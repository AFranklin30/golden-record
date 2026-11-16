# Golden Record — Task Board

Updated Nov 16, 2026. Status values: NOT STARTED, IN PROGRESS, BLOCKED, COMPLETED, DEFERRED.

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
| 200-row builder | `scripts/buildSyntheticDemoCsv.js` | Writes `demo/synthetic-customers-200.csv` (80 originals, 5 same-email copies, 10 nicknames, 10 spellings, 20 same-name different emails, 15 name+birthday+zip with no email, 60 different first name and birthday). It checks some pairs with `scoreMatch` and then discards those results. It does not save ground truth and it does not call the resolver. |
| Importer | `importCustomers` in `src/modules/customerImport.js` | This is the engine run for a CSV. Sprint 1 uses it. It is not a new adapter. |
| Firestore skip | `firestoreSyncEnabled()` in `src/modules/resolverEngine.js`, and the credential rejection handler in `index.js` | `node scripts/seedDemoOrg.js` on current `main` should not need a flag when no credential file exists. On `main` at `7fa878d`, before `b388ad4`, the seed died unless Node was started with `--unhandled-rejections=warn`. Use that flag only if a credential rejection still kills the process. |

`*.csv` is gitignored. The 200-row file stays local. Ground truth has to be a non-CSV file if it is committed.

## Sprint 1 — IN PROGRESS, started Nov 16, 2026

Do not change `eval/fixtures/benchmarkCases.js`, `eval/benchmark.js` metric rules, or the matcher. Do not overwrite `eval/reports/benchmark-report.md`.

| ID | Description | Priority | Status | Size | Depends on | Deliverable | Acceptance |
|---|---|---|---|---|---|---|---|
| S1-01 | Re-run the existing 60-scenario benchmark on `main` and record the result. | P0 | NOT STARTED | S | S0-06 | A note of the command and the summary next to the committed report. | `tests/eval.benchmark.test.js` passes. Summary stays 60 scenarios, 0 policy mismatches, precision 0.9048, recall 0.7917, 27 reviews. No matcher or fixture edit. |
| S1-02 | Save ground truth for the 200-row mix the script already builds. | P0 | NOT STARTED | M | S1-01 | A checked-in label file (not CSV) keyed to row number: same person as which original, or a different person, and whether the intended outcome is a hard match, a review, or a separation. | Every one of the 200 rows has one label. The 5 same-email copies, the nickname, spelling, same-name, no-email, and different-birthday buckets are all labeled. Labels are not inferred from a later engine run. |
| S1-03 | Generate the CSV by running the existing script. | P0 | NOT STARTED | S | S1-02 | `demo/synthetic-customers-200.csv` on disk. | The script prints 200 rows. Bucket sizes stay 80, 5, 10, 10, 20, 15, 60. Every row passes `parseCustomerRow`. No real person is in the file. |
| S1-04 | Run those rows through `importCustomers` in a fresh org. | P0 | NOT STARTED | M | S1-03 | One import batch and a per-row outcome (path, score, conflict id or none). | All 200 rows are attempted. Originals are loaded before the lookalikes. The process stays up if Firestore has no credentials. If a credential rejection still kills it, rerun with `node --unhandled-rejections=warn`. |
| S1-05 | Measure the import with the same split the 60-scenario report uses. | P0 | NOT STARTED | M | S1-01, S1-04 | Counts for precision, recall, false matches, missed matches, and review volume, plus the definition used. | Automatic decisions are hard matches and path B. Reviews are counted as review volume and are not folded into precision or recall. False matches and missed matches are named from the ground truth. The 60-scenario summary is unchanged. |
| S1-06 | Write a second reproducible report. | P0 | NOT STARTED | S | S1-05 | `eval/reports/synthetic-200-report.md` (new file). | A second person can regenerate it from the script, the label file, and the documented import command. `benchmark-report.md` is still the 60-scenario report. |
| S1-07 | Pick four demo examples from that run. | P1 | NOT STARTED | S | S1-05 | A short list: one exact duplicate, one clear non-match, one review, one ambiguous case. | Each line cites the row, the ground-truth label, the path, and the score from S1-04. |

## Counts

Sprint 0: 7 tasks, 7 COMPLETED.
Sprint 1: 7 tasks, 0 COMPLETED, 7 NOT STARTED. Sprint status is IN PROGRESS because it has started as planning; implementation has not.
