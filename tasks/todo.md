# Review queue: unmerge and completed decisions

## Context
Confirm and Keep separate already run through the dashboard. A confirmed pair then leaves the pending list, and `POST /v1/conflicts/:id/unmerge` is not forwarded. The operator cannot find or undo a merge.

## Files
- `src/routes/dashboard.js` — status filter on the existing review query, and forward unmerge
- `web/src/features/reviews/ReviewList.tsx` — Pending, Confirmed, Rejected, Unmerged on the same page
- `web/src/features/reviews/ReviewDetail.tsx` — Undo merge only when the status is confirmed
- `tests/routes/dashboardReviews.test.js` — session, tenant, status, unmerge, import-to-export workflow
- `web/src/features/reviews/ReviewQueue.test.tsx` — queue views and the undo dialog

## THE FIX
Default list stays pending, so Overview's pending count is unchanged. `reviewed_at` is shown when the row has one. The operator's name is not invented: merge history stores the organization name. Unmerge calls the existing handler.

## THE TEST
1. A signed-in operator lists confirmed and rejected rows for that organization only.
2. Unauthenticated, cross-organization, body `org_id`, a bad id, and a second unmerge are rejected.
3. Import, confirm, undo, and export restore the source fan and reverse the merge history.
4. The queue defaults to pending, Undo merge is only on a confirmed review, and one click cannot submit twice.

## DO NOT
Do not change the resolver, merge rules, households, navigation, or hosting.

# Hosted Neon database and Render service are created

## Context
Neon project `golden_record` is in AWS US East (Ohio). The production branch has migrations 001–019, role `golden_record_app`, and one organization. Render web service `golden-record` is live in Ohio on the free plan at `https://golden-record.onrender.com`. It builds `productization/remove-thunder` from the Dockerfile. The platform health check path is empty, so a sleeping database cannot fail a deploy. Cloud Run was not changed.

## Result
- Production host is the direct Ohio endpoint. Pooling is off.
- `golden_record_app` can log in, is not a superuser, has no `BYPASSRLS`, owns no tables, and has only the contract grants.
- The nine isolation checks passed on branch `rls_check`. That branch was deleted. The append-only audit delete was proven by granting delete to the app role, attempting the delete, and revoking the grant.
- `production` then had zero organizations. `scripts/initHostedDemo.js` created Equip AI Labs and operator `afrank25303@gmail.com`. No fans or reviews were loaded.
- A manual snapshot was not taken. Neon bills snapshot storage even on the free plan.

## DO NOT
Do not run the init command again. Do not point the local seed or Jest isolation tests at Neon. Do not put the owner URL in `.env`. Do not change the Render service off the free plan.

# Hosted Neon setup procedure

## Context
The database contract had the rules and a short Slice 3 list. It did not have a reproducible Neon create, region, direct-connection, migration, verification, and demo-data sequence. Nothing is created or deployed.

## Files
- `docs/engineering/hosted-database-contract.md` — the procedure, the stale RLS sentence, and the invalid `GRANT CONNECT` line

## THE FIX
Write the procedure into the contract. Region is Neon `aws-us-east-2` with Render Ohio. Migrations 001–019 run as the owner through `psql -f`. Row-level checks run on a throwaway branch because `initHostedDemo.js` refuses a database that already has an organization. The default branch then gets one snapshot and one Equip AI Labs operator. No fan rows.

## THE TEST
No database is contacted. The procedure matches `scripts/initHostedDemo.js`, the grant list, and migrations 013 and 018, which must be applied with `psql -f` because they build indexes concurrently.

## DO NOT
Do not create Neon or Render. Do not run the init command. Do not point the isolation tests at a hosted database. Do not edit `scripts/seedDemoOrg.js` or `scripts/createOperator.js`.

# Hosted demo initialization

## Context
Slice 3 starts with a command that can create one synthetic organization and one operator on the future Neon database. `scripts/seedDemoOrg.js` and `scripts/createOperator.js` stay localhost-only. Neon and Render are not created, and the new command is not run against a host.

## Files
- `src/modules/hostedDemoInit.js` — target checks and the one-time insert
- `scripts/initHostedDemo.js` — the command
- `tests/modules/hostedDemoInit.test.js` — accepted targets, rejected targets, and a stop when data already exists
- `docs/engineering/hosted-database-contract.md` — the invocation

## THE FIX
The command reads `GOLDEN_RECORD_DEMO_DATABASE_URL` and refuses `DATABASE_URL`. The host must be the direct Neon hostname named by `--expect-host`, the database must match `--expect-database`, the port must be 5432, and `sslmode=require` is required. `--confirm` must be `hostname/database` or nothing is written. The insert reuses `createOperator`. Any existing organization or operator stops the command. The raw API key and the password are not printed.

## THE TEST
1. A direct Neon URL with matching host, database, port 5432, and `sslmode=require` is accepted.
2. Localhost, port 5433, a pooled host, a non-Neon host, and a missing or different `sslmode` are rejected.
3. A wrong `--confirm` is rejected.
4. A fake connection that already has an organization performs no insert.
5. The command does not read `DATABASE_URL`.

## DO NOT
Do not edit `scripts/seedDemoOrg.js` or `scripts/createOperator.js`. Do not create Neon or Render. Do not run the command against a database. Do not print credentials.

# Slice 2 contract completion

## Context
The migration contract, the application role, the 15 second pool timeout, and the local RLS tests already exist. This pass fills the remaining contract gaps and verifies the Docker image, including sign-in. Neon and Render are not created.

## Files
- `docs/engineering/hosted-database-contract.md` — extensions, sequences, connection split, hosted RLS procedure, backup recreate limits, known issues
- `docs/engineering/golden-record-dashboard.md` — correct the stale 2 second timeout note
- `.env.example` — comment the four environments. Placeholders only.

## THE FIX
Document what the migrations already do. Leave the pool at 15000 milliseconds. State that `tenantIsolation.test.js` refuses every non-local database. Build and run the image.

## THE TEST
1. The image serves `/reviews` as HTML and `/v1/dashboard/session` as JSON.
2. `/health` without a key omits queue depth.
3. Sign-in against the local database returns the operator session, and a reload of `/reviews` returns the dashboard.

## DO NOT
Do not create Neon or Render. Do not deploy. Do not change the pool, the resolver, or the schema. Do not commit. Do not point the isolation test at a hosted database.

# Tenant isolation proof

## Context
Local tests connect as a superuser, so row-level security never applies. The health check also counts every organization's `ingest_failures` because that query has no tenant. Both are fixed here. Neon is not created.

## Files
- `src/routes/health.js` — count one authenticated organization's pending rows
- `tests/routes/healthIsolation.test.js` — the count does not include another organization
- `tests/routes/tenantIsolation.test.js` — `golden_record_app` on local Postgres
- `docs/engineering/hosted-database-contract.md` — record what the local test proves

## THE FIX
Health resolves the API key to an organization, then counts `ingest_failures` for that organization inside a transaction that sets `app.current_org_id`. A request without a key does not run that count. The isolation test creates `golden_record_app` if needed, connects as that role, and runs the contract's checks.

## THE TEST
1. Organization A's health key returns only A's pending failures.
2. A request with no key does not include a queue depth.
3. `golden_record_app` is not a superuser and has no `BYPASSRLS`.
4. With the tenant set to A, a fan, identifier, and conflict from B are invisible.
5. Clearing the tenant makes the fan query error.
6. An insert for B while the tenant is A errors.
7. Deleting an `audit_log` row is rejected.

## DO NOT
Do not create Neon or Render. Do not deploy. Do not reset the local database. Do not change the resolver, review actions, or merge behavior.

# Hosted connection behavior

## Context
The hosted-database contract recommended three application changes and left them unapplied. They are now approved. Slice 3, including any Neon or Render resource, stays unstarted.

## Files
- `src/db/pool.js` — 15 second connect timeout and an idle-client error listener
- `src/modules/operatorAuth.js` — transaction-local tenant setting before the sign-in audit insert
- `tests/startup/startup.test.js` — timeout and listener
- `tests/modules/operatorAuth.test.js` — the setting is inside the transaction, before the audit insert
- `docs/engineering/hosted-database-contract.md` — record the decisions

## THE FIX
`connectionTimeoutMillis` becomes 15000. `max` stays 5 and `idleTimeoutMillis` stays 30000. An `error` listener logs an idle client failure and does not exit. `openSession` calls `set_config('app.current_org_id', org_id, true)` after `BEGIN` and before the `audit_log` insert.

## THE TEST
1. The pool timeout is 15000 and one `error` listener swallows an emitted idle error.
2. A correct password records `BEGIN`, then `set_config` with the organization id and `true`, then the audit insert, then `COMMIT`.
3. A wrong password does not open that transaction.
4. The existing dashboard sign-in still returns 200 and writes `dashboard_session_issued`.

## DO NOT
Do not create Neon or Render. Do not deploy. Do not change the resolver, review actions, or schema. Do not grant a local application role.

# Hosted database contract

## Context
Slice 1 serves the dashboard and the API from one process. A hosted database still needs a written contract before any Neon project exists: migration order, a non-superuser role, how row-level security will be tested, environment variables, and backup rules. This slice does not create Neon or Render, and it does not change the pool.

## Files
- `docs/engineering/hosted-database-contract.md` — the contract
- `.env.example` — placeholders only
- `docs/engineering/golden-record-dashboard.md` — pointer to the contract

## THE FIX
Document migrations `001` through `019` for an empty Neon database, the `golden_record_app` role and its grants, and the row-level-security checks to run later. Recommend a 15 second connection timeout and leave `connectionTimeoutMillis` at 2000. Placeholders replace empty example values. Build the local Docker image and request `/reviews`, `/v1/dashboard/session`, and `/health`.

## THE TEST
1. The contract lists every migration in order and the two files that use `CREATE INDEX CONCURRENTLY`.
2. `.env.example` contains no real password, key, or connection string.
3. The image starts and `/reviews` returns HTML.
4. `/v1/dashboard/session` with no cookie returns JSON 401.
5. No Neon project, Render service, or Cloud Run change exists.

## DO NOT
Do not create cloud resources. Do not deploy. Do not reset the local database. Do not change the resolver, review actions, merge behavior, or schema. Do not change the pool timeout without an explicit decision. Do not claim row-level security is proven.

# Same-origin dashboard

## Context
The dashboard is served by Vite in development. A public URL has to serve the built files from Express, on the same origin as the API, so the existing `gr_session` cookie still applies. This slice does not create a host or a database.

## Files
- `index.js` — serve `web/dist`, and send `index.html` for dashboard routes
- `Dockerfile` — build the Vite app into the image
- `tests/routes/dashboardStatic.test.js` — a page route returns HTML; `/v1` stays JSON
- `docs/engineering/golden-record-dashboard.md` — later-slice notes

## THE FIX
Express serves `web/dist` after the dashboard routers and before the API-key routers. A GET that is not `/v1` or `/health` and is not a built file receives `index.html`. `/v1` is unchanged. The cookie settings are unchanged. If `web/dist` is absent, the API starts as it does today.

## THE TEST
1. `GET /reviews` returns the dashboard HTML, not an unauthorized JSON body.
2. `GET /v1/dashboard/session` with no cookie returns JSON 401.
3. A production-mode process on a local port signs in, loads Overview, opens Reviews, and reloads `/reviews`.

## DO NOT
Do not create Render or Neon resources. Do not deploy. Do not touch Cloud Run. Do not change the resolver, review actions, or the database.

## Later slices, not this one
- CSV parsing splits on every comma, including a comma inside quotes.
- `express.json()` still caps the body near 100 KB, while the CSV guard allows 1,000,000 characters.
- The pool gives up on a new database connection after 2 seconds, which is too short for a sleeping Neon database.
- The hosted database role is not proven until the same checks run on Neon. Local `golden_record_app` is proven by `tests/routes/tenantIsolation.test.js`.
- `SameSite=Lax` is the CSRF control. Origin and Referer checks are not added yet.
- A real customer file needs a backup and restore story beyond a free-tier window.

# Dashboard visual direction

## Context
The dashboard works, and it looks like a plain page. This slice changes presentation only. Matching, merge rules, and the session cookie stay as they are.

## Files
- `web/src/styles.css` — sans type, neutral surfaces, sidebar
- `web/src/components/Shell.tsx` — sidebar navigation
- `web/src/components/ui.tsx` — page header, badge, confirm dialog
- `web/src/features/reviews/*` — queue and comparison from the existing review payload
- `web/src/features/home/Overview.tsx` and `web/src/features/account/Account.tsx` — counts and identity already returned by the session and list endpoints
- import and export screens — the same page frame

## THE FIX
The shell is a sidebar: Overview, Imports, Review queue, Exports, Account. The organization name and email stay at the bottom. Review rows show name, email, the server score, and when the review opened. The detail page compares the identifiers the server returned. Confirm asks before the existing confirm request. There is no Identity Resolution page, no search API, and no fan count.

## THE TEST
1. An unsigned visit still opens the sign-in form.
2. Sign-out still clears the dashboard.
3. A review list filters the loaded names and does not invent a score.
4. A field present on both people and different is marked.
5. Overview and Account render only session, review, and import data.

## DO NOT
Do not change the resolver, thresholds, or merge behavior. Do not add a dependency. Do not show an API key.

# Dashboard route guard

## Context
Sign-in already uses `POST /v1/dashboard/session` and the httpOnly `gr_session` cookie. A missing or expired session stayed on the protected page, and sign-out left the previous organization's lists in memory.

## Files
- `web/src/queryClient.ts` — a 401 from any dashboard query rechecks the session
- `web/src/components/Shell.tsx` — redirect, retry, and sign-out
- `web/src/features/session/session.ts` — in-app return path
- `web/src/features/session/SignIn.tsx` — session-ended and signed-out notices
- `web/src/components/Shell.test.tsx` — the guard
- `docs/engineering/golden-record-dashboard.md` — what this slice does not prove

## THE FIX
`GET /v1/dashboard/session` stays the session check. A 401 goes to `/sign-in`. If this tab already had a session, the page says the session ended. A network or server failure stays on a retry screen. Sign-out calls `DELETE /v1/dashboard/session`, clears the query cache, and stays on the sign-in page. A return path must start with a single `/` and must not be `/sign-in`. A 404 review is not rendered.

## THE TEST
1. An unsigned visit to `/imports` shows the sign-in form.
2. A session that later returns 401 shows "Your session ended. Sign in again."
3. A network failure while checking the session shows a retry action.
4. Sign-out clears the page back to the sign-in form and does not write storage.
5. A 404 review does not show the other organization's email, and the request has no organization id.
6. After signing in from a review link, the screen returns to that review.

## DO NOT
Do not add a second session store, a CSRF token, or a browser end-to-end runner. Do not change the resolver, merge rules, or email and phone uniqueness.

# Dashboard sign-in uses the existing session

## Context
The API already signs an operator in with `POST /v1/dashboard/session` and an httpOnly `gr_session` cookie. The sign-in screen treated a network failure and a server failure as a rejected password. This slice connects that screen to the existing contract. It does not add a second session store or a second login route.

## Files
- `web/src/api.ts` — classify 401, other 4xx, 5xx, and a failed fetch
- `web/src/features/session/session.ts` — sign-in call, form checks, failure sentences
- `web/src/features/session/SignIn.tsx` — the screen
- `web/src/features/session/SignIn.test.tsx` — what the operator sees
- `docs/engineering/golden-record-dashboard.md` — security follow-up that this slice does not close

## THE FIX
`POST /v1/dashboard/session` stays the only sign-in call. Requests send `credentials: 'include'`. A 401 shows one sentence and does not say whether the email, operator, or organization exists. An empty form does not call the server. A 500 and a network failure get their own sentences. A session that `GET /v1/dashboard/session` already accepts skips the form. The password is not written to `localStorage` or `sessionStorage`.

## THE TEST
1. A correct password reaches the imports route.
2. A 401 shows "Those credentials were not accepted."
3. An empty form and a malformed email do not post.
4. An existing session leaves the sign-in form.
5. A 500 and a failed fetch do not say the password was rejected.
6. Show and hide change the password field type.
7. Nothing is stored in web storage.

## DO NOT
Do not change `operatorAuth`, the cookie, the resolver, or uniqueness. Do not add a CSRF token or a new test runner in this slice. Do not reset the database. Do not deploy.

# Dashboard authentication and authorization tests

Wrong password, unknown email, inactive operator, and inactive org must return the same 401. A signed-out or expired cookie must be rejected. One organization must not read or confirm another organization's import or review. A dashboard cookie must not authorize the API-key routes. Sign-in must hash a password even when the email is unknown, so the response time is not an account oracle.

`tests/routes/dashboardSecurity.test.js` passed. Sign-in hashes once for a missing, inactive, or wrong-password account. The health limiter had been counting every request at 10 per minute; it is now limited to `/health`.

# Dashboard session and web app

The frontend framework is `docs/engineering/frontend-engineering-framework.md`. This product's UI choices are `docs/engineering/golden-record-dashboard.md`.

Operator sign-in sets an httpOnly cookie. The organization API key stays on the server. Preview writes nothing. Import calls `importCustomers`. Confirm and reject forward to the existing conflict handlers. Export forwards to `GET /v1/export/fans`.

# Customer CSV import

## Context
A customer file has a name, email, birthday, ZIP, and phone on one row. One resolve call keeps only the single identifier it was given, so the next row cannot find that person. The import calls the existing resolver, then stores the rest of the row on the fan the resolver returns. Matching does not change. Nothing merges on its own.

## Files
- `migrations/migration_018.sql` — narrow `uq_identifier_per_org`; add `import_batch`, `import_row`, and audit event `import_identifiers_attached`
- `src/modules/customerImport.js` — parse, validate, call `resolverEngine`, then insert the remaining identifiers
- `tests/modules/customerImport.test.js` — validation with no resolver call, and the ten-row file on local Postgres
- `CLAUDE.md` — uniqueness and the new audit event

## THE FIX
`uq_identifier_per_org` stays unique for email, phone, nfc_uid, nba_id, ticketmaster_id, guardian_email, and guardian_phone when `source_system != 'fan_pass'`. name, dob, and zip may repeat across fans. The row key is sha256 of org plus normalized email, name, dob, zip, and phone. A completed key is not sent to the resolver again. Remaining identifiers are inserted only on the returned fan_id. A second birthday on an exact email match is not stored. Phone is stored and is not sent to the scorer.

## THE TEST
1. A row with no email and no name-plus-birthday is an error and creates no fan.
2. Rows 1 and 2 are one fan. Name, birthday, ZIP, phone, and email are stored.
3. Rows 3 and 4 open a pending review. Nothing is merged.
4. Rows 5 and 6 open a pending review with Robert. Nothing is merged.
5. Rows 7 and 8 are different fans. Robert Jones is not reviewed against Bob Smith.
6. Rows 9 and 10 are one fan. The 1992 birthday is not stored. Both phones are stored.
7. Importing the file again adds no fans, no reviews, and no identifier rows.
8. Confirming the Jon and John review through `POST /v1/conflicts/:id/confirm` soft-deletes only the new fan. `GET /v1/export/fans` omits that fan.
9. Confirming Bob into Robert works once. The other two reviews stay pending. Confirming that same review again returns 409. When another pending review names Robert as the target, that confirm returns 409 because one fan can absorb only one merge.

## DO NOT
Do not change `resolverEngine` or `probabilisticMatcher`. Do not auto-merge. Do not store a disagreeing birthday on the exact-email fan. Do not send phone into scoring. Do not reset the local database. Do not deploy.

# Name-and-birthday review floor

## Context
Bob and Robert with the same birthday and different emails score about 0.4 after the 0.3 email penalty. That is under 0.60, so today the system saves a second fan and writes no review row. The penalty stays. The path changes: a `name_plus_dob` agreement is review even when the stored score is under 0.60.

## Files
- `src/modules/resolverEngine.js` — `pathForMatch`, used for the path decision and for choosing which candidate is reviewed
- `eval/harness.js` — replay uses the same function
- `tests/modules/probabilisticMatcher.test.js` — penalty still applied
- `tests/modules/resolverEngine.test.js` — path and queue
- `tests/eval.harness.test.js` — replay path
- `CLAUDE.md` — PATH D description

## THE FIX
`pathForMatch(score, signals)` returns `C` at or above 0.85, `D` at or above 0.60, and also `D` when `signals` contains `name_plus_dob` and the score is under 0.60. The stored score is the real score. A stronger candidate that already clears 0.60 stays the winner. A name with no birthday still needs 0.60. A birthday conflict still scores 0 with no signals and stays two fans.

## THE TEST
1. Nickname, same birthday, different emails: score is about 0.4, email penalty is present, score is under 0.60.
2. That pair's path is `D`, `match_type` is `conflict`, and the queue stores the real score.
3. A 0.4 score with no `name_plus_dob` signal stays path `B` and writes no queue row.
4. A 0.90 score with `name_plus_dob` stays path `C`.
5. A 0.70 score with no `name_plus_dob` stays path `D`.
6. When one candidate scores 0.50 with no name-and-birthday signal and another scores 0.40 with `name_plus_dob`, the queue is for the 0.40 candidate.
7. When one candidate already scores 0.70, a 0.40 name-and-birthday candidate does not replace it.
8. Harness replay of a name-and-birthday score under 0.60 reports path `D` and keeps that score.

## DO NOT
Do not change the 0.3 email penalty, the 0.60 or 0.85 thresholds, the nickname list, blocking, or auto-merge. Nothing auto-merges.

---

# Eval scorecard — totals over existing harness rows

## Context
`evaluateRow` already sets `expected_verdict` and `replayed_path` (`C`, `D`, or `B`) or `gate_status: 'gated'`. `buildRun` returns those rows and never totals them. The 8 `CORPUS_PAIRS` in `scripts/seedDemoOrg.js` are the concrete example: exact agreement and the typo pair should count as found, the near-miss email, birthday veto, shared inbox, device-only, and sibling pairs should count as correct separation, and email-alone should count as found. This slice does not rescore them by hand. It counts whatever the harness already emitted.

## Files
- `eval/harness.js` — pure `summarizeScorecard(rows)`
- `eval/runCorpus.js` — attach `scorecard` on the run object and print it
- `tests/eval.harness.test.js` — five assertions, plain objects, no new Postgres fixtures

## THE FIX
`match` + path `C` or `D` → `found`. `match` + path `B` or `gated` → `silent_miss`. `not_match` + path `B` or `gated` → `correct_separation`. `not_match` + path `C` or `D` → `false_alarm`. `unsure` and skipped rows → `excluded`. `recall = found / (found + silent_miss)`, `precision = found / (found + false_alarm)`, null when the denominator is 0.

## THE TEST
1. One of each outcome → counts 1, 1, 1, 1, recall 0.5, precision 0.5.
2. `unsure` and a skipped row increment `excluded` only.
3. A gated `match` is a silent miss.
4. Empty list → zeros and null rates.
5. Regression: an existing `buildRun` result still has `counts.total`, and `scorecard` has the same keys.

## DO NOT
Do not change `scoreMatch`, blocking, path A, nicknames, corpus pairs, or the household test fix.

---

# tests/promoteTraceToCorpus.test.js — stale hardcoded trace ID fix (check-in required before implementation)

## Scope
Edit ONLY `tests/promoteTraceToCorpus.test.js`. No production file, no migration,
no `scripts/seedDemoOrg.js` change. `git diff` must show only this file.

## What's confirmed by reading the file (all of it)

The hardcoded generated id is `SCENARIO_3_TRACE_ID` (currently a module-level
`const`, line 46), consumed in exactly three places, all inside the second
`describe` block ("real demo trace"):
- line 276 — lookup for an already-promoted `evaluation_corpus` row
- line 282 — `promoteTraceToCorpus(client, DEMO_ORG_ID, SCENARIO_3_TRACE_ID, ...)`
- line 349 — re-querying `resolution_trace.scorer_version` by id in test 11

`DEMO_ORG_ID` (line 45) is NOT in scope — it's a fixed, hand-chosen constant
(`aaaaaaaa-0000-...`) that `scripts/seedDemoOrg.js` also hardcodes as
`DEMO_ORG_ID`; it doesn't change between seed runs, unlike a `crypto.randomUUID()`
value. The first `describe` block ("guards + shape") generates its own ids via
`crypto.randomUUID()` per test run already — nothing hardcoded there.
**No other generated id (fan id, audit_event_id, conflict_id) is hardcoded
anywhere in this file.** Scope is exactly the one constant.

## Chosen fix: query (a), not the summary file (b)

Read `seedScenario3` in `scripts/seedDemoOrg.js` (lines 271-347). Traced what
makes its trace uniquely identifiable without relying on any id generated by
that same run:

- The tap's `match_type` is `'conflict'` → `resolverEngine` sets
  `resolution_path = 'D'` (confirmed in `src/modules/resolverEngine.js:477`).
- `findBlockCandidates` retrieves **fan A via the `email` key and fan B via
  `name_dob`** (two different keys, by design — see the fixture-repair
  handoff) — so `candidate_ids` has exactly 2 entries for this trace.
- Checked every other scenario that also produces a `resolution_path = 'D'`
  trace in the same demo org, to make sure the 2-candidate count is actually
  distinguishing and not coincidental:
  - **Scenario 2** (Marcus Webb): fixture fan has name+dob only, tap sends
    name+dob only → only the `name_dob` key can retrieve anything →
    `candidate_ids` length 1.
  - **Scenario 5** (Dana Park): fixture fan has email only, live resolve sends
    `identifiers.email` → only the `email` key retrieves anything →
    `candidate_ids` length 1.
  - Scenario 1 is PATH A (not D). Scenario 4 never calls resolverEngine against
    existing candidates.
- So `org_id = DEMO_ORG_ID AND resolution_path = 'D' AND
  array_length(candidate_ids, 1) = 2` uniquely identifies Scenario 3's trace
  in a correctly seeded demo org, using only stable, seed-script-derived
  properties — no dependency on a value generated by *this specific* run.

This is option (a) from the prompt: a self-contained DB query, no dependency on
`scripts/demo-org-summary.txt` (which the seed script also regenerates per run,
but that's a second thing that can drift — the DB is the source of truth the
file is only reporting).

`resolution_trace` is `FORCE ROW LEVEL SECURITY` (migration_014); the existing
`beforeAll` already does `set_config('app.current_org_id', DEMO_ORG_ID, false)`
as its first statement — the new lookup query runs right after that, so it sees
the same context the rest of the block already relies on.

## The fix, concretely

- Delete the module-level `const SCENARIO_3_TRACE_ID = 'f71a4a01-...'` (line 46).
- Inside the second `describe` block, declare `let SCENARIO_3_TRACE_ID;` (same
  identifier — lines 276, 282, 349 need no other change).
- In that block's `beforeAll`, immediately after the existing `set_config` call
  and before the "existing corpus row" query, add:
  ```js
  const traceLookup = await client.query(
    `SELECT id FROM resolution_trace
       WHERE org_id = $1 AND resolution_path = 'D'
         AND array_length(candidate_ids, 1) = 2`,
    [DEMO_ORG_ID]
  );
  if (traceLookup.rows.length !== 1) {
    throw new Error(
      `Expected exactly one Scenario 3 resolution_trace row for demo org ` +
      `${DEMO_ORG_ID} (org_id + resolution_path='D' + 2 candidate_ids), found ` +
      `${traceLookup.rows.length}. The demo org needs seeding — run ` +
      `\`node scripts/seedDemoOrg.js\` (after \`bash scripts/resetLocalDb.sh\` ` +
      `if the schema is stale) before running this test file.`
    );
  }
  SCENARIO_3_TRACE_ID = traceLookup.rows[0].id;
  ```
- Resolved once, in `beforeAll`, not per-test — satisfies the "resolve once"
  requirement and matches the file's existing pattern (`corpusRow`, `runResult`
  are also `beforeAll`-scoped, reused by tests 7-11).

## Verification steps (in order)

1. Run `tests/promoteTraceToCorpus.test.js` against the currently seeded local
   DB (whatever generated trace id exists right now) — must pass fully.
2. `bash scripts/resetLocalDb.sh`, `node scripts/seedDemoOrg.js`, run the file
   again — must pass against a *different* generated trace id than step 1.
3. Reset + reseed a second time, run again — must pass against a *third* id.
   (Confirms it's not coincidence.)
4. Drop the demo org (or point at a schema with no seed data), run the file,
   confirm the thrown error names the demo org and says it needs seeding — not
   `undefined` or a bare `trace not found`.
5. Full suite: confirm return to the 11 failed / 570 passed / 1 skipped / 582
   total baseline (resolverEngine.test.js@2, household.test.js@9 only). Report
   any delta by suite name.
6. `git diff --stat` — only `tests/promoteTraceToCorpus.test.js`.
7. On the reseeds from steps 2-3, confirm Scenario 3's own fixture assertions
   still hold (fan A considered, fan B wins at 0.700, two size-1 blocks) — this
   change must not disturb the fixture repair already landed.

## lessons.md

Add a new entry naming the category (4th instance: #24, #28, #29, and the
`SCENARIO_3_TRACE_ID` case #30 documented but didn't yet fix) — generated ids
must be looked up, never hardcoded, in any test. 20-entry cap: rotate out #11
(oldest — Firestore `databaseId` omission), per the file's own stated rotation
rule.

## Handoff

Update `tasks/handoff.md` at the end per the 5-line required format.

## Not doing

- Not touching `scripts/seedDemoOrg.js`, any migration, or any production file.
- Not touching the two pre-existing failing suites.
- Not fixing lessons.md #28 or #29.
- Not skipping or deleting any of the 6 currently-failing tests.
