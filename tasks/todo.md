# STRIDE Audit — Golden Record Sprint 1
# OKC Thunder · Thunder Innovations Cohort
# Date: 2026-05-11 | Auditor: Claude Sonnet 4.6
# Feeds: Step 7b (OWASP Top 10) · Step 7c (CIA Triad summary)
# Output file: tasks/stride_audit.md

---

## Audit Surfaces — 11 total

- [x] Surface 1  — POST /v1/ingest/nfc (NFC tap resolution endpoint)
- [x] Surface 2  — Org API key authentication (orgAuthMiddleware)
- [x] Surface 3  — JWT issuance and verification (jwt.js + jwtMiddleware)
- [x] Surface 4  — WebView JWT handshake (POST /v1/session → GET /v1/fan/:id/profile)
- [x] Surface 5  — Fan record merge and resolver transaction (resolverEngine.js)
- [x] Surface 6  — Dead Letter Queue (ingest_failures table)
- [x] Surface 7  — Audit log (audit_log table)
- [x] Surface 8  — Row-level tenant isolation (org_id on every table)
- [x] Surface 9  — CORS configuration (CORS_ORIGIN pending King/Tanner)
- [x] Surface 10 — Health endpoint (GET /health — no auth)
- [x] Surface 11 — BigQuery analytics layer (🔒 Deferred — not yet active)

---

## Output Checklist

- [x] tasks/stride_audit.md written — full STRIDE tables, all 11 surfaces
- [x] Risk Summary — top 5 by Likelihood × Impact
- [x] Remediation Backlog — TASK-NN format, ordered by priority, tagged with blockers
- [x] tasks/handoff.md updated — 5 lines max

---

## Key Findings Confirmed by Source Read

**Critical — must fix before any multi-org or production use:**
- [x] TASK-01: body org_id not bound to request.context.org_id (resolve.js:21, nfc.js:19)
      Fixed: org_id bound to req.context.org_id; body mismatch returns 400. 8 tests pass.

**High — fix before Sprint 2 data export or analytics:**
- [ ] TASK-02: No Postgres Row Level Security — isolation is application-layer only
- [ ] TASK-03: CORS_ORIGIN unconfigured — blocked on King/Tanner
- [ ] TASK-04: PII unredacted in ingest_failures.raw_payload (nfc.js:52)
- [ ] TASK-05: Step 5 linked-systems query missing org_id filter (resolverEngine.js:160)

**Medium — fix before Sprint 2 auth expansion:**
- [ ] TASK-06: No JWT revocation — jti blocklist deferred to Sprint 2
- [ ] TASK-07: session.js audit INSERT not transactional with signToken (session.js:49-56)
- [x] TASK-08: Health endpoint discloses queue_depth + error_rate_5m to unauthenticated callers
      Fixed: tiered response — unauthenticated gets {status, timestamp} only; authenticated gets full payload.
- [x] TASK-06-pre: jti unique constraint prerequisite — migrations/migration_002.sql created.
      Partial index: idx_audit_jti_session_unique ON audit_log(jti) WHERE event_type='session_issued'.
- [ ] TASK-09: No org API key rotation or revocation endpoint
- [ ] TASK-10: Audit log append-only at application layer only — no DB-level delete constraint
- [ ] TASK-11: DLQ write failure silently swallowed — no secondary alerting (nfc.js:53-55)
- [ ] TASK-12: iss/aud claims absent from JWT — no cross-service replay prevention (jwt.js:44)
