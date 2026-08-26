'use strict';
// tests/guardBreakers.circularHousehold.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/guardBreakers.circularHousehold.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to local Postgres (localhost:5432)
//   migration_005.sql run (household, household_member tables,
//                          prevent_circular_household trigger)
//   migration_006.sql run (RLS on household, household_member)
//
// Proves:
//   The prevent_circular_household BEFORE INSERT trigger on household_member
//   fires and rejects any INSERT that would create a cycle where fan A is
//   fan B's guardian AND fan B is fan A's guardian. The trigger is enforced
//   by Postgres itself — it cannot be bypassed by application code that forgets
//   to check.
//
// Trigger confirmed from migrations/migration_005.sql:
//   Name:      prevent_circular_household
//   Function:  check_no_circular_household()
//   Fires:     BEFORE INSERT ON household_member, FOR EACH ROW
//   Condition: EXISTS (
//     SELECT 1 FROM household h
//     JOIN household_member hm ON hm.household_id = h.id
//     WHERE h.adult_fan_id = NEW.minor_fan_id
//       AND hm.minor_fan_id = NEW.adult_fan_id
//       AND hm.status = 'active'
//   )
//   Exception: RAISE EXCEPTION
//     'circular household relationship not permitted — fan % is already a minor under fan %',
//     NEW.adult_fan_id, NEW.minor_fan_id
//   SQLSTATE: P0001 (pg default for RAISE EXCEPTION without explicit code)
//
// Test operates at the DATABASE level — direct pool inserts, no Express app,
// no supertest. Connection uses the postgres superuser which bypasses RLS,
// so the trigger's internal SELECT sees all rows correctly regardless of
// app.current_org_id. The trigger fires on INSERT (not affected by RLS).
//
// 6 assertions across 3 tests.

require('dotenv').config();

// ── Safety guard — must run before pool is loaded ─────────────────────────────
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

const crypto = require('crypto');
const pool   = require('../src/db/pool');

let passed = 0;
let failed = 0;

// IDs generated in setup() — referenced across tests and teardown
let testOrgId, fanA, fanB, householdA, householdB;

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
  fanA       = crypto.randomUUID();
  fanB       = crypto.randomUUID();
  householdA = crypto.randomUUID();
  householdB = crypto.randomUUID();

  const orgKeyHash = crypto.createHash('sha256')
    .update(`smoke-circular-${testOrgId}`)
    .digest('hex');

  await pool.query(
    `INSERT INTO org (id, name, is_active, org_api_key_hash)
     VALUES ($1, 'Circular Household Smoke Org', true, $2)`,
    [testOrgId, orgKeyHash]
  );

  // Two fan rows in one statement — $3 = testOrgId shared by both
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $3, 'platform', 1, NOW(), NOW()),
            ($2, $3, 'platform', 1, NOW(), NOW())`,
    [fanA, fanB, testOrgId]
  );

  // household A (adult = fanA), household B (adult = fanB)
  await pool.query(
    `INSERT INTO household (id, org_id, adult_fan_id, created_by, created_at)
     VALUES ($1, $3, $4, 'fan', NOW()),
            ($2, $3, $5, 'fan', NOW())`,
    [householdA, householdB, testOrgId, fanA, fanB]
  );
}

async function teardown() {
  // FK order: household_member → household → fan → org
  // No audit_log rows created (bypassing app code) — append-only trigger not an issue.
  console.log('Cleaning up test data...');
  try {
    await pool.query(`DELETE FROM household_member WHERE org_id = $1`, [testOrgId]);
    await pool.query(`DELETE FROM household        WHERE org_id = $1`, [testOrgId]);
    await pool.query(`DELETE FROM fan              WHERE org_id = $1`, [testOrgId]);
    await pool.query(`DELETE FROM org              WHERE id     = $1`, [testOrgId]);
    console.log('Cleanup complete.\n');
  } catch (cleanupErr) {
    console.error('Cleanup error — rows remain:', cleanupErr.message);
    console.error('Manual cleanup SQL (run in psql):');
    console.error(`  DELETE FROM household_member WHERE org_id = '${testOrgId}';`);
    console.error(`  DELETE FROM household        WHERE org_id = '${testOrgId}';`);
    console.error(`  DELETE FROM fan              WHERE org_id = '${testOrgId}';`);
    console.error(`  DELETE FROM org              WHERE id     = '${testOrgId}';`);
  }
}

async function run() {
  console.log('\nguardBreakers.circularHousehold — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  try {

    // ── TEST 1 — establish fanA is fanB's guardian (should succeed) ───────────
    // A normal, valid household relationship. The trigger has nothing to block:
    // no reverse link exists yet when this INSERT fires.
    console.log('  --- test 1: fanA is fanB\'s guardian (valid) ---');

    let test1Succeeded = false;
    try {
      await pool.query(
        `INSERT INTO household_member
           (household_id, adult_fan_id, minor_fan_id,
            org_id, link_type, status, dob)
         VALUES ($1, $2, $3, $4, 'hard', 'active', '2015-06-10')`,
        [householdA, fanA, fanB, testOrgId]
      );
      test1Succeeded = true;
    } catch (err) {
      console.error(`  UNEXPECTED ERROR in test 1: ${err.message}`);
    }

    // ASSERT 1
    assert(test1Succeeded,
      'test 1 — INSERT (fanA adult, fanB minor) SUCCEEDS — valid relationship');

    // ── TEST 2 — attempt cycle: fanB is also fanA's guardian → trigger fires ──
    // After Test 1 committed, the trigger's SELECT finds:
    //   household where adult_fan_id = fanA  (= NEW.minor_fan_id)
    //   household_member where minor_fan_id = fanB (= NEW.adult_fan_id), status = 'active'
    // Cycle detected → RAISE EXCEPTION → INSERT rejected.
    console.log('\n  --- test 2: fanB is fanA\'s guardian → trigger fires ---');

    let triggerFired = false;
    let triggerError = null;
    try {
      await pool.query(
        `INSERT INTO household_member
           (household_id, adult_fan_id, minor_fan_id,
            org_id, link_type, status, dob)
         VALUES ($1, $2, $3, $4, 'hard', 'active', '2010-03-15')`,
        [householdB, fanB, fanA, testOrgId]
      );
      // Reaching here means the trigger did NOT fire — ASSERT 2 will fail below
    } catch (err) {
      triggerFired = true;
      triggerError = err;
    }

    // ASSERT 2 — INSERT was rejected
    assert(triggerFired,
      'test 2 — INSERT (fanB adult, fanA minor) is REJECTED by the database trigger');

    // ASSERT 3 — exception message matches the real RAISE EXCEPTION from migration_005.sql
    // ASSERT 4 — SQLSTATE is P0001 (RAISE EXCEPTION default — no explicit code in the function)
    if (triggerFired && triggerError) {
      assert(
        triggerError.message.includes('circular household relationship not permitted'),
        `test 2 — error message matches trigger RAISE EXCEPTION text` +
        `\n           got: "${triggerError.message}"`
      );
      assert(
        triggerError.code === 'P0001',
        `test 2 — SQLSTATE is P0001 (RAISE EXCEPTION without explicit code)` +
        `\n           got: "${triggerError.code}"`
      );
    }

    // ASSERT 5 — the cycle-creating row was never committed
    const cycleCheck = await pool.query(
      `SELECT COUNT(*) FROM household_member
       WHERE adult_fan_id = $1 AND minor_fan_id = $2 AND org_id = $3`,
      [fanB, fanA, testOrgId]
    );
    assert(
      parseInt(cycleCheck.rows[0].count, 10) === 0,
      'test 2 — cycle-creating row (fanB adult, fanA minor) was never committed'
    );

    // ── TEST 3 — Test 1 relationship survives the failed insert (regression) ──
    // The rejected INSERT in Test 2 must not have disturbed the committed row from Test 1.
    console.log('\n  --- test 3: Test 1 relationship intact after rejected insert ---');

    const validCheck = await pool.query(
      `SELECT COUNT(*) FROM household_member
       WHERE adult_fan_id = $1 AND minor_fan_id = $2
         AND org_id = $3 AND status = 'active'`,
      [fanA, fanB, testOrgId]
    );

    // ASSERT 6
    assert(
      parseInt(validCheck.rows[0].count, 10) === 1,
      'test 3 — household_member (fanA adult, fanB minor, status=active) still exists'
    );

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
