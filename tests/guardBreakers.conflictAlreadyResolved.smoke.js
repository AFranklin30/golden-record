'use strict';
// tests/guardBreakers.conflictAlreadyResolved.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/guardBreakers.conflictAlreadyResolved.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to local Postgres (localhost:5432)
//   migration_001.sql run (org, fan, identifier_link, audit_log)
//   migration_004.sql run (conflict_queue)
//   migration_005.sql run (merge_history)
//
// Why NOT require('../index.js'):
//   index.js calls app.listen() at import time and binds to a live port.
//   This test builds a minimal Express app with the same protectedRouter
//   middleware chain as index.js (lines 78-86). No changes to app startup.
//
// Proves:
//   POST /v1/conflicts/:id/confirm returns 409 { error: 'conflict already resolved' }
//   when the conflict_queue row has status !== 'pending' (here: 'confirmed').
//
//   This guard (conflicts.js line 120-122) fires BEFORE:
//     - the fanA deleted_at check
//     - the multi-hop merge guard
//     - BEGIN TRANSACTION
//
//   A second confirm on an already-confirmed conflict must never:
//     - re-soft-delete fan_id_b (writing a new NOW() over the existing deleted_at)
//     - write a second merge_history row (which would shadow the original for unmerge)
//     - write a conflict_confirmed audit_log row
//
//   The only safe response is 409 — no writes, no state change.
//
// Guard order in the confirm handler (confirmed from conflicts.js lines 107-159):
//   1. SELECT conflict WHERE id=$1 AND org_id=$2
//   2. rows === 0 → 404 'conflict not found'
//   3. status !== 'pending' → 409 'conflict already resolved'  ← THIS GUARD
//   4. fanA deleted_at check
//   5. multi-hop merge guard (prior merge_history as fan_id_target)
//   6. BEGIN ... COMMIT
//
// Test 1 proves the status guard (3) fires before the multi-hop guard (5).
// We do NOT seed fanA with an active merge_history row — that would only
// matter if the status guard failed to stop the request, and asserting
// 'multi-hop merge not supported' here would mask which guard actually fired.
//
// Two-case coverage:
//   Test 1 — already-confirmed conflict → 409 (6 assertions)
//   Test 2 — genuinely pending conflict confirms → 200 regression (5 assertions)

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
const conflictsRouter         = require('../src/routes/conflicts');

const ORG_KEY   = 'test-key-conflict-resolved';
const hashKey   = (k) => crypto.createHash('sha256').update(k).digest('hex');
const FIXED_PAST = '2026-06-01T00:00:00.000Z';

let server;
let testOrgId, fanA, fanB, fanC, fanD;
let conflictId, conflict2Id;
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

// POST helper — sends JSON body through the test Express server
function post(urlPath) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const body = '{}';
    const req  = http.request(
      {
        hostname: 'localhost',
        port,
        path:     urlPath,
        method:   'POST',
        headers: {
          'Authorization':  `Bearer ${ORG_KEY}`,
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
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
    req.write(body);
    req.end();
  });
}

async function setup() {
  testOrgId   = crypto.randomUUID();
  fanA        = crypto.randomUUID();
  fanB        = crypto.randomUUID();
  fanC        = crypto.randomUUID();
  fanD        = crypto.randomUUID();
  conflictId  = crypto.randomUUID();
  conflict2Id = crypto.randomUUID();

  // Org
  await pool.query(
    `INSERT INTO org (id, name, is_active, org_api_key_hash)
     VALUES ($1, 'Conflict Already Resolved Test Org', true, $2)`,
    [testOrgId, hashKey(ORG_KEY)]
  );

  // fanA — survivor, active (fan_id_a in the pre-confirmed conflict)
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [fanA, testOrgId]
  );

  // fanB — already absorbed: soft-deleted at FIXED_PAST.
  // Assertion 3 queries this timestamp and confirms it did NOT change after the
  // blocked second confirm — a new soft-delete would write NOW(), not FIXED_PAST.
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version,
                      created_at, updated_at, deleted_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW(), $3)`,
    [fanB, testOrgId, FIXED_PAST]
  );

  // conflict_queue — already confirmed (status='confirmed', reviewed_at set)
  await pool.query(
    `INSERT INTO conflict_queue
       (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched,
        status, reviewed_at)
     VALUES ($1, $2, $3, $4, 0.9, '[]', 'confirmed', $5)`,
    [conflictId, fanA, fanB, testOrgId, FIXED_PAST]
  );

  // merge_history — original confirmed merge (status='active')
  // fan_id_source=fanB (absorbed), fan_id_target=fanA (survivor)
  await pool.query(
    `INSERT INTO merge_history
       (fan_id_source, fan_id_target, org_id, conflict_id,
        merged_by, status, merged_at)
     VALUES ($1, $2, $3, $4, 'Test Org', 'active', $5)`,
    [fanB, fanA, testOrgId, conflictId, FIXED_PAST]
  );

  // fanC — fresh survivor for Test 2 regression (active, no prior merge)
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [fanC, testOrgId]
  );

  // fanD — fan to be absorbed in Test 2 regression (active)
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [fanD, testOrgId]
  );

  // identifier_link for fanD — gives the confirm handler something to move (STEP 1)
  await pool.query(
    `INSERT INTO identifier_link
       (fan_id, identifier_type, identifier_value, org_id,
        source_system, schema_version)
     VALUES ($1, 'email', 'fand@test-synth.com', $2,
             'synthetic_test', 'v1')`,
    [fanD, testOrgId]
  );

  // conflict2 — fresh pending conflict (no prior merge_history for fanC as target)
  // The multi-hop guard checks fan_id_a (fanC) as fan_id_target in merge_history.
  // No such row exists → guard is silent → confirm proceeds to 200.
  await pool.query(
    `INSERT INTO conflict_queue
       (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched,
        status)
     VALUES ($1, $2, $3, $4, 0.9, '[]', 'pending')`,
    [conflict2Id, fanC, fanD, testOrgId]
  );

  // Build minimal Express app matching protectedRouter in index.js (lines 78-86).
  // No rate limiter needed — smoke test sends a handful of requests.
  // No jwtMiddleware — conflictsRouter is on protectedRouter (not householdProtectedRouter).
  // Middleware order confirmed from index.js:
  //   orgAuthMiddleware → rlsContextMiddleware → correlationIdMiddleware → conflictsRouter
  const app = express();
  app.use(express.json());
  app.use(orgAuthMiddleware);
  app.use(rlsContextMiddleware);
  app.use(correlationIdMiddleware);
  app.use(conflictsRouter);

  await new Promise((resolve) => { server = app.listen(0, resolve); });
}

async function teardown() {
  console.log('Cleaning up test data...');
  const c = await pool.connect();
  try {
    await c.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

    // Each delete wrapped individually — one failure must not skip the rest.
    // FK delete order:
    //   merge_history (references conflict_queue + fan) must go before conflict_queue
    //   audit_log (references fan) before fan
    //   identifier_link (references fan) before fan
    //   conflict_queue (references fan) before fan
    //   fan before org
    //
    // Note: Test 2 writes one audit_log row (event_type='conflict_confirmed').
    // If migration_003 append-only trigger is active, DELETE FROM audit_log
    // throws even when rows exist. This also blocks fan and org cleanup
    // via the FK chain (audit_log.fan_id → fan.id → org.id).
    // Each delete is wrapped so partial cleanup still runs.
    // testOrgId is a fresh UUID per run — orphaned rows do not affect correctness.

    for (const [sql, params] of [
      [`DELETE FROM merge_history   WHERE org_id = $1`, [testOrgId]],
      [`DELETE FROM audit_log       WHERE org_id = $1`, [testOrgId]],
      [`DELETE FROM identifier_link WHERE org_id = $1`, [testOrgId]],
      [`DELETE FROM conflict_queue  WHERE org_id = $1`, [testOrgId]],
      [`DELETE FROM fan             WHERE org_id = $1`, [testOrgId]],
      [`DELETE FROM org             WHERE id     = $1`, [testOrgId]],
    ]) {
      try {
        await c.query(sql, params);
      } catch (e) {
        console.error(`  Cleanup warning (${sql.split(' ')[2]}): ${e.message}`);
      }
    }

    console.log('Cleanup complete. (audit_log/fan/org rows may remain if append-only trigger blocked DELETE)\n');
  } catch (e) {
    console.error('Cleanup setup failed:', e.message);
    if (testOrgId) {
      console.error('Manual cleanup SQL (run in psql):');
      console.error(`  DELETE FROM merge_history   WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM identifier_link WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM conflict_queue  WHERE org_id = '${testOrgId}';`);
      console.error(`  -- audit_log/fan/org cannot be deleted if append-only trigger is active`);
    }
  } finally {
    c.release();
  }
}

async function run() {
  console.log('\nguardBreakers.conflictAlreadyResolved — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  try {

    // ── TEST 1 — already-confirmed conflict → 409 ─────────────────────────────
    //
    // The conflict_queue row was seeded with status='confirmed'.
    // The confirm handler reads the row, checks status !== 'pending', and
    // returns 409 before any database writes or transaction open.
    //
    // This proves:
    //   - The status guard fires first (before multi-hop, before BEGIN)
    //   - No second soft-delete of fanB (deleted_at stays FIXED_PAST, not NOW())
    //   - No second merge_history row written for this conflict
    //   - No audit_log row written (guard exits before transaction)
    //   - conflict_queue status unchanged — still 'confirmed'
    console.log('  --- test 1: already-confirmed conflict → 409 ---');
    const r1 = await post(`/v1/conflicts/${conflictId}/confirm`);

    assert(r1.status === 409,
      'test 1 — status === 409');
    assert(r1.body.error === 'conflict already resolved',
      'test 1 — body.error === "conflict already resolved"');

    // DB verification — confirm nothing was written
    const c1 = await pool.connect();
    try {
      await c1.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

      // Assertion 3: fanB.deleted_at unchanged.
      // A second soft-delete would write NOW(), producing a timestamp different
      // from FIXED_PAST. Exact string comparison via toISOString() catches this.
      const fanBRow = await c1.query(
        `SELECT deleted_at FROM fan WHERE id = $1 AND org_id = $2`,
        [fanB, testOrgId]
      );
      const deletedAt = fanBRow.rows[0]?.deleted_at;
      assert(
        deletedAt !== null && deletedAt !== undefined &&
        new Date(deletedAt).toISOString() === FIXED_PAST,
        'test 1 — fanB.deleted_at unchanged (equals FIXED_PAST, no second soft-delete ran)'
      );

      // Assertion 4: exactly one merge_history row for this conflict.
      // A second confirm would INSERT a second row with a new UUID.
      const mergeCount = await c1.query(
        `SELECT COUNT(*) FROM merge_history WHERE conflict_id = $1`,
        [conflictId]
      );
      assert(
        parseInt(mergeCount.rows[0].count, 10) === 1,
        'test 1 — exactly one merge_history row for conflictId (no second row written)'
      );

      // Assertion 5: zero conflict_confirmed audit rows.
      // The status guard returns before BEGIN, so no audit_log INSERT ran.
      const auditCount = await c1.query(
        `SELECT COUNT(*) FROM audit_log
         WHERE org_id = $1 AND event_type = 'conflict_confirmed'`,
        [testOrgId]
      );
      assert(
        parseInt(auditCount.rows[0].count, 10) === 0,
        'test 1 — zero conflict_confirmed audit rows (guard exits before transaction)'
      );

      // Assertion 6: conflict_queue status still 'confirmed'.
      const conflictRow = await c1.query(
        `SELECT status FROM conflict_queue WHERE id = $1`,
        [conflictId]
      );
      assert(
        conflictRow.rows[0]?.status === 'confirmed',
        'test 1 — conflict_queue status unchanged (still "confirmed")'
      );
    } finally {
      c1.release();
    }

    // ── TEST 2 — genuinely pending conflict confirms → 200 (regression) ───────
    //
    // fanC has no active merge_history row as fan_id_target, so the multi-hop
    // guard is silent. conflict2 is status='pending'. The full merge path runs.
    //
    // Proves the 409 guard does not over-block pending conflicts.
    console.log('\n  --- test 2: pending conflict → 200 (regression) ---');
    const r2 = await post(`/v1/conflicts/${conflict2Id}/confirm`);

    assert(r2.status === 200,
      'test 2 — status === 200 (pending conflict confirms normally)');
    assert(r2.body.status === 'confirmed',
      'test 2 — body.status === "confirmed"');

    // DB verification — confirm the merge actually ran
    const c2 = await pool.connect();
    try {
      await c2.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

      // Assertion 9: fanD is now soft-deleted (absorbed into fanC).
      const fanDRow = await c2.query(
        `SELECT deleted_at FROM fan WHERE id = $1 AND org_id = $2`,
        [fanD, testOrgId]
      );
      assert(
        fanDRow.rows[0]?.deleted_at !== null,
        'test 2 — fanD.deleted_at is set (soft-deleted after merge)'
      );

      // Assertion 10: exactly one merge_history row for conflict2, status='active'.
      const merge2Count = await c2.query(
        `SELECT COUNT(*) FROM merge_history
         WHERE conflict_id = $1 AND status = 'active'`,
        [conflict2Id]
      );
      assert(
        parseInt(merge2Count.rows[0].count, 10) === 1,
        'test 2 — exactly one active merge_history row for conflict2Id'
      );

      // Assertion 11: conflict2 status is now 'confirmed'.
      const conflict2Row = await c2.query(
        `SELECT status FROM conflict_queue WHERE id = $1`,
        [conflict2Id]
      );
      assert(
        conflict2Row.rows[0]?.status === 'confirmed',
        'test 2 — conflict2 status is "confirmed"'
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
