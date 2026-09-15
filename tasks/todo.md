# Plan — CSV fan export endpoint (GET /v1/export/fans)

Read before planning: resolverEngine.js (14-key candidate projection + blocking
join), profile.js (RECEIVE/GUARD/EXECUTE/RETURN + error sanitization), conflicts.js
(merge_history columns: fan_id_source, fan_id_target, org_id, conflict_id,
merged_by, status, merged_at, reversed_at, reversed_by), index.js (mount order),
migration_014.sql + migration_016.sql (house style: safety guard, semantic CHECK,
RLS, indexes, verification queries), migration_001.sql / migration_005.sql
(org/fan/identifier_link schema, identifier_type CHECK list — confirms `device_id`
is NOT and never has been an allowed identifier_type, so that export column will
always be empty by construction, matching CLAUDE.md), migration_013.sql
(uq_identifier_per_org exact WHERE clause), tests/routes/conflicts.test.js +
tests/routes/household.test.js (existing route tests — mocked req.db/req.context,
bypass real middleware), tests/concurrency.identifierUniqueness.smoke.js +
tests/migration_015.test.js (existing tests that DO hit real local Postgres).

## Key finding that shapes the test file

Every existing `tests/routes/*.test.js` mocks `req.db`/`req.context` directly and
never runs the real `orgAuthMiddleware`/`rlsContextMiddleware` chain. That pattern
cannot satisfy this prompt's test list — #12 requires a real 401/403 from
`orgAuthMiddleware` (missing key, invalid key, inactive org), and #5/#8 require
real SQL behavior (an actual merge via the real confirm endpoint, real cross-org
RLS-scoped rows). So `tests/routes/export.test.js` will NOT follow
conflicts.test.js's mocked pattern — it follows `tests/migration_015.test.js`'s
pattern instead: real `pg` connection, real Express app assembled from the actual
middleware files, seeded org rows with real `sha256` API key hashes, real cleanup
in a `finally` block. This is a new style for `tests/routes/`, not a deviation
from an existing one — no existing route test could pass #12 as written.

## Files

- New: `src/routes/export.js`
- New: `migrations/migration_017.sql`
- New: `tests/routes/export.test.js`
- Edit: `index.js` — one line, mounting `exportRouter` on `protectedRouter`
  (same chain as resolve/nfc/session/profile/conflicts/adminHousehold: rate
  limiter → orgAuthMiddleware → rlsContextMiddleware → correlationIdMiddleware →
  handler; NO jwtMiddleware — org-authenticated, not fan-authenticated).
- Edit: `package.json` — add `csv-stringify` (prod dep, RFC 4180 serialization)
  and `csv-parse` (dev dep, so test #6's escaping assertion uses a real parser,
  not a string check).

## migration_017.sql — export_run table

Follows migration_014/016 house style exactly:
- Safety guard `DO $$ ... information_schema.tables ... RAISE EXCEPTION$$` if
  `export_run` already exists.
- Columns exactly as specified in the prompt (id, org_id, export_type, status,
  row_count, started_at, completed_at, error_detail, requested_by).
- ONE semantic CHECK constraint (the three-way OR given in the prompt) — no
  enumerated `export_type`/`status` values. This is the audit_log.event_type
  lesson from migration_016's block_results comment.
- `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `tenant_isolation`
  policy on `org_id = current_setting('app.current_org_id')::uuid` — applied in
  this migration, not deferred (per the Firestore-gap lesson in CLAUDE.md).
- Index on `(org_id, started_at DESC)`.
- No append-only trigger (running → success/failed is a legitimate UPDATE).
- Verification queries at the end (table exists, column count, index exists,
  constraint exists, RLS forced) mirroring migration_016's format.

## src/routes/export.js — GET /v1/export/fans

RECEIVE: `org_id`, `org_name` from `req.context`.

GUARD (in-memory only): `Object.keys(req.query).length > 0` → 400. This rejects
`?since=...` (and everything else) without silently ignoring it.

EXECUTE (no transaction — export_run tracks the run's own lifecycle, it isn't
part of a multi-table write that needs atomicity, same pattern as
resolution_trace being written outside resolverEngine's transaction):
1. `INSERT INTO export_run (id, org_id, export_type, status, started_at,
   requested_by) VALUES ($1, $2, 'fan_snapshot', 'running', NOW(), $3)` — id
   generated with `crypto.randomUUID()` in JS (not relying on the column
   default) so the handler has it to UPDATE later.
2. Two SELECTs against `req.db` (RLS-scoped):
   a. Main projection — the same 6-way LEFT JOIN shape as resolverEngine's
      candidate query (identifier_link aliased per type: email, name, dob, zip,
      device_id, guardian_email), but: scoped to `f.org_id = $1` with no
      `fan_id` filter and no `LIMIT`; `WHERE f.deleted_at IS NULL`; selecting
      `f.id, f.created_at, f.updated_at` instead of `f.org_id`.
   b. `merged_from` aggregation as its OWN query — NOT a 7th LEFT JOIN on the
      main query. Corrected reasoning (Aaron): a 7th LEFT JOIN on
      `merge_history` multiplies the fan row itself once per matching
      `merge_history` row. Today that's capped at 1 by the multi-hop block,
      so it happens not to bite yet — but treating "capped at 1 today" as
      the safety margin is backwards: a join-based approach is a live
      correctness bug the day multi-hop history ships (Joseph's file gets
      one row per merge instead of one row per fan — silent duplication in
      exactly the report CLAUDE.md says must never look like data loss or,
      symmetrically, phantom rows). A separate aggregation query has no such
      failure mode regardless of how many merges land on one target. Query:
      `SELECT fan_id_target, string_agg(fan_id_source::text, ';') AS merged_from
       FROM merge_history WHERE org_id = $1 AND status = 'active'
       GROUP BY fan_id_target`. Merged into the main rows in JS via a
      `Map(fan_id_target -> merged_from string)`. Same "separate query after the
      main one" shape as resolverEngine's own STEP 5 (linked_systems).
3. Serialize with `csv-stringify`'s sync API: header row
   (`fan_id, created_at, updated_at, email, name, dob, zip, device_id,
   guardian_email, email_last_seen_at, name_last_seen_at, dob_last_seen_at,
   zip_last_seen_at, device_last_seen_at, guardian_email_last_seen_at,
   merged_from`) always written, even for 0 data rows. Null/missing fields →
   `''` (empty string), not `'null'`/`'undefined'` — map explicitly before
   handing rows to `stringify`, don't rely on its default null handling.
4. `UPDATE export_run SET status = 'success', row_count = $1, completed_at =
   NOW() WHERE id = $2`.

On any thrown error inside the try: `UPDATE export_run SET status = 'failed',
error_detail = $1, completed_at = NOW() WHERE id = $2` (best-effort — wrapped in
its own `.catch()` so a failed update never masks the original error), log full
detail + org_id + correlation_id, return 500 with a generic body
(`{ error: 'export could not be completed', correlation_id }`) — matches
profile.js's sanitization pattern exactly.

RETURN (success path): `res.set('Content-Type', 'text/csv')`,
`res.set('Content-Disposition', 'attachment; filename="golden-record-fans-<ISO
date>.csv"')` (date = `new Date().toISOString().slice(0, 10)`), `res.status(200).send(csv)`.

## index.js

One line: `protectedRouter.use(exportRouter);` added after the existing
`protectedRouter.use(adminHouseholdRouter);` line, plus the corresponding
`require('./src/routes/export')` alongside the other route requires. No
reordering of anything else.

## Deferred — noted as comments in export.js, not built

Scheduling (Cloud Scheduler), GCS delivery, reasoning columns, incremental
export/`since`, an export_run operator UI, streaming/pagination (with the
53-fans-prod / 27k-Thunder-sample / 300s-Cloud-Run-timeout scale note from the
prompt).

## tests/routes/export.test.js

Real local Postgres only (`DATABASE_URL=postgresql://postgres:postgres@localhost
:5432/golden_record` — asserted at the top the way the existing smoke tests
guard this). Fresh org(s) with random UUIDs + real `sha256` API key hashes per
run, cleaned up in a `finally` block in FK order (merge_history →
conflict_queue → identifier_link → fan → export_run → org; leave audit_log —
none written by this endpoint anyway). Test app assembled from the real
middleware files in the documented order (rate limiter → orgAuthMiddleware →
rlsContextMiddleware → correlationIdMiddleware → exportRouter, PLUS
conflictsRouter mounted alongside it so test #5 can call the real
`/v1/conflicts/:id/confirm` endpoint) — not `require('../../index')` directly,
to avoid that file's `app.listen()`/`SIGTERM` side effects in Jest, but built
from the identical middleware list index.js uses, in the identical order.

Test #10 (export_run failure → 500 generic + logged detail) — revised per
Aaron's correction. Rejected approach: spying on `pool.connect` to swap in a
fake connection. That couples the test to plumbing (which object the handler
happened to obtain a client from) rather than to behavior (this query failed),
the same brittleness class as the positional-mock failures from prompt 4.
Also rejected: mutating schema inside a transaction and rolling back after —
doesn't actually work here, because Postgres DDL inside an uncommitted
transaction is invisible to every other session, and the export request runs
on its own connection from the pool. A rollback-after approach would need to
COMMIT the schema change to have any effect on the request under test, which
is a real (if temporary) mutation of shared local schema — worse, not better.

Approach used instead: get the real client the same way `rlsContextMiddleware`
does, then patch only that one client's `.query` method for the single test —
`jest.spyOn(client, 'query')`, `mockImplementation` rejecting when called with
the main fan-projection SELECT (matched on a distinctive substring, e.g. `FROM
fan f`) and delegating every other call (the `export_run` INSERT, the failure
UPDATE, `release()`) to the original bound method. This fails the query the
handler actually issues, not the connection underneath it — everything else
about the request is real. Restored via the original method reference in a
`finally`/`afterEach`, no global pool state left patched.

**Added assertion (Aaron's catch):** confirm the run does not end up stuck at
`'running'`. After the forced failure, query `export_run` for that run's id
directly and assert exactly one row, `status = 'failed'`, `error_detail` not
null, `completed_at` not null — not two rows, and not a lingering `'running'`
row. This is the case where the failure UPDATE is itself on the failing path
(e.g. a bug that reuses the same broken query object) and every export error
would silently orphan its own tracking row.

Tests 1–13 implement the prompt's numbered list directly against this real app
+ real DB (seed via direct `INSERT`s into `fan`/`identifier_link`, merge via the
real confirm endpoint for #5, parse the response body with `csv-parse` for #6).

Tests 14–15 (regression): run full `npm test`, diff suite-by-suite against the
stated baseline (11 failed / 556 passed / 1 skipped / 568 total, known failing
suites resolverEngine.test.js @2 and household.test.js @9); `git status`/`git
diff --stat` to confirm only the new files + the one index.js line changed.

## Do not (carried from the prompt, not re-deciding any of these)

No scheduling/GCS/reasoning-columns/incremental/`since`/operator-UI/streaming.
No pool usage (req.db only). No touching resolverEngine.js, the 14-key
projection, or scoring code. No enumerated CHECK values. No jwtMiddleware on
this route. No internal error detail in the response body. No CLAUDE.md edits.

## Open implementation choices being made without re-asking Aaron (not product
## decisions — flagging so they're visible, not silently buried)

- `export_type` literal value used in code: `'fan_snapshot'` (free text, no
  enumeration — a future export type is just a different string, no migration).
- CSV library: `csv-stringify` (prod) / `csv-parse` (dev, test-only) — smallest,
  most standard RFC 4180 pair; no existing CSV dependency in the repo to reuse.
- `merged_from` computed as a second query + in-JS map, not a 7th LEFT JOIN —
  reasoning above.
