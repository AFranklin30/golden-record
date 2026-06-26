'use strict';
// tests/conflicts.multiHopBlock.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/conflicts.multiHopBlock.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to local Postgres (localhost:5432)
//   migration_001, migration_004, migration_005, migration_006+ all run
//
// Proves:
//   The multi-hop merge block guard in component 19 fires correctly:
//   when fan_id_a (the absorbing fan) already has an active merge_history
//   row as fan_id_target, the confirm returns 409 and writes nothing to
//   the database — conflict_queue stays 'pending', no merge_history row
//   is created, no audit_log row is written, and the existing
//   identifier_link provenance (merged_from_fan_id) is untouched.
//
//   Scenario:
//     Merge 1 (complete): fanX absorbed BY fanY.
//       fanY is fan_id_target in merge_history row 1.
//       fanX is soft-deleted. X's identifier now lives under Y
//       with merged_from_fan_id = fanX.
//     Merge 2 attempt (blocked): fanZ absorbed BY fanY.
//       fanY would absorb a second fan — multi-hop chain.
//       Guard fires before BEGIN. 409 returned. Nothing written.
//
//   Regression: a clean fan pair with no prior merge history
//   can still be confirmed normally after this change (200).

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

const crypto = require('crypto');
const pool   = require('../src/db/pool');

// Extract confirm handler from the Express router.
// conflicts.js registers routes in this order:
//   stack[0]: GET  /v1/conflicts            (component 18)
//   stack[1]: POST /v1/conflicts/:id/confirm (component 19)  ← this test
//   stack[2]: POST /v1/conflicts/:id/reject  (component 20)
//   stack[3]: POST /v1/conflicts/:id/unmerge (component 26)
const conflictsRouter = require('../src/routes/conflicts');
const confirmHandler  = conflictsRouter.stack[1].route.stack[0].handle;

if (typeof confirmHandler !== 'function') {
  console.error('BLOCKED: Could not extract confirm handler from conflicts router stack[1].');
  console.error('  Check that conflicts.js still registers POST confirm as the second route.');
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED — ${message}`);
  console.log(`  PASS  ${message}`);
}

async function run() {
  // ── IDs — main test (three-fan chain scenario) ───────────────────────────
  const testOrgId   = crypto.randomUUID();
  const fanXId      = crypto.randomUUID(); // absorbed in merge 1, now soft-deleted
  const fanYId      = crypto.randomUUID(); // absorbed X in merge 1 — has active merge_history as target
  const fanZId      = crypto.randomUUID(); // fresh fan, no prior merge — attempt to merge Z into Y is blocked
  const conflict1Id = crypto.randomUUID(); // merge 1 conflict row (confirmed)
  const mergeH1Id   = crypto.randomUUID(); // merge_history row for merge 1
  const conflict2Id = crypto.randomUUID(); // merge 2 attempt — should be blocked (fan_id_a = Y)

  // ── IDs — regression test (clean pair, no prior merge history) ──────────
  const fanAId      = crypto.randomUUID();
  const fanBId      = crypto.randomUUID();
  const conflict3Id = crypto.randomUUID();

  const orgApiKeyHash = crypto
    .createHash('sha256')
    .update(testOrgId)
    .digest('hex');

  console.log('\nconflicts.multiHopBlock — smoke test');
  console.log('=====================================');
  console.log(`testOrgId:   ${testOrgId}`);
  console.log(`fanXId:      ${fanXId}  (absorbed by Y in merge 1, soft-deleted)`);
  console.log(`fanYId:      ${fanYId}  (absorbed X, has active merge_history — GUARD TARGET)`);
  console.log(`fanZId:      ${fanZId}  (fresh fan — blocked attempt to merge Z into Y)`);
  console.log(`conflict2Id: ${conflict2Id}  (the blocked attempt)`);
  console.log(`fanAId:      ${fanAId}  (regression — no prior merge)`);
  console.log(`fanBId:      ${fanBId}  (regression — no prior merge)`);
  console.log(`conflict3Id: ${conflict3Id}  (regression — should confirm normally)`);

  const client = await pool.connect();

  try {

    // ── SETUP ────────────────────────────────────────────────────────────────

    // Org inserted BEFORE RLS context — org is not tenant-isolated.
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash)
       VALUES ($1, '_smoke_multiHopBlock', $2)`,
      [testOrgId, orgApiKeyHash]
    );

    // RLS context — session-scoped (is_local = false). Matches rlsContextMiddleware.
    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`,
      [testOrgId]
    );

    // Fan X — soft-deleted, was the source of merge 1.
    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version,
                        deleted_at, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW(), NOW())`,
      [fanXId, testOrgId]
    );

    // Fan Y — active, absorbed X in merge 1. Has active merge_history as fan_id_target.
    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version,
                        created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [fanYId, testOrgId]
    );

    // Fan Z — active, fresh fan, no prior merge. This is the fan that would be
    // absorbed by Y in the blocked attempt.
    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version,
                        created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [fanZId, testOrgId]
    );

    // X's identifier — now living under Y after merge 1.
    // merged_from_fan_id = fanXId proves provenance was set by merge 1 confirm.
    // Assertion 8 verifies this row is UNCHANGED after the blocked merge 2 attempt.
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          merged_from_fan_id, first_seen_at, last_seen_at)
       VALUES ($1, 'email', 'fanx@test-synth.com', $2,
               'synthetic_test', 'v1', 1.0, $3, NOW(), NOW())`,
      [fanYId, testOrgId, fanXId]
    );

    // Conflict queue row 1 — merge 1, already confirmed.
    // Fan Y (fan_id_a) absorbed fan X (fan_id_b).
    await client.query(
      `INSERT INTO conflict_queue
         (id, fan_id_a, fan_id_b, org_id, confidence_score,
          signals_matched, status, created_at, reviewed_at)
       VALUES ($1, $2, $3, $4, 0.900, '[]', 'confirmed', NOW(), NOW())`,
      [conflict1Id, fanYId, fanXId, testOrgId]
    );

    // Merge history row 1 — records that Y absorbed X. status = 'active' means
    // this merge has not been reversed. This is the row the guard finds.
    await client.query(
      `INSERT INTO merge_history
         (id, fan_id_source, fan_id_target, org_id, conflict_id,
          merged_by, status, merged_at)
       VALUES ($1, $2, $3, $4, $5, '_smoke_multiHopBlock', 'active', NOW())`,
      [mergeH1Id, fanXId, fanYId, testOrgId, conflict1Id]
    );

    // Conflict queue row 2 — the BLOCKED attempt.
    // fan_id_a = fanYId: Y has already absorbed X (active merge_history as fan_id_target).
    // fan_id_b = fanZId: Z is the fresh fan Y would absorb — making Y absorb a second fan.
    // Guard should block this and return 409 before any writes.
    await client.query(
      `INSERT INTO conflict_queue
         (id, fan_id_a, fan_id_b, org_id, confidence_score,
          signals_matched, status, created_at)
       VALUES ($1, $2, $3, $4, 0.900, '[]', 'pending', NOW())`,
      [conflict2Id, fanYId, fanZId, testOrgId]
    );

    console.log('\nSetup complete — 3 fans, 1 completed merge, 1 pending blocked attempt.');

    // ── MAIN TEST — blocked confirm (409) ────────────────────────────────────

    console.log('\nMain test — calling confirm for conflict2 (fan_id_a = fanY, already absorbed X)...');

    let capturedStatus;
    let capturedBody;

    const req = {
      params:  { id: conflict2Id },
      context: {
        org_id:         testOrgId,
        org_name:       '_smoke_multiHopBlock',
        correlation_id: 'test-correlation-id'
      },
      db: client,
    };
    const res = {
      status(code) { capturedStatus = code; return this; },
      json(body)   { capturedBody   = body;  return this; },
    };

    await confirmHandler(req, res);

    console.log('\nAssertions (main test — guard fires):');

    // 1 — guard returned 409
    assert(capturedStatus === 409,
      '1. response status === 409');

    // 2 — correct error key
    assert(capturedBody.error === 'multi-hop merge not supported',
      '2. response body.error === "multi-hop merge not supported"');

    // 3 — conflict2 status unchanged (guard fired before any writes)
    const c2Check = await client.query(
      `SELECT status FROM conflict_queue WHERE id = $1`,
      [conflict2Id]
    );
    assert(c2Check.rows[0].status === 'pending',
      '3. conflict_queue row 2 status still "pending" (guard fired before any write)');

    // 4 — fanY still active (fan_id_a — never soft-deleted because BEGIN never ran)
    const fanYCheck = await client.query(
      `SELECT deleted_at FROM fan WHERE id = $1`,
      [fanYId]
    );
    assert(fanYCheck.rows[0].deleted_at === null,
      '4. fanY deleted_at IS NULL (fan_id_a never soft-deleted — guard fired before BEGIN)');

    // 5 — fanZ still active and identifiers not moved
    const fanZCheck = await client.query(
      `SELECT deleted_at FROM fan WHERE id = $1`,
      [fanZId]
    );
    assert(fanZCheck.rows[0].deleted_at === null,
      '5. fanZ deleted_at IS NULL (fan_id_b never touched — guard fired before BEGIN)');

    // 6 — no merge_history row was created for conflict2
    const mh2Check = await client.query(
      `SELECT COUNT(*) FROM merge_history WHERE conflict_id = $1`,
      [conflict2Id]
    );
    assert(parseInt(mh2Check.rows[0].count, 10) === 0,
      '6. no merge_history row for conflict2Id (guard fired before transaction opened)');

    // 7 — no audit_log row was written for this org (BEGIN never ran, STEP 4 never ran)
    const auditCheck = await client.query(
      `SELECT COUNT(*) FROM audit_log WHERE org_id = $1`,
      [testOrgId]
    );
    assert(parseInt(auditCheck.rows[0].count, 10) === 0,
      '7. no audit_log row for testOrgId (guard fired before transaction — STEP 4 never ran)');

    // 8 — X's identifier still under Y with merged_from_fan_id = fanX (untouched by blocked attempt)
    const ilCheck = await client.query(
      `SELECT fan_id, merged_from_fan_id
       FROM identifier_link
       WHERE identifier_value = 'fanx@test-synth.com'
         AND org_id = $1`,
      [testOrgId]
    );
    assert(
      ilCheck.rows.length === 1 &&
      ilCheck.rows[0].fan_id === fanYId &&
      ilCheck.rows[0].merged_from_fan_id === fanXId,
      '8. identifier_link: fan_id = fanY, merged_from_fan_id = fanX (provenance untouched by blocked attempt)'
    );

    console.log('\n  All 8 main test assertions passed.\n');

    // ── REGRESSION SETUP — clean pair, no prior merge history ───────────────

    console.log('Regression setup — inserting fresh fan pair A and B...');

    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [fanAId, testOrgId]
    );
    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [fanBId, testOrgId]
    );

    // Conflict row 3 — fan_id_a = A (no prior merge history), fan_id_b = B.
    // Guard checks: any active merge_history WHERE fan_id_target = A? No. Guard passes.
    await client.query(
      `INSERT INTO conflict_queue
         (id, fan_id_a, fan_id_b, org_id, confidence_score,
          signals_matched, status, created_at)
       VALUES ($1, $2, $3, $4, 0.900, '[]', 'pending', NOW())`,
      [conflict3Id, fanAId, fanBId, testOrgId]
    );

    // ── REGRESSION TEST — clean confirm (200) ────────────────────────────────

    console.log('Regression test — calling confirm for conflict3 (clean fan pair)...');

    let regStatus;

    const regReq = {
      params:  { id: conflict3Id },
      context: {
        org_id:         testOrgId,
        org_name:       '_smoke_multiHopBlock',
        correlation_id: 'test-correlation-id'
      },
      db: client,
    };
    const regRes = {
      status(code) { regStatus = code; return this; },
      json()       { return this; },
    };

    await confirmHandler(regReq, regRes);

    console.log('\nAssertions (regression — guard must NOT block clean pair):');

    // 9 — clean pair confirms normally
    assert(regStatus === 200,
      '9. response status === 200 (no prior merge history — guard passes, merge succeeds)');

    // 10 — conflict3 status updated to confirmed
    const c3Check = await client.query(
      `SELECT status FROM conflict_queue WHERE id = $1`,
      [conflict3Id]
    );
    assert(c3Check.rows[0].status === 'confirmed',
      '10. conflict_queue row 3 status === "confirmed"');

    // 11 — one new merge_history row created for conflict3
    const mh3Check = await client.query(
      `SELECT COUNT(*) FROM merge_history WHERE conflict_id = $1`,
      [conflict3Id]
    );
    assert(parseInt(mh3Check.rows[0].count, 10) === 1,
      '11. one merge_history row created for conflict3Id (merge recorded correctly)');

    console.log('\n  All 11 assertions passed.\n');

  } finally {

    // ── CLEANUP ──────────────────────────────────────────────────────────────
    //
    // Known limitation: audit_log has an append-only trigger that blocks DELETE.
    // audit_log.fan_id also has a FK to fan(id), which prevents deleting fan rows
    // while audit_log rows for those fans exist. fan.org_id → org(id) means org
    // cannot be deleted while fan rows remain.
    //
    // We clean what we can. fan/org rows remain as acceptable per-run artifacts —
    // testOrgId is a fresh UUID every run so orphaned rows do not affect correctness.
    //
    // Cleanable (no downstream audit_log dependency):
    //   merge_history, related_fans, identifier_link, conflict_queue
    //
    // Not cleanable (blocked by audit_log append-only trigger → FK chain):
    //   audit_log → fan → org
    //
    // Each delete is wrapped individually so one failure does not skip the rest.
    console.log('Cleaning up test data (fan/org rows will remain — see comment above)...');
    for (const [sql, args] of [
      [`DELETE FROM merge_history   WHERE org_id = $1`, [testOrgId]],
      [`DELETE FROM related_fans    WHERE org_id = $1`, [testOrgId]],
      [`DELETE FROM identifier_link WHERE org_id = $1`, [testOrgId]],
      [`DELETE FROM conflict_queue  WHERE org_id = $1`, [testOrgId]],
    ]) {
      try {
        await client.query(sql, args);
      } catch (e) {
        console.error(`  Cleanup warning: ${e.message}`);
      }
    }
    console.log('Cleanup complete. (audit_log/fan/org rows remain — append-only FK chain, fresh UUID per run)\n');

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
