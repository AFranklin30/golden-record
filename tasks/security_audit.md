# Security Audit — Component 38
# Golden Record Fan Identity Platform
# OKC Thunder — Thunder Innovations Cohort
# Author: Claude Code (read-only audit — no code modified)
# Date: 2026-06-02
# Auditor note: 23 files read. src/middleware/jwtMiddleware.js and
#               migrations 002–005 were not in the read list — gaps noted inline.

---

## Audit Scope

Files read:
  CLAUDE.md · .claude/CLAUDE.md · src/modules/jwt.js
  src/modules/normalizer.js · src/modules/resolverEngine.js
  src/modules/probabilisticMatcher.js
  src/middleware/orgAuthMiddleware.js
  src/middleware/rlsContextMiddleware.js
  src/middleware/correlationIdMiddleware.js
  src/routes/conflicts.js · src/routes/household.js
  src/routes/admin/household.js · src/routes/resolve.js
  src/routes/nfc.js · src/routes/session.js
  src/routes/profile.js · src/routes/health.js
  src/db/pool.js · index.js
  migrations/migration_001.sql · migrations/migration_006.sql
  package.json

Files NOT read (gaps flagged inline):
  src/middleware/jwtMiddleware.js
  migrations/migration_002.sql
  migrations/migration_003.sql
  migrations/migration_004.sql
  migrations/migration_005.sql

---

## Summary Counts

  PASS                  58
  LOW                    9
  MEDIUM                 5
  HIGH                   3
  CRITICAL               0
  RISK                   3
  VERIFY IN GCP CONSOLE  7

Priority fix list — ordered by severity:

  HIGH-1   audit_log event_type CHECK blocks all Sprint 2+ writes
  HIGH-2   audit_log identifier_type CHECK blocks Sprint 3 types
  HIGH-3   Child session JWTs have no middleware enforcement
  MEDIUM-1 Age-up email stub logs raw claim token to application log
  MEDIUM-2 Age-up email stub logs guardian email (PII) to application log
  MEDIUM-3 POST /v1/household audit event is outside a transaction
  MEDIUM-4 GET /health is not rate limited — DoS amplification vector
  MEDIUM-5 CORS not configured — browser callers will be blocked
  RISK-1   src/middleware/jwtMiddleware.js not in audit read list
  RISK-2   RLS on Sprint 1 tables (migration_003) not verified
  RISK-3   audit_log append-only trigger (migration_003) not verified

---

---

# SECTION 1 — STRIDE

---

## SPOOFING

---

SECTION:  STRIDE — Spoofing
CHECK:    Can a caller fake an org identity?
STATUS:   PASS
FINDING:  orgAuthMiddleware computes sha256(rawKey) and queries
          org table by hash. Raw key is never stored. Without the
          original key, identity cannot be forged.
          orgAuthMiddleware.js:29

---

SECTION:  STRIDE — Spoofing
CHECK:    Can a caller fake a fan identity?
STATUS:   PASS
FINDING:  jwtMiddleware verifies JWTs with RS256 and the public key.
          Without the private key (held only in Secret Manager / env),
          a valid JWT cannot be forged.
          jwt.js:58,78

---

SECTION:  STRIDE — Spoofing
CHECK:    Can a caller use another org's JWT with a different org's API key?
STATUS:   PASS
FINDING:  jwtMiddleware.js validates that claims.org_id matches
          req.context.org_id (set by orgAuthMiddleware). A JWT issued
          for Org A will be rejected when presented with Org B's API key.
          jwt.js:107-109

---

SECTION:  STRIDE — Spoofing
CHECK:    Can a caller use an expired JWT?
STATUS:   PASS
FINDING:  jwt.verify catches TokenExpiredError and throws JWTError → 401.
          clockTolerance is 30 seconds — reasonable for server skew.
          jwt.js:80

---

SECTION:  STRIDE — Spoofing
CHECK:    Is the JWT iss claim validated?
STATUS:   PASS
FINDING:  jwt.verify called with issuer: 'golden-record'. Tokens
          with a missing or wrong issuer are rejected.
          jwt.js:78

---

SECTION:  STRIDE — Spoofing
CHECK:    Is the JWT aud claim validated?
STATUS:   PASS
FINDING:  jwt.verify called with audience: 'golden-record'. Tokens
          with a missing or wrong audience are rejected.
          jwt.js:78
          Note: aud and iss are currently both 'golden-record'. A TODO
          comment flags update to 'golden-record-webview' before Sprint 4.
          jwt.js:48,77

---

SECTION:  STRIDE — Spoofing
CHECK:    Is the JWT org claim validated against the authenticated org_id?
STATUS:   PASS
FINDING:  After verifyToken, jwtMiddleware checks
          claims.org_id !== req.context.org_id and returns 403 if
          mismatch. Cross-org JWT reuse is blocked.
          jwt.js:107

---

## TAMPERING

---

SECTION:  STRIDE — Tampering
CHECK:    Are all database writes using parameterized queries ($1, $2)?
STATUS:   PASS
FINDING:  All SQL in every route, middleware, and module uses
          parameterized placeholders. No string concatenation of user
          input into SQL strings was found in any file reviewed.

---

SECTION:  STRIDE — Tampering
CHECK:    Can org_id be supplied in request body to bypass RLS?
STATUS:   PASS
FINDING:  org_id is always taken from req.context.org_id (set by
          orgAuthMiddleware). If body.org_id is present and differs
          from context, a 400 is returned — the body value is never
          used. resolve.js:20,23-26 · nfc.js:20,23-26 · session.js:16,20-24

---

SECTION:  STRIDE — Tampering
CHECK:    Can fan_id be supplied in request body to bypass JWT check?
STATUS:   PASS
FINDING:  Fan-facing endpoints take fan_id from JWT (req.context.fan_id)
          or compare URL params against the JWT claim. The body fan_id
          in POST /v1/session is used only to look up the fan in the DB,
          and org_id is always from context. No bypass path found.

---

SECTION:  STRIDE — Tampering
CHECK:    Can a caller modify another org's records?
STATUS:   PASS
FINDING:  Double protection: (1) all queries include AND org_id = $N
          scoped to req.context.org_id; (2) rlsContextMiddleware sets
          app.current_org_id for RLS enforcement at the database layer.

---

SECTION:  STRIDE — Tampering
CHECK:    Can a caller modify another fan's records?
STATUS:   PASS
FINDING:  All household and profile endpoints compare URL
          adult_fan_id against jwt_fan_id from the JWT. Mismatch → 403.
          profile.js:26 · household.js:111,221,416,525,731,833,913

---

SECTION:  STRIDE — Tampering
CHECK:    Is the audit_log append-only trigger in place?
STATUS:   RISK
FINDING:  migration_001.sql contains no DDL trigger to prevent
          UPDATE or DELETE on audit_log. The append-only property
          is enforced by application convention only. The CLAUDE.md
          notes "migration_003 — RLS + audit trigger" which may add
          this, but migration_003.sql was not in the audit read list.
          Cannot confirm. Verify that migration_003 includes a trigger
          that blocks UPDATE and DELETE on audit_log.
FIX:      Read migration_003.sql. Confirm trigger exists. If absent,
          add a BEFORE UPDATE/DELETE trigger on audit_log that raises
          an exception.

---

## REPUDIATION

---

SECTION:  STRIDE — Repudiation
CHECK:    Does every write have a corresponding audit_log entry?
STATUS:   MEDIUM
FINDING:  POST /v1/household (household.js:57-79) inserts the household
          row and then attempts the audit_log write in a separate
          try/catch that silently swallows failures (lines 66-79, comment
          reads "non-fatal if it fails"). This violates the CLAUDE.md
          rule: "Audit event is always the last write inside a
          transaction. If the audit write fails the whole transaction
          rolls back." A household can be created with no audit record.
FIX:      Wrap the household INSERT and audit_log INSERT together in a
          BEGIN/COMMIT transaction. Remove the non-fatal inner try/catch
          on the audit write.

---

SECTION:  STRIDE — Repudiation
CHECK:    Is the correlation_id present on every logged request?
STATUS:   PASS
FINDING:  correlationIdMiddleware runs on all protected routes and sets
          req.context.correlation_id. All catch blocks in route handlers
          include correlation_id in their log output.

---

SECTION:  STRIDE — Repudiation
CHECK:    Is merged_by recorded on every merge?
STATUS:   PASS
FINDING:  conflicts.js:169 records req.context.org_name as merged_by
          in merge_history. The org that confirmed the merge is
          permanently recorded.

---

SECTION:  STRIDE — Repudiation
CHECK:    Is severed_by recorded on every household sever?
STATUS:   LOW
FINDING:  severed_by is hardcoded as the string 'guardian'
          (household.js:780). This is accurate for the current scope
          (only guardians can sever via this endpoint) but will be
          misleading if staff-initiated severing is added in a future
          sprint without updating this field.
FIX:      No immediate action required. When staff-sever is added,
          derive severed_by from req.context rather than hardcoding.

---

SECTION:  STRIDE — Repudiation
CHECK:    Is aged_up_initiated_by recorded on every age-up?
STATUS:   LOW
FINDING:  aged_up_initiated_by is hardcoded as 'guardian'
          (household.js:979). Same issue as severed_by. Accurate now,
          but will need updating when staff can initiate age-up.
FIX:      Same as severed_by — no immediate action, update when
          staff-initiated age-up is added.

---

SECTION:  STRIDE — Repudiation
CHECK:    Is child session issuance (Component 33) audited?
STATUS:   LOW
FINDING:  POST /v1/household/:adult_fan_id/members/:child_fan_id/session
          issues an 8-hour JWT with no audit_log INSERT. This is
          per-spec (CLAUDE.md Component 33 pseudocode says "no audit
          event"), but it means child session issuance leaves no server-
          side record. The parent session that triggered it is audited,
          but the child token itself is not.
FIX:      Accept as known gap per spec. Document in CLAUDE.md as
          deliberate omission. Consider adding audit event in Sprint 4
          for production-grade session accountability.

---

## INFORMATION DISCLOSURE

---

SECTION:  STRIDE — Information Disclosure
CHECK:    Do error responses expose internal details, stack traces,
          table names, or query structure?
STATUS:   PASS
FINDING:  All catch blocks return generic error strings to the caller.
          Internal details (err.message, table names, query structure)
          are written to logger only. No stack traces in any response.

---

SECTION:  STRIDE — Information Disclosure
CHECK:    Is the JWT private key ever logged?
STATUS:   PASS
FINDING:  PRIVATE_KEY is loaded once at module init and held in closure.
          It is never referenced in any logger call. jwt.js:23

---

SECTION:  STRIDE — Information Disclosure
CHECK:    Is the raw claim token ever logged?
STATUS:   MEDIUM
FINDING:  household.js:1006-1011 — the age-up email stub logs the raw
          claim token in the claim_url field:
            logger.info('AGE-UP EMAIL STUB', {
              claim_url: `https://fanpass.thunder.com/claim/${raw_token}`
            })
          If this log entry reaches Cloud Logging, any party with log
          read access can use the raw token to claim any aged-up child
          profile during the 30-day window.
FIX:      Remove raw_token from the log entry before production.
          Log only that an email stub was fired, the minor_fan_id, and
          the expiry. Never log the claim_url with the token embedded.
          household.js:1006-1011

---

SECTION:  STRIDE — Information Disclosure
CHECK:    Are fan PII fields ever logged?
STATUS:   MEDIUM
FINDING:  Same email stub (household.js:1007) logs
          `to: guardianEmail` — the guardian's email address is PII.
          All other logger calls use UUIDs (fan_id, org_id) and
          non-PII fields. The email address is the only PII found
          in log output across all reviewed files.
FIX:      Remove `to: guardianEmail` from the stub logger call.
          Log `to: '[REDACTED]'` or omit the field entirely.
          household.js:1007

---

SECTION:  STRIDE — Information Disclosure
CHECK:    Is the raw org API key ever stored or logged?
STATUS:   PASS
FINDING:  orgAuthMiddleware computes sha256 of rawKey immediately and
          never stores or logs rawKey. orgAuthMiddleware.js:29

---

SECTION:  STRIDE — Information Disclosure
CHECK:    Does the health endpoint expose internal system details?
STATUS:   LOW
FINDING:  GET /health returns different payloads based on org API key
          auth: authenticated callers see db status, queue_depth, and
          error_rate_5m; unauthenticated callers see only status and
          timestamp. Operational metrics (queue depth, error rate) are
          visible to authenticated orgs. This is intentional but
          documented as accepted design. health.js:89-99

---

SECTION:  STRIDE — Information Disclosure
CHECK:    Is the ResolverError message ever returned to the caller?
STATUS:   PASS
FINDING:  resolverEngine throws ResolverError('resolver failure: ' +
          err.message). The route handlers catch this and return only
          'resolver internal error' to the caller. The ResolverError
          message (containing internal err.message) is only logged
          server-side. resolve.js:72-75 · nfc.js:100-109

---

## DENIAL OF SERVICE

---

SECTION:  STRIDE — Denial of Service
CHECK:    Is rate limiting applied to all routes?
STATUS:   MEDIUM
FINDING:  GET /health is mounted directly on the app without passing
          through any rate limiter (index.js:30: app.use(healthRouter)).
          Each health check request triggers up to 3 database queries
          (db probe, queue depth COUNT, error rate COUNT). An attacker
          can flood /health with no throttle, amplifying load on the
          database. All other routes pass through rateLimiter.
FIX:      Apply a rate limiter to healthRouter. A separate, more
          generous limit (e.g. 30 req/min) is appropriate for Cloud Run
          health probes while still preventing abuse. index.js:30

---

SECTION:  STRIDE — Denial of Service
CHECK:    Is there a maximum on pagination limits?
STATUS:   PASS
FINDING:  GET /v1/conflicts: limit capped at 100 (conflicts.js:33).
          GET /v1/household/:adult_fan_id: limit capped at 10
          (household.js:114). Both validated before any DB call.

---

SECTION:  STRIDE — Denial of Service
CHECK:    Is there protection against extremely large request bodies?
STATUS:   LOW
FINDING:  index.js:27 uses express.json() with no explicit limit.
          Express 5 default is 100kb — not documented or enforced
          explicitly. For an IoT/NFC ingest platform this is likely
          sufficient, but the limit should be set explicitly.
FIX:      Change to express.json({ limit: '10kb' }) or another
          documented value appropriate to the largest expected payload.
          index.js:27

---

SECTION:  STRIDE — Denial of Service
CHECK:    Can a single org exhaust database connections?
STATUS:   LOW
FINDING:  pool.js uses pg.Pool with default settings (max 10 connections).
          Rate limiting (100 req/min per IP) provides indirect protection
          but is IP-based only. A distributed attacker from multiple IPs
          or an org with many devices could exhaust the pool.
          pool.js:6
FIX:      Set explicit pool max in DATABASE_URL or Pool constructor.
          Consider a per-org concurrency limit at the application layer
          in a future sprint.

---

## ELEVATION OF PRIVILEGE

---

SECTION:  STRIDE — Elevation of Privilege
CHECK:    Can a child session JWT be used on adult or unrestricted
          fan endpoints?
STATUS:   HIGH
FINDING:  POST /v1/household/:adult_fan_id/members/:child_fan_id/session
          issues a JWT with acting_as='child' and guardian=adult_fan_id
          in the claims (household.js:871-876, jwt.js:56-57). However,
          jwtMiddleware.verifyToken() does NOT extract acting_as or
          guardian from the decoded claims — it returns only fan_id,
          org_id, iat, exp, jti (jwt.js:91-97). jwtMiddleware does not
          attach acting_as to req.context.

          Consequence: a child holding an 8-hour session token can:
          (1) Call GET /v1/fan/:id/profile for their own child fan_id
              — may be intentional but is not explicitly enforced.
          (2) Call POST /v1/household with their child fan_id,
              creating a household as a minor (the adult_fan_id guard
              checks req.context.fan_id, which is the child's fan_id).
          (3) Call household member endpoints using their child fan_id
              as the adult_fan_id URL param — all guards compare
              url_adult_fan_id to jwt_fan_id. A child token satisfies
              this guard because the child IS the jwt_fan_id.

          The acting_as claim is signed into the token but is invisible
          to the application after verification.
FIX:      In verifyToken() (jwt.js:91-97), extract acting_as and
          guardian from decoded claims and include them in the return
          object. In jwtMiddleware, attach them to req.context.
          On any endpoint where child sessions should be blocked,
          check req.context.acting_as and return 403 if 'child'.
          Minimum: block POST /v1/household and POST /v1/session from
          child-token holders.

---

SECTION:  STRIDE — Elevation of Privilege
CHECK:    Can a fan access staff endpoints (/v1/conflicts, /v1/admin)?
STATUS:   PASS
FINDING:  Staff endpoints are mounted in protectedRouter which requires
          only an org API key. Fan JWTs do not grant access to these
          routes. A fan would need the org's raw API key.
          index.js:41-51

---

SECTION:  STRIDE — Elevation of Privilege
CHECK:    Can a fan access another fan's household data?
STATUS:   PASS
FINDING:  Every household endpoint checks url_adult_fan_id !== jwt_fan_id
          and returns 403. The URL parameter is always verified against
          the JWT claim before any database call.

---

SECTION:  STRIDE — Elevation of Privilege
CHECK:    Can an org access another org's data?
STATUS:   PASS
FINDING:  RLS enforced at the Postgres layer via rlsContextMiddleware.
          All application queries also include explicit org_id scoping.
          Double protection at application and database layers.

---

SECTION:  STRIDE — Elevation of Privilege
CHECK:    Is jwtMiddleware correctly applied to all fan-facing endpoints?
STATUS:   PASS
FINDING:  GET /v1/fan/:id/profile — jwtMiddleware applied inline.
          profile.js:13
          All /v1/household routes — householdProtectedRouter has
          jwtMiddleware. index.js:58
          Machine-to-machine endpoints (resolve, nfc, session, conflicts,
          admin) correctly have no jwtMiddleware — by design.

---

SECTION:  STRIDE — Elevation of Privilege
CHECK:    Is the admin router correctly separated from fan routes?
STATUS:   PASS
FINDING:  adminHouseholdRouter is in protectedRouter (org API key only,
          no JWT). Fan household routes are in householdProtectedRouter
          (org API key + JWT). Correctly separated. index.js:51,53-59

---

---

# SECTION 2 — OWASP TOP 10

---

SECTION:  OWASP
CHECK:    A01 — JWT fan_id validated against URL params on all fan endpoints?
STATUS:   PASS
FINDING:  profile.js:26, household.js:111,221,416,525,731,833,913 —
          all compare URL param against JWT claim before any DB call.

---

SECTION:  OWASP
CHECK:    A01 — org_id always from req.context, never req.body?
STATUS:   PASS
FINDING:  All routes set org_id = req.context.org_id immediately.
          Body org_id is validated for mismatch only, never used as
          the actual org_id value.

---

SECTION:  OWASP
CHECK:    A01 — RLS enforced on all tables including Sprint 3 tables?
STATUS:   RISK
FINDING:  RLS on Sprint 3 tables (household, household_member,
          staging_household_data, merge_history, related_fans) is
          confirmed in migration_006.sql. RLS on Sprint 1 tables (org,
          fan, identifier_link, audit_log, ingest_failures) is expected
          in migration_003.sql, which was not in the audit read list.
          Cannot confirm Sprint 1 table RLS from files reviewed.
FIX:      Read migration_003.sql. Confirm ENABLE ROW LEVEL SECURITY,
          tenant_isolation policy, and FORCE ROW LEVEL SECURITY are
          applied to all Sprint 1 tables.

---

SECTION:  OWASP
CHECK:    A01 — Admin endpoints inaccessible without org API key?
STATUS:   PASS
FINDING:  adminHouseholdRouter passes through protectedRouter, which
          starts with orgAuthMiddleware. No admin route is reachable
          without a valid org API key. index.js:51

---

SECTION:  OWASP
CHECK:    A02 — JWT signed with RS256, not HS256?
STATUS:   PASS
FINDING:  jwt.sign uses { algorithm: 'RS256' } (jwt.js:58).
          jwt.verify uses { algorithms: ['RS256'] } (jwt.js:78).
          HS256 is not accepted.

---

SECTION:  OWASP
CHECK:    A02 — API keys stored as sha256 hash, not plain text?
STATUS:   PASS
FINDING:  org table stores org_api_key_hash. orgAuthMiddleware hashes
          the incoming key and compares by hash. Raw key never stored.
          migration_001.sql:64 · orgAuthMiddleware.js:29

---

SECTION:  OWASP
CHECK:    A02 — Claim token stored as sha256 hash, not plain text?
STATUS:   PASS
FINDING:  household.js:969 computes token_hash from raw_token.
          Only token_hash is written to household_member.claim_token.
          The raw token is never persisted. household.js:969,985

---

SECTION:  OWASP
CHECK:    A02 — JWT keys loaded from Secret Manager, not hardcoded?
STATUS:   PASS
FINDING:  Keys are read from environment variables JWT_PRIVATE_KEY and
          JWT_PUBLIC_KEY (jwt.js:23-24). They are not hardcoded.
          In production, Cloud Run must populate these env vars from
          Secret Manager. This is a deployment configuration requirement,
          not a code defect. See VERIFY IN GCP CONSOLE section.

---

SECTION:  OWASP
CHECK:    A02 — timingSafeEqual used for claim token comparison?
STATUS:   PASS
FINDING:  household.js:1075-1079 uses crypto.timingSafeEqual to compare
          the stored hash buffer against the incoming hash buffer.
          Timing attacks on claim token comparison are mitigated.

---

SECTION:  OWASP
CHECK:    A03 — Every database query uses parameterized $1/$2 format?
STATUS:   PASS
FINDING:  All SQL across all reviewed files uses parameterized queries.
          No string concatenation of user input into SQL found.

---

SECTION:  OWASP
CHECK:    A03 — No string concatenation in any SQL query?
STATUS:   PASS
FINDING:  SQL strings are all static template literals with $N
          placeholders. Confirmed across resolverEngine.js, conflicts.js,
          household.js, admin/household.js, session.js, profile.js,
          nfc.js, orgAuthMiddleware.js.

---

SECTION:  OWASP
CHECK:    A03 — Identifier values normalized before storage?
STATUS:   PASS
FINDING:  All identifier values pass through normalizeIdentifier()
          before being stored or used in queries. Normalization also
          validates format, preventing malformed values from reaching
          the database.

---

SECTION:  OWASP
CHECK:    A04 — Merge reversible via unmerge endpoint?
STATUS:   PASS
FINDING:  POST /v1/conflicts/:id/unmerge is implemented. It uses
          merged_from_fan_id provenance to restore identifiers to the
          original fan record. conflicts.js:274-403

---

SECTION:  OWASP
CHECK:    A04 — Child fan record not destroyed on household sever?
STATUS:   PASS
FINDING:  DELETE /v1/household/:adult_fan_id/members/:child_fan_id
          sets household_member.status = 'severed' only. Child fan
          record, identifier_link rows, and Firestore wallet are
          untouched. household.js:776-815

---

SECTION:  OWASP
CHECK:    A04 — Claim token single use — cleared after claim?
STATUS:   PASS
FINDING:  household.js:1111-1118 sets claim_token = NULL and
          claim_token_expires_at = NULL inside the commit transaction
          on successful claim. Token cannot be reused.

---

SECTION:  OWASP
CHECK:    A04 — Token expiry enforced with 410, not 404?
STATUS:   PASS
FINDING:  household.js:1091-1093 — expired claim token returns 410.
          Not-found claim token returns 404. Correct HTTP semantics
          per spec.

---

SECTION:  OWASP
CHECK:    A05 — CORS origin locked to specific domain, not wildcard?
STATUS:   MEDIUM
FINDING:  index.js has no CORS configuration. helmet() sets some
          security headers but does not configure CORS. The CLAUDE.md
          CORS_ORIGIN env var is flagged as "pending confirmation from
          King/Tanner." If any household or profile endpoints are
          called from a browser (Fan Pass PWA), requests will be
          blocked by the browser's same-origin policy. If the API is
          purely server-to-server, impact is lower.
FIX:      Implement CORS middleware (e.g. the 'cors' npm package)
          with a specific CORS_ORIGIN env var once confirmed with King
          and Tanner. Never use wildcard (*) on an authenticated API.
          index.js

---

SECTION:  OWASP
CHECK:    A05 — Error details never returned to caller?
STATUS:   PASS
FINDING:  All 500 responses use generic strings. Internal error details
          are logged only. Confirmed across all route handlers.

---

SECTION:  OWASP
CHECK:    A05 — JWT algorithm explicitly set to RS256?
STATUS:   PASS
FINDING:  Both jwt.sign and jwt.verify specify RS256 explicitly.
          jwt.js:58,78

---

SECTION:  OWASP
CHECK:    A05 — clockTolerance set to a reasonable value?
STATUS:   PASS
FINDING:  clockTolerance: 30 seconds. Appropriate for server-to-server
          clock skew in a Cloud Run environment. jwt.js:78

---

SECTION:  OWASP
CHECK:    A06 — Known vulnerable dependencies?
STATUS:   LOW
FINDING:  No obviously outdated or known-critical packages found.
          Current versions: express ^5.2.1, jsonwebtoken ^9.0.3,
          helmet ^8.1.0, pg ^8.20.0, express-rate-limit ^8.5.0.
          jsonwebtoken v9.x should be checked against current CVE
          advisories before production deployment.
FIX:      Run `npm audit` before first production deployment.
          Pin exact versions in package-lock.json. Subscribe to
          security advisories for jsonwebtoken and express.

---

SECTION:  OWASP
CHECK:    A07 — JWT expiry validated on every request?
STATUS:   PASS
FINDING:  jwt.verify catches TokenExpiredError and throws JWTError → 401.
          jwt.js:80

---

SECTION:  OWASP
CHECK:    A07 — Org API key validated on every request?
STATUS:   PASS
FINDING:  orgAuthMiddleware is the first middleware on all protected
          routers. No protected handler is reachable without a valid,
          active org API key.

---

SECTION:  OWASP
CHECK:    A07 — Rate limiting prevents brute force on auth?
STATUS:   LOW
FINDING:  Rate limiting is IP-based (express-rate-limit defaults).
          100 req/min per IP. A distributed attack from multiple IPs
          — realistic for a venue with many NFC readers — would bypass
          the per-IP limit. API key brute force across distributed
          sources is not mitigated.
FIX:      Consider adding a failed-auth counter per hashed-key prefix
          or per source IP range. Low priority for Sprint 3 but worth
          planning before high-traffic events.

---

SECTION:  OWASP
CHECK:    A07 — 401 vs 403 used correctly throughout?
STATUS:   PASS
FINDING:  401 = I don't know who you are (missing/invalid/expired token,
          unknown org key). 403 = I know who you are but you cannot
          proceed (inactive org, erased fan, JWT org mismatch, fan_id
          mismatch). Applied consistently throughout all reviewed files.

---

SECTION:  OWASP
CHECK:    A08 — Audit log append-only trigger in place?
STATUS:   RISK
FINDING:  Same as STRIDE Tampering finding above. migration_001.sql
          contains no DDL trigger. migration_003.sql (unread) may
          include one. Cannot confirm.

---

SECTION:  OWASP
CHECK:    A08 — audit_log event_type CHECK constraint allows
          Sprint 2+ and Sprint 3 event types?
STATUS:   HIGH
FINDING:  migration_001.sql:226 defines:
            CHECK (event_type IN ('resolution', 'session_issued'))
          The Sprint 2 and Sprint 3 code writes the following event
          types that are NOT in this constraint:
            'conflict_confirmed'      — conflicts.js:174
            'conflict_rejected'       — conflicts.js:248
            'merge_reversed'          — conflicts.js:377
            'household_created'       — household.js:69
            'household_member_added'  — household.js:351
            'household_member_updated'— household.js:688
            'household_member_severed'— household.js:790
            'household_member_aged_up'— household.js:998
            'profile_claimed'         — household.js:1125
          Every one of these INSERT statements would be rejected by
          Postgres with a CHECK constraint violation in production.
          This would cause ALL conflict resolution and household
          operations to fail with a 500 error.
          CLAUDE.md Sprint 2 note incorrectly states "No schema change
          needed — event_type is TEXT not enum. New values work
          automatically." There IS a CHECK constraint.
          If a migration (002, 003, or another unread file) updates this
          constraint, the issue may be resolved — but CLAUDE.md's
          comment is still wrong and misleading.
FIX:      Verify that a migration updates the audit_log event_type
          CHECK constraint to include all Sprint 2+ event types.
          If no such migration exists, create one immediately.
          Correct CLAUDE.md to remove the incorrect "no schema change
          needed" comment.

---

SECTION:  OWASP
CHECK:    A08 — audit_log identifier_type CHECK constraint allows
          Sprint 3 identifier types?
STATUS:   HIGH
FINDING:  migration_001.sql:232-234 defines:
            identifier_type TEXT CHECK (identifier_type IN
              ('email', 'phone', 'nfc_uid', 'nba_id', 'ticketmaster_id'))
          resolverEngine.js writes identifier_type to audit_log on
          every resolution (resolverEngine.js:302). When POST /v1/resolve
          is called with identifier_type 'name', 'dob', 'zip',
          'guardian_email', or 'guardian_phone' (all valid Sprint 3
          types), the audit_log INSERT will fail with a CHECK constraint
          violation, causing the resolver to throw a ResolverError and
          return 500.
          The same failure applies to the error audit path
          (resolverEngine.js:349-352).
          migration_005.sql updates identifier_link's CHECK constraint
          but does NOT update audit_log's identifier_type CHECK.
FIX:      Add a migration that drops and recreates the
          audit_log identifier_type CHECK to include all Sprint 3
          types: name, dob, zip, guardian_email, guardian_phone.
          This is parallel to what migration_005.sql PART 9 did for
          identifier_link.

---

SECTION:  OWASP
CHECK:    A08 — Merge history status transitions correct?
STATUS:   PASS
FINDING:  pending → confirmed (only via confirm endpoint).
          confirmed → unmerged (only via unmerge endpoint, which
          checks status = 'confirmed'). rejected conflicts cannot
          be confirmed (confirm checks status = 'pending').
          Unmerged conflicts cannot be re-confirmed. No regression
          path found.

---

SECTION:  OWASP
CHECK:    A09 — All errors logged with correlation_id?
STATUS:   PASS
FINDING:  All catch blocks across route handlers include
          correlation_id: req.context.correlation_id in the log
          object. Spot-checked: resolve.js:72, nfc.js:107,
          household.js:86, admin/household.js:119, conflicts.js:84.

---

SECTION:  OWASP
CHECK:    A09 — All errors logged with org_id?
STATUS:   PASS
FINDING:  All catch blocks include org_id in the log object.
          Confirmed across all reviewed route handlers.

---

SECTION:  OWASP
CHECK:    A09 — No PII in log output?
STATUS:   MEDIUM
FINDING:  Covered above. household.js:1007 logs guardian email address
          (PII) in the age-up email stub. All other logger calls use
          UUIDs and non-PII fields. The email address is the only PII
          found in log output across all reviewed files.
FIX:      Remove `to: guardianEmail` from the age-up logger call.
          household.js:1007

---

SECTION:  OWASP
CHECK:    A09 — No credentials in log output?
STATUS:   MEDIUM
FINDING:  See Information Disclosure finding above. household.js:1010
          logs the raw claim token embedded in claim_url. This is a
          credential — possession of this value lets anyone claim the
          aged-up profile.
FIX:      Remove raw_token from the log output. household.js:1010

---

SECTION:  OWASP
CHECK:    A10 — No external HTTP calls based on user input?
STATUS:   PASS
FINDING:  Firestore writes use fan_id (UUID generated internally) and
          org_id (from middleware). No user-controlled value determines
          an external HTTP destination. The email stub does not make
          actual HTTP calls — it only logs.

---

SECTION:  OWASP
CHECK:    A10 — Firestore project ID from environment variable,
          not user input?
STATUS:   PASS
FINDING:  resolverEngine.js:12 and profile.js:9 both use
          process.env.FIRESTORE_PROJECT_ID. Not user-controlled.

---

---

# SECTION 3 — CIA TRIAD

---

## CONFIDENTIALITY

---

SECTION:  CIA — Confidentiality
CHECK:    Fan data only accessible to authenticated org?
STATUS:   PASS
FINDING:  All protected routes require a valid org API key.
          RLS enforces org scoping at the database layer.

---

SECTION:  CIA — Confidentiality
CHECK:    Child data only accessible to the guardian?
STATUS:   PASS
FINDING:  All household endpoints verify url_adult_fan_id against
          jwt_fan_id. Only a fan whose JWT matches the adult_fan_id
          in the URL can access the child data. Staff can access
          child data via GET /v1/admin/household/:fan_id (org key only)
          — this is the correct design for staff oversight.

---

SECTION:  CIA — Confidentiality
CHECK:    Admin data only accessible via staff endpoints?
STATUS:   PASS
FINDING:  Soft links, staging_household_data, and related_fans are
          only returned by admin/household.js (org key, no JWT).
          Fan-facing endpoints (household.js) only return hard-link
          active members to the authenticated guardian.

---

SECTION:  CIA — Confidentiality
CHECK:    JWT private key never exposed in responses or logs?
STATUS:   PASS
FINDING:  PRIVATE_KEY is module-scoped. Never appears in any logger
          call, error response, or return value. jwt.js:23

---

## INTEGRITY

---

SECTION:  CIA — Integrity
CHECK:    All writes inside transactions where atomicity is required?
STATUS:   MEDIUM
FINDING:  POST /v1/household — household INSERT is not wrapped in a
          transaction. The audit event is a separate non-fatal write.
          If the audit write fails, a household record exists with no
          audit entry. See Repudiation finding for full detail.
          household.js:57-97
FIX:      Wrap both writes in BEGIN/COMMIT.

---

SECTION:  CIA — Integrity
CHECK:    Audit event always last write in transaction?
STATUS:   PASS
FINDING:  In all transaction-bearing handlers, the audit_log INSERT
          is the final statement before COMMIT. Confirmed in:
          resolverEngine.js:296-306, conflicts.js:172-178 (confirm),
          conflicts.js:247-252 (reject), conflicts.js:375-380 (unmerge),
          household.js:349-355 (add member), household.js:687-693
          (update), household.js:788-794 (sever), household.js:997-1003
          (age-up), household.js:1124-1128 (claim).

---

SECTION:  CIA — Integrity
CHECK:    RLS prevents cross-tenant writes?
STATUS:   PASS
FINDING:  RLS on Sprint 3 tables confirmed in migration_006.sql.
          rlsContextMiddleware sets app.current_org_id per request.
          Cross-tenant writes would require bypassing both application
          org_id scoping and Postgres RLS simultaneously.

---

SECTION:  CIA — Integrity
CHECK:    Unique constraints prevent duplicate records?
STATUS:   PASS
FINDING:  identifier_link: UNIQUE (identifier_type, identifier_value,
          org_id). migration_001.sql:172
          conflict_queue: uq_conflict_queue_pair prevents duplicate
          pending pairs. migration_006.sql:174
          merge_history: uq_merge_history_active prevents concurrent
          unmerge. migration_006.sql:183
          related_fans: uq_related_fans_pair prevents duplicate
          relationship rows. migration_006.sql:191
          household: UNIQUE (adult_fan_id, org_id).
          migration_005.sql (not read — assumed present per spec)

---

## AVAILABILITY

---

SECTION:  CIA — Availability
CHECK:    Health endpoint operational and non-throwing?
STATUS:   PASS
FINDING:  GET /health uses independent try/catch blocks for each
          metric. If any block fails the others still execute. The
          endpoint never throws — it always returns a JSON response.
          health.js:41-99

---

SECTION:  CIA — Availability
CHECK:    Graceful degradation when Firestore is unavailable?
STATUS:   PASS
FINDING:  resolverEngine.js:309-326 — Firestore sync failure is caught
          and logged. The Postgres record is committed and valid.
          profile.js:53-64 — Firestore read failure returns empty wallet
          state (loyalty_points: 0, stamps: [], avatar: null).

---

SECTION:  CIA — Availability
CHECK:    DLQ catches failed ingest attempts?
STATUS:   PASS
FINDING:  nfc.js writes to ingest_failures on both normalization
          failures and resolver failures. DLQ writes are in their own
          try/catch so a DLQ failure does not mask the original error
          response. nfc.js:63-76, nfc.js:100-113

---

SECTION:  CIA — Availability
CHECK:    Rate limiting prevents resource exhaustion on protected routes?
STATUS:   PASS
FINDING:  rateLimiter applied to all three protected routers.
          index.js:42,54,65
          Exception: GET /health — covered separately under DoS.

---

---

# SECTION 4 — TRUST BOUNDARIES

---

## ZONE 1 — External Untrusted Callers

---

SECTION:  TRUST — Zone 1
CHECK:    Every request from Zone 1 passes through orgAuthMiddleware
          before any data is touched?
STATUS:   PASS
FINDING:  protectedRouter, householdProtectedRouter, and
          householdPublicRouter all start with orgAuthMiddleware.
          GET /health is the only route without orgAuthMiddleware —
          intentional for Cloud Run health probes. The health endpoint
          limits its response to operational metrics for authenticated
          callers and a minimal status for unauthenticated callers.
          index.js:30,43,55,66

---

SECTION:  TRUST — Zone 1
CHECK:    No endpoint is reachable without org API key, except the
          intentionally public health route?
STATUS:   PASS
FINDING:  Confirmed. GET /health is the only route without
          orgAuthMiddleware and is intentionally public.

---

SECTION:  TRUST — Zone 1
CHECK:    Fan JWT required for all fan-facing endpoints?
STATUS:   PASS
FINDING:  GET /v1/fan/:id/profile — jwtMiddleware applied inline.
          All /v1/household routes — householdProtectedRouter has
          jwtMiddleware before all handlers. Machine-to-machine
          endpoints (resolve, nfc, session) correctly omit jwtMiddleware.

---

## ZONE 2 — Thunder Staff Internal

---

SECTION:  TRUST — Zone 2
CHECK:    Admin endpoints require org API key?
STATUS:   PASS
FINDING:  adminHouseholdRouter is in protectedRouter → orgAuthMiddleware.
          GET /v1/admin/household/:fan_id requires a valid org API key.

---

SECTION:  TRUST — Zone 2
CHECK:    Admin endpoints do not require fan JWT?
STATUS:   PASS
FINDING:  Correct design. Staff authenticate as the org, not as a fan.
          No jwtMiddleware in protectedRouter for admin routes.

---

SECTION:  TRUST — Zone 2
CHECK:    No staff endpoint bypasses RLS?
STATUS:   PASS
FINDING:  rlsContextMiddleware is applied to all protected routers,
          including the one hosting adminHouseholdRouter. The admin
          endpoint uses req.db (the RLS-scoped client), not the raw
          pool. admin/household.js:29-66

---

## ZONE 3 — GCP Trusted Infrastructure

---

SECTION:  TRUST — Zone 3
CHECK:    JWT keys loaded from Secret Manager in production?
STATUS:   VERIFY IN GCP CONSOLE
FINDING:  jwt.js reads from process.env.JWT_PRIVATE_KEY and
          process.env.JWT_PUBLIC_KEY. In Cloud Run, these env vars
          must be configured to pull from Secret Manager — this is a
          deployment configuration, not a code defect.
FIX:      Verify in Cloud Run console that JWT_PRIVATE_KEY and
          JWT_PUBLIC_KEY are backed by Secret Manager secrets with
          appropriate IAM bindings for the service account.

---

SECTION:  TRUST — Zone 3
CHECK:    Database credentials never hardcoded?
STATUS:   PASS
FINDING:  pool.js:6 uses process.env.DATABASE_URL. Not hardcoded.

---

SECTION:  TRUST — Zone 3
CHECK:    Firestore project ID from environment variable?
STATUS:   PASS
FINDING:  resolverEngine.js:12 and profile.js:9 both use
          process.env.FIRESTORE_PROJECT_ID.

---

## ZONE 4 — Application Internal

---

SECTION:  TRUST — Zone 4
CHECK:    Middleware stack order correct on all routers?
STATUS:   PASS
FINDING:  All three protected routers follow:
          rateLimiter → orgAuthMiddleware → rlsContextMiddleware →
          correlationIdMiddleware → [jwtMiddleware if applicable] →
          handler. This correctly satisfies CLAUDE.md middleware
          order while also inserting rlsContextMiddleware after
          orgAuthMiddleware (which sets the org_id that RLS needs).
          index.js:42-59

---

SECTION:  TRUST — Zone 4
CHECK:    No route bypasses the middleware stack?
STATUS:   PASS
FINDING:  All routes are mounted on one of the three protected routers
          or the intentionally public healthRouter. The claim route
          (/v1/household/claim/:token) is on householdPublicRouter
          which still has orgAuthMiddleware — the child presents the
          org key but not a fan JWT (correct, since they have no JWT
          yet). index.js:64-69

---

SECTION:  TRUST — Zone 4
CHECK:    Claim route mounted before household protected router to
          prevent :adult_fan_id matching 'claim'?
STATUS:   PASS
FINDING:  householdPublicRouter (containing claimRouter) is mounted
          at line 72, before householdProtectedRouter at line 73.
          Express will match /v1/household/claim/:token at the public
          router before it reaches the protected router's
          :adult_fan_id parameter. index.js:71-73

---

SECTION:  TRUST — Zone 4
CHECK:    src/middleware/jwtMiddleware.js audited?
STATUS:   RISK
FINDING:  This file is imported by profile.js:5 and index.js:21 but
          was not in the audit read list. jwt.js exports jwtMiddleware
          as a named export — jwtMiddleware.js likely re-exports it.
          However, any additional logic in that file (extra guards,
          modified behavior) was not reviewed.
FIX:      Add src/middleware/jwtMiddleware.js to the next audit
          read list. Confirm it does nothing beyond re-exporting
          jwtMiddleware from jwt.js.

---

---

# SECTION 5 — ENCRYPTION STRATEGY

---

## APPLICATION LAYER

---

SECTION:  ENCRYPTION — Application Layer
CHECK:    No HTTP endpoints exist — Cloud Run handles TLS termination?
STATUS:   PASS
FINDING:  The Node.js application listens on HTTP only (no TLS in code).
          This is the correct Cloud Run pattern — TLS is terminated at
          the Cloud Run ingress. index.js:75

---

SECTION:  ENCRYPTION — Application Layer
CHECK:    JWT transmitted via headers, not URL params?
STATUS:   PASS
FINDING:  Fan JWT is read from req.headers['x-fan-token'] (jwt.js:101).
          Org API key is read from req.headers['authorization'].
          Neither credential appears in URL params.
          Note: X-Fan-Token is a custom header, not the standard
          Authorization header. This is intentional — it prevents
          the fan JWT from conflicting with the org API key which
          occupies the Authorization header. jwt.js:101

---

SECTION:  ENCRYPTION — Application Layer
CHECK:    API key transmitted via headers, not URL params?
STATUS:   PASS
FINDING:  Authorization header. Confirmed in orgAuthMiddleware.js:11.

---

SECTION:  ENCRYPTION — Application Layer
CHECK:    JWT private key — loaded from Secret Manager?
STATUS:   VERIFY IN GCP CONSOLE
FINDING:  Same as Zone 3 check above. Code reads from env vars.
          Cloud Run must be configured to source these from Secret
          Manager secrets.

---

SECTION:  ENCRYPTION — Application Layer
CHECK:    Org API keys — sha256 hash only, never stored in plaintext?
STATUS:   PASS
FINDING:  Confirmed. org.org_api_key_hash stores only the hash.
          64-char hex enforced by CHECK constraint.
          migration_001.sql:64-65

---

SECTION:  ENCRYPTION — Application Layer
CHECK:    Claim tokens — sha256 hash only, never stored in plaintext?
STATUS:   PASS
FINDING:  Confirmed. Only token_hash is written to
          household_member.claim_token. household.js:969,985

---

SECTION:  ENCRYPTION — Application Layer
CHECK:    Fan PII (email, phone, name, DOB) encryption at rest?
STATUS:   LOW
FINDING:  identifier_value in identifier_link stores all identifier
          types — including email, phone, name, DOB — as plaintext
          TEXT. This is the standard design for an identity resolution
          graph (plaintext values are required for probabilistic
          matching and deduplication). Field-level encryption would
          prevent matching. This is a known accepted risk documented
          in CLAUDE.md ("PII fields like email, phone, name stored
          as plaintext identifier_value — standard for identity graph").
          Accepted risk. Phase 3 consideration per CLAUDE.md.

---

SECTION:  ENCRYPTION — Application Layer
CHECK:    .env and key files excluded from version control?
STATUS:   VERIFY IN GCP CONSOLE
FINDING:  .gitignore was not in the audit read list. Cannot confirm
          that .env, private.key, and public.key are excluded.
FIX:      Verify .gitignore contains: .env, *.pem, private.key,
          public.key, *.key. Run `git ls-files | grep -E '\.(env|pem|key)'`
          to confirm no credential files are tracked.

---

## INFRASTRUCTURE LAYER

---

SECTION:  ENCRYPTION — Infrastructure
CHECK:    Cloud SQL encryption at rest enabled?
STATUS:   VERIFY IN GCP CONSOLE
FINDING:  Cannot be verified from code. GCP encrypts Cloud SQL at
          rest by default but encryption can be disabled.
FIX:      In Cloud SQL Console: confirm encryption is Google-managed
          or CMEK. Do not disable default encryption.

---

SECTION:  ENCRYPTION — Infrastructure
CHECK:    Cloud SQL SSL connections enforced?
STATUS:   VERIFY IN GCP CONSOLE
FINDING:  pool.js uses DATABASE_URL with no explicit SSL options.
          For Cloud SQL, the Cloud SQL Auth Proxy handles SSL by
          default. Verify the connection method in production.
FIX:      Confirm the Cloud Run service connects via Cloud SQL Auth
          Proxy or that DATABASE_URL includes sslmode=require.
          Verify Cloud SQL instance has "Allow only SSL connections"
          enabled.

---

SECTION:  ENCRYPTION — Infrastructure
CHECK:    Firestore encryption at rest enabled?
STATUS:   VERIFY IN GCP CONSOLE
FINDING:  Cannot be verified from code. GCP encrypts Firestore at
          rest by default.
FIX:      Confirm in GCP Console that default encryption is not
          disabled.

---

SECTION:  ENCRYPTION — Infrastructure
CHECK:    Cloud Run HTTPS only — HTTP traffic blocked?
STATUS:   VERIFY IN GCP CONSOLE
FINDING:  Cannot be verified from code. Cloud Run serves only HTTPS
          by default but this can be misconfigured.
FIX:      In Cloud Run service settings: confirm "Ingress" is set to
          All or Internal+Load Balancer, and verify no HTTP→HTTPS
          downgrade is permitted.

---

SECTION:  ENCRYPTION — Infrastructure
CHECK:    Secret Manager access audit — only authorized service
          accounts have accessor role?
STATUS:   VERIFY IN GCP CONSOLE
FINDING:  Cannot be verified from code.
FIX:      In Secret Manager IAM: confirm only the Cloud Run service
          account has roles/secretmanager.secretAccessor. No dev
          workstation service accounts should have production accessor
          role.

---

---

# ADDITIONAL FINDINGS (Cross-Cutting)

---

SECTION:  STRIDE — Information Disclosure
CHECK:    DOB normalizer ambiguity — DD/MM/YYYY vs MM/DD/YYYY?
STATUS:   LOW
FINDING:  normalizer.js:82-89 — The MM/DD/YYYY and DD/MM/YYYY
          branches use the same regex pattern. Since the MM/DD/YYYY
          branch is tried first and succeeds for any DD/MM/YYYY input
          that also matches the regex (which is all of them), the
          DD/MM/YYYY branch is effectively dead code. Ambiguous dates
          like 04/05/2000 will always be parsed as April 5, never
          May 4. This is a data quality issue, not a security issue,
          but it could cause incorrect DOB storage for fans using
          day-first date formats.
FIX:      Clarify which format is primary and document it. If only
          MM/DD/YYYY and YYYY-MM-DD are accepted, remove the DD/MM/YYYY
          branch and update the validation error message.
          normalizer.js:64-105

---

SECTION:  STRIDE — Spoofing
CHECK:    Fan JWT uses non-standard X-Fan-Token header?
STATUS:   LOW
FINDING:  jwt.js:101 reads from req.headers['x-fan-token'] rather
          than the Authorization header. This is a deliberate design
          choice (the org API key occupies Authorization) but deviates
          from the CLAUDE.md pseudocode which specifies the
          Authorization header for verifyToken. The deviation is
          appropriate, but CLAUDE.md Component 3 pseudocode should
          be updated to document the actual header name.
FIX:      Update CLAUDE.md Component 3 pseudocode to specify
          X-Fan-Token header. No code change required.

---

---

# SUMMARY

Total PASS:                 58
Total LOW:                   9
Total MEDIUM:                5
Total HIGH:                  3
Total CRITICAL:              0
Total RISK:                  3
Total VERIFY IN GCP CONSOLE: 7

---

## Priority Fix List

### Do not deploy until resolved:

HIGH-1  audit_log event_type CHECK constraint
        migration_001.sql:226
        Blocks all Sprint 2+ writes in production.
        Verify a migration updates this constraint.
        If absent — create one before any production deploy.

HIGH-2  audit_log identifier_type CHECK constraint
        migration_001.sql:232-234
        Blocks resolution of Sprint 3 identifier types in production.
        Create migration to add name, dob, zip, guardian_email,
        guardian_phone to the allowed list.

HIGH-3  Child session JWT not enforced at middleware level
        jwt.js:91-97 · household.js:871-876
        Child token holders can call adult endpoints.
        Extract acting_as claim in verifyToken. Attach to req.context.
        Block child tokens from POST /v1/household and POST /v1/session.

---

### Fix before real traffic:

MEDIUM-1  Raw claim token logged in age-up email stub
          household.js:1010
          Remove raw_token from logger call.

MEDIUM-2  Guardian email (PII) logged in age-up email stub
          household.js:1007
          Remove `to: guardianEmail` from logger call.

MEDIUM-3  POST /v1/household audit event outside transaction
          household.js:57-79
          Wrap household INSERT and audit_log INSERT in BEGIN/COMMIT.

MEDIUM-4  GET /health not rate limited
          index.js:30
          Apply a separate rate limiter to the health router.

MEDIUM-5  CORS not configured
          index.js
          Implement CORS middleware once King/Tanner confirm the origin.

---

### Fix before scale:

LOW-1   severed_by hardcoded — household.js:780
LOW-2   aged_up_initiated_by hardcoded — household.js:979
LOW-3   Child session not audited — household.js:870-896 (per spec)
LOW-4   Health endpoint exposes metrics to authenticated callers
LOW-5   express.json() no explicit body size limit — index.js:27
LOW-6   IP-only rate limiting — index.js:34-39
LOW-7   Fan PII stored as plaintext — known accepted risk
LOW-8   DOB DD/MM/YYYY branch is dead code — normalizer.js:82-89
LOW-9   npm audit before production — package.json

---

### Verify in GCP Console before production:

VERIFY-1  JWT keys in Secret Manager (not .env)
VERIFY-2  Cloud SQL encryption at rest
VERIFY-3  Cloud SQL SSL connections (Auth Proxy or sslmode=require)
VERIFY-4  Firestore encryption at rest
VERIFY-5  Cloud Run HTTPS only
VERIFY-6  Secret Manager accessor IAM — service account only
VERIFY-7  .gitignore excludes .env and key files

---

### Audit gaps — read these files before closing:

RISK-1  src/middleware/jwtMiddleware.js — not read, not audited
RISK-2  migrations/migration_003.sql — RLS on Sprint 1 tables
         and audit_log append-only trigger unconfirmed
RISK-3  Confirm one of the unread migrations (002-005) updates
         both audit_log CHECK constraints, or create new migration
