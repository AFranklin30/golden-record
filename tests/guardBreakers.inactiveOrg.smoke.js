'use strict';
// tests/guardBreakers.inactiveOrg.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/guardBreakers.inactiveOrg.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to local Postgres (localhost:5432)
//   migration_001 run (org, fan, identifier_link, audit_log, ingest_failures)
//   migration_004 run (conflict_queue)
//   FIRESTORE_PROJECT_ID in .env (resolverEngine inits Firestore at module load;
//     the call fails locally with PERMISSION_DENIED — non-fatal, same as all
//     other smoke tests that exercise the resolve path)
//
// Why NOT require('../index.js'):
//   index.js calls app.listen() at import time and binds to a live port.
//   Instead this test builds a minimal Express app with the same protectedRouter
//   middleware order as index.js. No changes to application startup code needed.
//
// Proves:
//   orgAuthMiddleware's inactive-org guard fires BEFORE any downstream code runs.
//   This guard runs ahead of every route in the system — the largest blast radius
//   of any single guard. The test exercises the FULL production middleware stack
//   via HTTP because the guard lives in MIDDLEWARE, not in any route handler.
//
//   Mini-app middleware order matches index.js protectedRouter exactly:
//     orgAuthMiddleware → rlsContextMiddleware → correlationIdMiddleware → resolveRouter
//
//   Three-case coverage:
//     Test 1 — recognized key + inactive org  → 403 (6 assertions)
//     Test 2 — recognized key + active org    → 200 + fan row created (2 assertions)
//     Test 3 — unrecognized key               → 401 (2 assertions)
//
//   Test 1 vs Test 3 distinction: a 403 proves the key WAS recognized (matching
//   org_api_key_hash found) AND the inactive guard specifically fired.
//   A 401 here would mean the credential never matched — testing nothing useful.
//
// Cleanup note:
//   audit_log has an enforce_audit_log_append_only trigger (migration_003).
//   DELETE on audit_log throws even where 0 rows match. The cleanup block is
//   wrapped in try/catch per the established pattern in resolverEngine.smoke.js.
//   If cleanup fails, rows remain and a manual cleanup query is printed.
//   Seed uses ON CONFLICT DO UPDATE so the test is re-runnable even when the
//   previous teardown left orphaned org rows (org_api_key_hash is UNIQUE).

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
const resolveRouter           = require('../src/routes/resolve');

const INACTIVE_KEY = 'test-key-inactive-org';
const ACTIVE_KEY   = 'test-key-active-org';
const WRONG_KEY    = 'test-key-matches-no-org';  // deliberately not seeded in DB

const inactiveHash = crypto.createHash('sha256').update(INACTIVE_KEY).digest('hex');
const activeHash   = crypto.createHash('sha256').update(ACTIVE_KEY).digest('hex');

let server;
let inactiveOrgId;
let activeOrgId;
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

function post(authHeader, body) {
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
          'Authorization':  authHeader
        }
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

async function setup() {
  // ON CONFLICT DO UPDATE: idempotent seed even if a prior cleanup left org rows.
  // org_api_key_hash is UNIQUE (migration_001 line 64) — conflict target is valid.
  const inactiveResult = await pool.query(
    `INSERT INTO org (name, is_active, org_api_key_hash)
     VALUES ('Inactive Test Org', false, $1)
     ON CONFLICT (org_api_key_hash) DO UPDATE
       SET name = EXCLUDED.name, is_active = EXCLUDED.is_active
     RETURNING id`,
    [inactiveHash]
  );
  inactiveOrgId = inactiveResult.rows[0].id;

  const activeResult = await pool.query(
    `INSERT INTO org (name, is_active, org_api_key_hash)
     VALUES ('Active Test Org', true, $1)
     ON CONFLICT (org_api_key_hash) DO UPDATE
       SET name = EXCLUDED.name, is_active = EXCLUDED.is_active
     RETURNING id`,
    [activeHash]
  );
  activeOrgId = activeResult.rows[0].id;

  // Minimal Express app — same middleware order as index.js protectedRouter.
  // rlsContextMiddleware is included: Test 2 needs resolverEngine to have req.db.
  const app = express();
  app.use(express.json());
  app.use(orgAuthMiddleware);
  app.use(rlsContextMiddleware);
  app.use(correlationIdMiddleware);
  app.use(resolveRouter);

  await new Promise((resolve) => { server = app.listen(0, resolve); });
}

async function teardown() {
  // audit_log is append-only (enforce_audit_log_append_only trigger, migration_003).
  // DELETE on audit_log raises an exception even for zero matching rows.
  // FK chain: audit_log.fan_id → fan, so fan delete also fails when audit rows exist.
  // Established pattern (resolverEngine.smoke.js): wrap all cleanup in try/catch.
  // Assertions have already been evaluated — exit code depends on passed/failed count.
  console.log('Cleaning up test data...');
  try {
    const orgs = [inactiveOrgId, activeOrgId].filter(Boolean);
    for (const orgId of orgs) {
      const c = await pool.connect();
      try {
        await c.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
        await c.query(`DELETE FROM staging_household_data WHERE org_id = $1`, [orgId]);
        await c.query(`DELETE FROM conflict_queue          WHERE org_id = $1`, [orgId]);
        await c.query(`DELETE FROM audit_log               WHERE org_id = $1`, [orgId]);
        await c.query(`DELETE FROM identifier_link         WHERE org_id = $1`, [orgId]);
        await c.query(`DELETE FROM fan                     WHERE org_id = $1`, [orgId]);
        await c.query(`DELETE FROM org                     WHERE id     = $1`, [orgId]);
      } finally {
        c.release();
      }
    }
    console.log('Cleanup complete.\n');
  } catch (cleanupErr) {
    console.error('Cleanup error — rows remain:', cleanupErr.message);
    console.error('Manual cleanup SQL (run in psql):');
    if (inactiveOrgId) {
      console.error(`  DELETE FROM identifier_link WHERE org_id = '${inactiveOrgId}';`);
      console.error(`  DELETE FROM fan             WHERE org_id = '${inactiveOrgId}';`);
      console.error(`  DELETE FROM org             WHERE id     = '${inactiveOrgId}';`);
    }
    if (activeOrgId) {
      console.error(`  -- audit_log rows for '${activeOrgId}' cannot be deleted (append-only trigger)`);
      console.error(`  DELETE FROM identifier_link WHERE org_id = '${activeOrgId}';`);
      console.error(`  DELETE FROM fan             WHERE org_id = '${activeOrgId}';`);
      console.error(`  DELETE FROM org             WHERE id     = '${activeOrgId}';`);
    }
  }
}

async function run() {
  console.log('\nguardBreakers.inactiveOrg — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  try {

    // ── TEST 1 — recognized key, inactive org → 403 ───────────────────────────
    // 403 (not 401) proves the key WAS recognized AND the inactive-org guard fired.
    // 401 here would mean the credential never matched — that would prove nothing.
    console.log('  --- test 1: inactive org ---');
    const r1 = await post(`Bearer ${INACTIVE_KEY}`, {
      identifier_type:  'email',
      identifier_value: 'inactive.test@test-synth.com',
      schema_version:   'v1',
      source_system:    'synthetic_test'
    });

    assert(r1.status === 403,
      'test 1 — inactive org → 403');
    assert(r1.body.error === 'forbidden',
      'test 1 — inactive org → error is "forbidden"');

    // Guard fires before any transaction opens — zero downstream writes for this org.
    const c1 = await pool.connect();
    try {
      await c1.query(`SELECT set_config('app.current_org_id', $1, false)`, [inactiveOrgId]);

      const fanRows = await c1.query(
        `SELECT COUNT(*) FROM fan WHERE org_id = $1`, [inactiveOrgId]
      );
      assert(parseInt(fanRows.rows[0].count, 10) === 0,
        'test 1 — zero fan rows for inactiveOrgId');

      const linkRows = await c1.query(
        `SELECT COUNT(*) FROM identifier_link WHERE org_id = $1`, [inactiveOrgId]
      );
      assert(parseInt(linkRows.rows[0].count, 10) === 0,
        'test 1 — zero identifier_link rows for inactiveOrgId');

      const cqRows = await c1.query(
        `SELECT COUNT(*) FROM conflict_queue WHERE org_id = $1`, [inactiveOrgId]
      );
      assert(parseInt(cqRows.rows[0].count, 10) === 0,
        'test 1 — zero conflict_queue rows for inactiveOrgId');

      const auditRows = await c1.query(
        `SELECT COUNT(*) FROM audit_log WHERE org_id = $1`, [inactiveOrgId]
      );
      assert(parseInt(auditRows.rows[0].count, 10) === 0,
        'test 1 — zero audit_log rows for inactiveOrgId (no audit trail for blocked request)');
    } finally {
      c1.release();
    }

    // ── TEST 2 — recognized key, active org → 200 (regression) ───────────────
    // Proves the guard correctly distinguishes active from inactive orgs —
    // not blocking indiscriminately.
    console.log('\n  --- test 2: active org ---');
    const r2 = await post(`Bearer ${ACTIVE_KEY}`, {
      identifier_type:  'email',
      identifier_value: 'active.test@test-synth.com',
      schema_version:   'v1',
      source_system:    'synthetic_test'
    });

    assert(r2.status === 200,
      'test 2 — active org → 200');

    const c2 = await pool.connect();
    try {
      await c2.query(`SELECT set_config('app.current_org_id', $1, false)`, [activeOrgId]);
      const activeFanRows = await c2.query(
        `SELECT COUNT(*) FROM fan WHERE org_id = $1`, [activeOrgId]
      );
      assert(parseInt(activeFanRows.rows[0].count, 10) === 1,
        'test 2 — exactly one fan row created for activeOrgId');
    } finally {
      c2.release();
    }

    // ── TEST 3 — unrecognized key → 401 ──────────────────────────────────────
    // Confirms the 401 vs 403 branches are distinct: 401 = key matched no org,
    // 403 = key matched but org inactive. Without this case, test 1's 403 could
    // be mistaken for a catch-all that blocks every key.
    console.log('\n  --- test 3: unrecognized key ---');
    const r3 = await post(`Bearer ${WRONG_KEY}`, {
      identifier_type:  'email',
      identifier_value: 'wrong.key@test-synth.com',
      schema_version:   'v1',
      source_system:    'synthetic_test'
    });

    assert(r3.status === 401,
      'test 3 — unrecognized key → 401');
    assert(r3.body.error === 'unauthorized',
      'test 3 — unrecognized key → error is "unauthorized"');

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
