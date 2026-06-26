-- migration_013.sql
-- Golden Record Fan Identity Platform
-- OKC Thunder — Thunder Innovations Cohort
-- Author: Aaron
-- Sprint 3 (defensive hardening, pre-June 29th)
--
-- What this migration does:
-- Closes the identifier_link uniqueness gap that has existed since migration_001.
-- The CONSTRAINT clause in migration_001 was placed outside the CREATE TABLE parens
-- and was silently ignored by Postgres — pg_constraint returned 0 rows when queried.
-- Without this index, two concurrent PATH B resolutions of the same identifier could
-- each create a separate fan, producing silent duplicate identity records.
--
-- This migration adds the index. resolverEngine.js handles the resulting 23505 error
-- (added in the same change) with a fallback PATH A lookup so the losing concurrent
-- request resolves to the winner's fan instead of surfacing a 500.
--
-- Why CONCURRENTLY:
-- Builds the index without holding an ACCESS EXCLUSIVE lock on identifier_link.
-- Concurrent reads and writes proceed normally during the build.
--
-- IMPORTANT — transaction block restriction:
-- CREATE INDEX CONCURRENTLY cannot run inside an explicit or implicit transaction.
-- Run this migration with psql directly:
--   psql $DATABASE_URL -f migrations/migration_013.sql
-- If your migration runner wraps statements in BEGIN/COMMIT, drop CONCURRENTLY before
-- running — it will hold a brief table lock. Surface this to the team before doing so.
--
-- Pre-migration duplicate check (confirmed clean 2026-06-23):
--   SELECT identifier_type, identifier_value, org_id, COUNT(*)
--   FROM identifier_link
--   GROUP BY identifier_type, identifier_value, org_id
--   HAVING COUNT(*) > 1;
--   Result: 0 rows
--
-- Depends on: migration_001.sql (identifier_link table)
-- Run after:  migration_012.sql
-- Blocks:     none — additive index only


-- ============================================================
-- SAFETY GUARD
-- Prevents accidental re-run by checking whether the index
-- already exists. Runs in its own implicit transaction via DO $$.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_indexes
    WHERE indexname = 'uq_identifier_per_org'
      AND tablename = 'identifier_link'
  ) THEN
    RAISE EXCEPTION
      'migration_013 already applied — index uq_identifier_per_org '
      'already exists on identifier_link. Aborting.';
  END IF;
END $$;


-- ============================================================
-- PRE-MIGRATION DUPLICATE CHECK
-- Raises if any (type, value, org_id) combination has > 1 row.
-- The CREATE INDEX will fail silently or partially if duplicates
-- exist — this check surfaces them with actionable detail first.
-- ============================================================

DO $$
DECLARE
  v_dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_dup_count
  FROM (
    SELECT identifier_type, identifier_value, org_id
    FROM identifier_link
    GROUP BY identifier_type, identifier_value, org_id
    HAVING COUNT(*) > 1
  ) dups;

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'PRE-MIGRATION DUPLICATE CHECK FAILED — identifier_link has % '
      'combination(s) with duplicate (identifier_type, identifier_value, org_id). '
      'Resolve duplicates before creating the unique index — the CREATE will '
      'fail if any exist. Investigate with: '
      'SELECT identifier_type, identifier_value, org_id, COUNT(*) '
      'FROM identifier_link '
      'GROUP BY identifier_type, identifier_value, org_id '
      'HAVING COUNT(*) > 1;',
      v_dup_count;
  ELSE
    RAISE NOTICE
      'PRE-MIGRATION DUPLICATE CHECK PASSED — identifier_link: '
      '0 duplicate (type, value, org_id) combinations. '
      'Safe to create unique index.';
  END IF;
END $$;


-- ============================================================
-- UNIQUE INDEX
-- Enforces one identifier_link row per (type, value, org_id).
-- CONCURRENTLY: no table lock — safe to run against live traffic.
-- IF NOT EXISTS: idempotent in the event the DO $$ guard above
-- is bypassed (e.g., direct psql invocation after a partial run).
-- ============================================================

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  uq_identifier_per_org
  ON identifier_link (identifier_type, identifier_value, org_id);


-- ============================================================
-- VERIFICATION QUERIES
-- Run these after migration to confirm the index was created
-- and the table remains clean.
-- ============================================================

-- Index exists on identifier_link — expected: 1 row
SELECT indexname, tablename, indexdef
FROM pg_indexes
WHERE indexname = 'uq_identifier_per_org'
  AND tablename = 'identifier_link';
-- Expected: 1 row

-- No duplicate combinations remain — expected: 0 rows
SELECT identifier_type, identifier_value, org_id, COUNT(*)
FROM identifier_link
GROUP BY identifier_type, identifier_value, org_id
HAVING COUNT(*) > 1;
-- Expected: 0 rows
