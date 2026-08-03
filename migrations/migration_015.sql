-- =============================================================================
-- Golden Record — Fan Identity Platform
-- conflict_queue review-screen index
-- migration_015.sql
--
-- OKC Thunder — Thunder Innovations Cohort
-- Author: Aaron
-- Version: 1.0 · August 2026 · Confidential
--
-- Build order: depends on conflict_queue (exists, migration_002).
--
-- What this migration does:
--   Adds one composite index on conflict_queue so the conflict-review screen
--   (a reviewer-facing query, not a background job) doesn't do a sequential
--   scan as pending conflicts accumulate.
--
-- Column order is deliberate:
--   org_id             — every query is org-scoped, and RLS filters on it
--   status             — the review screen filters to 'pending'
--   confidence_score DESC — highest-confidence conflicts reviewed first
-- =============================================================================


-- =============================================================================
-- SAFETY GUARD
-- Prevents accidental re-run on a database where this migration already ran.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_indexes
    WHERE schemaname = 'public'
    AND indexname = 'idx_conflict_queue_org_status_score'
  ) THEN
    RAISE EXCEPTION
      'migration_015 already applied — idx_conflict_queue_org_status_score exists. Aborting.';
  END IF;
END $$;


-- =============================================================================
-- INDEX on conflict_queue
--
-- Standard CREATE INDEX, not CONCURRENTLY — CONCURRENTLY cannot run inside a
-- transaction block, and this is a plain migration file run with psql -f.
-- =============================================================================

CREATE INDEX idx_conflict_queue_org_status_score
  ON conflict_queue (org_id, status, confidence_score DESC);


-- =============================================================================
-- VERIFICATION QUERIES
-- Run these after the migration to confirm the index is in place.
--
-- Expected results:
--   index_count = 1  (idx_conflict_queue_org_status_score)
--   indexdef contains 'confidence_score DESC'
-- =============================================================================

SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'idx_conflict_queue_org_status_score';
