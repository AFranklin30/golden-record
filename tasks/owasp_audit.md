# OWASP Top 10 Audit — Golden Record Fan Identity Platform
**Golden Record**
Audit date: 2026-05-11 | Auditor: Claude Sonnet 4.6
Feeds: Step 7c (CIA Triad summary) · Sprint 2 security backlog

---

## Pre-Audit: STRIDE-Fixed Items

The following were fixed before this audit and are not re-raised as findings.

| Task | Fix | Status |
|---|---|---|
| TASK-01 | `body.org_id` → `req.context.org_id` in resolve.js:20 and nfc.js:21 | ✅ Confirmed fixed |
| TASK-02 | `idx_audit_jti_session_unique` partial index on audit_log — migration_002.sql | ✅ Confirmed applied |
| TASK-03 | Health endpoint tiered response — authenticated callers get full metrics, unauthenticated get status+timestamp only | ✅ Confirmed fixed |

---

## A01 — Broken Access Control

Files: src/middleware/orgAuthMiddleware.js, src/modules/jwt.js (jwtMiddleware), src/routes/profile.js, src/routes/resolve.js, src/routes/nfc.js, src/routes/session.js, index.js

| Finding | File | Line | Severity | Status | Remediation |
|---|---|---|---|---|---|
| **TASK-01 — body.org_id cross-tenant write on resolve + nfc** | resolve.js, nfc.js | 20, 21 | H | ✅ Mitigated | Fixed: org_id bound to req.context.org_id |
| **TASK-16 — body.org_id cross-tenant JWT issuance on session (TASK-01 incomplete)** | session.js | 17 | H | ❌ Unmitigated | `const org_id = body.org_id` must become `const org_id = req.context.org_id`. Org A can issue a valid JWT for any fan in Org B by sending Org B's UUID in the body — orgAuthMiddleware sets context to Org A but session.js ignores it. |
| **Cross-fan profile access blocked** | profile.js | 27 | H | ✅ Mitigated | `url_fan_id !== jwt_fan_id` guard at GUARD layer before any DB call |
| **Middleware stack enforced on all protected routes** | index.js | 33–40 | M | ✅ Mitigated | protectedRouter applies rateLimiter → orgAuthMiddleware → correlationIdMiddleware to all non-health routes; jwtMiddleware added per-route for fan-auth endpoints |
| **profile.js and session.js require both org API key and (profile only) fan JWT** | profile.js | 14 | M | ✅ Mitigated | profile.js adds jwtMiddleware inline at route definition; session.js is org-API-key-only (correct — session issuance precedes JWT existence) |
| **deleted_at checked before issuing session or returning profile** | session.js, profile.js | 45, 43 | M | ✅ Mitigated | Erased fans cannot receive tokens or read profiles |

**Key finding: TASK-16 is a P0 — TASK-01 was applied to two of three write endpoints. session.js was missed. A valid Org A API key + Org B fan_id + Org B UUID in body = JWT for Org B fan, bypassing all tenant isolation.**

---

## A02 — Cryptographic Failures

Files: src/modules/jwt.js, src/middleware/orgAuthMiddleware.js

| Finding | File | Line | Severity | Status | Remediation |
|---|---|---|---|---|---|
| **RS256 algorithm pinned — HS256 and none not accepted** | jwt.js | 70 | H | ✅ Mitigated | `algorithms: ['RS256']` in jwt.verify options |
| **JWT private key never logged or returned in any response** | jwt.js | 23–27 | H | ✅ Mitigated | Module-scope constant, never written to any log line, StartupError on missing key |
| **org API key stored as sha256(rawKey) only — raw key never persisted** | orgAuthMiddleware.js | 29 | H | ✅ Mitigated | `crypto.createHash('sha256').update(rawKey).digest('hex')` |
| **clockTolerance = 30s — standard OIDC window** | jwt.js | 70 | L | ✅ Mitigated | 30s is standard; 15m29s combined window is acceptable at this scale |
| **JWT keys sourced from env vars (Secret Manager in Cloud Run)** | jwt.js | 23–24 | L | ✅ Mitigated | `process.env.JWT_PRIVATE_KEY` with dotenv for local dev; Secret Manager mounts env vars in Cloud Run. Standard GCP pattern. |
| **SHA-256 without HMAC salt for org API key hash** | orgAuthMiddleware.js | 29 | L | ⚠️ Partial | Bare SHA-256 is vulnerable to rainbow tables if org_api_key_hash column leaks. For high-entropy keys (≥32 random bytes) this is impractical. Enforce minimum key entropy at key generation time (TASK-09 already covers rotation endpoint). Document minimum entropy requirement. |

---

## A03 — Injection

Files: src/modules/resolverEngine.js, src/routes/resolve.js, src/routes/nfc.js, src/routes/session.js, src/routes/profile.js, src/middleware/orgAuthMiddleware.js

| Finding | File | Line | Severity | Status | Remediation |
|---|---|---|---|---|---|
| **All database queries use parameterized placeholders ($1, $2, ...)** | All route + module files | — | H | ✅ Mitigated | No string concatenation into any SQL string found across all files |
| **normalizer.js validates and transforms identifier_value before resolverEngine** | resolve.js, nfc.js | 41–48, 45–61 | H | ✅ Mitigated | Type-checked, format-validated, normalized output reaches resolverEngine |
| **req.body passed as JSONB parameter — pg serializes, no string concat** | nfc.js | 53, 87 | M | ✅ Mitigated | `pool.query(..., [crypto.randomUUID(), org_id, body, err.message])` — pg driver serializes the JS object to JSONB safely; not concatenated into the query string |
| **No eval(), exec(), or dynamic query construction** | All files | — | H | ✅ Mitigated | Code review found no dynamic SQL or code execution patterns |
| **source_system is caller-supplied with no allowlist** | resolve.js | 19 | M | ❌ Unmitigated | `body.source_system \|\| 'unknown'` written to identifier_link.source_system. No SQL injection risk (parameterized) but arbitrary strings spoofing provenance. STRIDE TASK: source_system allowlist. |

---

## A04 — Insecure Design

Files: src/modules/resolverEngine.js, src/routes/nfc.js, src/routes/health.js, index.js

| Finding | File | Line | Severity | Status | Remediation |
|---|---|---|---|---|---|
| **station_id not authenticated — idempotency key manipulation** | nfc.js | 18, 35–38 | M | ❌ Unmitigated | STRIDE TASK-14: register station_ids per org; reject unregistered station_ids. Rotating station_id on retry bypasses idempotency window. |
| **Resolver idempotency protects same key only — unique key flood creates unlimited fan records** | resolverEngine.js | 60–78 | M | ❌ Unmitigated | STRIDE finding: no per-org fan creation rate limit. Compromised API key generates unlimited fan rows + Firestore docs. |
| **DLQ bounded only by health check threshold (10,000 rows) — no per-org insert limit** | nfc.js, health.js | 49–58, 76–80 | M | ❌ Unmitigated | STRIDE finding: burst of invalid NFC UIDs hits 503 before global rate limit. Per-org DLQ rate limit needed. |
| **GET /health has no rate limiter — 3–4 DB queries per request, unbounded** | index.js | 22 | M | ❌ Unmitigated | STRIDE TASK-08: health endpoint is on app.use() before protectedRouter. A flood of requests causes unmetered DB load. Apply lightweight rate limit (e.g., 10 req/s per IP) to /health. |
| **No circuit breaker or backpressure mechanism anywhere in the pipeline** | All files | — | M | ❌ Unmitigated | No bulkhead, no connection pool limiting per org, no request shed. Cloud Run autoscaling is the only pressure relief. |

---

## A05 — Security Misconfiguration

Files: src/routes/health.js, index.js, migrations/migration_001.sql, .env.example

| Finding | File | Line | Severity | Status | Remediation |
|---|---|---|---|---|---|
| **Health endpoint tiered response — TASK-03 confirmed closed** | health.js | 85–95 | M | ✅ Mitigated | Unauthenticated: `{ status, timestamp }` only. Authenticated: full metrics. queue_depth and error_rate_5m hidden from unauthenticated callers. |
| **No stack traces or internal error details in any HTTP response** | All routes | — | H | ✅ Mitigated | All 500 responses return generic messages; internal details logged only |
| **CORS unconfigured — no cors middleware in index.js** | index.js | — | H | 🔒 Blocked | Pending CORS domain from King/Tanner. No cors() call found in index.js. Treat as wildcard until configured. Hard production launch blocker. |
| **TASK-17 — Dev seed org with known API key hash in migration_001.sql** | migration_001.sql | 328–334 | H | ❌ Unmitigated | Seed inserts org with `sha256("dev-api-key-replace-in-prod")`. Key value is documented in the migration comment. No deployment guard prevents this reaching production Cloud SQL. Fix: add an environment check in the seed block (`DO $$ IF current_database() != 'golden-record-dev' THEN RAISE EXCEPTION ...`) or remove the seed from migration and use a separate seed script gated by environment. |
| **TASK-18 — No security headers (Helmet or equivalent)** | index.js | 19 | M | ❌ Unmitigated | No `helmet()` or manual security headers. Express 5 sends `X-Powered-By: Express` by default (reveals framework). Missing: X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security. Add `helmet()` before route mounting. |
| **Rate limiter defaults reasonable but not explicitly documented** | index.js | 27–31 | L | ✅ Mitigated | 100 req/60s default is reasonable for Sprint 1 scale; falls back from env vars. standardHeaders: true is correct (RFC 6585). |
| **express.json() without explicit body size limit** | index.js | 19 | L | ⚠️ Partial | Default 100kb limit. Explicit `express.json({ limit: '10kb' })` is better hygiene — prevents large body amplification. |
| **.env.example is empty** | .env.example | 1 | L | ⚠️ Partial | File exists but is empty. CLAUDE.md documents all required vars. Fill .env.example so new developers have a guide without needing to read CLAUDE.md first. |

---

## A06 — Vulnerable and Outdated Components

File: package.json

| Finding | Package | Version | Severity | Status | Remediation |
|---|---|---|---|---|---|
| **jsonwebtoken — auth-critical, flag for manual CVE review** | jsonwebtoken | ^9.0.3 | M | ⚠️ Partial | 9.x is the current maintained major. CVE-2022-23529 and CVE-2022-23540 affected 8.x; 9.x addresses these. Confirm ^9.0.3 resolves to ≥9.0.2 in lock file. Run `npm audit` before Sprint 2. |
| **express — framework, flag for manual review** | express | ^5.2.1 | M | ⚠️ Partial | Express 5 is current but less battle-tested than 4.x. No known critical CVEs in 5.x. Run `npm audit` before Sprint 2 deploy. |
| **pg (node-postgres) — DB driver, parameterization-critical** | pg | ^8.20.0 | L | ✅ Mitigated | 8.x is current and maintained. No known critical CVEs. |
| **express-rate-limit** | express-rate-limit | ^8.5.0 | L | ✅ Mitigated | Current maintained version. |
| **google-libphonenumber — phone normalization** | google-libphonenumber | ^3.2.44 | L | ✅ Mitigated | Google-maintained, no known security CVEs for this library. |
| **^ (caret) versions — mitigated by package-lock.json** | All | — | L | ✅ Mitigated | All dependencies use `^` allowing minor/patch updates. package-lock.json pins exact versions on install. Lock file must be committed and CI must use `npm ci` (not `npm install`) to enforce pinned versions. |
| **`npm audit` not mentioned in CI/CD pipeline** | — | — | M | ❌ Unmitigated | No evidence of automated dependency scanning. Add `npm audit --audit-level=high` to CI pipeline before Sprint 2 deploy. |

---

## A07 — Identification and Authentication Failures

Files: src/modules/jwt.js, src/middleware/jwtMiddleware.js (re-exports jwt.jwtMiddleware), src/routes/session.js, src/middleware/orgAuthMiddleware.js

| Finding | File | Line | Severity | Status | Remediation |
|---|---|---|---|---|---|
| **Token expiry enforced — 15-minute window** | jwt.js | 43, 70–72 | H | ✅ Mitigated | `expiresAt = issuedAt + 15 * 60`. TokenExpiredError caught and maps to 401. |
| **Algorithm pinned to RS256 — none and HS256 rejected** | jwt.js | 70 | H | ✅ Mitigated | `algorithms: ['RS256']` prevents algorithm confusion attacks |
| **TASK-19 — jwtMiddleware does not verify JWT org claim matches orgAuth context** | jwt.js | 99–101 | M | ❌ Unmitigated | `jwtMiddleware` attaches `fan_id` and `jti` from decoded token but never checks `claims.org_id === req.context.org_id`. A JWT issued for Fan A in Org A, presented with Org B's API key, passes jwtMiddleware silently. The DB query at profile.js:37 returns 404 (not 403) since Fan A doesn't exist in Org B. No auth-failure audit event is written. Fix: add `if (claims.org_id !== req.context.org_id) throw new JWTError('org mismatch', 403)` in jwtMiddleware. |
| **No JWT revocation in Sprint 1 — 15-minute blast radius** | jwt.js | — | M | ⚠️ Partial | STRIDE TASK-06: jti recorded in audit_log. migration_002.sql unique index in place. No revocation endpoint or blocklist check yet. Sprint 2 prerequisite. |
| **session.js sources org_id from body — TASK-16** | session.js | 17 | H | ❌ Unmitigated | Also covered in A01. Cross-org JWT issuance. |
| **Failed auth attempts logged without correlation_id** | orgAuthMiddleware.js, jwt.js | 37, 41, 104 | M | ❌ Unmitigated | STRIDE finding: auth failure logs contain only `ip` (and sometimes `org_id`). No `correlation_id`. Correlating burst-auth attempts at volume requires cross-referencing by timestamp+IP — impractical. Add `correlation_id: req.context?.correlation_id`. |
| **No per-IP lockout on auth failures — only global rate limiter** | orgAuthMiddleware.js | — | M | ⚠️ Partial | STRIDE finding: 100 req/60s global limit. Distributed brute force from many IPs can still make progress. Consider per-IP rate limiting specifically on consecutive 401s. |
| **clockTolerance = 30s — standard, documented** | jwt.js | 70 | L | ✅ Mitigated | 30s is standard OIDC practice. Combined valid window = 15m29s. |

---

## A08 — Software and Data Integrity Failures

Files: src/modules/resolverEngine.js, migrations/migration_001.sql, migrations/migration_002.sql

| Finding | File | Line | Severity | Status | Remediation |
|---|---|---|---|---|---|
| **TASK-10 — Audit log append-only enforced at application layer only — no DB trigger** | migration_001.sql | 222–241 | H | ❌ Unmitigated | STRIDE finding: no Postgres trigger prevents UPDATE/DELETE on audit_log. An admin with direct Cloud SQL access can silently alter audit history. Cloud SQL IAM is the only guard. Add trigger: `BEFORE UPDATE OR DELETE ON audit_log RAISE EXCEPTION 'audit_log is append-only'`. |
| **migration_001.sql safety guard — raises exception on re-run** | migration_001.sql | 26–36 | H | ✅ Mitigated | `DO $$ IF EXISTS (SELECT FROM information_schema.tables WHERE table_name='org') THEN RAISE EXCEPTION ...` prevents double-run on populated DB. |
| **migration_002.sql idempotency guard** | migration_002.sql | 27–49 | H | ✅ Mitigated | Checks for existing index by name; emits RAISE NOTICE and skips rather than failing. Safe re-run. |
| **No eval(), JSON.parse() of untrusted data, or unsafe deserialization** | All files | — | H | ✅ Mitigated | express.json() middleware handles body parsing; no custom deserialization found |
| **Audit event always last write in transaction — rollback on audit failure** | resolverEngine.js | 125–134 | H | ✅ Mitigated | Audit INSERT is last in transaction. If audit write fails, entire transaction rolls back — no write ever exists without audit event. |
| **TASK-20 — Firestore wallet data not validated before profile response** | profile.js | 53–58 | L | ⚠️ Partial | `firestoreDoc.data()` returned without field type validation. If Firestore security rules are permissive (known gap, blocked on GCP credentials), a direct Firestore write could inject unexpected types into `loyalty_points`, `stamps`, or `avatar` fields that surface in the profile response. Add field validation: `loyalty_points` must be number, `stamps` must be array, `avatar` must be string or null. |
| **jti unique constraint on session_issued rows — migration_002.sql applied** | migration_002.sql | 45–47 | M | ✅ Mitigated | `idx_audit_jti_session_unique` prevents duplicate jti rows for session_issued events. Sprint 2 revocation prerequisite met. |

---

## A09 — Security Logging and Monitoring Failures

Files: src/modules/resolverEngine.js, src/middleware/orgAuthMiddleware.js, src/modules/jwt.js, src/routes/nfc.js

| Finding | File | Line | Severity | Status | Remediation |
|---|---|---|---|---|---|
| **orgAuthMiddleware auth failure logs missing correlation_id** | orgAuthMiddleware.js | 37, 41 | M | ❌ Unmitigated | STRIDE finding: `{ ip: req.ip }` and `{ org_id: org.id, ip: req.ip }`. No `correlation_id`. Auth failure cannot be correlated to a specific request in high-volume logs. Add `correlation_id: req.context?.correlation_id`. |
| **jwtMiddleware auth failure log missing correlation_id and org_id** | jwt.js | 104 | M | ❌ Unmitigated | STRIDE finding: `{ reason: err.message, ip: req.ip }`. No `correlation_id` or `org_id`. JWT failures unattributable to an org or request at volume. Add `correlation_id: req.context?.correlation_id, org_id: req.context?.org_id`. |
| **resolve.js resolver failure log missing correlation_id** | resolve.js | 71 | L | ❌ Unmitigated | `{ error: err.message, org_id }`. Correlation_id present in req.context after correlationIdMiddleware. Add `correlation_id: req.context.correlation_id`. |
| **resolverEngine audit log failure log missing correlation_id** | resolverEngine.js | 184 | L | ❌ Unmitigated | `{ org_id, identifier_type, error: err.message }`. resolverEngine doesn't receive req.context directly. Pass correlation_id through resolverEngine input and log it on failure. |
| **profile.js error log includes correlation_id** | profile.js | 62–66 | M | ✅ Mitigated | `{ error, fan_id, org_id, correlation_id: req.context.correlation_id }` — correct, use as pattern for all other error logs |
| **DLQ write failures emitted via logger.error** | nfc.js | 56, 92 | M | ❌ Unmitigated | STRIDE TASK-11: DLQ write failures are logged but no Cloud Monitoring metric or alert. Silent DLQ failure = events disappear from all records. Add structured `event: 'dlq_write_failure'` label for alerting. |
| **jwt.js uses bare console.warn — inconsistent with structured logger** | jwt.js | 104 | L | ❌ Unmitigated | All other files define `const logger = { error: console.error, warn: console.warn }`. jwt.js uses `console.warn(...)` directly. Log aggregation systems filtering for structured `logger` calls may miss JWT auth failures. Replace with logger.warn or a shared logger module. |
| **No raw identifier values (emails, phone, NFC UID) found in any log output** | All files | — | H | ✅ Mitigated | Reviewed all log calls: no PII-bearing identifier values emitted to logs |
| **Audit log records every state transition — resolution success, failure, session issuance** | resolverEngine.js, session.js | 125–134, 51–56 | H | ✅ Mitigated | All terminal states produce an audit_log INSERT |

---

## A10 — Server-Side Request Forgery (SSRF)

Files: src/modules/resolverEngine.js, src/routes/profile.js

| Finding | File | Line | Severity | Status | Remediation |
|---|---|---|---|---|---|
| **resolverEngine Firestore doc ID is app-generated UUID — not user-supplied** | resolverEngine.js | 141 | H | ✅ Mitigated | `fan_id = crypto.randomUUID()` on Path B. Firestore.doc(fan_id) uses app-controlled value only. |
| **profile.js Firestore doc ID validated as UUID before call** | profile.js | 24–29, 55 | H | ✅ Mitigated | `url_fan_id` validated via UUID_RE (line 24); `jwt_fan_id === url_fan_id` equality check (line 27) before Firestore call at line 55. UUID format prevents path traversal characters. |
| **No outbound HTTP calls with user-supplied URL values** | All files | — | H | ✅ Mitigated | No axios, fetch, http.request, https.request using caller-supplied values found. Outbound calls limited to Firestore SDK (GCP endpoint, no user input in URL). |
| **Firestore document path cannot be traversed via fan_id** | resolverEngine.js, profile.js | — | M | ✅ Mitigated | Firestore SDK's doc() method accepts a document ID string. UUID format (validated) contains only hex chars and hyphens — no path separators or traversal sequences possible. |

---

## Net New Findings

Findings discovered in this OWASP pass that were **not** in the STRIDE audit.

| Task | Category | Severity | Finding | File | Line |
|---|---|---|---|---|---|
| **TASK-16** | A01 | H | session.js `body.org_id` not bound to authenticated context — TASK-01 missed this endpoint | session.js | 17 |
| **TASK-17** | A05 | H | Dev seed org with known API key hash in migration — no production deployment guard | migration_001.sql | 328–334 |
| **TASK-18** | A05 | M | No security headers (Helmet) — X-Powered-By exposes framework; no CSP/HSTS | index.js | 19 |
| **TASK-19** | A07 | M | jwtMiddleware does not verify JWT org claim matches orgAuth context — cross-org JWT produces 404 not 403, no audit event | jwt.js | 99–101 |
| **TASK-20** | A08 | L | Firestore wallet data not validated before profile response — unexpected types from permissive Firestore rules | profile.js | 53–58 |
| — | A06 | M | No `npm audit` in CI pipeline — key auth/crypto dependencies not scanned automatically | package.json | — |
| — | A09 | L | jwt.js uses bare `console.warn` instead of structured logger — JWT auth failures may be missed by log aggregation | jwt.js | 104 |
| — | A05 | L | express.json() has no explicit body size limit — default 100kb | index.js | 19 |
| — | A02 | L | SHA-256 without HMAC salt for org API key hash — rainbow tables possible if hash column leaks and keys are low-entropy | orgAuthMiddleware.js | 29 |

---

## Confirmed Mitigations

STRIDE findings that OWASP confirms are fully closed.

| STRIDE Finding | OWASP Category | Confirmation |
|---|---|---|
| TASK-01: body.org_id cross-tenant write on resolve + nfc | A01 | ✅ Confirmed fixed in resolve.js:20, nfc.js:21 |
| TASK-02: jti not unique-constrained in audit_log | A08 | ✅ Confirmed via migration_002.sql |
| TASK-03: health endpoint operational intelligence disclosure | A05 | ✅ Confirmed tiered response in health.js:85–95 |
| Algorithm confusion blocked (RS256 pinned) | A02, A07 | ✅ Confirmed jwt.js:70 `algorithms: ['RS256']` |
| JWT private key never logged | A02 | ✅ Confirmed — not present in any log call |
| org API key sha256 only | A02 | ✅ Confirmed orgAuthMiddleware.js:29 |
| fan_id URL param verified against JWT claim | A01 | ✅ Confirmed profile.js:27 |
| deleted_at checked before JWT issuance and profile | A01 | ✅ Confirmed session.js:45, profile.js:43 |
| ConflictError on pgcode 40001 correct | A04 | ✅ Confirmed resolverEngine.js:169 |
| Audit event always last write in transaction | A08 | ✅ Confirmed resolverEngine.js:125–134 |
| clockTolerance=30s acceptable | A07 | ✅ Confirmed — standard OIDC practice |
| No raw identifiers in log output | A09 | ✅ Confirmed — full log review |
| No SSRF vectors | A10 | ✅ Confirmed — no outbound HTTP from user input |
| All queries parameterized | A03 | ✅ Confirmed — full code review |

---

## Sprint 2 Security Backlog

All open and partial findings from STRIDE and OWASP combined, deduplicated, re-prioritized.
This is the handoff document for Monique.

### P0 — Fix before any multi-org or production use

**TASK-16 — Bind org_id to authenticated context in session.js**
`src/routes/session.js:17`
`const org_id = body.org_id` → `const org_id = req.context.org_id`
Parallel fix to TASK-01. An authenticated Org A caller can issue a valid JWT for any fan in Org B by sending Org B's UUID in the request body. TASK-01 was applied to resolve.js and nfc.js but this endpoint was missed.
Verify: test that body.org_id is ignored; session can only be issued for fans belonging to the authenticated org.

**TASK-01 (residual) — Verify no other endpoints source org_id from request body**
Search for `body.org_id` across the entire codebase after TASK-16 is applied. Confirm zero occurrences remain.

**TASK-02-rls — Add Postgres Row Level Security as defense-in-depth**
`new DDL migration`
RLS on fan, identifier_link, audit_log, ingest_failures: `USING (org_id = current_setting('app.org_id')::uuid)`.
One query bug that omits `AND org_id` no longer exposes all tenants. Application-layer enforcement is necessary but not sufficient for a multi-tenant system.

**TASK-03-cors — Restrict CORS to confirmed WebView origin**
`index.js (cors middleware config)`
🔒 Blocked on King/Tanner confirming the WebView domain.
Add `cors({ origin: process.env.CORS_ORIGIN })`. Treat CORS_ORIGIN=undefined as StartupError (same pattern as JWT keys).

**TASK-17 — Add production deployment guard to migration_001.sql dev seed**
`migrations/migration_001.sql:328–334`
The seed org row contains a documented dev API key hash. Options:
(a) Move the seed to a separate `seed_dev.sql` file that is never run in production.
(b) Add a guard: `DO $$ IF current_database() NOT LIKE '%dev%' AND current_database() NOT LIKE '%test%' THEN RAISE EXCEPTION 'dev seed must not run in production'; END $$;`
Production org records are inserted via admin tooling only (as documented in CLAUDE.md).

---

### P1 — Fix before Sprint 2 analytics pipeline, DLQ worker, or token revocation

**TASK-04 — Redact PII from DLQ raw_payload before insert**
`src/routes/nfc.js:52, 87`
Replace `body` with a scrubbed copy: hash or redact nfc_uid and identifier values. Retain org_id, station_id, schema_version for retry and forensics. This is the highest-impact PII exposure in Sprint 1.

**TASK-05 — Add org_id filter to linked-systems post-commit query**
`src/modules/resolverEngine.js:160`
`WHERE fan_id = $1` → `WHERE fan_id = $1 AND org_id = $2`
Cross-tenant information leak at the read level: source_system values are returned regardless of which org wrote the link.

**TASK-06 — Sprint 2 JWT revocation via jti blocklist**
`new src/routes/admin/revokeToken.js + Sprint 2 jwtMiddleware update`
jti index is in place (TASK-02). Sprint 2 revocation: check jti against a `revoked_tokens` table or audit_log revoked status on every jwtMiddleware call. 15-minute blast radius until this is implemented.

**TASK-07 — Alert on token-without-audit-record in session.js**
`src/routes/session.js:49–56`
signToken is in-memory and cannot roll back. If the audit INSERT fails after signToken, the token exists with no audit record. Emit structured log `event: 'token_without_audit'` with fan_id, org_id, jti immediately on audit INSERT failure. Cloud Monitoring alert on this label.

**TASK-10 — Add DB-level append-only trigger on audit_log**
`new DDL migration`
```sql
CREATE OR REPLACE FUNCTION prevent_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: UPDATE and DELETE are forbidden';
END $$;
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
```
Cloud SQL IAM is primary; this trigger is the backstop.

**TASK-19 — Verify JWT org claim against orgAuth context in jwtMiddleware**
`src/modules/jwt.js:99–101`
After `const claims = verifyToken(authHeader)`, add:
`if (claims.org_id !== req.context.org_id) throw new JWTError('org mismatch', 403)`
Produces explicit 403 (not 404) on cross-org JWT use and generates a warn log entry.

---

### P2 — Fix before Sprint 2 auth expansion, key management, or public launch

**TASK-08 — Move operational metrics off unauthenticated health endpoint**
`src/routes/health.js` (TASK-03 addressed tiered response; this completes the architectural split)
Health endpoint is now tiered. If the STRIDE TASK-08 recommendation to create a fully separate authenticated internal health endpoint is accepted, split GET /health into two endpoints.

**TASK-09 — Implement org API key rotation endpoint**
`new src/routes/admin/orgKeyRotate.js`
Compromised key has no kill switch. Add `key_revoked_at TIMESTAMPTZ` to org table and a POST /v1/internal/org/:id/rotate-key endpoint.

**TASK-11 — Add structured metric on DLQ write failure**
`src/routes/nfc.js:56, 92`
Replace bare logger.error with `event: 'dlq_write_failure'` structured label + Cloud Monitoring alert.

**TASK-12 — Add iss and aud claims to JWT**
`src/modules/jwt.js:44–50, 70`
Add `iss: 'golden-record'` and `aud: 'golden-record-webview'` at signing; verify at jwt.verify. Prevents cross-service token replay.

**TASK-13 — Confirm Cloud Run header redaction for Authorization and X-Fan-Token**
🔒 Blocked on GCP credentials.

**TASK-14 — Register and validate station_id per org**
`src/routes/nfc.js:18`
New DDL + validation. Prevents idempotency key manipulation.

**TASK-15 — Validate tapped_at timestamp bounds**
`src/routes/nfc.js:20`
Accept only tapped_at within ±1 hour of server NOW(). Prevents pipeline watermark corruption.

**TASK-18 — Add security headers via Helmet**
`index.js:19`
`npm install helmet` + `app.use(helmet())` before route mounting. Adds X-Content-Type-Options, X-Frame-Options, HSTS, removes X-Powered-By.

**TASK-20 — Validate Firestore wallet fields before profile response**
`src/routes/profile.js:53–58`
Add field guards: `loyalty_points` is finite number ≥ 0, `stamps` is array, `avatar` is string or null. Fall back to defaults on type mismatch. Dependency on Firestore security rules being configured (TASK-GCP-Firestore).

**TASK-A06 — Add npm audit to CI pipeline**
`package.json scripts`
Add `"audit": "npm audit --audit-level=high"` and run it in CI before Sprint 2 deploy. Key packages to confirm: jsonwebtoken ≥9.0.2, express 5.x.

**TASK-A07-jwt-logger — Replace console.warn with structured logger in jwt.js**
`src/modules/jwt.js:104`
`console.warn(...)` → `logger.warn(...)` using same pattern as all other route files.

**TASK-A09-correlation — Add correlation_id to all auth and resolver failure logs**
`src/middleware/orgAuthMiddleware.js:37, 41` · `src/modules/jwt.js:104` · `src/routes/resolve.js:71` · `src/modules/resolverEngine.js:184`
Pass `correlation_id: req.context?.correlation_id` in each log call.

---

*This audit is complete. All 10 OWASP categories evaluated against Sprint 1 source. Findings feed Step 7c (CIA Triad summary).*

*STRIDE + OWASP combined open tasks: TASK-04 through TASK-15 (STRIDE) + TASK-16 through TASK-A09-correlation (OWASP net new).*
*Three items confirmed closed: TASK-01, TASK-02, TASK-03.*
