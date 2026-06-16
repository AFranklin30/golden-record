# Quick-Win Refactors — tasks/todo.md
# Session: 2026-06-16
# 4 cleanups — shared UUID, shared logger, dotenv, dead code

---

## What This Session Does

Four low-risk, zero-behavior-change cleanups (except Refactor 4 which is an
intentional bug fix — removing genuinely dead code that silently supported
DD/MM/YYYY dates on a US-only platform).

---

## Files Created (new)
- [ ] src/lib/validate.js   — UUID_RE + isValidUuid
- [ ] src/lib/logger.js     — shared arrow-function logger

---

## Refactor 1 — Shared UUID validation

Both conflicts.js and household.js define identical UUID_RE locally.
Create one shared source, import in both.

- [ ] Create src/lib/validate.js
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        function isValidUuid(value) { return UUID_RE.test(value); }
        module.exports = { UUID_RE, isValidUuid };
- [ ] conflicts.js — remove local UUID_RE (line 9), add import { UUID_RE }
- [ ] household.js — remove local UUID_RE (line 22), add import { UUID_RE }

No call-site changes — keeping UUID_RE.test(...) pattern unchanged in both files.

---

## Refactor 2 — Shared logger

13 files define their own logger. Each varies (some have only error,
some error+warn, one has error+warn+info). Consolidate into one module.

Shared logger uses arrow functions (Lesson 7 — required for jest.spyOn).

Files to update — one import line in, one definition line out:
- [ ] src/lib/logger.js — CREATE
        const logger = {
          error: (...args) => console.error(...args),
          warn:  (...args) => console.warn(...args),
          info:  (...args) => console.log(...args),
        };
        module.exports = logger;
- [ ] src/middleware/rlsContextMiddleware.js   — import ../lib/logger
- [ ] src/middleware/correlationIdMiddleware.js — import ../lib/logger
- [ ] src/middleware/orgAuthMiddleware.js       — import ../lib/logger
- [ ] src/modules/resolverEngine.js            — import ../lib/logger
- [ ] src/modules/jwt.js                       — import ../lib/logger
- [ ] src/routes/session.js                    — import ../lib/logger
- [ ] src/routes/profile.js                    — import ../lib/logger
- [ ] src/routes/health.js                     — import ../lib/logger
- [ ] src/routes/nfc.js                        — import ../lib/logger
- [ ] src/routes/resolve.js                    — import ../lib/logger
- [ ] src/routes/conflicts.js                  — import ../lib/logger
- [ ] src/routes/household.js                  — import ../lib/logger
- [ ] src/routes/admin/household.js            — import ../../lib/logger

No logging behavior change — same console methods, same output.

---

## Refactor 3 — Remove dotenv from resolverEngine.js

resolverEngine.js line 7: require('dotenv').config() — remove it.
index.js (root, line 3) already calls require('dotenv').config() before any
module loads. Calling it again inside a module is harmless but misleading.

- [ ] resolverEngine.js — delete line 7: require('dotenv').config();

---

## Refactor 4 — Remove dead DD/MM/YYYY branch in normalizer.js

normalizer.js has three date-parsing attempts for slash-format inputs:
  1. MM/DD/YYYY — runs first
  2. DD/MM/YYYY — runs only if MM/DD/YYYY fails (month field > 12)
     This branch is reachable (e.g. 31/03/2000) but is wrong for a US-only
     platform. It silently accepts non-US formats.

The fix: remove the DD/MM/YYYY block (lines 83-89). Inputs like 31/03/2000
now correctly fail with dob format invalid.

One test must be updated (normalizer.test.js line 46-49):
  Before: expects '31/03/2000' to return '2000-03-31'
  After:  expects '31/03/2000' to throw NormalizationError('dob format invalid')

- [ ] normalizer.js    — delete lines 83-89 (DD/MM/YYYY block)
- [ ] normalizer.test.js — update test at line 46 to expect throw instead of return

---

## Verification

- [ ] npm test — all tests pass, count is 361 or 362 if test is updated not deleted
- [ ] grep -rn "const UUID_RE" src/ — zero results
- [ ] grep -rn "const logger" src/ — zero results
- [ ] grep -n "dotenv" src/modules/resolverEngine.js — zero results
- [ ] normalizer.js — no DD/MM/YYYY comment or block exists

---

## Lessons / Docs Update

- [ ] tasks/lessons.md — append Refactors 17-20 with before/after/why
- [ ] tasks/handoff.md — 5-line session summary

---

## Review

Will fill in after tests pass.
