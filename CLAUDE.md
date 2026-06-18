# CLAUDE.md — Golden Record Fan Identity Platform

OKC Thunder — Thunder Innovations Cohort
Author: Aaron
Version: 1.0 · April 2026 · Confidential

This file is the law of this codebase. Read it before touching anything.
Update it whenever a new pattern or rule is introduced.

---

## What This System Is

Golden Record is a production-grade fan identity resolution platform. It resolves
fragmented fan identifiers (NFC card UIDs, emails, phone numbers, NBA IDs,
Ticketmaster IDs) into a single canonical fan record — the Golden Record.

Every fan tap, login, or ingestion event flows through the identity graph. The
system is the source of truth for who a fan is across all Thunder touchpoints.

Tech stack: Node.js/Express · Postgres on Cloud SQL · Firestore · GCP Cloud Run

---

## Middleware Stack Order — This Is Law

Never deviate from this order. Never add middleware outside this sequence without
updating this file first.

```
rate limiter
  → orgAuthMiddleware        // who is calling? validates org API key
    → correlationIdMiddleware // assign request UUID, attach to context + response header
      → jwtMiddleware         // is the fan token valid? attaches fan_id to context
        → handler             // do the actual work
```

**Why this order is fixed:**
- `orgAuthMiddleware` creates `request.context` with `org_id` and `org_name`
- `correlationIdMiddleware` adds `correlation_id` to that same object
- `jwtMiddleware` adds `fan_id` to that same object
- Each middleware depends on the one before it having run
- Wrong order = context missing fields = silent failures that are hard to debug

**What each middleware attaches to request.context:**

| After middleware | request.context contains |
|---|---|
| orgAuthMiddleware | org_id, org_name |
| correlationIdMiddleware | org_id, org_name, correlation_id |
| jwtMiddleware | org_id, org_name, correlation_id, fan_id, acting_as |

---

## Error Sanitization Rule — This Is Law

**Internal error details never reach the caller. Ever.**

The caller receives:
- A generic error message
- The correlation_id so they can report it

The server logs receive:
- The full error detail
- The org_id
- The correlation_id
- The stack trace

**Correct pattern:**
```javascript
CATCH ANY error as err:
  logger.error('descriptive internal message', {
    error:          err.message,
    org_id:         org_id,
    correlation_id: request.context.correlation_id
  })
  RETURN 500 { error: "generic message safe for caller" }
```

**Wrong pattern — never do this:**
```javascript
RETURN 500 { error: err.message }  // exposes internals to caller
```

**Why:** Specific error messages reveal your system's internal structure to
attackers. Stack traces, table names, query structure, and key names have no
business in a response body. The correlation_id is all the caller needs to
report a problem. The real detail lives in Cloud Logging.

---

## Code Pattern — RECEIVE / GUARD / EXECUTE / RETURN

Every function and handler in this codebase follows this four-section pattern.
No exceptions.

```
RECEIVE   — collect inputs, assign to named variables
GUARD     — validate everything before any real work begins
EXECUTE   — do the actual work (module calls, db reads, db writes)
RETURN    — send the response or return the value
```

**EXECUTE dependency order — never deviate:**

| Step | What runs | Why |
|---|---|---|
| 1 | Module / utility calls | Transform or validate before anything touches the database |
| 2 | Database reads (SELECT) | Read before write. Verify things exist. |
| 3 | Database writes (INSERT/UPDATE) | Inside transaction if multiple writes |
| 4 | Audit event | Always last write inside transaction |

---

## TRY/CATCH Patterns

Three patterns in this codebase. Use the right one for the right component.

**Pattern 1 — TRY wraps EXECUTE only**
GUARD has no database calls. Use when all guards are in-memory checks.
Components: orgAuthMiddleware, correlationIdMiddleware, jwtMiddleware,
POST /v1/session, GET /v1/fan/:id/profile

**Pattern 2 — TRY wraps GUARD and EXECUTE together**
GUARD has database calls that can throw. One outer TRY/CATCH covers both.
Components: resolverEngine

**Pattern 3 — Multiple TRY/CATCH blocks**
Different failure modes need different DLQ reason codes.
Components: POST /v1/ingest/nfc

---

## Custom Error Types

| Error | Thrown by | Caught by |
|---|---|---|
| NormalizationError | normalizer.js | Adapter layer → 400. Written to ingest_failures DLQ. |
| JWTError | jwt.js | jwtMiddleware → 401. Internal reason never exposed. |
| ConflictError | resolverEngine | Endpoint layer → 409. Client should retry. |
| ResolverError | resolverEngine | Endpoint layer → 500. Failure audit written before throw. |
| StartupError | jwt.js init | Thrown at startup if keys missing. Prevents Cloud Run start. |

---

## HTTP Status Code Rules

| Code | Meaning in this system |
|---|---|
| 200 | Success |
| 400 | Bad input — normalization failure, missing required field |
| 401 | Unknown caller — missing or invalid credentials |
| 403 | Known caller, access denied — inactive org, erased fan, JWT mismatch |
| 404 | Record not found |
| 409 | Concurrent write conflict — client should retry |
| 500 | Internal failure — generic message only, full detail in logs |
| 503 | Degraded — health check only |

**401 vs 403 rule:**
- 401 = I don't know who you are
- 403 = I know who you are but you cannot proceed

---

## Sprint 1 Build Order

Build in this sequence. Each component depends on everything above it.
Do not skip steps.

```
1   migration_001.sql        — must run first, creates all tables
2   normalizer.js            — pure functions, no database
3   jwt.js                   — pure functions, Secret Manager keys must exist
4   resolverEngine.js        — standalone module, has database calls
5   GET /health              — proves Cloud Run and Postgres connected
6   orgAuthMiddleware        — org table must exist in schema
7   correlationIdMiddleware  — no dependencies
8   jwtMiddleware            — jwt.js must be complete
9   POST /v1/resolve         — normalizer and resolverEngine must be complete
10  POST /v1/ingest/nfc      — normalizer and resolverEngine must be complete
11  POST /v1/session         — jwt.js complete, fan table in schema
12  GET /v1/fan/:id/profile  — fan table and Firestore fans collection ready
```

---

## Database Rules

**Postgres (Cloud SQL) — identity graph and audit trail**
- `org` — every request authenticated against this table
- `fan` — canonical fan record, one row per unique fan
- `identifier_link` — identity graph edges, many rows per fan
- `audit_log` — append only, never UPDATE or DELETE rows here
- `ingest_failures` — dead letter queue for failed ingest attempts

**Firestore — wallet and loyalty data**
- Collection: `fans`
- Document ID: `fan_id` (UUID matching Postgres fan.id)
- Written by resolverEngine on Path B (new record) only
- Missing document = empty wallet state, not an error

**Transaction rule:**
Open transactions as late as possible — after all reads confirm data is valid.
Early transaction open = longer lock hold time.

**Audit rule:**
Audit event is always the last write inside a transaction.
If the audit write fails the whole transaction rolls back.
No write ever exists without a corresponding audit event.

---

## Security Rules

- Raw API keys are never stored — only sha256(rawKey)
- JWT private key is never logged, never returned in any response
- Internal error details never reach the caller (see Error Sanitization Rule above)
- fan_id in URL params is always verified against JWT claim before any db call
- Parameterized queries ($1, $2) everywhere — never concatenate values into SQL strings
- deleted_at check required before issuing JWT or returning profile
- Child tokens (`acting_as: 'child'`) must never be allowed to manage household accounts —
  every route file that accepts household management (create, view, modify, sever, age-up)
  must reject `acting_as === 'child'` with 403 before any handler logic runs.
  The enforcement point is a router-level `router.use()` guard at the top of the route file,
  not inside individual handlers. This prevents silent omissions when new routes are added.

---

## Environment Variables

Required to run locally. Copy `.env.example` and fill in values.

```
DATABASE_URL=postgresql://...
FIRESTORE_PROJECT_ID=...
JWT_PRIVATE_KEY=...          # local only — Secret Manager in Cloud Run
JWT_PUBLIC_KEY=...           # local only — Secret Manager in Cloud Run
RATE_LIMIT_WINDOW_MS=...
RATE_LIMIT_MAX_REQUESTS=...
CORS_ORIGIN=https://...      # exact domain from King/Tanner — pending confirmation
```

---

## How to Run the Migration

```bash
psql $DATABASE_URL -f migrations/migration_001.sql
```

Verify with the queries at the bottom of migration_001.sql.
Expected: 5 tables, all indexes present, 1 seed org row.

---

## Idempotency Key Construction

**POST /v1/resolve:**
```
sha256(identifier_type + "|" + normalized_value + "|" + org_id)
```

**POST /v1/ingest/nfc:**
```
sha256(normalized_uid + "|" + org_id + "|" + station_id)
```

tapped_at is excluded from the NFC idempotency key.
Hardware clock skew on retry generates a different timestamp and breaks idempotency.

---

## What Gets Updated Here

Update this file when:
- A new middleware is added to the stack
- A new custom error type is introduced
- A new TRY/CATCH pattern is used
- A new environment variable is required
- A Sprint 2 component changes an existing rule

Last updated: April 2026 — migration_001.sql complete, starting normalizer.js
```
