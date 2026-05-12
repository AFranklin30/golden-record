-- =============================================================================
-- Golden Record — Fan Identity Platform
-- Sprint 1 Security Migration
-- migration_002.sql
--
-- OKC Thunder — Thunder Innovations Cohort
-- Author: Aaron
-- Version: 1.0 · May 2026 · Confidential
--
-- Prerequisite: migration_001.sql must have been applied.
-- Run: psql $DATABASE_URL -f migrations/migration_002.sql
--
-- Purpose: Add unique constraint on audit_log.jti for session_issued rows.
--   Sprint 2 token revocation uses jti as the revocation key. Without a unique
--   constraint, a duplicate jti row would corrupt revocation state — one row
--   could be marked revoked while a second valid row for the same jti remains.
--
-- Why a partial index and not a full UNIQUE constraint on the column?
--   Only session_issued rows carry a jti value. Resolution and error audit rows
--   have jti = NULL. A full UNIQUE constraint would reject multiple NULL rows
--   (Postgres treats each NULL as distinct, but this is implementation-specific).
--   A partial index on event_type = 'session_issued' is precise, enforces
--   uniqueness only where it matters, and leaves null-jti rows unconstrained.
-- =============================================================================


-- =============================================================================
-- SAFETY GUARD
-- Prevents accidental re-run — idempotent check before applying.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_audit_jti_session_unique'
  ) THEN
    RAISE NOTICE 'migration_002.sql already applied — index idx_audit_jti_session_unique exists. Skipping.';
  ELSE

    -- Unique partial index on audit_log.jti for session_issued rows only.
    -- Prevents duplicate jti insertions for session events.
    -- Prerequisite for Sprint 2 jti-based token revocation.
    CREATE UNIQUE INDEX idx_audit_jti_session_unique
      ON audit_log (jti)
      WHERE event_type = 'session_issued';

    RAISE NOTICE 'migration_002.sql applied — idx_audit_jti_session_unique created.';

  END IF;
END $$;


-- =============================================================================
-- VERIFICATION QUERIES
-- Run these after migration to confirm the index was created correctly.
--
-- Expected results:
--   Query 1: 1 row — idx_audit_jti_session_unique on audit_log
--   Query 2: INSERT of a duplicate jti with event_type='session_issued' fails
--   Query 3: INSERT of a null jti for a non-session_issued row succeeds
-- =============================================================================

-- Query 1: Confirm the index exists
SELECT indexname, tablename, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'idx_audit_jti_session_unique';

-- Query 2: Confirm duplicate jti on session_issued is rejected
-- Uncomment to test manually — expects an error on the second INSERT:
--
-- INSERT INTO audit_log (id, fan_id, org_id, event_type, schema_version, jti, status)
-- VALUES (gen_random_uuid(), NULL, (SELECT id FROM org LIMIT 1), 'session_issued', 'v1', 'test-jti-001', 'success');
--
-- INSERT INTO audit_log (id, fan_id, org_id, event_type, schema_version, jti, status)
-- VALUES (gen_random_uuid(), NULL, (SELECT id FROM org LIMIT 1), 'session_issued', 'v1', 'test-jti-001', 'success');
-- ^ This second INSERT must fail with: ERROR: duplicate key value violates unique constraint

-- Query 3: Confirm null jti on other event types still succeeds
-- Uncomment to test manually — expects success:
--
-- INSERT INTO audit_log (id, org_id, event_type, identifier_type, idempotency_key, status)
-- VALUES (gen_random_uuid(), (SELECT id FROM org LIMIT 1), 'resolution', 'email', 'test-key-001', 'success');
--
-- INSERT INTO audit_log (id, org_id, event_type, identifier_type, idempotency_key, status)
-- VALUES (gen_random_uuid(), (SELECT id FROM org LIMIT 1), 'resolution', 'email', 'test-key-002', 'success');
-- ^ Both INSERTs must succeed — null jti rows are not constrained by the partial index
