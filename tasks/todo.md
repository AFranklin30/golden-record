# scoring_clock fix — one resolution, one moment
# Session: 2026-08-17

Read (not inferred), full files:
- src/modules/resolverEngine.js — confirmed exactly ONE scoreMatch call site
  (line 377). Confirmed trace object init (RECEIVE section, before try),
  the trace INSERT (STEP 4C, after COMMIT, own try/catch, swallowed on
  failure), and its VALUES placeholder mapping to the params array.
- src/modules/probabilisticMatcher.js — confirmed scoreMatch signature
  `scoreMatch(candidateRecord, inboundIdentifiers, now = Date.now())`
  (line 179) and the non-finite guard (lines 201-203): throws
  NormalizationError unless `now` is `typeof 'number'` and `Number.isFinite`.
  NOT modifying this file.
- migrations/migration_014.sql — confirmed `scoring_clock timestamptz NOT
  NULL` (line 80) and the column comment (lines 51-52): "scoring_clock is
  the injected `now`... NOT the row insert time. created_at is the insert
  time. When they differ, the difference matters." No migration needed —
  column already exists with the right type.
- tests/modules/resolverEngine.trace.test.js — found assertion 15 (lines
  136-138, inside test 1 "keys recorded on successful retrieval"): currently
  asserts only `trace.scoring_clock` is not null, with an explicit comment
  that it's "pinned here as a before-state" for the NOW()-binding behavior.
  Must update to assert the new behavior per the documented test-fixing
  exception (.claude/CLAUDE.md §6) — show old vs new at check-in.
- tests/modules/resolverEngine.test.js — confirmed its db.query mock
  branches on SQL text via `text.includes('INSERT INTO resolution_trace')`
  etc. (lines 151-169), not positional placeholder count — renumbering the
  trace INSERT's placeholders will not desync this mock.

## Placeholder renumbering (STEP 4C trace INSERT)

Current: columns id..created_at (27 total), scoring_clock bound inline as
NOW() (not a placeholder), created_at also NOW(). Params array currently
has 25 entries mapped to $1-$18 then $19-$25 (skipping the NOW() for
scoring_clock in between).

New: scoring_clock becomes a placeholder ($19), created_at stays NOW().
Everything from $19 onward in the current query shifts up by one
($19→$20, $20→$21, ... $25→$26). Full new params array (26 entries):

  1 id, 2 org_id, 3 audit_event_id, 4 resolution_path, 5 scoring_status,
  6 skip_reason, 7 inbound_identifiers(JSON), 8 candidate_ids,
  9 candidates_considered, 10 candidates_gated, 11 candidates_scored,
  12 signal_results(JSON), 13 best_candidate_id, 14 best_score,
  15 threshold_path_c, 16 threshold_path_d, 17 scorer_version,
  18 normalization_version, 19 scoring_clock (NEW — was NOW()),
  20 resulting_fan_id, 21 is_new_record, 22 conflict_id,
  23 block_keys_available, 24 block_results(JSON), 25 blocks_dropped,
  26 block_size_cap
  — then NOW() for created_at (unchanged, last column).

## THE FIX (src/modules/resolverEngine.js only)

1. Capture the clock once, in RECEIVE, before the trace object literal
   (around line 202, right before `const trace = {`):

   ```js
   // One resolution, one moment. Every scoreMatch call in the candidate loop
   // and the scoring_clock stamped on the trace all read this same value, so
   // a resolution is internally consistent and the trace records the instant
   // scoring actually happened — not the instant the trace row was inserted
   // after COMMIT. created_at is the insert time; these are deliberately
   // different columns (see migration_014).
   const scoring_clock = Date.now();
   ```

2. Line 377 — pass it to the only scoreMatch call:
   `scoreMatch(candidate, inbound, scoring_clock)`.

3. STEP 4C INSERT — replace the inline `NOW()` for scoring_clock with a new
   placeholder, insert `new Date(scoring_clock).toISOString()` into the
   params array at the corresponding position, renumber everything after it
   per the mapping above. `created_at`'s NOW() is untouched.

4. PATH A — no change needed beyond #1: `scoring_clock` is captured
   unconditionally in RECEIVE, before the PATH A/B branch, so PATH A's
   trace write (scoring_status 'skipped' / skip_reason
   'deterministic_match') already stamps it. Will confirm this after edit
   by re-reading the diff, not assume.

## THE TEST — tests/modules/resolverEngine.clock.test.js (new)

Local Postgres only, confirm DATABASE_URL points at localhost:5432 before
any write. Fresh test org + UUIDs, cleanup in FK order in `finally`.
Template off resolverEngine.trace.test.js's seedOrg/seedFan/seedIdentifier/
cleanupOrg helpers (same file conventions, same append-only-row handling
for audit_log/resolution_trace).

1. scoring_clock stamped and plausible — bracket a resolve with
   before/after timestamps, assert scoring_clock falls between them
   inclusive.
2. scoring_clock <= created_at on the same row (assert strictly < if the
   gap is reliably non-zero; else <= and report the observed gap).
3. Same clock across all candidates in one resolution — seed 3 fans
   sharing the inbound's email, spy/wrap scoreMatch, assert its 3rd arg is
   IDENTICAL (not just close) across all 3 calls.
4. Clock passed to scoreMatch equals the persisted scoring_clock, from the
   same resolution as #3.
5. PATH A stamps it — resolve an inbound whose identifier already exists,
   assert resolution_path 'A', skip_reason 'deterministic_match',
   scoring_clock non-null and in-window.
6. PATH B / no block key stamps it — assert skip_reason 'no_block_key',
   scoring_clock non-null even though scoreMatch never ran.
7. REGRESSION — PATH C score unchanged from pre-change behavior (fixture
   landing >= 0.85 threshold), match_type 'soft', pending conflict_queue
   row, best_score matches expected value.
8. REGRESSION — PATH D unchanged, fixture tuned into [0.60, 0.85).
9. REGRESSION — block metadata (block_keys_available, block_results,
   blocks_dropped, block_size_cap) still correct post-renumbering.
10. Trace write failure still doesn't break resolution (force INSERT
    failure, assert resolution still returns valid fan_id + audit_event_id,
    audit_log row committed) — Stage 7 decision B.
11. Update resolverEngine.trace.test.js assertion 15 (lines 136-138) to
    assert the new binding instead of "still NOW()". Old vs new shown at
    check-in, per .claude/CLAUDE.md §6. Not deleted, not skipped.
12. Full suite run, report delta vs baseline (11 failed / 546 passed /
    1 skipped / 558 total; known pre-existing failures: resolverEngine.test.js
    (2), household.test.js (9)).

## DO NOT

- Modify probabilisticMatcher.js (signature, default param, non-finite
  guard all stay as-is).
- Thread a clock in from resolve.js or nfc.js — rejected option B.
- Change created_at (stays NOW()).
- Capture the clock inside the candidate loop, the else branch, or
  anywhere PATH A doesn't reach.
- Touch getRecencyMultiplier, monthsBetween, or recency behavior.
- Touch retrieval, findBlockCandidates, BLOCK_SIZE_CAP, skip reasons, or
  block metadata logic (only re-proving via regression test #9, not
  changing).
- Move the trace INSERT out of its try/catch, before COMMIT, or make its
  failure throw.
- Write a migration.
- Delete or skip trace.test.js assertion 15 — update it, show old vs new.
- Touch nfc.js, resolve.js, CLAUDE.md, or .claude/CLAUDE.md.

Write plan to tasks/todo.md before touching any file — done. Checking in
before implementation.

## Review

**src/modules/resolverEngine.js (3 edits, as planned):**
1. `const scoring_clock = Date.now();` added in RECEIVE, before the `trace`
   object literal — captured unconditionally, so PATH A reaches it too.
2. The sole `scoreMatch` call site (was line 377) now passes `scoring_clock`
   as the third arg.
3. STEP 4C trace INSERT: `scoring_clock`'s inline `NOW()` replaced with
   placeholder `$19` bound to `new Date(scoring_clock).toISOString()`;
   everything from the old `$19` onward renumbered to `$20`-`$26`.
   `created_at` stays `NOW()`, unchanged, still the final column.

No changes to probabilisticMatcher.js, no migration, no route changes —
confirmed via `git status` before finishing.

**tests/modules/resolverEngine.clock.test.js (new, 10 tests, all passing):**
Assertions 1-2 (plausibility, scoring_clock <= created_at), 3-4 (identical
clock across candidates / matches persisted value — via a jest.mock that
wraps probabilisticMatcher's REAL scoreMatch in a jest.fn so scores stay
real while calls become inspectable), 5-6 (PATH A and no-block-key PATH B
both stamp it without scoreMatch ever running), 7-8 (PATH C/D scores
unchanged — 1.0 and 0.7, same fixtures as resolverEngine.blocking.test.js's
tests 12/13), 9 (block metadata columns re-proven post-renumbering), 10
(forced trace-INSERT failure still returns a valid resolution with a
committed audit_log row — Stage 7 decision B). Collapsed the spec's
assertions 11-12 into this file's own scope (11 → the trace.test.js edit
below; 12 → the full-suite run below).

**tests/modules/resolverEngine.trace.test.js — assertion 15 updated (test-
fixing exception, .claude/CLAUDE.md §6):**
- OLD: asserted only `scoring_clock` is non-null, with a comment explicitly
  pinning it as a "before-state" for the NOW()-binding behavior about to be
  fixed.
- NEW: additionally asserts `scoring_clock <= created_at` (`<=` rather than
  `<` because a sufficiently fast resolution could in principle land both
  in the same millisecond). Previously the two columns were bound by two
  separate `NOW()` calls in the same INSERT statement and were therefore
  IDENTICAL (Postgres `NOW()` is stable per statement) — the old assertion
  couldn't have told the two binding strategies apart even if it tried.
  13 passed / 1 skipped, matching this file's documented baseline exactly.

**tests/modules/resolverEngine.test.js — 2 lines changed, mechanical:**
Two tests in "inbound object construction" (`identifier_type email...` and
`inbound.org_id is always set`) call `expect(scoreMatch).toHaveBeenCalledWith(...)`
with exactly 2 expected args; Jest's `toHaveBeenCalledWith` requires exact
arity, so adding the third `scoring_clock` argument to every real call broke
both. Added `expect.any(Number)` as a third matcher to each — this is the
calling-convention change the fix exists to make, not new coverage. The
suite's 2 pre-existing failures (`guardian_email`/`nfc_uid` variants, "0
calls" — documented in-file at lines 534-541 as pre-dating the blocking
build, confirmed via a `git stash` round-trip against unmodified
resolverEngine.js before touching anything) are untouched and still fail
identically.

**Full suite:** 11 failed / 556 passed / 1 skipped / 568 total. Baseline was
11 failed / 546 passed / 1 skipped / 558 total — failed count identical,
passed/total both up by exactly 10 (the new clock test file). Confirmed via
a separate isolated run that the 2 failing suites are still exactly
resolverEngine.test.js (2 failures) and household.test.js (9 failures), same
counts as baseline.

**DO NOT list:** all held. probabilisticMatcher.js untouched; no clock
threaded from resolve.js/nfc.js; created_at untouched; scoring_clock
captured only once, before both the try block and the PATH A/B branch; no
recency-function changes; no migration; no changes to retrieval/blocking
logic (block metadata re-proven, not altered); trace INSERT still after
COMMIT, own try/catch, failure still swallowed; trace.test.js assertion 15
updated in place, not deleted or skipped; nfc.js, resolve.js, CLAUDE.md,
.claude/CLAUDE.md all untouched.
