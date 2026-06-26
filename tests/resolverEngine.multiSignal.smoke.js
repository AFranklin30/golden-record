'use strict';
// tests/resolverEngine.multiSignal.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/resolverEngine.multiSignal.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Requires:
//   DATABASE_URL in .env pointing to your local Postgres instance (localhost:5432)
//   migration_005.sql run  (staging_household_data, household tables)
//   migration_006.sql run  (RLS on Sprint 3 tables)
//   FIRESTORE_PROJECT_ID may be unset — resolverEngine catches Firestore
//   failures and logs them without throwing.
//
// Proves:
//   When the caller provides input.identifiers alongside the required
//   identifier_type/identifier_value, resolverEngine populates all six
//   inbound signal fields — not just the one driven by identifier_type.
//   signals_matched therefore contains MORE THAN ONE entry, proving the
//   multi-signal inbound fix works.
//
// Score math (verified before writing):
//   seeded:  email='multi@test-synth.com'  (20 chars)
//   inbound: email='mult1@test-synth.com'  (20 chars, 'i' swapped for '1')
//   levenshteinDistance = 1, maxLength = 20
//   similarity = 1 - 1/20 = 0.95 >= 0.8 → email_similarity fires
//   last_seen_at = NOW() → recency multiplier = 1.0
//   adjusted email_similarity = 0.7 * 1.0 = 0.70
//
//   identifiers.name = 'Multi Signal' — exact match with seeded name
//   identifiers.dob  = '1990-06-01'   — exact match with seeded dob
//   name_plus_dob fires → adjusted = 0.7 * 1.0 = 0.70
//
//   Additive accumulation (Sprint 4 step 2): 0.70 + 0.70 = 1.40 → capped at 1.0
//   1.0 >= 0.85 → PATH C fires ✓
//   signals_matched contains BOTH email_similarity AND name_plus_dob ✓
//
//   Under OLD code (Math.max) score was 0.70 → PATH D.
//   Under OLD code inbound.name and inbound.dob were null — only
//   email_similarity would appear in signals_matched.

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAILED — ${message}`);
  console.log(`  PASS  ${message}`);
}

async function run() {
  const testOrgId      = crypto.randomUUID();
  const existingFanId  = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();

  const orgApiKeyHash = crypto
    .createHash('sha256')
    .update(testOrgId)
    .digest('hex');

  console.log('\nresolverEngine multi-signal inbound — smoke test');
  console.log('=================================================');
  console.log(`testOrgId:      ${testOrgId}`);
  console.log(`existingFanId:  ${existingFanId}`);
  console.log(`idempotencyKey: ${idempotencyKey}`);

  const client = await pool.connect();

  try {

    // ── SETUP ────────────────────────────────────────────────────────────────

    // Org inserted before RLS context — org table is not tenant-isolated.
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash)
       VALUES ($1, '_smoke_multisignal_test', $2)`,
      [testOrgId, orgApiKeyHash]
    );

    // Session-scoped RLS context — survives the BEGIN/COMMIT resolverEngine runs.
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

    // Three identifier_link rows — email, name, dob — so both signals can fire.
    // last_seen_at = NOW() → recency multiplier = 1.0 on all three.
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES
         ($1, 'email', 'multi@test-synth.com', $2, 'thunder_app', 'v1', 1.0, NOW(), NOW()),
         ($1, 'name',  'Multi Signal',          $2, 'thunder_app', 'v1', 1.0, NOW(), NOW()),
         ($1, 'dob',   '1990-06-01',            $2, 'thunder_app', 'v1', 1.0, NOW(), NOW())`,
      [existingFanId, testOrgId]
    );

    console.log('\nSetup complete — org, fan, three identifier_link rows seeded.');

    // ── CALL ─────────────────────────────────────────────────────────────────
    //
    // identifier_type  = 'email' with a one-char typo → no hard match (Path A skipped).
    //
    // identifiers carries the multi-signal format introduced by this fix:
    //   {
    //     name: 'Multi Signal',
    //     dob:  '1990-06-01',
    //   }
    //
    // resolverEngine now merges these into the inbound object so scoreMatch sees
    // inbound.name and inbound.dob populated — not null as before the fix.
    //
    // Both email_similarity and name_plus_dob fire → signals_matched has 2 entries.
    // Math.max(0.7, 0.7) = 0.70 → PATH D (0.60 <= 0.70 < 0.85).
    console.log('\nCalling resolverEngine (multi-signal inbound)...');
    const result = await resolverEngine(
      {
        identifier_type:  'email',
        identifier_value: 'mult1@test-synth.com',
        identifiers: {
          name: 'Multi Signal',
          dob:  '1990-06-01',
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

    // 1 — Path C fires (additive: 0.7 + 0.7 = 1.0 >= 0.85)
    assert(result.match_type === 'soft',
      '1. result.match_type === "soft" (Path C — additive score reached 1.0)');

    // 2 — confidence_score >= 0.85 (Path C threshold)
    assert(result.confidence_score >= 0.85,
      '2. result.confidence_score >= 0.85');

    // 3 — new fan record created
    assert(result.is_new_record === true,
      '3. result.is_new_record === true');

    // 4 — conflict_id is a non-null UUID
    assert(result.conflict_id !== null,
      '4. result.conflict_id is non-null');
    assert(UUID_RE.test(result.conflict_id),
      '4. result.conflict_id matches UUID format');

    // 5 — core assertion: signals_matched contains MORE THAN ONE entry.
    //     Under old code (identifiers ignored) only email_similarity appeared.
    //     Under new code both email_similarity and name_plus_dob appear.
    const conflictRows = await client.query(
      `SELECT fan_id_a, status, signals_matched
       FROM conflict_queue
       WHERE id = $1`,
      [result.conflict_id]
    );
    assert(conflictRows.rows.length === 1,
      '5. exactly one conflict_queue row');
    assert(conflictRows.rows[0].status === 'pending',
      '5. conflict_queue.status === "pending"');
    assert(conflictRows.rows[0].fan_id_a === existingFanId,
      '5. conflict_queue.fan_id_a === existingFanId');

    const signals = conflictRows.rows[0].signals_matched;
    assert(Array.isArray(signals),
      '5. signals_matched is an array');
    assert(signals.length > 1,
      `5. signals_matched.length > 1 (got ${signals.length}) — multi-signal fix proven`);

    // 6 — email_similarity present
    const signalNames = signals.map(s => s.signal);
    assert(signalNames.includes('email_similarity'),
      '6. signals_matched includes "email_similarity"');

    // 7 — name_plus_dob present — proves inbound.name and inbound.dob were
    //     populated from identifiers instead of being forced to null
    assert(signalNames.includes('name_plus_dob'),
      '7. signals_matched includes "name_plus_dob"');

    // 8 — exactly one pending conflict_queue row for testOrgId
    const pendingRows = await client.query(
      `SELECT COUNT(*) AS row_count
       FROM conflict_queue
       WHERE org_id = $1 AND status = 'pending'`,
      [testOrgId]
    );
    assert(parseInt(pendingRows.rows[0].row_count, 10) === 1,
      '8. exactly one pending conflict_queue row for testOrgId');

    // 9 — zero staging_household_data rows (no guardian_email signal)
    const stagingRows = await client.query(
      `SELECT COUNT(*) AS row_count
       FROM staging_household_data
       WHERE org_id = $1`,
      [testOrgId]
    );
    assert(parseInt(stagingRows.rows[0].row_count, 10) === 0,
      '9. zero staging_household_data rows — guardian_email signal absent');

    // 10 — exactly one audit_log row, match_type = 'soft' (Path C)
    const auditRows = await client.query(
      `SELECT match_type, identifier_type
       FROM audit_log
       WHERE idempotency_key = $1 AND org_id = $2`,
      [idempotencyKey, testOrgId]
    );
    assert(auditRows.rows.length === 1,
      '10. exactly one audit_log row');
    assert(auditRows.rows[0].match_type === 'soft',
      '10. audit_log.match_type === "soft" (Path C)');

    console.log('\n  All 10 assertions passed.\n');

  } finally {

    // ── CLEANUP ──────────────────────────────────────────────────────────────
    // FK order: staging_household_data → conflict_queue → audit_log →
    //           identifier_link → fan → org
    console.log('Cleaning up test data...');
    // audit_log is append-only — rows cannot be deleted (trigger blocks it).
    // fan and org rows cannot be deleted while audit_log references them via FK.
    // These rows are keyed to a random UUID and are harmless across future runs.
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
        `DELETE FROM identifier_link        WHERE org_id = $1`, [testOrgId]
      );
      console.log('Cleanup complete (audit_log, fan, org rows retained — append-only).\n');
    } catch (cleanupErr) {
      console.error('Cleanup error — test rows may remain:', cleanupErr.message);
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
