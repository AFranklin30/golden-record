# Synthetic dataset spec

Version 2. Written before any import or resolver run. This is the recipe for the labeled file, not a report of what the engine did.

Set A is the existing 200 rows. Their CSV bytes do not change. Set B adds 80 cases, each an anchor and a probe, 160 rows. The labeled file has 360 rows. The two sets are reported separately. They are not blended into one precision figure.

Seed: `synthetic-set-b-v1`. Generation is a pure function of that seed. There is no random draw. Import order is fixed: Set A rows 1–200 in the original builder order, then Set B anchors (rows 201–280) in the scenario order below, then Set B probes (rows 281–360) in that same case order.

## Identity truth

Identity truth comes from the recipe. It is never edited to match an engine result.

| Value | Meaning |
|---|---|
| `first_seen` | This row introduces a person. Set A originals and every Set B anchor. |
| `same_person` | The probe is the same person as its anchor. |
| `distinct_person` | The probe is a different person from its anchor. |

`truth_basis` is always `recipe`.

## Policy-expected outcome

The policy-expected outcome is the decision `docs/engineering/matching-policy.md` implies for that recipe. It is not a score from `scoreMatch` and not a resolver result.

| Value | Meaning |
|---|---|
| `hard_match` | Exact email or exact name returns the existing person (path A). |
| `review` | A pending review (path C or D). Nothing merges until a person confirms it. |
| `separate` | A new person (path B). |
| `import_replay` | The row is a byte-identical copy, so the import returns the earlier result and does not call the resolver. |
| `import_error` | The match decision is path B or D, and storing the phone then fails. |

A review of a same person, and a review of a distinct person, are kept as both labels. They are not counted as a disagreement. The policy says nothing merges on its own.

`truth_policy_disagreement` is true only when the automatic decision contradicts the person:

- distinct person, policy-expected hard match (flag `S0`)
- same person, policy-expected separate (flag `S2`)

`flag` `S1` marks the recycled-phone rows, where the match decision agrees with identity and the phone write is predicted to fail. `severity_if_auto_merged` is `S0` on every distinct-person probe, because an automatic merge of that person would be a false merge.

## Set A — existing 200 rows

Buckets and row order are unchanged: 80 originals, 5 same-email copies, 10 nicknames, 10 spellings, 20 same-name rows, 15 name-and-birthday rows with no email, 60 different first name and birthday.

| Scenario | Rows | Role | Identity truth | Policy-expected | Path | Notes |
|---|---|---|---|---|---|---|
| A-ORIGINAL | 80 | first_seen | first_seen | separate | B | First row of that person. The block is empty. |
| A-SAME-EMAIL | 5 | probe | same_person | import_replay | B | Byte-identical copy of originals 1–5. The import row key matches, so the resolver is not called. |
| A-NICKNAME | 10 | probe | same_person | review | D | Nickname, new email, new ZIP, same birthday. |
| A-SPELLING | 10 | probe | same_person | review | D | First-name spelling, new email, new ZIP, same birthday. |
| A-SAME-NAME | 20 | probe | same_person | review | D | Same name and birthday, new email, new ZIP. |
| A-NO-EMAIL | 15 | probe | same_person | hard_match | A | No email, so the name is the singular identifier, and the birthday matches. |
| A-DIFF-DOB | 60 | probe | distinct_person | separate | B | Different first name and a birthday one year later. Never scored. |

Policy sentences:

- Empty block: "If the lookup misses, the system searches only people who share an exact email, an exact guardian email, or the same last name and the same birthday."
- Replay: "One email, and one phone, still belong to one person in an organization, outside household rows." The replay itself is import behavior, recorded in the notes.
- Nickname and spelling: "A nickname or a close spelling is scored only when a search key already found that person."
- Same name: "A name and the same birthday can still open a review when the score is low, unless another person already scores high enough for review."
- No email: "The same exact name and the same birthday."

The default command `node scripts/buildSyntheticDemoCsv.js` still runs the old `scoreMatch` check on these Set A lookalikes and refuses to write the 200-row CSV if that check throws. That check does not label rows, and `--labels` does not call it. Set B is never passed through it.

## Set B — 80 cases, 160 rows

Own last-name pool, disjoint from Set A. Birthdays are in 1990–2005, with month and day each from 1 to 12 and not equal, so a month/day swap is a real different date. Emails use `@example.org`. Phones, only where the recipe has one, are `405-555-01xx`. Anchors are imported before probes.

A Set B probe may share an email, a phone, an exact name, or a last name plus birthday only with its own anchor. The generator checks that from the recipe fields.

| ID | Cases | Identity truth | Policy-expected | Path | Flag | Recipe |
|---|---|---|---|---|---|---|
| SFE-1 | 8 | distinct | review | D | | Shared email, different first name, both birthdays present and different. |
| SFE-2 | 6 | distinct | hard_match | A | S0 | Shared email, different first name, probe birthday missing. |
| SFE-3 | 3 | distinct | hard_match | A | S0 | Shared email, different first name, same birthday. |
| RP-1 | 6 | distinct | import_error | B | S1 | Same phone, different name, email, birthday, and ZIP. |
| RP-2 | 4 | same | import_error | D | S1 | Same phone, name, and birthday. New email. Different ZIP, so the score stays under the review floor rather than clearing it. |
| MB-1 | 4 | same | hard_match | A | | Same email and name. Probe birthday missing. |
| MB-2 | 5 | same | separate | B | S2 | New email. Probe birthday missing. |
| MB-3 | 5 | distinct | hard_match | A | S0 | Anchor has an email and no birthday. Probe has the same name, no email, and a birthday. |
| MB-4 | 5 | same | hard_match | A | | Same shape as MB-3, and the probe is the same person. |
| CA-1 | 5 | same | review | D | | Same email and name. Birthday month and day are swapped. |
| CA-2 | 4 | same | hard_match | A | | Same email and birthday. Married last name. |
| CA-3 | 5 | distinct | review | D | | Same name, different birthday, probe has no email. |
| CA-4 | 5 | distinct | hard_match | A | S0 | Same name and birthday, probe has no email. `indistinguishable` is true. |
| CA-5 | 3 | distinct | review | D | | Same name and birthday, new email, different ZIP. |
| CO-1 | 4 | same | separate | B | S2 | Nickname, birthday month and day swapped, new email. |
| CO-2 | 4 | same | separate | B | S2 | Last-name typo, same birthday, new email. |
| CO-3 | 4 | same | review | C | | Anchor has no email. Probe adds an email and repeats the name, birthday, and ZIP. |

That is 39 same-person probes and 41 distinct-person probes. Nineteen probes are S0 (SFE-2, SFE-3, MB-3, CA-4). Thirteen are S2 (MB-2, CO-1, CO-2). Ten are S1 (RP-1, RP-2).

Policy sentences, from `docs/engineering/matching-policy.md`:

- SFE-1 and CA-1: "A review opens only when every stored birthday differs from the inbound birthday."
- SFE-2, MB-1, MB-3, and MB-4: "A missing birthday on either side keeps the hard match."
- SFE-3 and CA-2: "One stored birthday that matches keeps the hard match, even if another stored birthday on that person differs."
- RP-1 and RP-2: "A second person cannot store the same phone. The first person is already saved, so the second write fails. That failure is not a review." The phone is also not a search key: "The matcher does not read it, so a phone on a file cannot find a person and cannot be compared with a birthday."
- MB-2, CO-1, and CO-2: "If the lookup misses, the system searches only people who share an exact email, an exact guardian email, or the same last name and the same birthday."
- CA-3: "A review opens only when every stored birthday differs from the inbound birthday." The lookup here is the exact name.
- CA-4: "The same exact name and the same birthday."
- CA-5 and CO-3: "A name and the same birthday can still open a review when the score is low, unless another person already scores high enough for review." CO-3 repeats the ZIP as well, so the expected path is C rather than the low-score floor.

## How a later run should be scored

These definitions are for the import that has not been run. Do not compute them by calling the engine from the generator.

One decision per probe, judged against its anchor. First-seen rows and anchors are a sanity check. They stay out of precision and recall.

| Term | Definition |
|---|---|
| Engine outcome | `auto_merge` (path A, or a replay onto the anchor fan), `review` (path C or D), `new` (path B), `import_error`. |
| True positive | Truth is `same_person` and the row auto-merged into the anchor fan. |
| False positive | Truth is `distinct_person` and the row auto-merged, or it merged into the wrong fan. |
| False negative | Truth is `same_person` and the outcome is new, with no review. |
| True negative | Truth is `distinct_person` and the outcome is new. Count how many were never scored. |
| Precision | True positives ÷ (true positives + false positives). Reviews are excluded. |
| Recall | True positives ÷ (true positives + false negatives). Reviews are excluded. |
| Found rate | (true positives + same-person reviews) ÷ same-person probes. |
| Review volume | Reviews ÷ probe rows. |
| Review yield | Same-person reviews ÷ reviews. |
| Auto-merge false-positive rate | Distinct-person auto-merges ÷ all auto-merges, plus the raw count. |

Policy conformance is a separate table: for each policy-expected value, whether the actual outcome was `hard_match`, `review`, `separate`, or `import_error`. A review of the right or the wrong person can still conform to the policy. A false merge is an identity error. Report Set A and Set B separately.

Severity when reading a future run: S0 is a distinct person auto-merged. S1 is a merge into the wrong person, or an import error that leaves a partial record. S2 is a silent miss. S3 is a review of distinct people. S4 is a missing trace.

Small buckets are behavior checks, not rates. With zero errors in n rows, the rule-of-three upper bound is 3 ÷ n.

## Freeze

`demo/synthetic-ground-truth-v2.json` is hashed in `demo/synthetic-dataset-manifest.json` before S1-04. The manifest records the seed, the source commit, and that label hash. Do not edit the labels after seeing import results. A correction is a new version with a changelog line.

Rebuild:

```
node scripts/buildSyntheticDemoCsv.js --labels
```

That command writes the v2 labels, the gitignored Set B CSV, and the manifest. It does not import the rows.
