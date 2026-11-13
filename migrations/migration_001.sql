-- =============================================================================
-- Golden Record — Fan Identity Platform
-- Sprint 1 Schema Migration
-- migration_001.sql
--
-- Golden Record
-- Author: Aaron
-- Version: 1.0 · April 2026 · Confidential
--
-- Build order: Run this migration FIRST before any application code is deployed.
-- Dependency order: org → fan → identifier_link → audit_log → ingest_failures
--
-- Postgres version target: 14+ (Cloud SQL)
-- No extensions required: gen_random_uuid() is built-in since Postgres 13
-- All timestamps: TIMESTAMPTZ (UTC-aware) — never plain TIMESTAMP
-- =============================================================================


-- =============================================================================
-- SAFETY GUARD
-- Prevents accidental re-run on a populated database.
-- Remove this block only if you have a migration runner (flyway, node-pg-migrate)
-- that tracks which migrations have already been applied.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name = 'org'
  ) THEN
    RAISE EXCEPTION
      'migration_001 already applied — org table exists. Aborting.';
  END IF;
END $$;


-- =============================================================================
-- TABLE: org
--
-- Every inbound request is authenticated against this table via org_api_key_hash.
-- Required by: orgAuthMiddleware (every request), resolverEngine Guard 1.
-- Created first — fan and identifier_link both reference it.
--
-- Why org_api_key_hash TEXT not CHAR(64)?
--   sha256 output is always 64 hex chars. CHAR(64) would work but TEXT with a
--   CHECK constraint is more explicit and self-documenting about the invariant.
--
-- Why UNIQUE on org_api_key_hash?
--   The WHERE clause in orgAuthMiddleware is an equality lookup. UNIQUE creates
--   a B-tree index automatically — same effect as CREATE INDEX, zero extra DDL.
--
-- Why no raw key column?
--   The raw API key is never stored — only sha256(rawKey). If this table were
--   ever read by an unauthorized party, raw keys would compromise every org
--   immediately. One-way hash only.
-- =============================================================================

CREATE TABLE org (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  org_api_key_hash TEXT        NOT NULL UNIQUE
                               CHECK (length(org_api_key_hash) = 64),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path index: orgAuthMiddleware hashes the incoming key and queries by hash
-- on every single inbound request. Full table scan here = full table scan per tap.
-- UNIQUE above already creates a B-tree index — this comment is the explanation.
-- Explicit index below is redundant with UNIQUE but documents intent clearly.
-- Remove the explicit index if your team finds it confusing — UNIQUE covers it.
CREATE INDEX idx_org_api_key_hash ON org (org_api_key_hash);

COMMENT ON TABLE org IS
  'Registered organizations. Every inbound request is authenticated against this table.';
COMMENT ON COLUMN org.org_api_key_hash IS
  'sha256(rawApiKey). Raw key never stored. 64-char hex string.';


-- =============================================================================
-- TABLE: fan
--
-- Canonical fan record — the Golden Record. One row per unique fan identity
-- resolved by the platform. All other tables hang off this record.
--
-- Why stewardship_tier TEXT with CHECK not an ENUM?
--   Postgres ENUMs require ALTER TYPE to add new values — a DDL operation that
--   can lock the table. TEXT + CHECK constraint is easier to evolve in Sprint 2+.
--   Trade-off: application layer must also validate. Both layers validate — fine.
--
-- Why record_version INTEGER?
--   Optimistic locking. resolverEngine checks record_version before writing to
--   detect concurrent writes. If two requests resolve the same fan simultaneously
--   one will win and one will see a version mismatch — ConflictError → 409.
--   Sprint 1 uses version=1 always. The conflict detection machinery is in place.
--
-- Why deleted_at TIMESTAMPTZ nullable?
--   Soft delete pattern. Right to erasure (GDPR/CCPA) sets deleted_at.
--   Hard delete loses audit trail. Soft delete preserves the fact that a record
--   existed and was erased — required for legal compliance logging.
--   POST /v1/session and GET /v1/fan/:id/profile both check deleted_at is null.
-- =============================================================================

CREATE TABLE fan (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL REFERENCES org (id),
  stewardship_tier TEXT        NOT NULL DEFAULT 'platform'
                               CHECK (stewardship_tier IN ('platform', 'org', 'fan')),
  record_version   INTEGER     NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ          -- NULL = active. NOT NULL = erased.
);

-- Lookup by fan_id + org_id: POST /v1/session Step 1, GET /v1/fan/:id/profile Read 1
CREATE INDEX idx_fan_org ON fan (org_id, id);

COMMENT ON TABLE fan IS
  'Canonical fan record — the Golden Record. One row per unique fan identity.';
COMMENT ON COLUMN fan.stewardship_tier IS
  'Who stewarded this record: platform | org | fan. Sprint 1 always platform.';
COMMENT ON COLUMN fan.record_version IS
  'Optimistic lock version. Increment on every UPDATE. ConflictError if mismatch.';
COMMENT ON COLUMN fan.deleted_at IS
  'NULL = active. Set on right-to-erasure request. Never hard delete.';


-- =============================================================================
-- TABLE: identifier_link
--
-- The identity graph. One row per identifier-to-fan mapping. A single fan can
-- have many rows here (email + phone + nfc_uid all pointing to the same fan_id).
-- This is the table resolverEngine reads and writes on every resolution.
--
-- Why composite UNIQUE on (identifier_type, identifier_value, org_id)?
--   Each identifier is unique per org. The same email can exist in two different
--   orgs pointing to two different fan records — they are separate identity graphs.
--   The resolver queries by all three in Guard 2 and the Path A lookup.
--
-- Why confidence_score NUMERIC(3,2)?
--   Sprint 1: always 1.0 (hard match). Sprint 2: probabilistic matching produces
--   scores between 0.0 and 1.0. NUMERIC(3,2) = 1 digit before decimal, 2 after.
--   Range 0.00–1.00. FLOAT would work but NUMERIC is exact — no floating point drift.
--
-- Why first_seen_at and last_seen_at separate columns?
--   first_seen_at = when this identifier was first linked to this fan. Immutable.
--   last_seen_at  = when it was last seen (tap, login, etc.). Updated on Path A.
--   Together they answer: how long has this fan been known, and how recently active?
-- =============================================================================

CREATE TABLE identifier_link (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  fan_id           UUID          NOT NULL REFERENCES fan (id),
  org_id           UUID          NOT NULL REFERENCES org (id),
  identifier_type  TEXT          NOT NULL
                                 CHECK (identifier_type IN
                                   ('email', 'phone', 'nfc_uid', 'nba_id', 'ticketmaster_id')),
  identifier_value TEXT          NOT NULL,
  source_system    TEXT          NOT NULL,
  schema_version   TEXT          NOT NULL,
  confidence_score NUMERIC(3,2)  NOT NULL DEFAULT 1.0
                                 CHECK (confidence_score >= 0.0 AND confidence_score <= 1.0),
  first_seen_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Uniqueness: same identifier cannot map to two fans in the same org.
--
-- REMOVED 2026-08-26: never valid SQL. A bare CONSTRAINT clause outside a
-- CREATE TABLE body is not a statement, so this errored on every migration
-- replay since April and never created anything.
--
-- uq_identifier_per_org is created by migration_013 as a PARTIAL unique
-- index (WHERE source_system != 'fan_pass'). That is the version the system
-- needs — the unfiltered version attempted here would block adding a second
-- child to a household, since siblings legitimately share guardian_email.
--
-- Commented rather than deleted so the history stays legible.
--
-- CONSTRAINT uq_identifier_per_org
--   UNIQUE (identifier_type, identifier_value, org_id);

-- Hot path: resolverEngine Path A + B lookup — runs on every resolution
-- Query: WHERE identifier_type = $1 AND identifier_value = $2 AND org_id = $3
CREATE INDEX idx_identifier_lookup
  ON identifier_link (identifier_type, identifier_value, org_id);

-- Hot path: GET /v1/fan/:id/profile Read 2, resolverEngine Step 4 linked systems
-- Query: WHERE fan_id = $1 AND org_id = $2 — also WHERE fan_id = $1 (Step 4)
CREATE INDEX idx_identifier_link_fan
  ON identifier_link (fan_id, org_id);

COMMENT ON TABLE identifier_link IS
  'Identity graph. One row per identifier-to-fan mapping. Many rows per fan.';
COMMENT ON COLUMN identifier_link.confidence_score IS
  'Sprint 1: always 1.0 (hard match). Sprint 2: probabilistic scores 0.00-1.00.';
COMMENT ON COLUMN identifier_link.first_seen_at IS
  'Immutable. When this identifier was first linked to this fan.';
COMMENT ON COLUMN identifier_link.last_seen_at IS
  'Updated on every Path A hard match. When this identifier was last seen.';


-- =============================================================================
-- TABLE: audit_log
--
-- Append-only audit trail. Every resolution, session issuance, and failure is
-- recorded here. Never UPDATE or DELETE rows in this table — only INSERT.
--
-- Why idempotency_key on audit_log not on identifier_link?
--   The idempotency check in resolverEngine Guard 2 queries audit_log.
--   If the same resolution request arrives twice, the second request finds the
--   first audit row and returns the original result — zero duplicate writes.
--   identifier_link is the identity graph state. audit_log is the event log.
--   Different concerns, different tables.
--
-- Why nullable fan_id?
--   Failure audit events (status='error') are written when resolution fails.
--   At failure time fan_id may be null — the fan record may not have been created.
--   The failure event still needs to be recorded. fan_id nullable makes this work.
--
-- Why jti column?
--   POST /v1/session writes the JWT token ID (jti) here for lineage in Sprint 1.
--   Sprint 2: jti becomes the revocation list. Mark a row revoked = logout.
--   The column is here now so revocation is a column addition, not a schema change.
--
-- Why error_detail TEXT nullable?
--   Only failure events (status='error') have error_detail.
--   Success events leave it null. CHECK constraint enforces the pairing.
-- =============================================================================

CREATE TABLE audit_log (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fan_id           UUID                     REFERENCES fan (id),  -- nullable: failure events
  org_id           UUID        NOT NULL REFERENCES org (id),
  event_type       TEXT        NOT NULL
                               CHECK (event_type IN ('resolution', 'session_issued')),
  match_type       TEXT                     CHECK (match_type IN ('hard', 'soft', 'probabilistic')),
  confidence_score NUMERIC(3,2),
  is_new_record    BOOLEAN,
  idempotency_key  TEXT,       -- present on resolution events, null on session_issued
  identifier_type  TEXT        CHECK (identifier_type IN
                                 ('email', 'phone', 'nfc_uid', 'nba_id', 'ticketmaster_id')),
  schema_version   TEXT,
  jti              TEXT,       -- JWT token ID — session_issued events only
  status           TEXT        NOT NULL DEFAULT 'success'
                               CHECK (status IN ('success', 'error')),
  error_detail     TEXT,       -- nullable — failure events only
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- No updated_at — audit_log is append-only. Rows are never updated.
);

-- Hot path: resolverEngine Guard 2 idempotency check
-- Query: WHERE idempotency_key = $1 AND org_id = $2
CREATE INDEX idx_audit_idempotency
  ON audit_log (idempotency_key, org_id)
  WHERE idempotency_key IS NOT NULL;  -- partial index — skip null rows

-- Hot path: GET /health Check 3 — 5-minute error rate
-- Query: WHERE created_at > NOW() - INTERVAL '5 minutes' [AND status = 'error']
CREATE INDEX idx_audit_created_at ON audit_log (created_at DESC);

COMMENT ON TABLE audit_log IS
  'Append-only audit trail. INSERT only — never UPDATE or DELETE.';
COMMENT ON COLUMN audit_log.fan_id IS
  'Nullable. Failure events written before fan record exists have null fan_id.';
COMMENT ON COLUMN audit_log.jti IS
  'JWT token ID. Sprint 1: lineage. Sprint 2: revocation list.';
COMMENT ON COLUMN audit_log.idempotency_key IS
  'sha256(type|value|org_id). Guard 2 queries this to detect duplicate resolution.';


-- =============================================================================
-- TABLE: ingest_failures
--
-- Dead Letter Queue (DLQ) for failed ingest attempts. A record here means
-- something arrived at an adapter (NFC tap, resolve request) and could not be
-- processed — normalization failed, resolver threw, etc.
--
-- Why separate table from audit_log?
--   audit_log records business events (resolution, session issuance).
--   ingest_failures records operational failures — unprocessable input.
--   Different query patterns: audit_log is queried by fan_id and idempotency_key.
--   ingest_failures is queried by status='pending' for queue depth monitoring
--   and by created_at for retry jobs. Separate table, separate indexes.
--
-- Why raw_payload JSONB not TEXT?
--   JSONB lets Postgres index into the payload in Sprint 2+ if you need to query
--   by a field inside the raw request (e.g. all failures where nfc_uid starts with
--   a certain prefix). TEXT stores it as a blob — queryable only with LIKE. JSONB
--   costs slightly more on write but pays off the moment you need to inspect it.
--
-- Why fan_id absent?
--   By definition, a failure record means resolution did not complete.
--   fan_id was never resolved. The fan_id column would always be null.
--   Omitting it makes the schema honest about what this table represents.
-- =============================================================================

CREATE TABLE ingest_failures (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID        NOT NULL REFERENCES org (id),
  source_system TEXT        NOT NULL
                            CHECK (source_system IN ('nfc', 'resolve', 'session')),
  raw_payload   JSONB       NOT NULL,
  reason_code   TEXT        NOT NULL
                            CHECK (reason_code IN ('normalization_error', 'resolver_error', 'auth_error')),
  error_detail  TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'retried', 'dead')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: GET /health Check 2 queue depth
-- Query: SELECT COUNT(*) FROM ingest_failures WHERE status = 'pending'
CREATE INDEX idx_ingest_failures_status ON ingest_failures (status)
  WHERE status = 'pending';  -- partial index — only index the rows health check queries

COMMENT ON TABLE ingest_failures IS
  'Dead Letter Queue. Failed ingest attempts that could not be processed.';
COMMENT ON COLUMN ingest_failures.raw_payload IS
  'JSONB — full request body at time of failure. Enables retry and forensic analysis.';
COMMENT ON COLUMN ingest_failures.status IS
  'pending = needs retry. retried = retry attempted. dead = unrecoverable.';


-- =============================================================================
-- SEED: see migrations/seed_dev.sql
--
-- Dev org seed has been moved to seed_dev.sql to prevent known credentials
-- from reaching production Cloud SQL.
-- Run seed_dev.sql manually in local and staging environments only.
-- Production org records are inserted via admin tooling, not migrations.
-- =============================================================================


-- =============================================================================
-- VERIFICATION QUERIES
-- Run these after migration to confirm all tables and indexes were created.
-- Expected: 5 tables, correct column counts, indexes present.
-- =============================================================================

-- Confirm all five tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('org', 'fan', 'identifier_link', 'audit_log', 'ingest_failures')
ORDER BY table_name;

-- Confirm all indexes exist
SELECT indexname, tablename
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'idx_org_api_key_key',         -- UNIQUE on org (note: Postgres names UNIQUE indexes _key)
    'idx_org_api_key_hash',
    'idx_fan_org',
    'idx_identifier_lookup',
    'idx_identifier_link_fan',
    'idx_audit_idempotency',
    'idx_audit_created_at',
    'idx_ingest_failures_status'
  )
ORDER BY tablename, indexname;

-- Confirm seed org row
SELECT id, name, is_active FROM org;
