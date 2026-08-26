'use strict';

// =============================================================================
// resolverEngine.trace.test.js
// Block instrumentation on resolution_trace (prompt 5 of 5)
//
// Connects to: LOCAL Postgres only (localhost:5432 via DATABASE_URL).
// Never run against port 5433 (Cloud SQL proxy).
//
// Handler-level logic — calls resolverEngine directly, no supertest.
// Fresh test org(s)/UUIDs per run. Cleanup in FK order in a finally block.
// audit_log and resolution_trace are both append-only — leave their rows,
// they are inert against fresh UUIDs (same pattern as
// resolverEngine.blocking.test.js).
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

describe('resolverEngine — trace block instrumentation', () => {
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
      [orgId, '_trace_test_org_' + seed, orgKeyHash('trace-' + seed + '-' + orgId)]
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

  // 1 — keys recorded on a successful retrieval.
  // Also carries assertion 15 (scoring_clock still non-null).
  test('1 — keys recorded on successful retrieval', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    try {
      await seedOrg(orgId, 't1');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'email', 'a@b.com', orgId);

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'a@b.com' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace).toBeDefined();
      expect(trace.block_keys_available).toContain('email');
      expect(trace.block_size_cap).toBe(50);
      expect(trace.blocks_dropped).toBe(0);
      expect(trace.block_results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'email', block_size: 1, dropped: false }),
        ])
      );

      // assertion 15 — scoring_clock now binds the injected clock captured at
      // the top of the resolution (Date.now(), before any DB work), NOT an
      // inline NOW() evaluated at INSERT time. Previously scoring_clock and
      // created_at were both bound via NOW() in the same INSERT statement and
      // were therefore identical (Postgres NOW() is stable per statement).
      // Now scoring_clock is captured strictly before created_at (which is
      // still NOW(), stamped after COMMIT) — asserting <= rather than <
      // because a fully mocked/instant resolution could theoretically land
      // the two values in the same millisecond.
      expect(trace.scoring_clock).not.toBeNull();
      const scoringClockMs = new Date(trace.scoring_clock).getTime();
      const createdAtMs    = new Date(trace.created_at).getTime();
      expect(scoringClockMs).toBeLessThanOrEqual(createdAtMs);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 2 — all three keys listed when all three are available on the inbound.
  test('2 — all three keys listed when all three are available', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId, 't2');

      const result = await resolverEngine(
        baseInput(orgId, {
          identifiers: {
            email:          'trace2@test.com',
            guardian_email: 'guardian2@test.com',
            name:           'trace two person',
            dob:            '1991-02-02',
          },
        }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.block_keys_available).toEqual(
        expect.arrayContaining(['email', 'guardian_email', 'name_dob'])
      );
      expect(trace.block_keys_available.length).toBe(3);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 3 — only available keys are listed.
  test('3 — only available keys are listed (email only)', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId, 't3');

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'trace3@test.com' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.block_keys_available).toEqual(['email']);
      expect(trace.block_results.length).toBe(1);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 4 — an empty block is recorded, not omitted.
  test('4 — empty block is recorded, not omitted', async () => {
    const orgId  = uuid();
    const seeded = Array.from({ length: 5 }, uuid);
    try {
      await seedOrg(orgId, 't4');
      for (let i = 0; i < seeded.length; i++) {
        await seedFan(seeded[i], orgId);
        await seedIdentifier(seeded[i], 'email', `seed4-${i}@t4.com`, orgId);
      }

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'nomatch4@t4.com' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.block_results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'email', block_size: 0 }),
        ])
      );
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 5 — no_block_key: nothing to build a key from.
  // Also assertion 12 — the row exists at all (a swallowed CHECK violation
  // would leave getTrace() returning undefined).
  test('5 — no_block_key: recall ceiling, nothing to search on', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId, 't5');

      const result = await resolverEngine(
        baseInput(orgId, { identifier_type: 'zip', identifier_value: '73102' }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace).toBeDefined(); // assertion 12
      expect(trace.skip_reason).toBe('no_block_key');
      expect(trace.scoring_status).toBe('skipped');
      expect(trace.block_keys_available).toEqual([]);
      expect(
        trace.block_results === null || trace.block_results.length === 0
      ).toBe(true);
      expect(trace.blocks_dropped).toBe(0);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 6 — empty_block: keys available, nothing dropped, every block came back
  // empty. Same seed shape as #4.
  test('6 — empty_block: keys available, all blocks empty', async () => {
    const orgId  = uuid();
    const seeded = Array.from({ length: 5 }, uuid);
    try {
      await seedOrg(orgId, 't6');
      for (let i = 0; i < seeded.length; i++) {
        await seedFan(seeded[i], orgId);
        await seedIdentifier(seeded[i], 'email', `seed6-${i}@t6.com`, orgId);
      }

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'nomatch6@t6.com' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace).toBeDefined(); // assertion 12
      expect(trace.skip_reason).toBe('empty_block');
      expect(trace.blocks_dropped).toBe(0);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 7 — block_dropped_oversize: a deliberate miss.
  test('7 — block_dropped_oversize: 51 sharers dropped whole', async () => {
    const orgId  = uuid();
    const fanIds = Array.from({ length: 51 }, uuid);
    try {
      await seedOrg(orgId, 't7');
      for (const id of fanIds) {
        await seedFan(id, orgId);
        // fan_pass — uq_identifier_per_org excludes fan_pass rows, which is
        // what lets 51 fans legitimately share one guardian_email (Lesson 25).
        await seedIdentifier(id, 'guardian_email', 'big7@fam.com', orgId, 'fan_pass');
      }

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { guardian_email: 'big7@fam.com' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace).toBeDefined(); // assertion 12
      expect(trace.skip_reason).toBe('block_dropped_oversize');
      expect(trace.blocks_dropped).toBe(1);
      expect(trace.block_results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'guardian_email',
            block_size: 51,
            dropped: true,
          }),
        ])
      );
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 8 — PRECEDENCE: dropped beats empty. One key oversized-dropped, the
  // sibling key's block comes back empty. block_dropped_oversize must win.
  test('8 — PRECEDENCE: dropped beats empty sibling block', async () => {
    const orgId  = uuid();
    const fanIds = Array.from({ length: 51 }, uuid);
    try {
      await seedOrg(orgId, 't8');
      for (const id of fanIds) {
        await seedFan(id, orgId);
        await seedIdentifier(id, 'guardian_email', 'big8@fam.com', orgId, 'fan_pass');
      }

      const result = await resolverEngine(
        baseInput(orgId, {
          identifiers: {
            guardian_email: 'big8@fam.com',
            email:          'nomatch8@t8.com',
          },
        }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.skip_reason).toBe('block_dropped_oversize');
      expect(trace.skip_reason).not.toBe('empty_block');
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 9 — PRECEDENCE: no_block_key beats everything. Name alone (no dob) builds
  // no key at all — no probe should run, no fans should be needed to prove it.
  test('9 — PRECEDENCE: no_block_key beats everything', async () => {
    const orgId = uuid();
    try {
      await seedOrg(orgId, 't9');

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { name: 'trace nine person' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.skip_reason).toBe('no_block_key');
      expect(trace.candidate_ids).toEqual([]);
      expect(trace.candidates_considered).toBe(0);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 10 — all_candidates_gated is unaffected by this change.
  //
  // NOT constructible in this file. Traced through passesSignalEligibilityGate
  // against all three block keys before writing this test:
  //   - email key: the probe only returns a fan_id via an exact
  //     identifier_link row (identifier_type='email', identifier_value =
  //     inbound.email). The candidate join's il_email LEFT JOIN matches that
  //     same row, so candidate.email is guaranteed non-null and equal to
  //     inbound.email -> email_similarity STRONG signal always fires.
  //   - guardian_email key: identical logic -> guardian_email STRONG signal
  //     always fires.
  //   - name_dob key: the probe requires inbound.name AND inbound.dob both
  //     non-null, and only returns a fan_id with BOTH a matching
  //     name_last_word row AND an exact dob row -> candidate.name and
  //     candidate.dob both non-null -> name_plus_dob STRONG signal always
  //     fires.
  // Every block-retrieved candidate therefore satisfies the gate
  // (strongCount >= 1) by construction. 'all_candidates_gated' is real and
  // reachable (see resolverEngine.test.js's mocked-DB coverage, which builds
  // a candidate row directly rather than retrieving it through a live block
  // probe), but not reachable through this file's real-Postgres retrieval
  // path. Reporting this rather than forcing a fixture around it, per the
  // prompt's own instruction.
  test.skip('10 — all_candidates_gated: not constructible via real block retrieval (see comment above)', () => {});

  // 11 — PATH A leaves the block columns at defaults.
  test('11 — PATH A leaves block columns at defaults', async () => {
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

      expect(trace.resolution_path).toBe('A');
      expect(trace.skip_reason).toBe('deterministic_match');
      expect(trace.block_keys_available).toEqual([]);
      expect(trace.block_results).toBeNull();
      expect(trace.blocks_dropped).toBe(0);
      expect(trace.block_size_cap).toBeNull();
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 13 — REGRESSION: trace write failure still does not break resolution.
  // Forces a genuine Postgres-level INSERT failure via a scoped BEFORE INSERT
  // trigger keyed to this test's org_id (installed and dropped within the
  // test) — no value resolverEngine legitimately builds can violate a CHECK
  // constraint from the outside, so this is the real-Postgres equivalent of
  // the mocked `resolutionTrace: { reject: ... }` case already covered in
  // resolverEngine.test.js.
  test('13 — REGRESSION: trace write failure does not break resolution (real Postgres)', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    const triggerFn   = `_test_force_trace_failure_${orgId.replace(/-/g, '_')}`;
    const triggerName = `_test_force_trace_failure_trigger`;
    try {
      await seedOrg(orgId, 't13');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'email', 'a13@b.com', orgId);

      await client.query(`
        CREATE OR REPLACE FUNCTION ${triggerFn}() RETURNS trigger AS $$
        BEGIN
          IF NEW.org_id = '${orgId}' THEN
            RAISE EXCEPTION 'forced trace failure for testing';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await client.query(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON resolution_trace
        FOR EACH ROW EXECUTE FUNCTION ${triggerFn}();
      `);

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'a13@b.com' } }),
        client
      );

      expect(result.fan_id).toBeTruthy();
      expect(result.audit_event_id).toBeTruthy();

      const auditRow = await client.query(
        `SELECT status FROM audit_log WHERE id = $1`,
        [result.audit_event_id]
      );
      expect(auditRow.rows.length).toBe(1);
      expect(auditRow.rows[0].status).toBe('success');

      const trace = await getTrace(result.audit_event_id);
      expect(trace).toBeUndefined();
    } finally {
      await client.query(`DROP TRIGGER IF EXISTS ${triggerName} ON resolution_trace`);
      await client.query(`DROP FUNCTION IF EXISTS ${triggerFn}()`);
      await cleanupOrg(orgId);
    }
  });

  // 14 — REGRESSION: PATH C and PATH D unchanged under the new columns.
  // Same score math as resolverEngine.blocking.test.js tests 12/13.
  test('14 — REGRESSION: PATH C unchanged (signal_results/best_score/best_candidate_id populated)', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    const EMAIL = 'tracec14@test-synth.com';
    const NAME  = 'jordan tracec14';
    try {
      await seedOrg(orgId, 't14c');
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
      expect(trace.signal_results).not.toBeNull();
      expect(trace.best_score).not.toBeNull();
      expect(trace.best_candidate_id).toBe(fanA);

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

  test('14 — REGRESSION: PATH D unchanged (signal_results/best_score/best_candidate_id populated)', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    try {
      await seedOrg(orgId, 't14d');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'name', 'Aaron TraceD14', orgId);
      await seedIdentifier(fanA, 'dob', '1990-03-15', orgId);

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { name: 'Aaron TraceD14', dob: '1990-03-15' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(result.match_type).toBe('conflict');
      expect(trace.resolution_path).toBe('D');
      expect(trace.signal_results).not.toBeNull();
      expect(trace.best_score).not.toBeNull();
      expect(trace.best_candidate_id).toBe(fanA);

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
});
