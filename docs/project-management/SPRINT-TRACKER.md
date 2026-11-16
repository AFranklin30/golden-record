# Golden Record — Sprint Tracker

Corrected 2026-11-16.

## Current sprint

Sprint 0 — scope freeze and technical audit. IN PROGRESS.

The audit was first written against `main` at `7fa878d092d027c89db4e2020558934b7e03e8aa`. Aaron challenged it. The engineering tip is `productization/remove-thunder` at `cc83b1b97867d70257b2445afd07221d817c996b`. This tracker now uses that commit. Sprint 1 has not been started.

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

Merging these into `main` was not done.

## Tasks

| ID | Status |
|---|---|
| S0-01 Inventory of `main` | COMPLETED, then superseded |
| S0-02 Jest on `main` | COMPLETED as a record of the stale commit |
| S0-03 Harness on `main` | COMPLETED as a record of the stale commit |
| S0-04 Customer-data check | COMPLETED |
| S0-05 First docs | COMPLETED, then corrected |
| S0-07 Re-audit `cc83b1b` | COMPLETED |
| S0-06 Aaron approves the corrected scope and the merge into `main` | NOT STARTED |

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

## Remaining

S0-06 only. Do not start Sprint 1 from these docs until Aaron says the corrected scope is the one he wants, and until he decides whether `main` should receive `productization/remove-thunder`.
