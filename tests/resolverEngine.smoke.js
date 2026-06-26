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

    // Seed the existing fan's email identifier.
    // last_seen_at = NOW() guarantees getRecencyMultiplier returns 1.0 so the
    // adjusted email_similarity score lands at exactly 0.7 — no staleness drag.
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, 'email', 'aaron.franklin@test-synth.com', $2,
               'thunder_app', 'v1', 1.0, NOW(), NOW())`,
      [existingFanId, testOrgId]
    );

    console.log('\nSetup complete — org, fan, identifier_link seeded.');

    // ── CALL ─────────────────────────────────────────────────────────────────

    // Pass the client directly as db. resolverEngine calls client.query()
    // internally and runs its own BEGIN/COMMIT on this connection.
    // The session-scoped RLS context survives those transaction boundaries.
    //
    // inbound email 'aron.franklin@test-synth.com' — one 'a' removed from
    // 'aaron'. No exact match exists in identifier_link (Path A skipped).
    // The LEFT JOIN candidate query finds existingFanId. scoreMatch fires
    // email_similarity (similarity ~0.9655 >= 0.8, recency 1.0) -> score 0.70.
    // 0.60 <= 0.70 < 0.85 -> Path D.
    //
    // identifier_type = 'email' -> inbound.guardian_email = null.
    // Signal 4 guard short-circuits -> staging_household_data write skipped.
    console.log('\nCalling resolverEngine (Path D inbound)...');
    const result = await resolverEngine(
      {
        identifier_type:  'email',
        identifier_value: 'aron.franklin@test-synth.com',
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

    // 6 — signals_matched JSONB: exactly one entry, signal = 'email_similarity'
    //     pg parses JSONB columns into JS objects automatically.
    const signals = conflictRows.rows[0].signals_matched;
    assert(Array.isArray(signals),
      '6. signals_matched is an array');
    assert(signals.length === 1,
      '6. signals_matched contains exactly one entry');
    assert(signals[0].signal === 'email_similarity',
      '6. signals_matched[0].signal === "email_similarity"');

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

    // 8 — new identifier_link row: inbound email, confidence_score in [0.69, 0.71]
    //     pg returns NUMERIC columns as strings — parseFloat before comparing.
    const newLinkRows = await client.query(
      `SELECT confidence_score
       FROM identifier_link
       WHERE fan_id         = $1
         AND org_id         = $2
         AND identifier_type  = 'email'
         AND identifier_value = 'aron.franklin@test-synth.com'`,
      [result.fan_id, testOrgId]
    );
    assert(newLinkRows.rows.length === 1,
      '8. exactly one new identifier_link row for the inbound email');
    assertBetween(parseFloat(newLinkRows.rows[0].confidence_score), 0.69, 0.71,
      '8. new identifier_link.confidence_score in [0.69, 0.71]');

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
    // Re-assert RLS context — session-scoped so still active, but explicit
    // matches migration_006 pattern: "restore context to test org before cleanup."
    //
    // Deletion order respects FK constraints:
    //   conflict_queue         — REFERENCES fan (fan_id_a, fan_id_b)
    //   audit_log              — REFERENCES fan (fan_id)
    //   identifier_link        — REFERENCES fan (fan_id)
    //   staging_household_data — REFERENCES fan (adult_fan_id), 0 rows but safe
    //   fan                    — REFERENCES org (org_id)
    //   org                    — no FK dependency
    //
    // testOrgId is a fresh UUID — WHERE org_id = $1 targets only test rows.
    console.log('Cleaning up test data...');
    try {
      await client.query(
        `SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]
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
        `DELETE FROM staging_household_data WHERE org_id = $1`, [testOrgId]
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
    // FK deletion order (same as PATH D):
    //   conflict_queue         — 0 rows, safe
    //   audit_log              — 1 row
    //   identifier_link        — 1 row
    //   staging_household_data — 0 rows, safe
    //   fan                    — 1 row
    //   org                    — 1 row
    console.log('Cleaning up test data...');
    try {
      await client.query(
        `SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]
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
        `DELETE FROM staging_household_data WHERE org_id = $1`, [testOrgId]
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
    // Exact match to the deleted fan's identifier. Under the OLD code this
    // fires PATH A and returns deletedFanId at confidence 1.0. Under the FIX
    // the JOIN filters out deleted fans, linkResult is empty, and PATH B fires.
    // The candidate pool LEFT JOIN already has f.deleted_at IS NULL so the
    // deleted fan is also excluded from probabilistic scoring — PATH B fires
    // directly without any scoring attempt.
    console.log('\nCalling resolverEngine (deleted fan exact identifier — must fire PATH B, not PATH A)...');
    const result = await resolverEngine(
      {
        identifier_type:  'email',
        identifier_value: 'deleted.fan@test-synth.com',
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

    // 5 — New identifier_link row points to the NEW fan, not deletedFanId
    const newLinkRows = await client.query(
      `SELECT fan_id
       FROM identifier_link
       WHERE fan_id           = $1
         AND org_id           = $2
         AND identifier_type  = 'email'
         AND identifier_value = 'deleted.fan@test-synth.com'`,
      [result.fan_id, testOrgId]
    );
    assert(newLinkRows.rows.length === 1,
      '5. exactly one identifier_link row points to new fan_id');
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
    //
    // Two fan rows exist: deletedFanId + result.fan_id.
    // Both are deleted by WHERE org_id = $1.
    // Two identifier_link rows: one for each fan. Same WHERE clause catches both.
    //
    // FK deletion order:
    //   conflict_queue         — 0 rows, safe
    //   audit_log              — 1 row
    //   identifier_link        — 2 rows
    //   staging_household_data — 0 rows, safe
    //   fan                    — 2 rows
    //   org                    — 1 row
    console.log('Cleaning up test data...');
    try {
      await client.query(
        `SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]
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
        `DELETE FROM staging_household_data WHERE org_id = $1`, [testOrgId]
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
    //
    // Deletion order respects FK constraints:
    //   conflict_queue         — 0 rows, safe
    //   audit_log              — 1 row (deleted before fan to satisfy FK)
    //   identifier_link        — 1 row
    //   staging_household_data — 0 rows, safe
    //   fan                    — 1 row
    //   org                    — 1 row
    console.log('Cleaning up test data...');
    try {
      await client.query(
        `SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]
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
        `DELETE FROM staging_household_data WHERE org_id = $1`, [testOrgId]
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

async function runPathC() {
  const testOrgId      = crypto.randomUUID();
  const existingFanId  = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();

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
    // Seed existingFanId with three identifier_link rows so the candidate
    // LEFT JOIN can populate email, name, and dob columns simultaneously.
    // All three have last_seen_at = NOW() → getRecencyMultiplier returns 1.0
    // on every signal, giving each signal its full unattenuated weight.
    //
    // Score math:
    //   email_similarity: inbound='pathc.tst@test-synth.com' (24 chars)
    //                     candidate='pathc.test@test-synth.com' (25 chars)
    //                     levenshteinDistance = 1, maxLength = 25
    //                     similarity = 1 - 1/25 = 0.96  >=  0.8  →  fires
    //                     adjusted = 0.7 × 1.0 = 0.70
    //   name_plus_dob:    exact name match + exact dob match  →  fires
    //                     adjusted = 0.7 × 1.0 = 0.70
    //   additive:         min(1.0, 0.70 + 0.70) = min(1.0, 1.40) = 1.0
    //   name_alone:       name match fires independently (not deduped from
    //                     name_plus_dob) — score stays 1.0 (already capped)
    //                     but name_alone IS pushed to signals_matched
    //   final score = 1.0  >=  0.85 = THRESHOLD_PATH_C  →  PATH C fires

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
       VALUES ($1, 'email', 'pathc.test@test-synth.com', $2,
               'thunder_app', 'v1', 1.0, NOW(), NOW())`,
      [existingFanId, testOrgId]
    );

    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, 'name', 'Path C Fan', $2,
               'thunder_app', 'v1', 1.0, NOW(), NOW())`,
      [existingFanId, testOrgId]
    );

    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, 'dob', '1995-03-15', $2,
               'thunder_app', 'v1', 1.0, NOW(), NOW())`,
      [existingFanId, testOrgId]
    );

    console.log('\nSetup complete — org, fan, 3 identifier_link rows seeded (email, name, dob).');

    // ── CALL ─────────────────────────────────────────────────────────────────
    //
    // identifier_value uses 'pathc.tst@test-synth.com' ('e' removed from 'test').
    // No exact match exists in identifier_link → PATH A skipped.
    // identifiers.name + identifiers.dob populate the inbound object so the
    // name_plus_dob signal can fire alongside email_similarity.
    // Both fire, additive sum = 1.40 capped at 1.0 → PATH C.
    console.log('\nCalling resolverEngine (Path C inbound — two strong signals)...');
    const result = await resolverEngine(
      {
        identifier_type:  'email',
        identifier_value: 'pathc.tst@test-synth.com',
        identifiers: {
          name: 'Path C Fan',
          dob:  '1995-03-15',
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
    assert(signalNames.includes('name_plus_dob'),
      '7. signals_matched contains name_plus_dob');

    // 8 — exactly three entries: email_similarity, name_plus_dob, name_alone.
    //     name_alone fires independently whenever inbound.name and candidate.name
    //     both exist and match. It is not spurious — it is a legitimate separate
    //     signal that the scorer does not deduplicate from name_plus_dob.
    //     Score stays 1.0 (already capped — adding 0.3 × 1.0 = 0.3 to 1.0 stays 1.0)
    //     but name_alone is still pushed to signals_matched.
    assert(signals.length === 3,
      '8. signals_matched has exactly 3 entries: email_similarity, name_plus_dob, name_alone');
    assert(signalNames.includes('name_alone'),
      '8. signals_matched contains name_alone  (legitimate, not spurious)');

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
    assert(auditRows.rows[0].identifier_type === 'email',
      '10. audit_log.identifier_type === "email"');

    console.log('\n  All 10 assertions passed.\n');

  } finally {

    // ── CLEANUP ──────────────────────────────────────────────────────────────
    //
    // Deletion order respects FK constraints:
    //   staging_household_data — 0 rows, safe (checked by assertion 9)
    //   conflict_queue         — 1 row (REFERENCES fan — must go before fan)
    //   audit_log              — rows for this org
    //   identifier_link        — rows for this org (existingFanId + new fan)
    //   fan                    — 2 rows: existingFanId + new fan from PATH C
    //   org                    — 1 row
    //
    // testOrgId is a fresh UUID each run — WHERE org_id = $1 is safe.
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

(async () => {
  try {
    await runPathD();
    await runPathA();
    await runPathADeletedFan();
    await runPathB();
    await runPathC();
    pool.end();
    process.exit(0);
  } catch (err) {
    console.error('\nSMOKE TEST FAILED');
    console.error(err.message);
    pool.end();
    process.exit(1);
  }
})();
