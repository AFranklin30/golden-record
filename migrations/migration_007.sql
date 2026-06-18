-- migration_007.sql
-- Golden Record Fan Identity Platform
-- OKC Thunder — Thunder Innovations Cohort
-- Author: Aaron
-- Sprint 3
--
-- What this migration does:
-- 1. Expands audit_log.event_type CHECK constraint
--    Sprint 1 defined only 'resolution' and 'session_issued'.
--    Sprints 2 and 3 added 10 new event types that were blocked.
-- 2. Expands audit_log.identifier_type CHECK constraint
--    Sprint 1 defined only 5 identifier types.
--    Sprint 3 added 5 new types used in household resolution.
--    Note: identifier_link.identifier_type was already fixed in
--    migration_005 Part 9 — that table is NOT touched here.
--
-- Depends on: migration_001.sql
-- Run after:  migration_006.sql
-- Blocks:     any Sprint 2+ audit_log write for new event types
--             any Sprint 3 resolution where identifier_type is
--             name, dob, zip, guardian_email, or guardian_phone


-- ============================================================
-- SAFETY GUARD
-- Prevents accidental re-run.
-- Checks whether the new event_type constraint already includes
-- 'conflict_confirmed'. If it does, this migration was already
-- applied — abort.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'audit_log'::regclass
      AND contype = 'c'
      AND conname = 'audit_log_event_type_check'
      AND pg_get_constraintdef(oid) LIKE '%conflict_confirmed%'
  ) THEN
    RAISE EXCEPTION
      'migration_007 already applied — audit_log_event_type_check already '
      'includes conflict_confirmed. Aborting.';
  END IF;
END $$;


-- ============================================================
-- PART 1 — Expand audit_log.event_type CHECK constraint
--
-- migration_001 defined CHECK (event_type IN
--   ('resolution', 'session_issued'))
--
-- That constraint blocks every Sprint 2 and Sprint 3 audit write:
--   conflicts.js writes conflict_confirmed, conflict_rejected,
--   merge_reversed; household.js writes household_created,
--   household_member_added, household_member_updated,
--   household_member_severed, household_member_aged_up,
--   profile_claimed. ingest_failure is added proactively.
--
-- Postgres names inline column-level CHECK constraints as
-- {table}_{column}_check. The constraint from migration_001 is
-- audit_log_event_type_check.
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
    'ingest_failure'
  ));


-- ============================================================
-- PART 2 — identifier_link.identifier_type — SKIPPED
--
-- migration_005 Part 9 already dropped identifier_link_identifier_type_check
-- and replaced it with a constraint covering all 10 identifier types:
--   email, phone, nfc_uid, nba_id, ticketmaster_id,
--   name, dob, zip, guardian_email, guardian_phone
--
-- No action needed here for identifier_link.
-- ============================================================


-- ============================================================
-- PART 3 — Expand audit_log.identifier_type CHECK constraint
--
-- migration_001 defined CHECK (identifier_type IN
--   ('email', 'phone', 'nfc_uid', 'nba_id', 'ticketmaster_id'))
-- on the audit_log table as well as on identifier_link.
--
-- migration_005 fixed identifier_link but missed this identical
-- constraint on audit_log. resolverEngine.js writes the inbound
-- identifier_type variable directly to audit_log on every
-- resolution event. Sprint 3 resolverEngine accepts name, dob,
-- zip, guardian_email, and guardian_phone as valid identifier
-- types. Any resolution using those types would be blocked here.
--
-- The allowed set matches what migration_005 already set on
-- identifier_link — both tables must allow the same types.
-- ============================================================

ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_identifier_type_check;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_identifier_type_check
  CHECK (identifier_type IN (
    'email',
    'phone',
    'nfc_uid',
    'nba_id',
    'ticketmaster_id',
    'name',
    'dob',
    'zip',
    'guardian_email',
    'guardian_phone'
  ));


-- ============================================================
-- VERIFICATION QUERIES
-- Run these after the migration to confirm success.
-- ============================================================

-- 1. Verify audit_log event_type constraint includes all new event types
--    Expected: 1 row, constraint definition includes conflict_confirmed
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'audit_log'::regclass
  AND contype = 'c'
  AND conname = 'audit_log_event_type_check';
-- Expected: all 12 event types present

-- 2. Verify audit_log identifier_type constraint includes all Sprint 3 types
--    Expected: 1 row, constraint definition includes guardian_email
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'audit_log'::regclass
  AND contype = 'c'
  AND conname = 'audit_log_identifier_type_check';
-- Expected: all 10 identifier types present

-- 3. Verify identifier_link constraint still intact from migration_005
--    Expected: 1 row, all 10 types including guardian_email, guardian_phone
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'identifier_link'::regclass
  AND contype = 'c'
  AND conname = 'identifier_link_identifier_type_check';
-- Expected: all 10 identifier types present (set by migration_005, unchanged)

-- 4. Test insert with new event_type and new identifier_type
--    Creates minimal test fixtures, inserts a conflict_confirmed audit row
--    with identifier_type = 'name', then cleans up.
--    Expected: both INSERTs succeed without CHECK constraint violations.
DO $$
DECLARE
  v_org_id   UUID;
  v_fan_id   UUID;
  v_log_id   UUID;
  v_hash     TEXT;
BEGIN
  v_org_id := gen_random_uuid();
  v_fan_id := gen_random_uuid();
  v_log_id := gen_random_uuid();
  -- 64 hex chars — satisfies org_api_key_hash length = 64 constraint
  v_hash   := md5(v_org_id::text) || md5(v_org_id::text);

  INSERT INTO org (id, name, org_api_key_hash)
    VALUES (v_org_id, '_mig007_test_org', v_hash);

  -- Set RLS context before inserting into RLS-protected tables
  PERFORM set_config('app.current_org_id', v_org_id::text, false);

  INSERT INTO fan (id, org_id)
    VALUES (v_fan_id, v_org_id);

  -- Test 1: new event_type 'conflict_confirmed' — would have been blocked before
  INSERT INTO audit_log (id, fan_id, org_id, event_type, status, created_at)
    VALUES (v_log_id, v_fan_id, v_org_id, 'conflict_confirmed', 'success', NOW());

  RAISE NOTICE 'TEST PASSED: audit_log accepts event_type = conflict_confirmed';

  DELETE FROM audit_log WHERE id = v_log_id;

  -- Test 2: new identifier_type 'name' — would have been blocked before
  v_log_id := gen_random_uuid();
  INSERT INTO audit_log
    (id, fan_id, org_id, event_type, identifier_type, status, created_at)
    VALUES (v_log_id, v_fan_id, v_org_id, 'resolution', 'name', 'success', NOW());

  RAISE NOTICE 'TEST PASSED: audit_log accepts identifier_type = name';

  DELETE FROM audit_log WHERE id = v_log_id;

  -- Clean up test fixtures in FK-safe order
  DELETE FROM fan WHERE id = v_fan_id;
  DELETE FROM org WHERE id = v_org_id;

  RAISE NOTICE 'migration_007 verification complete — all tests passed';
END;
$$;
