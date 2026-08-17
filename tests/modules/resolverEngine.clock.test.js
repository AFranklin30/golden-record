'use strict';

// =============================================================================
// resolverEngine.clock.test.js
// One resolution, one moment — scoring_clock captured once, passed into every
// scoreMatch call and bound to the trace (follow-up to the blocking build).
//
// Connects to: LOCAL Postgres only (localhost:5432 via DATABASE_URL).
// Never run against port 5433 (Cloud SQL proxy).
//
// Handler-level logic — calls resolverEngine directly, no supertest.
// Fresh test org(s)/UUIDs per run. Cleanup in FK order in a finally block.
// audit_log and resolution_trace are both append-only — leave their rows,
// inert against fresh UUIDs (same pattern as resolverEngine.trace.test.js).
//
// probabilisticMatcher is mocked with a jest.fn WRAPPING the real
// implementation (jest.requireActual) — real scores, real behavior, but
// scoreMatch's call args become inspectable for assertions 3 and 4. This is
// the only way to observe resolverEngine's internal scoreMatch calls: it
// destructures `scoreMatch` at require time, so a spy installed after
// require would never be seen by resolverEngine's own reference. jest.mock
// is hoisted above all requires, so the wrap is in place before
// resolverEngine.js's own `require('./probabilisticMatcher')` resolves.
// =============================================================================

require('dotenv').config();

jest.mock('../../src/modules/probabilisticMatcher', () => {
  const actual = jest.requireActual('../../src/modules/probabilisticMatcher');
  return {
    ...actual,
    scoreMatch: jest.fn(actual.scoreMatch),
  };
});

const { Client }     = require('pg');
const crypto          = require('crypto');
const { scoreMatch }  = require('../../src/modules/probabilisticMatcher');
const { resolverEngine } = require('../../src/modules/resolverEngine');

function uuid() {
  return crypto.randomUUID();
}

function orgKeyHash(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

describe('resolverEngine — scoring_clock (one resolution, one moment)', () => {
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(() => {
    // mockClear only — NOT mockReset, which would strip the wrapped real
    // implementation and break every test's actual scoring behavior.
    scoreMatch.mockClear();
  });

  async function seedOrg(orgId, seed) {
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash) VALUES ($1, $2, $3)`,
      [orgId, '_clock_test_org_' + seed, orgKeyHash('clock-' + seed + '-' + orgId)]
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

  // 1 — scoring_clock is stamped and plausible.
  test('1 — scoring_clock falls between before/after timestamps', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    try {
      await seedOrg(orgId, 't1');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'email', 'clock1@t1.com', orgId);

      const before = Date.now();
      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'clock1@t1.com' } }),
        client
      );
      const after = Date.now();
      const trace = await getTrace(result.audit_event_id);

      const scoringClockMs = new Date(trace.scoring_clock).getTime();
      expect(scoringClockMs).toBeGreaterThanOrEqual(before);
      expect(scoringClockMs).toBeLessThanOrEqual(after);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 2 — scoring_clock precedes (or equals) created_at on the same row.
  test('2 — scoring_clock <= created_at', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    try {
      await seedOrg(orgId, 't2');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'email', 'clock2@t2.com', orgId);

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'clock2@t2.com' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      const scoringClockMs = new Date(trace.scoring_clock).getTime();
      const createdAtMs    = new Date(trace.created_at).getTime();
      const gapMs           = createdAtMs - scoringClockMs;

      expect(scoringClockMs).toBeLessThanOrEqual(createdAtMs);
      if (gapMs > 0) {
        expect(scoringClockMs).toBeLessThan(createdAtMs);
      }
      // eslint-disable-next-line no-console
      console.log(`assertion 2 — observed scoring_clock -> created_at gap: ${gapMs}ms`);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 3 — every candidate in one resolution is scored against the SAME clock.
  // Three fans share one 'email' identifier value via source_system =
  // 'fan_pass' (uq_identifier_per_org excludes fan_pass rows — same
  // technique resolverEngine.trace.test.js's oversized-block fixture uses,
  // just at a size well under BLOCK_SIZE_CAP so nothing gets dropped).
  test('3 — identical clock passed to scoreMatch across all candidates', async () => {
    const orgId  = uuid();
    const fanIds = Array.from({ length: 3 }, uuid);
    try {
      await seedOrg(orgId, 't3');
      for (const id of fanIds) {
        await seedFan(id, orgId);
        await seedIdentifier(id, 'email', 'shared-clock3@t3.com', orgId, 'fan_pass');
      }

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'shared-clock3@t3.com' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.candidates_scored).toBe(3);
      expect(scoreMatch.mock.calls.length).toBe(3);

      const clocksSeen = scoreMatch.mock.calls.map(call => call[2]);
      expect(new Set(clocksSeen).size).toBe(1);
      clocksSeen.forEach(c => expect(c).toBe(clocksSeen[0]));
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 4 — the clock passed to scoreMatch equals the clock persisted on the
  // trace, from the same resolution as assertion 3.
  test('4 — clock passed to scoreMatch equals the persisted scoring_clock', async () => {
    const orgId  = uuid();
    const fanIds = Array.from({ length: 3 }, uuid);
    try {
      await seedOrg(orgId, 't4');
      for (const id of fanIds) {
        await seedFan(id, orgId);
        await seedIdentifier(id, 'email', 'shared-clock4@t4.com', orgId, 'fan_pass');
      }

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'shared-clock4@t4.com' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(scoreMatch.mock.calls.length).toBe(3);
      const clockPassedToScorer = scoreMatch.mock.calls[0][2];
      const persistedScoringClockMs = new Date(trace.scoring_clock).getTime();

      expect(persistedScoringClockMs).toBe(clockPassedToScorer);
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 5 — PATH A stamps scoring_clock too, even though scoreMatch never runs.
  test('5 — PATH A stamps scoring_clock', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    try {
      await seedOrg(orgId, 't5');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'email', 'patha5@t5.com', orgId);

      const before = Date.now();
      const result = await resolverEngine(
        baseInput(orgId, { identifier_type: 'email', identifier_value: 'patha5@t5.com' }),
        client
      );
      const after = Date.now();
      const trace = await getTrace(result.audit_event_id);

      expect(trace.resolution_path).toBe('A');
      expect(trace.skip_reason).toBe('deterministic_match');
      expect(trace.scoring_clock).not.toBeNull();
      const scoringClockMs = new Date(trace.scoring_clock).getTime();
      expect(scoringClockMs).toBeGreaterThanOrEqual(before);
      expect(scoringClockMs).toBeLessThanOrEqual(after);
      expect(scoreMatch).not.toHaveBeenCalled();
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 6 — PATH B with zero candidates (no_block_key) stamps scoring_clock too.
  test('6 — no_block_key PATH B stamps scoring_clock', async () => {
    const orgId  = uuid();
    const seeded = Array.from({ length: 5 }, uuid);
    try {
      await seedOrg(orgId, 't6');
      for (let i = 0; i < seeded.length; i++) {
        await seedFan(seeded[i], orgId);
        await seedIdentifier(seeded[i], 'email', `seed6-${i}@t6.com`, orgId);
      }

      const result = await resolverEngine(
        baseInput(orgId, { identifier_type: 'zip', identifier_value: '73102' }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.skip_reason).toBe('no_block_key');
      expect(trace.scoring_clock).not.toBeNull();
      expect(scoreMatch).not.toHaveBeenCalled();
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 7 — REGRESSION: PATH C score unchanged. Same score math as
  // resolverEngine.blocking.test.js's test 12: email EXACT (0.7) +
  // name_alone FUZZY (0.3), no dob on either side, additive sum 1.0.
  test('7 — REGRESSION: PATH C score unchanged (1.0)', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    const EMAIL = 'pathc7@t7.com';
    const NAME  = 'jordan clockc7';
    try {
      await seedOrg(orgId, 't7');
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
      expect(Number(trace.best_score)).toBeCloseTo(1.0, 5);
      expect(result.confidence_score).toBeCloseTo(1.0, 5);

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

  // 8 — REGRESSION: PATH D score unchanged. Same score math as
  // resolverEngine.blocking.test.js's test 13: name_plus_dob alone (0.7),
  // 0.60 <= 0.70 < 0.85.
  test('8 — REGRESSION: PATH D score unchanged (0.7)', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    try {
      await seedOrg(orgId, 't8');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'name', 'Aaron ClockD8', orgId);
      await seedIdentifier(fanA, 'dob', '1990-03-15', orgId);

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { name: 'Aaron ClockD8', dob: '1990-03-15' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(result.match_type).toBe('conflict');
      expect(trace.resolution_path).toBe('D');
      expect(Number(trace.best_score)).toBeCloseTo(0.7, 5);
      expect(result.confidence_score).toBeCloseTo(0.7, 5);

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

  // 9 — REGRESSION: block metadata still populated correctly. The trace
  // INSERT's placeholder numbering changed (scoring_clock moved from an
  // inline NOW() to $19, shifting everything after it) — every other column
  // needs re-proving, not just the new one.
  test('9 — REGRESSION: block metadata columns still correct', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    try {
      await seedOrg(orgId, 't9');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'email', 'blockmeta9@t9.com', orgId);

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'blockmeta9@t9.com' } }),
        client
      );
      const trace = await getTrace(result.audit_event_id);

      expect(trace.block_keys_available).toContain('email');
      expect(trace.block_size_cap).toBe(50);
      expect(trace.blocks_dropped).toBe(0);
      expect(trace.block_results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'email', block_size: 1, dropped: false }),
        ])
      );
    } finally {
      await cleanupOrg(orgId);
    }
  });

  // 10 — trace write failure still does not break resolution (Stage 7
  // decision B). Force the INSERT to fail by poisoning org_id on a client
  // proxy scoped to just the resolution_trace statement.
  test('10 — trace write failure does not break resolution', async () => {
    const orgId = uuid();
    const fanA  = uuid();
    try {
      await seedOrg(orgId, 't10');
      await seedFan(fanA, orgId);
      await seedIdentifier(fanA, 'email', 'tracefail10@t10.com', orgId);

      const realQuery = client.query.bind(client);
      const failingDb = {
        query: (text, params) => {
          if (typeof text === 'string' && text.includes('INSERT INTO resolution_trace')) {
            return Promise.reject(new Error('simulated resolution_trace failure'));
          }
          return realQuery(text, params);
        },
      };

      const result = await resolverEngine(
        baseInput(orgId, { identifiers: { email: 'tracefail10@t10.com' } }),
        failingDb
      );

      expect(result.fan_id).toEqual(expect.any(String));
      expect(result.audit_event_id).toEqual(expect.any(String));

      const audit = await client.query(
        `SELECT status FROM audit_log WHERE id = $1`,
        [result.audit_event_id]
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0].status).toBe('success');

      const trace = await getTrace(result.audit_event_id);
      expect(trace).toBeUndefined();
    } finally {
      await cleanupOrg(orgId);
    }
  });
});
