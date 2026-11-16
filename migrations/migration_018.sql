-- =============================================================================
-- Golden Record — Customer CSV import
-- migration_018.sql
--
-- What this migration does:
--   1. Narrow uq_identifier_per_org so name, dob, and zip may repeat across
--      fans in one org. Email, phone, and the other hard identifier types
--      stay unique. The fan_pass exclusion stays.
--   2. import_batch and import_row — durable row identity for a customer file.
--      The resolver's own idempotency key expires and is not this identity.
--   3. audit_log event_type import_identifiers_attached.
--
-- CREATE INDEX CONCURRENTLY and DROP INDEX CONCURRENTLY cannot run inside a
-- transaction. Run this file with psql, not inside an explicit BEGIN.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'import_batch'
  ) THEN
    RAISE EXCEPTION
      'migration_018 already applied — import_batch table exists. Aborting.';
  END IF;
END $$;

DROP INDEX CONCURRENTLY IF EXISTS uq_identifier_per_org;

CREATE UNIQUE INDEX CONCURRENTLY uq_identifier_per_org
  ON identifier_link (identifier_type, identifier_value, org_id)
  WHERE source_system != 'fan_pass'
    AND identifier_type IN (
      'email',
      'phone',
      'nfc_uid',
      'nba_id',
      'ticketmaster_id',
      'guardian_email',
      'guardian_phone'
    );

CREATE TABLE import_batch (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        NOT NULL REFERENCES org (id),
  filename    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_row (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         uuid        NOT NULL REFERENCES import_batch (id),
  org_id           uuid        NOT NULL REFERENCES org (id),
  row_number       integer     NOT NULL,
  row_key          text,
  status           text        NOT NULL
                               CHECK (status IN ('pending', 'complete', 'error')),
  fan_id           uuid        REFERENCES fan (id),
  resolution_path  text,
  conflict_id      uuid,
  match_type       text,
  error            text,
  skipped          jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_import_row_key
  ON import_row (org_id, row_key)
  WHERE row_key IS NOT NULL;

ALTER TABLE import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_batch
  USING (org_id = current_setting('app.current_org_id')::uuid);

ALTER TABLE import_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_row FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_row
  USING (org_id = current_setting('app.current_org_id')::uuid);

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
    'import_identifiers_attached'
  ));
