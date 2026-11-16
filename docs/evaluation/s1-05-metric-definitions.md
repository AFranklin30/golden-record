# S1-05 metric definitions

Methodology for the 360-row synthetic import. Written from the label file, the dataset spec, and the S1-04 results schema. The measurement code is `eval/syntheticMetrics.js`. It implements this document. It reads the committed labels and the committed import results. It does not call the resolver, the matcher, or the importer, and it does not write the import results file.

## Four records

Each row is described in four ways. They are not substitutes for each other.

| Record | Field | What it is |
|---|---|---|
| Identity truth | `identity_truth` on the label | `first_seen`, `same_person`, or `distinct_person`. Assigned by the recipe. `truth_basis` is `recipe`. |
| Policy-expected outcome | `policy_expected` on the label | The decision the written matching policy implies. |
| Engine outcome | `engine_outcome` on the S1-04 results | What the import did: `auto_merge`, `review`, `new`, `replay`, or `import_error`. |
| Import outcome | `import_status`, `replayed`, `error` on the S1-04 results | Whether the row was stored, returned from an earlier row, or rejected. |

`expected_path` is the path the policy names, or the path stored on a replayed row. It is not identity truth. The classifier does not read `expected_path` or `policy_expected`.

A row can follow the policy and still be the wrong person. A row can be the right person and still be held for review.

## Unit

The quality metrics are pairwise. One probe is one decision about one anchor.

A probe has `role` `probe` and an `anchor_row`. Set A has 120 probes. Set B has 80. The other 160 rows are introductions: 80 Set A originals and 80 Set B anchors. An introduction is the first stored row of a person. It is checked, and it is left out of precision and recall.

The label on a probe says whether that row is the same person as its anchor. It does not give a separate cluster verdict. Five people have three rows: the original, a same-email replay, and a nickname probe. The replay is idempotency. The nickname row is a different decision. A cluster score would need a rule for mixing those two, and the label does not give one.

The code also counts distinct `person_key` values inside each class. A person key can sit on an introduction and again on a probe, so those counts are not a partition of people. Where the pair count and the person-key count differ inside one class, both are printed.

Record-level inventory (row counts, person-key counts, new-record counts) is reported beside the pairwise rates. The rates themselves are pairwise.

## Classes

The class is identity truth plus engine outcome.

| Class | Rule |
|---|---|
| `introduction` | Role is `first_seen` or `anchor`, and the engine outcome is `new`. |
| `introduction_other` | Role is `first_seen` or `anchor`, and the engine outcome is anything else. |
| `replay` | Probe, engine outcome `replay`. |
| `import_error` | Probe, engine outcome `import_error`. |
| `true_positive` | Probe, `same_person`, `auto_merge`, matched row is the anchor, matched person key is this person. |
| `false_positive` | Probe, `distinct_person`, `auto_merge`. |
| `false_positive_wrong_fan` | Probe, `same_person`, `auto_merge`, matched row is not the anchor. |
| `false_negative` | Probe, `same_person`, `new`. |
| `true_negative` | Probe, `distinct_person`, `new`. |
| `review_same_person` | Probe, `same_person`, `review`, matched row is the anchor, matched person key is this person. |
| `review_distinct_person` | Probe, `distinct_person`, `review`, matched row is the anchor. |
| `review_wrong_target_same_person` | Probe, `same_person`, `review`, matched row is not the anchor. |
| `review_wrong_target_distinct_person` | Probe, `distinct_person`, `review`, matched row is not the anchor. |

Matched to the anchor means `matched_row === anchor_row`.

The run stops on a row that fits none of these rules. A row is not moved into a nearby class. The run also stops when a same-person link to the anchor carries a different person key, when a `new` row has a matched row, or when the path disagrees with the engine outcome (`auto_merge` is path A, `review` is path C or D, `new` is path B).

`indistinguishable` does not change the class. A distinct person who was auto-merged is a false positive, including when the label says the columns cannot separate the two people.

## Where each class goes

| Class | Precision | Recall | Review volume | New records |
|---|---|---|---|---|
| `true_positive` | numerator and denominator | numerator and denominator | no | no |
| `false_positive` | denominator | no | no | no |
| `false_positive_wrong_fan` | denominator | no | no | no |
| `false_negative` | no | denominator | no | yes, and named as a miss |
| `true_negative` | no | no | no | yes, and named as a separation |
| `review_same_person` | no | no | yes | no |
| `review_distinct_person` | no | no | yes | no |
| `review_wrong_target_*` | no | no | yes | no |
| `replay` | no | no | no | no |
| `import_error` | no | no | no | no |
| `introduction` | no | no | no | yes, as an introduction |
| `introduction_other` | no | no | no | no; printed on its own |

A replay is not a new person and is not a duplicate-detection success.

An import error is not a match and is not a miss. The path and the error string are printed next to it. A path D import error stays out of the review count. A path B import error stays out of the true-negative count.

A review stays in review volume. It is not a false negative and it is not a false positive.

A same-person auto-merge onto the wrong fan is a false match. It is in the precision denominator. It is not in the recall denominator, because it is not a silent new record. Its count is printed on its own.

## Precision

Of the probe rows the engine auto-merged, the share that are the same person as the anchor they were linked to.

- Numerator: `true_positive`.
- Denominator: `true_positive` + `false_positive` + `false_positive_wrong_fan`.

Reviews, new records, replays, import errors, and introductions are outside this denominator. A denominator of zero is null, not zero.

## Recall

Of the genuine duplicate relationships the engine decided automatically, the share it linked to the right person.

A genuine duplicate relationship is a probe with `identity_truth` `same_person`.

- Numerator: `true_positive`.
- Denominator: `true_positive` + `false_negative`.

Same-person reviews are outside both sides. A review is not a missed match. Replays are outside. Import errors are outside. A denominator of zero is null.

This is the same automatic-versus-review split the 60-scenario report uses. The rows are a different population. The two precisions are not a before-and-after pair.

## Found rate

Found rate is not recall. It counts a duplicate the engine either auto-merged to the anchor or held against the anchor.

- Numerator: `true_positive` + `review_same_person`.
- Denominator: that numerator, plus `false_negative`, plus `review_wrong_target_same_person`, plus `false_positive_wrong_fan`.

Replays and import errors stay outside.

## False matches and missed matches

False matches are `false_positive` + `false_positive_wrong_fan`. A distinct person sent to review is not in this count. The engine did not associate that row with the other fan.

Missed matches are `false_negative`. A same-person review is not in this count. The engine held the relationship.

True negatives are distinct-person probes stored as new people. They appear in the confusion matrix. They are not in the precision denominator, because precision is about auto-merges. They are not in the recall denominator, because recall is about duplicates.

Among true negatives, and again among missed matches, the report counts how many were never scored. Never scored means `scoring_status` is `skipped` and `skip_reason` is `no_block_key`, `empty_block`, or `block_dropped_oversize`. Any other skip reason is printed beside that count.

## Review volume

- Total: every probe whose engine outcome is `review`.
- Eligible records: probes whose engine outcome is `auto_merge`, `review`, or `new`.
- Percentage: reviews divided by eligible probes.

Replays are not eligible. The resolver was not asked for a new decision. Import errors are not eligible. The row was not stored. Introductions are not eligible. They are not duplicate decisions.

Two other denominators are printed under their own names: reviews divided by all probes, and reviews divided by all 360 rows. The summary percentage uses eligible probes.

By scenario group, the denominator is the eligible probes in that group. Anchors in the group are not in it. A group whose probes are all replays or all import errors has a null percentage.

The identity split of the reviews is:

- same person, linked to the anchor
- different person, linked to the anchor
- wrong target

The labels do not say whether a review was genuine ambiguity or an unnecessary intervention. `indistinguishable` is the only flag that says the columns cannot separate two people. The report counts how many reviews carry that flag. It does not add the missing label. A same-person review is a real duplicate that was not merged. A distinct-person review is two different people that were not merged.

Review yield, as the dataset spec defines it, is same-person reviews linked to the anchor divided by all reviews.

The scores on review rows are printed as engine output. A score is not a judgment that the case was ambiguous.

## New records, import errors, and replays

New records are engine outcome `new`. They are split into introductions, true negatives, and false negatives. An introduction with a different outcome is `introduction_other` and is not relabeled as a true negative.

Import errors are grouped by scenario, identity truth, path, recorded error, and whether a fan id is present. The fan id is not printed. A fan id on an error row is not a stored success.

Replays are counted, with how many are the same person as the anchor and how many returned that anchor's row. They are not added to the new-person count.

## Policy conformance

A separate table. The map is the one S1-04 used:

| Policy-expected | Engine outcome |
|---|---|
| `hard_match` | `auto_merge` |
| `review` | `review` |
| `separate` | `new` |
| `import_replay` | `replay` |
| `import_error` | `import_error` |

This comparison does not change a class and it is not an identity result.

## Sets, groups, and small slices

Set A and Set B are scored with the same rules and printed separately. A pooled line adds the counts and prints the pooled denominators. That line is a sum of two designs. It is not one population. The summary leads with the two sets.

Scenario groups and scenario ids use the same rules. A small scenario is a behavior check. The ratio is the count over the denominator in that row.

When a precision or recall denominator is greater than zero and the error count in that ratio is zero, the report prints the rule-of-three bound from the dataset spec: 3 divided by that denominator. The bound is a caveat on a zero. It is not a measured error rate.

## Rounding

The fraction is the result. The decimal is the fraction rounded to four places, with the same `Math.round(value * 10000) / 10000` rule as `eval/benchmark.js`. A null fraction stays null.

## Inputs the run checks

The run stops if any of these differ:

- Label sha256 `0db2aa4810cd02583749830190f8877ca66b0d681882641099c57ac1a92af8b4`
- Set A CSV sha256 `3fb01339fa4144d63a566c97a39fe3869cd96a1c9d4df86fb288a3a783bf2bc7`
- Set B CSV sha256 `9c010f0ee4fa88ecc4b6e57f7cae4f8766a42475640e0ba40a02ec9862f062f8`
- The S1-04 results file sha256 stored in `eval/syntheticMetrics.js`

Copied identity fields on each results row must match the label row. The output omits fan ids, org ids, batch ids, and conflict ids.

## What the run does not claim

Auto-merge means the import associated the row with an existing fan on path A. No review was confirmed or rejected. A false match is that association.

The file is a designed synthetic set. A rate in a small scenario is not a rate for a live fan file, and it is not a measurement of any real customer.
