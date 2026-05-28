---
# Gap Report — Sprint 2 Pre-Close Review
OKC Thunder · Golden Record Fan Identity Platform
Date: 2026-05-21 | Reviewer: Claude Sonnet 4.6
Scope: All 20 Sprint 1 and Sprint 2 components evaluated against 10 criteria.

---

## Critical Gaps (must fix before Sprint 2 closes)

---

### GAP-01 — audit_log.event_type CHECK constraint rejects new Sprint 2 event types
**File:** migrations/migration_001.sql:227 · migrations/migration_004.sql
**Criterion:** Audit trail integrity, schema correctness

The CHECK constraint on audit_log.event_type reads:
```sql
CHECK (event_type IN ('resolution', 'session_issued'))
```

conflicts.js inserts `event_type = 'conflict_confirmed'` (confirm handler, line 155) and `event_type = 'conflict_rejected'` (reject handler, line 232). PostgreSQL will reject both INSERTs with a constraint violation. Both the confirm and reject endpoints will throw a 500 at the audit step — inside the transaction — causing the entire transaction to roll back. Confirmed merges and rejections will silently fail.

The .claude/CLAUDE.md pseudocode notes state: "No schema change needed — event_type is TEXT not enum. New values work automatically." **This is incorrect.** A TEXT CHECK constraint is not the same as a TEXT column with no constraint. The CHECK is as strict as an ENUM for the values it lists.

**Required fix:**
migration_004.sql must include an ALTER TABLE statement to update the constraint before creating the conflict_queue table:
```sql
ALTER TABLE audit_log DROP CONSTRAINT audit_log_event_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_event_type_check
  CHECK (event_type IN ('resolution', 'session_issued', 'conflict_confirmed', 'conflict_rejected'));
```
Add this block near the top of migration_004.sql, after the safety guard, before the CREATE TABLE.

---

### GAP-02 — correlationIdMiddleware.js: crypto not imported
**File:** src/middleware/correlationIdMiddleware.js:14
**Criterion:** RECEIVE/GUARD/EXECUTE/RETURN pattern, correctness

`crypto.randomUUID()` is called on line 14 but `crypto` is never imported. Every other file that uses crypto has `const crypto = require('crypto')` at the top. correlationIdMiddleware.js has none.

On Node.js 19+ and 20+, `crypto` is exposed as a global and this works. On Node.js 18 (current Cloud Run default if not pinned), `crypto` is not a bare global — `require('crypto')` is required. Running on Node.js 18 will produce `ReferenceError: crypto is not defined` on every protected request, breaking all routes behind the middleware stack.

**Required fix:**
src/middleware/correlationIdMiddleware.js — add at line 3 (after `'use strict'`):
```javascript
const crypto = require('crypto');
```

---

### GAP-03 — resolverEngine.js: idempotency early return missing conflict_id
**File:** src/modules/resolverEngine.js:76-85
**Criterion:** API contract completeness, Sprint 2 specific gaps

When Guard 2 fires (duplicate request within 24 hours), resolverEngine returns the cached result from audit_log:
```javascript
return {
  fan_id:           e.fan_id,
  match_type:       e.match_type,
  confidence_score: e.confidence_score,
  is_new_record:    e.is_new_record,
  linked_systems:   [],
  linked_count:     0,
  audit_event_id:   e.id
  // conflict_id is absent
};
```

If the original call was Path C (match_type='soft') or Path D (match_type='conflict'), the route handlers in resolve.js and nfc.js check `result.match_type === 'soft'` and return `conflict_id: result.conflict_id`. Because `result.conflict_id` is `undefined`, JSON serialization silently drops the field. The retry response is missing `conflict_id` while the original response included it. Clients cannot retrieve the conflict record ID on retry.

**Required fix:**
resolverEngine.js:76-85 — the idempotency return does not have access to conflict_id from audit_log (it is not stored there). Two options:

Option A (minimal): Return `conflict_id: null` explicitly and document that callers must re-query GET /v1/conflicts by fan_id if conflict_id is needed on idempotent retry.
```javascript
return {
  fan_id:           e.fan_id,
  match_type:       e.match_type,
  confidence_score: e.confidence_score,
  is_new_record:    e.is_new_record,
  linked_systems:   [],
  linked_count:     0,
  audit_event_id:   e.id,
  conflict_id:      null   // not stored in audit_log — query GET /v1/conflicts if needed
};
```

Option B (complete): Add a `conflict_id` column to audit_log (new migration). Persist conflict_id in the audit INSERT for Path C and D (resolverEngine.js:249-257). Return it on idempotency replay.

Option A is the minimal fix for Sprint 2 close. Option B is the clean fix for Sprint 3.

---

## Minor Gaps (fix before midpoint presentation)

---

### GAP-04 — session.js: TASK-07 not implemented — token-without-audit-record is silent
**File:** src/routes/session.js:52-63
**Criterion:** Security findings (TASK-07 open)

signToken() executes at line 52 inside the outer TRY. The audit INSERT at line 54 runs after signToken but in the same TRY block with no separation. If the audit INSERT throws (DB under load, constraint violation), the CATCH at line 60 logs a generic `session endpoint failure` message and returns 500 — but the token has already been signed and returned to no-one (500 response goes to caller, not the token). The token exists in memory and is never returned, but the missing audit record means revocation via jti is impossible for a token that was never received.

The more serious version: if a race condition or timing issue causes the catch not to fire but the INSERT is silently dropped, the token exists in the wild with no audit record.

OWASP audit TASK-07 requires a structured log entry with `event: 'token_without_audit'`, fan_id, org_id, and jti on audit INSERT failure, with a Cloud Monitoring alert on this label.

**Required fix:**
session.js — replace the generic logger.error in the CATCH with a conditional that detects audit INSERT failure:
```javascript
} catch (err) {
  if (tokenResult && err.message.includes('audit')) {
    logger.error('token_without_audit', {
      event:   'token_without_audit',
      fan_id,  org_id,
      jti:     tokenResult.jti,
      error:   err.message,
      correlation_id: req.context.correlation_id
    });
  } else {
    logger.error('session endpoint failure', { fan_id, org_id, error: err.message, correlation_id: req.context.correlation_id });
  }
  return res.status(500).json({ error: 'session could not be issued' });
}
```
This is a minimal implementation. Full implementation requires splitting signToken and audit INSERT into separate try blocks so that audit INSERT failure is always distinguishable.

---

### GAP-05 — nfc.js: TASK-11 not implemented — DLQ write failure has no structured metric label
**File:** src/routes/nfc.js:72, 108
**Criterion:** Security findings (TASK-11 open)

DLQ write failures on normalization error (line 72) and resolver error (line 108) emit:
```javascript
logger.error('DLQ write failed after normalization error', { org_id, station_id, error: dlqErr.message, correlation_id: req.context.correlation_id })
```

A DLQ write failure means a failed event disappears from all records — it is not in the main path, not in audit_log, not in ingest_failures. Cloud Monitoring cannot alert on this because there is no structured event label for the alerting system to filter on.

**Required fix:**
Both DLQ catch blocks should add `event: 'dlq_write_failure'` to the log object:
```javascript
logger.error('DLQ write failed after normalization error', {
  event: 'dlq_write_failure',
  org_id, station_id, reason_code: 'normalization_error',
  error: dlqErr.message, correlation_id: req.context.correlation_id
})
```
Create a Cloud Monitoring log-based metric that counts log entries with `jsonPayload.event="dlq_write_failure"` and alert when count > 0 in any 5-minute window.

---

### GAP-06 — profile.js: TASK-20 not implemented — Firestore wallet fields not validated
**File:** src/routes/profile.js:56
**Criterion:** Security findings (TASK-20 open)

`firestoreDoc.data()` is returned as `walletData` without field type validation. The profile response at line 83 returns `walletData.loyalty_points`, `walletData.stamps`, and `walletData.avatar` directly. If Firestore security rules are misconfigured (a known open gap, blocked on GCP credentials), a direct Firestore write could inject unexpected types into these fields — an object into loyalty_points, a string into stamps — that surface in the fan profile response and potentially break client rendering.

**Required fix:**
profile.js:56 — after `walletData = firestoreDoc.data()`, add:
```javascript
if (typeof walletData.loyalty_points !== 'number' || !isFinite(walletData.loyalty_points) || walletData.loyalty_points < 0) walletData.loyalty_points = 0;
if (!Array.isArray(walletData.stamps))          walletData.stamps = [];
if (walletData.avatar !== null && typeof walletData.avatar !== 'string') walletData.avatar = null;
```

---

### GAP-07 — jwt.js: aud claim does not match TASK-12 specification
**File:** src/modules/jwt.js:48
**Criterion:** Security findings (TASK-12 partial)

OWASP TASK-12 specifies `aud: 'golden-record-webview'` at signing and `audience: 'golden-record-webview'` at verification. The current code uses `aud: 'golden-record'` at both sign (line 48) and verify (line 74). The values are consistent with each other so tokens are not broken, but they don't match the TASK-12 prescription and do not distinguish token audience from token issuer.

**Required fix:**
If TASK-12 intent was to separate issuer from audience, update jwt.js line 48:
```javascript
aud: 'golden-record-webview',
```
And jwt.js line 74:
```javascript
audience: 'golden-record-webview',
```
If the intent is to use a single identifier, document the decision in CLAUDE.md so the inconsistency with TASK-12 is recorded. Either resolution is acceptable — the gap is the undocumented deviation from the spec.

---

## Confirmed Clean

Components that passed all 10 evaluation criteria.

| Component | File | Notes |
|---|---|---|
| migration_001.sql | migrations/migration_001.sql | Safety guard, 5 tables, all indexes, seed moved to seed_dev.sql |
| migration_002.sql | migrations/migration_002.sql | jti unique index, idempotent safety guard |
| migration_004.sql | migrations/migration_004.sql | conflict_queue table, 3 indexes, safety guard — pending GAP-01 fix |
| normalizer.js | src/modules/normalizer.js | RECEIVE/GUARD/EXECUTE/RETURN, pure functions, all 5 types |
| jwt.js | src/modules/jwt.js | RS256 pinned, iss/aud added (TASK-12), org claim check (TASK-19), StartupError on missing keys |
| resolverEngine.js | src/modules/resolverEngine.js | Pattern 2, TASK-01/05 fixed, Paths A/B/C/D, conflict_queue inside tx, audit last in tx — pending GAP-03 fix |
| health.js | src/routes/health.js | Never throws, tiered response (TASK-03), tryOrgAuth separate from main flow |
| orgAuthMiddleware.js | src/middleware/orgAuthMiddleware.js | Pattern 1, sha256 hash, no raw key stored, generic 500 |
| jwtMiddleware.js | src/middleware/jwtMiddleware.js | Correct re-export, org claim check present in jwt.js |
| resolve.js | src/routes/resolve.js | TASK-01 fixed, all 4 match paths, requires_review and conflict_id in all responses |
| nfc.js | src/routes/nfc.js | TASK-01/04/15 fixed, Pattern 3, all 4 match paths, session_ready, DLQ org_id scoped |
| session.js | src/routes/session.js | TASK-16 fixed, body.org_id mismatch guard, deleted_at check, Pattern 1 |
| profile.js | src/routes/profile.js | Pattern 1, JWT claim vs URL guard, deleted_at check, Firestore graceful fallback |
| probabilisticMatcher.js | src/modules/probabilisticMatcher.js | Pure functions, 5 signals, MAX scoring (not additive), org_id mismatch guard |
| conflicts.js — GET | src/routes/conflicts.js:14-89 | org_id isolation, status/limit/offset guards, ordered by confidence DESC, count for pagination |
| conflicts.js — confirm | src/routes/conflicts.js:92-181 | 404/409 pre-check, all 4 writes in correct order, audit last, identifier_link moves ALL rows for fan_id_b |
| conflicts.js — reject | src/routes/conflicts.js:184-257 | 404/409 pre-check, no soft delete of fan_id_b, audit last in tx |
| index.js | index.js | Helmet added (TASK-18), correct middleware stack order, jwtMiddleware per-route on profile only |

---

## Open Security Tasks (deferred, not blocking Sprint 2 close)

These were in the Sprint 2 security backlog but are not required for Sprint 2 close.
Document them so they carry into Sprint 3.

| Task | Status | Blocker |
|---|---|---|
| TASK-06 — JWT revocation via jti blocklist | Deferred Sprint 3 | jti index in place (migration_002.sql) |
| TASK-07 — token_without_audit structured alert | GAP-04 above | Implement before midpoint |
| TASK-09 — org API key rotation endpoint | Deferred post-midpoint | Monique confirmed |
| TASK-10 — audit_log append-only DB trigger | Deferred Sprint 3 | migration_003.sql not yet run |
| TASK-11 — DLQ write failure metric | GAP-05 above | Implement before midpoint |
| TASK-13 — Cloud Run header redaction | Blocked GCP credentials | — |
| TASK-14 — station_id registration per org | Deferred Sprint 3 | Requires new DDL |
| TASK-20 — Firestore wallet field validation | GAP-06 above | Implement before midpoint |
| migration_003.sql | Blocked GCP credentials | Run before second org onboarded |

---

## Sprint 2 Close Checklist

- [ ] GAP-01 — ALTER TABLE fix in migration_004.sql (audit_log CHECK constraint)
- [ ] GAP-02 — Add `const crypto = require('crypto')` to correlationIdMiddleware.js
- [ ] GAP-03 — Add `conflict_id: null` to idempotency early return in resolverEngine.js
- [ ] GAP-04 — structured token_without_audit log in session.js (before midpoint)
- [ ] GAP-05 — `event: 'dlq_write_failure'` label in nfc.js both DLQ catch blocks (before midpoint)
- [ ] GAP-06 — Firestore wallet field validation in profile.js (before midpoint)
- [ ] GAP-07 — Resolve aud claim value vs TASK-12 spec or document the deviation
- [ ] Sprint 2 tests across components 13-20
- [ ] Security regression check on new endpoints
- [ ] tasks/handoff.md updated with sprint closed status

---
*Gap report generated: 2026-05-21*
*Reviewer: Claude Sonnet 4.6 — gap analysis session only, no code modified*
