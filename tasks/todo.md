# Pre-Presentation Fixes — tasks/todo.md
# Session: 2026-06-09
# Fixing 4 BUGs and 2 ROUGH findings from pre_presentation_audit.md

---

## Plan

### Files touched (5 total — tightly coupled bugfix set)
- src/routes/conflicts.js        — BUG-3
- src/routes/household.js        — BUG-1, BUG-2, BUG-4, ROUGH-1, ROUGH-3
- migrations/migration_010.sql   — ROUGH-3 (new file)
- tests/routes/conflicts.test.js — BUG-3 tests
- tests/routes/household.test.js — all household fix tests

### Step 1 — conflicts.js (BUG-3)
- Line 10: add 'unmerged' to ALLOWED_STATUSES
  ['pending', 'confirmed', 'rejected'] → ['pending', 'confirmed', 'rejected', 'unmerged']
- Line 24: update guard message to include 'unmerged'

### Step 2 — household.js (BUG-4 — Firestore import)
- Add `const { Firestore } = require('@google-cloud/firestore');` at top
- Add module-level firestore instance after logger block:
    const firestore = new Firestore({
      projectId:  process.env.FIRESTORE_PROJECT_ID,
      databaseId: 'golden-record',
    });
- Replace `if (req.firestore) { await req.firestore.collection('fans')...` block
  with unconditional try/catch using `firestore.collection('golden-record')`

### Step 3 — household.js (BUG-1 — NaN guards)
- GET /v1/household/:adult_fan_id, lines 115-120
- Add `isNaN(limit) || limit < 1` guard before the `limit > 10` guard
- Add `isNaN(offset) ||` prefix to the `offset < 0` guard
- Pattern copied from conflicts.js lines 27-44

### Step 4 — household.js (BUG-2 — ON CONFLICT WHERE clause)
- 4 ON CONFLICT clauses in PUT handler — all missing WHERE clause
- Change all 4 from:
    ON CONFLICT (fan_id, identifier_type, org_id)
    DO UPDATE SET ...
  To:
    ON CONFLICT (fan_id, identifier_type, org_id)
    WHERE source_system = 'fan_pass'
    DO UPDATE SET ...

### Step 5 — household.js (ROUGH-1 — consistent forbidden 403 shape)
- GET household (line 113) and GET member (line 418): already have message — correct
- These 5 handlers return `{ error: 'forbidden' }` without message — add it:
  - POST members (line 222)
  - PUT member (line 527)
  - DELETE member (lines 732-733)
  - POST session (lines 834-835)
  - POST age-up (lines 914-915)
- Add: message: 'token does not match requested household'

### Step 6 — household.js (ROUGH-3 — child session audit)
- Component 33 POST .../session
- Inside the TRY block, after signToken call:
    await req.db.query(
      `INSERT INTO audit_log (id, fan_id, org_id, event_type, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'child_session_issued', 'success', NOW())`,
      [child_fan_id, org_id]
    );
- Remove "no db writes, no audit event" from comment on line 871

### Step 7 — migration_010.sql (ROUGH-3 — add child_session_issued to event_type CHECK)
- New file, same structure as migration_009
- Safety guard: abort if constraint already includes child_session_issued
- Drop audit_log_event_type_check
- Add new constraint with 13 values (12 from migration_007 + child_session_issued)
- Verification query + test DO block

### Step 8 — conflicts.test.js (BUG-3 tests)
- Test A: GET /v1/conflicts?status=unmerged returns 200
- Test B: GET /v1/conflicts with invalid status still returns 400

### Step 9 — household.test.js (all fixes verified)
- Add jest.mock('@google-cloud/firestore', ...) at top (same as resolverEngine.test.js)
- Update setupSuccessfulSession() to add 4th mock for audit INSERT
- BUG-1: limit=abc → 400, offset=abc → 400, valid values → 200
- BUG-2: all four ON CONFLICT WHERE source_system present; PUT success path works
- BUG-4: firestore client uses databaseId golden-record; collection golden-record used;
         req.firestore not referenced anywhere in household.js source
- ROUGH-1: all 4xx responses have error field; no message without error
- ROUGH-3: POST session writes audit_log INSERT with child_session_issued and minor_fan_id

---

## Checklist

- [ ] BUG-3  — conflicts.js ALLOWED_STATUSES fix
- [ ] BUG-4  — household.js Firestore import + collection fix
- [ ] BUG-1  — household.js NaN guards on limit/offset
- [ ] BUG-2  — household.js ON CONFLICT WHERE clause (4 places)
- [ ] ROUGH-1 — household.js consistent forbidden 403 message field
- [ ] ROUGH-3 — household.js child session audit INSERT
- [ ] migration_010.sql — child_session_issued constraint
- [ ] conflicts.test.js — BUG-3 tests
- [ ] household.test.js — jest.mock + all 15 verification tests
- [ ] npm test — full suite green
- [ ] tasks/lessons.md update (BUG-2 and BUG-4 lessons confirmed)
- [ ] tasks/handoff.md update (5 lines max)

---

## Architectural notes

BUG-4: Firestore initialized directly in household.js at module level —
same pattern as resolverEngine.js. Shared firestore.js module is Sprint 4 cleanup.

ROUGH-3: Single audit INSERT, no transaction needed. Appended inside existing
TRY block (Pattern 1 — TRY wraps EXECUTE). Outside transaction window since
child session has no BEGIN/COMMIT.

BUG-1: Adding both isNaN+min guard AND existing max guard to match conflicts.js
exactly. No minimum was checked before — NaN passed straight to Postgres LIMIT.
