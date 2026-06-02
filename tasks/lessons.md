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
