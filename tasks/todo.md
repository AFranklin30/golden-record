# CORS test drift cleanup + X-Correlation-Id report
# Session: 2026-08-02 (continuation — prior session shipped the CORS fix itself)

DEFENSIVE / CLEANUP. Two loose ends flagged (not fixed) by the prior session's
todo.md: cors.test.js's own hardcoded allowedHeaders mirror, and the
X-Correlation-Id inbound-read question. Neither changes runtime behavior for
a correctly-configured client.

## Verification done before writing this plan

- [x] Read `tests/routes/cors.test.js`. It does **not** import `index.js` at
      all — `buildCorsApp()` constructs its own throwaway Express app with a
      hand-copied `corsOptions` object (lines 12–22), including a hardcoded
      `allowedHeaders` array at line 20:
      `['Content-Type', 'X-Api-Key', 'X-Fan-Token', 'X-Correlation-Id']`.
      This is now **stale** — the real array in `index.js:47` (post prior-session
      fix) is `['Content-Type', 'Authorization', 'X-Fan-Token', 'X-Correlation-Id']`.
      None of this file's 5 tests assert on `access-control-allow-headers` or
      the array's contents at all — it's used only to build the `cors()`
      instance for the `origin`-behavior tests. So today it silently tests the
      **wrong array** without any assertion ever exercising the wrongness —
      exactly the "silently pass while testing the wrong array" shape flagged.
- [x] Read `tests/cors.preflight.test.js` — does not hardcode a header array
      anywhere. It requires the real `index.js` app directly and drives real
      OPTIONS preflights, so it already reflects the true source. **Nothing to
      change here for item 1.**
- [x] Read `index.js` — `allowedHeaders` is inline in `corsOptions` (line 47),
      not currently a named export. `module.exports = app` (line 122) — a
      function, not an object literal — so the array can only be reached by
      requiring `index.js` and reading a property attached to that function
      (e.g. `app.ALLOWED_HEADERS = ...`), the same way `cors.preflight.test.js`
      already does `const app = require('../index')`.
- [x] Confirmed `index.js` calls `app.listen(PORT)` unconditionally at module
      load (line 111) — no `require.main === module` guard. Requiring it
      **always** binds a real port and requires `DATABASE_URL` +
      `FIRESTORE_PROJECT_ID` env vars (checked at the top of the file) plus
      whatever `jwtMiddleware`'s init needs. `tests/cors.preflight.test.js`
      and `tests/startup/startup.test.js` both already pay this cost via an
      identical ad-hoc pattern (force `PORT=0`, intercept
      `http.Server.prototype.listen` to capture the server, close it in
      `afterAll`) — copy-pasted twice already, not currently a shared helper.
- [x] Read `src/middleware/correlationIdMiddleware.js` in full (26 lines) —
      see Item 2 report below.
- [x] Baseline `npx jest`: **11 failed / 491 passed / 502 total** — matches
      the number quoted in the prompt exactly. The 11 failures are 2
      pre-existing suites (`resolverEngine.test.js`, `household.test.js`),
      unrelated to CORS.
- [x] Confirmed both CORS test files currently pass in isolation (11/11) and
      the DB/Firestore/JWT env needed to require `index.js` is already present
      locally (`.env`) — so requiring it from a third test file is not blocked,
      just heavier than what `cors.test.js` does today.

## Decision — Aaron's correction (superseded the plan below)

Aaron rejected importing `index.js` into `cors.test.js` — the DB/JWT/listener
cost is real for a fixture nothing asserts against. Revised approach:
1. Extract `ALLOWED_HEADERS` in `index.js`, export it via `app.ALLOWED_HEADERS`.
2. `cors.test.js`: delete the dead mirror array entirely (confirmed nothing in
   the file asserts on header contents) + a comment pointing at
   `cors.preflight.test.js` for real coverage. No import of `index.js`.
3. `cors.preflight.test.js` confirmed to have never hardcoded an array — no
   change needed there beyond a new regression test for the X-Correlation-Id
   removal (item 2, Option A, also approved this round).
See lessons.md entry 23.

## Plan

1. [x] `index.js`: extracted `ALLOWED_HEADERS` as a named const, removed
       `'X-Correlation-Id'` (Option A approved), exported via
       `app.ALLOWED_HEADERS`.
2. [x] `tests/routes/cors.test.js`: deleted the hardcoded `allowedHeaders`
       array, left a comment explaining why (origin-only coverage; header
       coverage lives in `cors.preflight.test.js`).
3. [x] `tests/cors.preflight.test.js`: added test 8, mirroring test 7's
       pattern, proving `X-Correlation-Id` is no longer allowed.
4. [x] Grep check: no hardcoded header array or literal header-name strings
       remain in `cors.test.js`.
5. [x] RED-GREEN proof: added a junk header to `ALLOWED_HEADERS` → both CORS
       suites still passed (12/12, proves they read the real value, not a
       frozen copy). Removed `'Authorization'` → `cors.preflight.test.js`
       test 1 failed exactly as expected (`content-type,x-fan-token`
       returned, no `authorization`). Restored the array to
       `['Content-Type', 'Authorization', 'X-Fan-Token']`.
6. [x] Full `npx jest`: **11 failed / 492 passed / 503 total** vs. baseline
       11/491/502 — exactly +1 (the new test 8), same two pre-existing
       failing suites (`resolverEngine.test.js`, `household.test.js`), 0
       regressions.
7. [x] Item 2 (X-Correlation-Id): Aaron chose Option A, implemented as part
       of step 1 above.
8. [x] `docs/API_CONTRACT.md`: updated the CORS `allowedHeaders` bullet per
       Aaron's flag — see check-in note below re: scope of that edit.
9. [ ] `tasks/lessons.md` / `tasks/handoff.md` updated this session.

## Item 2 — X-Correlation-Id report (informational, not a plan step)

`correlationIdMiddleware.js` (26 lines, full file read):
- Generates `crypto.randomUUID()` — never reads `req.headers['x-correlation-id']`
  or any inbound header.
- Sets `req.context.correlation_id` and `res.setHeader('X-Correlation-Id', ...)`
  only.
- **No inbound read anywhere in the file.** Confirms the prompt's premise:
  `X-Correlation-Id` is permitted in `allowedHeaders` but unread — the same
  shape `X-Api-Key` was before the prior session's fix removed it.

Options (per prompt, presented not decided):
- **A** — remove `X-Correlation-Id` from `allowedHeaders`. Consistent with the
  `X-Api-Key` removal precedent.
- **B** — wire the middleware to accept an inbound value (fallback to
  generated UUID). Genuinely useful for cross-system tracing, but a behavior
  change to a "this is law" middleware — needs its own prompt, not folded in
  here.
- **C** — keep as-is, documented as intentional forward-compatibility.

No change made to `correlationIdMiddleware.js` in this task. Aaron chose
**Option A** on the follow-up turn — `X-Correlation-Id` removed from
`ALLOWED_HEADERS` in `index.js` (step 1 above). This supersedes the original
"do not remove" boundary below, which was written before that decision.

## Check-in note — API_CONTRACT.md edit went slightly beyond the literal ask

Aaron asked for "a line change" for the `X-Correlation-Id` entry. The
`allowedHeaders` bullet's surrounding prose (`'flagged not fixed'`,
`'This is now tracked as an open bug ... for a follow-up fix'`) was already
stale **before this session** — it still described the pre-existing
`X-Api-Key`/`Authorization` bug as open, even though the prior session (same
day, per `tasks/todo.md` history) had already shipped that fix. A
single-line edit would have left the array correct but the surrounding
narrative internally contradictory (fixed array, "not fixed" prose). I
rewrote the whole bullet to be accurate rather than leave that
inconsistency — flagging it here since it's a larger edit than what was
explicitly asked for. Not touched: any other bullet, any other doc.

## DO NOT (restating scope boundaries from the prompt, as amended above)

- Do not change the contents of the `allowedHeaders` array beyond the
  approved `X-Correlation-Id` removal.
- Do not modify `correlationIdMiddleware.js`.
- Do not change the CORS origin function, methods, helmet, rate limiters, or
  router mount order.
- Do not create a new config module/file for the header list.
- Do not fix the 11 pre-existing failures.
- Do not touch `CLAUDE.md` or `.claude/CLAUDE.md`.
