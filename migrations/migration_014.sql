-- =============================================================================
-- Golden Record — Fan Identity Platform
-- Stage 7 Evaluation Tables
-- migration_014.sql
--
-- OKC Thunder — Thunder Innovations Cohort
-- Author: Aaron
-- Version: 1.0 · July 2026 · Confidential
--
-- Build order: depends on fan, org, conflict_queue, audit_log (all exist).
--              Prompt 3 (resolverEngine trace write) depends on this.
--
-- What this migration does:
--   1. resolution_trace — immutable record of what the scorer did per resolution
--   2. trace_label      — mutable human verdict per trace (0..N per trace)
--   3. evaluation_corpus — durable labeled set; survives resolution_trace purge
--
-- Nothing writes to these tables yet. Prompt 3 wires up resolverEngine.
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
    AND table_name = 'resolution_trace'
  ) THEN
    RAISE EXCEPTION
      'migration_014 already applied — resolution_trace table exists. Aborting.';
  END IF;
END $$;


-- =============================================================================
-- TABLE 1: resolution_trace
--
-- Immutable record of what the scorer did on each resolution request.
-- One row per resolution attempt. Subject to PII retention purge (deferred).
--
-- Column notes:
-- - best_score is numeric(4,3) NOT numeric(3,2).
--   audit_log.confidence_score is numeric(3,2) and rounds 0.855 → 0.86,
--   which crosses THRESHOLD_PATH_C. Matching conflict_queue's (4,3) precision
--   is required, not cosmetic.
-- - scoring_clock is the injected `now` from prompt 1, NOT the row insert time.
--   created_at is the insert time. When they differ, the difference matters.
-- - candidate_ids is uuid[] with NO FK — candidates may be soft-deleted later
--   and the trace must survive that. No FK is intentional, not an omission.
-- =============================================================================

CREATE TABLE resolution_trace (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid        NOT NULL REFERENCES org(id),
  audit_event_id         uuid        REFERENCES audit_log(id),

  resolution_path        text        NOT NULL,
  scoring_status         text        NOT NULL,
  skip_reason            text,

  inbound_identifiers    jsonb       NOT NULL,
  candidate_ids          uuid[]      NOT NULL DEFAULT '{}',
  candidates_considered  integer     NOT NULL DEFAULT 0,
  candidates_gated       integer     NOT NULL DEFAULT 0,
  candidates_scored      integer     NOT NULL DEFAULT 0,

  signal_results         jsonb,
  best_candidate_id      uuid        REFERENCES fan(id),
  best_score             numeric(4,3),

  threshold_path_c       numeric(4,3) NOT NULL,
  threshold_path_d       numeric(4,3) NOT NULL,
  scorer_version         text        NOT NULL,
  normalization_version  text        NOT NULL,
  scoring_clock          timestamptz NOT NULL,

  resulting_fan_id       uuid        REFERENCES fan(id),
  is_new_record          boolean     NOT NULL,
  conflict_id            uuid        REFERENCES conflict_queue(id),

  created_at             timestamptz NOT NULL DEFAULT now()
);


-- =============================================================================
-- CONSTRAINTS on resolution_trace
--
-- Semantic constraints, not enumerated.
-- A new scoring_status value must NOT require a migration.
-- This is the audit_log.event_type lesson (broke prod three times:
-- migrations 007, 009, 010).
-- =============================================================================

ALTER TABLE resolution_trace ADD CONSTRAINT
  resolution_trace_scoring_status_score_check CHECK (
    (scoring_status =  'performed' AND best_score IS NOT NULL)
    OR
    (scoring_status <> 'performed' AND best_score IS NULL)
  );

ALTER TABLE resolution_trace ADD CONSTRAINT
  resolution_trace_skip_reason_check CHECK (
    (scoring_status =  'performed' AND skip_reason IS NULL)
    OR
    (scoring_status <> 'performed' AND skip_reason IS NOT NULL)
  );

ALTER TABLE resolution_trace ADD CONSTRAINT
  resolution_trace_score_bounds_check CHECK (
    best_score IS NULL OR (best_score >= 0.0 AND best_score <= 1.0)
  );

ALTER TABLE resolution_trace ADD CONSTRAINT
  resolution_trace_counts_check CHECK (
    candidates_considered >= 0
    AND candidates_gated  >= 0
    AND candidates_scored >= 0
    AND candidates_gated + candidates_scored <= candidates_considered
  );


-- =============================================================================
-- APPEND-ONLY TRIGGER on resolution_trace
--
-- Mirrors enforce_audit_log_append_only in migration_003.
-- A trigger is used rather than REVOKE because the app connects as postgres
-- (superuser) locally, which bypasses REVOKE entirely.
-- The trigger fires regardless of role.
-- =============================================================================

CREATE OR REPLACE FUNCTION prevent_resolution_trace_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'resolution_trace is append-only — % is not permitted.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_resolution_trace_append_only
  BEFORE UPDATE OR DELETE ON resolution_trace
  FOR EACH ROW EXECUTE FUNCTION prevent_resolution_trace_mutation();


-- =============================================================================
-- RLS on resolution_trace
--
-- Applied in this migration, not deferred. The Firestore tenant-isolation gap
-- happened by deferring exactly this kind of step.
-- FORCE ROW LEVEL SECURITY ensures the policy applies even to the table owner
-- (postgres superuser is the table owner locally).
-- =============================================================================

ALTER TABLE resolution_trace ENABLE ROW LEVEL SECURITY;
ALTER TABLE resolution_trace FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON resolution_trace
  USING (org_id = current_setting('app.current_org_id')::uuid);


-- =============================================================================
-- INDEXES on resolution_trace
--
-- Standard indexes only — no CONCURRENTLY because these are new empty tables
-- and CONCURRENTLY cannot run inside a transaction block.
-- =============================================================================

CREATE INDEX idx_resolution_trace_org_path
  ON resolution_trace (org_id, resolution_path);

CREATE INDEX idx_resolution_trace_created
  ON resolution_trace (created_at DESC);

CREATE INDEX idx_resolution_trace_conflict
  ON resolution_trace (conflict_id) WHERE conflict_id IS NOT NULL;

CREATE INDEX idx_resolution_trace_scoring_status
  ON resolution_trace (org_id, scoring_status);


-- =============================================================================
-- TABLE 2: trace_label
--
-- Human verdict on a resolution_trace row. Mutable by design — a person
-- revising their own verdict is an UPDATE. Disagreement between two people
-- is two rows; the unique index on (trace_id, labeled_by) makes one person's
-- stale verdict impossible.
--
-- labeled_by is TEXT holding a person's name ('monique', 'aaron').
-- This is the ONLY table where *_by holds a person, not an org_name.
-- No staff auth layer exists yet; a human name is the best available identity.
-- Do NOT make labeled_by consistent with other *_by columns — they hold org_name
-- because no individual identity exists. Here one does.
--
-- No append-only trigger — UPDATE is the expected write path for revised verdicts.
-- =============================================================================

CREATE TABLE trace_label (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id     uuid        NOT NULL REFERENCES resolution_trace(id),
  org_id       uuid        NOT NULL REFERENCES org(id),
  verdict      text        NOT NULL,
  labeled_by   text        NOT NULL,
  label_source text        NOT NULL,
  note         text,
  labeled_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_trace_label_per_labeler
  ON trace_label (trace_id, labeled_by);

ALTER TABLE trace_label ENABLE ROW LEVEL SECURITY;
ALTER TABLE trace_label FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON trace_label
  USING (org_id = current_setting('app.current_org_id')::uuid);


-- =============================================================================
-- TABLE 3: evaluation_corpus
--
-- Durable labeled set for Stage 7 metrics. Survives resolution_trace PII purge.
-- Only synthetic rows are replayable — promoted rows carry the label and observed
-- score but cannot be re-scored (resolution_trace stores derived signal results,
-- not raw candidate field values).
--
-- source CHECK enforces two valid states:
--   'synthetic'      — trace_id NULL, candidate_snapshot MUST be present
--                      (a synthetic row without a snapshot is unscorable, useless)
--   'promoted_trace' — trace_id required (points to the source trace)
--
-- No append-only trigger — corpus rows may be updated as labels are refined.
-- =============================================================================

CREATE TABLE evaluation_corpus (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid        NOT NULL REFERENCES org(id),

  source                text        NOT NULL,
  trace_id              uuid        REFERENCES resolution_trace(id),

  inbound_identifiers   jsonb       NOT NULL,
  candidate_snapshot    jsonb,
  expected_verdict      text        NOT NULL,
  rationale             text,

  observed_score        numeric(4,3),
  observed_path         text,
  scorer_version        text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text        NOT NULL
);

ALTER TABLE evaluation_corpus ADD CONSTRAINT
  evaluation_corpus_source_check CHECK (
    (source = 'synthetic'      AND trace_id IS NULL AND candidate_snapshot IS NOT NULL)
    OR
    (source = 'promoted_trace' AND trace_id IS NOT NULL)
  );

CREATE UNIQUE INDEX uq_evaluation_corpus_trace
  ON evaluation_corpus (trace_id) WHERE trace_id IS NOT NULL;

ALTER TABLE evaluation_corpus ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_corpus FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON evaluation_corpus
  USING (org_id = current_setting('app.current_org_id')::uuid);


-- =============================================================================
-- VERIFICATION QUERIES
-- Run these after the migration to confirm all objects are in place.
--
-- Expected results:
--   table_count = 3
--   resolution_trace_col_count = 23
--   trace_label_col_count = 9
--   evaluation_corpus_col_count = 13
--   trigger_count = 1  (enforce_resolution_trace_append_only)
--   index_count = 4    (the four idx_resolution_trace_* indexes)
--   constraint_count = 4  (4 on resolution_trace; source_check on evaluation_corpus = 5 total)
-- =============================================================================

SELECT
  table_name,
  COUNT(*) AS col_count
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('resolution_trace', 'trace_label', 'evaluation_corpus')
GROUP BY table_name
ORDER BY table_name;
