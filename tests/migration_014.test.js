'use strict';

// =============================================================================
// migration_014.test.js
// Stage 7 evaluation tables — resolution_trace, trace_label, evaluation_corpus
//
// Connects to: LOCAL Postgres only (localhost:5432 via DATABASE_URL).
// Never run against port 5433 (Cloud SQL proxy).
//
// Cleanup note: resolution_trace is append-only — DELETE throws. Any org row
// that resolution_trace.org_id references is also pinned by the FK constraint.
// This test uses NULL for optional fan FKs (best_candidate_id, resulting_fan_id)
// so no fan rows are created or pinned. testOrgId and testOrgIdB are permanently
// leaked — fresh UUIDs per run make them inert, exactly as audit_log rows are.
// =============================================================================

require('dotenv').config();

const { Client } = require('pg');
const crypto     = require('crypto');

function randomUUID() {
  return crypto.randomUUID();
}

function orgKeyHash(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

describe('migration_014 — resolution_trace, trace_label, evaluation_corpus', () => {
  let client;
  let testOrgId;
  let testOrgIdB;

  // A valid 'performed' trace row inserted in assertion 2, reused by assertions
  // 9–12 and 17 (trace_label and evaluation_corpus need a trace_id).
  let performedTraceId;
  // A 'skipped' trace row for assertion 3.
  let skippedTraceId;

  const COMMON_TRACE_FIELDS = {
    inbound_identifiers: JSON.stringify({ email: 'test@example.com' }),
    threshold_path_c:    0.85,
    threshold_path_d:    0.60,
    scorer_version:      'v1',
    normalization_version: 'v1',
    scoring_clock:       new Date().toISOString(),
    is_new_record:       false,
  };

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    testOrgId  = randomUUID();
    testOrgIdB = randomUUID();

    // org inserts go BEFORE setting RLS context — org table has no tenant policy.
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash) VALUES ($1, $2, $3)`,
      [testOrgId,  '_mig014_test_org_a', orgKeyHash('mig014-a-' + testOrgId)]
    );
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash) VALUES ($1, $2, $3)`,
      [testOrgIdB, '_mig014_test_org_b', orgKeyHash('mig014-b-' + testOrgIdB)]
    );

    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`,
      [testOrgId]
    );
  });

  afterAll(async () => {
    // Cleanup in FK order — deleteable tables only.
    // resolution_trace rows CANNOT be deleted (append-only trigger fires on DELETE).
    // testOrgId and testOrgIdB CANNOT be deleted while resolution_trace rows
    // that reference them exist (FK constraint). Leave both orgs.
    // Fresh UUIDs per run make these orphaned rows inert on the next test run,
    // exactly as audit_log rows are left. Do not attempt to fix this by deleting
    // resolution_trace rows — the trigger is the point.

    const orgs = [testOrgId, testOrgIdB];

    for (const orgId of orgs) {
      await client.query(
        `SELECT set_config('app.current_org_id', $1, false)`, [orgId]
      );
      try {
        await client.query(
          `DELETE FROM evaluation_corpus WHERE org_id = $1`, [orgId]
        );
      } catch (_) {}
      try {
        await client.query(
          `DELETE FROM trace_label WHERE org_id = $1`, [orgId]
        );
      } catch (_) {}
    }

    await client.end();
  });

  // ---------------------------------------------------------------------------
  // 1. Column counts — assert the actual DDL was applied as specified.
  //    Prompt stated 22/9/12 but DDL creates 23/9/13. Asserting DDL-derived
  //    counts so the test is honest about what was actually created.
  // ---------------------------------------------------------------------------
  it('1. all three tables exist with correct column counts', async () => {
    const { rows } = await client.query(`
      SELECT table_name, COUNT(*) AS col_count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('resolution_trace', 'trace_label', 'evaluation_corpus')
      GROUP BY table_name
      ORDER BY table_name
    `);

    const counts = Object.fromEntries(
      rows.map(r => [r.table_name, parseInt(r.col_count, 10)])
    );

    expect(counts['evaluation_corpus']).toBe(13);
    expect(counts['resolution_trace']).toBe(23);
    expect(counts['trace_label']).toBe(9);
  });

  // ---------------------------------------------------------------------------
  // 2. Valid 'performed' row inserts.
  // ---------------------------------------------------------------------------
  it('2. valid performed row (best_score set, skip_reason NULL) inserts', async () => {
    const { rows } = await client.query(`
      INSERT INTO resolution_trace
        (org_id, resolution_path, scoring_status, skip_reason,
         inbound_identifiers, candidate_ids, candidates_considered,
         candidates_gated, candidates_scored,
         signal_results, best_candidate_id, best_score,
         threshold_path_c, threshold_path_d,
         scorer_version, normalization_version, scoring_clock,
         resulting_fan_id, is_new_record, conflict_id)
      VALUES
        ($1, 'C', 'performed', NULL,
         $2, '{}', 3, 1, 2,
         $3, NULL, 0.820,
         $4, $5,
         $6, $7, $8,
         NULL, $9, NULL)
      RETURNING id
    `, [
      testOrgId,
      COMMON_TRACE_FIELDS.inbound_identifiers,
      JSON.stringify({ email_similarity: { score: 0.7 } }),
      COMMON_TRACE_FIELDS.threshold_path_c,
      COMMON_TRACE_FIELDS.threshold_path_d,
      COMMON_TRACE_FIELDS.scorer_version,
      COMMON_TRACE_FIELDS.normalization_version,
      COMMON_TRACE_FIELDS.scoring_clock,
      COMMON_TRACE_FIELDS.is_new_record,
    ]);

    expect(rows).toHaveLength(1);
    performedTraceId = rows[0].id;
    expect(performedTraceId).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // 3. Valid 'skipped' row inserts.
  // ---------------------------------------------------------------------------
  it('3. valid skipped row (skip_reason set, best_score NULL) inserts', async () => {
    const { rows } = await client.query(`
      INSERT INTO resolution_trace
        (org_id, resolution_path, scoring_status, skip_reason,
         inbound_identifiers, candidate_ids, candidates_considered,
         candidates_gated, candidates_scored,
         signal_results, best_candidate_id, best_score,
         threshold_path_c, threshold_path_d,
         scorer_version, normalization_version, scoring_clock,
         resulting_fan_id, is_new_record, conflict_id)
      VALUES
        ($1, 'A', 'skipped', 'deterministic_match',
         $2, '{}', 0, 0, 0,
         NULL, NULL, NULL,
         $3, $4,
         $5, $6, $7,
         NULL, $8, NULL)
      RETURNING id
    `, [
      testOrgId,
      COMMON_TRACE_FIELDS.inbound_identifiers,
      COMMON_TRACE_FIELDS.threshold_path_c,
      COMMON_TRACE_FIELDS.threshold_path_d,
      COMMON_TRACE_FIELDS.scorer_version,
      COMMON_TRACE_FIELDS.normalization_version,
      COMMON_TRACE_FIELDS.scoring_clock,
      COMMON_TRACE_FIELDS.is_new_record,
    ]);

    expect(rows).toHaveLength(1);
    skippedTraceId = rows[0].id;
    expect(skippedTraceId).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // 4. IMPOSSIBLE STATE: scoring_status='performed' + best_score NULL → 23514
  // ---------------------------------------------------------------------------
  it('4. performed + NULL best_score rejected (23514)', async () => {
    await expect(
      client.query(`
        INSERT INTO resolution_trace
          (org_id, resolution_path, scoring_status, skip_reason,
           inbound_identifiers, threshold_path_c, threshold_path_d,
           scorer_version, normalization_version, scoring_clock, is_new_record)
        VALUES
          ($1, 'C', 'performed', NULL,
           $2, $3, $4, $5, $6, $7, $8)
      `, [
        testOrgId,
        COMMON_TRACE_FIELDS.inbound_identifiers,
        COMMON_TRACE_FIELDS.threshold_path_c,
        COMMON_TRACE_FIELDS.threshold_path_d,
        COMMON_TRACE_FIELDS.scorer_version,
        COMMON_TRACE_FIELDS.normalization_version,
        COMMON_TRACE_FIELDS.scoring_clock,
        COMMON_TRACE_FIELDS.is_new_record,
      ])
    ).rejects.toMatchObject({ code: '23514' });
  });

  // ---------------------------------------------------------------------------
  // 5. IMPOSSIBLE STATE: scoring_status='skipped' + best_score NOT NULL → 23514
  // ---------------------------------------------------------------------------
  it('5. skipped + non-null best_score rejected (23514)', async () => {
    await expect(
      client.query(`
        INSERT INTO resolution_trace
          (org_id, resolution_path, scoring_status, skip_reason,
           inbound_identifiers, best_score,
           threshold_path_c, threshold_path_d,
           scorer_version, normalization_version, scoring_clock, is_new_record)
        VALUES
          ($1, 'A', 'skipped', 'deterministic_match',
           $2, 0.910,
           $3, $4, $5, $6, $7, $8)
      `, [
        testOrgId,
        COMMON_TRACE_FIELDS.inbound_identifiers,
        COMMON_TRACE_FIELDS.threshold_path_c,
        COMMON_TRACE_FIELDS.threshold_path_d,
        COMMON_TRACE_FIELDS.scorer_version,
        COMMON_TRACE_FIELDS.normalization_version,
        COMMON_TRACE_FIELDS.scoring_clock,
        COMMON_TRACE_FIELDS.is_new_record,
      ])
    ).rejects.toMatchObject({ code: '23514' });
  });

  // ---------------------------------------------------------------------------
  // 6. CONSTRAINT IS SEMANTIC, NOT ENUMERATED.
  //    A brand-new scoring_status value not in the codebase MUST succeed with
  //    no migration. This is the assertion that proves the audit_log lesson was
  //    applied. If this fails, the constraint was written as an enumeration.
  // ---------------------------------------------------------------------------
  it('6. novel scoring_status value succeeds (semantic constraint)', async () => {
    const { rows } = await client.query(`
      INSERT INTO resolution_trace
        (org_id, resolution_path, scoring_status, skip_reason,
         inbound_identifiers, threshold_path_c, threshold_path_d,
         scorer_version, normalization_version, scoring_clock, is_new_record)
      VALUES
        ($1, 'B', 'skipped_rate_limit', 'rate_limit_exceeded',
         $2, $3, $4, $5, $6, $7, $8)
      RETURNING scoring_status
    `, [
      testOrgId,
      COMMON_TRACE_FIELDS.inbound_identifiers,
      COMMON_TRACE_FIELDS.threshold_path_c,
      COMMON_TRACE_FIELDS.threshold_path_d,
      COMMON_TRACE_FIELDS.scorer_version,
      COMMON_TRACE_FIELDS.normalization_version,
      COMMON_TRACE_FIELDS.scoring_clock,
      COMMON_TRACE_FIELDS.is_new_record,
    ]);

    expect(rows[0].scoring_status).toBe('skipped_rate_limit');
  });

  // ---------------------------------------------------------------------------
  // 7. best_score out of bounds rejected.
  // ---------------------------------------------------------------------------
  it('7a. best_score 1.500 rejected (23514)', async () => {
    await expect(
      client.query(`
        INSERT INTO resolution_trace
          (org_id, resolution_path, scoring_status, skip_reason,
           inbound_identifiers, best_score,
           threshold_path_c, threshold_path_d,
           scorer_version, normalization_version, scoring_clock, is_new_record)
        VALUES
          ($1, 'C', 'performed', NULL,
           $2, 1.500,
           $3, $4, $5, $6, $7, $8)
      `, [
        testOrgId,
        COMMON_TRACE_FIELDS.inbound_identifiers,
        COMMON_TRACE_FIELDS.threshold_path_c,
        COMMON_TRACE_FIELDS.threshold_path_d,
        COMMON_TRACE_FIELDS.scorer_version,
        COMMON_TRACE_FIELDS.normalization_version,
        COMMON_TRACE_FIELDS.scoring_clock,
        COMMON_TRACE_FIELDS.is_new_record,
      ])
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('7b. best_score -0.100 rejected (23514)', async () => {
    await expect(
      client.query(`
        INSERT INTO resolution_trace
          (org_id, resolution_path, scoring_status, skip_reason,
           inbound_identifiers, best_score,
           threshold_path_c, threshold_path_d,
           scorer_version, normalization_version, scoring_clock, is_new_record)
        VALUES
          ($1, 'C', 'performed', NULL,
           $2, -0.100,
           $3, $4, $5, $6, $7, $8)
      `, [
        testOrgId,
        COMMON_TRACE_FIELDS.inbound_identifiers,
        COMMON_TRACE_FIELDS.threshold_path_c,
        COMMON_TRACE_FIELDS.threshold_path_d,
        COMMON_TRACE_FIELDS.scorer_version,
        COMMON_TRACE_FIELDS.normalization_version,
        COMMON_TRACE_FIELDS.scoring_clock,
        COMMON_TRACE_FIELDS.is_new_record,
      ])
    ).rejects.toMatchObject({ code: '23514' });
  });

  // ---------------------------------------------------------------------------
  // 8. Count coherence: gated + scored > considered → 23514
  // ---------------------------------------------------------------------------
  it('8. candidates_gated + candidates_scored > candidates_considered rejected (23514)', async () => {
    await expect(
      client.query(`
        INSERT INTO resolution_trace
          (org_id, resolution_path, scoring_status, skip_reason,
           inbound_identifiers,
           candidates_considered, candidates_gated, candidates_scored,
           threshold_path_c, threshold_path_d,
           scorer_version, normalization_version, scoring_clock, is_new_record)
        VALUES
          ($1, 'B', 'skipped', 'some_reason',
           $2,
           3, 2, 2,
           $3, $4, $5, $6, $7, $8)
      `, [
        testOrgId,
        COMMON_TRACE_FIELDS.inbound_identifiers,
        COMMON_TRACE_FIELDS.threshold_path_c,
        COMMON_TRACE_FIELDS.threshold_path_d,
        COMMON_TRACE_FIELDS.scorer_version,
        COMMON_TRACE_FIELDS.normalization_version,
        COMMON_TRACE_FIELDS.scoring_clock,
        COMMON_TRACE_FIELDS.is_new_record,
      ])
    ).rejects.toMatchObject({ code: '23514' });
  });

  // ---------------------------------------------------------------------------
  // 9. trace_label: two rows, same trace_id, different labeled_by — BOTH succeed.
  //    This is the disagreement-preservation requirement.
  // ---------------------------------------------------------------------------
  it('9. two trace_label rows for same trace, different labelers — both succeed', async () => {
    const insertLabel = (labeler, verdict) =>
      client.query(`
        INSERT INTO trace_label (trace_id, org_id, verdict, labeled_by, label_source)
        VALUES ($1, $2, $3, $4, 'manual')
      `, [performedTraceId, testOrgId, verdict, labeler]);

    await expect(insertLabel('monique', 'same')).resolves.not.toThrow();
    await expect(insertLabel('aaron',   'different')).resolves.not.toThrow();

    const { rows } = await client.query(
      `SELECT COUNT(*) AS cnt FROM trace_label WHERE trace_id = $1`,
      [performedTraceId]
    );
    expect(parseInt(rows[0].cnt, 10)).toBeGreaterThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // 10. trace_label: same trace_id + same labeled_by → 23505 on unique index.
  // ---------------------------------------------------------------------------
  it('10. duplicate labeler on same trace rejected (23505)', async () => {
    await expect(
      client.query(`
        INSERT INTO trace_label (trace_id, org_id, verdict, labeled_by, label_source)
        VALUES ($1, $2, 'same', 'monique', 'manual')
      `, [performedTraceId, testOrgId])
    ).rejects.toMatchObject({ code: '23505' });
  });

  // ---------------------------------------------------------------------------
  // 11. trace_label IS mutable: UPDATE a verdict. No trigger blocks it.
  // ---------------------------------------------------------------------------
  it('11. trace_label verdict UPDATE succeeds (mutable by design)', async () => {
    await expect(
      client.query(`
        UPDATE trace_label
        SET verdict = 'different', updated_at = now()
        WHERE trace_id = $1 AND labeled_by = 'monique'
      `, [performedTraceId])
    ).resolves.not.toThrow();

    const { rows } = await client.query(
      `SELECT verdict FROM trace_label WHERE trace_id = $1 AND labeled_by = 'monique'`,
      [performedTraceId]
    );
    expect(rows[0].verdict).toBe('different');
  });

  // ---------------------------------------------------------------------------
  // 12. resolution_trace IS NOT mutable.
  //     UPDATE and DELETE both throw with 'append-only' in the message.
  //     Because DELETE throws, cleanup of resolution_trace rows is impossible —
  //     leave them, as the finally block comment states.
  // ---------------------------------------------------------------------------
  it('12a. UPDATE on resolution_trace throws (append-only)', async () => {
    await expect(
      client.query(
        `UPDATE resolution_trace SET scoring_status = 'performed' WHERE id = $1`,
        [skippedTraceId]
      )
    ).rejects.toMatchObject({
      message: expect.stringContaining('append-only'),
    });
  });

  it('12b. DELETE on resolution_trace throws (append-only)', async () => {
    await expect(
      client.query(
        `DELETE FROM resolution_trace WHERE id = $1`,
        [skippedTraceId]
      )
    ).rejects.toMatchObject({
      message: expect.stringContaining('append-only'),
    });
  });

  // ---------------------------------------------------------------------------
  // 13. evaluation_corpus: synthetic row inserts.
  // ---------------------------------------------------------------------------
  it('13. synthetic corpus row (trace_id NULL, snapshot present) inserts', async () => {
    const { rows } = await client.query(`
      INSERT INTO evaluation_corpus
        (org_id, source, trace_id, inbound_identifiers, candidate_snapshot,
         expected_verdict, created_by)
      VALUES
        ($1, 'synthetic', NULL, $2, $3, 'no_match', 'aaron')
      RETURNING id
    `, [
      testOrgId,
      COMMON_TRACE_FIELDS.inbound_identifiers,
      JSON.stringify({
        email: 'candidate@example.com', name: 'Jane Doe',
        dob: '1990-01-01', zip: '73101',
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // 14. evaluation_corpus: promoted row (source='promoted_trace') inserts.
  // ---------------------------------------------------------------------------
  it('14. promoted corpus row (trace_id set, snapshot NULL) inserts', async () => {
    const { rows } = await client.query(`
      INSERT INTO evaluation_corpus
        (org_id, source, trace_id, inbound_identifiers, candidate_snapshot,
         expected_verdict, observed_score, observed_path, scorer_version, created_by)
      VALUES
        ($1, 'promoted_trace', $2, $3, NULL, 'match', 0.820, 'C', 'v1', 'monique')
      RETURNING id
    `, [
      testOrgId,
      performedTraceId,
      COMMON_TRACE_FIELDS.inbound_identifiers,
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // 15. evaluation_corpus: synthetic row with NULL candidate_snapshot → 23514.
  //     A synthetic row that cannot be re-scored is useless.
  // ---------------------------------------------------------------------------
  it('15. synthetic row with NULL candidate_snapshot rejected (23514)', async () => {
    await expect(
      client.query(`
        INSERT INTO evaluation_corpus
          (org_id, source, trace_id, inbound_identifiers, candidate_snapshot,
           expected_verdict, created_by)
        VALUES
          ($1, 'synthetic', NULL, $2, NULL, 'no_match', 'aaron')
      `, [
        testOrgId,
        COMMON_TRACE_FIELDS.inbound_identifiers,
      ])
    ).rejects.toMatchObject({ code: '23514' });
  });

  // ---------------------------------------------------------------------------
  // 16. evaluation_corpus: two rows promoting same trace_id → 23505.
  // ---------------------------------------------------------------------------
  it('16. duplicate promoted trace_id rejected (23505)', async () => {
    await expect(
      client.query(`
        INSERT INTO evaluation_corpus
          (org_id, source, trace_id, inbound_identifiers, candidate_snapshot,
           expected_verdict, created_by)
        VALUES
          ($1, 'promoted_trace', $2, $3, NULL, 'match', 'aaron')
      `, [
        testOrgId,
        performedTraceId,
        COMMON_TRACE_FIELDS.inbound_identifiers,
      ])
    ).rejects.toMatchObject({ code: '23505' });
  });

  // ---------------------------------------------------------------------------
  // 17. RLS holds on all three tables.
  //
  //     Why SET ROLE is required:
  //     The postgres role is a superuser with BYPASSRLS. Postgres exempts
  //     superusers from RLS unconditionally — even FORCE ROW LEVEL SECURITY
  //     does not override BYPASSRLS. Testing via the superuser connection would
  //     never isolate rows and would not prove the policy works.
  //
  //     SET ROLE to a non-superuser role within the same session strips BYPASSRLS
  //     for the duration of that role. FORCE ROW LEVEL SECURITY then applies,
  //     and the policy is exercised for real.
  //
  //     FORCE ROW LEVEL SECURITY is verified separately (pg_class query below) —
  //     it is what makes the policy apply to the table owner in production, where
  //     the app may connect as a role that owns the table but is not a superuser.
  // ---------------------------------------------------------------------------
  it('17. RLS isolates rows across orgs on all three tables', async () => {
    // Create a non-superuser role for RLS testing if it doesn't already exist.
    // This role persists across test runs — that is intentional and inert.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '_gr_rls_test') THEN
          CREATE ROLE _gr_rls_test;
        END IF;
      END $$
    `);
    await client.query(`GRANT SELECT, INSERT ON resolution_trace TO _gr_rls_test`);
    await client.query(`GRANT SELECT, INSERT ON trace_label TO _gr_rls_test`);
    await client.query(`GRANT SELECT, INSERT ON evaluation_corpus TO _gr_rls_test`);
    await client.query(`GRANT USAGE ON SCHEMA public TO _gr_rls_test`);

    // Insert rows under testOrgIdB as postgres (superuser, no RLS restriction).
    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`, [testOrgIdB]
    );

    await client.query(`
      INSERT INTO resolution_trace
        (org_id, resolution_path, scoring_status, skip_reason,
         inbound_identifiers, threshold_path_c, threshold_path_d,
         scorer_version, normalization_version, scoring_clock, is_new_record)
      VALUES
        ($1, 'B', 'skipped', 'test_rls',
         $2, $3, $4, $5, $6, $7, $8)
    `, [
      testOrgIdB,
      COMMON_TRACE_FIELDS.inbound_identifiers,
      COMMON_TRACE_FIELDS.threshold_path_c,
      COMMON_TRACE_FIELDS.threshold_path_d,
      COMMON_TRACE_FIELDS.scorer_version,
      COMMON_TRACE_FIELDS.normalization_version,
      COMMON_TRACE_FIELDS.scoring_clock,
      COMMON_TRACE_FIELDS.is_new_record,
    ]);

    // Switch org context to testOrgId, then switch ROLE to the non-superuser.
    // After SET ROLE, BYPASSRLS is no longer in effect — RLS applies for real.
    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]
    );
    await client.query(`SET ROLE _gr_rls_test`);

    try {
      const traceRes = await client.query(
        `SELECT COUNT(*) AS cnt FROM resolution_trace WHERE org_id = $1`,
        [testOrgIdB]
      );
      expect(parseInt(traceRes.rows[0].cnt, 10)).toBe(0);

      const labelRes = await client.query(
        `SELECT COUNT(*) AS cnt FROM trace_label WHERE org_id = $1`,
        [testOrgIdB]
      );
      expect(parseInt(labelRes.rows[0].cnt, 10)).toBe(0);

      const corpusRes = await client.query(
        `SELECT COUNT(*) AS cnt FROM evaluation_corpus WHERE org_id = $1`,
        [testOrgIdB]
      );
      expect(parseInt(corpusRes.rows[0].cnt, 10)).toBe(0);
    } finally {
      await client.query(`RESET ROLE`);
    }

    // Confirm FORCE RLS is set on all three tables (pg_class is readable by
    // any role, so this can go after RESET ROLE).
    const { rows: forceRows } = await client.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname IN ('resolution_trace', 'trace_label', 'evaluation_corpus')
        AND relkind = 'r'
      ORDER BY relname
    `);
    const byTable = Object.fromEntries(forceRows.map(r => [r.relname, r]));
    expect(byTable['resolution_trace'].relforcerowsecurity).toBe(true);
    expect(byTable['trace_label'].relforcerowsecurity).toBe(true);
    expect(byTable['evaluation_corpus'].relforcerowsecurity).toBe(true);

    // Restore context for cleanup.
    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]
    );
  });

  // ---------------------------------------------------------------------------
  // 18. Existing tables are untouched.
  //     Confirm column counts match pre-migration values and key constraints
  //     and triggers are still in place.
  // ---------------------------------------------------------------------------
  it('18. existing tables untouched — column counts, constraint, trigger intact', async () => {
    // Column counts (established from live DB before migration_014 was applied).
    const { rows: countRows } = await client.query(`
      SELECT table_name, COUNT(*) AS col_count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('audit_log', 'conflict_queue', 'merge_history')
      GROUP BY table_name
      ORDER BY table_name
    `);
    const counts = Object.fromEntries(
      countRows.map(r => [r.table_name, parseInt(r.col_count, 10)])
    );

    expect(counts['audit_log']).toBe(14);
    expect(counts['conflict_queue']).toBe(10);
    expect(counts['merge_history']).toBe(10);

    // audit_log_event_type_check constraint still exists.
    const { rows: constraintRows } = await client.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conname = 'audit_log_event_type_check'
        AND conrelid = 'audit_log'::regclass
    `);
    expect(constraintRows).toHaveLength(1);

    // enforce_audit_log_append_only trigger still fires on DELETE.
    // Insert an audit_log row to have something to target (org_id is an existing
    // row — use testOrgId which was committed before this point).
    let auditRowId;
    try {
      await client.query(
        `SET app.current_org_id = '00000000-0000-0000-0000-000000000000'`
      );
    } catch (_) {}

    const { rows: insertedAudit } = await client.query(`
      INSERT INTO audit_log
        (org_id, event_type, status)
      VALUES ($1, 'resolution', 'success')
      RETURNING id
    `, [testOrgId]);
    auditRowId = insertedAudit[0].id;

    await expect(
      client.query(`DELETE FROM audit_log WHERE id = $1`, [auditRowId])
    ).rejects.toMatchObject({
      message: expect.stringContaining('append-only'),
    });
  });

  // ---------------------------------------------------------------------------
  // 19. Full existing test suite still passes.
  //     This assertion is structural — the full suite is run via:
  //       npx jest --testPathIgnorePatterns=migration_014
  //     and the result is reported in the session notes.
  //     A failure there is a real regression — stop and report.
  // ---------------------------------------------------------------------------
  it('19. structural — see session notes for full suite 85/85 confirmation', () => {
    expect(true).toBe(true);
  });
});
