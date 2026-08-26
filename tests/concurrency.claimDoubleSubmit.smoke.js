'use strict';
// tests/concurrency.claimDoubleSubmit.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/concurrency.claimDoubleSubmit.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to local Postgres (localhost:5432)
//   migration_001.sql run (org, fan, audit_log tables)
//   migration_005.sql run (household, household_member with
//                          claim_token and claim_token_expires_at columns)
//   FIRESTORE_PROJECT_ID in .env (household.js inits Firestore at module load;
//     locally this fails with PERMISSION_DENIED — non-fatal)
//
// Proves:
//   Two concurrent GET /v1/household/claim/:token requests with the SAME valid
//   token produce exactly one 200 (JWT issued) and one 410 (token consumed).
//   The single-use guarantee holds: claim_token IS NULL after the race, and
//   exactly one profile_claimed audit row was written.
//
//   Without the CAS fix (AND claim_token IS NOT NULL on STEP 1), both requests
//   would succeed — two JWTs issued, two audit rows written.
//
// Token seeding:
//   claim_token column stores sha256(rawToken) as hex. The handler hashes the
//   incoming raw token and timing-safe compares it against stored hashes.
//   Seeding the hash (not the raw token) is required for the pre-BEGIN match
//   to find the row and reach the transaction.
//
// TEST 1 — concurrent double-submit → one 200, one 410 (5 assertions)
// TEST 2 — sequential claim after consumed token → 404/410, not 200 (2 assertions)

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
const householdRouter         = require('../src/routes/household');
const { householdClaimRouter } = householdRouter;

const ORG_KEY = 'test-key-claim-race';
const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

let server;
let testOrgId, adultId, childId, householdId;
let rawToken;
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

function get(urlPath) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req  = http.request(
      {
        hostname: 'localhost',
        port,
        path:     urlPath,
        method:   'GET',
        headers:  { 'Authorization': `Bearer ${ORG_KEY}` },
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
  const orgResult = await pool.query(
    `INSERT INTO org (name, is_active, org_api_key_hash)
     VALUES ('Claim Race Test Org', true, $1)
     ON CONFLICT (org_api_key_hash) DO UPDATE
       SET name      = EXCLUDED.name,
           is_active = EXCLUDED.is_active
     RETURNING id`,
    [hashKey(ORG_KEY)]
  );
  testOrgId = orgResult.rows[0].id;

  const adultResult = await pool.query(
    `INSERT INTO fan (org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, 'platform', 1, NOW(), NOW())
     RETURNING id`,
    [testOrgId]
  );
  adultId = adultResult.rows[0].id;

  const childResult = await pool.query(
    `INSERT INTO fan (org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, 'platform', 1, NOW(), NOW())
     RETURNING id`,
    [testOrgId]
  );
  childId = childResult.rows[0].id;

  const hhResult = await pool.query(
    `INSERT INTO household (org_id, adult_fan_id, created_by, created_at)
     VALUES ($1, $2, 'fan', NOW())
     RETURNING id`,
    [testOrgId, adultId]
  );
  householdId = hhResult.rows[0].id;

  rawToken = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash    = hashKey(rawToken);
  const futureExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO household_member
       (household_id, adult_fan_id, minor_fan_id, org_id,
        link_type, status, claim_token, claim_token_expires_at, dob, created_at)
     VALUES ($1, $2, $3, $4, 'hard', 'aged_up', $5, $6, '2010-06-15', NOW())`,
    [householdId, adultId, childId, testOrgId, tokenHash, futureExpiry]
  );

  // Minimal Express app matching householdPublicRouter in index.js.
  // Component 35 lives on householdClaimRouter — no jwtMiddleware.
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
  const c = await pool.connect();
  try {
    await c.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);
    // audit_log is append-only — the enforce_audit_log_append_only trigger blocks DELETE
    // even when 0 rows match (migration_003). Swallow the error and continue.
    try { await c.query(`DELETE FROM audit_log WHERE org_id = $1`, [testOrgId]); } catch (_) {}
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
  console.log('\nconcurrency.claimDoubleSubmit — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  try {

    // ── TEST 1 — two concurrent claims with the SAME token ───────────────────
    // Both requests arrive before either clears the token. Without the CAS fix
    // both would succeed. With the fix only the first writer clears the token
    // (claim_token IS NOT NULL predicate); the second sees rowCount=0 → 410.
    console.log('  --- test 1: concurrent double-submit → one 200, one 410 ---');

    const [r1a, r1b] = await Promise.all([
      get(`/v1/household/claim/${rawToken}`),
      get(`/v1/household/claim/${rawToken}`),
    ]);

    const statuses  = [r1a.status, r1b.status];
    const winner    = r1a.status === 200 ? r1a : r1b;
    const loser     = r1a.status === 200 ? r1b : r1a;

    assert(
      statuses.filter(s => s === 200).length === 1,
      'test 1 — exactly one response is 200'
    );
    // The loser returns 404 or 410 depending on race timing:
    //   410 — winner committed STEP 1 while loser was inside the transaction
    //         (CAS rowCount=0 fires)
    //   404 — winner committed before loser's READ 1, so loser's timing-safe
    //         loop finds claim_token=NULL and skips the row (no match → 404)
    // Both are correct. The critical proof is in asserts 4 and 5 below.
    assert(
      loser.status === 410 || loser.status === 404,
      `test 1 — the non-200 response is 404 or 410 (got ${loser.status})`
    );
    assert(
      typeof winner.body.token === 'string' && winner.body.token.length > 0,
      'test 1 — the 200 response includes a non-empty JWT'
    );

    // DB checks via RLS-scoped connection
    const c1 = await pool.connect();
    try {
      await c1.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

      const memberRow = await c1.query(
        `SELECT claim_token FROM household_member
         WHERE minor_fan_id = $1 AND org_id = $2`,
        [childId, testOrgId]
      );
      assert(
        memberRow.rows.length === 1 && memberRow.rows[0].claim_token === null,
        'test 1 — claim_token IS NULL after race (consumed exactly once)'
      );

      const auditRows = await c1.query(
        `SELECT COUNT(*) FROM audit_log
         WHERE org_id = $1 AND event_type = 'profile_claimed'
           AND fan_id = $2`,
        [testOrgId, childId]
      );
      assert(
        parseInt(auditRows.rows[0].count, 10) === 1,
        'test 1 — exactly ONE profile_claimed audit row (loser\'s STEP 3 was blocked)'
      );
    } finally {
      c1.release();
    }

    // ── TEST 2 — sequential claim after token consumed (regression) ──────────
    // Token was cleared to NULL. The pre-BEGIN timing-safe loop finds no row
    // with a non-null claim_token matching the hash → 404.
    // (Could also be 410 if the handler reaches expiry first — but with claim_token
    // NULL the loop finds no match and returns 404 before the expiry check.)
    console.log('\n  --- test 2: sequential claim after consumed token ---');

    const r2 = await get(`/v1/household/claim/${rawToken}`);

    assert(
      r2.status === 404 || r2.status === 410,
      `test 2 — consumed token returns 404 or 410, not 200 (got ${r2.status})`
    );

    const c2 = await pool.connect();
    try {
      await c2.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

      const auditRows2 = await c2.query(
        `SELECT COUNT(*) FROM audit_log
         WHERE org_id = $1 AND event_type = 'profile_claimed'
           AND fan_id = $2`,
        [testOrgId, childId]
      );
      assert(
        parseInt(auditRows2.rows[0].count, 10) === 1,
        'test 2 — still exactly ONE profile_claimed audit row (sequential retry wrote nothing)'
      );
    } finally {
      c2.release();
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
