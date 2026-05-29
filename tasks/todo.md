# Sprint 3 — Component 26: POST /v1/conflicts/:id/unmerge
# OKC Thunder · Golden Record Fan Identity Platform
# Session: 2026-05-29

---

## Goal

Add POST /v1/conflicts/:id/unmerge to src/routes/conflicts.js.
Reverses a confirmed merge using merged_from_fan_id provenance.
Staff-only endpoint — orgAuthMiddleware, no jwtMiddleware.
TRY/CATCH Pattern 1 — TRY wraps EXECUTE only.

---

## Build Order

- [ ] Write plan to tasks/todo.md
- [ ] Aaron approves plan
- [ ] Add unmerge handler to conflicts.js (RECEIVE/GUARD/EXECUTE/RETURN)
- [ ] Write tests/routes/conflicts.test.js — 12 unmerge test cases
- [ ] Run full test suite — all green
- [ ] Update tasks/handoff.md (5 lines max)

---

## Handler Structure

### RECEIVE
- conflict_id from req.params.id
- org_id from req.context.org_id

### GUARD (in-memory — no db calls in GUARD)
- conflict_id null/empty → 400 "conflict_id is required"
- conflict_id not UUID → 400 "conflict_id must be a valid UUID"

### EXECUTE — Pattern 1: TRY wraps all db work

**READ 1 — conflict_queue**
```sql
SELECT id, fan_id_a, fan_id_b, org_id, status
FROM conflict_queue
WHERE id = $1 AND org_id = $2
```
- rows.length === 0 → 404 "conflict not found"
- conflict.status !== 'confirmed' → 409 "conflict is not confirmed"
  message: "only confirmed merges can be reversed"

**READ 2 — merge_history**
```sql
SELECT id, fan_id_source, fan_id_target, status
FROM merge_history
WHERE conflict_id = $1 AND org_id = $2 AND status = 'active'
```
- rows.length === 0 → 404 "merge history not found"
  message: "this merge cannot be reversed"

**BEGIN TRANSACTION**

STEP 1 — move identifiers back to fan_id_source
```sql
UPDATE identifier_link
SET fan_id = merged_from_fan_id,
    merged_from_fan_id = NULL
WHERE fan_id = $1          -- fan_id_target
AND merged_from_fan_id = $2  -- fan_id_source
AND org_id = $3
```

STEP 2 — reactivate fan_id_source (clear deleted_at)
```sql
UPDATE fan
SET deleted_at = NULL, updated_at = NOW()
WHERE id = $1 AND org_id = $2
```

STEP 3 — update conflict_queue status to 'unmerged'
```sql
UPDATE conflict_queue
SET status = 'unmerged', reviewed_at = NOW()
WHERE id = $1
```

STEP 4 — update merge_history status to 'reversed'
```sql
UPDATE merge_history
SET status = 'reversed',
    reversed_at = NOW(),
    reversed_by = $1   -- req.context.org_name
WHERE id = $2          -- mergeRecord.id
```

STEP 5 — write to related_fans
```sql
INSERT INTO related_fans
  (id, fan_id_a, fan_id_b, org_id, relationship, source, created_at)
VALUES ($1, $2, $3, $4, 'unmerged', 'merge_history', NOW())
```
fan_id_a = mergeRecord.fan_id_target (the absorbing record)
fan_id_b = mergeRecord.fan_id_source (the restored record)

STEP 6 — audit event — always last write in transaction
```sql
INSERT INTO audit_log
  (id, fan_id, org_id, event_type, status, created_at)
VALUES ($1, $2, $3, 'merge_reversed', 'success', NOW())
```
fan_id = mergeRecord.fan_id_target

**COMMIT**

CATCH — ROLLBACK, logger.error, return 500

### RETURN
```json
{
  "conflict_id":     "<uuid>",
  "status":          "unmerged",
  "fan_id_restored": "<fan_id_source>",
  "fan_id_target":   "<fan_id_target>",
  "reversed_at":     "<ISO timestamp>"
}
```

---

## Test Cases (12)

1.  Identifiers move back to fan_id_source — identifier_link rows repointed
2.  merged_from_fan_id is NULL on all moved rows after unmerge
3.  fan_id_target no longer has those specific identifier rows
4.  fan_id_source reactivated — deleted_at is NULL after unmerge
5.  conflict_queue status = 'unmerged' after unmerge
6.  merge_history status = 'reversed', reversed_at set, reversed_by set
7.  related_fans row written with relationship = 'unmerged'
8.  Returns 409 when conflict status is 'pending'
9.  Returns 409 when conflict status is 'rejected'
10. Returns 409 when conflict status is 'unmerged' (cannot unmerge twice)
11. Returns 404 when conflict not found
12. Returns 404 when merge_history not found

---

## Constraints

- Touch conflicts.js only — do not touch confirm, reject, or list handlers
- ALLOWED_STATUSES constant stays: ['pending', 'confirmed', 'rejected']
  — list endpoint uses it, unmerge does not reference it
- Audit event is last write in transaction (STEP 6)
- merged_from_fan_id set to NULL after move (clean provenance after reversal)
- fan_id_source reactivated by clearing deleted_at — not re-created
- Never fix a test to match broken code

---

## Review Checklist

- [ ] RECEIVE / GUARD / EXECUTE / RETURN sections present and labeled
- [ ] GUARD has no db calls
- [ ] TRY wraps all db work (Pattern 1)
- [ ] READ 1 before READ 2 before transaction
- [ ] STEP 1: identifier_link fan_id set to merged_from_fan_id, merged_from_fan_id set NULL
- [ ] STEP 2: fan deleted_at cleared
- [ ] STEP 3: conflict_queue set to 'unmerged'
- [ ] STEP 4: merge_history set to 'reversed'
- [ ] STEP 5: related_fans row written
- [ ] STEP 6: audit_log is last write
- [ ] ROLLBACK on error
- [ ] 500 returns generic message only — no err.message in response
- [ ] All 12 tests pass
- [ ] No existing tests broken
