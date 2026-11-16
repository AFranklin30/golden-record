# Golden Record — Sprint Tracker

Verified against `main` commit `7fa878d` on 2026-11-16.

## Current sprint

Sprint 0 — scope freeze and technical audit.

Status: IN PROGRESS.
The audit and these documents are written. The sprint is not complete until Aaron approves the scope (S0-06).

## Objective

Prove what the repository actually does, write the demo plan from that, and keep later sprints from adding a new platform.

## Tasks

| ID | Status |
|---|---|
| S0-01 Capability inventory | COMPLETED |
| S0-02 Jest run | COMPLETED |
| S0-03 Evaluation harness run | COMPLETED |
| S0-04 Customer-data check | COMPLETED |
| S0-05 Project-management docs | COMPLETED |
| S0-06 Aaron approves the MVP scope | NOT STARTED |

## Completed this sprint

- Read the route files, matcher, resolver, migrations, export, harness, seed script, Dockerfile, and README.
- Installed dependencies. Installed local PostgreSQL 16. Replayed `scripts/resetLocalDb.sh` (migrations `001`–`017`).
- Ran `npm test` (`npx jest --runInBand`). Second run, with Node set to warn on unhandled rejections so a missing Google credential would not kill the process: **541 passed, 46 failed, 1 skipped, 588 total. 17 suites passed, 7 failed.**
- Seeded the synthetic demo org with `scripts/seedDemoOrg.js`. The script completed all five scenarios and inserted 8 synthetic corpus rows.
- Ran `node eval/runCorpus.js aaaaaaaa-0000-0000-0000-000000000001`. Scorecard: found 3, silent miss 0, correct separation 5, false alarm 1, recall 1, precision 0.75. Corpus size 9 (8 synthetic + 1 promoted).
- Checked the working tree for customer records. None are in the current files. A deleted evaluation script remains in git history. See D-004.
- `GET https://golden-record.onrender.com/health` returned HTTP 200 and `status: ok` on 2026-11-16.
- `https://golden-record-six.vercel.app/` returned HTTP 500 `FUNCTION_INVOCATION_FAILED`. No UI source is in this repo.

## Remaining

- S0-06. Aaron reads `SCOPE-AND-BACKLOG.md` and `DECISION-LOG.md` and approves them or marks cuts.

## Blockers

- Scope is proposed, not approved. Sprint 1 does not start until S0-06 is done.
- No Google application-default credentials in the audit environment. Firestore sync in `resolverEngine.js` logs the failure and also leaves a rejection that Jest reports as a test failure. That blocked a clean pass of the real-Postgres resolution suites. It is an environment gap, not a measured matching regression. See the failure breakdown below.
- No dashboard source was found to reuse.
- The Render service is up. The git SHA it is running is UNVERIFIED. The repo has no Render config.

## Test failure breakdown (second Jest run)

46 failed tests:

| Count | Where | What happened |
|---|---|---|
| 2 | `tests/modules/resolverEngine.test.js` | Intentional. The test file says these two cases are the pre-existing failures and were left failing. `guardian_email` and `nfc_uid` inputs do not reach `scoreMatch` when the mock returns no block candidate. |
| 5 | `tests/seedDemoOrg.test.js` | The file expects the demo org to already exist before the file runs. This audit started from an empty database, so the first test performed the seed and the earlier `beforeAll` lookups saw an empty org. The seed script's own output showed all five scenarios and 8 corpus rows. |
| 39 | `resolverEngine.blocking.test.js` (12), `resolverEngine.trace.test.js` (12), `resolverEngine.clock.test.js` (9), `nfc.identifiers.test.js` (5), `eval.harness.test.js` (1) | Jest reports `Could not load the default credentials` at the Firestore `set()` in `resolverEngine.js`. Postgres was available. These tests were not shown to fail on an assertion about matching. |

17 suites passed, including `probabilisticMatcher.test.js`, `normalizer.test.js`, `findBlockCandidates.test.js`, `conflicts.test.js`, `household.test.js`, `export.test.js`, `health.test.js`, the migration tests, and `promoteTraceToCorpus.test.js`.

One skip: `tests/modules/resolverEngine.trace.test.js` test "all_candidates_gated", marked `test.skip` in the file.

`npm test` does not run the 29 `*.smoke.js` and `*.unit.js` files. Those were not executed. They require the same local Postgres.

A later retry that set `FIRESTORE_EMULATOR_HOST` to a closed port made the blocking suite time out at 20 seconds. That retry is not the result above. The credential failure is the one that matches the code path.

## Harness result

Command: `node eval/runCorpus.js aaaaaaaa-0000-0000-0000-000000000001` after the synthetic seed.

- Scorer version: `v1+d7d646f3`
- Normalization version: `v1`
- Thresholds: path C 0.85, path D 0.60
- Counts: total 9, synthetic 8, promoted with snapshot 1, gated 1, skipped 0, scorer drift 0
- Scorecard: found 3, silent miss 0, correct separation 5, false alarm 1, excluded 0, recall 1, precision 0.75

The false alarm is the promoted demo row: expected verdict `not_match`, replayed path D, score 0.7, delta 0 against the stored trace, `label_disagreement` true. Path D queues a review. It does not merge.

There is no 60-scenario benchmark file in the current tree, and no stored 90.5% or 79.2% result.

## Completion assessment

Sprint 0 is not complete.

The audit deliverable is complete. The remaining gate is Aaron's approval of the proposed scope. Until that approval, the percent of Sprint 0 tasks done is 5/6, and the percent of all MVP tasks done is 5/35 (14%).
