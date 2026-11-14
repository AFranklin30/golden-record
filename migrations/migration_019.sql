-- =============================================================================
-- Golden Record — Dashboard operator session
-- migration_019.sql
--
-- operator and operator_session are auth tables, like org. They have no RLS
-- because sign-in looks them up before app.current_org_id is set.
-- The raw session token is never stored. The column is sha256(token).
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'operator'
  ) THEN
    RAISE EXCEPTION
      'migration_019 already applied — operator table exists. Aborting.';
  END IF;
END $$;

CREATE TABLE operator (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid        NOT NULL REFERENCES org (id),
  email          text        NOT NULL UNIQUE,
  password_salt  text        NOT NULL,
  password_hash  text        NOT NULL,
  is_active      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE operator_session (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id  uuid        NOT NULL REFERENCES operator (id),
  org_id       uuid        NOT NULL REFERENCES org (id),
  token_hash   text        NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

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
    'dashboard_session_issued'
  ));
