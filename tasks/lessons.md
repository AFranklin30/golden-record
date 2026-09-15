# lessons.md — Golden Record Fan Identity Platform
# Patterns learned from corrections and decisions.
# 20-entry cap. Oldest rotate out when cap is hit.

---

## 12 — CHECK constraints on match_type drift when new paths are added (2026-06-09)

audit_log.match_type was defined in migration_001 with three values:
'hard', 'soft', 'probabilistic'. Sprint 2 Path D introduced a fourth
match_type = 'conflict'. The constraint was never updated. Every Path D
resolution fails in production with a CHECK violation until migration_009 runs.

This is the same class of bug as Lesson 6 (event_type and identifier_type
constraint drift). The pattern repeats for every constrained column when a new
sprint adds a new value.

**Rule:** When adding a new path, result type, or status to resolverEngine,
always grep for CHECK constraints on the column being written:
  grep -n "CHECK.*match_type" migrations/
If a constraint exists, write the migration before shipping the code change.

**Corollary:** CHECK constraints must be updated in the same sprint as the code
that writes the new value — not deferred. A deferred constraint update guarantees
a production outage on the path that uses the new value.

**Scope:** applies to match_type, event_type, identifier_type, status, and any
other TEXT column with a CHECK constraint in this codebase.

---

## 13 — Application-layer status whitelists drift when new status values are added (2026-06-09)

When a new endpoint sets a new value on a status column (e.g. 'unmerged' on
conflict_queue.status), every application-layer whitelist that reads that column
must also be updated. In conflicts.js, ALLOWED_STATUSES = ['pending', 'confirmed',
'rejected'] was never updated when unmerge was added in Sprint 3. Staff cannot
query GET /v1/conflicts?status=unmerged — they receive 400.

This is the application-layer counterpart to Lesson 6 (CHECK constraint drift at
the database layer). Both drift in the same direction: a new code path writes a new
value, but the list of valid values in a gatekeeper is never updated.

**Rule:** When a new status value is written anywhere in the codebase, grep for
every array/set that enumerates that column's allowed values — at the DB layer
(CHECK constraints) AND at the application layer (ALLOWED_STATUSES, switch
statements, conditional branches). Both must be updated in the same sprint.

**Scope:** ALLOWED_STATUSES in conflicts.js, any future status/type enum in a
route handler that reads from a DB column.

---

## 14 — Never attach module resources to req — import them directly (2026-06-09)

household.js Component 29 guards the Firestore child-fan sync with:
  if (req.firestore) { ... }
No middleware in index.js ever sets req.firestore. The guard is always false.
Every child fan created via household silently gets no Firestore wallet document.
Tests mock req.db.query and never noticed — the branch is dead code in production.

**Rule:** Module-level resources (Firestore clients, external SDKs, connection pools)
must be imported directly in the file that uses them, not attached to req and
read back. req is for per-request context (org_id, fan_id, correlation_id, the db
client for the current transaction). Stable resources never change per-request and
do not belong on req.

**Corollary:** When reviewing a new file that reads req.X for something that is not
request context, check that a middleware actually sets req.X before the handler runs.
If no middleware does it, the property is always undefined.

**Scope:** any use of req.[non-standard-property] for a module resource.

---

## 15 — jest.clearAllMocks() wipes module-level constructor call history — use source inspection instead (2026-06-09)

When a module initializes a resource at load time (e.g. `const firestore = new Firestore(...)`),
`jest.clearAllMocks()` in `beforeEach` runs before each test and resets `Firestore.mock.calls`
to `[]`. By the time the test runs, the constructor call count is 0 — `toHaveBeenCalledWith`
always fails for module-level initialization patterns.

**Fix:** Use source inspection instead:
```javascript
const source = fs.readFileSync(require.resolve('../../src/routes/household.js'), 'utf8');
expect(source).toContain("databaseId: 'golden-record'");
expect(source).toContain('new Firestore(');
```
Source inspection is authoritative, immune to mock state, and tests the actual file.

**Corollary:** `jest.expect()` does not accept a second label argument the way some test
frameworks do (Jasmine style). Use separate named `test()` blocks instead of a for-loop
with labels for better failure attribution.

**Scope:** any test that needs to verify constructor arguments on a resource initialized
at module load time, not per-request.

---

## 16 — pool.on('connect') is not safe for queries when multiple connections establish simultaneously (2026-06-09)

`pool.on('connect')` fires synchronously when a connection is established — before
the client is fully ready for concurrent use. During Cloud Run startup, when the
pool opens multiple connections simultaneously, overlapping `client.query()` calls
on the same client trigger:

  DeprecationWarning: Calling client.query() when the client is already executing
  a query is deprecated and will be removed in pg@9.0.

**Fix:** Remove the `pool.on('connect')` handler. Set connection-level config
(e.g. `statement_timeout`) inside `rlsContextMiddleware` instead, where the client
is acquired via `await pool.connect()` and the query is properly awaited — a single
atomic operation with no concurrent execution risk.

**Why rlsContextMiddleware is the right place:** Every real route handler already
flows through it. The health endpoint and `orgAuthMiddleware` use `pool.query()`
directly and run only lightweight queries — they do not need `statement_timeout`.

**Pattern:**
```javascript
// In rlsContextMiddleware — set both RLS context and timeout in one query
await client.query(
  'SELECT set_config($1, $2, false), set_config($3, $4, false)',
  ['app.current_org_id', org_id, 'statement_timeout', '10000']
);
```

**Test update:** The startup test that asserted `pool.listenerCount('connect') > 0`
must be inverted to assert `=== 0`, and a source-inspection test added to verify
`rlsContextMiddleware` sets `statement_timeout`. Never fix a test to match broken
code — but when the design intentionally changes, update the test to match the new
correct behavior.

**Scope:** any future connection-level Postgres config. Do not use `pool.on('connect')`
for queries. Use `rlsContextMiddleware` or a dedicated middleware with a properly
awaited client.

---

## 17 — Shared UUID validation — one source of truth (2026-06-16)

Before: `UUID_RE` was defined identically in `conflicts.js` and `household.js`. Two copies
of the same regex with no connection between them — a silent drift risk if one is ever
updated.

After: `src/lib/validate.js` exports `UUID_RE` and `isValidUuid`. Both files import
`{ UUID_RE }` from that module. Only one definition to maintain.

**Why:** Duplicated regex constants are the lowest-friction source of subtle bugs —
one copy gets updated, the other doesn't, both tests still pass because they test
different endpoints. Moving to a shared module makes the single source of truth
explicit and machine-enforceable.

---

## 18 — Shared logger — arrow functions required for jest.spyOn (2026-06-16)

Before: 13 files each defined their own logger literal, with varying shapes:
`{ error: console.error }`, `{ error, warn }`, `{ warn }`, `{ error, warn, info }`.
None used arrow functions, which means `jest.spyOn(console, 'error')` cannot
intercept calls made through any of these loggers (the direct reference is captured
at module-load time, bypassing the spy). Lesson 7 documents this failure mode.

After: `src/lib/logger.js` exports a single logger using arrow functions so every call
is routed through the live `console` property at call time. All 13 files import it.

**Why:** Arrow functions make the logger spy-able, which matters for tests that assert
"this error was or was not logged." Direct-reference loggers silently defeat those tests.
The shared module also prevents each new file from re-introducing the wrong pattern.

---

## 19 — dotenv.config() belongs only at the application entry point (2026-06-16)

Before: `resolverEngine.js` called `require('dotenv').config()` at the top of the file.
The root `index.js` already calls this on line 3 before any module is loaded.

After: The call is removed from `resolverEngine.js` entirely.

**Why:** `dotenv.config()` is idempotent (it doesn't re-load if already loaded), so
calling it twice causes no runtime bug — but it signals incorrect design: a module
should not know or care how its environment is initialized. Entry-point configuration
belongs only in the entry point. Module files should simply read `process.env.*`.

---

## 20 — Removing genuinely dead code requires updating the test that proves it runs (2026-06-16)

Before: `normalizer.js` had a DD/MM/YYYY date-parsing branch that ran when the
MM/DD/YYYY attempt failed (i.e., when the "month" field was > 12). The test
`'31/03/2000'` → `'2000-03-31'` proved this branch was reachable and exercised it.
The task description called it "unreachable" — technically incorrect. It was
reachable but wrong behavior for a US-only platform.

After: The DD/MM/YYYY block (7 lines) is deleted from `normalizeDob`. The test is
updated: `'31/03/2000'` now throws `NormalizationError('dob format invalid')` as
expected for a US-only platform.

**Why:** The Thunder is US-only. Silently accepting `31/03/2000` and returning
`2000-03-31` is incorrect behavior that could corrupt identity records. The fix is
intentional — not just cleanup.

**Rule:** When removing a code branch, grep the test suite for tests that exercise
that specific branch. A test proving reachability is proof you need to update the
test, not just delete the branch.

---

## 21 — Chained-merge fan building fails against two independent guards — verify empirically before designing around it (2026-08-02)

When a seed/fixture script needs a fan holding multiple identifier types
(e.g. `name` + `dob`), the intuitive approach — resolve one field, resolve
the second field with the first passed via `identifiers` for scoring,
confirm the resulting conflict — silently assumes the eligibility gate and
the merge system have no hidden caps. Both failed this session, on two
separate runs, for two separate reasons:

1. `passesSignalEligibilityGate` requires composite signals
   (`name_plus_dob`, `name_plus_zip`) to have BOTH fields already present on
   the CANDIDATE, not just the inbound tap. A fan holding only `name` can
   never be scored against an inbound `dob` — there is no sequence of two
   resolves that builds a two-field fan from nothing. Only
   `email_similarity` and `guardian_email` are single-field STRONG signals,
   so only those can ever bootstrap a fresh fan.
2. `conflicts.js`'s multi-hop merge block allows a fan to absorb at most one
   confirmed merge, ever (`identifier_link.merged_from_fan_id` is a single
   column, not a chain). A merge's loser is always a freshly-minted
   single-identifier fan. So even a fan that successfully bootstraps via
   email caps at exactly 2 identifier types — a second merge onto the same
   target 409s.

Neither failure was visible from reading the code in isolation — both only
surfaced by actually running the sequence against a real database and
reading the real error. The fix that worked: stop building fans through
chained live merges entirely. Insert fixture fans directly via SQL (they
represent "what a touchpoint already knows"), and reserve live API calls for
the RESOLUTION DECISIONS being demonstrated (the scoring, the veto, the
pending conflict, the confirm) — those are the genuine artifact, not the
fixture's pre-existing state.

**Rule:** before designing a fixture/seed script around resolverEngine's
merge mechanics, run the proposed sequence once against a real local
database and read the actual response, rather than deriving it purely from
reading `resolverEngine.js` and `conflicts.js`. Multi-step stateful flows
(gate → score → conflict → confirm) can have caps that are only visible in
their composition, not in either guard read alone. Documented as a new Open
item in CLAUDE.md ("Merge-built fans cap at two identifier types") rather
than fixed — both guards are individually correct.

**Scope:** any future seed script, fixture builder, or test helper that
tries to assemble a multi-identifier fan via resolve+confirm rather than
direct SQL.

---

## 22 — Server-to-server tests cannot catch browser-enforced CORS behavior (2026-08-02)

`corsOptions.allowedHeaders` in index.js listed `X-Api-Key` (dead — nothing
reads it) but not `Authorization` (the header orgAuthMiddleware actually
reads). 75+ existing tests never caught this because every one of them uses
supertest with no `Origin` header — the `cors` package only engages its
preflight/allowedHeaders logic when it sees an `Origin` header on the
request. No Origin means no preflight means `allowedHeaders` is never
exercised, no matter how many requests the suite sends. This is a
browser-only failure mode: it costs nothing in supertest and blocks every
real cross-origin fetch/XHR call from a frontend.

**Fix pattern:** a dedicated test that sends a real `OPTIONS` request with an
`Origin` header (`tests/cors.preflight.test.js`), asserting on
`access-control-allow-headers` in the response. Confirmed via source read of
`node_modules/cors/lib/index.js` (`configureAllowedHeaders`) that when
`allowedHeaders` is a static array, the response reflects that exact array
regardless of what `Access-Control-Request-Headers` asked for — so the test
doesn't need to vary the requested header per assertion, just confirm the
static list is right.

**General form:** when a config allowlist exists (CORS headers, CHECK
constraints — see Lesson 6/12, ALLOWED_STATUSES — see Lesson 13),
identify every actual reader/writer and assert they agree with the list.
Allowlists drift in both directions — an entry with no reader (X-Api-Key
here) is the same class of bug as a reader whose entry is missing
(Authorization here), just silent instead of loud.

**Scope:** any CORS config change; any future allowlist-shaped config where
the thing enforcing it (browser, DB constraint, application whitelist) is
different from the thing that owns the test suite's request path.

---

## 23 — "Single source of truth" doesn't require every consumer to import the real thing (2026-08-02)

Proposed plan: fix `cors.test.js`'s stale `allowedHeaders` mirror by importing
`ALLOWED_HEADERS` from `index.js`, matching the "import it if usable" pattern
`cors.preflight.test.js` already uses. Aaron corrected it: `index.js` calls
`app.listen()` unconditionally at require-time (no `require.main` guard) and
requires `DATABASE_URL`/`FIRESTORE_PROJECT_ID`/JWT keys at load — importing
it turns a fast, isolated, dependency-free unit test into one that boots the
whole app, for a fixture whose `allowedHeaders` value nothing in that file
even asserts against.

Correct fix: export the constant from `index.js` (one declaration, one source
of truth) but let each consumer decide whether the coupling to the full app
boot is worth it. `cors.preflight.test.js` already pays that cost because it
needs the real app's actual preflight behavior. `cors.test.js` never tested
header contents at all — so the right fix there was deleting the dead mirror
plus a comment pointing at where real coverage lives, not building a
substitute source of the same value.

**Rule:** when killing a hardcoded mirror, first check whether anything in
the file actually asserts against it. If nothing does, delete it — importing
the real source to replace an assertion that doesn't exist just relocates the
drift risk into an unnecessary dependency instead of removing it.

**Scope:** any future "point the test at the real config" fix. Don't default
to importing the heaviest available source of truth; import only as much as
the file's own assertions need.

---

## 24 — Column-count assertions are the same brittleness class as CHECK-constraint enumeration (2026-08-11)

`tests/migration_014.test.js` asserted `resolution_trace` has exactly 23
columns. migration_016 legitimately added 4 block-metadata columns
(`block_keys_available`, `block_results`, `blocks_dropped`, `block_size_cap`)
— an intentional, prompt-authorized schema change — and the hard-coded count
broke immediately, for a reason that had nothing to do with correctness.

This is Stage 7's own test-hardening principle (assert the shape you care
about, not an incidental total) applied to a test the hardening pass didn't
reach. It's the same failure shape as Lesson 6/12's CHECK-constraint
enumeration and Lesson 13's ALLOWED_STATUSES drift: a gatekeeper pinned to
today's exact value breaks on the next legitimate addition, not on a bug.

**Fix applied here:** updated the count (23 → 27) with an inline comment
showing the old value and the reason, per the documented test-fixing
exception (the test was pinning a fact this migration deliberately changed).

**Not fixed here, flagged instead:** the assertion should check that specific
expected columns exist (`SELECT column_name FROM information_schema.columns
WHERE ... AND column_name = ANY($1)`) rather than counting all of them. A
count will break again on migration_017 and every migration after that
touches this table, for the same non-bug reason. Rewriting it is its own
prompt, not a side effect of a schema-only migration.

**Scope:** any test asserting `COUNT(*)` of columns/indexes/constraints on a
table expected to keep evolving. Prefer asserting the specific members that
matter over the total.

---

## 25 — Oversized blocking blocks are only reachable via guardian_email/fan_pass, not a general case (2026-08-13)

`uq_identifier_per_org` (migration_013) is `(identifier_type, identifier_value,
org_id) WHERE source_system != 'fan_pass'` — that WHERE clause applies to
every identifier_type the index covers, not just guardian_email. For `email`,
this means at most one live fan per org can ever hold a given email value
outside a `fan_pass` row. Consequence for `findBlockCandidates`'s email key:
an oversized email block isn't just rare in real traffic, it's structurally
impossible unless a row is written with `source_system = 'fan_pass'` — which
nothing in the email ingest paths does.

`guardian_email` is different only because production code (household.js,
sibling creation) deliberately writes those rows with `source_system =
'fan_pass'` — that carve-out is the entire reason the WHERE clause exists
(see CLAUDE.md's identifier_link uniqueness-index section). A large household
sharing one guardian_email is how a real oversized guardian_email block
happens; there is no equivalent real-world path for email.

This surfaced as a side effect of a test fixture (findBlockCandidates.test.js
cases 9-10, drop-at-cap / inclusive-boundary), not from reading the schema in
isolation — seeding duplicate emails with the default `source_system: 'test'`
hit the unique index immediately, which is what forced the guardian_email +
`fan_pass` choice.

**Rule:** when a test needs to prove "oversized block" behavior for a
blocking key backed by `identifier_link`, check whether that key's
identifier_type is ever written with `source_system = 'fan_pass'` in
production code before deciding which key to seed duplicates for. Seeding
duplicates for a key that's never written that way (email) doesn't represent
a reachable state — it represents a fixture bypassing a constraint that real
traffic can't bypass.

**Scope:** any future blocking key, fixture, or test seeding duplicate
`identifier_link` values for the same identifier_type/org. Same instinct as
Lesson 9 (verify the index before shipping) — applies to seeding data, not
just to `ON CONFLICT` clauses.

---

## 26 — `tests/routes/` legitimately holds two different test patterns, not drift (2026-09-05)

Every existing `tests/routes/*.test.js` (conflicts, household, resolve, nfc,
profile) mocks `req.db`/`req.context` directly and mounts only the router
under test — real `orgAuthMiddleware`/`rlsContextMiddleware` never run. That
pattern cannot prove a real 401/403 from `orgAuthMiddleware` (missing key,
invalid key, inactive org) or exercise real cross-request SQL behavior (an
actual merge via the real confirm endpoint, real RLS-scoped cross-org rows) —
by construction, since the middleware that produces those outcomes is never
in the request path.

`tests/routes/export.test.js` needed exactly those things, so it uses the
other pattern already established elsewhere in the repo (`tests/migration_015
.test.js`, the `tests/concurrency.*.smoke.js` files): a real local Postgres
connection, a real Express app built from the actual middleware files in
their documented order, seeded orgs with real sha256 API-key hashes, FK-ordered
cleanup in a `finally` block.

**Rule:** the choice between the two patterns is not stylistic — it follows
directly from CLAUDE.md's own locked convention ("Middleware-level guards
must be tested through the real Express app via supertest — NOT by calling
handlers directly. Handler-level logic can call the handler/module directly").
A route whose test list needs to prove an auth/RLS guard fires must use the
real-app-plus-real-DB pattern; a route whose test list is pure handler logic
against already-authenticated context can use the lighter mocked pattern.
Don't "fix" one pattern to match the other just because they live in the same
directory — check which guards the specific test list needs to exercise
before picking.

**Scope:** any new file under `tests/routes/`. Read the prompt's numbered
test list first: if any item names a 401/403/RLS outcome that only a real
middleware chain can produce, default to the real-app pattern for the whole
file rather than mixing mocked-context tests with a real-app auth test in the
same suite.

---

## 27 — Mocking a pooled pg client's `.query` for one request can hang a LATER `pool.query()` forever (2026-09-05)

Forcing a real-DB test to exercise a query-failure path (export.test.js #10)
by patching one client's `.query` method — `jest.spyOn(client, 'query')`,
rejecting on a matched SQL substring, delegating everything else to the
original bound method — worked correctly for the request under test, then
made an UNRELATED verification query later in the SAME test hang forever,
past every timeout (jest's test timeout, Postgres's own `statement_timeout`),
with zero error surfaced.

Root cause: on release, that client goes back into the pool's idle list.
`pool.query()` (used by `orgAuthMiddleware`, and by this test's own follow-up
reads) calls `this.connect()` internally in CALLBACK style —
`client.query(text, values, callback)`, three arguments — whenever it happens
to be handed that same idle client back. The patched `.query` mock was
written for the PROMISE calling convention used by `rlsContextMiddleware`
(`req.db.query(text, params)`, two arguments, no callback) and silently
dropped the third argument. `originalQuery(text, params)` inside the mock
then ran the real driver in promise mode, returning a promise nobody awaited
— the callback `pool.query()`'s internals are waiting on to know the query
finished never fires. No exception, no rejected promise, no timeout: a
genuine permanent hang, because the stalled code is pure JS control flow, not
I/O `statement_timeout` could ever see.

**Fix:** don't make the mock handle both calling conventions — narrower and
more reliable to restore the patch (`mockRestore()` on both the `pool.connect`
spy and the per-client `query` spy) immediately after the one response you
needed it for, before touching `pool.query()` or the pool again in the same
test.

**Rule:** any test that patches `client.query` on a client obtained from
`pool.connect()` must restore it before that client can be handed back out by
a LATER `pool.query()` call in the same test (or test file) — that release
happens automatically and invisibly via `rlsContextMiddleware`'s
`res.on('finish', ...)`. Prefer scoping the patch's lifetime to "until I have
the one response I forced" over trying to write a mock that correctly
emulates every calling convention pg's own internals use.

**Corollary:** when branching a `pool.connect` mock on "is this the call I
want to intercept," `args.length` reliably distinguishes pg's own
internal callback-style connect (used by `pool.query()`) from the
application's promise-style `await pool.connect()` (used by
`rlsContextMiddleware`) — confirmed by reading `pg`'s own
`Pool.prototype.connect`/`Pool.prototype.query` source
(`node_modules/pg/lib/pool.js`), not assumed.

**Scope:** any future test that mocks `pool.connect` or a pooled client's
`.query` to force a specific query to fail against a real local Postgres
connection.

---

## 28 — resetLocalDb.sh's final table count is printed, not asserted — an incomplete schema still reports success (2026-08-26)

The script's final verification step queries and prints the public-schema
table count and list, but never compares the count against the expected
number of tables. Because `resetLocalDb.sh` deliberately runs without
`ON_ERROR_STOP` (several migrations contain self-verification statements that
error by design — see the migration_001 dead-CONSTRAINT fix this session), a
real ordering or syntax error partway through the replay looks visually
identical to one of those expected errors. This session, a real error (a bare
`CONSTRAINT` clause outside its `CREATE TABLE` body in migration_001.sql,
never valid SQL) had been silently failing every replay since April, and a
reset produced an 11-table schema instead of 12 while still printing "Reset
complete."

**Rule:** a script that runs without `ON_ERROR_STOP` because some failures are
expected must still assert its own success condition explicitly at the end —
printing a count is not the same as checking it.

**Suggested fix (not implemented — out of scope for the migration_001 fix):**
assert the expected table count and expected index count in
`resetLocalDb.sh`'s final verification step; fail loudly (non-zero exit,
clear message) on mismatch instead of just printing the list.

**Scope:** any verification step, in any script, that is meant to catch drift
but only displays a count instead of comparing it against a known-good value.
Same failure shape as [[24]] — a check too shallow to catch the thing it
exists to catch.

---

## 29 — seedDemoOrg.js's "already seeded" guard checks org existence, not scenario completion (2026-08-26)

Running `node scripts/seedDemoOrg.js` against a freshly-reset local database
(as part of verifying the migration_001 fix) failed partway through —
Scenario 3's headline assertion ("fan A entered candidate scoring and lost to
the DOB veto") failed, because blocking's `name_dob` key requires an EXACT
match on both `name_last_word` and `dob`, and the fixture (fan A: "john
smith"/1985-03-12, fan B: "john smyth"/1978-11-04, tap: "John
Smith"/1978-11-04) was built to test FUZZY name matching against an unblocked
scan — neither fixture fan shares both fields with the inbound tap, so
blocking retrieves neither and the block comes back empty. This predates and
is unrelated to the migration_001 fix; it is the first time the demo seed has
run end-to-end since blocking shipped.

The seed script aborted with the org row, 2 fixture fans, and partial
scenario data already committed — no scenarios 4/5, no `evaluation_corpus`
rows, no promoted trace. Its own "already seeded" guard checks only whether
the demo org row exists. On a re-run against this same half-seeded database,
that guard would report "Demo org already seeded" and refuse to run again,
permanently masking the incomplete state rather than surfacing it.

**Rule:** an idempotency guard meant to prevent double-seeding must check for
completion of the thing it guards, not merely the existence of its first
side effect.

**Suggested fix (not implemented — out of scope for the migration_001 fix):**
check for scenario completion (e.g. presence of all 5 scenarios' expected rows,
or a completion marker written last) instead of bare org existence.

**Scope:** any seed/setup script with an idempotency guard, and any downstream
test (`tests/seedDemoOrg.test.js`, `tests/promoteTraceToCorpus.test.js`) that
assumes "the permanent demo org exists" implies "the permanent demo org fully
seeded." Same failure shape as [[24]] and [[28]] — a check too shallow to
catch the thing it exists to catch.

---

## 30 — A test that hardcodes a seed script's generated UUID goes stale on the next reset (2026-09-14)

Fixing Scenario 3's fixture (this session's actual task) required
`bash scripts/resetLocalDb.sh` + a fresh `node scripts/seedDemoOrg.js` — both
required by the task's own verification steps. That produces a brand-new
`crypto.randomUUID()` for every fixture fan, conflict, and `resolution_trace`
row, since none of these IDs are deterministic.

`tests/promoteTraceToCorpus.test.js` (line 46) hardcodes
`SCENARIO_3_TRACE_ID = 'f71a4a01-...'` as a literal constant, rather than
looking Scenario 3's trace up by a stable property (e.g. querying
`resolution_trace` for the row whose `candidate_ids` includes the known-stable
fan pairing, the way `tests/seedDemoOrg.test.js` does via
`findFanByNameDob`). Confirmed via `git log` that the constant was committed
one commit before blocking shipped — it was captured from a single specific
seed run and never revisited. Queried the (already half-seeded, pre-reset)
local DB directly and confirmed the row didn't exist even before this
session's reset: `SELECT id FROM resolution_trace WHERE id =
'f71a4a01-...'` → 0 rows. Every `resetLocalDb.sh` + reseed permanently
invalidates it, and nothing regenerates it — the 5 tests in that describe
block fail with `PromotionError: trace not found` regardless of whether the
seed fixture itself is correct. One of those 5 failures cascades into a 6th,
unrelated-looking failure in `tests/seedDemoOrg.test.js` (the "backfill does
not alter the promoted row's scorer_version" test expects a `promoted_trace`
evaluation_corpus row to already exist — it never gets created, because the
promotion that would create it never succeeds).

**Rule:** never hardcode an ID that a seed script generates via
`crypto.randomUUID()` (or any other non-deterministic generator) into a test
file as a literal constant. Look it up by a stable property instead — the
fixture's own well-known identifying fields (name+dob, email, a label), not
an ID that only exists because one specific run happened to produce it.

**Scope:** any test file that references `scripts/seedDemoOrg.js`'s permanent
demo org by ID rather than by lookup — flagged, not fixed, in
`tests/promoteTraceToCorpus.test.js`; out of scope for a fixture-only change.
Same failure shape as [[24]]/[[28]]/[[29]] — the check trusted a stand-in for
freshness instead of verifying it.

---

## 31 — Generated ids (UUIDs, timestamps, row counts) must never be hardcoded in a test — this is a category, not a one-off (2026-09-14)

Fixed what [[30]] flagged: `tests/promoteTraceToCorpus.test.js`'s
`SCENARIO_3_TRACE_ID` was a literal UUID copied out of a real database after one
specific seed run. Every `resetLocalDb.sh` + reseed generates a brand-new
`crypto.randomUUID()` for that row, so the constant was dead the moment the
database was reset next, and would die again on every future reset regardless
of what else changed. Fix: resolve it once in `beforeAll` via a DB query keyed
on stable properties instead of the run-specific id — `org_id = DEMO_ORG_ID AND
resolution_path = 'D' AND array_length(candidate_ids, 1) = 2` uniquely
identifies Scenario 3's trace (verified by checking every other PATH D trace in
the demo org retrieves exactly 1 candidate, not 2) — and fail loudly, naming
the demo org and saying it needs seeding, if the lookup finds zero or more than
one row. A silent `undefined` surfacing later as a bare "not found" is what
made the original failure hard to diagnose.

This is the fourth instance of the exact same failure shape:
- [[24]] — a test hardcoded `resolution_trace`'s column count (23), broke the
  moment a legitimate migration added columns.
- [[28]] — `resetLocalDb.sh` printed a table count but never compared it
  against the expected number, so an incomplete schema still reported success.
- [[29]] — `seedDemoOrg.js`'s "already seeded" guard checked for the org row's
  existence, not for scenario completion, so a half-seeded database looked
  finished.
- [[30]]/this entry — a hardcoded trace UUID from one seed run, asserted as if
  it were permanent.

All four are the same mistake at different layers: a check pinned to something
*incidental* — a count, an id, an existence flag — that happened to be true
once, instead of a check that looks up or verifies the thing it actually needs.
The first three are documented-not-fixed (each was out of scope for the change
that found it); this one is the first of the four actually fixed, and it
worked precisely because the fix looked up a stable property instead of
re-hardcoding a different incidental value.

**Rule:** never hardcode a UUID, timestamp, row count, or any other value a
script/seed/migration generates non-deterministically into a test as a literal
constant. Look it up in `beforeAll` by a stable, well-known property (a name,
an email, a label, a structural predicate like "the only trace with N
candidates") — resolved once per suite, not per test — and fail loudly with a
specific, actionable message (naming what was expected and what to do) if the
lookup returns zero or more than one match. Treat "how many rows/columns exist
right now" and "what id did this specific run produce" as the same category of
thing that must never be baked into an assertion.

**Scope:** every test file in this repo that reads from `scripts/seedDemoOrg.js`'s
permanent demo org, any test asserting a `COUNT(*)` on a table expected to
evolve, and any future seed/setup script's idempotency guard. Check new test
files against this category before merging, the same way [[6]]/[[12]]/[[13]]
get checked for CHECK-constraint and allowlist drift.
