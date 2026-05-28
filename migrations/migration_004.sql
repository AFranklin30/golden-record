-- =============================================================================
-- migration_004.sql
-- Golden Record Fan Identity Platform
-- OKC Thunder — Thunder Innovations Cohort
-- Author: Aaron
-- Sprint 2
--
-- !! STATUS: DO NOT RUN — migration_003.sql must be applied first !!
-- Depends on: migration_001.sql (fan and org tables must exist)
--             migration_002.sql (jti unique index must exist)
--             migration_003.sql (RLS policies must be active)
-- Run after:  migration_003.sql
-- Blocks:     probabilisticMatcher.js, resolverEngine.js Paths C and D
--
-- What this migration does:
--   Creates conflict_queue table for identity resolution decisions requiring
--   human staff review. Probabilistic matches above THRESHOLD_PATH_D but
--   below THRESHOLD_PATH_C are queued here for staff confirmation or rejection
--   before fan records are linked.
-- =============================================================================


-- =============================================================================
-- SAFETY GUARD
-- Prevents accidental re-run — checks for the conflict_queue table as a proxy
-- for whether this migration has already been applied.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name   = 'conflict_queue'
  ) THEN
    RAISE EXCEPTION
      'migration_004 already applied — table conflict_queue exists. Aborting.';
  END IF;
END $$;


-- =============================================================================
-- ALTER audit_log.event_type CHECK constraint
--
-- Sprint 2 conflict endpoints write event_type = 'conflict_confirmed' and
-- event_type = 'conflict_rejected'. The CHECK constraint from migration_001.sql
-- only allows ('resolution', 'session_issued') — PostgreSQL will reject both
-- Sprint 2 audit INSERTs with a constraint violation and roll back the entire
-- confirm/reject transaction.
--
-- Drop and re-add the constraint to include the two new Sprint 2 values.
-- =============================================================================

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_event_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_event_type_check
  CHECK (event_type IN ('resolution', 'session_issued', 'conflict_confirmed', 'conflict_rejected'));


-- =============================================================================
-- conflict_queue
--
-- Holds probabilistic match candidates that require human staff review.
-- resolverEngine Path C (high confidence soft match) and Path D (lower
-- confidence soft match) both write rows here before creating a new fan record.
-- Staff review a pending row and either confirm the match (fan records merge)
-- or reject it (fan records remain separate).
--
-- status values: pending | confirmed | rejected
--
-- fan_id_a: the existing fan record the inbound identifier may belong to
-- fan_id_b: the newly created provisional fan record for the inbound identifier
-- signals_matched: JSONB array of scoring signals from probabilisticMatcher.js
--   e.g. [{"signal":"email_similarity","score":0.7,"similarity":0.85}]
-- reviewed_by: staff user identifier — populated when status changes from pending
-- =============================================================================

CREATE TABLE conflict_queue (
  id                UUID        PRIMARY KEY,
  fan_id_a          UUID        NOT NULL REFERENCES fan(id),
  fan_id_b          UUID        NOT NULL REFERENCES fan(id),
  org_id            UUID        NOT NULL REFERENCES org(id),
  confidence_score  NUMERIC(4,3) NOT NULL,
  signals_matched   JSONB       NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'pending',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at       TIMESTAMPTZ,
  reviewed_by       TEXT
);


-- =============================================================================
-- INDEXES
--
-- idx_conflict_queue_org_status: composite index on (org_id, status)
--   Staff review dashboards filter by org and queue by status='pending'.
--   Composite index covers both predicates in one scan.
--
-- idx_conflict_queue_fan_a / fan_b: single-column indexes on each fan FK
--   resolverEngine Path C/D dedup checks query by fan_id to prevent inserting
--   duplicate conflict rows for the same candidate pair.
-- =============================================================================

CREATE INDEX idx_conflict_queue_org_status
  ON conflict_queue (org_id, status);

CREATE INDEX idx_conflict_queue_fan_a
  ON conflict_queue (fan_id_a);

CREATE INDEX idx_conflict_queue_fan_b
  ON conflict_queue (fan_id_b);


-- =============================================================================
-- VERIFICATION QUERIES
-- Run these after the migration to confirm the table and indexes are correct.
--
-- Expected results:
--   Query 1: 1 row — conflict_queue in public schema with 10 columns
--   Query 2: 3 rows — all three indexes present on conflict_queue
--   Query 3: ERROR — foreign key violation (unknown fan_id_a rejected)
--   Query 4: 1 row — status column default is 'pending'
-- =============================================================================

-- Query 1: Confirm table exists with correct column count
SELECT table_name, COUNT(*) AS column_count
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'conflict_queue'
GROUP BY table_name;

-- Query 2: Confirm all three indexes were created
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename  = 'conflict_queue'
ORDER BY indexname;

-- Query 3: Confirm FK on fan_id_a is enforced
-- Uncomment to test manually — expects a foreign key violation error:
--
-- INSERT INTO conflict_queue (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched)
-- VALUES (
--   gen_random_uuid(),
--   '00000000-0000-0000-0000-000000000000',   -- unknown fan — must not exist
--   (SELECT id FROM fan LIMIT 1),
--   (SELECT id FROM org LIMIT 1),
--   0.720,
--   '[]'::jsonb
-- );
-- ^ Expected: ERROR: insert or update on table "conflict_queue" violates foreign key constraint

-- Query 4: Confirm status DEFAULT is 'pending'
SELECT column_name, column_default
FROM information_schema.columns
WHERE table_schema  = 'public'
  AND table_name    = 'conflict_queue'
  AND column_name   = 'status';
