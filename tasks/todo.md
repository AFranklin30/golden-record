# Firestore Sync Debug — resolverEngine.js
# Session: 2026-06-09

---

## Diagnosis

Root cause: Firestore client initialized with `projectId` only — no `databaseId`.

```javascript
// current (line 12, resolverEngine.js)
const firestore = new Firestore({ projectId: process.env.FIRESTORE_PROJECT_ID });
```

Firestore now supports multiple named databases per project. When `databaseId` is
omitted, the SDK connects to `(default)`. If the `golden-record` collection was
created in a named database (not `(default)`), the `set()` call writes to `(default)`
silently — no exception, no log entry. The document appears in the wrong database.

This explains both symptoms:
- No error in Cloud Run logs (write did not fail — it wrote to the wrong place)
- No document in the expected `golden-record` collection (staff is looking at the
  named database, documents landed in `(default)`)

Same issue in profile.js line 9 — reads from `(default)`, returns empty wallet.

---

## Fix

Two changes, two files only.

### 1 — resolverEngine.js (line 12)
Add `databaseId` to Firestore init. Support via `FIRESTORE_DATABASE_ID` env var,
defaulting to `'(default)'` if not set.

```javascript
const firestore = new Firestore({
  projectId:  process.env.FIRESTORE_PROJECT_ID,
  databaseId: process.env.FIRESTORE_DATABASE_ID || '(default)',
});
```

Add temporary debug logging (logger.error level — guaranteed to appear in Cloud Run
logs) immediately before and after the `set()` call to surface any future silent
failure:

```javascript
logger.error('[debug] Firestore sync start', { fan_id, db: process.env.FIRESTORE_DATABASE_ID || '(default)' });
await firestore.collection('golden-record').doc(fan_id).set({...});
logger.error('[debug] Firestore sync complete', { fan_id });
```

Remove the [debug] lines before final deploy (flagged in Warnings below).

### 2 — profile.js (line 9)
Same `databaseId` fix — reads must hit the same database as writes.

```javascript
const firestore = new Firestore({
  projectId:  process.env.FIRESTORE_PROJECT_ID,
  databaseId: process.env.FIRESTORE_DATABASE_ID || '(default)',
});
```

---

## Questions for Aaron Before Build

1. Is `FIRESTORE_DATABASE_ID` set in Cloud Run environment variables, or should
   we hardcode `'(default)'` if the database is actually the default?

2. The `golden-record` collection name — should it match the database name, or is
   it the collection name inside whatever database the client connects to?

---

## Steps

- [x] 1. Write this plan → tasks/todo.md (done)
- [x] 2. Check in with Aaron — confirmed: databaseId = 'golden-record', collection = 'golden-record'
- [x] 3. Fix resolverEngine.js — databaseId + debug logging
- [x] 4. Fix profile.js — databaseId only (no Firestore writes here)
- [x] 5. Update tasks/lessons.md
- [x] 6. Update tasks/handoff.md

## Result

343/343 tests pass. Fix verified locally.
Temporary [debug] log lines in resolverEngine.js — remove before final deploy.
