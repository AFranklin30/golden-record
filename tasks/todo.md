# migration_006.sql — Sprint 3 Schema Enforcement
# OKC Thunder · Golden Record Fan Identity Platform
# Session: 2026-06-01

---

## Goal

Schema-level enforcement for Sprint 3 data integrity.
Three independent concerns:
  1. Partial unique index on identifier_link for Fan Pass managed identifiers
  2. RLS on the five new Sprint 3 tables
  3. Data integrity constraints on conflict_queue, merge_history, related_fans

One new file: migrations/migration_006.sql
No application code changes.

---

## Files Touched (1 file)

1. migrations/migration_006.sql  — new file only

---

## Structure Plan

### Safety guard (top of file)
  Check for existence of uq_identifier_link_managed index.
  Same DO $$ pattern as migration_003.
  If index already exists → RAISE EXCEPTION 'migration_006 already applied'.

### PART 1 — Partial unique index on identifier_link
  DROP INDEX IF EXISTS uq_identifier_link_fan_type_org;
    — cleans up any full index that may have been applied as a one-off fix
  CREATE UNIQUE INDEX uq_identifier_link_managed
    ON identifier_link (fan_id, identifier_type, org_id)
    WHERE source_system = 'fan_pass';
  Comment: Fan Pass identifiers are authoritative (one per type per fan per org).
           Ingest identifiers are observed — multiples allowed.
           Full unique index would break ingest from Ticketmaster, NBA app, camps.

### PART 2 — RLS on five Sprint 3 tables
  For each table: ENABLE, CREATE POLICY tenant_isolation, FORCE.
  Exact same pattern as migration_003 (no deviation).
  Tables:
    household
    household_member
    staging_household_data
    merge_history
    related_fans

  RLS note: same app.current_org_id session variable as migration_003.
  No new middleware needed — same rlsContextMiddleware from migration_003 covers
  all tables. No Node.js integration note required here.

### PART 3 — Data integrity constraints
  CREATE UNIQUE INDEX IF NOT EXISTS uq_conflict_queue_pair
    ON conflict_queue (fan_id_a, fan_id_b, org_id)
    WHERE status = 'pending';
    — prevents duplicate pending pairs only
    — resolved conflicts can have historical duplicates

  CREATE UNIQUE INDEX IF NOT EXISTS uq_merge_history_active
    ON merge_history (conflict_id)
    WHERE status = 'active';
    — one active merge per conflict at a time
    — prevents race condition on concurrent unmerge

  CREATE UNIQUE INDEX IF NOT EXISTS uq_related_fans_pair
    ON related_fans (fan_id_a, fan_id_b, org_id, relationship);
    — same two fans cannot have the same relationship twice

### Verification queries (bottom of file)
  1. Partial index exists on identifier_link
       SELECT indexname FROM pg_indexes
       WHERE tablename = 'identifier_link'
         AND indexname = 'uq_identifier_link_managed'
       Expected: 1 row
  2. RLS enabled on all five Sprint 3 tables
       SELECT tablename, rowsecurity FROM pg_tables
       WHERE tablename IN (
         'household', 'household_member',
         'staging_household_data',
         'merge_history', 'related_fans'
       )
       Expected: 5 rows, all rowsecurity = true
  3. All three data integrity indexes exist
       SELECT indexname FROM pg_indexes
       WHERE indexname IN (
         'uq_conflict_queue_pair',
         'uq_merge_history_active',
         'uq_related_fans_pair'
       )
       Expected: 3 rows
  4. RLS cross-tenant block test
       Same DO $$ pattern as migration_003/005 block test.
       Set app.current_org_id to a fake UUID.
       SELECT from each Sprint 3 table.
       Verify 0 rows returned (RLS blocks cross-tenant).

---

## Open Questions (none — everything confirmed in spec)

  - Partial vs full unique index: confirmed partial (source_system = 'fan_pass')
  - RLS policy name: confirmed 'tenant_isolation' (matches migration_003)
  - Safety guard sentinel: confirmed uq_identifier_link_managed index
  - PART 3 scope condition on uq_conflict_queue_pair: confirmed pending only

---

## Build Order

- [x] tasks/handoff.md read
- [x] tasks/lessons.md read
- [x] migration_003.sql read (RLS pattern)
- [x] migration_005.sql read (structure + verification pattern)
- [x] Plan written to tasks/todo.md
- [ ] Aaron approves plan — CHECK IN BEFORE IMPLEMENTATION
- [ ] Write migrations/migration_006.sql
- [ ] Visual review: safety guard, all 5 RLS tables, all 3 integrity indexes, 4 verification queries
- [ ] Update tasks/handoff.md
- [ ] Update tasks/lessons.md if any corrections

---

## Review Checklist

- [ ] Safety guard aborts on re-run (DO $$ block, checks uq_identifier_link_managed)
- [ ] DROP INDEX IF EXISTS uq_identifier_link_fan_type_org before create
- [ ] Partial index predicate: WHERE source_system = 'fan_pass'
- [ ] RLS on all 5 Sprint 3 tables — none missed
- [ ] ENABLE → POLICY → FORCE order on each table (matches migration_003)
- [ ] Policy name exactly 'tenant_isolation' on each table
- [ ] uq_conflict_queue_pair WHERE status = 'pending'
- [ ] uq_merge_history_active WHERE status = 'active'
- [ ] uq_related_fans_pair — no WHERE clause (full dedup)
- [ ] IF NOT EXISTS on all three PART 3 indexes
- [ ] 4 verification queries match spec exactly
- [ ] No application code changes
- [ ] No existing migration files modified
