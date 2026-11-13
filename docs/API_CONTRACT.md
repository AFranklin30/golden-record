# Golden Record — API Contract

Fan Identity Resolution Platform · Backend API Reference
Golden Record
Prepared for frontend integration (King) · Backend: Aaron Franklin
Regenerated 2026-08-02 · supersedes the 2026-06-25 version

## Read this first

This contract documents every endpoint whose handler was re-read against current source on
2026-08-02, including the Stage 7 evaluation work and the full hardening sprint that shipped
since the last version. Every field and status code below was verified line-by-line against
the route file that produces it — nothing here is carried forward from the old contract
without being re-checked.

**What changed since 2026-06-25, at a glance:**

- **The `identifiers` object is no longer symmetric between the two resolution endpoints.**
  `/v1/resolve` strictly validates *and* normalizes it. `/v1/ingest/nfc` does neither beyond
  the earlier type check. The old contract implied both endpoints treated it the same way —
  they do not. See **Resolution Endpoints** below.
- **`GET /v1/fan/:id/profile` is documented for the first time.** It's also the newest change
  in the codebase: a fan whose record was merged away by staff now gets forwarded to the
  survivor's full profile (200) instead of a flat 403. See **Profile**.
- **`/v1/conflicts` and `/v1/conflicts/:id/*` are documented for the first time.** The old
  contract listed them in the auth-tier table but never wrote the section.
- **A new staff-only endpoint, `GET /v1/admin/household/:fan_id`, is documented** — it is
  **not** part of the fan-facing app and King does not integrate against it today. It's
  included because whether a staff view ships this sprint is still an open scope question,
  and it's better documented and unused than missing when the answer is "yes."
- **A CORS configuration issue was found while reading `index.js`** that may block real
  cross-origin calls using the `Authorization` header. It is not fixed as part of this
  contract — flagged in **Coverage & Open Items** so it's known before it's hit.
- TASK-12 (JWT `aud` claim change) has **not** shipped — still flagged as upcoming, not done.

---

## Authentication Model

Golden Record uses a two-layer authentication model. Most endpoints require only the first
layer; fan-scoped endpoints require both.

### Layer 1 — Organization API key (every request)

Every request must include the organization API key as a Bearer token:

```
Authorization: Bearer <org-api-key>
```

The key is sha256-hashed and matched against an active organization
(`orgAuthMiddleware.js`). The authenticated `org_id` becomes the ground truth for the
request — it is never taken from the request body. If a body includes `org_id` that
disagrees with the authenticated org, the request is rejected with 400.

Failure modes: missing/absent header → 401 `'Authorization header is missing'` · not
`Bearer` scheme → 401 `'must use Bearer scheme'` · empty token → 401 `'Bearer token is
empty'` · token over 512 chars → 401 `'invalid credentials'` · unknown key → 401 `'invalid
credentials'` · inactive org → 403 `'org account is inactive'`.

### Layer 2 — Fan JWT (fan-scoped endpoints only)

Fan-scoped endpoints additionally require a fan JWT — passed in a separate header, **not** a
second `Authorization`:

```
x-fan-token: <jwt>
```

> **Common integration mistake**
> The fan JWT goes in `x-fan-token`, not in a second `Authorization` header. The org key and
> the fan JWT are sent together on fan-scoped calls — org key in `Authorization`, fan JWT in
> `x-fan-token`.

The JWT is RS256-signed, default 15-minute expiry (child sessions: 8 hours). Its `org` claim
must match the authenticated org or the request is 403 `'org claim does not match
authenticated org'`. `jwtMiddleware`'s error responses always return a generic `{ error,
message: 'invalid or expired token' }` regardless of the underlying reason (full detail is
logged server-side only, per the platform's error-sanitization convention) — the `error` key
is `'unauthorized'` for a 401 and `'forbidden'` for the 403 org-mismatch case.

A token carrying `acting_as: 'child'` is blocked from all household-management routes with
403 `'child tokens cannot manage household accounts'` — enforced by a `router.use()` guard at
the top of `household.js`, before any individual route handler runs.

> **Upcoming change — TASK-12 (coordinate before Sprint 4 WebView) — still pending, verified 2026-08-02**
> The JWT `aud` (audience) claim is currently `'golden-record'` and is planned to change to
> `'golden-record-webview'` before the Sprint 4 WebView integration. Re-checked against
> `src/modules/jwt.js` this session: both `signToken` and `verifyToken` still hard-code
> `aud: 'golden-record'` — the change has **not** shipped. Flagged here so it stays
> coordinated, not discovered.

### Endpoint authentication tiers

| Tier | Endpoints |
|---|---|
| Org key only | `/v1/resolve` · `/v1/ingest/nfc` · `/v1/session` · `/v1/conflicts` and all `/v1/conflicts/:id/*` · `/v1/household/claim/:token` |
| Org key + fan JWT (`x-fan-token`) | `/v1/fan/:id/profile` **(NEW to this tier list)** · `/v1/household` (create) · `/v1/household/:adult_fan_id` and all member sub-routes (add, get, update, sever, session, age-up) |
| Org key only — staff-facing, **not part of the fan app** | `/v1/admin/household/:fan_id` **(NEW)** — see **Admin (staff-facing)** below |
| No auth required (more detail if authed) | `/health` |

Base path: all endpoints are under the service root. Region us-central1, Cloud Run. Every
response is JSON.

### Middleware stack order — verified against `index.js`

Real mount order, read line-by-line from `index.js`:

```
CORS (function-based origin check)
  → helmet()
    → express.json()
      → [ /health only: its own stricter rate limiter, no further middleware ]
      → rate limiter (general routes)
        → orgAuthMiddleware        // who is calling?
          → rlsContextMiddleware   // sets Postgres session var + req.db
            → correlationIdMiddleware // assigns request UUID, X-Correlation-Id header
              → jwtMiddleware         // fan-scoped routes only — see below
                → handler
```

`jwtMiddleware` is wired two different ways depending on the route group, though the
resulting order on the wire is identical either way:
- **Household routes** get it via a router-level `.use()` on a dedicated
  `householdProtectedRouter` (all member/create/get routes).
- **`GET /v1/fan/:id/profile`** attaches it directly on that one route
  (`router.get(path, jwtMiddleware, handler)`) rather than at the router level — an
  implementation detail, not a behavior difference. It still requires both the org key and
  `x-fan-token` exactly like the household routes.

`/health` is mounted **outside** this stack entirely, on its own router with its own
stricter rate limiter (60-second window, 10 requests max) — no org auth, no RLS, no JWT.
It optionally self-authenticates (see **Health** below) purely to decide how much detail to
return, not to gate access.

The claim endpoint (`GET /v1/household/claim/:token`) runs the same
rate-limiter → orgAuth → rls → correlationId chain as everything else, but is mounted on its
own router with **no** `jwtMiddleware** — the claim token itself is the credential.

---

## Resolution Endpoints

The core of the platform. Both endpoints resolve an inbound identifier to a canonical fan
record, creating one if needed, and may queue a probable-match conflict for staff review.

### The `identifiers` object — **CHANGED, asymmetric between the two endpoints**

Both resolution endpoints accept an optional `identifiers` object carrying additional
signals (`email`, `name`, `dob`, `zip`, `device_id`, `guardian_email`) alongside the primary
identifier. **The two endpoints no longer treat this object the same way — this is the
biggest correction in this revision.**

**`/v1/resolve` (`resolve.js`) — validates AND normalizes:**
- `identifiers` is optional — omit it, or send `null`, and only the primary identifier is
  used.
- When present, it must be a JSON object — a string, array, or number → 400
  `'identifiers must be an object'`.
- Each recognized field, when present, must be a string (or `null`/absent). A non-string
  field (number, array, object) → 400 `'identifiers field must be a string'`.
- After the type check, `email`, `name`, `dob`, `zip`, and `guardian_email` are each run
  through the same normalizer used for the primary identifier. Any field that fails
  normalization 400s the **whole request** with `'identifiers field failed normalization'`
  and a `detail` message (e.g. a malformed email or an impossible date of birth).
- `device_id` is the one exception — it is passed through **unnormalized**. It is not in the
  normalizer's `ALLOWED_TYPES` list (confirmed: `device_id` has never been added there), so
  there is no normalization function to run it through. This is intentional, not an
  oversight — see the root `CLAUDE.md`'s scoring notes on why `device_id` is a soft signal
  only.

**`/v1/ingest/nfc` (`nfc.js`) — does neither:**
- `identifiers`, when present, is read straight off the request body
  (`body.identifiers || null`) and passed directly into the resolver with **no type
  validation and no normalization at all.** Only `nfc_uid` itself goes through
  normalization on this endpoint.
- Sending a malformed `identifiers` object (wrong type, non-string fields, un-normalized
  casing/whitespace) to `/v1/ingest/nfc` will not 400 the way it does on `/v1/resolve` — it
  is scored as-is by the resolver.

**Practical guidance for the frontend:** if a signal is going through `/v1/resolve`, send
whatever shape the resolve validation expects — it will catch and explain mistakes. If a
signal is going through `/v1/ingest/nfc` (physical taps), send pre-cleaned, well-typed
strings — lowercased email, trimmed/normalized name, ISO date — because nothing on that path
will catch or correct a malformed value before it reaches scoring.

```json
"identifiers": {
  "email": "jane@example.com",
  "name": "Jane Doe",
  "dob": "2010-06-15"
}
```

### Shared resolution response (200)

Both endpoints return the same resolution shape (nfc adds one extra field, see below). The
`match_type` and `is_new_record` fields tell the frontend what happened:

| Field | Type | Notes |
|---|---|---|
| `fan_id` | uuid | The canonical fan this identifier resolved to. |
| `match_type` | string | `'hard'` (certain link) · `'soft'` (high-confidence probable) · `'conflict'` (lower-confidence probable). |
| `is_new_record` | bool | `true` if a brand-new fan was created by this call; `false` if an existing fan was matched. |
| `requires_review` | bool | `true` for soft/conflict matches — a `conflict_queue` row was created for staff review. |
| `conflict_id` | uuid/null | Present (non-null) only when `requires_review` is `true`. |
| `confidence_score` | number | 1.0 for hard matches; the probabilistic score for soft/conflict. |
| `linked_systems` | array | Distinct source systems linked to this fan. Populated only on a hard *existing*-match (`is_new_record: false`); empty array on every other branch. |
| `linked_count` | number | **NEW — not documented in the prior contract.** Companion to `linked_systems`: its length on a hard existing-match, `0` on every other branch. |
| `audit_event_id` | uuid | The `audit_log` row id for this resolution. |

> **CHANGED — concurrent-resolution behavior (identifier uniqueness)**
> Verified against `resolverEngine.js` this session: two requests resolving the same
> brand-new identifier at the same instant now resolve to the same single fan. The loser of
> the race hits the identifier's unique index (Postgres `23505`), the engine catches it,
> re-queries by `idempotency_key`, and returns the winner's fan as a hard match
> (`is_new_record: false`) instead of erroring. No frontend change required — this replaced
> a prior race that could create two fans for the same brand-new identifier.

### POST /v1/resolve

Resolve an inbound identifier (email, phone, nfc_uid, name, etc.) to a fan.

**Request body**

| Field | Type | Notes |
|---|---|---|
| `identifier_type` | string | Required. One of: `email`, `phone`, `nfc_uid`, `nba_id`, `ticketmaster_id`, `name`, `dob`, `zip`, `guardian_email`, `guardian_phone`. |
| `identifier_value` | string | Required. Non-null, non-blank; further validated by the normalizer for the given type (e.g. a real email shape, a parseable phone, a date not in the future). |
| `schema_version` | string | Required. |
| `source_system` | string | Optional, defaults to `'unknown'`. |
| `identifiers` | object | Optional. See the `identifiers` rules above — this endpoint validates and normalizes it. |
| `org_id` | uuid | Optional. If sent, must equal the authenticated org or 400. |

**Responses**

| Status | Meaning |
|---|---|
| 200 | Resolved. Returns the shared resolution shape above. |
| 400 | `org_id` mismatch · missing `identifier_type`/`identifier_value`/`schema_version` · `identifier_value` failed normalization · malformed `identifiers` object or field type · an `identifiers` field failed normalization. |
| 409 | Concurrent write conflict (`record_version`) — `'concurrent write conflict — retry request'`. The caller may retry. |
| 500 | Resolver internal error — generic message only; full detail logged server-side. |

### POST /v1/ingest/nfc

NFC tap ingestion. Resolves an `nfc_uid` to a fan — the entry point for physical taps. Shares
the resolution engine with `/v1/resolve`, but **not** the `identifiers` validation contract
— see above.

**Request body**

| Field | Type | Notes |
|---|---|---|
| `nfc_uid` | string | Required. The raw NFC UID; normalized to a canonical colon-separated hex form. |
| `station_id` | string | Required. Max 128 chars. |
| `schema_version` | string | Required. |
| `tapped_at` | string | Optional ISO 8601. Defaults to now. Rejected if more than 5 minutes in the future or more than 24 hours in the past. |
| `identifiers` | object | Optional. **Not validated or normalized on this endpoint** — see above. |
| `org_id` | uuid | Optional. If sent, must equal the authenticated org or 400. |

**Responses**

| Status | Meaning |
|---|---|
| 200 | Resolved. Resolution shape **plus** `session_ready: true`. |
| 400 | `org_id` mismatch · missing `nfc_uid`/`station_id`/`schema_version` · `station_id` over 128 chars · `tapped_at` not valid ISO 8601, too far in the future, or too far in the past · `nfc_uid` failed normalization. |
| 409 | Concurrent write conflict — `'concurrent write conflict — retry tap'`. |
| 500 | Resolver internal error. |

A normalization failure or a resolver failure on this endpoint is also written to the
`ingest_failures` dead-letter queue server-side (raw `nfc_uid` is sha256-hashed before being
stored — no frontend impact either way).

---

## Session

### POST /v1/session

Issues a fan JWT for an already-resolved fan. Call resolve/ingest first to obtain a `fan_id`,
then exchange it here for a token the fan-scoped endpoints accept.

**Request body**

| Field | Type | Notes |
|---|---|---|
| `fan_id` | uuid | Required. Must be a valid UUID and an existing, non-erased fan in this org. |
| `schema_version` | string | Required. |
| `org_id` | uuid | Optional. If sent, must equal the authenticated org or 400. |

**Responses**

| Status | Meaning |
|---|---|
| 200 | Returns `{ token, fan_id, expires_at, token_type: 'Bearer' }`. Use `token` in `x-fan-token` on fan-scoped calls. |
| 400 | `org_id` mismatch · missing `fan_id`/`schema_version` · `fan_id` not a valid UUID. |
| 403 | Fan record has been erased — `'fan record has been erased — cannot issue session'`. |
| 404 | Fan not found — `'fan record not found — resolve identifier first'`. |
| 500 | Session could not be issued. |

Token lifetime: 15 minutes by default. The frontend should be ready to re-issue a session
when a fan JWT expires (a 401 `'invalid or expired token'` from a fan-scoped call is the
signal).

---

## Profile — **NEW, not in the prior contract**

### GET /v1/fan/:id/profile

Fan-scoped. Returns the fan's linked identifiers and wallet state (Firestore). Requires the
org key **and** a matching fan JWT — `:id` in the URL must equal the JWT's `fan_id` or the
request is 403 before any database work happens.

**Responses**

| Status | Meaning |
|---|---|
| 200 | Success — see both response shapes below. |
| 400 | `fan_id` missing or not a valid UUID. |
| 403 | URL `fan_id` does not match the JWT's `fan_id` (`'forbidden'`) — **or** the fan is genuinely erased (see below). |
| 404 | Fan record not found. |
| 500 | Profile could not be retrieved. |

**200 — normal profile**

| Field | Type | Notes |
|---|---|---|
| `fan_id` | uuid | |
| `org_id` | uuid | |
| `stewardship_tier` | string | Always `'platform'` today — see root `CLAUDE.md`. |
| `record_version` | number | |
| `linked_systems` | array | One entry per `identifier_link` row: `{ type, source, confidence, first_seen, last_seen }`. |
| `wallet` | object | `{ loyalty_points, stamps, avatar }` from Firestore. Missing document, a Firestore read failure, or malformed stored data all resolve to the same safe default: `{ loyalty_points: 0, stamps: [], avatar: null }` — not an error. |
| `record_created_at` | timestamp | |
| `record_updated_at` | timestamp | |

**200 — CHANGED: merged-away fan now forwards to the survivor, instead of a flat 403**

If the fan behind the JWT was soft-deleted **because their record was merged into another
fan** (`merge_history` has an active row with this fan as the source), the endpoint no longer
403s. It returns the **survivor's full profile** — same shape as above — plus two extra
fields:

| Field | Type | Notes |
|---|---|---|
| `merged_from` | uuid | The originally-requested (now-erased) `fan_id` — i.e. the JWT's fan, not the fan actually being returned. |
| `message` | string | Always `'fan record was merged'`. |

This means a client polling `GET /v1/fan/:id/profile` with a stale token for a fan that got
merged away will transparently start seeing the survivor's data (points, stamps, linked
systems) under the same call, rather than needing to detect a 403 and go re-resolve. The
15-minute (or 8-hour child) token still expires normally — this doesn't extend it.

**403 — genuine erasure (unchanged from the old behavior)**

If the fan is soft-deleted for any reason **other** than an active merge (e.g. no
`merge_history` row exists, or in the practically-unreachable case where the merge survivor
is itself also inactive), the response is the original flat 403:

```json
{ "error": "fan record has been erased" }
```

The frontend cannot distinguish "erased via merge, forwarding failed" from "erased,
unrelated to any merge" from this response alone — both produce the identical 403 body.

---

## Conflicts — **NEW, not in the prior contract**

Org-key-only — staff/org tooling, no fan JWT involved. These are the endpoints behind
Golden Record's human-review queue: every soft or probable match (`PATH C`/`PATH D` in the
resolver) lands here as a pending row, and nothing merges automatically.

### GET /v1/conflicts

List conflicts for the authenticated org, filterable by status.

**Query params**

| Param | Type | Notes |
|---|---|---|
| `status` | string | Optional, defaults to `'pending'`. One of: `pending`, `confirmed`, `rejected`, `unmerged`. |
| `limit` | number | Optional, defaults to 50. Must be ≥ 1 and ≤ 100. |
| `offset` | number | Optional, defaults to 0. Must be ≥ 0. |

**Responses**

| Status | Meaning |
|---|---|
| 200 | Returns `{ conflicts[], total, status_filter, limit, offset }`. |
| 400 | `status` not one of the four allowed values · `limit` < 1 · `limit` > 100 · `offset` negative. |
| 500 | Conflict queue could not be retrieved. |

Each entry in `conflicts[]`: `{ conflict_id, fan_id_a, fan_id_b, confidence_score,
signals_matched, status, created_at, reviewed_at }`, ordered by `confidence_score DESC`.

### POST /v1/conflicts/:id/confirm

Confirms a pending conflict as a real match — merges `fan_id_b` into `fan_id_a`. Identifiers
physically move (not copy); `fan_id_b` is soft-deleted.

**Responses**

| Status | Meaning |
|---|---|
| 200 | Confirmed. Returns `{ conflict_id, status: 'confirmed', merged_into, resolved_at }`. |
| 400 | `conflict_id` missing or not a valid UUID. |
| 404 | Conflict not found for this org · `'target fan record not found'` (`fan_id_a` missing). |
| 409 | `'conflict already resolved'` (status is not `pending`) · **`'merge target has been deleted'`** — `fan_id_a` was soft-deleted before this confirm ran; not in the prior contract at all · `'multi-hop merge not supported'` — `fan_id_a` has already absorbed a previous merge and cannot absorb another until that merge is reviewed or reversed (deliberate limitation, see root `CLAUDE.md`). |
| 500 | Conflict could not be confirmed. |

### POST /v1/conflicts/:id/reject

Rejects a pending conflict — both fan records stay separate, no identifiers move, no soft
delete.

**Responses**

| Status | Meaning |
|---|---|
| 200 | Rejected. Returns `{ conflict_id, status: 'rejected', resolved_at }`. |
| 400 | `conflict_id` missing or not a valid UUID. |
| 404 | Conflict not found for this org. |
| 409 | `'conflict already resolved'` — checked twice: once before the transaction opens, once again as a compare-and-swap (`WHERE status = 'pending'`) inside it, so a concurrent reject/confirm racing this one still gets a clean 409 rather than a corrupted double-write. |
| 500 | Conflict could not be rejected. |

### POST /v1/conflicts/:id/unmerge

Reverses a previously confirmed merge — identifiers move back to the original source fan
using the `merged_from_fan_id` provenance column, and the source fan is reactivated.

**Responses**

| Status | Meaning |
|---|---|
| 200 | Reversed. Returns `{ conflict_id, status: 'unmerged', fan_id_restored, fan_id_target, reversed_at }`. |
| 400 | `conflict_id` missing or not a valid UUID. |
| 404 | Conflict not found for this org · `'merge history not found'` — `'this merge cannot be reversed'` (no active `merge_history` row for this conflict). |
| 409 | `'conflict is not confirmed'` — `'only confirmed merges can be reversed'` · `'unmerge already completed'` — compare-and-swap race guard on the `merge_history` status update. |
| 500 | Unmerge could not be completed. |

---

## Household Endpoints

All household endpoints require both the org key and a fan JWT (`x-fan-token`). The JWT's
fan must match the `:adult_fan_id` in the URL, or the request is 403. Child tokens
(`acting_as: 'child'`) are blocked from all of these with 403 (see **Authentication Model**).

### POST /v1/household

Create a household for the authenticated adult fan. One household per adult per org.

| Status | Meaning |
|---|---|
| 201 | Created. Returns `{ household_id, adult_fan_id, org_id, created_at }`. |
| 400 | `adult_fan_id` missing or not a UUID. |
| 403 | Fan not found in org, or fan erased. |
| 409 | Household already exists — response includes the existing `household_id`. |
| 500 | Could not be created. |

### GET /v1/household/:adult_fan_id

Fetch the household and its active children (hard links only). Paginated via `?limit`
(1–10, default 3) and `?offset`.

| Status | Meaning |
|---|---|
| 200 | Returns `household_id` (`null` if none), `adult`, `children[]`, `total_children`, `limit`, `offset`. |
| 400 | Invalid UUID, or `limit`/`offset` out of range. |
| 403 | Token does not match requested household. |
| 404 | Fan record not found. |
| 500 | Could not be retrieved. |

### POST /v1/household/:adult_fan_id/members

Add a child to the household. Creates a child fan record and four `identifier_link` rows
(name, dob, guardian_email, guardian_phone).

**Request body**

| Field | Type | Notes |
|---|---|---|
| `first_name` | string | Required, non-blank. |
| `last_name` | string | Required, non-blank. |
| `dob` | string | Required. Normalized; invalid dates → 400. |
| `guardian_email` | string | Required, non-blank, must normalize as an email. |
| `guardian_phone` | string | Required, non-blank, must normalize as a phone. |

**Responses**

| Status | Meaning |
|---|---|
| 201 | Created. Returns member + child fan ids, `child_name`, `child_dob`, `link_type`, `status`, `staged_match`, `created_at`. |
| 400 | Missing required field, a field is the wrong type, or a field failed normalization. |
| 403 | Token mismatch, or adult fan erased. |
| 404 | Fan not found, or household not found (create the household first). |
| 409 | `'child already has a guardian'` — one active guardian per child per org; shared custody not yet supported. |
| 500 | Could not be created. |

### GET /v1/household/:adult_fan_id/members/:child_fan_id

Fetch a single active child member and all of that child's identifiers. (`claim_token` is
never returned; only its expiry is.)

| Status | Meaning |
|---|---|
| 200 | Returns the member detail and `identifiers[]`. |
| 400 | Invalid adult or child UUID. |
| 403 | Token mismatch, or fan inactive. |
| 404 | Fan, household, or member not found. |
| 500 | Could not be retrieved. |

### PUT /v1/household/:adult_fan_id/members/:child_fan_id

Update one or more child fields. Partial updates allowed — send only the fields you are
changing. At least one editable field is required.

**Request body (all optional, at least one required)**

| Field | Type | Notes |
|---|---|---|
| `first_name` / `last_name` | string | If only one is sent, the other half is read from the existing stored name. |
| `dob` | string | Updates both the identifier and the member `dob`. |
| `guardian_email` | string | Normalized as email. |
| `guardian_phone` | string | Normalized as phone. |

| Status | Meaning |
|---|---|
| 200 | Updated. Returns `updated_fields[]` and `updated_at`. |
| 400 | Invalid UUID, no editable fields provided, a field is the wrong type, or a field failed normalization. |
| 403 | Token mismatch, or fan inactive. |
| 404 | Fan, household, or member not found. |
| 500 | Could not be updated. |

### DELETE /v1/household/:adult_fan_id/members/:child_fan_id

Sever a child link (soft — the child fan record, identifiers, and wallet are untouched).
Sets status to `'severed'`.

| Status | Meaning |
|---|---|
| 200 | Severed. Returns member id, `status: 'severed'`, `severed_at`, `severed_by`. |
| 400 | Invalid adult or child UUID. |
| 403 | Token mismatch, or fan inactive. |
| 404 | Fan, household, or member not found. |
| 409 | Member is not active (already severed or aged up). |
| 500 | Could not be severed. |

### POST /v1/household/:adult_fan_id/members/:child_fan_id/session

Issue a child session JWT (8-hour expiry, `acting_as: 'child'`). The child token is
restricted — it cannot manage household accounts.

| Status | Meaning |
|---|---|
| 200 | Returns `{ token, expires_at, minor_fan_id, acting_as: 'child' }`. |
| 400 | Invalid adult or child UUID. |
| 403 | Token mismatch. |
| 404 | Fan, household, or active member not found. |
| 500 | Could not be issued. |

### POST /v1/household/:adult_fan_id/members/:child_fan_id/age-up

Begin aging up a child — marks the member `'aged_up'` and generates a single-use claim token
(30-day expiry) the child later redeems to claim their own profile.

| Status | Meaning |
|---|---|
| 200 | Returns member id, `status: 'aged_up'`, `aged_up_at`, `claim_token_expires_at`. (The raw claim token is never returned in the response — it is delivered out-of-band, currently logged as an email stub server-side.) |
| 400 | Invalid adult or child UUID. |
| 403 | Token mismatch, or fan inactive. |
| 404 | Fan, household, or member not found. |
| 409 | Member already aged up, or has been severed. |
| 500 | Could not be completed. |

> **CHANGED — age-up is race-safe**
> Two concurrent age-up calls on the same child now resolve to exactly one success (200) and
> one 409 — only one claim token is ever generated, via a compare-and-swap (`WHERE status =
> 'active'`) on the update.

### GET /v1/household/claim/:token

Org-key only, **no fan JWT**. The child presents the claim token forwarded by the guardian to
claim their profile and receive a standard fan JWT. Single-use.

| Status | Meaning |
|---|---|
| 200 | Claimed. Returns `{ fan_id, token, expires_at, claimed_at }`. The claim token is consumed (single-use). |
| 400 | Claim token missing. |
| 403 | Child fan record inactive. |
| 404 | Claim token not found (no match, or already consumed and cleared). |
| 410 | Claim token has expired — **or** was just consumed by a concurrent claim (single-use enforced). |
| 500 | Could not be claimed. |

> **CHANGED — claim is strictly single-use under concurrency**
> Two concurrent claims with the same token now yield exactly one 200 and one 410, via a
> compare-and-swap (`WHERE claim_token IS NOT NULL`) on the clearing update. A token can be
> redeemed once and only once. The frontend should treat 404 and 410 on claim as "this link
> is no longer usable."

---

## Admin (staff-facing) — **NEW, not part of the fan app**

> **This section is not something King integrates against today.** It's included because
> the endpoint exists on the same service and touches the identity data model directly, and
> whether a dedicated staff view ships this sprint is still an open scope question. Better
> documented and unused than missing if the answer becomes "yes."

### GET /v1/admin/household/:fan_id

Staff-facing read-only view of a fan's full household history — every household record,
every membership at every status (active, severed, aged up — not just active like the
fan-facing household endpoints), unpromoted soft links, and `related_fans` entries. Org key
only, no fan JWT. `claim_token` is never returned, same as the fan-facing member endpoints.

| Status | Meaning |
|---|---|
| 200 | Returns `{ fan_id, deleted_at, created_at, households[], memberships[], soft_links[], related_fans[] }`. |
| 400 | `fan_id` missing or not a valid UUID. |
| 404 | Fan not found for this org. |
| 500 | Admin household view could not be retrieved. |

---

## Health Endpoint

### GET /health

Liveness/readiness probe. Works with or without auth; returns more detail when a valid org
key is presented. Mounted outside the main middleware stack on its own stricter rate limiter
(60-second window, 10 requests max) — see **Middleware stack order** above.

| Status | Meaning |
|---|---|
| 200 | Healthy. `{ status: 'ok', timestamp }` unauthed; adds `{ db, queue_depth }` when authed. |
| 503 | Degraded (db disconnected or `queue_depth` ≥ 10000). Same shape as 200 by auth tier. |

---

## Error Response Shape

All error responses are JSON with an `error` field, and often a human-readable `message` or
`detail`. Examples:

```json
{ "error": "identifiers must be an object",
  "message": "identifiers, when provided, must be a JSON object of signal fields" }

{ "error": "child already has a guardian",
  "message": "this child already has an active guardian in this organization; ..." }

{ "error": "unauthorized", "message": "invalid or expired token" }
```

Every response also carries an `X-Correlation-Id` header — include it when reporting a
backend issue so the request can be traced in logs.

---

## What the frontend cannot get today

King's current designs assume five things this API does not provide. Better to know now
than at integration:

- **No fan-visible conflict status endpoint.** `/v1/conflicts` is org-key/staff-scoped only
  — a fan has no way to ask "is my identity under review?"
- **No short human-readable conflict reference code.** `conflict_queue.id` is a bare UUID;
  there is no shorter code to show or reference in a support flow.
- **No points, XP, quests, or rewards.** Firestore's wallet doc always holds
  `loyalty_points: 0` and `stamps: []` — confirmed no code path anywhere writes a non-zero
  value or a stamp. The only two Firestore writes in the system are `.set()` calls at fan
  creation, both writing these same zero/empty defaults.
- **No avatar upload or update.** The Firestore `avatar` field is always `null` — nothing
  writes to it.
- **No staff identity.** `resolved_by`/`merged_by`/`severed_by`/`aged_up_initiated_by` are
  the org's name (a TEXT field), never an individual staff member — there is no staff auth
  layer in this system today.

---

## Coverage & Open Items

This contract reflects every endpoint whose handler was read against current source on
2026-08-02. The following are known and worth coordinating:

- **`identifiers` normalization is asymmetric between the two resolution endpoints —
  confirmed, not yet closed.** `/v1/resolve` normalizes strictly; `/v1/ingest/nfc` does not
  normalize the `identifiers` object at all (only `nfc_uid` itself). See **Resolution
  Endpoints** above for the practical guidance. The remaining open work is closing the
  `nfc.js` half — Sprint 5's fuzzy name matching softens the whitespace/casing impact on that
  path, but not the email half, and email comparison is now exact (not fuzzy), so an
  unnormalized email arriving via NFC is more likely to silently fail to match than it was
  before Sprint 5.
- **Household-endpoint malformed-input fuzz pass is still pending**, same status as the prior
  contract — field-level validation exists on every household route (confirmed while reading
  each handler this session), but the dedicated fuzz pass done on `/v1/resolve` has not been
  extended to household request bodies.
- **TASK-12 has not shipped.** See the callout under **Authentication Model** — the `aud`
  claim is still `'golden-record'`, confirmed by reading `src/modules/jwt.js` directly this
  session (both the signing and verification code paths).
- **CORS `allowedHeaders` — updated 2026-08-02.** The list is now
  `['Content-Type', 'Authorization', 'X-Fan-Token']`, exported from `index.js` as
  `ALLOWED_HEADERS` (single source of truth — `tests/cors.preflight.test.js` asserts against
  the real app rather than a hand-copied array). `X-Correlation-Id` was removed the same
  session: `correlationIdMiddleware.js` only ever sets this header on the response, it never
  reads an inbound value, so allowing it through preflight was permitted-but-unread — same
  shape as the `X-Api-Key`→`Authorization` swap this list already went through. Accepting an
  inbound value for cross-system tracing is a real feature but a behavior change to that
  middleware; deferred to its own prompt if it ever ships.
- **Firestore-backed `wallet` fields on `GET /v1/fan/:id/profile` are always the empty
  default today** (see **What the frontend cannot get today**) — not a bug, just worth
  restating here since it's easy to assume a working profile response implies working wallet
  data.
- **The merge-forwarding behavior on `GET /v1/fan/:id/profile` cannot be distinguished from
  genuine erasure by status code alone in the 403 case** (see **Profile** above) — only the
  200-with-`merged_from` case is distinguishable. If the frontend needs to tell "this fan was
  merged, forwarding failed" apart from "this fan is erased, unrelated to any merge," that
  distinction does not exist in the current response shape.

If the frontend needs an endpoint not listed here, it has not yet been documented against
source — ask and it will be added.
