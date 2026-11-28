# Golden Record — Project Status

Snapshot dated Nov 27, 2026 (CT), about 11:45 PM CT, after Aaron closed Sprint 1.5 at 11:29 PM CT. Draft. Not committed.

`main` is the source of truth at `15c52f9565c5f6771032686191d99c8614bd2b98`. That is the merge of pull request #19 (the Sprint 1.5 closeout docs), Nov 27, 2026, 11:20 PM CT. Before it: `7737475` (pull request #18, admin safety fixes and `migration_022`, 9:50 PM CT), `855997e` (pull request #17, operator authorization, 9:31 PM CT) and `04eb817` (pull request #16, fixtures only, 9:23 PM CT). `render.yaml` sets `branch: main` (D-020).

Numbers marked "reported" were not run by PM. They are labeled UNVERIFIED. Nothing here is a new PM measurement. The S2-00 numbers were run by Antigravity in Aaron's terminal and reported to PM.

## Dashboard

| | |
|---|---|
| Health | Green on the reported numbers, with two open checks. S2-00 reports a full green run on `15c52f9` (Jest, Vitest, web build, benchmark, 360-row set). PM did not re-run it. Open: dashboard sign-in on Render, and the three advisory-lock call sites. |
| Current milestone | Commercial demo on the existing engine. |
| Current sprint | Sprint 2, show the decisions. IN PROGRESS, started Nov 27, 2026. |
| `main` | `15c52f9565c5f6771032686191d99c8614bd2b98`. Render deploys this branch. |
| Sprint 0 tasks | 7 of 7 COMPLETED. |
| Sprint 1 tasks | 7 of 7 COMPLETED (Nov 18, 2026). |
| Sprint 1.5 | COMPLETED Nov 27, 2026, closed by Aaron at 11:29 PM CT (D-030). 7 of 9 tasks COMPLETED. S1.5-07 (D-023 docs and pending fixtures) and S1.5-09 (stable lookup order) are CARRIED TO SPRINT 2, not completed. |
| Pulled forward | Operator authorization (D-024): built and merged (PR #17, PR #18). Aaron's confirmation of the move is not recorded (D-025). Hosted `migration_021` and `migration_022`: reported done (D-029). |
| Sprint 2 | 8 tasks. S2-00 COMPLETED. 7 NOT STARTED. All entry gates MET. Two carried-in tasks and one backlog item (BL-01) are on the board. |
| Blockers | None. Two checks are open: sign in to the dashboard on Render, and check that all three advisory-lock call sites use the same key (D-029). |
| Next action | Start S2-06a. First step: S1.5-07, the D-023 docs and pending fixtures. The S2-00 baseline is already recorded. |

## What is done

| Piece | State |
|---|---|
| PR #13 (Sprint 1 report and demo examples) | Merged Nov 18, 2026 (`d547a06`). |
| Direct commits to `main` | Nov 20–21, 2026 CT: `52a99f0` retrieval requirements, `a651d44` one-edit surname retrieval, `bad944d` Decision 6, `644cecd` Decisions 3 and 6 reconciled, `756a6eb` nickname retrieval and first-name conflict. |
| PR #15 (false-merge holds) | Merged Nov 21, 2026, 10:56 PM CT (`f332b97`). 14 files. Risky exact-email and exact-name cases now open a review instead of a hard match. Retrieval adds candidates and does not decide. |
| PR #16 (fixtures only) | Merged Nov 27, 2026, 9:23 PM CT (merge `04eb817`, branch commit `b80b60b`). 2 files, 12 edits: 7 cases in `level2-cases.json` and 5 scenarios in `benchmarkCases.js`, all moved to the review outcome. `src/` untouched. `same-name-one-birthday-matches` was left unchanged on purpose. |
| PR #17 (operator authorization) | Merged Nov 27, 2026, 9:31 PM CT (merge `855997e`, branch commit `d60aff0`). 34 files, 1 commit. Operator roles, admin-only operator management, a block that stops integrations from confirming, rejecting, or unmerging, and audit attribution. Adds `migrations/migration_021.sql`. Does not touch the resolver, the matcher, or the evaluation fixtures. |
| PR #18 (admin safety fixes) | Merged Nov 27, 2026, 9:50 PM CT (merge `7737475b9bf5e725e43faea70c7aa2f9637d7d72`, branch commit `fd6cd3d`). 6 files, +490 −3. Adds `migrations/migration_022.sql` (earliest-created active operator becomes admin in any org with no active admin, by `created_at`, then `id`), last-admin protection, `scripts/promoteOperator.js`, and a generic duplicate-email error. Reported Jest 739 passed and 1 skipped (Antigravity, not verified). Touches no resolver, fixtures, or project docs. |
| PR #19 (Sprint 1.5 closeout docs) | Merged Nov 27, 2026, 11:20 PM CT (merge `15c52f9565c5f6771032686191d99c8614bd2b98`, branch commit `4cab1a2`). 3 files (`TASK-BOARD.md`, `PROJECT-STATUS.md`, `DECISION-LOG.md`), +270 −96. Docs only. |
| S2-00 (baseline on `15c52f9`) | COMPLETED Nov 27, 2026. Run by Antigravity in Aaron's terminal. Reported, not re-run by PM. Numbers below. Commands are in `SPRINT-TRACKER.md`. |
| Hosted `migration_021` and `migration_022` | Reported run with zero errors. The only org's only operator (Aaron's account) was promoted to admin: 1 active operator, 1 active admin. `/health` 200. Aaron relayed Antigravity's report. Not verified by PM. |
| PR #14 (older copy of the failure analysis) | Still open. Not merged. The file on `main` is newer. Aaron decides whether to close it. Open PRs: #14 and #6. |
| Dashboard | `web/` is on `main` with these screens: Overview, Imports, Records, Reviews, Exports, Account. Confirm, reject, and unmerge are in the review detail. |

## Numbers

S2-00 on `main` `15c52f9`, Nov 27, 2026. Run by Antigravity in Aaron's terminal. Reported, not independently re-run by PM.

| | Value | Label |
|---|---|---|
| Jest | 45 of 45 suites. 739 passed, 0 failed, 1 skipped (740). | Reported by Antigravity. Not independently verified. |
| Vitest | 10 files, 34 of 34. Web build ok. | Reported by Antigravity. Not independently verified. |
| 60-scenario benchmark | 60 scenarios. 0 policy mismatches. Precision 0.875 (14 true positives, 2 false positives). Recall 0.7368 (14 true positives, 5 false negatives). 32 reviews. | Reported by Antigravity. Not independently verified. Precision and recall equal the after-PR #15 values. The 5 mismatches from then are gone (PR #16 fixtures). |
| 360-row set, outcomes | new 220, replay 5, review 117, import_error 10, auto_merge 8 (360 total). | Reported by Antigravity. Not independently verified. |
| 360-row set, identity | False merges 0. Missed matches 0. Reviews 117 of 185 (82 same person, 35 different people, 0 wrong target). Found 90 of 99. Automatic decisions 8, all correct. | Reported by Antigravity. Not independently verified. Same as the after-PR #15 record, so PR #16, #17, #18 and #19 did not move it. |
| Hash pin | `eval/syntheticMetrics.js` pins `EXPECTED.import_results_sha256` to the S1-04 file (`33afd385...`). The fresh import hashed `865f6d1e...`. | Metrics were computed through the exported `joinRows` and `evaluate`, with no file edits. Backlog item BL-01 (P2). No change now. |
| Working tree | Report files restored. Tree clean. | Reported by Antigravity. |
| Earlier numbers | After PR #15: Jest 720 passed, 8 failed, 1 skipped; benchmark 5 mismatches. After PR #16: Jest 728 passed, 1 skipped (reported). PR #17 branch: 733 passed, 1 skipped (reported). PR #18: 739 passed, 1 skipped (reported). | Superseded by S2-00 above. |
| Sprint 1 baseline | 698 passed, 1 skipped. 60 scenarios, 0 mismatches, precision 0.9048, recall 0.7917, 27 reviews. 19 false merges, 13 missed matches. | Recorded in `SPRINT-TRACKER.md`. |

Rules that still hold: 8/8 means every automatic decision that is left was correct. It does not mean the hard cases were solved. They are in the 117 reviews. The rule of three on a perfect 8 is 3/8. All data is synthetic.

## Decisions since the last snapshot (D-023 to D-030)

All in `DECISION-LOG.md`.

| ID | One line | State |
|---|---|---|
| D-023 | Several exact-name candidates with a DOB conflict go to Path D. No automatic match, even on an exact email. | Policy approved Nov 23, 2026, 2:33 PM CT. Implementation approved Nov 27, 2026, 9:39 PM CT, reported by Systems Architect, not verified. |
| D-024 | Operator authorization. | As merged in PR #17. PM added a note. |
| D-025 | Authorization pulled forward from Sprint 3. | PENDING Aaron's confirmation. |
| D-026 | Held-review Decision 2 is Option A: candidates live inside the `conflict_queue` record. No new table. One small migration allowed (`migration_023`: make `confidence_score` nullable). | Reported approved, not verified. Migration allowance: Aaron, Nov 27, 2026, 9:46 PM CT, relayed by Systems Architect. |
| D-027 | A hold that was never scored stores a null `confidence_score` plus a `not_scored` flag, never 0. | Reported approved, not verified. The column conflict is settled by the D-026 migration. |
| D-028 | Resolver and review-screen work added to Sprint 2. | Reported approved, not verified. Scope change. |
| D-029 | Hold on the hosted run of `migration_021` and `migration_022` until the admin result is Aaron. Rule: earliest-created active operator per org becomes admin (`created_at`, then `id`). | Rule reported by Systems Architect, not verified. `migration_022` is merged (PR #18). Hosted run reported done, admin result is Aaron's account (reported, not verified by PM). Open: Render sign-in, and the lock call sites. |
| D-030 | Sprint 1.5 is closed. S1.5-07 and S1.5-09 carry into Sprint 2. | APPROVED by Aaron, Nov 27, 2026, 11:29 PM CT ("close sprint 1.5"). |

The held-review Decisions 1, 2, and 3 are not defined in the repo. The only repo mention is `tasks/handoff.md`. Decision 1 is PR #16's title. Decision 2 is Option A as reported. Decision 3, and questions Q2 to Q6, have no reported answer.

## Open

- Aaron: confirm the authorization pull-forward (D-025). Closing Sprint 1.5 does not confirm it.
- Aaron or Antigravity: sign in to the dashboard on Render and confirm it works. The hosted run and the `/health` 200 are reported; a real sign-in is not.
- Check that all three advisory-lock call sites use the same key. PR #18's body names `hashtext('operator_org_' + org_id)` for operator creation and deactivation. PM did not read the code and did not identify the third call site.
- S1.5-07 (D-023 docs and pending fixtures): CARRIED TO SPRINT 2. It is the first step of S2-06a.
- S1.5-09 (stable lookup order): CARRIED TO SPRINT 2. It is acceptance item 9 of S2-06a.
- S2-06b confirm design (optional candidate fan id, checked on the server) comes from Systems Architect as a detail within the approved scope. Aaron has not approved it separately.
- S2-06a: `migration_023` is still the next free number (checked on `main` `15c52f9`: `022` is the last file; open PRs are #14 and #6, neither adds a migration). Re-check before building. Every reader of `confidence_score` must handle null (`GET /v1/conflicts` sorting, API contract docs, dashboard display).
- Aaron: PR #17 open questions 1 and 3 (integration reads, demo init admin). Question 2 (last admin) is handled in code by merged PR #18.
- Aaron: decide on PR #14, and the score-and-signal columns on the fan export (S2-04).
- S2-05: S2-00 already reported Vitest 34 of 34. Aaron accepts that as the record, or the test is run again.
- BL-01 (P2): make the hash pin in `eval/syntheticMetrics.js` optional or updatable. Not scheduled.
- Confirm the Render service branch is `main` (`render.yaml` says so; the live service is not read here).
- No CI workflow in the repo (`.github` is absent).
- The README path C sentence is still wrong (README says the existing fan is returned). Do not change the resolver to match it.
- Held-review Decision 3 and Q2 to Q6: status not reported.

## Entry gates for Sprint 2

All MET as of Nov 27, 2026.

| Gate | State |
|---|---|
| Aaron closes Sprint 1.5 | MET. Closed Nov 27, 2026, 11:29 PM CT (D-030). |
| Operator authorization merged with green tests | MET. PR #17 and PR #18 merged. Tests green per S2-00 (reported). |
| `main` green | MET per S2-00 on `15c52f9` (reported by Antigravity; not re-run by PM). |
| Benchmark summary recorded on current `main` | MET. S2-00. |

Hosted gate for Sprint 3: `migration_022` merged: met. Hosted `021` and `022` run: reported done. Still open: Render sign-in and the lock call sites.

## Risks

- **Hosted run is a report, not a check by PM.** The hosted run of `migration_021` and `migration_022` (zero errors, Aaron's account is the one admin, `/health` 200) was relayed from Antigravity. PM cannot see the hosted database or service. A real dashboard sign-in on Render is still needed.
- **Advisory-lock key.** Operator creation and deactivation use `pg_advisory_xact_lock(hashtext('operator_org_' + org_id))` per PR #18's body. PM did not read the code. If one of the three call sites uses another key, two admin changes could run at the same time.
- **Resolver work in Sprint 2.** S2-06a changes the matcher on the email path and the name path. The benchmark and the 360-row results can move. The S2-00 baseline is recorded: 0 policy mismatches, 32 reviews, 0 false merges, 117 reviews of 185, 8 automatic decisions. S2-06a must show no new false merges.
- **Null scores reach every reader of `confidence_score`.** The migration makes the column nullable. Any reader that assumes a number can break. S2-06a lists them and tests each. PM checked only `src/routes/dashboard.js`, not the other readers.
- **Flaky scenario.** `same-name-one-birthday-matches` depends on an unordered lookup. It can fail on a later run with no code change. It passed in the S2-00 run. It is carried into S2-06a (S1.5-09).
- **Pending D-023 fixtures.** S1.5-07 is carried over. Until the pending fixtures are live tests, the exact-email bypass case has no live test.
- **Hash pin.** The metrics script cannot run end to end on a fresh import until BL-01 is done. Metrics were computed through exported functions, so the numbers are usable, but it is a manual step.
- **Scope record.** D-025 (authorization pulled forward) is not confirmed by Aaron. Operator management sits next to the "multi-tenant admin product" exclusion in `SCOPE-AND-BACKLOG.md`.
- **Repo visibility.** GitHub's API shows `AFranklin30/golden-record` with `private: false`. The task brief calls it private. Check the setting in GitHub.

## Unverified

- Every Jest and Vitest number above except the old Sprint 1 baseline. S2-00's 739 passed and 1 skipped, Vitest 34 of 34, and the benchmark and 360-row results were run by Antigravity and reported. PM did not re-run them.
- The hosted run of `migration_021` and `migration_022` and its result.
- The Nov 27 approvals relayed by Systems Architect (D-023 amendment, D-026, D-027, D-028), Aaron's 9:46 PM CT migration quote, and the `migration_022` rule.
- Whether the live Render service runs `15c52f9`.
- Whether any code that reads `conflict_queue.signals_matched` can handle a candidate list. PM did not read that code.

## Earlier audit

The corrected test run, the corrected benchmark, the original audit, and the finding table from the Nov 16, 2026 version of this file are in git history for this file. `SPRINT-TRACKER.md` keeps the Sprint 1 and Sprint 1.5 run records. They are not repeated here.
