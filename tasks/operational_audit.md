# Operational Readiness Audit — Check 38C
# Golden Record Fan Identity Platform
# Date: 2026-06-02
# Auditor: Claude Code (read-only, no code changes)

Files read:
  CLAUDE.md, src/db/pool.js, index.js, src/routes/health.js,
  src/modules/resolverEngine.js, src/modules/jwt.js,
  src/routes/household.js, src/routes/nfc.js,
  src/routes/resolve.js, src/routes/admin/household.js,
  package.json

---

## CHECK 1 — Graceful shutdown

CHECK:    index.js handles SIGTERM before Cloud Run terminates the container.
STATUS:   FAIL
FINDING:  No SIGTERM handler exists anywhere in the codebase.
          index.js line 102 calls app.listen() and that is the end of
          the startup sequence. No process.on('SIGTERM', ...) is registered.
          No server.close() and no pool.end() are ever called.
          Cloud Run sends SIGTERM before killing a container on every
          deployment, scale-down, and revision rollout. Without a handler,
          all in-flight requests are cut off mid-execution, active
          database transactions are rolled back abruptly, and the
          connection pool is never drained. This affects every deploy.
FIX:      Capture the server reference from app.listen():
            const server = app.listen(PORT, ...);
          Add a SIGTERM handler:
            process.on('SIGTERM', () => {
              server.close(() => {
                pool.end(() => process.exit(0));
              });
            });
          server.close() stops accepting new connections and waits for
          in-flight requests to complete. pool.end() drains connections
          after the last request finishes. The sequence must be ordered —
          pool.end() inside the server.close() callback, not in parallel.

---

## CHECK 2 — Connection pool limits

CHECK:    pool.js sets explicit max connections, idleTimeoutMillis,
          and connectionTimeoutMillis.
STATUS:   RISK
FINDING:  pool.js line 6 passes only connectionString to the Pool
          constructor. No max, no idleTimeoutMillis, no
          connectionTimeoutMillis is set. The pg library defaults are:
            max: 10 (connections per pool instance)
            idleTimeoutMillis: 10000 (10 seconds)
            connectionTimeoutMillis: 0 (wait forever)
          The critical gap is connectionTimeoutMillis: 0. If Cloud SQL
          is degraded or temporarily unreachable, every new request
          blocks indefinitely waiting for a connection from the pool.
          No timeout means no circuit break. Under horizontal scaling,
          10 Cloud Run instances × 10 connections = 100 connections
          against Cloud SQL with no planned budget.
FIX:      Set explicit values in pool.js:
            const pool = new Pool({
              connectionString:      process.env.DATABASE_URL,
              max:                   5,
              idleTimeoutMillis:     30000,
              connectionTimeoutMillis: 5000,
            });
          connectionTimeoutMillis: 5000 means requests fail fast (503)
          rather than hanging when Cloud SQL is unreachable. max: 5 is
          a starting point — tune against Cloud SQL tier connection limit
          divided by expected max Cloud Run instances.

---

## CHECK 3 — Request timeout

CHECK:    Database queries have a timeout to prevent hung queries
          from consuming connection pool slots indefinitely.
STATUS:   RISK
FINDING:  No statement_timeout in pool.js. No query-level timeout on
          any db.query() call. No request-level timeout middleware in
          index.js. A query that hangs (long-running lock, Cloud SQL
          hiccup, deadlock) will hold its connection slot and block
          its request handler forever. Under load, all 10 pool slots
          can be consumed by hung queries, starving all subsequent
          requests.
FIX:      Add statement_timeout to the pool configuration in pool.js:
            const pool = new Pool({
              connectionString: process.env.DATABASE_URL,
              ...,
              statement_timeout: 10000,   // 10 seconds
            });
          This instructs Postgres to cancel any query that runs longer
          than 10 seconds. The query throws an error, the catch block
          handles it, and the connection is returned to the pool.
          Fix together with CHECK 2 — both are single-line additions
          to pool.js.

---

## CHECK 4 — Firestore dead letter queue

CHECK:    Failed Firestore sync attempts have retry logic, a DLQ write,
          or documented risk acceptance.
STATUS:   RISK
FINDING:  Two locations write to Firestore. Both catch failure and
          silently discard it:

          resolverEngine.js lines 308-327: new fan record Firestore sync.
          Failure is caught, logged as logger.error, execution continues.
          No retry. No DLQ write. No flag on the fan record.

          household.js lines 358-375: new child fan Firestore sync.
          Failure is caught, logged as logger.error, execution continues.
          No retry. No DLQ write.

          The profile endpoint (GET /v1/fan/:id/profile) treats a missing
          Firestore document as empty wallet state — this masks the failure
          from callers. A fan whose Firestore sync failed silently starts
          with loyalty_points: 0, stamps: [], avatar: null and there is
          no way to know or recover without a manual audit.

          There is no alert, no queue, and no reconciliation path.
FIX:      Options in order of implementation cost:
          1. Minimal (no new infra): write a row to a new table
             firestore_sync_failures (fan_id, org_id, created_at, synced_at)
             on Firestore write failure. A cron or a background job attempts
             resync. Mark synced_at when resolved.
          2. Simple retry: wrap the Firestore write in a retry loop
             (3 attempts, exponential backoff 1s/2s/4s). Covers transient
             failures without a DLQ. Still no durable queue.
          3. Pub/Sub (Sprint 6 scope): emit Firestore write events to a
             topic and consume asynchronously with retry and DLQ.
          For now, option 2 (simple retry) is achievable without new
          infrastructure and covers the majority of transient failures.

---

## CHECK 5 — Idempotency on household endpoints

CHECK:    POST /v1/household and POST /v1/household/:adult_fan_id/members
          are protected against duplicate records from mobile retries.
STATUS:   RISK
FINDING:  POST /v1/household — PASS. App-level check at household.js
          lines 48-57 reads for an existing household before writing.
          Returns 409 with existing household_id if found. The database
          also has CREATE UNIQUE INDEX idx_household_adult_org ON
          household (adult_fan_id, org_id) as a second guard.
          Double protection — correct.

          POST /v1/household/:adult_fan_id/members — RISK. No idempotency
          mechanism. The handler at household.js lines 214-399 creates a
          new UUID for minor_fan_id on every call (gen_random_uuid() at
          line 302). A mobile retry with identical input (same first_name,
          last_name, dob, guardian_email, guardian_phone) creates a second
          child fan record with identical identifiers. The database unique
          index idx_household_member_minor_org is on (minor_fan_id, org_id)
          — it cannot prevent two different UUIDs from being created.
          There is no idempotency key header check.
FIX:      Add a client-supplied idempotency key header (X-Idempotency-Key).
          On first call, store (idempotency_key, minor_fan_id) in a
          short-lived cache or the database. On retry, return the original
          minor_fan_id without creating a new record. Alternatively, add
          a composite unique constraint on (adult_fan_id, normalized_name,
          normalized_dob, org_id) in household_member — this would block
          duplicate adds at the database level and let the app catch the
          conflict and return 409.

---

## CHECK 6 — Child JWT expiry validation

CHECK:    jwtMiddleware correctly validates exp on child session tokens.
          Child tokens have 8-hour expiry.
STATUS:   PASS
FINDING:  jwt.js line 45: const expiresAt = issuedAt + (payload.expiresIn || 15 * 60)
          signToken accepts an optional expiresIn field in the payload.
          household.js line 875 passes expiresIn: 8 * 60 * 60 (28800 seconds).
          Child tokens are issued with correct 8-hour expiry embedded in exp.
          jwt.js line 78: jwt.verify() is called without ignoreExpiration,
          so the jsonwebtoken library validates exp on every token verification.
          TokenExpiredError is caught at line 80 and throws JWTError(401).
          jwtMiddleware returns 401 on expired tokens for both adult and
          child session tokens. No gap.

---

## CHECK 7 — Health endpoint Firestore check

CHECK:    GET /health checks both Postgres and Firestore connectivity.
STATUS:   LOW
FINDING:  health.js contains three check blocks (db probe, queue depth,
          error rate) — all Postgres queries. No Firestore connectivity
          check exists. If Firestore becomes unavailable:
          - Health returns 200 "ok" (Postgres is healthy)
          - POST /v1/resolve, POST /v1/ingest/nfc, and
            POST /v1/household/:adult_fan_id/members silently drop their
            Firestore sync on new records
          - Operators see no degradation signal in the health endpoint
          This creates a false-positive health state during Firestore
          incidents. The issue surfaces only in application logs or when
          fans notice their wallet is empty.
FIX:      Add a Firestore probe block to health.js after the db blocks:
            try {
              await firestore.collection('fans')
                             .doc('__health__').get();
              results.firestore = 'connected';
            } catch (err) {
              results.firestore = 'disconnected';
              logger.error('health check firestore probe failed', { error: err.message });
            }
          Include firestore status in the isHealthy calculation and in
          the authenticated response body. Return 503 when Firestore is
          disconnected. This is low priority because Firestore failures
          are non-fatal by design, but the health signal is misleading.

---

## CHECK 8 — Email delivery

CHECK:    Component 34 age-up email is implemented, stubbed with
          documented gap, or deferred with a recorded decision.
STATUS:   LOW
FINDING:  household.js lines 1005-1011 contains a logger.info stub:
            logger.info('AGE-UP EMAIL STUB', {
              subject:    'Your child can now claim their account',
              claim_url:  'https://example.com/claim/[REDACTED]',
              expires_at: claim_expires,
              email_stub: true,
            });
          The response body includes email_stub: true (line 1033).
          The raw claim token is correctly excluded from the log
          ([REDACTED] appears in claim_url). The token is generated
          (line 967) but never communicated to anyone.
          In production, the guardian initiates age-up and nothing
          reaches them. The child can never claim their profile. The
          claim token expires in 30 days with no delivery path.
          This is acceptable for the cohort demo. It becomes a blocking
          gap before any production deployment.
FIX:      Wire a real email provider (SendGrid, SES, or Mailgun) before
          production deployment. The claim URL must include the raw
          token — never the hash. The email send must happen after
          COMMIT (already correctly structured). Email failure must
          remain non-fatal (already correctly structured). The stub
          comment at line 1005 is clear — this is the right shape,
          just needs the real send call.

---

## CHECK 9 — Dead letter queue coverage

CHECK:    Both POST /v1/resolve and POST /v1/ingest/nfc write to
          ingest_failures DLQ on normalization and resolver failures.
STATUS:   RISK
FINDING:  POST /v1/ingest/nfc — PASS. nfc.js has DLQ writes on:
          - Normalization failure (lines 63-76, reason_code: 'normalization_error')
          - Resolver failure (lines 99-113, reason_code: 'resolver_error')
          Both writes use a hashed nfc_uid payload (line 56) so raw PII
          does not persist in ingest_failures. Full coverage.

          POST /v1/resolve — RISK. resolve.js has NO DLQ writes.
          - Normalization failure (lines 41-47): returns 400, no DLQ write.
          - Resolver failure (lines 67-76): logs and returns 500, no DLQ write.
          Note: resolverEngine writes a failure row to audit_log on error
          (resolverEngine.js lines 345-355). This is an internal trace,
          not a consumer recovery queue. audit_log is append-only and
          has no replay mechanism.
          Failed resolve calls for email, phone, nba_id, ticketmaster_id,
          and other non-NFC identifiers have no recovery path. There is
          no way to identify which identifiers failed resolution after the
          fact, other than searching audit_log by status='error'.
FIX:      Add DLQ writes to resolve.js following the nfc.js pattern.
          On NormalizationError: write to ingest_failures with
          reason_code: 'normalization_error'. Do not log raw
          identifier_value — log the type only.
          On ResolverError: write to ingest_failures with
          reason_code: 'resolver_error'. Same sanitization.
          Ensure identifier_value is hashed or excluded from the
          raw_payload field before storage.

---

## CHECK 10 — Pagination on admin endpoints

CHECK:    GET /v1/admin/household/:fan_id has pagination or result limits
          to prevent unbounded payloads.
STATUS:   LOW
FINDING:  admin/household.js contains four queries, none with LIMIT:
          - READ 2 (line 39): households — no LIMIT
          - READ 3 (line 49): household_member — no LIMIT (adult or minor)
          - READ 4 (line 61): related_fans — no LIMIT (fan_id_a or fan_id_b)
          READ 1 (fan lookup) returns one row by PK — no issue.
          In normal operation, result sets are small: most fans have
          0-1 households, 0-3 children, 0-2 related_fans records.
          Edge cases that could produce larger results:
          - A minor who aged up and was then part of multiple merges
            and unmerges accumulates related_fans rows over time.
          - Repeat household_member records (active, severed, aged_up)
            for fans who change guardians.
          No pagination response shape is returned, so callers cannot
          request the next page even if needed.
          Acceptable for the cohort demo.
FIX:      Add LIMIT clauses on household_member and related_fans queries.
          For the cohort, LIMIT 50 on each is sufficient. Before scale,
          add offset pagination (or cursor-based). related_fans is the
          highest-growth table for a long-lived identity.

---

## CHECK 11 — Environment variable validation at startup

CHECK:    Required environment variables are validated at startup,
          not at first use.
STATUS:   RISK
FINDING:  JWT keys — PASS. jwt.js lines 23-27 validate JWT_PRIVATE_KEY
          and JWT_PUBLIC_KEY at module load time. Missing keys throw
          StartupError, which prevents the Cloud Run instance from
          starting. Correct behavior.

          DATABASE_URL — RISK. pool.js line 6 constructs a Pool with
          connectionString: process.env.DATABASE_URL. If DATABASE_URL
          is undefined, pg passes undefined as the connection string
          and falls back to libpq default connection parameters
          (localhost:5432, current user). The pool is created
          successfully. The failure surfaces at the first query as a
          connection error — a 500 to the first caller, not a startup
          failure. A Cloud Run instance boots and starts accepting
          traffic before discovering it cannot reach the database.

          FIRESTORE_PROJECT_ID — RISK. resolverEngine.js line 12:
          new Firestore({ projectId: process.env.FIRESTORE_PROJECT_ID }).
          If undefined, the Firestore client may use the project from
          Application Default Credentials, which could silently write
          to the wrong project in a multi-project GCP setup. Failure
          is discovered at first Firestore write, not at startup.

          CORS_ORIGIN, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS —
          index.js lines 64-65 use || fallback defaults. Missing values
          are non-fatal by design.
FIX:      Add a startup validation block to index.js before app.listen():
            const required = ['DATABASE_URL', 'FIRESTORE_PROJECT_ID'];
            for (const key of required) {
              if (!process.env[key]) {
                console.error(`FATAL: required env var ${key} is not set`);
                process.exit(1);
              }
            }
          This matches the pattern jwt.js already uses for JWT keys.
          A Cloud Run instance that exits during startup is replaced —
          broken config is caught before serving any traffic.

---

## CHECK 12 — Log sanitization

CHECK:    No PII (fan emails, phone numbers, names, DOBs) appears in
          application log output across all route files.
STATUS:   PASS
FINDING:  Reviewed all logger.error, logger.warn, and logger.info calls
          in resolve.js, nfc.js, household.js, health.js,
          resolverEngine.js, and admin/household.js.
          All log calls contain only: error messages, fan_id UUIDs,
          org_id UUIDs, correlation_id UUIDs, and internal event labels.
          identifier_value is never logged in any error or warn path.
          nfc.js line 56: nfc_uid is sha256-hashed before being stored
          in the DLQ payload — raw NFC UID does not persist in
          ingest_failures.
          household.js lines 1005-1011: age-up claim token is replaced
          with [REDACTED] in the email stub log — raw token never logged.
          resolverEngine.js line 354: logs identifier_type (the category,
          e.g. "email") but not identifier_value (the actual address).
          No PII found in any log output path.

---

## Summary

Total PASS:  2  (Check 6, Check 12)
Total FAIL:  1  (Check 1)
Total RISK:  6  (Check 2, Check 3, Check 4, Check 5, Check 9, Check 11)
Total LOW:   3  (Check 7, Check 8, Check 10)

---

## Recommended Fix Order

Priority 1 — before ANY deployment:
  CHECK 1  (FAIL)  — SIGTERM handler
                     Every deploy drops in-flight requests without this.
                     One-line server reference capture + 5-line handler.
                     index.js only.

Priority 2 — fix together, one file:
  CHECK 2  (RISK)  — Connection pool limits
  CHECK 3  (RISK)  — Statement timeout
                     Both are additions to pool.js Pool constructor.
                     One change, one file, zero risk.

Priority 3 — before production traffic:
  CHECK 11 (RISK)  — Env var startup validation
                     Missing DATABASE_URL causes first-request 500.
                     5-line startup block in index.js.

Priority 4 — data recovery coverage:
  CHECK 9  (RISK)  — DLQ writes in resolve.js
                     Pattern already exists in nfc.js — copy it.
                     resolve.js only.
  CHECK 4  (RISK)  — Firestore retry / DLQ
                     Two locations (resolverEngine.js, household.js).
                     Add 3-attempt retry with backoff before DLQ.

Priority 5 — data integrity:
  CHECK 5  (RISK)  — Household member idempotency
                     Requires a new unique constraint in a migration.
                     Coordinate with King before adding — affects fan-
                     facing behavior (duplicate member creation becomes
                     409 instead of 201).

Priority 6 — operator visibility and completeness (pre-launch):
  CHECK 7  (LOW)   — Firestore health check
                     Adds accuracy to the health endpoint.
  CHECK 8  (LOW)   — Email delivery for age-up
                     Blocks age-up flow in production. Must be wired
                     before any real age-up use.
  CHECK 10 (LOW)   — Admin endpoint pagination
                     Acceptable for demo, fix before scale.

Do not deploy to Cloud Run until Priority 1 is resolved (FAIL).
Priority 2 and 3 are single-file changes — recommend fixing in same
session before pushing to Cloud Run.
