# Golden Record — Project Status

As of 2026-11-16. Source commit `7fa878d`.
Figures below were measured in this audit unless marked **UNVERIFIED**.

## Dashboard

| | |
|---|---|
| Health | Yellow. The engine, review API, unmerge, and fan export are in the repo and a large part of the Jest suite passes. The commercial demo is not assembled. The quality numbers in the brief were not reproduced. |
| Current milestone | Commercial demo on the existing engine. |
| Current sprint | Sprint 0 — scope freeze and audit. IN PROGRESS. |
| MVP tasks complete | 5 of 35 (14%). Deferred pilot tasks are not in that 35. |
| Current task | S0-06. Aaron approves the proposed scope. |
| Completed | S0-01 inventory, S0-02 Jest, S0-03 harness, S0-04 data check, S0-05 these docs. |
| Remaining in this sprint | S0-06 only. |
| Blockers | Scope not approved. No UI in this repo. Firestore credentials missing, which dirtied the integration-test run. Hosted database role for row-level security is UNVERIFIED. Render is up; the deployed git SHA is UNVERIFIED. |
| MVP planning window | Aaron's envelopes add up to 10.5–16 days after scope approval (Sprints 1–4). That is the window he set, not a new estimate. |
| Next action | Approve or cut `SCOPE-AND-BACKLOG.md`. |
| Next three priorities | 1. Approve D-002, D-003, and D-005 (do not retune the matcher, do not cite the missing 60-scenario numbers, do not assume a dashboard). 2. S1-01, lock the 9-row scorecard. 3. S1-02, specify the 200-record synthetic set. |

## Measured test run

`npx jest --runInBand` after migrations `001`–`017` on local PostgreSQL 16.

Second run (unhandled rejections set to warn, so a missing Google credential did not kill the process):

- 541 passed
- 46 failed
- 1 skipped
- 588 total
- 17 suites passed, 7 failed

The one skip is the `all_candidates_gated` test, skipped in source.

The 46 failures are broken down in `SPRINT-TRACKER.md`. Two are documented in the test file as pre-existing. Five are the demo-seed suite running against an empty database. Thirty-nine are Jest reporting the Firestore credential error at `resolverEngine.js` during real Postgres resolutions. Those 39 were not observed as matching-logic assertion failures.

This is not "691 passed."

`CLAUDE.md` still says 546 passed / 558 total as of 2026-08-17. An older pull request body says 570 passed / 582 total. Neither matches this run. The suite has grown since those notes.

The 29 smoke and unit scripts outside Jest were not run. `npm test` does not include them.

## Measured benchmark

`node eval/runCorpus.js` on the synthetic demo org after `scripts/seedDemoOrg.js`:

| | |
|---|---|
| Rows | 9 (8 synthetic, 1 promoted) |
| Found | 3 |
| Silent miss | 0 |
| Correct separation | 5 |
| False alarm | 1 |
| Recall | 1 |
| Precision | 0.75 |
| Scorer | `v1+d7d646f3` |
| Thresholds | 0.85 and 0.60 |

There is no 60-scenario file and no stored 90.5% or 79.2% result. The 200-record dataset is not in the repo. It is Sprint 1 work.

Recall of 1 on 9 rows means every labeled match was queued for review. It does not mean records were merged. The false alarm is the promoted demo trace: labeled `not_match`, replayed as path D at 0.7, in agreement with the stored trace, with label disagreement.

## Hosted checks

- `GET https://golden-record.onrender.com/health` on 2026-11-16: HTTP 200, `{"status":"ok","timestamp":"2026-11-16T04:18:05.042Z"}`.
- `https://golden-record-six.vercel.app/`: HTTP 500, `FUNCTION_INVOCATION_FAILED`.

## Customer data

No customer records are in the current tree. A deleted evaluation script remains in git history (commit `0d2187c`). It was not restored and its rows were not copied. See D-004.

## If the scope has to shrink

Cut in this order. Do not cut the matcher freeze or the synthetic-data rule.

1. Sprint 4 sample report and use-case list (S4-05, S4-07) can follow the first live demo.
2. Sprint 2 summary metrics (S2-05) can be the written report instead of a widget.
3. Do not cut the isolation check (S3-03), the baseline lock (S1-01), or the "no customer data" rule.
