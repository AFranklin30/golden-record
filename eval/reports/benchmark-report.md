# Synthetic identity benchmark

Measured against the resolver as of the November 15, 2026 matching policy. Identity ground truth is separate from the resolution the engine produced. Automatic matches are not mixed with reviews.

Scenarios: 60.

## Metrics

Automatic decisions are hard matches and path B outcomes. A review is left out of precision and recall.

- True positives: 19.
- False positives: 2.
- True negatives: 7.
- False negatives: 5.
- Precision: 90.5%.
- Recall: 79.2%.
- F1: 84.4%.
- Review rate: 45% (27 reviews).
- Correct review rate: 96.3% (26 reviews that the policy predicted).
- Incorrect review rate: 0% (0 reviews the policy did not predict).
- Missed reviews: 0.
- Reviews of people who are not the same person: 10.
- Same person sent to review, excluded from recall: 13.
- Candidate retrieval rate: 100% (29 of 29).
- Blocking misses, where the same person was not retrieved: 4.
- Incorrect new-person rate: 13.5% (5 of 37 same-person scenarios created a new person without review).
- Policy mismatches: 0.
- Unspecified row order: 1.

## Results by category

- exact_match: 6 scenarios, 6 matched the policy, 6 true positives, 0 false positives, 0 false negatives, 0 reviews.
- incomplete: 8 scenarios, 8 matched the policy, 7 true positives, 0 false positives, 0 false negatives, 1 reviews.
- identity_change: 7 scenarios, 7 matched the policy, 3 true positives, 0 false positives, 2 false negatives, 2 reviews.
- similar_different: 7 scenarios, 7 matched the policy, 0 true positives, 0 false positives, 1 false negatives, 4 reviews.
- household: 7 scenarios, 7 matched the policy, 1 true positives, 1 false positives, 1 false negatives, 2 reviews.
- conflicting_evidence: 10 scenarios, 10 matched the policy, 2 true positives, 1 false positives, 0 false negatives, 7 reviews.
- blocking: 6 scenarios, 6 matched the policy, 0 true positives, 0 false positives, 1 false negatives, 4 reviews.
- ambiguity: 9 scenarios, 9 matched the policy, 0 true positives, 0 false positives, 0 false negatives, 7 reviews.

## Failures and weaknesses

### changed-phone-only

Category: identity_change. Identity: same_person.

Existing records:

```json
[
  {
    "phone": "4055550106"
  }
]
```

Incoming record:

```json
{
  "singular": "phone",
  "phone": "4055550107"
}
```

Expected: blocking_miss. Actual: blocking_miss.

- Path: B. Skip: no_block_key. Score: none.
- Candidates considered: 0. Signals: [].
- Fan: 1767133c-93d0-4b5c-b9e0-832cd5f4ad2f. Conflict with: none. New record: true.

The phone changed and no email, name, or birthday is present. No search key exists, so the same person is not retrieved and a new person is created.

### several-changes-at-once

Category: identity_change. Identity: same_person.

Existing records:

```json
[
  {
    "email": "before@example.com",
    "name": "ada lovelace",
    "dob": "1990-04-02",
    "zip": "73101"
  }
]
```

Incoming record:

```json
{
  "singular": "email",
  "email": "after@example.com",
  "name": "ada king",
  "dob": "1991-05-06",
  "zip": "10001"
}
```

Expected: blocking_miss. Actual: blocking_miss.

- Path: B. Skip: empty_block. Score: none.
- Candidates considered: 0. Signals: [].
- Fan: f90f0c1b-5c12-4240-a433-cc49b3c520f3. Conflict with: none. New record: true.

The email, last name, birthday, and ZIP all changed. None of the three search keys match, so the earlier person is not retrieved.

### transposed-characters

Category: similar_different. Identity: same_person.

Existing records:

```json
[
  {
    "name": "jane doe",
    "dob": "1990-04-02"
  }
]
```

Incoming record:

```json
{
  "singular": "nfc_uid",
  "nfc_uid": "F1B2C3D4",
  "name": "ajne doe",
  "dob": "1990-04-02"
}
```

Expected: scored_separation. Actual: scored_separation.

- Path: B. Skip: none. Score: 0.000.
- Candidates considered: 1. Signals: [].
- Fan: 248189f7-57ae-4af7-baab-07a65b0c90e0. Conflict with: none. New record: true.

Ajne Doe is a transposition of Jane Doe. The last name and birthday retrieve the person. The full name is not close enough, so a new person is created and no review is opened.

### guardian-email-as-singular

Category: household. Identity: different_people.

Existing records:

```json
[
  {
    "name": "ann singular",
    "dob": "2012-01-01",
    "guardian_email": "parent.singular@example.com",
    "source_system": "fan_pass"
  },
  {
    "name": "ben singular",
    "dob": "2014-02-02",
    "guardian_email": "parent.singular@example.com",
    "source_system": "fan_pass"
  }
]
```

Incoming record:

```json
{
  "singular": "guardian_email",
  "guardian_email": "parent.singular@example.com",
  "name": "cam singular",
  "dob": "2016-03-03"
}
```

Expected: hard_match. Actual: hard_match.

- Path: A. Skip: deterministic_match. Score: none.
- Candidates considered: 0. Signals: [].
- Fan: 041ea566-a656-4093-93b9-73ca296dd0b3. Conflict with: none. New record: false.

A resolve call that sends the guardian email as the singular identifier hard-matches one child and does not read the birthday. With two children, which child is returned is unordered.

### guardian-email-fifty-one

Category: household. Identity: same_person.

Existing records:

```json
[
  {
    "guardian_email": "parent.fiftyone@example.com",
    "source_system": "fan_pass"
  }
]
```

Incoming record:

```json
{
  "singular": "nfc_uid",
  "nfc_uid": "A7B2C3D4",
  "guardian_email": "parent.fiftyone@example.com"
}
```

Expected: blocking_miss. Actual: blocking_miss.

- Path: B. Skip: block_dropped_oversize. Score: none.
- Candidates considered: 0. Signals: [].
- Fan: b6af08e4-2f15-4d28-babc-45a5af577428. Conflict with: none. New record: true.

Fifty-one live people share a guardian email. The whole block is dropped. The person inside that block is not scored, and a new person is created.

### card-id-with-conflicting-birthday

Category: conflicting_evidence. Identity: different_people.

Existing records:

```json
[
  {
    "nfc_uid": "B1B2C3D4",
    "name": "ada lovelace",
    "dob": "1990-04-02"
  }
]
```

Incoming record:

```json
{
  "singular": "nfc_uid",
  "nfc_uid": "B1B2C3D4",
  "name": "ada lovelace",
  "dob": "1991-04-02"
}
```

Expected: hard_match. Actual: hard_match.

- Path: A. Skip: deterministic_match. Score: none.
- Candidates considered: 0. Signals: [].
- Fan: 659f67e4-bac2-45d1-b77d-cbac605d9f8f. Conflict with: none. New record: false.

The same card id hard-matches even though the birthdays differ. A card id is not subject to the email and name birthday review.

### person-exists-but-is-not-retrieved

Category: blocking. Identity: same_person.

Existing records:

```json
[
  {
    "email": "bob.smith@example.com",
    "name": "bob smith",
    "dob": "1990-04-02"
  }
]
```

Incoming record:

```json
{
  "singular": "email",
  "email": "bob.jones@example.com",
  "name": "bob jones",
  "dob": "1990-04-02"
}
```

Expected: blocking_miss. Actual: blocking_miss.

- Path: B. Skip: empty_block. Score: none.
- Candidates considered: 0. Signals: [].
- Fan: 7be4ec1f-9dd0-4ed1-b814-8ed29c7d10af. Conflict with: none. New record: true.

Bob Smith and Bob Jones share a birthday and a first name. The last names differ, and the emails differ, so the true person is not retrieved.

## Limitations

- A guardian-email match with no incoming name still opens a review. No household staging row is written, because that row requires a child name.
- A phone on a customer file is stored after the match. It does not find a person. A phone sent as the singular identifier hard-matches before a birthday is read.
- Guardian phone is stored for a household and is not a search key.
- Guardian email is shared by a household. It does not identify one child. More than 50 live people on one guardian email are dropped and not scored.
- The same exact name and the same birthday still hard-match, including two different people.
- An exact name or exact email with one birthday missing still hard-matches.
- Card and account ids hard-match even when the birthday on the same call differs.
- When several people share a name and only one of the stored birthdays matches, the lookup has no order, so the result is either a hard match or a review.
- An email or exact-name birthday review replaces a higher-scoring different person found on the same call.
- A changed last name, with no shared email and no shared birthday, is not retrieved.
- Nothing in this run merged two people.

## Later scenarios worth adding

- A street address, which this resolver does not store.
- A phone number used as a search key on a customer file.
- More than two imports in a row, including a review that is later confirmed or rejected.
- Names outside the five nickname groups.
- A tie broken by a stable order, once the lookup has an order.
