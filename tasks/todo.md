# Operational Readiness Fixes — 38C Audit
# Session: 2026-06-02

---

## Goal

Apply four operational readiness fixes found in 38C audit.
Two files only: index.js and src/db/pool.js.
Configuration changes only — no logic changes.

---

## Changes Made

### pool.js

- [x] FIX 2: max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 2000
- [x] FIX 3: pool.on('connect') sets statement_timeout = 10000

### index.js

- [x] FIX 4: REQUIRED_ENV validation — DATABASE_URL and FIRESTORE_PROJECT_ID
- [x] BUG:   Moved app.set('trust proxy', 1) to after const app = express()
- [x] FIX 1: Imported pool; captured server from app.listen(); added SIGTERM handler

### Tests

- [x] tests/startup/startup.test.js — 7 tests, all pass
  1. pool.options.max === 5
  2. pool.options.idleTimeoutMillis === 30000
  3. pool.options.connectionTimeoutMillis === 2000
  4. pool.listenerCount('connect') > 0
  5. throws on missing DATABASE_URL
  6. throws on missing FIRESTORE_PROJECT_ID
  7. process.listenerCount('SIGTERM') increases after index.js loads

- [x] Full suite: 343 tests, 11 suites, 0 failures

---

## Review

All four 38C FAIL/RISK items addressed.
Pre-existing ReferenceError bug in index.js also fixed.
Ready to rebuild container and redeploy.
