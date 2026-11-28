'use strict';

const express = require('express');
const logger = require('../lib/logger');
const { UUID_RE } = require('../lib/validate');
const { readCustomerCsv, parseCustomerRow, importCustomers } = require('../modules/customerImport');
const { createOperator, VALID_ROLES } = require('../modules/operatorAuth');
const { requireOperator } = require('../middleware/requireRoleMiddleware');
const conflictsRouter = require('./conflicts');
const exportRouter = require('./export');

const router = express.Router();
const PREVIEW_LIMIT = 25;
const REVIEW_STATUSES = ['pending', 'confirmed', 'rejected', 'unmerged'];
const RECORD_PATHS = ['A', 'B', 'C', 'D'];
const REVIEW_FILTERS = ['queued', 'none'];
const RECORD_PAGE_MAX = 100;

function recordFilters(query) {
  const path = query.path === undefined || query.path === '' ? null : query.path;
  const review = query.review === undefined || query.review === '' ? null : query.review;
  const batch = query.batch_id === undefined || query.batch_id === '' ? null : query.batch_id;
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  const limit = query.limit === undefined ? 50 : parseInt(query.limit, 10);
  const offset = query.offset === undefined ? 0 : parseInt(query.offset, 10);
  if (path !== null && !RECORD_PATHS.includes(path)) return { error: 'invalid path' };
  if (review !== null && !REVIEW_FILTERS.includes(review)) return { error: 'invalid review filter' };
  if (batch !== null && !UUID_RE.test(batch)) return { error: 'batch_id must be a uuid' };
  if (!Number.isInteger(limit) || limit < 1 || limit > RECORD_PAGE_MAX) return { error: 'invalid limit' };
  if (!Number.isInteger(offset) || offset < 0) return { error: 'invalid offset' };
  return { path, review, batch, q, limit, offset };
}

function searchPattern(value) {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

function dispatch(target, req, res, url) {
  req.url = url;
  target(req, res, (err) => {
    if (err) {
      logger.error('dashboard forward failed', {
        error: err.message,
        org_id: req.context && req.context.org_id,
      });
      if (!res.headersSent) return res.status(500).json({ error: 'internal error' });
      return;
    }
    if (!res.headersSent) return res.status(404).json({ error: 'not found' });
  });
}

router.get('/v1/dashboard/session', (req, res) => {
  return res.status(200).json({
    operator_id: req.context.operator_id,
    email: req.context.operator_email,
    role: req.context.operator_role,
    org_name: req.context.org_name,
  });
});

router.get('/v1/dashboard/operators', requireOperator('admin'), async (req, res) => {
  try {
    const result = await req.db.query(
      `SELECT id, email, role, is_active, created_at
         FROM operator
        WHERE org_id = $1
        ORDER BY created_at ASC`,
      [req.context.org_id]
    );
    return res.status(200).json({ operators: result.rows });
  } catch (err) {
    logger.error('dashboard operator list failed', {
      error: err.message,
      org_id: req.context.org_id,
      correlation_id: req.context.correlation_id,
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

router.post('/v1/dashboard/operators', requireOperator('admin'), async (req, res) => {
  const email = req.body && req.body.email;
  const password = req.body && req.body.password;
  const role = req.body && req.body.role !== undefined ? req.body.role : 'operator';

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'email and password are required' });
  }
  if (typeof role !== 'string' || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'role must be admin or operator' });
  }

  try {
    await req.db.query('BEGIN');
    const created = await createOperator(req.db, {
      orgId: req.context.org_id,
      email,
      password,
      role,
    });
    await req.db.query(
      `INSERT INTO audit_log
         (org_id, event_type, status, schema_version, actor_type, operator_id, actor_email)
       VALUES ($1, 'operator_created', 'success', '1.0', 'operator', $2, $3)`,
      [req.context.org_id, req.context.operator_id, req.context.operator_email]
    );
    await req.db.query('COMMIT');
    return res.status(201).json({
      operator: {
        id: created.id,
        email: created.email,
        role: created.role,
        is_active: created.is_active,
        created_at: created.created_at,
      },
    });
  } catch (err) {
    await req.db.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      return res.status(409).json({ error: 'operator email already exists' });
    }
    if (err.message && (err.message.includes('operator email') || err.message.includes('operator password') || err.message.includes('operator role'))) {
      return res.status(400).json({ error: err.message });
    }
    logger.error('dashboard operator create failed', {
      error: err.message,
      org_id: req.context.org_id,
      correlation_id: req.context.correlation_id,
    });
    return res.status(500).json({ error: 'operator could not be created' });
  }
});

router.post('/v1/dashboard/operators/:id/deactivate', requireOperator('admin'), async (req, res) => {
  const targetId = req.params.id;
  if (!UUID_RE.test(targetId)) {
    return res.status(400).json({ error: 'operator id must be a uuid' });
  }
  if (targetId === req.context.operator_id) {
    return res.status(409).json({ error: 'cannot deactivate your own account' });
  }

  try {
    await req.db.query('BEGIN');
    const existing = await req.db.query(
      `SELECT id, email, role, is_active
         FROM operator
        WHERE id = $1 AND org_id = $2
        FOR UPDATE`,
      [targetId, req.context.org_id]
    );
    if (existing.rows.length === 0) {
      await req.db.query('ROLLBACK');
      return res.status(404).json({ error: 'operator not found' });
    }
    if (!existing.rows[0].is_active) {
      await req.db.query('ROLLBACK');
      return res.status(409).json({ error: 'operator already inactive' });
    }

    await req.db.query(
      `UPDATE operator
          SET is_active = false
        WHERE id = $1 AND org_id = $2`,
      [targetId, req.context.org_id]
    );
    await req.db.query(
      `DELETE FROM operator_session
        WHERE operator_id = $1 AND org_id = $2`,
      [targetId, req.context.org_id]
    );
    await req.db.query(
      `INSERT INTO audit_log
         (org_id, event_type, status, schema_version, actor_type, operator_id, actor_email)
       VALUES ($1, 'operator_deactivated', 'success', '1.0', 'operator', $2, $3)`,
      [req.context.org_id, req.context.operator_id, req.context.operator_email]
    );
    await req.db.query('COMMIT');
    return res.status(200).json({
      operator: {
        id: existing.rows[0].id,
        email: existing.rows[0].email,
        role: existing.rows[0].role,
        is_active: false,
      },
    });
  } catch (err) {
    await req.db.query('ROLLBACK').catch(() => {});
    logger.error('dashboard operator deactivate failed', {
      error: err.message,
      org_id: req.context.org_id,
      correlation_id: req.context.correlation_id,
    });
    return res.status(500).json({ error: 'operator could not be deactivated' });
  }
});

router.post('/v1/dashboard/imports/preview', (req, res) => {
  const csv = req.body && req.body.csv;
  const mapping = req.body ? req.body.mapping : undefined;
  if (typeof csv !== 'string') {
    return res.status(400).json({ error: 'csv is required' });
  }
  const read = readCustomerCsv(csv, mapping);
  if (!read.ok) return res.status(400).json({ error: read.error });

  const checked = read.rows.map((row, index) => {
    const parsed = parseCustomerRow(row);
    return {
      row_number: index + 1,
      values: row,
      status: parsed.ok ? 'ok' : 'error',
      error: parsed.ok ? null : parsed.error,
    };
  });
  return res.status(200).json({
    headers: read.headers,
    total: checked.length,
    error_count: checked.filter((row) => row.status === 'error').length,
    preview: checked.slice(0, PREVIEW_LIMIT),
  });
});

router.post('/v1/dashboard/imports', async (req, res) => {
  const csv = req.body && req.body.csv;
  const mapping = req.body ? req.body.mapping : undefined;
  const filename = req.body && typeof req.body.filename === 'string' ? req.body.filename.slice(0, 200) : null;
  if (typeof csv !== 'string') {
    return res.status(400).json({ error: 'csv is required' });
  }
  const read = readCustomerCsv(csv, mapping);
  if (!read.ok) return res.status(400).json({ error: read.error });

  try {
    const result = await importCustomers(req.db, {
      orgId: req.context.org_id,
      rows: read.rows,
      filename,
      actor: {
        actorType: 'operator',
        operatorId: req.context.operator_id,
        actorEmail: req.context.operator_email,
      },
    });
    const rows = result.rows.map((row) => ({
      row_number: row.row_number,
      status: row.status,
      fan_id: row.fan_id,
      resolution_path: row.resolution_path || null,
      conflict_id: row.conflict_id || null,
      error: row.error || null,
      skipped: row.skipped || null,
      replayed: Boolean(row.replayed),
    }));
    return res.status(200).json({
      batch_id: result.batch_id,
      total: rows.length,
      error_count: rows.filter((row) => row.status === 'error').length,
      rows,
    });
  } catch (err) {
    logger.error('dashboard import failed', {
      error: err.message,
      org_id: req.context.org_id,
      correlation_id: req.context.correlation_id,
    });
    return res.status(500).json({ error: 'import could not be completed' });
  }
});

router.get('/v1/dashboard/imports', async (req, res) => {
  try {
    const result = await req.db.query(
      `SELECT b.id, b.filename, b.created_at, b.data_removed_at,
              COUNT(r.id)::int AS row_count,
              COUNT(r.id) FILTER (WHERE r.status = 'error')::int AS error_count
         FROM import_batch b
         LEFT JOIN import_row r ON r.batch_id = b.id
        WHERE b.org_id = $1
        GROUP BY b.id
        ORDER BY b.created_at DESC
        LIMIT 50`,
      [req.context.org_id]
    );
    return res.status(200).json({ imports: result.rows });
  } catch (err) {
    logger.error('dashboard import list failed', {
      error: err.message,
      org_id: req.context.org_id,
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

router.get('/v1/dashboard/imports/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'import id must be a uuid' });
  }
  try {
    const batch = await req.db.query(
      `SELECT id, filename, created_at, data_removed_at FROM import_batch WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.context.org_id]
    );
    if (batch.rows.length === 0) return res.status(404).json({ error: 'import not found' });
    const rows = await req.db.query(
      `SELECT id, row_number, status, fan_id, resolution_path, conflict_id, error, skipped
         FROM import_row
        WHERE batch_id = $1 AND org_id = $2
        ORDER BY row_number
        LIMIT 200`,
      [req.params.id, req.context.org_id]
    );
    return res.status(200).json({ import: batch.rows[0], rows: rows.rows });
  } catch (err) {
    logger.error('dashboard import detail failed', {
      error: err.message,
      org_id: req.context.org_id,
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

function recordWhere(orgId, filters) {
  const params = [orgId];
  const where = ['r.org_id = $1'];
  if (filters.batch) {
    params.push(filters.batch);
    where.push(`r.batch_id = $${params.length}`);
  }
  if (filters.path) {
    params.push(filters.path);
    where.push(`r.resolution_path = $${params.length}`);
  }
  if (filters.review === 'queued') where.push('r.conflict_id IS NOT NULL');
  if (filters.review === 'none') where.push('r.conflict_id IS NULL');
  if (filters.q) {
    params.push(searchPattern(filters.q));
    where.push(`EXISTS (
      SELECT 1 FROM identifier_link il
       WHERE il.org_id = r.org_id
         AND il.fan_id = r.fan_id
         AND il.identifier_value ILIKE $${params.length} ESCAPE '\\'
    )`);
  }
  return { params, whereSql: where.join(' AND ') };
}

function presentRecord(row, people) {
  return {
    import_row_id: row.id,
    batch_id: row.batch_id,
    filename: row.filename,
    row_number: row.row_number,
    status: row.status,
    fan_id: row.fan_id,
    deleted_at: row.deleted_at,
    resolution_path: row.resolution_path,
    conflict_id: row.conflict_id,
    conflict_status: row.conflict_status,
    confidence_score: row.confidence_score,
    error: row.error,
    skipped: row.skipped,
    person: row.fan_id ? (people[row.fan_id] || {}) : {},
    review_opened: Boolean(row.conflict_id),
  };
}

const RECORD_SELECT = `
  SELECT r.id, r.batch_id, b.filename, r.row_number, r.status, r.fan_id,
         r.resolution_path, r.conflict_id, r.error, r.skipped,
         f.deleted_at,
         c.status AS conflict_status, c.confidence_score
    FROM import_row r
    JOIN import_batch b ON b.id = r.batch_id AND b.org_id = r.org_id
    LEFT JOIN fan f ON f.id = r.fan_id AND f.org_id = r.org_id
    LEFT JOIN conflict_queue c ON c.id = r.conflict_id AND c.org_id = r.org_id
`;

router.get('/v1/dashboard/records', async (req, res) => {
  const filters = recordFilters(req.query || {});
  if (filters.error) return res.status(400).json({ error: filters.error });
  try {
    const built = recordWhere(req.context.org_id, filters);
    const count = await req.db.query(
      `SELECT COUNT(*)::int AS total FROM import_row r WHERE ${built.whereSql}`,
      built.params
    );
    const rows = await req.db.query(
      `${RECORD_SELECT}
        WHERE ${built.whereSql}
        ORDER BY b.created_at DESC, r.row_number ASC
        LIMIT $${built.params.length + 1} OFFSET $${built.params.length + 2}`,
      [...built.params, filters.limit, filters.offset]
    );
    const fanIds = rows.rows.map((row) => row.fan_id).filter(Boolean);
    const people = fanIds.length ? await peopleFor(req.db, req.context.org_id, fanIds) : {};
    return res.status(200).json({
      records: rows.rows.map((row) => presentRecord(row, people)),
      total: count.rows[0].total,
      limit: filters.limit,
      offset: filters.offset,
    });
  } catch (err) {
    logger.error('dashboard record list failed', {
      error: err.message,
      org_id: req.context.org_id,
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

router.get('/v1/dashboard/records/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'record id must be a uuid' });
  }
  try {
    const result = await req.db.query(
      `${RECORD_SELECT}
        WHERE r.id = $1 AND r.org_id = $2`,
      [req.params.id, req.context.org_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'record not found' });
    const row = result.rows[0];
    const people = row.fan_id ? await peopleFor(req.db, req.context.org_id, [row.fan_id]) : {};
    return res.status(200).json({ record: presentRecord(row, people) });
  } catch (err) {
    logger.error('dashboard record detail failed', {
      error: err.message,
      org_id: req.context.org_id,
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

async function peopleFor(db, orgId, fanIds) {
  const result = await db.query(
    `SELECT fan_id, identifier_type, identifier_value
       FROM identifier_link
      WHERE org_id = $1
        AND fan_id = ANY($2::uuid[])
        AND identifier_type IN ('name', 'email', 'dob', 'zip', 'phone')
      ORDER BY identifier_type, identifier_value`,
    [orgId, fanIds]
  );
  const byFan = {};
  for (const row of result.rows) {
    if (!byFan[row.fan_id]) byFan[row.fan_id] = {};
    if (!byFan[row.fan_id][row.identifier_type]) byFan[row.fan_id][row.identifier_type] = [];
    byFan[row.fan_id][row.identifier_type].push(row.identifier_value);
  }
  return byFan;
}

router.get('/v1/dashboard/reviews', async (req, res) => {
  const status = req.query.status === undefined ? 'pending' : req.query.status;
  if (typeof status !== 'string' || !REVIEW_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  try {
    const result = await req.db.query(
      `SELECT id, fan_id_a, fan_id_b, confidence_score, status, created_at, reviewed_at, reviewed_by
         FROM conflict_queue
        WHERE org_id = $1 AND status = $2
          AND (
            $2 <> 'pending'
            OR NOT EXISTS (
              SELECT 1 FROM fan f
               WHERE f.org_id = conflict_queue.org_id
                 AND f.id IN (conflict_queue.fan_id_a, conflict_queue.fan_id_b)
                 AND f.deleted_at IS NOT NULL
            )
          )
        ORDER BY created_at DESC
        LIMIT 100`,
      [req.context.org_id, status]
    );
    const fanIds = result.rows.flatMap((row) => [row.fan_id_a, row.fan_id_b]);
    const people = fanIds.length ? await peopleFor(req.db, req.context.org_id, fanIds) : {};
    return res.status(200).json({
      reviews: result.rows.map((row) => ({
        conflict_id: row.id,
        fan_id_a: row.fan_id_a,
        fan_id_b: row.fan_id_b,
        confidence_score: row.confidence_score,
        status: row.status,
        created_at: row.created_at,
        reviewed_at: row.reviewed_at,
        reviewed_by: row.reviewed_by,
        person_a: people[row.fan_id_a] || {},
        person_b: people[row.fan_id_b] || {},
      })),
    });
  } catch (err) {
    logger.error('dashboard review list failed', {
      error: err.message,
      org_id: req.context.org_id,
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

router.get('/v1/dashboard/reviews/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'review id must be a uuid' });
  }
  try {
    const result = await req.db.query(
      `SELECT id, fan_id_a, fan_id_b, confidence_score, signals_matched, status, created_at, reviewed_at, reviewed_by
         FROM conflict_queue
        WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.context.org_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'review not found' });
    const row = result.rows[0];
    const people = await peopleFor(req.db, req.context.org_id, [row.fan_id_a, row.fan_id_b]);
    return res.status(200).json({
      conflict_id: row.id,
      fan_id_a: row.fan_id_a,
      fan_id_b: row.fan_id_b,
      confidence_score: row.confidence_score,
      signals_matched: row.signals_matched,
      status: row.status,
      created_at: row.created_at,
      reviewed_at: row.reviewed_at,
      reviewed_by: row.reviewed_by,
      person_a: people[row.fan_id_a] || {},
      person_b: people[row.fan_id_b] || {},
    });
  } catch (err) {
    logger.error('dashboard review detail failed', {
      error: err.message,
      org_id: req.context.org_id,
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

async function fanInActiveMerge(db, orgId, fanId) {
  const result = await db.query(
    `SELECT 1 FROM merge_history
      WHERE org_id = $1 AND status = 'active'
        AND (fan_id_source = $2 OR fan_id_target = $2)
      LIMIT 1`,
    [orgId, fanId]
  );
  return result.rows.length > 0;
}

async function hideFan(db, orgId, fanId) {
  const fan = await db.query(
    'SELECT id, deleted_at FROM fan WHERE id = $1 AND org_id = $2',
    [fanId, orgId]
  );
  if (fan.rows.length === 0) return { error: 'record not found', status: 404 };
  if (fan.rows[0].deleted_at) return { error: 'record already hidden', status: 409 };
  if (await fanInActiveMerge(db, orgId, fanId)) {
    return { error: 'record is part of an active merge', status: 409 };
  }
  await db.query(
    `UPDATE fan SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [fanId, orgId]
  );
  return { fanId };
}

router.post('/v1/dashboard/fans/:id/hide', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'fan id must be a uuid' });
  }
  try {
    await req.db.query('BEGIN');
    const hidden = await hideFan(req.db, req.context.org_id, req.params.id);
    if (hidden.error) {
      await req.db.query('ROLLBACK');
      return res.status(hidden.status).json({ error: hidden.error });
    }
    await req.db.query(
      `INSERT INTO audit_log
         (fan_id, org_id, event_type, status, schema_version, actor_type, operator_id, actor_email)
       VALUES ($1, $2, 'record_hidden', 'success', '1.0', 'operator', $3, $4)`,
      [hidden.fanId, req.context.org_id, req.context.operator_id, req.context.operator_email]
    );
    await req.db.query('COMMIT');
    return res.status(200).json({ fan_id: hidden.fanId, hidden: true });
  } catch (err) {
    try { await req.db.query('ROLLBACK'); } catch (_) { /* already closed */ }
    logger.error('dashboard fan hide failed', {
      error: err.message,
      org_id: req.context.org_id,
    });
    return res.status(500).json({ error: 'record could not be hidden' });
  }
});

router.post('/v1/dashboard/imports/:id/remove', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'import id must be a uuid' });
  }
  const confirmName = req.body && typeof req.body.confirm_filename === 'string'
    ? req.body.confirm_filename
    : null;
  if (confirmName === null) {
    return res.status(400).json({ error: 'confirm_filename is required' });
  }
  try {
    await req.db.query('BEGIN');
    const batch = await req.db.query(
      `SELECT id, filename, data_removed_at
         FROM import_batch
        WHERE id = $1 AND org_id = $2
        FOR UPDATE`,
      [req.params.id, req.context.org_id]
    );
    if (batch.rows.length === 0) {
      await req.db.query('ROLLBACK');
      return res.status(404).json({ error: 'import not found' });
    }
    const file = batch.rows[0];
    const expected = file.filename || 'Untitled import';
    if (confirmName !== expected) {
      await req.db.query('ROLLBACK');
      return res.status(400).json({ error: 'filename does not match' });
    }
    if (file.data_removed_at) {
      await req.db.query('ROLLBACK');
      return res.status(409).json({ error: 'import data already hidden' });
    }
    const rows = await req.db.query(
      `SELECT row_number, fan_id, resolution_path
         FROM import_row
        WHERE batch_id = $1 AND org_id = $2
        ORDER BY row_number`,
      [file.id, req.context.org_id]
    );
    const removed = [];
    const leftInPlace = [];
    const skipped = [];
    const seen = new Set();
    for (const row of rows.rows) {
      if (!row.fan_id || row.resolution_path === 'A') {
        leftInPlace.push({
          row_number: row.row_number,
          fan_id: row.fan_id,
          reason: row.resolution_path === 'A' ? 'already this person; not removed' : 'no person stored',
        });
        continue;
      }
      if (!['B', 'C', 'D'].includes(row.resolution_path)) {
        leftInPlace.push({ row_number: row.row_number, fan_id: row.fan_id, reason: 'no person stored' });
        continue;
      }
      if (seen.has(row.fan_id)) {
        removed.push({ row_number: row.row_number, fan_id: row.fan_id });
        continue;
      }
      const hidden = await hideFan(req.db, req.context.org_id, row.fan_id);
      if (hidden.error === 'record is part of an active merge') {
        skipped.push({ row_number: row.row_number, fan_id: row.fan_id, reason: hidden.error });
        continue;
      }
      if (hidden.error === 'record already hidden') {
        seen.add(row.fan_id);
        removed.push({ row_number: row.row_number, fan_id: row.fan_id });
        continue;
      }
      if (hidden.error) {
        skipped.push({ row_number: row.row_number, fan_id: row.fan_id, reason: hidden.error });
        continue;
      }
      seen.add(row.fan_id);
      removed.push({ row_number: row.row_number, fan_id: row.fan_id });
    }
    const marked = await req.db.query(
      `UPDATE import_batch SET data_removed_at = NOW()
        WHERE id = $1 AND org_id = $2
        RETURNING data_removed_at`,
      [file.id, req.context.org_id]
    );
    await req.db.query(
      `INSERT INTO audit_log
         (org_id, event_type, status, schema_version, actor_type, operator_id, actor_email)
       VALUES ($1, 'record_hidden', 'success', '1.0', 'operator', $2, $3)`,
      [req.context.org_id, req.context.operator_id, req.context.operator_email]
    );
    await req.db.query('COMMIT');
    return res.status(200).json({
      data_removed_at: marked.rows[0].data_removed_at,
      removed,
      left_in_place: leftInPlace,
      skipped,
    });
  } catch (err) {
    try { await req.db.query('ROLLBACK'); } catch (_) { /* already closed */ }
    logger.error('dashboard import removal failed', {
      error: err.message,
      org_id: req.context.org_id,
    });
    return res.status(500).json({ error: 'import could not be hidden' });
  }
});

router.post('/v1/dashboard/conflicts/:id/confirm', (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'conflict_id must be a valid UUID' });
  }
  dispatch(conflictsRouter, req, res, `/v1/conflicts/${req.params.id}/confirm`);
});

router.post('/v1/dashboard/conflicts/:id/reject', (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'conflict_id must be a valid UUID' });
  }
  dispatch(conflictsRouter, req, res, `/v1/conflicts/${req.params.id}/reject`);
});

router.post('/v1/dashboard/conflicts/:id/unmerge', (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'conflict_id must be a valid UUID' });
  }
  dispatch(conflictsRouter, req, res, `/v1/conflicts/${req.params.id}/unmerge`);
});

router.get('/v1/dashboard/exports/fans', (req, res) => {
  dispatch(exportRouter, req, res, '/v1/export/fans');
});

module.exports = router;
