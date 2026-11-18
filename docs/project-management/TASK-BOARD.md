# Golden Record — Task Board

Updated Nov 18, 2026. Status values: NOT STARTED, IN PROGRESS, BLOCKED, COMPLETED, DEFERRED.

Source of truth is `main` at `f867e62921e6332e6e02aeebeacba86351844699`. Sprint 2 and later are not on this board.

Sizes are planning sizes, not measured time. S is a focused slice. M is a main slice.

## Sprint 0

| ID | Description | Priority | Status | Size | Depends on | Acceptance |
|---|---|---|---|---|---|---|
| S0-01 | Inventory `main` at `7fa878d`. | P0 | COMPLETED | M | — | Kept as the record of the stale audit. |
| S0-02 | Jest on `main`. | P0 | COMPLETED | M | S0-01 | 541 passed, 46 failed, 1 skipped, 588 total. Not the tip. |
| S0-03 | 9-row harness on `main`. | P0 | COMPLETED | S | S0-01 | Precision 0.75, recall 1. Not the 60-scenario benchmark. |
| S0-04 | Customer-data check. Do not copy records. | P0 | COMPLETED | S | — | No customer rows in the working tree. History still has the deleted script. |
| S0-05 | First docs. | P0 | COMPLETED | M | S0-01–S0-04 | Superseded by S0-07. |
| S0-07 | Re-audit `cc83b1b` and correct these docs. | P0 | COMPLETED | M | S0-05 | Jest 691/1/692 and benchmark 60 / 0 mismatches / 0.9048 / 0.7917 are in `PROJECT-STATUS.md` with the command. |
| S0-06 | Aaron approves the MVP scope in `SCOPE-AND-BACKLOG.md` as written. | P0 | COMPLETED | S | S0-07 | Approved Nov 16, 2026. Recorded as D-019. |

## Already on `main` (reuse, not new Sprint 1 work)

| Piece | Where | What it does not do |
|---|---|---|
| 60-scenario benchmark | `eval/fixtures/benchmarkCases.js`, `eval/benchmark.js`, `tests/eval.benchmark.test.js`, `eval/reports/benchmark-report.md` | It is 60 resolver scenarios, not 200 customer rows. The test rewrites `eval/reports/benchmark-report.md` and `.json`. |
| 200-row builder | `scripts/buildSyntheticDemoCsv.js` | Writes `demo/synthetic-customers-200.csv` (80 originals, 5 same-email copies, 10 nicknames, 10 spellings, 20 same-name different emails, 15 name+birthday+zip with no email, 60 different first name and birthday). The default run still checks those lookalikes with `scoreMatch`. `node scripts/buildSyntheticDemoCsv.js --labels` writes `demo/synthetic-ground-truth-v2.json` for Set A plus Set B and does not call the resolver. |
| Importer | `importCustomers` in `src/modules/customerImport.js` | This is the engine run for a CSV. Sprint 1 uses it. It is not a new adapter. |
| Firestore skip | `firestoreSyncEnabled()` in `src/modules/resolverEngine.js`, and the credential rejection handler in `index.js` | The Jest suite did not need a flag. `node scripts/seedDemoOrg.js` still exited on the household child write, because `household.js` calls Firestore outside `index.js`. Rerun that script with `node --unhandled-rejections=warn`. |

`*.csv` is gitignored. The 200-row CSV and the 160-row extension stay local. `demo/synthetic-200-ground-truth.json` is the first label file. `demo/synthetic-ground-truth-v2.json` is the 360-row file.

## Sprint 1 — COMPLETED Nov 18, 2026, started Nov 16, 2026

Do not change `eval/fixtures/benchmarkCases.js`, `eval/benchmark.js` metric rules, or the matcher. Do not overwrite `eval/reports/benchmark-report.md`.

Nov 16, 2026, about 1:04 PM CT. Aaron approved expanding the labeled set from 200 rows to 360 before any engine run (D-021). Set A stays the original 200 rows. Set B adds 160 rows, 80 anchor-and-probe cases. The spec is `docs/evaluation/synthetic-dataset-spec.md`.

Nov 16, 2026, about 3:09 PM CT. Aaron approved S1-04. All 360 rows were imported through `importCustomers` and the raw results were recorded. S1-05 then measured that import against identity truth. S1-06 and S1-07 were completed Nov 18, 2026. Sprint 1.5, Matching Quality Fixes, was approved the same day (D-022) and is not on this board.

| ID | Description | Priority | Status | Size | Depends on | Deliverable | Acceptance |
|---|---|---|---|---|---|---|---|
| S1-01 | Re-run the existing 60-scenario benchmark on `main` and record the result. | P0 | COMPLETED | S | S0-06 | A note of the command and the summary next to the committed report. Recorded in `SPRINT-TRACKER.md`. The report files were restored. | `tests/eval.benchmark.test.js` passes. Summary stays 60 scenarios, 0 policy mismatches, precision 0.9048, recall 0.7917, 27 reviews. No matcher or fixture edit. |
| S1-02 | Save ground truth for the 200-row mix the script already builds. | P0 | COMPLETED | M | S1-01 | `demo/synthetic-200-ground-truth.json`, then `demo/synthetic-ground-truth-v2.json` after D-021. | Every labeled row has identity truth and a policy-expected outcome. Set A keeps its 200 rows. Set B adds the 17 scenarios. Labels are not inferred from an engine run. |
| S1-03 | Generate the CSV by running the existing script. | P0 | COMPLETED | S | S1-02 | `demo/synthetic-customers-200.csv` on disk. The `--labels` rebuild also writes the gitignored Set B CSV. | The script prints 200 Set A rows. The Set A hash matches the manifest, so the buckets stay 80, 5, 10, 10, 20, 15, 60. The import read every row. No real person is in the file. |
| S1-04 | Run those rows through `importCustomers` in a fresh org. | P0 | COMPLETED | M | S1-03 | `eval/reports/synthetic-360-import-results.json`, regenerated by `eval/syntheticImport.js`. | All 360 rows are attempted. Set A, then Set B anchors, then Set B probes. The process stays up if Firestore has no credentials. Recorded in `SPRINT-TRACKER.md`. |
| S1-05 | Measure the import with the same split the 60-scenario report uses. | P0 | COMPLETED | M | S1-01, S1-04 | `docs/evaluation/s1-05-metric-definitions.md`, `eval/syntheticMetrics.js`, `eval/reports/synthetic-360-metrics.json`, `eval/reports/synthetic-360-metrics-report.md`. | Automatic decisions are hard matches and path B. Reviews are counted as review volume and are not folded into precision or recall. False matches and missed matches are named from the ground truth. The 60-scenario summary is unchanged. Recorded in `SPRINT-TRACKER.md`. |
| S1-06 | Write a second reproducible report. | P0 | COMPLETED | S | S1-05 | `eval/reports/synthetic-200-report.md` (new file). | A second person can regenerate it from the script, the label file, and the documented import command. `benchmark-report.md` is still the 60-scenario report. |
| S1-07 | Pick four demo examples from that run. | P1 | COMPLETED | S | S1-05 | A short list: one exact duplicate, one clear non-match, one review, one ambiguous case. | Each line cites the row, the ground-truth label, the path, and the score from S1-04. |

## Counts

Sprint 0: 7 tasks, 7 COMPLETED.
Sprint 1: 7 tasks, 7 COMPLETED. Sprint status is COMPLETED as of Nov 18, 2026. The second report is `eval/reports/synthetic-200-report.md`. The four demo picks are in `docs/demo/demo-examples.md`. Sprint 1.5 is approved (D-022) and is not on this board.
