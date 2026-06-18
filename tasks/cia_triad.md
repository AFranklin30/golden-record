# CIA Triad Security Assessment
Golden Record Fan Identity Platform
OKC Thunder — Thunder Innovations Cohort
Step 7c of 7 — Security Audit
2026-05-11

---

## Executive Summary

Golden Record entered this audit cycle with a strong security foundation: all database queries use parameterized inputs that eliminate injection, JWTs use RS256 with pinned algorithms and 15-minute expiry, fan data is segregated by organization key at every database layer, and the audit log records every state change with transaction-backed consistency. Three critical findings were resolved before this document was written, including the highest-priority cross-tenant write vulnerability on the identity resolution and NFC ingest endpoints. Two P0 findings remain open before the midpoint presentation: session.js still reads the target organization from the request body rather than the authenticated API key (TASK-16), and a development seed organization with a documented test key lives inside the production migration with no deployment guard (TASK-17). CORS configuration is blocked on the WebView domain from King and Tanner and must be confirmed before any public-facing deployment. The remaining findings are sized, assigned to sprints, and tracked in the risk register below.

---

## Confidentiality

*Can fan data be read by someone who should not have it?*

### What is protecting fan data today

**Tenant isolation by org API key.** Every request is authenticated against the `org` table using a sha256-hashed API key before any data is accessed. `request.context.org_id` — set by `orgAuthMiddleware` from the authenticated key — binds all database queries on the two write endpoints that received the TASK-01 fix (resolve.js, nfc.js). The resolver engine's Guard 1 checks that the target org exists and is active; after TASK-01, it is guaranteed to be the same org the caller authenticated as.

**Fan profile gated by dual authentication.** `GET /v1/fan/:id/profile` requires both a valid org API key and a fan JWT. The URL `fan_id` is verified against the JWT `sub` claim in the GUARD block before any database call — cross-fan profile reads are structurally blocked at the application layer.

**JWT private key isolation.** The RS256 private key is held in module scope, sourced from Secret Manager at startup, and never written to any log line or response body. A `StartupError` prevents the service from starting if the key is absent.

**Internal error details blocked from responses.** All 500 responses return generic messages. Stack traces, query details, and table names go to Cloud Logging only. The `correlation_id` is the only diagnostic value surfaced to the caller.

**Health endpoint tiered (TASK-03 ✅).** Unauthenticated callers receive only `{ status, timestamp }`. Queue depth and error rate are gated behind org authentication and invisible to unauthenticated scanners.

**No PII in log output.** Full log review confirmed no emails, phone numbers, NFC UIDs, or identifier values appear in any log call across all Sprint 1 files.

### Open risks

| Task | Finding | Severity | Sprint |
|---|---|---|---|
| TASK-04 | Full NFC tap body (nfc_uid, org_id, station_id, tapped_at) stored unredacted in `ingest_failures.raw_payload` — PII exits the operational DB in any analytics export or DLQ drain | H | Sprint 2 |
| TASK-19 | `jwtMiddleware` does not verify the JWT org claim against orgAuth context — a JWT issued for Fan A in Org A, presented with Org B's API key, passes silently and produces 404 not 403 with no audit event | M | Sprint 2 |
| TASK-05 | linked-systems post-commit query (`resolverEngine.js:160`) missing `AND org_id = $2` — source_system values for a fan are returned regardless of which org linked them | M | Sprint 2 |
| TASK-20 | Firestore wallet fields not validated before profile response — unexpected types injected via a direct Firestore write surface in the API output | L | Sprint 2 |
| Audit-err | `error_detail` in `audit_log` stores internal error messages (e.g., "org_id not found: \<uuid\>") — must not be exposed in any non-privileged read endpoint | M | Sprint 2 |
| Audit-idem | `idempotency_key` is a deterministic sha256 hash of identifier+org — with DB access, a candidate email or phone number can be confirmed as resolved by testing against stored keys | L | Sprint 2 |

### Blocked on external dependencies

**TASK-03-cors (King/Tanner):** The CORS domain has not been confirmed. Without an exact origin restriction, any web page can read fan profile data cross-origin. This is a hard production launch blocker — one environment variable away from resolution once the domain arrives.

**TASK-13 (GCP credentials):** Cloud Run ingress header logging for `Authorization` and `X-Fan-Token` cannot be verified without GCP access. Raw org API key and raw JWT in access logs are a credential exposure risk.

**TASK-20 dependency (GCP credentials):** Firestore security rules cannot be verified without GCP access. The field validation fix in profile.js is implementable immediately; rule verification is not.

---

## Integrity

*Can fan data be modified or corrupted by someone who should not?*

### What is protecting data correctness today

**All queries parameterized.** No string concatenation into any SQL string was found across all Sprint 1 files. SQL injection is structurally eliminated.

**Transaction discipline.** The resolver engine opens a transaction only after all reads confirm data is valid. The audit event is always the last write inside the transaction — any write failure rolls back the entire transaction. No database write ever exists without a corresponding audit record.

**jti uniqueness enforced (TASK-02 ✅).** `migration_002.sql` applies a partial unique index on `audit_log.jti` for session-issued events. Duplicate jti rows cannot be inserted. Sprint 2 JWT revocation depends on this guarantee and it is already in place.

**Erased fans blocked.** Both session issuance and profile reads check `deleted_at` before proceeding. An erased fan cannot receive a JWT or have their profile returned.

**Migration re-run protection.** `migration_001.sql` raises an exception on re-run against a populated database. `migration_002.sql` checks for the existing index by name before applying. Neither migration can corrupt a live schema by re-running.

**SSRF structurally blocked.** Firestore document IDs are app-generated UUIDs, never sourced from caller input. No outbound HTTP calls use user-supplied URL values anywhere in Sprint 1.

### Open risks

| Task | Finding | Severity | Sprint |
|---|---|---|---|
| TASK-17 | Dev seed org with documented test key hash in `migration_001.sql` — no deployment guard prevents it reaching production Cloud SQL | H | Now |
| TASK-10 | `audit_log` append-only is application convention only — no Postgres trigger prevents `UPDATE`/`DELETE` by an admin with direct DB access; Cloud SQL IAM is the only guard | H | Sprint 2 |
| TASK-07 | `signToken` is in-memory and cannot roll back — if the audit `INSERT` fails after signing, a live token exists with no audit record | M | Sprint 2 |
| TASK-05 | linked-systems query missing `org_id` filter — architecturally crosses tenant boundary at the read level; currently low impact due to UUID uniqueness across orgs, but wrong by design | M | Sprint 2 |
| TASK-20 | Firestore wallet data returned without field type validation — malformed types from a permissive Firestore write surface in the profile response | L | Sprint 2 |

### Blocked on external dependencies

**TASK-02-rls (GCP credentials):** Postgres Row Level Security requires a DDL migration and `SET app.org_id` at connection time. The migration is written and ready; validating against Cloud SQL without GCP credentials is not possible. This is the backstop — one query bug that omits `AND org_id` no longer exposes all tenants once RLS is in place.

**TASK-13 (GCP credentials):** Cloud Run header redaction for raw JWT in `X-Fan-Token` cannot be verified without GCP access. A token captured from access logs can be replayed within the 15-minute window.

---

## Availability

*Can the service be taken down or degraded by an attacker?*

### What is protecting service uptime today

**Rate limiter first in middleware stack.** Global rate limiter (100 req/60s, RFC 6585 headers) is the first middleware on `protectedRouter`. RSA verify and all database queries cannot execute until the rate limit passes.

**Health endpoint never throws.** Three independent try/catch blocks in `health.js` prevent any single database failure from crashing the health check. Status degrades to 503 when the DB is unreachable, DLQ is saturating (≥10,000 pending), or the resolution error rate exceeds 1% in the last 5 minutes.

**DLQ absorbs endpoint failures.** Failed NFC taps are written to `ingest_failures` rather than blocking the ingest path. The endpoint returns 400 or 500 and continues serving other callers.

**Cloud Run autoscaling.** The middleware stack is stateless. New instances can be added without coordination. Horizontal scaling is the primary relief under sustained load.

**ConflictError → 409.** Serialization failures (pgcode 40001) are caught and returned as 409, instructing the caller to retry. The service does not absorb concurrent write conflicts internally.

### Open risks

| Task | Finding | Severity | Sprint |
|---|---|---|---|
| TASK-09 | No org API key rotation endpoint — a compromised API key has no kill switch; revocation requires a direct DB `UPDATE` with no audit trail and no application-layer tooling | H | Sprint 2 |
| A04-dlq | DLQ (`ingest_failures`) has no per-org insert rate limit — a single malfunctioning or compromised station can reach the 10,000-row health check threshold and trigger 503 before the global rate limiter engages | M | Sprint 2 |
| TASK-08 / A04 | `GET /health` has no rate limiter — 3–4 DB queries per request, a polling flood causes unmetered DB load; this route sits outside `protectedRouter` by design | M | Sprint 2 |
| A04-circuit | No circuit breaker or backpressure mechanism — Cloud Run autoscaling is the only pressure relief under sustained attack; there is no per-org connection limit or request shed | M | Sprint 2 |
| TASK-14 | `station_id` is caller-supplied with no allowlist — rotating `station_id` on retry bypasses the idempotency window and creates duplicate resolution events for the same physical tap | M | Sprint 2 |
| TASK-15 | `tapped_at` not bounds-validated — far-future or epoch-zero timestamps are accepted and corrupt Bronze pipeline watermarks when the DLQ drain worker processes them | M | Sprint 2 |

### Blocked on external dependencies

**TASK-03-cors / TASK-13 (King/Tanner + GCP credentials):** Confirming Cloud Run ingress header logging and CORS behavior at the load balancer requires both the WebView domain and GCP credentials.

**BigQuery analytics layer (Surface 11):** All BQ availability findings — VPC-SC perimeter, slot quota limits, append-only export pattern — are deferred pending GCP credentials and BigQuery activation. These are pre-activation gates, not Sprint 2 backlog items.

---

## Risk Register

All open findings from STRIDE and OWASP combined, deduplicated, sorted P0 → P1 → P2.

| Task | Category | Severity | Finding | Status | Sprint |
|---|---|---|---|---|---|
| TASK-16 | A01 / A07 | P0 | `session.js` reads `org_id` from request body — cross-tenant JWT issuance with any valid API key | ✅ Mitigated | Now ✅ |
| TASK-17 | A05 | P0 | Dev seed org with documented test key in `migration_001.sql` — no production deployment guard | ✅ Mitigated | Now ✅ |
| TASK-03-cors | A05 | P0 | CORS unconfigured — any web origin can read fan profile data and establish sessions cross-origin | 🔒 Blocked | Blocked (King/Tanner) |
| TASK-02-rls | S / E | P0 | Tenant isolation is application-layer only — one query bug exposes all tenants simultaneously | ❌ Open | Sprint 2 |
| TASK-04 | I / A02 | P1 | PII unredacted in `ingest_failures.raw_payload` — full NFC tap body exits operational DB in analytics exports | ❌ Open | Sprint 2 |
| TASK-05 | I | P1 | linked-systems post-commit query missing `AND org_id` — cross-tenant source_system leak at the read level | ❌ Open | Sprint 2 |
| TASK-06 | E | P1 | No JWT revocation — stolen 15-min token has no kill switch; jti index in place but no blocklist endpoint | ⚠️ Partial | Sprint 2 |
| TASK-07 | R | P1 | `signToken` not atomic with audit INSERT — token can exist with no audit record on INSERT failure | ❌ Open | Sprint 2 |
| TASK-09 | S | P1 | No org API key rotation endpoint — compromised key has no kill switch without a direct DB update | ❌ Open | Sprint 2 |
| TASK-10 | A08 | P1 | `audit_log` has no DB-level append-only trigger — admin with Cloud SQL access can silently alter history | ❌ Open | Sprint 2 |
| TASK-19 | A07 | P1 | `jwtMiddleware` does not verify JWT org claim vs orgAuth context — cross-org JWT produces 404 not 403, no audit event | ❌ Open | Sprint 2 |
| TASK-08 | A04 | P2 | `GET /health` has no rate limiter — 3–4 DB queries per request, unbounded polling causes DB load | ❌ Open | Sprint 2 |
| TASK-11 | R | P2 | DLQ write failure emits `logger.error` only — no Cloud Monitoring alert, events disappear silently from all records | ❌ Open | Sprint 2 |
| TASK-12 | S | P2 | No `iss` / `aud` claims on JWT — cross-service token replay possible within same GCP project | ❌ Open | Sprint 2 |
| TASK-13 | I | P2 | Cloud Run header redaction for `Authorization` and `X-Fan-Token` not confirmed | 🔒 Blocked | Blocked (GCP) |
| TASK-14 | S / T | P2 | `station_id` unauthenticated — idempotency key manipulation via rotating station_id on retry | ❌ Open | Sprint 2 |
| TASK-15 | T | P2 | `tapped_at` not bounds-validated — pipeline watermark corruption via malformed timestamps | ❌ Open | Sprint 2 |
| TASK-18 | A05 | P2 | No security headers (Helmet) — `X-Powered-By: Express` exposes framework; missing HSTS, X-Content-Type-Options | ✅ Mitigated | Now ✅ |
| TASK-20 | A08 | P2 | Firestore wallet fields not validated before profile response — type injection from permissive Firestore rules | ⚠️ Partial | Sprint 2 (Blocked GCP) |
| TASK-A06 | A06 | P2 | No `npm audit` in CI pipeline — auth and crypto dependencies not scanned automatically | ❌ Open | Sprint 2 |
| TASK-A07-jwt | A09 | P2 | `jwt.js` uses bare `console.warn` not structured logger — JWT auth failures may be missed by log aggregation | ❌ Open | Sprint 2 |
| TASK-A09-corr | A09 | P2 | `correlation_id` missing from orgAuthMiddleware, jwtMiddleware, resolve.js, and resolverEngine failure logs | ❌ Open | Sprint 2 |
| A04-dlq | A04 | P2 | DLQ has no per-org insert rate limit — station flood reaches 503 threshold before global rate limiter | ❌ Open | Sprint 2 |
| A04-circuit | A04 | P2 | No circuit breaker or backpressure mechanism — autoscaling is only relief under sustained load | ❌ Open | Sprint 2 |
| Audit-err | I | P2 | `error_detail` in `audit_log` stores internal error messages — must not surface in non-privileged read endpoints | ⚠️ Partial | Sprint 2 |
| Audit-idem | I | P2 | `idempotency_key` is pattern-of-life inferable with DB access — treat as sensitive, restrict audit_log exports | ⚠️ Partial | Sprint 2 |

---

## What Was Fixed in Step 7

**TASK-01** — Cross-tenant write via `body.org_id` on resolve.js and nfc.js — both endpoints now bind `org_id` to `req.context.org_id`, set by orgAuthMiddleware from the authenticated key. Body `org_id` is dropped entirely. Confirmed via code review in Step 7b.

**TASK-02** — `jti` not unique-constrained in `audit_log` — `migration_002.sql` applies `idx_audit_jti_session_unique`, a partial unique index on `jti WHERE jti IS NOT NULL AND event_type = 'session_issued'`. Duplicate session jti rows cannot be inserted. Sprint 2 revocation prerequisite met.

**TASK-03** — Health endpoint operational intelligence disclosure — tiered response implemented in health.js: unauthenticated callers receive `{ status, timestamp }` only; `queue_depth` and `error_rate_5m` are gated behind org authentication and returned only to authenticated internal callers.

**TASK-16** — `session.js` cross-tenant JWT issuance — `const org_id = req.context.org_id` at session.js:17 binds org identity to the authenticated API key, not the request body. An additional 400 guard (session.js:21-26) explicitly rejects requests where `body.org_id` is present but does not match the authenticated org, making the mismatch visible rather than silently ignoring it.

**TASK-17** — Dev seed org with known key in `migration_001.sql` — seed INSERT moved to `migrations/seed_dev.sql`, which has a hard `DO $$ RAISE EXCEPTION $$` guard that blocks execution against any database not named with `dev`, `test`, `local`, or `staging`. `migration_001.sql` now contains only a pointer comment; no credentials ship with the production migration.
