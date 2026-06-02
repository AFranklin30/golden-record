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
✅ 2   normalizer.js            — complete
✅ 3   jwt.js                   — complete
✅ 4   resolverEngine.js        — complete
✅ 5   GET /health              — complete
✅ 6   orgAuthMiddleware        — complete
✅ 7   correlationIdMiddleware  — complete
✅ 8   jwtMiddleware            — complete
✅ 9   POST /v1/resolve         — complete
✅ 10  POST /v1/ingest/nfc      — complete
✅ 11  POST /v1/session         — complete
✅ 12  GET /v1/fan/:id/profile  — complete
✅ 13  migration_004.sql        — complete (not yet run — blocked on GCP credentials)
✅ 14  probabilisticMatcher.js  — complete
✅ 15  resolverEngine.js update — Paths C and D
✅ 16  resolve.js update        — requires_review + conflict_id in response
✅ 17  nfc.js update            — same response shape as resolve.js
✅ 18  GET /v1/conflicts        — complete
✅ 19  POST /v1/conflicts/:id/confirm — complete
✅ 20  POST /v1/conflicts/:id/reject  — complete
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


---

## New Postgres Table — conflict_queue

Add to migration_004.sql.
Depends on migration_001.sql — fan and org tables must exist.

```sql
CREATE TABLE conflict_queue (
  id                UUID PRIMARY KEY,
  fan_id_a          UUID NOT NULL REFERENCES fan(id),
  fan_id_b          UUID NOT NULL REFERENCES fan(id),
  org_id            UUID NOT NULL REFERENCES org(id),
  confidence_score  NUMERIC(4,3) NOT NULL,
  signals_matched   JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at       TIMESTAMPTZ,
  reviewed_by       TEXT
);

-- status values: pending | confirmed | rejected

CREATE INDEX idx_conflict_queue_org_status
  ON conflict_queue (org_id, status);

CREATE INDEX idx_conflict_queue_fan_a
  ON conflict_queue (fan_id_a);

CREATE INDEX idx_conflict_queue_fan_b
  ON conflict_queue (fan_id_b);
```

---

## COMPONENT 13 — migration_004.sql

File: migrations/migration_004.sql
Depends on: migration_001.sql
Blocks: probabilisticMatcher.js, resolverEngine.js Paths C and D
Status: build in Sprint 2

File header:
-- migration_004.sql
-- Golden Record Fan Identity Platform
-- OKC Thunder — Thunder Innovations Cohort
-- Author: Aaron
-- Sprint 2
-- What this migration does:
-- Creates conflict_queue table for identity decisions
-- requiring human staff review
-- Depends on: migration_001.sql, migration_002.sql, migration_003.sql
-- Blocks: probabilisticMatcher.js build
-- Run after: migration_003.sql

Contents:
CREATE TABLE conflict_queue (...)
CREATE INDEX idx_conflict_queue_org_status ...
CREATE INDEX idx_conflict_queue_fan_a ...
CREATE INDEX idx_conflict_queue_fan_b ...
Verification queries at bottom
Same pattern as migration_001.sql and migration_002.sql

---

## Signal Weights — Constants
SIGNAL_WEIGHTS = {
email_similarity:  0.7,
name_plus_dob:     0.7,
name_plus_zip:     0.6,
device_id:         0.5,
name_alone:        0.3
}
-- email exact match and phone exact match are 1.0
-- They are hard matches handled in resolverEngine.js Path A
-- They never reach probabilisticMatcher.js

---

## Confidence Thresholds — Constants
THRESHOLD_PATH_C  = 0.85  -- above this: high confidence,
--   staff review priority 1
THRESHOLD_PATH_D  = 0.60  -- above this, below Path C:
--   lower confidence,
--   staff review priority 2
-- below this: Path B,
--   no match, new record
-- Placeholder values — Monique confirms before Sprint 2 build

---

## COMPONENT 14 — probabilisticMatcher.js

File: src/modules/probabilisticMatcher.js
Type: Pure function module
Dependencies: none — scoring logic only, no database calls
Called by: resolverEngine.js after hard match returns null
Exports: scoreMatch(candidateRecord, inboundIdentifiers)
FUNCTION scoreMatch(candidateRecord, inboundIdentifiers):
// RECEIVE
candidate       = candidateRecord
inbound         = inboundIdentifiers
score           = 0.0
signals_matched = []
// GUARD
IF candidate is null:
THROW NormalizationError("candidateRecord is required")
IF inbound is null:
THROW NormalizationError("inboundIdentifiers is required")
IF candidate.org_id != inbound.org_id:
THROW NormalizationError("org_id mismatch — cannot score across tenants")
// EXECUTE — take highest signal score, not additive
// Signal 1 — email similarity (fuzzy)
IF inbound.email is not null AND candidate.email is not null:
similarity = levenshteinSimilarity(inbound.email, candidate.email)
IF similarity >= 0.8:
score = MAX(score, SIGNAL_WEIGHTS.email_similarity)
signals_matched.push({
signal:     "email_similarity",
score:      SIGNAL_WEIGHTS.email_similarity,
similarity: similarity
})
// Signal 2 — name + DOB
IF inbound.name is not null AND inbound.dob is not null
AND candidate.name is not null AND candidate.dob is not null:
nameMatch = normalizedNameMatch(inbound.name, candidate.name)
dobMatch  = inbound.dob == candidate.dob
IF nameMatch AND dobMatch:
score = MAX(score, SIGNAL_WEIGHTS.name_plus_dob)
signals_matched.push({
signal: "name_plus_dob",
score:  SIGNAL_WEIGHTS.name_plus_dob
})
// Signal 3 — name + zip
IF inbound.name is not null AND inbound.zip is not null
AND candidate.name is not null AND candidate.zip is not null:
nameMatch = normalizedNameMatch(inbound.name, candidate.name)
zipMatch  = inbound.zip == candidate.zip
IF nameMatch AND zipMatch:
score = MAX(score, SIGNAL_WEIGHTS.name_plus_zip)
signals_matched.push({
signal: "name_plus_zip",
score:  SIGNAL_WEIGHTS.name_plus_zip
})
// Signal 4 — device ID
IF inbound.device_id is not null AND candidate.device_id is not null:
IF inbound.device_id == candidate.device_id:
score = MAX(score, SIGNAL_WEIGHTS.device_id)
signals_matched.push({
signal: "device_id",
score:  SIGNAL_WEIGHTS.device_id
})
// Signal 5 — name alone
IF inbound.name is not null AND candidate.name is not null:
nameMatch = normalizedNameMatch(inbound.name, candidate.name)
IF nameMatch:
score = MAX(score, SIGNAL_WEIGHTS.name_alone)
signals_matched.push({
signal: "name_alone",
score:  SIGNAL_WEIGHTS.name_alone
})
// RETURN
RETURN {
score:           score,
signals_matched: signals_matched
}
FUNCTION levenshteinSimilarity(a, b):
distance  = levenshteinDistance(a, b)
maxLength = MAX(a.length, b.length)
IF maxLength == 0: RETURN 1.0
RETURN 1.0 - (distance / maxLength)
FUNCTION normalizedNameMatch(a, b):
normalizedA = a.trim().toLowerCase()
normalizedB = b.trim().toLowerCase()
RETURN normalizedA == normalizedB
-- nickname matching (Bob vs Robert) is Sprint 3 scope

---

## COMPONENT 15 — resolverEngine.js update

File: src/modules/resolverEngine.js
Change: add Paths C and D after hard match check returns null
        and before Path B new record creation
Do not reload the full resolverEngine pseudocode.
Load only this section.
// After existingLink is null is confirmed
// Before Path B new record creation
// Insert Paths C and D here
IF existingLink is null:
// STEP 1 — find candidates for probabilistic scoring
candidates = db.query(
  "SELECT f.id, f.org_id, il.identifier_type, il.identifier_value
   FROM fan f
   JOIN identifier_link il ON il.fan_id = f.id
   WHERE f.org_id = $1
   AND il.identifier_type IN ('email', 'phone', 'device_id')
   LIMIT 100",
  [org_id]
)
-- LIMIT 100 prevents full table scan on large orgs
-- Sprint 3: replace with indexed similarity search

bestMatch   = null
bestScore   = 0.0
bestSignals = []

// STEP 2 — score each candidate
FOR EACH candidate in candidates:
  result = scoreMatch(candidate, inbound)
  IF result.score > bestScore:
    bestScore   = result.score
    bestMatch   = candidate
    bestSignals = result.signals_matched

// PATH C — high confidence soft match, hold for confirmation
IF bestScore >= THRESHOLD_PATH_C:
  new_fan_id       = generateUUID()
  fan_id           = new_fan_id
  match_type       = "soft"
  confidence_score = bestScore
  is_new_record    = true

  // Create new record — do not link yet
  db.query(
    "INSERT INTO fan (id, org_id, stewardship_tier,
     record_version, created_at, updated_at)
     VALUES ($1,$2,'platform',1,NOW(),NOW())",
    [new_fan_id, org_id]
  )
  db.query(
    "INSERT INTO identifier_link (fan_id, identifier_type,
     identifier_value, org_id, source_system, schema_version,
     confidence_score, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())",
    [new_fan_id, identifier_type, identifier_value, org_id,
     source_system, schema_version, bestScore]
  )

  // Write to conflict_queue — priority 1 (high confidence)
  conflict_id = generateUUID()
  db.query(
    "INSERT INTO conflict_queue (id, fan_id_a, fan_id_b,
     org_id, confidence_score, signals_matched, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW())",
    [conflict_id, bestMatch.id, new_fan_id, org_id,
     bestScore, JSON.stringify(bestSignals)]
  )

// PATH D — lower confidence possible match, hold for confirmation
ELSE IF bestScore >= THRESHOLD_PATH_D:
  new_fan_id       = generateUUID()
  fan_id           = new_fan_id
  match_type       = "conflict"
  confidence_score = bestScore
  is_new_record    = true

  // Create new record — do not link yet
  db.query(
    "INSERT INTO fan (id, org_id, stewardship_tier,
     record_version, created_at, updated_at)
     VALUES ($1,$2,'platform',1,NOW(),NOW())",
    [new_fan_id, org_id]
  )
  db.query(
    "INSERT INTO identifier_link (fan_id, identifier_type,
     identifier_value, org_id, source_system, schema_version,
     confidence_score, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())",
    [new_fan_id, identifier_type, identifier_value, org_id,
     source_system, schema_version, bestScore]
  )

  // Write to conflict_queue — priority 2 (lower confidence)
  conflict_id = generateUUID()
  db.query(
    "INSERT INTO conflict_queue (id, fan_id_a, fan_id_b,
     org_id, confidence_score, signals_matched, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW())",
    [conflict_id, bestMatch.id, new_fan_id, org_id,
     bestScore, JSON.stringify(bestSignals)]
  )

// PATH B — no match, new record
// Score below THRESHOLD_PATH_D or no candidates found
ELSE:
  // existing Path B logic unchanged — do not modify
  ...

---

## COMPONENT 16 — resolve.js update

File: src/routes/resolve.js
Change: add requires_review and conflict_id to RETURN section
Do not reload the full resolve.js pseudocode.
Load only the RETURN section.
// RETURN — updated response shape
// Path A — hard match, existing fan
IF match_type == "hard" AND is_new_record == false:
RETURN 200 {
fan_id:           result.fan_id,
match_type:       "hard",
confidence_score: 1.0,
is_new_record:    false,
requires_review:  false,
conflict_id:      null,
linked_systems:   result.linked_systems,
linked_count:     result.linked_count,
audit_event_id:   result.audit_event_id
}
// Path B — new record, no match
IF match_type == "hard" AND is_new_record == true:
RETURN 200 {
fan_id:           result.fan_id,
match_type:       "hard",
confidence_score: 1.0,
is_new_record:    true,
requires_review:  false,
conflict_id:      null,
linked_systems:   [],
linked_count:     0,
audit_event_id:   result.audit_event_id
}
// Path C — high confidence soft match, held for review
IF match_type == "soft":
RETURN 200 {
fan_id:           result.fan_id,
match_type:       "soft",
confidence_score: result.confidence_score,
is_new_record:    true,
requires_review:  true,
conflict_id:      result.conflict_id,
linked_systems:   [],
linked_count:     0,
audit_event_id:   result.audit_event_id
}
// Path D — lower confidence conflict, held for review
IF match_type == "conflict":
RETURN 200 {
fan_id:           result.fan_id,
match_type:       "conflict",
confidence_score: result.confidence_score,
is_new_record:    true,
requires_review:  true,
conflict_id:      result.conflict_id,
linked_systems:   [],
linked_count:     0,
audit_event_id:   result.audit_event_id
}

---

## COMPONENT 17 — nfc.js update

File: src/routes/nfc.js
Change: same response shape update as resolve.js
Apply identical RETURN section from Component 16 above.
Load only nfc.js — do not reload resolve.js.

---

## TRY/CATCH Patterns — Sprint 2
probabilisticMatcher.js     — Pattern 1
Pure function, no database calls
TRY wraps EXECUTE only
resolverEngine.js update    — Pattern 2
Paths C and D added inside
existing outer TRY
No new TRY/CATCH needed
resolve.js update           — Pattern 1
RETURN section changes only
No new TRY/CATCH needed
nfc.js update               — Pattern 1
RETURN section changes only
No new TRY/CATCH needed

---

## EXECUTE Dependency Order — Sprint 2

Same rule as Sprint 1 — never deviate:

| Step | What runs                              | Why                              |
|------|----------------------------------------|----------------------------------|
| 1    | scoreMatch (probabilisticMatcher.js)   | Score before any database write  |
| 2    | Database reads (candidate query)       | Read before write                |
| 3    | Database writes (fan, identifier_link, | Inside transaction               |
|      | conflict_queue)                        |                                  |
| 4    | Audit event                            | Always last write in transaction |

---

## Migration Dependency Map — Full Picture
migration_001  ✅  foundation — all five core tables
migration_002  ✅  jti unique index on audit_log
migration_003  ⬜  RLS + audit trigger
written, not run — blocked on GCP credentials
run before any second org is onboarded
migration_004  ✅  conflict_queue table — Sprint 2
run after migration_003
migration_005  ⬜  household schema — Sprint 3-4
org key table  ⬜  post-midpoint — Sprint 5 or later

Warning: migration_003 not yet run locally or on Cloud SQL.
Run migration_003 before migration_004 when GCP credentials arrive.

---

# END SPRINT 2 PSEUDOCODE REFERENCE

Last updated: May 2026
Path C updated — hold for confirmation, no auto-link at any threshold
Key management deferred — post-midpoint, Monique confirmed
Confidence thresholds are placeholders — Monique confirms before build
Pub/Sub async pipeline — Sprint 6 bulk processing and Sprint 7 erasure

Paste this at the bottom of .claude/CLAUDE.md after the Sprint 1 pseudocode section.
Then update the build order checkboxes at the top of the file — all 12 Sprint 1 components marked ✅, Sprint 2 components as ⬜ 13 through ⬜ 17.

## COMPONENT 18 — GET /v1/conflicts

File: src/routes/conflicts.js
Auth: orgAuthMiddleware required
TRY/CATCH: Pattern 1 — TRY wraps EXECUTE only
Purpose: returns paginated list of conflict_queue records
         filtered by status for King's staff dashboard
         ordered by confidence_score descending —
         highest confidence reviews appear first
HANDLER GET /v1/conflicts (request, response):
// RECEIVE
org_id  = request.context.org_id
status  = request.query.status  OR "pending"
limit   = request.query.limit   OR 50
offset  = request.query.offset  OR 0
// GUARD
ALLOWED_STATUSES = ["pending", "confirmed", "rejected"]
IF status not in ALLOWED_STATUSES:
RETURN 400 {
error: "invalid status",
message: "status must be one of: pending, confirmed, rejected"
}
IF limit > 100:
RETURN 400 {
error: "limit exceeds maximum",
message: "limit cannot exceed 100"
}
IF limit < 1:
RETURN 400 {
error: "invalid limit",
message: "limit must be at least 1"
}
IF offset < 0:
RETURN 400 {
error: "invalid offset",
message: "offset cannot be negative"
}
// EXECUTE
TRY:
// READ 1 — fetch conflicts for this org filtered by status
conflicts = db.query(
"SELECT id, fan_id_a, fan_id_b, org_id,
confidence_score, signals_matched,
status, created_at, reviewed_at
FROM conflict_queue
WHERE org_id = $1
AND status = $2
ORDER BY confidence_score DESC
LIMIT $3 OFFSET $4",
[org_id, status, limit, offset]
)
// READ 2 — total count for pagination
total = db.query(
  "SELECT COUNT(*) FROM conflict_queue
   WHERE org_id = $1 AND status = $2",
  [org_id, status]
)
CATCH ANY error as err:
logger.error("conflict list fetch failed", {
error:          err.message,
org_id:         org_id,
correlation_id: request.context.correlation_id
})
RETURN 500 { error: "conflict queue could not be retrieved" }
// RETURN
RETURN 200 {
conflicts: conflicts.map(c => ({
conflict_id:      c.id,
fan_id_a:         c.fan_id_a,
fan_id_b:         c.fan_id_b,
confidence_score: c.confidence_score,
signals_matched:  c.signals_matched,
status:           c.status,
created_at:       c.created_at,
reviewed_at:      c.reviewed_at
})),
total:         total,
status_filter: status,
limit:         limit,
offset:        offset
}

---

## COMPONENT 19 — POST /v1/conflicts/:id/confirm

File: src/routes/conflicts.js
Auth: orgAuthMiddleware required
TRY/CATCH: Pattern 1 — TRY wraps EXECUTE only
Purpose: staff confirms two fan records are the same person
         moves fan_id_b identifiers to fan_id_a
         soft deletes fan_id_b
         closes conflict_queue row as confirmed
HANDLER POST /v1/conflicts/:id/confirm (request, response):
// RECEIVE
conflict_id = request.params.id
org_id      = request.context.org_id
// GUARD
IF conflict_id is null OR empty:
RETURN 400 { error: "conflict_id is required" }
IF conflict_id is not valid UUID:
RETURN 400 { error: "conflict_id must be a valid UUID" }
// EXECUTE
TRY:
// READ — verify conflict exists, belongs to org, is pending
conflict = db.query(
"SELECT id, fan_id_a, fan_id_b, org_id, status
FROM conflict_queue
WHERE id = $1 AND org_id = $2",
[conflict_id, org_id]
)
IF conflict is null:
RETURN 404 { error: "conflict not found" }
IF conflict.status != 'pending':
RETURN 409 { error: "conflict already resolved" }
BEGIN TRANSACTION:

  // STEP 1 — move fan_id_b identifiers to fan_id_a
  db.query(
    "UPDATE identifier_link
     SET fan_id = $1
     WHERE fan_id = $2 AND org_id = $3",
    [conflict.fan_id_a, conflict.fan_id_b, org_id]
  )

  // STEP 2 — soft delete fan_id_b — merged, no longer needed
  db.query(
    "UPDATE fan
     SET deleted_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND org_id = $2",
    [conflict.fan_id_b, org_id]
  )

  // STEP 3 — close conflict as confirmed
  db.query(
    "UPDATE conflict_queue
     SET status = 'confirmed', reviewed_at = NOW()
     WHERE id = $1",
    [conflict_id]
  )

  // STEP 4 — audit event — always last write in transaction
  db.query(
    "INSERT INTO audit_log (id, fan_id, org_id,
     event_type, status, created_at)
     VALUES ($1,$2,$3,'conflict_confirmed','success',NOW())",
    [generateUUID(), conflict.fan_id_a, org_id]
  )

COMMIT TRANSACTION
CATCH ANY error as err:
logger.error("conflict confirm failed", {
error:          err.message,
conflict_id:    conflict_id,
org_id:         org_id,
correlation_id: request.context.correlation_id
})
RETURN 500 { error: "conflict could not be confirmed" }
// RETURN
RETURN 200 {
conflict_id: conflict_id,
status:      "confirmed",
merged_into: conflict.fan_id_a,
resolved_at: currentUTCTimestamp()
}

---

## COMPONENT 20 — POST /v1/conflicts/:id/reject

File: src/routes/conflicts.js
Auth: orgAuthMiddleware required
TRY/CATCH: Pattern 1 — TRY wraps EXECUTE only
Purpose: staff confirms two fan records are different people
         both records stay separate — no merge
         closes conflict_queue row as rejected
HANDLER POST /v1/conflicts/:id/reject (request, response):
// RECEIVE
conflict_id = request.params.id
org_id      = request.context.org_id
// GUARD
IF conflict_id is null OR empty:
RETURN 400 { error: "conflict_id is required" }
IF conflict_id is not valid UUID:
RETURN 400 { error: "conflict_id must be a valid UUID" }
// EXECUTE
TRY:
// READ — verify conflict exists, belongs to org, is pending
conflict = db.query(
"SELECT id, fan_id_a, fan_id_b, org_id, status
FROM conflict_queue
WHERE id = $1 AND org_id = $2",
[conflict_id, org_id]
)
IF conflict is null:
RETURN 404 { error: "conflict not found" }
IF conflict.status != 'pending':
RETURN 409 { error: "conflict already resolved" }
BEGIN TRANSACTION:

  // STEP 1 — close conflict as rejected
  // Both fan records stay separate — no identifier moves
  // No soft delete — fan_id_b is a real separate person
  db.query(
    "UPDATE conflict_queue
     SET status = 'rejected', reviewed_at = NOW()
     WHERE id = $1",
    [conflict_id]
  )

  // STEP 2 — audit event — always last write in transaction
  db.query(
    "INSERT INTO audit_log (id, fan_id, org_id,
     event_type, status, created_at)
     VALUES ($1,$2,$3,'conflict_rejected','success',NOW())",
    [generateUUID(), conflict.fan_id_a, org_id]
  )

COMMIT TRANSACTION
CATCH ANY error as err:
logger.error("conflict reject failed", {
error:          err.message,
conflict_id:    conflict_id,
org_id:         org_id,
correlation_id: request.context.correlation_id
})
RETURN 500 { error: "conflict could not be rejected" }
// RETURN
RETURN 200 {
conflict_id: conflict_id,
status:      "rejected",
resolved_at: currentUTCTimestamp()
}

## Notes for Components 18 19 20

All three handlers live in src/routes/conflicts.js
Build all three in one Claude Code session — tightly coupled

Middleware stack for conflicts.js:
rate limiter
→ orgAuthMiddleware
→ correlationIdMiddleware
→ handler
Note: jwtMiddleware NOT required
Conflict resolution is a staff action not a fan action
Staff authenticate as the org not as a fan
orgAuthMiddleware is sufficient

Pagination on GET /v1/conflicts:
  Default limit 50, maximum 100
  offset based pagination — simple for Sprint 2
  cursor based pagination is Sprint 3 if needed
  King's dashboard should pass limit and offset
  as query parameters

signals_matched is JSONB in Postgres:
  Returned as parsed JSON in the response
  King's dashboard reads it directly
  No transformation needed

Firestore note on confirm:
  When fan_id_b is soft deleted and identifiers
  move to fan_id_a — Firestore wallet for fan_id_b
  becomes orphaned
  Sprint 3 reconciliation job handles Firestore cleanup
  Do not attempt Firestore merge in this endpoint
  Keep it simple — Postgres only

audit_log note:
  conflict_confirmed and conflict_rejected are new
  event_type values
  No schema change needed — event_type is TEXT not enum
  New values work automatically

---

---

## Sprint 2 Status

NOT COMPLETE — do not mark sprint closed

Sprint 2 is complete when:
- Components 18 19 and 20 built and verified
- All tests pass across components 13-20
- Security regression check clean
- tasks/handoff.md updated with sprint closed status

Do not begin Sprint 3 pseudocode or build
until all items above are checked




## Sprint 2 Status

NOT COMPLETE — do not mark sprint closed.

Remaining work:
⬜ 18  POST /v1/conflicts/:id/confirm
⬜ 19  POST /v1/conflicts/:id/reject
⬜ 20  Sprint 2 tests — all components 13-19
⬜ 21  Security regression check — new endpoints only

Sprint 2 is complete when:
- Components 18 and 19 are built and verified
- All tests pass across components 13-19
- Security regression check is clean
- tasks/handoff.md updated with sprint closed status

Do not begin Sprint 3 pseudocode or build work
until all four items above are checked.


## COMPONENT 21 — migration_005.sql

File: migrations/migration_005.sql
Depends on: migration_001.sql, migration_004.sql
Blocks: all Sprint 3 components
Status: build first

```sql
-- migration_005.sql
-- Golden Record Fan Identity Platform
-- OKC Thunder — Thunder Innovations Cohort
-- Author: Aaron
-- Sprint 3
--
-- What this migration does:
-- 1. household table
-- 2. household_member table
-- 3. staging_household_data table
-- 4. merge_history table
-- 5. related_fans table
-- 6. merged_from_fan_id on identifier_link
-- 7. federation_id on fan table (nullable seed)
-- 8. Circular reference trigger on household_member
-- 9. New identifier_types added to CHECK constraint
--    name, dob, zip, guardian_email, guardian_phone
--
-- Depends on: migration_001.sql, migration_004.sql
-- Run after: migration_004.sql
-- Blocks: all Sprint 3 component builds

-- PART 1 — household table
CREATE TABLE household (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES org(id),
  adult_fan_id    UUID NOT NULL REFERENCES fan(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT NOT NULL DEFAULT 'fan'
  -- always fan-initiated — never system-created
);

CREATE INDEX idx_household_org
  ON household (org_id);
CREATE INDEX idx_household_adult
  ON household (adult_fan_id);
CREATE UNIQUE INDEX idx_household_adult_org
  ON household (adult_fan_id, org_id);
  -- one household per adult per org

-- PART 2 — household_member table
CREATE TABLE household_member (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id    UUID NOT NULL REFERENCES household(id),
  adult_fan_id    UUID NOT NULL REFERENCES fan(id),
  minor_fan_id    UUID NOT NULL REFERENCES fan(id),
  org_id          UUID NOT NULL REFERENCES org(id),
  link_type       TEXT NOT NULL DEFAULT 'hard',
  -- hard: adult added in Fan Pass
  -- soft: inferred from external data, never fan-facing
  status          TEXT NOT NULL DEFAULT 'active',
  -- active | severed | aged_up
  dob             DATE,
  -- for aging-up calculation
  aged_up_at      TIMESTAMPTZ,
  aged_up_initiated_by TEXT,
  -- 'fan' | 'guardian' | 'staff'
  claim_token     TEXT,
  claim_token_expires_at TIMESTAMPTZ,
  severed_at      TIMESTAMPTZ,
  severed_by      TEXT,
  -- 'guardian' | 'staff'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_household_member_household
  ON household_member (household_id);
CREATE INDEX idx_household_member_adult
  ON household_member (adult_fan_id);
CREATE INDEX idx_household_member_minor
  ON household_member (minor_fan_id);
CREATE INDEX idx_household_member_link_type
  ON household_member (link_type);
CREATE INDEX idx_household_member_status
  ON household_member (status);
CREATE INDEX idx_household_member_dob
  ON household_member (dob)
  WHERE aged_up_at IS NULL AND status = 'active';
  -- partial index — only active minor profiles
CREATE UNIQUE INDEX idx_household_member_minor_org
  ON household_member (minor_fan_id, org_id)
  WHERE status = 'active';
  -- one active household per minor per org

-- PART 3 — circular reference prevention
CREATE OR REPLACE FUNCTION check_no_circular_household()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM household h
    JOIN household_member hm ON hm.household_id = h.id
    WHERE h.adult_fan_id = NEW.minor_fan_id
    AND hm.minor_fan_id = NEW.adult_fan_id
    AND hm.status = 'active'
  ) THEN
    RAISE EXCEPTION
      'circular household relationship not permitted — '
      'fan % is already a minor under fan %',
      NEW.adult_fan_id, NEW.minor_fan_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_circular_household
  BEFORE INSERT ON household_member
  FOR EACH ROW EXECUTE FUNCTION check_no_circular_household();

-- PART 4 — staging_household_data table
-- Holds probable relationships from bulk data
-- NEVER auto-promotes to fan record
-- Adult confirms in Fan Pass to promote
CREATE TABLE staging_household_data (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adult_fan_id    UUID NOT NULL REFERENCES fan(id),
  org_id          UUID NOT NULL REFERENCES org(id),
  child_name      TEXT NOT NULL,
  child_dob       DATE,
  source          TEXT NOT NULL,
  -- 'youth_camp' | 'rookies_club' | 'bulk_upload'
  raw_data        JSONB NOT NULL,
  -- full original record preserved
  confidence      NUMERIC(4,3),
  -- how confident we are this is a real relationship
  promoted_at     TIMESTAMPTZ,
  -- set when adult confirms in Fan Pass
  promoted_to     UUID REFERENCES fan(id),
  -- the minor_fan_id it was promoted to
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_staging_adult
  ON staging_household_data (adult_fan_id);
CREATE INDEX idx_staging_org
  ON staging_household_data (org_id);
CREATE INDEX idx_staging_unpromoted
  ON staging_household_data (adult_fan_id)
  WHERE promoted_at IS NULL;
  -- partial index — only unpromoted records

-- PART 5 — merge_history table
CREATE TABLE merge_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fan_id_source   UUID NOT NULL REFERENCES fan(id),
  -- fan_id_b — the record that was merged in
  fan_id_target   UUID NOT NULL REFERENCES fan(id),
  -- fan_id_a — the record that absorbed the merge
  org_id          UUID NOT NULL REFERENCES org(id),
  conflict_id     UUID REFERENCES conflict_queue(id),
  merged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  merged_by       TEXT,
  -- staff identifier who confirmed the merge
  reversed_at     TIMESTAMPTZ,
  reversed_by     TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
  -- active | reversed
);

CREATE INDEX idx_merge_history_source
  ON merge_history (fan_id_source);
CREATE INDEX idx_merge_history_target
  ON merge_history (fan_id_target);
CREATE INDEX idx_merge_history_conflict
  ON merge_history (conflict_id);
CREATE INDEX idx_merge_history_org_status
  ON merge_history (org_id, status);

-- PART 6 — related_fans table
-- Written on aging-up and unmerge completion
-- Staff queryable — no fan-facing endpoint yet
-- Sprint 5+ for fan-facing related view
CREATE TABLE related_fans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fan_id_a        UUID NOT NULL REFERENCES fan(id),
  fan_id_b        UUID NOT NULL REFERENCES fan(id),
  org_id          UUID NOT NULL REFERENCES org(id),
  relationship    TEXT NOT NULL,
  -- 'aged_up' | 'unmerged' | 'household_history'
  source          TEXT NOT NULL,
  -- 'household' | 'merge_history' | 'manual'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_related_fans_a
  ON related_fans (fan_id_a);
CREATE INDEX idx_related_fans_b
  ON related_fans (fan_id_b);
CREATE INDEX idx_related_fans_org
  ON related_fans (org_id);

-- PART 7 — add merged_from_fan_id to identifier_link
ALTER TABLE identifier_link
ADD COLUMN merged_from_fan_id UUID REFERENCES fan(id);
-- null on all existing rows — only set during merge confirm

CREATE INDEX idx_identifier_link_merged_from
  ON identifier_link (merged_from_fan_id)
  WHERE merged_from_fan_id IS NOT NULL;
  -- partial index — only merged identifiers

-- PART 8 — add federation_id to fan table
-- nullable — Phase 2 populates this
-- represents cross-org canonical identity
ALTER TABLE fan
ADD COLUMN federation_id UUID;
-- no index yet — Phase 2 adds this when used

-- PART 9 — update identifier_type CHECK constraint
-- Add new identifier types for household and signals
ALTER TABLE identifier_link
DROP CONSTRAINT IF EXISTS identifier_link_type_check;

ALTER TABLE identifier_link
ADD CONSTRAINT identifier_link_type_check
CHECK (identifier_type IN (
  'email',
  'phone',
  'nfc_uid',
  'nba_id',
  'ticketmaster_id',
  'name',
  'dob',
  'zip',
  'guardian_email',
  'guardian_phone'
));

-- VERIFICATION QUERIES
-- Run these after migration to confirm success

-- 1. All new tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN (
  'household',
  'household_member',
  'staging_household_data',
  'merge_history',
  'related_fans'
);
-- Expected: 5 rows

-- 2. New columns on identifier_link
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'identifier_link'
AND column_name = 'merged_from_fan_id';
-- Expected: 1 row

-- 3. federation_id on fan table
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'fan'
AND column_name = 'federation_id';
-- Expected: 1 row

-- 4. Circular reference trigger exists
SELECT trigger_name
FROM information_schema.triggers
WHERE event_object_table = 'household_member';
-- Expected: prevent_circular_household

-- 5. Updated CHECK constraint includes new types
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'identifier_link'::regclass
AND contype = 'c';
-- Expected: guardian_email, guardian_phone,
--           name, dob, zip all present

-- 6. Test circular reference trigger blocks correctly
-- Insert a household and member first
-- Then try to reverse the relationship
-- Expected: ERROR circular household relationship
```

---

## COMPONENT 22 — normalizer.js update

File: src/modules/normalizer.js
Change: add five new identifier types
Load only normalizer.js — do not reload other files
-- Add to ALLOWED_TYPES:
ALLOWED_TYPES = [
"email", "phone", "nfc_uid", "nba_id", "ticketmaster_id",
"name", "dob", "zip", "guardian_email", "guardian_phone"
]
-- Add to EXECUTE routing:
IF identifierType == "name":          RETURN normalizeName(rawValue)
IF identifierType == "dob":           RETURN normalizeDob(rawValue)
IF identifierType == "zip":           RETURN normalizeZip(rawValue)
IF identifierType == "guardian_email": RETURN normalizeEmail(rawValue)
IF identifierType == "guardian_phone": RETURN normalizePhone(rawValue)
-- guardian_email and guardian_phone use existing normalizers
-- no new functions needed for those two
FUNCTION normalizeName(value):
// GUARD
normalized = value.trim().toLowerCase()
IF normalized is empty:
THROW NormalizationError("name cannot be blank")
IF normalized.length > 256:
THROW NormalizationError("name exceeds max length")
// EXECUTE + RETURN
-- remove extra whitespace between words
RETURN normalized.replace(/\s+/g, ' ')
FUNCTION normalizeDob(value):
// GUARD
IF value does not match YYYY-MM-DD format:
TRY parse as MM/DD/YYYY or DD/MM/YYYY
IF cannot parse:
THROW NormalizationError("dob format invalid: " + value)
parsed = parseDate(value)
IF parsed is in the future:
THROW NormalizationError("dob cannot be in the future")
IF parsed is more than 120 years ago:
THROW NormalizationError("dob is not a valid birth date")
// EXECUTE + RETURN
RETURN parsed.toISO8601DateOnly()
-- always returns YYYY-MM-DD
FUNCTION normalizeZip(value):
// GUARD
stripped = value.trim().replace(/[^0-9]/g, '')
IF stripped.length is not 5:
THROW NormalizationError("zip must be 5 digits: " + value)
// EXECUTE + RETURN
RETURN stripped

---

## COMPONENT 23 — probabilisticMatcher.js update

File: src/modules/probabilisticMatcher.js
Change: activate name/dob/zip signals, add guardian_email,
        add recency staleness multiplier
Load only probabilisticMatcher.js
-- Updated SIGNAL_WEIGHTS:
SIGNAL_WEIGHTS = {
email_similarity:   0.7,
name_plus_dob:      0.7,
name_plus_zip:      0.6,
guardian_email:     0.65,
device_id:          0.5,
name_alone:         0.3
}
-- Recency multiplier constants:
RECENCY_MULTIPLIER = {
within_6_months:  1.0,
within_12_months: 0.8,
within_24_months: 0.5,
older:            0.2
}
FUNCTION getRecencyMultiplier(last_seen_at):
months = monthsBetween(NOW(), last_seen_at)
IF months <= 6:  RETURN 1.0
IF months <= 12: RETURN 0.8
IF months <= 24: RETURN 0.5
RETURN 0.2
FUNCTION scoreMatch(candidateRecord, inboundIdentifiers):
// RECEIVE
candidate       = candidateRecord
inbound         = inboundIdentifiers
score           = 0.0
signals_matched = []
// GUARD
IF candidate is null:
THROW NormalizationError("candidateRecord is required")
IF inbound is null:
THROW NormalizationError("inboundIdentifiers is required")
IF candidate.org_id != inbound.org_id:
THROW NormalizationError("org_id mismatch — cannot score across tenants")
// EXECUTE — take highest signal score with recency weighting
// Signal 1 — email similarity (existing)
IF inbound.email is not null AND candidate.email is not null:
similarity = levenshteinSimilarity(inbound.email, candidate.email)
IF similarity >= 0.8:
recency = getRecencyMultiplier(candidate.email_last_seen_at)
adjusted = SIGNAL_WEIGHTS.email_similarity * recency
score = MAX(score, adjusted)
signals_matched.push({
signal: "email_similarity",
raw_score: SIGNAL_WEIGHTS.email_similarity,
recency_multiplier: recency,
adjusted_score: adjusted,
similarity: similarity
})
// Signal 2 — name + DOB (now active)
IF inbound.name is not null AND inbound.dob is not null
AND candidate.name is not null AND candidate.dob is not null:
nameMatch = normalizedNameMatch(inbound.name, candidate.name)
dobMatch  = inbound.dob == candidate.dob
IF nameMatch AND dobMatch:
recency = getRecencyMultiplier(candidate.name_last_seen_at)
adjusted = SIGNAL_WEIGHTS.name_plus_dob * recency
score = MAX(score, adjusted)
signals_matched.push({
signal: "name_plus_dob",
raw_score: SIGNAL_WEIGHTS.name_plus_dob,
recency_multiplier: recency,
adjusted_score: adjusted
})
// Signal 3 — name + zip (now active)
IF inbound.name is not null AND inbound.zip is not null
AND candidate.name is not null AND candidate.zip is not null:
nameMatch = normalizedNameMatch(inbound.name, candidate.name)
zipMatch  = inbound.zip == candidate.zip
IF nameMatch AND zipMatch:
recency = getRecencyMultiplier(candidate.name_last_seen_at)
adjusted = SIGNAL_WEIGHTS.name_plus_zip * recency
score = MAX(score, adjusted)
signals_matched.push({
signal: "name_plus_zip",
raw_score: SIGNAL_WEIGHTS.name_plus_zip,
recency_multiplier: recency,
adjusted_score: adjusted
})
// Signal 4 — guardian email (new)
// Used for household soft link detection only
// Not a fan identity signal — a relationship signal
IF inbound.guardian_email is not null
AND candidate.guardian_email is not null:
IF inbound.guardian_email == candidate.guardian_email:
recency = getRecencyMultiplier(candidate.guardian_email_last_seen_at)
adjusted = SIGNAL_WEIGHTS.guardian_email * recency
score = MAX(score, adjusted)
signals_matched.push({
signal: "guardian_email",
raw_score: SIGNAL_WEIGHTS.guardian_email,
recency_multiplier: recency,
adjusted_score: adjusted
})
// Signal 5 — device ID (existing)
IF inbound.device_id is not null AND candidate.device_id is not null:
IF inbound.device_id == candidate.device_id:
recency = getRecencyMultiplier(candidate.device_last_seen_at)
adjusted = SIGNAL_WEIGHTS.device_id * recency
score = MAX(score, adjusted)
signals_matched.push({
signal: "device_id",
raw_score: SIGNAL_WEIGHTS.device_id,
recency_multiplier: recency,
adjusted_score: adjusted
})
// Signal 6 — name alone (now active)
IF inbound.name is not null AND candidate.name is not null:
nameMatch = normalizedNameMatch(inbound.name, candidate.name)
IF nameMatch:
recency = getRecencyMultiplier(candidate.name_last_seen_at)
adjusted = SIGNAL_WEIGHTS.name_alone * recency
score = MAX(score, adjusted)
signals_matched.push({
signal: "name_alone",
raw_score: SIGNAL_WEIGHTS.name_alone,
recency_multiplier: recency,
adjusted_score: adjusted
})
// RETURN
RETURN {
score:           score,
signals_matched: signals_matched
}

---

## COMPONENT 24 — resolverEngine.js update

File: src/modules/resolverEngine.js
Change: add soft link detection for household
        after probabilistic scoring completes
        write to staging_household_data if
        guardian_email signal fired
Load only resolverEngine.js
-- After probabilistic scoring loop completes
-- Before Path C / Path D / Path B decision
-- Add soft link detection:
// SOFT LINK DETECTION
// If guardian_email signal fired in scoring
// record probable household relationship
// in staging_household_data
// NEVER create a child fan record here
// NEVER show this to the fan
guardianEmailSignal = bestSignals.find(
s => s.signal == "guardian_email"
)
IF guardianEmailSignal is not null:
TRY:
db.query(
"INSERT INTO staging_household_data
(id, adult_fan_id, org_id, child_name,
child_dob, source, raw_data, confidence, created_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
ON CONFLICT DO NOTHING",
[generateUUID(), bestMatch.id, org_id,
inbound.name, inbound.dob,
source_system,
JSON.stringify(inbound),
guardianEmailSignal.adjusted_score]
)
CATCH ANY as stagingErr:
-- Non-fatal — log and continue
-- Soft link staging failure never blocks resolution
logger.warn("soft link staging failed", {
error: stagingErr.message,
org_id: org_id
})
-- Continue to Path C / Path D / Path B as normal

---

## COMPONENT 25 — conflicts.js update

File: src/routes/conflicts.js
Change: update confirm endpoint to track
        merged_from_fan_id and write to merge_history
Load only conflicts.js
-- Inside POST /v1/conflicts/:id/confirm
-- Add to BEGIN TRANSACTION block
-- After STEP 1 (move identifiers):
  // STEP 1 — move fan_id_b identifiers to fan_id_a
  //          AND track provenance for unmerge
  db.query(
    "UPDATE identifier_link
     SET fan_id = $1,
         merged_from_fan_id = $2
     WHERE fan_id = $2 AND org_id = $3",
    [conflict.fan_id_a, conflict.fan_id_b, org_id]
  )

  // After STEP 3 (close conflict)
  // Add STEP 3B — write to merge_history

  // STEP 3B — write merge_history record
  db.query(
    "INSERT INTO merge_history
     (id, fan_id_source, fan_id_target, org_id,
      conflict_id, merged_by, status, merged_at)
     VALUES ($1,$2,$3,$4,$5,$6,'active',NOW())",
    [generateUUID(), conflict.fan_id_b,
     conflict.fan_id_a, org_id,
     conflict_id, request.context.org_name]
  )

  // STEP 4 — audit event — always last write
  -- unchanged

---

## COMPONENT 26 — POST /v1/conflicts/:id/unmerge

File: src/routes/conflicts.js
Auth: orgAuthMiddleware required
TRY/CATCH: Pattern 1 — TRY wraps EXECUTE only
Purpose: reverse a confirmed merge
         moves identifiers back using merged_from_fan_id
         reactivates fan_id_source
         writes to related_fans
         updates merge_history status
HANDLER POST /v1/conflicts/:id/unmerge (request, response):
// RECEIVE
conflict_id = request.params.id
org_id      = request.context.org_id
// GUARD
IF conflict_id is null OR empty:
RETURN 400 { error: "conflict_id is required" }
IF conflict_id is not valid UUID:
RETURN 400 { error: "conflict_id must be a valid UUID" }
// EXECUTE
TRY:
// READ 1 — verify conflict exists and was confirmed
conflict = db.query(
"SELECT id, fan_id_a, fan_id_b, org_id, status
FROM conflict_queue
WHERE id = $1 AND org_id = $2",
[conflict_id, org_id]
)
IF conflict is null:
RETURN 404 { error: "conflict not found" }
IF conflict.status != 'confirmed':
RETURN 409 {
error: "conflict is not confirmed",
message: "only confirmed merges can be reversed"
}
// READ 2 — find merge_history record
mergeRecord = db.query(
  "SELECT id, fan_id_source, fan_id_target, status
   FROM merge_history
   WHERE conflict_id = $1 AND org_id = $2
   AND status = 'active'",
  [conflict_id, org_id]
)
IF mergeRecord is null:
  RETURN 404 {
    error: "merge history not found",
    message: "this merge cannot be reversed"
  }

BEGIN TRANSACTION:

  // STEP 1 — move identifiers back to fan_id_source
  //          using merged_from_fan_id provenance
  db.query(
    "UPDATE identifier_link
     SET fan_id = merged_from_fan_id,
         merged_from_fan_id = NULL
     WHERE fan_id = $1
     AND merged_from_fan_id = $2
     AND org_id = $3",
    [mergeRecord.fan_id_target,
     mergeRecord.fan_id_source, org_id]
  )

  // STEP 2 — reactivate fan_id_source
  db.query(
    "UPDATE fan
     SET deleted_at = NULL,
         updated_at = NOW()
     WHERE id = $1 AND org_id = $2",
    [mergeRecord.fan_id_source, org_id]
  )

  // STEP 3 — update conflict_queue status
  db.query(
    "UPDATE conflict_queue
     SET status = 'unmerged',
         reviewed_at = NOW()
     WHERE id = $1",
    [conflict_id]
  )

  // STEP 4 — update merge_history status
  db.query(
    "UPDATE merge_history
     SET status = 'reversed',
         reversed_at = NOW(),
         reversed_by = $1
     WHERE id = $2",
    [request.context.org_name, mergeRecord.id]
  )

  // STEP 5 — write to related_fans
  // These two fans have a history together
  // even though the merge was reversed
  db.query(
    "INSERT INTO related_fans
     (id, fan_id_a, fan_id_b, org_id,
      relationship, source, created_at)
     VALUES ($1,$2,$3,$4,'unmerged','merge_history',NOW())",
    [generateUUID(), mergeRecord.fan_id_target,
     mergeRecord.fan_id_source, org_id]
  )

  // STEP 6 — audit event — always last write
  db.query(
    "INSERT INTO audit_log
     (id, fan_id, org_id, event_type, status, created_at)
     VALUES ($1,$2,$3,'merge_reversed','success',NOW())",
    [generateUUID(), mergeRecord.fan_id_target, org_id]
  )

COMMIT TRANSACTION
CATCH ANY error as err:
logger.error("unmerge failed", {
error:          err.message,
conflict_id:    conflict_id,
org_id:         org_id,
correlation_id: request.context.correlation_id
})
RETURN 500 { error: "unmerge could not be completed" }
// RETURN
RETURN 200 {
conflict_id:     conflict_id,
status:          "unmerged",
fan_id_restored: mergeRecord.fan_id_source,
fan_id_target:   mergeRecord.fan_id_target,
reversed_at:     currentUTCTimestamp()
}

---

## COMPONENT 27 — POST /v1/household

File: src/routes/household.js
Auth: orgAuthMiddleware + jwtMiddleware
TRY/CATCH: Pattern 1
Purpose: adult creates their household
         one household per adult per org
HANDLER POST /v1/household (request, response):
// RECEIVE
adult_fan_id = request.context.fan_id
org_id       = request.context.org_id
// GUARD — no body needed
-- adult_fan_id comes from JWT — already verified
-- no input to validate
// EXECUTE
TRY:
// CHECK — does household already exist?
existing = db.query(
"SELECT id FROM household
WHERE adult_fan_id = $1 AND org_id = $2",
[adult_fan_id, org_id]
)
IF existing is not null:
RETURN 409 {
error: "household already exists",
household_id: existing.id
}
household_id = generateUUID()
db.query(
  "INSERT INTO household
   (id, org_id, adult_fan_id, created_by, created_at)
   VALUES ($1,$2,$3,'fan',NOW())",
  [household_id, org_id, adult_fan_id]
)

db.query(
  "INSERT INTO audit_log
   (id, fan_id, org_id, event_type, status, created_at)
   VALUES ($1,$2,$3,'household_created','success',NOW())",
  [generateUUID(), adult_fan_id, org_id]
)
CATCH ANY error as err:
logger.error("household creation failed", {
error:          err.message,
fan_id:         adult_fan_id,
org_id:         org_id,
correlation_id: request.context.correlation_id
})
RETURN 500 { error: "household could not be created" }
// RETURN
RETURN 201 {
household_id: household_id,
adult_fan_id: adult_fan_id,
created_at:   currentUTCTimestamp()
}

---

## COMPONENT 28 — GET /v1/household/:adult_fan_id

File: src/routes/household.js
Auth: orgAuthMiddleware + jwtMiddleware
TRY/CATCH: Pattern 1
Purpose: get household with children
         adult always first in response
         pagination limit 3 default
HANDLER GET /v1/household/:adult_fan_id (request, response):
// RECEIVE
url_adult_fan_id = request.params.adult_fan_id
jwt_fan_id       = request.context.fan_id
org_id           = request.context.org_id
limit            = request.query.limit  OR 3
offset           = request.query.offset OR 0
// GUARD
IF url_adult_fan_id is null OR not valid UUID:
RETURN 400 { error: "adult_fan_id must be a valid UUID" }
IF url_adult_fan_id != jwt_fan_id:
RETURN 403 {
error: "forbidden",
message: "token does not match requested household"
}
IF limit > 10:
RETURN 400 { error: "limit cannot exceed 10" }
IF offset < 0:
RETURN 400 { error: "offset cannot be negative" }
// EXECUTE
TRY:
// READ 1 — adult fan record
adult = db.query(
"SELECT id, org_id, stewardship_tier,
record_version, created_at
FROM fan WHERE id = $1 AND org_id = $2",
[jwt_fan_id, org_id]
)
IF adult is null:
RETURN 404 { error: "fan record not found" }
// READ 2 — household
household = db.query(
  "SELECT id FROM household
   WHERE adult_fan_id = $1 AND org_id = $2",
  [jwt_fan_id, org_id]
)

IF household is null:
  -- Adult has no household yet
  -- Return adult only, empty children array
  RETURN 200 {
    household_id: null,
    adult: {
      fan_id:   adult.id,
      org_id:   adult.org_id
    },
    children:       [],
    total_children: 0,
    limit:          limit,
    offset:         offset
  }

// READ 3 — children — hard links only
//          soft links never shown to fan
children = db.query(
  "SELECT hm.id as member_id,
          hm.minor_fan_id,
          hm.dob,
          hm.status,
          hm.created_at,
          il_name.identifier_value as name
   FROM household_member hm
   LEFT JOIN identifier_link il_name
     ON il_name.fan_id = hm.minor_fan_id
     AND il_name.identifier_type = 'name'
     AND il_name.org_id = $1
   WHERE hm.household_id = $2
   AND hm.link_type = 'hard'
   AND hm.status = 'active'
   ORDER BY hm.created_at ASC
   LIMIT $3 OFFSET $4",
  [org_id, household.id, limit, offset]
)

// READ 4 — total count
total = db.query(
  "SELECT COUNT(*) FROM household_member
   WHERE household_id = $1
   AND link_type = 'hard'
   AND status = 'active'",
  [household.id]
)
CATCH ANY error as err:
logger.error("household fetch failed", {
error:          err.message,
fan_id:         jwt_fan_id,
org_id:         org_id,
correlation_id: request.context.correlation_id
})
RETURN 500 { error: "household could not be retrieved" }
// RETURN
RETURN 200 {
household_id: household.id,
adult: {
fan_id: adult.id,
org_id: adult.org_id
},
children: children.map(c => ({
member_id:    c.member_id,
fan_id:       c.minor_fan_id,
name:         c.name,
dob:          c.dob,
status:       c.status,
created_at:   c.created_at
})),
total_children: total,
limit:          limit,
offset:         offset
}

---

## COMPONENT 29 — POST /v1/household/:adult_fan_id/members

File: src/routes/household.js
Auth: orgAuthMiddleware + jwtMiddleware
TRY/CATCH: Pattern 1
Purpose: adult adds child — hard link
         creates child fan record
         stores name, dob, guardian_email,
         guardian_phone as identifier_types
         checks staging_household_data for matches
         promotes staged data if match found
HANDLER POST /v1/household/:adult_fan_id/members (request, response):
// RECEIVE
url_adult_fan_id = request.params.adult_fan_id
jwt_fan_id       = request.context.fan_id
org_id           = request.context.org_id
body             = request.body
first_name       = body.first_name
last_name        = body.last_name
dob              = body.dob
guardian_email   = body.guardian_email
guardian_phone   = body.guardian_phone
// GUARD
IF url_adult_fan_id != jwt_fan_id:
RETURN 403 { error: "forbidden" }
IF first_name is null OR empty:
RETURN 400 { error: "first_name is required" }
IF last_name is null OR empty:
RETURN 400 { error: "last_name is required" }
IF dob is null OR empty:
RETURN 400 { error: "dob is required" }
IF guardian_email is null OR empty:
RETURN 400 { error: "guardian_email is required" }
IF guardian_phone is null OR empty:
RETURN 400 { error: "guardian_phone is required" }
TRY:
normalized_name   = normalizeIdentifier("name",
first_name + " " + last_name)
normalized_dob    = normalizeIdentifier("dob", dob)
normalized_email  = normalizeIdentifier("guardian_email",
guardian_email)
normalized_phone  = normalizeIdentifier("guardian_phone",
guardian_phone)
CATCH NormalizationError as err:
RETURN 400 {
error: "validation failed",
detail: err.message
}
// EXECUTE
TRY:
// READ 1 — verify adult exists
adult = db.query(
"SELECT id FROM fan
WHERE id = $1 AND org_id = $2",
[jwt_fan_id, org_id]
)
IF adult is null:
RETURN 404 { error: "adult fan record not found" }
READ 2 — verify household exists
  IF not found → 404
  do NOT auto-create
  component 27 must be called first
// READ 3 — check staging for probable match
staged = db.query(
  "SELECT id, child_name, child_dob, source, raw_data
   FROM staging_household_data
   WHERE adult_fan_id = $1
   AND org_id = $2
   AND promoted_at IS NULL
   AND LOWER(child_name) = $3
   AND child_dob = $4",
  [jwt_fan_id, org_id, normalized_name, normalized_dob]
)
-- staged match found — will promote after fan record created

BEGIN TRANSACTION:

  // STEP 1 — create child fan record
  minor_fan_id = generateUUID()
  db.query(
    "INSERT INTO fan
     (id, org_id, stewardship_tier,
      record_version, created_at, updated_at)
     VALUES ($1,$2,'platform',1,NOW(),NOW())",
    [minor_fan_id, org_id]
  )

  // STEP 2 — store child identifiers
  FOR EACH identifier IN [
    { type: 'name',           value: normalized_name },
    { type: 'dob',            value: normalized_dob },
    { type: 'guardian_email', value: normalized_email },
    { type: 'guardian_phone', value: normalized_phone }
  ]:
    db.query(
      "INSERT INTO identifier_link
       (fan_id, identifier_type, identifier_value,
        org_id, source_system, schema_version,
        confidence_score, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,'fan_pass','1.0',1.0,NOW(),NOW())",
      [minor_fan_id, identifier.type,
       identifier.value, org_id]
    )

  // STEP 3 — create household_member hard link
  db.query(
    "INSERT INTO household_member
     (id, household_id, adult_fan_id, minor_fan_id,
      org_id, link_type, status, dob, created_at)
     VALUES ($1,$2,$3,$4,$5,'hard','active',$6,NOW())",
    [generateUUID(), household_id, jwt_fan_id,
     minor_fan_id, org_id, normalized_dob]
  )

  // STEP 4 — promote staged data if match found
  IF staged is not null:
    db.query(
      "UPDATE staging_household_data
       SET promoted_at = NOW(),
           promoted_to = $1
       WHERE id = $2",
      [minor_fan_id, staged.id]
    )

  // STEP 5 — audit event — always last
  db.query(
    "INSERT INTO audit_log
     (id, fan_id, org_id, event_type, status, created_at)
     VALUES ($1,$2,$3,'child_account_created','success',NOW())",
    [generateUUID(), jwt_fan_id, org_id]
  )

COMMIT TRANSACTION

// STEP 6 — Firestore sync — after commit
// New child fan record needs a wallet document
TRY:
  firestore.collection("fans").doc(minor_fan_id).set({
    fan_id:         minor_fan_id,
    org_id:         org_id,
    loyalty_points: 0,
    stamps:         [],
    avatar:         null,
    created_at:     currentUTCTimestamp()
  })
CATCH ANY as firestoreErr:
  logger.error("Firestore sync failed for child fan", {
    fan_id: minor_fan_id,
    error:  firestoreErr.message
  })
  -- Non-fatal — Postgres commit stands
CATCH ANY error as err:
logger.error("child account creation failed", {
error:          err.message,
fan_id:         jwt_fan_id,
org_id:         org_id,
correlation_id: request.context.correlation_id
})
RETURN 500 { error: "child account could not be created" }
// RETURN
RETURN 201 {
minor_fan_id:    minor_fan_id,
household_id:    household_id,
name:            normalized_name,
dob:             normalized_dob,
staged_match:    staged is not null,
-- tells frontend if camp/rookies data was found and linked
created_at:      currentUTCTimestamp()
}

---

## COMPONENT 30 — GET /v1/household/:adult_fan_id/members/:child_fan_id

File: src/routes/household.js
Auth: orgAuthMiddleware + jwtMiddleware
TRY/CATCH: Pattern 1
Purpose: get child PII detail view
HANDLER GET /v1/household/:adult_fan_id/members/:child_fan_id
(request, response):
// RECEIVE
url_adult_fan_id = request.params.adult_fan_id
child_fan_id     = request.params.child_fan_id
jwt_fan_id       = request.context.fan_id
org_id           = request.context.org_id
// GUARD
IF url_adult_fan_id != jwt_fan_id:
RETURN 403 { error: "forbidden" }
IF child_fan_id is null OR not valid UUID:
RETURN 400 { error: "child_fan_id must be a valid UUID" }
// EXECUTE
TRY:
// Verify child belongs to this adult's household
member = db.query(
"SELECT hm.id, hm.minor_fan_id, hm.dob,
hm.status, hm.created_at
FROM household_member hm
JOIN household h ON h.id = hm.household_id
WHERE hm.minor_fan_id = $1
AND h.adult_fan_id = $2
AND hm.org_id = $3
AND hm.link_type = 'hard'
AND hm.status = 'active'",
[child_fan_id, jwt_fan_id, org_id]
)
IF member is null:
RETURN 404 { error: "child account not found" }
// Get child identifiers
identifiers = db.query(
  "SELECT identifier_type, identifier_value
   FROM identifier_link
   WHERE fan_id = $1 AND org_id = $2
   AND identifier_type IN
     ('name', 'dob', 'guardian_email', 'guardian_phone')",
  [child_fan_id, org_id]
)

-- Map identifiers to named fields
name   = identifiers.find(i => i.type == 'name')?.value
dob    = identifiers.find(i => i.type == 'dob')?.value
email  = identifiers.find(i => i.type == 'guardian_email')?.value
phone  = identifiers.find(i => i.type == 'guardian_phone')?.value
CATCH ANY error as err:
logger.error("child account fetch failed", {
error:          err.message,
fan_id:         jwt_fan_id,
child_fan_id:   child_fan_id,
correlation_id: request.context.correlation_id
})
RETURN 500 { error: "child account could not be retrieved" }
// RETURN
RETURN 200 {
minor_fan_id:    child_fan_id,
name:            name,
dob:             dob,
guardian_email:  email,
guardian_phone:  phone,
status:          member.status,
created_at:      member.created_at
}

---

## COMPONENT 31 — PUT /v1/household/:adult_fan_id/members/:child_fan_id

File: src/routes/household.js
Auth: orgAuthMiddleware + jwtMiddleware
TRY/CATCH: Pattern 1
Purpose: edit child PII
HANDLER PUT /v1/household/:adult_fan_id/members/:child_fan_id
(request, response):
// RECEIVE
url_adult_fan_id = request.params.adult_fan_id
child_fan_id     = request.params.child_fan_id
jwt_fan_id       = request.context.fan_id
org_id           = request.context.org_id
body             = request.body
first_name       = body.first_name
last_name        = body.last_name
dob              = body.dob
guardian_email   = body.guardian_email
guardian_phone   = body.guardian_phone
// GUARD
IF url_adult_fan_id != jwt_fan_id:
RETURN 403 { error: "forbidden" }
IF child_fan_id is null OR not valid UUID:
RETURN 400 { error: "child_fan_id must be a valid UUID" }
-- At least one field must be provided
IF all of first_name, last_name, dob,
guardian_email, guardian_phone are null:
RETURN 400 { error: "at least one field is required" }
TRY:
-- Normalize only fields that were provided
IF first_name OR last_name is provided:
full_name = (first_name OR existing_first) + " " +
(last_name OR existing_last)
normalized_name = normalizeIdentifier("name", full_name)
IF dob is provided:
normalized_dob = normalizeIdentifier("dob", dob)
IF guardian_email is provided:
normalized_email = normalizeIdentifier("guardian_email",
guardian_email)
IF guardian_phone is provided:
normalized_phone = normalizeIdentifier("guardian_phone",
guardian_phone)
CATCH NormalizationError as err:
RETURN 400 { error: "validation failed", detail: err.message }
// EXECUTE
TRY:
// Verify child belongs to this adult
member = db.query(
"SELECT hm.id FROM household_member hm
JOIN household h ON h.id = hm.household_id
WHERE hm.minor_fan_id = $1
AND h.adult_fan_id = $2
AND hm.org_id = $3
AND hm.status = 'active'",
[child_fan_id, jwt_fan_id, org_id]
)
IF member is null:
RETURN 404 { error: "child account not found" }
BEGIN TRANSACTION:

  // Update each provided identifier
  FOR EACH [type, value] IN provided fields:
    db.query(
      "INSERT INTO identifier_link
       (fan_id, identifier_type, identifier_value,
        org_id, source_system, schema_version,
        confidence_score, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,'fan_pass','1.0',1.0,NOW(),NOW())
       ON CONFLICT (fan_id, identifier_type, org_id)
       DO UPDATE SET
         identifier_value = EXCLUDED.identifier_value,
         last_seen_at = NOW()",
      [child_fan_id, type, value, org_id]
    )

  // Update dob on household_member if provided
  IF dob is provided:
    db.query(
      "UPDATE household_member
       SET dob = $1
       WHERE id = $2",
      [normalized_dob, member.id]
    )

  // Audit event — always last
  db.query(
    "INSERT INTO audit_log
     (id, fan_id, org_id, event_type, status, created_at)
     VALUES ($1,$2,$3,'child_account_updated','success',NOW())",
    [generateUUID(), jwt_fan_id, org_id]
  )

COMMIT TRANSACTION
CATCH ANY error as err:
logger.error("child account update failed", {
error:          err.message,
fan_id:         jwt_fan_id,
child_fan_id:   child_fan_id,
correlation_id: request.context.correlation_id
})
RETURN 500 { error: "child account could not be updated" }
// RETURN
RETURN 200 {
minor_fan_id: child_fan_id,
updated_at:   currentUTCTimestamp()
}

---

## COMPONENT 32 — DELETE /v1/household/:adult_fan_id/members/:child_fan_id

File: src/routes/household.js
Auth: orgAuthMiddleware + jwtMiddleware
TRY/CATCH: Pattern 1
Purpose: adult severs child link before age 18
         sets status to severed
         does NOT delete child fan record
         does NOT delete child identifiers
         writes audit event
HANDLER DELETE /v1/household/:adult_fan_id/members/:child_fan_id
(request, response):
// RECEIVE
url_adult_fan_id = request.params.adult_fan_id
child_fan_id     = request.params.child_fan_id
jwt_fan_id       = request.context.fan_id
org_id           = request.context.org_id
// GUARD
IF url_adult_fan_id != jwt_fan_id:
RETURN 403 { error: "forbidden" }
IF child_fan_id is null OR not valid UUID:
RETURN 400 { error: "child_fan_id must be a valid UUID" }
// EXECUTE
TRY:
member = db.query(
"SELECT hm.id, hm.status
FROM household_member hm
JOIN household h ON h.id = hm.household_id
WHERE hm.minor_fan_id = $1
AND h.adult_fan_id = $2
AND hm.org_id = $3",
[child_fan_id, jwt_fan_id, org_id]
)
IF member is null:
RETURN 404 { error: "child account not found" }
IF member.status != 'active':
RETURN 409 { error: "child account is not active" }
BEGIN TRANSACTION:

  db.query(
    "UPDATE household_member
     SET status = 'severed',
         severed_at = NOW(),
         severed_by = 'guardian'
     WHERE id = $1",
    [member.id]
  )

  db.query(
    "INSERT INTO audit_log
     (id, fan_id, org_id, event_type, status, created_at)
     VALUES ($1,$2,$3,'child_link_severed','success',NOW())",
    [generateUUID(), jwt_fan_id, org_id]
  )

COMMIT TRANSACTION
CATCH ANY error as err:
logger.error("child link sever failed", {
error:          err.message,
fan_id:         jwt_fan_id,
child_fan_id:   child_fan_id,
correlation_id: request.context.correlation_id
})
RETURN 500 { error: "child link could not be severed" }
// RETURN
RETURN 200 {
minor_fan_id: child_fan_id,
status:       "severed",
severed_at:   currentUTCTimestamp()
}

---

## COMPONENT 33 — POST /v1/household/:adult_fan_id/members/:child_fan_id/session

File: src/routes/household.js
Auth: orgAuthMiddleware + jwtMiddleware
TRY/CATCH: Pattern 1
Purpose: adult switches to child account
         issues JWT with child fan_id
         8-hour expiry — game length
         acting_as: "child" in claims
         all fan activities write to child record
HANDLER POST /v1/household/:adult_fan_id/members/:child_fan_id/session
(request, response):
// RECEIVE
url_adult_fan_id = request.params.adult_fan_id
child_fan_id     = request.params.child_fan_id
jwt_fan_id       = request.context.fan_id
org_id           = request.context.org_id
// GUARD
IF url_adult_fan_id != jwt_fan_id:
RETURN 403 { error: "forbidden" }
IF child_fan_id is null OR not valid UUID:
RETURN 400 { error: "child_fan_id must be a valid UUID" }
// EXECUTE
TRY:
// Verify child is hard-linked and active
member = db.query(
"SELECT hm.id, hm.minor_fan_id,
hm.household_id, hm.status
FROM household_member hm
JOIN household h ON h.id = hm.household_id
WHERE hm.minor_fan_id = $1
AND h.adult_fan_id = $2
AND hm.org_id = $3
AND hm.link_type = 'hard'
AND hm.status = 'active'",
[child_fan_id, jwt_fan_id, org_id]
)
IF member is null:
RETURN 404 { error: "child account not found" }
// Verify child fan record exists and is not deleted
child = db.query(
  "SELECT id, deleted_at FROM fan
   WHERE id = $1 AND org_id = $2",
  [child_fan_id, org_id]
)
IF child is null:
  RETURN 404 { error: "child fan record not found" }
IF child.deleted_at is not null:
  RETURN 403 { error: "child account has been erased" }

// Issue child JWT — 8-hour expiry
issuedAt  = currentUTCTimestamp()
expiresAt = issuedAt + 8 hours
jti       = generateUUID()

claims = {
  sub:           child_fan_id,
  org:           org_id,
  household_id:  member.household_id,
  acting_as:     "child",
  parent_fan_id: jwt_fan_id,
  iat:           issuedAt,
  exp:           expiresAt,
  jti:           jti
}

token = jwtLibrary.sign(claims, PRIVATE_KEY, algorithm="RS256")

// Audit event
db.query(
  "INSERT INTO audit_log
   (id, fan_id, org_id, event_type,
    schema_version, jti, status, created_at)
   VALUES ($1,$2,$3,'child_session_issued','1.0',$4,'success',NOW())",
  [generateUUID(), child_fan_id, org_id, jti]
)
CATCH ANY error as err:
logger.error("child session failed", {
error:          err.message,
fan_id:         jwt_fan_id,
child_fan_id:   child_fan_id,
correlation_id: request.context.correlation_id
})
RETURN 500 { error: "child session could not be issued" }
// RETURN
RETURN 200 {
token:         token,
fan_id:        child_fan_id,
expires_at:    expiresAt.toISO8601(),
token_type:    "Bearer",
acting_as:     "child",
parent_fan_id: jwt_fan_id
}

---

## COMPONENT 34 — POST /v1/household/:adult_fan_id/members/:child_fan_id/age-up

File: src/routes/household.js
Auth: orgAuthMiddleware + jwtMiddleware
TRY/CATCH: Pattern 1
Purpose: initiate aging-up transition
         generates claim token
         sends email to guardian_email
         sets status to aged_up on household_member
         writes to related_fans
         guardian loses visibility after this call
HANDLER POST /v1/household/:adult_fan_id/members/:child_fan_id/age-up
(request, response):
// RECEIVE
url_adult_fan_id = request.params.adult_fan_id
child_fan_id     = request.params.child_fan_id
jwt_fan_id       = request.context.fan_id
org_id           = request.context.org_id
// GUARD
IF url_adult_fan_id != jwt_fan_id:
RETURN 403 { error: "forbidden" }
IF child_fan_id is null OR not valid UUID:
RETURN 400 { error: "child_fan_id must be a valid UUID" }
// EXECUTE
TRY:
// Verify child is active and hard-linked
member = db.query(
"SELECT hm.id, hm.minor_fan_id,
hm.household_id, hm.dob, hm.status
FROM household_member hm
JOIN household h ON h.id = hm.household_id
WHERE hm.minor_fan_id = $1
AND h.adult_fan_id = $2
AND hm.org_id = $3
AND hm.link_type = 'hard'
AND hm.status = 'active'",
[child_fan_id, jwt_fan_id, org_id]
)
IF member is null:
RETURN 404 { error: "child account not found" }
// Get guardian email for claim notification
guardianEmail = db.query(
  "SELECT identifier_value FROM identifier_link
   WHERE fan_id = $1
   AND identifier_type = 'guardian_email'
   AND org_id = $2
   LIMIT 1",
  [child_fan_id, org_id]
)
IF guardianEmail is null:
  RETURN 422 {
    error: "cannot initiate age-up",
    message: "no guardian email on file for this child account"
  }

// Generate claim token — 30 day expiry
claimToken        = generateSecureRandomString(64)
claimTokenExpiry  = currentUTCTimestamp() + 30 days

BEGIN TRANSACTION:

  // Update household_member status
  db.query(
    "UPDATE household_member
     SET status = 'aged_up',
         aged_up_at = NOW(),
         aged_up_initiated_by = 'guardian',
         claim_token = $1,
         claim_token_expires_at = $2
     WHERE id = $3",
    [claimToken, claimTokenExpiry, member.id]
  )

  // Write to related_fans
  // These two fans have a history together
  db.query(
    "INSERT INTO related_fans
     (id, fan_id_a, fan_id_b, org_id,
      relationship, source, created_at)
     VALUES ($1,$2,$3,$4,'aged_up','household',NOW())",
    [generateUUID(), jwt_fan_id, child_fan_id, org_id]
  )

  // Audit event — always last
  db.query(
    "INSERT INTO audit_log
     (id, fan_id, org_id, event_type, status, created_at)
     VALUES ($1,$2,$3,'age_up_initiated','success',NOW())",
    [generateUUID(), jwt_fan_id, org_id]
  )

COMMIT TRANSACTION

// Send claim email to guardian_email
// After commit — non-fatal if email fails
TRY:
  emailService.send({
    to:      guardianEmail.identifier_value,
    subject: "Fan Pass — Share this link to complete profile transfer",
    body:    "Share this link with your fan to claim their independent profile: " +
             CLAIM_BASE_URL + "/claim/" + claimToken +
             " This link expires in 30 days."
  })
CATCH ANY as emailErr:
  logger.error("age-up claim email failed", {
    child_fan_id: child_fan_id,
    error: emailErr.message
  })
  -- Non-fatal — guardian can request new token
CATCH ANY error as err:
logger.error("age-up initiation failed", {
error:          err.message,
fan_id:         jwt_fan_id,
child_fan_id:   child_fan_id,
correlation_id: request.context.correlation_id
})
RETURN 500 { error: "age-up could not be initiated" }
// RETURN
RETURN 200 {
minor_fan_id:       child_fan_id,
status:             "aged_up",
claim_token_expiry: claimTokenExpiry.toISO8601(),
message:            "Claim link sent to guardian email.
Share it with your fan to complete
their profile transfer."
}

---

## COMPONENT 35 — GET /v1/household/claim/:token

File: src/routes/household.js
Auth: orgAuthMiddleware only
      No jwtMiddleware — child has no JWT yet
TRY/CATCH: Pattern 1
Purpose: child claims their aged-up profile
         authenticates with any known identifier
         profile becomes independent
         household link preserved as related_fans
HANDLER GET /v1/household/claim/:token (request, response):
// RECEIVE
claim_token  = request.params.token
org_id       = request.context.org_id
body         = request.body
-- Child provides one identifier to verify identity
identifier_type  = body.identifier_type
identifier_value = body.identifier_value
// GUARD
IF claim_token is null OR empty:
RETURN 400 { error: "claim token is required" }
IF identifier_type is null OR empty:
RETURN 400 { error: "identifier_type is required" }
IF identifier_value is null OR empty:
RETURN 400 { error: "identifier_value is required" }
TRY:
normalized_value = normalizeIdentifier(
identifier_type, identifier_value
)
CATCH NormalizationError as err:
RETURN 400 { error: "validation failed", detail: err.message }
// EXECUTE
TRY:
// READ 1 — find household_member by claim token
member = db.query(
"SELECT hm.id, hm.minor_fan_id,
hm.household_id, hm.status,
hm.claim_token_expires_at
FROM household_member hm
WHERE hm.claim_token = $1
AND hm.org_id = $2",
[claim_token, org_id]
)
IF member is null:
RETURN 404 { error: "claim token not found or already used" }
IF member.status != 'aged_up':
RETURN 409 { error: "this profile has already been claimed" }
IF member.claim_token_expires_at < currentUTCTimestamp():
RETURN 410 { error: "claim token has expired" }
// READ 2 — verify child owns the presented identifier
link = db.query(
  "SELECT id FROM identifier_link
   WHERE fan_id = $1
   AND identifier_type = $2
   AND identifier_value = $3
   AND org_id = $4",
  [member.minor_fan_id, identifier_type,
   normalized_value, org_id]
)
IF link is null:
  RETURN 403 {
    error: "identifier does not match this profile",
    message: "provide an identifier associated with this account"
  }

BEGIN TRANSACTION:

  // STEP 1 — clear claim token — one time use
  db.query(
    "UPDATE household_member
     SET claim_token = NULL,
         claim_token_expires_at = NULL
     WHERE id = $1",
    [member.id]
  )

  // STEP 2 — fan record is now independent
  // No change needed to fan table
  // household_member status is already 'aged_up'
  // Guardian can no longer see this fan
  // via GET /v1/household/:adult_fan_id

  // STEP 3 — audit event — always last
  db.query(
    "INSERT INTO audit_log
     (id, fan_id, org_id, event_type, status, created_at)
     VALUES ($1,$2,$3,'profile_claimed','success',NOW())",
    [generateUUID(), member.minor_fan_id, org_id]
  )

COMMIT TRANSACTION

// Issue a standard fan JWT for the newly independent fan
tokenResult = signToken({
  fan_id: member.minor_fan_id,
  org_id: org_id
})
CATCH ANY error as err:
logger.error("profile claim failed", {
error:          err.message,
org_id:         org_id,
correlation_id: request.context.correlation_id
})
RETURN 500 { error: "profile could not be claimed" }
// RETURN
RETURN 200 {
fan_id:     member.minor_fan_id,
token:      tokenResult.token,
expires_at: tokenResult.expires_at,
token_type: "Bearer",
message:    "Profile successfully claimed.
Welcome to your independent account."
}

---

## COMPONENT 36 — GET /v1/admin/household/:fan_id

File: src/routes/admin/household.js
Auth: orgAuthMiddleware only — staff endpoint
TRY/CATCH: Pattern 1
Purpose: staff views soft links for a fan
         shows probable household relationships
         from staging_household_data
         never shown in fan-facing frontend
HANDLER GET /v1/admin/household/:fan_id (request, response):
// RECEIVE
fan_id = request.params.fan_id
org_id = request.context.org_id
// GUARD
IF fan_id is null OR not valid UUID:
RETURN 400 { error: "fan_id must be a valid UUID" }
// EXECUTE
TRY:
// READ 1 — confirmed household (hard links)
hardLinks = db.query(
"SELECT hm.minor_fan_id, hm.link_type,
hm.status, hm.dob, hm.created_at,
il.identifier_value as name
FROM household_member hm
JOIN household h ON h.id = hm.household_id
LEFT JOIN identifier_link il
ON il.fan_id = hm.minor_fan_id
AND il.identifier_type = 'name'
AND il.org_id = $1
WHERE h.adult_fan_id = $2
AND hm.org_id = $1",
[org_id, fan_id]
)
// READ 2 — probable relationships (soft links / staging)
softLinks = db.query(
  "SELECT id, child_name, child_dob,
          source, confidence, created_at,
          promoted_at, promoted_to
   FROM staging_household_data
   WHERE adult_fan_id = $1
   AND org_id = $2
   ORDER BY confidence DESC",
  [fan_id, org_id]
)

// READ 3 — related fans (post-household history)
related = db.query(
  "SELECT fan_id_b as related_fan_id,
          relationship, source, created_at
   FROM related_fans
   WHERE fan_id_a = $1 AND org_id = $2
   UNION
   SELECT fan_id_a as related_fan_id,
          relationship, source, created_at
   FROM related_fans
   WHERE fan_id_b = $1 AND org_id = $2",
  [fan_id, org_id]
)
CATCH ANY error as err:
logger.error("admin household fetch failed", {
error:          err.message,
fan_id:         fan_id,
org_id:         org_id,
correlation_id: request.context.correlation_id
})
RETURN 500 { error: "household data could not be retrieved" }
// RETURN
RETURN 200 {
fan_id:     fan_id,
confirmed:  hardLinks.map(h => ({
minor_fan_id: h.minor_fan_id,
name:         h.name,
dob:          h.dob,
link_type:    h.link_type,
status:       h.status,
created_at:   h.created_at
})),
probable:   softLinks.map(s => ({
child_name:   s.child_name,
child_dob:    s.child_dob,
source:       s.source,
confidence:   s.confidence,
promoted:     s.promoted_at is not null,
promoted_to:  s.promoted_to,
created_at:   s.created_at
})),
related:    related.map(r => ({
related_fan_id: r.related_fan_id,
relationship:   r.relationship,
source:         r.source,
created_at:     r.created_at
}))
}

---

## JWT Notes — Sprint 3
Standard fan JWT — unchanged:
sub: fan_id
org: org_id
iat, exp (15 minutes), jti
Child session JWT — new, 8-hour expiry:
sub: child_fan_id
org: org_id
household_id: household_id
acting_as: "child"
parent_fan_id: adult_fan_id
iat, exp (8 hours), jti
jwtMiddleware update needed:
Read acting_as claim
Read parent_fan_id claim
Attach both to request.context
request.context.acting_as
request.context.parent_fan_id
Endpoints that need acting_as awareness:
GET /v1/fan/:id/profile
If acting_as == "child" and url_fan_id == sub
allow access — child viewing own profile
If acting_as == "child" and url_fan_id != sub
check if url_fan_id == parent_fan_id
allow if yes — child viewing parent is blocked
but parent viewing child is allowed via
household session JWT

---

## TRY/CATCH Patterns — Sprint 3
migration_005.sql          — SQL only, no patterns
normalizer.js update       — Pattern 1, pure functions
probabilisticMatcher.js    — Pattern 1, pure functions
resolverEngine.js update   — Pattern 2, existing outer TRY
conflicts.js update        — Pattern 1, existing structure
POST /v1/conflicts/unmerge — Pattern 1
All household endpoints    — Pattern 1
GET /v1/admin/household    — Pattern 1

---

## EXECUTE Dependency Order — Sprint 3

Same rule as always — never deviate:

| Step | What runs | Why |
|------|-----------|-----|
| 1 | Normalize inputs | Before any db call |
| 2 | DB reads — verify | Read before write |
| 3 | DB writes in transaction | All or nothing |
| 4 | Audit event | Always last in transaction |
| 5 | Firestore sync | After commit, non-fatal |
| 6 | Email send | After commit, non-fatal |

---

## Sprint 3 Status

NOT COMPLETE — do not mark sprint closed

Sprint 3 is complete when:
- Components 21-36 built and verified
- All tests pass across components 21-36
- Security regression check clean
- migration_005.sql run on local database
- tasks/handoff.md updated with sprint closed status

Do not begin Sprint 4 pseudocode or build
until all items above are checked

---

# END SPRINT 3 PSEUDOCODE REFERENCE

Last updated: May 2026
Adult-to-child language throughout — not parent-child
Soft links backend only — never fan-facing
Child records created ONLY from Fan Pass — never from bulk data
Staging table holds probable relationships — never auto-promotes
Related fans table tracks post-household history
Unmerge uses merged_from_fan_id — never destroys merge data
Child session JWT — 8 hours — game length
Claim token — 30 days — guardian forwards to child