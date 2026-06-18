-- =============================================================================
-- migration_003.sql
-- Golden Record Fan Identity Platform
-- OKC Thunder — Thunder Innovations Cohort
-- Author: Aaron
-- Date: May 2026
--
-- !! STATUS: DO NOT RUN — blocked on GCP credentials !!
-- Depends on: migration_001.sql (all four tables must exist)
-- Run before: any second org is onboarded
--
-- What this migration does:
-- 1. Row Level Security — tenant isolation at the database layer
--    across fan, identifier_link, audit_log, ingest_failures
-- 2. Append-only trigger on audit_log (TASK-10)
--
-- Node.js integration required — see Part 3 comment block below
-- before activating this migration in production
-- =============================================================================


-- =============================================================================
-- PART 3 — NODE.JS INTEGRATION NOTE (read before activating in production)
--
-- RLS depends on a session-level config variable: app.current_org_id
-- The application must set this variable before any other query on each request.
--
-- After orgAuthMiddleware sets request.context.org_id, add this call
-- to a request-scoped middleware or at the top of every handler that
-- touches a RLS-protected table:
--
--   await db.query(
--     "SELECT set_config('app.current_org_id', $1, true)",
--     [request.context.org_id]
--   );
--
-- The third argument `true` scopes the setting to the current transaction only.
-- It resets automatically at transaction end — no manual cleanup required.
-- Every request sets its own org context independently.
--
-- Recommended placement in the middleware stack:
--   orgAuthMiddleware  ← sets request.context.org_id
--     → rlsContextMiddleware  ← NEW: calls set_config above
--       → correlationIdMiddleware
--         → jwtMiddleware
--           → handler
--
-- This does not need to be implemented now — it is blocked on GCP credentials.
-- This comment exists so the implementation is not forgotten when credentials arrive.
-- =============================================================================


-- =============================================================================
-- SAFETY GUARD
-- Prevents accidental re-run — checks for the append-only trigger as a proxy
-- for whether this migration has already been applied.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.triggers
    WHERE event_object_schema = 'public'
      AND event_object_table   = 'audit_log'
      AND trigger_name         = 'enforce_audit_log_append_only'
  ) THEN
    RAISE EXCEPTION
      'migration_003 already applied — trigger enforce_audit_log_append_only exists. Aborting.';
  END IF;
END $$;


-- =============================================================================
-- PART 1 — ROW LEVEL SECURITY
--
-- Tenant isolation at the database layer. Without RLS, a misconfigured query
-- or a bug in the application layer could return rows belonging to another org.
-- RLS enforces org_id scoping at the Postgres level — a second line of defense
-- that cannot be bypassed by application code.
--
-- How it works:
--   The Node.js application calls set_config('app.current_org_id', org_id, true)
--   at the start of every request (see Part 3 above). The policy below compares
--   each row's org_id to that session variable. Rows that do not match are
--   invisible to SELECT, UPDATE, INSERT, and DELETE — as if they do not exist.
--
-- Why FORCE ROW LEVEL SECURITY?
--   Without FORCE, the Postgres superuser and table owner bypass RLS by default.
--   Cloud SQL connects the application as the table owner. FORCE ensures the policy
--   applies to every connection including the service account. Required for Cloud SQL.
--
-- Tables protected: fan, identifier_link, audit_log, ingest_failures
-- Table NOT protected: org — org is the authentication table itself. It is read
--   by orgAuthMiddleware before org_id is known. RLS on org would deadlock auth.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- TABLE: fan
-- -----------------------------------------------------------------------------

ALTER TABLE fan ENABLE ROW LEVEL SECURITY;

-- Tenant isolation: each request sees only the fans belonging to its org.
CREATE POLICY tenant_isolation ON fan
  USING (org_id = current_setting('app.current_org_id')::uuid);

-- Apply policy to the table owner (Cloud SQL service account).
ALTER TABLE fan FORCE ROW LEVEL SECURITY;


-- -----------------------------------------------------------------------------
-- TABLE: identifier_link
-- -----------------------------------------------------------------------------

ALTER TABLE identifier_link ENABLE ROW LEVEL SECURITY;

-- Tenant isolation: resolverEngine Path A/B lookups and profile reads
-- return only identifier rows belonging to the calling org.
CREATE POLICY tenant_isolation ON identifier_link
  USING (org_id = current_setting('app.current_org_id')::uuid);

ALTER TABLE identifier_link FORCE ROW LEVEL SECURITY;


-- -----------------------------------------------------------------------------
-- TABLE: audit_log
-- -----------------------------------------------------------------------------

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Tenant isolation: idempotency checks (Guard 2) and health check error-rate
-- queries see only the calling org's audit events.
CREATE POLICY tenant_isolation ON audit_log
  USING (org_id = current_setting('app.current_org_id')::uuid);

ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;


-- -----------------------------------------------------------------------------
-- TABLE: ingest_failures
-- -----------------------------------------------------------------------------

ALTER TABLE ingest_failures ENABLE ROW LEVEL SECURITY;

-- Tenant isolation: DLQ reads and queue depth monitoring see only the
-- calling org's failures.
CREATE POLICY tenant_isolation ON ingest_failures
  USING (org_id = current_setting('app.current_org_id')::uuid);

ALTER TABLE ingest_failures FORCE ROW LEVEL SECURITY;


-- =============================================================================
-- PART 2 — APPEND-ONLY TRIGGER ON audit_log (TASK-10)
--
-- audit_log is append-only by design (see CLAUDE.md Database Rules and the table
-- comment in migration_001.sql). Sprint 1 enforces this at the application layer
-- only — resolverEngine never calls UPDATE or DELETE on audit_log.
--
-- This trigger enforces it at the database layer so no future code path, migration,
-- or ad-hoc query can mutate an audit row — regardless of application behavior.
--
-- Why a trigger and not a RULE or CHECK constraint?
--   Postgres RULEs intercept query rewrites and can have unexpected interaction
--   with RLS. A BEFORE trigger is the standard, explicit mechanism for blocking
--   an operation before it reaches storage. It fires per-row, logs the operation
--   type via TG_OP, and rolls back the attempted write cleanly.
--
-- TG_OP is a Postgres built-in that returns 'UPDATE' or 'DELETE' depending on
-- which operation fired the trigger. Including it in the exception message means
-- Cloud Logging captures exactly what was attempted and by whom.
-- =============================================================================

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log is append-only — UPDATE and DELETE are not permitted. '
    'Attempted operation: % on audit_log',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();


-- =============================================================================
-- VERIFICATION QUERIES
-- Run these after the migration to confirm RLS and the trigger are active.
--
-- Expected results:
--   Query 1: 4 rows — fan, identifier_link, audit_log, ingest_failures
--            all show rowsecurity = true
--   Query 2: 4 rows — tenant_isolation policy on each of the four tables
--   Query 3: 2 rows — enforce_audit_log_append_only fires on UPDATE and DELETE
--   Query 4: ERROR — "audit_log is append-only" (UPDATE attempt blocked)
--   Query 5: ERROR — "audit_log is append-only" (DELETE attempt blocked)
-- =============================================================================

-- Query 1: Confirm RLS is enabled on all four protected tables
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('fan', 'identifier_link', 'audit_log', 'ingest_failures')
ORDER BY tablename;

-- Query 2: Confirm tenant_isolation policy exists on all four tables
SELECT tablename, policyname
FROM pg_policies
WHERE policyname = 'tenant_isolation'
ORDER BY tablename;

-- Query 3: Confirm the append-only trigger exists and covers both operations
SELECT trigger_name, event_manipulation
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND event_object_table  = 'audit_log'
ORDER BY event_manipulation;

-- Query 4: Confirm trigger blocks UPDATE — run and confirm it throws:
--   UPDATE audit_log SET status = 'error' WHERE 1=0;
--   Expected: ERROR: audit_log is append-only — UPDATE and DELETE are not permitted.
--             Attempted operation: UPDATE on audit_log

-- Query 5: Confirm trigger blocks DELETE — run and confirm it throws:
--   DELETE FROM audit_log WHERE 1=0;
--   Expected: ERROR: audit_log is append-only — UPDATE and DELETE are not permitted.
--             Attempted operation: DELETE on audit_log
