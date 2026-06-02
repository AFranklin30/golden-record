Completed: migration_006.sql — partial unique index on identifier_link (fan_pass only), RLS on 5 Sprint 3 tables, 3 data integrity indexes on conflict_queue/merge_history/related_fans.
Next: Run migration_006.sql locally (psql $DATABASE_URL -f migrations/migration_006.sql), then Sprint 3 test suite security regression check on household + admin routes.
Blocked: GCP credentials from Tanner — migrations 003/004/005/006 not yet run on Cloud SQL.
Decisions: Partial unique index scoped to source_system = 'fan_pass' only — full index would block multi-source ingest. RLS cross-tenant test uses household as representative table (same policy pattern on all 5 tables).
Warnings: Run migration_006 locally before Sprint 3 test suite — RLS policies must be active for tenant isolation tests to pass. Run migrations in order: 003 → 004 → 005 → 006.
