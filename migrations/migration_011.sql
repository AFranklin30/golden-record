-- migration_011.sql
-- Golden Record Fan Identity Platform
-- OKC Thunder — Thunder Innovations Cohort
-- Author: Aaron
-- Sprint 3 (data integrity follow-up)
--
-- What this migration does:
-- Adds a partial unique index on conflict_queue (fan_id_b)
-- scoped to status = 'pending'.
-- Prevents the same fan record from appearing as fan_id_b
-- (the candidate for soft-deletion) in more than one pending
-- conflict simultaneously.
--
-- Without this constraint, two concurrent soft-match processes
-- can both flag the same fan as fan_id_b against two different
-- existing fans. If staff confirms one merge, fan_id_b is
-- soft-deleted and its identifiers move to the confirmed target.
-- A second confirm on the still-pending conflict then writes a
-- merge_history row that falsely claims a merge happened while
-- the identifier_link UPDATE moves zero rows — breaking the
-- unmerge reversal guarantee.
--
-- Scoped to fan_id_b only, not fan_id_a.
-- A surviving fan (fan_id_a) can legitimately appear across
-- multiple historical merges over time. Only the soft-deleted
-- side (fan_id_b) must never be in two pending conflicts at once.
--
-- This index is complementary to uq_conflict_queue_pair from
-- migration_006, which prevents the exact same (fan_id_a,
-- fan_id_b, org_id) pair from having two pending conflicts.
-- That constraint does not prevent fan_id_b from appearing
-- across two conflicts with DIFFERENT fan_id_a values.
-- This index closes that gap.
--
-- RLS: conflict_queue already has ENABLE ROW LEVEL SECURITY
-- and FORCE ROW LEVEL SECURITY with a tenant_isolation policy
-- from migration_008. No RLS changes needed here.
--
-- Pre-requisite: the following audit query must return zero rows
-- before applying this migration:
--   SELECT fan_id_b, COUNT(*)
--   FROM conflict_queue
--   WHERE status = 'pending'
--   GROUP BY fan_id_b
--   HAVING COUNT(*) > 1;
-- If that returns any rows, stop — resolve those conflicts
-- manually before running this migration.
--
-- Depends on: migration_001.sql, migration_004.sql,
--             migration_006.sql (uq_conflict_queue_pair
--             already exists — this is a complementary
--             constraint, not a replacement)
-- Run after:  migration_010.sql
-- Blocks:     none — additive integrity constraint


-- ============================================================
-- SAFETY GUARD
-- Prevents accidental re-run — checks for the new index's
-- existence as a proxy for whether this migration has been
-- applied.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_indexes
    WHERE tablename = 'conflict_queue'
      AND indexname = 'uq_one_pending_conflict_per_fan_b'
  ) THEN
    RAISE EXCEPTION
      'migration_011 already applied — index uq_one_pending_conflict_per_fan_b exists. Aborting.';
  END IF;
END $$;


-- ============================================================
-- CONSTRAINT — one pending conflict per fan_id_b
--
-- A fan record flagged as a probable duplicate (fan_id_b)
-- can exist in at most one pending conflict at any time.
-- Once a conflict is resolved (confirmed or rejected), its
-- status leaves 'pending' and fan_id_b is freed to appear
-- in a new pending conflict if warranted.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_pending_conflict_per_fan_b
  ON conflict_queue (fan_id_b)
  WHERE status = 'pending';


-- ============================================================
-- VERIFICATION QUERIES
-- Run these after the migration to confirm success.
-- ============================================================

-- 1. Index exists on conflict_queue — expected: 1 row
SELECT indexname
FROM pg_indexes
WHERE tablename = 'conflict_queue'
  AND indexname = 'uq_one_pending_conflict_per_fan_b';
-- Expected: 1 row

-- 2. Constraint test — creates two separate existing candidate
--    fans (A and B) and one new fan (X), inserts a pending
--    conflict with fan_id_a=A and fan_id_b=X, then attempts a
--    second pending conflict with fan_id_a=B and fan_id_b=X
--    (same fan_id_b, different fan_id_a).
--    uq_conflict_queue_pair from migration_006 does NOT block
--    this because fan_id_a differs.
--    uq_one_pending_conflict_per_fan_b MUST block it.
--    Cleans up all test data in FK-safe order before exiting.
DO $$
DECLARE
  v_org_id      UUID;
  v_fan_a       UUID;
  v_fan_b       UUID;
  v_fan_x       UUID;
  v_conflict_1  UUID;
  v_conflict_2  UUID;
  v_hash        TEXT;
  v_blocked     BOOLEAN := FALSE;
BEGIN
  v_org_id     := gen_random_uuid();
  v_fan_a      := gen_random_uuid();
  v_fan_b      := gen_random_uuid();
  v_fan_x      := gen_random_uuid();
  v_conflict_1 := gen_random_uuid();
  v_conflict_2 := gen_random_uuid();
  -- 64 hex chars — satisfies org_api_key_hash length constraint
  v_hash       := md5(v_org_id::text) || md5(v_org_id::text);

  INSERT INTO org (id, name, org_api_key_hash)
    VALUES (v_org_id, '_mig011_test_org', v_hash);

  -- set RLS context to test org before inserting into RLS-protected tables
  PERFORM set_config('app.current_org_id', v_org_id::text, false);

  -- fan_a and fan_b are separate existing candidate fans
  -- fan_x is the new fan being flagged as fan_id_b in both conflicts
  INSERT INTO fan (id, org_id) VALUES (v_fan_a, v_org_id);
  INSERT INTO fan (id, org_id) VALUES (v_fan_b, v_org_id);
  INSERT INTO fan (id, org_id) VALUES (v_fan_x, v_org_id);

  -- Conflict 1: fan_a vs fan_x — must succeed
  INSERT INTO conflict_queue
    (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched)
  VALUES
    (v_conflict_1, v_fan_a, v_fan_x, v_org_id, 0.750, '[]'::jsonb);

  -- Conflict 2: fan_b vs fan_x — same fan_id_b, different fan_id_a.
  -- uq_conflict_queue_pair does NOT block this (fan_id_a differs).
  -- uq_one_pending_conflict_per_fan_b MUST block this.
  BEGIN
    INSERT INTO conflict_queue
      (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched)
    VALUES
      (v_conflict_2, v_fan_b, v_fan_x, v_org_id, 0.700, '[]'::jsonb);
  EXCEPTION
    WHEN unique_violation THEN
      v_blocked := TRUE;
      RAISE NOTICE
        'CONSTRAINT TEST PASSED: second pending conflict for fan_id_b % was blocked',
        v_fan_x;
  END;

  -- cleanup in FK-safe order
  -- conflict_queue references fan — delete conflicts before fans
  DELETE FROM conflict_queue WHERE id IN (v_conflict_1, v_conflict_2);
  DELETE FROM fan             WHERE id IN (v_fan_x, v_fan_b, v_fan_a);
  DELETE FROM org             WHERE id  = v_org_id;

  IF NOT v_blocked THEN
    RAISE EXCEPTION
      'CONSTRAINT TEST FAILED — uq_one_pending_conflict_per_fan_b did not block '
      'a second pending conflict for fan_id_b %. '
      'Confirm the index exists on conflict_queue (fan_id_b) '
      'WHERE status = ''pending'' before re-running.', v_fan_x;
  END IF;
END;
$$;
