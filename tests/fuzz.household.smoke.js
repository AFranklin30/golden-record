'use strict';
// tests/fuzz.household.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/fuzz.household.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Fuzz / malformed-input probe for two household write endpoints:
//   POST /v1/household/:adult_fan_id/members         (Component 29 — add-child)
//   PUT  /v1/household/:adult_fan_id/members/:child  (Component 31 — update)
//
// Categories:
//   CLEAN REJECT:       status 400 (or 409) AND row-delta 0 — correctly rejected
//   HARD GAP:           status 500, OR any write with a non-2xx status — fix targets
//   SILENT DEGRADATION: 2xx status AND (malformed input accepted; writes may occur)
//
// PROBE ONLY — reports what it finds, fixes nothing.
//
// Step 0 confirmed gaps (traced from household.js before writing):
//
//   Component 29 GUARD (lines 240–254) — OUTSIDE any try/catch:
//
//     if (!first_name || !first_name.trim()) { return 400; }
//     if (!last_name  || !last_name.trim())  { return 400; }
//     if (!dob        || !dob.trim())        { return 400; }
//     if (!guardian_email || !guardian_email.trim()) { return 400; }
//     if (!guardian_phone || !guardian_phone.trim()) { return 400; }
//
//     For any truthy non-string (42, ["x"], {y:2010}, true):
//       !value   → false  (short-circuit does NOT fire)
//       value.trim() → TypeError: value.trim is not a function
//     The GUARD section has no try/catch. Express 5 catches the rejected
//     async handler promise and returns 500. HARD GAP on all five fields.
//
//   Component 31 READ 4a (line 641) — INSIDE EXECUTE try/catch:
//
//     const newFirst = first_name != null ? first_name.trim() : exFirst;
//
//     For D1 (first_name=42, last_name omitted):
//       Normalization block SKIPS (42 != null && undefined != null = false).
//       READ 4a fires: 42.trim() → TypeError → EXECUTE catch → 500. HARD GAP.
//
//   Component 31 dob / guardian_email / guardian_phone: passed directly to
//     normalizeIdentifier (no pre-.trim()), so typeof check fires → NormalizationError
//     → 400. CLEAN.
//
// Auth headers:
//   Authorization: Bearer <ORG_KEY>   (raw key, hashed before storage)
//   x-fan-token:   <adultToken>        (fan JWT minted with signToken)

require('dotenv').config();

// ── Safety guard — must run before pool or any route module is loaded ─────────
(function guardLocalOnly() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error('BLOCKED: DATABASE_URL is not set. Add it to .env and point it at localhost:5432.');
    process.exit(1);
  }
  let parsed;
  try { parsed = new URL(raw); } catch {
    console.error('BLOCKED: DATABASE_URL could not be parsed. Check .env.');
    process.exit(1);
  }
  const host = parsed.hostname;
  const port = parsed.port || '5432';
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocal || port === '5433') {
    console.error('BLOCKED: DATABASE_URL does not point to local Postgres on port 5432.');
    console.error(`  host: ${host}  port: ${port}`);
    console.error('  This test must never run against Cloud SQL (port 5433) or a remote host.');
    process.exit(1);
  }
}());
// ─────────────────────────────────────────────────────────────────────────────

const http    = require('http');
const express = require('express');
const crypto  = require('crypto');
const pool    = require('../src/db/pool');

const orgAuthMiddleware       = require('../src/middleware/orgAuthMiddleware');
const rlsContextMiddleware    = require('../src/middleware/rlsContextMiddleware');
const correlationIdMiddleware = require('../src/middleware/correlationIdMiddleware');
const jwtMiddleware           = require('../src/middleware/jwtMiddleware');
const householdRouter         = require('../src/routes/household');
const { signToken }           = require('../src/modules/jwt');

const CLEAN_REJECT   = 'CLEAN REJECT';
const HARD_GAP       = 'HARD GAP';
const SILENT_DEGRADE = 'SILENT DEGRADATION';

// Module-level state set during setup
let server;
let testOrgId, adultId, childId, householdId;
let adultToken;
let countClient;
let passed = 0, failed = 0;

// Raw key = testOrgId UUID (set per-run in setup) — unique, no collision risk
// avoids the "constant hash collides when prior org cleanup failed" problem.
let ORG_KEY;  // assigned in run() after testOrgId is created
const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL  ${message}`);
    failed++;
  } else {
    console.log(`  PASS  ${message}`);
    passed++;
  }
}

// Generic HTTP helper — sends JSON body with both auth headers
function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const port    = server.address().port;
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization':  `Bearer ${ORG_KEY}`,
          'x-fan-token':    adultToken,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Endpoint helpers — closures over adultId / childId (set in setup before any probe runs)
function postMember(body) {
  return httpRequest('POST', `/v1/household/${adultId}/members`, body);
}

function putMember(body) {
  return httpRequest('PUT', `/v1/household/${adultId}/members/${childId}`, body);
}

// Row counters — RLS context already set on countClient
async function countRows() {
  const fan    = await countClient.query('SELECT COUNT(*) AS n FROM fan              WHERE org_id = $1', [testOrgId]);
  const link   = await countClient.query('SELECT COUNT(*) AS n FROM identifier_link  WHERE org_id = $1', [testOrgId]);
  const member = await countClient.query('SELECT COUNT(*) AS n FROM household_member WHERE org_id = $1', [testOrgId]);
  const audit  = await countClient.query('SELECT COUNT(*) AS n FROM audit_log         WHERE org_id = $1', [testOrgId]);
  return {
    fan:    parseInt(fan.rows[0].n,    10),
    link:   parseInt(link.rows[0].n,   10),
    member: parseInt(member.rows[0].n, 10),
    audit:  parseInt(audit.rows[0].n,  10),
  };
}

function rowDelta(before, after) {
  const d = {
    fan:    after.fan    - before.fan,
    link:   after.link   - before.link,
    member: after.member - before.member,
    audit:  after.audit  - before.audit,
  };
  d.total = d.fan + d.link + d.member + d.audit;
  return d;
}

function fmt(n) { return n >= 0 ? `+${n}` : `${n}`; }

function classify(status, d) {
  if ((status === 400 || status === 409) && d.total === 0) return CLEAN_REJECT;
  if (status === 500 || (status >= 400 && d.total > 0))   return HARD_GAP;
  if (status === 200 || status === 201)                   return SILENT_DEGRADE;
  return `UNKNOWN(${status})`;
}

async function probeCase(label, desc, reqFn, body, predicted) {
  const before = await countRows();
  const resp   = await reqFn(body);
  const after  = await countRows();
  const d      = rowDelta(before, after);
  const actual = classify(resp.status, d);

  const snippet = resp.body
    ? (resp.body.error || resp.body.household_member_id || JSON.stringify(resp.body).slice(0, 80))
    : String(resp.body).slice(0, 80);

  console.log(`\nCASE ${label}: ${desc}`);
  console.log(`  status:    ${resp.status}`);
  console.log(`  body:      ${snippet}`);
  console.log(`  row-delta: fan${fmt(d.fan)}, link${fmt(d.link)}, member${fmt(d.member)}, audit${fmt(d.audit)}`);
  console.log(`  CATEGORY:  ${actual}  (predicted: ${predicted})`);

  assert(actual === predicted, `${label}: category ${actual} === ${predicted}`);
  return { label, actual, resp, d };
}

async function run() {
  console.log('\nfuzz.household — malformed-input probe\n');
  console.log('══════════════════════════════════════════════════════════════\n');

  // ── SETUP ─────────────────────────────────────────────────────────────────────
  testOrgId   = crypto.randomUUID();
  adultId     = crypto.randomUUID();
  childId     = crypto.randomUUID();
  householdId = crypto.randomUUID();
  ORG_KEY     = testOrgId;  // raw key = testOrgId UUID — unique per run, no collision

  // Minimal Express app — same middleware order as householdProtectedRouter in index.js
  const app = express();
  app.use(express.json());
  app.use(orgAuthMiddleware);
  app.use(rlsContextMiddleware);
  app.use(correlationIdMiddleware);
  app.use(jwtMiddleware);
  app.use(householdRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });

  // Seed org — raw key = ORG_KEY constant, no collision risk
  await pool.query(
    `INSERT INTO org (id, name, is_active, org_api_key_hash)
     VALUES ($1, '_fuzz_household_probe', true, $2)`,
    [testOrgId, hashKey(ORG_KEY)]
  );

  // Seed adult fan
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [adultId, testOrgId]
  );

  // Seed household
  await pool.query(
    `INSERT INTO household (id, org_id, adult_fan_id, created_by, created_at)
     VALUES ($1, $2, $3, 'fan', NOW())`,
    [householdId, testOrgId, adultId]
  );

  // Seed existing child fan + identifiers + active membership (required for PUT cases D1–D4)
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [childId, testOrgId]
  );
  for (const [type, value] of [
    ['name',           'seed child'],
    ['dob',            '2012-06-15'],
    ['guardian_email', 'guardian@fuzz-seed.com'],
    ['guardian_phone', '+14055551234'],
  ]) {
    await pool.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, 'fan_pass', '1.0', 1.0, NOW(), NOW())`,
      [childId, type, value, testOrgId]
    );
  }
  await pool.query(
    `INSERT INTO household_member
       (id, household_id, adult_fan_id, minor_fan_id, org_id,
        link_type, status, dob, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'hard', 'active', '2012-06-15', NOW())`,
    [householdId, adultId, childId, testOrgId]
  );

  // Mint adult JWT — signToken attaches fan_id and org_id to the token
  adultToken = signToken({ fan_id: adultId, org_id: testOrgId }).token;

  // Dedicated counting client — RLS context set once for all row counts
  countClient = await pool.connect();
  await countClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

  const results = [];

  try {

    // ── GROUP A — add-child (Component 29), non-string body fields ────────────
    // FIXED (typeof guard at top of GUARD section, before any .trim() call).
    // Was HARD GAP; now CLEAN REJECT → 400.
    console.log('GROUP A — add-child (Component 29), non-string body fields');
    console.log('────────────────────────────────────────────────────────────');

    results.push(await probeCase(
      'A1', 'first_name = 42  (number)',
      postMember,
      { first_name: 42, last_name: 'Smith', dob: '2010-01-01',
        guardian_email: 'a@test.com', guardian_phone: '4055559999' },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'A2', 'last_name = ["x"]  (array)',
      postMember,
      { first_name: 'Alice', last_name: ['x'], dob: '2010-01-01',
        guardian_email: 'a@test.com', guardian_phone: '4055559999' },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'A3', 'dob = { y: 2010 }  (object)',
      postMember,
      { first_name: 'Alice', last_name: 'Smith', dob: { y: 2010 },
        guardian_email: 'a@test.com', guardian_phone: '4055559999' },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'A4', 'guardian_email = 42  (number)',
      postMember,
      { first_name: 'Alice', last_name: 'Smith', dob: '2010-01-01',
        guardian_email: 42, guardian_phone: '4055559999' },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'A5', 'guardian_phone = true  (boolean)',
      postMember,
      { first_name: 'Alice', last_name: 'Smith', dob: '2010-01-01',
        guardian_email: 'a@test.com', guardian_phone: true },
      CLEAN_REJECT
    ));

    // ── GROUP B — add-child, malformed-but-string ─────────────────────────────
    // PREDICTED CLEAN REJECT: guard passes (truthy non-empty string), then
    // normalizeIdentifier catches the invalid format → NormalizationError → 400.
    console.log('\nGROUP B — add-child, malformed-but-string (expected CLEAN REJECT via normalizer)');
    console.log('────────────────────────────────────────────────────────────────────────────────');

    results.push(await probeCase(
      'B1', 'dob = "2015-13-45"  (invalid date string)',
      postMember,
      { first_name: 'Alice', last_name: 'Smith', dob: '2015-13-45',
        guardian_email: 'a@test.com', guardian_phone: '4055559999' },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'B2', 'guardian_email = "notanemail"',
      postMember,
      { first_name: 'Alice', last_name: 'Smith', dob: '2010-01-01',
        guardian_email: 'notanemail', guardian_phone: '4055559999' },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'B3', 'guardian_phone = "abc"',
      postMember,
      { first_name: 'Alice', last_name: 'Smith', dob: '2010-01-01',
        guardian_email: 'a@test.com', guardian_phone: 'abc' },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'B4', 'first_name = "   "  (whitespace only)',
      postMember,
      { first_name: '   ', last_name: 'Smith', dob: '2010-01-01',
        guardian_email: 'a@test.com', guardian_phone: '4055559999' },
      CLEAN_REJECT
    ));

    // ── GROUP C — add-child, absent fields ───────────────────────────────────
    // PREDICTED CLEAN REJECT: undefined fields hit !field → 400 before any work.
    console.log('\nGROUP C — add-child, absent fields (expected CLEAN REJECT)');
    console.log('────────────────────────────────────────────────────────────');

    results.push(await probeCase(
      'C1', 'body = {}  (all required fields missing)',
      postMember,
      {},
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'C2', 'first_name present, everything else missing',
      postMember,
      { first_name: 'Alice' },
      CLEAN_REJECT
    ));

    // ── GROUP D — update (Component 31), non-string + partial-update edge ─────
    // D1 PREDICTED HARD GAP: READ 4a (line 641) inside EXECUTE try/catch.
    // D2, D3 PREDICTED CLEAN REJECT: dob/email passed to normalizeIdentifier directly.
    // D4 PREDICTED CLEAN REJECT: no editable fields guard fires before any work.
    console.log('\nGROUP D — update (Component 31), non-string + edge cases');
    console.log('──────────────────────────────────────────────────────────');

    results.push(await probeCase(
      'D1', 'first_name = 42  (number), last_name omitted — exercises READ 4a name-rebuild branch',
      putMember,
      { first_name: 42 },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'D2', 'dob = ["x"]  (array) — no pre-.trim(); normalizeIdentifier typeof check → 400',
      putMember,
      { dob: ['x'] },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'D3', 'guardian_email = { a: 1 }  (object) — normalizeIdentifier typeof check → 400',
      putMember,
      { guardian_email: { a: 1 } },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'D4', 'body = {}  (no editable fields → expected 400 before any work)',
      putMember,
      {},
      CLEAN_REJECT
    ));

    // ── GROUP E — adversarial / oversized ─────────────────────────────────────
    // E1 PREDICTED SILENT DEGRADATION: normalizeName accepts injection string as a
    //   literal name; parameterized queries prevent execution. 201 + writes.
    // E2 PREDICTED CLEAN REJECT: normalizeIdentifier length > 512 → NormalizationError.
    console.log('\nGROUP E — adversarial / oversized');
    console.log('────────────────────────────────────');

    results.push(await probeCase(
      'E1', "first_name = \"'; DROP TABLE fan;--\"  (SQL injection — stored as literal, never executed)",
      postMember,
      { first_name: "'; DROP TABLE fan;--", last_name: 'Safe',
        dob: '2011-03-20', guardian_email: 'safe@test.com', guardian_phone: '4055558888' },
      SILENT_DEGRADE
    ));

    results.push(await probeCase(
      'E2', 'first_name = "a".repeat(100000)  (oversized — normalizer caps at 512)',
      postMember,
      { first_name: 'a'.repeat(100000), last_name: 'Smith', dob: '2010-01-01',
        guardian_email: 'a@test.com', guardian_phone: '4055559999' },
      CLEAN_REJECT
    ));

  } finally {

    // ── SUMMARY ───────────────────────────────────────────────────────────────
    const cleanRejects   = results.filter(r => r.actual === CLEAN_REJECT).map(r => r.label);
    const hardGaps       = results.filter(r => r.actual === HARD_GAP).map(r => r.label);
    const silentDegrades = results.filter(r => r.actual === SILENT_DEGRADE).map(r => r.label);
    const unknowns       = results.filter(r =>
      r.actual !== CLEAN_REJECT && r.actual !== HARD_GAP && r.actual !== SILENT_DEGRADE
    ).map(r => r.label);

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('FUZZ PROBE SUMMARY — household write endpoints');
    console.log('══════════════════════════════════════════════════════════════');
    console.log(`CLEAN REJECT:       [${cleanRejects.join(', ')}]`);
    console.log(`HARD GAP:           [${hardGaps.join(', ')}]  ← fix targets`);
    console.log(`SILENT DEGRADATION: [${silentDegrades.join(', ')}]`);
    if (unknowns.length) {
      console.log(`UNKNOWN:            [${unknowns.join(', ')}]  ← unexpected status codes`);
    }
    console.log('');
    console.log('FIX TARGETS:');
    console.log('  A1–A5 (Component 29 guard, lines 240–254):');
    console.log('    !value.trim() on truthy non-strings throws TypeError outside try/catch.');
    console.log('    Fix: add `if (typeof first_name !== "string")` checks before .trim() calls,');
    console.log('    or consolidate into a single typeof guard block at the top of GUARD.');
    console.log('');
    console.log('  D1 (Component 31 READ 4a, line 641):');
    console.log('    first_name.trim() called inside EXECUTE try/catch when first_name is a non-string');
    console.log('    and last_name is omitted (normalization block skipped). TypeError → 500.');
    console.log('    Fix: `typeof first_name === "string" ? first_name.trim() : String(first_name || "")`');
    console.log('    or a typeof guard before entering READ 4a.');
    console.log('');
    console.log('NOTES:');
    console.log('  E1 (SQL injection): parameterized queries prevent execution. normalizeName');
    console.log('    accepts the string as a valid (if unusual) name and stores it as a literal.');
    console.log('    SILENT DEGRADATION = probe finding, not a security hole.');
    console.log('══════════════════════════════════════════════════════════════\n');

    // ── CLEANUP ───────────────────────────────────────────────────────────────
    countClient.release();
    if (server) server.close();

    console.log('Cleaning up test data...');
    const c = await pool.connect();
    try {
      await c.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

      // audit_log is append-only (enforce_audit_log_append_only trigger, migration_003).
      // E1 succeeds and writes an audit row — DELETE will fail. Swallowed.
      try { await c.query(`DELETE FROM audit_log        WHERE org_id = $1`, [testOrgId]); } catch { /* append-only — expected */ }

      // These always succeed — no FK referencing household_member, household, identifier_link
      await c.query(`DELETE FROM household_member WHERE org_id = $1`, [testOrgId]);
      await c.query(`DELETE FROM household        WHERE org_id = $1`, [testOrgId]);
      await c.query(`DELETE FROM identifier_link  WHERE org_id = $1`, [testOrgId]);

      // audit_log_fan_id_fkey is NO ACTION — fan rows referenced by surviving audit_log
      // rows (E1 success) cannot be deleted. Swallowed — orphaned rows are inert
      // (testOrgId is a fresh UUID per run; no future run references this org).
      try { await c.query(`DELETE FROM fan WHERE org_id = $1`, [testOrgId]); } catch { /* audit_log FK — expected when E1 succeeds */ }
      try { await c.query(`DELETE FROM org WHERE id     = $1`, [testOrgId]); } catch { /* fan FK  — expected when fan rows remain */ }

      console.log('Cleanup complete (audit_log/fan/org rows may remain as inert orphans).\n');
    } catch (cleanupErr) {
      console.error('Unexpected cleanup error:', cleanupErr.message);
    } finally {
      c.release();
    }
  }

  const total = passed + failed;
  console.log(`${total} checks: ${passed} passed, ${failed} failed\n`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Probe crashed:', err.message);
  console.error(err.stack);
  pool.end();
  process.exit(1);
});
