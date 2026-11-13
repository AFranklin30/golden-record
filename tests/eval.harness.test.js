'use strict';

// =============================================================================
// tests/eval.harness.test.js
// Stage 7 evaluation harness — eval/harness.js + eval/runCorpus.js
//
// Connects to: LOCAL Postgres only (localhost:5432 via DATABASE_URL).
// Never run against port 5433 (Cloud SQL proxy). Pattern matches
// tests/migration_014.test.js — Jest-collected, real DB, raw pg.Client.
//
// Cleanup note: resolution_trace is append-only — DELETE throws. testOrgId
// (main describe) and the regression test's own org are permanently leaked
// via that FK pin. Fresh UUIDs per run make them inert, exactly as
// tests/migration_014.test.js and tests/resolverEngine.smoke.js leave rows.
// =============================================================================

require('dotenv').config();

const fs     = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');

const pool             = require('../src/db/pool');
const harness           = require('../eval/harness');
const runCorpus         = require('../eval/runCorpus');
const probabilisticMatcher = require('../src/modules/probabilisticMatcher');
const { NORMALIZATION_VERSION } = require('../src/modules/normalizer');
const { resolverEngine } = require('../src/modules/resolverEngine');

function orgKeyHash(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

function buildSnapshot(orgId, overrides = {}) {
  return {
    id: crypto.randomUUID(),
    org_id: orgId,
    email: null, email_last_seen_at: null,
    name: null, name_last_seen_at: null,
    dob: null, dob_last_seen_at: null,
    zip: null, zip_last_seen_at: null,
    device_id: null, device_last_seen_at: null,
    guardian_email: null, guardian_email_last_seen_at: null,
    ...overrides,
  };
}

function buildInbound(orgId, overrides = {}) {
  return {
    org_id: orgId,
    email: null, name: null, dob: null, zip: null, device_id: null, guardian_email: null,
    ...overrides,
  };
}

async function insertTrace(client, {
  id, org_id, resolution_path, scoring_status, skip_reason,
  inbound_identifiers, best_score, scorer_version, normalization_version,
  is_new_record,
}) {
  await client.query(
    `INSERT INTO resolution_trace
       (id, org_id, resolution_path, scoring_status, skip_reason,
        inbound_identifiers, candidate_ids, candidates_considered,
        candidates_gated, candidates_scored, signal_results,
        best_candidate_id, best_score, threshold_path_c, threshold_path_d,
        scorer_version, normalization_version, scoring_clock,
        resulting_fan_id, is_new_record, conflict_id)
     VALUES
       ($1, $2, $3, $4, $5,
        $6, '{}', 0, 0, 0, NULL,
        NULL, $7, 0.85, 0.60,
        $8, $9, NOW(),
        NULL, $10, NULL)`,
    [
      id, org_id, resolution_path, scoring_status, skip_reason,
      JSON.stringify(inbound_identifiers), best_score,
      scorer_version, normalization_version, is_new_record,
    ]
  );
}

async function insertCorpus(client, {
  id, org_id, source, trace_id, inbound_identifiers, candidate_snapshot,
  expected_verdict, scorer_version,
}) {
  await client.query(
    `INSERT INTO evaluation_corpus
       (id, org_id, source, trace_id, inbound_identifiers, candidate_snapshot,
        expected_verdict, rationale, observed_score, observed_path,
        scorer_version, created_by)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, $8, 'test')`,
    [
      id, org_id, source, trace_id,
      JSON.stringify(inbound_identifiers),
      candidate_snapshot != null ? JSON.stringify(candidate_snapshot) : null,
      expected_verdict, scorer_version ?? null,
    ]
  );
}

async function insertLabel(client, { trace_id, org_id, labeled_by, verdict, label_source }) {
  await client.query(
    `INSERT INTO trace_label (trace_id, org_id, verdict, labeled_by, label_source)
     VALUES ($1, $2, $3, $4, $5)`,
    [trace_id, org_id, verdict, labeled_by, label_source]
  );
}

describe('eval/harness + eval/runCorpus — Stage 7 evaluation replay', () => {
  let client;
  let testOrgId;
  let runResult;
  let scoreMatchSpy;

  let trace5Id, traceStubId;
  let corpusIdE, corpusIdF, corpusIdG, corpusIdH, corpusIdI, corpusIdStub;
  let candidateSnapshotG;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    testOrgId = crypto.randomUUID();
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash) VALUES ($1, $2, $3)`,
      [testOrgId, '_eval_harness_test_org', orgKeyHash('eval-harness-' + testOrgId)]
    );
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

    // ---- fixture (e): promoted_trace + snapshot — state 3 ----------------
    // name_plus_dob fires: weight 0.7 * recency 0.8 (7 months stale) =
    // 0.7 * 0.8 = 0.5600000000000001 in JS. Stored trace best_score is the
    // literal 0.56, which numeric(4,3) round-trips as '0.560' -> parseFloat
    // 0.56 exactly. The two are NOT === but agree within SCORE_TOLERANCE —
    // this is the fixture that proves the tolerance path (assertions 3, 4).
    trace5Id = crypto.randomUUID();
    const inboundE = buildInbound(testOrgId, { name: 'jordan eval', dob: '1990-05-05' });
    await insertTrace(client, {
      id: trace5Id, org_id: testOrgId, resolution_path: 'B',
      scoring_status: 'performed', skip_reason: null,
      inbound_identifiers: inboundE, best_score: 0.56,
      scorer_version: probabilisticMatcher.SCORER_VERSION,
      normalization_version: NORMALIZATION_VERSION,
      is_new_record: true,
    });
    await insertLabel(client, {
      trace_id: trace5Id, org_id: testOrgId, labeled_by: 'aaron',
      verdict: 'match', label_source: 'manual',
    });
    await insertLabel(client, {
      trace_id: trace5Id, org_id: testOrgId, labeled_by: 'monique',
      verdict: 'not_match', label_source: 'manual',
    });

    corpusIdE = crypto.randomUUID();
    const candidateSnapshotE = buildSnapshot(testOrgId, {
      name: 'jordan eval', name_last_seen_at: '2025-12-01T00:00:00.000Z',
      dob: '1990-05-05',
    });
    await insertCorpus(client, {
      id: corpusIdE, org_id: testOrgId, source: 'promoted_trace', trace_id: trace5Id,
      inbound_identifiers: inboundE, candidate_snapshot: candidateSnapshotE,
      expected_verdict: 'match', scorer_version: probabilisticMatcher.SCORER_VERSION,
    });

    // ---- fixture (f): synthetic, gate PASSES (email = 1 strong signal) ---
    corpusIdF = crypto.randomUUID();
    const inboundF = buildInbound(testOrgId, { email: 'eval.f@test-synth.com' });
    const candidateSnapshotF = buildSnapshot(testOrgId, {
      email: 'eval.f@test-synth.com', email_last_seen_at: '2026-07-01T00:00:00.000Z',
    });
    await insertCorpus(client, {
      id: corpusIdF, org_id: testOrgId, source: 'synthetic', trace_id: null,
      inbound_identifiers: inboundF, candidate_snapshot: candidateSnapshotF,
      expected_verdict: 'match', scorer_version: probabilisticMatcher.SCORER_VERSION,
    });

    // ---- fixture (g): synthetic, gate FAILS (name alone = 1 weak signal) -
    corpusIdG = crypto.randomUUID();
    const inboundG = buildInbound(testOrgId, { name: 'sam only' });
    candidateSnapshotG = buildSnapshot(testOrgId, { name: 'sam only' });
    await insertCorpus(client, {
      id: corpusIdG, org_id: testOrgId, source: 'synthetic', trace_id: null,
      inbound_identifiers: inboundG, candidate_snapshot: candidateSnapshotG,
      expected_verdict: 'unsure', scorer_version: probabilisticMatcher.SCORER_VERSION,
    });

    // ---- fixture (h): synthetic, gate passes, scorer_version NULL --------
    corpusIdH = crypto.randomUUID();
    const inboundH = buildInbound(testOrgId, { email: 'eval.h@test-synth.com' });
    const candidateSnapshotH = buildSnapshot(testOrgId, {
      email: 'eval.h@test-synth.com', email_last_seen_at: '2026-07-01T00:00:00.000Z',
    });
    await insertCorpus(client, {
      id: corpusIdH, org_id: testOrgId, source: 'synthetic', trace_id: null,
      inbound_identifiers: inboundH, candidate_snapshot: candidateSnapshotH,
      expected_verdict: 'match', scorer_version: null,
    });

    // ---- fixture (i): synthetic, gate passes, zip conflict + penalty -----
    // email matches (fires, gate passes); zip present + different on both
    // sides -> detectConflicts flags it, SIGNAL_CONFIG.disagreement.zip
    // (0.1) is subtracted. Non-DOB conflict, so no veto.
    corpusIdI = crypto.randomUUID();
    const inboundI = buildInbound(testOrgId, { email: 'conflict@test-synth.com', zip: '73102' });
    const candidateSnapshotI = buildSnapshot(testOrgId, {
      email: 'conflict@test-synth.com', email_last_seen_at: '2026-07-01T00:00:00.000Z',
      zip: '90001',
    });
    await insertCorpus(client, {
      id: corpusIdI, org_id: testOrgId, source: 'synthetic', trace_id: null,
      inbound_identifiers: inboundI, candidate_snapshot: candidateSnapshotI,
      expected_verdict: 'match', scorer_version: probabilisticMatcher.SCORER_VERSION,
    });

    // ---- PATH A stub trace, promoted but unscored -------------------------
    traceStubId = crypto.randomUUID();
    const inboundStub = { email: 'stub@test-synth.com' }; // singular PATH A shape
    await insertTrace(client, {
      id: traceStubId, org_id: testOrgId, resolution_path: 'A',
      scoring_status: 'skipped', skip_reason: 'deterministic_match',
      inbound_identifiers: inboundStub, best_score: null,
      scorer_version: probabilisticMatcher.SCORER_VERSION,
      normalization_version: NORMALIZATION_VERSION,
      is_new_record: false,
    });
    corpusIdStub = crypto.randomUUID();
    await insertCorpus(client, {
      id: corpusIdStub, org_id: testOrgId, source: 'promoted_trace', trace_id: traceStubId,
      inbound_identifiers: inboundStub, candidate_snapshot: null,
      expected_verdict: 'unsure', scorer_version: probabilisticMatcher.SCORER_VERSION,
    });

    // ---- run the harness end-to-end ---------------------------------------
    scoreMatchSpy = jest.spyOn(probabilisticMatcher, 'scoreMatch');
    runResult = await runCorpus.buildRun(client, testOrgId);
  });

  afterAll(async () => {
    if (scoreMatchSpy) scoreMatchSpy.mockRestore();

    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);
    try {
      await client.query(`DELETE FROM evaluation_corpus WHERE org_id = $1`, [testOrgId]);
    } catch (err) {
      console.error('cleanup: evaluation_corpus delete failed', err.message);
    }
    try {
      await client.query(`DELETE FROM trace_label WHERE org_id = $1`, [testOrgId]);
    } catch (err) {
      console.error('cleanup: trace_label delete failed', err.message);
    }
    try {
      await client.query(`DELETE FROM identifier_link WHERE org_id = $1`, [testOrgId]);
    } catch (err) {
      console.error('cleanup: identifier_link delete failed', err.message);
    }
    console.log(
      `cleanup: resolution_trace, audit_log, conflict_queue, fan, org left ` +
      `in place for org ${testOrgId} — append-only FK pins (resolution_trace).`
    );

    await client.end();
  });

  function findRow(corpusId) {
    return runResult.rows.find((r) => r.corpus_id === corpusId);
  }

  it('1. fixture (e) classifies as promoted_with_snapshot, score_source both', () => {
    const row = findRow(corpusIdE);
    expect(row.state).toBe('promoted_with_snapshot');
    expect(row.score_source).toBe('both');
  });

  it('2. fixture (e): replayed_score and trace_score both non-null numbers', () => {
    const row = findRow(corpusIdE);
    expect(typeof row.replayed_score).toBe('number');
    expect(typeof row.trace_score).toBe('number');
  });

  it('3. fixture (e): delta computed, agrees true within SCORE_TOLERANCE', () => {
    const row = findRow(corpusIdE);
    expect(row.delta).not.toBeNull();
    expect(row.agrees).toBe(true);
    expect(Math.abs(row.delta)).toBeLessThanOrEqual(harness.SCORE_TOLERANCE);
  });

  it('4. fixture (e): replayed_score !== trace_score under ===, yet agrees — proves the tolerance path', () => {
    const row = findRow(corpusIdE);
    expect(row.replayed_score === row.trace_score).toBe(false);
    expect(row.agrees).toBe(true);
  });

  it('5. fixture (e): both label rows returned, label_disagreement true', () => {
    const row = findRow(corpusIdE);
    expect(row.labels).toHaveLength(2);
    expect(row.label_disagreement).toBe(true);
  });

  it("6. fixture (e): monique's not_match is present despite expected_verdict=match", () => {
    const row = findRow(corpusIdE);
    expect(row.labels).toContainEqual({ labeled_by: 'monique', verdict: 'not_match' });
    expect(row.expected_verdict).toBe('match');
  });

  it('fixture (e): name and birthday under 0.60 replays as path D and keeps the real score', () => {
    const row = findRow(corpusIdE);
    expect(row.replayed_score).toBeLessThan(0.60);
    expect(row.signals_matched.some((s) => s.signal === 'name_plus_dob')).toBe(true);
    expect(row.replayed_path).toBe('D');
  });

  it('7. fixture (f): score_source replayed, trace_score null, gate_status passed', () => {
    const row = findRow(corpusIdF);
    expect(row.score_source).toBe('replayed');
    expect(row.trace_score).toBeNull();
    expect(row.gate_status).toBe('passed');
  });

  it('8. fixture (g): gated, replayed_score null, counted in counts.gated, scoreMatch not called for it', () => {
    const row = findRow(corpusIdG);
    expect(row.gate_status).toBe('gated');
    expect(row.replayed_score).toBeNull();
    expect(runResult.counts.gated).toBe(1);

    const calledWithG = scoreMatchSpy.mock.calls.some(
      (args) => args[0] && args[0].id === candidateSnapshotG.id
    );
    expect(calledWithG).toBe(false);
  });

  it('9. PATH A stub promoted row: skipped with trace_not_scored, no throw', () => {
    const row = findRow(corpusIdStub);
    expect(row.skipped).toBe(true);
    expect(row.skip_reason).toBe('trace_not_scored');
  });

  it('10. parseInboundIdentifiers normalizes both singular and full shapes to 7 keys', () => {
    const singular = harness.parseInboundIdentifiers({ email: 'x@test-synth.com' });
    expect(singular.shape).toBe('singular');
    expect(Object.keys(singular.inbound).sort()).toEqual(
      ['device_id', 'dob', 'email', 'guardian_email', 'name', 'org_id', 'zip'].sort()
    );
    expect(singular.inbound.email).toBe('x@test-synth.com');
    expect(singular.inbound.name).toBeNull();

    const full = harness.parseInboundIdentifiers({
      org_id: testOrgId, email: 'y@test-synth.com', name: null, dob: null,
      zip: null, device_id: null, guardian_email: null,
    });
    expect(full.shape).toBe('full');
    expect(Object.keys(full.inbound).sort()).toEqual(
      ['device_id', 'dob', 'email', 'guardian_email', 'name', 'org_id', 'zip'].sort()
    );
    expect(full.inbound.email).toBe('y@test-synth.com');
  });

  it('11. conflicts_detected and penalties_applied present for a replayed row that produced them', () => {
    const row = findRow(corpusIdI);
    expect(row.gate_status).toBe('passed');
    expect(row.conflicts_detected.length).toBeGreaterThan(0);
    expect(row.conflicts_detected.some((c) => c.field === 'zip')).toBe(true);
    expect(row.penalties_applied.length).toBeGreaterThan(0);
    expect(row.penalties_applied.some((p) => p.field === 'zip')).toBe(true);
  });

  it('12. run file writes and parses as valid JSON', () => {
    const filePath = runCorpus.writeRunFile(runResult);
    const raw = fs.readFileSync(filePath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    fs.unlinkSync(filePath);
  });

  it('14. fixture (f): normalization_version_drift is not_applicable, key present', () => {
    const row = findRow(corpusIdF);
    expect('normalization_version_drift' in row).toBe(true);
    expect(row.normalization_version_drift).toBe('not_applicable');
  });

  it('15. fixture (e): normalization_version_drift is boolean, sourced from the linked trace', () => {
    const row = findRow(corpusIdE);
    expect(typeof row.normalization_version_drift).toBe('boolean');
    expect(row.normalization_version_drift).toBe(false); // trace5.normalization_version === NORMALIZATION_VERSION
  });

  it('16. fixture (h): scorer_version_drift is unknown, not false', () => {
    const row = findRow(corpusIdH);
    expect(row.scorer_version_drift).toBe('unknown');
    expect(row.scorer_version_drift).not.toBe(false);
  });

  it('17. counts.scorer_version_unknown reflects fixture (h)', () => {
    expect(runResult.counts.scorer_version_unknown).toBeGreaterThanOrEqual(1);
  });

  it('5. buildRun still returns counts.total and a scorecard with the same keys', () => {
    expect(typeof runResult.counts.total).toBe('number');
    expect(Object.keys(runResult.scorecard).sort()).toEqual(SCORECARD_KEYS);
  });
});

const SCORECARD_KEYS = [
  'correct_separation',
  'excluded',
  'false_alarm',
  'found',
  'precision',
  'recall',
  'silent_miss',
].sort();

function scorecardRow(overrides) {
  return {
    expected_verdict: 'match',
    skipped: false,
    gate_status: 'passed',
    replayed_path: 'C',
    ...overrides,
  };
}

describe('summarizeScorecard — totals over evaluateRow results', () => {
  it('1. one of each outcome yields counts of 1 and rates of 0.5', () => {
    const card = harness.summarizeScorecard([
      scorecardRow({ expected_verdict: 'match', replayed_path: 'C' }),
      scorecardRow({ expected_verdict: 'match', replayed_path: 'B' }),
      scorecardRow({ expected_verdict: 'not_match', replayed_path: 'B' }),
      scorecardRow({ expected_verdict: 'not_match', replayed_path: 'C' }),
    ]);

    expect(card.found).toBe(1);
    expect(card.silent_miss).toBe(1);
    expect(card.correct_separation).toBe(1);
    expect(card.false_alarm).toBe(1);
    expect(card.excluded).toBe(0);
    expect(card.recall).toBe(0.5);
    expect(card.precision).toBe(0.5);
  });

  it('2. unsure and a skipped row increment excluded only', () => {
    const card = harness.summarizeScorecard([
      scorecardRow({ expected_verdict: 'unsure', replayed_path: 'C' }),
      scorecardRow({ expected_verdict: 'match', skipped: true, replayed_path: 'C' }),
    ]);

    expect(card.excluded).toBe(2);
    expect(card.found).toBe(0);
    expect(card.silent_miss).toBe(0);
    expect(card.correct_separation).toBe(0);
    expect(card.false_alarm).toBe(0);
    expect(card.recall).toBeNull();
    expect(card.precision).toBeNull();
  });

  it('3. a gated match is a silent miss', () => {
    const card = harness.summarizeScorecard([
      scorecardRow({ expected_verdict: 'match', gate_status: 'gated', replayed_path: null }),
    ]);

    expect(card.silent_miss).toBe(1);
    expect(card.found).toBe(0);
    expect(card.recall).toBe(0);
  });

  it('4. an empty list returns zeros and null rates', () => {
    const card = harness.summarizeScorecard([]);

    expect(card.found).toBe(0);
    expect(card.silent_miss).toBe(0);
    expect(card.correct_separation).toBe(0);
    expect(card.false_alarm).toBe(0);
    expect(card.excluded).toBe(0);
    expect(card.recall).toBeNull();
    expect(card.precision).toBeNull();
    expect(Object.keys(card).sort()).toEqual(SCORECARD_KEYS);
  });
});

describe('regression — resolverEngine export-line change is inert', () => {
  it('13. real PATH D resolution still works and still writes a resolution_trace row', async () => {
    const testOrgId      = crypto.randomUUID();
    const existingFanId  = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    const orgApiKeyHash  = orgKeyHash(testOrgId);

    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO org (id, name, org_api_key_hash) VALUES ($1, $2, $3)`,
        [testOrgId, '_eval_regression_test', orgApiKeyHash]
      );
      await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);
      await client.query(
        `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
         VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
        [existingFanId, testOrgId]
      );
      await client.query(
        `INSERT INTO identifier_link
           (fan_id, identifier_type, identifier_value, org_id, source_system,
            schema_version, confidence_score, first_seen_at, last_seen_at)
         VALUES ($1, 'name', 'Regression Test', $2, 'demo_app', 'v1', 1.0, NOW(), NOW())`,
        [existingFanId, testOrgId]
      );
      await client.query(
        `INSERT INTO identifier_link
           (fan_id, identifier_type, identifier_value, org_id, source_system,
            schema_version, confidence_score, first_seen_at, last_seen_at)
         VALUES ($1, 'dob', '1990-03-15', $2, 'demo_app', 'v1', 1.0, NOW(), NOW())`,
        [existingFanId, testOrgId]
      );

      const result = await resolverEngine(
        {
          identifier_type:  'email',
          identifier_value: 'eval.regression.novel@test-synth.com',
          identifiers: { name: 'Regression Test', dob: '1990-03-15' },
          org_id:           testOrgId,
          schema_version:   'v1',
          source_system:    'synthetic_test',
          idempotency_key:  idempotencyKey,
        },
        client
      );

      expect(result.match_type).toBe('conflict');
      expect(result.confidence_score).toBeGreaterThanOrEqual(0.60);
      expect(result.confidence_score).toBeLessThan(0.85);
      expect(result.is_new_record).toBe(true);

      const traceRows = await client.query(
        `SELECT id FROM resolution_trace WHERE resulting_fan_id = $1 AND org_id = $2`,
        [result.fan_id, testOrgId]
      );
      expect(traceRows.rows.length).toBe(1);
    } finally {
      try {
        await client.query(`DELETE FROM identifier_link WHERE org_id = $1`, [testOrgId]);
      } catch (err) {
        console.error('cleanup: identifier_link delete failed', err.message);
      }
      try {
        await client.query(`DELETE FROM fan WHERE org_id = $1`, [testOrgId]);
      } catch {
        console.log(`  Note: fan rows for org ${testOrgId} pinned by resolution_trace — left as inert.`);
      }
      try {
        await client.query(`DELETE FROM org WHERE id = $1`, [testOrgId]);
      } catch {
        console.log(`  Note: org ${testOrgId} pinned by resolution_trace — left as inert.`);
      }
      client.release();
    }
  });
});
