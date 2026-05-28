# Sprint 2 — Complete Test Suite
# OKC Thunder · Golden Record Fan Identity Platform
# Date: 2026-05-28

---

## Current State (session start)

All 5 test files already exist from prior sessions.
94 tests total. 86 passing. 8 failing.

**Root cause of 8 failures:**
conflicts.test.js `setupSuccessfulConfirm` sets up 2 mock responses:
  1. SELECT conflict → pendingConflict
  2. Everything else → { rows: [] } (default)

The R3 fix added a new SELECT fan_id_a.deleted_at call between the
conflict SELECT and BEGIN. When that call returns { rows: [] },
`fanAResult.rows.length === 0` → handler returns 404 → all subsequent
transaction assertions fail.

Fix: add a third mock to setupSuccessfulConfirm that returns
`{ rows: [{ deleted_at: null }] }` for the fan_id_a SELECT.

**Missing regression tests:**
- R2 scenarios not in resolverEngine.test.js (2 tests)
- R3 scenarios not in conflicts.test.js (4 tests)

---

## Gap Confirmation (pre-flight)

- [x] GAP-01 — audit_log CHECK constraint fixed in migration_004.sql
- [x] GAP-02 — crypto import added to correlationIdMiddleware.js
- [x] GAP-03 — conflict_id: null on idempotency early return
- [x] GAP-04 — token_without_audit structured log in session.js
- [x] GAP-05 — event: 'dlq_write_failure' in nfc.js both DLQ blocks
- [x] GAP-06 — Firestore wallet field validation in profile.js
- [x] GAP-07 — aud deviation documented in jwt.js
- [x] R2 fix — AND f.deleted_at IS NULL in resolverEngine.js candidate query
- [x] R3 fix — fan_id_a deleted_at guard in conflicts.js confirm handler

---

## Tasks

- [ ] Write plan to tasks/todo.md [THIS FILE — done]
- [ ] Check in with Aaron before implementation
- [ ] Fix setupSuccessfulConfirm in conflicts.test.js — add fan_id_a mock
      (this is the root cause of all 8 failures)
- [ ] Add R2 regression scenarios to resolverEngine.test.js (2 tests)
      R2-A: candidate SQL includes AND f.deleted_at IS NULL
      R2-B: Path B fires when candidate query returns empty rows
- [ ] Add R3 regression scenarios to conflicts.test.js (4 tests)
      R3-A: confirm returns 409 when fan_id_a.deleted_at is not null
      R3-B: no identifiers moved when fan_id_a is deleted (no UPDATE identifier_link)
      R3-C: fan_id_b record unchanged after 409 (no UPDATE fan)
      R3-D: conflict_queue status remains pending after 409 (no UPDATE conflict_queue)
- [ ] Run all tests — target: 100 tests, 100 passing
- [ ] Update tasks/handoff.md

---

## File Scope

- tests/modules/resolverEngine.test.js — add 2 R2 scenarios
- tests/routes/conflicts.test.js — fix setupSuccessfulConfirm + add 4 R3 scenarios

No source files touched unless a test reveals broken code.
Two files only.

---

## Done When

All tests passing. Final count reported. Handoff updated.
No tests skipped. No tests fixed to match broken code.
