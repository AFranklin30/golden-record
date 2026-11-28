-- =============================================================================
-- Golden Record — Operator roles and audit attribution
-- migration_021.sql
--
-- What this migration does:
--   1. Adds role ('admin' | 'operator') to operator table.
--   2. Adds actor_type, operator_id, and actor_email columns to audit_log
--      (additive only; enforce_audit_log_append_only trigger stays intact).
--   3. Adds created_by_operator_id and created_by_email to import_batch.
--   4. Extends audit_log_event_type_check with operator_created and
--      operator_deactivated.
--
-- operator and operator_session remain auth tables without RLS (migration_019).
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'operator'
      AND column_name = 'role'
  ) THEN
    RAISE EXCEPTION
      'migration_021 already applied — operator.role exists. Aborting.';
  END IF;
END $$;

ALTER TABLE operator
  ADD COLUMN role text NOT NULL DEFAULT 'operator'
  CHECK (role IN ('admin', 'operator'));

ALTER TABLE audit_log
  ADD COLUMN actor_type text
    CHECK (actor_type IN ('operator', 'integration', 'system')),
  ADD COLUMN operator_id uuid
    REFERENCES operator (id),
  ADD COLUMN actor_email text;

CREATE INDEX idx_audit_log_operator
  ON audit_log (org_id, operator_id)
  WHERE operator_id IS NOT NULL;

ALTER TABLE import_batch
  ADD COLUMN created_by_operator_id uuid
    REFERENCES operator (id),
  ADD COLUMN created_by_email text;

ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_event_type_check;

ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_event_type_check
  CHECK (event_type IN (
    'resolution',
    'session_issued',
    'conflict_confirmed',
    'conflict_rejected',
    'merge_reversed',
    'household_created',
    'household_member_added',
    'household_member_updated',
    'household_member_severed',
    'household_member_aged_up',
    'profile_claimed',
    'ingest_failure',
    'child_session_issued',
    'import_identifiers_attached',
    'dashboard_session_issued',
    'record_hidden',
    'operator_created',
    'operator_deactivated'
  ));
