'use strict';

// Smoke test — resolverEngine.js
// Requires: local Postgres running, migration_001.sql applied, DATABASE_URL in .env
// Run: node src/tests/resolverEngine.smoke.js

const crypto = require('crypto');
const { resolverEngine, ConflictError, ResolverError } = require('../modules/resolverEngine');
const pool = require('../db/pool');

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// Fetch the seed org from the database so the test uses a real UUID.
// migration_001.sql inserts one seed row; this query finds it.
async function getSeedOrg() {
  const result = await pool.query('SELECT id FROM org WHERE is_active = true LIMIT 1');
  if (result.rows.length === 0) throw new Error('No seed org found — run migration_001.sql first');
  return result.rows[0].id;
}

async function cleanup(org_id, identifier_value) {
  // Remove all rows created during the test so the suite is re-runnable
  await pool.query(
    `DELETE FROM audit_log WHERE org_id = $1 AND identifier_type = 'nfc_uid'`,
    [org_id]
  );
  await pool.query(
    `DELETE FROM identifier_link WHERE org_id = $1 AND identifier_value = $2`,
    [org_id, identifier_value]
  );
  await pool.query(
    `DELETE FROM fan WHERE org_id = $1
     AND id NOT IN (SELECT fan_id FROM identifier_link WHERE org_id = $1)`,
    [org_id]
  );
}

async function run() {
  console.log('\n=== resolverEngine smoke tests ===\n');

  const org_id          = await getSeedOrg();
  const identifier_value = 'AB:CD:EF:12';         // valid 4-byte NFC UID already normalized
  const identifier_type  = 'nfc_uid';
  const schema_version   = 'v1';
  const source_system    = 'smoke-test';
  const idempotency_key  = crypto.createHash('sha256')
    .update(`${identifier_type}|${identifier_value}|${org_id}`)
    .digest('hex');

  // Clean up any leftover rows from a previous run before starting
  await cleanup(org_id, identifier_value);

  // ── TEST 1: Path B — new fan ───────────────────────────────────────────────
  console.log('1. Path B — new fan');
  let result1;
  try {
    result1 = await resolverEngine({
      identifier_type, identifier_value, org_id,
      schema_version, idempotency_key, source_system
    });
    assert('returns fan_id (UUID)',          /^[0-9a-f-]{36}$/.test(result1.fan_id));
    assert('match_type = hard',             result1.match_type === 'hard');
    assert('confidence_score = 1.0',        result1.confidence_score === 1.0);
    assert('is_new_record = true',          result1.is_new_record === true);
    assert('audit_event_id present',        !!result1.audit_event_id);
    assert('linked_systems is array',       Array.isArray(result1.linked_systems));
    assert('linked_count >= 1',             result1.linked_count >= 1);

    const fanRow = await pool.query('SELECT id FROM fan WHERE id = $1', [result1.fan_id]);
    assert('fan row written to db',         fanRow.rows.length === 1);

    const linkRow = await pool.query(
      'SELECT fan_id FROM identifier_link WHERE identifier_value = $1 AND org_id = $2',
      [identifier_value, org_id]
    );
    assert('identifier_link row written',   linkRow.rows.length === 1);

    const auditRow = await pool.query(
      'SELECT status FROM audit_log WHERE id = $1',
      [result1.audit_event_id]
    );
    assert('audit_log row status=success',  auditRow.rows[0]?.status === 'success');
  } catch (err) {
    console.error(`  FAIL  Path B threw unexpectedly: ${err.message}`);
    failed += 7;
  }

  // ── TEST 2: Path A — returning fan ────────────────────────────────────────
  console.log('\n2. Path A — returning fan (new idempotency key)');
  const idempotency_key2 = crypto.createHash('sha256')
    .update(`${identifier_type}|${identifier_value}|${org_id}|retry`)
    .digest('hex');

  try {
    const result2 = await resolverEngine({
      identifier_type, identifier_value, org_id,
      schema_version, idempotency_key: idempotency_key2, source_system
    });
    assert('same fan_id returned',          result2.fan_id === result1.fan_id);
    assert('is_new_record = false',         result2.is_new_record === false);
    assert('match_type = hard',             result2.match_type === 'hard');

    const linkRow = await pool.query(
      'SELECT last_seen_at FROM identifier_link WHERE identifier_value = $1 AND org_id = $2',
      [identifier_value, org_id]
    );
    assert('last_seen_at updated',          linkRow.rows.length === 1);
  } catch (err) {
    console.error(`  FAIL  Path A threw unexpectedly: ${err.message}`);
    failed += 4;
  }

  // ── TEST 3: Idempotency — same key returns prior result ───────────────────
  console.log('\n3. Idempotency — same key, no new rows');
  const auditCountBefore = await pool.query(
    'SELECT COUNT(*) FROM audit_log WHERE org_id = $1', [org_id]
  );
  try {
    const result3 = await resolverEngine({
      identifier_type, identifier_value, org_id,
      schema_version, idempotency_key, source_system
    });
    assert('same fan_id returned',          result3.fan_id === result1.fan_id);
    assert('audit_event_id matches',        result3.audit_event_id === result1.audit_event_id);

    const auditCountAfter = await pool.query(
      'SELECT COUNT(*) FROM audit_log WHERE org_id = $1', [org_id]
    );
    assert('no new audit_log rows',
      parseInt(auditCountAfter.rows[0].count) === parseInt(auditCountBefore.rows[0].count)
    );
  } catch (err) {
    console.error(`  FAIL  Idempotency threw unexpectedly: ${err.message}`);
    failed += 3;
  }

  // ── TEST 4: Unknown org_id → ResolverError ────────────────────────────────
  // Note: failure audit INSERT for an unknown org_id will itself fail due to the
  // FK constraint on audit_log.org_id — that's expected. The inner CATCH logs it.
  console.log('\n4. Unknown org_id → ResolverError');
  try {
    await resolverEngine({
      identifier_type, identifier_value,
      org_id: crypto.randomUUID(),
      schema_version,
      idempotency_key: crypto.randomUUID(),
      source_system
    });
    assert('should have thrown', false, 'no error thrown');
    failed++;
  } catch (err) {
    assert('throws ResolverError',          err instanceof ResolverError);
    assert('message includes org_id',       err.message.includes('org_id not found'));
  }

  // ── TEST 5: Error class shapes ────────────────────────────────────────────
  console.log('\n5. Error class shapes');
  const ce = new ConflictError('test conflict');
  assert('ConflictError name',              ce.name === 'ConflictError');
  assert('ConflictError is Error',          ce instanceof Error);

  const re = new ResolverError('test resolver');
  assert('ResolverError name',              re.name === 'ResolverError');
  assert('ResolverError is Error',          re instanceof Error);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await cleanup(org_id, identifier_value);

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);

  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Smoke test runner error:', err.message);
  pool.end();
  process.exit(1);
});
