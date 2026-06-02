# lessons.md — Golden Record Fan Identity Platform
# Patterns learned from corrections and decisions.
# 20-entry cap. Oldest rotate out when cap is hit.

---

## 1 — Mock ROLLBACK in 500 error tests (2026-05-29)

When testing a db error path that triggers the catch block, the catch block
calls `req.db.query('ROLLBACK').catch(() => {})`. If no mock is set up for
that call, `jest.fn()` returns `undefined` and `undefined.catch()` throws a
TypeError before the 500 response is sent — the response body is empty.

**Fix:** In any 500 error test, add a ROLLBACK mock after the rejection:
```javascript
mockDb.query
  .mockRejectedValueOnce(new Error('some db error'))  // the failing query
  .mockResolvedValueOnce({ rows: [] });               // ROLLBACK
```

**Scope:** applies to every handler that has `ROLLBACK` in its catch block.
Components 19, 20, 26, 29 — and all future handlers with transactions.

---

## 3 — Never auto-create parent records — return 404 (2026-05-29)

When a handler needs a parent record (e.g. household before adding a member),
do NOT auto-create it if it does not exist. Return 404 and tell the caller
which endpoint to call first.

Auto-creation bypasses deliberate fan actions and breaks the audit trail.
The household in Component 29 must exist because POST /v1/household is a
separate fan-initiated action with its own audit event. Silently creating it
would mean no audit record for the household creation.

**Pattern:**
```javascript
if (!parentRecord) {
  return res.status(404).json({
    error:   'parent not found',
    message: 'create it first via POST /v1/parent-endpoint',
  });
}
```

**Scope:** any endpoint that requires a prior fan action (household, wallet, etc.)

---

## 4 — SQL substring assertions: use regex when column names contain table names (2026-05-31)

When asserting "no UPDATE on fan table" by filtering all SQL strings for
`.includes('UPDATE') && .includes('FAN')`, the filter false-positives on
`UPDATE household_member ... RETURNING ... MINOR_FAN_ID` because `MINOR_FAN_ID`
contains the substring `FAN`.

**Fix:** use a regex that matches `UPDATE` followed by the table name as a word
boundary, not a substring:
```javascript
const fanUpdates = allSqls.filter(s => /UPDATE\s+FAN[\s\n]/.test(s));
```
This matches `UPDATE fan WHERE` but not `UPDATE household_member ... MINOR_FAN_ID`.

**Scope:** applies to any assertion that checks whether a specific table was
targeted by a write. Always use a word-boundary regex, not `.includes()`.

---

## 5 — Separate router for endpoints with different middleware stacks (2026-06-01)

When a route in a file requires DIFFERENT middleware than the other routes in that file
(e.g. Component 35 — no jwtMiddleware — living alongside Components 27-34 which all need
jwtMiddleware), export a second router as a property on the default export:

```javascript
const claimRouter = express.Router();
// ... add routes to claimRouter ...
router.householdClaimRouter = claimRouter;
module.exports = router;
```

Then in index.js, extract and mount on the appropriate middleware chain:
```javascript
const householdRouter = require('./src/routes/household');
const { householdClaimRouter } = householdRouter;
// mount claimRouter on a public router (no jwtMiddleware) BEFORE the protected router
```

**Why:** Attaching as a property on the default export preserves backward compatibility
for every existing test and import that does `require('./household')` directly. No
destructuring needed in old code. New router is accessible via named property.

**Mount order matters:** The public router (no JWT) must be mounted BEFORE the protected
router in index.js or Express will match the public route's path segment (e.g. 'claim')
as a URL parameter (e.g. :adult_fan_id) in the protected router.

**Scope:** any future household or other route that needs different middleware from its siblings.

---

## 6 — CHECK constraints block new event_type and identifier_type values (2026-06-02)

When CLAUDE.md says "No schema change needed — event_type is TEXT not enum,
new values work automatically," this is WRONG if a CHECK constraint exists on
that column. migration_001.sql defines CHECK constraints on both
audit_log.event_type and audit_log.identifier_type. Postgres CHECK constraints
block any value not in the allowed list regardless of column type. Sprint 2+
and Sprint 3 introduce new values for both columns that violate these constraints.

When migration_005 fixed identifier_link.identifier_type, it missed the identical
constraint on audit_log.identifier_type. The same identifier_type values are
written to audit_log by resolverEngine on every resolution — same column name,
same allowed-values pattern, but a different table. Fixing one table is not
enough when the same constraint pattern exists on multiple tables.

**Rule:** Before writing a new event_type or identifier_type to audit_log,
always verify the CHECK constraint in migration_001.sql and any subsequent
migration that may update it. When adding new values in a new sprint, always
check if a migration update is needed for ALL columns with CHECK constraints
that reference the new type — and for ALL tables that have that column.

**Corollary:** When fixing a CHECK constraint for a column name (e.g.
identifier_type), grep for that column name across ALL tables, not just the
one in front of you. `grep -n "CHECK.*identifier_type" migrations/` catches
the same constraint appearing in multiple tables.

**Scope:** applies any time a new sprint adds new values to a CHECK-constrained
column. Always grep for `CHECK (column_name IN` before claiming no schema change
is needed.

---

## 7 — Logger must use arrow functions for jest.spyOn to work (2026-06-02)

If the logger is defined as `{ info: console.log }` (direct reference), then
`jest.spyOn(console, 'log')` cannot intercept calls to `logger.info`. The spy
replaces the `console.log` property on the console object, but `logger.info`
holds the original function reference captured at module load time.

**Fix:** define the logger with arrow functions so every call goes through the
current console property at call time:
```javascript
const logger = {
  error: (...args) => console.error(...args),
  warn:  (...args) => console.warn(...args),
  info:  (...args) => console.log(...args),
};
```
Now `jest.spyOn(console, 'log').mockImplementation(() => {})` intercepts all
`logger.info(...)` calls and `logSpy.mockRestore()` properly restores them.

**Scope:** applies to any logger module defined with direct console references
that tests need to spy on. This pattern is needed for MEDIUM-1 style "verify
the log does not contain a secret" tests.

---

## 8 — cors string-origin config sets header statically — use function for server-level enforcement (2026-06-02)

When cors is configured as `origin: 'https://allowed.com'` (a string), the
`Access-Control-Allow-Origin` header is set to that string on EVERY response
regardless of the request's `Origin` header. A request from `https://evil.com`
still gets the header back — the browser enforces the restriction, not the server.

To block at the server level (so the header is absent for non-matching origins),
use a function-based origin handler:
```javascript
origin: (requestOrigin, callback) => {
  const allowed = process.env.CORS_ORIGIN;
  if (!requestOrigin) return callback(null, true);   // server-to-server calls
  if (!allowed)       return callback(null, false);  // no config → fail secure
  callback(null, requestOrigin === allowed);          // exact match only
}
```
With `callback(null, false)`, cors does NOT set the ACAO header. Tests that
assert `toBeUndefined()` on the header require this approach.

**Scope:** any future CORS configuration where tests need to verify "unlisted
origin gets no access-control-allow-origin header."

---

## 9 — ON CONFLICT requires an exact matching unique index — verify before shipping (2026-06-02)

`ON CONFLICT (col_a, col_b, col_c) DO UPDATE SET ...` requires a unique index
or exclusion constraint on exactly those columns (or a partial index with a
matching WHERE clause). Without it, Postgres rejects the statement at runtime:
  ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification

Tests that mock req.db.query never hit this error. The bug only surfaces against
a real database. Component 31 (PUT household member) shipped with this defect —
no unique index on (fan_id, identifier_type, org_id).

**Rule:** Before writing any ON CONFLICT clause, verify the exact unique index
exists by querying pg_indexes. A non-unique index on the same columns is not
enough. A partial index requires a matching WHERE clause in ON CONFLICT.

**Scope:** any upsert with ON CONFLICT. Always run the verification query:
  SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '<table>';

---

## 10 — RLS must be explicitly extended to every new table added in subsequent migrations (2026-06-02)

migration_003 enabled RLS on Sprint 1 tables. Sprint 2 and Sprint 3 added 6
new tenant tables (conflict_queue, household, household_member, merge_history,
related_fans, staging_household_data) but none had RLS enabled. Cross-tenant
isolation on those tables relies entirely on application WHERE org_id = $N clauses.

**Rule:** Every migration that creates a new table holding org-scoped data must
include ENABLE ROW LEVEL SECURITY and a CREATE POLICY for that table in the same
migration — not deferred to a later migration. RLS is not inherited.

**Corollary:** When writing a new sprint migration, grep for all new CREATE TABLE
statements and confirm each one has a corresponding ENABLE ROW LEVEL SECURITY
and USING (org_id = ...) policy in the same file.

**Scope:** all future migrations adding tables that join to org or fan.

---

## 2 — Session prompt vs CLAUDE.md pseudocode conflicts — always clarify (2026-05-29)

When the session prompt and CLAUDE.md pseudocode contradict each other on a
guard rule (e.g. "at least one of X or Y" vs "both required"), do not guess
and do not pick the more permissive rule. Write the plan, flag the conflict
explicitly, and check in before touching code.

Aaron confirmed 2026-05-29: pseudocode is authoritative. Session prompt was
wrong about guardian_email/guardian_phone. Both are required because:
- guardian_email is required for aging-up claim link (Component 34)
- guardian_phone is required for probabilistic matching signal

**Rule:** flag contradictions in the plan, check in, build after confirmation.
