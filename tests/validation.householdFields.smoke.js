'use strict';
// tests/validation.householdFields.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/validation.householdFields.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Verifies the typeof guard fix for non-string body fields in two household handlers:
//   Component 29 — POST /v1/household/:adult_fan_id/members  (add-child)
//   Component 31 — PUT  /v1/household/:adult_fan_id/members/:child_fan_id (update)
//
// Before the fix: truthy non-string fields (42, ["x"], {y:1}, true) passed the
//   !value short-circuit then threw TypeError on .trim() → 500.
// After the fix: typeof guard fires in the GUARD section → 400.
//
// Also locks the Component 31 line-582 path: both first_name and last_name
//   non-string → typeof guard catches before the NORMALIZATION .trim() runs.

require('dotenv').config();

// ── Safety guard — local-only ──────────────────────────────────────────────
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
    process.exit(1);
  }
}());
// ──────────────────────────────────────────────────────────────────────────

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

const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

let server;
let testOrgId, adultId, childId, householdId;
let adultToken;
let countClient;
let passed = 0, failed = 0;
let ORG_KEY;

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL  ${message}`);
    failed++;
  } else {
    console.log(`  PASS  ${message}`);
    passed++;
  }
}

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

function postMember(body) {
  return httpRequest('POST', `/v1/household/${adultId}/members`, body);
}

function putMember(body) {
  return httpRequest('PUT', `/v1/household/${adultId}/members/${childId}`, body);
}

async function countRows() {
  const fan    = await countClient.query('SELECT COUNT(*) AS n FROM fan              WHERE org_id = $1', [testOrgId]);
  const link   = await countClient.query('SELECT COUNT(*) AS n FROM identifier_link  WHERE org_id = $1', [testOrgId]);
  const member = await countClient.query('SELECT COUNT(*) AS n FROM household_member WHERE org_id = $1', [testOrgId]);
  const audit  = await countClient.query('SELECT COUNT(*) AS n FROM audit_log        WHERE org_id = $1', [testOrgId]);
  return {
    fan:    parseInt(fan.rows[0].n,    10),
    link:   parseInt(link.rows[0].n,   10),
    member: parseInt(member.rows[0].n, 10),
    audit:  parseInt(audit.rows[0].n,  10),
  };
}

function delta(before, after) {
  return (after.fan + after.link + after.member + after.audit)
       - (before.fan + before.link + before.member + before.audit);
}

// Assert a rejection: 400 status, correct error message, zero writes.
async function assertReject(label, reqFn, body, expectedError) {
  console.log(`\n${label}`);
  const before = await countRows();
  const resp   = await reqFn(body);
  const after  = await countRows();
  const d      = delta(before, after);

  assert(resp.status === 400,            `${label}: status is 400 (got ${resp.status})`);
  assert(resp.body?.error === expectedError, `${label}: error === '${expectedError}' (got '${resp.body?.error}')`);
  assert(d === 0,                        `${label}: zero writes (delta=${d})`);
}

async function run() {
  console.log('\nvalidation.householdFields — typeof guard regression test\n');
  console.log('══════════════════════════════════════════════════════════\n');

  // ── SETUP ─────────────────────────────────────────────────────────────────
  testOrgId   = crypto.randomUUID();
  adultId     = crypto.randomUUID();
  childId     = crypto.randomUUID();
  householdId = crypto.randomUUID();
  ORG_KEY     = testOrgId;

  const app = express();
  app.use(express.json());
  app.use(orgAuthMiddleware);
  app.use(rlsContextMiddleware);
  app.use(correlationIdMiddleware);
  app.use(jwtMiddleware);
  app.use(householdRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });

  await pool.query(
    `INSERT INTO org (id, name, is_active, org_api_key_hash)
     VALUES ($1, '_validation_household_fields', true, $2)`,
    [testOrgId, hashKey(ORG_KEY)]
  );
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [adultId, testOrgId]
  );
  await pool.query(
    `INSERT INTO household (id, org_id, adult_fan_id, created_by, created_at)
     VALUES ($1, $2, $3, 'fan', NOW())`,
    [householdId, testOrgId, adultId]
  );

  // Seed child fan + identifiers + active membership (required for PUT cases)
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [childId, testOrgId]
  );
  for (const [type, value] of [
    ['name',           'seed child'],
    ['dob',            '2012-06-15'],
    ['guardian_email', 'guardian@seed.com'],
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

  adultToken  = signToken({ fan_id: adultId, org_id: testOrgId }).token;
  countClient = await pool.connect();
  await countClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

  try {

    // ── GROUP A — Component 29, non-string fields → must be 400, never 500 ──
    console.log('GROUP A — Component 29 (add-child): non-string required fields');
    console.log('─────────────────────────────────────────────────────────────');

    await assertReject(
      'A1: first_name = 42 (number)',
      postMember,
      { first_name: 42, last_name: 'Smith', dob: '2010-01-01',
        guardian_email: 'a@test.com', guardian_phone: '4055559999' },
      'first_name must be a string'
    );

    await assertReject(
      'A2: last_name = ["x"] (array)',
      postMember,
      { first_name: 'Alice', last_name: ['x'], dob: '2010-01-01',
        guardian_email: 'a@test.com', guardian_phone: '4055559999' },
      'last_name must be a string'
    );

    await assertReject(
      'A3: dob = { y: 2010 } (object)',
      postMember,
      { first_name: 'Alice', last_name: 'Smith', dob: { y: 2010 },
        guardian_email: 'a@test.com', guardian_phone: '4055559999' },
      'dob must be a string'
    );

    await assertReject(
      'A4: guardian_email = 42 (number)',
      postMember,
      { first_name: 'Alice', last_name: 'Smith', dob: '2010-01-01',
        guardian_email: 42, guardian_phone: '4055559999' },
      'guardian_email must be a string'
    );

    await assertReject(
      'A5: guardian_phone = true (boolean)',
      postMember,
      { first_name: 'Alice', last_name: 'Smith', dob: '2010-01-01',
        guardian_email: 'a@test.com', guardian_phone: true },
      'guardian_phone must be a string'
    );

    // ── GROUP R — Component 29 regression ───────────────────────────────────
    console.log('\nGROUP R — Component 29 regression');
    console.log('───────────────────────────────────');

    // R1: valid child → 201, writes must happen
    console.log('\nR1: all valid string fields → 201, child created');
    {
      const before = await countRows();
      const resp   = await postMember({
        first_name: 'Alice', last_name: 'Smith', dob: '2010-05-20',
        guardian_email: 'alice.parent@test.com', guardian_phone: '4055558888',
      });
      const after = await countRows();
      const d     = delta(before, after);
      assert(resp.status === 201, `R1: status is 201 (got ${resp.status})`);
      assert(d > 0,               `R1: writes occurred (delta=${d})`);
    }

    // R2: empty string first_name → 400 via existing blank guard (not typeof guard)
    console.log('\nR2: first_name = "" (empty string) → 400 from existing blank guard');
    {
      const before = await countRows();
      const resp   = await postMember({
        first_name: '', last_name: 'Smith', dob: '2010-01-01',
        guardian_email: 'a@test.com', guardian_phone: '4055559999',
      });
      const after = await countRows();
      const d     = delta(before, after);
      assert(resp.status === 400, `R2: status is 400 (got ${resp.status})`);
      assert(d === 0,             `R2: zero writes (delta=${d})`);
    }

    // ── GROUP D — Component 31, non-string name fields ───────────────────────
    // Option A chosen: typeof guard in GUARD section rejects before any .trim().
    // Covers both the READ 4a path (one name field) and the line-582 path (both).
    console.log('\nGROUP D — Component 31 (update): non-string name fields');
    console.log('─────────────────────────────────────────────────────────');

    // D1: first_name = 42, last_name omitted → typeof guard fires → 400
    //   Previously: normalization block skipped (only-one-field), READ 4a fired
    //   42.trim() → TypeError caught by EXECUTE try/catch → 500.
    await assertReject(
      'D1: first_name = 42, last_name omitted (was 500 via READ 4a line-641)',
      putMember,
      { first_name: 42 },
      'first_name must be a string'
    );

    // D2: both first_name and last_name non-string → typeof guard fires → 400
    //   Locks the line-582 path: previously first_name.trim() inside the NORMALIZATION
    //   try/catch threw TypeError (not NormalizationError) → re-thrown → 500.
    await assertReject(
      'D2: first_name = 42, last_name = ["x"] (was 500 via line-582 .trim())',
      putMember,
      { first_name: 42, last_name: ['x'] },
      'first_name must be a string'
    );

    // D3: valid partial update → 200, name updated (name-rebuild path still works)
    console.log('\nD3: first_name = "Jane" only → 200, name updated');
    {
      const before = await countRows();
      const resp   = await putMember({ first_name: 'Jane' });
      const after  = await countRows();
      const d      = delta(before, after);
      assert(resp.status === 200, `D3: status is 200 (got ${resp.status})`);
      assert(d > 0,               `D3: writes occurred (delta=${d})`);
    }

  } finally {

    countClient.release();
    if (server) server.close();

    console.log('\nCleaning up test data...');
    const c = await pool.connect();
    try {
      await c.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);
      try { await c.query(`DELETE FROM audit_log        WHERE org_id = $1`, [testOrgId]); } catch { /* append-only */ }
      await c.query(`DELETE FROM household_member WHERE org_id = $1`, [testOrgId]);
      await c.query(`DELETE FROM household        WHERE org_id = $1`, [testOrgId]);
      await c.query(`DELETE FROM identifier_link  WHERE org_id = $1`, [testOrgId]);
      try { await c.query(`DELETE FROM fan WHERE org_id = $1`, [testOrgId]); } catch { /* audit FK */ }
      try { await c.query(`DELETE FROM org WHERE id     = $1`, [testOrgId]); } catch { /* fan FK */ }
      console.log('Cleanup complete.\n');
    } catch (cleanupErr) {
      console.error('Unexpected cleanup error:', cleanupErr.message);
    } finally {
      c.release();
    }
  }

  const total = passed + failed;
  console.log(`\n${total} checks: ${passed} passed, ${failed} failed`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test crashed:', err.message);
  console.error(err.stack);
  pool.end();
  process.exit(1);
});
