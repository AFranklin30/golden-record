'use strict';

// Sprint 1.5 false-merge rules.
// Decision 1, Decision 3, Decision 6, nickname retrieval, and exact-name
// retrieval when a birthday is missing. Retrieval does not hard-match.
//
// Connects to LOCAL Postgres only (localhost:5432 via DATABASE_URL).

require('dotenv').config();

const { Client } = require('pg');
const crypto = require('crypto');
const { resolverEngine } = require('../../src/modules/resolverEngine');
const { populatedFirstNamesConflict } = require('../../src/modules/probabilisticMatcher');

function uuid() {
  return crypto.randomUUID();
}

describe('populated first-name conflict', () => {
  test('different given names conflict, and a listed nickname does not', () => {
    expect(populatedFirstNamesConflict('omar inwood', 'carmen inwood')).toBe(true);
    expect(populatedFirstNamesConflict('robert vernon', 'bob vernon')).toBe(false);
    expect(populatedFirstNamesConflict('ada lovelace', 'ada smith')).toBe(false);
    expect(populatedFirstNamesConflict('jon smith', 'john smith')).toBe(true);
    expect(populatedFirstNamesConflict('ada lovelace', null)).toBe(false);
    expect(populatedFirstNamesConflict(null, null)).toBe(false);
  });
});

describe('Sprint 1.5 false-merge holds', () => {
  let client;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL || '';
    if (!url.includes('localhost:5432')) {
      throw new Error('these tests only run against local Postgres on port 5432');
    }
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function seedOrg(orgId) {
    const hash = crypto.createHash('sha256').update('s15-' + orgId).digest('hex');
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash, is_active) VALUES ($1, $2, $3, true)`,
      [orgId, '_s15_' + orgId.slice(0, 8), hash]
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
    await client.query(`DELETE FROM conflict_queue WHERE org_id = $1`, [orgId]).catch(() => {});
    await client.query(`DELETE FROM identifier_link WHERE org_id = $1`, [orgId]).catch(() => {});
    await client.query(`DELETE FROM fan WHERE org_id = $1`, [orgId]).catch(() => {});
    await client.query(`DELETE FROM org WHERE id = $1`, [orgId]).catch(() => {});
  }

  function call(orgId, singularType, singularValue, identifiers) {
    return {
      identifier_type: singularType,
      identifier_value: singularValue,
      identifiers,
      org_id: orgId,
      schema_version: 'v1',
      source_system: 'synthetic_test',
      idempotency_key: uuid(),
    };
  }

  async function traceOf(auditEventId) {
    const result = await client.query(
      `SELECT resolution_path, candidate_ids, block_keys_available, block_results,
              signal_results, best_candidate_id, skip_reason
         FROM resolution_trace WHERE audit_event_id = $1`,
      [auditEventId]
    );
    return result.rows[0];
  }

  function signalNames(trace) {
    const raw = trace && trace.signal_results;
    const rows = Array.isArray(raw) ? raw : [];
    return rows.map((row) => row.signal);
  }

  async function expectReview(result, anchor, signal) {
    const trace = await traceOf(result.audit_event_id);
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
    expect(trace.best_candidate_id).toBe(anchor);
    expect(signalNames(trace)).toContain(signal);
    expect(review.rows[0].fan_id_a).toBe(anchor);
    expect(review.rows[0].fan_id_b).toBe(result.fan_id);
    expect(review.rows[0].status).toBe('pending');
    expect(merges.rows).toHaveLength(0);
    return trace;
  }

  async function expectHardMatch(result, anchor) {
    const trace = await traceOf(result.audit_event_id);
    expect(result.match_type).toBe('hard');
    expect(result.is_new_record).toBe(false);
    expect(result.fan_id).toBe(anchor);
    expect(result.conflict_id).toBeNull();
    expect(trace.resolution_path).toBe('A');
  }

  test('exact email and a conflicting first name with no inbound birthday opens a review', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const anchor = await seedPerson(orgId, {
        email: 'sfe-2@example.com',
        name: 'omar inwood',
        dob: '1990-09-02',
      });
      const result = await resolverEngine(call(
        orgId,
        'email',
        'sfe-2@example.com',
        { name: 'carmen inwood' }
      ), client);
      await expectReview(result, anchor, 'first_name_conflict');
      const emails = await client.query(
        `SELECT fan_id FROM identifier_link
          WHERE org_id = $1 AND identifier_type = 'email' AND identifier_value = 'sfe-2@example.com'`,
        [orgId]
      );
      expect(emails.rows).toEqual([{ fan_id: anchor }]);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('exact email, equal birthdays, and a conflicting first name opens a review', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const anchor = await seedPerson(orgId, {
        email: 'sfe-3@example.com',
        name: 'una oakley',
        dob: '1991-03-08',
      });
      const result = await resolverEngine(call(
        orgId,
        'email',
        'sfe-3@example.com',
        { name: 'carmen oakley', dob: '1991-03-08' }
      ), client);
      await expectReview(result, anchor, 'first_name_conflict');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('exact email and the same name still hard-matches when the inbound birthday is missing', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const anchor = await seedPerson(orgId, {
        email: 'mb-1@example.com',
        name: 'ada lovelace',
        dob: '1990-04-02',
      });
      const result = await resolverEngine(call(
        orgId,
        'email',
        'mb-1@example.com',
        { name: 'ada lovelace' }
      ), client);
      await expectHardMatch(result, anchor);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('exact email and an agreeing first name still hard-matches when the surname changed', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const anchor = await seedPerson(orgId, {
        email: 'married@example.com',
        name: 'ada lovelace',
        dob: '1990-04-02',
      });
      const result = await resolverEngine(call(
        orgId,
        'email',
        'married@example.com',
        { name: 'ada smith', dob: '1990-04-02' }
      ), client);
      await expectHardMatch(result, anchor);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('a listed nickname on an exact email is not a first-name conflict', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const anchor = await seedPerson(orgId, {
        email: 'nick@example.com',
        name: 'robert vernon',
        dob: '1995-09-02',
      });
      const result = await resolverEngine(call(
        orgId,
        'email',
        'nick@example.com',
        { name: 'bob vernon', dob: '1995-09-02' }
      ), client);
      await expectHardMatch(result, anchor);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('a missing first name on one side of an exact email still hard-matches', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const anchor = await seedPerson(orgId, {
        email: 'noname@example.com',
        name: 'ada lovelace',
        dob: '1990-04-02',
      });
      const result = await resolverEngine(call(
        orgId,
        'email',
        'noname@example.com',
        { dob: '1990-04-02' }
      ), client);
      await expectHardMatch(result, anchor);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('exact name with a missing stored birthday opens a review', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const anchor = await seedPerson(orgId, {
        email: 'mb-3@example.com',
        name: 'quinn langley',
      });
      const result = await resolverEngine(call(
        orgId,
        'name',
        'quinn langley',
        { dob: '1993-01-06' }
      ), client);
      await expectReview(result, anchor, 'exact_name_missing_birthday');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('exact name with a missing inbound birthday opens a review', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const anchor = await seedPerson(orgId, {
        name: 'quinn langley',
        dob: '1993-01-06',
      });
      const result = await resolverEngine(call(
        orgId,
        'name',
        'quinn langley',
        {}
      ), client);
      await expectReview(result, anchor, 'exact_name_missing_birthday');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('exact name, equal birthdays, and no incoming email opens a review', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const anchor = await seedPerson(orgId, {
        email: 'ca-4@example.com',
        name: 'orla maddox',
        dob: '1995-01-06',
      });
      const result = await resolverEngine(call(
        orgId,
        'name',
        'orla maddox',
        { dob: '1995-01-06' }
      ), client);
      await expectReview(result, anchor, 'exact_name_missing_email');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('exact name and equal birthdays stay a hard match when an incoming email is present', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const anchor = await seedPerson(orgId, {
        email: 'stored@example.com',
        name: 'orla maddox',
        dob: '1995-01-06',
      });
      const result = await resolverEngine(call(
        orgId,
        'name',
        'orla maddox',
        { dob: '1995-01-06', email: 'different@example.com' }
      ), client);
      await expectHardMatch(result, anchor);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('a new email, the same name, and a missing inbound birthday is retrieved and reviewed', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const anchor = await seedPerson(orgId, {
        email: 'mb-2-a@example.com',
        name: 'lionel gresham',
        dob: '1992-08-01',
      });
      const result = await resolverEngine(call(
        orgId,
        'email',
        'mb-2-b@example.com',
        { name: 'lionel gresham' }
      ), client);
      const trace = await expectReview(result, anchor, 'exact_name_missing_birthday');
      const blocks = Array.isArray(trace.block_results) ? trace.block_results : [];
      expect(blocks).toContainEqual({ key: 'exact_name', block_size: 1, dropped: false });
      expect(trace.candidate_ids).toContain(anchor);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('an exact name retrieved by a different email is reviewed when the birthdays differ', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const anchor = await seedPerson(orgId, {
        email: 'jane.a.dob@example.com',
        name: 'jane doe',
        dob: '1990-04-02',
      });
      const result = await resolverEngine(call(
        orgId,
        'email',
        'jane.b.dob@example.com',
        { name: 'jane doe', dob: '1991-05-06' }
      ), client);
      const trace = await expectReview(result, anchor, 'dob_veto');
      const blocks = Array.isArray(trace.block_results) ? trace.block_results : [];
      expect(blocks).toContainEqual({ key: 'exact_name', block_size: 1, dropped: false });
    } finally {
      await cleanupOrg(orgId);
    }
  });

  test('a listed nickname and the same surname is retrieved when the birthday is swapped, and reviewed', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId);
      const anchor = await seedPerson(orgId, {
        email: 'co-1-a@example.com',
        name: 'robert vernon',
        dob: '1995-09-02',
      });
      const result = await resolverEngine(call(
        orgId,
        'email',
        'co-1-b@example.com',
        { name: 'bob vernon', dob: '1995-02-09' }
      ), client);
      const trace = await expectReview(result, anchor, 'nickname_birthday_conflict');
      const blocks = Array.isArray(trace.block_results) ? trace.block_results : [];
      expect(blocks).toContainEqual({ key: 'nickname_surname', block_size: 1, dropped: false });
      expect(trace.candidate_ids).toContain(anchor);
      expect(result.match_type).not.toBe('hard');
    } finally {
      await cleanupOrg(orgId);
    }
  });
});
