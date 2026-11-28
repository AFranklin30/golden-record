# Golden Record — Sprint Tracker

Corrected 2026-11-16. Updated Nov 27, 2026 (CT) for the Sprint 1.5 closeout and the S2-00 baseline.

## Current sprint

Sprint 0 is COMPLETED as of Nov 16, 2026. Aaron approved the MVP scope in `SCOPE-AND-BACKLOG.md` as written (S0-06, D-019).

Sprint 1 is COMPLETED as of Nov 18, 2026. It started Nov 16, 2026. S1-01 through S1-07 are COMPLETED. On Nov 16, about 1:04 PM CT, Aaron approved expanding the labeled set from 200 rows to 360 before any engine run (D-021). On Nov 16, about 3:09 PM CT, Aaron approved the import (S1-04). The raw results are recorded. S1-05 measured them against identity truth. S1-06 is the written report. S1-07 is the four demo picks. On Nov 18, 2026, Aaron approved Sprint 1.5, Matching Quality Fixes, inserted before Sprint 2 (D-022). The estimate is 3–5 days and is unverified. Sprints 2, 3, and 4 move back. The Sprint 1.5 task list is in the Sprint 1.5 section below and on `TASK-BOARD.md`.

Sprint 1.5 is COMPLETED as of Nov 27, 2026. Aaron closed it at 11:29 PM CT (D-030). 7 of 9 tasks are COMPLETED. S1.5-07 (D-023 docs and pending fixtures) and S1.5-09 (stable lookup order) are CARRIED TO SPRINT 2, not completed.

Sprint 2 is IN PROGRESS, started Nov 27, 2026. S2-00 (baseline on current `main`) is COMPLETED. All entry gates are met.

Source of truth is `main` at `15c52f9565c5f6771032686191d99c8614bd2b98` (pull request #19 merge, Nov 27, 2026, 11:20 PM CT). `render.yaml` sets `branch: main` (D-020). The Sprint 0 and Sprint 1 records below were written against earlier commits and are unchanged.

## What changed in the correction

`git fetch --all --prune` showed `origin/main` still at `7fa878d092d027c89db4e2020558934b7e03e8aa`. The newer commits are only on `origin/productization/remove-thunder`. They are not ancestors of the first audit branch, and they were not in PR #8 until this correction rebases the docs onto that tip.

`git log --format='%H %cI %s' origin/main..origin/productization/remove-thunder`:

| Commit | Subject |
|---|---|
| `3daab145998db672fbde0e6a2707e75901aa4cbb` | Name-and-birthday agreement stays in review when the email penalty drops the score under 0.60. |
| `11da7ead967bedc3f4e3674ca806f4294f09ffd9` | Labeled nickname pairs. |
| `d121c8ed2c2a821c0e7964242b2491cd56733315` | Live resolve opens review for Bob and Robert when emails differ. |
| `c355ca20886119c083c0ee7c509d5713d9834a04` | Import a customer row through the existing resolver. |
| `5e394acd8baef908073e0ba1b4dcb6bbbd3a9167` | Operator dashboard, one Render service. |
| `751d5b5166bf0b71512f7e9caa2d8b9ff222e625` | Undo a merge and reopen a completed review from the queue. |
| `b388ad419c85e03c5c384590c4403a27b049dc51` | Import stays up when Firestore has no credentials. |
| `cc83b1b97867d70257b2445afd07221d817c996b` | Exact email and exact name are held for review when every stored birthday differs. |

Those commits are on `main` now, through pull request #9 (`15c807618e1d4640816ea8b3bae1c760cd484a78`) and `f867e62921e6332e6e02aeebeacba86351844699`.

## Tasks

| ID | Status |
|---|---|
| S0-01 Inventory of `main` | COMPLETED, then superseded |
| S0-02 Jest on `main` | COMPLETED as a record of the stale commit |
| S0-03 Harness on `main` | COMPLETED as a record of the stale commit |
| S0-04 Customer-data check | COMPLETED |
| S0-05 First docs | COMPLETED, then corrected |
| S0-07 Re-audit `cc83b1b` | COMPLETED |
| S0-06 Aaron approves the MVP scope as written | COMPLETED Nov 16, 2026 |

## Tip verification

Database `postgresql://postgres:postgres@localhost:5432/golden_record` was rebuilt with `scripts/resetLocalDb.sh` from the tip (migrations `001`–`020`, 19 public tables). `node scripts/seedDemoOrg.js` was run first, because `tests/seedDemoOrg.test.js` reads that org and does not create it. `web/` was built so `web/dist/index.html` exists.

`npx jest --forceExit` then printed:

```
Test Suites: 39 passed, 39 total
Tests:       1 skipped, 691 passed, 692 total
```

The benchmark test rewrote `eval/reports/benchmark-report.md` and `eval/reports/benchmark-report.json`. The summary before restore was 60 scenarios, policy mismatches 0, precision 0.9048, recall 0.7917, 27 reviews. The files were restored with `git checkout`.

## Why the first Jest total was 588

That command was `npx jest --runInBand` on `main` (`7fa878d`), not on the tip. `package.json` on `main` is `"test": "jest"` with no extra config. Jest's default pattern runs `*.test.js` only, not `*.smoke.js` or `*.unit.js`. `main` has 24 `*.test.js` files and Jest reported 588 tests. The tip has 39 `*.test.js` files and Jest reported 692 tests. The difference is the commit, not a second package.

The 46 failures on `main` were:

| Count | Suite | Class |
|---|---|---|
| 2 | `tests/modules/resolverEngine.test.js` | Genuine test failures the file itself called pre-existing. The tip rewrites those cases so `scoreMatch` is not expected when there is no block candidate. |
| 5 | `tests/seedDemoOrg.test.js` | Setup. The file requires a demo org that the empty database did not have yet. |
| 39 | blocking, trace, clock, `nfc.identifiers`, and one harness regression | Environment. Jest reported `Could not load the default credentials` at the Firestore `set()` in `resolverEngine.js`. `main` always calls `set()` and the client also rejects a promise outside the `try`. No Firestore emulator is named in `main`'s tests, README, or `package.json`. Pointing `FIRESTORE_EMULATOR_HOST` at a closed port made those tests time out. `gcloud` is not installed here, so the emulator was not started. |

On the tip, `firestoreSyncEnabled()` returns false when `FIRESTORE_SYNC` is not `on` and no credential file and no `K_SERVICE` are present. This machine has no ADC file. The tip run did not need an emulator.

## Sprint 1 plan

Goal: keep the 60-scenario benchmark intact, then measure a 200-record synthetic file with ground truth. No Sprint 2 work.

What already exists on `main`:

- `eval/benchmark.js` classifies a resolver trace. Automatic decisions are hard matches and path B. Reviews stay out of precision and recall. Policy mismatches are counted apart from those rates.
- `tests/eval.benchmark.test.js` runs the 60 cases and rewrites `eval/reports/benchmark-report.md` and `.json`. The committed summary is 60 scenarios, 0 policy mismatches, precision 0.9048, recall 0.7917, 27 reviews.
- `scripts/buildSyntheticDemoCsv.js` builds the original 200 synthetic rows and writes `demo/synthetic-customers-200.csv`. The mix is 80 originals, 5 same-email copies, 10 nicknames, 10 spellings, 20 same name with a different email, 15 name+birthday+zip with no email, and 60 different first name and birthday. The default command still checks those lookalikes with `scoreMatch`. `node scripts/buildSyntheticDemoCsv.js --labels` writes `demo/synthetic-ground-truth-v2.json` from the recipe and does not call `importCustomers` or the scorer. Set B is 160 rows. The spec is `docs/evaluation/synthetic-dataset-spec.md`.
- `*.csv` is gitignored, so the CSV itself will not be committed. The ground-truth file is JSON and is committed.

Written in S1-06 and S1-07:

- `eval/reports/synthetic-200-report.md`, so the 60-scenario files are not overwritten.
- Four demo examples in `docs/demo/demo-examples.md`, taken from that run.

| ID | Title | Status | Size |
|---|---|---|---|
| S1-01 | Re-run the 60-scenario benchmark and confirm it did not move | COMPLETED | S |
| S1-02 | Save ground truth for the existing 200-row mix | COMPLETED | M |
| S1-03 | Generate the CSV with `scripts/buildSyntheticDemoCsv.js` | COMPLETED | S |
| S1-04 | Import the 360 rows through `importCustomers` | COMPLETED | M |
| S1-05 | Measure precision, recall, false matches, missed matches, and review volume | COMPLETED | M |
| S1-06 | Write `eval/reports/synthetic-200-report.md` | COMPLETED | S |
| S1-07 | Pick four demo examples from the import | COMPLETED | S |

Firestore: `firestoreSyncEnabled()` skips the wallet write in the resolver when no credential file exists, and `index.js` ignores a "Could not load the default credentials" rejection. The Jest suite did not need a flag. `node scripts/seedDemoOrg.js` still exited during Scenario 4, because `household.js` writes the child wallet outside that handler. `node --unhandled-rejections=warn scripts/seedDemoOrg.js` finished the seed. That is an environment workaround, not a matcher change.

## S1-01 result

Database `postgresql://postgres:postgres@localhost:5432/golden_record` was rebuilt with `scripts/resetLocalDb.sh`. `web/` was built so `web/dist/index.html` exists. The first `node scripts/seedDemoOrg.js` died on the household Firestore rejection above. The warn rerun completed, then:

```
env -u FIRESTORE_EMULATOR_HOST -u FIRESTORE_SYNC -u GOOGLE_APPLICATION_CREDENTIALS \
  npx jest --forceExit
```

That run, before the ground-truth test existed, printed:

```
Test Suites: 39 passed, 39 total
Tests:       1 skipped, 691 passed, 692 total
```

`tests/eval.benchmark.test.js` rewrote `eval/reports/benchmark-report.md` and `.json`. The summary was 60 scenarios, 0 policy mismatches, precision 0.9048, recall 0.7917, 27 reviews. True positives 19, false positives 2, true negatives 7, false negatives 5. The files were restored with `git checkout`. The body differed by generated fan ids, so it was not committed. The summary matched the committed report. No matcher or fixture file was edited.

After `tests/syntheticGroundTruth.test.js` was added, the same command printed 40 suites, 692 passed, 1 skipped, 693 total. The benchmark summary was unchanged. The extra pass is that new test.

## S1-02 result

`node scripts/buildSyntheticDemoCsv.js --labels` first wrote `demo/synthetic-200-ground-truth.json`. The CSV rows matched the previous script. The 200 rows were not imported.

That first file used one outcome field. Aaron then approved the evaluation-design change (D-021). The same command now writes `demo/synthetic-ground-truth-v2.json`: 360 labels, identity truth and policy-expected outcome kept separate, scenario id and case group on every row. The 200-row file is unchanged. Set A CSV bytes are unchanged. Set B does not go through the `scoreMatch` filter. S1-02 did not import the rows.

After that revision, `npx jest --forceExit` printed 40 suites, 695 passed, 1 skipped, 696 total. The extra passes are the four tests in `tests/syntheticGroundTruth.test.js`. The benchmark summary was again 60 scenarios, 0 policy mismatches, precision 0.9048, recall 0.7917, 27 reviews. The report files were restored.

## S1-03 result

`node scripts/buildSyntheticDemoCsv.js --labels` wrote the Set A CSV, the Set B CSV, and the label file. The label hash was `0db2aa4810cd02583749830190f8877ca66b0d681882641099c57ac1a92af8b4`. The Set A hash was `3fb01339fa4144d63a566c97a39fe3869cd96a1c9d4df86fb288a3a783bf2bc7`. Both match `demo/synthetic-dataset-manifest.json`. The Set B hash `9c010f0ee4fa88ecc4b6e57f7cae4f8766a42475640e0ba40a02ec9862f062f8` matched as well. The tracked label file and manifest did not change. The default builder's `scoreMatch` check was not run.

## S1-04 result

Started from `main` at `526e4aa`. The database `postgresql://postgres:postgres@localhost:5432/golden_record` was rebuilt with `scripts/resetLocalDb.sh`. The import created its own org, `synthetic-360-import`. It did not use the demo org.

```
env -u FIRESTORE_EMULATOR_HOST -u GOOGLE_APPLICATION_CREDENTIALS -u FIRESTORE_SYNC -u K_SERVICE \
  node --unhandled-rejections=warn eval/syntheticImport.js
```

That command rebuilds the dataset, stops if a hash differs, then calls `importCustomers` with the rows from `readCustomerCsv` in manifest order: Set A rows 1–200, Set B anchors 201–280, Set B probes 281–360. It does not call `scoreMatch`. A second run on a new org matched every field except `org_id`, `batch_id`, `fan_id`, `matched_fan_id`, and `conflict_id`.

All 360 rows were attempted. No row crashed the process. Engine outcomes: `new` 233, `review` 65, `auto_merge` 47, `import_error` 10, `replay` 5. A readable trace explanation was produced for 355 rows. The other 5 are the same-email replays. Those rows return the stored result and do not call the resolver, so they do not write a new trace.

The ten `import_error` rows are RP-1 probes 298–303 (path B) and RP-2 probes 304–307 (path D). The recorded error on each is `row could not be stored`. The process log for those rows named `uq_identifier_per_org`. That text is not returned by the importer, and the importer was not changed to surface it.

Policy-expected mapped to an engine outcome as `hard_match` → `auto_merge`, `review` → `review`, `separate` → `new`, `import_replay` → `replay`, and `import_error` → `import_error`. Compared that way, every scenario had zero mismatch rows. This comparison is not a precision or accuracy claim. Identity disagreements that were already in the labels are unchanged.

| Scenario | Rows | Policy expected → engine outcome | Mismatch rows |
|---|---|---|---|
| A-ORIGINAL | 80 | separate → new (80) | none |
| A-SAME-EMAIL | 5 | import_replay → replay (5) | none |
| A-NICKNAME | 10 | review → review (10) | none |
| A-SPELLING | 10 | review → review (10) | none |
| A-SAME-NAME | 20 | review → review (20) | none |
| A-NO-EMAIL | 15 | hard_match → auto_merge (15) | none |
| A-DIFF-DOB | 60 | separate → new (60) | none |
| SFE-1 | 16 | separate → new (8); review → review (8) | none |
| SFE-2 | 12 | separate → new (6); hard_match → auto_merge (6) | none |
| SFE-3 | 6 | separate → new (3); hard_match → auto_merge (3) | none |
| RP-1 | 12 | separate → new (6); import_error → import_error (6) | none |
| RP-2 | 8 | separate → new (4); import_error → import_error (4) | none |
| MB-1 | 8 | separate → new (4); hard_match → auto_merge (4) | none |
| MB-2 | 10 | separate → new (10) | none |
| MB-3 | 10 | separate → new (5); hard_match → auto_merge (5) | none |
| MB-4 | 10 | separate → new (5); hard_match → auto_merge (5) | none |
| CA-1 | 10 | separate → new (5); review → review (5) | none |
| CA-2 | 8 | separate → new (4); hard_match → auto_merge (4) | none |
| CA-3 | 10 | separate → new (5); review → review (5) | none |
| CA-4 | 10 | separate → new (5); hard_match → auto_merge (5) | none |
| CA-5 | 6 | separate → new (3); review → review (3) | none |
| CO-1 | 8 | separate → new (8) | none |
| CO-2 | 8 | separate → new (8) | none |
| CO-3 | 8 | separate → new (4); review → review (4) | none |

No matching logic, threshold, policy, resolver, importer, label, or 60-scenario fixture file was edited.

After the results file was written, the database was reset again and `node --unhandled-rejections=warn scripts/seedDemoOrg.js` seeded the demo org. `web/` was built so `web/dist/index.html` exists. Then:

```
env -u FIRESTORE_EMULATOR_HOST -u FIRESTORE_SYNC -u GOOGLE_APPLICATION_CREDENTIALS \
  npx jest --forceExit
```

That printed 40 suites, 695 passed, 1 skipped, 696 total. `tests/eval.benchmark.test.js` rewrote the benchmark report. The summary was 60 scenarios, 0 policy mismatches, precision 0.9048, recall 0.7917, 27 reviews. The report files and `scripts/demo-org-summary.txt` were restored with `git checkout`.

## S1-05 result

Started from `cursor/s1-04-synthetic-360-import-b942`. The measurement reads the committed S1-04 file. It does not call `importCustomers`, the resolver, or the matcher, and it does not rewrite `eval/reports/synthetic-360-import-results.json`.

```
node scripts/buildSyntheticDemoCsv.js --labels
node eval/syntheticMetrics.js
```

The label sha256, both CSV sha256 values, and the import-results sha256 `33afd385694b08a6edfbbaddf015be4b3b605cf727e07c46728a166daf6820ba` matched the constants in `eval/syntheticMetrics.js`. A second run wrote the same JSON and the same markdown.

The rates are pairwise. One probe is one decision about its anchor. Set A and Set B are printed separately. The pooled line adds those counts. Reviews, replays, and import errors stay out of precision and recall. Definitions: `docs/evaluation/s1-05-metric-definitions.md`. Report: `eval/reports/synthetic-360-metrics-report.md`.

- Set A precision 15 / 15 = 1. Set A recall 15 / 15 = 1. False matches 0. Missed matches 0. Reviews 40. Replays 5.
- Set B precision 13 / 32 = 0.4063. Set B recall 13 / 26 = 0.5. False matches 19. Missed matches 13. Reviews 25. Import errors 10.
- Pooled precision 28 / 47 = 0.5957. Pooled recall 28 / 41 = 0.6829. False matches 19. Missed matches 13.
- Reviews 65 of 185 eligible probes (0.3514). Eligible means a probe whose outcome is auto-merge, review, or new. Same-person reviews 49. Distinct-person reviews 16.
- New records 233: 160 introductions, 60 true negatives, 13 missed matches.
- Import errors 10 and replays 5 are outside those rates. Policy-expected matched the engine outcome on 360 of 360 rows. That match is not an identity result.

No matching logic, threshold, policy, resolver, importer, label, or 60-scenario fixture file was edited.

The database `postgresql://postgres:postgres@localhost:5432/golden_record` was rebuilt with `scripts/resetLocalDb.sh` so the suite could run. `node --unhandled-rejections=warn scripts/seedDemoOrg.js` seeded the demo org. `web/` was built so `web/dist/index.html` exists. Then:

```
env -u FIRESTORE_EMULATOR_HOST -u FIRESTORE_SYNC -u GOOGLE_APPLICATION_CREDENTIALS \
  npx jest --forceExit
```

That printed 41 suites, 698 passed, 1 skipped, 699 total. The three new passes are `tests/syntheticMetrics.test.js`. `tests/eval.benchmark.test.js` rewrote the benchmark report. The summary was 60 scenarios, 0 policy mismatches, precision 0.9048, recall 0.7917, 27 reviews. The report files and `scripts/demo-org-summary.txt` were restored with `git checkout`.

## S1-06 result

Started from `main` at `433071ef13bba9bb637bc7ff5295f6035c3bb72e`. No matching logic, threshold, policy, resolver, importer, label, 360-row result file, or 60-scenario fixture was edited.

The report is `eval/reports/synthetic-200-report.md`. The task board names that path. The measured set is the 360-row file. `eval/reports/benchmark-report.md` is still the 60-scenario report.

The figures are copied from `eval/reports/synthetic-360-metrics.json`, `eval/reports/synthetic-360-metrics-report.md`, `eval/reports/synthetic-360-import-results.json`, and `eval/reports/benchmark-report.json`. They were not recomputed with a different method. The failure-scenario probe rows in the results file match the table: false merges SFE-2 (289–294), SFE-3 (295–297), MB-3 (317–321), and CA-4 (341–345); missed matches MB-2 (312–316), CO-1 (349–352), and CO-2 (353–356); import errors RP-1 (298–303) and RP-2 (304–307).

Set A precision 15 / 15, recall 15 / 15. Set B precision 13 / 32, recall 13 / 26. Pooled precision 28 / 47, recall 28 / 41. False merges 19. Missed matches 13. Reviews 65 / 185. Found rate 77 / 99. The 60-scenario summary cited in the report is 60 scenarios, 0 policy mismatches, precision 0.9048, recall 0.7917, 27 reviews.

`node scripts/buildSyntheticDemoCsv.js --labels` rewrote the label file in place. The label sha256 stayed `0db2aa4810cd02583749830190f8877ca66b0d681882641099c57ac1a92af8b4`. The tracked label file and manifest were unchanged. The CSVs stayed gitignored.

The reproduction commands are in the report. `node eval/syntheticMetrics.js` regenerates the S1-05 metrics files. It does not emit the S1-06 report. A second person compares the two.

The database `postgresql://postgres:postgres@localhost:5432/golden_record` was rebuilt with `scripts/resetLocalDb.sh`. `node --unhandled-rejections=warn scripts/seedDemoOrg.js` seeded the demo org. The household child write logged the expected missing-credentials rejection and the seed finished. `web/` was built so `web/dist/index.html` exists. Then:

```
env -u FIRESTORE_EMULATOR_HOST -u FIRESTORE_SYNC -u GOOGLE_APPLICATION_CREDENTIALS -u K_SERVICE \
  npx jest --forceExit
```

That printed 41 suites, 698 passed, 1 skipped, 699 total. `tests/eval.benchmark.test.js` rewrote the benchmark report. The summary was 60 scenarios, 0 policy mismatches, precision 0.9048, recall 0.7917, 27 reviews. True positives 19, false positives 2, true negatives 7, false negatives 5. The report files and `scripts/demo-org-summary.txt` were restored with `git checkout`. The 360-row result files were not rewritten. No matcher or fixture file was edited.

## S1-07 result

The four picks are in `docs/demo/demo-examples.md`. The task board's list is the one used: an exact duplicate, a clear non-match, a review, and an ambiguous case.

| Pick | Row | Case | Ground truth | Path | Score |
|---|---|---|---|---|---|
| Exact duplicate | 81, anchor 1 | A-SAME-EMAIL-01 | `same_person`, policy `import_replay` | B | 1, source `stored_row` |
| Clear non-match | 141, anchor 1 | A-DIFF-DOB-01 | `distinct_person`, policy `separate` | B | 1, source `audit_log.confidence_score` |
| Review | 86, anchor 1 | A-NICKNAME-01 | `same_person`, policy `review` | D | 0.3, source `resolution_trace.best_score` |
| Ambiguous case | 341, anchor 261 | CA-4-01 | `distinct_person`, policy `hard_match`, `indistinguishable` true | A | 1, source `audit_log.confidence_score` |

Row 81 stores no explanation. `explanation_produced` is false and `explanation` is null, because the resolver was not called. The other three store `scoring skipped: empty_block`, `scoring performed: name_plus_dob`, and `scoring skipped: deterministic_match`. The CSV field values are quoted from the rebuilt gitignored CSVs. The results file does not store them.

Row 341 is a false merge. The demo labels it as a known weakness covered by Sprint 1.5. Row 126, the earliest correct automatic join, is in the S1-06 report and is not one of the four picks. The kickoff asked for a correct automatic join in the four. The task board does not. The board's list is the one in the demo file.

## Remaining

Sprint 1's task list is complete. Do not treat the S1-04 policy comparison as the identity measurement. The identity measurement is the S1-05 report. The buyer write-up of that measurement is the S1-06 report.

## Sprint 1.5

Sprint 1.5 is COMPLETED as of Nov 27, 2026, closed by Aaron at 11:29 PM CT (D-030). It started Nov 18, 2026. S1.5-03 and S1.5-05 were run on Nov 22, 2026. S1.5 IDs other than S1.5-03 and S1.5-05 are PM labels from planning notes and commit history. They are not defined anywhere else in the repo. Titles follow `TASK-BOARD.md`.

| ID | Status |
|---|---|
| S1.5-01 Record the approved policy decisions in the failure analysis | COMPLETED |
| S1.5-02 Record the candidate-retrieval requirements and one-edit surname retrieval | COMPLETED |
| S1.5-03 False-merge rules in the matcher | COMPLETED (PR #15) |
| S1.5-04 One test per new rule, and the policy doc updated | COMPLETED (PR #15) |
| S1.5-05 Re-run the 360-row identity metrics | COMPLETED |
| S1.5-06 Review and update the project docs | COMPLETED (PR #19, merge `15c52f9`, Nov 27, 2026, 11:20 PM CT) |
| S1.5-07 D-023 policy docs and pending fixtures | CARRIED TO SPRINT 2 (dependency of S2-06a). Not completed. |
| S1.5-08 Reconcile the stale fixture expectations | COMPLETED (PR #16) |
| S1.5-09 Stable lookup order for the same-name lookup | CARRIED TO SPRINT 2 (acceptance item 9 of S2-06a). Not completed. |

### S1.5-03 and S1.5-05 result

The matcher now holds the approved cases for review. The numbers below are the measured re-run. The old S1-05 files were not replaced.

| | S1-05 baseline | After S1.5-03 |
|---|---|---|
| Jest | 698 passed, 1 skipped | 720 passed, 8 failed, 1 skipped, 729 total |
| 60-scenario benchmark | 60 scenarios, 0 mismatches, P 0.9048, R 0.7917, 27 reviews | 60 scenarios, 5 mismatches, P 0.875, R 0.7368, 32 reviews |
| Pooled precision | 28/47 | 8/8 |
| Pooled recall | 28/41 | 8/8 |
| False merges | 19 | 0 |
| Missed matches | 13 | 0 |
| Reviews | 65/185 | 117/185 |
| Found | 77/99 | 90/99 |

The 8 Jest failures are `tests/eval.benchmark.test.js` and `tests/eval.level2.test.js`. Those fixtures still expected the old hard matches when this was written, and were not edited then. PR #16 reconciled them later. Detail is in `eval/reports/sprint-1.5-rerun-report.md`.

8/8 is every remaining automatic decision. It is not a claim that the hard cases were solved. Those cases are in the 117 reviews. Set A has no remaining automatic decision, so its precision and recall are null. The metrics rule of three on 8/8 is 3/8.

## S2-00 result (Sprint 2 baseline)

Date: Nov 27, 2026 (CT), on `main` at `15c52f9565c5f6771032686191d99c8614bd2b98` (pull request #19 merge). Run by Antigravity in Aaron's terminal. **The results below were reported by Antigravity. PM did not re-run them. The command list below was also reported by Antigravity.**

### Commands

These are the exact commands Antigravity ran, as reported in its log (Nov 28, 2026). No environment-variable wrappers were used.

```
git checkout main && git pull
scripts/resetLocalDb.sh
node --unhandled-rejections=warn scripts/seedDemoOrg.js
npm --prefix web run build && npm --prefix web test
npx jest --forceExit
node --unhandled-rejections=warn eval/syntheticImport.js
node eval/syntheticMetrics.js   # exited 2 on EXPECTED.import_results_sha256; metrics then computed via exported joinRows + evaluate
git checkout -- eval/reports
git checkout -- scripts/demo-org-summary.txt
git status
```

The 360-row metrics were computed through the exported `joinRows` and `evaluate` functions in `eval/syntheticMetrics.js`, with no file edits (see the hash note below). `eval/reports` and `scripts/demo-org-summary.txt` were restored with `git checkout`, and the working tree was clean (reported).

### Results (reported)

| | Value |
|---|---|
| Jest | 45 of 45 suites. 739 passed, 0 failed, 1 skipped (740). |
| Vitest | 10 files, 34 of 34. |
| Web build | ok |
| 60-scenario benchmark | 60 scenarios. 0 policy mismatches. Precision 0.875 (14 true positives, 2 false positives). Recall 0.7368 (14 true positives, 5 false negatives). 32 reviews. |
| 360-row outcomes | new 220, replay 5, review 117, import_error 10, auto_merge 8 (360 total) |
| 360-row identity | False merges 0. Missed matches 0. Reviews 117 of 185 (82 same person, 35 different people, 0 wrong target). Found 90 of 99. Automatic decisions 8, all correct. |

### How it compares

| | S1-05 baseline | After S1.5-03 (PR #15, Nov 22) | S2-00 (`15c52f9`, reported) |
|---|---|---|---|
| Jest | 698 passed, 1 skipped | 720 passed, 8 failed, 1 skipped | 739 passed, 0 failed, 1 skipped |
| 60-scenario benchmark | 0 mismatches, P 0.9048, R 0.7917, 27 reviews | 5 mismatches, P 0.875, R 0.7368, 32 reviews | 0 mismatches, P 0.875, R 0.7368, 32 reviews |
| False merges | 19 | 0 | 0 |
| Missed matches | 13 | 0 | 0 |
| Reviews | 65 of 185 | 117 of 185 | 117 of 185 |
| Found | 77 of 99 | 90 of 99 | 90 of 99 |

The 360-row identity results did not move after PR #15, so PR #16, #17, #18 and #19 did not change them (reported). 8 of 8 automatic decisions correct is every remaining automatic decision. It is not a claim that the hard cases were solved. They are in the 117 reviews. The rule of three on a perfect 8 is 3/8. All data is synthetic.

### Hash pin note

`eval/syntheticMetrics.js` pins `EXPECTED.import_results_sha256` to the S1-04 file (`33afd385...`). The fresh import hashed `865f6d1e...`. The script's own run therefore does not pass its check. The metrics were computed through the exported `joinRows` and `evaluate`, with no file edits. A small P2 backlog item (BL-01 on `TASK-BOARD.md`) covers making the pin optional or updatable. No change was made now.

This is the baseline that S2-06a compares against: 0 false merges, 0 missed matches, 117 reviews of 185, 90 of 99 found, 8 automatic decisions, benchmark 0 mismatches and 32 reviews.
