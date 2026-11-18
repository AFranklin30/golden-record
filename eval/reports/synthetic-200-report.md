# Sprint 1 benchmark report

Written November 18, 2026, from the committed S1-04 results and the S1-05 measurement. This file is the S1-06 deliverable named in `docs/project-management/TASK-BOARD.md`. The measured set has 360 rows. `eval/reports/benchmark-report.md` remains the 60-scenario report. This file does not replace it.

The first half is for a buyer who will not read the engine. The appendix is for a second person who wants to check every figure. No figure in this file was recomputed with a different method. Each figure is copied from `eval/reports/synthetic-360-metrics.json` or `eval/reports/benchmark-report.json`, and the failure-scenario row lists were checked against `eval/reports/synthetic-360-import-results.json`.

This report does not change the matcher, the thresholds, the policy, the resolver, the importer, the labels, or either result file.

## For a buyer

### What was tested

The test is synthetic. The rows were generated from a written recipe. The emails use `@example.com` and `@example.org`. No customer file and no Thunder file were used.

There are 360 rows.

- Set A is the original 200-row mix: 80 first records, 5 byte-identical copies, 10 nicknames, 10 close spellings, 20 rows with the same name and birthday and a different email, 15 rows with the same name and birthday and no email, and 60 rows with a different first name and a birthday one year later. The recipe is `docs/evaluation/synthetic-dataset-spec.md`.
- Set B is 160 rows: 80 anchors and 80 probes, across 17 scenarios (SFE-1 through CO-3). Set B was built to expose weaknesses in the written matching policy. The measurement file says it does not represent a real-world data distribution and must not be presented as a real-world accuracy estimate.

Import order was Set A rows 1–200, then Set B anchors 201–280, then Set B probes 281–360. All 360 rows were attempted. The engine outcomes in the raw results file are `new` 233, `review` 65, `auto_merge` 47, `import_error` 10, and `replay` 5.

A separate, older check is the 60-scenario benchmark. It is a different population. Its precision is not a baseline for the 360-row file, and the 360-row file is not a replacement for it. Both are reported below.

### How a decision is counted

One probe is one decision about one earlier row, called the anchor. The 160 first records (80 in Set A, 80 in Set B) introduce a person. They are checked, and they stay out of precision and recall.

Four facts are kept apart. They can disagree with each other.

| Fact | What it answers |
|---|---|
| Identity truth | Is this probe the same person as the anchor? The recipe assigns this before any engine run. |
| Policy-expected outcome | What does the written matching policy say should happen? |
| Engine outcome | What did the import do? |
| Import outcome | Was the row stored, returned from an earlier identical row, or rejected? |

The engine followed the written policy on 360 of 360 rows. That is policy conformance. It is not an identity result. A rule can be followed and still join two different people, or store one person twice.

Words used below:

- **Precision.** Of the probes the engine joined automatically to an existing person, the share that really were that person. A review is left out.
- **Recall.** Of the genuine duplicates the engine decided automatically, the share it joined to the right person. A review is left out. A review is not counted as a miss.
- **False merge.** A different person joined automatically to the anchor. There are 19.
- **Missed match.** The same person stored as a new person, with no review. There are 13.
- **Review.** The engine held the row for a person to confirm. Nothing is merged until that confirmation. Reviews are counted as review volume.
- **Found rate.** True automatic joins plus same-person reviews, divided by every same-person probe. This is not recall. The dataset spec defines it this way.

An automatic join is path A. A new person is path B. A review is path C or path D. A replay also stores path B, copied from the earlier row, and the measurement does not count that copy as a new person. On this run, path D was 61 of the 65 reviews and path C was 4.

### The 360-row results

Read Set A and Set B first. The pooled line adds the two counts. It is a sum of two designs. It is not one population.

| | Precision | Recall | False merges | Missed matches | Reviews | Found rate |
|---|---|---|---|---|---|---|
| Set A (200 rows, 120 probes) | 15 / 15 = 1 | 15 / 15 = 1 | 0 | 0 | 40 | 55 / 60 = 0.9167 |
| Set B (160 rows, 80 probes) | 13 / 32 = 0.4063 | 13 / 26 = 0.5 | 19 | 13 | 25 | 22 / 39 = 0.5641 |
| Pooled | 28 / 47 = 0.5957 | 28 / 41 = 0.6829 | 19 | 13 | 65 | 77 / 99 = 0.7778 |

Other pooled counts from the same file: true negatives 60, replays 5, import errors 10. Set A has the 60 true negatives, the 5 replays, and no import errors. Set B has no true negatives, no replays, and all 10 import errors.

Review volume, using the denominator the measurement defines as eligible probes (a probe whose outcome is an automatic join, a review, or a new person): **65 / 185 = 0.3514**. Replays and import errors are outside that denominator. The same 65 reviews are 65 / 200 of all probes (0.325) and 65 / 360 of all rows (0.1806). Of the 65 reviews, 49 are the same person as the anchor and 16 are a different person. None was linked to the wrong fan. Review yield, same-person reviews divided by reviews, is 49 / 65 = 0.7538.

Found rate 77 / 99 uses all 99 same-person probes as the denominator. The 77 are the 28 correct automatic joins plus the 49 same-person reviews. The other 22 same-person probes are the 13 misses, the 5 replays, and the 4 same-person import errors. Those 22 are in the found-rate denominator. They are not in the numerator. Recall's denominator is 41, which is only the 28 correct automatic joins plus the 13 misses.

Set A can show precision 1 and recall 1 while 40 of its same-person probes are reviews and 5 are replays. Those 45 rows are outside both rates. The 15 / 15 covers only the 15 automatic decisions.

Zero errors across Set A's 15 automatic decisions gives an approximate 95% upper bound on the error rate of 3/15 = 0.2 (20%). This is an approximate statistical bound, not a guarantee of real-world performance, and it does not mean the true rate is necessarily below 20%. The bound covers only those 15 automatic decisions. It does not cover Set A's 40 reviews or Set A's 5 replays. The same sentence is printed for Set A recall, because that denominator is the same 15 decisions. The wording is copied from `docs/evaluation/s1-05-metric-definitions.md` and from `eval/reports/synthetic-360-metrics-report.md`.

Set B was designed to produce the 32 observed identity errors: 19 distinct-person probes expected to auto-merge and 13 same-person probes expected to be stored as new. Those 32 rows are the entire error count, and Set B has 0 true negatives. Its purpose is to expose policy weaknesses under adversarial conditions. It does not represent a real-world data distribution and must not be presented as a real-world accuracy estimate.

The label manifest records `disagreement_count` 32. That is the same 19 plus 13. The results file shows no false merge and no miss outside the scenarios in the next table.

### Confusion matrix

Eligible probes only. The 5 replays and the 10 import errors are outside this grid. 28 + 49 + 13 + 19 + 16 + 60 = 185, which is the eligible-probe count.

| Identity truth | Automatic join | Review | New person |
|---|---:|---:|---:|
| Same person | 28 | 49 | 13 |
| Different person | 19 | 16 | 60 |

Same-person automatic join is a true positive. On this run none of those 28 joined a different fan from the anchor. Different-person automatic join is a false merge. Same-person new is a missed match. Different-person new is a true negative.

Held out of the grid: replays, 5 same person and 0 different person; import errors, 4 same person and 6 different person.

All 60 true negatives were never scored. The skip reason on every one is `empty_block`. All 13 missed matches were never scored. The skip reason on every one is `empty_block`.

### Where the 360-row run went wrong

Every probe in a scenario below had the engine outcome in this table. Anchors in the same scenario are first records and are not in the probe counts. The recipe column is the dataset spec, not a new interpretation.

| Scenario | What went wrong | Probe rows | Probes | Identity truth | Engine outcome |
|---|---|---|---:|---|---|
| SFE-2 | False merge. Shared email, different first name, probe birthday missing. | 289–294 | 6 | different person | automatic join, path A |
| SFE-3 | False merge. Shared email, different first name, same birthday. | 295–297 | 3 | different person | automatic join, path A |
| MB-3 | False merge. Anchor has an email and no birthday. Probe has the same name, no email, and a birthday. | 317–321 | 5 | different person | automatic join, path A |
| CA-4 | False merge. Same name and birthday, probe has no email. The label marks these probes `indistinguishable`. | 341–345 | 5 | different person | automatic join, path A |
| MB-2 | Missed match. New email, probe birthday missing. | 312–316 | 5 | same person | new person, path B |
| CO-1 | Missed match. Nickname, birthday month and day swapped, new email. | 349–352 | 4 | same person | new person, path B |
| CO-2 | Missed match. Last-name typo, same birthday, new email. | 353–356 | 4 | same person | new person, path B |
| RP-1 | Import error. Same phone, nothing else shared. | 298–303 | 6 | different person | `import_error`, path B |
| RP-2 | Import error. Same phone, name, and birthday. New email, different ZIP. | 304–307 | 4 | same person | `import_error`, path D |

False merges: 6 + 3 + 5 + 5 = 19. Missed matches: 5 + 4 + 4 = 13. Import errors: 6 + 4 = 10.

The stored error string on each import-error row is `row could not be stored`. The S1-04 record says the process log for those rows named `uq_identifier_per_org`, and that text is not in the results file. The importer was not changed to surface it. A fan id is present on all 10 error rows. The measurement treats that id as not a stored success.

RP-1 probes were not linked to the anchor. Scoring was skipped, reason `empty_block`. RP-2 probes were linked to the anchor, path D, score 0.3, with the stored explanation `scoring performed: name_plus_dob`, and the phone write then failed. Those 4 path D errors stay out of the review count.

MB-3 and MB-4 share the columns an import can see, and they carry opposite identity truth. MB-4 probes are rows 322–326. They are classed as 5 true positives, not as failures. The measurement does not drop the MB-3 rows out of the false-merge count. CA-4's five probes stay in the false-merge count. The `indistinguishable` flag describes them. It does not remove them.

### The 60-scenario benchmark

Source: `eval/reports/benchmark-report.json`, summary object. The matching markdown report prints the same rates as 90.5% and 79.2%.

| Item | Value |
|---|---|
| Scenarios | 60 |
| Policy mismatches | 0 |
| Precision | 0.9048 |
| Recall | 0.7917 |
| Reviews | 27 |
| True positives | 19 |
| False positives | 2 |
| True negatives | 7 |
| False negatives | 5 |

Automatic decisions are hard matches and path B outcomes. A review is left out of precision and recall. 19 / (19 + 2) = 19 / 21, which rounds to 0.9048 by the benchmark's four-decimal rule. 19 / (19 + 5) = 19 / 24, which rounds to 0.7917. The review rate in the markdown report is 45% (27 reviews).

This benchmark and the 360-row measurement use the same idea: automatic decisions in the rates, reviews beside them. They are not a before-and-after pair. The 60-scenario narrative of individual failures stays in `eval/reports/benchmark-report.md`.

### What this measurement does not say

- The rows are a designed synthetic set. A rate here is not a rate for a live fan file, and it is not a measurement of any real customer.
- Set B was designed to provoke the 32 identity errors above. A pooled precision of 28 / 47 describes that mixture. It is not an estimate of accuracy on an ordinary fan file.
- The samples that look perfect are small. Set A's perfect automatic result is 15 decisions. The rule of three used in the S1-05 documents puts an approximate 95% upper bound of 3 / 15 = 0.2 on the error rate in those 15 decisions. The dataset spec states the same rule for a small bucket: with zero errors in n rows, the upper bound is 3 ÷ n. Small scenarios are behavior checks. The ratio is the count over the denominator in that row.
- Reviews were not confirmed or rejected. Precision and recall describe automatic associations only.
- The engine's stored explanation is a short trace label, such as `scoring skipped: deterministic_match` or `scoring performed: name_plus_dob`. It does not include the name, email, or birthday. Five replay rows called no resolver and store no explanation. See `docs/demo/demo-examples.md`.
- No matching rule was changed to improve these numbers. The numbers describe the engine as it stands.

### Known weaknesses

The false merges are SFE-2, SFE-3, MB-3, and CA-4. The missed matches are MB-2, CO-1, and CO-2. The import errors are RP-1 and RP-2. On every one of those rows the engine did what the written policy told it to do. The identity labels disagree on the 32 merge and miss rows. The 10 import errors are the recycled-phone cases: the matcher does not read the phone, and the second write of that phone fails.

Aaron approved Sprint 1.5, Matching Quality Fixes, on November 18, 2026, to address these weaknesses. The sprint is inserted before Sprint 2, which moves Sprints 2, 3, and 4 back. The estimate is 3–5 days and is unverified. The approval is D-022 in `docs/project-management/DECISION-LOG.md`. This report does not list Sprint 1.5's tasks. It does not change a threshold or a signal.

### One correct automatic link

This is not one of the four demo picks. The task board's four picks are in `docs/demo/demo-examples.md`. Row 126 is the earliest correct automatic join in the measurement report, and a buyer should be able to see one.

Row 126, Set A, scenario A-NO-EMAIL, case A-NO-EMAIL-01. The anchor is row 41.

| | First name | Last name | Email | Birthday | ZIP | Phone |
|---|---|---|---|---|---|---|
| Row 41, anchor | Freya | Owens | freya.owens.1@example.com | 1977-03-09 | 73101 | blank |
| Row 126, probe | Freya | Owens | blank | 1977-03-09 | 73101 | blank |

Identity truth is `same_person`. The policy expected `hard_match`, path A. The engine outcome is `auto_merge`, path A, score 1. The score source is `audit_log.confidence_score`. Scoring status is `skipped`, skip reason `deterministic_match`, signals empty. The stored explanation is `scoring skipped: deterministic_match`. The probe was linked to row 41. The label note is: "Same person. The probe has no email, so the name is the singular identifier, and the birthday matches."

The field values are the CSV lines the importer read (`demo/synthetic-customers-200.csv`, which is gitignored). The decision, path, score, and explanation are the committed S1-04 row.

## Technical appendix

### Files and hashes

Checked against `eval/reports/synthetic-360-metrics.json` and `demo/synthetic-dataset-manifest.json`.

| Input | sha256 |
|---|---|
| `demo/synthetic-ground-truth-v2.json` | `0db2aa4810cd02583749830190f8877ca66b0d681882641099c57ac1a92af8b4` |
| Set A CSV | `3fb01339fa4144d63a566c97a39fe3869cd96a1c9d4df86fb288a3a783bf2bc7` |
| Set B CSV | `9c010f0ee4fa88ecc4b6e57f7cae4f8766a42475640e0ba40a02ec9862f062f8` |
| `eval/reports/synthetic-360-import-results.json` | `33afd385694b08a6edfbbaddf015be4b3b605cf727e07c46728a166daf6820ba` |

The metrics file also records that its import-results label hash equals the label hash above. This report was written from `main` at `433071ef13bba9bb637bc7ff5295f6035c3bb72e`. It did not run the import again.

Definitions: `docs/evaluation/s1-05-metric-definitions.md`. Machine-readable counts: `eval/reports/synthetic-360-metrics.json`. The generated prose measurement: `eval/reports/synthetic-360-metrics-report.md`. This markdown file is written by hand. `node eval/syntheticMetrics.js` does not emit it.

### Population

- Rows 360. Probes 200. Same-person probes 99. Distinct-person probes 101. Introductions 160.
- Person keys 261. A key can appear on an introduction and again on a probe. Sizes: 167 keys on one row, 89 on two rows, 5 on three rows. All 5 three-row keys include a replay. The metrics stay pairwise.
- Set A: 200 rows, 120 probes. Set B: 160 rows, 80 probes.
- In the metrics file, every class has the same pair count and person-key count.

Class counts, pooled:

| Class | Count |
|---|---:|
| introduction | 160 |
| introduction_other | 0 |
| replay | 5 |
| import_error | 10 |
| true_positive | 28 |
| false_positive | 19 |
| false_positive_wrong_fan | 0 |
| false_negative | 13 |
| true_negative | 60 |
| review_same_person | 49 |
| review_distinct_person | 16 |
| review_wrong_target_same_person | 0 |
| review_wrong_target_distinct_person | 0 |

Set A class counts: introduction 80, replay 5, true_positive 15, true_negative 60, review_same_person 40, and zeros in the other classes. Set B class counts: introduction 80, import_error 10, true_positive 13, false_positive 19, false_negative 13, review_same_person 9, review_distinct_person 16, and zeros in the other classes.

New records: engine outcome `new` is 233, which is 160 introductions + 60 true negatives + 13 missed matches. Introductions with any other outcome: 0.

### What enters precision and recall

Precision numerator: true positives. Precision denominator: true positives + false positives + same-person automatic joins onto the wrong fan. The wrong-fan count is 0, so the denominator is 28 + 19 = 47.

Recall numerator: true positives. Recall denominator: true positives + false negatives = 28 + 13 = 41.

Left out of both: reviews, replays, import errors, introductions, and true negatives. A same-person review is not a false negative. A distinct-person review is not a false positive.

Decimals are the fraction rounded to four places with `Math.round(value * 10000) / 10000`, the same rule as `eval/benchmark.js`. 28 / 47 rounds to 0.5957. 28 / 41 rounds to 0.6829. 13 / 32 rounds to 0.4063. 13 / 26 is 0.5. 65 / 185 rounds to 0.3514. 77 / 99 rounds to 0.7778.

When a precision or recall denominator is greater than zero and the error count in that ratio is zero, the metrics report prints 3 divided by that denominator. That print is the rule-of-three caveat. It is not a measured error rate. Set A's 3 / 15 is that caveat. The same report prints it on the smaller zero-error scenarios (MB-1, MB-4, CA-2, and the Set A exact-name group). Those lines live in `eval/reports/synthetic-360-metrics-report.md` and are not restated here as extra measurements.

### Policy conformance

The map used by S1-04 and S1-05:

| Policy-expected | Engine outcome |
|---|---|
| `hard_match` | `auto_merge` |
| `review` | `review` |
| `separate` | `new` |
| `import_replay` | `replay` |
| `import_error` | `import_error` |

Policy-expected matched the engine outcome on 360 of 360 rows. Mismatches: 0. The identity class still records `hard_match` on all 28 true positives and on all 19 false positives, and `separate` on all 13 false negatives and all 60 true negatives.

### Scores and explanations

From the results file's own rules:

- When scoring was performed, `score` is `resolution_trace.best_score`.
- When scoring was skipped, `score` is `audit_log.confidence_score` for that resolution.
- A replay copies the stored row score and sets `score_source` to `stored_row`. It does not call the resolver, so `explanation` is null and `explanation_produced` is false.
- `explanation_produced` is true only when the row called the resolver and the trace has a skip reason or a performed scoring record. The text is `scoring skipped: <reason>` or `scoring performed: <signal names>`. It does not include identifier values.

On this run, explanations were produced for 355 rows. The 5 missing explanations are the same-email replays, rows 81–85.

Review scores stored on the 65 review rows: 0 on 18 rows, 0.3 on 43 rows, 1 on 4 rows. A score is the engine's number. It does not decide whether the case was ambiguous. The labels do not mark a review as genuine ambiguity or as an unnecessary intervention. Reviews marked `indistinguishable`: 0. The five `indistinguishable` probes are the CA-4 false merges, and they are automatic joins, not reviews.

A path B score of 1 with skip reason `empty_block` is the stored confidence on a row that was never scored. It is the number in `audit_log.confidence_score`. It is not a statement that a comparison gave a probability of 1.

### Reproduce

A second person can rebuild the labeled files and re-measure the committed import. The metrics command does not need a database. It stops if any hash above differs. It rewrites `eval/reports/synthetic-360-metrics.json` and `eval/reports/synthetic-360-metrics-report.md`. It does not write this file. Compare its counts with the tables above.

```
node scripts/buildSyntheticDemoCsv.js --labels
node eval/syntheticMetrics.js
```

The label command writes `demo/synthetic-ground-truth-v2.json`, the gitignored Set A CSV, the gitignored Set B CSV, and the manifest. It does not call the resolver. The default builder command, without `--labels`, still runs a `scoreMatch` check on Set A and is not the command this report uses.

The committed raw results were produced by this import, recorded in the sprint tracker. It needs the local database. It creates its own org, `synthetic-360-import`. Volatile fields, which change on every run, are `org_id`, `batch_id`, and each row's `fan_id`, `matched_fan_id`, and `conflict_id`.

```
bash scripts/resetLocalDb.sh
env -u FIRESTORE_EMULATOR_HOST -u GOOGLE_APPLICATION_CREDENTIALS -u FIRESTORE_SYNC -u K_SERVICE \
  node --unhandled-rejections=warn eval/syntheticImport.js
```

The 60-scenario numbers are regenerated by `tests/eval.benchmark.test.js`, which rewrites `eval/reports/benchmark-report.md` and `eval/reports/benchmark-report.json`. The summary to compare is 60 scenarios, 0 policy mismatches, precision 0.9048, recall 0.7917, 27 reviews. If the summary matches and the body differs by generated fan ids, restore the committed files. This report does not replace them.

```
env -u FIRESTORE_EMULATOR_HOST -u FIRESTORE_SYNC -u GOOGLE_APPLICATION_CREDENTIALS \
  npx jest --forceExit tests/eval.benchmark.test.js
```
