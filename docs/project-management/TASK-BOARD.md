# Golden Record — Task Board

Corrected 2026-11-16. Status values: NOT STARTED, IN PROGRESS, BLOCKED, COMPLETED, DEFERRED.

"On the tip" means the work exists in `cc83b1b97867d70257b2445afd07221d817c996b`. It is not on `main`.

Sizes are planning sizes, not measured time.

## Sprint 0

| ID | Description | Priority | Status | Size | Depends on | Acceptance |
|---|---|---|---|---|---|---|
| S0-01 | Inventory `main` at `7fa878d`. | P0 | COMPLETED | M | — | Kept as the record of the stale audit. |
| S0-02 | Jest on `main`. | P0 | COMPLETED | M | S0-01 | 541 passed, 46 failed, 1 skipped, 588 total. Not the tip. |
| S0-03 | 9-row harness on `main`. | P0 | COMPLETED | S | S0-01 | Precision 0.75, recall 1. Not the 60-scenario benchmark. |
| S0-04 | Customer-data check. Do not copy records. | P0 | COMPLETED | S | — | No customer rows in the working tree. History still has the deleted script. |
| S0-05 | First docs. | P0 | COMPLETED | M | S0-01–S0-04 | Superseded by S0-07. |
| S0-07 | Re-audit `cc83b1b` and correct these docs. | P0 | COMPLETED | M | S0-05 | Jest 691/1/692 and benchmark 60 / 0 mismatches / 0.9048 / 0.7917 are in `PROJECT-STATUS.md` with the command. |
| S0-06 | Aaron approves the corrected scope and whether to merge the tip into `main`. | P0 | NOT STARTED | S | S0-07 | A note in `DECISION-LOG.md` or on the PR. Sprint 1 does not restart before this. |

## Already done on the tip

These were NOT STARTED in the first board because they are absent from `main`. They are not new tasks.

| ID | Description | Status | Evidence |
|---|---|---|---|
| S1-60 | 60-scenario benchmark with zero policy mismatches. | COMPLETED on the tip | `eval/fixtures/benchmarkCases.js`, `tests/eval.benchmark.test.js`, `eval/reports/benchmark-report.md`. Re-ran 2026-11-16. |
| S2-UI | Operator dashboard: queue, confirm, reject, unmerge, import, export. | COMPLETED on the tip | `web/`, `src/routes/dashboard.js`. Static tests pass when `web/dist` exists. |
| S2-CSV | CSV in through the existing resolver. | COMPLETED on the tip | `src/modules/customerImport.js`, `POST /v1/dashboard/imports`, migration `018`. |
| S3-RLS-TEST | Non-superuser isolation test. | COMPLETED on the tip | `tests/routes/tenantIsolation.test.js` passed inside the 691. |

## Not started

| ID | Description | Priority | Status | Size | Depends on | Acceptance |
|---|---|---|---|---|---|---|
| S1-200 | Run `scripts/buildSyntheticDemoCsv.js` and import the 200 synthetic rows. | P1 | NOT STARTED | M | S0-06 | The CSV is produced, imported through `importCustomers`, and the review count is written down. Optional next to the 60-scenario baseline. |
| S2-EXPORT | Add score and signals to the fan CSV, only if Aaron asks. | P2 | DEFERRED | S | S0-06 | A written yes, then a column list. Default is to leave `CSV_HEADER` alone. |
| S2-VITEST | Run `npm test` inside `web/`. | P1 | NOT STARTED | S | S0-06 | The 9 Vitest files pass or the failures are listed. Not part of the 691. |
| S3-SHA | Record the git SHA behind `golden-record.onrender.com`. | P0 | NOT STARTED | S | S0-06 | The SHA is named. UNVERIFIED today. |
| S3-HOST | Apply migrations `001`–`020` on the hosted database if they are not there, and repeat the app-role isolation check. | P0 | NOT STARTED | M | S3-SHA | The hosted role is `NOSUPERUSER NOBYPASSRLS`, or the gap is written down. |
| S4-WALK | One hosted walkthrough and a script that matches `docs/engineering/matching-policy.md`. | P0 | NOT STARTED | M | S3-HOST | Path C is described as a queued new fan. The README sentence is corrected or called out. |
| S4-README | Fix the path C sentence in `README.md`. | P1 | NOT STARTED | S | S0-06 | The sentence matches `resolverEngine.js`. The resolver is not edited to match the old sentence. |

## Counts

Sprint 0 tasks: 7. COMPLETED: 6. NOT STARTED: 1 (S0-06).

The first board's "5/35 = 14%" counted a build list that assumed `main`. That percentage is withdrawn. The open product decision is the merge, not a missing engine.
