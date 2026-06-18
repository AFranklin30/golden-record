# Pre-Presentation Bug Hunt — Audit Report
# Golden Record Fan Identity Platform
# OKC Thunder — Thunder Innovations Cohort
# Date: 2026-06-09
# Auditor: Claude Code (read-only — no code modified)

---

## Scope

Every route, module, and middleware file read in full.
10 checks run. Findings rated PASS / BUG / ROUGH / RISK.
Migrations spot-checked for CHECK constraint correctness.

---

## CHECK 1 — Response shape consistency

CHECK:    All endpoints return consistent, complete response shapes.

FINDING:  resolve.js — all 4 paths (Path A, B, C, D) return the same field set
          with `requires_review` and `conflict_id` consistent. PASS.
          nfc.js — same shape as resolve.js plus `session_ready: true`. Consistent
          across all 4 paths. PASS.
          session.js — returns `token`, `fan_id`, `expires_at`, `token_type`. PASS.
          profile.js — fully structured with `linked_systems`, `wallet`. PASS.
          conflicts.js — GET, confirm, reject, unmerge each have appropriate
          shapes for their operation. PASS.
          household.js — GET /v1/household/:adult_fan_id/members/:child_fan_id
          returns `claim_token_expires_at` even when null (active members).
          Not harmful but adds a field that has no meaning in the active state.

STATUS:   ROUGH (claim_token_expires_at in active member response)
FIX:      —
DEMO:     If asked about `claim_token_expires_at` being null, explain it is
          populated when the guardian initiates an age-up transfer.

---

## CHECK 2 — Error message consistency

CHECK:    Error responses use consistent field names and structure.

FINDING:  Two distinct shapes in use across the codebase:
            { error: '...' }                  — most 400s in routes
            { error: '...', message: '...' }  — auth middleware, some 409s

          Examples:
            POST /v1/resolve 400:     { error: 'identifier_type is required' }
            orgAuthMiddleware 401:    { error: 'unauthorized', message: '...' }
            conflicts unmerge 409:    { error: '...', message: '...' }
            conflicts confirm 409:    { error: 'conflict already resolved' }

          The `message` field is present on auth errors and a subset of
          conflict errors, absent on validation errors. Not a crash but an
          inconsistent contract for callers.

          All 500 responses return only generic messages — internal details
          never exposed. PASS.
          No stack traces, table names, or variable names in any response. PASS.

STATUS:   ROUGH
FIX:      —
DEMO:     Not visible in a happy-path demo. If an error fires, the caller
          may or may not get a `message` field — explain this as a known
          cleanup item for Sprint 4.

---

## CHECK 3 — Edge cases in GUARD blocks

CHECK:    Guard blocks cover type coercion, NaN, and format edge cases.

--- FINDING 3A ---

CHECK:    GET /v1/household/:adult_fan_id — limit/offset NaN guard.
STATUS:   BUG

FINDING:  household.js:105-106 parses query params with parseInt:
            const limit  = req.query.limit  !== undefined ? parseInt(req.query.limit, 10)  : 3;
            const offset = req.query.offset !== undefined ? parseInt(req.query.offset, 10) : 0;

          household.js:115-119 guards are:
            if (limit > 10)  { return 400 }
            if (offset < 0)  { return 400 }

          If a caller sends ?limit=abc, parseInt returns NaN.
          NaN > 10 is false — the guard passes.
          NaN is then passed to the DB query as LIMIT $3.
          Postgres rejects a non-integer LIMIT → db error → catch → 500.

          This same NaN gap does NOT exist in conflicts.js:27 which correctly
          guards with: `if (isNaN(limit) || limit < 1)`.

FIX:      Add isNaN check to household.js GET /v1/household/:adult_fan_id
          limit and offset guards. Pattern to follow: conflicts.js:27-44.

--- FINDING 3B ---

CHECK:    normalizeDob — invalid leap-day dates.
STATUS:   RISK

FINDING:  normalizer.js:68-89: normalizeDob uses JavaScript's Date constructor
          to validate dates. JavaScript's V8 engine may treat dates like
          "2026-02-29" (Feb 29 on a non-leap year) as Invalid Date (returning
          NaN from getTime()), correctly rejecting it. However, behavior can
          vary between JS environments. If V8 rolls the date over to
          2026-03-01 instead of rejecting it, the normalized DOB stored would
          be wrong and the error would go undetected.

          Not confirmed to fail in Node.js V8, but worth knowing before a
          live demo where a child DOB is entered.

FIX:      —
DEMO:     Use only valid calendar dates in the demo. Do not demo edge-case
          DOBs.

--- FINDING 3C ---

CHECK:    Remaining guard coverage across all routes.
STATUS:   PASS

FINDING:  UUID format checks present on all URL params. PASS.
          String type checks in normalizer before routing. PASS.
          Integer bounds validated in conflicts.js. PASS.
          Optional field null-before-use paths all guarded. PASS.

---

## CHECK 4 — Database query correctness

CHECK:    Queries filter by org_id, return expected row counts, use safe WHERE clauses.

--- FINDING 4A ---

CHECK:    All queries filter by org_id where expected.
STATUS:   PASS

FINDING:  Every SELECT, UPDATE, and DELETE that touches fan-scoped data includes
          AND org_id = $N. Spot-checked: resolverEngine, conflicts (all three
          operations), household (all handlers), admin/household. PASS.

--- FINDING 4B ---

CHECK:    staging_household_data ON CONFLICT DO NOTHING in resolverEngine.
STATUS:   ROUGH

FINDING:  resolverEngine.js:186-209: ON CONFLICT DO NOTHING is used when
          inserting soft-link staging rows. migration_005.sql defines no UNIQUE
          constraint on staging_household_data. Without a matching constraint,
          ON CONFLICT DO NOTHING never fires — every insert succeeds. If the
          same guardian_email signal fires on multiple resolution calls for the
          same candidate pair, duplicate staging rows accumulate. The admin
          household view would show the same probable relationship multiple times.

FIX:      —
DEMO:     In practice, the same guardian_email signal would only fire if the
          same child record is resolved multiple times against the same adult.
          Low probability in a demo. If it fires, the admin view shows
          duplicates — explain as known Sprint 3 cleanup.

--- FINDING 4C ---

CHECK:    All other queries — SELECT cardinality, UPDATE scope.
STATUS:   PASS

FINDING:  candidate query in resolverEngine: LIMIT 100. PASS.
          All fan lookups: WHERE id = $1 AND org_id = $2 returns 0 or 1 row. PASS.
          conflict_queue UPDATE in confirm/reject/unmerge: WHERE id = $1. PASS.
          merge_history UPDATE in unmerge: WHERE id = $2 (primary key). PASS.
          ORDER BY confidence_score DESC on GET /v1/conflicts — deterministic
          ordering for staff dashboard. PASS.

---

## CHECK 5 — Transaction completeness

CHECK:    All multi-write endpoints use BEGIN/COMMIT. Audit event is always last.
          ROLLBACK present on all transactions. Correct db client used.

STATUS:   PASS

FINDING:  All multi-write handlers use transactions:
            POST /v1/household — BEGIN/COMMIT, ROLLBACK in catch. PASS.
            POST /v1/household/:id/members — BEGIN/COMMIT, ROLLBACK. PASS.
            PUT  /v1/household/:id/members/:id — BEGIN/COMMIT, ROLLBACK. PASS.
            DELETE /v1/household/:id/members/:id — BEGIN/COMMIT, ROLLBACK. PASS.
            POST /v1/household/:id/members/:id/age-up — BEGIN/COMMIT, ROLLBACK. PASS.
            GET  /v1/household/claim/:token — BEGIN/COMMIT, ROLLBACK. PASS.
            POST /v1/conflicts/:id/confirm — BEGIN/COMMIT, ROLLBACK. PASS.
            POST /v1/conflicts/:id/reject — BEGIN/COMMIT, ROLLBACK. PASS.
            POST /v1/conflicts/:id/unmerge — BEGIN/COMMIT, ROLLBACK. PASS.
            resolverEngine — BEGIN/COMMIT, ROLLBACK. PASS.

          Audit event is always the last write inside every transaction. PASS.
          All handlers use req.db (pooled client with RLS context set). PASS.
          Firestore sync and email stub always execute after COMMIT. PASS.

          signToken in claim endpoint executes inside TRY but outside the
          transaction BEGIN/COMMIT window. If signToken throws, ROLLBACK fires
          and the claim token remains unconsumed — correct retry behavior. PASS.

---

## CHECK 6 — JWT and auth edge cases

CHECK:    JWT required where expected. fan_id verified before db calls.
          Child session guards. clockTolerance set. org_id mismatch handled.

--- FINDING 6A ---

CHECK:    Child session writes no audit event.
STATUS:   ROUGH

FINDING:  household.js:871-878: POST .../session issues a child JWT with no
          audit log write. The pseudocode specified event_type='child_session_issued'
          but that value was intentionally omitted — migration_007.sql's
          event_type CHECK constraint does not include 'child_session_issued',
          so adding the INSERT would fail. The implementation skips the audit
          event to avoid the constraint violation. Child session issuance is
          not audited.

FIX:      —
DEMO:     If asked about audit coverage: adult session issuance is audited via
          POST /v1/session. Child session issuance is not yet audited — flagged
          for Sprint 4 after adding the event_type to the constraint.

--- FINDING 6B ---

CHECK:    All other JWT and auth edge cases.
STATUS:   PASS

FINDING:  jwtMiddleware checks org_id from JWT against org_id from API key auth.
          Mismatch returns 403. PASS.
          Profile endpoint: url_fan_id !== jwt_fan_id checked before db calls. PASS.
          clockTolerance: 30 seconds set in jwt.js:78. PASS.
          JWT keys read at startup — StartupError thrown if missing. PASS.
          X-Fan-Token header used for JWT (consistent across middleware and
          CORS allowedHeaders config). PASS.
          Admin household and conflicts: staff-only, no jwtMiddleware required. PASS.
          Household claim endpoint: no jwtMiddleware, mounted on separate
          public router before protected router in index.js. PASS.

---

## CHECK 7 — Household flow correctness

CHECK:    Full lifecycle: create → add member → get → update → sever →
          age-up → claim. Status transitions correct and irreversible.

STATUS:   PASS (with ROUGH noted in 6A above)

FINDING:  Create household (POST /v1/household):
            Verifies adult fan exists and not erased before write. PASS.
            409 if household already exists. PASS.

          Add member (POST .../members):
            Verifies adult exists, household exists (404 if not — forces
            explicit creation first per Lesson 3). PASS.
            Checks staging_household_data for probable match. PASS.
            Creates child fan + 4 identifier_links + household_member in tx. PASS.

          Status transitions:
            active → severed: DELETE sets status='severed'. PASS.
            active → aged_up: age-up checks for aged_up (409) and severed (409)
            before proceeding. No regression to active. PASS.
            aged_up → claimed: claim clears token, status remains 'aged_up'.
            Guardian can no longer see the child (GET /household/:id filters
            status='active'). PASS.

          Claim token flow:
            Raw token = UUID + UUID (72 chars). PASS.
            SHA-256 hash stored in DB — raw token never persisted. PASS.
            Timing-safe comparison via crypto.timingSafeEqual. PASS.
            Token cleared (set to NULL) after single use. PASS.
            Email stub logs [REDACTED] — raw token never logged. PASS.

          Route mount order in index.js:
            householdPublicRouter (claim, no JWT) mounted before
            householdProtectedRouter (:adult_fan_id with JWT). PASS.
            GET /v1/household/claim/:token is matched by the public router
            before Express reaches the protected router's :adult_fan_id
            parameter. PASS.

---

## CHECK 8 — Response data leakage

CHECK:    claim_token, JWT private key, internal errors never in responses.
          Cross-tenant data isolation. Erased fans not returned as active.

--- FINDING 8A ---

CHECK:    req.firestore never set — child Firestore sync silently skipped.
STATUS:   BUG

FINDING:  household.js:359: `if (req.firestore) {` guards the Firestore sync
          for new child fan records. index.js does not attach a firestore
          instance to req at any point — no middleware sets req.firestore.
          The condition is always false. Child fan records created via
          POST /v1/household/:adult_fan_id/members NEVER receive a Firestore
          wallet document.

          Downstream impact: if GET /v1/fan/:id/profile is ever called for
          a child fan_id (e.g., after the child claims their profile and logs
          in independently), the Firestore read returns `.exists = false` and
          the response shows `loyalty_points: 0, stamps: [], avatar: null`
          (the default empty wallet). Functionally acceptable for the demo
          since children don't have profile endpoints. But the wallet gap
          is real and will surface post-claim.

FIX:      In household.js Component 29, replace `req.firestore` with the
          module-level firestore instance used by resolverEngine.js.
          The Firestore client in resolverEngine.js is initialized at
          module level with the correct projectId and databaseId. Either
          export it from resolverEngine or create a shared firestore.js
          module that both resolverEngine and household.js import.

--- FINDING 8B ---

CHECK:    All other data leakage vectors.
STATUS:   PASS

FINDING:  claim_token excluded from all SELECT statements and all responses.
          household.js GET member comment confirms: "claim_token is NOT selected".
          admin/household.js same — intentional exclusion documented in code. PASS.
          All 500 responses return only generic messages. PASS.
          No stack traces in any response. PASS.
          JWT private key never returned or logged. PASS.
          Deleted fans:
            session.js checks `fan.deleted_at` → 403. PASS.
            profile.js checks `fan.deleted_at` → 403. PASS.
            POST /v1/household checks `fan.deleted_at` → 403. PASS.
            Claim checks child fan `deleted_at` → 403. PASS.
          RLS on all tables: migration_003 (Sprint 1), migration_006 (Sprint 3),
          migration_008 (conflict_queue). PASS.

---

## CHECK 9 — Demo path specifically

CHECK:    All three demo paths: endpoints mounted, happy path clean, no obvious
          failure mode.

--- PATH 1 — Core resolution loop ---

STATUS:   PASS

  POST /v1/resolve → new fan
    Mounted on protectedRouter. Response includes requires_review=false,
    conflict_id=null, is_new_record=true. PASS.

  POST /v1/resolve → same fan (idempotent)
    Idempotency key hits within 24h → returns is_new_record=false with
    original audit_event_id. PASS.

  POST /v1/session → JWT
    Mounted on protectedRouter. Returns Bearer token with 15-min expiry. PASS.

  GET /v1/fan/:id/profile → full profile
    Mounted on protectedRouter with per-route jwtMiddleware. X-Fan-Token
    header required. Returns linked_systems and wallet. PASS.

--- PATH 2 — Conflict workflow ---

  POST /v1/resolve → two fans with similar signals
    Paths C and D return requires_review=true, conflict_id populated. PASS.

  GET /v1/conflicts → see conflict in queue
    Mounted on protectedRouter. Ordered by confidence_score DESC. PASS.

  POST /v1/conflicts/:id/confirm → merge
    Moves identifiers, soft-deletes fan_id_b, writes merge_history. PASS.

  POST /v1/conflicts/:id/unmerge → reverse
    STATUS:   BUG (see BUG-3 below)

--- PATH 3 — Household workflow ---

  POST /v1/household → create
    Mounted on householdProtectedRouter. Returns 201 with household_id. PASS.

  POST /v1/household/:id/members → add child
    Returns 201. Firestore sync skipped (BUG-4). Wallet gap exists. ROUGH.

  GET /v1/household/:id/members/:child_id → view
    Returns full member record with identifiers. PASS.

  POST /v1/household/:id/members/:child_id/session → child JWT
    Returns 8-hour token. No audit event (ROUGH 6A). PASS.

  POST /v1/household/:id/members/:child_id/age-up → initiate
    Email is stubbed — no real email sent. ROUGH.

  GET /v1/admin/household/:fan_id → staff view
    Returns households, memberships, soft_links, related_fans. PASS.

---

## CHECK 10 — Known deferred items

CHECK:    Flag known gaps so they can be explained during the demo.

  EMAIL DELIVERY — STUBBED
    household.js:1006-1011: age-up fires a logger.info email stub.
    No real email is sent. Guardian cannot receive the claim link
    in the current state. The response includes `email_stub: true`.
    STATUS: RISK — demo must script around this. Guardian manually
    forwarding the URL to child must be narrated, not demonstrated live.

  RESOLVE.JS DLQ — NOT IMPLEMENTED
    resolve.js has no DLQ write on resolver failure. nfc.js has it.
    STATUS: RISK — if resolver fails during demo on a POST /v1/resolve
    call, no ingest_failures record is written. The failure is logged
    only in Cloud Logging.

  FIRESTORE DLQ — NOT IMPLEMENTED
    resolverEngine.js:322-328: Firestore failure is caught and logged
    but not written to any queue. The fan record is committed but the
    wallet document is missing. Silent at the API layer.
    STATUS: RISK — Postgres record is always valid. Demo impact is low
    since profile endpoint falls back to empty wallet.

  HOUSEHOLD MEMBER IDEMPOTENCY — NOT IMPLEMENTED
    POST /v1/household/:adult_fan_id/members has no idempotency key.
    If the same child is added twice (same name + DOB), two separate
    child fan records are created. No deduplication.
    STATUS: RISK — avoid adding the same child twice in the demo.

  PATHS C AND D — NOT TESTED WITH REAL DATA
    Probabilistic matching thresholds are placeholders (0.85/0.60).
    Paths C and D have not been driven with production-like data volumes.
    STATUS: RISK — demo should stage known signals in advance so the
    confidence score lands in the expected band.

  CORS_ORIGIN — NOT CONFIRMED
    CORS_ORIGIN not yet confirmed with King/Tanner. If unset in env,
    all browser origins are blocked (function-based CORS config fails
    secure). Server-to-server calls (no Origin header) are unaffected.
    STATUS: RISK — must be set before any browser-based demo.

---

## CONFIRMED BUGS — Fix Before Presentation

--- BUG-1 ---
FILE:     src/routes/household.js:115-119
CHECK:    Guard block NaN — GET /v1/household/:adult_fan_id

FINDING:  limit and offset guards use `> 10` and `< 0` without isNaN check.
          ?limit=abc → parseInt = NaN → NaN > 10 = false → guard passes →
          NaN sent to Postgres LIMIT clause → db error → 500.
          conflicts.js:27-44 does this correctly (isNaN guard present there).

FIX:      Add `isNaN(limit) || ` to the limit guard.
          Add `isNaN(offset) || ` to the offset guard.
          Pattern: `if (isNaN(limit) || limit > 10) { return 400 }`

--- BUG-2 ---
FILE:     src/routes/household.js:624-683 (all four ON CONFLICT clauses in PUT)
CHECK:    ON CONFLICT missing WHERE clause — PUT household member (Lesson 9)

FINDING:  PUT /v1/household/:adult_fan_id/members/:child_fan_id uses:
            ON CONFLICT (fan_id, identifier_type, org_id)
            DO UPDATE SET identifier_value = ..., last_seen_at = NOW()
          migration_006.sql creates only a PARTIAL unique index:
            CREATE UNIQUE INDEX uq_identifier_link_managed
              ON identifier_link (fan_id, identifier_type, org_id)
              WHERE source_system = 'fan_pass';
          Postgres requires the ON CONFLICT clause to include the WHERE
          predicate of the partial index. Without it, Postgres raises:
            ERROR: there is no unique or exclusion constraint matching
            the ON CONFLICT specification
          Tests mock req.db.query so they never hit this. Against the
          real Cloud SQL database, every call to PUT household member fails.

FIX:      Change all four ON CONFLICT clauses to:
            ON CONFLICT (fan_id, identifier_type, org_id)
              WHERE source_system = 'fan_pass'
            DO UPDATE SET ...

--- BUG-3 ---
FILE:     src/routes/conflicts.js:10 (ALLOWED_STATUSES) and
          src/routes/conflicts.js:350 (unmerge sets 'unmerged')
CHECK:    Unmerged conflicts not queryable via GET /v1/conflicts

FINDING:  POST /v1/conflicts/:id/unmerge sets conflict_queue.status = 'unmerged'.
          GET /v1/conflicts ALLOWED_STATUSES = ['pending', 'confirmed', 'rejected'].
          'unmerged' is not in ALLOWED_STATUSES. If staff or the dashboard
          tries GET /v1/conflicts?status=unmerged, they receive:
            400 { error: 'invalid status', message: '...' }
          There is no API path to list conflicts that have been unmerged.
          The data exists in conflict_queue and merge_history but is
          not surfaced to the dashboard.

FIX:      Add 'unmerged' to ALLOWED_STATUSES in conflicts.js line 10.

--- BUG-4 ---
FILE:     src/routes/household.js:359
CHECK:    req.firestore never set — child fan wallet never synced to Firestore

FINDING:  POST /v1/household/:adult_fan_id/members Firestore sync:
            if (req.firestore) {
              await req.firestore.collection('fans').doc(minor_fan_id).set({...});
          index.js never sets req.firestore on any request. The condition
          is always false. All child fan records created via household
          have no Firestore wallet document. When the child claims their
          profile and calls GET /v1/fan/:id/profile, Firestore returns
          `.exists = false` and the response shows an empty wallet
          (loyalty_points: 0, stamps: [], avatar: null). Functional but
          the wallet will be perpetually empty unless the document is
          created out-of-band.

          Additional note: resolverEngine.js uses `firestore.collection('golden-record')`
          while household.js uses `req.firestore.collection('fans')`. These are
          different collection names. Even if req.firestore were set, the
          child fan document would be written to a different collection
          than where resolverEngine writes all other fan documents.

FIX:      In household.js Component 29, replace the req.firestore block with
          a direct import and call using the same Firestore setup as
          resolverEngine.js (collection: 'golden-record', databaseId: 'golden-record').

---

## Summary

Total PASS:   checked items with no issue found
Total BUG:    4  — fix ALL before presentation
Total ROUGH:  4  — prepare talking points
Total RISK:   6  — know these cold before walking into the demo room

### PASS items:
  - Middleware order: rate limiter → orgAuth → rls → correlationId → handler
  - All 500 responses hide internal error details
  - All queries filter by org_id; RLS enforced at DB layer
  - All multi-write endpoints use transactions with ROLLBACK handlers
  - Audit event is always last write in every transaction
  - JWT/org mismatch check fires before db calls
  - fan_id URL param verified against JWT claim before db calls on profile
  - claim_token never in any response body
  - Timing-safe token comparison implemented
  - Household status transitions are correct and irreversible
  - Admin household endpoint correctly excludes claim_token
  - CHECK constraints updated through migration_009 (match_type 'conflict')
  - event_type CHECK updated through migration_007 (Sprint 3 event types)
  - RLS on all tenant tables through migration_008 (conflict_queue)

### BUG items (fix before demo):
  BUG-1: GET /v1/household/:adult_fan_id — NaN limit/offset causes 500
  BUG-2: PUT /v1/household/:id/members/:id — ON CONFLICT missing WHERE,
          fails against real DB
  BUG-3: GET /v1/conflicts?status=unmerged returns 400 — unmerged
          conflicts not queryable
  BUG-4: req.firestore never set — child fan Firestore sync silently skipped;
          collection name mismatch if fixed naively

### ROUGH items (prepare talking points):
  ROUGH-1: Inconsistent error response shape (error vs error+message)
  ROUGH-2: claim_token_expires_at returned as null for active members
  ROUGH-3: Child session writes no audit event
  ROUGH-4: staging_household_data ON CONFLICT DO NOTHING never fires
            (no unique constraint)

### RISK items (know these cold):
  RISK-1:  normalizeDob may silently roll over invalid leap-day dates
  RISK-2:  Email delivery for age-up is stubbed — no real email sent
  RISK-3:  Firestore sync failures are silent at the API layer
  RISK-4:  resolve.js has no DLQ write on resolver failure
  RISK-5:  Household member idempotency not implemented
  RISK-6:  CORS_ORIGIN not confirmed with King/Tanner

---
End of audit. 2026-06-09.
