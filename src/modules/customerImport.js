'use strict';

const crypto = require('crypto');
const { resolverEngine } = require('./resolverEngine');
const { normalizeIdentifier, NormalizationError } = require('./normalizer');
const logger = require('../lib/logger');

const SOURCE_SYSTEM = 'csv_import';
const SCHEMA_VERSION = '1.0';

function blankToNull(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] == null ? '' : cells[index].trim();
    });
    return row;
  });
}

function parseCustomerRow(raw) {
  const first = blankToNull(raw.first_name);
  const last = blankToNull(raw.last_name);
  const emailRaw = blankToNull(raw.email);
  const dobRaw = blankToNull(raw.birthday != null ? raw.birthday : raw.dob);
  const zipRaw = blankToNull(raw.zip);
  const phoneRaw = blankToNull(raw.phone);

  let nameRaw = null;
  if (first && last) nameRaw = `${first} ${last}`;
  else if (first || last) nameRaw = first || last;

  const fields = {};
  try {
    if (emailRaw) fields.email = normalizeIdentifier('email', emailRaw);
    if (nameRaw) fields.name = normalizeIdentifier('name', nameRaw);
    if (dobRaw) fields.dob = normalizeIdentifier('dob', dobRaw);
    if (zipRaw) fields.zip = normalizeIdentifier('zip', zipRaw);
    if (phoneRaw) fields.phone = normalizeIdentifier('phone', phoneRaw);
  } catch (err) {
    if (err instanceof NormalizationError) {
      logger.error('customer import row failed normalization', { error: err.message });
      return { ok: false, error: 'row could not be read' };
    }
    throw err;
  }

  if (!fields.email && !(fields.name && fields.dob)) {
    return { ok: false, error: 'row needs an email, or a name and a birthday' };
  }
  return { ok: true, fields };
}

function rowKeyFor(orgId, fields) {
  const material = [
    orgId,
    fields.email || '',
    fields.name || '',
    fields.dob || '',
    fields.zip || '',
    fields.phone || '',
  ].join('|');
  return crypto.createHash('sha256').update(material).digest('hex');
}

function pathFromResult(result) {
  if (result.match_type === 'soft') return 'C';
  if (result.match_type === 'conflict') return 'D';
  if (result.is_new_record) return 'B';
  return 'A';
}

async function recordError(client, { batchId, orgId, rowNumber, rowKey, message }) {
  if (rowKey) {
    await client.query(
      `UPDATE import_row
         SET status = 'error', error = $1
       WHERE org_id = $2 AND row_key = $3`,
      [message, orgId, rowKey]
    );
    return;
  }
  await client.query(
    `INSERT INTO import_row (batch_id, org_id, row_number, status, error)
     VALUES ($1, $2, $3, 'error', $4)`,
    [batchId, orgId, rowNumber, message]
  );
}

async function attachRemaining(client, { orgId, fanId, path, fields, rowKey, actor }) {
  const skipped = {};
  await client.query('BEGIN');
  try {
    for (const type of ['name', 'dob', 'zip', 'phone']) {
      const value = fields[type];
      if (!value) continue;

      const existing = await client.query(
        `SELECT identifier_value
           FROM identifier_link
          WHERE fan_id = $1 AND org_id = $2 AND identifier_type = $3`,
        [fanId, orgId, type]
      );
      if (existing.rows.some((row) => row.identifier_value === value)) continue;

      if (type === 'dob' && path === 'A' && existing.rows.length > 0) {
        skipped.dob = 'birthday already stored for this email';
        continue;
      }

      await client.query(
        `INSERT INTO identifier_link
           (fan_id, org_id, identifier_type, identifier_value,
            source_system, schema_version, confidence_score)
         VALUES ($1, $2, $3, $4, $5, $6, 1.0)`,
        [fanId, orgId, type, value, SOURCE_SYSTEM, SCHEMA_VERSION]
      );
    }

    await client.query(
      `INSERT INTO audit_log
         (fan_id, org_id, event_type, status, idempotency_key, schema_version,
          actor_type, operator_id, actor_email)
       VALUES ($1, $2, 'import_identifiers_attached', 'success', $3, $4, $5, $6, $7)`,
      [
        fanId,
        orgId,
        rowKey,
        SCHEMA_VERSION,
        actor ? actor.actorType : 'system',
        actor ? actor.operatorId : null,
        actor ? actor.actorEmail : null,
      ]
    );
    await client.query(
      `UPDATE import_row
         SET status = 'complete', skipped = $1
       WHERE org_id = $2 AND row_key = $3`,
      [JSON.stringify(skipped), orgId, rowKey]
    );
    await client.query('COMMIT');
    return skipped;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function importOne(client, { batchId, orgId, rowNumber, raw, actor }) {
  const parsed = parseCustomerRow(raw);
  if (!parsed.ok) {
    await recordError(client, { batchId, orgId, rowNumber, message: parsed.error });
    return { row_number: rowNumber, status: 'error', error: parsed.error, fan_id: null };
  }

  const fields = parsed.fields;
  const rowKey = rowKeyFor(orgId, fields);

  await client.query(
    `INSERT INTO import_row (batch_id, org_id, row_number, row_key, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (org_id, row_key) WHERE row_key IS NOT NULL DO NOTHING`,
    [batchId, orgId, rowNumber, rowKey]
  );

  const stored = await client.query(
    `SELECT status, fan_id, resolution_path, conflict_id, error, skipped
       FROM import_row
      WHERE org_id = $1 AND row_key = $2`,
    [orgId, rowKey]
  );
  const prior = stored.rows[0];

  if (prior.status === 'complete') {
    return {
      row_number: rowNumber,
      status: 'complete',
      fan_id: prior.fan_id,
      resolution_path: prior.resolution_path,
      conflict_id: prior.conflict_id,
      skipped: prior.skipped,
      replayed: true,
    };
  }

  let fanId = prior.fan_id;
  let resolutionPath = prior.resolution_path;
  let conflictId = prior.conflict_id;

  if (!fanId) {
    const singularType = fields.email ? 'email' : 'name';
    const singularValue = fields.email || fields.name;
    const identifiers = {};
    if (fields.name) identifiers.name = fields.name;
    if (fields.dob) identifiers.dob = fields.dob;
    if (fields.zip) identifiers.zip = fields.zip;
    if (fields.email) identifiers.email = fields.email;

    let result;
    try {
      result = await resolverEngine({
        identifier_type: singularType,
        identifier_value: singularValue,
        identifiers,
        org_id: orgId,
        schema_version: SCHEMA_VERSION,
        idempotency_key: rowKey,
        source_system: SOURCE_SYSTEM,
      }, client);
    } catch (err) {
      logger.error('customer import resolver failed', {
        error: err.message,
        org_id: orgId,
        row_number: rowNumber,
      });
      await recordError(client, {
        batchId, orgId, rowNumber, rowKey, message: 'row could not be stored',
      });
      return { row_number: rowNumber, status: 'error', error: 'row could not be stored', fan_id: null };
    }

    fanId = result.fan_id;
    resolutionPath = pathFromResult(result);
    conflictId = result.conflict_id;

    await client.query(
      `UPDATE import_row
         SET fan_id = $1, resolution_path = $2, conflict_id = $3, match_type = $4, status = 'pending', error = NULL
       WHERE org_id = $5 AND row_key = $6`,
      [fanId, resolutionPath, conflictId, result.match_type, orgId, rowKey]
    );
  }

  try {
    const skipped = await attachRemaining(client, {
      orgId, fanId, path: resolutionPath, fields, rowKey, actor,
    });
    return {
      row_number: rowNumber,
      status: 'complete',
      fan_id: fanId,
      resolution_path: resolutionPath,
      conflict_id: conflictId,
      skipped,
      replayed: false,
    };
  } catch (err) {
    logger.error('customer import could not store remaining identifiers', {
      error: err.message,
      org_id: orgId,
      row_number: rowNumber,
    });
    await recordError(client, {
      batchId, orgId, rowNumber, rowKey, message: 'row could not be stored',
    });
    return { row_number: rowNumber, status: 'error', error: 'row could not be stored', fan_id: fanId };
  }
}

async function importCustomers(client, options) {
  const orgId = options.orgId;
  const filename = options.filename || null;
  const actor = options.actor || null;
  const rows = typeof options.csv === 'string' ? parseCsv(options.csv) : options.rows;

  await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);

  const batch = await client.query(
    `INSERT INTO import_batch (org_id, filename, created_by_operator_id, created_by_email)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      orgId,
      filename,
      actor ? actor.operatorId : null,
      actor ? actor.actorEmail : null,
    ]
  );
  const batchId = batch.rows[0].id;
  const results = [];

  for (let index = 0; index < rows.length; index++) {
    try {
      results.push(await importOne(client, {
        batchId, orgId, rowNumber: index + 1, raw: rows[index], actor,
      }));
    } catch (err) {
      logger.error('customer import row failed', {
        error: err.message,
        org_id: orgId,
        row_number: index + 1,
      });
      await recordError(client, {
        batchId, orgId, rowNumber: index + 1, message: 'row could not be stored',
      });
      results.push({
        row_number: index + 1,
        status: 'error',
        error: 'row could not be stored',
        fan_id: null,
      });
    }
  }

  return { batch_id: batchId, rows: results };
}

const IMPORT_FIELDS = ['first_name', 'last_name', 'email', 'birthday', 'zip', 'phone'];

function readCustomerCsv(text, mapping) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: 'file is empty' };
  }
  if (text.length > 1000000) {
    return { ok: false, error: 'file is too large' };
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return { ok: false, error: 'file is empty' };

  const headers = lines[0].split(',').map((header) => header.trim());
  const parsed = lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] == null ? '' : cells[index].trim();
    });
    return row;
  });

  const sourceByField = {};
  if (mapping == null) {
    for (const field of IMPORT_FIELDS) {
      if (headers.includes(field)) sourceByField[field] = field;
    }
  } else if (typeof mapping !== 'object' || Array.isArray(mapping)) {
    return { ok: false, error: 'column mapping is invalid' };
  } else {
    for (const [field, source] of Object.entries(mapping)) {
      if (!IMPORT_FIELDS.includes(field)) return { ok: false, error: 'column mapping is invalid' };
      if (source == null || source === '') continue;
      if (typeof source !== 'string' || !headers.includes(source)) {
        return { ok: false, error: 'column mapping is invalid' };
      }
      sourceByField[field] = source;
    }
  }

  const rows = parsed.map((row) => {
    const out = {};
    for (const field of IMPORT_FIELDS) {
      const source = sourceByField[field];
      out[field] = source ? (row[source] ?? '') : '';
    }
    return out;
  });
  return { ok: true, headers, rows };
}

module.exports = {
  parseCsv,
  parseCustomerRow,
  importCustomers,
  readCustomerCsv,
  IMPORT_FIELDS,
};
