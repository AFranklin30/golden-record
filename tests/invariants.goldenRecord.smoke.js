'use strict';
// tests/invariants.goldenRecord.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/invariants.goldenRecord.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to local Postgres (localhost:5432)
//   All migrations through migration_012.sql run
//
// Proves:
//   assertInvariants() returns an empty array for fully valid state (PART A)
//   assertInvariants() catches each seedable invariant violation one at a time (PART B)
//   DB constraints block I4 and I6 seed attempts — throw confirms the guarantee (PART C)
//   I2: INSERT succeeds (uq_identifier_per_org is absent, confirmed Step 0 2026-06-23)
//     AND assertInvariants() returns an I2 violation
//
// Connects as postgres (RLS-bypassed) so the checker can see cross-org leaks (I1).
// Cross-org violations are invisible under RLS and must be checked with RLS off.
//
// 9 assertions across 3 parts.
//
// Cleanup note:
//   audit_log has an enforce_audit_log_append_only trigger (migration_003).
//   DELETE on audit_log fails when matching rows exist. The Part A seed writes
//   one conflict_confirmed audit row. Teardown wraps audit_log DELETE in
//   try/catch — if it fails, manual cleanup SQL is printed. Orphaned rows are
//   inert: testOrgId is a fresh UUID per run so they cannot affect future runs.

require('dotenv').config();

// ── Safety guard — must run before pool is loaded ─────────────────────────────
// This test must NEVER run against Cloud SQL (port 5433) or a remote host.
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
const { assertInvariants } = require('./helpers/invariants');

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

// ─────────────────────────────────────────────────────────────────────────────
// Shared state — all allocated in setup(), freed in teardown()
// ─────────────────────────────────────────────────────────────────────────────
let testOrgId;
let fanSourceId;  // soft-deleted fan (absorbed in Part A merge)
let fanTargetId;  // active fan (survivor in Part A merge)
let conflictIdA;  // Part A conflict_queue.id (confirmed, triggers I7 pass)

// ─────────────────────────────────────────────────────────────────────────────
// setup — Part A seed: fully valid state
// ─────────────────────────────────────────────────────────────────────────────
async function setup() {
  testOrgId   = crypto.randomUUID();
  fanSourceId = crypto.randomUUID();
  fanTargetId = crypto.randomUUID();

  const c = await pool.connect();
  try {
    // org
    await c.query(
      `INSERT INTO org (id, name, is_active, org_api_key_hash)
       VALUES ($1, '_smoke_invariants', true, $2)`,
      [testOrgId, crypto.createHash('sha256').update(testOrgId).digest('hex')]
    );

    // two fans — both start active
    await c.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $3, 'platform', 1, NOW(), NOW()),
              ($2, $3, 'platform', 1, NOW(), NOW())`,
      [fanSourceId, fanTargetId, testOrgId]
    );

    // soft-delete fanSource — it is the absorbed fan (I5 requires deleted_at IS NOT NULL)
    await c.query(
      `UPDATE fan SET deleted_at = NOW() WHERE id = $1`,
      [fanSourceId]
    );

    // identifier_link for fanTarget (same org — I1 clean)
    await c.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, 'email', 'target@test-synth.com', $2,
               'resolve', '1.0', 1.0, NOW(), NOW())`,
      [fanTargetId, testOrgId]
    );

    // conflict_queue — fanSource vs fanTarget, confirmed, score in [0,1] (I3 clean)
    // conflict_queue.id has no DEFAULT — must supply explicitly
    const cqRes = await c.query(
      `INSERT INTO conflict_queue
         (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status)
       VALUES (gen_random_uuid(), $1, $2, $3, 0.90, '[]'::jsonb, 'confirmed')
       RETURNING id`,
      [fanSourceId, fanTargetId, testOrgId]
    );
    conflictIdA = cqRes.rows[0].id;

    // merge_history — active merge, source is soft-deleted (I5 clean), reversed fields NULL (I6 clean)
    await c.query(
      `INSERT INTO merge_history
         (fan_id_source, fan_id_target, org_id, conflict_id, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [fanSourceId, fanTargetId, testOrgId, conflictIdA]
    );

    // audit_log — conflict_confirmed for fanSource (I7 clean: confirmed conflict IS witnessed)
    // status='success', error_detail=NULL — satisfies audit_log_status_error_detail_check
    await c.query(
      `INSERT INTO audit_log
         (fan_id, org_id, event_type, status)
       VALUES ($1, $2, 'conflict_confirmed', 'success')`,
      [fanSourceId, testOrgId]
    );
  } finally {
    c.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// teardown — delete everything for testOrgId in FK order
// audit_log DELETE is wrapped in try/catch (append-only trigger)
// ─────────────────────────────────────────────────────────────────────────────
async function teardown() {
  console.log('\nCleaning up test data...');
  const c = await pool.connect();
  let auditBlocked = false;
  try {
    // FK order: deepest dependents first
    await c.query(`DELETE FROM merge_history  WHERE org_id = $1`, [testOrgId]);

    // audit_log has an append-only trigger — DELETE always throws when rows exist.
    // When it fails, fan and org cleanup will also fail (FK: audit_log.fan_id → fan).
    // Orphaned rows are inert: testOrgId is a fresh UUID per run.
    try {
      await c.query(`DELETE FROM audit_log WHERE org_id = $1`, [testOrgId]);
    } catch {
      auditBlocked = true;
      console.error('  audit_log DELETE blocked by append-only trigger — orphaned rows are inert (fresh org per run)');
      console.error(`  Manual cleanup: DELETE FROM audit_log WHERE org_id = '${testOrgId}';`);
    }

    await c.query(`DELETE FROM conflict_queue  WHERE org_id = $1`, [testOrgId]);
    await c.query(`DELETE FROM identifier_link WHERE org_id = $1`, [testOrgId]);

    // fan and org DELETE fail when audit_log rows remain (FK constraint).
    // Each is wrapped individually so the other gets attempted regardless.
    try {
      await c.query(`DELETE FROM fan WHERE org_id = $1`, [testOrgId]);
    } catch (fanErr) {
      if (!auditBlocked) throw fanErr; // unexpected — re-throw
      console.error(`  fan DELETE skipped — audit_log FK. Manual: DELETE FROM fan WHERE org_id = '${testOrgId}';`);
    }
    try {
      await c.query(`DELETE FROM org WHERE id = $1`, [testOrgId]);
    } catch (orgErr) {
      if (!auditBlocked) throw orgErr;
      console.error(`  org DELETE skipped — audit_log FK. Manual: DELETE FROM org WHERE id = '${testOrgId}';`);
    }

    if (!auditBlocked) console.log('Cleanup complete.');
  } catch (err) {
    console.error('Teardown error — rows may remain:', err.message);
    if (testOrgId) {
      console.error('Manual cleanup SQL:');
      console.error(`  DELETE FROM merge_history  WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM conflict_queue WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM identifier_link WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM fan             WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM org             WHERE id     = '${testOrgId}';`);
    }
  } finally {
    c.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// run
// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\ninvariants.goldenRecord — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  const c = await pool.connect();
  try {

    // ── PART A — clean org returns zero violations (green baseline) ───────────
    console.log('--- PART A: clean state → zero violations ---');

    const clean = await assertInvariants(c, testOrgId);

    // ASSERT 1 — returns an array
    assert(Array.isArray(clean),
      'PART A Assert 1: assertInvariants returns an array');

    // ASSERT 2 — array is empty (no false positives on valid state)
    assert(clean.length === 0,
      `PART A Assert 2: array is empty — ${clean.length === 0 ? 'no violations' : JSON.stringify(clean)}`);


    // ── PART B — each seedable invariant caught one at a time ─────────────────
    console.log('\n--- PART B: seedable violations ---');

    // ── I1 — cross-org identifier_link ────────────────────────────────────────
    console.log('\n  [I1] cross-org identifier_link');
    const orgY   = crypto.randomUUID();
    const fanY   = crypto.randomUUID();
    let   ilCrossId;
    try {
      // second org + fan
      await c.query(
        `INSERT INTO org (id, name, is_active, org_api_key_hash)
         VALUES ($1, '_smoke_invariants_orgY', true, $2)`,
        [orgY, crypto.createHash('sha256').update(orgY).digest('hex')]
      );
      await c.query(
        `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
         VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
        [fanY, orgY]
      );
      // cross-org link: fan_id points to fanY (orgY) but org_id = testOrgId
      const ilRes = await c.query(
        `INSERT INTO identifier_link
           (fan_id, identifier_type, identifier_value, org_id,
            source_system, schema_version, confidence_score,
            first_seen_at, last_seen_at)
         VALUES ($1, 'phone', '4055550001', $2,
                 'resolve', '1.0', 1.0, NOW(), NOW())
         RETURNING id`,
        [fanY, testOrgId]
      );
      ilCrossId = ilRes.rows[0].id;

      const v1 = await assertInvariants(c, testOrgId);

      // ASSERT 3 — I1 appears in violations
      assert(v1.some(v => v.invariant === 'I1'),
        'PART B Assert 3 [I1]: cross-org identifier_link detected');
    } finally {
      // clean up I1 violation rows in FK order
      if (ilCrossId) await c.query(`DELETE FROM identifier_link WHERE id = $1`, [ilCrossId]);
      await c.query(`DELETE FROM fan WHERE id = $1`, [fanY]);
      await c.query(`DELETE FROM org WHERE id = $1`, [orgY]);
    }

    // ── I3 — confidence_score out of [0,1] ────────────────────────────────────
    console.log('\n  [I3] confidence_score = 1.500');
    const fanP = crypto.randomUUID();
    const fanQ = crypto.randomUUID();
    let   cqBadId;
    try {
      await c.query(
        `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
         VALUES ($1, $3, 'platform', 1, NOW(), NOW()),
                ($2, $3, 'platform', 1, NOW(), NOW())`,
        [fanP, fanQ, testOrgId]
      );
      // NUMERIC(4,3) has no range CHECK — 1.500 stores successfully
      const cqRes3 = await c.query(
        `INSERT INTO conflict_queue
           (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status)
         VALUES (gen_random_uuid(), $1, $2, $3, 1.500, '[]'::jsonb, 'pending')
         RETURNING id`,
        [fanP, fanQ, testOrgId]
      );
      cqBadId = cqRes3.rows[0].id;

      const v3 = await assertInvariants(c, testOrgId);

      // ASSERT 4 — I3 appears in violations
      assert(v3.some(v => v.invariant === 'I3'),
        'PART B Assert 4 [I3]: out-of-range confidence_score detected');
    } finally {
      if (cqBadId) await c.query(`DELETE FROM conflict_queue WHERE id = $1`, [cqBadId]);
      await c.query(`DELETE FROM fan WHERE id IN ($1, $2)`, [fanP, fanQ]);
    }

    // ── I5 — active merge, source fan still alive ─────────────────────────────
    console.log('\n  [I5] active merge, fan_id_source deleted_at IS NULL');
    const fanR = crypto.randomUUID();
    const fanS = crypto.randomUUID();
    let   mhBadId;
    try {
      await c.query(
        `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
         VALUES ($1, $3, 'platform', 1, NOW(), NOW()),
                ($2, $3, 'platform', 1, NOW(), NOW())`,
        [fanR, fanS, testOrgId]
      );
      // fanR.deleted_at IS NULL — active fan as source of active merge → I5 violation
      const mhRes = await c.query(
        `INSERT INTO merge_history (fan_id_source, fan_id_target, org_id, status)
         VALUES ($1, $2, $3, 'active')
         RETURNING id`,
        [fanR, fanS, testOrgId]
      );
      mhBadId = mhRes.rows[0].id;

      const v5 = await assertInvariants(c, testOrgId);

      // ASSERT 5 — I5 appears in violations
      assert(v5.some(v => v.invariant === 'I5'),
        'PART B Assert 5 [I5]: active merge with live source fan detected');
    } finally {
      if (mhBadId) await c.query(`DELETE FROM merge_history WHERE id = $1`, [mhBadId]);
      await c.query(`DELETE FROM fan WHERE id IN ($1, $2)`, [fanR, fanS]);
    }

    // ── I7 — confirmed conflict, no audit ─────────────────────────────────────
    console.log('\n  [I7] confirmed conflict with no conflict_confirmed audit for fan_id_a');
    const fanU = crypto.randomUUID();
    const fanV = crypto.randomUUID();
    let   cqNoAuditId;
    try {
      await c.query(
        `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
         VALUES ($1, $3, 'platform', 1, NOW(), NOW()),
                ($2, $3, 'platform', 1, NOW(), NOW())`,
        [fanU, fanV, testOrgId]
      );
      // confirmed conflict for fanU — no audit_log row written for fanU
      const cqRes7 = await c.query(
        `INSERT INTO conflict_queue
           (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status)
         VALUES (gen_random_uuid(), $1, $2, $3, 0.88, '[]'::jsonb, 'confirmed')
         RETURNING id`,
        [fanU, fanV, testOrgId]
      );
      cqNoAuditId = cqRes7.rows[0].id;

      const v7 = await assertInvariants(c, testOrgId);

      // ASSERT 6 — I7 appears in violations
      assert(v7.some(v => v.invariant === 'I7'),
        'PART B Assert 6 [I7]: confirmed conflict with no audit row detected');
    } finally {
      if (cqNoAuditId) await c.query(`DELETE FROM conflict_queue WHERE id = $1`, [cqNoAuditId]);
      await c.query(`DELETE FROM fan WHERE id IN ($1, $2)`, [fanU, fanV]);
    }


    // ── PART C — DB-enforced constraints confirm the DB blocks the seed ───────
    console.log('\n--- PART C: DB-enforced constraints ---');

    // Shared fans for Part C
    const fanX = crypto.randomUUID();
    const fanZ = crypto.randomUUID();
    await c.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $3, 'platform', 1, NOW(), NOW()),
              ($2, $3, 'platform', 1, NOW(), NOW())`,
      [fanX, fanZ, testOrgId]
    );

    // ── I4 — self-conflict INSERT must throw ──────────────────────────────────
    console.log('\n  [I4] INSERT conflict_queue fan_id_a = fan_id_b (expect check_violation)');
    {
      let threw = false;
      let code;
      try {
        await c.query(
          `INSERT INTO conflict_queue
             (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status)
           VALUES (gen_random_uuid(), $1, $1, $2, 0.70, '[]'::jsonb, 'pending')`,
          [fanX, testOrgId]
        );
      } catch (err) {
        threw = true;
        code  = err.code;
      }
      // ASSERT 7 — INSERT threw a check_violation (Postgres code 23514)
      assert(threw && code === '23514',
        `PART C Assert 7 [I4]: INSERT fan_id_a=fan_id_b threw check_violation (23514) — threw=${threw}, code=${code}`);
    }

    // ── I6 — active merge with reversed_at populated INSERT must throw ────────
    console.log('\n  [I6] INSERT merge_history status=active with reversed_at (expect check_violation)');
    {
      let threw = false;
      let code;
      try {
        await c.query(
          `INSERT INTO merge_history
             (fan_id_source, fan_id_target, org_id, status, reversed_at, reversed_by)
           VALUES ($1, $2, $3, 'active', NOW(), 'test')`,
          [fanX, fanZ, testOrgId]
        );
      } catch (err) {
        threw = true;
        code  = err.code;
      }
      // ASSERT 8 — INSERT threw a check_violation (Postgres code 23514)
      assert(threw && code === '23514',
        `PART C Assert 8 [I6]: INSERT active+reversed_at threw check_violation (23514) — threw=${threw}, code=${code}`);
    }

    // ── I2 — duplicate (type, value, org) → different fan_id ─────────────────
    // Step 0 confirmed uq_identifier_per_org is ABSENT. INSERT should succeed,
    // and assertInvariants should return an I2 violation.
    console.log('\n  [I2] duplicate identifier → same (type, value, org_id), different fan_id');
    {
      let insertThrew  = false;
      let insertCode;
      let dupIlId1, dupIlId2;
      try {
        const r1 = await c.query(
          `INSERT INTO identifier_link
             (fan_id, identifier_type, identifier_value, org_id,
              source_system, schema_version, confidence_score,
              first_seen_at, last_seen_at)
           VALUES ($1, 'email', 'dup@test-synth.com', $2,
                   'resolve', '1.0', 1.0, NOW(), NOW())
           RETURNING id`,
          [fanX, testOrgId]
        );
        dupIlId1 = r1.rows[0].id;

        const r2 = await c.query(
          `INSERT INTO identifier_link
             (fan_id, identifier_type, identifier_value, org_id,
              source_system, schema_version, confidence_score,
              first_seen_at, last_seen_at)
           VALUES ($1, 'email', 'dup@test-synth.com', $2,
                   'resolve', '1.0', 1.0, NOW(), NOW())
           RETURNING id`,
          [fanZ, testOrgId]
        );
        dupIlId2 = r2.rows[0].id;
      } catch (err) {
        insertThrew = true;
        insertCode  = err.code;
      }

      if (insertThrew) {
        // uq_identifier_per_org IS present (unexpected per Step 0 — report it)
        console.log(`    NOTE: uq_identifier_per_org constraint EXISTS — INSERT threw (${insertCode}).`);
        console.log('    Step 0 finding was: constraint absent. Schema may have changed.');
        // ASSERT 9 — first branch: INSERT threw (constraint now present)
        assert(insertCode === '23505',
          `PART C Assert 9 [I2]: INSERT threw unique_violation (23505) — code=${insertCode}`);
      } else {
        // uq_identifier_per_org absent (confirmed per Step 0) — checker is the only guard
        console.log('    NOTE: uq_identifier_per_org constraint absent (confirmed Step 0 2026-06-23).');
        console.log('    INSERT succeeded. assertInvariants is the only I2 guard.');

        const v2 = await assertInvariants(c, testOrgId);
        const hasI2 = v2.some(v => v.invariant === 'I2');

        // ASSERT 9 — second branch: INSERT succeeded AND checker caught I2
        assert(hasI2,
          `PART C Assert 9 [I2]: INSERT succeeded (no constraint) AND assertInvariants caught I2 — hasI2=${hasI2}`);

        // clean up duplicate links
        if (dupIlId1) await c.query(`DELETE FROM identifier_link WHERE id = $1`, [dupIlId1]);
        if (dupIlId2) await c.query(`DELETE FROM identifier_link WHERE id = $1`, [dupIlId2]);
      }
    }

    // clean up Part C fans
    await c.query(`DELETE FROM fan WHERE id IN ($1, $2)`, [fanX, fanZ]);

  } finally {
    c.release();
    await teardown();
    await pool.end();
  }

  const total = passed + failed;
  console.log(`\n${total} checks: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Smoke test crashed:', err.message, err.stack);
  process.exit(1);
});
