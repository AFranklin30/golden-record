# Synthetic 360 identity-resolution metrics

Pairwise measurement of the committed S1-04 import against the recipe labels. Identity truth, the policy-expected outcome, the engine outcome, and the import outcome are kept apart. Definitions: `docs/evaluation/s1-05-metric-definitions.md`.

## Inputs

- Label sha256: `0db2aa4810cd02583749830190f8877ca66b0d681882641099c57ac1a92af8b4`.
- Set A CSV sha256: `3fb01339fa4144d63a566c97a39fe3869cd96a1c9d4df86fb288a3a783bf2bc7`.
- Set B CSV sha256: `9c010f0ee4fa88ecc4b6e57f7cae4f8766a42475640e0ba40a02ec9862f062f8`.
- Import results sha256: `33afd385694b08a6edfbbaddf015be4b3b605cf727e07c46728a166daf6820ba`.
- Import results label sha256: `0db2aa4810cd02583749830190f8877ca66b0d681882641099c57ac1a92af8b4`.
- The evaluator read the committed results file. It did not run the import again.

## Population

- Rows: 360.
- Probes: 200 (99 same person, 101 distinct person).
- Introductions: 160.
- Person keys: 261. A key can appear on an introduction and again on a probe.
- Set A: 200 rows, 120 probes.
- Set B: 160 rows, 80 probes.

The rates below are pairwise: one probe, one anchor, one decision. Record counts are printed next to them. Auto-merge means path A associated the probe with an existing fan. No review was confirmed.

## Precision and recall

Set A and Set B are the figures to read. The pooled line adds the same counts. It is not one population.

- Set A precision: 15 / 15 = 1; zero errors across these 15 automatic decisions gives an approximate 95% upper bound on the error rate of 3/15 = 0.2 (20%). This is an approximate statistical bound, not a guarantee of real-world performance, and it does not mean the true rate is necessarily below 20%.
- Set A recall: 15 / 15 = 1; zero errors across these 15 automatic decisions gives an approximate 95% upper bound on the error rate of 3/15 = 0.2 (20%). This is an approximate statistical bound, not a guarantee of real-world performance, and it does not mean the true rate is necessarily below 20%.
- Set A found rate: 55 / 60 = 0.9167.
- Set A counts: TP 15, FP 0, FN 0, TN 60, reviews 40, replays 5, import errors 0.
The 3/15 bound covers only Set A's 15 automatic decisions. It does not cover Set A's 40 reviews or Set A's 5 replays.
- Set B precision: 13 / 32 = 0.4063.
- Set B recall: 13 / 26 = 0.5.
- Set B found rate: 22 / 39 = 0.5641.
- Set B counts: TP 13, FP 19, FN 13, TN 0, reviews 25, replays 0, import errors 10.
Set B was designed to produce the 32 observed identity errors: 19 distinct-person probes expected to auto-merge and 13 same-person probes expected to be stored as new. Those 32 rows are the entire error count, and Set B has 0 true negatives. Its purpose is to expose policy weaknesses under adversarial conditions. It does not represent a real-world data distribution and must not be presented as a real-world accuracy estimate.
- Pooled precision: 28 / 47 = 0.5957.
- Pooled recall: 28 / 41 = 0.6829.
- Pooled found rate: 77 / 99 = 0.7778.
- Pooled counts: TP 28, FP 19, FN 13, TN 60, reviews 65, replays 5, import errors 10.

False matches: 19. Distinct-person auto-merges: 19 (19 linked to the anchor, 0 linked elsewhere). Same-person auto-merges onto another fan: 0.

Missed matches: 13. These are same-person probes stored as new people. Same-person reviews held out of recall: 49.

Found rate follows the dataset spec: true positives plus same-person reviews, divided by all same-person probes. It is not recall. Set A and Set B use that same denominator. The earlier pooled denominator was 77 / 90. It left out 5 same-person import replays and 4 RP-2 import errors. Neither group is a review. Replay rows in the review count: 0. Import-error rows in the review count: 0.

Recall leaves out same-person reviews, replays, and import errors. Set A recall can be 1 while many same-person probes are reviews or replays. Those exclusions are the counts above.

## Review volume

- Reviews: 65.
- Eligible probes: 185. Eligible means a probe whose engine outcome is auto-merge, review, or new.
- Reviews as a share of eligible probes: 65 / 185 = 0.3514.
- Reviews as a share of all probes: 65 / 200 = 0.325.
- Reviews as a share of all rows: 65 / 360 = 0.1806.
- Same person, linked to the anchor: 49.
- Different person, linked to the anchor: 16.
- Wrong target: 0.
- Reviews marked indistinguishable: 0.
- Review yield (same-person reviews linked to the anchor / reviews): 49 / 65 = 0.7538.
- Review paths: {"D":61,"C":4}.
- Review scores: {"0":18,"1":4,"0.3":43}. A score is the engine's number. It does not decide whether the case was ambiguous.

The labels do not mark a review as genuine ambiguity or as an unnecessary intervention. A same-person review is a real duplicate the engine did not merge. A distinct-person review is two different people the engine did not merge.

## Confusion matrix

Eligible probes only. Replays and import errors are outside this grid.

| Identity truth | Auto-merge | Review | New |
|---|---:|---:|---:|
| Same person | 28 | 49 | 13 |
| Distinct person | 19 | 16 | 60 |

Same-person auto-merge in this grid is a true positive plus any same-person auto-merge onto the wrong fan. Distinct-person auto-merge is a false match. Same-person new is a missed match. Distinct-person new is a true negative.

Held out of the grid: replays 5 same person and 0 distinct person; import errors 4 same person and 6 distinct person.

True negatives never scored: 60 of 60. Skip reasons: {"empty_block":60}.

Missed matches never scored: 13 of 13. Skip reasons: {"empty_block":13}.

## New records

- Engine outcome new: 233.
- Introductions: 160.
- Introductions with another outcome: 0.
- Distinct probes stored as new people: 60.
- Same-person probes stored as new people: 13.

## Import errors

Rows: 10. Fan id present on 10. Resolver called on 10. A fan id on an error row is not counted as a stored person. These rows are outside precision, recall, review volume, and new-record totals.

- RP-1: 6 rows, identity {"distinct_person":6}, path {"B":6}, error {"row could not be stored":6}, scoring {"skipped":6}, skip reason {"empty_block":6}, linked to the anchor 0.
- RP-2: 4 rows, identity {"same_person":4}, path {"D":4}, error {"row could not be stored":4}, scoring {"performed":4}, skip reason {"none":4}, linked to the anchor 4.

## Replays

Rows: 5. Same person: 5. Linked to the anchor: 5. Resolver called: 0. Paths: {"B":5}.

A replay returns the earlier row. It is not a new person and it is not a duplicate-detection success.

## Scenario groups

| Group | Rows | Probes | Eligible | TP | FP | FN | TN | Reviews | Precision | Recall | Reviews / eligible |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| first_seen | 80 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a (denominator 0) | n/a (denominator 0) | n/a (denominator 0) |
| idempotency | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | n/a (denominator 0) | n/a (denominator 0) | n/a (denominator 0) |
| floor_review | 40 | 40 | 40 | 0 | 0 | 0 | 0 | 40 | n/a (denominator 0) | n/a (denominator 0) | 40 / 40 = 1 |
| exact_name | 15 | 15 | 15 | 15 | 0 | 0 | 0 | 0 | 15 / 15 = 1; zero errors across these 15 automatic decisions gives an approximate 95% upper bound on the error rate of 3/15 = 0.2 (20%). This is an approximate statistical bound, not a guarantee of real-world performance, and it does not mean the true rate is necessarily below 20% | 15 / 15 = 1; zero errors across these 15 automatic decisions gives an approximate 95% upper bound on the error rate of 3/15 = 0.2 (20%). This is an approximate statistical bound, not a guarantee of real-world performance, and it does not mean the true rate is necessarily below 20% | 0 / 15 = 0 |
| easy_negative | 60 | 60 | 60 | 0 | 0 | 0 | 60 | 0 | n/a (denominator 0) | n/a (denominator 0) | 0 / 60 = 0 |
| shared_family_email | 34 | 17 | 17 | 0 | 9 | 0 | 0 | 8 | 0 / 9 = 0 | n/a (denominator 0) | 8 / 17 = 0.4706 |
| recycled_phone | 20 | 10 | 0 | 0 | 0 | 0 | 0 | 0 | n/a (denominator 0) | n/a (denominator 0) | n/a (denominator 0) |
| missing_birthday | 38 | 19 | 19 | 9 | 5 | 5 | 0 | 0 | 9 / 14 = 0.6429 | 9 / 14 = 0.6429 | 0 / 19 = 0 |
| conflicting_attributes | 44 | 22 | 22 | 4 | 5 | 0 | 0 | 13 | 4 / 9 = 0.4444 | 4 / 4 = 1; zero errors in 4, rule-of-three upper bound 3 / 4 = 0.75 | 13 / 22 = 0.5909 |
| combination | 24 | 12 | 12 | 0 | 0 | 8 | 0 | 4 | n/a (denominator 0) | 0 / 8 = 0 | 4 / 12 = 0.3333 |

## Scenarios

Probe decisions only. Anchor rows in the same scenario are introductions and stay out of these rates.

| Scenario | Probes | Introductions | TP | FP | FN | TN | Reviews | Replays | Import errors | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| A-ORIGINAL | 0 | 80 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a (denominator 0) | n/a (denominator 0) |
| A-SAME-EMAIL | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | n/a (denominator 0) | n/a (denominator 0) |
| A-NICKNAME | 10 | 0 | 0 | 0 | 0 | 0 | 10 | 0 | 0 | n/a (denominator 0) | n/a (denominator 0) |
| A-SPELLING | 10 | 0 | 0 | 0 | 0 | 0 | 10 | 0 | 0 | n/a (denominator 0) | n/a (denominator 0) |
| A-SAME-NAME | 20 | 0 | 0 | 0 | 0 | 0 | 20 | 0 | 0 | n/a (denominator 0) | n/a (denominator 0) |
| A-NO-EMAIL | 15 | 0 | 15 | 0 | 0 | 0 | 0 | 0 | 0 | 15 / 15 = 1; zero errors across these 15 automatic decisions gives an approximate 95% upper bound on the error rate of 3/15 = 0.2 (20%). This is an approximate statistical bound, not a guarantee of real-world performance, and it does not mean the true rate is necessarily below 20% | 15 / 15 = 1; zero errors across these 15 automatic decisions gives an approximate 95% upper bound on the error rate of 3/15 = 0.2 (20%). This is an approximate statistical bound, not a guarantee of real-world performance, and it does not mean the true rate is necessarily below 20% |
| A-DIFF-DOB | 60 | 0 | 0 | 0 | 0 | 60 | 0 | 0 | 0 | n/a (denominator 0) | n/a (denominator 0) |
| SFE-1 | 8 | 8 | 0 | 0 | 0 | 0 | 8 | 0 | 0 | n/a (denominator 0) | n/a (denominator 0) |
| SFE-2 | 6 | 6 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 0 / 6 = 0 | n/a (denominator 0) |
| SFE-3 | 3 | 3 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 / 3 = 0 | n/a (denominator 0) |
| RP-1 | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | n/a (denominator 0) | n/a (denominator 0) |
| RP-2 | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | n/a (denominator 0) | n/a (denominator 0) |
| MB-1 | 4 | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 4 / 4 = 1; zero errors in 4, rule-of-three upper bound 3 / 4 = 0.75 | 4 / 4 = 1; zero errors in 4, rule-of-three upper bound 3 / 4 = 0.75 |
| MB-2 | 5 | 5 | 0 | 0 | 5 | 0 | 0 | 0 | 0 | n/a (denominator 0) | 0 / 5 = 0 |
| MB-3 | 5 | 5 | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 0 / 5 = 0 | n/a (denominator 0) |
| MB-4 | 5 | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 5 / 5 = 1; zero errors in 5, rule-of-three upper bound 3 / 5 = 0.6 | 5 / 5 = 1; zero errors in 5, rule-of-three upper bound 3 / 5 = 0.6 |
| CA-1 | 5 | 5 | 0 | 0 | 0 | 0 | 5 | 0 | 0 | n/a (denominator 0) | n/a (denominator 0) |
| CA-2 | 4 | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 4 / 4 = 1; zero errors in 4, rule-of-three upper bound 3 / 4 = 0.75 | 4 / 4 = 1; zero errors in 4, rule-of-three upper bound 3 / 4 = 0.75 |
| CA-3 | 5 | 5 | 0 | 0 | 0 | 0 | 5 | 0 | 0 | n/a (denominator 0) | n/a (denominator 0) |
| CA-4 | 5 | 5 | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 0 / 5 = 0 | n/a (denominator 0) |
| CA-5 | 3 | 3 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | n/a (denominator 0) | n/a (denominator 0) |
| CO-1 | 4 | 4 | 0 | 0 | 4 | 0 | 0 | 0 | 0 | n/a (denominator 0) | 0 / 4 = 0 |
| CO-2 | 4 | 4 | 0 | 0 | 4 | 0 | 0 | 0 | 0 | n/a (denominator 0) | 0 / 4 = 0 |
| CO-3 | 4 | 4 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | n/a (denominator 0) | n/a (denominator 0) |

In this file, every class has the same pair count and person-key count. A person key is not split across two rows of one class.

## Policy conformance

Policy-expected outcome matched the engine outcome on 360 of 360 rows. Mismatches: 0.

This table is not an identity result. A matching policy can still auto-merge two different people, or store one person as two.

| Identity class | Policy-expected counts |
|---|---|
| introduction | {"separate":160} |
| replay | {"import_replay":5} |
| import_error | {"import_error":10} |
| true_positive | {"hard_match":28} |
| false_positive | {"hard_match":19} |
| false_negative | {"separate":13} |
| true_negative | {"separate":60} |
| review_same_person | {"review":49} |
| review_distinct_person | {"review":16} |

## Examples

Each example is the earliest row in file order for that rule.

### Correct automatic association

Row 126, set A, scenario A-NO-EMAIL, group exact_name, case A-NO-EMAIL-01.

- Identity truth: same_person.
- Policy-expected: hard_match.
- Engine outcome: auto_merge, path A, score 1.
- Class: true_positive. Linked to the anchor: true. Indistinguishable: false.
- Skip reason: deterministic_match.
- Trace explanation: scoring skipped: deterministic_match.
- Label note: Same person. The probe has no email, so the name is the singular identifier, and the birthday matches.

### Correct separation

Row 141, set A, scenario A-DIFF-DOB, group easy_negative, case A-DIFF-DOB-01.

- Identity truth: distinct_person.
- Policy-expected: separate.
- Engine outcome: new, path B, score 1.
- Class: true_negative. Linked to the anchor: false. Indistinguishable: false.
- Skip reason: empty_block.
- Trace explanation: scoring skipped: empty_block.
- Label note: Different person. Different first name and a birthday one year later, so no block key hits. Never scored.

### Incorrect automatic association

Row 289, set B, scenario SFE-2, group shared_family_email, case SFE-2-01.

- Identity truth: distinct_person.
- Policy-expected: hard_match.
- Engine outcome: auto_merge, path A, score 1.
- Class: false_positive. Linked to the anchor: true. Indistinguishable: false.
- Skip reason: deterministic_match.
- Trace explanation: scoring skipped: deterministic_match.
- Label note: Distinct family member, shared email, probe birthday missing. A missing birthday keeps the email hard match.

### Incorrect automatic association marked indistinguishable

Row 341, set B, scenario CA-4, group conflicting_attributes, case CA-4-01.

- Identity truth: distinct_person.
- Policy-expected: hard_match.
- Engine outcome: auto_merge, path A, score 1.
- Class: false_positive. Linked to the anchor: true. Indistinguishable: true.
- Skip reason: deterministic_match.
- Trace explanation: scoring skipped: deterministic_match.
- Label note: Distinct namesake, same name and birthday, probe has no email. Exact name plus the same birthday is a hard match. The fields on the probe do not separate the two people.

### Missed duplicate

Row 312, set B, scenario MB-2, group missing_birthday, case MB-2-01.

- Identity truth: same_person.
- Policy-expected: separate.
- Engine outcome: new, path B, score 1.
- Class: false_negative. Linked to the anchor: false. Indistinguishable: false.
- Skip reason: empty_block.
- Trace explanation: scoring skipped: empty_block.
- Label note: Same person, new email, probe birthday missing. The email misses and there is no birthday to block on, so the row is new.

### Same person held for review

Row 86, set A, scenario A-NICKNAME, group floor_review, case A-NICKNAME-01.

- Identity truth: same_person.
- Policy-expected: review.
- Engine outcome: review, path D, score 0.3.
- Class: review_same_person. Linked to the anchor: true. Indistinguishable: false.
- Trace explanation: scoring performed: name_plus_dob.
- Label note: Same person, nickname, different email and ZIP, same birthday. The name and birthday keep a low score in review.

### Different people held for review

Row 281, set B, scenario SFE-1, group shared_family_email, case SFE-1-01.

- Identity truth: distinct_person.
- Policy-expected: review.
- Engine outcome: review, path D, score 0.
- Class: review_distinct_person. Linked to the anchor: true. Indistinguishable: false.
- Trace explanation: scoring performed: dob_veto.
- Label note: Distinct family member, shared email, both birthdays present and different. The email birthday review opens. The original person keeps the email.

### Replay of an earlier row

Row 81, set A, scenario A-SAME-EMAIL, group idempotency, case A-SAME-EMAIL-01.

- Identity truth: same_person.
- Policy-expected: import_replay.
- Engine outcome: replay, path B, score 1.
- Class: replay. Linked to the anchor: true. Indistinguishable: false.
- Skip reason: empty_block.
- Label note: Byte-identical copy of the anchor. The import row key matches, so the resolver is not called and the stored path stays the anchor path B.

### Import error for a different person

Row 298, set B, scenario RP-1, group recycled_phone, case RP-1-01.

- Identity truth: distinct_person.
- Policy-expected: import_error.
- Engine outcome: import_error, path B, score 1.
- Class: import_error. Linked to the anchor: false. Indistinguishable: false.
- Skip reason: empty_block.
- Import error: row could not be stored.
- Trace explanation: scoring skipped: empty_block.
- Label note: Distinct person, same phone, nothing else shared. The matcher does not read the phone, so the row is new. The second phone write then fails.

### Import error for the same person

Row 304, set B, scenario RP-2, group recycled_phone, case RP-2-01.

- Identity truth: same_person.
- Policy-expected: import_error.
- Engine outcome: import_error, path D, score 0.3.
- Class: import_error. Linked to the anchor: true. Indistinguishable: false.
- Import error: row could not be stored.
- Trace explanation: scoring performed: name_plus_dob.
- Label note: Same person, same phone, new email, different ZIP, same name and birthday. The 0.60 threshold keeps a name-and-birthday agreement in review, and the different ZIP keeps the score below 0.85, so the path stays D. The second phone write then fails.

### First MB-3 probe

Row 317, set B, scenario MB-3, group missing_birthday, case MB-3-01.

- Identity truth: distinct_person.
- Policy-expected: hard_match.
- Engine outcome: auto_merge, path A, score 1.
- Class: false_positive. Linked to the anchor: true. Indistinguishable: false.
- Skip reason: deterministic_match.
- Trace explanation: scoring skipped: deterministic_match.
- Label note: Distinct namesake. The anchor has an email and no birthday. The probe has the same name, no email, and a birthday. A missing stored birthday keeps the name hard match.

### First MB-4 probe

Row 322, set B, scenario MB-4, group missing_birthday, case MB-4-01.

- Identity truth: same_person.
- Policy-expected: hard_match.
- Engine outcome: auto_merge, path A, score 1.
- Class: true_positive. Linked to the anchor: true. Indistinguishable: false.
- Skip reason: deterministic_match.
- Trace explanation: scoring skipped: deterministic_match.
- Label note: Same person. The anchor has an email and no birthday. The probe has the same name, no email, and a birthday. A missing stored birthday keeps the name hard match.

## Limitations

The rows are a designed synthetic set. A rate here is not a rate for a live fan file, and it is not a measurement of any real customer.

Small scenarios are behavior checks. The ratio is the count over the denominator in that row.

Reviews were not confirmed or rejected. Precision and recall describe automatic associations only. Found rate divides true positives plus same-person reviews by all same-person probes.

Set B was designed to produce the 32 observed identity errors: 19 distinct-person probes expected to auto-merge and 13 same-person probes expected to be stored as new. Those 32 rows are the entire error count, and Set B has 0 true negatives. Its purpose is to expose policy weaknesses under adversarial conditions. It does not represent a real-world data distribution and must not be presented as a real-world accuracy estimate.

The 60-scenario benchmark is a different population. Its precision is not a baseline for this file.

MB-3 probes are classed as 5 false matches. MB-4 probes are classed as 5 true positives. The dataset spec says those two scenarios share the columns an import can see and carry opposite identity truth. This report does not re-check the CSV, and it does not drop the MB-3 rows out of the false-match count.

CA-4 has 5 probes marked indistinguishable and 5 false matches. The flag stays a description. The false matches stay in the count.

5 person keys have three rows. 5 of those keys include a replay. The metrics stay pairwise, so a replay is not scored as the resolution of another probe for that person.

## Reproduce

```
node scripts/buildSyntheticDemoCsv.js --labels
node eval/syntheticMetrics.js
```

The second command checks the three dataset hashes and the committed import-results hash, then writes `eval/reports/synthetic-360-metrics.json` and this file. It does not need a database.

