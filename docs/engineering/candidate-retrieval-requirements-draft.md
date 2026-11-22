# Candidate retrieval requirements (draft)

Draft as of 2026-11-17. This document states what a candidate-retrieval layer must accomplish. It does not implement that layer, and it does not amend `docs/engineering/matching-policy.md`.

Decision 3 and Decision 6 are identity decisions recorded in that policy and in `docs/engineering/sprint-1.5-failure-analysis.md`. The resolver now implements them. They do not change the retrieval evidence below. An exact normalized full name remains a candidate when either birthday is missing, and when both birthdays match and the incoming email is missing. A missing birthday leads to a human review. Both birthdays equal and an incoming email missing also leads to a human review. A missing birthday is still not a birthday conflict. Both birthdays equal, with an incoming email present, stays the existing exact-name hard match.

Experiment 6 is evidence. The agreed direction in the review is the source of the requirements marked **agreed**. Anything this file does not have agreement for is marked **proposed** or **unresolved**. None of these statements are production policy until the canonical policy is explicitly changed.

Evidence lives in `/tmp/gr-exp-multi-identifier-v1/` (`out/report.md`, `out/per-probe.csv`, `out/configurations.csv`). Set B has 80 probes and 80 anchors. Recall below is out of 39 same-person anchors.

## 1. Purpose and scope

The retrieval layer returns the people a later step is allowed to evaluate. It exists so that a same person is still findable when one identifier is new, missing, or in conflict, and so that a different person who shares a qualifying identifier is still present for that evaluation.

In scope:

- Which records enter the candidate set.
- Which differences must stay attached to a candidate.
- Which signals are required, rejected, or not yet bounded.

Out of scope:

- Ranking the set.
- Choosing a match, a review, or a new identity.
- Merge and unmerge.
- Thresholds, edit distances, and algorithms that this draft does not have agreement for.
- Changing the canonical matching policy in place.

## 2. Definitions and terminology

| Term | Meaning in this draft |
|---|---|
| Candidate | A stored person returned for evaluation against the inbound record. Presence in the set is not a claim that the two records are the same person. |
| Retrieval signal | A stated comparison that is sufficient to put a stored person in the set. Signals are unioned. One failed signal does not cancel a different signal that succeeded. |
| Qualifying candidate | A stored person who meets at least one required signal in this draft. |
| Normalized full name | The production name normalization: trim, lowercase, collapse internal whitespace. |
| Surname | The last word of the normalized full name. This is the same token the current last-name-plus-birthday key uses. |
| Nickname | A first-name pair in the existing production given-name list. This draft adds no names to that list. |
| Missing birthday | One side has no birthday. A missing birthday is not a conflict. |
| Birthday conflict | Both sides have a birthday and the values differ. |
| Spelling variation | The surname is the same name misspelled. CO-2 is four one-character deletions. |
| Replaced surname | The surname is a different name. CA-2 is four married surnames. |
| Empty set | Retrieval returned nobody. It is an input to a later decision. It is not, by itself, a decision that the person is new. |

Experiment 6 IDs are case IDs. For a paired result the probe and its own anchor share that ID. A cross-pair candidate names both IDs.

## 3. Candidate-retrieval principles

### CR-P1. A failed identifier does not erase a successful one

**Status:** agreed.

**Statement.** A non-matching email must not prevent another qualifying signal from returning its candidates. A missing or conflicting birthday must not silently remove a candidate that another qualifying signal already returned.

**Rationale.** The current import uses the email as the singular identifier whenever the row has one. After that lookup misses, discovery does not search the exact full name. MB-2 is a same person with an unchanged name, a new email, and no probe birthday, and production retrieval returned nobody.

**Evidence.** MB-2-01 through MB-2-05. Production missed all five. Exact full name retrieved all five. SFE-1-01 through SFE-1-08 show the other half: an exact email still returns the candidate when the birthdays differ.

### CR-P2. Conflicts stay on the candidate

**Status:** agreed.

**Statement.** Retrieval records a missing birthday and a birthday conflict as properties of the candidate. It does not delete the candidate in order to hide either condition.

**Rationale.** Downstream evaluation needs the disagreement. Removing the person at retrieval time makes that evaluation impossible.

**Evidence.** CA-1-01 through CA-1-05 are the same person, the same email, the same name, and a month/day swap. SFE-1-01 through SFE-1-08 are different people, the same email, and birthdays two years apart. Both groups qualify by exact email. The swap and the two-year shift are different facts and both remain visible.

### CR-P3. Retrieval is not the identity decision

**Status:** agreed.

**Statement.** A returned candidate does not establish that the records are the same person. An empty set does not establish that the person is new. Ranking, gating, review, matching, and creation of a new identity are later layers.

**Rationale.** Experiment 6's expanded set retrieved every same-person anchor and still contained 38 candidates whose anchor is a different person. The 13 production misses were an empty set for people who were not new.

**Evidence.** Production retrieval: 26 correct and 35 unrelated, with misses MB-2-01–05, CO-1-01–04, and CO-2-01–04. Expanded retrieval: 39 correct and 38 unrelated. RP-1-01 through RP-1-06 are different people and an empty set under every signal this experiment ran.

## 4. Required retrieval behaviors

### CR-R1. Exact normalized full name is a retrieval path

**Status:** agreed.

**Statement.** An unchanged normalized full name returns the stored person, including when the email differs, the inbound birthday is missing, the stored birthday is missing, or the birthdays conflict. The birthday condition is attached. It does not remove the candidate.

**Rationale.** The name is the evidence that was stable in MB-2. The current post-miss keys cannot see it when the probe birthday is missing, and the singular email lookup does not fall through to the name.

**Evidence.**

| Case | What differs | Production | Exact full name |
|---|---|---|---|
| MB-2-01–05 | New email, probe birthday missing, name unchanged | Miss | Retrieved |
| MB-4-01–05 | Probe email missing, anchor birthday missing, name unchanged, same person | Retrieved, because the singular key was the name | Retrieved |
| MB-3-01–05 | Same shape as MB-4, different person by the recipe | Retrieved | Retrieved |
| CA-3-01–05 | Same name, birthdays two years apart, probe email missing | Retrieved by the exact-name birthday review | Retrieved |
| CA-4-01–05 | Same name, same birthday, probe email missing, different person | Retrieved | Retrieved |
| CA-5-01–03 | Same name, same birthday, different email, different person | Retrieved by last name plus birthday | Retrieved |

MB-3 and MB-4 present the same fields. CA-4 has no field in the file that separates the two people. Retrieval returns both shapes. It does not decide between them.

### CR-R2. A listed nickname plus the same surname is a retrieval path

**Status:** agreed.

**Statement.** When the first names are in the same existing nickname group and the surnames match exactly, the stored person is a candidate. A new email does not block that path. A birthday conflict, including a month/day swap, stays attached to the candidate.

**Rationale.** CO-1 is a same person the exact keys do not find. The nickname list already contains the four pairs. No new nickname mapping is authorized.

**Evidence.** CO-1-01 Bob/Robert Vernon, CO-1-02 Bill/William Winslow, CO-1-03 Liz/Elizabeth Yeager, CO-1-04 Jim/James Barlow. Each probe has a new email. Birthdays are swapped, for example 1995-02-09 against 1995-09-02 on CO-1-01. First-name Jaro-Winkler is 0.50, 0.7262, 0.7778, and 0.72. The nickname signal and the month/day observation both found the anchor. This requirement adopts the nickname-plus-surname path. It does not adopt a Jaro-Winkler path.

### CR-R3. Every stored person who meets a required signal is returned

**Status:** agreed.

**Statement.** If more than one stored person meets a required signal, the set contains each of them. Retrieval does not keep an arbitrary single row and drop the rest.

**Rationale.** A shared name or a shared email is often more than one person. Evaluating one and ignoring the others is an identity decision made inside retrieval.

**Evidence.** Experiment 6's exact keys happened to hit only the paired anchor, because the generator forbids those collisions outside the pair. The canonical policy already states the behavior this requirement rejects: when several people share an exact name, the lookup reads one of them and the others are not part of that decision. CA-4-01 through CA-4-05 and MB-3-01 through MB-3-05 are the cases where the visible fields do not identify a unique person.

### CR-R4. Exact email, exact guardian email, and exact last name plus exact birthday remain in force

**Status:** agreed as carried forward from the canonical policy. This draft does not re-derive them and does not withdraw them.

**Statement.** Those three keys still return candidates under the canonical policy. This draft adds paths. It does not replace those keys. Their candidates follow CR-P1 and CR-P2: a birthday gap or conflict is recorded and does not, by itself, remove a person an exact key returned.

**Rationale.** Experiment 6 measured them. It did not produce an agreement to delete them. Guardian email had no rows to measure.

**Evidence.** Exact email returned 13 same-person anchors and 17 different-person anchors (SFE-1-01–08, SFE-2-01–06, SFE-3-01–03). Exact last name plus exact birthday returned 8 same-person anchors (RP-2-01–04, CO-3-01–04) and 11 different-person anchors (CA-4-01–05, CA-5-01–03, SFE-3-01–03). Exact guardian email returned nobody because no Set B row has the field.

## 5. Treatment of missing and conflicting information

### CR-M1. Missing is not the same condition as conflict

**Status:** agreed. The definition is the canonical policy's definition, carried forward.

**Statement.** A birthday conflict exists only when both records have a birthday and the values differ. A missing birthday on either side is recorded as missing. Retrieval must not treat the two conditions as one condition.

**Rationale.** SFE-2 has a shared email and no probe birthday. SFE-1 has a shared email and two different birthdays. Both are candidates. The reason a later step is looking at them is different.

**Evidence.** SFE-2-01 through SFE-2-06. SFE-1-01 through SFE-1-08. CA-1-01 through CA-1-05, where both birthdays exist and one is the month/day swap of the other.

### CR-M2. A month/day swap is a conflict, not an equal birthday

**Status:** agreed as an observation that retrieval must preserve. The swap is not adopted here as a new general date rule beyond the nickname path's duty to keep it visible.

**Statement.** When both birthdays are present and one is the month/day transposition of the other, the candidate stays, and the two dates stay different. Retrieval must not store them as the same birthday.

**Rationale.** The Set B recipe constructs that transposition on purpose, and the dates are real different dates. CO-1 would disappear if a swap were either ignored or normalized away before the nickname path could record it.

**Evidence.** CO-1-01 through CO-1-04 and CA-1-01 through CA-1-05. Nine pairs. No unrelated candidate came from the swap comparison in Experiment 6. A two-year shift, as in SFE-1 and CA-3, is not this pattern.

### CR-M3. Absence of a field limits that field's signal only

**Status:** agreed.

**Statement.** A signal that needs a field does not fire when the field is missing. Other signals that do not need the field still fire.

**Rationale.** Last name plus birthday cannot be built for MB-2 because the probe birthday is missing. The full name is present and matches. Using the missing birthday to skip the name is the failure CR-P1 forbids.

**Evidence.** MB-2-01 through MB-2-05. Twenty probes lack an email. Fifteen probes and ten anchors lack a birthday. All 160 Set B records lack a guardian email.

## 6. Exact and approximate retrieval signals

### CR-S1. Exact signals in this draft

**Status:** agreed.

**Statement.** The exact retrieval signals named by this draft are:

- Exact normalized email.
- Exact guardian email, as already stated in the canonical policy.
- Exact surname plus exact birthday.
- Exact normalized full name, including the cases in CR-R1.
- Existing nickname group plus exact surname, as stated in CR-R2.

A candidate qualifies if any one of them matches. The set is the union.

**Rationale.** Each named signal either already exists in the policy or was the agreed explanation of a same-person miss. Combining them into one score is an identity-layer action, not a retrieval rule.

**Evidence.** Section 4. The union of the policy's post-miss keys retrieved 21 of 39 same-person anchors (46 candidates, 25 of them unrelated). Adding the exact-name and nickname paths is what covers MB-2 and CO-1. CO-2 is not covered by any exact signal in this list.

### CR-S2. First-name Jaro-Winkler at 0.90 is not a retrieval signal

**Status:** agreed.

**Statement.** First-name Jaro-Winkler similarity at or above 0.90 is not a candidate-retrieval requirement. A future change would need its own approval. This draft does not set a different first-name threshold in its place.

**Rationale.** On Set B the comparison missed the four nicknames it might have been asked to catch, recovered the four surname deletions only because those first names were unchanged and unique, and added three candidates who share no surname, email, or birthday.

**Evidence.**

| Probe | Other anchor | First names | Jaro-Winkler |
|---|---|---|---:|
| MB-1-04 | SFE-1-05 | Keira / Kira | 0.9400 |
| CA-5-02 | SFE-3-02 | Vito / Victor | 0.9111 |
| CA-5-03 | CO-1-02 | Willa / William | 0.9429 |

CO-1-01 through CO-1-04 remain below 0.90. CO-2-01 through CO-2-04 score 1.0 because the first name is identical.

### CR-S3. The full-name scoring predicate is not adopted as a retrieval signal

**Status:** agreed as a refusal. Experiment 6 measured the predicate. The review did not adopt it.

**Statement.** The production full-name scoring predicate, including its 0.85 similarity comparison, is not a retrieval signal in this draft. It remains a scoring behavior in the canonical policy, where a nickname or a close spelling is scored only after a search key has already found the person.

**Rationale.** The predicate recovered CO-2, and it also recovered people exact name and the nickname list already cover. It missed the four replaced surnames in CA-2. Adopting it would choose the 0.85 boundary this draft is not allowed to invent.

**Evidence.** Scoring-predicate retrieval in Experiment 6: 35 correct, 18 unrelated, 4 missed. The misses are CA-2-01 Finn Drummond/Alden, CA-2-02 Gia Easton/Briscoe, CA-2-03 Holt Fenton/Carver, and CA-2-04 Isla Glover/Dewitt. Those four are already retrieved by exact email.

### CR-S4. Signals this draft does not add

**Status:** agreed.

**Statement.** Phone, ZIP, device id, phonetic surname, and any nickname outside the existing list are not retrieval signals in this draft.

**Rationale.** The canonical policy already excludes phone, ZIP, and device id from discovery. Experiment 6 did not produce agreement to add them. There is no phonetic implementation to adopt. The nickname list was not extended.

**Evidence.** RP-1-01 through RP-1-06 share a phone and were retrieved by nothing. RP-2-01 through RP-2-04 share that phone and were already retrieved by exact last name plus exact birthday. ZIP was present on the rows and was not a key.

## 7. Surname spelling variation versus completely replaced surnames

### CR-N1. The two surname problems stay separate

**Status:** agreed.

**Statement.** A small spelling variation and a completely replaced surname are different retrieval problems. A rule aimed at one must not be treated as a rule for the other.

**Rationale.** CO-2 changes one character and keeps the first name and the birthday. CA-2 replaces the surname and keeps the email and the birthday. One comparison that tries to cover both will either miss the married names or accept much larger surname changes than CO-2 demonstrates.

**Evidence.** CO-2-01 Bramley/Bramly, CO-2-02 Ostler/Ostlar, CO-2-03 Quinlan/Quinlen, CO-2-04 Sutcliffe/Sutclife, each with the same first name and the same birthday. CA-2-01 through CA-2-04, each with the same email, the same first name, the same birthday, and a different surname.

### CR-N2. A spelling variation may be retrieved only with corroboration

**Status:** agreed as a constraint. The comparison and the boundary are **unresolved** (UR-1, UR-2).

**Statement.** A small surname spelling variation may put a stored person in the candidate set only when corroborating first-name evidence and corroborating birthday evidence are also present. Surname similarity alone must not return a candidate. This draft names no algorithm, no threshold, and no edit distance.

**Rationale.** CO-2 is a real completeness gap: exact surname fails, and the unchanged first name plus the same birthday are what make the pair plausible. Experiment 6 does not say how large a spelling change is still "small." The full-name scores on those four pairs were 0.9231, 0.9091, 0.9231, and 0.9286 under the existing scoring predicate. Those numbers describe the four rows. They are not a boundary.

**Evidence.** CO-2-01 through CO-2-04. Production missed all four. No unrelated Set B candidate was produced by a surname-only comparison, because no surname-only comparison was run.

### CR-N3. A replaced surname is not discovered from the surname

**Status:** agreed.

**Statement.** Retrieval must not try to discover a completely replaced surname through surname similarity alone. Another qualifying signal, such as exact email, may still return that person.

**Rationale.** CA-2 shows that a married surname can be the same person and can still be far from the stored surname. The email is the signal that found them. The surname distance is not.

**Evidence.** CA-2-01 through CA-2-04. Exact email retrieved all four. The full-name scoring predicate retrieved none. This does not establish a way to find a replaced surname when no other qualifying signal exists.

## 8. Separation from ranking, gating, identity decisions, and identity creation

### CR-X1. Later layers may order or defer work. They may not drop a qualifying candidate

**Status:** agreed.

**Statement.** Ranking, gating, workload controls, and a block cap must not silently discard a person who met a retrieval signal in this draft. If a later layer cannot evaluate the full set, it reports that the set was not fully evaluated. The retrieval result itself still contains every qualifying person.

**Rationale.** A dropped candidate is indistinguishable from a person the signals never found. Experiment 6's value was the ability to count both the 13 misses and the 38 unrelated candidates. A cap that deletes rows before that count makes the next evaluation false.

**Evidence.** The largest block in Experiment 6 was 2. The cap of 50 removed nobody there. The requirement is about the cap's defined behavior, not about a result the cap produced on this file. The canonical policy drops a guardian-email block larger than 50 and scores nobody in it. That conflict is recorded in section 10.

### CR-X2. Identity matching and review read the set. They do not define it

**Status:** agreed.

**Statement.** A match decision, a review decision, and a decision to create a new identity consume the candidate set and its attached missing-field and conflict annotations. They are not retrieval signals. A birthday conflict may be decisive at that later layer. It is not a reason for retrieval to pretend the candidate was never found.

**Rationale.** The canonical policy scores a birthday conflict as a rejection of a person who was already retrieved, and in some paths it also turns an exact email or exact name into a hard match before any other candidate is considered. Those are identity outcomes. This draft keeps them outside the definition of the set.

**Evidence.** SFE-2 and SFE-3 are retrieved and are different people. The published evaluation counts them as false automatic links. CA-3 is retrieved with a birthday conflict and is held for review. MB-2 was not retrieved, and a new identity was created. CR-P3 is the retrieval statement. The decision of what those outcomes should become is not made here.

### CR-X3. Creating a new identity requires an explicit decision

**Status:** agreed.

**Statement.** An empty candidate set is not sufficient authority to create a person. Creation stays a separate decision, with the empty set as one of its inputs.

**Rationale.** The same empty outcome covered the 13 same-person misses and the 6 RP-1 probes. Retrieval cannot tell those two situations apart by emptiness alone.

**Evidence.** MB-2-01–05, CO-1-01–04, CO-2-01–04, RP-1-01–06.

## 9. Known limitations of Experiment 6

- The candidate pool was the 80 Set B anchors. Set A and the other probes were outside it. Approximate comparisons against that larger population were not measured.
- First names and surnames in Set B are nearly unique. Nickname-plus-surname added no unrelated candidate. That does not show the volume of the nickname list when many people share a surname.
- No guardian email was present. CR-R4 carries the policy key forward without new evidence.
- No phonetic algorithm exists in the repository. None was added.
- The block cap never fired. The frequency experiments, not Set B, are where common-name volume was measured.
- Phone and ZIP were withheld on purpose.
- Expanded retrieval's 39-of-39 same-person result included signals this draft rejects, in particular first-name Jaro-Winkler. Completeness against the requirements in this draft is not the same number as the expanded-union number.
- CO-2 contains four one-character deletions and no other spelling pattern. Insertions, transpositions, and longer edits were not in the file.
- MB-3 against MB-4, and CA-4, are indistinguishable on the fields an import can see. The recipe, not the fields, marks them as different people. Retrieval requirements cannot resolve that.

## 10. Conflicts with the canonical policy

These are discrepancies. This draft does not edit `docs/engineering/matching-policy.md`.

| Topic | Canonical policy today | This draft |
|---|---|---|
| Search after an email miss | The post-miss search is exact email, exact guardian email, or the same last name and the same birthday. A nickname or a close spelling is scored only when a search key already found the person. | CR-R1 returns an exact full name even when a different email is present. CR-R2 returns a listed nickname with the same surname before any other key has found the person. |
| Singular identifier | A call has one singular identifier. On import that is the email when the row has one, otherwise the name. A hit is a hard match, with the email and name birthday exceptions. | Retrieval can qualify a person through a signal that is not the singular identifier. Returning that person is not a hard match. |
| Several people, one exact name | The lookup reads one of them, with no set order. The others are not part of that decision. | CR-R3 returns every person who meets the signal. |
| Birthday conflict during scoring | A birthday conflict on a scored person rejects that person before any other agreement is counted. | CR-X2 leaves that rejection, if it remains, to the identity layer. Retrieval still returns the person and the conflict. |
| Block cap | A guardian email shared by more than 50 live people is dropped, and nobody in that group is scored. | CR-X1 forbids silently discarding a qualifying candidate. Experiment 6 did not show a replacement control. |
| Empty search | The resolution path creates a new person when no candidate is found. | CR-X3 says emptiness is not that decision. |
| One winner | After the lookup misses, the highest score is the person considered. An equal score keeps the person returned first. | CR-X1 says ranking must not remove the other qualifying people from the retrieval result. |

Aligned with the policy, and restated so the draft does not drift:

- A missing birthday is not a conflict.
- Exact email and exact name with a universal birthday conflict stay visible for review rather than disappearing. The policy already does this for the singular lookup. CR-P2 extends that visibility rule to every retrieval signal this draft requires.
- Phone is not a discovery key. ZIP and device id do not start a match.
- Nothing here authorizes an automatic merge.

## 11. Unresolved decisions requiring future approval

### UR-1. The surname-spelling boundary

**Status:** unresolved.

No approved comparison, threshold, or edit distance exists for CR-N2. CO-2-01 through CO-2-04 establish that a one-character deletion with the same first name and the same birthday is inside the problem. They do not establish the outside of the problem. Implementation of a surname-similarity signal waits on this approval. Until then, those four pairs remain a known retrieval gap, and this draft does not pretend an exact surname key covers them.

### UR-2. What corroborates a surname spelling variation

**Status:** unresolved.

CR-N2 requires corroborating first-name evidence and corroborating birthday evidence. In CO-2 both the first name and the birthday were exact. This draft does not decide whether a nickname, a missing birthday, or a conflicting birthday can serve as that corroboration. Those combinations were not the CO-2 cases.

### UR-3. Approval to change the canonical policy

**Status:** unresolved.

The conflicts in section 10 are recorded. This draft does not apply them. A later approval has to accept or reject each conflict before `docs/engineering/matching-policy.md` or the resolver changes. Workload control, including what happens to a block larger than 50, is part of that approval. This draft requires that a qualifying candidate not vanish silently. It does not choose the replacement.

### Later approval — Decision 3 and Decision 6, read together

**Status:** approved. Decision 3 is the more specific exception. Decision 6 governs a missing birthday. The resolver now opens those reviews, retrieves a listed nickname with the exact surname, and treats a populated non-equivalent first name as a review. This does not close UR-1, UR-2, or UR-3.

Question 2 in the failure analysis asked whether MB-3 and MB-4 both go to review. Decision 6 says yes, whichever side is missing the birthday. Question 3 asked whether CA-4 and A-NO-EMAIL both go to review. Decision 3 says yes: both birthdays are present and equal, and the incoming email is missing. Retrieval of the exact name stays, which is CR-R1. The synthetic labels stay as written, and the fields still cannot tell MB-3 from MB-4, or CA-4 from A-NO-EMAIL. The tables in this draft are the Experiment 6 evidence. They are not relabeled. An exact-email hard match, including MB-1, is outside this pair of decisions. In shape 1, an incoming email is present when it is non-missing. It does not have to equal the stored email. The 15 A-NO-EMAIL probes remain shape 2, with CA-4.

CR-R2 is implemented as retrieval permission. A listed nickname with the exact surname may enter the candidate set even when the birthdays differ. The birthday disagreement stays attached for identity evaluation. It does not authorize a hard match, and a nickname is not an exact first name under Decision 5A. A retrieved nickname pair that would otherwise be stored as a new person is held for review.

A populated first-name difference is an identity conflict when the names are not exact and the pair is not on the explicit variant list. The nickname groups are the located list. Fuzzy similarity is not equivalence. No spelling-variant inventory beyond those groups was approved here. This identity rule does not add a retrieval signal.

Decision 5B later chose the surname boundary this draft left open: exact first name, exact birthday, and raw Levenshtein distance at most 1. That retrieval key is implemented. The UR-1 and UR-2 text above is the unresolved wording from this draft. It is not a description of the resolver after that key.

### UR-4. Guardian email is not reopened

**Status:** unresolved only in the sense that Experiment 6 gives no new evidence. No decision to add, remove, or retune it is proposed.

The canonical policy's guardian-email key stands. Set B cannot confirm or challenge it.

## 12. Traceability

| Requirement | Status | Cases |
|---|---|---|
| CR-P1 | agreed | MB-2-01–05; SFE-1-01–08 |
| CR-P2 | agreed | CA-1-01–05; SFE-1-01–08; CO-1-01–04 |
| CR-P3 | agreed | Production misses MB-2-01–05, CO-1-01–04, CO-2-01–04; RP-1-01–06; expanded set 39 correct and 38 unrelated |
| CR-R1 | agreed | MB-2-01–05; MB-3-01–05; MB-4-01–05; CA-3-01–05; CA-4-01–05; CA-5-01–03 |
| CR-R2 | agreed | CO-1-01–04 |
| CR-R3 | agreed | Policy behavior for shared exact names; CA-4-01–05; MB-3-01–05 |
| CR-R4 | agreed, carried forward | Email: MB-1, CA-1, CA-2, SFE-1, SFE-2, SFE-3. Last name plus birthday: RP-2, CO-3, CA-4, CA-5, SFE-3. Guardian email: no Set B rows |
| CR-M1 | agreed | SFE-1-01–08; SFE-2-01–06; CA-1-01–05 |
| CR-M2 | agreed | CO-1-01–04; CA-1-01–05 |
| CR-M3 | agreed | MB-2-01–05; field counts in the Experiment 6 report |
| CR-S1 | agreed | Same cases as CR-R1, CR-R2, and CR-R4 |
| CR-S2 | agreed | MB-1-04 with SFE-1-05; CA-5-02 with SFE-3-02; CA-5-03 with CO-1-02; CO-1-01–04; CO-2-01–04 |
| CR-S3 | agreed | CO-2-01–04 recovered by the predicate and not adopted; CA-2-01–04 missed by the predicate |
| CR-S4 | agreed | RP-1-01–06; RP-2-01–04 |
| CR-N1 | agreed | CO-2-01–04 against CA-2-01–04 |
| CR-N2 | agreed as a constraint; boundary unresolved | CO-2-01–04; UR-1; UR-2 |
| CR-N3 | agreed | CA-2-01–04 |
| CR-X1 | agreed | Cap measured at 0 drops on Set B; policy drop at 50 is the conflict |
| CR-X2 | agreed | SFE-2; SFE-3; CA-3; MB-2 |
| CR-X3 | agreed | MB-2-01–05; CO-1-01–04; CO-2-01–04; RP-1-01–06 |
| UR-1 | unresolved | CO-2-01–04 |
| UR-2 | unresolved | CO-2 first names and birthdays were exact; other corroboration was not tested |
| UR-3 | unresolved | Section 10 |
| UR-4 | not reopened | No guardian-email rows |
