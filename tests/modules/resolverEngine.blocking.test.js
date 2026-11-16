'use strict';

// =============================================================================
// resolverEngine.blocking.test.js
// Wiring findBlockCandidates into resolverEngine (prompt 4 of 5)
//
// Connects to: LOCAL Postgres only (localhost:5432 via DATABASE_URL).
// Never run against port 5433 (Cloud SQL proxy).
//
// Handler-level logic — calls resolverEngine directly, no supertest.
// Fresh test org(s)/UUIDs per run.
//
// CLEANUP NOTE: resolverEngine writes a resolution_trace row on every real
// resolution (append-only trigger; FK-pins org, fan, conflict_queue, and
// audit_log — see tests/resolverEngine.smoke.js for the same pattern). Only
// the idempotency short-circuit (assertion 15) returns before that write.
// Cleanup here deletes identifier_link + staging_household_data, then
// best-effort fan/org deletes wrapped in try/catch — those fail once a trace
// row pins them and are left inert, same treatment as audit_log rows.
// =============================================================================

require('dotenv').config();

const { Client } = require('pg');
const crypto     = require('crypto');
const { resolverEngine } = require('../../src/modules/resolverEngine');

function uuid() {
  return crypto.randomUUID();
}

function orgKeyHash(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

describe('resolverEngine — blocking wiring', () => {
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function seedOrg(orgId, seed) {
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash) VALUES ($1, $2, $3)`,
      [orgId, '_blocking_test_org_' + seed, orgKeyHash('blocking-' + seed + '-' + orgId)]
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

  async function seedIdentifier(fanId, type, value, orgId, sourceSystem = 'test') {
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, 'v1', 1.0, NOW(), NOW())`,
      [fanId, type, value, orgId, sourceSystem]
    );
  }

  async function cleanupOrg(orgId) {
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
    try {
      await client.query(`DELETE FROM staging_household_data WHERE org_id = $1`, [orgId]);
      await client.query(`DELETE FROM identifier_link WHERE org_id = $1`, [orgId]);
    } catch (cleanupErr) {
      console.error('Cleanup error (identifier_link/staging):', cleanupErr.message);
    }
    try {
      await client.query(`DELETE FROM fan WHERE org_id = $1`, [orgId]);
    } catch {
      // pinned by resolution_trace — left inert, fresh UUID next run
    }
    try {
      await client.query(`DELETE FROM org WHERE id = $1`, [orgId]);
    } catch {
      // pinned by resolution_trace — left inert, fresh UUID next run
    }
  }

  async function getTrace(auditEventId) {
    const result = await client.query(
      `SELECT * FROM resolution_trace WHERE audit_event_id = $1`,
      [auditEventId]
    );
    return result.rows[0];
  }

  function baseInput(orgId, overrides = {}) {
    return {
      identifier_type:  'nfc_uid',
      identifier_value: uuid(),
      org_id:           orgId,
      schema_version:   'v1',
      source_system:    'synthetic_test',
      idempotency_key:  uuid(),
      ...overrides,
    };
  }

  // 1 — blocking narrows. Proves LIMIT 100 is gone: pre-blocking, all 6 fans
  // would have been considered.
  test('1 — blocking narrows: candidates_considered === 1, candidate_ids is [A.id]', async () => {
    const orgId  = uuid();
    const fanA   = uuid();
    const others = Array.from({ length: 5 }, uuid);
    try {
      await seedOrg(orgId, 't1');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'email', 'a@b.com', orgId);
      for (let i = 0; i < others.length; i++) {
        await seedFan(others[i], orgId);
        await seedIdentifier(others[i], 'email', `other${i}@b.com`, orgId);
      }

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'a@b.com' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.candidates_considered).toBe(1);
      expect(trace.candidate_ids).toEqual([fanA]);
      expect(trace.candidates_gated).toBe(0); // assertion 7 (gate invariant)
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 2 — name_dob path reaches the scorer via the last-word key.
  test('2 — name_dob path reaches the scorer: considered === 1, scored === 1', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    try {
      await seedOrg(orgId, 't2');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'name', 'robert smith', orgId);
      await seedIdentifier(fanA, 'dob', '1990-01-01', orgId);

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { name: 'bob smith', dob: '1990-01-01' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.candidates_considered).toBe(1);
      expect(trace.candidates_scored).toBe(1);
      expect(trace.candidates_gated).toBe(0); // assertion 7 (gate invariant)
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 3 — union, not intersect. Two fans, one per key, both reach the scorer.
  test('3 — union reaches the scorer: considered === 2, both ids present', async () => {
    const orgId = uuid();
    const fanA  = uuid(); // email only
    const fanB  = uuid(); // name + dob only
    try {
      await seedOrg(orgId, 't3');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'email', 'union3@test.com', orgId);
      await seedFan(fanB, orgId);
      await seedIdentifier(fanB, 'name', 'union person', orgId);
      await seedIdentifier(fanB, 'dob', '1985-05-05', orgId);

      const result = await resolverEngine(
        baseInput(orgId, {
          identifiers: { email: 'union3@test.com', name: 'union person', dob: '1985-05-05' },
        }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.candidates_considered).toBe(2);
      expect([...trace.candidate_ids].sort()).toEqual([fanA, fanB].sort());
      expect(trace.candidates_gated).toBe(0); // assertion 7 (gate invariant)
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 4 — no block key available (identifier_type 'zip' builds no key) → PATH B
  // fires without ever scanning the 10 seeded fans.
  test('4 — no block key available: PATH B fires without a scan, considered === 0', async () => {
    const orgId  = uuid();
    const seeded = Array.from({ length: 10 }, uuid);
    try {
      await seedOrg(orgId, 't4');
      for (let i = 0; i < seeded.length; i++) {
        await seedFan(seeded[i], orgId);
        await seedIdentifier(seeded[i], 'email', `seed4-${i}@t4.com`, orgId);
      }

      const result = await resolverEngine(
        baseInput(orgId, { identifier_type: 'zip', identifier_value: '73102' }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.candidates_considered).toBe(0);
      expect(trace.candidate_ids).toEqual([]);
      expect(result.match_type).toBe('hard');
      expect(result.is_new_record).toBe(true);
      expect(trace.resolution_path).toBe('B');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 5 — keys available but the block comes back empty → PATH B.
  // Also covers assertion 8: bestMatch stays null, no staging row, no throw.
  test('5 — keys available but block empty: PATH B fires, considered === 0', async () => {
    const orgId  = uuid();
    const seeded = Array.from({ length: 10 }, uuid);
    try {
      await seedOrg(orgId, 't5');
      for (let i = 0; i < seeded.length; i++) {
        await seedFan(seeded[i], orgId);
        await seedIdentifier(seeded[i], 'email', `noshare5-${i}@t5.com`, orgId);
      }

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'nomatch5@t5.com' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.candidates_considered).toBe(0);
      expect(trace.resolution_path).toBe('B');

      // assertion 8 — bestSignals stays [], guardianEmailSignal undefined,
      // staging block skipped by arithmetic, trace row still written.
      const staging = await client.query(
        `SELECT COUNT(*) AS n FROM staging_household_data WHERE org_id = $1`,
        [orgId]
      );
      expect(parseInt(staging.rows[0].n, 10)).toBe(0);
      expect(trace).toBeDefined();
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 6 — an oversized block (51 sharers) is dropped whole, not truncated to 50.
  test('6 — oversized block dropped whole: 51 sharers → considered === 0, PATH B', async () => {
    const orgId  = uuid();
    const fanIds = Array.from({ length: 51 }, uuid);
    try {
      await seedOrg(orgId, 't6');
      for (const id of fanIds) {
        await seedFan(id, orgId);
        // fan_pass — uq_identifier_per_org excludes fan_pass rows, which is
        // what lets 51 fans legitimately share one guardian_email (Lesson 25).
        await seedIdentifier(id, 'guardian_email', 'big@fam.com', orgId, 'fan_pass');
      }

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { guardian_email: 'big@fam.com' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.candidates_considered).toBe(0);
      expect(trace.resolution_path).toBe('B');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 9 — a deleted fan sharing the inbound email must not reach the scorer.
  // findBlockCandidates filters deleted_at IS NULL inside its own probe.
  test('9 — deleted fans excluded: considered === 0', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    try {
      await seedOrg(orgId, 't9');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'email', 'deleted9@t9.com', orgId);
      await client.query(`UPDATE fan SET deleted_at = NOW() WHERE id = $1`, [fanA]);

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'deleted9@t9.com' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.candidates_considered).toBe(0);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 10 — cross-org isolation: the same email in a second org must not surface.
  test('10 — cross-org isolation: candidate_ids is [A.id] only', async () => {
    const orgId      = uuid();
    const otherOrgId = uuid();
    const fanA       = uuid();
    const fanZ       = uuid();
    try {
      await seedOrg(orgId, 't10a');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'email', 'crossorg10@test.com', orgId);

      await seedOrg(otherOrgId, 't10b'); // switches app.current_org_id to otherOrgId
      await seedFan(fanZ, otherOrgId);
      await seedIdentifier(fanZ, 'email', 'crossorg10@test.com', otherOrgId);

      await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'crossorg10@test.com' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.candidate_ids).toEqual([fanA]);
    } finally {
      await cleanupOrg(orgId);
      await cleanupOrg(otherOrgId);
    }
  });

  // 11 — REGRESSION: PATH A returns before the block phase and never enters it.
  test('11 — REGRESSION: PATH A untouched, never enters the block phase', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    try {
      await seedOrg(orgId, 't11');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'email', 'patha11@test.com', orgId);

      const result = await resolverEngine(
        baseInput(orgId, { identifier_type: 'email', identifier_value: 'patha11@test.com' }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(result.match_type).toBe('hard');
      expect(result.is_new_record).toBe(false);
      expect(trace.resolution_path).toBe('A');
      expect(trace.skip_reason).toBe('deterministic_match');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 12 — REGRESSION: PATH C still fires end to end under blocking.
  // Same score math as resolverEngine.smoke.js's runPathC: email EXACT (0.7)
  // + name_alone FUZZY (0.3), no dob on either side, additive sum 1.0.
  test('12 — REGRESSION: PATH C still fires end to end', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    const EMAIL = 'pathc12@test-synth.com';
    const NAME  = 'jordan pathc12';
    try {
      await seedOrg(orgId, 't12');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'email', EMAIL, orgId);
      await seedIdentifier(fanA, 'name', NAME, orgId);

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: EMAIL, name: NAME } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(result.match_type).toBe('soft');
      expect(trace.resolution_path).toBe('C');
      expect(trace.candidates_scored).toBeGreaterThanOrEqual(1);

      const conflict = await client.query(
        `SELECT status FROM conflict_queue WHERE id = $1`,
        [result.conflict_id]
      );
      expect(conflict.rows.length).toBe(1);
      expect(conflict.rows[0].status).toBe('pending');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 13 — REGRESSION: PATH D still fires end to end under blocking.
  // Same score math as resolverEngine.smoke.js's runPathD: name_plus_dob
  // fires (0.7), no email conflict, 0.60 <= 0.70 < 0.85.
  test('13 — REGRESSION: PATH D still fires end to end', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    try {
      await seedOrg(orgId, 't13');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'name', 'Aaron Test13', orgId);
      await seedIdentifier(fanA, 'dob', '1990-03-15', orgId);

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { name: 'Aaron Test13', dob: '1990-03-15' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(result.match_type).toBe('conflict');
      expect(trace.resolution_path).toBe('D');

      const conflict = await client.query(
        `SELECT status FROM conflict_queue WHERE id = $1`,
        [result.conflict_id]
      );
      expect(conflict.rows.length).toBe(1);
      expect(conflict.rows[0].status).toBe('pending');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 14 — the 14-key candidate projection reaching scoreMatch is unchanged.
  // Distinguishes the real candidate join (alias il_gemail) from
  // findBlockCandidates' own probes, which never select identifier_value
  // under that alias.
  test('14 — 14-key candidate shape unchanged', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    try {
      await seedOrg(orgId, 't14');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'email', 'shape14@test.com', orgId);

      const spy = jest.spyOn(client, 'query');
      await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'shape14@test.com' } }),
        client
      );

      const joinCallIdx = spy.mock.calls.findIndex(
        c => typeof c[0] === 'string' && c[0].includes('il_gemail.identifier_value')
      );
      expect(joinCallIdx).toBeGreaterThan(-1);

      const joinResult = await spy.mock.results[joinCallIdx].value;
      expect(joinResult.rows.length).toBe(1);
      expect(Object.keys(joinResult.rows[0]).sort()).toEqual(
        [
          'id', 'org_id',
          'email', 'email_last_seen_at',
          'name', 'name_last_seen_at',
          'dob', 'dob_last_seen_at',
          'zip', 'zip_last_seen_at',
          'device_id', 'device_last_seen_at',
          'guardian_email', 'guardian_email_last_seen_at',
        ].sort()
      );

      spy.mockRestore();
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 15 — the idempotency short-circuit still returns before BEGIN and never
  // reaches the block phase (only the org check + idempotency SELECT run).
  test('15 — idempotency short-circuit unchanged: never reaches the block phase', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId, 't15');

      const input = baseInput(orgId, {
        identifier_type:  'email',
        identifier_value: 'idem15@test.com',
      });

      const first = await resolverEngine(input, client);

      const spy   = jest.spyOn(client, 'query');
      const second = await resolverEngine(input, client);

      expect(second.fan_id).toBe(first.fan_id);
      expect(second.audit_event_id).toBe(first.audit_event_id);

      // Only GUARD 1 (org check) + GUARD 2 (idempotency SELECT) ran.
      expect(spy.mock.calls.length).toBe(2);
      const blockProbe = spy.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('il_n.name_last_word')
      );
      expect(blockProbe).toBeUndefined();

      spy.mockRestore();
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 16 — nickname plus same birthday and a different email still opens review.
  // name_dob retrieves Robert. name_plus_dob scores 0.7, the email penalty
  // subtracts 0.3, and the review floor keeps the real 0.4 score on path D.
  test('16 — nickname, same birthday, different email opens review at 0.4', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    try {
      await seedOrg(orgId, 't16');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'name', 'robert smith', orgId);
      await seedIdentifier(fanA, 'dob', '1990-01-15', orgId);
      await seedIdentifier(fanA, 'email', 'robert@example.com', orgId);

      const result = await resolverEngine(
        baseInput(orgId, {
          identifiers: {
            name: 'bob smith',
            dob: '1990-01-15',
            email: 'bob@example.com',
          },
        }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(result.match_type).toBe('conflict');
      expect(result.confidence_score).toBeCloseTo(0.4, 5);
      expect(trace.resolution_path).toBe('D');
      expect(trace.candidates_considered).toBe(1);
      expect(trace.candidate_ids).toEqual([fanA]);

      const conflict = await client.query(
        `SELECT fan_id_a, status, confidence_score FROM conflict_queue WHERE id = $1`,
        [result.conflict_id]
      );
      expect(conflict.rows.length).toBe(1);
      expect(conflict.rows[0].fan_id_a).toBe(fanA);
      expect(conflict.rows[0].status).toBe('pending');
      expect(parseFloat(conflict.rows[0].confidence_score)).toBeCloseTo(0.4, 5);
    } finally {
      await cleanupOrg(orgId);
    }
  });

});
