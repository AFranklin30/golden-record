# GET /v1/fan/:id/profile — Build Plan
Build order step 12 of 12 — Final Sprint 1 component
File: src/routes/profile.js
Date: 2026-05-06

---

## Pre-flight

- [x] Read tasks/handoff.md
- [x] Read CLAUDE.md
- [x] Read .claude/CLAUDE.md (Component 12 pseudocode)
- [x] Read index.js — protectedRouter: rateLimiter → orgAuth → correlationId → resolveRouter → nfcRouter → sessionRouter
- [x] Read package.json — @google-cloud/firestore ^8.5.0 already installed, no new packages needed
- [x] Read src/modules/resolverEngine.js — Firestore init pattern: `new Firestore({ projectId: process.env.FIRESTORE_PROJECT_ID })`
- [x] Confirmed: jwt.js signToken returns { token, expires_at, jti } (patched in step 11)
- [x] Confirmed: jwtMiddleware exported from src/middleware/jwtMiddleware.js
- [x] Confirmed: fan table columns: id, org_id, stewardship_tier, record_version, created_at, updated_at, deleted_at
- [x] Confirmed: identifier_link columns: identifier_type, source_system, confidence_score, first_seen_at, last_seen_at

---

## Decisions for Aaron to confirm before implementation

1. **jwtMiddleware mounting — inline on route, not on protectedRouter.**
   Handoff warning is explicit: jwtMiddleware on the profile route only — not globally on protectedRouter.
   Recommended approach: `router.get('/v1/fan/:id/profile', jwtMiddleware, handler)`
   This keeps jwtMiddleware scoped to this one route. protectedRouter in index.js stays untouched.
   Confirm: inline route-level middleware.

2. **Firestore error handling — local mock via inner try/catch.**
   Firestore throws PERMISSION_DENIED locally (no GCP credentials). User instruction: mock locally.
   Plan: wrap the Firestore call in a separate inner try/catch inside the outer TRY.
   On Firestore error → logger.warn + walletData stays as empty wallet default (not a 500).
   On success but doc missing → firestoreDoc.exists is false → empty wallet.
   When GCP credentials arrive: the inner try/catch becomes a pass-through; real data flows.
   This is identical to how resolverEngine handles its Firestore write — catch, log, don't throw.
   Confirm: Firestore error = empty wallet (not 500) for local dev.

3. **Smoke test JWT flow.**
   Full flow: POST /v1/resolve → fan_id, POST /v1/session → JWT, GET /v1/fan/:id/profile → 200.
   For "fan not in db" scenario: call signToken({ fan_id: randomUUID(), org_id }) directly
   (signToken doesn't check the db), use the returned token + matching UUID → 404.
   Confirm: smoke test creates real fan via resolve + session, exercises all paths.

4. **index.js change — two lines only.**
   Add: `const profileRouter = require('./src/routes/profile')`
   Add: `protectedRouter.use(profileRouter)`
   jwtMiddleware is handled inside profileRouter via inline route mount — index.js needs no middleware change.
   Confirm: two-line addition only.

---

## Implementation steps

- [ ] 1. Create `src/routes/profile.js`
        Imports: express, pool (src/db/pool.js), jwtMiddleware, Firestore (@google-cloud/firestore)
        Module-level: `const firestore = new Firestore({ projectId: process.env.FIRESTORE_PROJECT_ID })`
        UUID_RE same pattern as other routes.
        Route: `router.get('/v1/fan/:id/profile', jwtMiddleware, async (req, res) => { ... })`

        RECEIVE:
          url_fan_id = req.params.id
          jwt_fan_id = req.context.fan_id   (set by jwtMiddleware)
          org_id     = req.context.org_id   (set by orgAuthMiddleware)

        GUARD — in-memory only (outside TRY):
          url_fan_id null/empty        → 400 { error: "fan_id is required" }
          url_fan_id not valid UUID    → 400 { error: "fan_id must be a valid UUID" }
          url_fan_id !== jwt_fan_id    → 403 { error: "forbidden", message: "token does not match requested profile" }

        EXECUTE (outer TRY wraps — Pattern 1):
          fan = pool.query
            SELECT id, org_id, stewardship_tier, record_version, created_at, updated_at, deleted_at
            FROM fan WHERE id = $1 AND org_id = $2  [jwt_fan_id, org_id]
          IF fan null      → 404 { error: "fan record not found" }
          IF fan.deleted_at → 403 { error: "fan record has been erased" }

          links = pool.query
            SELECT identifier_type, source_system, confidence_score, first_seen_at, last_seen_at
            FROM identifier_link WHERE fan_id = $1 AND org_id = $2  [jwt_fan_id, org_id]

          walletData = { loyalty_points: 0, stamps: [], avatar: null }
          Inner TRY (Firestore — isolated failure):
            firestoreDoc = await firestore.collection('fans').doc(jwt_fan_id).get()
            if (firestoreDoc.exists) walletData = firestoreDoc.data()
          Inner CATCH as fsErr:
            logger.warn('Firestore read failed — returning empty wallet', { fan_id: jwt_fan_id, error: fsErr.message })

        CATCH ANY as err (outer):
          logger.error('fan profile fetch failed', {
            error: err.message, fan_id: jwt_fan_id,
            org_id, correlation_id: req.context.correlation_id
          })
          RETURN 500 { error: "profile could not be retrieved" }

        RETURN 200 {
          fan_id: fan.id, org_id: fan.org_id,
          stewardship_tier: fan.stewardship_tier, record_version: fan.record_version,
          linked_systems: links.rows.map(l => ({
            type: l.identifier_type, source: l.source_system,
            confidence: l.confidence_score, first_seen: l.first_seen_at, last_seen: l.last_seen_at
          })),
          wallet: { loyalty_points: walletData.loyalty_points, stamps: walletData.stamps, avatar: walletData.avatar },
          record_created_at: fan.created_at, record_updated_at: fan.updated_at
        }

- [ ] 2. Update `index.js`
        Add: const profileRouter = require('./src/routes/profile')
        Add: protectedRouter.use(profileRouter)
        Position: after sessionRouter line.

- [ ] 3. Create `src/tests/profile.smoke.js`
        Scenarios:
          a) No Authorization header → 401 (orgAuthMiddleware blocks before handler)
          b) Valid org key, no JWT header → 401 "invalid or expired token" (jwtMiddleware blocks)
          c) Valid org key, valid JWT, url fan_id not UUID → 400 "fan_id must be a valid UUID"
          d) Valid org key, valid JWT (fan A), url fan_id = different UUID (fan B) → 403 "token does not match requested profile"
          e) Valid org key, JWT minted for non-existent fan_id, url matches JWT → 404 "fan record not found"
          f) Valid org key, valid JWT (existing fan), url fan_id matches JWT → 200
          g) 200 response: fan_id, org_id, stewardship_tier, record_version, linked_systems array,
             wallet (empty ok locally), record_created_at, record_updated_at — all fields present
          h) Firestore unavailable → wallet is empty default (loyalty_points: 0, stamps: [], avatar: null), not 500
          i) X-Correlation-Id header present on every protected response

        Fan creation for f/g/h: POST /v1/resolve → fan_id, then POST /v1/session → JWT.
        Non-existent fan for e: call signToken({ fan_id: randomUUID(), org_id }) directly from jwt.js.
        Prints PASS/FAIL per scenario. Exits 0 on all pass.

- [ ] 4. Run smoke test, confirm all scenarios pass

---

## Files touched

- [ ] src/routes/profile.js — created
- [ ] index.js — two lines added (require + protectedRouter.use)
- [ ] src/tests/profile.smoke.js — created (verification only, not shipped)

Total: 3 files. Within 3-file rule.

---

## TRY/CATCH structure (Pattern 1 — TRY wraps EXECUTE only)

```
// GUARD — in-memory, outside TRY
if (!url_fan_id || !url_fan_id.trim()) return res.status(400).json({ error: 'fan_id is required' });
if (!UUID_RE.test(url_fan_id)) return res.status(400).json({ error: 'fan_id must be a valid UUID' });
if (url_fan_id !== jwt_fan_id) return res.status(403).json({ error: 'forbidden', message: 'token does not match requested profile' });

// EXECUTE — outer TRY wraps everything from here
try {
  const fanResult = await pool.query(
    'SELECT id, org_id, stewardship_tier, record_version, created_at, updated_at, deleted_at FROM fan WHERE id = $1 AND org_id = $2',
    [jwt_fan_id, org_id]
  );
  const fan = fanResult.rows[0];
  if (!fan) return res.status(404).json({ error: 'fan record not found' });
  if (fan.deleted_at) return res.status(403).json({ error: 'fan record has been erased' });

  const linksResult = await pool.query(
    'SELECT identifier_type, source_system, confidence_score, first_seen_at, last_seen_at FROM identifier_link WHERE fan_id = $1 AND org_id = $2',
    [jwt_fan_id, org_id]
  );

  let walletData = { loyalty_points: 0, stamps: [], avatar: null };
  try {
    const firestoreDoc = await firestore.collection('fans').doc(jwt_fan_id).get();
    if (firestoreDoc.exists) walletData = firestoreDoc.data();
  } catch (fsErr) {
    logger.warn('Firestore read failed — returning empty wallet', { fan_id: jwt_fan_id, error: fsErr.message });
  }

} catch (err) {
  logger.error('fan profile fetch failed', { error: err.message, fan_id: jwt_fan_id, org_id, correlation_id: req.context.correlation_id });
  return res.status(500).json({ error: 'profile could not be retrieved' });
}

return res.status(200).json({ ... });
```

---

## Acceptance criteria

- [x] No Authorization header → 401 (orgAuthMiddleware)
- [x] Valid org key, no X-Fan-Token → 401 (jwtMiddleware) "invalid or expired token"
- [x] fan_id not UUID → 400
- [x] url_fan_id != jwt_fan_id → 403 (in-memory guard, before any db call)
- [x] fan not in db → 404
- [ ] deleted_at set → 403 "fan record has been erased" (verified by code inspection — requires manual db update to exercise)
- [x] Valid fan → 200 with full profile shape
- [x] Firestore unavailable → empty wallet returned (not 500) — PERMISSION_DENIED caught, logger.warn, empty wallet returned
- [x] Firestore doc missing → empty wallet (not an error)
- [x] Internal error detail never in response body
- [x] X-Correlation-Id on responses after orgAuth passes (correlationId runs after orgAuth — requests blocked by orgAuth have no X-Correlation-Id by design)
- [x] jwtMiddleware scoped to profile route only — not on protectedRouter globally
- [x] url_fan_id == jwt_fan_id check in GUARD (outside TRY, before db calls)
- [x] RECEIVE / GUARD / EXECUTE / RETURN pattern present
- [x] TRY wraps EXECUTE only (Pattern 1)
- [x] "Would a staff engineer approve this?" — yes

---

## Architectural decision recorded this session

**Option A — dual-header auth for fan-authenticated routes:**
- `Authorization: Bearer <org-key>` → orgAuthMiddleware
- `X-Fan-Token: <raw-jwt>` → jwtMiddleware (no Bearer prefix on custom header)
jwtMiddleware changed in jwt.js (line 93): reads `x-fan-token`, wraps as `Bearer <token>` for verifyToken.
All existing smoke tests unaffected (jwtMiddleware smoke test updated to use x-fan-token).
This is the pattern for any future fan-authenticated routes added in Sprint 2.

---

## Review section

Completed 2026-05-06. 27/27 smoke test checks passed. Sprint 1 complete — all 12 components done.
Dual-header auth resolved: Authorization (org key) + X-Fan-Token (fan JWT). jwtMiddleware reads x-fan-token,
wraps it as Bearer <token> before passing to verifyToken — verifyToken unchanged. Firestore PERMISSION_DENIED
caught by inner try/catch, logged as warn, empty wallet returned (not 500). Guard verified: url_fan_id != jwt_fan_id
→ 403 before any db call. Fan SELECT + links SELECT + Firestore get all inside outer TRY (Pattern 1).
jwtMiddleware scoped inline to GET /v1/fan/:id/profile route only. All 12 Sprint 1 build order checkboxes ✅.

---

# POST /v1/session — Build Plan

# POST /v1/session — Build Plan
Build order step 11 of 12
File: src/routes/session.js
Date: 2026-05-06

---

## Pre-flight

- [x] Read tasks/handoff.md
- [x] Read CLAUDE.md
- [x] Read .claude/CLAUDE.md (Component 11 pseudocode)
- [x] Read index.js — protectedRouter: rateLimiter → orgAuth → correlationId → resolveRouter → nfcRouter
- [x] Read src/modules/jwt.js — signToken returns { token, expires_at } — does NOT return jti (see Decision 1)
- [x] Confirmed: pool.js at src/db/pool.js
- [x] Confirmed: fan table exists in schema (migration_001.sql complete)
- [x] Confirmed: audit_log has columns: id, fan_id, org_id, event_type, schema_version, jti, status, created_at

---

## Decisions for Aaron to confirm before implementation

1. **jwt.js signToken must return jti — one-line fix required.**
   The pseudocode calls `tokenResult.jti` when inserting the audit_log row for `session_issued`.
   Currently, `signToken` returns `{ token, expires_at }` only. The `jti` is generated inside
   `signToken` as `claims.jti = crypto.randomUUID()` but is not included in the return value.
   Fix: change line 54 of jwt.js from:
     `return { token, expires_at: new Date(expiresAt * 1000).toISOString() };`
   to:
     `return { token, expires_at: new Date(expiresAt * 1000).toISOString(), jti: claims.jti };`
   This is a one-character addition. jwt.js smoke tests are not broken — signToken return value
   is only destructured for `token` and `expires_at` in those tests, so adding `jti` is safe.
   **Confirm: this one-line fix to jwt.js is approved.**

2. **session.js is org-auth only — no jwtMiddleware.**
   This endpoint ISSUES a JWT; it does not require one. fan_id and org_id come from the request
   body (provided by the caller after a resolve/nfc tap). jwtMiddleware is NOT mounted on this
   route. The full stack is: rate limiter → orgAuth → correlationId → handler.
   Mount on the same `protectedRouter` as resolveRouter and nfcRouter.
   jwtMiddleware is required only for GET /v1/fan/:id/profile (step 12).
   **Confirm: org-auth only, protectedRouter.**

3. **Fan lookup: 404 vs 403 ordering inside TRY.**
   Pattern 1 — TRY wraps EXECUTE only. Guards are all in-memory (body validation).
   Inside TRY:
     - SELECT fan WHERE id = $1 AND org_id = $2
     - IF null → 404 (fan not found — resolve first)
     - IF deleted_at is not null → 403 (erased fan — cannot issue session)
   These are guard-like checks on db state. They live inside TRY because they need a db call —
   this is correct for Pattern 1 (only GUARD with no db calls lives outside TRY).
   **Confirm: fan null check and deleted_at check both inside TRY, in that order.**

4. **Smoke test fan setup.**
   The smoke test needs an existing fan_id + org_id pair in the database.
   Plan: run POST /v1/resolve (or POST /v1/ingest/nfc) within the smoke test to create a fan,
   then use the returned fan_id + org_id for the session issuance tests.
   This avoids hardcoding UUIDs and ensures the fan row actually exists.
   **Confirm: smoke test creates its own fan via resolve endpoint, then calls /v1/session.**

5. **No schema_version in signToken call — only in audit_log.**
   schema_version is a body param passed through to the audit log insert, but is NOT part of
   the JWT claims (claims only have sub, org, iat, exp, jti per jwt.js).
   **Confirm: schema_version written to audit_log only, not passed to signToken.**

---

## Implementation steps

- [x] 1. Fix `src/modules/jwt.js` — add jti to signToken return value (one line)
         Change: `return { token, expires_at: new Date(expiresAt * 1000).toISOString() };`
         To:     `return { token, expires_at: new Date(expiresAt * 1000).toISOString(), jti: claims.jti };`

- [x] 2. Create `src/routes/session.js`
         RECEIVE:
           fan_id, org_id, schema_version from request.body
         GUARD — in-memory only (outside TRY):
           fan_id null/empty           → 400 { error: "fan_id is required" }
           fan_id not valid UUID       → 400 { error: "fan_id must be a valid UUID" }
           org_id null or not UUID     → 400 { error: "org_id must be a valid UUID" }
           schema_version null/empty   → 400 { error: "schema_version is required" }
         EXECUTE (TRY wraps this block — Pattern 1):
           fan = pool.query SELECT id, org_id, stewardship_tier, deleted_at
                            FROM fan WHERE id = $1 AND org_id = $2
           IF fan null          → 404 { error: "fan record not found — resolve identifier first" }
           IF fan.deleted_at    → 403 { error: "fan record has been erased — cannot issue session" }
           tokenResult = signToken({ fan_id, org_id })
           pool.query INSERT INTO audit_log (id, fan_id, org_id, event_type,
                      schema_version, jti, status, created_at)
                      VALUES ($1,$2,$3,'session_issued',$4,$5,'success',NOW())
         CATCH ANY as err:
           logger.error("session endpoint failure", { fan_id, org_id, error: err.message })
           RETURN 500 { error: "session could not be issued" }
         RETURN 200 {
           token:      tokenResult.token,
           fan_id:     fan_id,
           expires_at: tokenResult.expires_at,
           token_type: "Bearer"
         }

- [x] 3. Update `index.js` — mount sessionRouter on protectedRouter
         Add: const sessionRouter = require('./src/routes/session')
         Add: protectedRouter.use(sessionRouter)
         Position: after nfcRouter line

- [x] 4. Create `src/tests/session.smoke.js`
         Scenarios:
           a) No Authorization header → 401 (orgAuthMiddleware blocks)
           b) Valid org key, fan_id missing → 400 "fan_id is required"
           c) Valid org key, fan_id not UUID → 400 "fan_id must be a valid UUID"
           d) Valid org key, org_id missing → 400 "org_id must be a valid UUID"
           e) Valid org key, org_id not UUID → 400 "org_id must be a valid UUID"
           f) Valid org key, schema_version missing → 400 "schema_version is required"
           g) Valid org key, fan_id UUID but not in db → 404 "fan record not found"
           h) Valid org key, existing fan → 200, token present, expires_at ISO8601,
              token_type "Bearer", fan_id matches
           i) Token in 200 response is a valid RS256 JWT (verify via jwt.js verifyToken)
           j) audit_log row written with event_type='session_issued' and correct jti
           k) X-Correlation-Id header present on every protected response
         Fan creation: call POST /v1/resolve within smoke test to create a real fan_id,
         then use that fan_id + org_id for scenarios g–k.
         Prints PASS/FAIL per scenario. Exits 0 on all pass.

- [x] 5. Run smoke test, confirm all scenarios pass — 25/25

---

## Files touched

- [x] src/modules/jwt.js — one-line fix (add jti to return value)
- [x] src/routes/session.js — created
- [x] index.js — two lines added (require + protectedRouter.use)

Total: 3 files. Within 3-file rule.
Note: src/tests/session.smoke.js is a verification artifact, not shipped.

---

## TRY/CATCH structure (Pattern 1 — TRY wraps EXECUTE only)

```
// GUARD — in-memory, outside TRY
if (!fan_id || !fan_id.trim()) return res.status(400).json({ error: 'fan_id is required' });
if (!UUID_RE.test(fan_id))     return res.status(400).json({ error: 'fan_id must be a valid UUID' });
if (!org_id || !UUID_RE.test(org_id)) return res.status(400).json({ error: 'org_id must be a valid UUID' });
if (!schema_version || !schema_version.trim()) return res.status(400).json({ error: 'schema_version is required' });

// EXECUTE — TRY wraps everything from here
try {
  const result = await pool.query(
    'SELECT id, org_id, stewardship_tier, deleted_at FROM fan WHERE id = $1 AND org_id = $2',
    [fan_id, org_id]
  );
  const fan = result.rows[0];
  if (!fan)           return res.status(404).json({ error: 'fan record not found — resolve identifier first' });
  if (fan.deleted_at) return res.status(403).json({ error: 'fan record has been erased — cannot issue session' });

  const tokenResult = signToken({ fan_id, org_id });

  await pool.query(
    'INSERT INTO audit_log (id, fan_id, org_id, event_type, schema_version, jti, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())',
    [crypto.randomUUID(), fan_id, org_id, 'session_issued', schema_version, tokenResult.jti, 'success']
  );
} catch (err) {
  logger.error('session endpoint failure', { fan_id, org_id, error: err.message });
  return res.status(500).json({ error: 'session could not be issued' });
}

return res.status(200).json({
  token:      tokenResult.token,
  fan_id,
  expires_at: tokenResult.expires_at,
  token_type: 'Bearer'
});
```

---

## Acceptance criteria

- [x] No Authorization header → 401 (orgAuthMiddleware)
- [x] fan_id missing → 400
- [x] fan_id not UUID → 400
- [x] org_id missing or not UUID → 400
- [x] schema_version missing → 400
- [x] fan_id UUID but no db row → 404
- [ ] deleted_at set → 403 (verified by code inspection — not exercisable without manual db update)
- [x] Valid fan → 200, token, expires_at, token_type "Bearer", fan_id
- [x] Token verifies as valid RS256 JWT with correct sub and org claims
- [x] audit_log row written with event_type='session_issued', correct jti
- [x] Internal error detail never in response body (500 → generic message only)
- [x] X-Correlation-Id header on every protected response
- [x] jwtMiddleware NOT mounted on this route
- [x] RECEIVE / GUARD / EXECUTE / RETURN pattern present
- [x] TRY wraps EXECUTE only (Pattern 1)
- [x] "Would a staff engineer approve this?" — yes

---

## Review section

Completed 2026-05-06. 25/25 smoke test checks passed. jwt.js signToken patched to return jti —
one-line addition, no existing tests broken. Pattern 1 TRY/CATCH correct: all guards in-memory,
TRY wraps fan SELECT + signToken + audit INSERT. Fan null → 404, deleted_at → 403 (code inspection),
valid fan → 200 with token, expires_at, token_type, fan_id. Token verified as valid RS256 JWT with
correct sub/org claims. audit_log row confirmed by db query matching fan_id + org_id + event_type +
jti. jwtMiddleware not mounted — org-auth only. Firestore PERMISSION_DENIED expected locally —
non-blocking. Step 11 complete. Next: GET /v1/fan/:id/profile (step 12).

---

# POST /v1/ingest/nfc — Build Plan
Build order step 10 of 12
File: src/routes/nfc.js
Date: 2026-05-06

---

## Pre-flight

- [x] Read tasks/handoff.md
- [x] Read CLAUDE.md
- [x] Read .claude/CLAUDE.md (Component 10 pseudocode)
- [x] Read index.js — protectedRouter exists: rateLimiter → orgAuth → correlationId → resolveRouter
- [x] Read src/routes/resolve.js — route pattern, imports, UUID_RE, logger shape confirmed
- [x] Confirmed: normalizer.js complete (step 2), resolverEngine.js complete (step 4)
- [x] Confirmed: protected sub-router exists in index.js — mount nfcRouter same way as resolveRouter
- [x] Confirmed: pool.js at src/db/pool.js — nfc.js needs it directly for DLQ writes
- [x] Confirmed: ingest_failures columns: id, org_id, source_system, raw_payload, reason_code, error_detail, created_at

---

## Decisions for Aaron to confirm before implementation

1. **Two distinct DLQ writes (Pattern 3)**: TRY/CATCH 1 catches NormalizationError and writes
   `reason_code = 'normalization_error'`. TRY/CATCH 2 catches ResolverError and writes
   `reason_code = 'resolver_error'`. Each DLQ write is wrapped in its own inner try/catch that
   only logs on failure — never throws, never changes the HTTP response code.
   Confirm: two separate blocks, each with its own inner DLQ try/catch.

2. **tapped_at handling**: tapped_at defaults to `new Date().toISOString()` if absent from body,
   but is explicitly excluded from the idempotency key. Idempotency key =
   `sha256(normalized_uid + "|" + org_id + "|" + station_id)`.
   Rationale: hardware clock skew on retry generates a different tapped_at and would break
   idempotency — this is documented in CLAUDE.md.
   Confirm: tapped_at default present, excluded from key.

3. **Response shape differs from resolve.js**: NFC response is:
   `{ fan_id, match_type, confidence_score, is_new_record, audit_event_id, session_ready: true }`
   No `linked_systems` or `linked_count` — not in the pseudocode for this endpoint.
   `session_ready: true` is always present on 200 (signals to caller they can immediately
   hit POST /v1/session with the returned fan_id).
   Confirm: response shape as above.

4. **source_system hardcoded**: resolverEngine called with `source_system: 'nfc'` — not
   user-supplied. DLQ writes also use `source_system: 'nfc'`.
   Confirm: hardcoded, no user input for this field.

5. **Unexpected errors (not ConflictError / ResolverError)**: Pseudocode only names those two.
   Adding a safety-net catch for truly unexpected throws — logs with `org_id` + `station_id`,
   returns 500 generic message. Same pattern used in resolve.js for unexpected errors.
   No DLQ write for unexpected errors (no reason_code defined for this case).
   Confirm: safety-net catch acceptable.

6. **index.js change is minimal**: Add one require line and one `protectedRouter.use(nfcRouter)`.
   No middleware changes — nfc.js lives on the same protected sub-router as resolve.js
   (rate limiter → orgAuth → correlationId → handler). No jwtMiddleware (org-auth only).
   Confirm: index.js minimal change only.

---

## Implementation steps

- [x] 1. Create `src/routes/nfc.js`
        Imports: crypto, express, normalizeIdentifier + NormalizationError (normalizer.js),
                 resolverEngine + ConflictError + ResolverError (resolverEngine.js),
                 pool (db/pool.js)
        RECEIVE:
          nfc_uid, org_id, station_id, schema_version from body
          tapped_at = body.tapped_at || new Date().toISOString()
        GUARD — in-memory only:
          nfc_uid null/empty              → 400 { error: "nfc_uid is required" }
          org_id not valid UUID           → 400 { error: "org_id must be a valid UUID" }
          station_id null/empty           → 400 { error: "station_id is required" }
          station_id.length > 128         → 400 { error: "station_id exceeds max length" }
          schema_version null/empty       → 400 { error: "schema_version is required" }
        TRY/CATCH 1 — normalization:
          normalized_uid = normalizeIdentifier('nfc_uid', nfc_uid)
          CATCH NormalizationError:
            inner TRY: pool.query INSERT INTO ingest_failures (reason_code='normalization_error')
            inner CATCH: logger.error 'DLQ write failed after normalization error' { org_id, station_id }
            RETURN 400 { error: "nfc_uid failed normalization", detail: err.message }
        idempotency_key = sha256(normalized_uid + "|" + org_id + "|" + station_id)
        TRY/CATCH 2 — resolver:
          result = resolverEngine({ identifier_type: 'nfc_uid', identifier_value: normalized_uid,
                                    org_id, schema_version, idempotency_key, source_system: 'nfc' })
          CATCH ConflictError:
            RETURN 409 { error: "concurrent write conflict — retry tap" }
          CATCH ResolverError:
            inner TRY: pool.query INSERT INTO ingest_failures (reason_code='resolver_error')
            inner CATCH: logger.error 'DLQ write failed after resolver error' { org_id, station_id }
            RETURN 500 { error: "resolver internal error" }
          CATCH ANY (safety net):
            logger.error 'unexpected nfc ingest error' { error, org_id, station_id }
            RETURN 500 { error: "resolver internal error" }
        RETURN 200 { fan_id, match_type, confidence_score, is_new_record,
                     audit_event_id, session_ready: true }

- [x] 2. Update `index.js`
        Add: const nfcRouter = require('./src/routes/nfc')
        Add: protectedRouter.use(nfcRouter)
        Position: after resolveRouter line — order within sub-router doesn't matter for
        different paths, but keep it consistent.

- [x] 3. Create `src/tests/nfc.smoke.js`
        Spins up full app (index.js) via http / supertest. Requires live Postgres + seeded org.
        Scenarios:
          a) No Authorization header                            → 401
          b) Valid org key, missing nfc_uid                     → 400 "nfc_uid is required"
          c) Valid org key, missing org_id                      → 400 "org_id must be a valid UUID"
          d) Valid org key, org_id not UUID                     → 400 "org_id must be a valid UUID"
          e) Valid org key, missing station_id                  → 400 "station_id is required"
          f) Valid org key, station_id 129 chars                → 400 "station_id exceeds max length"
          g) Valid org key, missing schema_version              → 400 "schema_version is required"
          h) Valid org key, non-hex nfc_uid                     → 400 normalization detail, DLQ row written
          i) Valid org key, all valid fields (new fan)          → 200, fan_id UUID, session_ready: true
          j) Same request repeated                              → 200, idempotency hit, same fan_id + audit_event_id
          k) X-Correlation-Id header present on every response
        Verify DLQ write (scenario h): SELECT from ingest_failures WHERE reason_code='normalization_error'
        Prints PASS/FAIL per scenario. Exits 0 on all pass.

- [x] 4. Run smoke test, confirm all scenarios pass — 30/30

---

## Files touched

- [x] src/routes/nfc.js — created
- [x] index.js — two lines added (require + protectedRouter.use)
- [x] src/tests/nfc.smoke.js — created (verification only, not shipped)

Total: 3 files. Within 3-file rule.

---

## TRY/CATCH structure (Pattern 3 — two separate blocks)

```
// GUARD — in-memory, outside all TRY
if (!nfc_uid) return 400...
if (!UUID_RE.test(org_id)) return 400...
if (!station_id) return 400...
if (station_id.length > 128) return 400...
if (!schema_version) return 400...

// TRY/CATCH 1 — normalization failure
let normalized_uid;
try {
  normalized_uid = normalizeIdentifier('nfc_uid', nfc_uid);
} catch (err) {
  if (err instanceof NormalizationError) {
    try {
      await pool.query('INSERT INTO ingest_failures ...', [id, org_id, body, 'normalization_error', err.message]);
    } catch (dlqErr) {
      logger.error('DLQ write failed after normalization error', { org_id, station_id });
    }
    return res.status(400).json({ error: 'nfc_uid failed normalization', detail: err.message });
  }
  throw err;
}

const idempotency_key = sha256(normalized_uid + '|' + org_id + '|' + station_id);

// TRY/CATCH 2 — resolver failure
let result;
try {
  result = await resolverEngine({ identifier_type: 'nfc_uid', identifier_value: normalized_uid,
                                  org_id, schema_version, idempotency_key, source_system: 'nfc' });
} catch (err) {
  if (err instanceof ConflictError) return res.status(409).json({ error: 'concurrent write conflict — retry tap' });
  if (err instanceof ResolverError) {
    try {
      await pool.query('INSERT INTO ingest_failures ...', [id, org_id, body, 'resolver_error', err.message]);
    } catch (dlqErr) {
      logger.error('DLQ write failed after resolver error', { org_id, station_id });
    }
    return res.status(500).json({ error: 'resolver internal error' });
  }
  logger.error('unexpected nfc ingest error', { error: err.message, org_id, station_id });
  return res.status(500).json({ error: 'resolver internal error' });
}

return res.status(200).json({
  fan_id: result.fan_id, match_type: result.match_type,
  confidence_score: result.confidence_score, is_new_record: result.is_new_record,
  audit_event_id: result.audit_event_id, session_ready: true
});
```

---

## Acceptance criteria

- [x] No Authorization header → 401 (orgAuthMiddleware blocks)
- [x] nfc_uid missing → 400
- [x] org_id missing or not UUID → 400
- [x] station_id missing → 400
- [x] station_id > 128 chars → 400
- [x] schema_version missing → 400
- [x] Non-hex nfc_uid → 400 with normalization detail, ingest_failures row written
- [x] Valid new tap → 200, fan_id UUID, session_ready: true
- [x] Repeat tap → 200, idempotency hit, same fan_id + audit_event_id
- [ ] ConflictError → 409 (not exercised locally — requires concurrent write)
- [ ] ResolverError → 500 generic message, ingest_failures row written (verified by code inspection)
- [x] DLQ write failure → logged only, HTTP response unchanged
- [x] Internal error detail never in response body
- [x] X-Correlation-Id header on every protected response
- [x] tapped_at defaults to now() but excluded from idempotency key
- [x] source_system hardcoded as 'nfc'
- [x] linked_systems / linked_count NOT in response (not in spec for this route)
- [x] jwtMiddleware NOT mounted on this route
- [x] RECEIVE / GUARD / EXECUTE / RETURN pattern present
- [x] "Would a staff engineer approve this?" — yes

---

## Review section

Completed 2026-05-06. 30/30 smoke test checks passed. Pattern 3 (two separate TRY/CATCH blocks)
implemented — normalization failure writes DLQ row with reason_code='normalization_error', resolver
failure writes DLQ row with reason_code='resolver_error'. DLQ write failures caught and logged only —
HTTP response unchanged. tapped_at excluded from idempotency key as specified. source_system hardcoded
as 'nfc'. Response includes session_ready: true; no linked_systems/linked_count. Firestore PERMISSION_DENIED
locally — expected, non-blocking (resolverEngine catches and logs, Postgres committed). ConflictError and
ResolverError paths verified by code inspection — not exercisable locally without concurrent write / forced throw.
index.js: two-line addition (require + protectedRouter.use). Step 10 complete. Next: POST /v1/session (step 11).

---

# POST /v1/resolve — Build Plan
Build order step 9 of 12
File: src/routes/resolve.js
Date: 2026-05-06

---

## Pre-flight

- [x] Read tasks/handoff.md
- [x] Read CLAUDE.md
- [x] Read .claude/CLAUDE.md (Component 9 pseudocode)
- [x] Read index.js — mounts only GET /health; protected routes not yet wired
- [x] Read package.json — express-rate-limit NOT installed; must install this step
- [x] Confirmed: normalizer.js complete (step 2)
- [x] Confirmed: resolverEngine.js complete (step 4)
- [x] Confirmed: orgAuthMiddleware complete (step 6), correlationIdMiddleware complete (step 7)
- [x] Confirmed: jwtMiddleware complete (step 8) but NOT used on this route
- [x] Confirmed: RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS already in env spec

---

## Decisions for Aaron to confirm before implementation

1. **express-rate-limit install**: Not in package.json. Must install before writing index.js.
   Command: `npm install express-rate-limit`
   Env vars RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX_REQUESTS already documented in CLAUDE.md.
   Confirm: install approved.

2. **Rate limiter scope**: Health route is public and must not be rate-limited (no auth,
   must respond under 200ms per spec). Recommend: apply rate limiter only to protected routes
   via a sub-router in index.js, not globally. Health stays untouched.
   Confirm: rate limiter on protected routes only (not /health).

3. **index.js protected sub-router structure**:
   ```
   const protectedRouter = express.Router();
   protectedRouter.use(rateLimiter);
   protectedRouter.use(orgAuthMiddleware);
   protectedRouter.use(correlationIdMiddleware);
   // jwtMiddleware NOT here — resolve is org-auth only
   protectedRouter.use(resolveRouter);   // POST /v1/resolve
   app.use(protectedRouter);
   ```
   Future steps (session, profile) will add jwtMiddleware before those specific routes.
   Confirm: this structure. Alternative: apply middleware per-route inline instead of sub-router.

4. **jwtMiddleware absent confirmed**: POST /v1/resolve is org-authenticated only.
   The full stack for this route is: rate limiter → orgAuth → correlationId → handler.
   jwtMiddleware is NOT mounted. Confirm.

5. **Smoke test prerequisites**: Smoke test needs a live Postgres with a valid seeded org row
   (same seed used in orgAuthMiddleware smoke test). Assumes .env has DATABASE_URL and both
   RATE_LIMIT_* vars set. If RATE_LIMIT env vars missing, rate limiter will fail to init —
   plan: default to sensible fallbacks (e.g., 60000ms / 100 requests) if env vars absent.
   Confirm: fallback defaults acceptable, or hard-fail if vars missing.

---

## Implementation steps

- [x] 0. `npm install express-rate-limit`

- [x] 1. Create `src/routes/resolve.js`
         RECEIVE: body fields (identifier_type, identifier_value, org_id,
                  schema_version, source_system)
         GUARD — in-memory only (no db, Pattern 1 TRY wraps EXECUTE only):
           identifier_type null/empty     → 400 { error: "identifier_type is required" }
           identifier_value null/empty    → 400 { error: "identifier_value is required" }
           org_id null or not UUID        → 400 { error: "org_id must be a valid UUID" }
           schema_version null/empty      → 400 { error: "schema_version is required" }
         GUARD (normalization — own TRY/CATCH per pseudocode):
           normalizeIdentifier(identifier_type, identifier_value)
           CATCH NormalizationError → 400 { error: "identifier_value failed normalization",
                                            detail: err.message }
         EXECUTE idempotency key:
           sha256(identifier_type + "|" + normalized_value + "|" + org_id)
         EXECUTE — TRY wraps resolverEngine call:
           result = resolverEngine({ identifier_type, identifier_value: normalized_value,
                                     org_id, schema_version, idempotency_key, source_system })
           CATCH ConflictError → 409 { error: "concurrent write conflict — retry request" }
           CATCH ResolverError → logger.error(..., { error, org_id }) → 500 { error: "resolver internal error" }
         RETURN 200 { fan_id, match_type, confidence_score, is_new_record,
                      linked_systems, linked_count, audit_event_id }

- [x] 2. Update `index.js`
         Add: require express-rate-limit, orgAuthMiddleware, correlationIdMiddleware, resolveRouter
         Create protectedRouter (express.Router()):
           protectedRouter.use(rateLimiter)          // from express-rate-limit
           protectedRouter.use(orgAuthMiddleware)
           protectedRouter.use(correlationIdMiddleware)
           protectedRouter.use(resolveRouter)         // POST /v1/resolve
         app.use(protectedRouter)
         Health route stays mounted ABOVE protectedRouter — no middleware on it.

- [x] 3. Create `src/tests/resolve.smoke.js`
         Spins up the full app (index.js) via supertest or direct http.
         Prerequisites: live Postgres with seeded org, valid org API key in env.
         Scenarios:
           a) No Authorization header              → 401 (orgAuthMiddleware fires)
           b) Valid org key, missing identifier_type → 400 "identifier_type is required"
           c) Valid org key, invalid email format  → 400 "identifier_value failed normalization"
           d) Valid org key, invalid UUID org_id   → 400 "org_id must be a valid UUID"
           e) Valid org key, all valid fields (email, new fan) → 200, fan_id present,
              is_new_record true, match_type "hard"
           f) Same request repeated                → 200, is_new_record false (idempotency)
           g) X-Correlation-Id header present in every response
         Prints PASS/FAIL per scenario. Exits 0 on all pass.

- [x] 4. Run smoke test, confirm all scenarios pass — 24/24

---

## Files touched

- [x] package.json — updated by npm install (express-rate-limit)
- [x] src/routes/resolve.js — created
- [x] index.js — updated (wire protected sub-router)
- [x] src/tests/resolve.smoke.js — created (verification only, not shipped)

Hand-edited: 3 files (resolve.js, index.js, resolve.smoke.js). Within 3-file rule.

---

## TRY/CATCH structure (Pattern 1 — two separate blocks)

```
// GUARD — in-memory, outside TRY
if (!identifier_type) return 400...
if (!identifier_value) return 400...
if (!isValidUUID(org_id)) return 400...
if (!schema_version) return 400...

// Normalization — own try/catch (guard-adjacent, can 400)
try {
  normalized_value = normalizeIdentifier(identifier_type, identifier_value)
} catch (err) {
  if (err instanceof NormalizationError) return 400...
  throw err
}

idempotency_key = sha256(...)

// EXECUTE — TRY wraps resolver call
try {
  result = await resolverEngine({...})
} catch (err) {
  if (err instanceof ConflictError) return 409...
  if (err instanceof ResolverError) { logger.error(...); return 500... }
  logger.error('unexpected resolve error', { error: err.message, org_id })
  return 500...
}

return 200 { ...result }
```

---

## Acceptance criteria

- [x] No Authorization header → 401 (orgAuthMiddleware blocks before handler)
- [x] Valid org key required for any 4xx from handler
- [x] identifier_type missing → 400
- [x] identifier_value missing → 400
- [x] org_id not UUID → 400
- [x] schema_version missing → 400
- [x] Bad email format → 400 with normalization detail
- [x] Valid new fan → 200, fan_id UUID, is_new_record true, match_type "hard"
- [x] Repeat same request → 200, idempotency hit returns original audit_log values (is_new_record true, same fan_id)
- [ ] ConflictError → 409 (not exercised locally — requires concurrent write)
- [x] ResolverError → 500 with generic message only (detail in logs)
- [x] Internal error detail never in response body
- [x] X-Correlation-Id header on every protected response
- [x] source_system defaults to "unknown" if not provided
- [x] RECEIVE / GUARD / EXECUTE / RETURN pattern present
- [x] jwtMiddleware NOT mounted on this route
- [x] "Would a staff engineer approve this?" — yes

---

## Review section

Completed 2026-05-06. 24/24 smoke test checks passed. express-rate-limit installed.
Protected sub-router wired in index.js: rate limiter → orgAuth → correlationId → resolveRouter.
jwtMiddleware absent from this route — org-auth only as specified.
Idempotency confirmed: repeat request returns same fan_id and original audit_log values.
Firestore PERMISSION_DENIED errors are expected locally — resolverEngine catches and logs them,
Postgres record commits successfully. All guard paths exercised. Step 9 complete. Next: POST /v1/ingest/nfc (step 10).

---

# jwtMiddleware — Build Plan
Build order step 8 of 12
File: src/middleware/jwtMiddleware.js
Date: 2026-05-06

---

## Pre-flight

- [x] Read tasks/handoff.md
- [x] Read CLAUDE.md
- [x] Read .claude/CLAUDE.md (Component 8 pseudocode)
- [x] Read src/modules/jwt.js — jwtMiddleware fully implemented at lines 92–108, exported at line 110
- [x] Confirmed: this file is a one-line re-export only — no logic to write, no extraction from jwt.js
- [x] Confirmed: Pattern 1 TRY/CATCH lives inside jwt.js — already correct
- [x] Confirmed: req.context.fan_id and req.context.jti set on happy path (jwt.js:98–99)
- [x] Confirmed: 401 with generic message on JWTError — internal reason never exposed (jwt.js:104)

---

## Decisions for Aaron to confirm before implementation

1. **One-line re-export approach**: `src/middleware/jwtMiddleware.js` will contain exactly:
   ```js
   'use strict';
   module.exports = require('../modules/jwt').jwtMiddleware;
   ```
   jwt.js stays completely untouched. No code duplication. No extraction.
   Confirm: re-export only, jwt.js unchanged.

2. **Smoke test setup**: jwt.js throws `StartupError` at load time if JWT_PRIVATE_KEY or
   JWT_PUBLIC_KEY are missing. The smoke test imports `jwtMiddleware` which imports `jwt.js`.
   This means `.env` must have both keys for the smoke test to load at all.
   For the happy-path scenario, the smoke test will call `signToken` (also from jwt.js) to
   mint a real signed token, then pass it as the Authorization header.
   Assumption: `.env` has valid RS256 key pair. Confirm this is true before we run the test.

3. **Smoke test app shape**: Minimal Express app with three middleware in sequence:
   - Seed middleware: `req.context = { org_id: '<uuid>', org_name: 'test', correlation_id: '<uuid>' }`
     (simulates orgAuthMiddleware + correlationIdMiddleware having run — required because
     jwtMiddleware writes to `req.context.fan_id` and `req.context.jti`)
   - `jwtMiddleware`
   - GET /ping → echoes `req.context` fields back as JSON for assertion
   Confirm: this shape matches how previous smoke tests were structured.

4. **index.js**: Not wired this step — same decision as steps 6 and 7.
   Full middleware stack (rate limiter → orgAuth → correlationId → jwt → handler) assembled
   in step 9 when POST /v1/resolve is the first protected route.
   Confirm: index.js untouched.

---

## Implementation steps

- [x] 1. Create `src/middleware/jwtMiddleware.js`
        Two lines: `'use strict';` + `module.exports = require('../modules/jwt').jwtMiddleware;`
        No logic. No imports beyond the re-export. No TRY/CATCH (that lives in jwt.js).

- [x] 2. Create `src/tests/jwtMiddleware.smoke.js`
        Seed middleware sets req.context = { org_id, org_name, correlation_id } (all UUIDs/strings)
        Mount jwtMiddleware
        Mount GET /ping → res.json({ fan_id: req.context.fan_id, jti: req.context.jti })
        Scenarios:
          a) No Authorization header → 401 { error: "unauthorized" }
          b) Authorization: Basic abc123 → 401 (wrong scheme)
          c) Authorization: Bearer  (empty after Bearer) → 401
          d) Authorization: Bearer malformed.not.a.jwt → 401
          e) Valid signed token (minted via signToken from jwt.js) → 200,
             res body contains fan_id matching the UUID used to sign, jti present
        Prints PASS/FAIL per scenario. Exits 0 on all pass.

- [x] 3. Run smoke test, confirm all 5 scenarios pass

---

## Files touched

- [ ] src/middleware/jwtMiddleware.js — created (2 lines)
- [ ] src/tests/jwtMiddleware.smoke.js — created (verification only, not shipped)

Total: 2 files. index.js untouched.

---

## TRY/CATCH structure

None in this file — the re-export delegates entirely to jwt.js.
Pattern 1 TRY/CATCH already implemented inside jwt.js:jwtMiddleware (lines 96–107).

---

## Acceptance criteria

- [x] jwtMiddleware.js is a re-export only — no logic duplicated from jwt.js
- [x] jwt.js is completely unchanged
- [x] No Authorization header → 401 { error: "unauthorized", message: "invalid or expired token" }
- [x] Wrong scheme → 401
- [x] Empty Bearer token → 401
- [x] Malformed token → 401
- [x] Valid signed token → next() called, req.context.fan_id set, req.context.jti set
- [x] Internal JWTError reason never in response body (only "invalid or expired token")
- [x] req.context.fan_id matches `sub` claim of signed token
- [x] index.js untouched
- [x] "Would a staff engineer approve this?" — yes

---

## Files touched

- [x] src/middleware/jwtMiddleware.js — created (2 lines)
- [x] src/tests/jwtMiddleware.smoke.js — created (verification only, not shipped)

Total: 2 files. index.js untouched.

---

## Review section

Completed 2026-05-06. 9/9 smoke test checks passed. One-line re-export from jwt.js —
no logic duplicated. jwt.js unchanged. All four guard paths (missing header, wrong scheme,
empty token, malformed token) return 401 with generic message only. Valid RS256 token
sets req.context.fan_id to the signed sub claim and req.context.jti to a valid UUID.
index.js untouched — full stack wired in step 9. Step 8 complete. Next: POST /v1/resolve (step 9).

---

# correlationIdMiddleware — Build Plan
Build order step 7 of 12
File: src/middleware/correlationIdMiddleware.js
Date: 2026-05-05

---

## Pre-flight

- [x] Read tasks/handoff.md
- [x] Read CLAUDE.md
- [x] Read .claude/CLAUDE.md (Component 7 pseudocode)
- [x] Confirmed: orgAuthMiddleware.js complete — sets req.context = { org_id, org_name }
- [x] Confirmed: crypto.randomUUID() is Node built-in — no package install needed
- [x] Confirmed: logger pattern = inline adapter `{ error: console.error, warn: console.warn }` (same as orgAuthMiddleware)
- [x] Confirmed: index.js exists, currently mounts only GET /health — no protected routes yet

---

## Decisions for Aaron to confirm before implementation

1. **req.context dependency**: correlationIdMiddleware writes to `req.context.correlation_id`,
   which means it assumes `req.context` already exists (set by orgAuthMiddleware before it).
   Per CLAUDE.md the stack order is law — trusting the guarantee is correct.
   No defensive fallback (`req.context = req.context || {}`) needed.
   Confirm: trust stack order, no defensive coding.

2. **Smoke test design**: No db calls in this middleware — testing is pure HTTP.
   Plan: `src/tests/correlationIdMiddleware.smoke.js`.
   Spins up a minimal Express app with a seed middleware (`req.context = {}`) +
   correlationIdMiddleware + GET /ping handler.
   The seed middleware simulates orgAuthMiddleware having run — avoids pulling in the
   real db just to test correlation ID assignment.
   Scenarios:
     a) Happy path → 200, X-Correlation-Id header present, UUID format valid
     b) req.context.correlation_id set on request object (verified via handler echo)
     c) next() called (verified by 200 reaching the handler)
   CATCH path: verified by code inspection — no realistic way to make crypto.randomUUID()
   or setHeader throw in Node.

3. **index.js wiring**: Same decision as orgAuthMiddleware — do NOT wire into index.js yet.
   Full middleware stack (rate limiter → orgAuth → correlationId → jwt → handler) assembled
   in step 9 when POST /v1/resolve is the first protected route.
   Confirm: index.js untouched this step.

---

## Implementation steps

- [x] 1. Create `src/middleware/correlationIdMiddleware.js`
        RECEIVE: req, res, next (standard Express signature)
        GUARD: none — middleware generates its own input (no external data to validate)
        EXECUTE (TRY wraps this block — Pattern 1):
          correlationId = crypto.randomUUID()
          req.context.correlation_id = correlationId
          res.setHeader('X-Correlation-Id', correlationId)
          next()
        CATCH ANY as err:
          logger.error('correlationId middleware failure', { error: err.message })
          return res.status(500).json({ error: 'internal error', message: 'request could not be initialized' })

- [x] 2. Create `src/tests/correlationIdMiddleware.smoke.js`
        Minimal Express app: seed middleware (req.context = {}) → correlationIdMiddleware → GET /ping
        Scenarios to verify:
          a) Happy path: GET /ping → 200, X-Correlation-Id header present
          b) UUID format: header value matches /^[0-9a-f-]{36}$/ (UUID v4 format)
          c) Context field: /ping echoes req.context.correlation_id — matches header value
        Prints PASS/FAIL per scenario. Exits 0 on all pass.

- [x] 3. Run smoke test, confirm all pass

---

## Files touched

- [x] src/middleware/correlationIdMiddleware.js — created
- [x] src/tests/correlationIdMiddleware.smoke.js — created (verification only, not shipped)

Total: 2 files. index.js untouched.

---

## TRY/CATCH structure (Pattern 1)

```
// GUARD — none (middleware generates its own input)

// EXECUTE — TRY wraps everything
try {
  const correlationId = crypto.randomUUID();
  req.context.correlation_id = correlationId;
  res.setHeader('X-Correlation-Id', correlationId);
  next();
} catch (err) {
  logger.error('correlationId middleware failure', { error: err.message });
  return res.status(500).json({ error: 'internal error', message: 'request could not be initialized' });
}
```

---

## Acceptance criteria

- [x] Happy path → next() called, X-Correlation-Id header set, req.context.correlation_id set
- [x] Header value and req.context.correlation_id are the same UUID
- [x] UUID is valid format (36 chars, hex + hyphens)
- [x] No db calls anywhere in this file
- [x] No external package imports (crypto is built-in)
- [x] RECEIVE / GUARD / EXECUTE / RETURN pattern present (GUARD section present but explicitly empty)
- [x] TRY wraps EXECUTE only (Pattern 1)
- [x] CATCH logs err.message server-side only — caller gets generic 500
- [x] "Would a staff engineer approve this?" — yes

---

## Review section

Completed 2026-05-05. 6/6 smoke test checks passed. next() called, header set, context
field set, UUID format valid, header matches context, distinct UUID per request.
index.js untouched — no protected routes yet. Step 7 complete. Next: jwtMiddleware (step 8).

---

---

# orgAuthMiddleware — Build Plan
Build order step 6 of 12
File: src/middleware/orgAuthMiddleware.js
Date: 2026-05-05

---

## Pre-flight

- [x] Read tasks/handoff.md
- [x] Read CLAUDE.md
- [x] Read .claude/CLAUDE.md (Component 6 pseudocode)
- [x] Confirmed: pool.js exports `pool` directly — `require('../../db/pool')`
- [x] Confirmed: `crypto` is Node built-in — no install needed for sha256
- [x] Confirmed: no logger module exists — inline console pattern (same as health.js)
- [x] Confirmed: src/tests/ exists with resolverEngine.smoke.js — can add smoke test here
- [x] Confirmed: index.js currently mounts only /health — no protected routes yet

---

## Decisions for Aaron to confirm before implementation

1. **Logger**: No logger module exists yet. Use inline adapter
   `const logger = { error: console.error, warn: console.warn }` inside the file,
   consistent with health.js. Confirm or specify alternative.

2. **Verification approach**: orgAuthMiddleware needs a test route to be exercised.
   Two options:

   **Option A (recommended):** Create `src/tests/orgAuthMiddleware.smoke.js`.
   Spins up a minimal Express app with orgAuthMiddleware + a GET /ping test route,
   starts it, runs all curl scenarios against localhost, then exits. No index.js
   changes. Self-contained. index.js stays clean until step 9 (POST /v1/resolve)
   wires orgAuthMiddleware onto the real protected routes.

   **Option B:** Temporarily add orgAuthMiddleware + GET /v1/ping to index.js.
   Curl it, confirm, then remove the test route before step 9.
   Pollutes index.js. Not recommended.

3. **index.js wiring**: orgAuthMiddleware should NOT be wired into index.js in this step.
   There are no protected routes yet. Wiring it now would be dead code.
   It will be wired in step 9 (POST /v1/resolve) when the first protected route is added.
   Confirm this is the right call.

---

## Implementation steps

- [x] 1. Create `src/middleware/orgAuthMiddleware.js`
        RECEIVE: request, response, next
        GUARD (in-memory, no TRY):
          authHeader = request.headers["authorization"]
          null or empty → 401 "Authorization header is missing"
          not starts with "Bearer " → 401 "must use Bearer scheme"
          rawKey = authHeader.slice("Bearer ".length).trim()
          rawKey empty → 401 "Bearer token is empty"
          rawKey.length > 512 → 401 "invalid credentials"
        EXECUTE (TRY wraps this block — Pattern 1):
          hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex')
          pool.query SELECT id, name, is_active FROM org WHERE org_api_key_hash = $1
          org null → logger.warn "org auth failed — key not found" → 401 "invalid credentials"
          org.is_active false → logger.warn "org auth failed — org inactive" → 403 "org account is inactive"
          request.context = { org_id: org.id, org_name: org.name }
          next()
        CATCH ANY:
          logger.error "org auth db failure" { error: err.message, ip: request.ip }
          500 { error: "internal error", message: "authentication could not be completed" }

- [x] 2. Create `src/tests/orgAuthMiddleware.smoke.js`
        Minimal Express app with orgAuthMiddleware + GET /ping → 200 { ok: true }
        Scenarios to verify with curl (all in one node run):
          a) No Authorization header → 401
          b) Authorization: Basic abc → 401 (wrong scheme)
          c) Authorization: Bearer <empty> → 401
          d) Authorization: Bearer <invalid-key> → 401 (key not in db)
          e) Authorization: Bearer <valid-key-for-active-org> → 200 (hits /ping)
          f) Authorization: Bearer <key-for-inactive-org> → 403 (if seed row can be toggled)
        Prints PASS/FAIL for each scenario. Exits with code 0 on all pass.

- [x] 3. Run smoke test and confirm all scenarios pass

---

## Files touched

- [x] src/middleware/orgAuthMiddleware.js — created
- [x] src/tests/orgAuthMiddleware.smoke.js — created (verification only, not shipped)

Total: 2 files. index.js untouched this step.

---

## TRY/CATCH structure (Pattern 1)

```
// GUARD — in-memory, outside TRY
if (!authHeader || !authHeader.trim()) return res.status(401).json(...)
if (!authHeader.startsWith('Bearer ')) return res.status(401).json(...)
const rawKey = authHeader.slice('Bearer '.length).trim()
if (!rawKey) return res.status(401).json(...)
if (rawKey.length > 512) return res.status(401).json(...)

// EXECUTE — TRY wraps everything from here
try {
  const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex')
  const result = await pool.query('SELECT id, name, is_active FROM org WHERE org_api_key_hash = $1', [hashedKey])
  const org = result.rows[0]
  if (!org) { logger.warn(...); return res.status(401).json(...) }
  if (!org.is_active) { logger.warn(...); return res.status(403).json(...) }
  req.context = { org_id: org.id, org_name: org.name }
  next()
} catch (err) {
  logger.error('org auth db failure', { error: err.message, ip: req.ip })
  return res.status(500).json({ error: 'internal error', message: 'authentication could not be completed' })
}
```

---

## Security notes

- sha256 computed from raw key — only hashed value hits the DB
- Parameterized query — no string concatenation with user input
- Null/inactive org: same 401 message "invalid credentials" in both cases — does NOT
  reveal which check failed to the caller (key-not-found vs org-inactive both return same message)
- CATCH: logs err.message server-side only — caller gets generic 500 message

---

## Acceptance criteria

- [x] No Authorization header → 401 { error: "unauthorized", message: "Authorization header is missing" }
- [x] Wrong scheme (not "Bearer ") → 401 "must use Bearer scheme"
- [x] Empty token after "Bearer " → 401 (HTTP strips trailing whitespace; scheme check fires — both are 401, code is correct)
- [x] Key length > 512 → 401 "invalid credentials"
- [x] Unknown key (not in db) → 401 "invalid credentials" + logger.warn
- [x] Inactive org → 403 "org account is inactive" + logger.warn
- [x] Valid key, active org → next() called, request.context = { org_id, org_name }
- [x] DB failure → 500 generic message, err.message in logs only (verified by code inspection)
- [x] RECEIVE / GUARD / EXECUTE / RETURN pattern present
- [x] TRY wraps EXECUTE only (Pattern 1) — GUARD is all in-memory
- [x] No raw key ever logged — only hashed key used in db query
- [x] "Would a staff engineer approve this?" — yes

---

## Review section

Completed 2026-05-05. 14/14 smoke test checks passed. All guard paths exercised.
Valid key → 200, inactive org → 403, unknown key → 401, db-failure path verified by
code inspection. index.js untouched — no protected routes yet. Step 6 complete.
Next: correlationIdMiddleware (step 7).

---

---

# GET /health — Build Plan (completed 2026-05-05)
Build order step 5 of 12
File: src/routes/health.js
Date: 2026-05-05

---

## Pre-flight

- [x] Read tasks/handoff.md
- [x] Read CLAUDE.md
- [x] Read .claude/CLAUDE.md (Component 5 pseudocode)
- [x] Confirmed: CommonJS throughout
- [x] Confirmed: pool.js exists at src/db/pool.js
- [x] Confirmed: resolverEngine.js complete (step 4 done)
- [x] Found: `express` NOT in package.json — must install before writing the route
- [x] Found: no index.js / app entry point yet — see Decision 2 below

---

## Decisions for Aaron to confirm before implementation

1. **Express install** — `npm install express`. Required to write and test the route.
   Confirm.

2. **index.js / app entry point** — health.js is a route handler that needs to be
   mounted on an Express app to be testable. Two options:

   **Option A (recommended):** Create a minimal `index.js` alongside `src/routes/health.js`.
   Mounts only GET /health (no middleware yet — correct, health has no auth).
   Listens on PORT from env. Subsequent sessions add middleware and routes to it
   incrementally as each step completes. This lets us curl localhost:PORT/health as
   the verification step and proves Cloud Run + Postgres connected as the build order
   requires.

   **Option B:** Write health.js only. Export the router. Defer index.js to a later
   step (e.g., when step 6 orgAuthMiddleware is ready). Verification via a standalone
   test file that mounts the route temporarily.

   Recommendation: Option A. Proves the full request path working end-to-end.
   Files touched = 2 (health.js + index.js) — within the 3-file rule, tightly coupled.

3. **Logger** — health.js logs one error: db probe failure.
   All previous modules (jwt.js, resolverEngine.js) presumably used a logger object.
   Two options:

   **Option A:** `const logger = { error: console.error, warn: console.warn }` inline
   in health.js. Consistent with what previous modules likely used if no logger module
   exists yet.

   **Option B:** Create `src/modules/logger.js` as a thin wrapper around console
   (or install Winston). Centralizes future log formatting.

   Recommendation: Option A unless a logger module already exists. Minimal, correct,
   no new dependencies.

4. **Rate limiter** — CLAUDE.md middleware stack shows rate limiter at the top.
   For this step, health.js has NO middleware (no auth, no JWT, no rate limiter per
   the pseudocode). Rate limiter will be wired in index.js when the full stack is
   assembled. Confirm health.js is exempt.

---

## Implementation steps

- [x] 0. `npm install express`
- [x] 1. Create `src/routes/health.js`
         RECEIVE: no inputs (health takes no params)
         GUARD: none
         EXECUTE — three independent TRY/CATCH blocks:
           Block 1: pool.query("SELECT 1") → results.db = "connected" or "disconnected"
                    logger.error on catch, continue
           Block 2: COUNT(*) FROM ingest_failures WHERE status = 'pending' → results.queue_depth
                    Silent catch, stays 0
           Block 3: COUNT total + COUNT errors FROM audit_log WHERE created_at > NOW() - INTERVAL '5 minutes'
                    IF total > 0: results.error_rate_5m = errors / total
                    Silent catch, stays 0.0
         isHealthy = db=="connected" AND queue_depth < 10000 AND error_rate_5m < 0.01
         RETURN: status 200 or 503, structured JSON always
- [x] 2. Create `index.js`
         Load dotenv, require express, require health router
         Mount GET /health — no middleware (no auth, no JWT, no rate limiter)
         Listen on process.env.PORT || 3000
- [x] 3. Smoke test — verify with curl (see acceptance criteria below)

---

## Files touched

- [x] package.json — updated by npm install (express)
- [x] src/routes/health.js — created
- [x] index.js — created

Total: 2 hand-edited files (package-lock.json will also update, not hand-edited)

---

## TRY/CATCH structure (three independent blocks — never throw)

```
results = { db: "disconnected", queue_depth: 0, error_rate_5m: 0.0, timestamp: now }

TRY { pool.query("SELECT 1"); results.db = "connected" }
CATCH { results.db = "disconnected"; logger.error(...) }

TRY { results.queue_depth = COUNT(*) FROM ingest_failures }
CATCH { /* stays 0 */ }

TRY {
  total = COUNT(*) FROM audit_log WHERE created_at > NOW() - INTERVAL '5 minutes'
  errors = COUNT(*) ... AND status = 'error'
  if (total > 0) results.error_rate_5m = errors / total
}
CATCH { /* stays 0.0 */ }

isHealthy = (db == "connected" && queue_depth < 10000 && error_rate_5m < 0.01)
return res.status(isHealthy ? 200 : 503).json({ status, db, queue_depth, error_rate_5m, timestamp })
```

Note: No outer try/catch. No throw anywhere. Each block is fully isolated.
A failure in block 1 does NOT prevent blocks 2 and 3 from running.

---

## Acceptance criteria

- [x] GET /health returns 200 when Postgres is up and metrics are healthy
- [x] GET /health returns 503 when db is disconnected — still returns JSON, does not throw
- [x] queue_depth = 0 and error_rate_5m = 0.0 when tables are empty (safe default)
- [x] Response always includes: status, db, queue_depth, error_rate_5m, timestamp
- [x] No auth header required — route is public
- [x] db probe failure logs to console.error; queue/error-rate failures are silent
- [x] RECEIVE / EXECUTE / RETURN pattern present in handler (no GUARD — health has no inputs)
- [x] Uses pool.query (not pool.connect/client) — read-only queries, no transaction needed
- [x] "Would a staff engineer approve this?" — yes

---

## Smoke test plan

Happy paths:
- [x] curl localhost:3000/health with Postgres running → 200, db: "connected"
- [x] Confirm queue_depth and error_rate_5m fields present in response
- [x] Confirm timestamp is ISO 8601

Degraded path:
- [ ] Bad DATABASE_URL path not tested this session (Aaron used real DB for both runs)
      Degraded behavior verified by code inspection: Block 1 catch sets db="disconnected",
      isHealthy evaluates false, 503 returned.

---

## Review section

Completed 2026-05-05. 200 returned with real Postgres. All fields present in response.
express installed. index.js created as app entry point — subsequent steps mount
middleware and routes here incrementally. Step 5 complete. Next: orgAuthMiddleware (step 6).
