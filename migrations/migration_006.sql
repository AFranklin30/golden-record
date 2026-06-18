-- migration_006.sql
-- Golden Record Fan Identity Platform
-- OKC Thunder — Thunder Innovations Cohort
-- Author: Aaron
-- Sprint 3
--
-- What this migration does:
-- 1. Partial unique index on identifier_link
--    One authoritative value per identifier_type per fan per org
--    for Fan Pass managed identifiers only. Ingest sources unrestricted.
-- 2. RLS on five Sprint 3 tables
--    household, household_member, staging_household_data,
--    merge_history, related_fans — tenant isolation at the database layer.
--    Same policy pattern as migration_003.
-- 3. Data integrity constraints
--    conflict_queue  — prevent duplicate pending fan pairs
--    merge_history   — prevent concurrent reversal
--    related_fans    — prevent duplicate relationship rows
--
-- Depends on: migration_001.sql, migration_003.sql,
--             migration_004.sql, migration_005.sql
-- Run after:  migration_005.sql
-- Blocks:     Sprint 3 test suite — RLS policies must be active
--             for tenant isolation tests to pass correctly


-- ============================================================
-- SAFETY GUARD
-- Prevents accidental re-run — checks for the partial unique
-- index as a proxy for whether this migration has been applied.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM pg_indexes
    WHERE tablename = 'identifier_link'
      AND indexname = 'uq_identifier_link_managed'
  ) THEN
    RAISE EXCEPTION
      'migration_006 already applied — index uq_identifier_link_managed exists. Aborting.';
  END IF;
END $$;


-- ============================================================
-- PART 1 — Partial unique index on identifier_link
--
-- Fan Pass identifiers are authoritative: one value per
-- identifier_type per fan per org. Ingest identifiers are
-- observed — multiples allowed from Ticketmaster, NFC readers,
-- youth camps, and other source systems.
--
-- A full unique index on (fan_id, identifier_type, org_id)
-- would block legitimate multi-source ingest. The partial
-- predicate (source_system = 'fan_pass') scopes enforcement
-- to Fan Pass managed identifiers only.
-- ============================================================

-- Remove any full (non-partial) unique index applied as a
-- one-off fix before this migration was written.
DROP INDEX IF EXISTS uq_identifier_link_fan_type_org;

CREATE UNIQUE INDEX uq_identifier_link_managed
  ON identifier_link (fan_id, identifier_type, org_id)
  WHERE source_system = 'fan_pass';


-- ============================================================
-- PART 2 — RLS on Sprint 3 tables
--
-- Tenant isolation at the database layer for the five tables
-- added in migration_005. Without RLS a misconfigured query
-- or application bug could return rows belonging to another org.
-- RLS enforces org_id scoping at the Postgres level — a second
-- line of defense that cannot be bypassed by application code.
--
-- Policy: USING clause compares each row's org_id to the
-- session variable app.current_org_id, set by the application
-- via rlsContextMiddleware after orgAuthMiddleware resolves
-- the org. See migration_003 Part 3 for the Node.js
-- integration note — same middleware covers all RLS tables.
--
-- Why FORCE ROW LEVEL SECURITY?
-- Cloud SQL connects the application as the table owner.
-- Without FORCE the table owner bypasses RLS by default.
-- FORCE ensures the policy applies to every connection
-- including the service account — required for Cloud SQL.
-- ============================================================


-- ------------------------------------------------------------
-- TABLE: household
-- ------------------------------------------------------------

ALTER TABLE household ENABLE ROW LEVEL SECURITY;

-- Tenant isolation: each request sees only households
-- belonging to the calling org.
CREATE POLICY tenant_isolation ON household
  USING (org_id = current_setting('app.current_org_id')::uuid);

ALTER TABLE household FORCE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- TABLE: household_member
-- ------------------------------------------------------------

ALTER TABLE household_member ENABLE ROW LEVEL SECURITY;

-- Tenant isolation: household member reads (hard link lookups,
-- aged-up checks, child session verification) return only
-- rows belonging to the calling org.
CREATE POLICY tenant_isolation ON household_member
  USING (org_id = current_setting('app.current_org_id')::uuid);

ALTER TABLE household_member FORCE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- TABLE: staging_household_data
-- ------------------------------------------------------------

ALTER TABLE staging_household_data ENABLE ROW LEVEL SECURITY;

-- Tenant isolation: probable household relationships inferred
-- from bulk data are visible only to the org that ingested them.
CREATE POLICY tenant_isolation ON staging_household_data
  USING (org_id = current_setting('app.current_org_id')::uuid);

ALTER TABLE staging_household_data FORCE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- TABLE: merge_history
-- ------------------------------------------------------------

ALTER TABLE merge_history ENABLE ROW LEVEL SECURITY;

-- Tenant isolation: merge history reads (unmerge lookups,
-- audit queries) return only rows belonging to the calling org.
CREATE POLICY tenant_isolation ON merge_history
  USING (org_id = current_setting('app.current_org_id')::uuid);

ALTER TABLE merge_history FORCE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- TABLE: related_fans
-- ------------------------------------------------------------

ALTER TABLE related_fans ENABLE ROW LEVEL SECURITY;

-- Tenant isolation: related fan records (aged-up history,
-- unmerge history, admin household view) are visible only
-- to the org that created them.
CREATE POLICY tenant_isolation ON related_fans
  USING (org_id = current_setting('app.current_org_id')::uuid);

ALTER TABLE related_fans FORCE ROW LEVEL SECURITY;


-- ============================================================
-- PART 3 — Data integrity constraints
-- ============================================================

-- conflict_queue: prevent duplicate pending fan pairs.
-- Scoped to pending only — resolved conflicts can accumulate
-- historical duplicates without violating data integrity.
-- Race condition without this: two concurrent ingest events
-- for the same candidate pair both pass the idempotency check
-- and both insert into conflict_queue before either commits.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conflict_queue_pair
  ON conflict_queue (fan_id_a, fan_id_b, org_id)
  WHERE status = 'pending';

-- merge_history: prevent concurrent reversal.
-- Only one active merge record per conflict_id at a time.
-- Race condition without this: two concurrent unmerge requests
-- both find status = 'active' in merge_history, both proceed,
-- and both try to move identifiers back — double-unmerge.
CREATE UNIQUE INDEX IF NOT EXISTS uq_merge_history_active
  ON merge_history (conflict_id)
  WHERE status = 'active';

-- related_fans: prevent duplicate relationship rows.
-- Same two fans cannot have the same relationship recorded twice.
-- No WHERE clause — deduplication applies to all statuses.
CREATE UNIQUE INDEX IF NOT EXISTS uq_related_fans_pair
  ON related_fans (fan_id_a, fan_id_b, org_id, relationship);


-- ============================================================
-- VERIFICATION QUERIES
-- Run these after the migration to confirm success.
-- ============================================================

-- 1. Partial unique index exists on identifier_link — expected: 1 row
SELECT indexname
FROM pg_indexes
WHERE tablename = 'identifier_link'
  AND indexname = 'uq_identifier_link_managed';
-- Expected: 1 row

-- 2. RLS enabled on all five Sprint 3 tables — expected: 5 rows, all rowsecurity = true
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'household',
    'household_member',
    'staging_household_data',
    'merge_history',
    'related_fans'
  )
ORDER BY tablename;
-- Expected: 5 rows, all with rowsecurity = true

-- 3. All three data integrity indexes exist — expected: 3 rows
SELECT indexname
FROM pg_indexes
WHERE indexname IN (
  'uq_conflict_queue_pair',
  'uq_merge_history_active',
  'uq_related_fans_pair'
)
ORDER BY indexname;
-- Expected: 3 rows

-- 4. RLS blocks cross-tenant access
-- Tests household as the representative table — the same
-- tenant_isolation policy applies identically to all five
-- Sprint 3 tables. Inserts one test row for a known org,
-- then queries from a different org context, and confirms
-- zero rows are returned.
DO $$
DECLARE
  v_org_id    UUID;
  v_fan_id    UUID;
  v_hh_id     UUID;
  v_fake_org  UUID;
  v_hash      TEXT;
  v_count     INTEGER;
  rls_blocked BOOLEAN := FALSE;
BEGIN
  v_org_id   := gen_random_uuid();
  v_fan_id   := gen_random_uuid();
  v_hh_id    := gen_random_uuid();
  v_fake_org := gen_random_uuid();
  -- 64 hex chars — satisfies org_api_key_hash length constraint
  v_hash     := md5(v_org_id::text) || md5(v_org_id::text);

  INSERT INTO org (id, name, org_api_key_hash)
    VALUES (v_org_id, '_rls006_test_org', v_hash);

  -- set RLS context to test org before inserting into RLS-protected tables
  PERFORM set_config('app.current_org_id', v_org_id::text, false);

  INSERT INTO fan (id, org_id)
    VALUES (v_fan_id, v_org_id);

  INSERT INTO household (id, org_id, adult_fan_id)
    VALUES (v_hh_id, v_org_id, v_fan_id);

  -- switch to a different org — RLS should block the test row
  PERFORM set_config('app.current_org_id', v_fake_org::text, false);

  SELECT COUNT(*) INTO v_count FROM household;

  IF v_count = 0 THEN
    rls_blocked := TRUE;
    RAISE NOTICE 'RLS TEST PASSED: household returned 0 rows for cross-tenant org';
  ELSE
    RAISE NOTICE 'RLS TEST FAILED: household returned % rows for wrong org', v_count;
  END IF;

  -- restore context to test org before cleanup
  PERFORM set_config('app.current_org_id', v_org_id::text, false);

  DELETE FROM household WHERE id = v_hh_id;
  DELETE FROM fan       WHERE id = v_fan_id;
  DELETE FROM org       WHERE id = v_org_id;

  IF NOT rls_blocked THEN
    RAISE EXCEPTION
      'RLS verification failed — household returned rows for wrong org. '
      'Confirm ENABLE ROW LEVEL SECURITY and FORCE ROW LEVEL SECURITY '
      'are both applied to the household table.';
  END IF;
END;
$$;
