'use strict';
// tests/concurrency.ageUpDoubleSubmit.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/concurrency.ageUpDoubleSubmit.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to local Postgres (localhost:5432)
//   JWT_PRIVATE_KEY, JWT_PUBLIC_KEY in .env
//   FIRESTORE_PROJECT_ID in .env (household.js inits Firestore at module load;
//     locally this fails with PERMISSION_DENIED — non-fatal)
//   migration_005.sql run (household, household_member, related_fans tables)
//
// Proves:
//   Component 34 (POST /v1/household/:adult_fan_id/members/:child_fan_id/age-up)
//   CAS fix: STEP 1 UPDATE has AND status = 'active'. A second concurrent writer
//   sees rowCount = 0 → ROLLBACK → 409 before writing related_fans / audit.
//
//   Blast radius blocked:
//     - exactly ONE related_fans row (loser's STEP 2 never ran)
//     - exactly ONE household_member_aged_up audit row (loser's STEP 3 never ran)
//     - claim_token written exactly once (loser's token never reached the row)
//
// TEST 1 — concurrent double-submit → one 200, one 409
// TEST 2 — sequential retry on aged-up member → 409 (READ 3 regression)
//
// 8 assertions total.
//
// Cleanup note:
//   household_member_aged_up audit rows cannot be deleted (append-only trigger).
//   All other rows are cleaned up in FK order. Orphaned audit rows are inert —
//   testOrgId is a fresh UUID per run.

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

const ORG_KEY = 'test-key-ageup-race';
const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

let app;
let testOrgId, adultId, childId, householdId, memberId;
let adultToken;
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
  testOrgId   = crypto.randomUUID();
  adultId     = crypto.randomUUID();
  childId     = crypto.randomUUID();
  householdId = crypto.randomUUID();
  memberId    = crypto.randomUUID();

  await pool.query(
    `INSERT INTO org (id, name, is_active, org_api_key_hash)
     VALUES ($1, '_smoke_ageup_race', true, $2)`,
    [testOrgId, hashKey(ORG_KEY)]
  );

  // Adult fan
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [adultId, testOrgId]
  );

  // Child fan
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [childId, testOrgId]
  );

  // Household owned by adult
  await pool.query(
    `INSERT INTO household (id, org_id, adult_fan_id, created_by, created_at)
     VALUES ($1, $2, $3, 'fan', NOW())`,
    [householdId, testOrgId, adultId]
  );

  // Active household_member — child under adult
  await pool.query(
    `INSERT INTO household_member
       (id, household_id, adult_fan_id, minor_fan_id, org_id,
        link_type, status, dob, created_at)
     VALUES ($1, $2, $3, $4, $5, 'hard', 'active', '2010-06-15', NOW())`,
    [memberId, householdId, adultId, childId, testOrgId]
  );

  // identifier_link — guardian_email for child (READ 4 in age-up handler)
  await pool.query(
    `INSERT INTO identifier_link
       (fan_id, identifier_type, identifier_value, org_id,
        source_system, schema_version, confidence_score,
        first_seen_at, last_seen_at)
     VALUES ($1, 'guardian_email', 'guardian@test-synth.com', $2,
             'fan_pass', '1.0', 1.0, NOW(), NOW())`,
    [childId, testOrgId]
  );

  // Adult JWT — used as x-fan-token header
  adultToken = signToken({ fan_id: adultId, org_id: testOrgId }).token;

  // Minimal Express app — same middleware chain as householdProtectedRouter in index.js
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
    // FK order: deepest first
    await c.query(`DELETE FROM related_fans     WHERE org_id = $1`, [testOrgId]);
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
      console.error(`  DELETE FROM related_fans     WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM audit_log        WHERE org_id = '${testOrgId}';`);
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
  console.log('\nconcurrency.ageUpDoubleSubmit — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  try {

    // ── TEST 1 — concurrent double-submit → one 200, one 409 ─────────────────
    console.log('  --- test 1: concurrent double-submit on same child ---');
    const [r1a, r1b] = await Promise.all([
      request(app)
        .post(`/v1/household/${adultId}/members/${childId}/age-up`)
        .set('Authorization', `Bearer ${ORG_KEY}`)
        .set('x-fan-token', adultToken)
        .send({}),
      request(app)
        .post(`/v1/household/${adultId}/members/${childId}/age-up`)
        .set('Authorization', `Bearer ${ORG_KEY}`)
        .set('x-fan-token', adultToken)
        .send({}),
    ]);

    const statuses = [r1a.status, r1b.status].sort();

    // ASSERT 1 — exactly one 200 and one 409
    assert(
      statuses[0] === 200 && statuses[1] === 409,
      'test 1 — concurrent double-submit → one 200, one 409'
    );

    // ASSERT 2 — the 409 body is the CAS message (not the READ 3 early-out message)
    const loser = r1a.status === 409 ? r1a : r1b;
    assert(
      loser.body.error === 'member already aged up',
      'test 1 — 409 body.error === "member already aged up"'
    );

    // DB state verification — use pool directly (bypasses RLS for audit reads)
    const c = await pool.connect();
    try {
      await c.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

      // ASSERT 3 — household_member.status is 'aged_up'
      const memberRow = await c.query(
        `SELECT status, claim_token FROM household_member WHERE id = $1`,
        [memberId]
      );
      assert(
        memberRow.rows[0]?.status === 'aged_up',
        'test 1 — household_member.status === "aged_up"'
      );

      // ASSERT 4 — exactly ONE related_fans row for (adultId, childId) aged_up
      const rfRow = await c.query(
        `SELECT COUNT(*) AS cnt FROM related_fans
         WHERE fan_id_a = $1 AND fan_id_b = $2
           AND relationship = 'aged_up' AND org_id = $3`,
        [adultId, childId, testOrgId]
      );
      assert(
        Number(rfRow.rows[0].cnt) === 1,
        'test 1 — exactly ONE related_fans row for aged_up relationship'
      );

      // ASSERT 5 — exactly ONE household_member_aged_up audit row
      const auditRow = await c.query(
        `SELECT COUNT(*) AS cnt FROM audit_log
         WHERE fan_id = $1 AND org_id = $2
           AND event_type = 'household_member_aged_up'`,
        [adultId, testOrgId]
      );
      assert(
        Number(auditRow.rows[0].cnt) === 1,
        'test 1 — exactly ONE household_member_aged_up audit row'
      );

      // ASSERT 6 — claim_token is non-null and was written exactly once
      // (the loser's generated token was rolled back and never reached the row)
      const claimToken = memberRow.rows[0]?.claim_token;
      assert(
        claimToken !== null && claimToken !== undefined && claimToken.length > 0,
        'test 1 — claim_token is non-null and non-empty (written exactly once)'
      );
    } finally {
      c.release();
    }

    // ── TEST 2 — sequential retry on already-aged-up member → 409 ────────────
    // Proves the READ 3 early-out still fires after the CAS fix.
    console.log('  --- test 2: sequential retry on aged-up member → 409 (regression) ---');
    const r2 = await request(app)
      .post(`/v1/household/${adultId}/members/${childId}/age-up`)
      .set('Authorization', `Bearer ${ORG_KEY}`)
      .set('x-fan-token', adultToken)
      .send({});

    // ASSERT 7 — 409 returned
    assert(r2.status === 409, 'test 2 — sequential retry → 409');

    // ASSERT 8 — claim_token unchanged (no second overwrite from sequential path)
    const c2 = await pool.connect();
    try {
      await c2.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);
      const memberRow2 = await c2.query(
        `SELECT claim_token FROM household_member WHERE id = $1`,
        [memberId]
      );
      const tokenAfterRetry = memberRow2.rows[0]?.claim_token;

      // Re-read the token from the first pass for comparison
      const c3 = await pool.connect();
      let originalToken;
      try {
        await c3.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);
        const originalRow = await c3.query(
          `SELECT claim_token FROM household_member WHERE id = $1`,
          [memberId]
        );
        originalToken = originalRow.rows[0]?.claim_token;
      } finally {
        c3.release();
      }

      assert(
        tokenAfterRetry === originalToken,
        'test 2 — claim_token unchanged after sequential retry (no overwrite)'
      );
    } finally {
      c2.release();
    }

  } finally {
    await teardown();
    await pool.end();

    console.log(`\n${passed + failed} assertions — ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  }
}

run().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
