-- migration_005.sql
-- Golden Record Fan Identity Platform
-- OKC Thunder — Thunder Innovations Cohort
-- Author: Aaron
-- Sprint 3
--
-- What this migration does:
-- 1. household table
-- 2. household_member table
-- 3. staging_household_data table
-- 4. merge_history table
-- 5. related_fans table
-- 6. merged_from_fan_id on identifier_link
-- 7. federation_id on fan table (nullable seed)
-- 8. Circular reference trigger on household_member
-- 9. New identifier_types added to CHECK constraint
--    name, dob, zip, guardian_email, guardian_phone
--
-- Depends on: migration_001.sql, migration_004.sql
-- Run after: migration_004.sql
-- Blocks: all Sprint 3 component builds

-- ============================================================
-- PART 1 — household table
-- ============================================================

CREATE TABLE household (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID        NOT NULL REFERENCES org(id),
  adult_fan_id UUID        NOT NULL REFERENCES fan(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   TEXT        NOT NULL DEFAULT 'fan'
  -- always fan-initiated — never system-created
);

CREATE INDEX idx_household_org
  ON household (org_id);

CREATE INDEX idx_household_adult
  ON household (adult_fan_id);

CREATE UNIQUE INDEX idx_household_adult_org
  ON household (adult_fan_id, org_id);
  -- one household per adult per org

-- ============================================================
-- PART 2 — household_member table
-- ============================================================

CREATE TABLE household_member (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id           UUID        NOT NULL REFERENCES household(id),
  adult_fan_id           UUID        NOT NULL REFERENCES fan(id),
  minor_fan_id           UUID        NOT NULL REFERENCES fan(id),
  org_id                 UUID        NOT NULL REFERENCES org(id),
  link_type              TEXT        NOT NULL DEFAULT 'hard',
  -- hard: adult added in Fan Pass
  -- soft: inferred from external data, never fan-facing
  status                 TEXT        NOT NULL DEFAULT 'active',
  -- active | severed | aged_up
  dob                    DATE,
  -- for aging-up calculation
  aged_up_at             TIMESTAMPTZ,
  aged_up_initiated_by   TEXT,
  -- 'fan' | 'guardian' | 'staff'
  claim_token            TEXT,
  claim_token_expires_at TIMESTAMPTZ,
  severed_at             TIMESTAMPTZ,
  severed_by             TEXT,
  -- 'guardian' | 'staff'
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_household_member_household
  ON household_member (household_id);

CREATE INDEX idx_household_member_adult
  ON household_member (adult_fan_id);

CREATE INDEX idx_household_member_minor
  ON household_member (minor_fan_id);

CREATE INDEX idx_household_member_link_type
  ON household_member (link_type);

CREATE INDEX idx_household_member_status
  ON household_member (status);

CREATE INDEX idx_household_member_dob
  ON household_member (dob)
  WHERE aged_up_at IS NULL AND status = 'active';
  -- partial index — only active minor profiles

CREATE UNIQUE INDEX idx_household_member_minor_org
  ON household_member (minor_fan_id, org_id)
  WHERE status = 'active';
  -- one active household per minor per org

-- ============================================================
-- PART 3 — circular reference prevention trigger
-- ============================================================

CREATE OR REPLACE FUNCTION check_no_circular_household()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM household h
    JOIN household_member hm ON hm.household_id = h.id
    WHERE h.adult_fan_id = NEW.minor_fan_id
      AND hm.minor_fan_id = NEW.adult_fan_id
      AND hm.status = 'active'
  ) THEN
    RAISE EXCEPTION
      'circular household relationship not permitted — fan % is already a minor under fan %',
      NEW.adult_fan_id, NEW.minor_fan_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_circular_household
  BEFORE INSERT ON household_member
  FOR EACH ROW EXECUTE FUNCTION check_no_circular_household();

-- ============================================================
-- PART 4 — staging_household_data table
-- Holds probable relationships from bulk data.
-- NEVER auto-promotes to fan record.
-- Adult confirms in Fan Pass to promote.
-- ============================================================

CREATE TABLE staging_household_data (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  adult_fan_id UUID        NOT NULL REFERENCES fan(id),
  org_id       UUID        NOT NULL REFERENCES org(id),
  child_name   TEXT        NOT NULL,
  child_dob    DATE,
  source       TEXT        NOT NULL,
  -- 'youth_camp' | 'rookies_club' | 'bulk_upload'
  raw_data     JSONB       NOT NULL,
  -- full original record preserved
  confidence   NUMERIC(4,3),
  -- how confident we are this is a real relationship
  promoted_at  TIMESTAMPTZ,
  -- set when adult confirms in Fan Pass
  promoted_to  UUID REFERENCES fan(id),
  -- the minor_fan_id it was promoted to
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_staging_adult
  ON staging_household_data (adult_fan_id);

CREATE INDEX idx_staging_org
  ON staging_household_data (org_id);

CREATE INDEX idx_staging_unpromoted
  ON staging_household_data (adult_fan_id)
  WHERE promoted_at IS NULL;
  -- partial index — only unpromoted records

-- ============================================================
-- PART 5 — merge_history table
-- ============================================================

CREATE TABLE merge_history (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fan_id_source UUID        NOT NULL REFERENCES fan(id),
  -- fan_id_b — the record that was merged in
  fan_id_target UUID        NOT NULL REFERENCES fan(id),
  -- fan_id_a — the record that absorbed the merge
  org_id        UUID        NOT NULL REFERENCES org(id),
  conflict_id   UUID        REFERENCES conflict_queue(id),
  merged_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  merged_by     TEXT,
  -- staff identifier who confirmed the merge
  reversed_at   TIMESTAMPTZ,
  reversed_by   TEXT,
  status        TEXT        NOT NULL DEFAULT 'active'
  -- active | reversed
);

CREATE INDEX idx_merge_history_source
  ON merge_history (fan_id_source);

CREATE INDEX idx_merge_history_target
  ON merge_history (fan_id_target);

CREATE INDEX idx_merge_history_conflict
  ON merge_history (conflict_id);

CREATE INDEX idx_merge_history_org_status
  ON merge_history (org_id, status);

-- ============================================================
-- PART 6 — related_fans table
-- Written on aging-up and unmerge completion.
-- Staff queryable — no fan-facing endpoint yet.
-- ============================================================

CREATE TABLE related_fans (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fan_id_a     UUID        NOT NULL REFERENCES fan(id),
  fan_id_b     UUID        NOT NULL REFERENCES fan(id),
  org_id       UUID        NOT NULL REFERENCES org(id),
  relationship TEXT        NOT NULL,
  -- 'aged_up' | 'unmerged' | 'household_history'
  source       TEXT        NOT NULL,
  -- 'household' | 'merge_history' | 'manual'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_related_fans_a
  ON related_fans (fan_id_a);

CREATE INDEX idx_related_fans_b
  ON related_fans (fan_id_b);

CREATE INDEX idx_related_fans_org
  ON related_fans (org_id);

-- ============================================================
-- PART 7 — merged_from_fan_id on identifier_link
-- null on all existing rows — only set during merge confirm
-- ============================================================

ALTER TABLE identifier_link
  ADD COLUMN merged_from_fan_id UUID REFERENCES fan(id);

CREATE INDEX idx_identifier_link_merged_from
  ON identifier_link (merged_from_fan_id)
  WHERE merged_from_fan_id IS NOT NULL;
  -- partial index — only merged identifiers

-- ============================================================
-- PART 8 — federation_id on fan table
-- nullable — Phase 2 populates this
-- represents cross-org canonical identity
-- ============================================================

ALTER TABLE fan
  ADD COLUMN federation_id UUID;
  -- no index yet — Phase 2 adds this when used

-- ============================================================
-- PART 9 — update identifier_type CHECK constraint
-- Add new identifier types for household and signals
-- ============================================================

ALTER TABLE identifier_link
  DROP CONSTRAINT IF EXISTS identifier_link_identifier_type_check;

ALTER TABLE identifier_link
  ADD CONSTRAINT identifier_link_identifier_type_check
  CHECK (identifier_type IN (
    'email',
    'phone',
    'nfc_uid',
    'nba_id',
    'ticketmaster_id',
    'name',
    'dob',
    'zip',
    'guardian_email',
    'guardian_phone'
  ));

-- ============================================================
-- VERIFICATION QUERIES
-- Run these after migration to confirm success
-- ============================================================

-- 1. All new tables exist — expected: 5 rows
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'household',
    'household_member',
    'staging_household_data',
    'merge_history',
    'related_fans'
  )
ORDER BY table_name;
-- Expected: 5 rows

-- 2. merged_from_fan_id column on identifier_link — expected: 1 row
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'identifier_link'
  AND column_name = 'merged_from_fan_id';
-- Expected: 1 row

-- 3. federation_id column on fan table — expected: 1 row
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'fan'
  AND column_name = 'federation_id';
-- Expected: 1 row

-- 4. Circular reference trigger exists — expected: prevent_circular_household
SELECT trigger_name
FROM information_schema.triggers
WHERE event_object_table = 'household_member';
-- Expected: prevent_circular_household

-- 5. Updated CHECK constraint includes new identifier types
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'identifier_link'::regclass
  AND contype = 'c'
  AND conname = 'identifier_link_identifier_type_check';
-- Expected: guardian_email, guardian_phone, name, dob, zip all present

-- 6. Test circular reference trigger blocks correctly
-- Note: ROLLBACK TO SAVEPOINT is not valid in PL/pgSQL anonymous blocks.
--       Test data is inserted and then explicitly deleted after the trigger check.
DO $$
DECLARE
  v_org_id        UUID;
  v_fan_a         UUID;
  v_fan_b         UUID;
  v_hh_a          UUID;
  v_hh_b          UUID;
  v_hash          TEXT;
  trigger_blocked BOOLEAN := FALSE;
BEGIN
  v_org_id := gen_random_uuid();
  v_fan_a  := gen_random_uuid();
  v_fan_b  := gen_random_uuid();
  v_hh_a   := gen_random_uuid();
  v_hh_b   := gen_random_uuid();
  -- 64 hex chars — satisfies org_api_key_hash length = 64 constraint
  v_hash   := md5(v_org_id::text) || md5(v_org_id::text);

  INSERT INTO org (id, name, org_api_key_hash)
    VALUES (v_org_id, '_trigger_test_org', v_hash);

  -- satisfy forced RLS on fan table before inserting or deleting fans
  PERFORM set_config('app.current_org_id', v_org_id::text, false);

  INSERT INTO fan (id, org_id) VALUES (v_fan_a, v_org_id);
  INSERT INTO fan (id, org_id) VALUES (v_fan_b, v_org_id);

  -- fan_a is adult, fan_b is minor
  INSERT INTO household (id, org_id, adult_fan_id)
    VALUES (v_hh_a, v_org_id, v_fan_a);
  INSERT INTO household_member (id, household_id, adult_fan_id, minor_fan_id, org_id)
    VALUES (gen_random_uuid(), v_hh_a, v_fan_a, v_fan_b, v_org_id);

  -- fan_b household for the reverse attempt
  INSERT INTO household (id, org_id, adult_fan_id)
    VALUES (v_hh_b, v_org_id, v_fan_b);

  -- attempt circular insert — fan_b adult, fan_a minor — should be blocked
  BEGIN
    INSERT INTO household_member (id, household_id, adult_fan_id, minor_fan_id, org_id)
      VALUES (gen_random_uuid(), v_hh_b, v_fan_b, v_fan_a, v_org_id);
    RAISE NOTICE 'TRIGGER TEST FAILED: circular reference was NOT blocked';
  EXCEPTION WHEN OTHERS THEN
    trigger_blocked := TRUE;
    RAISE NOTICE 'TRIGGER TEST PASSED: blocked with message: %', SQLERRM;
  END;

  -- clean up test data in FK-safe order
  DELETE FROM household_member WHERE org_id = v_org_id;
  DELETE FROM household         WHERE org_id = v_org_id;
  DELETE FROM fan               WHERE org_id = v_org_id;
  DELETE FROM org               WHERE id     = v_org_id;

  IF NOT trigger_blocked THEN
    RAISE EXCEPTION 'Circular reference trigger verification failed — trigger did not fire';
  END IF;
END;
$$;
