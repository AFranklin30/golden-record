# Golden Record — Project Plan

Verified against `main` commit `7fa878d` on 2026-11-16.
This is a planning document. It does not change the product.
Anything marked **PROPOSED** is waiting on Aaron. Anything marked **UNVERIFIED** was not proven in this audit.

The planning windows below are the envelopes Aaron set for this commercial-demo effort. They are not a new forecast.

## Objective

Make the existing identity engine demonstrable and credible for prospective businesses, and ready for a first pilot that accepts a CSV, produces match and review decisions, and does not require a new platform.

Success for the demo:

- A prospect can see duplicate detection, a human review queue, a completed decision, an unmerge, a short explanation, summary counts, and an export.
- The counts on screen match a report that can be regenerated from synthetic data.
- The matching rules that exist today are unchanged.
- No real customer records are used.

## What exists today

Golden Record is a Node.js / Express API with PostgreSQL migrations, an evaluation harness, and a CSV export of fans. There is no user interface in this repository. Matching already has a deterministic path and a probabilistic scorer. Uncertain matches are queued. Nothing is auto-merged.

The live check `GET https://golden-record.onrender.com/health` returned HTTP 200 and `{"status":"ok","timestamp":"2026-11-16T04:18:05.042Z"}` on 2026-11-16. That matches the unauthenticated shape in `src/routes/health.js`. Which git commit is deployed is **UNVERIFIED**. The repository has a `Dockerfile` and Cloud Run instructions in `README.md`. It has no Render service file.

## Milestones

| Milestone | Planning window | Done when |
|---|---|---|
| Sprint 0 — scope freeze and audit | 0.5–1 day | This audit is written, and Aaron has approved the MVP scope in `SCOPE-AND-BACKLOG.md`. |
| Sprint 1 — synthetic benchmark | 2–3 days | The current 9-row scorecard is locked, a 200-record synthetic set with ground truth has been run, and a report lists precision, recall, false alarms, missed matches, and review volume. |
| Sprint 2 — show the decisions | 3–5 days | A person can see results, the review queue, completed decisions, unmerge, explanations, summary counts, and an export, using the API that already exists. |
| Sprint 3 — hosted demo | 3–5 days | Migrations are applied on hosted Postgres, a non-superuser role is checked for tenant isolation, the API and the Sprint 2 screen are deployed, synthetic data is loaded into its own org, and one hosted walkthrough passes. |
| Sprint 4 — demo package | 2–3 days | A full synthetic demo has been run, the numbers on screen match the report, and the overview, script, sample report, CSV workflow, and pilot proposal exist. |
| First customer pilot | After Sprint 4, only with a real file and Aaron's approval | A customer's CSV is mapped, loaded into an isolated org, resolved, reviewed with the customer, and returned with a value note. |

Sum of the planning windows after Sprint 0 approval: 10.5–16 days of those envelopes. Sprint 0 approval is still open.

## Sprint 0 — scope freeze and audit

**Objective.** Decide what the demo is, from the code that is actually here, and stop the plan from growing.

**Tasks.** S0-01 through S0-06 in `TASK-BOARD.md`.

**Dependencies.** None. S0-06 depends on Aaron reading this folder.

**Deliverables.** The six files in `docs/project-management/`.

**Acceptance.**

- Every capability claim is tied to a file or to a command that was run.
- The test and benchmark numbers in these docs are the numbers from this audit, not the numbers in the brief.
- Out-of-scope work is listed and not scheduled.
- Aaron has approved or edited the proposed scope.

**Risks.** Treating the brief's 691 / 60-scenario / 90.5% / 79.2% figures as facts. They were not reproduced. See `PROJECT-STATUS.md`.

**Excluded.** Application code, tests, migrations, and config changes. Those stay out of Sprint 0.

## Sprint 1 — synthetic benchmark

**Objective.** Measure the current engine on synthetic data and keep that measurement repeatable. Do not change scoring.

**Dependencies.** S0-06 approved. Local or hosted Postgres with migrations `001`–`017`. No customer data.

**Tasks.**

| ID | Work | Size | Priority |
|---|---|---|---|
| S1-01 | Lock the current 9-row scorecard as the regression baseline. | S | P0 |
| S1-02 | Write the 200-record dataset rules: duplicates, non-matches, conflicts, ambiguous cases. Ground truth is written before the engine runs. | M | P0 |
| S1-03 | Generate the synthetic records and the expected verdict for each pair. | M | P0 |
| S1-04 | Run them through `eval/harness.js` / `eval/runCorpus.js` and, separately, through `POST /v1/resolve` in an isolated org. | M | P0 |
| S1-05 | Record precision, recall, false alarms, silent misses, and how many rows landed in review. | S | P0 |
| S1-06 | Write the benchmark report so a second person can regenerate it. | S | P0 |
| S1-07 | Pick a handful of demo examples from that set. | S | P1 |

Size means planning size inside the sprint: S is a focused slice, M is a main slice.

**Deliverables.** A checked-in synthetic dataset, the baseline scorecard, the 200-record report, and the demo examples.

**Acceptance.**

- Regenerating the 9-row baseline still produces found 3, silent miss 0, correct separation 5, false alarm 1, recall 1, precision 0.75, using the definitions in `eval/harness.js`.
- The 200-record report states the same definitions, the scorer version, and the thresholds (`PATH C` 0.85, `PATH D` 0.60).
- No change to `probabilisticMatcher.js`, `resolverEngine.js`, or the thresholds.
- Every record is synthetic. No customer file is an input.

**Risks.**

- The scorecard counts a review-queue result (path C or D) as a positive match. It does not mean the engine merged anyone. The engine never auto-merges. A "false alarm" here means "a labeled non-match was sent to review."
- The one false alarm on the baseline is the promoted demo trace (expected `not_match`, replayed path D at 0.7, label disagreement true, replay agrees with the stored trace). Do not "fix" that by retuning the scorer in this sprint.
- `POST /v1/resolve` writes fan rows. Run it only in an isolated org.

**Excluded.** New matching rules, threshold changes, CSV upload, a user interface, and any rerun of the deleted client evaluation script.

## Sprint 2 — show the decisions

**Objective.** Let a person see what the engine already decided, using the existing API.

**Dependencies.** Sprint 1 report, so the screen and the report use the same counts. S0-06, because there is no dashboard in this repository to reuse. See decision D-005.

**Tasks.**

| ID | Work | Size | Priority |
|---|---|---|---|
| S2-01 | Confirm whether a review UI exists outside this repo. If it does not, Aaron approves a minimal screen. | S | P0 |
| S2-02 | Show results, potential duplicates, the pending queue, and completed confirm/reject decisions from `GET /v1/conflicts`. | M | P0 |
| S2-03 | Call the existing `POST /v1/conflicts/:id/unmerge`. Do not rewrite unmerge. | S | P0 |
| S2-04 | Show why a pair was queued or separated, from `signals_matched`, score, and path. | M | P0 |
| S2-05 | Show the Sprint 1 summary counts. | S | P1 |
| S2-06 | Export the review decisions. Today `GET /v1/export/fans` is a fan snapshot and omits score and signals on purpose. | M | P0 |

**Deliverables.** A way to click through one demo org, plus an export that includes the review outcome.

**Acceptance.**

- A reviewer can list pending, confirmed, rejected, and unmerged conflicts for one org.
- Confirm, reject, and unmerge do what `src/routes/conflicts.js` already does, and the screen shows the result.
- The explanation uses fields the API already returns. It does not invent a new score.
- The export can be opened as CSV and contains the decision, not only the surviving fan.
- Household, NFC, and wallet screens are not added.

**Risks.** Building a product UI because "reuse the dashboard" turned out to be false. The minimal screen is the whole Sprint 2 UI budget.

**Excluded.** A new auth system, per-customer policies, match-algorithm work, and Firestore wallet merging.

## Sprint 3 — hosted demo

**Objective.** Run the Sprint 2 walkthrough on a hosted database and the hosted API, in its own org.

**Dependencies.** Sprint 2's screen. A Postgres Aaron can point the app at. JWT keys and `DATABASE_URL` in the host's environment. `FIRESTORE_PROJECT_ID` is required at process start (`index.js`) even when the demo does not use the wallet.

**Tasks.**

| ID | Work | Size | Priority |
|---|---|---|---|
| S3-01 | Provision hosted Postgres for the demo. | M | P0 |
| S3-02 | Apply `migrations/migration_001.sql` through `migration_017.sql` and record the result. | M | P0 |
| S3-03 | Connect the app as a role that does not bypass row-level security, and prove one org cannot read another. | M | P0 |
| S3-04 | Confirm org API-key auth on the hosted service. | S | P0 |
| S3-05 | Deploy this backend and record the commit. Render `/health` is already up; the deployed commit is unverified. | M | P0 |
| S3-06 | Deploy the Sprint 2 screen and set `CORS_ORIGIN` to that origin. | S | P0 |
| S3-07 | Load only the synthetic demo org. | S | P0 |
| S3-08 | Walk through resolve, review, unmerge, and export on the hosted URL. | M | P0 |
| S3-09 | Confirm errors returned to callers stay generic, and failures show up in logs. | S | P1 |

**Deliverables.** A hosted URL, the migration log, the isolation check, and a note of the deployed commit.

**Acceptance.**

- `GET /health` returns `status: ok` against the hosted database.
- Migrations `001`–`017` are applied. `export_run` exists.
- A second org's key cannot read the demo org's conflicts or export.
- The walkthrough uses synthetic data only.
- The caller-facing 500 body does not include the internal error string. That is already the pattern in the route handlers.

**Risks.**

- Local Postgres in this audit connected as superuser `postgres`. Row-level security policies exist and are forced, and they do not apply to a superuser. If the hosted role is also a superuser, tenant isolation is only the `org_id` filter in the queries.
- `src/lib/logger.js` writes to the console. There is no separate log drain in the repo.
- Firestore writes run after commit and are swallowed on failure. Missing Google credentials made many local integration tests fail even when Postgres work had succeeded. The demo must not depend on Firestore.

**Excluded.** Cloud SQL hardening projects, a new logging platform, multi-tenant admin, and production cutover of a real customer database.

## Sprint 4 — demo package

**Objective.** Package the hosted walkthrough so Aaron can give it without inventing numbers.

**Dependencies.** Sprint 3 walkthrough passing.

**Tasks.**

| ID | Work | Size | Priority |
|---|---|---|---|
| S4-01 | Run the full synthetic demo once on the hosted environment and save the outputs. | M | P0 |
| S4-02 | Check every number on the screen against the Sprint 1 report. | S | P0 |
| S4-03 | Write a product overview that matches the code, including "path C and D queue a new fan for review; they do not attach the tap to the existing fan." | S | P0 |
| S4-04 | Write the demo script. | S | P0 |
| S4-05 | Write a sample customer report from the synthetic run. | M | P1 |
| S4-06 | Write the CSV customer workflow: what we need in the file, what we return, what a person still has to decide. | M | P0 |
| S4-07 | List prospective use cases and a one-customer pilot proposal. | S | P1 |

**Deliverables.** Overview, script, sample report, CSV workflow, pilot proposal.

**Acceptance.** A person who was not in the build can follow the script on the hosted URL and get the same counts the report states. The overview does not repeat the stale Path C sentence in `README.md`.

**Risks.** `README.md` and parts of `docs/API_CONTRACT.md` disagree with the code. The overview has to be written from the route files, not from those docs.

**Excluded.** A marketing site, case studies that use real customer data, and any change to matching.

## First customer pilot (after the demo)

Not part of the demo build. Starts only when a customer file exists and Aaron approves it.

1. Inspect the CSV structure. Do not copy it into the git repo.
2. Map columns onto the identifier types the normalizer already allows.
3. Load into a new org, not the demo org.
4. Run resolution.
5. Walk the customer through queued pairs and the pairs the engine separated.
6. Deliver the export and a short note of what was confirmed, rejected, and left pending.

An adapter or a "score without writing" mode is built only if that file cannot be handled by the current `POST /v1/resolve` input. That is decision D-007.

## Completion criteria for the commercial MVP

- Scope in `SCOPE-AND-BACKLOG.md` is approved.
- Sprint 1 report exists and can be regenerated.
- Sprint 2 walkthrough works on synthetic data.
- Sprint 3 hosted walkthrough works, including a non-superuser isolation check.
- Sprint 4 script and sample report match that walkthrough.
- No customer records are in the repository or the demo environment.
