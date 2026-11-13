# STRIDE Threat Model Audit — Golden Record Fan Identity Platform
**Golden Record**
Audit date: 2026-05-11 | Auditor: Claude Sonnet 4.6
Feeds: Step 7b (OWASP Top 10) · Step 7c (CIA Triad summary)

---

## Surface 1 — POST /v1/ingest/nfc (NFC Tap Resolution Endpoint)

Inbound: nfc_uid from hardware station · station_id caller-supplied · DLQ on normalization_error and resolver_error

| Threat | Category | Description | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|---|
| Cross-tenant write via body org_id | E / S | `org_id` read from `body.org_id` (nfc.js:19), not `request.context.org_id` set by orgAuthMiddleware. Authenticated Org A can resolve NFC taps into Org B's identity graph by sending Org B's UUID in the body. resolverEngine Guard 1 verifies the target org exists — not that the caller owns it. | H | H | Bind `org_id` to `request.context.org_id` before calling resolverEngine. Drop `body.org_id` entirely. | ❌ Unmitigated |
| station_id not authenticated — idempotency key manipulation | S / T | `station_id` is caller-supplied with no allowlist validation (nfc.js:33-36). It feeds the idempotency key: sha256(normalized_uid\|org_id\|station_id). Rotating station_id on retry bypasses the idempotency window and creates duplicate resolution events for the same physical tap. | M | M | Register station_ids per org; reject taps from unregistered station_ids with 400. | ❌ Unmitigated |
| tapped_at accepted without range validation | T | `tapped_at` from body (nfc.js:22) stored in raw_payload with no bounds check. An attacker submits far-future or epoch-zero timestamps. Excluded from idempotency key (correct), but malformed timestamps corrupt pipeline watermarks when Bronze layer reads the DLQ. | M | L | Validate `tapped_at` is within ±1 hour of server time; reject with 400 otherwise. | ❌ Unmitigated |
| DLQ write failure silently dropped | R | On normalization_error or resolver_error, the DLQ insert is wrapped in an inner try/catch (nfc.js:53-55, nfc.js:88-90) that only emits `logger.error`. If the DB is under load, the DLQ write fails silently and the failed event disappears from all records. | M | H | Emit a structured metric/alert on DLQ write failure; implement retry or dead-letter fallback. | ❌ Unmitigated |
| PII in DLQ raw_payload | I | `raw_payload` stored as `body` JSONB (nfc.js:52) contains the full request body: raw nfc_uid, org_id, station_id, tapped_at. Any future analytics export or Cloud Logging sink copies PII out of the operational DB unmasked. | H | H | Redact PII fields (nfc_uid, identifier values) before DLQ insert; store only a hash or truncated form. | ❌ Unmitigated |
| NFC UID flood fills DLQ and triggers 503 | D | Burst of invalid nfc_uid values each insert a row into ingest_failures. Health check marks 503 at 10,000 pending rows. No per-org insert rate limit. A compromised or malfunctioning station can reach threshold before the global rate limiter engages. | M | M | Per-org DLQ insert rate limit; alert on DLQ growth before health check threshold. | ❌ Unmitigated |
| Normalization error detail disclosed in 400 | I | `400` response body includes `detail: err.message` from NormalizationError (nfc.js:56). Reveals normalization logic to caller (e.g., "nfc_uid invalid length — expected 4 or 7 byte UID"). Acceptable for machine-to-machine adapters; document intentionally. | L | L | Acceptable; document as intentional design for machine adapter callers. | ⚠️ Partial |

---

## Surface 2 — Org API Key Authentication (orgAuthMiddleware)

Applies to: POST /v1/resolve, POST /v1/ingest/nfc, POST /v1/session · Does NOT apply to: GET /health

| Threat | Category | Description | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|---|
| No key rotation or revocation endpoint | S / E | The `org` table has no `key_valid_until`, `revoked_at`, or `key_version` column (migration_001.sql:60-68). A compromised org API key has no kill switch. Revoking requires a direct DB UPDATE on `org_api_key_hash` — an out-of-band operation with no application-layer endpoint, no audit trail, and no automated tooling. | M | H | Add `key_revoked_at TIMESTAMPTZ` to org table; build an admin endpoint (internal, org-auth protected) to rotate keys and write an audit event. | ❌ Unmitigated |
| Raw key length guard at 512 only | T / D | `rawKey.length > 512` guard exists (orgAuthMiddleware.js:23-25). Below 512 chars, any string is hashed and looked up. No minimum key length, no entropy check, no format validation. A short or low-entropy key passes all guards and reaches the DB lookup. | L | M | Enforce a minimum raw key length (e.g., 32 chars); document minimum entropy requirement for key generation. | ⚠️ Partial |
| DB timing side-channel on hash lookup | S | org_api_key_hash lookup uses Postgres equality (`WHERE org_api_key_hash = $1`) on a B-tree index (orgAuthMiddleware.js:31-33). Index scan timing varies by hash distribution — slightly different response times for near-miss vs. complete miss. In JS, string comparison is not the attack surface; the Postgres index scan is. Remote timing attacks against network-latency-dominated calls are extremely difficult. Risk is theoretical at this stack depth. | L | L | Document that the Postgres B-tree lookup is the timing surface, not JS string comparison; no remediation required at this time. | ✅ Mitigated |
| Org auth failure logged with IP only | R | Failed auth attempts log `{ ip: req.ip }` (orgAuthMiddleware.js:37, 41). No `correlation_id`, no `org_id` (not yet set on failure path), no `user_agent`. Credential stuffing attempts are detectable only by IP, not by behavior pattern. | M | L | Add `user_agent` and request timestamp to auth failure logs; consider structured alerting on burst of 401s from single IP. | ⚠️ Partial |
| No multi-org key leakage detection | I | One sha256 hash maps to exactly one org (UNIQUE constraint). If two orgs accidentally share a key (collision or copy-paste error), the first matched row wins silently. UNIQUE prevents this at the DB level. | L | M | UNIQUE constraint on org_api_key_hash enforces this. | ✅ Mitigated |
| Credential brute-force | D | Global rate limiter exists on protectedRouter. No per-IP or per-org lockout specifically for auth failures. A distributed brute-force from many IPs hits the global window. | M | M | Global rate limiter partially mitigates; consider per-IP rate limiting specifically on auth failures (429 on N consecutive 401s from same IP). | ⚠️ Partial |
| Authorization header logged by proxy | I | Raw org API key in `Authorization: Bearer <raw-key>` header could be logged by Cloud Run access logs or intermediate load balancer. sha256 happens inside the middleware — the raw key travels in the header to the app. | M | H | Confirm Cloud Run ingress does not log Authorization header values in access logs; configure header redaction if needed. | 🔒 Pending GCP credentials |

---

## Surface 3 — JWT Issuance and Verification (jwt.js + jwtMiddleware)

RS256 · 15-minute expiry · Secret Manager keys · X-Fan-Token header · jti in audit_log

| Threat | Category | Description | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|---|
| No iss or aud claims | S | JWT payload contains `sub`, `org`, `iat`, `exp`, `jti` (jwt.js:44-50). No `iss` (issuer) or `aud` (audience) claims. If another GCP service in the same project also accepts RS256 tokens signed with the same private key, a Golden Record token is valid there. Cross-service token replay is currently a design gap, not a live threat (no other services confirmed). | L | M | Add `iss: 'golden-record'` and `aud: 'golden-record-webview'` at signing; verify at verifyToken. | ❌ Unmitigated |
| No JWT revocation in Sprint 1 | E | Stolen or leaked token is valid for up to 15 minutes with no kill switch. `jti` is recorded in audit_log for lineage but no revocation endpoint or blocklist exists. Sprint 2 revocation hook exists in schema (jti column). | M | H | Sprint 2 revocation via jti blocklist; document 15-minute blast radius explicitly. | ⚠️ Partial |
| Algorithm confusion blocked | S | `verifyToken` explicitly pins `algorithms: ['RS256']` (jwt.js:70). `none` algorithm rejected. Algorithm confusion attacks are not possible. | L | H | Pinned algorithm list. | ✅ Mitigated |
| JWT private key never logged | I | Private key held in module-scope constant (jwt.js:23), never written to any log line, never included in any response body. StartupError prevents service start without keys (jwt.js:25-27). | L | H | Key isolation at startup. | ✅ Mitigated |
| JWT failure log missing correlation_id | R | JWT failure warn log (jwt.js:104) emits `{ reason: err.message, ip: req.ip }`. No `correlation_id` or `org_id`. Log entries cannot be correlated to a specific request without cross-referencing by timestamp + IP — impractical at volume. | M | L | Add `correlation_id: req.context?.correlation_id` and `org_id: req.context?.org_id` to the JWT failure log. | ❌ Unmitigated |
| clockTolerance=30s creates overlap window | T | `verifyToken` accepts tokens up to 30 seconds past expiry (jwt.js:70). A stolen token 14m59s into its life has a combined valid window of 15m29s. Acceptable at this scale; document explicitly. | L | L | Acceptable; 30s tolerance is standard OIDC practice. Document in CLAUDE.md. | ✅ Mitigated |
| jti not unique-constrained in audit_log | R | `jti` column in audit_log (migration_001.sql:236) has no UNIQUE constraint. A replay event writing the same jti twice would insert a second audit row rather than be detected. In Sprint 1 this is cosmetic; in Sprint 2 jti is the revocation key — duplicate jti rows would corrupt revocation state. | M | M | Add UNIQUE constraint on audit_log.jti for session_issued rows before Sprint 2 revocation. | ⚠️ Partial |
| RSA verify CPU cost without per-endpoint limiting | D | RSA verify is CPU-intensive. Global rate limiter is the only protection before jwtMiddleware on GET /v1/fan/:id/profile. Burst of concurrent invalid tokens forces repeated RSA operations. Rate limiter is correctly first in the middleware stack. | M | M | Rate limiter position is correct (first in stack); acceptable for Sprint 1 scale. | ✅ Mitigated |

---

## Surface 4 — WebView JWT Handshake (POST /v1/session → GET /v1/fan/:id/profile)

Dual-header auth on profile: Authorization: Bearer \<org-key\> + X-Fan-Token: \<raw-jwt\>

| Threat | Category | Description | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|---|
| X-Fan-Token logged by Cloud Run ingress | I / T | Raw JWT travels in the `X-Fan-Token` header. jwtMiddleware prepends `Bearer` at jwt.js:94. If Cloud Run access logs capture custom headers, the raw token appears in logs where it is retained and accessible to any log viewer. A token captured from logs can be replayed within the 15-minute window. | M | H | Confirm Cloud Run ingress does not log X-Fan-Token header; configure header redaction if it does. | 🔒 Pending GCP credentials |
| No CSRF protection on POST /v1/session | S / E | POST /v1/session accepts `fan_id` and `org_id` from the body, protected only by org API key. With permissive CORS (current state), a malicious web page in a fan's browser could trigger a session issuance for a known `fan_id` if the browser holds org credentials. Org key is machine-to-machine — not held in browser — so practical CSRF risk is low. | L | M | Document that org API key must never be exposed to browser-side code; CORS restriction (blocked on domain) adds defense-in-depth. | ⚠️ Partial |
| Session token not revocable | E | Issued JWT valid for 15 minutes. No logout endpoint. Fan cannot invalidate their own token. Attacker with captured token has full profile read access until expiry. | M | H | Sprint 2 revocation; current 15-minute window limits blast radius. | ⚠️ Partial |
| POST /v1/session audit INSERT not transactional with signToken | R | `signToken` executes at session.js:49 (in-memory, cannot roll back). The audit INSERT follows at session.js:51-56. If the INSERT fails, the token exists in the wild with no audit record. The outer catch only logs and returns 500 — the token is already signed. | L | M | Move signToken inside a DB transaction with a savepoint, or at minimum wrap signToken+INSERT atomically. If INSERT fails, emit a structured alert immediately (token-without-audit-record is a security event). | ❌ Unmitigated |
| fan_id in URL verified against JWT claim | E | GET /v1/fan/:id/profile: `url_fan_id !== jwt_fan_id` guard at profile.js:27, before any DB call. Cross-fan profile access is blocked at the GUARD layer. | L | H | In-memory guard before DB. | ✅ Mitigated |
| deleted_at checked before profile and session | S | POST /v1/session and GET /v1/fan/:id/profile both check `fan.deleted_at` before proceeding (session.js:45, profile.js:43). Erased fans cannot receive tokens or read profiles. | L | H | deleted_at guard in place. | ✅ Mitigated |
| JWT payload visible to WebView client | I | JWT payload (sub=fan_id, org=org_id) is Base64-encoded, not encrypted. A client app can decode the payload client-side — fan_id and org_id visible in the app's memory. UUIDs are not PII per se, but fan_id uniquely identifies the fan across the system. | L | L | Acceptable; document that JWT payload is not secret (only signed). | ✅ Mitigated |
| Token replay within 15-minute window | D | Attacker capturing a valid X-Fan-Token can make repeated GET /v1/fan/:id/profile calls for the full token lifetime. No per-fan or per-jti rate limiting. | M | M | Rate limit on GET /v1/fan/:id/profile per fan_id or jti; Sprint 2 revocation closes this fully. | ❌ Unmitigated |

---

## Surface 5 — Fan Record Merge and Resolver Transaction (resolverEngine.js)

Path A: hard match → UPDATE last_seen_at · Path B: new record → INSERT fan + identifier_link · Firestore sync after COMMIT

| Threat | Category | Description | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|---|
| Cross-tenant write via body org_id | E / S | Same as Surface 1. resolverEngine receives `org_id` from the caller. Both resolve.js:21 and nfc.js:19 source `org_id` from `body.org_id`. resolverEngine Guard 1 (resolverEngine.js:48-57) checks the target org exists and is active — not that the caller is that org. An authenticated Org A caller passes Org B's UUID as `org_id` and resolverEngine happily resolves into Org B's graph. | H | H | Callers must pass `request.context.org_id` — not `body.org_id` — to resolverEngine. | ❌ Unmitigated |
| source_system caller-controlled | S / T | `source_system` defaults to `"unknown"` (resolve.js:22) and is caller-supplied with no allowlist. An attacker writes any string to `identifier_link.source_system` — spoofing origin provenance (e.g., claiming `source_system: "firebase_auth"` for a manual API call). | M | M | Validate `source_system` against a registered allowlist per org; or derive from `request.context.org_name`. | ❌ Unmitigated |
| linked-systems Step 5 query missing org_id | I | Post-commit linked-systems query (resolverEngine.js:160): `SELECT DISTINCT source_system FROM identifier_link WHERE fan_id = $1` — no `org_id` filter. Source_system values for a given fan are returned regardless of which org linked them. Cross-tenant information leak — which systems linked this fan — is possible if fan_id were ever shared across orgs (UUID uniqueness prevents this today, but the query is architecturally wrong). | L | M | Add `AND org_id = $2` to the Step 5 query; pass `org_id` through. | ❌ Unmitigated |
| Firestore sync failure is non-fatal | R | After COMMIT, if Firestore sync fails for a new fan (resolverEngine.js:149-156), the error is caught, logged, and swallowed. The Postgres fan record is committed and valid. Firestore doc missing = empty wallet at profile read (profile.js:53-58). Sprint 2 reconciliation is the intended fix path. This is a known, accepted gap. | M | L | Document Sprint 2 reconciliation job; monitor Firestore sync failure rate. | ⚠️ Partial |
| Idempotency check 24-hour window | D | Idempotency lookup queries audit_log with a 24-hour window (resolverEngine.js:60-65). `idx_audit_idempotency` partial index exists. At very high volume (millions of resolutions/day), index bloat may degrade this query. Single-tenant now; monitor as volume grows. | L | M | Monitor idx_audit_idempotency size; consider audit_log partitioning by day at Sprint 2 scale. | ⚠️ Partial |
| ConflictError on pgcode 40001 (serialization failure) | T | resolverEngine.js:169 catches `err.code === '40001'` (serialization failure) and re-throws as ConflictError. This is correct for optimistic locking. Caller receives 409 and retries. | L | M | Correct handling; documented. | ✅ Mitigated |
| Fan creation rate — no per-org limit | D | Burst of unique identifiers each creates a new fan row + identifier_link row + Firestore doc. No per-org fan creation rate limit. A compromised API key can generate unlimited fan records. | M | H | Add per-org fan creation rate limit (e.g., max N new fans per minute); alert on anomalous creation bursts. | ❌ Unmitigated |
| Audit event always last write in transaction | R | Audit event INSERT is always last inside the transaction (resolverEngine.js:126-134). Audit write failure rolls back the entire transaction — no write ever exists without a corresponding audit event. | L | H | Correct by design. | ✅ Mitigated |

---

## Surface 6 — Dead Letter Queue (ingest_failures table)

Written by POST /v1/ingest/nfc on normalization_error and resolver_error · raw_payload = full inbound body

| Threat | Category | Description | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|---|
| PII in raw_payload unredacted | I | raw_payload stored as full body JSONB (nfc.js:52). Contains nfc_uid (raw, pre-normalization), org_id, station_id, tapped_at. When ingest_failures is exported to BigQuery or surfaced in analytics dashboards, PII leaves the operational DB without masking. This is the highest-impact information disclosure in Sprint 1. | H | H | Redact or hash PII fields (nfc_uid, any identifier value) before DLQ insert; retain only org_id, station_id, schema_version, and error metadata. | ❌ Unmitigated |
| DLQ write failure silently swallowed | R | DLQ insert failures (nfc.js:53-55, nfc.js:88-90) are caught and only `logger.error` is emitted. No metric, no alert, no fallback. Events disappear from all records — the audit trail has a silent gap. | M | H | Emit a Cloud Monitoring custom metric on DLQ write failure; implement secondary fallback (structured log with a queryable label). | ❌ Unmitigated |
| DLQ status lifecycle unmanaged | T | Status values `pending`, `retried`, `dead` exist in schema (migration_001.sql:299) but no Sprint 1 endpoint or worker manages the lifecycle. All failed events remain `pending` indefinitely. Health check threshold (10,000 pending) is the only circuit breaker. | M | M | Implement a DLQ drain worker or admin endpoint that reads `status='pending'` rows, re-validates, and updates to `retried` or `dead`. | ❌ Unmitigated |
| DLQ raw_payload is attacker-controlled | T | The JSONB body stored in raw_payload is entirely attacker-supplied. A future DLQ retry worker that re-POSTs `raw_payload` without re-validating fields would replay attacker data — including a manipulated `org_id`. | M | H | Re-validate all fields (especially org_id) when processing DLQ retries; never replay raw_payload directly without normalization and auth re-check. | ⚠️ Partial |
| No access controls on DLQ reads | I | No Sprint 1 endpoint reads ingest_failures. Direct DB access is the only read path. If a future admin or analytics endpoint surfaces DLQ rows without org_id-scoping, cross-tenant DLQ data is exposed. | L | H | Any future DLQ read endpoint must enforce `AND org_id = $n` from authenticated context; document this requirement now. | ⚠️ Partial |
| DLQ flood → health check 503 | D | Burst of invalid NFC taps each insert a row. At >10,000 pending, health check returns 503. 10,000 rows is reachable with a basic flood script if per-org rate limits are absent. | M | M | Per-org DLQ insert rate limit at the endpoint level; set Cloud Monitoring alert before health threshold. | ❌ Unmitigated |

---

## Surface 7 — Audit Log (audit_log table)

Append-only by convention · Contains: fan_id, org_id, match_type, idempotency_key, identifier_type, jti, error_detail

| Threat | Category | Description | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|---|
| Append-only enforced at application layer only | R | No DB trigger, constraint, or Cloud SQL audit log prevents an admin with direct DB access from DELETE-ing or UPDATE-ing audit_log rows. Cloud SQL IAM is the only guard. If Cloud SQL credentials are compromised, the audit trail can be silently altered. | M | H | Add a Postgres trigger that raises an exception on UPDATE/DELETE to audit_log; this is a one-DDL guard that cannot be bypassed without DDL access. | ❌ Unmitigated |
| error_detail stores internal error messages | I | resolverEngine.js:181 writes `err.message` as `error_detail` into audit_log on resolution failure. Messages contain internal state: "org_id not found: \<uuid\>", "resolver failure: …". If audit_log is ever exported to analytics or a non-privileged dashboard, internal system structure is disclosed. | M | M | Scrub or categorize error_detail before any audit_log export; never expose audit_log directly to a non-privileged read endpoint. | ⚠️ Partial |
| idempotency_key is a deterministic hash of PII-adjacent data | I | idempotency_key = sha256(identifier_type\|normalized_value\|org_id) (resolve.js:49-52, nfc.js:62-65). Not PII itself, but with enough audit rows, an attacker with DB access can test candidate identifiers (emails, phone numbers) against stored idempotency_key values to confirm whether a specific identifier was ever resolved by a specific org. Pattern-of-life inference is possible. | L | M | Document that idempotency_key is a one-way hash but must be treated as sensitive; restrict audit_log exports to authorized roles only. | ⚠️ Partial |
| jti not unique-constrained | R | jti column has no UNIQUE constraint. Duplicate jti rows can be inserted. In Sprint 2, jti is the revocation key — a duplicate jti row would corrupt revocation state (marking one row revoked could leave a second valid row). | M | H | Add UNIQUE constraint on audit_log.jti (partial index: WHERE jti IS NOT NULL) before Sprint 2 revocation feature. | ⚠️ Partial |
| Audit write failure rolls back transaction — correct | R | Audit INSERT is always last in the transaction (resolverEngine.js:126-134). If the audit write fails, the whole transaction rolls back. No write ever exists without an audit event. Correct by design. | L | H | Correct by design; verified. | ✅ Mitigated |
| Audit log has no row-level retention policy | I | No `deleted_at`, no TTL, no archival policy defined. audit_log grows unboundedly. At Sprint 2 scale, old rows will need archival. If rows are ever deleted for storage management without a proper archival process, audit lineage is lost. | L | M | Define audit_log retention and archival policy before Sprint 2; implement Cloud SQL export to GCS for long-term audit storage. | 🔒 Pending GCP credentials |

---

## Surface 8 — Row-Level Tenant Isolation (org_id on every table)

org_id on: fan, identifier_link, audit_log, ingest_failures · All application queries include AND org_id = $n

| Threat | Category | Description | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|---|
| Isolation is application-layer only — no Postgres RLS | T / E | No Row Level Security policies on any table. A single query bug that omits `AND org_id = $n` exposes all tenants' data. Current Sprint 1 code has org_id filters consistently, but one future developer mistake breaks isolation for every tenant simultaneously. | M | H | Add RLS policies on fan, identifier_link, audit_log, ingest_failures: `USING (org_id = current_setting('app.org_id')::uuid)`. Set `current_setting` from request.context.org_id at query time. | ❌ Unmitigated |
| Body org_id enables cross-tenant access | S / E | Root cause of the cross-tenant threat. All write endpoints (resolve.js:21, nfc.js:19) source org_id from the body, not from request.context (which reflects the authenticated org key). An org with a valid key can write into any other org's tenant. | H | H | Single fix: bind org_id to request.context.org_id on all endpoints that call resolverEngine. | ❌ Unmitigated |
| linked-systems post-commit query crosses tenant | I | resolverEngine.js:160: `SELECT DISTINCT source_system FROM identifier_link WHERE fan_id = $1` — no org_id filter. Source system names for a fan are returned regardless of which org wrote the link. This crosses the tenant boundary at the read level. | L | M | Add `AND org_id = $2` to this query; pass org_id through to the post-commit step. | ❌ Unmitigated |
| Audit log cross-tenant query possible | I | Audit events include org_id in all writes. However, no read endpoint for audit_log exists in Sprint 1. If one is added without org_id scoping, cross-tenant audit history is exposed. | L | H | Any future audit_log read endpoint must enforce `AND org_id = $n` from authenticated context; enforce at RLS layer as backstop. | ⚠️ Partial |
| DB pool shared across all tenants | D | Single connection pool (pool.js) serves all orgs. A slow query from Org A (e.g., an unindexed scan triggered by a bug) blocks Org B's connections. No per-org connection pool limits. | M | M | Cloud Run autoscaling and pool.js max connections mitigate partially; per-org pool limits not feasible in single-tenant Sprint 1. | ⚠️ Partial |

---

## Surface 9 — CORS Configuration

CORS_ORIGIN not yet configured · Domain pending from King/Tanner · Current state: treat as unconfigured wildcard

| Threat | Category | Description | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|---|
| Wildcard CORS allows any origin to read fan profile | I / S | CORS_ORIGIN not configured (blocked on King/Tanner). If the Express cors middleware runs with `origin: '*'` or no restriction, any web page can read GET /v1/fan/:id/profile responses via XHR — including fan_id, org_id, stewardship_tier, linked_systems, wallet data. | H | H | Treat unconfigured CORS as a hard production launch blocker; restrict to exact WebView origin once domain is confirmed. | 🔒 Pending CORS domain |
| Cross-origin session establishment | E | With permissive CORS, a malicious page can trigger POST /v1/session cross-origin if it somehow holds a valid org API key and a known fan_id. Org API key is machine-to-machine — not browser-accessible — but the design depends on this key never leaking to browser context. | M | H | CORS domain restriction + confirm org API key is never embedded in browser-side code. | 🔒 Pending CORS domain |
| CORS preflight bypasses auth middleware | D | Express handles OPTIONS preflight requests before auth middleware fires. A burst of OPTIONS requests from malicious origins consumes Cloud Run ingress resources. | L | M | Configure CORS max-age to minimize preflight frequency for legitimate callers; rate limit OPTIONS at ingress level. | ⚠️ Partial |
| Auth header value exposed in CORS preflight | I | If `Authorization` and `X-Fan-Token` are listed in `Access-Control-Allow-Headers` without a locked CORS origin, any origin can discover which headers the API accepts and begin credential-testing. | M | L | Lock allowed headers to minimum set; restrict origin before enabling cross-origin requests. | 🔒 Pending CORS domain |

---

## Surface 10 — Health Endpoint (GET /health)

No auth · No JWT · Returns: db status, queue_depth (ingest_failures pending count), error_rate_5m

| Threat | Category | Description | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|---|
| Operational intelligence disclosure to unauthenticated callers | I | GET /health returns `db: "connected"\|"disconnected"`, `queue_depth` (integer), `error_rate_5m` (float) (health.js). Any unauthenticated caller learns: whether the DB is up, whether the DLQ is saturating, and whether resolution is failing at a measurable rate. An attacker times attacks to DLQ-saturation events (when queue_depth approaches 10,000 and error rate is high) when the system is most degraded. | M | M | Consider returning only `status: "ok"\|"degraded"` publicly; move queue_depth and error_rate_5m to an authenticated internal health endpoint. | ❌ Unmitigated |
| Health endpoint triggers DB reads without auth | D | Each GET /health executes three DB queries (SELECT 1, COUNT ingest_failures, COUNT audit_log twice) (health.js). A crawler polling /health at high frequency causes unmetered DB load. No rate limiter on this route. | M | M | Apply a lightweight rate limit on GET /health (e.g., 10 req/s per IP); this route is exempted from the protectedRouter rate limiter by design. | ❌ Unmitigated |
| Error rate reveals resolution failure spike | I | `error_rate_5m` is computed from audit_log WHERE status='error' / total in last 5 minutes. During a DoS attack or a bug causing mass resolver failures, this value approaches 1.0 — confirming to the attacker that the attack is working. | M | L | Move error_rate_5m to the authenticated internal health endpoint only. | ❌ Unmitigated |
| Health endpoint never throws | R | Three independent try/catch blocks (health.js) prevent any single failure from crashing the health check. Results default to safe values (db="disconnected", 0, 0.0). Status correctly degrades to 503. Correct by design. | L | L | Never-throw design is correct. | ✅ Mitigated |
| DB probe confirms Cloud SQL is reachable | I | `db: "connected"` confirms to an unauthenticated caller that Cloud SQL is reachable from this Cloud Run instance and responding. Minor: this is standard health check behavior, not a material risk at this stage. | L | L | Acceptable at single-tenant scale; revisit if the endpoint becomes public-facing at broader scale. | ✅ Mitigated |

---

## Surface 11 — BigQuery Analytics Layer 🔒 Deferred

Not yet active. All findings are deferred pending GCP credentials and BigQuery activation.

| Threat | Category | Description | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|---|
| Service account key compromise | S | If the BQ service account key is stored as a file rather than using Workload Identity Federation, compromise allows an attacker to impersonate the analytics pipeline and insert or overwrite Gold-tier fan records. | M | H | Use Workload Identity Federation exclusively; never store service account key files. | 🔒 Deferred |
| BQ tables mutable by default | T | BigQuery tables are mutable. An actor with `bigquery.tables.updateData` can overwrite Gold-tier aggregated fan loyalty data — corrupting analytics without any DB-level write protection. | M | H | Apply BigQuery table ACLs; consider append-only export pattern; enable time-travel auditing. | 🔒 Deferred |
| Data Access Audit Logs not enabled by default | R | Cloud Audit Logs for BigQuery Data Access must be explicitly enabled. Without it, any analyst querying fan data leaves no access record. Must be enabled before any data lands in BQ — retroactive enablement does not capture prior access. | H | H | Enable Data Access Audit Logs for BigQuery in GCP project before first data load. This is a pre-activation gate. | 🔒 Deferred |
| PII in Gold tier without column-level security | I | identifier_link.identifier_value (emails, phone numbers, NFC UIDs) feeds the pipeline. Without column-level security policies on BQ tables, any `roles/bigquery.dataViewer` project member sees all PII. | H | H | Apply BigQuery column-level security and authorized views before populating Gold tier. | 🔒 Deferred |
| Unbounded BQ queries exhaust slot quota | D | A `SELECT *` from a large Gold fan table with no WHERE clause consumes project-wide on-demand slot quota, delaying all other analytics workloads. | M | M | Enforce query cost limits per user; require date/filter bounds on ad-hoc queries; use BI Engine reservations. | 🔒 Deferred |
| VPC-SC perimeter not configured | E | Without VPC Service Controls, the BigQuery dataset is reachable from any GCP project holding a valid service account token — including compromised external projects. | M | H | Implement VPC-SC perimeter around the BQ dataset before activation. | 🔒 Deferred |
| PII flows from DLQ raw_payload into analytics | I | If ingest_failures is exported to BQ (e.g., for DLQ retry analytics), raw_payload JSONB — which contains unredacted NFC UIDs and identifiers — arrives in BigQuery unmasked. DLP scanning would be required before any downstream use. | H | H | Redact PII from raw_payload before export (see TASK-04); apply Cloud DLP to GCS export buckets. | 🔒 Deferred |

---

## Risk Summary

Top 5 unmitigated or partially mitigated risks, ranked by Likelihood × Impact (H=3, M=2, L=1):

| Rank | Surface | Threat | L×I Score | Tracking |
|---|---|---|---|---|
| **1** | 1, 5, 8 | **Body `org_id` not bound to authenticated `request.context.org_id`** — enables full cross-tenant read/write with any valid org API key by submitting another org's UUID in the request body. resolverEngine Guard 1 verifies the target org is active, not that the caller owns it. | 9 (H×H) | TASK-01 |
| **2** | 1, 6 | **PII unredacted in `ingest_failures.raw_payload`** — full NFC tap body (nfc_uid, org_id, station_id, tapped_at) stored as JSONB with no masking. Any future analytics export copies PII out of the operational DB. | 6 (H×M raising to H when pipeline activates) | TASK-04 |
| **3** | 9 | **CORS unconfigured** — wildcard or absent CORS allows any web origin to read fan profile data and establish sessions cross-origin. Hard production launch blocker. | 6 (H×H, blocked on domain) | TASK-03 |
| **4** | 2 | **No org API key rotation or revocation** — compromised key has no kill switch; requires direct DB UPDATE with no audit trail and no application-layer endpoint. | 6 (M×H) | TASK-09 |
| **5** | 4, 3 | **Session token not revocable + audit INSERT not atomic with signToken** — stolen 15-minute token cannot be invalidated; if audit INSERT fails, the token exists in the wild with no audit record. | 4 (M×M + M×M compounded) | TASK-06, TASK-07 |

---

## Remediation Backlog

Ordered by priority. Each item is in TASK-NN format matching tasks/todo.md checkboxes.
GCP and CORS blockers flagged explicitly.

---

### P0 — Fix before any multi-org or production use

**TASK-01 — Bind org_id to authenticated context on all write endpoints**
Files: src/routes/resolve.js:21, src/routes/nfc.js:19
Replace `const org_id = body.org_id` with `const org_id = req.context.org_id` on both routes.
Drop body.org_id entirely — callers should not be able to specify which org they are acting as;
that is determined by the API key they presented to orgAuthMiddleware.
Verify: existing smoke tests must still pass; add a test that sends a mismatched body org_id and confirms it is ignored.

**TASK-02 — Add Postgres Row Level Security as defense-in-depth**
Files: new DDL migration
Add RLS policies on fan, identifier_link, audit_log, ingest_failures:
`ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;`
`CREATE POLICY org_isolation ON <table> USING (org_id = current_setting('app.org_id')::uuid);`
Set `SET app.org_id = '<uuid>'` at connection time from request.context.org_id.
This is the backstop — one query bug that omits AND org_id no longer exposes all tenants.

**TASK-03 — Restrict CORS to confirmed WebView origin**
File: Express app config (index.js or cors middleware config)
🔒 Blocked on King/Tanner confirming the WebView domain.
Once domain is confirmed: set `origin: process.env.CORS_ORIGIN` with no wildcard fallback.
Treat CORS_ORIGIN=undefined as a hard service start failure (same pattern as StartupError for JWT keys).
Verify: preflight OPTIONS from a non-allowlisted origin returns 403.

---

### P1 — Fix before Sprint 2 analytics pipeline or DLQ retry worker

**TASK-04 — Redact PII from DLQ raw_payload before insert**
File: src/routes/nfc.js:52 (and any future DLQ write sites)
Before writing raw_payload, create a scrubbed copy: replace nfc_uid and any identifier values
with `"[REDACTED]"` or a sha256 hash. Retain org_id, station_id, schema_version, tapped_at for
retry and forensic purposes. Store redacted object, not the original body reference.
Verify: DLQ row inserted with no raw identifier values; org_id and station_id still present.

**TASK-05 — Add org_id filter to linked-systems post-commit query**
File: src/modules/resolverEngine.js:160
Change: `WHERE fan_id = $1`
To: `WHERE fan_id = $1 AND org_id = $2` — pass org_id through from resolverEngine input.
Verify: resolverEngine smoke test still passes; source_system values returned are scoped to calling org.

**TASK-06 — Add UNIQUE constraint on audit_log.jti before Sprint 2 revocation**
File: new DDL migration
`CREATE UNIQUE INDEX idx_audit_jti_unique ON audit_log (jti) WHERE jti IS NOT NULL;`
Prerequisite for Sprint 2 jti blocklist revocation. Without this, duplicate jti rows corrupt revocation state.

**TASK-07 — Fix session.js: alert on token-without-audit-record**
File: src/routes/session.js:49-56
signToken cannot be rolled back (in-memory). If the audit INSERT fails, the token exists in the wild
with no audit record. This is a security event, not just a server error.
Wrap the audit INSERT failure in a structured log entry with a queryable label (e.g., `event: 'token_without_audit'`,
fan_id, org_id, jti). Set a Cloud Monitoring alert on this label so ops is paged immediately.
Long-term: Sprint 2 jti revocation closes this by providing a kill switch.

---

### P2 — Fix before Sprint 2 auth expansion or key management

**TASK-08 — Move operational metrics off the unauthenticated health endpoint**
File: src/routes/health.js
Remove `queue_depth` and `error_rate_5m` from the public GET /health response.
Return only `{ status: "ok"|"degraded", db: "connected"|"disconnected", timestamp }` publicly.
Create a new authenticated GET /v1/internal/health endpoint (orgAuthMiddleware only, no JWT) that
returns the full metrics. Health check infrastructure (Cloud Run, uptime monitors) uses the public
endpoint; internal dashboards use the authenticated endpoint.

**TASK-09 — Implement org API key rotation endpoint**
File: new src/routes/admin/orgKeyRotate.js (internal route, not exposed publicly)
Adds `key_revoked_at TIMESTAMPTZ` and `new_org_api_key_hash` to org table (DDL migration).
Endpoint: POST /v1/internal/org/:id/rotate-key — accepts new_key, hashes it, updates org row,
writes audit event, returns 200. Old key immediately invalid.
Verify: request with old key returns 401 after rotation; new key succeeds.

**TASK-10 — Add DB-level append-only guard on audit_log**
File: new DDL migration
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
Cloud SQL IAM remains the primary access control; this trigger is the backstop.

**TASK-11 — Add secondary alerting on DLQ write failure**
File: src/routes/nfc.js:53-55, src/routes/nfc.js:88-90
Replace bare `logger.error` on DLQ write failure with a structured log entry that includes
`event: 'dlq_write_failure'`, org_id, station_id, reason_code, and the original error.
Set a Cloud Monitoring alert on this label. Silent DLQ write failures are a silent audit gap —
ops must know when events are being lost.

**TASK-12 — Add iss and aud claims to JWT**
File: src/modules/jwt.js:44-50 (signToken), src/modules/jwt.js:70 (verifyToken)
At signing: add `iss: 'golden-record'` and `aud: 'golden-record-webview'` to the claims object.
At verification: add `{ issuer: 'golden-record', audience: 'golden-record-webview' }` to jwt.verify options.
Prevents cross-service token replay if another GCP service in the project uses the same RS256 key pair.

**TASK-13 — Confirm Cloud Run ingress header redaction for Authorization and X-Fan-Token**
🔒 Blocked on GCP credentials.
Verify that Cloud Run managed load balancer does not log Authorization or X-Fan-Token header values
in Cloud Logging access logs. If they are logged, configure header redaction in the Cloud Run service
settings. Raw org API key and raw JWT in access logs are a credential exposure risk.

**TASK-14 — Add station_id registration and validation per org**
File: new DDL (station table or org config column), src/routes/nfc.js
Register valid station_ids per org. Reject NFC taps from unregistered station_ids with 400.
Prevents idempotency key manipulation via rotating station_id values.
Blocked on station registration schema — Sprint 2 backlog item.

**TASK-15 — Validate tapped_at timestamp bounds**
File: src/routes/nfc.js:22
Accept tapped_at only if it is within ±1 hour of server NOW(). Reject with 400 otherwise.
Prevents far-future or epoch-zero timestamps from corrupting Bronze pipeline watermarks.

---

*This audit is complete. All 11 surfaces evaluated. Findings feed:*
- *OWASP Top 10 pass (Step 7b): TASK-01 → A01 Broken Access Control; TASK-04 → A02 Cryptographic Failures / data exposure; TASK-03 → A05 Security Misconfiguration; TASK-08 → A04 Insecure Design (operational data disclosure)*
- *CIA Triad summary (Step 7c): Confidentiality: TASK-03/04/05/13; Integrity: TASK-01/02/10/12; Availability: TASK-08/11*
