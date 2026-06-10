-- migration_010.sql
-- Golden Record Fan Identity Platform
-- OKC Thunder — Thunder Innovations Cohort
-- Author: Aaron
-- Sprint 3 pre-presentation fix
--
-- What this migration does:
-- Expands audit_log.event_type CHECK constraint to include
-- 'child_session_issued'.
-- household.js Component 33 (POST .../session) writes this
-- event_type to audit_log. The constraint from migration_007
-- does not include it — every child session audit write fails
-- with a CHECK constraint violation.
--
-- Depends on: migration_007.sql
-- Run after:  migration_009.sql
-- Blocks:     child_session_issued audit writes in production


-- ============================================================
-- SAFETY GUARD
-- Prevents accidental re-run.
-- Checks whether audit_log_event_type_check already includes
-- 'child_session_issued'. If it does, this migration was already
-- applied — abort.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'audit_log'::regclass
      AND contype  = 'c'
      AND conname  = 'audit_log_event_type_check'
      AND pg_get_constraintdef(oid) LIKE '%child_session_issued%'
  ) THEN
    RAISE EXCEPTION
      'migration_010 already applied — audit_log_event_type_check already '
      'includes child_session_issued. Aborting.';
  END IF;
END $$;


-- ============================================================
-- PART 1 — Expand audit_log.event_type CHECK constraint
--
-- migration_007 defined CHECK (event_type IN (
--   'resolution', 'session_issued', 'conflict_confirmed',
--   'conflict_rejected', 'merge_reversed', 'household_created',
--   'household_member_added', 'household_member_updated',
--   'household_member_severed', 'household_member_aged_up',
--   'profile_claimed', 'ingest_failure'
-- )) — 12 values.
--
-- household.js Component 33 issues child session tokens and
-- audits each issuance with event_type = 'child_session_issued'.
-- Without this migration, every child session audit INSERT
-- fails the CHECK constraint — child session issuance is
-- never audited in production.
-- ============================================================

ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_event_type_check;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_event_type_check
  CHECK (event_type IN (
    'resolution',
    'session_issued',
    'conflict_confirmed',
    'conflict_rejected',
    'merge_reversed',
    'household_created',
    'household_member_added',
    'household_member_updated',
    'household_member_severed',
    'household_member_aged_up',
    'profile_claimed',
    'ingest_failure',
    'child_session_issued'
  ));


-- ============================================================
-- VERIFICATION QUERIES
-- Run these after the migration to confirm success.
-- ============================================================

-- 1. Verify constraint includes all 13 event_type values
--    Expected: 1 row, definition includes child_session_issued
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'audit_log'::regclass
  AND contype  = 'c'
  AND conname  = 'audit_log_event_type_check';
-- Expected: all 13 event types present including child_session_issued


-- 2. Test insert with event_type = 'child_session_issued'
--    Creates minimal test fixtures, inserts a child_session_issued row,
--    then cleans up.
DO $$
DECLARE
  v_org_id UUID;
  v_fan_id UUID;
  v_log_id UUID;
  v_hash   TEXT;
BEGIN
  v_org_id := gen_random_uuid();
  v_fan_id := gen_random_uuid();
  v_log_id := gen_random_uuid();
  -- 64 hex chars — satisfies org_api_key_hash length constraint
  v_hash   := md5(v_org_id::text) || md5(v_org_id::text);

  INSERT INTO org (id, name, org_api_key_hash)
    VALUES (v_org_id, '_mig010_test_org', v_hash);

  -- Set RLS context before writing to RLS-protected tables
  PERFORM set_config('app.current_org_id', v_org_id::text, false);

  INSERT INTO fan (id, org_id)
    VALUES (v_fan_id, v_org_id);

  INSERT INTO audit_log (id, fan_id, org_id, event_type, status, created_at)
    VALUES (v_log_id, v_fan_id, v_org_id, 'child_session_issued', 'success', NOW());

  RAISE NOTICE 'TEST PASSED: audit_log accepts event_type = child_session_issued';
  RAISE NOTICE 'NOTE: test row id=% left in audit_log (append-only — intentional)', v_log_id;
  RAISE NOTICE 'NOTE: org _mig010_test_org and fan left — FK ref from audit_log prevents cleanup';

  RAISE NOTICE 'migration_010 verification complete';
END;
$$;
