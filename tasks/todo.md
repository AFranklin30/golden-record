# Security Fixes — MEDIUM-1 through MEDIUM-5
# OKC Thunder · Golden Record Fan Identity Platform
# Session: 2026-06-02

---

## Goal

Fix four MEDIUM security findings from the security audit.
Write tests proving each fix works.

---

## Pre-read Findings

### Files read
- [x] tasks/handoff.md
- [x] src/routes/household.js
- [x] src/routes/health.js
- [x] index.js
- [x] package.json
- [x] tests/routes/household.test.js (pattern reference)

### Key facts established

**MEDIUM-1** — household.js line 1006-1011: logger.info logs raw_token in claim_url
  and `to: guardianEmail` — both are credentials/PII that must not be in Cloud Logging.

**MEDIUM-2** — household.js lines 56-88: POST /v1/household has two separate db.query
  calls for INSERT household + INSERT audit_log with no transaction. Audit failure is
  swallowed — household can exist with no audit trail. Violates CLAUDE.md audit law.

**MEDIUM-3** — index.js line 30: healthRouter is mounted with no rate limiter.
  Health runs 3 db queries per unauthenticated request. An attacker can exhaust
  db connections. Fix: 10 req/min stricter limiter on health only.

**MEDIUM-4/5** — index.js: no cors package imported or configured.
  Any origin can make cross-origin requests. Fix: cors middleware, CORS_ORIGIN env
  controls allowed origin. Default false = fail secure.

**cors not in package.json** — need npm install cors.

---

## Plan

### Step 1 — MEDIUM-1: Redact token from age-up email stub log
File: src/routes/household.js
- Remove `to: guardianEmail` from logger.info
- Change `claim_url` from full URL with raw token to `'https://fanpass.thunder.com/claim/[REDACTED]'`
- Add `email_stub: true`

### Step 2 — MEDIUM-2: Wrap POST /v1/household in transaction
File: src/routes/household.js
- Remove inner try/catch around audit INSERT
- Add `await req.db.query('BEGIN')` before household INSERT
- Make audit INSERT part of the same outer try block (not nested)
- Add `await req.db.query('COMMIT')` after audit INSERT
- Add `await req.db.query('ROLLBACK').catch(() => {})` in outer catch
- Update setupSuccessfulCreate() mock chain in tests to account for BEGIN/COMMIT

### Step 3 — MEDIUM-3: Rate limit health endpoint
File: index.js
- Create healthRateLimiter (windowMs: 60000, max: 10)
- Create healthLimitedRouter wrapping healthRouter
- Replace `app.use(healthRouter)` with `app.use(healthLimitedRouter)`

### Step 4 — MEDIUM-4/5: Configure CORS
File: index.js
- `npm install cors`
- `const cors = require('cors')`
- Mount `app.use(cors(corsOptions))` before all other middleware
- corsOptions: origin from CORS_ORIGIN env (default false), methods GET/POST/PUT/DELETE,
  allowedHeaders Content-Type/X-Api-Key/X-Fan-Token/X-Correlation-Id, credentials false

### Step 5 — Write tests
File: tests/routes/household.test.js
- Test: email stub log does not contain raw token
- Test: email stub log does not contain guardian_email
- Test: POST /v1/household rollback on audit failure — 500 returned
- Test: POST /v1/household household row does not persist if transaction rolls back

File: tests/routes/health.test.js (new)
- Test: GET /health returns 429 after 10 requests within 60 seconds

File: tests/index.test.js (new)
- Test: CORS headers present when CORS_ORIGIN is set
- Test: CORS blocks requests from unlisted origins

---

## Tasks

- [ ] Step 1 — MEDIUM-1: redact email stub log (household.js)
- [ ] Step 2 — MEDIUM-2: transaction wrap POST /v1/household (household.js)
- [ ] Step 3 — MEDIUM-3: health rate limiter (index.js)
- [ ] Step 4 — MEDIUM-4/5: CORS (npm install + index.js)
- [ ] Step 5 — Tests (household.test.js, health.test.js, index.test.js)
- [ ] Run npm test — all pass
- [ ] Update tasks/lessons.md
- [ ] Update tasks/handoff.md

---

## Constraints

- Never fix a test to match broken code — fix code to match test
- Audit event is always last write in transaction — CLAUDE.md law
- CORS default must be false — fail secure not fail open
- Health rate limiter is separate from the global one (stricter)
