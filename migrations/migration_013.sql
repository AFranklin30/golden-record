-- migration_013.sql  (CORRECTED — scoped to exclude household identifiers)
-- Golden Record Fan Identity Platform
-- Golden Record
-- Author: Aaron
-- Sprint 3 (defensive hardening) — REVISED 2026-06-28
--
-- WHY THIS WAS REVISED (read before touching):
-- The original migration_013 created an UNFILTERED unique index on
-- (identifier_type, identifier_value, org_id) across ALL identifier rows.
-- That was WRONG for household identifiers. Children added via the household
-- flow (component 29) get guardian_email and guardian_phone identifier rows
-- written with source_system = 'fan_pass'. SIBLINGS legitimately share the
-- same guardian_email and guardian_phone (same parent). An unfiltered unique
-- index on (type, value, org) would make the second sibling's guardian_email
-- collide with the first's and BLOCK adding a second child to any household.
--
-- This flaw did not surface in June testing because that data had no siblings
-- sharing a guardian. It surfaced when applying to prod, whose real household
-- test data had multiple children sharing one guardian_email/phone.
--
-- THE FIX: scope the index to exclude source_system = 'fan_pass'.
-- This enforces "one value maps to one fan per org" for the RESOLVE-path
-- identifiers (nba_app, ticketmaster, staff_portal, etc.) — which is the
-- duplicate-identity protection this migration was always meant to provide —
-- while leaving household identifiers free to be shared across siblings.
--
-- This complements (does not replace) prod's existing index
-- uq_identifier_link_managed, which is scoped WHERE source_system = 'fan_pass'
-- on (fan_id, identifier_type, org_id) — i.e. "one identifier per CHILD" for
-- household data, which allows different children (different fan_id) to share
-- a guardian. The two indexes cover disjoint row sets (fan_pass vs not) and
-- never conflict.
--
-- DO NOT remove the WHERE clause to "simplify" — it will reintroduce the
-- sibling-blocking bug.
--
-- Verified clean 2026-06-28 (prod): the duplicate check below returns 0 rows
-- for all non-fan_pass sources (nba_app, ticketmaster, staff_portal, unknown,
-- demo_seed). fan_pass has legitimate sibling duplicates, correctly excluded.
--
-- CONCURRENTLY note: cannot run inside a transaction block. Run via:
--   psql $DATABASE_URL -f migrations/migration_013.sql
--
-- Depends on: migration_001.sql (identifier_link table)
-- Run after:  migration_012.sql


-- ============================================================
-- SAFETY GUARD — prevent accidental re-run
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
-- PRE-MIGRATION DUPLICATE CHECK  (SCOPED — excludes fan_pass)
-- Only checks the rows the index will cover. fan_pass rows are
-- excluded because siblings legitimately share guardian identifiers;
-- counting them would false-positive and abort a clean migration.
-- ============================================================
DO $$
DECLARE
  v_dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_dup_count
  FROM (
    SELECT identifier_type, identifier_value, org_id
    FROM identifier_link
    WHERE source_system != 'fan_pass'
    GROUP BY identifier_type, identifier_value, org_id
    HAVING COUNT(*) > 1
  ) dups;

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'PRE-MIGRATION DUPLICATE CHECK FAILED — % non-fan_pass combination(s) '
      'have duplicate (identifier_type, identifier_value, org_id). '
      'Resolve before creating the unique index. Investigate with: '
      'SELECT identifier_type, identifier_value, org_id, COUNT(*) '
      'FROM identifier_link WHERE source_system != ''fan_pass'' '
      'GROUP BY identifier_type, identifier_value, org_id HAVING COUNT(*) > 1;',
      v_dup_count;
  ELSE
    RAISE NOTICE
      'PRE-MIGRATION DUPLICATE CHECK PASSED — 0 duplicate non-fan_pass '
      'combinations. Safe to create scoped unique index.';
  END IF;
END $$;


-- ============================================================
-- UNIQUE INDEX  (SCOPED — excludes household/fan_pass identifiers)
-- Enforces one (type, value) per org for resolve-path identifiers.
-- Household identifiers (source_system = 'fan_pass') are excluded so
-- siblings can share guardian_email / guardian_phone.
-- ============================================================
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  uq_identifier_per_org
  ON identifier_link (identifier_type, identifier_value, org_id)
  WHERE source_system != 'fan_pass';


-- ============================================================
-- VERIFICATION
-- ============================================================
-- Index exists — expected 1 row
SELECT indexname, indexdef
FROM pg_indexes
WHERE indexname = 'uq_identifier_per_org' AND tablename = 'identifier_link';

-- No non-fan_pass duplicates remain — expected 0 rows
SELECT identifier_type, identifier_value, org_id, COUNT(*)
FROM identifier_link
WHERE source_system != 'fan_pass'
GROUP BY identifier_type, identifier_value, org_id
HAVING COUNT(*) > 1;