# health.js RLS Fix — tasks/todo.md
# Session: 2026-06-09
# Remove Block 3 (error_rate_5m) — audit_log requires RLS context health endpoint cannot provide

---

## Problem

Block 3 queries audit_log directly via pool.query.
audit_log has RLS enabled and requires app.current_org_id to be set
as a session variable before any query runs. pool.query cannot set
that variable — the query throws: "unrecognized configuration parameter app.current_org_id"
This is also the source of the pg deprecation warning.

## Plan

### File touched: src/routes/health.js (1 file, 1 step)

### Step 1 — Remove Block 3 and all error_rate_5m references

- [x] Remove `error_rate_5m: 0.0` from results object (line 34)
- [x] Remove Block 3 entirely (lines 59–75)
- [x] Remove `results.error_rate_5m < 0.01` from isHealthy calculation (line 84)
- [x] Remove `error_rate_5m: results.error_rate_5m` from authenticated response (line 95)

### isHealthy after change:
```
results.db === 'connected' && results.queue_depth < 10000
```

---

## Review

- [x] health.js has no remaining error_rate_5m references
- [x] isHealthy only checks db and queue_depth
- [x] Block 3 (lines 59–75) fully removed
