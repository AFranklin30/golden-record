'use strict';
// tests/adminHousehold.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/adminHousehold.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to your local Postgres instance
//   migration_005.sql run  (staging_household_data table)
//   migration_006.sql run  (RLS on Sprint 3 tables)
//
// Proves:
//   soft_links in GET /v1/admin/household/:fan_id is read from
//   staging_household_data — NOT from household_member link_type='soft'
//   (nothing ever writes link_type='soft' to household_member).
//
//   The promoted_at IS NULL filter works: staging row 2 has promoted_at
//   set and must not appear in soft_links. Only row 1 appears.
//
//   Response shape matches the corrected spec: staging_id, child_name,
//   child_dob, source, confidence, adult_fan_id, created_at.
//   No link_type field (staging_household_data has no such column).

require('dotenv').config();

// ── Safety guard — must run before pool or any route module is loaded ─────────
// This test must NEVER run against Cloud SQL. The Cloud SQL Auth Proxy uses
// port 5433. Local Postgres uses port 5432. Any non-localhost host is rejected.
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
    console.error('  Update .env to point to localhost:5432 before running.');
    process.exit(1);
  }
}());
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const pool   = require('../src/db/pool');

// Extract the async GET handler directly from the Express router.
// admin/household.js registers exactly one route, so stack[0] is stable.
// Calling handler(req, res) directly avoids HTTP overhead and lets us
// inject req.db = the real pg client so RLS context flows through unchanged.
const adminHouseholdRouter = require('../src/routes/admin/household');
const handler = adminHouseholdRouter.stack[0].route.stack[0].handle;

if (typeof handler !== 'function') {
  console.error('BLOCKED: Could not extract handler from router.stack[0].route.stack[0].handle.');
  console.error('  Check that admin/household.js still registers exactly one GET route.');
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED — ${message}`);
  console.log(`  PASS  ${message}`);
}

function assertBetween(value, low, high, message) {
  if (value < low || value > high) {
    throw new Error(
      `ASSERT FAILED — ${message}\n` +
      `  expected between ${low} and ${high}, got ${value}`
    );
  }
  console.log(`  PASS  ${message}  (${value})`);
}

async function run() {
  const testOrgId  = crypto.randomUUID();
  const testFanId  = crypto.randomUUID();
  const stagingId1 = crypto.randomUUID();
  const stagingId2 = crypto.randomUUID();

  const orgApiKeyHash = crypto
    .createHash('sha256')
    .update(testOrgId)
    .digest('hex');

  console.log('\nadminHousehold — soft_links smoke test');
  console.log('=======================================');
  console.log(`testOrgId:  ${testOrgId}`);
  console.log(`testFanId:  ${testFanId}`);
  console.log(`stagingId1: ${stagingId1}  (unpromoted — should appear in soft_links)`);
  console.log(`stagingId2: ${stagingId2}  (promoted   — must be excluded)`);

  const client = await pool.connect();

  try {

    // ── SETUP ────────────────────────────────────────────────────────────────

    // Org inserted BEFORE RLS context is set.
    // org is the auth table — not subject to tenant isolation policy.
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash)
       VALUES ($1, '_smoke_admin_household', $2)`,
      [testOrgId, orgApiKeyHash]
    );

    // Set RLS context session-scoped (is_local = false) so it survives
    // the transactions the handler runs internally. Matches rlsContextMiddleware.
    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`,
      [testOrgId]
    );

    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [testFanId, testOrgId]
    );

    // staging row 1 — promoted_at IS NULL — must appear in soft_links
    await client.query(
      `INSERT INTO staging_household_data
         (id, adult_fan_id, org_id, child_name, child_dob,
          source, raw_data, confidence, created_at)
       VALUES ($1, $2, $3, 'Test Child One', '2010-06-01',
               'synthetic_test', '{}', 0.65, NOW())`,
      [stagingId1, testFanId, testOrgId]
    );

    // staging row 2 — promoted_at set — WHERE promoted_at IS NULL must exclude it
    // promoted_to references fan(id): testFanId is a valid target.
    await client.query(
      `INSERT INTO staging_household_data
         (id, adult_fan_id, org_id, child_name, child_dob,
          source, raw_data, confidence, promoted_at, promoted_to, created_at)
       VALUES ($1, $2, $3, 'Test Child Two', '2012-03-15',
               'synthetic_test', '{}', 0.52, NOW(), $2, NOW())`,
      [stagingId2, testFanId, testOrgId]
    );

    console.log('\nSetup complete — org, fan, 2 staging rows seeded.');

    // ── CALL ─────────────────────────────────────────────────────────────────

    // Mock req carries everything the handler reads from the request context.
    // req.db = real pg client ensures the queries hit the real database with
    // the RLS context already set on this connection.
    let capturedStatus;
    let capturedBody;

    const req = {
      params:  { fan_id: testFanId },
      context: { org_id: testOrgId, correlation_id: 'test-correlation-id' },
      db:      client,
    };
    const res = {
      status(code) { capturedStatus = code; return this; },
      json(body)   { capturedBody   = body;  return this; },
    };

    console.log('\nCalling handler directly...');
    await handler(req, res);

    console.log('\nResult.soft_links:', JSON.stringify(capturedBody.soft_links, null, 2));
    console.log('\nAssertions:');

    // ── ASSERT ───────────────────────────────────────────────────────────────

    // 1 — handler returned 200
    assert(capturedStatus === 200,
      '1. response status === 200');

    // 2 — exactly one soft_link: unpromoted row only
    //     proves the promoted_at IS NULL filter works
    assert(Array.isArray(capturedBody.soft_links) && capturedBody.soft_links.length === 1,
      '2. soft_links has exactly one entry (promoted row excluded)');

    const sl = capturedBody.soft_links[0];

    // 3 — correct staging row was returned
    assert(sl.staging_id === stagingId1,
      '3. soft_links[0].staging_id === stagingId1');

    // 4 — confidence value — pg returns NUMERIC as string, parseFloat before compare
    assertBetween(parseFloat(sl.confidence), 0.64, 0.66,
      '4. soft_links[0].confidence ≈ 0.65');

    // 5 — child_name matches seeded value
    assert(sl.child_name === 'Test Child One',
      '5. soft_links[0].child_name === "Test Child One"');

    // 6 — adult_fan_id links back to the queried fan
    assert(sl.adult_fan_id === testFanId,
      '6. soft_links[0].adult_fan_id === testFanId');

    // 7 — link_type must not appear: staging_household_data has no such column.
    //     If this field is present, the old household_member filter crept back in.
    assert(!('link_type' in sl),
      '7. soft_links[0] has no link_type field');

    // 8-10 — other response keys present and unaffected
    //        no household/membership/related_fans rows seeded, so [] is correct
    assert(Array.isArray(capturedBody.memberships),
      '8. memberships array is present');

    assert(Array.isArray(capturedBody.related_fans),
      '9. related_fans array is present');

    assert(Array.isArray(capturedBody.households),
      '10. households array is present');

    console.log('\n  All 10 assertions passed.\n');

  } finally {

    // ── CLEANUP ──────────────────────────────────────────────────────────────
    //
    // FK order:
    //   staging_household_data  — REFERENCES fan (adult_fan_id, promoted_to)
    //   fan                     — REFERENCES org (org_id)
    //   org                     — no FK dependency
    //
    // testOrgId is a fresh UUID every run — WHERE org_id = $1 is safe.
    console.log('Cleaning up test data...');
    try {
      await client.query(
        `DELETE FROM staging_household_data WHERE org_id = $1`, [testOrgId]
      );
      await client.query(
        `DELETE FROM fan                    WHERE org_id = $1`, [testOrgId]
      );
      await client.query(
        `DELETE FROM org                    WHERE id     = $1`, [testOrgId]
      );
      console.log('Cleanup complete.\n');
    } catch (cleanupErr) {
      console.error('Cleanup error — test rows may remain:', cleanupErr.message);
      console.error(
        `  Manual cleanup: DELETE FROM org WHERE id = '${testOrgId}';`
      );
    }

    client.release();
  }
}

run()
  .then(() => { pool.end(); process.exit(0); })
  .catch(err => {
    console.error('\nSMOKE TEST FAILED');
    console.error(err.message);
    pool.end();
    process.exit(1);
  });
