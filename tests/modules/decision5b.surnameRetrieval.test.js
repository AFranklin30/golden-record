'use strict';

// =============================================================================
// decision5b.surnameRetrieval.test.js
// Decision 5B — similar_surname retrieval.
//
// A one-edit surname can retrieve a candidate only when the normalized first
// name and the birthday already match. Retrieval does not hard-link anyone.
//
// Connects to: LOCAL Postgres only (localhost:5432 via DATABASE_URL).
// Never run against port 5433 (Cloud SQL proxy).
//
// resolverEngine writes a resolution_trace row. Cleanup deletes what it can
// and leaves rows the trace pins. Each run uses fresh UUIDs.
// =============================================================================

require('dotenv').config();

const { Client } = require('pg');
const crypto     = require('crypto');
const { resolverEngine, BLOCK_SIZE_CAP } = require('../../src/modules/resolverEngine');
const { levenshteinDistance } = require('../../src/modules/probabilisticMatcher');

function uuid() {
  return crypto.randomUUID();
}

const CO2 = [
  ['bodhi bramley', 'bodhi bramly'],
  ['cleo ostler', 'cleo ostlar'],
  ['daria quinlan', 'daria quinlen'],
  ['enzo sutcliffe', 'enzo sutclife'],
];

function surname(name) {
  return name.trim().split(/\s+/).pop();
}

function oneEditSurnames(base, count) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const found = [];
  const seen = new Set();

  function add(value) {
    if (!value || value === base || seen.has(value)) return;
    if (levenshteinDistance(base, value) !== 1) return;
    seen.add(value);
    found.push(value);
  }

  for (let i = 0; i < base.length; i += 1) {
    add(base.slice(0, i) + base.slice(i + 1));
    for (const ch of alphabet) {
      add(base.slice(0, i) + ch + base.slice(i + 1));
      add(base.slice(0, i) + ch + base.slice(i));
    }
  }
  for (const ch of alphabet) add(base + ch);

  if (found.length < count) {
    throw new Error(`only ${found.length} surnames at distance 1 from ${base}`);
  }
  return found.slice(0, count);
}

describe('Decision 5B similar-surname retrieval', () => {
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function seedOrg(orgId) {
    const hash = crypto.createHash('sha256').update('decision5b-' + orgId).digest('hex');
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash) VALUES ($1, $2, $3)`,
      [orgId, '_decision5b_' + orgId.slice(0, 8), hash]
    );
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
  }

  async function seedFan(fanId, orgId) {
    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [fanId, orgId]
    );
  }

  async function seedIdentifier(fanId, type, value, orgId) {
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, 'test', 'v1', 1.0, NOW(), NOW())`,
      [fanId, type, value, orgId]
    );
  }

  async function seedPerson(orgId, fields) {
    const fanId = uuid();
    await seedFan(fanId, orgId);
    for (const type of ['email', 'name', 'dob', 'zip']) {
      if (fields[type] != null) await seedIdentifier(fanId, type, fields[type], orgId);
    }
    return fanId;
  }

  async function cleanupOrg(orgId) {
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
    try {
      await client.query(`DELETE FROM identifier_link WHERE org_id = $1`, [orgId]);
    } catch (cleanupErr) {
      console.error('Cleanup error (identifier_link):', cleanupErr.message);
    }
    try {
      await client.query(`DELETE FROM fan WHERE org_id = $1`, [orgId]);
    } catch {
      // pinned by resolution_trace
    }
    try {
      await client.query(`DELETE FROM org WHERE id = $1`, [orgId]);
    } catch {
      // pinned by resolution_trace
    }
  }

  async function getTrace(auditEventId) {
    const result = await client.query(
      `SELECT resolution_path, candidate_ids, block_keys_available, block_results,
              blocks_dropped, skip_reason, signal_results, best_candidate_id
         FROM resolution_trace WHERE audit_event_id = $1`,
      [auditEventId]
    );
    return result.rows[0];
  }

  function block(trace, key) {
    const rows = Array.isArray(trace.block_results) ? trace.block_results : [];
    return rows.find((row) => row.key === key);
  }

  function probe(orgId, identifiers, singular = {}) {
    return {
      identifier_type:  singular.type || 'nfc_uid',
      identifier_value: singular.value || uuid(),
      org_id:           orgId,
      schema_version:   'v1',
      source_system:    'synthetic_test',
      idempotency_key:  uuid(),
      identifiers,
    };
  }

  test.each(CO2)('%s / %s is retrieved and opened as a review', async (storedName, inboundName) => {
    expect(levenshteinDistance(surname(storedName), surname(inboundName))).toBe(1);
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const anchor = await seedPerson(orgId, {
        email: 'anchor@example.com',
        name:  storedName,
        dob:   '1992-03-03',
        zip:   '10001',
      });

      const result = await resolverEngine(probe(orgId, {
        email: 'probe@example.com',
        name:  inboundName,
        dob:   '1992-03-03',
        zip:   '10002',
      }, { type: 'email', value: 'probe@example.com' }), client);
      const trace = await getTrace(result.audit_event_id);
      const review = await client.query(
        `SELECT fan_id_a, fan_id_b, status FROM conflict_queue WHERE id = $1`,
        [result.conflict_id]
      );
      const merges = await client.query(
        `SELECT 1 FROM merge_history
          WHERE fan_id_source = $1 OR fan_id_target = $1
             OR fan_id_source = $2 OR fan_id_target = $2`,
        [anchor, result.fan_id]
      );

      expect(result.match_type).toBe('conflict');
      expect(result.is_new_record).toBe(true);
      expect(result.fan_id).not.toBe(anchor);
      expect(trace.resolution_path).toBe('D');
      expect(trace.candidate_ids).toContain(anchor);
      expect(block(trace, 'similar_surname')).toEqual({ key: 'similar_surname', block_size: 1, dropped: false });
      expect(block(trace, 'name_dob')).toEqual({ key: 'name_dob', block_size: 0, dropped: false });
      expect(trace.signal_results).toEqual(expect.arrayContaining([
        expect.objectContaining({ signal: 'name_plus_dob' }),
      ]));
      expect(review.rows[0].status).toBe('pending');
      expect(review.rows[0].fan_id_a).toBe(anchor);
      expect(review.rows[0].fan_id_b).toBe(result.fan_id);
      expect(merges.rows).toHaveLength(0);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('a different person at surname distance 1 is reviewed, not hard-linked', async () => {
    expect(levenshteinDistance('keller', 'zeller')).toBe(1);
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const stored = await seedPerson(orgId, {
        email: 'morgan.keller@example.com',
        name:  'morgan keller',
        dob:   '1988-08-08',
        zip:   '73101',
      });

      const result = await resolverEngine(probe(orgId, {
        email: 'morgan.zeller@example.com',
        name:  'morgan zeller',
        dob:   '1988-08-08',
        zip:   '73102',
      }, { type: 'email', value: 'morgan.zeller@example.com' }), client);
      const trace = await getTrace(result.audit_event_id);
      const merges = await client.query(
        `SELECT 1 FROM merge_history
          WHERE fan_id_source = $1 OR fan_id_target = $1
             OR fan_id_source = $2 OR fan_id_target = $2`,
        [stored, result.fan_id]
      );

      expect(trace.candidate_ids).toContain(stored);
      expect(result.fan_id).not.toBe(stored);
      expect(result.is_new_record).toBe(true);
      expect(result.match_type).toBe('conflict');
      expect(trace.resolution_path).toBe('D');
      expect(merges.rows).toHaveLength(0);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('a different first name excludes similar-surname retrieval', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const stored = await seedPerson(orgId, {
        name: 'morgan keller',
        dob:  '1988-08-08',
      });

      const result = await resolverEngine(probe(orgId, {
        name: 'taylor zeller',
        dob:  '1988-08-08',
      }), client);
      const trace = await getTrace(result.audit_event_id);

      expect(block(trace, 'similar_surname')).toEqual({ key: 'similar_surname', block_size: 0, dropped: false });
      expect(block(trace, 'name_dob')).toEqual({ key: 'name_dob', block_size: 0, dropped: false });
      expect(trace.candidate_ids).not.toContain(stored);
      expect(result.fan_id).not.toBe(stored);
      expect(result.is_new_record).toBe(true);
      expect(trace.resolution_path).toBe('B');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('a different birthday excludes similar-surname retrieval', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const stored = await seedPerson(orgId, {
        name: 'morgan keller',
        dob:  '1988-08-08',
      });

      const result = await resolverEngine(probe(orgId, {
        name: 'morgan zeller',
        dob:  '1989-08-08',
      }), client);
      const trace = await getTrace(result.audit_event_id);

      expect(block(trace, 'similar_surname')).toEqual({ key: 'similar_surname', block_size: 0, dropped: false });
      expect(trace.candidate_ids).not.toContain(stored);
      expect(result.is_new_record).toBe(true);
      expect(trace.resolution_path).toBe('B');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('a missing birthday does not make the similar-surname key available', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const stored = await seedPerson(orgId, {
        name: 'morgan keller',
        dob:  '1988-08-08',
      });

      const result = await resolverEngine(probe(orgId, {
        name: 'morgan zeller',
      }), client);
      const trace = await getTrace(result.audit_event_id);

      expect(trace.block_keys_available).not.toContain('similar_surname');
      expect(trace.block_keys_available).not.toContain('name_dob');
      expect(trace.candidate_ids).not.toContain(stored);
      expect(result.is_new_record).toBe(true);
      expect(trace.resolution_path).toBe('B');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('a distance-2 transposition is not retrieved', async () => {
    expect(levenshteinDistance('smith', 'smtih')).toBe(2);
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const stored = await seedPerson(orgId, {
        name: 'morgan smith',
        dob:  '1988-08-08',
      });

      const result = await resolverEngine(probe(orgId, {
        name: 'morgan smtih',
        dob:  '1988-08-08',
      }), client);
      const trace = await getTrace(result.audit_event_id);

      expect(block(trace, 'similar_surname')).toEqual({ key: 'similar_surname', block_size: 0, dropped: false });
      expect(block(trace, 'name_dob')).toEqual({ key: 'name_dob', block_size: 0, dropped: false });
      expect(trace.candidate_ids).not.toContain(stored);
      expect(trace.resolution_path).toBe('B');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('an exact name still hard-matches before retrieval keys run', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const stored = await seedPerson(orgId, {
        name: 'ada lovelace',
        dob:  '1815-12-10',
      });

      const result = await resolverEngine(probe(orgId, {
        name: 'ada lovelace',
        dob:  '1815-12-10',
      }, { type: 'name', value: 'ada lovelace' }), client);
      const trace = await getTrace(result.audit_event_id);

      expect(result.match_type).toBe('hard');
      expect(result.is_new_record).toBe(false);
      expect(result.fan_id).toBe(stored);
      expect(trace.resolution_path).toBe('A');
      expect(trace.block_keys_available).toEqual([]);
      expect(trace.block_results).toBeNull();
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('the same email still hard-matches before a one-edit surname is considered', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const stored = await seedPerson(orgId, {
        email: 'bodhi@example.com',
        name:  'bodhi bramley',
        dob:   '1992-03-03',
      });

      const result = await resolverEngine(probe(orgId, {
        name: 'bodhi bramly',
        dob:  '1992-03-03',
      }, { type: 'email', value: 'bodhi@example.com' }), client);
      const trace = await getTrace(result.audit_event_id);

      expect(result.match_type).toBe('hard');
      expect(result.is_new_record).toBe(false);
      expect(result.fan_id).toBe(stored);
      expect(trace.resolution_path).toBe('A');
      expect(trace.block_keys_available).toEqual([]);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('an exact surname with a different first name is still retrieved by name_dob', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const stored = await seedPerson(orgId, {
        email: 'robert@example.com',
        name:  'robert smith',
        dob:   '1990-01-01',
        zip:   '10001',
      });

      const result = await resolverEngine(probe(orgId, {
        email: 'bob@example.com',
        name:  'bob smith',
        dob:   '1990-01-01',
        zip:   '10002',
      }, { type: 'email', value: 'bob@example.com' }), client);
      const trace = await getTrace(result.audit_event_id);

      expect(trace.candidate_ids).toContain(stored);
      expect(block(trace, 'name_dob')).toEqual({ key: 'name_dob', block_size: 1, dropped: false });
      expect(block(trace, 'similar_surname')).toEqual({ key: 'similar_surname', block_size: 0, dropped: false });
      expect(result.fan_id).not.toBe(stored);
      expect(result.is_new_record).toBe(true);
      expect(result.match_type).toBe('conflict');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('a fan found by email, exact surname, and similar surname is one candidate', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const stored = await seedPerson(orgId, {
        email: 'same@example.com',
        name:  'morgan keller',
        dob:   '1988-08-08',
      });

      const result = await resolverEngine(probe(orgId, {
        email: 'same@example.com',
        name:  'morgan keller',
        dob:   '1988-08-08',
      }), client);
      const trace = await getTrace(result.audit_event_id);

      expect(trace.candidate_ids).toEqual([stored]);
      expect(block(trace, 'email')).toEqual({ key: 'email', block_size: 1, dropped: false });
      expect(block(trace, 'name_dob')).toEqual({ key: 'name_dob', block_size: 1, dropped: false });
      expect(block(trace, 'similar_surname')).toEqual({ key: 'similar_surname', block_size: 1, dropped: false });
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('more than 50 filtered one-edit surnames drop that key', async () => {
    const orgId = uuid();
    const surnames = oneEditSurnames('smith', BLOCK_SIZE_CAP + 1);
    const fanIds = surnames.map(() => uuid());
    try {
      await seedOrg(orgId);
      for (let i = 0; i < fanIds.length; i += 1) {
        await seedFan(fanIds[i], orgId);
        await seedIdentifier(fanIds[i], 'name', `ann ${surnames[i]}`, orgId);
        await seedIdentifier(fanIds[i], 'dob', '1994-04-04', orgId);
      }

      const result = await resolverEngine(probe(orgId, {
        name: 'ann smith',
        dob:  '1994-04-04',
      }), client);
      const trace = await getTrace(result.audit_event_id);

      expect(block(trace, 'similar_surname')).toEqual({
        key: 'similar_surname',
        block_size: BLOCK_SIZE_CAP + 1,
        dropped: true,
      });
      expect(block(trace, 'name_dob')).toEqual({ key: 'name_dob', block_size: 0, dropped: false });
      expect(trace.blocks_dropped).toBe(1);
      expect(trace.skip_reason).toBe('block_dropped_oversize');
      expect(trace.candidate_ids).toEqual([]);
      for (const fanId of fanIds) expect(trace.candidate_ids).not.toContain(fanId);
      expect(result.is_new_record).toBe(true);
      expect(result.fan_id).not.toBe(fanIds[0]);
    } finally {
      await cleanupOrg(orgId);
    }
  }, 30000);

  test('the cap counts filtered surnames, so a large unrelated cohort stays searchable', async () => {
    const orgId = uuid();
    const farIds = Array.from({ length: BLOCK_SIZE_CAP + 1 }, () => uuid());
    const closeId = uuid();
    try {
      await seedOrg(orgId);
      for (let i = 0; i < farIds.length; i += 1) {
        const farSurname = `zz${String(i).padStart(3, '0')}`;
        expect(levenshteinDistance('smith', farSurname)).toBeGreaterThan(1);
        await seedFan(farIds[i], orgId);
        await seedIdentifier(farIds[i], 'name', `ann ${farSurname}`, orgId);
        await seedIdentifier(farIds[i], 'dob', '1994-04-04', orgId);
      }
      await seedFan(closeId, orgId);
      await seedIdentifier(closeId, 'name', 'ann smyth', orgId);
      await seedIdentifier(closeId, 'dob', '1994-04-04', orgId);

      const result = await resolverEngine(probe(orgId, {
        name: 'ann smith',
        dob:  '1994-04-04',
      }), client);
      const trace = await getTrace(result.audit_event_id);

      expect(levenshteinDistance('smith', 'smyth')).toBe(1);
      expect(block(trace, 'similar_surname')).toEqual({ key: 'similar_surname', block_size: 1, dropped: false });
      expect(block(trace, 'name_dob')).toEqual({ key: 'name_dob', block_size: 0, dropped: false });
      expect(trace.candidate_ids).toEqual([closeId]);
      expect(result.fan_id).not.toBe(closeId);
      expect(result.is_new_record).toBe(true);
    } finally {
      await cleanupOrg(orgId);
    }
  }, 30000);

  test('a one-edit surname on a short name is retrieved and stored as a new person', async () => {
    expect(levenshteinDistance('xu', 'yu')).toBe(1);
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const stored = await seedPerson(orgId, {
        email: 'bo.xu@example.com',
        name:  'bo xu',
        dob:   '1999-09-09',
        zip:   '10001',
      });

      const result = await resolverEngine(probe(orgId, {
        email: 'bo.yu@example.com',
        name:  'bo yu',
        dob:   '1999-09-09',
        zip:   '10002',
      }, { type: 'email', value: 'bo.yu@example.com' }), client);
      const trace = await getTrace(result.audit_event_id);

      expect(trace.candidate_ids).toContain(stored);
      expect(block(trace, 'similar_surname')).toEqual({ key: 'similar_surname', block_size: 1, dropped: false });
      expect(result.fan_id).not.toBe(stored);
      expect(result.is_new_record).toBe(true);
      expect(result.match_type).toBe('hard');
      expect(trace.resolution_path).toBe('B');
      expect(result.conflict_id).toBeNull();
    } finally {
      await cleanupOrg(orgId);
    }
  });
});
