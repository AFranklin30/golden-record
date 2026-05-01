# Agent Configuration — Golden Record Fan Identity Platform
# OKC Thunder — Thunder Innovations Cohort
# Author: Aaron
# Version: 1.0 · April 2026 · Confidential
#
# FILE LOCATION IN REPO: .claude/CLAUDE.md
#
# Claude Code reads this file at session start.
# Read tasks/handoff.md second. Then load only the file you are working on.
# Never load the full codebase into context.

---

## 1. Plan Mode — Default Behavior

- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- Write plan to tasks/todo.md with checkable items before touching any file
- Check in with Aaron before starting implementation
- If something goes sideways — STOP and re-plan immediately, do not keep pushing
- Use plan mode for verification steps, not just building
- Ask yourself before every step: "Would a staff engineer approve this?"

---

## 2. Subagent Strategy — Surgical Not Liberal

- Use subagents for isolated, bounded tasks only
- Use subagents for parallel work only — two independent files with zero shared dependencies
- Never spawn a subagent for a task the main agent can do in one step
- Pass only the minimum context a subagent needs — never the full conversation
- Subagent output returns as a summary, not raw output
- Sequential components (normalizer → jwt → resolver) do NOT use subagents
- Subagents acceptable for: orgAuthMiddleware + correlationIdMiddleware in parallel only

---

## 3. Token Efficiency — This Is Law

- Read only the files needed for the current task
- Never load the full codebase into context — load by dependency order
- Load one module at a time following the build order below
- Summarize completed work before starting the next task
- tasks/todo.md is the handoff document between sessions
- tasks/handoff.md is the session boundary document — 5 lines max

**Session start sequence — always in this order:**
1. Read tasks/handoff.md (5 lines — what was done, what is next)
2. Read CLAUDE.md (project rules)
3. Read .claude/CLAUDE.md (this file — agent rules + pseudocode for current task)
4. Load only the file being worked on
5. Begin

---

## 4. File Scope Rule

- One file per task unless files are tightly coupled
- Never edit more than 3 files in a single agent step
- If a change touches more than 3 files — stop and re-plan
- Minimal code impact — simplest correct solution always wins
- No temporary fixes — find root causes, senior developer standards

---

## 5. Self-Improvement Loop

- After ANY correction from Aaron: update tasks/lessons.md with the pattern
- Write rules that prevent the same mistake from happening again
- lessons.md has a 20-entry cap — oldest entries rotate out when cap is hit
- Review lessons.md at session start if it exists
- Ruthlessly iterate on lessons until mistake rate drops

---

## 6. Verification Before Done

- Never mark a task complete without proving it works
- Run tests, check logs, demonstrate correctness
- Never fix a test to match broken code — fix the code to match the test
- Ask: "Would a staff engineer approve this?"

---

## 7. Autonomous Bug Fixing

- When given a bug report: just fix it, no hand-holding required
- Read the failing test first, then the code
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from Aaron

---

## 8. Demand Elegance

- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: implement the elegant solution
- Skip for simple obvious fixes — do not over-engineer
- Challenge your own work before presenting it

---

## 9. Session Handoff — Required at Every Session End

Write to tasks/handoff.md before closing. 5 lines max:

```
Completed: [what was finished this session]
Next: [exact next file in build order]
Blocked: [anything waiting on Aaron, King, Tanner, or credentials]
Decisions: [any architectural decisions made that affect downstream files]
Warnings: [anything the next session needs to know before touching code]
```

---

## 10. Task Management

1. Write plan to tasks/todo.md with checkable items
2. Check in with Aaron before starting implementation
3. Mark items complete as you go
4. High-level summary at each step
5. Add review section to tasks/todo.md on completion
6. Update tasks/lessons.md after any correction

---

## Core Principles

- Simplicity first — minimal code, minimal impact
- No laziness — find root causes, no temporary fixes
- Senior developer standards on every file
- One job per function, one job per endpoint
- The pseudocode is the spec — translate it, do not redesign it

---

---

# FULL PSEUDOCODE REFERENCE — ALL 12 SPRINT 1 COMPONENTS

Read only the section for the component you are currently building.
Do not load sections for components you are not working on.

---

## Build Order — Update Checkboxes As You Go

```
✅ 1   migration_001.sql        — complete
⬜ 2   normalizer.js            — pure functions, no database
⬜ 3   jwt.js                   — pure functions, Secret Manager keys must exist
⬜ 4   resolverEngine.js        — standalone module, has database calls
⬜ 5   GET /health              — proves Cloud Run and Postgres connected
⬜ 6   orgAuthMiddleware        — org table must exist in schema
⬜ 7   correlationIdMiddleware  — no dependencies
⬜ 8   jwtMiddleware            — jwt.js must be complete
⬜ 9   POST /v1/resolve         — normalizer and resolverEngine must be complete
⬜ 10  POST /v1/ingest/nfc      — normalizer and resolverEngine must be complete
⬜ 11  POST /v1/session         — jwt.js complete, fan table in schema
⬜ 12  GET /v1/fan/:id/profile  — fan table and Firestore fans collection ready
```

---

## EXECUTE Dependency Order — Never Deviate

| Step | What runs | Why |
|---|---|---|
| 1 | Module / utility calls | Transform or validate before anything touches the database |
| 2 | Database reads (SELECT) | Read before write. Verify things exist. |
| 3 | Database writes (INSERT/UPDATE) | Inside transaction if multiple writes |
| 4 | Audit event | Always last write inside transaction |

---

## TRY/CATCH Patterns

| Pattern | When | Components |
|---|---|---|
| Pattern 1 — TRY wraps EXECUTE only | GUARD has no db calls | orgAuthMiddleware, correlationIdMiddleware, jwtMiddleware, POST /v1/session, GET /v1/fan/:id/profile |
| Pattern 2 — TRY wraps GUARD + EXECUTE | GUARD has db calls | resolverEngine |
| Pattern 3 — Multiple TRY/CATCH blocks | Different failure modes, different DLQ reason codes | POST /v1/ingest/nfc |

---

## Middleware Stack Order — Law

```
rate limiter
  → orgAuthMiddleware
    → correlationIdMiddleware
      → jwtMiddleware
        → handler
```

request.context after each middleware:
- After orgAuthMiddleware:        { org_id, org_name }
- After correlationIdMiddleware:  { org_id, org_name, correlation_id }
- After jwtMiddleware:            { org_id, org_name, correlation_id, fan_id }

---

## Custom Error Types

| Error | Thrown by | Caught by |
|---|---|---|
| NormalizationError | normalizer.js | Adapter → 400, written to ingest_failures DLQ |
| JWTError | jwt.js | jwtMiddleware → 401, internal reason never exposed |
| ConflictError | resolverEngine | Endpoint → 409, client retries |
| ResolverError | resolverEngine | Endpoint → 500, failure audit written before throw |
| StartupError | jwt.js init | Thrown at startup if keys missing, prevents Cloud Run start |

---

---

## COMPONENT 2 — normalizer.js

File: src/modules/normalizer.js
Type: Pure function module
Dependencies: google-libphonenumber
No database calls. No side effects.
Router is the only public export — never export individual normalizers.

```
// RECEIVE
FUNCTION normalizeIdentifier(type, value):
  identifierType = type
  rawValue = value

// GUARD — universal input validation (router owns all of these)
  IF identifierType is null OR identifierType.trim() is empty:
    THROW NormalizationError("identifier_type is required")
  IF rawValue is null:
    THROW NormalizationError("identifier_value is required")
  IF typeof rawValue is not string:
    THROW NormalizationError("identifier_value must be a string")
  IF rawValue.trim() is empty:
    THROW NormalizationError("identifier_value cannot be blank")
  IF rawValue.length > 512:
    THROW NormalizationError("identifier_value exceeds max length")
  ALLOWED_TYPES = ["email", "phone", "nfc_uid", "nba_id", "ticketmaster_id"]
  IF identifierType not in ALLOWED_TYPES:
    THROW NormalizationError("unknown identifier_type: " + identifierType)

// EXECUTE — route to correct normalizer
  IF identifierType == "email":    RETURN normalizeEmail(rawValue)
  IF identifierType == "phone":    RETURN normalizePhone(rawValue)
  IF identifierType == "nfc_uid":  RETURN normalizeNfcUid(rawValue)
  IF identifierType == "nba_id" OR identifierType == "ticketmaster_id":
    RETURN rawValue.trim()

// RETURN — unreachable but explicit
  THROW NormalizationError("unhandled identifier_type: " + identifierType)


FUNCTION normalizeEmail(value):
// GUARD — format specific only
  normalized = value.trim().toLowerCase()
  IF normalized does not match email regex:
    THROW NormalizationError("email format invalid: " + value)
// EXECUTE + RETURN
  RETURN normalized


FUNCTION normalizePhone(value):
// GUARD — format specific only
  stripped = value.removeAll("(", ")", "-", " ", ".").keepOnly([0-9, "+"])
  parsed = libphonenumber.parse(stripped, defaultRegion="US")
  IF parsed is not valid:
    THROW NormalizationError("phone not a valid number: " + value)
// EXECUTE + RETURN
  RETURN libphonenumber.format(parsed, format="E164")


FUNCTION normalizeNfcUid(value):
// GUARD — format specific only
  stripped = value.removeAll(":", "-", " ").toUpperCase()
  IF stripped does not match [0-9A-F]+:
    THROW NormalizationError("nfc_uid contains non-hex characters: " + value)
  IF stripped.length is not 8 AND stripped.length is not 14:
    THROW NormalizationError("nfc_uid invalid length — expected 4 or 7 byte UID")
// EXECUTE + RETURN
  RETURN stripped.splitIntoPairsOfTwo().joinWith(":")
```

---

## COMPONENT 3 — jwt.js

File: src/modules/jwt.js
Type: Pure function module
Algorithm: RS256. Expiry: 15 minutes.
Private key read from Secret Manager at startup — held in memory, never logged.

```
// MODULE INIT — runs at Cloud Run startup
  PRIVATE_KEY = secretManager.read("jwt-private-key")
  PUBLIC_KEY  = secretManager.read("jwt-public-key")
  IF PRIVATE_KEY is null OR PUBLIC_KEY is null:
    THROW StartupError("JWT keys not found — service cannot start")


FUNCTION signToken(payload):
  fan_id = payload.fan_id
  org_id = payload.org_id

// GUARD
  IF fan_id is null OR not valid UUID: THROW JWTError("fan_id required and must be UUID")
  IF org_id is null OR not valid UUID: THROW JWTError("org_id required and must be UUID")
  IF PRIVATE_KEY is null: THROW JWTError("private key not loaded")

// EXECUTE
  issuedAt  = currentUTCTimestamp()
  expiresAt = issuedAt + 15 minutes
  claims = {
    sub: fan_id,
    org: org_id,
    iat: issuedAt,
    exp: expiresAt,
    jti: generateUUID()
  }
  token = jwtLibrary.sign(claims, PRIVATE_KEY, algorithm="RS256")

// RETURN
  RETURN { token: token, expires_at: expiresAt.toISO8601() }


FUNCTION verifyToken(authHeader):
  raw = authHeader

// GUARD — header shape
  IF raw is null OR empty: THROW JWTError("Authorization header is missing", code=401)
  IF not starts with "Bearer ": THROW JWTError("must use Bearer scheme", code=401)
  token = raw.removePrefix("Bearer ").trim()
  IF token is empty: THROW JWTError("Bearer token is empty", code=401)

// EXECUTE
  TRY:
    decoded = jwtLibrary.verify(token, PUBLIC_KEY, algorithms=["RS256"], clockTolerance=30)
  CATCH TokenExpiredError:     THROW JWTError("token has expired", code=401)
  CATCH InvalidSignatureError: THROW JWTError("token signature invalid", code=401)
  CATCH InvalidAlgorithmError: THROW JWTError("algorithm not permitted", code=401)
  CATCH ANY:                   THROW JWTError("token is malformed", code=401)

// GUARD — claims shape after decode
  IF decoded.sub is null: THROW JWTError("token missing fan_id claim", code=401)
  IF decoded.org is null: THROW JWTError("token missing org_id claim", code=401)

// RETURN
  RETURN { fan_id: decoded.sub, org_id: decoded.org, iat: decoded.iat, exp: decoded.exp, jti: decoded.jti }


FUNCTION jwtMiddleware(request, response, next):
  authHeader = request.headers["authorization"]

  TRY:
    claims = verifyToken(authHeader)
    request.context.fan_id = claims.fan_id
    request.context.jti    = claims.jti
    next()
  CATCH JWTError as error:
    logger.warn("JWT verification failed", { reason: error.message, ip: request.ip })
    RETURN response.status(401).json({ error: "unauthorized", message: "invalid or expired token" })
```

---

## COMPONENT 4 — resolverEngine.js

File: src/modules/resolverEngine.js
Type: Standalone module — has database calls, no HTTP route
TRY/CATCH: Pattern 2 — outer TRY wraps guards AND transaction
Exports: resolverEngine(input) — one named export

```
FUNCTION resolverEngine(input):
  identifier_type  = input.identifier_type
  identifier_value = input.identifier_value
  org_id           = input.org_id
  schema_version   = input.schema_version
  idempotency_key  = input.idempotency_key
  source_system    = input.source_system

  fan_id = null | match_type = null | confidence_score = null
  is_new_record = null | audit_event_id = null
  linked_systems = [] | linked_count = 0

// OUTER TRY — wraps guards AND transaction
  TRY:

    // GUARD 1 — verify org exists and is active
    org = db.query("SELECT id, is_active FROM org WHERE id = $1", [org_id])
    IF org is null:            THROW ResolverError("org_id not found: " + org_id)
    IF org.is_active == false: THROW ResolverError("org is inactive: " + org_id)

    // GUARD 2 — idempotency check
    existingAuditEvent = db.query(
      "SELECT fan_id, match_type, confidence_score, is_new_record, id
       FROM audit_log WHERE idempotency_key = $1 AND org_id = $2",
      [idempotency_key, org_id]
    )
    IF existingAuditEvent is not null:
      RETURN { fan_id: existingAuditEvent.fan_id,
               match_type: existingAuditEvent.match_type,
               confidence_score: existingAuditEvent.confidence_score,
               is_new_record: existingAuditEvent.is_new_record,
               linked_systems: [], linked_count: 0,
               audit_event_id: existingAuditEvent.id }

    BEGIN TRANSACTION:

      existingLink = db.query(
        "SELECT fan_id, confidence_score FROM identifier_link
         WHERE identifier_type = $1 AND identifier_value = $2 AND org_id = $3",
        [identifier_type, identifier_value, org_id]
      )

      // PATH A — hard match
      IF existingLink is not null:
        fan_id = existingLink.fan_id | match_type = "hard"
        confidence_score = 1.0 | is_new_record = false
        db.query(
          "UPDATE identifier_link SET last_seen_at = NOW()
           WHERE identifier_type = $1 AND identifier_value = $2 AND org_id = $3",
          [identifier_type, identifier_value, org_id]
        )

      // PATH B — new record
      ELSE:
        new_fan_id = generateUUID()
        db.query(
          "INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
           VALUES ($1, $2, 'platform', 1, NOW(), NOW())",
          [new_fan_id, org_id]
        )
        db.query(
          "INSERT INTO identifier_link (fan_id, identifier_type, identifier_value,
           org_id, source_system, schema_version, confidence_score, first_seen_at, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,1.0,NOW(),NOW())",
          [new_fan_id, identifier_type, identifier_value, org_id, source_system, schema_version]
        )
        fan_id = new_fan_id | match_type = "hard"
        confidence_score = 1.0 | is_new_record = true

      // STEP 3 — audit event — always last write in transaction
      audit_event_id = generateUUID()
      db.query(
        "INSERT INTO audit_log (id, fan_id, org_id, event_type, match_type, confidence_score,
         is_new_record, idempotency_key, identifier_type, schema_version, status, created_at)
         VALUES ($1,$2,$3,'resolution',$4,$5,$6,$7,$8,$9,'success',NOW())",
        [audit_event_id, fan_id, org_id, match_type, confidence_score,
         is_new_record, idempotency_key, identifier_type, schema_version]
      )

    COMMIT TRANSACTION

    // STEP 4B — Firestore sync — after COMMIT, outside transaction
    // New records only — Path A fans already have a Firestore document
    IF is_new_record == true:
      TRY:
        firestore.collection("fans").doc(fan_id).set({
          fan_id: fan_id, org_id: org_id,
          loyalty_points: 0, stamps: [], avatar: null,
          created_at: currentUTCTimestamp()
        })
      CATCH ANY as firestoreErr:
        logger.error("Firestore sync failed for new fan", {
          fan_id: fan_id, org_id: org_id, error: firestoreErr.message
        })
        // do NOT throw — Postgres record is committed and valid

    // STEP 5 — query linked systems AFTER commit, outside transaction
    linkedRows = db.query(
      "SELECT DISTINCT source_system FROM identifier_link WHERE fan_id = $1",
      [fan_id]
    )
    linked_systems = linkedRows.map(row => row.source_system)
    linked_count   = linked_systems.length

  CATCH ConflictError:
    ROLLBACK TRANSACTION
    THROW ConflictError("record_version conflict — concurrent write")

  CATCH ANY error as err:
    ROLLBACK TRANSACTION IF ACTIVE
    TRY:
      db.query(
        "INSERT INTO audit_log (id, org_id, event_type, identifier_type,
         idempotency_key, status, error_detail, created_at)
         VALUES ($1,$2,'resolution',$3,$4,'error',$5,NOW())",
        [generateUUID(), org_id, identifier_type, idempotency_key, err.message]
      )
    CATCH:
      logger.error("audit log write failed", { org_id, identifier_type, error: err.message })
    THROW ResolverError("resolver failure: " + err.message)

// RETURN
  RETURN { fan_id, match_type, confidence_score, is_new_record,
           linked_systems, linked_count, audit_event_id }
```

---

## COMPONENT 5 — GET /health

File: src/routes/health.js
No auth. No normalizer. No JWT. Must respond under 200ms.
Rule: Never throw. Always return structured JSON even when every check fails.

```
HANDLER GET /health (request, response):

  results = { db: "disconnected", queue_depth: 0, error_rate_5m: 0.0, timestamp: currentUTCTimestamp() }

  TRY:
    db.query("SELECT 1")
    results.db = "connected"
  CATCH err:
    results.db = "disconnected"
    logger.error("health check db probe failed", { error: err.message })

  TRY:
    results.queue_depth = db.query("SELECT COUNT(*) FROM ingest_failures WHERE status = 'pending'")
  CATCH: // stays 0

  TRY:
    total  = db.query("SELECT COUNT(*) FROM audit_log WHERE created_at > NOW() - INTERVAL '5 minutes'")
    errors = db.query("SELECT COUNT(*) FROM audit_log WHERE created_at > NOW() - INTERVAL '5 minutes' AND status = 'error'")
    IF total > 0: results.error_rate_5m = errors / total
  CATCH: // stays 0.0

  isHealthy = (results.db == "connected" AND results.queue_depth < 10000 AND results.error_rate_5m < 0.01)

  RETURN response.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? "ok" : "degraded",
    db: results.db, queue_depth: results.queue_depth,
    error_rate_5m: results.error_rate_5m, timestamp: results.timestamp
  })
```

---

## COMPONENT 6 — orgAuthMiddleware

File: src/middleware/orgAuthMiddleware.js
TRY/CATCH: Pattern 1 — TRY wraps EXECUTE only
No writes. No audit event. Auth failures go to structured log only.

```
FUNCTION orgAuthMiddleware(request, response, next):
  authHeader = request.headers["authorization"]

// GUARD — in-memory only
  IF authHeader is null OR empty:
    RETURN 401 { error: "unauthorized", message: "Authorization header is missing" }
  IF not starts with "Bearer ":
    RETURN 401 { error: "unauthorized", message: "must use Bearer scheme" }
  rawKey = authHeader.removePrefix("Bearer ").trim()
  IF rawKey is empty:
    RETURN 401 { error: "unauthorized", message: "Bearer token is empty" }
  IF rawKey.length > 512:
    RETURN 401 { error: "unauthorized", message: "invalid credentials" }

// EXECUTE
  TRY:
    hashedKey = sha256(rawKey)
    org = db.query(
      "SELECT id, name, is_active FROM org WHERE org_api_key_hash = $1",
      [hashedKey]
    )
    IF org is null:
      logger.warn("org auth failed — key not found", { ip: request.ip })
      RETURN 401 { error: "unauthorized", message: "invalid credentials" }
    IF org.is_active == false:
      logger.warn("org auth failed — org inactive", { org_id: org.id, ip: request.ip })
      RETURN 403 { error: "forbidden", message: "org account is inactive" }

    request.context = { org_id: org.id, org_name: org.name }
    next()

  CATCH ANY error as err:
    logger.error("org auth db failure", { error: err.message, ip: request.ip })
    RETURN 500 { error: "internal error", message: "authentication could not be completed" }
```

---

## COMPONENT 7 — correlationIdMiddleware

File: src/middleware/correlationIdMiddleware.js
TRY/CATCH: Pattern 1 — TRY wraps EXECUTE only
No db calls. No writes. No audit event.

```
FUNCTION correlationIdMiddleware(request, response, next):

// GUARD — none needed, this middleware generates its own input

// EXECUTE
  TRY:
    correlationId = generateUUID()
    request.context.correlation_id = correlationId
    response.setHeader("X-Correlation-Id", correlationId)
    next()
  CATCH ANY error as err:
    logger.error("correlationId middleware failure", { error: err.message })
    RETURN 500 { error: "internal error", message: "request could not be initialized" }
```

---

## COMPONENT 8 — jwtMiddleware

File: src/middleware/jwtMiddleware.js
See jwt.js pseudocode above — jwtMiddleware is defined inside jwt.js.
Position: Fourth in stack — after correlationId, before handler.

---

## COMPONENT 9 — POST /v1/resolve

File: src/routes/resolve.js
Imports: normalizeIdentifier, resolverEngine

```
HANDLER POST /v1/resolve (request, response):
  body             = request.body
  identifier_type  = body.identifier_type
  identifier_value = body.identifier_value
  org_id           = body.org_id
  schema_version   = body.schema_version
  source_system    = body.source_system OR "unknown"

// GUARD — no db calls
  IF identifier_type is null OR empty:  RETURN 400 { error: "identifier_type is required" }
  IF identifier_value is null OR empty: RETURN 400 { error: "identifier_value is required" }
  IF org_id is null OR not UUID:        RETURN 400 { error: "org_id must be a valid UUID" }
  IF schema_version is null OR empty:   RETURN 400 { error: "schema_version is required" }

  TRY:
    normalized_value = normalizeIdentifier(identifier_type, identifier_value)
  CATCH NormalizationError as err:
    RETURN 400 { error: "identifier_value failed normalization", detail: err.message }

  idempotency_key = sha256(identifier_type + "|" + normalized_value + "|" + org_id)

// EXECUTE
  TRY:
    result = resolverEngine({
      identifier_type, identifier_value: normalized_value,
      org_id, schema_version, idempotency_key, source_system
    })
  CATCH ConflictError:
    RETURN 409 { error: "concurrent write conflict — retry request" }
  CATCH ResolverError as err:
    logger.error("resolver engine failure", { error: err.message, org_id })
    RETURN 500 { error: "resolver internal error" }

// RETURN
  RETURN 200 {
    fan_id, match_type, confidence_score, is_new_record,
    linked_systems, linked_count, audit_event_id
  }
```

---

## COMPONENT 10 — POST /v1/ingest/nfc

File: src/routes/nfc.js
TRY/CATCH: Pattern 3 — multiple blocks, different DLQ reason codes

```
HANDLER POST /v1/ingest/nfc (request, response):
  body           = request.body
  nfc_uid        = body.nfc_uid
  org_id         = body.org_id
  station_id     = body.station_id
  schema_version = body.schema_version
  tapped_at      = body.tapped_at OR currentUTCTimestamp()

// GUARD
  IF nfc_uid is null OR empty:         RETURN 400 { error: "nfc_uid is required" }
  IF org_id not valid UUID:            RETURN 400 { error: "org_id must be a valid UUID" }
  IF station_id is null OR empty:      RETURN 400 { error: "station_id is required" }
  IF station_id.length > 128:          RETURN 400 { error: "station_id exceeds max length" }
  IF schema_version is null OR empty:  RETURN 400 { error: "schema_version is required" }

  // TRY/CATCH 1 — normalization failure
  TRY:
    normalized_uid = normalizeIdentifier("nfc_uid", nfc_uid)
  CATCH NormalizationError as err:
    TRY:
      db.query("INSERT INTO ingest_failures (id, org_id, source_system, raw_payload,
               reason_code, error_detail, created_at)
               VALUES ($1,$2,'nfc',$3,'normalization_error',$4,NOW())",
        [generateUUID(), org_id, JSON.stringify(body), err.message])
    CATCH: logger.error("DLQ write failed after normalization error", { org_id, station_id })
    RETURN 400 { error: "nfc_uid failed normalization", detail: err.message }

  // tapped_at excluded — hardware clock skew breaks idempotency on retry
  idempotency_key = sha256(normalized_uid + "|" + org_id + "|" + station_id)

  // TRY/CATCH 2 — resolver failure
  TRY:
    result = resolverEngine({
      identifier_type: "nfc_uid", identifier_value: normalized_uid,
      org_id, schema_version, idempotency_key, source_system: "nfc"
    })
  CATCH ConflictError:
    RETURN 409 { error: "concurrent write conflict — retry tap" }
  CATCH ResolverError as err:
    TRY:
      db.query("INSERT INTO ingest_failures (id, org_id, source_system, raw_payload,
               reason_code, error_detail, created_at)
               VALUES ($1,$2,'nfc',$3,'resolver_error',$4,NOW())",
        [generateUUID(), org_id, JSON.stringify(body), err.message])
    CATCH: logger.error("DLQ write failed after resolver error", { org_id, station_id })
    RETURN 500 { error: "resolver internal error" }

// RETURN
  RETURN 200 {
    fan_id, match_type, confidence_score, is_new_record,
    audit_event_id, session_ready: true
  }
```

---

## COMPONENT 11 — POST /v1/session

File: src/routes/session.js
TRY/CATCH: Pattern 1 — TRY wraps EXECUTE only

```
HANDLER POST /v1/session (request, response):
  body           = request.body
  fan_id         = body.fan_id
  org_id         = body.org_id
  schema_version = body.schema_version

// GUARD — in-memory only
  IF fan_id is null OR empty:         RETURN 400 { error: "fan_id is required" }
  IF fan_id is not valid UUID:        RETURN 400 { error: "fan_id must be a valid UUID" }
  IF org_id is null OR not UUID:      RETURN 400 { error: "org_id must be a valid UUID" }
  IF schema_version is null OR empty: RETURN 400 { error: "schema_version is required" }

// EXECUTE
  TRY:
    fan = db.query(
      "SELECT id, org_id, stewardship_tier, deleted_at
       FROM fan WHERE id = $1 AND org_id = $2",
      [fan_id, org_id]
    )
    IF fan is null:
      RETURN 404 { error: "fan record not found — resolve identifier first" }
    IF fan.deleted_at is not null:
      RETURN 403 { error: "fan record has been erased — cannot issue session" }

    tokenResult = signToken({ fan_id, org_id })

    db.query(
      "INSERT INTO audit_log (id, fan_id, org_id, event_type,
       schema_version, jti, status, created_at)
       VALUES ($1,$2,$3,'session_issued',$4,$5,'success',NOW())",
      [generateUUID(), fan_id, org_id, schema_version, tokenResult.jti]
    )

  CATCH ANY error as err:
    logger.error("session endpoint failure", { fan_id, org_id, error: err.message })
    RETURN 500 { error: "session could not be issued" }

// RETURN
  RETURN 200 {
    token:      tokenResult.token,
    fan_id:     fan_id,
    expires_at: tokenResult.expires_at,
    token_type: "Bearer"
  }
```

---

## COMPONENT 12 — GET /v1/fan/:id/profile

File: src/routes/profile.js
TRY/CATCH: Pattern 1 — TRY wraps EXECUTE only
Auth: jwtMiddleware required. URL param verified against JWT claim.

```
HANDLER GET /v1/fan/:id/profile (request, response):
  url_fan_id = request.params.id
  jwt_fan_id = request.context.fan_id
  org_id     = request.context.org_id

// GUARD — in-memory only
  IF url_fan_id is null OR empty:  RETURN 400 { error: "fan_id is required" }
  IF url_fan_id is not valid UUID: RETURN 400 { error: "fan_id must be a valid UUID" }
  IF url_fan_id != jwt_fan_id:
    RETURN 403 { error: "forbidden", message: "token does not match requested profile" }

// EXECUTE
  TRY:
    fan = db.query(
      "SELECT id, org_id, stewardship_tier, record_version, created_at, updated_at, deleted_at
       FROM fan WHERE id = $1 AND org_id = $2",
      [jwt_fan_id, org_id]
    )
    IF fan is null:                RETURN 404 { error: "fan record not found" }
    IF fan.deleted_at is not null: RETURN 403 { error: "fan record has been erased" }

    links = db.query(
      "SELECT identifier_type, source_system, confidence_score, first_seen_at, last_seen_at
       FROM identifier_link WHERE fan_id = $1 AND org_id = $2",
      [jwt_fan_id, org_id]
    )

    firestoreDoc = firestore.collection("fans").doc(jwt_fan_id).get()
    walletData = firestoreDoc.exists
      ? firestoreDoc.data()
      : { loyalty_points: 0, stamps: [], avatar: null }

  CATCH ANY error as err:
    logger.error("fan profile fetch failed", {
      error: err.message, fan_id: jwt_fan_id,
      org_id: org_id, correlation_id: request.context.correlation_id
    })
    RETURN 500 { error: "profile could not be retrieved" }

// RETURN
  RETURN 200 {
    fan_id:           fan.id,
    org_id:           fan.org_id,
    stewardship_tier: fan.stewardship_tier,
    record_version:   fan.record_version,
    linked_systems:   links.map(l => ({
                        type:       l.identifier_type,
                        source:     l.source_system,
                        confidence: l.confidence_score,
                        first_seen: l.first_seen_at,
                        last_seen:  l.last_seen_at
                      })),
    wallet: {
      loyalty_points: walletData.loyalty_points,
      stamps:         walletData.stamps,
      avatar:         walletData.avatar
    },
    record_created_at: fan.created_at,
    record_updated_at: fan.updated_at
  }
```

---

# END OF PSEUDOCODE REFERENCE

Last updated: April 2026
migration_001.sql complete. Starting normalizer.js next.
Update build order checkboxes above as each component is completed.
