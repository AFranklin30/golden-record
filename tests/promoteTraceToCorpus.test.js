'use strict';

// =============================================================================
// tests/promoteTraceToCorpus.test.js
// scripts/promoteTraceToCorpus.js — Stage 7 decisions 2 & 3 (where a promoted
// row's score/verdict come from) made observable in eval/runCorpus.js output.
//
// Connects to: LOCAL Postgres only (localhost:5432 via DATABASE_URL). Same
// pattern as tests/migration_014.test.js / tests/eval.harness.test.js.
//
// Two describes:
//   A — guards + shape, against an isolated fresh test org (own fan +
//       fixture traces so 'skipped' and 'cross-org' states can be produced
//       deliberately).
//   B — a fresh org with one performed trace and eight synthetic corpus
//       rows. The permanent demo org is not read, so a second Scenario 3
//       trace left there cannot change the result.
//
// Cleanup: describe A cleans up in FK order in afterAll; resolution_trace and
// fan (FK-pinned by best_candidate_id) are left in place — inert, exactly as
// tests/eval.harness.test.js leaves them. Describe B writes nothing it
// doesn't leave permanently by design (a promoted evaluation_corpus row +
// two trace_label rows on the real demo trace) and touches no other demo
// org state.
// =============================================================================

require('dotenv').config();

const fs     = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');

const {
  promoteTraceToCorpus,
  PromotionError,
  DEFAULT_RATIONALE,
} = require('../scripts/promoteTraceToCorpus');
const { buildRun } = require('../eval/runCorpus');
const { scoreMatch, SCORER_VERSION } = require('../src/modules/probabilisticMatcher');
const { FROZEN_CLOCK } = require('../eval/harness');
const { NORMALIZATION_VERSION } = require('../src/modules/normalizer');

const CANDIDATE_SNAPSHOT_KEYS = [
  'id', 'org_id', 'email', 'email_last_seen_at', 'name', 'name_last_seen_at',
  'dob', 'dob_last_seen_at', 'zip', 'zip_last_seen_at', 'device_id',
  'device_last_seen_at', 'guardian_email', 'guardian_email_last_seen_at',
].sort();

function orgKeyHash(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

async function insertTrace(client, {
  id, org_id, resolution_path, scoring_status, skip_reason,
  inbound_identifiers, best_candidate_id, best_score,
  scorer_version, normalization_version, is_new_record,
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
        $7, $8, 0.85, 0.60,
        $9, $10, NOW(),
        NULL, $11, NULL)`,
    [
      id, org_id, resolution_path, scoring_status, skip_reason,
      JSON.stringify(inbound_identifiers), best_candidate_id, best_score,
      scorer_version, normalization_version, is_new_record,
    ]
  );
}

describe('scripts/promoteTraceToCorpus — guards + shape (isolated test org)', () => {
  let client;
  let testOrgId, testOrgIdB;
  let fanId;
  let performedTraceId, skippedTraceId;
  let promoteResult;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    testOrgId  = crypto.randomUUID();
    testOrgIdB = crypto.randomUUID();
    fanId      = crypto.randomUUID();

    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash) VALUES ($1, $2, $3)`,
      [testOrgId, '_promote_test_org', orgKeyHash('promote-' + testOrgId)]
    );
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash) VALUES ($1, $2, $3)`,
      [testOrgIdB, '_promote_test_org_b', orgKeyHash('promote-b-' + testOrgIdB)]
    );

    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [fanId, testOrgId]
    );
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id, source_system,
          schema_version, confidence_score, first_seen_at, last_seen_at)
       VALUES ($1, 'email', 'promote.fixture@test-synth.com', $2, 'demo_app', 'v1', 1.0, NOW(), NOW())`,
      [fanId, testOrgId]
    );
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id, source_system,
          schema_version, confidence_score, first_seen_at, last_seen_at)
       VALUES ($1, 'name', 'Promote Fixture', $2, 'demo_app', 'v1', 1.0, NOW(), NOW())`,
      [fanId, testOrgId]
    );

    performedTraceId = crypto.randomUUID();
    await insertTrace(client, {
      id: performedTraceId, org_id: testOrgId, resolution_path: 'D',
      scoring_status: 'performed', skip_reason: null,
      inbound_identifiers: {
        org_id: testOrgId, email: 'promote.fixture@test-synth.com',
        name: null, dob: null, zip: null, device_id: null, guardian_email: null,
      },
      best_candidate_id: fanId, best_score: 0.70,
      scorer_version: SCORER_VERSION, normalization_version: NORMALIZATION_VERSION,
      is_new_record: true,
    });

    skippedTraceId = crypto.randomUUID();
    await insertTrace(client, {
      id: skippedTraceId, org_id: testOrgId, resolution_path: 'A',
      scoring_status: 'skipped', skip_reason: 'deterministic_match',
      inbound_identifiers: { email: 'promote.stub@test-synth.com' },
      best_candidate_id: null, best_score: null,
      scorer_version: SCORER_VERSION, normalization_version: NORMALIZATION_VERSION,
      is_new_record: false,
    });

    // Successful promotion, reused by assertions 4, 5, 6.
    promoteResult = await promoteTraceToCorpus(client, testOrgId, performedTraceId, {
      expected_verdict: 'not_match',
      rationale: DEFAULT_RATIONALE,
    });
  });

  afterAll(async () => {
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
      `cleanup: resolution_trace + fan (FK-pinned by best_candidate_id) left ` +
      `in place for org ${testOrgId} / ${testOrgIdB} — inert, same pattern as ` +
      `tests/eval.harness.test.js.`
    );
    await client.end();
  });

  // 1
  test('guard: promoting a skipped trace rejects, naming the reason', async () => {
    let caught;
    try {
      await promoteTraceToCorpus(client, testOrgId, skippedTraceId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PromotionError);
    expect(caught.message).toMatch(/scoring_status='skipped'/);
    expect(caught.message).toMatch(/deterministic_match/);
  });

  // 2
  test('guard: promoting the same trace twice fails cleanly, not a raw pg error', async () => {
    let caught;
    try {
      await promoteTraceToCorpus(client, testOrgId, performedTraceId, { expected_verdict: 'match' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PromotionError);
    expect(caught.message).toMatch(/already points at trace_id/);
    expect(caught.message).not.toMatch(/duplicate key value violates/i);
  });

  // 3
  test('guard: a trace_id from another org is rejected', async () => {
    let caught;
    try {
      await promoteTraceToCorpus(client, testOrgIdB, performedTraceId);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PromotionError);
    expect(caught.message).toMatch(/not found/);
  });

  // 4
  test('corpus row: source=promoted_trace, non-null trace_id AND candidate_snapshot', async () => {
    const result = await client.query(
      `SELECT * FROM evaluation_corpus WHERE id = $1`,
      [promoteResult.corpus_id]
    );
    const row = result.rows[0];
    expect(row.source).toBe('promoted_trace');
    expect(row.trace_id).toBe(performedTraceId);
    expect(row.candidate_snapshot).not.toBeNull();
  });

  // 5
  test('candidate_snapshot has exactly the 14 keys from resolverEngine candidate SELECT', async () => {
    const result = await client.query(
      `SELECT candidate_snapshot FROM evaluation_corpus WHERE id = $1`,
      [promoteResult.corpus_id]
    );
    const snapshot = result.rows[0].candidate_snapshot;
    expect(Object.keys(snapshot).sort()).toEqual(CANDIDATE_SNAPSHOT_KEYS);
    // and the two identifiers actually written come through, not just nulls
    expect(snapshot.email).toBe('promote.fixture@test-synth.com');
    expect(snapshot.name).toBe('Promote Fixture');
  });

  // 6
  test('two trace_label rows exist on the trace with different verdicts', async () => {
    const result = await client.query(
      `SELECT labeled_by, verdict FROM trace_label WHERE trace_id = $1 ORDER BY labeled_by`,
      [performedTraceId]
    );
    expect(result.rows).toHaveLength(2);
    const verdicts = new Set(result.rows.map((r) => r.verdict));
    expect(verdicts.size).toBe(2);
  });
});

describe('scripts/promoteTraceToCorpus — fresh org trace (decisions 2 & 3 observable)', () => {
  let client;
  let orgId;
  let corpusRow;
  let runResult;
  let SCENARIO_3_TRACE_ID;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    orgId = crypto.randomUUID();
    const fanId = crypto.randomUUID();
    SCENARIO_3_TRACE_ID = crypto.randomUUID();
    const hash = orgKeyHash('promote-fresh-' + orgId);
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash, is_active) VALUES ($1, $2, $3, true)`,
      [orgId, '_promote_fresh', hash]
    );
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [fanId, orgId]
    );
    const seenAt = new Date(FROZEN_CLOCK);
    for (const [type, value] of [['name', 'jane doe'], ['dob', '1990-04-02']]) {
      await client.query(
        `INSERT INTO identifier_link
           (fan_id, org_id, identifier_type, identifier_value, source_system,
            schema_version, confidence_score, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, 'csv_import', '1.0', 1.0, $5, $5)`,
        [fanId, orgId, type, value, seenAt]
      );
    }

    const stored = await client.query(
      `SELECT f.id, f.org_id,
              NULL::text AS email, NULL::timestamptz AS email_last_seen_at,
              il_name.identifier_value AS name, il_name.last_seen_at AS name_last_seen_at,
              il_dob.identifier_value AS dob, il_dob.last_seen_at AS dob_last_seen_at,
              NULL::text AS zip, NULL::timestamptz AS zip_last_seen_at,
              NULL::text AS device_id, NULL::timestamptz AS device_last_seen_at,
              NULL::text AS guardian_email, NULL::timestamptz AS guardian_email_last_seen_at
         FROM fan f
         JOIN identifier_link il_name
           ON il_name.fan_id = f.id AND il_name.identifier_type = 'name' AND il_name.org_id = f.org_id
         JOIN identifier_link il_dob
           ON il_dob.fan_id = f.id AND il_dob.identifier_type = 'dob' AND il_dob.org_id = f.org_id
        WHERE f.id = $1`,
      [fanId]
    );
    const inbound = {
      org_id: orgId,
      email: null,
      name: 'jane doe',
      dob: '1990-04-02',
      zip: null,
      device_id: null,
      guardian_email: null,
    };
    const snapshot = JSON.parse(JSON.stringify(stored.rows[0]));
    const scored = scoreMatch(snapshot, inbound, FROZEN_CLOCK);

    await insertTrace(client, {
      id: SCENARIO_3_TRACE_ID,
      org_id: orgId,
      resolution_path: 'D',
      scoring_status: 'performed',
      skip_reason: null,
      inbound_identifiers: inbound,
      best_candidate_id: fanId,
      best_score: scored.score,
      scorer_version: 'v-from-trace',
      normalization_version: NORMALIZATION_VERSION,
      is_new_record: true,
    });

    for (let i = 0; i < 8; i += 1) {
      await client.query(
        `INSERT INTO evaluation_corpus
           (id, org_id, source, inbound_identifiers, candidate_snapshot,
            expected_verdict, scorer_version, created_by)
         VALUES ($1, $2, 'synthetic', $3, $4, 'not_match', $5, 'test')`,
        [crypto.randomUUID(), orgId, JSON.stringify(inbound), JSON.stringify(snapshot), SCORER_VERSION]
      );
    }

    const result = await promoteTraceToCorpus(client, orgId, SCENARIO_3_TRACE_ID, {
      expected_verdict: 'not_match',
      rationale: DEFAULT_RATIONALE,
    });
    const fresh = await client.query(
      `SELECT * FROM evaluation_corpus WHERE id = $1`,
      [result.corpus_id]
    );
    corpusRow = fresh.rows[0];
    runResult = await buildRun(client, orgId);
  });

  afterAll(async () => {
    await client.end();
  });

  function findPromotedRow() {
    return runResult.rows.find((r) => r.corpus_id === corpusRow.id);
  }

  // 7
  test('promoted row: score_source both, scores numeric, delta computed', () => {
    const row = findPromotedRow();
    expect(row).toBeDefined();
    expect(row.score_source).toBe('both');
    expect(typeof row.trace_score).toBe('number');
    expect(typeof row.replayed_score).toBe('number');
    expect(row.delta).not.toBeNull();
    expect(typeof row.agrees).toBe('boolean');
  });

  // 8 — REPLAY FIDELITY. Do NOT loosen SCORE_TOLERANCE to make this pass.
  test('REPLAY FIDELITY: agrees === true (a false here is a real finding, not a test bug)', () => {
    const row = findPromotedRow();
    if (row.agrees !== true) {
      throw new Error(
        `Replay fidelity finding: replayed_score=${row.replayed_score} ` +
        `trace_score=${row.trace_score} delta=${row.delta} exceeds SCORE_TOLERANCE. ` +
        `Production's stored score and a fresh replay of the same candidate ` +
        `disagree — report this, do not adjust the tolerance to hide it.`
      );
    }
    expect(row.agrees).toBe(true);
  });

  // 9
  test('expected_verdict does not suppress the disagreeing labeler', () => {
    const row = findPromotedRow();
    expect(row.expected_verdict).toBe('not_match');
    expect(row.labels).toContainEqual({ labeled_by: 'aaron', verdict: 'match' });
    expect(row.labels).toContainEqual({ labeled_by: 'monique', verdict: 'not_match' });
    expect(row.label_disagreement).toBe(true);
  });

  // 10
  test('counts: promoted_with_snapshot=1, synthetic=8, total=9', () => {
    expect(runResult.counts.promoted_with_snapshot).toBe(1);
    expect(runResult.counts.synthetic).toBe(8);
    expect(runResult.counts.total).toBe(9);
  });

  // 11
  test('scorer_version read from the trace row, not the current SCORER_VERSION constant', async () => {
    const traceResult = await client.query(
      `SELECT scorer_version FROM resolution_trace WHERE id = $1`,
      [SCENARIO_3_TRACE_ID]
    );
    const traceScorerVersion = traceResult.rows[0].scorer_version;
    expect(corpusRow.scorer_version).toBe(traceScorerVersion);
    expect(traceScorerVersion).not.toBe(SCORER_VERSION);

    // Distinct-source proof: the script never imports probabilisticMatcher,
    // so it has no access to the SCORER_VERSION constant at all — the
    // written value can only have come from the trace query.
    const scriptSource = fs.readFileSync(
      require.resolve('../scripts/promoteTraceToCorpus'),
      'utf8'
    );
    expect(scriptSource).not.toMatch(/require\(['"].*probabilisticMatcher['"]\)/);
  });
});
