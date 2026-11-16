# Golden Record — Task Board

Verified against `main` commit `7fa878d` on 2026-11-16.
Status values: NOT STARTED, IN PROGRESS, BLOCKED, COMPLETED, DEFERRED.
Priority P0 is required for the demo. P1 is required for the package around the demo. Deferred items are not scheduled.

Sizes are planning sizes inside the parent sprint, not measured time. S is a focused slice. M is a main slice. L would consume most of a sprint. None of the tasks below is L; anything that started to look L was split.

## Sprint 0

| ID | Description | Priority | Status | Size | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|
| S0-01 | Inventory the engine, API, migrations, tests, export, and deploy files. Do not trust the README alone. | P0 | COMPLETED | M | — | Each claimed capability is tied to a file in `PROJECT-STATUS.md` and `SCOPE-AND-BACKLOG.md`. |
| S0-02 | Run `npm test` against local Postgres with migrations `001`–`017` applied. | P0 | COMPLETED | M | S0-01 | The board records the Jest totals from this run, including failures and why. |
| S0-03 | Run `node eval/runCorpus.js` on the synthetic demo org. | P0 | COMPLETED | S | S0-01 | The scorecard counts and the row classifications are recorded. No customer data is an input. |
| S0-04 | Check the tree and git history for customer records. Do not copy any records into docs. | P0 | COMPLETED | S | — | The data-risk note in `DECISION-LOG.md` (D-004) states what was found and what was not copied. |
| S0-05 | Write the six project-management docs. | P0 | COMPLETED | M | S0-01, S0-02, S0-03, S0-04 | The docs live in `docs/project-management/` and contain only verified facts plus items explicitly marked UNVERIFIED or PROPOSED. |
| S0-06 | Aaron approves or edits the proposed MVP scope. | P0 | NOT STARTED | S | S0-05 | `SCOPE-AND-BACKLOG.md` is marked approved, or the cuts are written into `DECISION-LOG.md`. Sprint 1 does not start before this. |

## Sprint 1

| ID | Description | Priority | Status | Size | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|
| S1-01 | Lock the current 9-row scorecard as a regression baseline. The pairs already live in `scripts/seedDemoOrg.js`. The run file under `eval/runs/` is gitignored, so the baseline has to be recorded on purpose. | P0 | NOT STARTED | S | S0-06 | A second run of the demo org still reports found 3, silent miss 0, correct separation 5, false alarm 1, recall 1, precision 0.75. Scorer version and thresholds are in the record. |
| S1-02 | Specify the 200-record synthetic set: realistic duplicates, clear non-matches, conflicts, and ambiguous cases. Write the expected verdict before scoring. | P0 | NOT STARTED | M | S1-01 | The spec lists how many of each case type, which fields vary, and the verdict rule. It does not change `SIGNAL_CONFIG`. |
| S1-03 | Generate the synthetic records and ground truth. | P0 | NOT STARTED | M | S1-02 | The file is checked in, contains no real people, and every labeled pair has an expected verdict of match or not_match. |
| S1-04a | Score the 200-record set with `eval/harness.js` / `eval/runCorpus.js`. | P0 | NOT STARTED | S | S1-03 | The harness run completes and writes a scorecard using the existing classification function. |
| S1-04b | Run the same synthetic identities through `POST /v1/resolve` in a fresh org. | P0 | NOT STARTED | M | S1-03 | The org is isolated. The run records path A/B/C/D counts and how many `conflict_queue` rows were created. |
| S1-05 | Compute precision, recall, false alarms, silent misses, and review volume from S1-04a and S1-04b. | P0 | NOT STARTED | S | S1-04a, S1-04b | The report uses the harness definitions and also states, separately, that path C and D do not auto-merge. |
| S1-06 | Write the reproducible benchmark report. | P0 | NOT STARTED | S | S1-05 | A second person can regenerate the numbers from the checked-in data and the documented command. |
| S1-07 | Choose demo examples from the synthetic set: one clear duplicate, one clear non-match, one conflict, one ambiguous review case. | P1 | NOT STARTED | S | S1-05 | Each example names the path, the score, and the signals from the run. No customer story is attached. |

## Sprint 2

| ID | Description | Priority | Status | Size | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|
| S2-01 | Find out whether a review UI already exists outside this repo. This repo has none. The GitHub homepage URL returned HTTP 500 on 2026-11-16. | P0 | NOT STARTED | S | S0-06 | Either an existing UI repository is named, or Aaron approves the minimal screen in D-005. No UI code is written before that. |
| S2-02 | Show the resolution result, the duplicate candidate, the pending queue, and completed confirm/reject decisions. Source: `GET /v1/conflicts` and the resolve response. | P0 | NOT STARTED | M | S2-01, S1-07 | A user can filter by pending, confirmed, rejected, and unmerged. The fields on screen are fields the API returns. |
| S2-03 | Expose unmerge through the existing `POST /v1/conflicts/:id/unmerge`. | P0 | NOT STARTED | S | S2-02 | Unmerge of a confirmed merge returns the restored fan id. A second unmerge returns 409. Multi-hop behavior is left as the current 409. |
| S2-04 | Explain a queued match and a separation. Queued rows already store `signals_matched`. Separations are path B and do not create a conflict row. | P0 | NOT STARTED | M | S2-02, S1-06 | The demo examples from S1-07 show the signals and the path. The screen does not claim a separation reason the API did not return. |
| S2-05 | Show summary counts from the Sprint 1 report. | P1 | NOT STARTED | S | S1-06, S2-02 | The numbers on screen equal the report. They are not recomputed with a different formula. |
| S2-06 | Export review decisions. `GET /v1/export/fans` currently exports the live fan snapshot and deliberately leaves out confidence and signals (`src/routes/export.js` header comment). | P0 | NOT STARTED | M | S2-02 | A CSV download includes the conflict id, the two fan ids, status, score, and signals for the demo org. Fan snapshot export still works. |

## Sprint 3

| ID | Description | Priority | Status | Size | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|
| S3-01 | Stand up hosted Postgres for the demo and pilot. | P0 | NOT STARTED | M | S0-06 | A connection string exists in the host environment, not in git. |
| S3-02 | Apply migrations `001` through `017` on that database. | P0 | NOT STARTED | M | S3-01 | The 15 public tables from a local replay are present, including `export_run`. The apply log is saved. |
| S3-03 | Verify tenant isolation with a role that does not bypass row-level security. | P0 | NOT STARTED | M | S3-02 | Two orgs are loaded. A session as the app role for org A does not read org B. The role name is recorded. |
| S3-04 | Verify org API-key auth and inactive-org rejection on the hosted API. | P0 | NOT STARTED | S | S3-05 | Missing key returns 401. A known inactive org returns 403. |
| S3-05 | Deploy the backend and record the commit. `https://golden-record.onrender.com/health` already returns ok. The deployed commit is UNVERIFIED. There is no Render config in the repo. | P0 | NOT STARTED | M | S3-01 | `/health` is ok and the deploy note names the git SHA. |
| S3-06 | Deploy the Sprint 2 screen. Set `CORS_ORIGIN` to that exact origin. | P0 | NOT STARTED | S | S2-02, S3-05 | A browser request from the screen origin succeeds. Another origin is rejected. |
| S3-07 | Load the synthetic demo data into its own org. | P0 | NOT STARTED | S | S3-02, S1-03 | The org id is new. No customer file is loaded. |
| S3-08 | Run the hosted walkthrough: resolve, queue, confirm or reject, unmerge, export. | P0 | NOT STARTED | M | S3-04, S3-06, S3-07 | Each step's HTTP status matches `src/routes`. The export downloads. |
| S3-09 | Check logging and error handling on the hosted service. | P1 | NOT STARTED | S | S3-08 | A forced bad request returns the generic message. The log line has the correlation id and the error detail. |

## Sprint 4

| ID | Description | Priority | Status | Size | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|
| S4-01 | Run the full synthetic demo on the hosted environment and keep the outputs. | P0 | NOT STARTED | M | S3-08 | The saved output includes queue counts, one confirm, one unmerge, and the export. |
| S4-02 | Compare every displayed metric to the Sprint 1 report. | P0 | NOT STARTED | S | S4-01, S1-06 | Mismatches are listed and fixed in the display, not by changing the scorer. |
| S4-03 | Write the product overview from the code. | P0 | NOT STARTED | S | S4-01 | The overview says path C and D create a new fan and a pending conflict. It does not say path C returns the existing fan. |
| S4-04 | Write the demo script. | P0 | NOT STARTED | S | S4-01, S1-07 | The script uses the S1-07 examples and the hosted URL. It has no customer records. |
| S4-05 | Write a sample customer report from the synthetic run. | P1 | NOT STARTED | M | S4-01 | The report shows matches sent to review, separations, and decisions a person made. It is labeled synthetic. |
| S4-06 | Write the CSV customer workflow. | P0 | NOT STARTED | M | S4-03 | The doc lists the columns the normalizer can accept, the API steps, and what the customer gets back. It does not promise an upload endpoint that does not exist. |
| S4-07 | Write prospective use cases and a one-customer pilot proposal. | P1 | NOT STARTED | S | S4-06 | The proposal is one CSV pilot in an isolated org. It does not include CRM connectors or a new matcher. |

## Future pilot (not in the current sprint sequence)

| ID | Description | Priority | Status | Size | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|
| F-01 | First real CSV pilot: inspect the file, map fields, load an isolated org, resolve, review with the customer, deliver results. | P0 when a file exists | DEFERRED | L, split when it starts | S4-06, Aaron's approval, a real file kept out of git | The customer can see which pairs were confirmed, rejected, and left pending, and can download the result. |
| F-02 | Separate "what would match" from database writes, only if the pilot cannot accept writes in an isolated org. | P1 when needed | DEFERRED | M | F-01 showing the need | A documented customer constraint, then a design Aaron approves before code. |
| F-03 | A file adapter beyond the current resolve body, only if the customer's columns cannot be mapped onto existing identifier types. | P1 when needed | DEFERRED | M | F-01 showing the need | The adapter is for that file's columns. It is not a general connector framework. |

## Counts

MVP tasks S0 through S4: 35.
COMPLETED: 5 (S0-01 through S0-05).
NOT STARTED: 30.
DEFERRED, not in the 35: 3.

Percent of MVP tasks complete: 5/35 = 14%.
