# Golden Record — Sprint Tracker

Corrected 2026-11-16.

## Current sprint

Sprint 0 is COMPLETED as of Nov 16, 2026. Aaron approved the MVP scope in `SCOPE-AND-BACKLOG.md` as written (S0-06, D-019).

Sprint 1 is IN PROGRESS, started Nov 16, 2026. This entry is the plan only. The 200-row file has not been generated, and no new benchmark has been run.

Source of truth is `main` at `f867e62921e6332e6e02aeebeacba86351844699`. Pull request #9 merged the earlier tip. `render.yaml` on that commit sets `branch: main` (D-020).

## What changed in the correction

`git fetch --all --prune` showed `origin/main` still at `7fa878d092d027c89db4e2020558934b7e03e8aa`. The newer commits are only on `origin/productization/remove-thunder`. They are not ancestors of the first audit branch, and they were not in PR #8 until this correction rebases the docs onto that tip.

`git log --format='%H %cI %s' origin/main..origin/productization/remove-thunder`:

| Commit | Subject |
|---|---|
| `3daab145998db672fbde0e6a2707e75901aa4cbb` | Name-and-birthday agreement stays in review when the email penalty drops the score under 0.60. |
| `11da7ead967bedc3f4e3674ca806f4294f09ffd9` | Labeled nickname pairs. |
| `d121c8ed2c2a821c0e7964242b2491cd56733315` | Live resolve opens review for Bob and Robert when emails differ. |
| `c355ca20886119c083c0ee7c509d5713d9834a04` | Import a customer row through the existing resolver. |
| `5e394acd8baef908073e0ba1b4dcb6bbbd3a9167` | Operator dashboard, one Render service. |
| `751d5b5166bf0b71512f7e9caa2d8b9ff222e625` | Undo a merge and reopen a completed review from the queue. |
| `b388ad419c85e03c5c384590c4403a27b049dc51` | Import stays up when Firestore has no credentials. |
| `cc83b1b97867d70257b2445afd07221d817c996b` | Exact email and exact name are held for review when every stored birthday differs. |

Those commits are on `main` now, through pull request #9 (`15c807618e1d4640816ea8b3bae1c760cd484a78`) and `f867e62921e6332e6e02aeebeacba86351844699`.

## Tasks

| ID | Status |
|---|---|
| S0-01 Inventory of `main` | COMPLETED, then superseded |
| S0-02 Jest on `main` | COMPLETED as a record of the stale commit |
| S0-03 Harness on `main` | COMPLETED as a record of the stale commit |
| S0-04 Customer-data check | COMPLETED |
| S0-05 First docs | COMPLETED, then corrected |
| S0-07 Re-audit `cc83b1b` | COMPLETED |
| S0-06 Aaron approves the MVP scope as written | COMPLETED Nov 16, 2026 |

## Tip verification

Database `postgresql://postgres:postgres@localhost:5432/golden_record` was rebuilt with `scripts/resetLocalDb.sh` from the tip (migrations `001`–`020`, 19 public tables). `node scripts/seedDemoOrg.js` was run first, because `tests/seedDemoOrg.test.js` reads that org and does not create it. `web/` was built so `web/dist/index.html` exists.

`npx jest --forceExit` then printed:

```
Test Suites: 39 passed, 39 total
Tests:       1 skipped, 691 passed, 692 total
```

The benchmark test rewrote `eval/reports/benchmark-report.md` and `eval/reports/benchmark-report.json`. The summary before restore was 60 scenarios, policy mismatches 0, precision 0.9048, recall 0.7917, 27 reviews. The files were restored with `git checkout`.

## Why the first Jest total was 588

That command was `npx jest --runInBand` on `main` (`7fa878d`), not on the tip. `package.json` on `main` is `"test": "jest"` with no extra config. Jest's default pattern runs `*.test.js` only, not `*.smoke.js` or `*.unit.js`. `main` has 24 `*.test.js` files and Jest reported 588 tests. The tip has 39 `*.test.js` files and Jest reported 692 tests. The difference is the commit, not a second package.

The 46 failures on `main` were:

| Count | Suite | Class |
|---|---|---|
| 2 | `tests/modules/resolverEngine.test.js` | Genuine test failures the file itself called pre-existing. The tip rewrites those cases so `scoreMatch` is not expected when there is no block candidate. |
| 5 | `tests/seedDemoOrg.test.js` | Setup. The file requires a demo org that the empty database did not have yet. |
| 39 | blocking, trace, clock, `nfc.identifiers`, and one harness regression | Environment. Jest reported `Could not load the default credentials` at the Firestore `set()` in `resolverEngine.js`. `main` always calls `set()` and the client also rejects a promise outside the `try`. No Firestore emulator is named in `main`'s tests, README, or `package.json`. Pointing `FIRESTORE_EMULATOR_HOST` at a closed port made those tests time out. `gcloud` is not installed here, so the emulator was not started. |

On the tip, `firestoreSyncEnabled()` returns false when `FIRESTORE_SYNC` is not `on` and no credential file and no `K_SERVICE` are present. This machine has no ADC file. The tip run did not need an emulator.

## Sprint 1 plan

Goal: keep the 60-scenario benchmark intact, then measure a 200-record synthetic file with ground truth. No Sprint 2 work.

What already exists on `main`:

- `eval/benchmark.js` classifies a resolver trace. Automatic decisions are hard matches and path B. Reviews stay out of precision and recall. Policy mismatches are counted apart from those rates.
- `tests/eval.benchmark.test.js` runs the 60 cases and rewrites `eval/reports/benchmark-report.md` and `.json`. The committed summary is 60 scenarios, 0 policy mismatches, precision 0.9048, recall 0.7917, 27 reviews.
- `scripts/buildSyntheticDemoCsv.js` builds 200 synthetic rows and writes `demo/synthetic-customers-200.csv`. The mix is 80 originals, 5 same-email copies, 10 nicknames, 10 spellings, 20 same name with a different email, 15 name+birthday+zip with no email, and 60 different first name and birthday. It checks lookalikes with `scoreMatch` only, prints the counts, and does not save labels. It does not call `importCustomers`.
- `*.csv` is gitignored, so the CSV itself will not be committed.

What is new:

- A committed ground-truth file for those 200 rows.
- An import of that file through the existing resolver.
- A second report, `eval/reports/synthetic-200-report.md`, so the 60-scenario files are not overwritten.
- Four demo examples taken from that run.

| ID | Title | Status | Size |
|---|---|---|---|
| S1-01 | Re-run the 60-scenario benchmark and confirm it did not move | NOT STARTED | S |
| S1-02 | Save ground truth for the existing 200-row mix | NOT STARTED | M |
| S1-03 | Generate the CSV with `scripts/buildSyntheticDemoCsv.js` | NOT STARTED | S |
| S1-04 | Import the 200 rows through `importCustomers` | NOT STARTED | M |
| S1-05 | Measure precision, recall, false matches, missed matches, and review volume | NOT STARTED | M |
| S1-06 | Write `eval/reports/synthetic-200-report.md` | NOT STARTED | S |
| S1-07 | Pick four demo examples from the import | NOT STARTED | S |

Firestore: on this `main`, `firestoreSyncEnabled()` skips the wallet write when no credential file exists, and `index.js` ignores a "Could not load the default credentials" rejection. `node scripts/seedDemoOrg.js` should not need a flag. The `--unhandled-rejections=warn` workaround belongs to `main` at `7fa878d`, before `b388ad4`. If a seed or import still dies on that rejection, rerun the process with `node --unhandled-rejections=warn`. That is an environment workaround, not a matcher change.

## Remaining

S1-01 is the next task. Do not edit the 60-scenario fixture or the matcher while doing it.
