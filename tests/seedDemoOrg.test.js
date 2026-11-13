'use strict';

// =============================================================================
// tests/seedDemoOrg.test.js
// Verifies the permanent demo org seeded by scripts/seedDemoOrg.js.
//
// Connects to: LOCAL Postgres only (localhost:5432 via DATABASE_URL), same
// pattern as tests/migration_014.test.js.
//
// This test does NOT seed anything itself and does NOT assume seeding has
// already run in this process — it queries DEMO_ORG_ID fresh and asserts on
// whatever state it finds. If the demo org has never been seeded, most
// assertions here fail informatively (not silently pass) — that is
// intentional: run `node scripts/seedDemoOrg.js` first.
//
// CLEANUP: none. The demo org is permanent by design — no teardown, no
// DELETE on resolution_trace or anything it FK-pins.
// =============================================================================

require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const { scoreMatch, SCORER_VERSION } = require('../src/modules/probabilisticMatcher');
const { FROZEN_CLOCK, summarizeScorecard } = require('../eval/harness');
const { buildRun } = require('../eval/runCorpus');

const DEMO_ORG_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const DEMO_API_KEY = 'demo-seed-key-do-not-use-in-production';
const UUID_RE       = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEED_SCRIPT_PATH  = path.join(__dirname, '..', 'scripts', 'seedDemoOrg.js');
const RESET_SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'resetLocalDb.sh');

const CANDIDATE_SNAPSHOT_KEYS = [
  'id', 'org_id', 'email', 'email_last_seen_at', 'name', 'name_last_seen_at',
  'dob', 'dob_last_seen_at', 'zip', 'zip_last_seen_at', 'device_id',
  'device_last_seen_at', 'guardian_email', 'guardian_email_last_seen_at',
].sort();

const NICKNAME_SAME_BIRTHDAY = 'Nickname given name with the same last name and the same birthday — Bob and Robert are the same person and belong in review.';
const NICKNAME_DIFFERENT_EMAIL = 'Nickname given name, same birthday, and different emails — the email penalty lowers the score, and the name-and-birthday agreement still belongs in review.';
const NICKNAME_DIFFERENT_LAST_NAME = 'Nickname given name with a different last name and the same birthday — Bob Smith and Robert Jones are two people.';
const NICKNAME_RATIONALES = [
  NICKNAME_SAME_BIRTHDAY,
  NICKNAME_DIFFERENT_EMAIL,
  NICKNAME_DIFFERENT_LAST_NAME,
];

async function findFanByIdentifier(client, type, value) {
  const result = await client.query(
    `SELECT fan_id FROM identifier_link
     WHERE org_id = $1 AND identifier_type = $2 AND identifier_value = $3
     LIMIT 1`,
    [DEMO_ORG_ID, type, value]
  );
  return result.rows[0] ? result.rows[0].fan_id : null;
}

async function findFanByNameDob(client, name, dob) {
  const result = await client.query(
    `SELECT il1.fan_id
     FROM identifier_link il1
     JOIN identifier_link il2
       ON il2.fan_id = il1.fan_id AND il2.org_id = il1.org_id
     WHERE il1.org_id = $1 AND il1.identifier_type = 'name' AND il1.identifier_value = $2
       AND il2.identifier_type = 'dob' AND il2.identifier_value = $3
     LIMIT 1`,
    [DEMO_ORG_ID, name, dob]
  );
  return result.rows[0] ? result.rows[0].fan_id : null;
}

describe('seedDemoOrg — permanent demo org', () => {
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  // 1 — one-shot guard: no-op when already seeded, no partial writes
  test('one-shot guard: calling the seed entrypoint when already seeded is a no-op', () => {
    return (async () => {
      const beforeFan = await client.query('SELECT COUNT(*) FROM fan WHERE org_id = $1', [DEMO_ORG_ID]);
      const beforeConflict = await client.query('SELECT COUNT(*) FROM conflict_queue WHERE org_id = $1', [DEMO_ORG_ID]);

      const output = execFileSync('node', [SEED_SCRIPT_PATH], { encoding: 'utf8' });
      expect(output).toMatch(/already seeded/i);

      const afterFan = await client.query('SELECT COUNT(*) FROM fan WHERE org_id = $1', [DEMO_ORG_ID]);
      const afterConflict = await client.query('SELECT COUNT(*) FROM conflict_queue WHERE org_id = $1', [DEMO_ORG_ID]);

      expect(afterFan.rows[0].count).toBe(beforeFan.rows[0].count);
      expect(afterConflict.rows[0].count).toBe(beforeConflict.rows[0].count);
    })();
  }, 30000);

  // 2 — DEMO_ORG_ID is a valid UUID; API key stored hashed, never raw
  test('DEMO_ORG_ID is a valid UUID and the API key is stored hashed, never raw', async () => {
    expect(DEMO_ORG_ID).toMatch(UUID_RE);

    const orgResult = await client.query('SELECT org_api_key_hash FROM org WHERE id = $1', [DEMO_ORG_ID]);
    expect(orgResult.rows.length).toBe(1);
    expect(orgResult.rows[0].org_api_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(orgResult.rows[0].org_api_key_hash).not.toBe(DEMO_API_KEY);

    const rawKeyResult = await client.query(
      'SELECT id FROM org WHERE org_api_key_hash = $1',
      [DEMO_API_KEY]
    );
    expect(rawKeyResult.rows.length).toBe(0);
  });

  // 3 — Scenario 1: second resolve of the same email is a hard match onto
  // the existing fixture fan, not a second fan.
  test('Scenario 1: alice.chen@example.com resolves to exactly one fan', async () => {
    const emailLinks = await client.query(
      `SELECT fan_id FROM identifier_link
       WHERE org_id = $1 AND identifier_type = 'email' AND identifier_value = $2`,
      [DEMO_ORG_ID, 'alice.chen@example.com']
    );
    expect(emailLinks.rows.length).toBe(1);
    const fanId = emailLinks.rows[0].fan_id;

    const resolutionAudits = await client.query(
      `SELECT match_type, is_new_record FROM audit_log
       WHERE org_id = $1 AND fan_id = $2 AND event_type = 'resolution'
       ORDER BY created_at ASC`,
      [DEMO_ORG_ID, fanId]
    );
    // one row from the fixture insert (is_new_record true), one from the
    // live resolve that hard-matched it (is_new_record false)
    expect(resolutionAudits.rows.length).toBeGreaterThanOrEqual(2);
    const hardMatchRow = resolutionAudits.rows.find(r => r.is_new_record === false);
    expect(hardMatchRow).toBeDefined();
    expect(hardMatchRow.match_type).toBe('hard');
  });

  // 4/5 — Scenario 3: the DOB veto headline
  let fanAId, fanBId;
  beforeAll(async () => {
    fanAId = await findFanByNameDob(client, 'john smith', '1985-03-12');
    fanBId = await findFanByNameDob(client, 'john smyth', '1978-11-04');
  });

  test('Scenario 3: resolution_trace shows fan A considered but NOT winning', async () => {
    expect(fanAId).toMatch(UUID_RE);
    expect(fanBId).toMatch(UUID_RE);

    const traceResult = await client.query(
      `SELECT id, candidate_ids, best_candidate_id, best_score FROM resolution_trace
       WHERE org_id = $1 AND $2 = ANY(candidate_ids)`,
      [DEMO_ORG_ID, fanAId]
    );
    expect(traceResult.rows.length).toBeGreaterThanOrEqual(1);

    const headlineTrace = traceResult.rows.find(r => r.best_candidate_id === fanBId);
    expect(headlineTrace).toBeDefined();
    expect(headlineTrace.best_candidate_id).not.toBe(fanAId);
  });

  test('Scenario 3: scoreMatch(fanA, inbound, FROZEN_CLOCK) proves the DOB veto fired', async () => {
    const fanARow = await client.query(
      `SELECT identifier_type, identifier_value, last_seen_at FROM identifier_link
       WHERE org_id = $1 AND fan_id = $2`,
      [DEMO_ORG_ID, fanAId]
    );
    const fields = {};
    for (const row of fanARow.rows) {
      fields[row.identifier_type] = row.identifier_value;
      fields[`${row.identifier_type}_last_seen_at`] = row.last_seen_at;
    }

    const candidateSnapshot = {
      id: fanAId,
      org_id: DEMO_ORG_ID,
      email: null, email_last_seen_at: null,
      name: fields.name ?? null, name_last_seen_at: fields.name_last_seen_at ?? null,
      dob: fields.dob ?? null, dob_last_seen_at: fields.dob_last_seen_at ?? null,
      zip: null, zip_last_seen_at: null,
      device_id: null, device_last_seen_at: null,
      guardian_email: null, guardian_email_last_seen_at: null,
    };
    const inbound = {
      org_id: DEMO_ORG_ID,
      email: null,
      name: 'John Smith',
      dob: '1978-11-04',
      zip: null,
      device_id: null,
      guardian_email: null,
    };

    const result = scoreMatch(candidateSnapshot, inbound, FROZEN_CLOCK);
    expect(result.dob_veto).toBe(true);
    expect(result.score).toBe(0.0);
  });

  // 6 — Scenario 2: conflict stays pending
  test('Scenario 2: Marcus Webb fixture has a pending conflict_queue row', async () => {
    const marcusFanId = await findFanByNameDob(client, 'marcus webb', '1990-04-15');
    expect(marcusFanId).toMatch(UUID_RE);

    const conflictResult = await client.query(
      `SELECT status FROM conflict_queue WHERE org_id = $1 AND fan_id_a = $2`,
      [DEMO_ORG_ID, marcusFanId]
    );
    expect(conflictResult.rows.length).toBeGreaterThanOrEqual(1);
    expect(conflictResult.rows.every(r => r.status === 'pending')).toBe(true);
  });

  // 7 — Scenario 5: merge_history active, loser soft-deleted
  test('Scenario 5: Dana Park merge is confirmed and active, loser is soft-deleted', async () => {
    const danaFanId = await findFanByIdentifier(client, 'email', 'dana.park@example.com');
    expect(danaFanId).toMatch(UUID_RE);

    const mergeResult = await client.query(
      `SELECT fan_id_source, fan_id_target, status FROM merge_history
       WHERE org_id = $1 AND fan_id_target = $2 AND status = 'active'`,
      [DEMO_ORG_ID, danaFanId]
    );
    expect(mergeResult.rows.length).toBe(1);

    const loserId = mergeResult.rows[0].fan_id_source;
    const loserFan = await client.query('SELECT deleted_at FROM fan WHERE id = $1', [loserId]);
    expect(loserFan.rows[0].deleted_at).not.toBeNull();
  });

  // 8/9 — evaluation_corpus: the seed script's contract is "insert exactly 11
  // SYNTHETIC rows, correctly shaped" — not "the corpus contains N rows".
  // Rows added later by other tools (e.g. scripts/promoteTraceToCorpus.js)
  // are not this script's business and must not be asserted here.
  let corpusRows;
  beforeAll(async () => {
    const result = await client.query(
      `SELECT id, source, trace_id, candidate_snapshot, expected_verdict, rationale, scorer_version
       FROM evaluation_corpus WHERE org_id = $1`,
      [DEMO_ORG_ID]
    );
    corpusRows = result.rows;
  });

  test('seedDemoOrg writes exactly 11 synthetic evaluation_corpus rows, correctly shaped', () => {
    const syntheticRows = corpusRows.filter(r => r.source === 'synthetic');
    expect(syntheticRows.length).toBe(11);

    expect(syntheticRows.every(r => r.trace_id === null)).toBe(true);
    expect(syntheticRows.every(r => r.candidate_snapshot != null)).toBe(true);

    for (const row of syntheticRows) {
      const keys = Object.keys(row.candidate_snapshot).sort();
      expect(keys).toEqual(CANDIDATE_SNAPSHOT_KEYS);
    }

    // CORPUS_PAIRS: pairs 1, 2, 8, 9, 10 are 'match';
    // pairs 3, 4, 5, 6, 7, 11 are 'not_match'.
    const verdictCounts = syntheticRows.reduce((acc, r) => {
      acc[r.expected_verdict] = (acc[r.expected_verdict] || 0) + 1;
      return acc;
    }, {});
    expect(verdictCounts.match).toBe(5);
    expect(verdictCounts.not_match).toBe(6);

    // The original eight keep the scorer_version they were seeded with.
    // The three nickname pairs are inserted later and carry the current version.
    const nicknameRows = syntheticRows.filter(r => NICKNAME_RATIONALES.includes(r.rationale));
    expect(nicknameRows).toHaveLength(3);
    expect(nicknameRows.every(r => r.scorer_version === SCORER_VERSION)).toBe(true);
  });

  // 8b — regression: the backfill must never touch the promoted row's
  // scorer_version, which came from its trace and records what actually
  // produced that resolution, not the current constant.
  test("the backfill does not alter the promoted row's scorer_version", async () => {
    const promotedRows = corpusRows.filter(r => r.source === 'promoted_trace');
    expect(promotedRows.length).toBeGreaterThanOrEqual(1);
    const beforeVersion = promotedRows[0].scorer_version;

    // Re-run the backfill directly (idempotent — WHERE scorer_version IS NULL
    // means a second run is a no-op) and confirm the promoted row is untouched.
    await client.query(
      `UPDATE evaluation_corpus SET scorer_version = $1
        WHERE org_id = $2 AND source = 'synthetic' AND scorer_version IS NULL`,
      [SCORER_VERSION, DEMO_ORG_ID]
    );

    const afterResult = await client.query(
      `SELECT scorer_version FROM evaluation_corpus WHERE org_id = $1 AND source = 'promoted_trace'`,
      [DEMO_ORG_ID]
    );
    expect(afterResult.rows[0].scorer_version).toBe(beforeVersion);
  });

  // 8c — eval/runCorpus.js's buildRun must report zero unknown-scorer-version
  // rows for the demo org now that every synthetic row is stamped.
  test('buildRun reports zero scorer_version_unknown rows for the demo org', async () => {
    const runObject = await buildRun(client, DEMO_ORG_ID);
    expect(runObject.counts.scorer_version_unknown).toBe(0);
  });

  // 8d — proves the drift check is live, not vacuously true: a disposable
  // temp org (fresh UUID, never DEMO_ORG_ID) with a synthetic row stamped
  // with an intentionally-wrong scorer_version must report drift === true.
  test('buildRun reports scorer_version_drift for a row stamped with a stale version', async () => {
    const tempOrgId  = crypto.randomUUID();
    const apiKeyHash = crypto.randomBytes(32).toString('hex');
    const minimalSnapshot = {
      id: crypto.randomUUID(), org_id: tempOrgId,
      email: null, email_last_seen_at: null,
      name: null, name_last_seen_at: null,
      dob: null, dob_last_seen_at: null,
      zip: null, zip_last_seen_at: null,
      device_id: null, device_last_seen_at: null,
      guardian_email: null, guardian_email_last_seen_at: null,
    };

    try {
      await client.query(
        `INSERT INTO org (id, name, is_active, org_api_key_hash) VALUES ($1, 'temp-drift-org', true, $2)`,
        [tempOrgId, apiKeyHash]
      );
      await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [tempOrgId]);
      await client.query(
        `INSERT INTO evaluation_corpus
           (id, org_id, source, trace_id, inbound_identifiers, candidate_snapshot,
            expected_verdict, rationale, created_by, scorer_version)
         VALUES ($1, $2, 'synthetic', NULL, '{}'::jsonb, $3, 'match', 'drift-check fixture', 'test', 'v1+deadbeef')`,
        [crypto.randomUUID(), tempOrgId, JSON.stringify(minimalSnapshot)]
      );

      const runObject = await buildRun(client, tempOrgId);
      const row = runObject.rows.find(r => r.state === 'synthetic');
      expect(row).toBeDefined();
      expect(row.scorer_version_drift).toBe(true);
    } finally {
      // evaluation_corpus has no append-only trigger — safe to clean up.
      await client.query(`DELETE FROM evaluation_corpus WHERE org_id = $1`, [tempOrgId]);
      // No fan/resolution_trace rows were created for this org, so unlike
      // the future-proofing test above, the org row itself can be deleted.
      await client.query(`DELETE FROM org WHERE id = $1`, [tempOrgId]);
    }
  }, 30000);

  // eval/runCorpus.js's buildRun computes counts.synthetic independently
  // per-row (counts[row.state]++), so it reflects only what seedDemoOrg
  // wrote regardless of anything else promoted into the same org.
  // counts.total and counts.promoted_with_snapshot are intentionally left
  // unasserted — both count promoted_trace rows, which are not this script's
  // contract.
  test("eval/runCorpus.js buildRun's counts.synthetic reflects the seed script's 11 rows", async () => {
    const runObject = await buildRun(client, DEMO_ORG_ID);
    expect(runObject.counts.synthetic).toBe(11);
  });

  test('nickname pairs: same birthday is found, different emails stay found at the real score, different last name stays separated', async () => {
    const runObject = await buildRun(client, DEMO_ORG_ID);
    const byRationale = new Map(corpusRows.map(r => [r.rationale, r.id]));

    const sameBirthday = runObject.rows.find(r => r.corpus_id === byRationale.get(NICKNAME_SAME_BIRTHDAY));
    const differentEmail = runObject.rows.find(r => r.corpus_id === byRationale.get(NICKNAME_DIFFERENT_EMAIL));
    const differentLastName = runObject.rows.find(r => r.corpus_id === byRationale.get(NICKNAME_DIFFERENT_LAST_NAME));

    expect(sameBirthday.replayed_path).toBe('D');
    expect(sameBirthday.replayed_score).toBeCloseTo(0.7, 5);
    expect(differentEmail.replayed_path).toBe('D');
    expect(differentEmail.replayed_score).toBeCloseTo(0.4, 5);
    expect(differentLastName.replayed_path).toBe('B');

    const card = summarizeScorecard([sameBirthday, differentEmail, differentLastName]);
    expect(card.found).toBe(2);
    expect(card.silent_miss).toBe(0);
    expect(card.correct_separation).toBe(1);
  });

  // 10 — future-proofing: prove the above assertions stay true no matter how
  // many more promoted_trace rows land later, WITHOUT touching DEMO_ORG_ID's
  // corpus rows (the cleanup rule for this permanent org forbids deleting
  // them). Built against a disposable temporary org instead. That org and
  // every resolution_trace row it accumulates are left permanently stranded
  // on purpose: resolution_trace is append-only (trigger-enforced) and org
  // has an inbound FK from it (default RESTRICT), so neither can ever be
  // deleted — same shape as the demo org itself, just inert under a fresh
  // UUID nothing else queries. Only evaluation_corpus rows (no append-only
  // trigger) are cleaned up.
  test('assertions scoped by source=synthetic are unaffected by additional promoted_trace rows landing later', async () => {
    const tempOrgId  = crypto.randomUUID();
    const apiKeyHash = crypto.randomBytes(32).toString('hex');

    const minimalSnapshot = {
      id: crypto.randomUUID(), org_id: tempOrgId,
      email: null, email_last_seen_at: null,
      name: null, name_last_seen_at: null,
      dob: null, dob_last_seen_at: null,
      zip: null, zip_last_seen_at: null,
      device_id: null, device_last_seen_at: null,
      guardian_email: null, guardian_email_last_seen_at: null,
    };

    async function insertTrace() {
      const traceId = crypto.randomUUID();
      await client.query(
        `INSERT INTO resolution_trace
           (id, org_id, resolution_path, scoring_status, skip_reason,
            inbound_identifiers, best_score, threshold_path_c, threshold_path_d,
            scorer_version, normalization_version, scoring_clock, is_new_record)
         VALUES ($1, $2, 'B', 'skipped', 'test_fixture', '{}'::jsonb, NULL, 0.85, 0.60,
                 'v1+test', 'v1', now(), true)`,
        [traceId, tempOrgId]
      );
      return traceId;
    }

    async function insertPromotedRow() {
      const traceId = await insertTrace();
      await client.query(
        `INSERT INTO evaluation_corpus
           (id, org_id, source, trace_id, inbound_identifiers, candidate_snapshot,
            expected_verdict, rationale, created_by)
         VALUES ($1, $2, 'promoted_trace', $3, '{}'::jsonb, $4, 'match', 'temp-org future-proof fixture', 'test')`,
        [crypto.randomUUID(), tempOrgId, traceId, JSON.stringify(minimalSnapshot)]
      );
    }

    async function readSyntheticCount() {
      const result = await client.query(
        `SELECT source FROM evaluation_corpus WHERE org_id = $1`,
        [tempOrgId]
      );
      return result.rows.filter(r => r.source === 'synthetic').length;
    }

    try {
      await client.query(
        `INSERT INTO org (id, name, is_active, org_api_key_hash) VALUES ($1, 'temp-future-proof-org', true, $2)`,
        [tempOrgId, apiKeyHash]
      );
      await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [tempOrgId]);

      // 2 synthetic rows, standing in for "the seed script's N rows"
      for (const verdict of ['match', 'not_match']) {
        await client.query(
          `INSERT INTO evaluation_corpus
             (id, org_id, source, trace_id, inbound_identifiers, candidate_snapshot,
              expected_verdict, rationale, created_by)
           VALUES ($1, $2, 'synthetic', NULL, '{}'::jsonb, $3, $4, 'temp-org future-proof fixture', 'test')`,
          [crypto.randomUUID(), tempOrgId, JSON.stringify(minimalSnapshot), verdict]
        );
      }

      // 1 promoted row already present at the first reading
      await insertPromotedRow();
      expect(await readSyntheticCount()).toBe(2);

      // A second and third promoted_trace row land later — the exact future
      // scenario this test exists to prove doesn't break the contract-scoped
      // assertion.
      await insertPromotedRow();
      await insertPromotedRow();
      expect(await readSyntheticCount()).toBe(2);
    } finally {
      // evaluation_corpus has no append-only trigger — safe to clean up.
      await client.query(`DELETE FROM evaluation_corpus WHERE org_id = $1`, [tempOrgId]);
      // resolution_trace is append-only (trigger-enforced) and the temp org
      // row can never be deleted while a trace still references it (FK,
      // default RESTRICT) — both are left permanently stranded on purpose.
      // Do NOT attempt either delete here; a failed trace DELETE must not
      // abort this cleanup block.
    }
  }, 30000);

  // 11 — resetLocalDb.sh refuses non-localhost DATABASE_URL
  test('resetLocalDb.sh refuses to run when DATABASE_URL does not contain localhost', () => {
    expect(() => {
      execFileSync('bash', [RESET_SCRIPT_PATH], {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: 'postgresql://user:pass@example.com:5432/somedb' },
      });
    }).toThrow();
  });
});
