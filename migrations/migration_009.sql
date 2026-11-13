-- migration_009.sql
-- Golden Record Fan Identity Platform
-- Golden Record
-- Author: Aaron
-- Sprint 2 constraint fix (applied in Sprint 3 cycle)
--
-- What this migration does:
-- Expands audit_log.match_type CHECK constraint.
-- migration_001 defined only 'hard', 'soft', 'probabilistic'.
-- Sprint 2 Path D writes match_type = 'conflict' to audit_log
-- on every lower-confidence probabilistic match queued for review.
-- Every Path D resolution fails in production with a CHECK
-- constraint violation until this migration is run.
--
-- Depends on: migration_001.sql
-- Run after:  migration_008.sql
-- Blocks:     Path D resolution events in production


-- ============================================================
-- SAFETY GUARD
-- Prevents accidental re-run.
-- Checks whether audit_log_match_type_check already includes
-- 'conflict'. If it does, this migration was already applied.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'audit_log'::regclass
      AND contype  = 'c'
      AND conname  = 'audit_log_match_type_check'
      AND pg_get_constraintdef(oid) LIKE '%conflict%'
  ) THEN
    RAISE EXCEPTION
      'migration_009 already applied — audit_log_match_type_check already '
      'includes conflict. Aborting.';
  END IF;
END $$;


-- ============================================================
-- PART 1 — Expand audit_log.match_type CHECK constraint
--
-- migration_001 defined CHECK (match_type IN
--   ('hard', 'soft', 'probabilistic'))
--
-- Sprint 2 resolverEngine.js Path D sets match_type = 'conflict'
-- when the probabilistic score falls between THRESHOLD_PATH_D
-- and THRESHOLD_PATH_C (lower-confidence match, queued for
-- staff review). The audit write at the end of the transaction
-- fails the CHECK constraint — the entire Path D transaction
-- rolls back and the fan record is never created.
--
-- Adding 'conflict' aligns the constraint with the four
-- match_type values that resolverEngine can produce:
--   hard         — exact identifier match (Path A)
--   hard         — new record, no match (Path B — also 'hard')
--   soft         — high-confidence probabilistic (Path C)
--   conflict     — lower-confidence probabilistic (Path D)
-- ============================================================

ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_match_type_check;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_match_type_check
  CHECK (match_type IN (
    'hard',
    'soft',
    'probabilistic',
    'conflict'
  ));


-- ============================================================
-- VERIFICATION QUERIES
-- Run these after the migration to confirm success.
-- ============================================================

-- 1. Verify constraint includes all four match_type values
--    Expected: 1 row, definition includes hard, soft,
--              probabilistic, and conflict
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'audit_log'::regclass
  AND contype  = 'c'
  AND conname  = 'audit_log_match_type_check';
-- Expected: (hard, soft, probabilistic, conflict) all present


-- 2. Test insert with match_type = 'conflict'
--    audit_log.fan_id is nullable — no fan fixture needed.
--    audit_log.org_id is NOT NULL — one test org is created.
--    audit_log is append-only — test row intentionally left.
--    org fixture left because the audit_log FK prevents cleanup.
--    Both rows are prefixed _mig009_ for identification.
DO $$
DECLARE
  v_org_id UUID;
  v_log_id UUID;
  v_hash   TEXT;
BEGIN
  v_org_id := gen_random_uuid();
  v_log_id := gen_random_uuid();
  -- 64 hex chars — satisfies org_api_key_hash length constraint
  v_hash   := md5(v_org_id::text) || md5(v_org_id::text);

  INSERT INTO org (id, name, org_api_key_hash)
    VALUES (v_org_id, '_mig009_test_org', v_hash);

  -- Set RLS context before writing to RLS-protected tables
  PERFORM set_config('app.current_org_id', v_org_id::text, false);

  -- fan_id intentionally omitted — nullable column, no fan fixture needed
  INSERT INTO audit_log
    (id, org_id, event_type, match_type, status, created_at)
  VALUES
    (v_log_id, v_org_id, 'resolution', 'conflict', 'success', NOW());

  RAISE NOTICE 'TEST PASSED: audit_log accepts match_type = conflict';
  RAISE NOTICE 'NOTE: test row id=% left in audit_log (append-only — intentional)', v_log_id;
  RAISE NOTICE 'NOTE: org _mig009_test_org left — FK ref from audit_log prevents cleanup';

  RAISE NOTICE 'migration_009 verification complete';
END;
$$;
