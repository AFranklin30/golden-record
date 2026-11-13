-- migration_012.sql
-- Golden Record Fan Identity Platform
-- Golden Record
-- Author: Aaron
-- Sprint 3 (defensive hardening, pre-June 29th)
--
-- What this migration does:
-- 1. CHECK constraint on audit_log — enforces that status='error' rows always
--    have error_detail populated, and status='success' rows never do. Application
--    code already writes these correctly; the constraint closes the gap permanently.
-- 2. CHECK constraint on conflict_queue — prevents fan_id_a = fan_id_b on the
--    same row. Not reachable through any live code path today (the new fan_id is
--    generated after the candidate pool query runs, so it cannot appear in its own
--    candidate list), but the constraint closes that gap as defensive insurance.
-- 3. CHECK constraint on merge_history — enforces that status='active' rows have
--    reversed_at and reversed_by both NULL, and status='reversed' rows have both
--    populated. Same category of contradictory-row risk as constraint 1.
--
-- None of these are currently exploitable bugs. All three are
-- "application code does this correctly today, but nothing in the
-- database guarantees it stays correct" gaps.
--
-- Pre-migration audit queries (results):
--   audit_log:      0 violating rows — confirmed safe
--   conflict_queue: 0 self-referencing rows — confirmed safe
--   merge_history:  0 violating rows — confirmed safe
--
-- Depends on: migration_001.sql (audit_log),
--             migration_004.sql (conflict_queue),
--             migration_005.sql (merge_history)
-- Run after:  migration_011.sql
-- Blocks:     none — additive integrity constraints only


-- ============================================================
-- SAFETY GUARD
-- Prevents accidental re-run — checks for the first constraint
-- as a proxy for whether this migration has been applied.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_constraint
    WHERE conname    = 'audit_log_status_error_detail_check'
      AND conrelid   = 'audit_log'::regclass
  ) THEN
    RAISE EXCEPTION
      'migration_012 already applied — constraint '
      'audit_log_status_error_detail_check exists on audit_log. Aborting.';
  END IF;
END $$;


-- ============================================================
-- PRE-MIGRATION AUDIT QUERIES
-- All three run before any ALTER TABLE statement executes.
-- Each block raises an exception if violations are found —
-- the migration halts and violations must be resolved before
-- re-running. Each is kept separate so the violation type is
-- clearly identified if found.
--
-- Note: these queries read across all tenant rows. The migration
-- runner must have SUPERUSER or BYPASSRLS privilege for the
-- counts to be accurate. The ALTER TABLE statements below will
-- validate all rows regardless of the runner's RLS context.
-- ============================================================


-- AUDIT 1 — audit_log: status/error_detail pairing
-- Detects rows where status='error' has no error_detail,
-- or status='success' has an error_detail populated.
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM audit_log
  WHERE (status = 'error'   AND error_detail IS NULL)
     OR (status = 'success' AND error_detail IS NOT NULL);

  IF v_count > 0 THEN
    RAISE EXCEPTION
      'PRE-MIGRATION AUDIT 1 FAILED — audit_log has % row(s) with '
      'contradictory status/error_detail pairings. '
      'Resolve before adding audit_log_status_error_detail_check. '
      'Investigate: SELECT id, status, error_detail FROM audit_log '
      'WHERE (status = ''error'' AND error_detail IS NULL) '
      'OR (status = ''success'' AND error_detail IS NOT NULL);',
      v_count;
  ELSE
    RAISE NOTICE
      'PRE-MIGRATION AUDIT 1 PASSED — audit_log: 0 violating rows. '
      'Safe to add constraint 1.';
  END IF;
END $$;


-- AUDIT 2 — conflict_queue: self-reference guard
-- Detects rows where fan_id_a and fan_id_b are the same UUID.
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM conflict_queue
  WHERE fan_id_a = fan_id_b;

  IF v_count > 0 THEN
    RAISE EXCEPTION
      'PRE-MIGRATION AUDIT 2 FAILED — conflict_queue has % row(s) '
      'where fan_id_a = fan_id_b. '
      'Resolve before adding conflict_queue_fan_a_not_fan_b_check. '
      'Investigate: SELECT id FROM conflict_queue WHERE fan_id_a = fan_id_b;',
      v_count;
  ELSE
    RAISE NOTICE
      'PRE-MIGRATION AUDIT 2 PASSED — conflict_queue: 0 self-referencing rows. '
      'Safe to add constraint 2.';
  END IF;
END $$;


-- AUDIT 3 — merge_history: status/reversed pairing
-- Detects rows where status='active' has reversal metadata,
-- or status='reversed' is missing reversed_at or reversed_by.
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM merge_history
  WHERE (status = 'active'   AND (reversed_at IS NOT NULL OR reversed_by IS NOT NULL))
     OR (status = 'reversed' AND (reversed_at IS NULL     OR reversed_by IS NULL));

  IF v_count > 0 THEN
    RAISE EXCEPTION
      'PRE-MIGRATION AUDIT 3 FAILED — merge_history has % row(s) with '
      'contradictory status/reversed pairings. '
      'Resolve before adding merge_history_status_reversed_check. '
      'Investigate: SELECT id, status, reversed_at, reversed_by FROM merge_history '
      'WHERE (status = ''active'' AND (reversed_at IS NOT NULL OR reversed_by IS NOT NULL)) '
      'OR (status = ''reversed'' AND (reversed_at IS NULL OR reversed_by IS NULL));',
      v_count;
  ELSE
    RAISE NOTICE
      'PRE-MIGRATION AUDIT 3 PASSED — merge_history: 0 violating rows. '
      'Safe to add constraint 3.';
  END IF;
END $$;


-- ============================================================
-- CONSTRAINT 1 — audit_log status/error_detail pairing
--
-- status='error' rows must always have error_detail populated:
-- a failed resolution or ingest event without an error message
-- loses the root cause forever and breaks incident response.
-- status='success' rows must never have error_detail populated:
-- prevents logically contradictory rows that could mislead
-- monitoring dashboards and alert thresholds.
-- ============================================================

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_status_error_detail_check
  CHECK (
    (status = 'error'   AND error_detail IS NOT NULL)
    OR
    (status = 'success' AND error_detail IS NULL)
  );


-- ============================================================
-- CONSTRAINT 2 — conflict_queue self-reference guard
--
-- fan_id_a and fan_id_b must be different fans. A fan cannot be
-- flagged as a probable duplicate of itself. Not reachable through
-- any live code path today — the resolverEngine.js generates the
-- new fan_id after the candidate pool query completes, so it
-- cannot appear in its own candidate list. The constraint closes
-- this gap permanently as defensive insurance.
-- ============================================================

ALTER TABLE conflict_queue
  ADD CONSTRAINT conflict_queue_fan_a_not_fan_b_check
  CHECK (fan_id_a != fan_id_b);


-- ============================================================
-- CONSTRAINT 3 — merge_history status/reversed pairing
--
-- status='active' rows must have reversed_at and reversed_by
-- both NULL: a merge that has not been reversed cannot carry
-- reversal metadata. status='reversed' rows must have both
-- fields populated: a reversal without both columns breaks the
-- audit trail and makes the unmerge event unattributable.
-- ============================================================

ALTER TABLE merge_history
  ADD CONSTRAINT merge_history_status_reversed_check
  CHECK (
    (status = 'active'   AND reversed_at IS NULL     AND reversed_by IS NULL)
    OR
    (status = 'reversed' AND reversed_at IS NOT NULL AND reversed_by IS NOT NULL)
  );


-- ============================================================
-- VERIFICATION QUERIES
-- Run these after the migration to confirm success.
-- ============================================================

-- All three CHECK constraints exist — expected: 3 rows
SELECT conname, conrelid::regclass AS table_name
FROM pg_constraint
WHERE conname IN (
  'audit_log_status_error_detail_check',
  'conflict_queue_fan_a_not_fan_b_check',
  'merge_history_status_reversed_check'
)
ORDER BY conname;
-- Expected: 3 rows


-- ============================================================
-- CONSTRAINT TESTS
-- One DO $$ block per constraint.
-- Each block attempts to INSERT a row that violates the constraint,
-- asserts that check_violation fires, and cleans up all test data
-- in FK-safe order before exiting.
-- Raises EXCEPTION if the constraint failed to block the insert.
-- ============================================================


-- ------------------------------------------------------------
-- TEST 1 — audit_log_status_error_detail_check
--
-- Inserts a row with status='success' AND error_detail populated.
-- The constraint must reject it with check_violation.
--
-- Cleanup note: audit_log has an append-only trigger that blocks
-- DELETE and UPDATE. Because a working constraint means the INSERT
-- is rejected and no audit_log row is written, cleanup only needs
-- to remove the test org row. If the constraint somehow failed and
-- the INSERT succeeded, RAISE EXCEPTION rolls back the entire block
-- (including the org insert and any audit_log row) before exiting.
-- ------------------------------------------------------------

DO $$
DECLARE
  v_org_id  UUID;
  v_hash    TEXT;
  v_blocked BOOLEAN := FALSE;
BEGIN
  v_org_id := gen_random_uuid();
  -- 64 hex chars — satisfies org_api_key_hash length constraint
  v_hash   := md5(v_org_id::text) || md5(v_org_id::text);

  INSERT INTO org (id, name, org_api_key_hash)
    VALUES (v_org_id, '_mig012_test1_org', v_hash);

  PERFORM set_config('app.current_org_id', v_org_id::text, false);

  -- Violating insert: status='success' with error_detail populated
  BEGIN
    INSERT INTO audit_log (org_id, event_type, status, error_detail)
      VALUES (v_org_id, 'resolution', 'success', 'this detail must not be allowed on success');
  EXCEPTION
    WHEN check_violation THEN
      v_blocked := TRUE;
      RAISE NOTICE
        'CONSTRAINT TEST 1 PASSED: audit_log rejected status=''success'' '
        'row with error_detail populated';
  END;

  -- If the constraint did not fire, RAISE EXCEPTION rolls back the entire
  -- block — including any audit_log row that was not blocked and the org row.
  IF NOT v_blocked THEN
    RAISE EXCEPTION
      'CONSTRAINT TEST 1 FAILED — audit_log_status_error_detail_check did not '
      'block a row with status=''success'' and error_detail populated. '
      'Confirm the CHECK constraint was applied to the audit_log table.';
  END IF;

  -- Constraint worked: INSERT was rejected, no audit_log row exists,
  -- safe to delete the test org.
  DELETE FROM org WHERE id = v_org_id;
END $$;


-- ------------------------------------------------------------
-- TEST 2 — conflict_queue_fan_a_not_fan_b_check
--
-- Inserts a conflict_queue row with fan_id_a = fan_id_b (same UUID).
-- The constraint must reject it with check_violation.
-- Cleanup in FK-safe order: fan, org.
-- ------------------------------------------------------------

DO $$
DECLARE
  v_org_id      UUID;
  v_fan_id      UUID;
  v_conflict_id UUID;
  v_hash        TEXT;
  v_blocked     BOOLEAN := FALSE;
BEGIN
  v_org_id      := gen_random_uuid();
  v_fan_id      := gen_random_uuid();
  v_conflict_id := gen_random_uuid();
  -- 64 hex chars — satisfies org_api_key_hash length constraint
  v_hash        := md5(v_org_id::text) || md5(v_org_id::text);

  INSERT INTO org (id, name, org_api_key_hash)
    VALUES (v_org_id, '_mig012_test2_org', v_hash);

  PERFORM set_config('app.current_org_id', v_org_id::text, false);

  INSERT INTO fan (id, org_id) VALUES (v_fan_id, v_org_id);

  -- Violating insert: fan_id_a and fan_id_b are the same fan UUID
  BEGIN
    INSERT INTO conflict_queue
      (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched)
    VALUES
      (v_conflict_id, v_fan_id, v_fan_id, v_org_id, 0.900, '[]'::jsonb);
  EXCEPTION
    WHEN check_violation THEN
      v_blocked := TRUE;
      RAISE NOTICE
        'CONSTRAINT TEST 2 PASSED: conflict_queue rejected row where '
        'fan_id_a = fan_id_b (%)',
        v_fan_id;
  END;

  IF NOT v_blocked THEN
    RAISE EXCEPTION
      'CONSTRAINT TEST 2 FAILED — conflict_queue_fan_a_not_fan_b_check did not '
      'block a row with fan_id_a = fan_id_b (%). '
      'Confirm the CHECK constraint was applied to the conflict_queue table.',
      v_fan_id;
  END IF;

  -- Constraint worked: no conflict_queue row exists, safe to delete fan and org.
  DELETE FROM fan WHERE id  = v_fan_id;
  DELETE FROM org WHERE id  = v_org_id;
END $$;


-- ------------------------------------------------------------
-- TEST 3 — merge_history_status_reversed_check
--
-- Inserts a merge_history row with status='active' AND reversed_at
-- populated. The constraint must reject it with check_violation.
-- conflict_id is left NULL (nullable) — no conflict_queue row needed.
-- Cleanup in FK-safe order: fan (source and target), org.
-- ------------------------------------------------------------

DO $$
DECLARE
  v_org_id  UUID;
  v_fan_src UUID;
  v_fan_tgt UUID;
  v_hash    TEXT;
  v_blocked BOOLEAN := FALSE;
BEGIN
  v_org_id  := gen_random_uuid();
  v_fan_src := gen_random_uuid();
  v_fan_tgt := gen_random_uuid();
  -- 64 hex chars — satisfies org_api_key_hash length constraint
  v_hash    := md5(v_org_id::text) || md5(v_org_id::text);

  INSERT INTO org (id, name, org_api_key_hash)
    VALUES (v_org_id, '_mig012_test3_org', v_hash);

  PERFORM set_config('app.current_org_id', v_org_id::text, false);

  INSERT INTO fan (id, org_id) VALUES (v_fan_src, v_org_id);
  INSERT INTO fan (id, org_id) VALUES (v_fan_tgt, v_org_id);

  -- Violating insert: status='active' with reversed_at populated
  BEGIN
    INSERT INTO merge_history
      (fan_id_source, fan_id_target, org_id, status, reversed_at, reversed_by)
    VALUES
      (v_fan_src, v_fan_tgt, v_org_id, 'active', NOW(), '_test_reviewer');
  EXCEPTION
    WHEN check_violation THEN
      v_blocked := TRUE;
      RAISE NOTICE
        'CONSTRAINT TEST 3 PASSED: merge_history rejected status=''active'' '
        'row with reversed_at populated';
  END;

  IF NOT v_blocked THEN
    RAISE EXCEPTION
      'CONSTRAINT TEST 3 FAILED — merge_history_status_reversed_check did not '
      'block a row with status=''active'' and reversed_at populated. '
      'Confirm the CHECK constraint was applied to the merge_history table.';
  END IF;

  -- Constraint worked: no merge_history row exists, safe to delete fans and org.
  DELETE FROM fan WHERE id IN (v_fan_src, v_fan_tgt);
  DELETE FROM org WHERE id  = v_org_id;
END $$;
