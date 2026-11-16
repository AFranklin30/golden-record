# Golden Record — Project Plan

Corrected 2026-11-16.

The first version of this plan audited `main` at `7fa878d092d027c89db4e2020558934b7e03e8aa` and treated the dashboard, the 60-scenario benchmark, and CSV import as work still to build. Those three are already on `productization/remove-thunder` at `cc83b1b97867d70257b2445afd07221d817c996b`. This plan judges the demo against that commit. It does not merge the branch into `main`.

Planning windows below are the envelopes Aaron set. They are not a new forecast. Most of Sprint 1 and Sprint 2, as first written, is already implemented on the tip. The remaining work is verification and the merge decision, not a second build.

## Objective

A prospect can see the current engine: a measured benchmark, a review queue, a human confirm or reject, an unmerge, and a fan export. Matching policy stays the policy in `docs/engineering/matching-policy.md`. No customer records.

## Sprint 0 — scope freeze

**Status:** IN PROGRESS. The re-audit is written. Aaron has not approved it.

**Deliverable:** this folder.

**Acceptance:** The docs name `cc83b1b` as the tip, keep the reproduced 691 / 692 Jest result and the 60-scenario report, and do not schedule a second dashboard or a second benchmark.

**Excluded:** Application code, tests, migrations, config, and merging into `main`.

## Sprint 1 — benchmark

**Status:** The 60-scenario benchmark is already on the tip. Do not rebuild it.

**What was verified:** `tests/eval.benchmark.test.js` during `npx jest --forceExit` rewrote the report and the summary was 60 scenarios, 0 policy mismatches, precision 0.9048, recall 0.7917, 27 reviews. The report files were restored afterward.

**Left, only if Aaron still wants it:** run `scripts/buildSyntheticDemoCsv.js` and import `demo/synthetic-customers-200.csv` through the existing importer. That file is not in git, and the script was not run. UNVERIFIED.

**Excluded:** Threshold changes, new signals, and replacing the benchmark's metric with the older 9-row scorecard.

## Sprint 2 — show the decisions

**Status:** The operator dashboard is on the tip. Do not build another one.

**Already present:** `web/`, dashboard routes, confirm, reject, unmerge, CSV import, fan export.

**Left:** Confirm the built UI in a browser against a seeded org, and decide whether the fan CSV must grow score and signal columns. The columns are not in `src/routes/export.js` today.

**Excluded:** A new UI stack. Vitest under `web/` was not run; that is a test gap, not a reason to rewrite the screens.

## Sprint 3 — hosted demo

**Status:** NOT STARTED as a fresh deploy of this commit.

**Already present:** `Dockerfile` builds the dashboard and the API. `render.yaml` names the Ohio service and this branch. `GET https://golden-record.onrender.com/health` returned HTTP 200 `status: ok` on 2026-11-16. The deployed SHA is UNVERIFIED.

**Left:** Record the SHA that is live, apply migrations `001`–`020` if the hosted database is behind, and repeat the `golden_record_app` isolation check against the hosted role. The local isolation test passed inside the 691.

**Excluded:** A new logging platform and a production cutover of a customer database.

## Sprint 4 — demo package

**Status:** NOT STARTED.

**Left:** One scripted walkthrough on the hosted tip: import synthetic rows, open a review, confirm, unmerge, export. The overview must say path C and path D queue a new fan. `README.md` still says path C returns the existing fan.

**Excluded:** Case studies that use real customer data.

## Completion

The commercial demo is complete when:

- Aaron has either merged `productization/remove-thunder` into `main` or explicitly accepted the branch as the release line.
- The 60-scenario test still reports 0 policy mismatches.
- A person who did not write the code can follow the hosted walkthrough and see the same benchmark numbers.
- No customer records are in the repo or the demo org.
