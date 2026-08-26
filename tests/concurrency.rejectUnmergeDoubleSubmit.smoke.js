'use strict';
// tests/concurrency.rejectUnmergeDoubleSubmit.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/concurrency.rejectUnmergeDoubleSubmit.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to local Postgres (localhost:5432)
//   migrations run: org, fan, identifier_link, audit_log, conflict_queue,
//                   merge_history, related_fans
//
// Proves:
//   The CAS fixes in conflicts.js actually block a concurrent double-submit.
//
//   Component 20 — POST /v1/conflicts/:id/reject
//     CAS: UPDATE conflict_queue SET status='rejected' WHERE id=$1 AND status='pending'
//     A second concurrent writer sees rowCount=0 → ROLLBACK → 409 before audit INSERT.
//     Blast radius blocked: no duplicate conflict_rejected audit row.
//
//   Component 26 — POST /v1/conflicts/:id/unmerge
//     CAS: UPDATE merge_history SET status='reversed' WHERE id=$2 AND status='active'
//     A second concurrent writer sees rowCount=0 → ROLLBACK before STEPs 5-6.
//     Blast radius blocked: no duplicate related_fans row, no duplicate audit row,
//     no phantom reversed_at overwrite.
//
// Why these tests are not flaky in serial processing either:
//   In serial mode the pre-transaction status guard fires on the second request
//   (conflict already resolved / conflict is not confirmed) and the assertions
//   still hold — one 200, one 409, all counts exactly 1.
//   The CAS is the safety net for the concurrent case; the pre-transaction guard
//   is the safety net for the serial case. Both produce the same observable outcome.

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
const conflictsRouter         = require('../src/routes/conflicts');

const ORG_KEY = 'test-key-concurrency-cas';
const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

let server;
let testOrgId;
// Scenario R — reject
let fanRA, fanRB, conflictR;
// Scenario U — unmerge
let fanUA, fanUB, conflictU;

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

// POST helper — sends an empty JSON body through the test Express server
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
  testOrgId  = crypto.randomUUID();
  fanRA      = crypto.randomUUID();
  fanRB      = crypto.randomUUID();
  conflictR  = crypto.randomUUID();
  fanUA      = crypto.randomUUID();
  fanUB      = crypto.randomUUID();
  conflictU  = crypto.randomUUID();

  // Org
  await pool.query(
    `INSERT INTO org (id, name, is_active, org_api_key_hash)
     VALUES ($1, 'Concurrency CAS Test Org', true, $2)`,
    [testOrgId, hashKey(ORG_KEY)]
  );

  // ── Scenario R — reject ───────────────────────────────────────────────────

  // fanRA — survivor, active (fan_id_a)
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [fanRA, testOrgId]
  );

  // fanRB — to-reject, active (fan_id_b)
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [fanRB, testOrgId]
  );

  // conflictR — pending (both writers will attempt to reject it)
  await pool.query(
    `INSERT INTO conflict_queue
       (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status)
     VALUES ($1, $2, $3, $4, 0.9, '[]', 'pending')`,
    [conflictR, fanRA, fanRB, testOrgId]
  );

  // ── Scenario U — unmerge ─────────────────────────────────────────────────

  // fanUA — target, active (fan_id_a in conflict, fan_id_target in merge_history)
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [fanUA, testOrgId]
  );

  // fanUB — source, already soft-deleted (absorbed by the original merge)
  // deleted_at is set — the unmerge will reactivate it by setting deleted_at = NULL.
  // Assertion 10 checks fanUB.deleted_at IS NULL after exactly one unmerge.
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version,
                      created_at, updated_at, deleted_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW(), NOW())`,
    [fanUB, testOrgId]
  );

  // identifier_link — one identifier currently on fanUA, provenance points to fanUB.
  // The unmerge STEP 1 moves it back: SET fan_id = merged_from_fan_id, merged_from_fan_id = NULL
  // WHERE fan_id = fanUA AND merged_from_fan_id = fanUB AND org_id = testOrgId.
  // Assertion 11 verifies fan_id=fanUB, merged_from_fan_id IS NULL after exactly one unmerge.
  await pool.query(
    `INSERT INTO identifier_link
       (fan_id, merged_from_fan_id, identifier_type, identifier_value,
        org_id, source_system, schema_version)
     VALUES ($1, $2, 'email', 'fanu@test-synth-cas.com', $3,
             'synthetic_test', 'v1')`,
    [fanUA, fanUB, testOrgId]
  );

  // conflictU — confirmed (the original merge happened; now being unmerged)
  await pool.query(
    `INSERT INTO conflict_queue
       (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched,
        status, reviewed_at)
     VALUES ($1, $2, $3, $4, 0.9, '[]', 'confirmed', NOW())`,
    [conflictU, fanUA, fanUB, testOrgId]
  );

  // merge_history — active merge: fanUB was absorbed into fanUA
  // reversed_at and reversed_by are NULL — the unmerge will populate them.
  // Assertion 7 verifies both are populated after exactly one unmerge.
  await pool.query(
    `INSERT INTO merge_history
       (fan_id_source, fan_id_target, org_id, conflict_id,
        merged_by, status, merged_at)
     VALUES ($1, $2, $3, $4, 'Concurrency CAS Test Org', 'active', NOW())`,
    [fanUB, fanUA, testOrgId, conflictU]
  );

  // Build minimal Express app matching protectedRouter in index.js.
  // No rate limiter — smoke test sends a handful of requests.
  // No jwtMiddleware — conflictsRouter is on protectedRouter (not householdProtectedRouter).
  // Middleware order confirmed from CLAUDE.md and index.js:
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
  console.log('\nCleaning up test data...');
  const c = await pool.connect();
  try {
    await c.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

    // FK delete order:
    //   related_fans (references fan) before fan
    //   merge_history (references conflict_queue + fan) before conflict_queue
    //   audit_log (references fan) before fan — may be blocked by append-only trigger
    //   identifier_link (references fan) before fan
    //   conflict_queue (references fan) before fan
    //   fan before org
    //
    // Each delete is wrapped so one failure does not skip the rest.
    // Orphaned audit rows are inert — fresh UUIDs per run.
    for (const [sql, params] of [
      [`DELETE FROM related_fans    WHERE org_id = $1`, [testOrgId]],
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
      console.error(`  DELETE FROM related_fans    WHERE org_id = '${testOrgId}';`);
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
  console.log('\nconcurrency.rejectUnmergeDoubleSubmit — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  try {

    // ── TEST 1 — concurrent double-submit on reject → one 200, one 409 ────────
    //
    // Both POST requests are fired simultaneously via Promise.all.
    // The reject handler's CAS (UPDATE WHERE id=$1 AND status='pending') means
    // only the first writer can set status='rejected' with rowCount=1. The second
    // writer sees rowCount=0 → ROLLBACK → 409 before the audit INSERT runs.
    //
    // In serial mode the pre-transaction status guard catches the second request
    // (status already 'rejected') and also returns 409 'conflict already resolved'.
    // Assertions hold in both concurrent and serial cases.
    console.log('  --- test 1: concurrent reject double-submit → one 200, one 409 ---');
    const [r1a, r1b] = await Promise.all([
      post(`/v1/conflicts/${conflictR}/reject`),
      post(`/v1/conflicts/${conflictR}/reject`),
    ]);

    const rejectStatuses = [r1a.status, r1b.status].sort();

    assert(
      rejectStatuses[0] === 200 && rejectStatuses[1] === 409,
      'assertion 1 — exactly one 200 and one 409 from concurrent rejects'
    );

    const reject409 = r1a.status === 409 ? r1a : r1b;
    assert(
      reject409.body.error === 'conflict already resolved',
      'assertion 2 — 409 body.error === "conflict already resolved"'
    );

    // DB verification
    const c1 = await pool.connect();
    try {
      await c1.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

      const conflictRRow = await c1.query(
        `SELECT status FROM conflict_queue WHERE id = $1`,
        [conflictR]
      );
      assert(
        conflictRRow.rows[0]?.status === 'rejected',
        'assertion 3 — conflict_queue status for conflictR is "rejected"'
      );

      // CAS guarantee: the second writer's ROLLBACK happened before its audit INSERT.
      // Only one conflict_rejected row should exist for fanRA.
      const auditRCount = await c1.query(
        `SELECT COUNT(*) FROM audit_log
         WHERE org_id = $1 AND event_type = 'conflict_rejected' AND fan_id = $2`,
        [testOrgId, fanRA]
      );
      assert(
        parseInt(auditRCount.rows[0].count, 10) === 1,
        'assertion 4 — exactly ONE conflict_rejected audit row for fanRA (second writer blocked by CAS)'
      );
    } finally {
      c1.release();
    }

    // ── TEST 2 — concurrent double-submit on unmerge → one 200, one 409 ──────
    //
    // Both POST requests fired simultaneously.
    // The unmerge handler's CAS at STEP 4 (UPDATE merge_history WHERE id=$2 AND status='active')
    // means only the first writer can flip status to 'reversed' (rowCount=1). The second
    // writer sees rowCount=0 → ROLLBACK before STEPs 5 and 6 → one related_fans row,
    // one audit row, no reversed_at overwrite.
    //
    // STEPs 1-3 inside the losing writer's transaction are naturally safe:
    //   STEP 1: identifier_link row already moved by R1; R2's WHERE matches 0 rows (no-op).
    //           After rollback, no state change.
    //   STEP 2: fan.deleted_at already NULL from R1; R2 sets NULL again (idempotent).
    //           After rollback, R1's committed NULL persists — fanUB stays active.
    //   STEP 3: conflict_queue already 'unmerged' from R1; R2 sets it again (idempotent).
    //           After rollback, R1's committed value persists.
    console.log('\n  --- test 2: concurrent unmerge double-submit → one 200, one 409 ---');
    const [r2a, r2b] = await Promise.all([
      post(`/v1/conflicts/${conflictU}/unmerge`),
      post(`/v1/conflicts/${conflictU}/unmerge`),
    ]);

    const unmergeStatuses = [r2a.status, r2b.status].sort();

    assert(
      unmergeStatuses[0] === 200 && unmergeStatuses[1] === 409,
      'assertion 5 — exactly one 200 and one 409 from concurrent unmerges'
    );

    // DB verification
    const c2 = await pool.connect();
    try {
      await c2.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

      const conflictURow = await c2.query(
        `SELECT status FROM conflict_queue WHERE id = $1`,
        [conflictU]
      );
      assert(
        conflictURow.rows[0]?.status === 'unmerged',
        'assertion 6 — conflict_queue status for conflictU is "unmerged"'
      );

      // Exactly one merge_history row, flipped once: status='reversed',
      // reversed_at and reversed_by both populated by the winner.
      const mergeRow = await c2.query(
        `SELECT status, reversed_at, reversed_by
         FROM merge_history
         WHERE conflict_id = $1 AND org_id = $2`,
        [conflictU, testOrgId]
      );
      assert(
        mergeRow.rows.length === 1 &&
        mergeRow.rows[0].status === 'reversed' &&
        mergeRow.rows[0].reversed_at !== null &&
        mergeRow.rows[0].reversed_by !== null,
        'assertion 7 — exactly ONE merge_history row: status="reversed", reversed_at and reversed_by populated'
      );

      // CAS blocks second writer before STEP 5 — only one related_fans row.
      const relatedCount = await c2.query(
        `SELECT COUNT(*) FROM related_fans
         WHERE fan_id_a = $1 AND fan_id_b = $2
           AND org_id = $3 AND relationship = 'unmerged'`,
        [fanUA, fanUB, testOrgId]
      );
      assert(
        parseInt(relatedCount.rows[0].count, 10) === 1,
        'assertion 8 — exactly ONE related_fans row for (fanUA, fanUB) relationship="unmerged"'
      );

      // CAS blocks second writer before STEP 6 — only one merge_reversed audit row.
      const auditUCount = await c2.query(
        `SELECT COUNT(*) FROM audit_log
         WHERE org_id = $1 AND event_type = 'merge_reversed' AND fan_id = $2`,
        [testOrgId, fanUA]
      );
      assert(
        parseInt(auditUCount.rows[0].count, 10) === 1,
        'assertion 9 — exactly ONE merge_reversed audit row for fanUA (second writer blocked by CAS)'
      );

      // fanUB was reactivated exactly once. Even though the losing writer's STEP 2
      // set deleted_at=NULL (idempotent), its ROLLBACK leaves R1's committed NULL
      // in place. The fan is active, not double-processed.
      const fanUBRow = await c2.query(
        `SELECT deleted_at FROM fan WHERE id = $1 AND org_id = $2`,
        [fanUB, testOrgId]
      );
      assert(
        fanUBRow.rows[0]?.deleted_at === null,
        'assertion 10 — fanUB.deleted_at IS NULL (reactivated exactly once, losing writer rolled back cleanly)'
      );

      // Identifier moved back exactly once: fan_id=fanUB, merged_from_fan_id cleared.
      // R1's STEP 1 moved it; R2's STEP 1 found 0 matching rows (no-op) and then rolled back.
      const ilRow = await c2.query(
        `SELECT fan_id, merged_from_fan_id
         FROM identifier_link
         WHERE org_id = $1
           AND identifier_type = 'email'
           AND identifier_value = 'fanu@test-synth-cas.com'`,
        [testOrgId]
      );
      assert(
        ilRow.rows.length === 1 &&
        ilRow.rows[0].fan_id === fanUB &&
        ilRow.rows[0].merged_from_fan_id === null,
        'assertion 11 — identifier_link: fan_id=fanUB, merged_from_fan_id IS NULL (moved exactly once)'
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
