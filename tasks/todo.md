# migration_009.sql — audit_log match_type constraint fix
# Session: 2026-06-09

---

## Context

audit_log.match_type CHECK constraint was defined in migration_001 with three values:
  'hard', 'soft', 'probabilistic'

Sprint 2 Path D writes match_type = 'conflict'. Every Path D resolution event
fails in production with a CHECK constraint violation. This migration adds 'conflict'
to the allowed set.

audit_log.fan_id is nullable — test insert does not need a fan fixture.
audit_log.org_id is NOT NULL — one test org fixture will be created and left.
audit_log is append-only — test row intentionally not deleted per CLAUDE.md rule.

---

## Source files read

- [x] tasks/handoff.md — session context loaded
- [x] tasks/lessons.md — 11 lessons reviewed
- [x] migrations/migration_007.sql — exact pattern confirmed
- [x] migrations/migration_008.sql — pattern confirmed
- [x] migrations/migration_001.sql audit_log section — constraint name and columns confirmed

---

## Plan

File: migrations/migration_009.sql

### Header
Same pattern as migration_007:
  Author: Aaron
  Sprint 2 constraint fix (applied in Sprint 3 cycle)
  Depends on: migration_001.sql
  Run after: migration_008.sql
  Blocks: Path D resolution events in production

### Safety guard
DO $$ block — checks if audit_log_match_type_check already includes 'conflict'.
If yes: RAISE EXCEPTION 'migration_009 already applied — ...'
Same pattern as migration_007 safety guard.

### Part 1 — fix constraint
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_match_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_match_type_check
  CHECK (match_type IN ('hard', 'soft', 'probabilistic', 'conflict'));

### Verification query 1
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'audit_log'::regclass
  AND conname = 'audit_log_match_type_check';
Expected: all four values present

### Verification query 2 — DO $$ test block
- Create org fixture (name: '_mig009_test_org', identifiable for future cleanup)
- SET app.current_org_id (RLS context — same pattern as migration_007 and migration_008)
- INSERT into audit_log with match_type = 'conflict', fan_id = NULL (nullable column)
- RAISE NOTICE 'TEST PASSED: audit_log accepts match_type = conflict'
- Do NOT delete from audit_log — append-only rule
- Leave NOTICE that org fixture and test row are intentionally left

---

## Steps

- [x] 1. Read migration_007.sql — confirmed pattern
- [x] 2. Read migration_001.sql audit_log section — confirmed constraint name and column nullability
- [x] 3. Write plan to tasks/todo.md (this file)
- [ ] 4. Check in with Aaron before implementation
- [ ] 5. Create migrations/migration_009.sql
- [ ] 6. Update tasks/lessons.md
- [ ] 7. Update tasks/handoff.md
