'use strict';
// tests/resolverEngine.eligibilityGate.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/resolverEngine.eligibilityGate.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to localhost:5432
//   migration_005.sql run  (name, zip, and other new identifier types in CHECK constraint)
//   FIRESTORE_PROJECT_ID may be unset — resolverEngine catches Firestore failure
//
// Proves passesSignalEligibilityGate() correctly gates scoreMatch():
//
//   TEST 1 — name_alone only (1 weak):   gate FAILS → PATH B
//   TEST 2 — name_plus_zip + name_alone (2 weak): gate PASSES → PATH D
//             score math: 0.6*0.8 + 0.3*0.8 = 0.48 + 0.24 = 0.72
//             (both signals at 8-month recency → multiplier 0.8)
//   TEST 3 — email_similarity (1 strong): gate PASSES → PATH D
//   TEST 4 — rich candidate, inbound carries name only (1 weak): gate FAILS → PATH B
//             confirms gate inspects the INBOUND side, not just the candidate side
//
// Primary identifier for tests 1, 2, 4 is nfc_uid (avoids Path A hard-match
// collision — the seeded fans carry name/zip identifiers, not nfc_uid).
// Signal fields flow through the `identifiers` extra object.

require('dotenv').config();

// ── Safety guard — must run before pool or resolverEngine are loaded ──────────
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
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocalHost || port === '5433') {
    console.error('BLOCKED: DATABASE_URL does not point to local Postgres on port 5432.');
    console.error(`  host: ${host}  port: ${port}`);
    console.error('  This test must never run against Cloud SQL (port 5433) or a remote host.');
    process.exit(1);
  }
}());
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const pool   = require('../src/db/pool');
const { resolverEngine } = require('../src/modules/resolverEngine');

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED — ${message}`);
  console.log(`  PASS  ${message}`);
}

function assertBetween(value, low, high, message) {
  if (value < low || value > high) {
    throw new Error(
      `ASSERT FAILED — ${message}\n` +
      `  expected between ${low} and ${high}, got ${value}`
    );
  }
  console.log(`  PASS  ${message}  (${value})`);
}

async function seedFan(client, fanId, orgId) {
  await client.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [fanId, orgId]
  );
}

async function seedIdentifier(client, fanId, type, value, orgId) {
  await client.query(
    `INSERT INTO identifier_link
       (fan_id, identifier_type, identifier_value, org_id,
        source_system, schema_version, confidence_score,
        first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, 'test', 'v1', 1.0, NOW(), NOW())`,
    [fanId, type, value, orgId]
  );
}

async function run() {
  const testOrgId     = crypto.randomUUID();
  const orgApiKeyHash = crypto.createHash('sha256').update(testOrgId).digest('hex');

  console.log('\nresolverEngine eligibility gate — smoke test');
  console.log('=============================================');
  console.log(`testOrgId: ${testOrgId}`);

  const client = await pool.connect();

  try {

    // ── SETUP ────────────────────────────────────────────────────────────────

    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash) VALUES ($1, '_smoke_gate_test', $2)`,
      [testOrgId, orgApiKeyHash]
    );

    // Session-scoped RLS context — persists across the BEGIN/COMMIT that
    // resolverEngine runs internally. Matches rlsContextMiddleware exactly.
    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`,
      [testOrgId]
    );

    // ─── TEST 1 ───────────────────────────────────────────────────────────────
    // Candidate has name only → name_alone = 1 weak signal → gate FAILS → PATH B.
    // inbound primary is nfc_uid so Path A hard-match never finds the seeded fan.
    console.log('\n── TEST 1: name_alone only (1 weak) — gate FAILS → PATH B');

    const t1FanId = crypto.randomUUID();
    await seedFan(client, t1FanId, testOrgId);
    await seedIdentifier(client, t1FanId, 'name', 'Gate Test Name One', testOrgId);

    const t1 = await resolverEngine({
      identifier_type:  'nfc_uid',
      identifier_value: 'F1:11:11:11',
      org_id:           testOrgId,
      schema_version:   'v1',
      source_system:    'synthetic_test',
      idempotency_key:  crypto.randomUUID(),
      identifiers:      { name: 'Gate Test Name One' },
    }, client);

    console.log(`  result: match_type=${t1.match_type} is_new_record=${t1.is_new_record} conflict_id=${t1.conflict_id}`);

    // 1. PATH B fired — gate rejected the name_alone-only candidate.
    assert(
      t1.match_type === 'hard' && t1.is_new_record === true,
      '1. PATH B — match_type=hard, is_new_record=true (gate blocked name_alone-only candidate)'
    );

    // 2. Zero conflict_queue rows — gate prevented PATH D from considering this candidate.
    const t1ConflictCount = await client.query(
      `SELECT COUNT(*) AS cnt FROM conflict_queue WHERE org_id = $1`,
      [testOrgId]
    );
    assert(
      parseInt(t1ConflictCount.rows[0].cnt, 10) === 0,
      '2. zero conflict_queue rows (gate prevented PATH D)'
    );

    // ─── TEST 2 ───────────────────────────────────────────────────────────────
    // Candidate has name + zip, both 8 months old.
    // Inbound carries name + zip → name_plus_zip (1 weak) + name_alone (2 weak) → gate PASSES.
    // Score: name_plus_zip(0.6*0.8=0.48) + name_alone(0.3*0.8=0.24) = 0.72 → PATH D.
    console.log('\n── TEST 2: name_plus_zip + name_alone (2 weak) — gate PASSES → PATH D');

    const t2FanId = crypto.randomUUID();
    await seedFan(client, t2FanId, testOrgId);
    // Both identifiers share the same recency bucket: 8 months → multiplier 0.8.
    // name_plus_zip signal uses candidate.name_last_seen_at for recency.
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, 'name', 'Weak Combo Fan', $2, 'test', 'v1', 1.0,
               NOW() - INTERVAL '8 months', NOW() - INTERVAL '8 months')`,
      [t2FanId, testOrgId]
    );
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, 'zip', '73102', $2, 'test', 'v1', 1.0,
               NOW() - INTERVAL '8 months', NOW() - INTERVAL '8 months')`,
      [t2FanId, testOrgId]
    );

    const t2 = await resolverEngine({
      identifier_type:  'nfc_uid',
      identifier_value: 'F2:22:22:22',
      org_id:           testOrgId,
      schema_version:   'v1',
      source_system:    'synthetic_test',
      idempotency_key:  crypto.randomUUID(),
      identifiers:      { name: 'Weak Combo Fan', zip: '73102' },
    }, client);

    console.log(`  result: match_type=${t2.match_type} confidence=${t2.confidence_score} conflict_id=${t2.conflict_id}`);

    // 3. PATH D fired — gate passed on 2 weak signals, scoreMatch ran.
    assert(
      t2.match_type === 'conflict',
      '3. PATH D — match_type=conflict (gate passed on name_plus_zip + name_alone)'
    );

    // 4. Conflict queue row exists for t2.
    const t2ConflictRows = await client.query(
      `SELECT signals_matched FROM conflict_queue WHERE id = $1`,
      [t2.conflict_id]
    );
    assert(
      t2ConflictRows.rows.length === 1,
      '4. conflict_queue row exists for t2.conflict_id'
    );

    // 5. signals_matched contains name_plus_zip.
    const t2Signals = t2ConflictRows.rows[0].signals_matched;
    assert(
      t2Signals.some(s => s.signal === 'name_plus_zip'),
      '5. signals_matched contains name_plus_zip'
    );

    // 6. signals_matched contains name_alone.
    assert(
      t2Signals.some(s => s.signal === 'name_alone'),
      '6. signals_matched contains name_alone'
    );

    // 7. confidence_score ≈ 0.72 (0.6*0.8 + 0.3*0.8).
    assertBetween(
      t2.confidence_score,
      0.71,
      0.73,
      '7. confidence_score between 0.71 and 0.73 (expect 0.72)'
    );

    // ─── TEST 3 ───────────────────────────────────────────────────────────────
    // Candidate has email only → email_similarity = 1 strong signal → gate PASSES.
    // Inbound email has a one-char typo: 'str0ng' vs 'strong'.
    // levenshtein = 1, max = 21, similarity ≈ 0.952 ≥ 0.8 → fires → score 0.70 → PATH D.
    console.log('\n── TEST 3: email_similarity (1 strong) — gate PASSES → PATH D');

    const t3FanId = crypto.randomUUID();
    await seedFan(client, t3FanId, testOrgId);
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, 'email', 'strong@test-synth.com', $2, 'test', 'v1', 1.0, NOW(), NOW())`,
      [t3FanId, testOrgId]
    );

    const t3 = await resolverEngine({
      identifier_type:  'email',
      identifier_value: 'str0ng@test-synth.com',
      org_id:           testOrgId,
      schema_version:   'v1',
      source_system:    'synthetic_test',
      idempotency_key:  crypto.randomUUID(),
      identifiers:      null,
    }, client);

    console.log(`  result: match_type=${t3.match_type} confidence=${t3.confidence_score} conflict_id=${t3.conflict_id}`);

    // 8. PATH D fired — gate passed on 1 strong signal.
    assert(
      t3.match_type === 'conflict',
      '8. PATH D — match_type=conflict (gate passed on email_similarity strong signal)'
    );

    // 9. Conflict queue row exists for t3.
    const t3ConflictRows = await client.query(
      `SELECT signals_matched FROM conflict_queue WHERE id = $1`,
      [t3.conflict_id]
    );
    assert(
      t3ConflictRows.rows.length === 1,
      '9. conflict_queue row exists for t3.conflict_id'
    );

    // 10. signals_matched contains email_similarity.
    assert(
      t3ConflictRows.rows[0].signals_matched.some(s => s.signal === 'email_similarity'),
      '10. signals_matched contains email_similarity'
    );

    // ─── TEST 4 ───────────────────────────────────────────────────────────────
    // Candidate has name + zip (rich data), but inbound carries only name.
    // Gate inspects the INBOUND side: zip absent in inbound → name_plus_zip can't fire.
    // name_alone is the only possible signal (1 weak) → gate FAILS → PATH B.
    console.log('\n── TEST 4: rich candidate, inbound name-only (1 weak) — gate FAILS → PATH B');

    const t4FanId = crypto.randomUUID();
    await seedFan(client, t4FanId, testOrgId);
    await seedIdentifier(client, t4FanId, 'name', 'Boundary Test Fan', testOrgId);
    await seedIdentifier(client, t4FanId, 'zip',  '73104',             testOrgId);

    const t4 = await resolverEngine({
      identifier_type:  'nfc_uid',
      identifier_value: 'F4:44:44:44',
      org_id:           testOrgId,
      schema_version:   'v1',
      source_system:    'synthetic_test',
      idempotency_key:  crypto.randomUUID(),
      identifiers:      { name: 'Boundary Test Fan' },
      // no zip in identifiers — inbound.zip = null → name_plus_zip can't fire
      // only name_alone possible (1 weak) → gate fails even though candidate has zip
    }, client);

    console.log(`  result: match_type=${t4.match_type} is_new_record=${t4.is_new_record} conflict_id=${t4.conflict_id}`);

    // 11. PATH B fired — gate failed because inbound had only 1 weak signal possible.
    assert(
      t4.match_type === 'hard' && t4.is_new_record === true,
      '11. PATH B — match_type=hard, is_new_record=true (gate blocked: inbound has name_alone only = 1 weak)'
    );

    // 12. Total conflict_queue rows still 2 — t2 and t3 only, no t4 row added.
    const finalConflictCount = await client.query(
      `SELECT COUNT(*) AS cnt FROM conflict_queue WHERE org_id = $1`,
      [testOrgId]
    );
    assert(
      parseInt(finalConflictCount.rows[0].cnt, 10) === 2,
      '12. total conflict_queue rows = 2 (t2 + t3 only — t4 gate failure added no new row)'
    );

    console.log('\n  All 12 assertions passed.\n');

  } finally {

    // ── CLEANUP ──────────────────────────────────────────────────────────────
    // FK order: staging_household_data → conflict_queue → audit_log →
    //           identifier_link → fan → org
    console.log('Cleaning up test data...');
    try {
      await client.query(
        `SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]
      );
      await client.query(
        `DELETE FROM staging_household_data WHERE org_id = $1`, [testOrgId]
      );
      await client.query(
        `DELETE FROM conflict_queue         WHERE org_id = $1`, [testOrgId]
      );
      await client.query(
        `DELETE FROM audit_log              WHERE org_id = $1`, [testOrgId]
      );
      await client.query(
        `DELETE FROM identifier_link        WHERE org_id = $1`, [testOrgId]
      );
      await client.query(
        `DELETE FROM fan                    WHERE org_id = $1`, [testOrgId]
      );
      await client.query(
        `DELETE FROM org                    WHERE id = $1`,     [testOrgId]
      );
      console.log('Cleanup complete.\n');
    } catch (cleanupErr) {
      console.error('Cleanup error — test rows may remain:', cleanupErr.message);
      console.error(
        `  Manual cleanup: DELETE FROM org WHERE id = '${testOrgId}';`
      );
    }

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
