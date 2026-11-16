# Golden Record — Decision Log

Verified against `main` commit `7fa878d` on 2026-11-16.
Decisions below are **PROPOSED** until Aaron accepts or replaces them. None is marked approved.

## D-001 — The MVP is a demo and a first CSV pilot

**Status:** PROPOSED

**Decision.** Use the existing engine to show duplicate detection, human review, unmerge, an explanation, counts, and an export. The first real customer step is one CSV in an isolated org.

**Why.** The resolver, scorer, review queue, unmerge, audit log, traces, and fan export already exist. The missing pieces are a repeatable synthetic measurement, a way to show the queue, and a hosted walkthrough.

**Alternative.** Rebuild Golden Record as a general integration product. Rejected for this effort. That work is listed under deferred.

## D-002 — Keep the current matching behavior

**Status:** PROPOSED

**Decision.** Do not change `probabilisticMatcher.js`, the path thresholds, the DOB veto, or the blocking keys as part of the demo. Path C stays at 0.85. Path D stays at 0.60. Path C and path D both mint a new fan and insert a pending `conflict_queue` row. Nothing auto-merges.

**Why.** Those rules are implemented in `src/modules/probabilisticMatcher.js` and `src/modules/resolverEngine.js`, and they are what the tests and the 9-row scorecard measure. `README.md` says path C returns the existing fan. The code does not. The overview will follow the code.

**Alternative.** Retune weights or thresholds before the demo so the headline percentages look higher. Rejected. There is no approved labeled set that would justify a change, and a change would invalidate the baseline.

## D-003 — The quality baseline is the 9-row synthetic run

**Status:** PROPOSED

**Decision.** The regression baseline is the 2026-11-16 harness run on the seeded demo org:

- found 3, silent miss 0, correct separation 5, false alarm 1
- recall 1, precision 0.75
- scorer `v1+d7d646f3`, normalization `v1`
- definitions in `summarizeScorecard` inside `eval/harness.js`

A review-queue path (C or D) counts as a positive. A false alarm means a labeled non-match was queued, not that two records were merged.

**Why.** This is the only scorecard this audit could regenerate. The 8 synthetic pairs are inserted by `scripts/seedDemoOrg.js`. One promoted trace comes from the demo seed's scenario 3.

**Alternative.** Adopt the brief's 60 scenarios, 90.5% precision, and 79.2% recall. Rejected. Those figures are not in the current tree, not in `eval/runs/` (that directory is gitignored and was empty), and not constants in the deleted evaluation script that was inspected for structure only.

## D-004 — Do not recover the deleted client evaluation

**Status:** PROPOSED

**Decision.** Do not restore, rerun, or quote the evaluation script removed in commit `0d2187c`. Do not put customer records in the demo, the dataset, or these docs.

**What was checked.**

- The current tree has no matches for the client name, no CSV files, and no SQL dumps.
- `.gitignore` ignores a client-specific SQL dump pattern and all `*.csv` files. None of those files were in the workspace.
- Commit `0d2187c` deleted an evaluation script that read client cohorts from local Postgres. The blob is still reachable in git history. A structure-only read found a Postgres client, calls to the scorer, and precision/recall calculation. It found no embedded email addresses and no phone numbers. Cohort rows were loaded from the database, not stored in the file. The file's contents are not copied here.
- The script's presence in history is a retention risk even though the working tree is clean.

**Alternative.** Rewrite git history to drop the blob. Not done. History rewrite is destructive and needs Aaron's explicit approval. It is not required to start the synthetic benchmark.

## D-005 — Do not assume a dashboard is in this repo

**Status:** PROPOSED

**Decision.** Sprint 2 starts by confirming whether a UI exists somewhere else. If it does not, the only UI in scope is a minimal screen on the existing conflict, unmerge, and export endpoints. No screen is built until Aaron says which of those two it is.

**Why.** This repository has no HTML, React, or Vue app. The owner's other repositories visible from this account are not a Golden Record UI. The repo homepage `https://golden-record-six.vercel.app/` returned HTTP 500 on 2026-11-16. `docs/API_CONTRACT.md` mentions a frontend integrator and says a staff view was an open question. `scripts/seedDemoOrg.js` mentions a reviewer UI as a consumer of the seed. The UI source is not here.

**Alternative.** Build a full staff product in Sprint 2. Rejected unless Aaron expands scope. It would consume the sprint and is not required to demonstrate the engine.

## D-006 — CSV upload is not a Sprint 1 prerequisite

**Status:** PROPOSED

**Decision.** Sprint 1 runs the synthetic set through the harness and through `POST /v1/resolve`. A CSV ingest endpoint is not built for that. The customer CSV workflow is documented in Sprint 4 and executed only in the later pilot, when a real file exists.

**Why.** There is no CSV ingest route. `csv-parse` is a devDependency used by `tests/routes/export.test.js`. `csv-stringify` is used by `GET /v1/export/fans`. The engine already accepts one identifier plus an `identifiers` object.

**Alternative.** Build a general file adapter before measuring quality. Rejected. It delays the benchmark and is the universal-adapter work this effort put out of scope.

## D-007 — Isolated org instead of a dry-run engine

**Status:** PROPOSED

**Decision.** Demo and pilot runs write to Postgres, in an org created for that run. A mode that scores without writing is deferred until a real customer cannot accept writes even in an isolated org.

**Why.** `resolverEngine.js` inserts the fan, the identifier, the conflict row, and the audit row inside the transaction for paths B, C, and D. Changing that is an engine change. An isolated org contains the writes.

**Alternative.** Split decisioning from persistence before the demo. Deferred as F-02. It is not a prerequisite for showing the current product.

## D-008 — Leave household, NFC, and the wallet alone

**Status:** PROPOSED

**Decision.** Do not add household, NFC, claim-token, or Firestore wallet features for the demo. Do not remove them either. They stay as they are.

**Why.** They are implemented and tested (`src/routes/household.js`, `src/routes/nfc.js`, `src/routes/profile.js`). The commercial story for this effort is duplicate review of customer records, not stadium taps or loyalty points. Firestore is written once at fan creation and is not updated on merge. Points are not implemented. That wallet gap matters only if points are in the demo. They are not.

## D-009 — Review export is a thin addition to the current export

**Status:** PROPOSED

**Decision.** Sprint 2 adds a CSV of review decisions. It does not replace `GET /v1/export/fans`. It does not add scheduling or a cloud bucket.

**Why.** The fan export comment in `src/routes/export.js` defers reasoning columns on purpose, because a downstream pipeline is hard to take back. A separate review export can include score and signals without changing the fan-snapshot contract.

**Alternative.** Add those columns to the fan snapshot. Not proposed. It changes an existing contract.

## D-010 — Prove tenant isolation with a non-superuser role

**Status:** PROPOSED

**Decision.** Sprint 3 checks row-level security by connecting as a role that cannot bypass it. The demo does not wait on a broader database-hardening project.

**Why.** Migrations enable and force row-level security on 14 tables, each with a `tenant_isolation` policy. `org` is exempt. Replaying the migrations as superuser `postgres` produced the expected RLS self-check errors on `household` and `conflict_queue`: a superuser still sees rows. Policies existing is not the same as policies being in effect for the app role. The hosted role is **UNVERIFIED**.

**Alternative.** Rewrite query access before the demo. Rejected. The queries already filter on `org_id` from the API key. The Sprint 3 check is there to see whether the database also enforces it.

## D-011 — Docs that disagree with the code get corrected in the overview, not by changing the engine

**Status:** PROPOSED

**Decision.** Sprint 4's product overview is written from the route and resolver source. Stale sentences in `README.md` and `docs/API_CONTRACT.md` are fixed only when that overview is written, and only to match the code.

**Examples already verified.**

- README says path C returns the existing fan. `resolverEngine.js` sets `is_new_record = true` and inserts a new fan for path C and path D.
- README stops the migration list at `010` and says row-level security covers 10 tenant tables. The tree has migrations through `017`. Fourteen tables have forced row-level security. `org` does not. Fifteen public tables exist after a full replay.
- `docs/API_CONTRACT.md` says `/v1/ingest/nfc` does not normalize the `identifiers` object. `src/routes/nfc.js` calls `normalizeIdentifiersObject`.

**Alternative.** Change path C so the README becomes true. Rejected by D-002.
