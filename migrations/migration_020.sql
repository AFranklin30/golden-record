-- =============================================================================
-- Golden Record — mark an import's people as hidden
-- migration_020.sql
--
-- data_removed_at records that the operator hid the people minted by a file.
-- The batch and its rows stay. record_hidden is the audit event for that hide,
-- whether it is one fan or a batch.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'import_batch'
      AND column_name = 'data_removed_at'
  ) THEN
    RAISE EXCEPTION
      'migration_020 already applied — import_batch.data_removed_at exists. Aborting.';
  END IF;
END $$;

ALTER TABLE import_batch
  ADD COLUMN data_removed_at timestamptz;

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
    'record_hidden'
  ));
