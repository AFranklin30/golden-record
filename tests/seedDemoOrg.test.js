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

const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');

const { scoreMatch } = require('../src/modules/probabilisticMatcher');
const { FROZEN_CLOCK } = require('../eval/harness');
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

  // 8/9 — evaluation_corpus: exactly 8 synthetic rows, correct 14-key shape
  let corpusRows;
  beforeAll(async () => {
    const result = await client.query(
      `SELECT source, candidate_snapshot FROM evaluation_corpus WHERE org_id = $1`,
      [DEMO_ORG_ID]
    );
    corpusRows = result.rows;
  });

  test('evaluation_corpus has exactly 8 synthetic rows with non-null candidate_snapshot', () => {
    expect(corpusRows.length).toBe(8);
    expect(corpusRows.every(r => r.source === 'synthetic')).toBe(true);
    expect(corpusRows.every(r => r.candidate_snapshot != null)).toBe(true);
  });

  test('every candidate_snapshot has exactly the 14 candidate-SELECT keys', () => {
    for (const row of corpusRows) {
      const keys = Object.keys(row.candidate_snapshot).sort();
      expect(keys).toEqual(CANDIDATE_SNAPSHOT_KEYS);
    }
  });

  // 10 — eval/runCorpus.js against DEMO_ORG_ID
  test('eval/runCorpus.js buildRun produces counts.total === 8 and counts.synthetic === 8', async () => {
    const runObject = await buildRun(client, DEMO_ORG_ID);
    expect(runObject.counts.total).toBe(8);
    expect(runObject.counts.synthetic).toBe(8);
  });

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
