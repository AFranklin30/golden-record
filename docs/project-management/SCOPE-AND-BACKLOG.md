# Golden Record — Scope and Backlog

Corrected 2026-11-16 against `cc83b1b97867d70257b2445afd07221d817c996b` on `productization/remove-thunder`.
`main` (`7fa878d092d027c89db4e2020558934b7e03e8aa`) does not contain this scope. Merging the branch is **PROPOSED**, not done.

The first draft of this file described `main` and listed the dashboard, the benchmark, and CSV import as missing. Those three are on the tip. The corrections are marked below.

## Proposed MVP

Show a prospect the tip, on synthetic data:

1. The 60-scenario benchmark stays at 0 policy mismatches, precision 0.9048, recall 0.7917, 27 reviews.
2. An operator signs in, imports a synthetic CSV, sees the review queue, confirms or rejects, undoes one merge, and downloads the fan export.
3. A second organization cannot read the first through the `golden_record_app` role.

## Already on the tip (reuse, do not rebuild)

| Capability | Evidence on `cc83b1b` |
|---|---|
| Deterministic and probabilistic matching | `src/modules/resolverEngine.js`, `src/modules/probabilisticMatcher.js`. |
| Review instead of auto-merge | Path C and path D insert a new fan and a pending conflict. Confirm is still `POST /v1/conflicts/:id/confirm`. |
| Policy as of 2026-11-15 | `docs/engineering/matching-policy.md`. Name plus the same birthday is review even under 0.60. Exact email or exact name is review when every stored birthday differs. |
| 60-scenario benchmark | `eval/fixtures/benchmarkCases.js` (60 scenarios), `eval/benchmark.js`, `tests/eval.benchmark.test.js`, `eval/reports/benchmark-report.md`. Reproduced this session. |
| Operator dashboard | `web/`, `src/routes/dashboard.js`, `src/routes/dashboardSession.js`, `src/middleware/dashboardSessionMiddleware.js`. |
| CSV import | `POST /v1/dashboard/imports`, `src/modules/customerImport.js`, `migrations/migration_018.sql`. |
| Unmerge from the queue | `POST /v1/conflicts/:id/unmerge` and `web/src/features/reviews/ReviewDetail.tsx`. |
| Fan CSV export | `GET /v1/export/fans`, proxied at `GET /v1/dashboard/exports/fans`. |
| Tenant-isolation test | `tests/routes/tenantIsolation.test.js`. Passed in the 691-test run. |
| Deploy description | `Dockerfile` builds `web/` then the API. `render.yaml` points the Ohio service at this branch. |
| Tests | `npx jest --forceExit`: 691 passed, 1 skipped, 692 total, 39 suites. |

## Still open

| Gap | Evidence | Proposed handling |
|---|---|---|
| `main` does not have the tip | `origin/main` is `7fa878d` | Aaron decides the merge. Not part of Sprint 0 implementation. |
| README path C sentence | `README.md` still says the existing fan is returned | Correct the sentence. Do not change the resolver. |
| Fan export has no score or signals | `CSV_HEADER` in `src/routes/export.js` | Leave it unless a pilot asks. Reviews are on the screen. |
| 200-row synthetic CSV | `scripts/buildSyntheticDemoCsv.js` writes `demo/synthetic-customers-200.csv`. The CSV is not in git. The script was not run. | UNVERIFIED. Run it only if Aaron still wants that file in addition to the 60 scenarios. |
| Web unit tests | 9 `web/**/*.test.*` files. `package.json` jest ignores `/web/`. | UNVERIFIED. Not part of the 691. |
| CI | No `.github` workflow | Still absent. Not a reason to change the matcher. |
| Live Render SHA | `/health` returned `status: ok` on 2026-11-16 from the earlier audit. The SHA was not read from the service. | UNVERIFIED. |
| Hosted app role | The isolation test passed locally as `golden_record_app`. The role used by Render is not visible from this repo. | UNVERIFIED for production. |

## Excluded

Unchanged, and still out unless Aaron writes a change:

- Another matching engine, new signals, or auto-merge.
- A second dashboard.
- A universal adapter or CRM connectors.
- Per-customer policy editors and a multi-tenant admin product.
- Restoring the deleted client evaluation from git history.
- Treating the `main` 588-test run, or the 9-row scorecard, as the tip's quality number.

## Deferred

| Item | Why it waits |
|---|---|
| Merge the tip into `main` | Aaron's call. D-012. |
| Score-and-signal columns on the fan export | D-017. The screen already shows the review. |
| Running `buildSyntheticDemoCsv.js` and importing those 200 rows | The 60-scenario benchmark already exists. This is extra, not a rebuild. |
| Git history cleanup of the deleted client script | Destructive. Still D-004. |

## Scope-change requests

The first Sprint 0 draft asked to build a dashboard, a 60-scenario benchmark, and CSV intake. Those are withdrawn for the tip. They were an accurate description of `main` only.

The open request is S0-06: Aaron accepts this corrected scope, or names what is still missing on `cc83b1b`.
