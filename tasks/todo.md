# pg Deprecation Warning Fix — tasks/todo.md
# Session: 2026-06-09
# Remove pool.on('connect') and move statement_timeout to rlsContextMiddleware

---

## Problem

pool.on('connect') fires synchronously when a connection is established.
During Cloud Run startup, multiple connections establish simultaneously.
Multiple client.query() calls fire before previous ones complete — pg sees
this as calling query() on a client already executing a query, and logs:

  DeprecationWarning: Calling client.query() when the client is already
  executing a query is deprecated and will be removed in pg@9.0.

This is a startup-time warning, not a request-time warning.

## Fix

Two files. Two changes.

### File 1 — src/db/pool.js

- [x] Remove pool.on('connect') handler entirely (lines 13–17)
- [x] Final state: pool config + module.exports only — no connect handler

### File 2 — src/middleware/rlsContextMiddleware.js

- [x] Extend existing set_config query to also set statement_timeout
- [x] Replace single set_config call with two-param set_config call in one query
- [x] Both params set atomically in the same properly-awaited client.query()

Current:
  await client.query(
    'SELECT set_config($1, $2, false)',
    ['app.current_org_id', org_id]
  );

Target:
  await client.query(
    'SELECT set_config($1, $2, false), set_config($3, $4, false)',
    ['app.current_org_id', org_id, 'statement_timeout', '10000']
  );

---

## Why This Is Safe

- Health endpoint uses pool.query() directly — no rlsContextMiddleware — lightweight
  query only, does not need statement_timeout
- orgAuthMiddleware uses pool.query() directly — same reason
- All route handlers that do real work go through rlsContextMiddleware
  — they get statement_timeout via the set_config call
- rlsContextMiddleware already has a properly awaited client via pool.connect()
  — adding statement_timeout to the same query runs in a single atomic operation
  with no concurrent execution risk

---

## Verification

- [x] npm test — 361 tests pass (1 new test added), no regressions
- [ ] No DeprecationWarning in startup logs — verify after deploy

---

## Review

- [x] pool.js has no pool.on('connect') handler
- [x] rlsContextMiddleware.js sets both app.current_org_id and statement_timeout
      in a single query
- [x] All tests pass
