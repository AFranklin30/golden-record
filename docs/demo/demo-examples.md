# Four demo examples from the 360-row synthetic import

These are the four S1-07 picks. The task board asks for one exact duplicate, one clear non-match, one review, and one ambiguous case. Each example cites the row, the ground-truth label, the path, and the score from the committed S1-04 file, `eval/reports/synthetic-360-import-results.json`.

A later note for the same sprint asked for a correct automatic join, a correct review, a correct keep-separate, and one honest failure. Those four are not the same list. This file follows the task board. The ambiguous case below is also a false merge. It is one of the known weaknesses Sprint 1.5 is approved to address. A correct automatic join of the same person is row 126. It is written up in `eval/reports/synthetic-200-report.md` and is not one of these four.

The name, email, birthday, ZIP, and phone come from the CSV lines the importer read. Set A is `demo/synthetic-customers-200.csv`. Set B is `demo/synthetic-extension-160.csv`. Both CSVs are gitignored. They are rebuilt by `node scripts/buildSyntheticDemoCsv.js --labels`. Empty CSV fields are shown as blank. The results file does not store those fields.

The engine does store an explanation string, with one exception. The results file's rule is: the text is produced only when the row called the resolver, and it is `scoring skipped: <reason>` or `scoring performed: <signal names>`. It does not include the name, email, or birthday. A replay does not call the resolver, so its explanation is null. The sentences quoted as "Label note" are the recipe notes in `demo/synthetic-ground-truth-v2.json`. They are not engine text.

Fan ids are omitted. The results file records them, and its header says they change on every import.

Path A is an automatic join to an existing fan. Path B is a new fan, or the path copied from the earlier row on a replay. Path C or path D is a review. Nothing is merged until a person confirms a review.

## 1. Exact duplicate — row 81

Case A-SAME-EMAIL-01. Set A. The anchor is row 1, the same person.

| | First name | Last name | Email | Birthday | ZIP | Phone |
|---|---|---|---|---|---|---|
| Row 1, first record | Robert | Adler | robert.adler.1@example.com | 1972-01-15 | 73101 | blank |
| Row 81, probe | Robert | Adler | robert.adler.1@example.com | 1972-01-15 | 73101 | blank |

The two CSV lines are the same.

Ground truth, from the label file:

- Identity truth: `same_person`. Truth basis: `recipe`.
- Policy-expected: `import_replay`. Expected path: B.
- `indistinguishable`: false. `truth_policy_disagreement`: false.
- Label note: "Byte-identical copy of the anchor. The import row key matches, so the resolver is not called and the stored path stays the anchor path B."

Engine decision, from the S1-04 row:

- Engine outcome: `replay`.
- Path: B.
- Score: 1. Score source: `stored_row`.
- Linked to row 1. `replayed`: true. `resolver_called`: false.
- Scoring status: `skipped`. Skip reason on the stored row: `empty_block`. Signals: none.
- `explanation_produced`: false. `explanation`: null.

The explanation text is not stored for this row, because the resolver was not called. What is stored is the outcome, the path, the copied score, and the link back to row 1. Row 1 itself was a new person: path B, score 1, score source `audit_log.confidence_score`, stored explanation `scoring skipped: empty_block`.

The measurement counts this row as a replay. It is not counted as a successful duplicate detection, and it is not inside precision or recall. The other exact copies are rows 82–85.

## 2. Clear non-match — row 141

Case A-DIFF-DOB-01. Set A. The anchor is row 1, a different person.

| | First name | Last name | Email | Birthday | ZIP | Phone |
|---|---|---|---|---|---|---|
| Row 1, anchor | Robert | Adler | robert.adler.1@example.com | 1972-01-15 | 73101 | blank |
| Row 141, probe | Lucas | Adler | lucas.adler.3@example.com | 1973-01-15 | 10001 | blank |

Ground truth, from the label file:

- Identity truth: `distinct_person`. Person key: `distinct-A-DIFF-DOB-1`.
- Policy-expected: `separate`. Expected path: B.
- `indistinguishable`: false. `truth_policy_disagreement`: false.
- Label note: "Different person. Different first name and a birthday one year later, so no block key hits. Never scored."

Engine decision, from the S1-04 row:

- Engine outcome: `new`.
- Path: B.
- Score: 1. Score source: `audit_log.confidence_score`.
- `matched_row`: null. The probe was not linked to row 1.
- Scoring status: `skipped`. Skip reason: `empty_block`. Signals: none.
- Stored explanation: `scoring skipped: empty_block`.

The stored explanation is that one string. It does not name Lucas or Robert. The score of 1 is the confidence written when scoring is skipped. The measurement classes this row as a true negative, one of the 60 different-person probes stored as new people. All 60 have skip reason `empty_block`.

## 3. Review — row 86

Case A-NICKNAME-01. Set A. The anchor is row 1, the same person.

| | First name | Last name | Email | Birthday | ZIP | Phone |
|---|---|---|---|---|---|---|
| Row 1, anchor | Robert | Adler | robert.adler.1@example.com | 1972-01-15 | 73101 | blank |
| Row 86, probe | Bob | Adler | bob.adler.2@example.com | 1972-01-15 | 94105 | blank |

Ground truth, from the label file:

- Identity truth: `same_person`. Person key: `original-1`.
- Policy-expected: `review`. Expected path: D.
- `indistinguishable`: false. `truth_policy_disagreement`: false.
- Label note: "Same person, nickname, different email and ZIP, same birthday. The name and birthday keep a low score in review."

Engine decision, from the S1-04 row:

- Engine outcome: `review`.
- Path: D.
- Score: 0.3. Score source: `resolution_trace.best_score`.
- Linked to row 1.
- Scoring status: `performed`. Signals: `name_plus_dob`.
- Stored explanation: `scoring performed: name_plus_dob`.

The stored explanation names the signal. It does not say that Bob and Robert are nicknames, and it does not mention the email or the ZIP. The measurement classes this row as `review_same_person`. It is one of Set A's 40 reviews. It is outside precision and recall. It is inside the found rate, because it is a same-person review linked to the anchor. No merge was confirmed.

## 4. Ambiguous case — row 341

Case CA-4-01. Set B. The anchor is row 261. This is a false merge. The label says the fields on the probe do not separate the two people. Sprint 1.5, Matching Quality Fixes, was approved on November 18, 2026 to address the known weaknesses named in `eval/reports/synthetic-200-report.md`. This row is one of them. The estimate is 3–5 days and is unverified. The approval is D-022. This example does not describe the fix. The matcher was not changed.

| | First name | Last name | Email | Birthday | ZIP | Phone |
|---|---|---|---|---|---|---|
| Row 261, anchor | Orla | Maddox | ca-4-01.a@example.org | 1995-01-06 | 80060 | blank |
| Row 341, probe | Orla | Maddox | blank | 1995-01-06 | 80060 | blank |

Ground truth, from the label file:

- Identity truth: `distinct_person`. The probe's person key is `CA-4-01#probe`. The anchor's person key is `CA-4-01#anchor`.
- Policy-expected: `hard_match`. Expected path: A.
- `indistinguishable`: true. Flag: `S0`. `truth_policy_disagreement`: true.
- Label note: "Distinct namesake, same name and birthday, probe has no email. Exact name plus the same birthday is a hard match. The fields on the probe do not separate the two people."

Engine decision, from the S1-04 row:

- Engine outcome: `auto_merge`.
- Path: A.
- Score: 1. Score source: `audit_log.confidence_score`.
- Linked to row 261.
- Scoring status: `skipped`. Skip reason: `deterministic_match`. Signals: none.
- Stored explanation: `scoring skipped: deterministic_match`.

The stored explanation is that skip reason. It does not say the two rows are different people, and it does not say the columns are ambiguous. The measurement classes this row as a false positive. The same class applies to CA-4 probes 342–345. CA-4 is 5 of the 19 false merges. Policy conformance on this row is still a match: the policy expected a hard match, and the engine made one.

The dataset spec says MB-3 and MB-4 are the other pair that shares the columns an import can see and carries opposite identity truth. They are not this example. MB-3 probe row 317 is a false merge. MB-4 probe row 322 is a true positive. The measurement keeps both.
