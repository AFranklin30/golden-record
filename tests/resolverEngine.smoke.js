'use strict';
// tests/resolverEngine.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/resolverEngine.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to your local Postgres instance
//   migration_005.sql run  (staging_household_data, household tables)
//   migration_006.sql run  (RLS on Sprint 3 tables)
//   FIRESTORE_PROJECT_ID may be unset — resolverEngine catches any
//   Firestore failure and logs it without throwing.
//
// Proves:
//   PATH D fires correctly for a soft email match (0.60 <= score < 0.85)
//   guardian_email soft-link side-channel does NOT write to
//   staging_household_data when guardian_email is absent from the inbound.
//
// Score math (verified before writing):
//   seeded:  'aaron.franklin@test-synth.com'  (29 chars)
//   inbound: 'aron.franklin@test-synth.com'   (28 chars, one 'a' removed)
//   levenshteinDistance = 1, maxLength = 29
//   similarity = 28/29 approx 0.9655 — exceeds 0.8 threshold
//   last_seen_at = NOW() -> monthsBetween approx 0 -> recency multiplier = 1.0
//   adjusted_score = 0.7 * 1.0 = 0.70
//   THRESHOLD_PATH_D = 0.60 <= 0.70 < 0.85 = THRESHOLD_PATH_C -> Path D fires

require('dotenv').config();

// ── Safety guard — must run before pool or resolverEngine are loaded ──────────
// This test must NEVER run against Cloud SQL. The Cloud SQL Auth Proxy uses
// port 5433. Local Postgres uses port 5432. Any non-localhost host is also
// rejected. Exit immediately if either condition is detected.
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
    console.error('  Update .env to point to localhost:5432 before running.');
    process.exit(1);
  }
}());
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const pool   = require('../src/db/pool');
const { resolverEngine } = require('../src/modules/resolverEngine');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function runPathD() {
  const testOrgId      = crypto.randomUUID();
  const existingFanId  = crypto.randomUUID();
  // Fresh UUID each run — no idempotency cache hit from a prior run.
  const idempotencyKey = crypto.randomUUID();

  // sha256(testOrgId) -> 64 hex chars, satisfies org_api_key_hash constraint.
  const orgApiKeyHash = crypto
    .createHash('sha256')
    .update(testOrgId)
    .digest('hex');

  console.log('\nresolverEngine Path D — smoke test');
  console.log('====================================');
  console.log(`testOrgId:      ${testOrgId}`);
  console.log(`existingFanId:  ${existingFanId}`);
  console.log(`idempotencyKey: ${idempotencyKey}`);

  const client = await pool.connect();

  try {

    // ── SETUP ────────────────────────────────────────────────────────────────

    // Org is inserted BEFORE the RLS context is set.
    // Org is the auth table — it is not subject to the tenant_isolation policy
    // that guards fan/identifier_link. Matches migration_006 DO $$ pattern.
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash)
       VALUES ($1, '_smoke_pathd_test', $2)`,
      [testOrgId, orgApiKeyHash]
    );

    // Set RLS context — is_local = false means session-scoped, not local to
    // the current transaction. Persists across the BEGIN/COMMIT that
    // resolverEngine runs internally. Matches rlsContextMiddleware exactly.
    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`,
      [testOrgId]
    );

    // Seed the existing fan this inbound will be matched against.
    await client.query(
      `INSERT INTO fan
         (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [existingFanId, testOrgId]
    );

    // Seed name + dob identifiers so name_plus_dob fires (score 0.70 → PATH D).
    // Sprint 5 changed email comparison to EXACT, so near-miss email no longer
    // fires email_similarity. name_plus_dob is the correct PATH D signal now.
    // last_seen_at = NOW() guarantees recency multiplier = 1.0.
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, 'name', 'Aaron Test', $2,
               'thunder_app', 'v1', 1.0, NOW(), NOW())`,
      [existingFanId, testOrgId]
    );
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, 'dob', '1990-03-15', $2,
               'thunder_app', 'v1', 1.0, NOW(), NOW())`,
      [existingFanId, testOrgId]
    );

    console.log('\nSetup complete — org, fan, identifier_link seeded (name + dob).');

    // ── CALL ─────────────────────────────────────────────────────────────────

    // Pass the client directly as db. resolverEngine calls client.query()
    // internally and runs its own BEGIN/COMMIT on this connection.
    // The session-scoped RLS context survives those transaction boundaries.
    //
    // identifier_type='email', identifier_value novel — PATH A skips (no match
    // in identifier_link). identifiers.name + identifiers.dob populate inbound.
    // name_plus_dob fires: 'aaron test' fuzzy ≥ 0.85, dob exact → 0.7 × 1.0 = 0.70.
    // No email in candidate → no email conflict penalty.
    // 0.60 ≤ 0.70 < 0.85 → Path D.
    console.log('\nCalling resolverEngine (Path D inbound)...');
    const result = await resolverEngine(
      {
        identifier_type:  'email',
        identifier_value: 'pathd.novel@test-synth.com',
        identifiers: {
          name: 'Aaron Test',
          dob:  '1990-03-15',
        },
        org_id:           testOrgId,
        schema_version:   'v1',
        source_system:    'synthetic_test',
        idempotency_key:  idempotencyKey,
      },
      client
    );

    console.log('\nResult:', JSON.stringify(result, null, 2));
    console.log('\nAssertions:');

    // ── ASSERT ───────────────────────────────────────────────────────────────

    // 1 — Path D sets match_type = 'conflict'
    assert(result.match_type === 'conflict',
      '1. result.match_type === "conflict"');

    // 2 — confidence_score = 0.7 * 1.0 = 0.70
    assertBetween(result.confidence_score, 0.69, 0.71,
      '2. result.confidence_score in [0.69, 0.71]');

    // 3 — Path D always creates a new fan record
    assert(result.is_new_record === true,
      '3. result.is_new_record === true');

    // 4 — conflict_id is a non-null UUID (conflict_queue row was written)
    assert(result.conflict_id !== null,
      '4. result.conflict_id is non-null');
    assert(UUID_RE.test(result.conflict_id),
      '4. result.conflict_id matches UUID format');

    // 5 — conflict_queue: exactly one pending row, fan_id_a = existingFanId
    const conflictRows = await client.query(
      `SELECT fan_id_a, fan_id_b, status, signals_matched
       FROM conflict_queue
       WHERE id = $1`,
      [result.conflict_id]
    );
    assert(conflictRows.rows.length === 1,
      '5. exactly one conflict_queue row for result.conflict_id');
    assert(conflictRows.rows[0].status === 'pending',
      '5. conflict_queue.status === "pending"');
    assert(conflictRows.rows[0].fan_id_a === existingFanId,
      '5. conflict_queue.fan_id_a === existingFanId');

    // 6 — signals_matched JSONB: exactly one entry, signal = 'name_plus_dob'.
    //     name_plus_dob is a strong signal; nameCountedInCompositeSignal suppresses
    //     name_alone so no double-count occurs. One signal, one entry.
    //     pg parses JSONB columns into JS objects automatically.
    const signals = conflictRows.rows[0].signals_matched;
    assert(Array.isArray(signals),
      '6. signals_matched is an array');
    assert(signals.length === 1,
      '6. signals_matched contains exactly one entry');
    assert(signals[0].signal === 'name_plus_dob',
      '6. signals_matched[0].signal === "name_plus_dob"');

    // 7 — new fan row exists, stewardship_tier = 'platform', id != existingFanId
    const newFanRows = await client.query(
      `SELECT id, stewardship_tier
       FROM fan
       WHERE id = $1 AND org_id = $2`,
      [result.fan_id, testOrgId]
    );
    assert(newFanRows.rows.length === 1,
      '7. new fan row exists for result.fan_id');
    assert(newFanRows.rows[0].stewardship_tier === 'platform',
      '7. new fan.stewardship_tier === "platform"');
    assert(newFanRows.rows[0].id !== existingFanId,
      '7. new fan.id !== existingFanId');

    // 8 — new identifier_link row: inbound email (the PATH D identifier_type/value),
    //     confidence_score = bestScore (name_plus_dob ≈ 0.70).
    //     pg returns NUMERIC columns as strings — parseFloat before comparing.
    const newLinkRows = await client.query(
      `SELECT confidence_score
       FROM identifier_link
       WHERE fan_id         = $1
         AND org_id         = $2
         AND identifier_type  = 'email'
         AND identifier_value = 'pathd.novel@test-synth.com'`,
      [result.fan_id, testOrgId]
    );
    assert(newLinkRows.rows.length === 1,
      '8. exactly one new identifier_link row for the inbound identifier');
    assertBetween(parseFloat(newLinkRows.rows[0].confidence_score), 0.65, 0.75,
      '8. new identifier_link.confidence_score in [0.65, 0.75]');

    // 9 — zero rows in staging_household_data for testOrgId.
    //     Confirms the guardian_email signal did not fire and the soft-link
    //     detection block was correctly skipped.
    //     Requires migration_005.sql to have been run.
    const stagingRows = await client.query(
      `SELECT COUNT(*) AS row_count
       FROM staging_household_data
       WHERE org_id = $1`,
      [testOrgId]
    );
    assert(parseInt(stagingRows.rows[0].row_count, 10) === 0,
      '9. zero staging_household_data rows — guardian_email side-channel absent');

    // 10 — audit_log: exactly one row, match_type = 'conflict', identifier_type = 'email'
    const auditRows = await client.query(
      `SELECT match_type, identifier_type
       FROM audit_log
       WHERE idempotency_key = $1 AND org_id = $2`,
      [idempotencyKey, testOrgId]
    );
    assert(auditRows.rows.length === 1,
      '10. exactly one audit_log row for this idempotency key');
    assert(auditRows.rows[0].match_type === 'conflict',
      '10. audit_log.match_type === "conflict"');
    assert(auditRows.rows[0].identifier_type === 'email',
      '10. audit_log.identifier_type === "email"');

    console.log('\n  All 10 assertions passed.\n');

  } finally {

    // ── CLEANUP ──────────────────────────────────────────────────────────────
    //
    // conflict_queue: left — resolution_trace.conflict_id FK pins it (append-only).
    // audit_log: left — append-only + pinned by resolution_trace.
    // fan / org: pinned by resolution_trace (resulting_fan_id, org_id FKs).
    //   Attempted below; failure caught per-statement and noted.
    // identifier_link + staging_household_data: NOT referenced by trace — deleted.
    console.log('Cleaning up test data...');
    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]
    );
    try {
      await client.query(
        `DELETE FROM staging_household_data WHERE org_id = $1`, [testOrgId]
      );
      await client.query(
        `DELETE FROM identifier_link        WHERE org_id = $1`, [testOrgId]
      );
    } catch (cleanupErr) {
      console.error('Cleanup error (identifier_link/staging):', cleanupErr.message);
    }
    try {
      await client.query(`DELETE FROM fan WHERE org_id = $1`, [testOrgId]);
    } catch {
      console.log(`  Note: fan rows for org ${testOrgId} pinned by resolution_trace — left as inert.`);
    }
    try {
      await client.query(`DELETE FROM org WHERE id = $1`, [testOrgId]);
    } catch {
      console.log(`  Note: org ${testOrgId} pinned by resolution_trace — left as inert.`);
    }
    console.log('Cleanup complete (conflict_queue + audit_log left intentionally).\n');

    client.release();
  }
}

async function runPathA() {
  const testOrgId      = crypto.randomUUID();
  const existingFanId  = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();

  const orgApiKeyHash = crypto
    .createHash('sha256')
    .update(testOrgId)
    .digest('hex');

  console.log('\nresolverEngine Path A — smoke test');
  console.log('====================================');
  console.log(`testOrgId:      ${testOrgId}`);
  console.log(`existingFanId:  ${existingFanId}`);
  console.log(`idempotencyKey: ${idempotencyKey}`);

  const client = await pool.connect();

  try {

    // ── SETUP ────────────────────────────────────────────────────────────────

    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash)
       VALUES ($1, '_smoke_patha_test', $2)`,
      [testOrgId, orgApiKeyHash]
    );

    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`,
      [testOrgId]
    );

    await client.query(
      `INSERT INTO fan
         (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [existingFanId, testOrgId]
    );

    // last_seen_at 30 days ago — deliberately stale so the PATH A UPDATE to
    // NOW() is detectable in assertion 9.
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, 'email', 'returning.fan@test-synth.com', $2,
               'thunder_app', 'v1', 1.0,
               NOW() - INTERVAL '30 days',
               NOW() - INTERVAL '30 days')`,
      [existingFanId, testOrgId]
    );

    console.log('\nSetup complete — org, fan, identifier_link seeded (last_seen_at 30 days stale).');

    // ── CALL ─────────────────────────────────────────────────────────────────

    // Exact identifier match → PATH A fires immediately.
    // resolverEngine finds the row in identifier_link, returns existingFanId,
    // and issues UPDATE identifier_link SET last_seen_at = NOW().
    // Probabilistic matching never runs.
    console.log('\nCalling resolverEngine (Path A inbound — exact email match)...');
    const result = await resolverEngine(
      {
        identifier_type:  'email',
        identifier_value: 'returning.fan@test-synth.com',
        org_id:           testOrgId,
        schema_version:   'v1',
        source_system:    'synthetic_test',
        idempotency_key:  idempotencyKey,
      },
      client
    );

    console.log('\nResult:', JSON.stringify(result, null, 2));
    console.log('\nAssertions:');

    // ── ASSERT ───────────────────────────────────────────────────────────────

    // 1 — PATH A sets match_type = 'hard'
    assert(result.match_type === 'hard',
      '1. result.match_type === "hard"');

    // 2 — PATH A always returns confidence_score = 1.0
    assert(result.confidence_score === 1.0,
      '2. result.confidence_score === 1.0');

    // 3 — existing fan, not a new record
    assert(result.is_new_record === false,
      '3. result.is_new_record === false');

    // 4 — no conflict_queue row written on PATH A
    assert(result.conflict_id === null,
      '4. result.conflict_id === null');

    // 5 — same fan recognised, not a new one
    assert(result.fan_id === existingFanId,
      '5. result.fan_id === existingFanId');

    // 6 — zero new fan rows (only the seeded one)
    const fanCount = await client.query(
      `SELECT COUNT(*) AS row_count FROM fan WHERE org_id = $1`,
      [testOrgId]
    );
    assert(parseInt(fanCount.rows[0].row_count, 10) === 1,
      '6. exactly one fan row for testOrgId — no new fan created');

    // 7 — zero conflict_queue rows (PATH A never writes a conflict)
    const conflictCount = await client.query(
      `SELECT COUNT(*) AS row_count FROM conflict_queue WHERE org_id = $1`,
      [testOrgId]
    );
    assert(parseInt(conflictCount.rows[0].row_count, 10) === 0,
      '7. zero conflict_queue rows for testOrgId');

    // 8 — zero new identifier_link rows (hard match never creates a new link)
    const linkCount = await client.query(
      `SELECT COUNT(*) AS row_count FROM identifier_link WHERE org_id = $1`,
      [testOrgId]
    );
    assert(parseInt(linkCount.rows[0].row_count, 10) === 1,
      '8. exactly one identifier_link row for testOrgId — no new link created');

    // 9 — last_seen_at updated to within the last 60 seconds.
    //     Core behavioral proof: the PATH A UPDATE ran.
    //     Seeded value was 30 days ago — any value >= 60s old means the UPDATE
    //     did not fire.
    const linkRow = await client.query(
      `SELECT last_seen_at FROM identifier_link
       WHERE fan_id           = $1
         AND identifier_type  = 'email'
         AND identifier_value = 'returning.fan@test-synth.com'
         AND org_id           = $2`,
      [existingFanId, testOrgId]
    );
    assert(linkRow.rows.length === 1,
      '9. identifier_link row found for last_seen_at check');
    const lastSeenAt = new Date(linkRow.rows[0].last_seen_at);
    const ageMs      = Date.now() - lastSeenAt.getTime();
    assert(ageMs >= 0 && ageMs < 60000,
      `9. identifier_link last_seen_at updated within last 60 seconds (age: ${ageMs}ms)`);

    // 10 — audit_log: exactly one row, match_type = 'hard', is_new_record = false
    const auditRows = await client.query(
      `SELECT match_type, is_new_record FROM audit_log
       WHERE idempotency_key = $1 AND org_id = $2`,
      [idempotencyKey, testOrgId]
    );
    assert(auditRows.rows.length === 1,
      '10. exactly one audit_log row for this idempotency key');
    assert(auditRows.rows[0].match_type === 'hard',
      '10. audit_log.match_type === "hard"');
    assert(auditRows.rows[0].is_new_record === false,
      '10. audit_log.is_new_record === false');

    console.log('\n  All 10 assertions passed.\n');

  } finally {

    // ── CLEANUP ──────────────────────────────────────────────────────────────
    // conflict_queue: left — pinned by resolution_trace (append-only).
    // audit_log: left — append-only + pinned by resolution_trace.
    // fan / org: pinned by resolution_trace; attempted below, caught per-statement.
    // identifier_link + staging_household_data: deletable (not referenced by trace).
    console.log('Cleaning up test data...');
    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]
    );
    try {
      await client.query(
        `DELETE FROM staging_household_data WHERE org_id = $1`, [testOrgId]
      );
      await client.query(
        `DELETE FROM identifier_link        WHERE org_id = $1`, [testOrgId]
      );
    } catch (cleanupErr) {
      console.error('Cleanup error (identifier_link/staging):', cleanupErr.message);
    }
    try {
      await client.query(`DELETE FROM fan WHERE org_id = $1`, [testOrgId]);
    } catch {
      console.log(`  Note: fan rows for org ${testOrgId} pinned by resolution_trace — left as inert.`);
    }
    try {
      await client.query(`DELETE FROM org WHERE id = $1`, [testOrgId]);
    } catch {
      console.log(`  Note: org ${testOrgId} pinned by resolution_trace — left as inert.`);
    }
    console.log('Cleanup complete (conflict_queue + audit_log left intentionally).\n');

    client.release();
  }
}

async function runPathADeletedFan() {
  const testOrgId      = crypto.randomUUID();
  const deletedFanId   = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();

  const orgApiKeyHash = crypto
    .createHash('sha256')
    .update(testOrgId)
    .digest('hex');

  console.log('\nresolverEngine Path A (deleted fan) — smoke test');
  console.log('=================================================');
  console.log(`testOrgId:      ${testOrgId}`);
  console.log(`deletedFanId:   ${deletedFanId}`);
  console.log(`idempotencyKey: ${idempotencyKey}`);

  const client = await pool.connect();

  try {

    // ── SETUP ────────────────────────────────────────────────────────────────
    //
    // Seed a fan that was SOFT-DELETED (deleted_at = NOW()) with one
    // identifier_link row. Under the old PATH A query (no deleted_at check)
    // this identifier would fire a hard match and return the deleted fan.
    // Under the fixed query the JOIN filters it out and PATH B fires instead.

    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash)
       VALUES ($1, '_smoke_patha_deleted_test', $2)`,
      [testOrgId, orgApiKeyHash]
    );

    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`,
      [testOrgId]
    );

    // Fan is soft-deleted from the moment of creation.
    await client.query(
      `INSERT INTO fan
         (id, org_id, stewardship_tier, record_version,
          created_at, updated_at, deleted_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW(), NOW())`,
      [deletedFanId, testOrgId]
    );

    // Identifier seeded 30 days ago — if PATH A fires incorrectly, this row's
    // last_seen_at would be updated to NOW(). Assertion 6 catches that.
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, 'email', 'deleted.fan@test-synth.com', $2,
               'thunder_app', 'v1', 1.0,
               NOW() - INTERVAL '30 days',
               NOW() - INTERVAL '30 days')`,
      [deletedFanId, testOrgId]
    );

    console.log('\nSetup complete — org, DELETED fan, identifier_link seeded (last_seen_at 30 days stale).');

    // ── CALL ─────────────────────────────────────────────────────────────────
    //
    // identifier_type='nfc_uid' avoids both PATH A (no nfc_uid in identifier_link)
    // and the uq_identifier_per_org constraint (migration_013 prevents two rows
    // with the same email+org; using nfc_uid lets PATH B insert freely).
    // The deleted fan is excluded from the candidate pool (f.deleted_at IS NULL
    // filter), so PATH B fires with zero candidates.
    // The seeded email identifier_link for deletedFanId is untouched — assertion 6
    // confirms PATH A's UPDATE never ran against it (last_seen_at still 30d stale).
    console.log('\nCalling resolverEngine (novel nfc_uid — deleted fan excluded from pool, PATH B fires)...');
    const result = await resolverEngine(
      {
        identifier_type:  'nfc_uid',
        identifier_value: 'deleted-fan-test-nfc-001',
        org_id:           testOrgId,
        schema_version:   'v1',
        source_system:    'synthetic_test',
        idempotency_key:  idempotencyKey,
      },
      client
    );

    console.log('\nResult:', JSON.stringify(result, null, 2));
    console.log('\nAssertions:');

    // ── ASSERT ───────────────────────────────────────────────────────────────

    // 1 — A NEW fan was created, not the deleted one returned
    assert(result.fan_id !== deletedFanId,
      '1. result.fan_id !== deletedFanId  (PATH B created a new fan, not the deleted one)');

    // 2 — PATH B fired (new record)
    assert(result.is_new_record === true,
      '2. result.is_new_record === true  (PATH B fired, not PATH A)');

    // 3 — PATH B match_type is 'hard'
    assert(result.match_type === 'hard',
      '3. result.match_type === "hard"  (PATH B match_type)');

    // 4 — New fan row exists, deleted_at IS NULL (active record)
    const newFanRows = await client.query(
      `SELECT id, deleted_at
       FROM fan
       WHERE id = $1 AND org_id = $2`,
      [result.fan_id, testOrgId]
    );
    assert(newFanRows.rows.length === 1,
      '4. exactly one fan row for result.fan_id');
    assert(newFanRows.rows[0].deleted_at === null,
      '4. new fan.deleted_at IS NULL  (active record, not a ghost)');

    // 5 — New identifier_link row (nfc_uid) points to the NEW fan, not deletedFanId
    const newLinkRows = await client.query(
      `SELECT fan_id
       FROM identifier_link
       WHERE fan_id             = $1
         AND org_id             = $2
         AND identifier_type    = 'nfc_uid'
         AND identifier_value   = 'deleted-fan-test-nfc-001'`,
      [result.fan_id, testOrgId]
    );
    assert(newLinkRows.rows.length === 1,
      '5. exactly one nfc_uid identifier_link row points to new fan_id');
    assert(newLinkRows.rows[0].fan_id !== deletedFanId,
      '5. new identifier_link.fan_id !== deletedFanId');

    // 6 — Original identifier_link row for deletedFanId is untouched.
    //     PATH A's UPDATE last_seen_at = NOW() must NOT have run against it.
    //     Seeded value was 30 days ago — if age is < 60 seconds the UPDATE fired.
    const oldLinkRows = await client.query(
      `SELECT last_seen_at
       FROM identifier_link
       WHERE fan_id           = $1
         AND identifier_type  = 'email'
         AND identifier_value = 'deleted.fan@test-synth.com'`,
      [deletedFanId]
    );
    assert(oldLinkRows.rows.length === 1,
      '6. original identifier_link row for deletedFanId still exists');
    const oldAge = Date.now() - new Date(oldLinkRows.rows[0].last_seen_at).getTime();
    assert(oldAge > 29 * 24 * 60 * 60 * 1000,
      `6. original identifier_link.last_seen_at unchanged — still ~30 days old (age: ${Math.round(oldAge / 86400000)}d)`);

    // 7 — Zero conflict_queue rows — deleted fan's identifier is excluded from
    //     the candidate pool, so probabilistic scoring never compared the two
    //     and no conflict was written.
    const conflictCount = await client.query(
      `SELECT COUNT(*) AS row_count FROM conflict_queue WHERE org_id = $1`,
      [testOrgId]
    );
    assert(parseInt(conflictCount.rows[0].row_count, 10) === 0,
      '7. zero conflict_queue rows  (deleted fan excluded from candidate pool)');

    // 8 — Exactly one audit_log row, match_type = 'hard', is_new_record = true
    const auditRows = await client.query(
      `SELECT match_type, is_new_record
       FROM audit_log
       WHERE idempotency_key = $1 AND org_id = $2`,
      [idempotencyKey, testOrgId]
    );
    assert(auditRows.rows.length === 1,
      '8. exactly one audit_log row for this idempotency key');
    assert(auditRows.rows[0].match_type === 'hard',
      '8. audit_log.match_type === "hard"');
    assert(auditRows.rows[0].is_new_record === true,
      '8. audit_log.is_new_record === true');

    console.log('\n  All 8 assertions passed.\n');

  } finally {

    // ── CLEANUP ──────────────────────────────────────────────────────────────
    // conflict_queue: left — pinned by resolution_trace (append-only).
    // audit_log: left — append-only + pinned by resolution_trace.
    // fan / org: pinned by resolution_trace; attempted below, caught per-statement.
    //   Two fan rows exist (deletedFanId + result.fan_id) — WHERE org_id catches both.
    // identifier_link: two rows (one per fan), deletable (not referenced by trace).
    console.log('Cleaning up test data...');
    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]
    );
    try {
      await client.query(
        `DELETE FROM staging_household_data WHERE org_id = $1`, [testOrgId]
      );
      await client.query(
        `DELETE FROM identifier_link        WHERE org_id = $1`, [testOrgId]
      );
    } catch (cleanupErr) {
      console.error('Cleanup error (identifier_link/staging):', cleanupErr.message);
    }
    try {
      await client.query(`DELETE FROM fan WHERE org_id = $1`, [testOrgId]);
    } catch {
      console.log(`  Note: fan rows for org ${testOrgId} pinned by resolution_trace — left as inert.`);
    }
    try {
      await client.query(`DELETE FROM org WHERE id = $1`, [testOrgId]);
    } catch {
      console.log(`  Note: org ${testOrgId} pinned by resolution_trace — left as inert.`);
    }
    console.log('Cleanup complete (conflict_queue + audit_log left intentionally).\n');

    client.release();
  }
}

async function runPathB() {
  const testOrgId      = crypto.randomUUID();
  const uniqueId       = crypto.randomUUID();
  const inboundEmail   = `new-fan-${uniqueId}@test-synth.com`;
  const idempotencyKey = crypto.randomUUID();

  const orgApiKeyHash = crypto
    .createHash('sha256')
    .update(testOrgId)
    .digest('hex');

  console.log('\nresolverEngine Path B — smoke test');
  console.log('====================================');
  console.log(`testOrgId:      ${testOrgId}`);
  console.log(`inboundEmail:   ${inboundEmail}`);
  console.log(`idempotencyKey: ${idempotencyKey}`);

  const client = await pool.connect();

  try {

    // ── SETUP ────────────────────────────────────────────────────────────────
    // Seed org only. No fan rows, no identifier_link rows.
    // Candidate pool query returns zero rows — probabilistic matcher never runs.
    // PATH B fires immediately without any scoring attempt.

    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash)
       VALUES ($1, '_smoke_pathb_test', $2)`,
      [testOrgId, orgApiKeyHash]
    );

    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`,
      [testOrgId]
    );

    console.log('\nSetup complete — org only, zero fans seeded.');

    // ── CALL ─────────────────────────────────────────────────────────────────
    // UUID-embedded email guarantees no prior existence in identifier_link.
    // Candidate pool returns zero rows — no scoring attempt made.
    // PATH B creates a new fan record at confidence 1.0.
    // Firestore sync will fail with PERMISSION_DENIED locally — non-fatal,
    // resolverEngine catches and logs without throwing.
    console.log('\nCalling resolverEngine (Path B inbound — brand new identifier)...');
    const result = await resolverEngine(
      {
        identifier_type:  'email',
        identifier_value: inboundEmail,
        org_id:           testOrgId,
        schema_version:   'v1',
        source_system:    'synthetic_test',
        idempotency_key:  idempotencyKey,
      },
      client
    );

    console.log('\nResult:', JSON.stringify(result, null, 2));
    console.log('\nAssertions:');

    // ── ASSERT ───────────────────────────────────────────────────────────────

    // 1 — PATH B sets match_type = 'hard' (new record, no conflict, full confidence)
    assert(result.match_type === 'hard',
      '1. result.match_type === "hard"');

    // 2 — PATH B always returns confidence_score = 1.0
    assert(result.confidence_score === 1.0,
      '2. result.confidence_score === 1.0');

    // 3 — brand new fan, always a new record
    assert(result.is_new_record === true,
      '3. result.is_new_record === true');

    // 4 — no conflict_queue row written on PATH B
    assert(result.conflict_id === null,
      '4. result.conflict_id === null');

    // 5 — fan_id is a non-null UUID
    assert(result.fan_id !== null,
      '5. result.fan_id is non-null');
    assert(UUID_RE.test(result.fan_id),
      '5. result.fan_id matches UUID format');

    // 6 — exactly one fan row: id=result.fan_id, stewardship_tier='platform'
    const newFanRows = await client.query(
      `SELECT id, stewardship_tier
       FROM fan
       WHERE id = $1 AND org_id = $2`,
      [result.fan_id, testOrgId]
    );
    assert(newFanRows.rows.length === 1,
      '6. exactly one fan row for result.fan_id');
    assert(newFanRows.rows[0].stewardship_tier === 'platform',
      '6. fan.stewardship_tier === "platform"');

    // 7 — exactly one identifier_link row, confidence_score = 1.0
    //     pg returns NUMERIC columns as strings — parseFloat before comparing.
    const linkRows = await client.query(
      `SELECT confidence_score
       FROM identifier_link
       WHERE fan_id           = $1
         AND org_id           = $2
         AND identifier_type  = 'email'
         AND identifier_value = $3`,
      [result.fan_id, testOrgId, inboundEmail]
    );
    assert(linkRows.rows.length === 1,
      '7. exactly one identifier_link row for the inbound email');
    assert(parseFloat(linkRows.rows[0].confidence_score) === 1.0,
      '7. identifier_link.confidence_score === 1.0');

    // 8 — zero conflict_queue rows (PATH B never writes a conflict)
    const conflictCount = await client.query(
      `SELECT COUNT(*) AS row_count FROM conflict_queue WHERE org_id = $1`,
      [testOrgId]
    );
    assert(parseInt(conflictCount.rows[0].row_count, 10) === 0,
      '8. zero conflict_queue rows for testOrgId');

    // 9 — zero staging_household_data rows
    //     No guardian_email signal in inbound — soft-link side-channel absent.
    const stagingCount = await client.query(
      `SELECT COUNT(*) AS row_count
       FROM staging_household_data
       WHERE org_id = $1`,
      [testOrgId]
    );
    assert(parseInt(stagingCount.rows[0].row_count, 10) === 0,
      '9. zero staging_household_data rows — guardian_email side-channel absent');

    // 10 — audit_log: exactly one row, match_type = 'hard', is_new_record = true
    const auditRows = await client.query(
      `SELECT match_type, is_new_record FROM audit_log
       WHERE idempotency_key = $1 AND org_id = $2`,
      [idempotencyKey, testOrgId]
    );
    assert(auditRows.rows.length === 1,
      '10. exactly one audit_log row for this idempotency key');
    assert(auditRows.rows[0].match_type === 'hard',
      '10. audit_log.match_type === "hard"');
    assert(auditRows.rows[0].is_new_record === true,
      '10. audit_log.is_new_record === true');

    console.log('\n  All 10 assertions passed.\n');

  } finally {

    // ── CLEANUP ──────────────────────────────────────────────────────────────
    // conflict_queue: left — pinned by resolution_trace (append-only).
    // audit_log: left — append-only + pinned by resolution_trace.
    // fan / org: pinned by resolution_trace; attempted below, caught per-statement.
    // identifier_link + staging_household_data: deletable (not referenced by trace).
    console.log('Cleaning up test data...');
    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]
    );
    try {
      await client.query(
        `DELETE FROM staging_household_data WHERE org_id = $1`, [testOrgId]
      );
      await client.query(
        `DELETE FROM identifier_link        WHERE org_id = $1`, [testOrgId]
      );
    } catch (cleanupErr) {
      console.error('Cleanup error (identifier_link/staging):', cleanupErr.message);
    }
    try {
      await client.query(`DELETE FROM fan WHERE org_id = $1`, [testOrgId]);
    } catch {
      console.log(`  Note: fan rows for org ${testOrgId} pinned by resolution_trace — left as inert.`);
    }
    try {
      await client.query(`DELETE FROM org WHERE id = $1`, [testOrgId]);
    } catch {
      console.log(`  Note: org ${testOrgId} pinned by resolution_trace — left as inert.`);
    }
    console.log('Cleanup complete (conflict_queue + audit_log left intentionally).\n');

    client.release();
  }
}

async function runPathC() {
  const testOrgId      = crypto.randomUUID();
  const existingFanId  = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();

  // Build from constants so seed and inbound can't drift — Sprint 5 email is EXACT.
  const PATHC_EMAIL = 'pathc-exact@test-synth.com';
  const PATHC_NAME  = 'jordan pathc';

  const orgApiKeyHash = crypto
    .createHash('sha256')
    .update(testOrgId)
    .digest('hex');

  console.log('\nresolverEngine Path C — smoke test');
  console.log('====================================');
  console.log(`testOrgId:      ${testOrgId}`);
  console.log(`existingFanId:  ${existingFanId}`);
  console.log(`idempotencyKey: ${idempotencyKey}`);

  const client = await pool.connect();

  try {

    // ── SETUP ────────────────────────────────────────────────────────────────
    //
    // Seed existingFanId with exactly two identifier_link rows: email + name.
    // NO dob — seeding a matching dob would fire name_plus_dob (0.7) and
    // suppress name_alone, dropping the total to 0.7 → PATH D, not C.
    //
    // Score math (Sprint 5 scorer — email EXACT, name FUZZY):
    //   email_similarity: PATHC_EMAIL === PATHC_EMAIL (byte-identical) → fires
    //                     adjusted = 0.7 × 1.0 = 0.70
    //   name_alone:       'jordan pathc' fuzzy vs 'jordan pathc' (1.0 ≥ 0.85)
    //                     fires because name_plus_dob is not active (no dob)
    //                     adjusted = 0.3 × 1.0 = 0.30
    //   additive:         min(1.0, 0.70 + 0.30) = 1.0
    //   final score = 1.0  >=  0.85 = THRESHOLD_PATH_C  →  PATH C fires
    //
    // PATHC_EMAIL and PATHC_NAME are declared as constants above so the seed
    // value and the inbound value are guaranteed byte-identical.

    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash)
       VALUES ($1, '_smoke_pathc_test', $2)`,
      [testOrgId, orgApiKeyHash]
    );

    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`,
      [testOrgId]
    );

    await client.query(
      `INSERT INTO fan
         (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [existingFanId, testOrgId]
    );

    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, 'email', $2, $3,
               'thunder_app', 'v1', 1.0, NOW(), NOW())`,
      [existingFanId, PATHC_EMAIL, testOrgId]
    );

    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, 'name', $2, $3,
               'thunder_app', 'v1', 1.0, NOW(), NOW())`,
      [existingFanId, PATHC_NAME, testOrgId]
    );

    console.log('\nSetup complete — org, fan, 2 identifier_link rows seeded (email + name, no dob).');

    // ── CALL ─────────────────────────────────────────────────────────────────
    //
    // identifier_type = 'nfc_uid' with a novel value → PATH A skipped (no nfc_uid
    // in identifier_link). identifiers.email (EXACT same bytes as PATHC_EMAIL) fires
    // email_similarity (0.7). identifiers.name fires name_alone (0.3) — name_plus_dob
    // is absent because no dob is present in either the inbound or the candidate.
    // 0.70 + 0.30 = 1.0 ≥ 0.85 → PATH C.
    console.log('\nCalling resolverEngine (Path C inbound — exact email + name_alone)...');
    const result = await resolverEngine(
      {
        identifier_type:  'nfc_uid',
        identifier_value: 'pathc-novel-nfc-001',
        identifiers: {
          email: PATHC_EMAIL,
          name:  PATHC_NAME,
        },
        org_id:          testOrgId,
        schema_version:  'v1',
        source_system:   'synthetic_test',
        idempotency_key: idempotencyKey,
      },
      client
    );

    console.log('\nResult:', JSON.stringify(result, null, 2));
    console.log('\nAssertions:');

    // ── ASSERT ───────────────────────────────────────────────────────────────

    // 1 — PATH C sets match_type = 'soft' (distinct from PATH D's 'conflict')
    assert(result.match_type === 'soft',
      '1. result.match_type === "soft"');

    // 2 — additive sum 0.70 + 0.70 = 1.40, capped at 1.0
    assert(result.confidence_score === 1.0,
      '2. result.confidence_score === 1.0  (additive sum 1.40 capped)');

    // 3 — PATH C always creates a new fan record (pending staff review)
    assert(result.is_new_record === true,
      '3. result.is_new_record === true');

    // 4 — conflict_queue row was written
    assert(result.conflict_id !== null,
      '4. result.conflict_id is non-null');
    assert(UUID_RE.test(result.conflict_id),
      '4. result.conflict_id matches UUID format');

    // 5 — a new fan was created, not the existing one
    assert(result.fan_id !== existingFanId,
      '5. result.fan_id !== existingFanId  (new fan, not the seeded one)');

    // 6 — conflict_queue: exactly one pending row pointing at existingFanId
    //     confidence_score is NUMERIC(4,3) — pg returns it as string, parseFloat needed.
    const conflictRows = await client.query(
      `SELECT fan_id_a, fan_id_b, status, confidence_score, signals_matched
       FROM conflict_queue
       WHERE id = $1`,
      [result.conflict_id]
    );
    assert(conflictRows.rows.length === 1,
      '6. exactly one conflict_queue row for result.conflict_id');
    assert(conflictRows.rows[0].status === 'pending',
      '6. conflict_queue.status === "pending"');
    assert(conflictRows.rows[0].fan_id_a === existingFanId,
      '6. conflict_queue.fan_id_a === existingFanId');
    assert(parseFloat(conflictRows.rows[0].confidence_score) === 1.0,
      '6. conflict_queue.confidence_score === 1.0');

    // 7 — signals_matched contains both strong signals — core multi-signal proof.
    //     Under the old Math.max code with single-signal inbound, only
    //     email_similarity would appear. Both being present proves all three
    //     Sprint 4 fixes (inbound shape, additive scoring, eligibility gate)
    //     are working end-to-end.
    const signals = conflictRows.rows[0].signals_matched;
    assert(Array.isArray(signals),
      '7. signals_matched is an array');
    const signalNames = signals.map(s => s.signal);
    assert(signalNames.includes('email_similarity'),
      '7. signals_matched contains email_similarity');
    assert(signalNames.includes('name_alone'),
      '7. signals_matched contains name_alone');

    // 8 — exactly two entries: email_similarity + name_alone.
    //     No dob seeded → name_plus_dob does not fire →
    //     nameCountedInCompositeSignal stays false → name_alone fires (0.30).
    assert(signals.length === 2,
      '8. signals_matched has exactly 2 entries: email_similarity + name_alone');
    assert(!signalNames.includes('name_plus_dob'),
      '8. signals_matched does NOT contain name_plus_dob  (no dob seeded)');

    // 9 — zero staging_household_data rows for testOrgId.
    //     No guardian_email in inbound — soft-link side-channel correctly absent.
    const stagingRows = await client.query(
      `SELECT COUNT(*) AS row_count
       FROM staging_household_data
       WHERE org_id = $1`,
      [testOrgId]
    );
    assert(parseInt(stagingRows.rows[0].row_count, 10) === 0,
      '9. zero staging_household_data rows — guardian_email side-channel absent');

    // 10 — audit_log: exactly one row, match_type = 'soft', identifier_type = 'email'
    const auditRows = await client.query(
      `SELECT match_type, identifier_type
       FROM audit_log
       WHERE idempotency_key = $1 AND org_id = $2`,
      [idempotencyKey, testOrgId]
    );
    assert(auditRows.rows.length === 1,
      '10. exactly one audit_log row for this idempotency key');
    assert(auditRows.rows[0].match_type === 'soft',
      '10. audit_log.match_type === "soft"');
    assert(auditRows.rows[0].identifier_type === 'nfc_uid',
      '10. audit_log.identifier_type === "nfc_uid"');

    console.log('\n  All 10 assertions passed.\n');

  } finally {

    // ── CLEANUP ──────────────────────────────────────────────────────────────
    //
    // conflict_queue: left intentionally — resolution_trace.conflict_id FK pins it.
    //   resolution_trace is append-only, so referenced conflict_queue rows cannot
    //   be deleted. Same treatment as audit_log. Fresh UUID keeps rows inert.
    // audit_log: left intentionally — append-only + pinned by resolution_trace.
    // fan / org: pinned by resolution_trace (resulting_fan_id, best_candidate_id,
    //   org_id FKs). Attempted below; FK failure caught per-statement and noted.
    // identifier_link + staging_household_data: NOT referenced by trace — deleted.
    //
    // Final delete order:
    //   1. staging_household_data  (not pinned by trace)
    //   2. identifier_link         (not pinned by trace)
    //   3. fan                     (try — pinned by trace, likely fails)
    //   4. org                     (try — pinned by trace, likely fails)
    console.log('Cleaning up test data...');
    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]
    );
    try {
      await client.query(
        `DELETE FROM staging_household_data WHERE org_id = $1`, [testOrgId]
      );
      await client.query(
        `DELETE FROM identifier_link        WHERE org_id = $1`, [testOrgId]
      );
    } catch (cleanupErr) {
      console.error('Cleanup error (identifier_link/staging):', cleanupErr.message);
    }
    try {
      await client.query(`DELETE FROM fan WHERE org_id = $1`, [testOrgId]);
    } catch {
      console.log(`  Note: fan rows for org ${testOrgId} pinned by resolution_trace — left as inert.`);
    }
    try {
      await client.query(`DELETE FROM org WHERE id = $1`, [testOrgId]);
    } catch {
      console.log(`  Note: org ${testOrgId} pinned by resolution_trace — left as inert.`);
    }
    console.log('Cleanup complete (conflict_queue + audit_log left intentionally).\n');

    client.release();
  }
}

// =============================================================================
// runTraceTests — resolution_trace writer (Stage 7 Prompt 4)
//
// Tests 1-10 from the prompt. Connects to the real local Postgres.
//
// CLEANUP NOTE: resolution_trace is append-only. Once written, trace rows pin
// the following rows permanently via FK constraints:
//   resolution_trace.org_id           → org (all 6 test orgs pinned)
//   resolution_trace.resulting_fan_id → fan (new fan per resolution)
//   resolution_trace.best_candidate_id → fan (seeded candidates for scored paths)
//   resolution_trace.conflict_id      → conflict_queue (tests 5, 6)
//   resolution_trace.audit_event_id   → audit_log (audit_log also append-only)
// Only identifier_link and staging_household_data are NOT referenced by trace
// and can be cleaned up. Everything else is permanently leaked per run.
// Fresh UUIDs ensure leaked rows are inert. Same pattern as audit_log rows.
// =============================================================================

async function runTraceTests() {
  console.log('\nresolverEngine resolution_trace — smoke tests (1-10)');
  console.log('=====================================================');

  const client = await pool.connect();

  // One org per sub-test — isolates candidate pools so signals are predictable.
  const orgA = crypto.randomUUID(); // test 1 (PATH A)
  const orgB = crypto.randomUUID(); // tests 2, 7 (PATH B no-candidates + idempotency)
  const orgC = crypto.randomUUID(); // test 3 (PATH B scored-but-lost)
  const orgD = crypto.randomUUID(); // test 4 (PATH B all-gated)
  const orgE = crypto.randomUUID(); // tests 5, 8, 9, 10 (PATH C)
  const orgF = crypto.randomUUID(); // test 6 (PATH D)

  const mkHash = (id) => crypto.createHash('sha256').update(id).digest('hex');

  // idempKey2 is declared here so test 7 can reuse the same key as test 2.
  const idempKey2 = crypto.randomUUID();

  // trace5row is populated in test 5 and reused by tests 8, 9, 10.
  let trace5row = null;

  try {

    // ── PRE-SETUP: insert all orgs before RLS context is set ─────────────────
    // org table is not subject to tenant_isolation policy.
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash) VALUES
         ($1, '_trace_test_orgA', $2),
         ($3, '_trace_test_orgB', $4),
         ($5, '_trace_test_orgC', $6),
         ($7, '_trace_test_orgD', $8),
         ($9, '_trace_test_orgE', $10),
         ($11, '_trace_test_orgF', $12)`,
      [
        orgA, mkHash(orgA), orgB, mkHash(orgB),
        orgC, mkHash(orgC), orgD, mkHash(orgD),
        orgE, mkHash(orgE), orgF, mkHash(orgF),
      ]
    );
    console.log('  Pre-setup: 6 orgs inserted.');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1: PATH A — trace with scoring_status='skipped',
    //         skip_reason='deterministic_match'
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[1] PATH A trace');

    const fanA = crypto.randomUUID();
    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [fanA, orgA]
    );
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score, first_seen_at, last_seen_at)
       VALUES ($1, 'email', 'trace.pathA@synth.test', $2, 'smoke', 'v1', 1.0, NOW(), NOW())`,
      [fanA, orgA]
    );
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgA]);

    const r1 = await resolverEngine(
      { identifier_type: 'email', identifier_value: 'trace.pathA@synth.test',
        org_id: orgA, schema_version: 'v1', source_system: 'smoke',
        idempotency_key: crypto.randomUUID() },
      client
    );

    const t1 = await client.query(
      `SELECT resolution_path, scoring_status, skip_reason, best_score,
              candidates_considered, inbound_identifiers
       FROM resolution_trace WHERE resulting_fan_id = $1 AND org_id = $2`,
      [r1.fan_id, orgA]
    );
    assert(t1.rows.length === 1,
      '1. exactly one trace row for PATH A');
    assert(t1.rows[0].resolution_path === 'A',
      '1. resolution_path = A');
    assert(t1.rows[0].scoring_status === 'skipped',
      '1. scoring_status = skipped');
    assert(t1.rows[0].skip_reason === 'deterministic_match',
      '1. skip_reason = deterministic_match');
    assert(t1.rows[0].best_score === null,
      '1. best_score IS NULL');
    assert(parseInt(t1.rows[0].candidates_considered, 10) === 0,
      '1. candidates_considered = 0');
    const inb1 = t1.rows[0].inbound_identifiers;
    assert(
      typeof inb1 === 'object' &&
      inb1.email === 'trace.pathA@synth.test' &&
      Object.keys(inb1).length === 1,
      '1. inbound_identifiers = {email: "trace.pathA@synth.test"} (one-key object)'
    );
    console.log('  PASS  test 1 (7 assertions)');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2: PATH B no candidates — scoring_status='skipped',
    //         skip_reason='no_candidates'
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[2] PATH B no candidates');

    // orgB has no fans — candidate pool returns 0 rows.
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgB]);

    const r2 = await resolverEngine(
      { identifier_type: 'email', identifier_value: 'trace.pathB.novel@synth.test',
        org_id: orgB, schema_version: 'v1', source_system: 'smoke',
        idempotency_key: idempKey2 },   // reused in test 7
      client
    );

    const t2 = await client.query(
      `SELECT resolution_path, scoring_status, skip_reason, best_score, candidates_considered
       FROM resolution_trace WHERE resulting_fan_id = $1 AND org_id = $2`,
      [r2.fan_id, orgB]
    );
    assert(t2.rows.length === 1,
      '2. exactly one trace row');
    assert(t2.rows[0].resolution_path === 'B',
      '2. resolution_path = B');
    assert(t2.rows[0].scoring_status === 'skipped',
      '2. scoring_status = skipped');
    assert(t2.rows[0].skip_reason === 'no_candidates',
      '2. skip_reason = no_candidates');
    assert(t2.rows[0].best_score === null,
      '2. best_score IS NULL');
    assert(parseInt(t2.rows[0].candidates_considered, 10) === 0,
      '2. candidates_considered = 0');
    console.log('  PASS  test 2 (6 assertions)');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3: PATH B scored-but-lost — gate passes (both emails set),
    //         score = 0.0 (different emails → exact match fails),
    //         scoring_status='performed', best_score NOT NULL.
    // Proves near-miss visibility: a scored-but-unmatched resolution records
    // 'performed' with a non-null score, not 'skipped'.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[3] PATH B scored-but-lost (gate passes, score 0.0)');

    const fanC = crypto.randomUUID();
    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`, [fanC, orgC]
    );
    // Candidate has email set — gate passes. Inbound email is different → exact
    // match fails → score 0.0.
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score, first_seen_at, last_seen_at)
       VALUES ($1, 'email', 'trace.candidate.c@synth.test', $2, 'smoke', 'v1', 1.0, NOW(), NOW())`,
      [fanC, orgC]
    );
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgC]);

    const r3 = await resolverEngine(
      { identifier_type: 'email', identifier_value: 'trace.inbound.c@synth.test',
        org_id: orgC, schema_version: 'v1', source_system: 'smoke',
        idempotency_key: crypto.randomUUID() },
      client
    );

    const t3 = await client.query(
      `SELECT resolution_path, scoring_status, skip_reason, best_score,
              candidates_considered, candidates_scored
       FROM resolution_trace WHERE resulting_fan_id = $1 AND org_id = $2`,
      [r3.fan_id, orgC]
    );
    assert(t3.rows.length === 1,
      '3. exactly one trace row');
    assert(t3.rows[0].resolution_path === 'B',
      '3. resolution_path = B');
    assert(t3.rows[0].scoring_status === 'performed',
      '3. scoring_status = performed  (scorer ran even though score was 0)');
    assert(t3.rows[0].skip_reason === null,
      '3. skip_reason IS NULL for performed');
    assert(t3.rows[0].best_score !== null,
      '3. best_score is NOT NULL  (0.0 is not null — performed requires non-null)');
    assert(parseInt(t3.rows[0].candidates_scored, 10) >= 1,
      '3. candidates_scored >= 1');
    console.log('  PASS  test 3 (6 assertions)');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 4: PATH B all gated — candidate has name only (1 weak signal).
    //         Gate requires >=1 strong OR >=2 weak → fails.
    //         scoring_status='skipped', skip_reason='all_candidates_gated'.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[4] PATH B all gated (name-only candidate, 1 weak → gate fails)');

    const fanD = crypto.randomUUID();
    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`, [fanD, orgD]
    );
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score, first_seen_at, last_seen_at)
       VALUES ($1, 'name', 'Gated Trace Fan', $2, 'smoke', 'v1', 1.0, NOW(), NOW())`,
      [fanD, orgD]
    );
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgD]);

    // identifier_type='nfc_uid' avoids PATH A match. identifiers.name populates
    // inbound.name → name_alone = 1 weak → gate fails.
    const r4 = await resolverEngine(
      { identifier_type: 'nfc_uid', identifier_value: 'trace-gate-uid-001',
        identifiers: { name: 'Gated Trace Fan' },
        org_id: orgD, schema_version: 'v1', source_system: 'smoke',
        idempotency_key: crypto.randomUUID() },
      client
    );

    const t4 = await client.query(
      `SELECT resolution_path, scoring_status, skip_reason,
              candidates_considered, candidates_gated, candidates_scored, best_score
       FROM resolution_trace WHERE resulting_fan_id = $1 AND org_id = $2`,
      [r4.fan_id, orgD]
    );
    assert(t4.rows.length === 1,
      '4. exactly one trace row');
    assert(t4.rows[0].resolution_path === 'B',
      '4. resolution_path = B');
    assert(t4.rows[0].scoring_status === 'skipped',
      '4. scoring_status = skipped');
    assert(t4.rows[0].skip_reason === 'all_candidates_gated',
      '4. skip_reason = all_candidates_gated');
    assert(parseInt(t4.rows[0].candidates_considered, 10) >= 1,
      '4. candidates_considered >= 1');
    assert(parseInt(t4.rows[0].candidates_gated, 10) >= 1,
      '4. candidates_gated >= 1');
    assert(parseInt(t4.rows[0].candidates_scored, 10) === 0,
      '4. candidates_scored = 0');
    assert(t4.rows[0].best_score === null,
      '4. best_score IS NULL  (skipped → no score)');
    console.log('  PASS  test 4 (8 assertions)');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5: PATH C — email exact match (0.7) + name_alone (0.3) = 1.0 ≥ 0.85.
    //         Trace row also used by tests 8 (counts coherence), 9 (PII check),
    //         10 (versions wired).
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[5] PATH C (exact email + name_alone → score 1.0)');

    const fanE = crypto.randomUUID();
    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`, [fanE, orgE]
    );
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score, first_seen_at, last_seen_at)
       VALUES ($1, 'email', 'trace.exactmatch@synth.test', $2, 'smoke', 'v1', 1.0, NOW(), NOW())`,
      [fanE, orgE]
    );
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score, first_seen_at, last_seen_at)
       VALUES ($1, 'name', 'Jane Trace', $2, 'smoke', 'v1', 1.0, NOW(), NOW())`,
      [fanE, orgE]
    );
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgE]);

    // identifier_type='nfc_uid' skips PATH A. identifiers carries email+name.
    // Email exact match = 0.7 × 1.0 = 0.7. name_alone: 'jane trace' vs 'jane trace'
    // → fuzzy 1.0 ≥ 0.85 → fires → 0.3 × 1.0 = 0.3. Sum = 1.0. PATH C.
    const r5 = await resolverEngine(
      { identifier_type: 'nfc_uid', identifier_value: 'trace-pathc-uid-001',
        identifiers: { email: 'trace.exactmatch@synth.test', name: 'Jane Trace' },
        org_id: orgE, schema_version: 'v1', source_system: 'smoke',
        idempotency_key: crypto.randomUUID() },
      client
    );

    assert(r5.match_type === 'soft',    '5. result.match_type = soft');
    assert(r5.conflict_id !== null,      '5. result.conflict_id is non-null');
    assert(r5.is_new_record === true,   '5. result.is_new_record = true');

    const t5rows = await client.query(
      `SELECT resolution_path, scoring_status, best_score, signal_results,
              candidate_ids, candidates_considered, candidates_gated,
              candidates_scored, conflict_id, is_new_record,
              scorer_version, normalization_version
       FROM resolution_trace WHERE resulting_fan_id = $1 AND org_id = $2`,
      [r5.fan_id, orgE]
    );
    assert(t5rows.rows.length === 1,
      '5. exactly one trace row');
    trace5row = t5rows.rows[0];

    assert(trace5row.resolution_path === 'C',
      '5. resolution_path = C');
    assert(trace5row.scoring_status === 'performed',
      '5. scoring_status = performed');
    assert(parseFloat(trace5row.best_score) >= 0.85,
      '5. best_score >= 0.85');
    assert(trace5row.conflict_id === r5.conflict_id,
      '5. trace.conflict_id matches result.conflict_id');
    assert(trace5row.is_new_record === true,
      '5. trace.is_new_record = true');
    console.log('  PASS  test 5 (9 assertions)');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 6: PATH D — name_plus_dob fires → score ~0.7 in [0.60, 0.85).
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[6] PATH D (name_plus_dob → score ~0.7)');

    const fanF = crypto.randomUUID();
    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`, [fanF, orgF]
    );
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score, first_seen_at, last_seen_at)
       VALUES ($1, 'name', 'Bob Traced', $2, 'smoke', 'v1', 1.0, NOW(), NOW())`,
      [fanF, orgF]
    );
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score, first_seen_at, last_seen_at)
       VALUES ($1, 'dob', '1988-06-10', $2, 'smoke', 'v1', 1.0, NOW(), NOW())`,
      [fanF, orgF]
    );
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgF]);

    // name_plus_dob: 'bob traced' matches exactly, dob exact → fires → 0.7 × 1.0 = 0.7.
    // No email → no email conflict penalty. 0.60 ≤ 0.7 < 0.85 → PATH D.
    const r6 = await resolverEngine(
      { identifier_type: 'nfc_uid', identifier_value: 'trace-pathd-uid-001',
        identifiers: { name: 'Bob Traced', dob: '1988-06-10' },
        org_id: orgF, schema_version: 'v1', source_system: 'smoke',
        idempotency_key: crypto.randomUUID() },
      client
    );

    assert(r6.match_type === 'conflict',    '6. result.match_type = conflict');
    assert(r6.conflict_id !== null,          '6. result.conflict_id is non-null');

    const t6 = await client.query(
      `SELECT resolution_path, scoring_status, best_score, conflict_id
       FROM resolution_trace WHERE resulting_fan_id = $1 AND org_id = $2`,
      [r6.fan_id, orgF]
    );
    assert(t6.rows.length === 1,
      '6. exactly one trace row');
    assert(t6.rows[0].resolution_path === 'D',
      '6. resolution_path = D');
    assert(t6.rows[0].scoring_status === 'performed',
      '6. scoring_status = performed');
    assertBetween(parseFloat(t6.rows[0].best_score), 0.60, 0.84,
      '6. best_score in [0.60, 0.84]');
    assert(t6.rows[0].conflict_id === r6.conflict_id,
      '6. trace.conflict_id matches result');
    console.log('  PASS  test 6 (7 assertions)');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 7: Idempotency second call writes NO trace.
    //         First call (test 2) wrote one trace row for orgB. Second call
    //         with the same idempotency_key fires GUARD 2 → early return before
    //         COMMIT → STEP 4C never reached → no new trace row.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[7] Idempotency second call writes no trace');

    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgB]);

    const beforeCount = await client.query(
      `SELECT COUNT(*) AS n FROM resolution_trace WHERE org_id = $1`, [orgB]
    );
    const countBefore = parseInt(beforeCount.rows[0].n, 10);

    // Same identifier + same idempotency key → GUARD 2 fires, early return
    await resolverEngine(
      { identifier_type: 'email', identifier_value: 'trace.pathB.novel@synth.test',
        org_id: orgB, schema_version: 'v1', source_system: 'smoke',
        idempotency_key: idempKey2 },
      client
    );

    const afterCount = await client.query(
      `SELECT COUNT(*) AS n FROM resolution_trace WHERE org_id = $1`, [orgB]
    );
    const countAfter = parseInt(afterCount.rows[0].n, 10);

    assert(countBefore >= 1,
      '7. first call (test 2) wrote at least one trace row');
    assert(countAfter === countBefore,
      '7. second call (idempotency replay) wrote NO new trace row');
    console.log('  PASS  test 7 (2 assertions)');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 8: Counts coherence — using test-5 PATH C trace row.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[8] Counts coherence (test-5 trace row)');

    const considered   = parseInt(trace5row.candidates_considered, 10);
    const gated        = parseInt(trace5row.candidates_gated, 10);
    const scored       = parseInt(trace5row.candidates_scored, 10);
    const candidateIds = trace5row.candidate_ids;

    assert(gated + scored <= considered,
      '8. candidates_gated + candidates_scored <= candidates_considered');
    assert(Array.isArray(candidateIds),
      '8. candidate_ids is an array');
    assert(candidateIds.length === considered,
      '8. candidate_ids.length === candidates_considered');
    console.log('  PASS  test 8 (3 assertions)');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 9: Derived-only signal_results — no raw PII in the stored signals.
    //         Each entry must have only scoring keys; no email address, no DOB
    //         string, no raw name appears as a value.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[9] Derived-only signal_results');

    const sigResults = trace5row.signal_results;
    assert(Array.isArray(sigResults),         '9. signal_results is an array');
    assert(sigResults.length > 0,             '9. signal_results is non-empty');

    // 'similarity' is the Levenshtein ratio (a float, not a raw field value) —
    // permitted as a derived scoring key, not PII.
    const EXPECTED_KEYS = new Set(['signal', 'raw_score', 'recency_multiplier', 'adjusted_score', 'similarity']);
    for (const entry of sigResults) {
      for (const k of Object.keys(entry)) {
        assert(EXPECTED_KEYS.has(k),
          `9. signal_results entry key is a scoring key (got: ${k})`);
      }
      // No raw field value (email, name, dob) appears as a string value
      for (const v of Object.values(entry)) {
        if (typeof v === 'string') {
          assert(!v.includes('@'),
            `9. signal string value is not an email address: ${v}`);
          assert(!/\d{4}-\d{2}-\d{2}/.test(v),
            `9. signal string value is not a DOB: ${v}`);
        }
      }
    }
    console.log('  PASS  test 9');

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 10: Versions wired — SCORER_VERSION and NORMALIZATION_VERSION
    //          constants are written to every trace row, not defaulted.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[10] Versions wired');

    const SCORER_VER_RE = /^v\d+\+[0-9a-f]{8}$/;
    assert(SCORER_VER_RE.test(trace5row.scorer_version),
      '10. scorer_version matches /^v\\d+\\+[0-9a-f]{8}$/');
    assert(trace5row.normalization_version === 'v1',
      '10. normalization_version === "v1"');
    console.log('  PASS  test 10 (2 assertions)');

    console.log('\n  All trace tests (1-10) passed.\n');

  } finally {

    // ── CLEANUP ──────────────────────────────────────────────────────────────
    //
    // resolution_trace is append-only and pins: org, fan (resulting + candidate),
    // conflict_queue (tests 5,6), audit_log (also append-only). Attempting to
    // DELETE any of these would fail with a FK or trigger violation.
    //
    // Only identifier_link and staging_household_data are safe to delete.
    // All other rows are permanently leaked — inert via fresh UUIDs per run.
    //
    // The same FK pattern now also affects the cleanups in the other smoke test
    // functions (runPathD, runPathA, etc.): their DELETE FROM audit_log already
    // failed pre-migration_014; their DELETE FROM fan/org will now also fail.
    // Those failures are caught silently. This is expected and does not affect
    // test correctness.
    console.log('Cleaning up trace test data (identifier_link only; all other rows permanently leaked)...');
    const allOrgs = [orgA, orgB, orgC, orgD, orgE, orgF];
    for (const org of allOrgs) {
      try {
        await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [org]);
        await client.query(`DELETE FROM identifier_link        WHERE org_id = $1`, [org]);
        await client.query(`DELETE FROM staging_household_data WHERE org_id = $1`, [org]);
      } catch (cleanupErr) {
        console.error(`Cleanup error for org ${org}:`, cleanupErr.message);
      }
    }
    console.log('Cleanup complete.\n');
    client.release();
  }
}

(async () => {
  try {
    await runPathD();
    await runPathA();
    await runPathADeletedFan();
    await runPathB();
    await runPathC();
    await runTraceTests();
    pool.end();
    process.exit(0);
  } catch (err) {
    console.error('\nSMOKE TEST FAILED');
    console.error(err.message);
    pool.end();
    process.exit(1);
  }
})();
