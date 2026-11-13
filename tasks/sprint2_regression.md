# Sprint 2 Security Regression Report
**Golden Record**
Date: 2026-05-28 | Reviewer: Claude Sonnet 4.6
Scope: Net new Sprint 2 components only — probabilisticMatcher.js,
       resolverEngine.js Paths C/D, conflicts.js, migration_004.sql

Prior audits on file: tasks/stride_audit.md, tasks/owasp_audit.md, tasks/gap_report.md
This report does not re-raise findings already in those documents.

---

## Evaluation Criteria Applied

1. RECEIVE/GUARD/EXECUTE/RETURN pattern — all functions/handlers
2. org_id binding — req.context only, never request.body
3. Error sanitization — no err.message in response body, correlation_id on 500s
4. Parameterized queries — $1/$2/$3 everywhere, no string concatenation
5. Audit trail — audit event last in every transaction, new event_types valid
6. Conflict queue isolation — org_id filters on all conflict_queue queries
7. Probabilistic matcher cross-tenant check — org_id mismatch guard, signals_matched internal only
8. merge_history and merged_from_fan_id — confirm sets provenance, unmerge uses it
9. Child data protection — not applicable (Sprint 3)
10. New response fields — requires_review, conflict_id, session_ready present in correct paths

---

## Clean

### probabilisticMatcher.js
All 10 checks pass.
- RECEIVE/GUARD/EXECUTE/RETURN pattern correct (lines 54-146)
- org_id mismatch guard present and throws before any scoring (line 67-69)
- Pure functions — no database calls, no side effects
- MAX scoring (not additive) — correct, prevents score inflation from weak signals stacking
- Error wrapping: inner errors caught and re-raised as NormalizationError (line 139-143)
- signals_matched is only in the return value of scoreMatch, consumed internally by
  resolverEngine — never surfaced in any API response

### resolverEngine.js (Paths C and D)
All checks pass except FINDING-R2 (see Findings section).
- org_id comes from input.org_id, which resolve.js:20 and nfc.js:21 bind to
  req.context.org_id — org_id binding is correct at the caller layer
- All queries use parameterized placeholders ($1, $2, ...) — lines 91-257
- Candidate query includes org_id filter: `WHERE f.org_id = $1` (line 117) — TASK-05 clean
- STEP 5 linked-systems query includes org_id filter: `AND org_id = $2` (line 285) — TASK-05 fixed
- conflict_id generated and returned on Paths C/D (lines 185, 216, 319) ✅
- idempotency early return includes `conflict_id: null` (line 84) — GAP-03 fixed
- Audit event is LAST write inside transaction (lines 249-258) ✅
- conflict_queue INSERT inside transaction (lines 186-192, 217-223) before audit ✅
- Firestore sync non-fatal (lines 263-280) ✅
- Pattern 2 (TRY wraps GUARD + EXECUTE) correctly implemented

### GET /v1/conflicts
All checks pass.
- org_id sourced from req.context.org_id (line 16) — never from query params or body
- Conflict query filters by org_id AND status: `WHERE org_id = $1 AND status = $2` (line 53)
- No err.message in 500 response (line 87: returns generic string)
- correlation_id present in error log (line 85) ✅
- RECEIVE/GUARD/EXECUTE/RETURN pattern correct
- GUARD validates status allowlist, limit bounds, offset bounds before any DB call
- signals_matched returned to staff dashboard (line 72) — intentional by design
  (Component 18 pseudocode explicitly includes it; this is an org-auth staff endpoint,
   not a fan-facing endpoint; staff need signal detail to make merge decisions)
- Count query also org_id scoped (line 60-61) ✅

### POST /v1/conflicts/:id/reject
All checks pass.
- org_id from req.context.org_id (line 195)
- conflict_queue READ uses `WHERE id = $1 AND org_id = $2` (line 209-213)
  — org ownership verified before any write
- Status 'pending' verified before transaction (line 222-224)
- No soft delete of fan_id_b (correct — different people, records stay separate)
- All writes parameterized ✅
- Audit event LAST in transaction (lines 238-241) ✅
- No err.message in 500 response (line 258) ✅
- correlation_id in error log (line 260) ✅

### migration_004.sql
All checks pass.
- Safety guard prevents re-run (lines 29-39)
- GAP-01 fix confirmed: ALTER TABLE updates audit_log.event_type CHECK constraint
  (lines 54-56) to include 'conflict_confirmed' and 'conflict_rejected'
  — confirm and reject audit INSERTs will not throw constraint violations
- conflict_queue table created with correct schema
- 3 indexes created (org_status composite, fan_a, fan_b) ✅
- Foreign keys on fan_id_a, fan_id_b, org_id ✅

### resolve.js (Sprint 2 response shape — cross-reference only)
Confirmed via file read — not reloaded in full.
- All 4 paths include requires_review and conflict_id (lines 79-133)
  Path A hard match: requires_review: false, conflict_id: null
  Path B hard match new: requires_review: false, conflict_id: null
  Path C soft: requires_review: true, conflict_id: result.conflict_id
  Path D conflict: requires_review: true, conflict_id: result.conflict_id

### nfc.js (Sprint 2 response shape — cross-reference only)
Confirmed via file read — not reloaded in full.
- All 4 paths include requires_review, conflict_id, AND session_ready (lines 119-177)
  session_ready: true on all paths (fan record exists in all cases) ✅
- GAP-05 fix confirmed: event: 'dlq_write_failure' label on both DLQ catch blocks
  (lines 72, 108) ✅

---

## Findings

### FINDING-R1
**Severity: High**
**File: src/routes/conflicts.js:131, 154-158**
**Check: #8 — merge_history and merged_from_fan_id**
**Net new: Yes — not in STRIDE, OWASP, or gap_report (informal mention in handoff.md only)**

The confirm endpoint writes to two objects that do not exist in the current schema:

1. Line 131 — `SET fan_id = $1, merged_from_fan_id = $2`
   The `merged_from_fan_id` column on `identifier_link` is defined in migration_005.sql
   (PART 7: `ALTER TABLE identifier_link ADD COLUMN merged_from_fan_id UUID REFERENCES fan(id)`).
   It does not exist in the schema until migration_005.sql runs.

2. Lines 154-158 — `INSERT INTO merge_history (...)`
   The `merge_history` table is defined in migration_005.sql (PART 5).
   It does not exist in the schema until migration_005.sql runs.

**Production impact:** Every POST /v1/conflicts/:id/confirm call throws a Postgres error
(`column "merged_from_fan_id" of relation "identifier_link" does not exist` or
`relation "merge_history" does not exist`) at the transaction level. The CATCH block
at line 177 rolls back the entire transaction. The conflict status remains 'pending'.
No merge is ever completed. The endpoint appears to "work" (returns 500 with generic
message) but performs no state change.

Tests pass because the DB is mocked and mock queries don't validate schema.

**Production gate:** migration_005.sql must run before the confirm endpoint is made
available in production. This is already blocked on GCP credentials per handoff.md.
No code change needed — the code correctly anticipates Sprint 3 schema. Document
this dependency explicitly in a production deploy checklist.

---

### FINDING-R2
**Severity: Medium**
**File: src/modules/resolverEngine.js:112-119**
**Check: #6 — conflict queue isolation, #2 — org_id binding**
**Net new: Yes — not in STRIDE, OWASP, or gap_report**

The candidate query for probabilistic scoring does not exclude deleted fan records:

```sql
SELECT f.id, f.org_id, il.identifier_type, il.identifier_value
FROM fan f
JOIN identifier_link il ON il.fan_id = f.id
WHERE f.org_id = $1
  AND il.identifier_type IN ('email', 'phone', 'device_id')
LIMIT 100
```

`f.deleted_at IS NULL` is missing. A fan that has been soft-deleted (deleted_at IS NOT NULL)
can appear as `bestMatch` and be placed in conflict_queue as `fan_id_a`.

**Attack chain:**
1. Fan A is resolved via Path B → fan record created
2. Fan A is later erased (deleted_at set via some future erasure endpoint)
3. New inbound identifier probabilistically matches deleted Fan A
4. Path C or Path D fires → conflict_queue row with fan_id_a = deleted Fan A's id
5. Staff sees the conflict and confirms it
6. Confirm endpoint moves identifiers to deleted Fan A (merged_into a deleted record)
7. fan_id_b soft-deleted as well
8. Both fan records are now inaccessible — identifiers permanently stranded

This is a data integrity issue, not a cross-tenant issue. Requires the specific sequence
above. No sprint has a fan erasure endpoint yet (Sprint 6 scope per CLAUDE.md), so the
practical risk is low today. Must be fixed before erasure endpoints exist.

**Recommended fix:**
src/modules/resolverEngine.js:112-119 — add `AND f.deleted_at IS NULL` to candidate query:

```javascript
const candidateRows = await client.query(
  `SELECT f.id, f.org_id, il.identifier_type, il.identifier_value
   FROM fan f
   JOIN identifier_link il ON il.fan_id = f.id
   WHERE f.org_id = $1
     AND f.deleted_at IS NULL
     AND il.identifier_type IN ('email', 'phone', 'device_id')
   LIMIT 100`,
  [org_id]
);
```

---

### FINDING-R3
**Severity: Medium**
**File: src/routes/conflicts.js:109-124**
**Check: #6 — conflict queue isolation**
**Net new: Yes — not in STRIDE, OWASP, or gap_report**

The confirm endpoint READ section verifies the conflict exists, belongs to the org, and
is 'pending'. It does not verify that fan_id_a (the merge target) is still active:

```javascript
const conflictResult = await client.query(
  `SELECT id, fan_id_a, fan_id_b, org_id, status
   FROM conflict_queue
   WHERE id = $1 AND org_id = $2`,
  [conflict_id, org_id]
);
```

If fan_id_a was deleted after the conflict_queue row was created, the confirm proceeds
and moves all identifiers from fan_id_b into a deleted fan record (fan_id_a). The merge
completes successfully from the endpoint's perspective, but the merged fan record is
permanently inaccessible.

This is a defense-in-depth gap. FINDING-R2 recommends excluding deleted fans from scoring,
which prevents most cases. R3 is the backstop check at confirm time.

Related to: FINDING-R2 (same root cause, different enforcement point)
Practical risk: Low today (no erasure endpoint in current sprints).
Must be fixed before erasure endpoints exist.

**Recommended fix:**
src/routes/conflicts.js — after reading the conflict (before BEGIN TRANSACTION), add
a check on fan_id_a.deleted_at:

```javascript
const fanAResult = await client.query(
  'SELECT deleted_at FROM fan WHERE id = $1 AND org_id = $2',
  [conflict.fan_id_a, org_id]
);
if (fanAResult.rows.length === 0 || fanAResult.rows[0].deleted_at !== null) {
  return res.status(409).json({ error: 'merge target has been erased — conflict cannot be confirmed' });
}
```
Insert this block between line 124 (status check) and line 126 (BEGIN).

---

### FINDING-R4
**Severity: Low**
**File: src/routes/conflicts.js:144-149 (confirm), 230-235 (reject)**
**Check: #5 — audit trail**
**Net new: Yes — not in any prior audit. Matches pseudocode spec.**

The `conflict_queue.reviewed_by` column is defined in migration_004.sql (line 87) but
neither the confirm nor the reject endpoint populates it. The UPDATE statements set only
`status` and `reviewed_at`:

```sql
-- confirm (line 145-148):
UPDATE conflict_queue
SET status = 'confirmed', reviewed_at = NOW()
WHERE id = $1

-- reject (line 231-234):
UPDATE conflict_queue
SET status = 'rejected', reviewed_at = NOW()
WHERE id = $1
```

The column is documented as "staff user identifier who confirmed the merge" in the
migration comment. Without a value, there is no accountability trail in conflict_queue
for who made each merge decision. `merge_history.merged_by` is populated on confirm
(line 157: `req.context.org_name`), which provides partial accountability — but only
for confirmed merges, not rejected ones.

Pseudocode for Components 19 and 20 also omits reviewed_by, so this matches the spec.
This is a design gap in the spec itself.

Not a security vulnerability. No remediation required for Sprint 2 close.

---

## Findings Summary

| ID | Severity | File | Line(s) | Description | Net New | Fix Required |
|----|----------|------|---------|-------------|---------|--------------|
| R1 | High | conflicts.js | 131, 154-158 | Confirm endpoint references migration_005.sql objects (merge_history table, merged_from_fan_id column) — endpoint is non-functional in production until Sprint 3 migration runs | Yes | Production deploy gate: run migration_005.sql before enabling confirm in production |
| R2 | Medium | resolverEngine.js | 112-119 | Candidate query includes deleted fans — deleted fan can become merge target in conflict_queue | Yes | Add `AND f.deleted_at IS NULL` to candidate query |
| R3 | Medium | conflicts.js | 109-124 | Confirm endpoint doesn't verify fan_id_a.deleted_at before merge — identifiers can move to deleted fan | Yes | Add deleted_at check on fan_id_a before BEGIN TRANSACTION |
| R4 | Low | conflicts.js | 144-149, 230-235 | conflict_queue.reviewed_by never populated — no accountability trail per merge decision | Yes | No fix required for Sprint 2 (matches pseudocode spec) |

---

## Recommended Fixes

### R1 — Production Deploy Gate (no code change)
Add to production deploy checklist:
> POST /v1/conflicts/:id/confirm is non-functional until migration_005.sql is applied.
> Gate this endpoint behind a feature flag or disable it in prod until Sprint 3 migration runs.
> Tests pass (mocked DB) — production failure is schema-only.

### R2 — Exact Change for resolverEngine.js:112-119

Replace:
```javascript
const candidateRows = await client.query(
  `SELECT f.id, f.org_id, il.identifier_type, il.identifier_value
   FROM fan f
   JOIN identifier_link il ON il.fan_id = f.id
   WHERE f.org_id = $1
     AND il.identifier_type IN ('email', 'phone', 'device_id')
   LIMIT 100`,
  [org_id]
);
```

With:
```javascript
const candidateRows = await client.query(
  `SELECT f.id, f.org_id, il.identifier_type, il.identifier_value
   FROM fan f
   JOIN identifier_link il ON il.fan_id = f.id
   WHERE f.org_id = $1
     AND f.deleted_at IS NULL
     AND il.identifier_type IN ('email', 'phone', 'device_id')
   LIMIT 100`,
  [org_id]
);
```

### R3 — Exact Change for conflicts.js — insert after line 124, before line 126

```javascript
// Verify merge target (fan_id_a) has not been erased
const fanAResult = await client.query(
  'SELECT deleted_at FROM fan WHERE id = $1 AND org_id = $2',
  [conflict.fan_id_a, org_id]
);
if (fanAResult.rows.length === 0 || fanAResult.rows[0].deleted_at !== null) {
  return res.status(409).json({ error: 'merge target has been erased — conflict cannot be confirmed' });
}
```

---

## Prior Audit Cross-Reference

Findings from STRIDE/OWASP/gap_report that this regression confirms as FIXED in Sprint 2:

| Prior Task | Fix Confirmed |
|------------|---------------|
| GAP-01 — audit_log CHECK constraint | ✅ migration_004.sql:54-56 — constraint updated |
| GAP-03 — idempotency return missing conflict_id | ✅ resolverEngine.js:84 — `conflict_id: null` present |
| TASK-01/TASK-05 — org_id binding + linked-systems org_id filter | ✅ resolverEngine.js:285 — `AND org_id = $2` present |
| GAP-05 — DLQ write failure structured label | ✅ nfc.js:72, 108 — `event: 'dlq_write_failure'` present |

Open prior findings that are NOT Sprint 2 scope (carry to Sprint 3):

| Prior Task | Status |
|------------|--------|
| TASK-06 — JWT revocation via jti blocklist | Deferred Sprint 3 |
| TASK-09 — Org API key rotation endpoint | Deferred post-midpoint |
| TASK-10 — audit_log append-only DB trigger | Blocked: migration_003.sql not run |
| TASK-13 — Cloud Run header redaction | Blocked: GCP credentials |
| TASK-16 — session.js body.org_id (confirmed fixed per gap_report) | ✅ Fixed |
| TASK-19 — JWT org claim vs orgAuth context mismatch | ✅ Fixed (per gap_report confirmed) |

---

## Sprint 2 Close Verdict

**Sprint 2 security regression check: CONDITIONAL PASS**

No new Critical findings.

Two Medium findings (R2, R3) are data integrity gaps that have low practical risk in
current sprints (no erasure endpoint exists yet). They must be fixed before Sprint 6
erasure endpoints are built.

One High finding (R1) is a known production blocker already flagged in handoff.md.
It is a schema dependency issue, not a code bug. No code change required — migration
gate must be enforced.

**Sprint 2 may close if:**
- R1 is documented in the production deploy checklist as a migration gate
- R2 and R3 are tracked in the Sprint 3 backlog as pre-erasure fixes
- R4 is acknowledged as a spec gap (low severity, no immediate fix required)

---
*Regression check complete: 2026-05-28*
*Reviewer: Claude Sonnet 4.6 — analysis only, no code modified*
