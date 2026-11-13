-- =============================================================================
-- Golden Record — Fan Identity Platform
-- CSV fan export — export_run table
-- migration_017.sql
--
-- Golden Record
-- Author: Aaron
-- Version: 1.0 · September 2026 · Confidential
--
-- Build order: depends on org (migration_001, exists). GET /v1/export/fans
--              (src/routes/export.js) depends on this.
--
-- What this migration does:
--   1. export_run — one row per export attempt, successful or not. Same
--      instinct as resolution_trace: record what happened, decide later who
--      looks at it.
--
-- No UI reads this table yet — that is deliberate (see CLAUDE.md's Open
-- section, "Operational UI over export_run"). Nothing writes to it before
-- src/routes/export.js ships in the same change as this migration.
-- =============================================================================


-- =============================================================================
-- SAFETY GUARD
-- Prevents accidental re-run on a database where this migration already ran.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name = 'export_run'
  ) THEN
    RAISE EXCEPTION
      'migration_017 already applied — export_run table exists. Aborting.';
  END IF;
END $$;


-- =============================================================================
-- TABLE: export_run
--
-- One row per export attempt. A run legitimately transitions
-- running -> success or running -> failed via UPDATE, so — unlike
-- audit_log/resolution_trace — this table has NO append-only trigger.
--
-- export_type and status are TEXT, not enumerated. A new export_type (e.g. a
-- future incremental export) must not require a migration — this is the
-- audit_log.event_type lesson (broke prod in migrations 007, 009, 010; see
-- CLAUDE.md's "audit_log event_type discipline" section and lessons.md #6/12).
-- The CHECK constraint below constrains the SHAPE each status implies, not
-- the set of allowed status/export_type strings.
--
-- requested_by is TEXT = org_name, matching resolved_by/merged_by/severed_by —
-- no staff auth layer exists.
-- =============================================================================

CREATE TABLE export_run (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL REFERENCES org(id),
  export_type   text        NOT NULL,
  status        text        NOT NULL,
  row_count     integer,
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  error_detail  text,
  requested_by  text
);

ALTER TABLE export_run ADD CONSTRAINT
  export_run_status_shape_check CHECK (
    (status = 'success' AND completed_at IS NOT NULL AND row_count IS NOT NULL)
    OR
    (status = 'failed'  AND error_detail IS NOT NULL)
    OR
    (status = 'running')
  );


-- =============================================================================
-- RLS on export_run
--
-- Applied in this migration, not deferred. The Firestore tenant-isolation gap
-- (see CLAUDE.md's Firestore section) happened by deferring exactly this kind
-- of step — do not repeat that here.
-- FORCE ROW LEVEL SECURITY ensures the policy applies even to the table owner
-- (postgres superuser is the table owner locally — see CLAUDE.md's RLS/
-- superuser note for the separate, still-open gap this does NOT close).
-- =============================================================================

ALTER TABLE export_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON export_run
  USING (org_id = current_setting('app.current_org_id')::uuid);


-- =============================================================================
-- INDEX on export_run
--
-- Standard index only — no CONCURRENTLY, this is a new empty table and
-- CONCURRENTLY cannot run inside a transaction block.
-- =============================================================================

CREATE INDEX idx_export_run_org_started
  ON export_run (org_id, started_at DESC);


-- =============================================================================
-- VERIFICATION QUERIES
-- Run these after the migration to confirm all objects are in place.
--
-- Expected results:
--   export_run_col_count = 9
--   constraint_count = 1  (export_run_status_shape_check)
--   index_count = 1        (idx_export_run_org_started)
--   rls_forced = true
-- =============================================================================

SELECT COUNT(*) AS export_run_col_count
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'export_run';

SELECT conname
FROM pg_constraint
WHERE conrelid = 'export_run'::regclass
  AND contype = 'c';

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'export_run';

SELECT relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE oid = 'export_run'::regclass;
