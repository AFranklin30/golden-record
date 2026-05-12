Completed: TASK-16 and TASK-17 fixed. All P0 findings resolved or blocked on external dependencies. CIA Triad updated.
Next: Sprint 2 planning kickoff with Monique using owasp_audit.md backlog; confirm CORS domain with King/Tanner (unblocks TASK-03-cors); get GCP credentials (unblocks TASK-13, TASK-02-rls, TASK-20).
Blocked: CORS domain (King/Tanner) blocks TASK-03-cors; GCP credentials block TASK-13, TASK-02-rls, TASK-20 Firestore rule verification.
Decisions: TASK-17 seed extracted to seed_dev.sql with a database-name guard (RAISE EXCEPTION if not dev/test/local/staging). Chosen over inline guard in migration_001.sql — credentials are physically absent from the production migration now.
Warnings: seed_dev.sql must never be added to any CI pipeline that runs against production; document this in the Sprint 2 runbook.
