'use strict';
// tests/fuzz.resolve.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/fuzz.resolve.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Fuzz / malformed-input probe for POST /v1/resolve.
// Fires malformed inputs and classifies each outcome into one of three categories:
//   CLEAN REJECT:       status 400 AND row-delta 0
//   HARD GAP:           status 500, OR row-delta > 0 with a non-2xx status
//   SILENT DEGRADATION: status 200 AND malformed input accepted without error
//
// This is a PROBE — it reports what it finds and fixes nothing.
// The output IS the deliverable. Fix targets appear in the SUMMARY block.
//
// Step 0 code trace (before writing — confirmed/refuted from source):
//
//   Group B (B1-B4) — CONFIRMED CLEAN REJECT 400:
//     normalizer.js:119 typeof rawValue !== 'string' → NormalizationError → 400.
//     Route guard fires before any DB call. Delta 0.
//
//   A1/A2/A3 — CONFIRMED SILENT DEGRADATION:
//     extra.foo ?? null → all inbound fields null → eligibility gate fails → PATH B.
//
//   A4 (identifiers.email = 42) — CONFIRMED in outcome, mechanism REFUTED:
//     Predicted "NaN >= 0.8 false, no throw." WRONG.
//     If scoreMatch IS called: levenshteinDistance(42, b) → dp[undefined][n] → TypeError.
//     But in test (no email-having candidates): candidate.email = null for all fans →
//     gate check fails → scoreMatch never called → PATH B → 200.
//     LATENT HARD GAP: would be 500 if email candidates existed.
//
//   A5 (identifiers.name = {nested:1}) — REFUTED — SILENT DEGRADATION, not HARD GAP:
//     Original prediction: HARD GAP 500 (.trim() on object throws in scoreMatch).
//     Actual: eligibility gate fails (0 strong, 0-1 weak — gate needs ≥1 strong or
//     ≥2 weak). All accumulated test fans have only nba_id in identifier_link →
//     candidate.name = null → name_alone weak = 0. scoreMatch never called.
//     PATH B → 200. The throw path requires another strong signal alongside name.
//
//   A6 — CONFIRMED SILENT DEGRADATION:
//     ["a"] === candidate.guardian_email → false → signal skipped.
//
//   A7 — CONFIRMED SILENT DEGRADATION:
//     "2015-13-45" never matches any normalized DOB. Signal skipped.
//
//   Group C (C1-C3) — CONFIRMED CLEAN REJECT 400:
//     resolve.js route guards fire before normalizer/resolverEngine.
//
//   D1 (SQL injection) — SILENT DEGRADATION:
//     nba_id normalizer just trims. Parameterized queries neutralize injection.
//     PATH B creates fan. 200.
//
//   D2 (100k chars) — CONFIRMED CLEAN REJECT 400:
//     normalizer.js:125 length > 512 → NormalizationError → 400.
//
//   D3 (Unicode normalization gap) — SILENT DEGRADATION ×2:
//     nba_id normalizer only trims — no NFC/NFKC normalization.
//     'café' ≠ 'café' as JS strings → two separate fans.

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
  const host    = parsed.hostname;
  const port    = parsed.port || '5432';
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
const resolveRouter           = require('../src/routes/resolve');

const ORG_KEY = 'test-key-fuzz-resolve-probe';
const orgHash = crypto.createHash('sha256').update(ORG_KEY).digest('hex');

const CLEAN_REJECT   = 'CLEAN REJECT';
const HARD_GAP       = 'HARD GAP';
const SILENT_DEGRADE = 'SILENT DEGRADATION';

let server;
let testOrgId;
let countClient;
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL  ${message}`);
    failed++;
  } else {
    console.log(`  PASS  ${message}`);
    passed++;
  }
}

function post(body) {
  return new Promise((resolve, reject) => {
    const port    = server.address().port;
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path:     '/v1/resolve',
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization':  `Bearer ${ORG_KEY}`,
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

async function countRows() {
  const fan      = await countClient.query(
    'SELECT COUNT(*) AS n FROM fan                    WHERE org_id = $1', [testOrgId]
  );
  const link     = await countClient.query(
    'SELECT COUNT(*) AS n FROM identifier_link        WHERE org_id = $1', [testOrgId]
  );
  const conflict = await countClient.query(
    'SELECT COUNT(*) AS n FROM conflict_queue         WHERE org_id = $1', [testOrgId]
  );
  const staging  = await countClient.query(
    'SELECT COUNT(*) AS n FROM staging_household_data WHERE org_id = $1', [testOrgId]
  );
  return {
    fan:      parseInt(fan.rows[0].n,      10),
    link:     parseInt(link.rows[0].n,     10),
    conflict: parseInt(conflict.rows[0].n, 10),
    staging:  parseInt(staging.rows[0].n,  10),
  };
}

function rowDelta(before, after) {
  const d = {
    fan:      after.fan      - before.fan,
    link:     after.link     - before.link,
    conflict: after.conflict - before.conflict,
    staging:  after.staging  - before.staging,
  };
  d.total = d.fan + d.link + d.conflict + d.staging;
  return d;
}

function fmt(n) { return (n >= 0 ? `+${n}` : `${n}`); }

function classify(status, d) {
  if (status === 400 && d.total === 0) return CLEAN_REJECT;
  if (status === 500 || (status >= 400 && d.total > 0)) return HARD_GAP;
  if (status === 200) return SILENT_DEGRADE;
  return `UNKNOWN(${status})`;
}

async function probeCase(label, desc, body, predicted) {
  const before = await countRows();
  const resp   = await post(body);
  const after  = await countRows();
  const d      = rowDelta(before, after);
  const actual = classify(resp.status, d);

  const bodySnippet = resp.body
    ? (resp.body.error || resp.body.fan_id || JSON.stringify(resp.body).slice(0, 80))
    : String(resp.body).slice(0, 80);

  console.log(`\nCASE ${label}: ${desc}`);
  console.log(`  status:    ${resp.status}`);
  console.log(`  body:      ${bodySnippet}`);
  console.log(`  row-delta: fan${fmt(d.fan)}, link${fmt(d.link)}, conflict${fmt(d.conflict)}, staging${fmt(d.staging)}`);
  console.log(`  CATEGORY:  ${actual}  (predicted: ${predicted})`);

  assert(actual === predicted, `${label}: ${actual} === ${predicted}`);

  return { label, actual, resp, d };
}

async function run() {
  console.log('\nfuzz.resolve — malformed-input probe\n');
  console.log('══════════════════════════════════════════════════════════════\n');

  // ── SETUP ────────────────────────────────────────────────────────────────────
  testOrgId = crypto.randomUUID();

  const app = express();
  app.use(express.json());
  app.use(orgAuthMiddleware);
  app.use(rlsContextMiddleware);
  app.use(correlationIdMiddleware);
  app.use(resolveRouter);
  await new Promise((res) => { server = app.listen(0, res); });

  // Seed org — ON CONFLICT handles re-runs where prior cleanup left the org row.
  // All PATH B fans created during probe are candidates for subsequent cases,
  // but they only carry nba_id in identifier_link (null email/name/dob/zip).
  const orgResult = await pool.query(
    `INSERT INTO org (id, name, org_api_key_hash)
     VALUES ($1, '_fuzz_resolve_probe', $2)
     ON CONFLICT (org_api_key_hash) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [testOrgId, orgHash]
  );
  testOrgId = orgResult.rows[0].id;

  // Dedicated counting client — session-scoped RLS context set once.
  countClient = await pool.connect();
  await countClient.query(
    `SELECT set_config('app.current_org_id', $1, false)`,
    [testOrgId]
  );

  const results = [];

  try {

    // ── GROUP A — identifiers object (unguarded surface) ─────────────────────
    console.log('GROUP A — identifiers object (unguarded surface)');
    console.log('──────────────────────────────────────────────────');

    results.push(await probeCase(
      'A1', 'identifiers = "notanobject"',
      { identifier_type: 'nba_id', identifier_value: crypto.randomUUID(), schema_version: 'v1', identifiers: 'notanobject' },
      SILENT_DEGRADE
    ));

    results.push(await probeCase(
      'A2', 'identifiers = ["x"]',
      { identifier_type: 'nba_id', identifier_value: crypto.randomUUID(), schema_version: 'v1', identifiers: ['x'] },
      SILENT_DEGRADE
    ));

    results.push(await probeCase(
      'A3', 'identifiers = 42',
      { identifier_type: 'nba_id', identifier_value: crypto.randomUUID(), schema_version: 'v1', identifiers: 42 },
      SILENT_DEGRADE
    ));

    results.push(await probeCase(
      'A4', 'identifiers = { email: 42 }  [latent HARD GAP if email candidates present]',
      { identifier_type: 'nba_id', identifier_value: crypto.randomUUID(), schema_version: 'v1', identifiers: { email: 42 } },
      SILENT_DEGRADE
    ));

    results.push(await probeCase(
      'A5', 'identifiers = { name: { nested: 1 } }  [REFUTED from HARD GAP — gate blocks scoreMatch]',
      { identifier_type: 'nba_id', identifier_value: crypto.randomUUID(), schema_version: 'v1', identifiers: { name: { nested: 1 } } },
      SILENT_DEGRADE
    ));

    results.push(await probeCase(
      'A6', 'identifiers = { guardian_email: ["a"] }',
      { identifier_type: 'nba_id', identifier_value: crypto.randomUUID(), schema_version: 'v1', identifiers: { guardian_email: ['a'] } },
      SILENT_DEGRADE
    ));

    results.push(await probeCase(
      'A7', 'identifiers = { dob: "2015-13-45" }',
      { identifier_type: 'nba_id', identifier_value: crypto.randomUUID(), schema_version: 'v1', identifiers: { dob: '2015-13-45' } },
      SILENT_DEGRADE
    ));

    // ── GROUP B — singular identifier_value type confusion ───────────────────
    console.log('\nGROUP B — singular identifier_value type confusion (expected CLEAN REJECT)');
    console.log('──────────────────────────────────────────────────────────────────────────');

    results.push(await probeCase(
      'B1', 'identifier_value = 12345 (number)',
      { identifier_type: 'nba_id', identifier_value: 12345, schema_version: 'v1' },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'B2', 'identifier_value = ["x"] (array)',
      { identifier_type: 'nba_id', identifier_value: ['x'], schema_version: 'v1' },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'B3', 'identifier_value = { a: 1 } (object)',
      { identifier_type: 'nba_id', identifier_value: { a: 1 }, schema_version: 'v1' },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'B4', 'identifier_value = true (bool)',
      { identifier_type: 'nba_id', identifier_value: true, schema_version: 'v1' },
      CLEAN_REJECT
    ));

    // ── GROUP C — absence / whitespace ───────────────────────────────────────
    console.log('\nGROUP C — absence / whitespace (expected CLEAN REJECT)');
    console.log('────────────────────────────────────────────────────────');

    results.push(await probeCase(
      'C1', 'identifier_type = "   " (whitespace only)',
      { identifier_type: '   ', identifier_value: crypto.randomUUID(), schema_version: 'v1' },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'C2', 'schema_version omitted',
      { identifier_type: 'nba_id', identifier_value: crypto.randomUUID() },
      CLEAN_REJECT
    ));

    results.push(await probeCase(
      'C3', 'body = {}',
      {},
      CLEAN_REJECT
    ));

    // ── GROUP D — adversarial strings ────────────────────────────────────────
    console.log('\nGROUP D — adversarial strings');
    console.log('──────────────────────────────');

    results.push(await probeCase(
      'D1', "identifier_value = \"'; DROP TABLE fan;--\" (SQL injection — parameterized query should neutralize)",
      { identifier_type: 'nba_id', identifier_value: "'; DROP TABLE fan;--", schema_version: 'v1' },
      SILENT_DEGRADE
    ));

    results.push(await probeCase(
      'D2', 'identifier_value = "a".repeat(100000) (length attack)',
      { identifier_type: 'nba_id', identifier_value: 'a'.repeat(100000), schema_version: 'v1' },
      CLEAN_REJECT
    ));

    // D3 — two sends for Unicode normalization gap probe
    console.log(`\nCASE D3a: identifier_value = "caf\\u00e9" (precomposed é, U+00E9)`);
    const d3aBefore = await countRows();
    const d3aResp   = await post({ identifier_type: 'nba_id', identifier_value: 'café',  schema_version: 'v1' });
    const d3aAfter  = await countRows();
    const d3aDelta  = rowDelta(d3aBefore, d3aAfter);
    const d3aActual = classify(d3aResp.status, d3aDelta);
    const d3aSnippet = d3aResp.body ? (d3aResp.body.error || d3aResp.body.fan_id) : String(d3aResp.body);
    console.log(`  status:    ${d3aResp.status}`);
    console.log(`  body:      ${d3aSnippet}`);
    console.log(`  row-delta: fan${fmt(d3aDelta.fan)}, link${fmt(d3aDelta.link)}, conflict${fmt(d3aDelta.conflict)}, staging${fmt(d3aDelta.staging)}`);
    console.log(`  CATEGORY:  ${d3aActual}  (predicted: ${SILENT_DEGRADE})`);
    assert(d3aActual === SILENT_DEGRADE, `D3a: ${d3aActual} === ${SILENT_DEGRADE}`);
    results.push({ label: 'D3a', actual: d3aActual, resp: d3aResp, d: d3aDelta });

    console.log(`\nCASE D3b: identifier_value = "cafe\\u0301" (decomposed e + combining U+0301)`);
    const d3bBefore = await countRows();
    const d3bResp   = await post({ identifier_type: 'nba_id', identifier_value: 'café', schema_version: 'v1' });
    const d3bAfter  = await countRows();
    const d3bDelta  = rowDelta(d3bBefore, d3bAfter);
    const d3bActual = classify(d3bResp.status, d3bDelta);
    const d3bSnippet = d3bResp.body ? (d3bResp.body.error || d3bResp.body.fan_id) : String(d3bResp.body);
    console.log(`  status:    ${d3bResp.status}`);
    console.log(`  body:      ${d3bSnippet}`);
    console.log(`  row-delta: fan${fmt(d3bDelta.fan)}, link${fmt(d3bDelta.link)}, conflict${fmt(d3bDelta.conflict)}, staging${fmt(d3bDelta.staging)}`);
    console.log(`  CATEGORY:  ${d3bActual}  (predicted: ${SILENT_DEGRADE})`);
    assert(d3bActual === SILENT_DEGRADE, `D3b: ${d3bActual} === ${SILENT_DEGRADE}`);
    results.push({ label: 'D3b', actual: d3bActual, resp: d3bResp, d: d3bDelta });

    // D3 extra assertion: two Unicode forms must produce different fan records.
    const d3aFanId = d3aResp.body && d3aResp.body.fan_id;
    const d3bFanId = d3bResp.body && d3bResp.body.fan_id;
    assert(
      Boolean(d3aFanId) && Boolean(d3bFanId) && d3aFanId !== d3bFanId,
      'D3: precomposed and decomposed "café" create DIFFERENT fan records — Unicode normalization gap'
    );

  } finally {

    // ── SUMMARY ──────────────────────────────────────────────────────────────
    const cleanRejects   = results.filter(r => r.actual === CLEAN_REJECT).map(r => r.label);
    const hardGaps       = results.filter(r => r.actual === HARD_GAP).map(r => r.label);
    const silentDegrades = results.filter(r => r.actual === SILENT_DEGRADE).map(r => r.label);
    const unknowns       = results.filter(r =>
      r.actual !== CLEAN_REJECT && r.actual !== HARD_GAP && r.actual !== SILENT_DEGRADE
    ).map(r => r.label);

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('FUZZ PROBE SUMMARY — POST /v1/resolve');
    console.log('══════════════════════════════════════════════════════════════');
    console.log(`CLEAN REJECT:       [${cleanRejects.join(', ')}]`);
    console.log(`HARD GAP:           [${hardGaps.join(', ')}]  ← fix targets`);
    console.log(`SILENT DEGRADATION: [${silentDegrades.join(', ')}]  ← malformed identifiers field accepted without error`);
    if (unknowns.length) {
      console.log(`UNKNOWN:            [${unknowns.join(', ')}]  ← unexpected status codes`);
    }
    console.log('');
    console.log('NOTES:');
    console.log('  A4 (identifiers.email = 42): 200 in this test (no email-having candidates —');
    console.log('    gate check candidate.email != null fails for all nba_id-only fans).');
    console.log('    LATENT HARD GAP: if email candidates existed, levenshteinDistance(42, b)');
    console.log('    throws TypeError (dp[undefined][n]) → NormalizationError → ROLLBACK + 500.');
    console.log('');
    console.log('  A5 (identifiers.name = {nested:1}): original prediction was HARD GAP 500.');
    console.log('    REFUTED by Step 0 trace. Eligibility gate fails (0 strong, ≤1 weak);');
    console.log('    scoreMatch never called; PATH B → 200. The .trim()-on-object throw path');
    console.log('    only fires if another strong signal (email, guardian_email, name+dob)');
    console.log('    is also present in inbound — A5 provides none.');
    console.log('');
    console.log('  D1 (SQL injection): system correctly neutralizes via parameterized queries.');
    console.log('    The adversarial string is stored as-is in identifier_link (nba_id type,');
    console.log('    no format validation). SILENT DEGRADATION = finding, not a security hole.');
    console.log('');
    console.log('  D3 (Unicode gap): two fan records created for logically identical café.');
    console.log('    Fix path: NFC normalization in normalizeIdentifier for name/email types.');
    console.log('══════════════════════════════════════════════════════════════\n');

    // ── CLEANUP ───────────────────────────────────────────────────────────────
    countClient.release();
    if (server) server.close();

    console.log('Cleaning up test data...');
    const c = await pool.connect();
    try {
      await c.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);
      await c.query(`DELETE FROM staging_household_data WHERE org_id = $1`, [testOrgId]);
      await c.query(`DELETE FROM merge_history          WHERE org_id = $1`, [testOrgId]);
      // audit_log is append-only (enforce_audit_log_append_only trigger, migration_003).
      // DELETE throws even when 0 rows match. Skip it — rows are inert orphans.
      // audit_log.fan_id has no RESTRICT FK to fan so fan deletion below succeeds.
      try { await c.query(`DELETE FROM audit_log WHERE org_id = $1`, [testOrgId]); } catch { /* append-only — expected */ }
      await c.query(`DELETE FROM conflict_queue         WHERE org_id = $1`, [testOrgId]);
      await c.query(`DELETE FROM identifier_link        WHERE org_id = $1`, [testOrgId]);
      await c.query(`DELETE FROM fan                    WHERE org_id = $1`, [testOrgId]);
      await c.query(`DELETE FROM org                    WHERE id     = $1`, [testOrgId]);
      console.log('Cleanup complete.\n');
    } catch (cleanupErr) {
      console.error('Cleanup error — rows may remain:', cleanupErr.message);
      console.error(`  Manual cleanup: psql $DATABASE_URL -c "DELETE FROM identifier_link WHERE org_id = '${testOrgId}'; DELETE FROM fan WHERE org_id = '${testOrgId}'; DELETE FROM org WHERE id = '${testOrgId}';"`);
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
