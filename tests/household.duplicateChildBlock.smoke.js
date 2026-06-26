'use strict';
// tests/household.duplicateChildBlock.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/household.duplicateChildBlock.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to local Postgres (localhost:5432)
//   JWT_PRIVATE_KEY, JWT_PUBLIC_KEY in .env
//   FIRESTORE_PROJECT_ID in .env (household.js inits Firestore at module load;
//     locally this fails with PERMISSION_DENIED — non-fatal, same as all other
//     smoke tests that require household.js)
//   migration_005.sql run (household, household_member tables)
//   migration_006.sql run (RLS on household, household_member)
//
// Why NOT require('../index.js'):
//   index.js calls app.listen() at import time and binds to a live port.
//   This test builds a minimal Express app with the same householdProtectedRouter
//   middleware chain as index.js (lines 89-95). No changes to application startup.
//
// Proves:
//   Component 29 (POST /v1/household/:adult_fan_id/members) READ 4 blocks a
//   second adult from adding a child (same name + dob) who already has an
//   active guardian anywhere in the same org. Returns 409.
//
//   Guard checks status = 'active' only — a severed prior relationship does NOT
//   block a new guardian relationship for the same name+dob.
//
//   A genuinely different child (different name or dob) is not blocked.
//
// Middleware chain (confirmed from index.js lines 89-95):
//   orgAuthMiddleware → rlsContextMiddleware → correlationIdMiddleware
//     → jwtMiddleware → householdRouter
//
// Auth headers:
//   Authorization: Bearer <testOrgId>   ← raw key = testOrgId UUID, unique per run
//   x-fan-token:   <adultBToken>        ← fan JWT for adultB
//
// 8 assertions across 3 tests.
//
// Cleanup note:
//   Test 2 and test 3 succeed and write audit_log rows (household_member_added).
//   audit_log has an enforce_audit_log_append_only trigger (migration_003).
//   DELETE on audit_log fails when matching rows exist. Cleanup is wrapped in
//   try/catch — if it fails, manual cleanup SQL is printed. Orphaned rows are
//   inert: testOrgId is a fresh UUID per run so they cannot affect correctness
//   of future runs.

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

const express = require('express');
const request = require('supertest');
const crypto  = require('crypto');
const pool    = require('../src/db/pool');

const orgAuthMiddleware       = require('../src/middleware/orgAuthMiddleware');
const rlsContextMiddleware    = require('../src/middleware/rlsContextMiddleware');
const correlationIdMiddleware = require('../src/middleware/correlationIdMiddleware');
const jwtMiddleware           = require('../src/middleware/jwtMiddleware');
const householdRouter         = require('../src/routes/household');
const { signToken }           = require('../src/modules/jwt');

const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

let app;
let testOrgId, adultA, adultB, householdA, householdB, childId;
let adultBToken;
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

async function setup() {
  testOrgId  = crypto.randomUUID();
  adultA     = crypto.randomUUID();
  adultB     = crypto.randomUUID();
  householdA = crypto.randomUUID();
  householdB = crypto.randomUUID();
  childId    = crypto.randomUUID();

  // Raw key = testOrgId UUID — unique per run, no collision risk.
  const orgKeyHash = hashKey(testOrgId);

  await pool.query(
    `INSERT INTO org (id, name, is_active, org_api_key_hash)
     VALUES ($1, '_smoke_dup_child_block', true, $2)`,
    [testOrgId, orgKeyHash]
  );

  // Two adult fans in one statement
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $3, 'platform', 1, NOW(), NOW()),
            ($2, $3, 'platform', 1, NOW(), NOW())`,
    [adultA, adultB, testOrgId]
  );

  // Two households
  await pool.query(
    `INSERT INTO household (id, org_id, adult_fan_id, created_by, created_at)
     VALUES ($1, $3, $4, 'fan', NOW()),
            ($2, $3, $5, 'fan', NOW())`,
    [householdA, householdB, testOrgId, adultA, adultB]
  );

  // Child fan already under adultA
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [childId, testOrgId]
  );

  // identifier_link — name for child.
  // normalizeIdentifier('name', 'Shared Child') → 'shared child'
  await pool.query(
    `INSERT INTO identifier_link
       (fan_id, identifier_type, identifier_value, org_id,
        source_system, schema_version, confidence_score,
        first_seen_at, last_seen_at)
     VALUES ($1, 'name', 'shared child', $2, 'fan_pass', '1.0', 1.0, NOW(), NOW())`,
    [childId, testOrgId]
  );

  // household_member — child is active under adultA's household
  await pool.query(
    `INSERT INTO household_member
       (id, household_id, adult_fan_id, minor_fan_id, org_id,
        link_type, status, dob, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'hard', 'active', '2015-04-01', NOW())`,
    [householdA, adultA, childId, testOrgId]
  );

  // Fan JWT for adultB — used as x-fan-token header
  adultBToken = signToken({ fan_id: adultB, org_id: testOrgId }).token;

  // Minimal Express app — same middleware order as householdProtectedRouter in index.js
  app = express();
  app.use(express.json());
  app.use(orgAuthMiddleware);
  app.use(rlsContextMiddleware);
  app.use(correlationIdMiddleware);
  app.use(jwtMiddleware);
  app.use(householdRouter);
}

async function teardown() {
  console.log('Cleaning up test data...');
  const c = await pool.connect();
  try {
    await c.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);
    await c.query(`DELETE FROM audit_log        WHERE org_id = $1`, [testOrgId]);
    await c.query(`DELETE FROM household_member WHERE org_id = $1`, [testOrgId]);
    await c.query(`DELETE FROM household        WHERE org_id = $1`, [testOrgId]);
    await c.query(`DELETE FROM identifier_link  WHERE org_id = $1`, [testOrgId]);
    await c.query(`DELETE FROM fan              WHERE org_id = $1`, [testOrgId]);
    await c.query(`DELETE FROM org              WHERE id     = $1`, [testOrgId]);
    console.log('Cleanup complete.\n');
  } catch (cleanupErr) {
    console.error('Cleanup error — rows remain:', cleanupErr.message);
    console.error('Manual cleanup SQL (run in psql):');
    if (testOrgId) {
      console.error(`  DELETE FROM household_member WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM household        WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM identifier_link  WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM fan              WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM org              WHERE id     = '${testOrgId}';`);
      console.error(`  -- audit_log rows cannot be deleted if append-only trigger is active`);
    }
  } finally {
    c.release();
  }
}

async function run() {
  console.log('\nhousehold.duplicateChildBlock — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  try {

    // ── TEST 1 — adultB adds same child (same name + dob) → 409 ──────────────
    // adultA's household already has an active member with name='shared child',
    // dob='2015-04-01'. READ 4 finds this row and returns 409 before BEGIN.
    // No new fan, no new household_member, no audit_log row.
    console.log('  --- test 1: adultB adds same child (same name+dob) → 409 ---');
    const r1 = await request(app)
      .post(`/v1/household/${adultB}/members`)
      .set('Authorization', `Bearer ${testOrgId}`)
      .set('x-fan-token', adultBToken)
      .send({
        first_name:     'Shared',
        last_name:      'Child',
        dob:            '2015-04-01',
        guardian_email: 'adultb@test-synth.com',
        guardian_phone: '4055551111',
      });

    // ASSERT 1 — 409 returned
    assert(r1.status === 409,
      'test 1 — same child, different household → 409');

    // ASSERT 2 — correct error key
    assert(r1.body.error === 'child already has a guardian',
      'test 1 — body.error is "child already has a guardian"');

    // DB verification — guard fires before BEGIN so no side effects
    const c1 = await pool.connect();
    try {
      await c1.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

      // ASSERT 3 — fan count unchanged: adultA + adultB + childId = 3
      const fanCount = await c1.query(
        `SELECT COUNT(*) FROM fan WHERE org_id = $1`, [testOrgId]
      );
      assert(
        parseInt(fanCount.rows[0].count, 10) === 3,
        'test 1 — fan count is 3 (adultA, adultB, childId only — no new fan created)'
      );

      // ASSERT 4 — no household_member rows for adultB
      const memberCount = await c1.query(
        `SELECT COUNT(*) FROM household_member
         WHERE adult_fan_id = $1 AND org_id = $2`,
        [adultB, testOrgId]
      );
      assert(
        parseInt(memberCount.rows[0].count, 10) === 0,
        'test 1 — zero household_member rows for adultB (guard fired before BEGIN)'
      );

      // ASSERT 5 — no audit_log for adultB
      const auditCount = await c1.query(
        `SELECT COUNT(*) FROM audit_log
         WHERE org_id = $1 AND event_type = 'household_member_added'
           AND fan_id = $2`,
        [testOrgId, adultB]
      );
      assert(
        parseInt(auditCount.rows[0].count, 10) === 0,
        'test 1 — zero household_member_added audit rows for adultB'
      );
    } finally {
      c1.release();
    }

    // ── TEST 2 — adultB adds a different child → 201 (regression) ────────────
    // A child with a different dob must not be blocked — guard matches on BOTH
    // name AND dob. Proves the guard is not over-broad.
    console.log('\n  --- test 2: adultB adds different child → 201 ---');
    const r2 = await request(app)
      .post(`/v1/household/${adultB}/members`)
      .set('Authorization', `Bearer ${testOrgId}`)
      .set('x-fan-token', adultBToken)
      .send({
        first_name:     'Different',
        last_name:      'Kid',
        dob:            '2016-08-08',
        guardian_email: 'adultb@test-synth.com',
        guardian_phone: '4055551111',
      });

    // ASSERT 6 — 201 returned
    assert(r2.status === 201,
      'test 2 — different child → 201');

    const c2 = await pool.connect();
    try {
      await c2.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

      // ASSERT 7 — exactly one active member under adultB now
      const memberCount2 = await c2.query(
        `SELECT COUNT(*) FROM household_member
         WHERE adult_fan_id = $1 AND org_id = $2 AND status = 'active'`,
        [adultB, testOrgId]
      );
      assert(
        parseInt(memberCount2.rows[0].count, 10) === 1,
        'test 2 — exactly one active household_member under adultB'
      );
    } finally {
      c2.release();
    }

    // ── TEST 3 — severed prior relationship, same name+dob → 201 (boundary) ──
    // Guard checks status = 'active' only. A SEVERED prior relationship must NOT
    // block a new guardian from claiming the same name+dob. This is the boundary
    // case: 'active' blocks, 'severed' does not.
    console.log('\n  --- test 3: severed prior relationship, same name+dob → 201 ---');

    // Sever adultA's active link to childId
    await pool.query(
      `UPDATE household_member SET status = 'severed'
       WHERE minor_fan_id = $1 AND adult_fan_id = $2 AND org_id = $3`,
      [childId, adultA, testOrgId]
    );

    // adultB now tries the same name+dob that was blocked in test 1.
    // The only prior household_member row for this name+dob is now severed,
    // so the guard passes and a new child fan is created under adultB.
    const r3 = await request(app)
      .post(`/v1/household/${adultB}/members`)
      .set('Authorization', `Bearer ${testOrgId}`)
      .set('x-fan-token', adultBToken)
      .send({
        first_name:     'Shared',
        last_name:      'Child',
        dob:            '2015-04-01',
        guardian_email: 'adultb@test-synth.com',
        guardian_phone: '4055551111',
      });

    // ASSERT 8 — 201 returned (severed does not block)
    assert(r3.status === 201,
      'test 3 — severed prior relationship does not block; same name+dob → 201');

  } finally {
    await teardown();
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
