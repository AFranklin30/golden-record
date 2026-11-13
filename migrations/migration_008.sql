-- migration_008.sql
-- Golden Record Fan Identity Platform
-- Golden Record
-- Author: Aaron
-- Sprint 3 (data integrity follow-up)
--
-- What this migration does:
-- Enables Row Level Security on conflict_queue.
-- This table was created in migration_004 but RLS was not applied
-- at that time. All other tenant tables have RLS enforced:
--   Sprint 1 tables — migration_003
--   Sprint 3 tables — migration_006
-- conflict_queue is the only remaining gap.
--
-- Depends on: migration_001.sql, migration_004.sql
-- Run after:  migration_007.sql
-- Blocks:     38C operational readiness check


-- ============================================================
-- SAFETY GUARD
-- Prevents accidental re-run — checks for the tenant_isolation
-- policy on conflict_queue as a proxy for whether this
-- migration has been applied.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_policies
    WHERE tablename  = 'conflict_queue'
      AND policyname = 'tenant_isolation'
  ) THEN
    RAISE EXCEPTION
      'migration_008 already applied — tenant_isolation policy exists '
      'on conflict_queue. Aborting.';
  END IF;
END $$;


-- ============================================================
-- RLS on conflict_queue
--
-- Tenant isolation at the database layer for the table added
-- in migration_004. Without RLS a misconfigured query or
-- application bug could return conflict_queue rows belonging
-- to another org. RLS enforces org_id scoping at the Postgres
-- level — a second line of defense that cannot be bypassed by
-- application code.
--
-- Policy: USING clause compares each row's org_id to the
-- session variable app.current_org_id, set by the application
-- via rlsContextMiddleware after orgAuthMiddleware resolves
-- the org. Same middleware and same setting name used for all
-- other RLS tables in this system.
--
-- Why FORCE ROW LEVEL SECURITY?
-- Cloud SQL connects the application as the table owner.
-- Without FORCE the table owner bypasses RLS by default.
-- FORCE ensures the policy applies to every connection
-- including the service account — required for Cloud SQL.
-- ============================================================

ALTER TABLE conflict_queue ENABLE ROW LEVEL SECURITY;

-- Tenant isolation: each request sees only conflict_queue rows
-- belonging to the calling org.
CREATE POLICY tenant_isolation ON conflict_queue
  USING (org_id = current_setting('app.current_org_id')::uuid);

ALTER TABLE conflict_queue FORCE ROW LEVEL SECURITY;


-- ============================================================
-- VERIFICATION QUERIES
-- Run these after the migration to confirm success.
-- ============================================================

-- 1. RLS enabled on conflict_queue — expected: 1 row, rowsecurity = true
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'conflict_queue';
-- Expected: 1 row with rowsecurity = true

-- 2. Tenant isolation policy exists — expected: 1 row
SELECT policyname
FROM pg_policies
WHERE tablename = 'conflict_queue';
-- Expected: tenant_isolation

-- 3. RLS blocks cross-tenant access
-- Inserts one test org, two test fans, and one conflict_queue row,
-- then queries from a different org context and confirms zero rows
-- are returned. Cleans up all test data before exiting.
DO $$
DECLARE
  v_org_id      UUID;
  v_fan_id_a    UUID;
  v_fan_id_b    UUID;
  v_conflict_id UUID;
  v_fake_org    UUID;
  v_hash        TEXT;
  v_count       INTEGER;
  rls_blocked   BOOLEAN := FALSE;
BEGIN
  v_org_id      := gen_random_uuid();
  v_fan_id_a    := gen_random_uuid();
  v_fan_id_b    := gen_random_uuid();
  v_conflict_id := gen_random_uuid();
  v_fake_org    := gen_random_uuid();
  -- 64 hex chars — satisfies org_api_key_hash length constraint
  v_hash        := md5(v_org_id::text) || md5(v_org_id::text);

  INSERT INTO org (id, name, org_api_key_hash)
    VALUES (v_org_id, '_rls008_test_org', v_hash);

  -- set RLS context to test org before inserting into RLS-protected tables
  PERFORM set_config('app.current_org_id', v_org_id::text, false);

  INSERT INTO fan (id, org_id) VALUES (v_fan_id_a, v_org_id);
  INSERT INTO fan (id, org_id) VALUES (v_fan_id_b, v_org_id);

  INSERT INTO conflict_queue
    (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched)
  VALUES
    (v_conflict_id, v_fan_id_a, v_fan_id_b, v_org_id,
     0.750, '[]'::jsonb);

  -- switch to a different org — RLS should block the test row
  PERFORM set_config('app.current_org_id', v_fake_org::text, false);

  SELECT COUNT(*) INTO v_count FROM conflict_queue;

  IF v_count = 0 THEN
    rls_blocked := TRUE;
    RAISE NOTICE 'RLS TEST PASSED: conflict_queue returned 0 rows for cross-tenant org';
  ELSE
    RAISE NOTICE 'RLS TEST FAILED: conflict_queue returned % rows for wrong org', v_count;
  END IF;

  -- restore context to test org before cleanup
  PERFORM set_config('app.current_org_id', v_org_id::text, false);

  DELETE FROM conflict_queue WHERE id = v_conflict_id;
  DELETE FROM fan             WHERE id = v_fan_id_a;
  DELETE FROM fan             WHERE id = v_fan_id_b;
  DELETE FROM org             WHERE id = v_org_id;

  IF NOT rls_blocked THEN
    RAISE EXCEPTION
      'RLS verification failed — conflict_queue returned rows for wrong org. '
      'Confirm ENABLE ROW LEVEL SECURITY and FORCE ROW LEVEL SECURITY '
      'are both applied to the conflict_queue table.';
  END IF;
END;
$$;
