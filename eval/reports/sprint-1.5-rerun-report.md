# Sprint 1.5 re-run

Measured Nov 22, 2026, after the approved review rules were put in the matcher. The synthetic labels, the CSVs, and the 60-scenario fixtures were not changed. The old S1-04 and S1-05 report files were restored after this run and are the baseline below.

The import was `node --unhandled-rejections=warn eval/syntheticImport.js` against local Postgres. The class counts use `eval/syntheticMetrics.js` (`joinRows`, `classify`, `evaluate`) on that import. The hash pin inside `syntheticMetrics.js` still points at the committed S1-04 file, so this run did not execute that script's `main()`. The classification rules are the same ones.

## Before and after

| | S1-05 baseline | This run |
|---|---|---|
| Jest | 698 passed, 1 skipped | 720 passed, 8 failed, 1 skipped, 729 total |
| 60-scenario benchmark | 60 scenarios, 0 policy mismatches, P 0.9048, R 0.7917, 27 reviews | 60 scenarios, 5 policy mismatches, P 0.875, R 0.7368, 32 reviews |
| Pooled precision | 28/47 | 8/8 |
| Pooled recall | 28/41 | 8/8 |
| False merges | 19 | 0 |
| Missed matches | 13 | 0 |
| Reviews | 65/185 | 117/185 |
| Found | 77/99 | 90/99 |

Set A precision and recall are null. The denominator is 0. Set A found rate is 55/60. Set B precision is 8/8, recall is 8/8, false merges 0, missed matches 0, reviews 62, found 35/39.

The 8 remaining automatic joins are MB-1 (4) and CA-2 (4). MB-1 is the same email and the same name with the probe birthday missing. CA-2 is the same email, the same first name, the same birthday, and a different last name. Both stay hard matches.

8/8 means every automatic decision that is still automatic was a true join, and no same-person row was stored as a new person. It does not mean the hard cases were solved. They are in the review count. The metrics rule of three on a perfect 8 is 3/8.

Engine outcomes on the 360 rows: new 220, review 117, auto_merge 8, import_error 10, replay 5. The 10 import errors are still RP-1 and RP-2.

## The original 19 false merges

All 19 are reviews of the anchor. None is still an automatic join.

| Cases | Rows | Status | Why |
|---|---|---|---|
| SFE-2-01 to SFE-2-06 | 289–294 | now review | Exact email, different first names, probe birthday missing. Decision 1. |
| SFE-3-01 to SFE-3-03 | 295–297 | now review | Exact email, different first names, same birthday. Decision 1. |
| MB-3-01 to MB-3-05 | 317–321 | now review | Exact name, stored birthday missing. Decision 6. |
| CA-4-01 to CA-4-05 | 341–345 | now review | Exact name, same birthday, no incoming email. Decision 3. |

## The original 13 missed matches

All 13 are reviews of the anchor. None is still a new person.

| Cases | Rows | Status | Why |
|---|---|---|---|
| MB-2-01 to MB-2-05 | 312–316 | now review | The new email misses. The exact name is retrieved. The probe birthday is missing, so Decision 6 opens a review. |
| CO-1-01 to CO-1-04 | 349–352 | now review | The listed nickname and the same surname are retrieved. The swapped birthday stays a conflict, so the pair is a review, not a hard match and not a new person. |
| CO-2-01 to CO-2-04 | 353–356 | now review | Main already retrieves a one-edit surname when the first name and birthday match (`a651d44`). The existing name-and-birthday review floor holds the pair. This change does not add a new rule for CO-2. |

## New false merges and new misses

None. No probe outside those 32 rows became a false merge or a missed match.

52 probes no longer match the old policy label. Every one of them is in this list:

| Scenario | Rows | Old policy label | This run |
|---|---:|---|---|
| A-NO-EMAIL | 15 | hard match | review |
| SFE-2 | 6 | hard match | review |
| SFE-3 | 3 | hard match | review |
| MB-2 | 5 | separate | review |
| MB-3 | 5 | hard match | review |
| MB-4 | 5 | hard match | review |
| CA-4 | 5 | hard match | review |
| CO-1 | 4 | separate | review |
| CO-2 | 4 | separate | review |

A-NO-EMAIL rows 126–140 and MB-4 rows 322–326 were true joins. They are reviews now because they have the same columns as CA-4 and MB-3. The labels were not changed. The fields still cannot tell the pairs apart.

## What is still wrong

The 19 are not automatically separated, and the 13 are not automatically joined. A person still has to decide them.

MB-3 and MB-4 are the same columns. Five of those reviews are different people and five are the same person. CA-4 and the 15 A-NO-EMAIL probes are the same shape. Five of those reviews are different people and fifteen are the same person. The matcher cannot see a field that separates them.

CO-1 is retrieved and then held because the birthdays differ. The nickname list does not make the swapped birthday an agreement.

The 10 recycled-phone rows are still import errors. They were outside the 19 and the 13.

Set A no longer has an automatic decision, so a Set A precision number cannot be computed.

## Benchmark mismatches

These five scenarios now review. The fixture still expects a hard match. The fixture was not edited.

| Scenario | Approved rule |
|---|---|
| exact-name-and-birthday | Decision 3. Same name, same birthday, no email. |
| missing-email | Decision 3. |
| email-no-longer-present | Decision 3. |
| name-only | Decision 6. Both birthdays missing. |
| different-attributes-across-imports | Decision 6. The stored birthday is missing. |

That is why benchmark precision moved from 0.9048 to 0.875 and recall from 0.7917 to 0.7368. Five same-person hard matches left the automatic counts and became reviews. False positives stayed 2. False negatives stayed 5. Reviews moved from 27 to 32.

`same-name-one-birthday-matches` passed on this run. The lookup returned the person whose birthday does not match, which the fixture already allows as a review. Decision 3 would also review the person whose birthday does match, and the fixture only allows a hard match for that person. The lookup has no order. A later run can fail that scenario without a matcher change.

## Level 2 fixtures

`tests/eval.level2.test.js` has seven failures. The fixture file was not edited.

| Case | Fixture expects | This run |
|---|---|---|
| missing-email-same-name | hard match | review, Decision 3 |
| exact-name-same-birthday | hard match | review, Decision 3 |
| exact-name-missing-inbound-dob | hard match | review, Decision 6 |
| exact-name-missing-stored-dob | hard match | review, Decision 6 |
| exact-name-both-missing-dob | hard match | review, Decision 6 |
| same-name-different-email-different-birthday | new person, empty block | review. The exact name is retrieved and the birthdays differ. |
| birthday-veto | new person after a scored birthday veto | review. The card is new, and the name and the conflicting birthday are held. |

## Choices where the wording was open

- A first name missing on one side of an exact email stays a hard match. The approval says that case is not decided. A missing name is not treated as a conflicting name. Sending every email hit that does not repeat the name to review was not approved.
- A retrieved nickname with a conflicting birthday is a review, not a new person. The wording left review versus no match open. The retrieved person is not dropped and is not merged.
- A retrieved exact name with a conflicting birthday is a review, not a new person. That is shape 3 of the exact-name rule. The same choice as the nickname case.
- Decision 5B stays the one-edit surname rule already on main. No new threshold was chosen.
