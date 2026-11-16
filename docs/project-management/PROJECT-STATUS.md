# Golden Record — Project Status

Corrected 2026-11-16. The first audit measured `main` at `7fa878d092d027c89db4e2020558934b7e03e8aa`. That commit is stale.

The engineering tip is `productization/remove-thunder` at `cc83b1b97867d70257b2445afd07221d817c996b`. It is 8 commits ahead of the merge-base with `main` (`762e469ac069c926de37ae064d18beebf932f2a4`). Those 8 commits are not on `main` and were not in the first audit. Merging this branch into `main` is Aaron's decision. It has not been done.

## Dashboard

| | |
|---|---|
| Health | Yellow for the commercial release process, because `main` does not contain the demo work. The tip itself has a passing root suite and a 60-scenario benchmark. |
| Current milestone | Commercial demo on the existing engine. |
| Current sprint | Sprint 0. IN PROGRESS until Aaron accepts this corrected scope. |
| Code under review | `cc83b1b97867d70257b2445afd07221d817c996b` on `productization/remove-thunder`. |
| `main` | `7fa878d092d027c89db4e2020558934b7e03e8aa`. Lags the tip. |
| MVP tasks complete | 5 of 6 Sprint 0 tasks, plus the correction S0-07. Later sprint tasks below are re-scoped, not started as new work. |
| Current task | S0-06. Aaron approves the corrected scope, including whether `productization/remove-thunder` becomes `main`. |
| Blockers | The tip is not merged to `main`. No GitHub Actions workflow exists. The hosted service's git SHA is UNVERIFIED. |
| Next action | Read the correction table in this file and approve or cut the remaining gaps. |
| Next three priorities | 1. Decide whether to merge `productization/remove-thunder` into `main`. 2. Keep the 60-scenario benchmark as the regression baseline. 3. Do not rebuild the dashboard or the matcher. |

## Corrected test run

Command, from a detached worktree at `cc83b1b97867d70257b2445afd07221d817c996b`, after `scripts/resetLocalDb.sh` and `node scripts/seedDemoOrg.js`, with `web/` built so `web/dist/index.html` exists:

```
env -u FIRESTORE_EMULATOR_HOST -u FIRESTORE_SYNC -u GOOGLE_APPLICATION_CREDENTIALS \
  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/golden_record \
  FIRESTORE_PROJECT_ID=local-audit \
  JWT_PRIVATE_KEY=<local test PEM> \
  JWT_PUBLIC_KEY=<local test PEM> \
  npx jest --forceExit
```

No application-default credential file was present, so `firestoreSyncEnabled()` in `src/modules/resolverEngine.js` skips the wallet write. `FIRESTORE_EMULATOR_HOST` was unset. An earlier run that inherited `FIRESTORE_EMULATOR_HOST=127.0.0.1:8099` stalled and was discarded.

Output:

```
Test Suites: 39 passed, 39 total
Tests:       1 skipped, 691 passed, 692 total
```

The one skip is `tests/modules/resolverEngine.trace.test.js`, "all_candidates_gated", marked `test.skip` in the file.

Without `web/dist`, the same command was `689 passed, 3 skipped, 692 total`, because `tests/routes/dashboardStatic.test.js` skips both of its tests when `web/dist/index.html` is missing.

`tests/seedDemoOrg.test.js` does not seed the database itself. It fails if `node scripts/seedDemoOrg.js` has not already been run. That is why a fresh database is not a fair run of this suite.

Jest config in `package.json` ignores `/web/`. The 9 Vitest files under `web/` were not run. Their result is UNVERIFIED.

File counts from `git ls-tree`: 39 `*.test.js` files on the tip, 24 on `main`. The "61 files vs 46" count was not reproduced by that listing.

## Corrected benchmark

`npx jest --forceExit` runs `tests/eval.benchmark.test.js`, which executes every case in `eval/fixtures/benchmarkCases.js` and rewrites:

- `eval/reports/benchmark-report.md`
- `eval/reports/benchmark-report.json`

Those generated files were restored after the run (`git checkout -- eval/reports`). The regenerated summary matched the committed report:

| | |
|---|---|
| Scenarios | 60 |
| Policy mismatches | 0 |
| Precision | 0.9048 |
| Recall | 0.7917 |
| Reviews | 27 |
| True positives | 19 |
| False positives | 2 |
| False negatives | 5 |
| True negatives | 7 |

`eval/fixtures/benchmarkCases.js` contains 60 `scenario({...})` calls. The test asserts `summary.total === cases.length` and `summary.policy_mismatches === 0`.

Precision and recall here exclude reviews. A review is not counted as an automatic match. See `docs/engineering/matching-policy.md` and `eval/benchmark.js`.

## Original audit, for the record

On `main` at `7fa878d`, `npx jest --runInBand` with a local Postgres and no Google credentials reported `541 passed, 46 failed, 1 skipped, 588 total`. That run is explained in `SPRINT-TRACKER.md`. It is not the tip.

## Finding table

| Finding | Original (`main` `7fa878d`) | Reconciled (`cc83b1b`) | Still valid? |
|---|---|---|---|
| Commit audited | `7fa878d` on `main` | Tip is `cc83b1b` on `productization/remove-thunder`, 8 commits past the merge-base. `main` has not moved. | The first commit hash was right for `main`. It was the wrong tip. |
| Root Jest | 541 passed, 46 failed, 1 skipped, 588 total | 691 passed, 1 skipped, 0 failed, 692 total, 39 suites, after seed and `web/dist` | Original number described `main` only. Aaron's 691 is reproduced on the tip. |
| 46 failures | Classified as 2 intentional test failures, 5 empty-demo-org setup failures, 39 Firestore credential rejections | Those suites were changed on the tip. The tip run had 0 failures. Firestore writes are skipped when no credential file exists (`b388ad419c85e03c5c384590c4403a27b049dc51`). | The classification stands for the `main` run. It is not the tip's status. |
| 588 vs 691 | Treated as one suite | `main` has 24 `*.test.js` files. The tip has 39. Jest on the tip reports 692 tests. | The gap is a different commit, not a missing smoke run. |
| 60-scenario benchmark | Reported absent on `main` | Present: `eval/benchmark.js`, `eval/fixtures/benchmarkCases.js`, `tests/eval.benchmark.test.js`, `eval/reports/benchmark-report.md`. Re-ran: 60 scenarios, 0 policy mismatches, precision 0.9048, recall 0.7917, 27 reviews. | Absent on `main`. Present and reproduced on the tip. |
| Dashboard | Reported absent | `web/` (Vite, React, TypeScript), `src/routes/dashboard.js`, `docs/engineering/golden-record-dashboard.md`, served from `web/dist` by `index.js`. Commit `5e394acd8baef908073e0ba1b4dcb6bbbd3a9167`. | Absent on `main`. Present on the tip. Overlooked because the audit never left `main`. |
| Vercel homepage | HTTP 500 on 2026-11-16 | Same observation. `render.yaml` on the tip deploys this branch to the Render service `golden-record` in Ohio. The live SHA is still UNVERIFIED. | The 500 is still a fact. It is not this dashboard's source. |
| Path C / D | Both mint a new fan and a pending review. Thresholds 0.85 and 0.60. No auto-merge. | Same, plus two policy changes: a name-and-birthday agreement under 0.60 is still path D (`pathForMatch`), and an exact email or exact name whose stored birthdays all differ is held for review. Documented in `docs/engineering/matching-policy.md`. | "No auto-merge" and "path C does not return the existing fan" still hold. The path rules are not identical to `main`. |
| README path C sentence | Says the existing fan is returned | The same sentence is still in `README.md` on the tip (line 131). | Still a doc bug. Do not change the engine to match it. |
| RLS | Policies exist; local superuser bypasses them; hosted role UNVERIFIED | `tests/routes/tenantIsolation.test.js` creates `golden_record_app` with `NOSUPERUSER NOBYPASSRLS` and passed inside the 691. `operator` and `operator_session` are auth tables without RLS (`migration_019.sql`). | Policies are now tested with a non-superuser role on the tip. The default local URL used here was still the `postgres` superuser. |
| CSV upload | No ingest route | `POST /v1/dashboard/imports` and `POST /v1/dashboard/imports/preview` read CSV text through `src/modules/customerImport.js`. Migration `018`. | The "no CSV upload" finding is false on the tip. |
| Decision export | Fan snapshot only, no score or signals | `GET /v1/dashboard/exports/fans` forwards to `GET /v1/export/fans`. `CSV_HEADER` in `src/routes/export.js` is still the fan snapshot without score or signals. | The fan-export gap remains. Reviews are on screen, not in that CSV. |
| Unmerge | API exists; multi-hop blocked | API still in `src/routes/conflicts.js`. The dashboard calls `POST /v1/dashboard/conflicts/:id/unmerge` (`web/src/features/reviews/ReviewDetail.tsx`). | Unmerge was not missing. The screen to use it is on the tip. |
| CI | No workflow | Still no `.github` workflow on the tip. | Still valid. |
| Customer data | None in the `main` tree. A deleted script remains in git history. | Not re-copied. The tip's benchmark fixtures are synthetic. | Still do not restore that history. |
| 200-record set | Not in the tree | `scripts/buildSyntheticDemoCsv.js` writes `demo/synthetic-customers-200.csv`. That CSV is not in the commit. The script was not run here. | The generator exists. The file and its measured result are UNVERIFIED. |
