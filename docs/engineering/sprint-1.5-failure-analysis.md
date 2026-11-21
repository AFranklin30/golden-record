# Sprint 1.5 failure analysis

Read-only trace of the 19 false merges and 13 missed matches in the 360-row synthetic import. Written November 18, 2026. Case evidence in sections 3 through 7 is observed fact or a labeled reconstruction. Section 11 records approved policy direction from the review of this analysis. That direction is not implemented behavior. Section 13 records Decision 6, approved November 20, 2026. Decision 6 resolves question 2. It is not implemented, and it does not change sections 3 through 7. Reproducibility verification is outstanding.

The 60-scenario benchmark is a different population. Its precision 0.9048, recall 0.7917, 0 policy mismatches, and 27 reviews are not part of these 32 rows, and this analysis does not change that baseline.

## 1. Executive summary

None of these 32 rows was scored. The 0.85 and 0.60 thresholds were not the branch that decided them. No agreement signal fired. The stored score of 1 is `audit_log.confidence_score` for a skipped resolution, which the resolver sets to 1.0 for both a hard match and a new person.

The 19 false merges are exact-identifier hard matches, path A, skip reason `deterministic_match`. The importer's singular identifier hit one stored row, the birthday exception did not reject that hit, and the resolver returned that person before blocking or scoring. On every one of the 19, the stored `matched_row` is the anchor.

The 13 missed matches are path B, skip reason `empty_block`. The exact lookup missed, every block key that the inbound could build returned no live fan, and nobody was ranked. The anchor was not retrieved.

| Group | Rows | What the stored trace says | Earliest divergence |
|---|---:|---|---|
| SFE-2 false merges | 6 | path A, `deterministic_match`, no signals | Exact email hit kept, because the probe has no birthday, so the birthday exception does not run. The different first name is on the call and is not read. |
| SFE-3 false merges | 3 | path A, `deterministic_match`, no signals | Exact email hit kept, because the birthdays are equal. The different first name is on the call and is not read. |
| MB-3 false merges | 5 | path A, `deterministic_match`, no signals | Exact name hit kept, because the anchor has no stored birthday, so the probe's birthday cannot conflict. |
| CA-4 false merges | 5 | path A, `deterministic_match`, no signals | Exact name hit kept, because the birthdays are equal. The probe has no email. |
| MB-2 missed matches | 5 | path B, `empty_block`, no signals | New email misses the exact lookup. The probe has no birthday, so the last-name-plus-birthday block is not built. The shared name is not a retrieval key. |
| CO-1 missed matches | 4 | path B, `empty_block`, no signals | New email misses. The last-name-plus-birthday block requires the exact birthday, and the month and day are swapped. The nickname is not the singular identifier, so the exact-name lookup does not run. |
| CO-2 missed matches | 4 | path B, `empty_block`, no signals | New email misses. The last-name-plus-birthday block uses the exact last word, and the last name is a typo. |

Policy-expected outcome matched the engine on all 32. The identity labels do not. These are policy outcomes, measured as identity errors by S1-05. They are not cases where the engine left the written rule.

## 2. Analysis methodology

Sources, read and not rewritten:

- `eval/reports/synthetic-360-import-results.json`, the S1-04 row records. Import-results sha256 `33afd385694b08a6edfbbaddf015be4b3b605cf727e07c46728a166daf6820ba`.
- `eval/reports/synthetic-360-metrics.json` and `eval/reports/synthetic-360-metrics-report.md`, for the class counts this trace explains.
- `demo/synthetic-ground-truth-v2.json` and `docs/evaluation/synthetic-dataset-spec.md`, for identity truth and the recipe.
- `demo/synthetic-customers-200.csv` and `demo/synthetic-extension-160.csv`, rebuilt locally with `node scripts/buildSyntheticDemoCsv.js --labels`. The label sha256 stayed `0db2aa4810cd02583749830190f8877ca66b0d681882641099c57ac1a92af8b4`. The tracked label file and manifest did not change. The CSVs are gitignored.
- `src/modules/customerImport.js`, `src/modules/resolverEngine.js`, `src/modules/normalizer.js`, and `docs/engineering/matching-policy.md`, for the pipeline the stored skip reasons come from.
- `eval/syntheticImport.js`, for what the results file keeps and what it drops.

Pipeline the importer actually runs, in order:

1. `parseCustomerRow` normalizes email, name, birthday, ZIP, and phone. A blank field is omitted.
2. The singular identifier is the email when the row has one, and the name otherwise (`customerImport.js`, `importOne`).
3. `resolverEngine` looks up that exact value on a live fan. For email and name, a birthday exception can refuse the hard match only when the inbound birthday is present and every stored birthday differs.
4. Only if that hard match is refused, or the lookup misses, does `findBlockCandidates` run. Its keys are exact email, exact guardian email, and exact last word of the name plus exact birthday. A key is built only from fields on the inbound row.
5. Scoring and `pathForMatch` (0.85 path C, 0.60 path D, with a name-and-birthday floor) run only for fans those keys returned.
6. After commit, `attachRemaining` stores name, birthday, ZIP, and phone on that fan when the row carried them. Anchors are rows 201–280 and probes are rows 281–360, and `importCustomers` awaits each row before the next. An anchor's attached fields are committed before its probe is resolved.

The results file stores `engine_outcome`, `path`, `score`, `score_source`, `scoring_status`, `skip_reason`, `signals`, `explanation`, and `matched_row`. It does not store `block_keys_available`, `block_results`, `candidates_considered`, or the identifier values. Where this document names which block key missed, that is a reconstruction from the code and the CSV, marked as such. The skip reason itself is stored.

`deterministic_match` is the trace's initial skip reason. Path A leaves it in place and does not run the block. `empty_block` is written only when at least one block key was available, no block was dropped for size, and the queries returned zero live fans (`resolverEngine.js`, the `candidates_considered === 0` branch).

This session did not re-run the import and did not query `identifier_link`. Reproducibility is argued from the stored rows plus that code, and from the S1-04 note that a second import matched every non-volatile field.

Normalization check, run against the recipe strings with the current `normalizeIdentifier`: emails are already lowercase, birthdays are already `YYYY-MM-DD`, and names become lowercase with collapsed spaces. For every pair below, normalization does not turn a differing email, name, or birthday into an equal one, and it does not split a pair that the recipe shows as equal. Normalization is not the stage that diverged.

## 3. False-merge analysis

Identity truth on all 19 probes is `distinct_person`. Policy-expected is `hard_match`. The engine outcome is `auto_merge`, path A, score 1, score source `audit_log.confidence_score`, scoring skipped, skip reason `deterministic_match`, signals empty, explanation `scoring skipped: deterministic_match`, `matched_row` equal to `anchor_row`. That signature is the same on all 19 rows. Phone is blank on every anchor and probe in this section. ZIP differs on SFE-2 and SFE-3 and matches on MB-3 and CA-4. ZIP is not a singular identifier and is not a block key, and path A returns before scoring, so ZIP is not an input to these 19 decisions.

No candidate list was scored. The exact lookup is what returned the anchor. Blocking did not run. The code takes `linkResult.rows[0]` with no `ORDER BY`. The results file does not store how many rows that query returned. What it stores is that the fan linked in the outcome is the anchor. The recipe's isolation check is written so a Set B probe shares an email or an exact name only with its own anchor. That check was not re-executed against a database here.

### SFE-2 — shared email, probe birthday missing (6)

Singular identifier: email. The first names differ. The last names match. The probe birthday is blank, so `identifiers.dob` is omitted, and the birthday exception's `if (inboundDob)` body does not run. The anchor's stored birthday is never compared. The different first name is passed in `identifiers.name` and is not read on this branch.

| Case | Probe | Anchor | Anchor | Probe | Email | Anchor birthday |
|---|---:|---:|---|---|---|---|
| SFE-2-01 | 289 | 209 | Omar Inwood | Carmen Inwood | sfe-2-01@example.org | 1990-09-02 |
| SFE-2-02 | 290 | 210 | Phoebe Jarvis | Diego Jarvis | sfe-2-02@example.org | 1990-10-03 |
| SFE-2-03 | 291 | 211 | Quentin Keating | Elena Keating | sfe-2-03@example.org | 1990-11-04 |
| SFE-2-04 | 292 | 212 | Rosa Llewellyn | Fabio Llewellyn | sfe-2-04@example.org | 1990-12-05 |
| SFE-2-05 | 293 | 213 | Selene Marchand | Gloria Marchand | sfe-2-05@example.org | 1991-01-06 |
| SFE-2-06 | 294 | 214 | Tobias Northcott | Hector Northcott | sfe-2-06@example.org | 1991-02-07 |

Probe ZIP is 81008 through 81013. Anchor ZIP is 80008 through 80013. Probe birthday is blank.

Expected identity outcome: do not treat the probe as the anchor. Actual: automatic join to the anchor. Earliest divergence: the exact-email hit is kept, because there is no inbound birthday for the exception to test. This is identity-decision logic. It is not scoring, not a threshold, and not a retrieval miss. The person was retrieved by the exact email, and the name disagreement was present and not consulted. There is no birthday conflict on the call, because the probe birthday is absent.

Contrast, stored and not one of these 19: SFE-1 has the same shared email and a different first name, and both birthdays are present and different. Those probes were reviews, path D, explanation `scoring performed: dob_veto`. The birthday exception does run when the inbound birthday exists and every stored birthday differs.

### SFE-3 — shared email, same birthday, different first name (3)

Singular identifier: email. Both birthdays are present and equal, so `birthdayConflicts` is false (`storedValues.every` fails as soon as one stored birthday equals the inbound birthday). The hard match stands. The different first name is on the call and is not read.

| Case | Probe | Anchor | Anchor | Probe | Email | Birthday |
|---|---:|---:|---|---|---|---|
| SFE-3-01 | 295 | 215 | Una Oakley | Carmen Oakley | sfe-3-01@example.org | 1991-03-08 |
| SFE-3-02 | 296 | 216 | Victor Penrose | Diego Penrose | sfe-3-02@example.org | 1991-04-09 |
| SFE-3-03 | 297 | 217 | Wynn Quill | Elena Quill | sfe-3-03@example.org | 1991-05-10 |

Probe ZIP is 81014 through 81016. Anchor ZIP is 80014 through 80016.

Expected identity outcome: do not treat the probe as the anchor. Actual: automatic join to the anchor. Earliest divergence: the birthday exception runs, finds an agreeing birthday, and keeps the exact-email hit. The name is conflicting evidence relative to identity truth. The hard-match branch does not compare names. This is identity-decision logic, not a scored rank.

### MB-3 — exact name, anchor birthday missing (5)

Singular identifier: name, because the probe email is blank. The normalized names are equal. The anchor birthday is blank, so `attachRemaining` has no birthday to store. The probe birthday is present. The exception requires `storedValues.length > 0` before a conflict is possible, so a missing stored birthday keeps the hard match. The anchor's email is a different value and is not the field the lookup used.

| Case | Probe | Anchor | Name | Anchor email | Probe birthday | ZIP |
|---|---:|---:|---|---|---|---|
| MB-3-01 | 317 | 237 | Quinn Langley | mb-3-01.a@example.org | 1993-01-06 | 80036 |
| MB-3-02 | 318 | 238 | Reva Merrick | mb-3-02.a@example.org | 1993-02-07 | 80037 |
| MB-3-03 | 319 | 239 | Soren Niles | mb-3-03.a@example.org | 1993-03-08 | 80038 |
| MB-3-04 | 320 | 240 | Tessa Osborne | mb-3-04.a@example.org | 1993-04-09 | 80039 |
| MB-3-05 | 321 | 241 | Ulric Prescott | mb-3-05.a@example.org | 1993-05-10 | 80040 |

Expected identity outcome: do not treat the probe as the anchor. Actual: automatic join to the anchor. Earliest divergence: the exact-name hit is kept, because there is no stored birthday to disagree with the probe. This is identity-decision logic applied to a missing stored birthday.

The same columns with the opposite identity label are MB-4, probes 322–326. Those five are true positives under the same path A signature. The imported fields do not say which pair is which. The mechanism is determined. A correct automatic separation of MB-3, using only these columns, would also change MB-4. That limit is observed, not a guess about a hidden field.

### CA-4 — exact name, same birthday, probe has no email (5)

Singular identifier: name. Normalized names are equal. Birthdays are equal, so the exception finds no conflict and keeps the hard match. The probe email is blank. The anchor email is `ca-4-0N.a@example.org`. The label sets `indistinguishable` true. The label note says the fields on the probe do not separate the two people.

| Case | Probe | Anchor | Name | Birthday | Anchor email | ZIP |
|---|---:|---:|---|---|---|---|
| CA-4-01 | 341 | 261 | Orla Maddox | 1995-01-06 | ca-4-01.a@example.org | 80060 |
| CA-4-02 | 342 | 262 | Pia Neville | 1995-02-07 | ca-4-02.a@example.org | 80061 |
| CA-4-03 | 343 | 263 | Remy Ogden | 1995-03-08 | ca-4-03.a@example.org | 80062 |
| CA-4-04 | 344 | 264 | Sable Pruitt | 1995-04-09 | ca-4-04.a@example.org | 80063 |
| CA-4-05 | 345 | 265 | Theo Rourke | 1995-05-10 | ca-4-05.a@example.org | 80064 |

Expected identity outcome: do not treat the probe as the anchor. Actual: automatic join to the anchor. Earliest divergence: the exact-name hit is kept because the birthdays agree. No scored signal ran. There is no disagreeing birthday and no probe email to disagree with. The anchor email is extra information the path A name branch does not require.

Set A's 15 correct automatic joins, A-NO-EMAIL probes 126–140, are the same decision shape: no probe email, same normalized name, same birthday, path A, `deterministic_match`. The mechanism that false-merges CA-4 is the mechanism that correctly joins those 15. The columns of one probe do not mark which is which.

## 4. Missed-match analysis

Identity truth on all 13 probes is `same_person`. Policy-expected is `separate`. The engine outcome is `new`, path B, score 1, score source `audit_log.confidence_score`, scoring skipped, skip reason `empty_block`, signals empty, explanation `scoring skipped: empty_block`, `matched_row` null. That signature is the same on all 13. Phone is blank on every row in this section.

The exact lookup used the probe email. That email is not the anchor email, so a miss at the exact lookup is what the singular-email rule does. The failure to find the anchor happens at the next stage, the block. `empty_block` means each available key returned zero live fans. Nobody was scored, so nobody was ranked and nobody was classified by a threshold. The score of 1 is the new-person confidence, not a match probability.

Reconstruction, not a stored block list: `findBlockCandidates` builds `email` when the inbound email is present, `guardian_email` when that field is present, and `name_dob` when both name and birthday are present. The importer does not send guardian email. It does send name, birthday, and ZIP when the CSV has them. ZIP is not a block key.

The anchor's name and birthday are stored only if `attachRemaining` ran on the anchor. The anchor rows for these scenarios are stored as `new` records, and the importer commits `attachRemaining` before the next row. This session did not read those `identifier_link` rows back. The reconstruction below assumes that commit happened, which is what the importer code does for a completed anchor.

### MB-2 — same name, new email, probe birthday missing (5)

Singular identifier: the probe email. It differs from the anchor email (`mb-2-0N.b@example.org` versus `mb-2-0N.a@example.org`). Normalized names are equal. The probe birthday is blank. The anchor birthday is present.

Available keys on the probe, reconstructed: `email` only. `name_dob` is not built, because the inbound birthday is null. The email key looks up the probe's new address, which no earlier row holds. The shared name is not a retrieval key. The anchor's birthday cannot be used from the probe side, because the probe did not bring a birthday.

| Case | Probe | Anchor | Name | Anchor email | Probe email | Anchor birthday |
|---|---:|---:|---|---|---|---|
| MB-2-01 | 312 | 232 | Lionel Gresham | mb-2-01.a@example.org | mb-2-01.b@example.org | 1992-08-01 |
| MB-2-02 | 313 | 233 | Maren Holbrook | mb-2-02.a@example.org | mb-2-02.b@example.org | 1992-09-02 |
| MB-2-03 | 314 | 234 | Nils Isley | mb-2-03.a@example.org | mb-2-03.b@example.org | 1992-10-03 |
| MB-2-04 | 315 | 235 | Odette Juniper | mb-2-04.a@example.org | mb-2-04.b@example.org | 1992-11-04 |
| MB-2-05 | 316 | 236 | Paolo Kestrel | mb-2-05.a@example.org | mb-2-05.b@example.org | 1992-12-05 |

Anchor ZIP is 80031 through 80035. Probe ZIP is 81031 through 81035.

Expected identity outcome: find the anchor and hold or join the same person. Actual: a new person, and the anchor was not in the candidate set. Earliest divergence: blocking, after a correct miss on the new email. This is candidate retrieval. It is not a ranking error. The person was never retrieved. The missing probe birthday is why the name-and-birthday key does not exist for this call. That is a property of the key rules, observed in `findBlockCandidates`, not a second independent bug.

### CO-1 — nickname, birthday month and day swapped, new email (4)

Singular identifier: the probe email (`co-1-0N.b@example.org`). The anchor email is `co-1-0N.a@example.org`. Last names match. First names are nickname pairs. Birthdays are the anchor date with month and day swapped. Both dates are real dates inside the recipe's range.

Available keys, reconstructed: `email` and `name_dob`. The email key misses. `name_dob` joins the exact last word to a `dob` identifier equal to the inbound birthday. The last word matches the anchor. The swapped birthday does not equal the anchor birthday, so that join does not return the anchor. The exact-name lookup does not run, because the singular identifier is the email, not the name. The nickname list in the scorer is never consulted, because scoring does not run.

| Case | Probe | Anchor | Anchor name | Probe name | Anchor birthday | Probe birthday |
|---|---:|---:|---|---|---|---|
| CO-1-01 | 349 | 269 | Robert Vernon | Bob Vernon | 1995-09-02 | 1995-02-09 |
| CO-1-02 | 350 | 270 | William Winslow | Bill Winslow | 1995-10-03 | 1995-03-10 |
| CO-1-03 | 351 | 271 | Elizabeth Yeager | Liz Yeager | 1995-11-04 | 1995-04-11 |
| CO-1-04 | 352 | 272 | James Barlow | Jim Barlow | 1995-12-05 | 1995-05-12 |

Anchor ZIP is 80068 through 80071. Probe ZIP is 81068 through 81071.

Expected identity outcome: find the anchor. Actual: a new person. The anchor was not retrieved. Earliest divergence: the block, on an exact birthday comparison, after the new email missed. Two later comparisons never happened: nickname matching, and the exact-name lookup. Those are consequences of the retrieval miss, not separate scored mistakes.

### CO-2 — last-name typo, same birthday, new email (4)

Singular identifier: the probe email. First names match. Birthdays match. Last names differ by one character. The block's name key is the exact last word, from `substring` of the stored name and from the inbound name's last word.

Available keys, reconstructed: `email` and `name_dob`. The email misses. The last words differ, so `name_dob` does not join the anchor even though the birthday string is the same. The exact full-name lookup does not run, because the singular identifier is the email.

| Case | Probe | Anchor | Anchor name | Probe name | Birthday |
|---|---:|---:|---|---|---|
| CO-2-01 | 353 | 273 | Bodhi Bramley | Bodhi Bramly | 1996-01-06 |
| CO-2-02 | 354 | 274 | Cleo Ostler | Cleo Ostlar | 1996-02-07 |
| CO-2-03 | 355 | 275 | Daria Quinlan | Daria Quinlen | 1996-03-08 |
| CO-2-04 | 356 | 276 | Enzo Sutcliffe | Enzo Sutclife | 1996-04-09 |

Emails are `co-2-0N.a@example.org` on the anchor and `co-2-0N.b@example.org` on the probe. Anchor ZIP is 80072 through 80075. Probe ZIP is 81072 through 81075.

Expected identity outcome: find the anchor. Actual: a new person. The anchor was not retrieved. Earliest divergence: the block's exact last-word comparison. Scoring, including a fuzzy name comparison, did not run. This is candidate retrieval.

## 5. Root-cause breakdown

Primary class, from the stored skip reason and the branch that writes it:

| Class | Rows | Cases |
|---|---:|---|
| Identity decision logic: exact hit kept as a hard match, scoring not run | 19 | SFE-2, SFE-3, MB-3, CA-4 |
| Candidate retrieval: block returned nobody after the exact lookup missed | 13 | MB-2, CO-1, CO-2 |
| Candidate ranking or scoring | 0 | |
| Matching thresholds | 0 | |
| Data normalization | 0 | |
| Blocking size cap (`block_dropped_oversize`) | 0 | |
| Undetermined mechanism | 0 | |

The 19 split by the condition that kept the hard match:

| Condition inside the hard-match rule | Rows | Cases |
|---|---:|---|
| Inbound birthday absent, so the exception does not run. A different first name is unused. | 6 | SFE-2 |
| Birthdays present and equal, so the exception keeps the email hit. A different first name is unused. | 3 | SFE-3 |
| Exact name, and the anchor has no stored birthday for the probe birthday to conflict with. | 5 | MB-3 |
| Exact name and equal birthdays. The probe has no email. | 5 | CA-4 |

The 13 split by which reconstructed key missed:

| Retrieval gap | Rows | Cases |
|---|---:|---|
| Only the new email can be a key. The shared name is not a key, and the probe birthday is absent so `name_dob` is not built. | 5 | MB-2 |
| Email misses, and `name_dob` misses because the birthday month and day are swapped. Nickname matching does not run. | 4 | CO-1 |
| Email misses, and `name_dob` misses because the last word differs by a typo. | 4 | CO-2 |

Distinctions asked for in the task:

- Never retrieved: all 13 misses. Stored evidence is `empty_block` and `matched_row` null.
- Retrieved and ranked incorrectly: none of these 32. Scoring did not run, so there is no rank.
- Retrieved and classified incorrectly by a threshold: none. `pathForMatch` is not the branch for a path A return, and it is not consulted when `candidates_considered` is 0.
- Hard-matched despite evidence that was on the call and not consulted: SFE-2 and SFE-3. The different first name was submitted in `identifiers` and the path A branch returned first. SFE-2 has no birthday conflict to consult. SFE-3 has agreeing birthdays, which the exception treats as permission to keep the email hit.
- Hard-matched without a conflicting shared field: MB-3 and CA-4. The disagreement is missing data (no anchor birthday, or no probe email), not two different values in one field that the scorer then ignored.

## 6. Evidence and reproducibility

Within each scenario, all probes share one stored outcome signature. The count is 6 + 3 + 5 + 5 + 5 + 4 + 4 = 32, which is the S1-05 false-merge count plus the missed-match count. No other scenario in the metrics file has a false positive or a false negative.

The field pairs in the tables were read from the rebuilt CSVs. The decisions were read from `synthetic-360-import-results.json`. The branch that produces `deterministic_match` on path A, and the branch that produces `empty_block` on path B, are the current `resolverEngine.js`. The singular-identifier choice is the current `customerImport.js`.

S1-04 recorded that a second import on a new org matched every field except `org_id`, `batch_id`, `fan_id`, `matched_fan_id`, and `conflict_id`. This investigation did not run that import again. A fresh database trace of `block_results` was not captured. The committed file and that earlier second run are evidence about the outcome signature. The code and the CSV are the basis for the key-by-key reconstruction. Neither one was confirmed by reading `resolution_trace.block_results` for these rows, because those arrays are not in the committed results file. Reproducibility has not been established. The import was not rerun for this analysis, the per-row `block_results` were not preserved, and the miss-side key list was reconstructed.

The score of 1 does not mean the scorer returned 1. `score_source` is `audit_log.confidence_score` on all 32, and both the path A and path B branches assign `confidence_score = 1.0` without calling `scoreMatch`.

## 7. Known limitations and undetermined cases

The mechanism of each of the 32 is determined at the level of "hard match kept" or "block returned nobody." Reproducibility verification is unresolved. The import was not rerun during the original investigation. Individual `block_results` were not preserved. Miss-side key analysis was reconstructed from code and CSV data. The following are not determined from a live query in this session:

- How many rows the exact-lookup query returned before `rows[0]` was taken. The stored link is the anchor. A second fan with the same email or exact name is not what the recipe checker is written to allow. That checker was not re-run against the import database here.
- The stored `block_results` array for the 13 misses. `empty_block` says every built key was empty and none was dropped for the cap of 50. Which keys were built is reconstructed. Guardian email was not on these rows. A key the reconstruction names cannot have returned the anchor, or the skip reason would not be `empty_block`.
- Whether `attachRemaining` wrote the anchor name and birthday, as opposed to the resolver's single singular row. Completed anchor rows and the importer's commit order are the evidence. The `identifier_link` table for this org was not read.

No row in the 32 is an undetermined cause. Two pairs are determined and still not separable from a success:

- MB-3 and MB-4 share the columns an import can see and carry opposite identity truth. Five false merges and five true positives take the same path.
- CA-4 and A-NO-EMAIL share the decision shape. Five false merges and fifteen true positives take the same path. CA-4 is marked `indistinguishable` on the label. A-NO-EMAIL is not.

The 10 recycled-phone import errors (RP-1, RP-2) are outside this analysis. They are not in the 19 or the 13. The 60-scenario benchmark's own false positives and false negatives were not traced here.

## 8. Prioritized improvement opportunities

These are hypotheses about where a later change would have to act. They are not selected rules, and this document does not implement them. Each one changes a written policy, not a threshold that these 32 never reached. Approved direction from the review is recorded in section 11. This list is the earlier hypothesis list. It is not the approved rule, and nothing in it is implemented.

1. SFE-2 and SFE-3. The different first name is already on the call and is ignored after an email hit. A review when the normalized names differ would meet both the missing-birthday case and the same-birthday case. SFE-1 already reviews the shared-email case when the birthdays differ. Whether a different first name should do the same, including when the birthdays agree, is a policy choice.
2. MB-3. Stopping the hard match when the anchor birthday is missing also stops MB-4, which is the same columns and a true positive. The opportunity is a review for that shape, not a score cutoff that can see a difference the columns do not have.
3. CA-4. Stopping the hard match for exact name plus the same birthday when the probe has no email also stops the 15 A-NO-EMAIL true positives. The opportunity is the same kind of review. The label already says the probe fields do not separate the CA-4 people.
4. MB-2. Finding these five requires a retrieval key that can fire with a shared name and no probe birthday, after a new email has missed. Name-alone retrieval is not one of the three block keys. Adding it is a new key, and the current design treats an unnarrowed or weakly narrowed scan as a product decision because a weak key can manufacture reviews.
5. CO-1. The anchor is excluded by the exact birthday inside `name_dob`, and the nickname never reaches the scorer. A month-and-day swap inside the block, or an exact-name lookup that still runs when the singular identifier is a different email, would be a new retrieval rule. The nickname list cannot help a person who was not retrieved.
6. CO-2. The anchor is excluded by the exact last word. A fuzzy last name in the block would be a new retrieval rule. The scorer's spelling check does not run on an empty block.

No opportunity in this list is "lower 0.85" or "lower 0.60." Those comparisons did not execute for these rows.

## 9. Questions requiring policy decisions

1. When an email hits and the first names differ, should that be a review for a missing probe birthday (SFE-2), for an agreeing birthday (SFE-3), for both, or for neither?
2. When an exact name hits and one side has no birthday (MB-3 and MB-4), should both shapes go to review?
3. When an exact name and the same birthday hit and the incoming row has no email (CA-4 and A-NO-EMAIL), should both shapes go to review?
4. For a same person with a new email and no birthday (MB-2), is a name-only retrieval key acceptable, or is that miss an accepted limit of the three block keys?
5. For a swapped birthday (CO-1) or a last-name typo (CO-2), should either comparison exist inside retrieval, or should those misses stay outside the search?

Approved direction for these questions is recorded in section 11. That direction was not implemented on November 18. Question 2 is resolved by Decision 6 in section 13. The other ambiguities in section 11 stay open, except the Decision 2 and Decision 4 reading that section 13 closes.

## 10. Retrieval, evaluation, and decision

These are separate stages. Approval of a retrieval rule is not approval of an automatic match.

1. Candidate retrieval. Identify records worth considering. A retrieved record is only a candidate.
2. Matching evaluation. Evaluate the identity evidence on that candidate, including agreement and disagreement.
3. Decision. Automatic match, human review, or no match.

The current engine collapses some of these. An exact email or exact name can be both the retrieval and the automatic match, and path A returns before scoring. Sections 3 and 4 describe that behavior as it ran. Section 11 is the approved direction for a later change. It is not a description of what the code does now.

Under that direction, retrieval still does not authorize an automatic match. A candidate that is retrieved and then held for review is not discarded. A candidate that is not automatically matched is not, by that fact alone, dropped from consideration.

## 11. Approved policy decisions

Recorded from the failure-analysis review on November 18, 2026. This is approved direction. It is not implemented. The case evidence in sections 3 through 7 is unchanged.

### Decision 1: Exact email with conflicting first name

Approved behavior:

- Exact email may retrieve a candidate.
- A conflicting first name prevents automatic matching.
- The candidate must be sent for human review.
- Do not automatically merge or discard the candidate.

Rationale: An exact email match is not sufficient to override contradictory identity information.

The SFE-2 and SFE-3 rows are the cases in this file where an exact email hit and the first names differ. Today's engine auto-merged them. This decision says that shape goes to review instead. It does not say the code has been changed.

### Decision 2: Exact name with missing birthday

Approved behavior:

- Exact normalized first and last names may retrieve a candidate.
- Missing DOB prevents automatic matching under this policy.
- Send the candidate for human review.
- Do not automatically merge or discard the candidate.

Rationale: Exact names alone do not provide sufficient distinguishing evidence.

The MB-3 rows are the cases in this file where an exact name hit and the anchor birthday is missing. Today's engine auto-merged them. This decision says missing DOB blocks the automatic match and the candidate goes to review.

### Decision 3: Exact name and matching birthday without incoming email

Approved behavior:

- Retrieve the candidate.
- Do not automatically merge when incoming email is missing under this policy.
- Send the candidate for human review.
- Do not discard the candidate.

Rationale: Exact name and DOB provide stronger evidence than name alone, but the agreed policy requires additional verification.

The CA-4 rows are the cases in this file where the exact name and birthday match and the probe email is blank. Today's engine auto-merged them. This decision says that shape goes to review.

### Decision 4: Name-only retrieval when DOB is missing

Approved behavior:

- Allow candidate retrieval using exact normalized first and last names even when DOB is missing.
- Retrieval does not authorize automatic matching.
- Existing downstream matching safeguards remain applicable.
- Evaluate additional candidate volume and false candidate retrievals experimentally.

Rationale: Prevent potentially legitimate matches from being discarded prematurely.

The MB-2 rows are the cases in this file where the names match, the emails differ, and the probe birthday is missing, so today's `name_dob` key is not built and the anchor is not retrieved. This decision approves retrieval by the exact full name in that situation. It does not approve an automatic match. The experimental volume check has not been run.

### Decision 5A: Swapped or conflicting birthdays

Approved behavior:

- Allow retrieval when exact normalized first and last names match, even when birthdays disagree.
- Preserve the birthday disagreement as conflicting information.
- Do not treat the birthday disagreement as supporting identity evidence.
- Retrieval does not authorize automatic matching.

Rationale: Birthday transposition and source-data errors may otherwise cause legitimate candidates to be missed.

### Decision 5B: Surname spelling variations

Approved behavior:

- Allow constrained surname-similarity retrieval when supported by corroborating information.
- Examples of corroborating information include matching first name and matching DOB.
- Do not allow surname similarity alone to retrieve candidates.
- Retrieval does not establish identity or authorize automatic matching.

Rationale: Small surname spelling variations may represent legitimate matches, but surname similarity alone creates unacceptable ambiguity.

The CO-2 rows have the same first name, the same birthday, and a one-character surname difference. They are the cases in this file that match the corroboration example. Today's block uses the exact last word, so those anchors were not retrieved. This decision approves a constrained retrieval for that shape. It does not define the similarity function, and it does not approve an automatic match.

### Ambiguities for discussion

These are gaps between the approved wording and the case evidence. This file does not close them.

- Decision 1 does not define "conflicting first name." The SFE-2 and SFE-3 first names are different given names, not nicknames. The decision does not say whether a nickname pair counts as a conflict, or what happens when the email matches and the first names agree, or when one first name is absent.
- Decision 2 says "missing DOB" and does not say which side. On MB-3 the anchor birthday is blank and the probe birthday is present. MB-4 has the same columns and is a true positive under today's rule. The decision does not name MB-4. Whether both shapes go to review is the consequence already described in section 7, and it is not restated here as an extra decision. Decision 6, in section 13, closes this gap. Both shapes go to review. The November 18 wording above is the gap as it stood.
- Decision 3, read as written, also covers A-NO-EMAIL probes 126–140: exact name, same birthday, no incoming email. Those 15 are true positives today. The decision does not name Set A. Section 7 already records that the columns do not separate that shape from CA-4.
- Decision 4 says existing downstream matching safeguards remain applicable. Today's exact-name path auto-merges when a birthday is missing. Decision 2 says that automatic match must not happen. If "existing" means the current hard-match rule, Decision 4 and Decision 2 disagree. If "existing" means the safeguards that remain after Decisions 1 through 3, they agree: retrieve, then review. Decision 6 chooses the second reading for an exact name with either birthday missing: retrieve the candidate, then review. It does not choose a reading for any other Decision 4 case.
- Decision 5A requires exact normalized first and last names. The CO-1 probes do not have exact first names. They are Robert/Bob, William/Bill, Elizabeth/Liz, and James/Jim, and the birthdays are swapped. Decision 5A as written does not retrieve those four rows. The decision does not say that a nickname counts as an exact first name.
- Decision 5B gives matching first name and matching DOB as examples of corroboration. CO-1 has neither an exact first name nor an agreeing birthday, so it is not that example. CO-2 does match the example. The decision does not set the similarity measure, the threshold, or which other fields count as corroboration. Surname similarity alone stays disallowed.
- Decisions 5A and 5B approve retrieval only. They do not say whether the later decision for a retrieved CO-1 or CO-2 pair is review or no match. "Retrieval does not authorize automatic matching" leaves that choice open.

## 12. Implementation status

| Item | Status |
|---|---|
| Failure analysis | Drafted |
| Case-level evidence | Documented |
| Policy decisions | Approved direction |
| Reproducibility verification | Outstanding |
| Technical requirements | Not yet finalized |
| Implementation | Not started |
| Experimental validation of proposed policies | Not started |

The approved direction in section 11 is not matcher behavior as of this section. No threshold, retrieval rule, or decision rule had been changed to carry it out when this status was written. The experimental check named in Decision 4 has not been run. Reproducibility of the original trace has not been established: the import was not rerun, individual `block_results` were not preserved, and the miss-side key analysis was reconstructed from code and CSV data.

## 13. Decision 6 — exact name with a missing birthday

Approved November 20, 2026. This resolves question 2. It is not implemented. Sections 3 through 7 stay the observation of the November 18 import.

Observed behavior, unchanged by this section: on MB-3 and MB-4 the singular identifier is the exact name. The anchor birthday is blank and the probe birthday is present. The birthday exception does not run, because there is no stored birthday to differ. The engine hard-matches the anchor, path A, skip reason `deterministic_match`. MB-3 is a false merge. MB-4 is a true positive. The two groups use the same columns.

Approved policy:

- An exact-name candidate stays eligible for retrieval when the stored birthday is missing, the incoming birthday is missing, or both are missing.
- A missing birthday does not authorize a hard match on that exact name.
- Both birthdays present and equal: the existing exact-name hard match stays.
- Both birthdays present and different: the existing birthday-conflict review stays.
- Either birthday missing: open a human review. Do not link the records automatically, and do not drop the candidate.
- The rule is the same whichever record is missing the birthday.

Required future behavior: find the exact-name candidate, then create a pending review instead of path A. Do not change scoring thresholds to produce that review. Do not treat a missing birthday as a birthday conflict. A conflict still requires both birthdays, and those birthdays must differ.

MB-3 and MB-4 are one observationally indistinguishable class. The available fields cannot tell a different person from the same person. Both groups get the same treatment, a human review. The synthetic ground-truth labels stay as written: MB-3 `distinct_person`, MB-4 `same_person`. This decision does not claim the matcher can determine the true identity from those fields.

This decision does not change an exact-email hard match. A missing birthday still keeps that email hard match under the current policy, including MB-1, where the email and the name both match and the probe birthday is missing.

Decision 6 does not adopt Decision 3. Decision 3 says an exact name and an equal birthday go to review when the incoming email is missing. Decision 6 says that equal-birthday exact-name hard match stays. CA-4 and A-NO-EMAIL remain the conflict between those two approvals. Question 3 is not resolved here.

Decision 5B's later implementation is a different change. On November 20 the resolver gained a `similar_surname` retrieval key: exact first name, exact birthday, and raw Levenshtein distance at most 1 between surnames. That key does not establish identity. The Decision 5B paragraph above describes the engine this analysis traced, which used the exact last word. It is not a description of the resolver after that key.
