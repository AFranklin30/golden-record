'use strict';

// scripts/seedDemoOrg.js
// Golden Record Fan Identity Platform — OKC Thunder — Thunder Innovations Cohort
//
// Seeds ONE permanent demo org: fixture fans inserted directly via SQL
// (what a touchpoint already knows), then real resolutions fired through the
// live HTTP API against those fixtures (the genuine demo artifact — scoring,
// the DOB veto, pending conflicts, a confirmed merge, real resolution_trace
// rows). So the harness, the reviewer UI, and the final-month presentation
// walkthrough all have real fans in real paths.
//
// Run:  node scripts/seedDemoOrg.js
//
// REVISION 2 (2026-08-02) — fixtures replace the previous session's
// merge-chain consolidation approach, which failed twice against real
// platform constraints:
//   1. Eligibility gate: composite signals (name_plus_dob, name_plus_zip)
//      require BOTH fields already present on the CANDIDATE. A fan holding
//      only `name` can never be scored against an inbound `dob` — there is
//      no live-API sequence that builds a name+dob fan from nothing.
//   2. Multi-hop merge block (conflicts.js): a fan can absorb at most one
//      confirmed merge, ever. A merge's loser is always a freshly-minted
//      single-identifier fan, so a merge-built fan caps at exactly 2
//      identifier types — and reaching even that requires one of them to be
//      a single-field STRONG signal (email_similarity or guardian_email).
// Both guards are correct; their composition means a fan holding exactly
// `name` + `dob` is unreachable through the live API. See CLAUDE.md's Open
// section for the documented finding. Fixture fans sidestep this because
// they represent "what a touchpoint already knows" rather than something
// assembled live — the RESOLUTION DECISIONS made against them (the scoring,
// the veto, the pending conflict, the confirm) are still 100% real API calls.
//
// One-shot: if DEMO_ORG_ID already exists this prints a message and exits.
// There is no reset flag. resolution_trace is append-only (trigger-enforced)
// and FK-pins fan / audit_log / conflict_queue, so surgical cleanup is not
// possible. The only reset path is scripts/resetLocalDb.sh.
//
// Requires: local Postgres (localhost:5432) with migration_014 applied.
// This script must NEVER run against Cloud SQL — it seeds permanent data.

require('dotenv').config();

// ── Safety guard — local Postgres only, mirrors tests/*.smoke.js ──────────
(function guardLocalOnly() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error('BLOCKED: DATABASE_URL is not set. Add it to .env and point it at localhost:5432.');
    process.exit(1);
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    console.error('BLOCKED: DATABASE_URL could not be parsed. Check .env.');
    process.exit(1);
  }
  const host    = parsed.hostname;
  const port    = parsed.port || '5432';
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocal || port === '5433') {
    console.error('BLOCKED: DATABASE_URL does not point to local Postgres on port 5432.');
    console.error(`  host: ${host}  port: ${port}`);
    console.error('  This script must never run against Cloud SQL (port 5433) or a remote host —');
    console.error('  it seeds PERMANENT, un-teardownable data (resolution_trace is append-only).');
    process.exit(1);
  }
}());

const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const request = require('supertest');
const { Client } = require('pg');

const pool = require('../src/db/pool');

const orgAuthMiddleware       = require('../src/middleware/orgAuthMiddleware');
const rlsContextMiddleware    = require('../src/middleware/rlsContextMiddleware');
const correlationIdMiddleware = require('../src/middleware/correlationIdMiddleware');
const jwtMiddleware            = require('../src/middleware/jwtMiddleware');

const resolveRouter    = require('../src/routes/resolve');
const nfcRouter        = require('../src/routes/nfc');
const sessionRouter    = require('../src/routes/session');
const conflictsRouter  = require('../src/routes/conflicts');
const householdRouter  = require('../src/routes/household');

const DEMO_ORG_ID     = 'aaaaaaaa-0000-0000-0000-000000000001';
const DEMO_ORG_NAME   = 'Demo Org';
const DEMO_API_KEY    = 'demo-seed-key-do-not-use-in-production';
const SCHEMA_VERSION  = 'v1';
const AUTH_HEADER     = `Bearer ${DEMO_API_KEY}`;

// Fixed timestamp for every fixture row — within 6 months of "now" so
// getRecencyMultiplier always returns 1.0 and scores are reproducible.
const FIXTURE_TS = '2026-06-01T00:00:00.000Z';

// ── output ──────────────────────────────────────────────────────────────
const summaryLines = [];
function log(line) {
  console.log(line);
  summaryLines.push(line);
}

// ── app under test — mirrors index.js's middleware order exactly, real
// pool, real middleware, zero mocks. supertest(app) — no .listen(), no
// raw http.request. ─────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());

  const protectedRouter = express.Router();
  protectedRouter.use(orgAuthMiddleware);
  protectedRouter.use(rlsContextMiddleware);
  protectedRouter.use(correlationIdMiddleware);
  protectedRouter.use(resolveRouter);
  protectedRouter.use(nfcRouter);
  protectedRouter.use(sessionRouter);
  protectedRouter.use(conflictsRouter);
  app.use(protectedRouter);

  const householdProtectedRouter = express.Router();
  householdProtectedRouter.use(orgAuthMiddleware);
  householdProtectedRouter.use(rlsContextMiddleware);
  householdProtectedRouter.use(correlationIdMiddleware);
  householdProtectedRouter.use(jwtMiddleware);
  householdProtectedRouter.use(householdRouter);
  app.use(householdProtectedRouter);

  return app;
}

// ── thin API helpers ────────────────────────────────────────────────────
async function resolve(app, body) {
  const res = await request(app)
    .post('/v1/resolve')
    .set('Authorization', AUTH_HEADER)
    .send({ schema_version: SCHEMA_VERSION, source_system: 'demo_seed', ...body });
  if (res.status !== 200) {
    throw new Error(`resolve failed (${res.status}): ${JSON.stringify(res.body)} — sent: ${JSON.stringify(body)}`);
  }
  return res.body;
}

async function nfcResolve(app, body) {
  const res = await request(app)
    .post('/v1/ingest/nfc')
    .set('Authorization', AUTH_HEADER)
    .send({ schema_version: SCHEMA_VERSION, ...body });
  if (res.status !== 200) {
    throw new Error(`nfc ingest failed (${res.status}): ${JSON.stringify(res.body)} — sent: ${JSON.stringify(body)}`);
  }
  return res.body;
}

async function confirmConflict(app, conflictId) {
  const res = await request(app)
    .post(`/v1/conflicts/${conflictId}/confirm`)
    .set('Authorization', AUTH_HEADER)
    .send();
  if (res.status !== 200) {
    throw new Error(`confirm failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function issueSession(app, fanId) {
  const res = await request(app)
    .post('/v1/session')
    .set('Authorization', AUTH_HEADER)
    .send({ fan_id: fanId, schema_version: SCHEMA_VERSION });
  if (res.status !== 200) {
    throw new Error(`session issue failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

function freshNfcUid() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// insertFixtureFan — direct SQL. Represents "what a touchpoint already
// knows" — pre-existing state, not something assembled live. Values passed
// in `identifiers` MUST already match normalizer.js's output exactly
// (lowercase/trimmed email & name, YYYY-MM-DD dob) — this helper does not
// normalize, since fixtures skip the API layer entirely.
async function insertFixtureFan(client, identifiers, label) {
  const fanId = crypto.randomUUID();

  await client.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, $3, $3)`,
    [fanId, DEMO_ORG_ID, FIXTURE_TS]
  );

  for (const { type, value } of identifiers) {
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id, source_system,
          schema_version, confidence_score, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, 'seed', $5, 1.0, $6, $6)`,
      [fanId, type, value, DEMO_ORG_ID, SCHEMA_VERSION, FIXTURE_TS]
    );
  }

  // One audit_log row per fixture fan — no resolution_trace (only
  // resolverEngine writes those).
  await client.query(
    `INSERT INTO audit_log
       (id, fan_id, org_id, event_type, match_type, confidence_score,
        is_new_record, identifier_type, schema_version, status, created_at)
     VALUES ($1, $2, $3, 'resolution', 'hard', 1.0, true, $4, $5, 'success', $6)`,
    [crypto.randomUUID(), fanId, DEMO_ORG_ID, identifiers[0].type, SCHEMA_VERSION, FIXTURE_TS]
  );

  log(`  fixture fan: ${fanId}  ${label}`);
  return fanId;
}

// ── Scenario 1 — clean hard match (PATH A) ─────────────────────────────
async function seedScenario1(app, client) {
  log('\n=== Scenario 1 — clean hard match (PATH A) ===');

  const fixtureFanId = await insertFixtureFan(
    client,
    [{ type: 'email', value: 'alice.chen@example.com' }],
    'Alice Chen — PATH A fixture'
  );

  const res = await resolve(app, { identifier_type: 'email', identifier_value: 'alice.chen@example.com' });
  log(`  resolve: fan_id=${res.fan_id} match_type=${res.match_type} is_new_record=${res.is_new_record}`);

  if (res.match_type !== 'hard' || res.is_new_record !== false || res.fan_id !== fixtureFanId) {
    throw new Error(`Scenario 1 sanity check failed — expected PATH A hard match onto fixture ${fixtureFanId}, got ${JSON.stringify(res)}`);
  }

  return { fan_id: fixtureFanId, label: 'Alice Chen — clean hard match (PATH A)' };
}

// ── Scenario 2 — soft match requiring review, left PENDING ─────────────
async function seedScenario2(app, client) {
  log('\n=== Scenario 2 — soft match requiring review (left pending) ===');

  const fixtureFanId = await insertFixtureFan(
    client,
    [{ type: 'name', value: 'marcus webb' }, { type: 'dob', value: '1990-04-15' }],
    'Marcus Webb — fixture (name + dob)'
  );

  const tap = await nfcResolve(app, {
    nfc_uid: freshNfcUid(), station_id: 'demo-station-2',
    identifiers: { name: 'Marcus Webb', dob: '1990-04-15' },
  });
  log(`  NFC tap: fan_id=${tap.fan_id} match_type=${tap.match_type} confidence=${tap.confidence_score} conflict_id=${tap.conflict_id} — LEFT PENDING`);
  if (!tap.conflict_id || tap.match_type === 'hard') {
    throw new Error('Scenario 2 headline failed — NFC tap did not produce a pending soft/conflict match');
  }

  return {
    fixture_fan_id: fixtureFanId,
    tap_fan_id: tap.fan_id,
    pending_conflict_id: tap.conflict_id,
    label_fixture: 'Marcus Webb — fixture fan (name + dob)',
    label_tap: 'Marcus Webb — new fan minted by pending NFC-tap conflict, needs staff review',
  };
}

// ── Scenario 3 — DOB veto blocking a bad merge (the headline) ──────────
async function seedScenario3(app, client) {
  log('\n=== Scenario 3 — DOB veto blocking a bad merge (headline) ===');

  const fanAId = await insertFixtureFan(
    client,
    [{ type: 'name', value: 'john smith' }, { type: 'dob', value: '1985-03-12' }],
    'John Smith — fixture fan A (DOB veto candidate)'
  );
  const fanBId = await insertFixtureFan(
    client,
    [{ type: 'name', value: 'john smyth' }, { type: 'dob', value: '1978-11-04' }],
    'John Smyth — fixture fan B (winning candidate)'
  );

  const tap = await nfcResolve(app, {
    nfc_uid: freshNfcUid(), station_id: 'demo-station-3',
    identifiers: { name: 'John Smith', dob: '1978-11-04' },
  });
  log(`  NFC tap: fan_id=${tap.fan_id} match_type=${tap.match_type} confidence=${tap.confidence_score} audit_event_id=${tap.audit_event_id}`);

  const traceResult = await client.query(
    'SELECT id, candidate_ids, best_candidate_id, best_score FROM resolution_trace WHERE audit_event_id = $1',
    [tap.audit_event_id]
  );
  if (traceResult.rows.length === 0) {
    throw new Error('Scenario 3 — no resolution_trace row found for the NFC tap audit_event_id');
  }
  const trace = traceResult.rows[0];
  const fanAConsidered = trace.candidate_ids.includes(fanAId);
  log(`  resolution_trace id: ${trace.id}`);
  log(`  fan A considered: ${fanAConsidered}   best_candidate_id: ${trace.best_candidate_id}   best_score: ${trace.best_score}`);

  if (!fanAConsidered) {
    throw new Error('Scenario 3 headline failed — fan A never entered candidate scoring');
  }
  if (trace.best_candidate_id === fanAId) {
    throw new Error('Scenario 3 headline failed — fan A won despite the DOB conflict; veto did not hold');
  }
  if (trace.best_candidate_id !== fanBId) {
    throw new Error(`Scenario 3 headline failed — expected fan B (${fanBId}) to win, got ${trace.best_candidate_id}`);
  }

  return {
    fan_a_id: fanAId,
    fan_b_id: fanBId,
    tap_fan_id: tap.fan_id,
    tap_conflict_id: tap.conflict_id,
    trace_id: trace.id,
    label_a: 'John Smith (fan A) — DOB veto candidate, correctly did NOT win',
    label_b: 'John Smyth (fan B) — winning candidate via name_plus_dob (~0.7)',
    label_tap: 'John Smith — new fan minted by the NFC tap, pending conflict against fan B',
  };
}

// ── Scenario 4 — household with a child ─────────────────────────────────
// Unaffected by either blocker: household.js never calls resolverEngine, so
// there's no eligibility gate or merge-chain concern. Plain live resolve
// (PATH B, no scoring against anything) for the adult, then live
// session/household/member calls.
async function seedScenario4(app) {
  log('\n=== Scenario 4 — household with a child ===');

  const adult = await resolve(app, { identifier_type: 'email', identifier_value: 'household.parent@example.com' });
  log(`  adult fan: ${adult.fan_id}`);

  const session  = await issueSession(app, adult.fan_id);
  const fanToken = session.token;

  const householdRes = await request(app)
    .post('/v1/household')
    .set('Authorization', AUTH_HEADER)
    .set('X-Fan-Token', fanToken)
    .send();
  if (householdRes.status !== 201) {
    throw new Error(`household create failed (${householdRes.status}): ${JSON.stringify(householdRes.body)}`);
  }
  log(`  household id: ${householdRes.body.household_id}`);

  const memberRes = await request(app)
    .post(`/v1/household/${adult.fan_id}/members`)
    .set('Authorization', AUTH_HEADER)
    .set('X-Fan-Token', fanToken)
    .send({
      first_name:     'Casey',
      last_name:      'Park',
      dob:            '2016-06-01',
      guardian_email: 'household.parent@example.com',
      guardian_phone: '(405) 555-1111',
    });
  if (memberRes.status !== 201) {
    throw new Error(`household member create failed (${memberRes.status}): ${JSON.stringify(memberRes.body)}`);
  }
  log(`  child fan: ${memberRes.body.minor_fan_id}`);

  return {
    adult_fan_id: adult.fan_id,
    child_fan_id: memberRes.body.minor_fan_id,
    household_id: householdRes.body.household_id,
    label_adult: 'household.parent@example.com — adult fan with household',
    label_child: 'Casey Park — child fan (fan_pass identifiers, guardian_email household.parent@example.com)',
  };
}

// ── Scenario 5 — confirmed merge with history, left MERGED ─────────────
// One fixture fan (email) + one live resolve of a different field, scored
// against the fixture via email_similarity — the same single-field-bootstrap
// mechanic proven safe in Scenario 2/3's gate analysis. resolverEngine can
// never spontaneously score two pre-existing fans against each other, so
// this is the only mechanically possible way to get a genuine
// conflict_queue row without a direct insert (conflict_queue is not in the
// list of direct-SQL-authorized tables).
async function seedScenario5(app, client) {
  log('\n=== Scenario 5 — confirmed merge with history (left merged) ===');

  const fixtureFanId = await insertFixtureFan(
    client,
    [{ type: 'email', value: 'dana.park@example.com' }],
    'Dana Park — fixture fan (email)'
  );

  const step = await resolve(app, {
    identifier_type: 'name', identifier_value: 'dana park',
    identifiers: { email: 'dana.park@example.com' },
  });
  log(`  resolve (name, scored via identifiers.email against fixture): fan_id=${step.fan_id} match_type=${step.match_type} conflict_id=${step.conflict_id}`);
  if (!step.conflict_id) {
    throw new Error('Scenario 5 setup failed — expected a conflict_queue row');
  }

  const confirmed = await confirmConflict(app, step.conflict_id);
  log(`  confirmed merge: merged_into=${confirmed.merged_into} — NOT unmerged`);
  if (confirmed.merged_into !== fixtureFanId) {
    throw new Error(`Scenario 5 — expected fixture ${fixtureFanId} to be the merge survivor, got ${confirmed.merged_into}`);
  }

  const mergeHistoryResult = await client.query(
    'SELECT id, status FROM merge_history WHERE conflict_id = $1',
    [step.conflict_id]
  );
  const mergeHistoryRow = mergeHistoryResult.rows[0] || null;

  return {
    survivor_fan_id: confirmed.merged_into,
    loser_fan_id: step.fan_id,
    conflict_id: step.conflict_id,
    merge_history_id: mergeHistoryRow ? mergeHistoryRow.id : null,
    label_survivor: 'Dana Park — confirmed-merge survivor (fixture)',
    label_loser: 'Dana Park duplicate — merged in and soft-deleted (loser)',
  };
}

// ── evaluation_corpus — 8 hand-written synthetic pairs ──────────────────
//
// candidate_snapshot's 14 keys match resolverEngine's candidate SELECT
// exactly: id, org_id, email, email_last_seen_at, name, name_last_seen_at,
// dob, dob_last_seen_at, zip, zip_last_seen_at, device_id,
// device_last_seen_at, guardian_email, guardian_email_last_seen_at.
//
// RECENCY_TS is within 6 months of eval/harness.js's FROZEN_CLOCK
// (2026-07-01), so any replay through the harness gets a clean 1.0 recency
// multiplier — scores in the rationale below are exact, not approximate.
const RECENCY_TS = '2026-06-01T00:00:00.000Z';
function seenIf(v) { return v == null ? null : RECENCY_TS; }

function makeCandidate(id, { email = null, name = null, dob = null, zip = null, device_id = null, guardian_email = null } = {}) {
  return {
    id, org_id: DEMO_ORG_ID,
    email, email_last_seen_at: seenIf(email),
    name, name_last_seen_at: seenIf(name),
    dob, dob_last_seen_at: seenIf(dob),
    zip, zip_last_seen_at: seenIf(zip),
    device_id, device_last_seen_at: seenIf(device_id),
    guardian_email, guardian_email_last_seen_at: seenIf(guardian_email),
  };
}

function makeInbound({ email = null, name = null, dob = null, zip = null, device_id = null, guardian_email = null } = {}) {
  return { org_id: DEMO_ORG_ID, email, name, dob, zip, device_id, guardian_email };
}

const CORPUS_PAIRS = [
  {
    n: 1,
    inbound:   makeInbound({ email: 'pair1.taylor@example.com', name: 'taylor reed', dob: '1992-02-02' }),
    candidate: makeCandidate(crypto.randomUUID(), { email: 'pair1.taylor@example.com', name: 'taylor reed', dob: '1992-02-02' }),
    expected_verdict: 'match',
    rationale: 'All three strong identifiers (email, name, dob) agree exactly — unambiguous same person.',
  },
  {
    n: 2,
    inbound:   makeInbound({ name: 'jon smith', dob: '1988-08-08', zip: '73102' }),
    candidate: makeCandidate(crypto.randomUUID(), { name: 'john smith', dob: '1988-08-08', zip: '73102' }),
    expected_verdict: 'match',
    rationale: "Name is a one-character typo ('jon' vs 'john', similarity 0.9 clears the 0.85 threshold); dob and zip both agree exactly — same person.",
  },
  {
    n: 3,
    inbound:   makeInbound({ email: 'jsmith@example.com', name: 'pat morgan' }),
    candidate: makeCandidate(crypto.randomUUID(), { email: 'jsmith2@example.com', name: 'pat morgan' }),
    expected_verdict: 'not_match',
    rationale: 'Emails differ by one character — Sprint 5 made email comparison exact-only; a near-miss email is a different person, not a typo, even with a matching name.',
  },
  {
    n: 4,
    inbound:   makeInbound({ email: 'jordan.lee@example.com', name: 'jordan lee', dob: '1985-05-05' }),
    candidate: makeCandidate(crypto.randomUUID(), { email: 'jordan.lee@example.com', name: 'jordan lee', dob: '1978-01-01' }),
    expected_verdict: 'not_match',
    rationale: 'DOB conflict is an absolute veto invariant — a conflicting date of birth overrides the matching email and name.',
  },
  {
    n: 5,
    inbound:   makeInbound({ email: 'shared.family@example.com', name: 'morgan avery' }),
    candidate: makeCandidate(crypto.randomUUID(), { email: 'shared.family@example.com', name: 'riley chen' }),
    expected_verdict: 'not_match',
    rationale: 'Shared/family email address but the names are unrelated people — a shared inbox is not proof of shared identity.',
  },
  {
    n: 6,
    inbound:   makeInbound({ device_id: 'DEV-AA11' }),
    candidate: makeCandidate(crypto.randomUUID(), { device_id: 'DEV-AA11' }),
    expected_verdict: 'not_match',
    rationale: 'Device ID alone is weak evidence (shared/borrowed hardware) — not sufficient on its own to declare a match. device_id is intentionally excluded from normalizer ALLOWED_TYPES for this reason.',
  },
  {
    n: 7,
    inbound:   makeInbound({ guardian_email: 'parent2@example.com', name: 'child one', dob: '2015-01-01' }),
    candidate: makeCandidate(crypto.randomUUID(), { guardian_email: 'parent2@example.com', name: 'child two', dob: '2017-03-03' }),
    expected_verdict: 'not_match',
    rationale: 'Same guardian_email (siblings sharing a parent contact) but different children — guardian_email intentionally allows multiple children per household and must not merge siblings into one fan.',
  },
  {
    n: 8,
    inbound:   makeInbound({ email: 'casey.nguyen@example.com', name: 'casey nguyen' }),
    candidate: makeCandidate(crypto.randomUUID(), { email: 'casey.nguyen@example.com' }),
    expected_verdict: 'match',
    rationale: 'Email alone is a strong, exact signal; the candidate is otherwise sparse but has nothing to contradict it.',
  },
  // TODO — pairs 9-16 are pending Monique's labeling (ground-truth verdicts
  // are Thunder-owned; see CLAUDE.md "Status as of 2026-07-14" / Stage 7).
  // Do NOT invent verdicts for them. Add as their own evaluation_corpus rows
  // once labeled — this file inserts exactly the 8 pairs above.
];

async function seedEvaluationCorpus(client) {
  log('\n=== evaluation_corpus — 8 synthetic pairs ===');
  for (const pair of CORPUS_PAIRS) {
    await client.query(
      `INSERT INTO evaluation_corpus
         (id, org_id, source, trace_id, inbound_identifiers, candidate_snapshot,
          expected_verdict, rationale, created_by)
       VALUES ($1, $2, 'synthetic', NULL, $3, $4, $5, $6, 'aaron')`,
      [
        crypto.randomUUID(),
        DEMO_ORG_ID,
        JSON.stringify(pair.inbound),
        JSON.stringify(pair.candidate),
        pair.expected_verdict,
        pair.rationale,
      ]
    );
    log(`  pair ${pair.n}: ${pair.expected_verdict} — ${pair.rationale}`);
  }
  log('  (pairs 9-16 pending Monique — not inserted; see TODO in this file)');
  return CORPUS_PAIRS.length;
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // ONE-SHOT GUARD — no partial seeding, no delete, no throw.
    const existing = await client.query('SELECT id FROM org WHERE id = $1', [DEMO_ORG_ID]);
    if (existing.rows.length > 0) {
      console.log(
        'Demo org already seeded. To reseed: bash scripts/resetLocalDb.sh,\n' +
        're-run this script.'
      );
      return;
    }

    // org row — direct SQL, chicken-and-egg (no API exists to create an org)
    const apiKeyHash = crypto.createHash('sha256').update(DEMO_API_KEY).digest('hex');
    await client.query(
      `INSERT INTO org (id, name, is_active, org_api_key_hash) VALUES ($1, $2, true, $3)`,
      [DEMO_ORG_ID, DEMO_ORG_NAME, apiKeyHash]
    );
    log(`Org created: ${DEMO_ORG_ID} (${DEMO_ORG_NAME})`);

    // RLS context for this script's own direct-SQL reads/writes below
    // (fan, identifier_link, evaluation_corpus, resolution_trace,
    // merge_history all FORCE RLS). Uses a dedicated client, not the shared
    // `pool` — set_config is session-scoped and the app's own middleware
    // also borrows connections from `pool`; a stray set_config there would
    // be the exact pooled-connection carryover gap documented in CLAUDE.md.
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [DEMO_ORG_ID]);

    const app = buildApp();

    const s1 = await seedScenario1(app, client);
    const s2 = await seedScenario2(app, client);
    const s3 = await seedScenario3(app, client);
    const s4 = await seedScenario4(app);
    const s5 = await seedScenario5(app, client);
    const corpusCount = await seedEvaluationCorpus(client);

    log('\n=== SUMMARY ===');
    log(`org_id: ${DEMO_ORG_ID}`);
    log(`org_name: ${DEMO_ORG_NAME}`);
    log(`raw API key (send as "Authorization: Bearer <key>"): ${DEMO_API_KEY}`);
    log('');
    log('Fans:');
    log(`  ${s1.fan_id}  ${s1.label}`);
    log(`  ${s2.fixture_fan_id}  ${s2.label_fixture}`);
    log(`  ${s2.tap_fan_id}  ${s2.label_tap}`);
    log(`  ${s3.fan_a_id}  ${s3.label_a}`);
    log(`  ${s3.fan_b_id}  ${s3.label_b}`);
    log(`  ${s3.tap_fan_id}  ${s3.label_tap}`);
    log(`  ${s4.adult_fan_id}  ${s4.label_adult}`);
    log(`  ${s4.child_fan_id}  ${s4.label_child}`);
    log(`  ${s5.survivor_fan_id}  ${s5.label_survivor}`);
    log(`  ${s5.loser_fan_id}  ${s5.label_loser}`);
    log('');
    log('Conflicts:');
    log(`  ${s2.pending_conflict_id}  pending    (Scenario 2 — Marcus Webb NFC-tap conflict, needs staff review)`);
    log(`  ${s3.tap_conflict_id}  pending    (Scenario 3 — fan B vs NFC-tap fan, needs staff review)`);
    log(`  ${s5.conflict_id}  confirmed  (Scenario 5 — Dana Park merge, merge_history id ${s5.merge_history_id})`);
    log('');
    log('Traces:');
    log(`  ${s3.trace_id}  Scenario 3 — DOB veto headline trace (audit_event_id-linked)`);
    log('');
    log(`evaluation_corpus rows: ${corpusCount}`);
    log(`household_id (Scenario 4): ${s4.household_id}`);

    const outPath = path.join(__dirname, 'demo-org-summary.txt');
    fs.writeFileSync(outPath, summaryLines.join('\n') + '\n');
    console.log(`\nSummary written to ${outPath}`);
  } finally {
    await client.end();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('seedDemoOrg failed:', err);
  process.exit(1);
});
