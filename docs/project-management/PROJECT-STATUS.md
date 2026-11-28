# Golden Record — Project Status

Snapshot dated Nov 27, 2026 (CT), about 9:45 PM. Draft. Not committed.

`main` is the source of truth at `7737475b9bf5e725e43faea70c7aa2f9637d7d72`. That is the merge of pull request #18 (admin safety fixes and `migration_022`), Nov 27, 2026, 9:50 PM CT. Before it: `855997e` (pull request #17, operator authorization, 9:31 PM CT) and `04eb817` (pull request #16, fixtures only, 9:23 PM CT). `render.yaml` sets `branch: main` (D-020).

Numbers marked "reported" were not run by PM. They are labeled UNVERIFIED. Nothing here is a new measurement.

## Dashboard

| | |
|---|---|
| Health | Amber. Code is merged and tests are reported green. No verified run is recorded on `7737475`. The hosted database still must not get `migration_021` and `migration_022` until Aaron checks the hosted admin result. |
| Current milestone | Commercial demo on the existing engine. |
| Current sprint | Sprint 1.5, Matching Quality Fixes. Not complete. Aaron decides when it is. |
| `main` | `7737475b9bf5e725e43faea70c7aa2f9637d7d72`. Render deploys this branch. |
| Sprint 0 tasks | 7 of 7 COMPLETED. |
| Sprint 1 tasks | 7 of 7 COMPLETED (Nov 18, 2026). |
| Sprint 1.5 tasks | 6 of 9 COMPLETED. S1.5-06 (this draft) is IN PROGRESS. S1.5-07 (D-023 docs and pending fixtures) and S1.5-09 (stable lookup order) are NOT STARTED. |
| Pulled forward | Operator authorization (D-024): built and merged. Aaron's confirmation of the move is not recorded (D-025). The admin fix (`migration_022`, AUTH-02) is merged in PR #18 (`7737475`). The hosted run is still gated. |
| Sprint 2 | Planned on the task board. 8 tasks, all NOT STARTED. Waits on the entry gates below. |
| Blockers | Hosted hold stays: do not run `migration_021` and `migration_022` on the hosted database until Aaron checks that the hosted admin result is him (D-029). PR #18 is merged, so the code fix exists. PM has no record that the two pre-merge checks were done (hosted result; same lock key at all three call sites). |
| Next action | Aaron closes Sprint 1.5 or says what is still needed. S2-00 records the benchmark baseline. |

## What is done

| Piece | State |
|---|---|
| PR #13 (Sprint 1 report and demo examples) | Merged Nov 18, 2026 (`d547a06`). |
| Direct commits to `main` | Nov 20–21, 2026 CT: `52a99f0` retrieval requirements, `a651d44` one-edit surname retrieval, `bad944d` Decision 6, `644cecd` Decisions 3 and 6 reconciled, `756a6eb` nickname retrieval and first-name conflict. |
| PR #15 (false-merge holds) | Merged Nov 21, 2026, 10:56 PM CT (`f332b97`). 14 files. Risky exact-email and exact-name cases now open a review instead of a hard match. Retrieval adds candidates and does not decide. |
| PR #16 (fixtures only) | Merged Nov 27, 2026, 9:23 PM CT (merge `04eb817`, branch commit `b80b60b`). 2 files, 12 edits: 7 cases in `level2-cases.json` and 5 scenarios in `benchmarkCases.js`, all moved to the review outcome. `src/` untouched. `same-name-one-birthday-matches` was left unchanged on purpose. |
| PR #17 (operator authorization) | Merged Nov 27, 2026, 9:31 PM CT (merge `855997e`, branch commit `d60aff0`). 34 files, 1 commit. Operator roles, admin-only operator management, a block that stops integrations from confirming, rejecting, or unmerging, and audit attribution. Adds `migrations/migration_021.sql`. Does not touch the resolver, the matcher, or the evaluation fixtures. |
| PR #18 (admin safety fixes) | Merged Nov 27, 2026, 9:50 PM CT (merge `7737475b9bf5e725e43faea70c7aa2f9637d7d72`, branch commit `fd6cd3d`). 6 files, +490 −3. Adds `migrations/migration_022.sql` (earliest-created active operator becomes admin in any org with no active admin, by `created_at`, then `id`), last-admin protection, `scripts/promoteOperator.js`, and a generic duplicate-email error. Reported Jest 739 passed and 1 skipped (Antigravity, not verified). Touches no resolver, fixtures, or project docs. |
| PR #14 (older copy of the failure analysis) | Still open. Not merged. The file on `main` is newer. Aaron decides whether to close it. |
| Dashboard | `web/` is on `main` with these screens: Overview, Imports, Records, Reviews, Exports, Account. Confirm, reject, and unmerge are in the review detail. |

## Numbers

| | Value | Label |
|---|---|---|
| Jest on `main` at `04eb817` | 728 passed, 1 skipped | Reported by Antigravity. Not independently verified. |
| Jest on the auth branch (PR #17) | 733 passed, 1 skipped (44 suites, 734 total) | Reported by Antigravity. Not independently verified. The PR body says the same. |
| Jest on `7737475` | Not recorded | S2-00 records it. |
| Web tests | 32 of 32 | Reported by Systems Architect. Not verified. The PR #17 body says 34 passed in 10 files on its branch. |
| 60-scenario benchmark | NOT YET RUN on `7737475` (and not on `04eb817`). Last recorded after PR #15: 5 policy mismatches, precision 0.875, recall 0.7368, 32 reviews. | PR #16 edited the five scenarios that mismatched. So the mismatch count has likely changed. That is an expectation, not a result. S2-00 records it. |
| 360-row set | False merges 0, missed matches 0, reviews 117/185, found 90/99. 8 automatic decisions, all correct (MB-1 and CA-2). | Measured right after PR #15 (`eval/reports/sprint-1.5-rerun-report.md`). It comes before PR #16 and PR #17. The repo shows no re-run since. |
| Earlier baseline (Sprint 1) | 698 passed, 1 skipped. 60 scenarios, 0 mismatches, precision 0.9048, recall 0.7917, 27 reviews. 19 false merges, 13 missed matches. | Recorded in `SPRINT-TRACKER.md`. |

Rules that still hold: 8/8 means every automatic decision that is left was correct. It does not mean the hard cases were solved. They are in the 117 reviews. The rule of three on a perfect 8 is 3/8. All data is synthetic.

## Decisions since the last snapshot

All in `DECISION-LOG.md`.

| ID | One line | State |
|---|---|---|
| D-023 | Several exact-name candidates with a DOB conflict go to Path D. No automatic match, even on an exact email. | Policy approved Nov 23, 2026, 2:33 PM CT. Implementation approved Nov 27, 2026, 9:39 PM CT, reported by Systems Architect, not verified. |
| D-024 | Operator authorization. | As merged in PR #17. PM added a note. |
| D-025 | Authorization pulled forward from Sprint 3. | PENDING Aaron's confirmation. |
| D-026 | Held-review Decision 2 is Option A: candidates live inside the `conflict_queue` record. No new table. One small migration allowed (`migration_023`: make `confidence_score` nullable). | Reported approved, not verified. Migration allowance: Aaron, Nov 27, 2026, 9:46 PM CT, relayed by Systems Architect. |
| D-027 | A hold that was never scored stores a null `confidence_score` plus a `not_scored` flag, never 0. | Reported approved, not verified. The column conflict is settled by the D-026 migration. |
| D-028 | Resolver and review-screen work added to Sprint 2. | Reported approved, not verified. Scope change. |
| D-029 | Do not run `migration_021` and `migration_022` on the hosted database until Aaron checks the hosted admin result is him. Rule: earliest-created active operator per org becomes admin (`created_at`, then `id`). | Rule reported by Systems Architect, not verified. `migration_022` is merged (PR #18). The hosted hold stays. |

The held-review Decisions 1, 2, and 3 are not defined in the repo. The only repo mention is `tasks/handoff.md`. Decision 1 is PR #16's title. Decision 2 is Option A as reported. Decision 3, and questions Q2 to Q6, have no reported answer.

## Open

- Aaron: close Sprint 1.5, or name what is still needed.
- Aaron: confirm the authorization pull-forward (D-025).
- S2-06b confirm design (optional candidate fan id, checked on the server) comes from Systems Architect as a detail within the approved scope. Aaron has not approved it separately.
- S2-06a: `migration_023` is still the next free number (checked on `main` `7737475`: `022` is the last file, no open PR adds one). Re-check before building. Every reader of `confidence_score` must handle null (`GET /v1/conflicts` sorting, API contract docs, dashboard display).
- Hosted database: Aaron checks that the hosted admin result is him (earliest-created active operator in the hosted org) before `migration_021` then `migration_022` run there. PM has no record that the two PR #18 pre-merge checks were done: hosted result, and the same advisory-lock key at all three call sites. PM did not read the code.
- Aaron: PR #17 open questions 1 and 3 (integration reads, demo init admin). Question 2 (last admin) is handled in code by merged PR #18.
- Aaron: decide on PR #14, and the score-and-signal columns on the fan export (S2-04).
- S1.5-07 is NOT STARTED. S1.5-09 is NOT STARTED.
- Confirm the Render service branch is `main` (`render.yaml` says so; the live service is not read here).
- No CI workflow in the repo (`.github` is absent).
- The README path C sentence is still wrong (README says the existing fan is returned). Do not change the resolver to match it.
- Held-review Decision 3 and Q2 to Q6: status not reported.

## Entry gates for Sprint 2

| Gate | State |
|---|---|
| Aaron closes Sprint 1.5 | NOT MET. His decision. |
| Operator authorization merged with green tests | Merged (PR #17). Tests reported green, UNVERIFIED on `main`. |
| `main` green | NOT MET. No verified run on `7737475`. |
| Benchmark summary recorded on current `main` | NOT MET. S2-00. |

Hosted gate for Sprint 3: `migration_022` (PR #18) is merged. Met. Still gated: Aaron checks the hosted admin result before `021` and `022` run on the hosted database.

## Risks

- **Hosted database and `migration_021` + `migration_022`.** Reported: `migration_021` gives every existing operator the `operator` role, so existing orgs have no admin. `migration_022` (merged in PR #18) fixes that by making each org's earliest-created active operator the admin, by `created_at`, then `id` (rule reported by Systems Architect). Hold: do not run `021` and `022` on the hosted database until Aaron checks that the hosted admin result is him. Run `021` first, then `022`. PM has no record that the two PR #18 pre-merge checks were done (hosted result; same advisory-lock key at all three call sites). Jest 739 passed and 1 skipped is reported by Antigravity, not verified. UNVERIFIED by PM.
- **Deploy and database out of step.** `render.yaml` points at `main`. The `Dockerfile` starts `node index.js` and has no migration step. If Render redeployed after PR #17 and the hosted database has not had `migration_021`, sign-in may fail, because PR #17 says the session lookup reads the role. PM cannot see the hosted service or the hosted database. Someone with access should check.
- **Resolver work in Sprint 2.** S2-06a changes the matcher on the email path and the name path. The benchmark and the 360-row results can move. S2-00 records the baseline first. S2-06a must show no new false merges.
- **Null scores reach every reader of `confidence_score`.** The migration makes the column nullable. Any reader that assumes a number can break. S2-06a lists them and tests each. PM checked only `src/routes/dashboard.js`, not the other readers.
- **Flaky scenario.** `same-name-one-birthday-matches` depends on an unordered lookup. It can fail on a later run with no code change (S1.5-09, or S2-06a).
- **Stale numbers.** The 360-row results and the last benchmark numbers come before PR #16 and PR #17.
- **PR #16 test coverage.** It ran 11 suites, not the full suite. The full suite is not recorded on that branch.
- **Repo visibility.** GitHub's API shows `AFranklin30/golden-record` with `private: false`. The task brief calls it private. Check the setting in GitHub.

## Unverified

- Every Jest and Vitest number above except the old Sprint 1 baseline. This includes PR #18's 739 passed and 1 skipped.
- The Nov 27 approvals relayed by Systems Architect (D-023 amendment, D-026, D-027, D-028), Aaron's 9:46 PM CT migration quote, and the `migration_022` rule and the `migration_021` admin blocker.
- Whether the hosted database has `migration_021`, and the live Render commit.
- Whether any code that reads `conflict_queue.signals_matched` can handle a candidate list. PM did not read that code.

## Earlier audit

The corrected test run, the corrected benchmark, the original audit, and the finding table from the Nov 16, 2026 version of this file are in git history for this file. `SPRINT-TRACKER.md` keeps the Sprint 1 and Sprint 1.5 run records. They are not repeated here.
