# Customer CSV import

## Context
A customer file has a name, email, birthday, ZIP, and phone on one row. One resolve call keeps only the single identifier it was given, so the next row cannot find that person. The import calls the existing resolver, then stores the rest of the row on the fan the resolver returns. Matching does not change. Nothing merges on its own.

## Files
- `migrations/migration_018.sql` — narrow `uq_identifier_per_org`; add `import_batch`, `import_row`, and audit event `import_identifiers_attached`
- `src/modules/customerImport.js` — parse, validate, call `resolverEngine`, then insert the remaining identifiers
- `tests/modules/customerImport.test.js` — validation with no resolver call, and the ten-row file on local Postgres
- `CLAUDE.md` — uniqueness and the new audit event

## THE FIX
`uq_identifier_per_org` stays unique for email, phone, nfc_uid, nba_id, ticketmaster_id, guardian_email, and guardian_phone when `source_system != 'fan_pass'`. name, dob, and zip may repeat across fans. The row key is sha256 of org plus normalized email, name, dob, zip, and phone. A completed key is not sent to the resolver again. Remaining identifiers are inserted only on the returned fan_id. A second birthday on an exact email match is not stored. Phone is stored and is not sent to the scorer.

## THE TEST
1. A row with no email and no name-plus-birthday is an error and creates no fan.
2. Rows 1 and 2 are one fan. Name, birthday, ZIP, phone, and email are stored.
3. Rows 3 and 4 open a pending review. Nothing is merged.
4. Rows 5 and 6 open a pending review with Robert. Nothing is merged.
5. Rows 7 and 8 are different fans. Robert Jones is not reviewed against Bob Smith.
6. Rows 9 and 10 are one fan. The 1992 birthday is not stored. Both phones are stored.
7. Importing the file again adds no fans, no reviews, and no identifier rows.
8. Confirming the Jon and John review through `POST /v1/conflicts/:id/confirm` soft-deletes only the new fan. `GET /v1/export/fans` omits that fan.
9. Confirming Bob into Robert works once. The other two reviews stay pending. Confirming that same review again returns 409. When another pending review names Robert as the target, that confirm returns 409 because one fan can absorb only one merge.

## DO NOT
Do not change `resolverEngine` or `probabilisticMatcher`. Do not auto-merge. Do not store a disagreeing birthday on the exact-email fan. Do not send phone into scoring. Do not reset the local database. Do not deploy.

# Name-and-birthday review floor

## Context
Bob and Robert with the same birthday and different emails score about 0.4 after the 0.3 email penalty. That is under 0.60, so today the system saves a second fan and writes no review row. The penalty stays. The path changes: a `name_plus_dob` agreement is review even when the stored score is under 0.60.

## Files
- `src/modules/resolverEngine.js` — `pathForMatch`, used for the path decision and for choosing which candidate is reviewed
- `eval/harness.js` — replay uses the same function
- `tests/modules/probabilisticMatcher.test.js` — penalty still applied
- `tests/modules/resolverEngine.test.js` — path and queue
- `tests/eval.harness.test.js` — replay path
- `CLAUDE.md` — PATH D description

## THE FIX
`pathForMatch(score, signals)` returns `C` at or above 0.85, `D` at or above 0.60, and also `D` when `signals` contains `name_plus_dob` and the score is under 0.60. The stored score is the real score. A stronger candidate that already clears 0.60 stays the winner. A name with no birthday still needs 0.60. A birthday conflict still scores 0 with no signals and stays two fans.

## THE TEST
1. Nickname, same birthday, different emails: score is about 0.4, email penalty is present, score is under 0.60.
2. That pair's path is `D`, `match_type` is `conflict`, and the queue stores the real score.
3. A 0.4 score with no `name_plus_dob` signal stays path `B` and writes no queue row.
4. A 0.90 score with `name_plus_dob` stays path `C`.
5. A 0.70 score with no `name_plus_dob` stays path `D`.
6. When one candidate scores 0.50 with no name-and-birthday signal and another scores 0.40 with `name_plus_dob`, the queue is for the 0.40 candidate.
7. When one candidate already scores 0.70, a 0.40 name-and-birthday candidate does not replace it.
8. Harness replay of a name-and-birthday score under 0.60 reports path `D` and keeps that score.

## DO NOT
Do not change the 0.3 email penalty, the 0.60 or 0.85 thresholds, the nickname list, blocking, or auto-merge. Nothing auto-merges.

---

# Eval scorecard — totals over existing harness rows

## Context
`evaluateRow` already sets `expected_verdict` and `replayed_path` (`C`, `D`, or `B`) or `gate_status: 'gated'`. `buildRun` returns those rows and never totals them. The 8 `CORPUS_PAIRS` in `scripts/seedDemoOrg.js` are the concrete example: exact agreement and the typo pair should count as found, the near-miss email, birthday veto, shared inbox, device-only, and sibling pairs should count as correct separation, and email-alone should count as found. This slice does not rescore them by hand. It counts whatever the harness already emitted.

## Files
- `eval/harness.js` — pure `summarizeScorecard(rows)`
- `eval/runCorpus.js` — attach `scorecard` on the run object and print it
- `tests/eval.harness.test.js` — five assertions, plain objects, no new Postgres fixtures

## THE FIX
`match` + path `C` or `D` → `found`. `match` + path `B` or `gated` → `silent_miss`. `not_match` + path `B` or `gated` → `correct_separation`. `not_match` + path `C` or `D` → `false_alarm`. `unsure` and skipped rows → `excluded`. `recall = found / (found + silent_miss)`, `precision = found / (found + false_alarm)`, null when the denominator is 0.

## THE TEST
1. One of each outcome → counts 1, 1, 1, 1, recall 0.5, precision 0.5.
2. `unsure` and a skipped row increment `excluded` only.
3. A gated `match` is a silent miss.
4. Empty list → zeros and null rates.
5. Regression: an existing `buildRun` result still has `counts.total`, and `scorecard` has the same keys.

## DO NOT
Do not change `scoreMatch`, blocking, path A, nicknames, corpus pairs, or the household test fix.

---

# tests/promoteTraceToCorpus.test.js — stale hardcoded trace ID fix (check-in required before implementation)

## Scope
Edit ONLY `tests/promoteTraceToCorpus.test.js`. No production file, no migration,
no `scripts/seedDemoOrg.js` change. `git diff` must show only this file.

## What's confirmed by reading the file (all of it)

The hardcoded generated id is `SCENARIO_3_TRACE_ID` (currently a module-level
`const`, line 46), consumed in exactly three places, all inside the second
`describe` block ("real demo trace"):
- line 276 — lookup for an already-promoted `evaluation_corpus` row
- line 282 — `promoteTraceToCorpus(client, DEMO_ORG_ID, SCENARIO_3_TRACE_ID, ...)`
- line 349 — re-querying `resolution_trace.scorer_version` by id in test 11

`DEMO_ORG_ID` (line 45) is NOT in scope — it's a fixed, hand-chosen constant
(`aaaaaaaa-0000-...`) that `scripts/seedDemoOrg.js` also hardcodes as
`DEMO_ORG_ID`; it doesn't change between seed runs, unlike a `crypto.randomUUID()`
value. The first `describe` block ("guards + shape") generates its own ids via
`crypto.randomUUID()` per test run already — nothing hardcoded there.
**No other generated id (fan id, audit_event_id, conflict_id) is hardcoded
anywhere in this file.** Scope is exactly the one constant.

## Chosen fix: query (a), not the summary file (b)

Read `seedScenario3` in `scripts/seedDemoOrg.js` (lines 271-347). Traced what
makes its trace uniquely identifiable without relying on any id generated by
that same run:

- The tap's `match_type` is `'conflict'` → `resolverEngine` sets
  `resolution_path = 'D'` (confirmed in `src/modules/resolverEngine.js:477`).
- `findBlockCandidates` retrieves **fan A via the `email` key and fan B via
  `name_dob`** (two different keys, by design — see the fixture-repair
  handoff) — so `candidate_ids` has exactly 2 entries for this trace.
- Checked every other scenario that also produces a `resolution_path = 'D'`
  trace in the same demo org, to make sure the 2-candidate count is actually
  distinguishing and not coincidental:
  - **Scenario 2** (Marcus Webb): fixture fan has name+dob only, tap sends
    name+dob only → only the `name_dob` key can retrieve anything →
    `candidate_ids` length 1.
  - **Scenario 5** (Dana Park): fixture fan has email only, live resolve sends
    `identifiers.email` → only the `email` key retrieves anything →
    `candidate_ids` length 1.
  - Scenario 1 is PATH A (not D). Scenario 4 never calls resolverEngine against
    existing candidates.
- So `org_id = DEMO_ORG_ID AND resolution_path = 'D' AND
  array_length(candidate_ids, 1) = 2` uniquely identifies Scenario 3's trace
  in a correctly seeded demo org, using only stable, seed-script-derived
  properties — no dependency on a value generated by *this specific* run.

This is option (a) from the prompt: a self-contained DB query, no dependency on
`scripts/demo-org-summary.txt` (which the seed script also regenerates per run,
but that's a second thing that can drift — the DB is the source of truth the
file is only reporting).

`resolution_trace` is `FORCE ROW LEVEL SECURITY` (migration_014); the existing
`beforeAll` already does `set_config('app.current_org_id', DEMO_ORG_ID, false)`
as its first statement — the new lookup query runs right after that, so it sees
the same context the rest of the block already relies on.

## The fix, concretely

- Delete the module-level `const SCENARIO_3_TRACE_ID = 'f71a4a01-...'` (line 46).
- Inside the second `describe` block, declare `let SCENARIO_3_TRACE_ID;` (same
  identifier — lines 276, 282, 349 need no other change).
- In that block's `beforeAll`, immediately after the existing `set_config` call
  and before the "existing corpus row" query, add:
  ```js
  const traceLookup = await client.query(
    `SELECT id FROM resolution_trace
       WHERE org_id = $1 AND resolution_path = 'D'
         AND array_length(candidate_ids, 1) = 2`,
    [DEMO_ORG_ID]
  );
  if (traceLookup.rows.length !== 1) {
    throw new Error(
      `Expected exactly one Scenario 3 resolution_trace row for demo org ` +
      `${DEMO_ORG_ID} (org_id + resolution_path='D' + 2 candidate_ids), found ` +
      `${traceLookup.rows.length}. The demo org needs seeding — run ` +
      `\`node scripts/seedDemoOrg.js\` (after \`bash scripts/resetLocalDb.sh\` ` +
      `if the schema is stale) before running this test file.`
    );
  }
  SCENARIO_3_TRACE_ID = traceLookup.rows[0].id;
  ```
- Resolved once, in `beforeAll`, not per-test — satisfies the "resolve once"
  requirement and matches the file's existing pattern (`corpusRow`, `runResult`
  are also `beforeAll`-scoped, reused by tests 7-11).

## Verification steps (in order)

1. Run `tests/promoteTraceToCorpus.test.js` against the currently seeded local
   DB (whatever generated trace id exists right now) — must pass fully.
2. `bash scripts/resetLocalDb.sh`, `node scripts/seedDemoOrg.js`, run the file
   again — must pass against a *different* generated trace id than step 1.
3. Reset + reseed a second time, run again — must pass against a *third* id.
   (Confirms it's not coincidence.)
4. Drop the demo org (or point at a schema with no seed data), run the file,
   confirm the thrown error names the demo org and says it needs seeding — not
   `undefined` or a bare `trace not found`.
5. Full suite: confirm return to the 11 failed / 570 passed / 1 skipped / 582
   total baseline (resolverEngine.test.js@2, household.test.js@9 only). Report
   any delta by suite name.
6. `git diff --stat` — only `tests/promoteTraceToCorpus.test.js`.
7. On the reseeds from steps 2-3, confirm Scenario 3's own fixture assertions
   still hold (fan A considered, fan B wins at 0.700, two size-1 blocks) — this
   change must not disturb the fixture repair already landed.

## lessons.md

Add a new entry naming the category (4th instance: #24, #28, #29, and the
`SCENARIO_3_TRACE_ID` case #30 documented but didn't yet fix) — generated ids
must be looked up, never hardcoded, in any test. 20-entry cap: rotate out #11
(oldest — Firestore `databaseId` omission), per the file's own stated rotation
rule.

## Handoff

Update `tasks/handoff.md` at the end per the 5-line required format.

## Not doing

- Not touching `scripts/seedDemoOrg.js`, any migration, or any production file.
- Not touching the two pre-existing failing suites.
- Not fixing lessons.md #28 or #29.
- Not skipping or deleting any of the 6 currently-failing tests.
