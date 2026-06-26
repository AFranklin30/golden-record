'use strict';
// tests/concurrency.identifierUniqueness.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/concurrency.identifierUniqueness.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to local Postgres (localhost:5432)
//   migrations run through migration_013 (uq_identifier_per_org index on identifier_link)
//
// Proves:
//   TEST 1 — uq_identifier_per_org blocks a raw duplicate identifier_link INSERT
//     A direct INSERT of a second identifier_link row with the same
//     (identifier_type, identifier_value, org_id) as an existing row must
//     raise error code 23505.
//
//   TEST 2 — two concurrent resolverEngine calls for the same new identifier
//             resolve to the same fan, no 500s, two success audit rows
//     resolverEngine is called directly (not through Express) with two
//     concurrent invocations sharing a pool but using separate dedicated clients.
//     The winner creates the fan (PATH B) and commits. The loser hits 23505 on
//     identifier_link INSERT, catches it, ROLLBACKs, re-queries PATH A, and
//     returns the winner's fan. In serial mode the loser finds the identifier in
//     PATH A before reaching the INSERT — no 23505 fires but assertions still hold.

require('dotenv').config();

// ── Safety guard — must run before pool or any module is loaded ───────────────
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

const crypto  = require('crypto');
const pool    = require('../src/db/pool');
const { resolverEngine } = require('../src/modules/resolverEngine');

const ORG_KEY = 'test-key-identifier-uniqueness';
const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

let testOrgId;
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
  testOrgId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO org (id, name, is_active, org_api_key_hash)
     VALUES ($1, 'Identifier Uniqueness Test Org', true, $2)`,
    [testOrgId, hashKey(ORG_KEY)]
  );
}

async function teardown() {
  console.log('\nCleaning up test data...');
  const c = await pool.connect();
  try {
    // FK delete order: audit_log and identifier_link before fan, fan before org.
    // audit_log deletes may be blocked by the append-only trigger — catch and continue.
    for (const [sql, params] of [
      [`DELETE FROM audit_log       WHERE org_id = $1`, [testOrgId]],
      [`DELETE FROM identifier_link WHERE org_id = $1`, [testOrgId]],
      [`DELETE FROM fan             WHERE org_id = $1`, [testOrgId]],
      [`DELETE FROM org             WHERE id     = $1`, [testOrgId]],
    ]) {
      try {
        await c.query(sql, params);
      } catch (e) {
        console.error(`  Cleanup warning (${sql.split(' ')[2]}): ${e.message}`);
      }
    }
    console.log('Cleanup complete. (audit_log rows may remain if append-only trigger blocked DELETE)\n');
  } catch (e) {
    console.error('Cleanup setup failed:', e.message);
    if (testOrgId) {
      console.error('Manual cleanup SQL (run in psql):');
      console.error(`  DELETE FROM identifier_link WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM fan             WHERE org_id = '${testOrgId}';`);
      console.error(`  DELETE FROM org             WHERE id     = '${testOrgId}';`);
    }
  } finally {
    c.release();
  }
}

async function run() {
  console.log('\nconcurrency.identifierUniqueness — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  try {

    // ── TEST 1 — uq_identifier_per_org blocks a raw duplicate INSERT ──────────
    //
    // Seed one fan + one identifier_link. Then attempt a direct INSERT of a
    // second identifier_link row with the same (type, value, org_id) but a
    // different fan_id. The unique index must reject it with code 23505.
    console.log('  --- test 1: index blocks duplicate identifier_link INSERT ---');

    const fan1A = crypto.randomUUID();
    const fan1B = crypto.randomUUID();
    const t1Type  = 'email';
    const t1Value = `uniqueness-test-1-${crypto.randomUUID()}@test-synth.com`;

    const c1 = await pool.connect();
    try {
      // Seed fan1A + identifier_link
      await c1.query(
        `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
         VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
        [fan1A, testOrgId]
      );
      await c1.query(
        `INSERT INTO identifier_link
           (fan_id, identifier_type, identifier_value, org_id,
            source_system, schema_version, confidence_score, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, 'synthetic_test', 'v1', 1.0, NOW(), NOW())`,
        [fan1A, t1Type, t1Value, testOrgId]
      );

      // Seed fan1B (the duplicate attempt needs a real fan FK)
      await c1.query(
        `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
         VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
        [fan1B, testOrgId]
      );

      // Attempt duplicate INSERT — same (type, value, org_id), different fan
      let threw23505 = false;
      try {
        await c1.query(
          `INSERT INTO identifier_link
             (fan_id, identifier_type, identifier_value, org_id,
              source_system, schema_version, confidence_score, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, 'synthetic_test', 'v1', 0.9, NOW(), NOW())`,
          [fan1B, t1Type, t1Value, testOrgId]
        );
      } catch (insertErr) {
        if (insertErr.code === '23505') {
          threw23505 = true;
        } else {
          throw insertErr;
        }
      }

      assert(
        threw23505,
        'assertion 1 — duplicate identifier_link INSERT threw 23505 (unique_violation)'
      );

      const countRow = await c1.query(
        `SELECT COUNT(*) FROM identifier_link
         WHERE identifier_type = $1 AND identifier_value = $2 AND org_id = $3`,
        [t1Type, t1Value, testOrgId]
      );
      assert(
        parseInt(countRow.rows[0].count, 10) === 1,
        'assertion 2 — exactly one identifier_link row for that (type, value, org_id) after blocked duplicate'
      );

    } finally {
      c1.release();
    }

    // ── TEST 2 — two concurrent resolverEngine calls → same fan ───────────────
    //
    // Two concurrent resolverEngine invocations for the same brand-new identifier
    // (no prior fan, no prior identifier_link). Each call gets its own dedicated
    // pool client so their transactions are independent.
    //
    // Concurrent mode: both proceed past PATH A (no match yet), both reach PATH B
    // INSERT. The winner commits first. The loser hits 23505 on identifier_link
    // INSERT → ROLLBACK → PATH A re-query → returns winner's fan.
    //
    // Serial mode: winner commits (PATH B), loser finds identifier in PATH A hard
    // match and returns winner's fan without hitting 23505.
    //
    // In both modes: same fan_id, one fan row, one identifier_link row, two
    // success audit rows, zero error audit rows.
    //
    // Different idempotency keys ensure neither call hits the GUARD 2 early-return
    // and both write their own audit rows (making assertion 7 deterministic in
    // both serial and concurrent execution modes).
    console.log('\n  --- test 2: concurrent resolverEngine calls → same fan, no errors ---');

    const t2Type  = 'email';
    const t2Value = `uniqueness-test-2-${crypto.randomUUID()}@test-synth.com`;
    // Different keys — simulates two callers that don't share an idempotency namespace.
    const t2Key1  = crypto.randomUUID();
    const t2Key2  = crypto.randomUUID();

    const input1 = {
      identifier_type:  t2Type,
      identifier_value: t2Value,
      org_id:           testOrgId,
      schema_version:   'v1',
      idempotency_key:  t2Key1,
      source_system:    'synthetic_test',
    };
    const input2 = {
      identifier_type:  t2Type,
      identifier_value: t2Value,
      org_id:           testOrgId,
      schema_version:   'v1',
      idempotency_key:  t2Key2,
      source_system:    'synthetic_test',
    };

    let result1, result2;
    const db1 = await pool.connect();
    const db2 = await pool.connect();
    try {
      [result1, result2] = await Promise.all([
        resolverEngine(input1, db1),
        resolverEngine(input2, db2),
      ]);
    } finally {
      db1.release();
      db2.release();
    }

    assert(
      result1 != null && result2 != null &&
      result1.fan_id === result2.fan_id,
      'assertion 3 — both concurrent calls resolved to the SAME fan_id'
    );

    const c2 = await pool.connect();
    try {
      // ASSERT 4 — exactly one fan for this identifier
      const fanCount = await c2.query(
        `SELECT COUNT(*) FROM fan
         WHERE org_id = $1
           AND id = $2
           AND deleted_at IS NULL`,
        [testOrgId, result1.fan_id]
      );
      assert(
        parseInt(fanCount.rows[0].count, 10) === 1,
        'assertion 4 — exactly one fan row for the resolved fan_id, deleted_at IS NULL'
      );

      // ASSERT 5 — exactly one identifier_link row for (type, value, org_id)
      const ilCount = await c2.query(
        `SELECT COUNT(*) FROM identifier_link
         WHERE identifier_type = $1 AND identifier_value = $2 AND org_id = $3`,
        [t2Type, t2Value, testOrgId]
      );
      assert(
        parseInt(ilCount.rows[0].count, 10) === 1,
        'assertion 5 — exactly one identifier_link row for that (type, value, org_id)'
      );

      // ASSERT 6 — neither call threw a ResolverError (both results are non-null objects
      // with a fan_id — checked above; confirm match_type shape here)
      assert(
        result1.match_type != null && result2.match_type != null &&
        !result1.fan_id.includes('error') && !result2.fan_id.includes('error'),
        'assertion 6 — neither caller received a ResolverError (both have match_type)'
      );

      // ASSERT 7 — two success resolution audit rows, zero error audit rows
      // Aaron addition: status='success' verified on both rows, not just count.
      const auditRows = await c2.query(
        `SELECT status FROM audit_log
         WHERE org_id = $1 AND event_type = 'resolution'
           AND identifier_type = $2`,
        [testOrgId, t2Type]
      );
      // Filter to this test's identifier only (org has no other resolution rows
      // but be precise in case of prior test data from the same run)
      const auditForIdentifier = await c2.query(
        `SELECT status FROM audit_log
         WHERE org_id = $1 AND event_type = 'resolution'
           AND idempotency_key IN ($2, $3)`,
        [testOrgId, t2Key1, t2Key2]
      );
      const successCount = auditForIdentifier.rows.filter(r => r.status === 'success').length;
      const errorCount   = auditForIdentifier.rows.filter(r => r.status === 'error').length;

      assert(
        successCount === 2,
        `assertion 7a — exactly 2 success resolution audit rows (got ${successCount})`
      );
      assert(
        errorCount === 0,
        `assertion 7b — zero error resolution audit rows (got ${errorCount})`
      );
    } finally {
      c2.release();
    }

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
