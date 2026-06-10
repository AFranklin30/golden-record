Completed: removed Block 3 (error_rate_5m) from health.js — audit_log has RLS and pool.query can't set app.current_org_id; this also eliminates the pg deprecation warning
Next: run migration_010.sql on Cloud SQL (psql $DATABASE_URL -f migrations/migration_010.sql), then npm test full suite, commit, rebuild, redeploy
Blocked: nothing
Decisions: error rate monitoring belongs in Cloud Logging, not the health endpoint; isHealthy now only checks db connected + queue_depth < 10000
Warnings: migration_010.sql must still run on Cloud SQL before redeploy — child_session_issued audit INSERT will fail CHECK constraint in production without it
