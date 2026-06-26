'use strict';
// tests/guardBreakers.expiredClaimToken.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/guardBreakers.expiredClaimToken.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to local Postgres (localhost:5432)
//   migration_001.sql run (org, fan, audit_log tables)
//   migration_005.sql run (household, household_member with
//                          claim_token and claim_token_expires_at columns)
//   FIRESTORE_PROJECT_ID in .env (household.js inits Firestore at module load;
//     locally this fails with PERMISSION_DENIED — non-fatal, same pattern as
//     all other smoke tests that require household.js)
//
// Why NOT require('../index.js'):
//   index.js calls app.listen() at import time and binds to a live port.
//   This test builds a minimal Express app with the same householdPublicRouter
//   middleware chain as index.js (lines 100-105). No changes to app startup.
//
// Proves:
//   GET /v1/household/claim/:token returns 410 for a token whose hash IS stored
//   in the database but whose claim_token_expires_at is in the past — NOT 404.
//
//   410 = token existed but is no longer usable (expired).
//   404 = token was never valid or matches no row.
//
//   The distinction matters: a caller receiving 404 would not know whether
//   their token was invalid or simply expired. 410 is the correct semantic
//   for "resource existed, is now gone" per RFC 9110.
//
// Claim endpoint token flow (confirmed from src/routes/household.js:1081–1116):
//   1. sha256(raw_token) → incoming_hash as hex string
//   2. SELECT all aged_up members for this org
//   3. timingSafeEqual(Buffer.from(row.claim_token, 'hex'), incoming_buf)
//   4. No match → 404 'claim token not found'
//   5. Match + expired → 410 'claim token has expired'
//      (returns before BEGIN TRANSACTION — no audit write, no token clear)
//   6. Match + valid → clear token, write audit_log, issue JWT → 200
//
// Critical: claim_token stores sha256(rawToken) as hex. The test seeds the
// sha256 hash so the timing-safe compare finds the row and the 410 branch is
// reachable. An unmatched hash never reaches the expiry check — returns 404.
//
// Three-case coverage:
//   Test 1 — expired token (matching hash, past expiry)  → 410 (4 assertions)
//   Test 2 — unknown token (no matching hash)             → 404 (2 assertions)
//   Test 3 — valid unexpired token                        → 200 (3 assertions)
//
// Cleanup note:
//   Test 3 writes one audit_log row (event_type='profile_claimed').
//   audit_log has an enforce_audit_log_append_only trigger (migration_003).
//   DELETE on audit_log throws even where 0 rows match. Cleanup is wrapped
//   in try/catch per the established pattern in inactiveOrg.smoke.js.
//   If cleanup fails, rows remain and manual cleanup SQL is printed.
//   Org seed uses ON CONFLICT DO UPDATE so the test is re-runnable even when
//   a prior teardown left orphaned rows (org_api_key_hash is UNIQUE).

require('dotenv').config();

// ── Safety guard — must run before pool or any route module is loaded ─────────
// This test must NEVER run against Cloud SQL. Local Postgres uses port 5432.
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
const householdRouter         = require('../src/routes/household');
const { householdClaimRouter } = householdRouter;

const ORG_KEY = 'test-key-expired-claim';
const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

let server;
let testOrgId, adultId, childId, childId2, householdId, memberId2;
let rawToken1, rawToken2;
let passed = 0, failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL  ${message}`);
    failed++;
  } else {
    console.log(`  PASS  ${message}`);
    passed++;
  }
}

// GET helper — token passed in URL path, org key in Authorization header
function get(urlPath) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req  = http.request(
      {
        hostname: 'localhost',
        port,
        path:     urlPath,
        method:   'GET',
        headers: {
          'Authorization': `Bearer ${ORG_KEY}`,
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
    req.end();
  });
}

async function setup() {
  // Seed org — ON CONFLICT DO UPDATE: idempotent if a prior cleanup left the row.
  // org_api_key_hash is UNIQUE (migration_001) — valid conflict target.
  const orgResult = await pool.query(
    `INSERT INTO org (name, is_active, org_api_key_hash)
     VALUES ('Expired Claim Token Test Org', true, $1)
     ON CONFLICT (org_api_key_hash) DO UPDATE
       SET name      = EXCLUDED.name,
           is_active = EXCLUDED.is_active
     RETURNING id`,
    [hashKey(ORG_KEY)]
  );
  testOrgId = orgResult.rows[0].id;

  // Seed adult fan
  const adultResult = await pool.query(
    `INSERT INTO fan (org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, 'platform', 1, NOW(), NOW())
     RETURNING id`,
    [testOrgId]
  );
  adultId = adultResult.rows[0].id;

  // Seed child fan 1 — for expired token test (Test 1)
  const child1Result = await pool.query(
    `INSERT INTO fan (org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, 'platform', 1, NOW(), NOW())
     RETURNING id`,
    [testOrgId]
  );
  childId = child1Result.rows[0].id;

  // Seed child fan 2 — for valid token test (Test 3)
  const child2Result = await pool.query(
    `INSERT INTO fan (org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, 'platform', 1, NOW(), NOW())
     RETURNING id`,
    [testOrgId]
  );
  childId2 = child2Result.rows[0].id;

  // Seed household — one per adult per org (UNIQUE index on adult_fan_id, org_id)
  const hhResult = await pool.query(
    `INSERT INTO household (org_id, adult_fan_id, created_by, created_at)
     VALUES ($1, $2, 'fan', NOW())
     RETURNING id`,
    [testOrgId, adultId]
  );
  householdId = hhResult.rows[0].id;

  // Expired token — Test 1
  // claim_token column stores sha256(rawToken) as hex, NOT the raw token.
  // The claim endpoint hashes the incoming raw token and timing-safe compares
  // it against stored hashes. Seeding the hash ensures the compare finds this
  // row and the expiry check (and 410 branch) is reachable.
  rawToken1 = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash1   = hashKey(rawToken1);
  const pastExpiry   = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago

  await pool.query(
    `INSERT INTO household_member
       (household_id, adult_fan_id, minor_fan_id, org_id,
        link_type, status, claim_token, claim_token_expires_at, dob, created_at)
     VALUES ($1, $2, $3, $4, 'hard', 'aged_up', $5, $6, '2010-06-15', NOW())`,
    [householdId, adultId, childId, testOrgId, tokenHash1, pastExpiry]
  );

  // Valid token — Test 3
  rawToken2 = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash2   = hashKey(rawToken2);
  const futureExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days ahead

  const member2Result = await pool.query(
    `INSERT INTO household_member
       (household_id, adult_fan_id, minor_fan_id, org_id,
        link_type, status, claim_token, claim_token_expires_at, dob, created_at)
     VALUES ($1, $2, $3, $4, 'hard', 'aged_up', $5, $6, '2012-03-20', NOW())
     RETURNING id`,
    [householdId, adultId, childId2, testOrgId, tokenHash2, futureExpiry]
  );
  memberId2 = member2Result.rows[0].id;

  // Build minimal Express app matching householdPublicRouter in index.js.
  // No rate limiter needed — smoke test sends a handful of requests.
  // Middleware order confirmed from index.js lines 100-105:
  //   orgAuthMiddleware → rlsContextMiddleware → correlationIdMiddleware → householdClaimRouter
  const app = express();
  app.use(express.json());
  app.use(orgAuthMiddleware);
  app.use(rlsContextMiddleware);
  app.use(correlationIdMiddleware);
  app.use(householdClaimRouter);

  await new Promise((resolve) => { server = app.listen(0, resolve); });
}

async function teardown() {
  console.log('Cleaning up test data...');
  // FK delete order: audit_log → household_member → household → fan → org
  // audit_log may be blocked by enforce_audit_log_append_only trigger
  // (migration_003). Test 3 writes one profile_claimed row. If the trigger
  // is present, the DELETE throws and the catch block prints manual SQL.
  const c = await pool.connect();
  try {
    await c.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);
    await c.query(`DELETE FROM audit_log        WHERE org_id = $1`, [testOrgId]);
    await c.query(`DELETE FROM household_member WHERE org_id = $1`, [testOrgId]);
    await c.query(`DELETE FROM household        WHERE org_id = $1`, [testOrgId]);
    await c.query(`DELETE FROM fan              WHERE org_id = $1`, [testOrgId]);
    await c.query(`DELETE FROM org              WHERE id     = $1`, [testOrgId]);
    console.log('Cleanup complete.\n');
  } catch (cleanupErr) {
    console.error('Cleanup error — rows remain:', cleanupErr.message);
    console.error('Manual cleanup SQL (run in psql):');
    if (testOrgId) {
      console.error(`  DELETE FROM household_member WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM household        WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM fan              WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM org              WHERE id     = '${testOrgId}';`);
      console.error(`  -- audit_log rows cannot be deleted if append-only trigger is active`);
    }
  } finally {
    c.release();
  }
}

async function run() {
  console.log('\nguardBreakers.expiredClaimToken — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  try {

    // ── TEST 1 — expired token → 410 ─────────────────────────────────────────
    // The stored claim_token hash matches rawToken1. The expiry is 1 day in
    // the past. The endpoint must return 410, not 404.
    //
    // 410 = "I found this token but it is no longer usable."
    // 404 = "I have no record of this token." (wrong — the row exists)
    //
    // The endpoint exits before BEGIN TRANSACTION on 410:
    //   — claim_token is NOT cleared (assertion 3)
    //   — no audit_log row is written (assertion 4)
    console.log('  --- test 1: expired token → 410 ---');
    const r1 = await get(`/v1/household/claim/${rawToken1}`);

    assert(r1.status === 410,
      'test 1 — expired token → 410');
    assert(r1.body.error === 'claim token has expired',
      'test 1 — body.error is "claim token has expired"');

    // DB check: claim_token must still be set — 410 must NOT consume the token.
    // Uses pool.connect + set_config for RLS context (same pattern as inactiveOrg).
    const c1 = await pool.connect();
    try {
      await c1.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

      const memberRow = await c1.query(
        `SELECT claim_token FROM household_member
         WHERE minor_fan_id = $1 AND org_id = $2`,
        [childId, testOrgId]
      );
      assert(
        memberRow.rows.length === 1 && memberRow.rows[0].claim_token !== null,
        'test 1 — claim_token still set after 410 (not consumed on expiry rejection)'
      );

      const auditRows = await c1.query(
        `SELECT COUNT(*) FROM audit_log
         WHERE org_id = $1 AND event_type = 'profile_claimed'`,
        [testOrgId]
      );
      assert(
        parseInt(auditRows.rows[0].count, 10) === 0,
        'test 1 — zero profile_claimed audit rows (410 exits before transaction)'
      );
    } finally {
      c1.release();
    }

    // ── TEST 2 — unknown token → 404 (contrast) ──────────────────────────────
    // A token whose sha256 hash matches no stored row must return 404.
    // This proves the two rejection paths are distinct:
    //   404 = hash matched nothing
    //   410 = hash matched a row but expiry passed
    console.log('\n  --- test 2: unknown token → 404 ---');
    const unknownToken = crypto.randomUUID();
    const r2 = await get(`/v1/household/claim/${unknownToken}`);

    assert(r2.status === 404,
      'test 2 — unknown token → 404');
    assert(r2.body.error === 'claim token not found',
      'test 2 — body.error is "claim token not found"');

    // ── TEST 3 — valid unexpired token → 200 (regression) ────────────────────
    // rawToken2 has a 30-day future expiry. The endpoint must clear the token
    // (single-use) and return a JWT. Proves the 410 guard does not over-block.
    console.log('\n  --- test 3: valid token → 200 ---');
    const r3 = await get(`/v1/household/claim/${rawToken2}`);

    assert(r3.status === 200,
      'test 3 — valid unexpired token → 200');
    assert(typeof r3.body.token === 'string' && r3.body.token.length > 0,
      'test 3 — response includes a non-empty JWT token');

    // DB check: claim_token must be NULL after success — single-use enforcement.
    const c3 = await pool.connect();
    try {
      await c3.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

      const member2Row = await c3.query(
        `SELECT claim_token FROM household_member WHERE id = $1`,
        [memberId2]
      );
      assert(
        member2Row.rows.length === 1 && member2Row.rows[0].claim_token === null,
        'test 3 — claim_token is NULL after successful claim (single-use cleared)'
      );
    } finally {
      c3.release();
    }

  } finally {
    await teardown();
    if (server) server.close();
    await pool.end();
  }

  const total = passed + failed;
  console.log(`\n${total} checks: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Smoke test crashed:', err.message);
  process.exit(1);
});
