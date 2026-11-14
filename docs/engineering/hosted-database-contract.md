# Hosted database contract

This is the contract for a fresh Neon database and for the process that connects to it. It does not create the database. Row-level security has been executed on local Postgres as `golden_record_app`. It has not been executed on Neon.

The running service keeps a pool of at most 5 connections and sets `app.current_org_id` for the life of the borrowed connection (`set_config` with the third argument `false`). That setting is what the tenant policy reads. Two consequences follow.

A Neon hostname that contains `-pooler` uses transaction pooling. The setting would not survive from one statement to the next, so a request could lose its tenant context. `DATABASE_URL` for this application is the direct Neon connection string, with `sslmode=require`. The application already pools. Do not put the pooler string in `DATABASE_URL`.

The local `postgres` login is a superuser. A superuser bypasses row-level security even when `FORCE ROW LEVEL SECURITY` is on. A passing test that uses that login does not prove tenant isolation. `tests/routes/tenantIsolation.test.js` logs in as `golden_record_app` on localhost, and that run is the local proof. It is not a Neon proof.

## Fresh database

Target Neon Postgres 16. The migration files require Postgres 14 or newer. `gen_random_uuid()` is built in. No extension is required.

Prerequisites:

- An empty database. `public.org` must not exist. `migration_001` aborts when it does.
- The Neon owner role runs the migrations. That role is not a superuser on Neon. It owns the tables afterward. The running service does not use it.
- `psql` and the direct connection string. Run one file at a time. Do not wrap the sequence in a single `BEGIN`.
- `migration_013` and `migration_018` contain `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY`. Those statements cannot run inside a transaction.
- The header of `migration_003` still says not to run it. That header is stale. The file is required, and it is left unchanged.

On an empty database the duplicate checks in `migration_011` and `migration_013` return no rows. `migration_015` says `conflict_queue` comes from `migration_002`. The table is created in `migration_004`. Numeric order is still the order to run.

```bash
psql "$DATABASE_URL" -f migrations/migration_001.sql
psql "$DATABASE_URL" -f migrations/migration_002.sql
psql "$DATABASE_URL" -f migrations/migration_003.sql
psql "$DATABASE_URL" -f migrations/migration_004.sql
psql "$DATABASE_URL" -f migrations/migration_005.sql
psql "$DATABASE_URL" -f migrations/migration_006.sql
psql "$DATABASE_URL" -f migrations/migration_007.sql
psql "$DATABASE_URL" -f migrations/migration_008.sql
psql "$DATABASE_URL" -f migrations/migration_009.sql
psql "$DATABASE_URL" -f migrations/migration_010.sql
psql "$DATABASE_URL" -f migrations/migration_011.sql
psql "$DATABASE_URL" -f migrations/migration_012.sql
psql "$DATABASE_URL" -f migrations/migration_013.sql
psql "$DATABASE_URL" -f migrations/migration_014.sql
psql "$DATABASE_URL" -f migrations/migration_015.sql
psql "$DATABASE_URL" -f migrations/migration_016.sql
psql "$DATABASE_URL" -f migrations/migration_017.sql
psql "$DATABASE_URL" -f migrations/migration_018.sql
psql "$DATABASE_URL" -f migrations/migration_019.sql
```

| File | What it adds | After |
|---|---|---|
| 001 | `org`, `fan`, `identifier_link`, `audit_log`, `ingest_failures` | empty database |
| 002 | partial unique index on `audit_log.jti` | 001 |
| 003 | RLS and `FORCE` on the 001 tenant tables; append-only trigger on `audit_log` | 002 |
| 004 | `conflict_queue` | 003 |
| 005 | `household`, `household_member`, `staging_household_data`, `merge_history`, `related_fans` | 004 |
| 006 | RLS and `FORCE` on the 005 tables; integrity constraints | 005 |
| 007 | `audit_log` event types added for household | 006 |
| 008 | RLS and `FORCE` on `conflict_queue`; more event types | 007 |
| 009 | further `audit_log` event types | 008 |
| 010 | `match_type` and event-type corrections | 009 |
| 011 | one pending conflict per `fan_id_b` | 010 |
| 012 | defensive checks on `audit_log`, `conflict_queue`, `merge_history` | 011 |
| 013 | `uq_identifier_per_org`, excluding `source_system = 'fan_pass'` | 012, and not inside a transaction |
| 014 | `resolution_trace`, `trace_label`, `evaluation_corpus`, RLS, append-only trigger on `resolution_trace` | 013 |
| 015 | review-screen index on `conflict_queue` | 014 |
| 016 | `identifier_link.name_last_word` and block columns on `resolution_trace` | 015 |
| 017 | `export_run` with RLS | 016 |
| 018 | narrows `uq_identifier_per_org`; adds `import_batch` and `import_row` with RLS | 017, and not inside a transaction |
| 019 | `operator`, `operator_session`, and `dashboard_session_issued` | 018 |

`org`, `operator`, and `operator_session` have no RLS. Sign-in reads them before `app.current_org_id` exists. Every other application table has `ENABLE` and `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy:

```sql
USING (org_id = current_setting('app.current_org_id')::uuid)
```

After 019 the database has schema and no organization row. Loading an organization is a later step. Do not point this sequence at the local database.

No migration creates an extension. `gen_random_uuid()` is built into Postgres 14 and newer. No migration creates a sequence or an identity column. Primary keys are UUIDs, so `golden_record_app` needs no sequence privilege.

Row-level security is created in `003`, `006`, `008`, `014`, `017`, and `018`. These tables have `tenant_isolation` and `FORCE ROW LEVEL SECURITY`:

`fan`, `identifier_link`, `audit_log`, `ingest_failures`, `household`, `household_member`, `staging_household_data`, `merge_history`, `related_fans`, `conflict_queue`, `resolution_trace`, `trace_label`, `evaluation_corpus`, `export_run`, `import_batch`, `import_row`.

`org`, `operator`, and `operator_session` do not. Sign-in reads them before a tenant exists.

Append-only triggers cover `audit_log` (`enforce_audit_log_append_only` in `003`) and `resolution_trace` (`enforce_resolution_trace_append_only` in `014`). Both fire on `UPDATE` and `DELETE` for each row. `TRUNCATE` does not fire them. `ingest_failures` is not append-only.

The files assume an empty `public` schema and a role that can create tables. `migration_013` and `migration_018` must be run with `psql`, not inside a surrounding transaction. The header on `migration_003` says not to run it. That header is stale. The file is required. `conflict_queue` is created in `migration_004`.

## How the process connects

Two credentials stay apart.

The owner connection is for a person at a shell: migrations, grants, backups, and creating the first organization. It is not an environment variable of the running service, and it is not committed.

`DATABASE_URL` on the running service is the `golden_record_app` direct connection, with `sslmode=require`. The host does not contain `-pooler`. The Render service stores that value. It does not store the owner password.

Local `.env` still uses the superuser. That is a local convenience. The demonstration service does not copy it.

## Application role

Two roles. The Neon owner runs migrations, creates the first organization, creates the first operator, and takes backups. The process that serves requests uses `golden_record_app`.

`golden_record_app` logs in. It is not a superuser, cannot bypass row-level security, and cannot create databases or roles. It does not own the tables, so it cannot drop them or turn RLS off. Its password is set in the Neon console or with a password command. The password is not written into this repository.

Run the following as the database owner after migration 019. This SQL is not a migration file. `tests/routes/tenantIsolation.test.js` applies it on local Postgres and connects as `golden_record_app`. The Neon database does not exist yet.

```sql
CREATE ROLE golden_record_app
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS;

-- current_database() is not valid in GRANT. Substitute the real database name,
-- or run: EXECUTE format('GRANT CONNECT ON DATABASE %I TO golden_record_app', current_database());
GRANT CONNECT ON DATABASE neondb TO golden_record_app;
GRANT USAGE ON SCHEMA public TO golden_record_app;

GRANT SELECT ON org, operator TO golden_record_app;
GRANT SELECT, INSERT, DELETE ON operator_session TO golden_record_app;

GRANT SELECT, INSERT, UPDATE ON
  fan,
  identifier_link,
  conflict_queue,
  household_member,
  staging_household_data,
  merge_history,
  export_run,
  import_row
  TO golden_record_app;

GRANT SELECT, INSERT ON household, related_fans, import_batch TO golden_record_app;
GRANT SELECT, INSERT ON audit_log, ingest_failures TO golden_record_app;
GRANT INSERT ON resolution_trace TO golden_record_app;
```

`related_fans` is inserted and read, not updated. `audit_log` and `resolution_trace` are append-only in the application; the triggers reject update and delete. `ingest_failures` is inserted by the NFC failure path and read by the health check. Fan removal is `deleted_at`, so the role has no `DELETE` on tenant tables. The only `DELETE` is `operator_session`, used by sign-out.

`trace_label` and `evaluation_corpus` are for the evaluation scripts. Those scripts keep using the owner role. The application role has no privilege on them.

`TRUNCATE` is not granted. A later migration that adds a table must grant the new table explicitly. There is no default grant that hands every future table to the application role.

The application role can read every `org` API-key hash and every operator password hash, because those tables have no RLS and sign-in runs before tenant context exists. The stored values are hashes. That is still broader than a tenant policy. One database holds one demonstration organization. The role password and the Neon connection string stay in the host's secret store.

## How tenant isolation will be verified

`tests/routes/tenantIsolation.test.js` is the local proof. It connects as `golden_record_app`, not as the local superuser. The same checks still have to be run on Neon after that database exists. A superuser session is not an acceptable substitute.

Use a database where migrations 001–019 and the role above are applied. Connect as the database owner only to arrange fixtures. Run the assertions as `golden_record_app`.

1. `pg_roles` for `golden_record_app` shows `rolsuper = false`, `rolbypassrls = false`, `rolcreatedb = false`, and `rolcanlogin = true`.
2. A separate connection logs in as `golden_record_app`. `current_user` is that role and `current_setting('is_superuser')` is `off`.
3. The local superuser inserts two organizations and the fixture rows. That connection bypasses row-level security, so it is used only to arrange fixtures.
4. As `golden_record_app`, set `app.current_org_id` to organization A and select from `fan`, `identifier_link`, and `conflict_queue`. The result contains A's rows and does not contain B's rows.
5. Set the setting to organization B and select A's fan by id. The result is empty.
6. Reset the setting and select from `fan`. The statement errors on the empty tenant value. It does not return both organizations.
7. With the setting on A, insert a `fan` row whose `org_id` is B. The statement errors.
8. `DELETE` on `audit_log` is denied for `golden_record_app`. Inside a transaction that grants `DELETE` and then rolls it back, the append-only trigger rejects the delete.
9. With the session tenant set to B, the health count for A still returns A's pending rows. The count sets the tenant inside its own transaction.

Record the SQL, the role name, and the row counts.

`tests/routes/tenantIsolation.test.js` and `tests/routes/healthIsolation.test.js` are that procedure on local Postgres. Both refuse a `DATABASE_URL` that is not `localhost:5432`. Do not point them at Neon. Hosted row-level security is not verified.

When a Neon database exists, repeat the checks with the owner URL only for fixtures and with a second connection logged in as `golden_record_app` for every assertion:

1. `pg_roles` shows `rolsuper = false`, `rolbypassrls = false`, `rolcreatedb = false`, `rolcanlogin = true`.
2. `current_user` is `golden_record_app` and `current_setting('is_superuser')` is `off`.
3. As the owner, insert organization A and organization B, one fan in each, one `identifier_link` in each, one `conflict_queue` row in each, one pending `ingest_failures` row in each, and one `audit_log` row.
4. As `golden_record_app`, set `app.current_org_id` to A. Selecting `fan`, `identifier_link`, and `conflict_queue` returns A's rows and does not return B's.
5. Set the tenant to B and select A's fan by id. The result is empty.
6. `RESET app.current_org_id`, then select from `fan`. The statement errors. It does not return both organizations.
7. Set the tenant to A and insert a `fan` whose `org_id` is B. The statement errors with a row-level security policy violation.
8. `DELETE` on `audit_log` as `golden_record_app` is permission denied. A transaction that grants `DELETE`, sets the role, and deletes the fixture row fails with the append-only error, then rolls back. After rollback the role still cannot delete.
9. With the session tenant set to B, `countPendingIngestFailures` for A returns only A's pending rows. `GET /health` with A's API key returns that same count. `GET /health` with no key omits `queue_depth`.

Keep the SQL and the row counts. Until that output exists, hosted row-level security is not verified.

## Connection timeout

`src/db/pool.js` waits 15000 milliseconds for a new connection. That value is already in the code. `max` is 5. `idleTimeoutMillis` is 30000. node-postgres has no separate pool-acquisition timeout. `connectionTimeoutMillis` is the wait for a new connection, including a sleeping Neon compute. There is no retry. A connect failure throws. `/health` then reports the database disconnected. A dashboard request returns a generic 500. The process stays up because the pool logs idle-client errors instead of crashing.

Neon suspends a free compute after 5 minutes without a connection. Neon documents the wake as typically a few hundred milliseconds, and in uncommon cases a few seconds. Their resilience guide says to allow at least 10–15 seconds. 15000 matches that floor. A database that is actually unreachable holds a request for 15 seconds, and five such attempts can fill the pool. A shorter timeout fails the first request after a slow wake. An always-on compute removes the cold start and costs money. It is not part of the free demonstration. A retry is not added: one 15 second wait already covers the published wake, and a retry would double the wait when the database is down.

The pool also has an `error` listener. When Neon closes an idle connection, the listener logs the failure and leaves the process running.

`statement_timeout` is 10000 milliseconds on the request connection. That limit starts after the connection exists. It does not cover the wake.

Dashboard sign-in sets `app.current_org_id` inside its transaction before the `audit_log` insert. The third argument is `true`, so the setting ends when that transaction commits. This is what `FORCE ROW LEVEL SECURITY` requires. A local superuser still bypasses the policy, so this code path is not yet proof of tenant isolation.

## Environment

The process refuses to start without `DATABASE_URL` and `FIRESTORE_PROJECT_ID`. `src/modules/jwt.js` throws at load when `JWT_PRIVATE_KEY` or `JWT_PUBLIC_KEY` is empty, including for a dashboard-only process. Real values live in `.env` locally and in the host's secret store for a demonstration or production. `.env.example` holds placeholders only.

A PEM key may be stored with literal `\n` between lines. `jwt.js` turns those into newlines. The dashboard does not issue fan tokens. Fan session routes do, and they require a real RS256 pair, not a non-empty placeholder.

| Variable | Local | Demonstration | Production |
|---|---|---|---|
| `DATABASE_URL` | `localhost:5432`, local superuser, no SSL | Neon direct URL, `golden_record_app`, `sslmode=require` | same shape as demonstration, on the customer database |
| `FIRESTORE_PROJECT_ID` | local project id; a missing live project is logged and ignored | any non-empty id until wallet writes matter | the real Firestore project |
| `JWT_PRIVATE_KEY` | local PEM | a generated PEM stored as a secret | a generated PEM stored as a secret, separate from demonstration |
| `JWT_PUBLIC_KEY` | the matching public PEM | the matching public PEM | the matching public PEM |
| `NODE_ENV` | `development` | `production`, so `gr_session` is `Secure` | `production` |
| `PORT` | `3000` | the platform's port | the platform's port |
| `CORS_ORIGIN` | `http://localhost:5173` while Vite proxies, or the Express origin during a production-mode check | the exact public `https` origin | the exact public `https` origin |
| `RATE_LIMIT_WINDOW_MS` | optional, default `60000` | optional, default `60000` | set explicitly |
| `RATE_LIMIT_MAX_REQUESTS` | optional, default `100` | optional, default `100` | set explicitly |
| `CLAIM_URL_BASE` | optional, default `https://example.com/claim` | the public origin plus the claim path, when claim links are sent | the customer claim URL |
| `DEV_ORG_API_KEY` | read by local scripts and tests, not by the server | unset | unset |

The browser sends `Origin` on a sign-in POST. If `CORS_ORIGIN` is unset, that request is rejected. Same-origin hosting does not remove the need for this variable.

`CORS_ORIGIN` for local Vite is `http://localhost:5173`. For a local production-mode check it is the Express origin, such as `http://127.0.0.1:3457`. For Render and for a later production host it is that service's exact `https` origin.

The synthetic demonstration needs `DATABASE_URL`, `FIRESTORE_PROJECT_ID`, both JWT keys, `NODE_ENV=production`, `PORT`, and `CORS_ORIGIN`. The process exits without the first four. `NODE_ENV=production` makes `gr_session` `Secure`. `PORT` is the port Render provides. `CORS_ORIGIN` lets the browser sign in. `FIRESTORE_PROJECT_ID` can be any non-empty value until wallet writes matter, because a failed Firestore sync is logged and ignored. The JWT values must be non-empty or the process will not start. Fan-token routes need a real RS256 pair. The dashboard does not issue fan tokens. `CLAIM_URL_BASE` is not needed until a claim link is sent. `DEV_ORG_API_KEY` stays unset on the host. The rate-limit variables can stay at their defaults.

## Backup and restore

Synthetic demonstration data can be thrown away. The acceptable loss is the whole demonstration database. Recovery is the manual Neon snapshot taken before any fan rows, or a new project plus migrations 001–019, which returns an empty schema.

`scripts/seedDemoOrg.js` and `scripts/createOperator.js` refuse every database that is not local Postgres. They cannot recreate the local fan fixtures on Neon. `scripts/initHostedDemo.js` can create Equip AI Labs and one operator, and nothing else. A snapshot taken after that command is the way back to a signed-in empty dashboard. Losing the demo and starting from an empty schema is acceptable. Losing a real customer file is not.

Real customer data is a different requirement, and it is not met by this contract:

- A scheduled backup that survives deletion of the Neon project, retained for a period Aaron sets. A starting proposal is a daily copy kept for 30 days.
- A restore drill onto a separate database, completed once before any real file is imported.
- The demonstration database is not the database that receives a real customer file.
- Neon encrypts connections with TLS and encrypts storage at rest. That is not a tested restore.
- `audit_log` cannot be edited in place. A restore replaces the database from a backup. It is not a row-level undo.

No customer file is loaded under the free-tier window. The free plan keeps about six hours of history plus one manual snapshot. That is not a customer backup.

## Known issues

These stay out of this slice.

- A quoted comma in a CSV is split into two columns.
- `express.json()` caps a body near 100 KB. The CSV guard allows 1,000,000 characters, and a larger file never reaches that guard.
- A CSV import runs to completion inside the request.
- `SameSite=Lax` is the CSRF control. Origin and Referer checks are not added.
- Hosted row-level security is not verified. The local proof is `golden_record_app` on localhost.
- A real customer file needs a backup and a tested restore that does not depend on Neon's free-tier history.
- More than one operator, and any staff role beyond that single identity, is future product work.

## Hosted demo initialization

`scripts/initHostedDemo.js` creates one organization and one operator. It does not load fans, and it does not change `scripts/seedDemoOrg.js` or `scripts/createOperator.js`. Those two still refuse every non-local database.

The command reads `GOLDEN_RECORD_DEMO_DATABASE_URL` and `GOLDEN_RECORD_DEMO_OPERATOR_PASSWORD`. It does not read `DATABASE_URL`. The URL must be the Neon owner, not `golden_record_app`, because the application role cannot insert into `org`. The host must equal `--expect-host`, the database must equal `--expect-database`, the port must be 5432, and `sslmode` must be `require`. A pooled host, localhost, port 5433, and any non-Neon host are rejected. `--confirm` must be `hostname/database` or the command writes nothing.

It stops when any organization or operator already exists. It does not update, delete, or truncate. The operator password and the generated organization API key are not printed. This command has not been run against Neon.

## Health queue

`GET /health` counts pending `ingest_failures` for the organization identified by the API key. The count sets `app.current_org_id` inside that transaction. A request without a key does not run the count.

## Hosted setup procedure

Do not create the Neon project, the Render service, or any rows by reading this section. Run it only after a separate approval to execute.

Checked against Neon and Render docs on 2026-11-13.

**Region.** Create the Neon project in AWS US East (Ohio), Neon id `aws-us-east-2`. When the Render web service is created, choose Ohio. Neon cannot move a project to another region later. Ohio is the pair: Render offers Ohio, and it is the closer US region to this machine. Oregon is the other pair (`aws-us-west-2` with Render Oregon). Pick Oregon only by creating a different empty project before any migration runs.

**Free plan, as published that day.** No credit card. 100 compute-hours per project per month at the default 0.25 compute unit. Compute scales to zero after 5 minutes of no connections, and the free plan cannot turn that off. Hitting 100 compute-hours or 5 GB of network transfer suspends compute until the next period. Storage growth stops past 1 GB in one project. Select Postgres 16 on the create form. Stop if 16 is not offered. Do not accept a newer major version in its place.

**Direct connection.** In the Neon connect dialog, turn connection pooling off. The toggle is on by default and only changes the string it displays. Copy the owner role's string. The host must start with `ep-` and end with `.aws.neon.tech`. Neon may insert a short cell name before the region, as in `ep-something.c-9.us-east-2.aws.neon.tech`. It must not contain `-pooler`. The port is 5432. The query string includes `sslmode=require`. Write down the database name Neon created. The usual name is `neondb`. Store the owner string outside the repo and outside `.env`. Leave local `DATABASE_URL` on localhost.

**Migrations.** From the repository root, with the owner string only in that shell:

```sh
OWNER_URL='postgresql://OWNER:PASSWORD@ep-something.us-east-2.aws.neon.tech/neondb?sslmode=require'
for f in migrations/migration_0*.sql; do
  psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f "$f" || exit 1
done
```

That loop is `migration_001.sql` through `migration_019.sql` in numeric order. `psql -f` is required. `migration_013.sql` and `migration_018.sql` run `CREATE INDEX CONCURRENTLY`, which fails inside an explicit transaction. Their `DO` blocks are separate transactions, so a file run by `psql -f` is valid. `migration_003.sql` still says not to run it. Run it anyway. It is the row-level security migration, and an empty database has no organizations for `migration_001.sql` to refuse. Stop on the first error. Do not continue past a failed file.

**Application role.** After 019 succeeds, set a password for `golden_record_app` in the Neon console or with `\password` in psql. Then run the grant block in "Application role" as the owner. Replace `neondb` in `GRANT CONNECT` with the database name you wrote down. `GRANT CONNECT ON DATABASE current_database()` is not valid SQL. Build a second connection string for this role, same host, same database, `sslmode=require`, no `-pooler`. That string is the future Render `DATABASE_URL`. It is not the string used for migrations or for `initHostedDemo.js`.

**Hosted verification, on a branch.** `initHostedDemo.js` stops when any organization exists, and an `audit_log` row keeps its organization from being deleted. Run the nine checks on a Neon branch, then delete that branch. The default branch stays empty.

1. In the Neon console, branch the default branch after migrations and grants. Name the branch `rls-check`.
2. Open the owner connection and the `golden_record_app` connection against that branch's direct host. The branch host is a different `ep-` name. It still must not contain `-pooler`.
3. Run checks 1 through 9 in "How tenant isolation will be verified" on that branch. The owner inserts the two fixture organizations. Every assertion uses `golden_record_app`.
4. Keep the SQL and the row counts. Stop if the role is a superuser, has `BYPASSRLS`, or can see the other organization's fan.
5. Delete the `rls-check` branch. Do not run `initHostedDemo.js` on it. Do not point `tenantIsolation.test.js` or `healthIsolation.test.js` at either host. Both refuse every non-local database.

Check 9's health request needs a running API. Skip that HTTP call until Render exists. The SQL count inside `countPendingIngestFailures` can still be run on the branch with a `psql` session: begin, `set_config('app.current_org_id', '<org A>', true)`, count pending `ingest_failures` for A, commit. The session tenant before that transaction is B.

**Demo data, on the default branch.** After the branch is gone, confirm the default branch has zero rows in `org` and zero rows in `operator`. Take one manual Neon snapshot of that empty schema. Then, in one shell, with the owner URL and the operator password in the environment and not in the command arguments:

```sh
export GOLDEN_RECORD_DEMO_DATABASE_URL="$OWNER_URL"
export GOLDEN_RECORD_DEMO_OPERATOR_PASSWORD='the-operator-password'
node scripts/initHostedDemo.js \
  --expect-host=ep-something.us-east-2.aws.neon.tech \
  --expect-database=neondb \
  --email=operator@example.com \
  --org-name='Equip AI Labs' \
  --confirm=ep-something.us-east-2.aws.neon.tech/neondb
unset GOLDEN_RECORD_DEMO_DATABASE_URL GOLDEN_RECORD_DEMO_OPERATOR_PASSWORD
```

`--confirm` is the host, a slash, and the database name. The command prints the host and database, then the organization id and the operator email. It does not print the password or the organization API key. The raw API key is discarded. Dashboard sign-in does not need it. A later call to the organization API would need a new key, and no command issues one.

The command inserts one organization named Equip AI Labs and one operator. It inserts no fans, reviews, imports, or households. `scripts/seedDemoOrg.js` cannot be pointed at this host. The first dashboard on Neon is a signed-in empty review queue. Fan rows wait for a later approved loader, or for rows typed after the site exists. Those rows are synthetic. No real customer file and no real person's data.

Take a second snapshot after the organization and operator exist if that signed-in empty database is the state worth restoring. The first snapshot remains the empty-schema restore.

## Render, after a separate approval

Do not start these steps from this document. They follow a successful run of the hosted setup procedure.

1. Create the Render web service in Ohio from this Dockerfile. Set the environment from the table above. `DATABASE_URL` is the `golden_record_app` direct string. `NODE_ENV=production`. `CORS_ORIGIN` is the Render `https` origin. Secrets are host environment variables, not the image.
2. Confirm `/reviews` returns the dashboard, `/v1/dashboard/session` without a cookie returns JSON 401, sign-in works, and a review page reload returns the dashboard.
3. Leave the existing Cloud Run service untouched.
