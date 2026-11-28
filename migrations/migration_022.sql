-- =============================================================================
-- Golden Record — Backfill organization admin role and operator_promoted audit
-- migration_022.sql
--
-- What this migration does:
--   1. For every organization that has at least one active operator and no
--      active admin, promotes its earliest-created active operator to 'admin'.
--   2. Extends audit_log_event_type_check with 'operator_promoted'.
--
-- Safe to run more than once: wrapped in a transaction; a second run finds
-- zero orgs without an active admin and updates zero rows.
-- =============================================================================

BEGIN;

WITH orgs_without_admin AS (
  SELECT DISTINCT org_id
    FROM operator
   WHERE is_active = true
  EXCEPT
  SELECT DISTINCT org_id
    FROM operator
   WHERE is_active = true
     AND role = 'admin'
),
earliest_operator AS (
  SELECT DISTINCT ON (op.org_id) op.id
    FROM operator op
    JOIN orgs_without_admin o ON o.org_id = op.org_id
   WHERE op.is_active = true
   ORDER BY op.org_id, op.created_at ASC, op.id ASC
)
UPDATE operator
   SET role = 'admin'
 WHERE id IN (SELECT id FROM earliest_operator);

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
    'operator_deactivated',
    'operator_promoted'
  ));

COMMIT;
