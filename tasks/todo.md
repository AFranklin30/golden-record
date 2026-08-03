# Three independent LIVE fixes — scorer_version backfill, conflict_queue
# index, canonical-ID forwarding
# Session: 2026-08-02

## Context confirmed before planning (read, not assumed)

- `scripts/seedDemoOrg.js` — `seedEvaluationCorpus()` (lines 514-535) inserts
  8 synthetic rows via a column list that omits `scorer_version`. Confirmed:
  `probabilisticMatcher.js` exports `SCORER_VERSION` (line 378 module.exports).
- `tests/seedDemoOrg.test.js` line 266-272 — the pending comment confirming
  this exact gap and naming the queued follow-up (this prompt).
- `migrations/migration_014.sql` — header format, safety-guard `DO $$ ... RAISE
  EXCEPTION` pattern (checks `information_schema.tables`), verification-query
  block. `evaluation_corpus` has no append-only trigger (confirmed — only
  `resolution_trace` and `trace_label`'s sibling get one; `evaluation_corpus`
  explicitly documented as updatable). `conflict_queue` columns confirmed via
  `conflicts.js`: `org_id, status, confidence_score`.
- `src/routes/profile.js` — full file read. Actual guard shape:
  - `deleted_at` check is `if (fan.deleted_at) { return res.status(403).json({
    error: 'fan record has been erased' }); }` — note the real message is
    **'fan record has been erased'**, not the prompt's shorthand `'erased'`.
    Keeping the real message for the genuine-erasure branch.
  - Query uses `jwt_fan_id` (already proven `=== url_fan_id` by the guard
    above it) and `org_id` from `req.context`.
  - `jwtMiddleware` is embedded directly in the route (`router.get(path,
    jwtMiddleware, handler)`) — this is the only route file that does this
    (checked all of `src/routes/*.js`).
- `migrations/migration_005.sql` — `merge_history` columns confirmed:
  `fan_id_source` (loser), `fan_id_target` (survivor), `org_id`,
  `conflict_id`, `status` ('active'/'reversed'). Multi-hop block guarantees
  at most one active row per source fan.
- Test conventions confirmed from `tests/routes/conflicts.test.js` and
  `tests/routes/household.test.js`: route tests in `tests/routes/` mount only
  the router under test behind a hand-built middleware stub that injects
  `req.context`/`req.db` (mockDb, `jest.fn()`), not the real
  orgAuth/rls/correlationId chain. `household.test.js` additionally
  `jest.mock('@google-cloud/firestore', ...)` since `household.js` and
  `profile.js` both instantiate a Firestore client at module load.
  `profile.js` is the only route with `jwtMiddleware` inline in the route
  itself (not applied via an outer `router.use()` the test can skip by simply
  not mounting it) — so `tests/routes/profile.test.js` (new file) must use the
  **real** `jwtMiddleware` + real `signToken` (from `src/modules/jwt.js`) to
  produce a valid `X-Fan-Token`, per the root CLAUDE.md rule that
  middleware-level guards go through the real Express app via supertest, not
  a bypass. `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` are already required local env
  vars (other route tests rely on them the same way).
- `eval/runCorpus.js` — `computeVersionDrift` confirmed: `scorer_version_drift`
  is `'unknown'` when `corpusRow.scorer_version == null`, else a boolean
  compare against the live `SCORER_VERSION` constant. `counts.scorer_version_unknown`
  and `counts.scorer_version_drift` both counted independently per row —
  exactly what Fix 1's tests 3 and 4 need.

## Fix 1 — stamp scorer_version on synthetic corpus rows

**File:** `scripts/seedDemoOrg.js`
**Test:** `tests/seedDemoOrg.test.js`

1. Import `SCORER_VERSION` from `../src/modules/probabilisticMatcher` at the
   top of `seedDemoOrg.js`.
2. Add `scorer_version` to `seedEvaluationCorpus`'s INSERT column list and
   bind list, value = `SCORER_VERSION`.
3. Add a guarded backfill UPDATE in `main()`, run once after
   `seedEvaluationCorpus` (or before — order doesn't matter since it's scoped
   to `source = 'synthetic'` and only fills NULLs):
   ```sql
   UPDATE evaluation_corpus SET scorer_version = $1
    WHERE org_id = $2 AND source = 'synthetic' AND scorer_version IS NULL
   ```
   params `[SCORER_VERSION, DEMO_ORG_ID]`. This is what repairs the 8
   already-seeded rows without a DB reset. Scoped to `source = 'synthetic'`
   so the promoted row (whose `scorer_version` came from its trace and
   records what actually produced that resolution) is never touched.
4. Do NOT add `normalization_version` anywhere — column doesn't exist on
   `evaluation_corpus`.
5. Uncomment the pending assertion block in `tests/seedDemoOrg.test.js`
   (lines 266-272 today) once the backfill has run — replace with a real
   assertion: every synthetic row's `scorer_version === SCORER_VERSION`.

**New tests to add to `tests/seedDemoOrg.test.js`:**
- Every synthetic corpus row for `DEMO_ORG_ID` has `scorer_version ===
  SCORER_VERSION` (replaces the commented-out block).
- Capture the promoted row's `scorer_version` before running
  `node scripts/seedDemoOrg.js` again is not possible (one-shot guard exits
  early) — instead: capture it once at test start, assert it is non-null and
  record its value; the regression proof is structural (query scoped to
  `source = 'synthetic'` only touches synthetic rows) plus an assertion that
  the promoted row's current `scorer_version` differs from `SCORER_VERSION`
  in general is not guaranteed, so the actual regression check is: run the
  backfill UPDATE a second time in-test (idempotent — `WHERE ... IS NULL`
  means a second run is a no-op) and assert the promoted row's
  `scorer_version` is byte-identical before/after.
- `eval/runCorpus.js`'s `buildRun(client, DEMO_ORG_ID)` →
  `counts.scorer_version_unknown === 0`.
- Disposable temp org (fresh UUID, not `DEMO_ORG_ID`): seed a synthetic-shaped
  corpus row with `scorer_version = 'v1+deadbeef'`, run `buildRun`, assert
  that row reports `scorer_version_drift === true`. Proves the drift check is
  live, not vacuously true. Clean up the temp org's `evaluation_corpus` row in
  `finally` (no append-only trigger there); leave the temp org row itself
  stranded per the file's existing documented pattern if it acquires any
  `resolution_trace` reference — this test won't create one, so the org row
  itself CAN be deleted in FK order (org has no other children created here).

## Fix 2 — conflict_queue index

**New file:** `migrations/migration_015.sql`
**New test:** `tests/migration_015.test.js`

Mirrors `migration_014.sql`'s structure:
1. Header block (same author/version/date format).
2. Safety guard — check `pg_indexes` for `idx_conflict_queue_org_status_score`
   by name, `RAISE EXCEPTION` if present (matches the prompt's instruction —
   `pg_indexes`, not `information_schema.tables`, since this migration adds an
   index to an existing table, not a new table).
3. `CREATE INDEX idx_conflict_queue_org_status_score ON conflict_queue
   (org_id, status, confidence_score DESC);` — standard, not CONCURRENTLY.
4. Verification query block at the bottom (matches migration_014's pattern):
   query `pg_indexes` for the new index name, assert `indexdef` contains
   `'confidence_score DESC'`.

**Test file** (new, modeled on `tests/migration_014.test.js`'s connection
pattern — local Postgres only):
1. Query `pg_indexes` for `idx_conflict_queue_org_status_score`; assert
   `indexdef` contains `'confidence_score DESC'`.
2. Run `psql $DATABASE_URL -f migrations/migration_015.sql` a second time
   (via `execFileSync`), assert it throws / stderr matches the "already
   applied" exception message — not a raw duplicate-index Postgres error.

## Fix 3 — canonical ID forwarding

**File:** `src/routes/profile.js`
**New test file:** `tests/routes/profile.test.js`

Insert the merge_history lookup inside the existing `if (fan.deleted_at)`
branch, before its current unconditional 403:

```javascript
if (fan.deleted_at) {
  // Multi-hop merges are blocked (conflicts.js), so at most one active
  // merge_history row can exist per source fan — this lookup is
  // unambiguous. If chain-history ever ships, this becomes a walk instead
  // of a single lookup.
  const survivorResult = await req.db.query(
    `SELECT fan_id_target FROM merge_history
     WHERE fan_id_source = $1 AND org_id = $2 AND status = 'active'`,
    [jwt_fan_id, org_id]
  );
  if (survivorResult.rows.length > 0) {
    return res.status(200).json({
      fan_id:      survivorResult.rows[0].fan_id_target,
      merged_from: jwt_fan_id,
      message:     'fan record was merged'
    });
  }
  return res.status(403).json({ error: 'fan record has been erased' });
}
```

Org-scoped (`org_id` in the WHERE), and the genuine-erasure branch keeps the
file's real existing message verbatim.

**STATUS CODE — DECIDED: 200 with `merged_from` field (Aaron's answer,
2026-08-02).** Simplest for a client — same response shape as success, plus a
`merged_from` field. No Location header, no redirect semantics implied.

**New test file `tests/routes/profile.test.js`** (mirrors
`tests/routes/conflicts.test.js` / `household.test.js`: mount only
`profile.js`'s router behind a stub middleware injecting `req.context` (org_id,
correlation_id) + `req.db` = mockDb; `jest.mock('@google-cloud/firestore')`;
use real `jwtMiddleware`/`signToken` for the `X-Fan-Token` header since
`jwtMiddleware` is embedded in this route):

1. Merged-away fan (`deleted_at` set, `merge_history` mock returns an active
   row) → response is 200, body has `fan_id` = survivor, `merged_from` =
   requested fan_id.
2. Soft-deleted fan, `merge_history` mock returns 0 rows → still 403 with
   `error: 'fan record has been erased'` (regression — forwarding must not
   swallow genuine erasure).
3. Assert the `merge_history` query's bound params are `[fan_id, org_id]` —
   proves org-scoping (a differently-orged row can never surface since the
   query itself filters on the authenticated org_id).
4. JWT mismatch (`X-Fan-Token` signed for a different fan_id than the URL) →
   403 before any `mockDb.query` call (`expect(mockDb.query).not.toHaveBeenCalled()`).

## Regression (all three fixes)

- Full `npx jest`. Baseline: 11 failed / 476 passed / 487 total. Report new
  numbers; any change to the pre-existing 11 is a regression — say so
  plainly, don't absorb it.
- `git status` — confirm only the listed files changed (plus this todo.md).

## Cleanup

Standard FK order in `finally` blocks for anything tests create. Temp orgs
that acquire a `resolution_trace` row are left permanently stranded (expected,
per existing convention) — do not attempt to delete traces, don't let a failed
trace DELETE abort the rest of cleanup. Never touch `DEMO_ORG_ID` or its rows,
including the promoted corpus row.

## Do-not list (restated from prompt)

- Do NOT run `resetLocalDb.sh` or re-run the full seed.
- Do NOT backfill `scorer_version` on promoted rows — scope to
  `source='synthetic'`.
- Do NOT add `normalization_version` to `evaluation_corpus`.
- Do NOT pick the Fix 3 status code without checking in first.
- Do NOT change the `deleted_at` guard anywhere except `profile.js`.
- Do NOT use `CREATE INDEX CONCURRENTLY`.
- Do NOT touch scoring, thresholds, `SIGNAL_CONFIG`, or the eligibility gate.
- Do NOT fix the 11 pre-existing failures.
- Do NOT touch `.claude/CLAUDE.md`.

## Open question — RESOLVED

Status code for the canonical-ID forward response: **200 with `merged_from`
field.** Decided by Aaron 2026-08-02.

## Review — completed 2026-08-02

- [x] Fix 1: `SCORER_VERSION` imported and stamped on every synthetic-corpus
      INSERT in `scripts/seedDemoOrg.js`; guarded backfill added inside the
      one-shot-guard's "already seeded" branch (runs even when full seeding
      is skipped — that branch is the only path that ever repairs an
      already-seeded demo org without a DB reset). Ran
      `node scripts/seedDemoOrg.js` once — backfilled 8 rows. Pending
      assertion in `tests/seedDemoOrg.test.js` replaced with a real
      `scorer_version === SCORER_VERSION` check; 3 new tests added (promoted
      row unchanged by backfill, `buildRun` reports 0 unknown, disposable
      temp-org row proves drift detection is live). 14/14 passing.
- [x] Fix 2: `migrations/migration_015.sql` created (mirrors migration_014's
      header/guard/verification format). Guard uses `pg_indexes` (not
      `information_schema.tables`, since this adds an index to an existing
      table). Applied to local DB via `psql`. Confirmed a second run's
      combined stdout+stderr contains the guard's own exception message
      (psql doesn't set a nonzero exit code without `ON_ERROR_STOP`, so the
      new test asserts on captured output, not exit code).
      `tests/migration_015.test.js` — 2/2 passing.
- [x] Fix 3: `src/routes/profile.js` — merge_history lookup inserted inside
      the existing `deleted_at` guard, org-scoped
      (`WHERE fan_id_source = $1 AND org_id = $2 AND status = 'active'`).
      Genuine-erasure branch keeps the file's real original message verbatim
      (`'fan record has been erased'` — not the prompt's `'erased'`
      shorthand). Status code decided by Aaron at check-in: 200 with
      `merged_from` field. **Revised after Aaron's follow-up:** the forward
      response now returns the survivor's FULL profile (identifier_link +
      Firestore wallet, same shape as the normal success path), not just a
      bare `{fan_id, merged_from, message}` pointer — a client asking for a
      profile shouldn't need a second call. Extracted `buildProfilePayload()`
      (fan row → links + wallet + response shape) so the primary and
      survivor-forwarding paths share it instead of duplicating ~40 lines.
      Added a defensive fallback (403 erased) for the practically-unreachable
      case where the survivor itself is also deleted — the multi-hop block
      makes this not currently possible, but a broken partial response would
      be worse than a clear 403 if it ever were. New
      `tests/routes/profile.test.js` — this is the only route with
      `jwtMiddleware` embedded directly in the route (not an outer
      `router.use()`), so the test uses the real `jwtMiddleware` + `signToken`
      for `X-Fan-Token` rather than bypassing auth, per the root CLAUDE.md
      rule for middleware-level guards. 4/4 passing (forward returns full
      survivor profile + merged_from, regression 403 on genuine erasure,
      org-scoping of both the merge_history AND the survivor's
      identifier_link query, JWT mismatch still 403s before any db call).
- [x] Full `npx jest`: **11 failed / 485 passed / 496 total** (baseline
      11/476/487 — +9 new passing tests, 0 regressions). Same 2 pre-existing
      failing suites (`resolverEngine.test.js`, `household.test.js`) —
      confirmed via `grep '^FAIL'`, no new suite failures.
- [x] `git status` confirms only the fixes' files changed: `scripts/seedDemoOrg.js`,
      `src/routes/profile.js`, `tests/seedDemoOrg.test.js`,
      `migrations/migration_015.sql` (new), `tests/migration_015.test.js`
      (new), `tests/routes/profile.test.js` (new), plus this todo.md. (Other
      modified/untracked files in `git status` — `CLAUDE.md`,
      `tasks/handoff.md`, `scripts/promoteTraceToCorpus.js`,
      `tests/promoteTraceToCorpus.test.js`, `eval/runs/` — predate this
      session and were not touched here.)
- [x] Did not touch scoring, thresholds, `SIGNAL_CONFIG`, the eligibility
      gate, `normalization_version` on `evaluation_corpus`, the promoted
      row's `scorer_version`, `CREATE INDEX CONCURRENTLY`, or
      `.claude/CLAUDE.md`. Did not run `resetLocalDb.sh` or reseed. Did not
      touch `DEMO_ORG_ID`'s promoted corpus row.
