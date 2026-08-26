# CLAUDE.md — Golden Record

Fan identity resolution platform. OKC Thunder Innovations Cohort. Sole backend engineer: Aaron Franklin.
Stack: Node.js / Express · Postgres (Cloud SQL) with RLS · Firestore (named DB `golden-record`) · Cloud Run · GCP.
Last updated: 2026-08-02.

**This file = PROJECT KNOWLEDGE ONLY.** Agent behavior rules live in `.claude/CLAUDE.md`.
Do not duplicate agent rules here — duplication causes drift. This file replaces the
April v1.0 root CLAUDE.md and the project-knowledge tail that was appended to
`.claude/CLAUDE.md`. Those were stale and contradicted the code (see Firestore section).

---

## How to work with Aaron

- **Trace real code, never infer.** Before writing any fix or test, read the actual file. Past sessions burned time on stale inferences that didn't match the real code. If a file isn't in context, ask for it rather than guessing field names, messages, or status codes.
- **Pattern first, why before how.** Aaron's Kolbe is 7373 (high Fact Finder + Quick Start, low Follow Thru + Implementor). Name the framework, give the concrete example, then the detail. Avoid abstract-first explanations.
- **No auto-decisions.** Never let a fix make a silent judgment call. If a fix has an open product/architecture decision inside it, surface the options and get an explicit answer first.
- **One concept per step when teaching.** When Aaron asks for an explanation, go slow, one new idea at a time, with concrete examples tied to his own schema.

---

## Claude Code prompt format (required structure)

Every fix prompt must have:
1. **Context** — what's broken, why it matters, whether it's live or defensive.
2. **File / test file / build-order step / dependencies.**
3. **THE FIX** — exact before/after code.
4. **THE TEST** — what to seed, call, assert (numbered assertions). Include a regression assertion proving the fix doesn't break the happy path.
5. **DO NOT** — explicit scope boundaries.
6. Always: "Write plan to tasks/todo.md before touching any file. Check in before implementation."

Locked conventions for prompts:
- Tests connect ONLY to local Postgres (`localhost:5432`). Confirm `DATABASE_URL` in `.env` before any write.
- `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/golden_record`
- Tests use a dedicated test org with fresh UUIDs; clean up in FK order in a `finally` block.
- `audit_log` is append-only — DELETE fails by design. Leave audit rows; clean up everything else. Each test run uses fresh UUIDs so orphaned audit rows are inert.
- Middleware-level guards (auth, RLS) must be tested through the real Express app via supertest — NOT by calling handlers directly. Handler-level logic can call the handler/module directly.
- For tests needing API-key auth, hash the test key the same way orgAuthMiddleware does: `crypto.createHash('sha256').update(rawKey).digest('hex')`.

---

## Code pattern — RECEIVE / GUARD / EXECUTE / RETURN

Every function and handler follows this four-section pattern. No exceptions.

```
RECEIVE   — collect inputs, assign to named variables
GUARD     — validate everything before any real work begins
EXECUTE   — do the actual work (module calls, db reads, db writes)
RETURN    — send the response or return the value
```

**EXECUTE dependency order — never deviate:**

| Step | What runs | Why |
|---|---|---|
| 1 | Module / utility calls | Transform or validate before anything touches the database |
| 2 | Database reads (SELECT) | Read before write. Verify things exist. |
| 3 | Database writes (INSERT/UPDATE) | Inside transaction if multiple writes |
| 4 | Audit event | Always last write inside transaction |

---

## Middleware stack order — this is law

Never deviate. Never add middleware outside this sequence without updating this file first.

```
rate limiter
  → orgAuthMiddleware        // who is calling? validates org API key
    → rlsContextMiddleware   // sets Postgres session var app.current_org_id, attaches req.db
      → correlationIdMiddleware // assign request UUID, attach to context + response header
        → jwtMiddleware         // is the fan token valid? attaches fan_id to context
          → handler             // do the actual work
```

All three protected routers wire this five-step chain. Each middleware depends on the
one before it having run. Wrong order = context missing fields = silent failures that
are hard to debug.

| After middleware | `req.context` contains |
|---|---|
| orgAuthMiddleware | org_id, org_name |
| rlsContextMiddleware | org_id, org_name (unchanged — adds no `req.context` field; sets the Postgres session variable and attaches `req.db` instead) |
| correlationIdMiddleware | org_id, org_name, correlation_id |
| jwtMiddleware | org_id, org_name, correlation_id, fan_id, acting_as |

`/health` is mounted OUTSIDE this stack entirely: its own stricter rate limiter (60s
window / 10 req), no auth, no RLS, no JWT.

---

## Error sanitization rule — this is law

**Internal error details never reach the caller. Ever.**

Caller gets: a generic message + the correlation_id.
Logs get: full error detail, org_id, correlation_id, stack trace.

Correct:
```javascript
catch (err) {
  logger.error('descriptive internal message', {
    error:          err.message,
    org_id:         org_id,
    correlation_id: req.context.correlation_id
  });
  return res.status(500).json({ error: 'generic message safe for caller' });
}
```

Never: `return res.status(500).json({ error: err.message })` — exposes internals.

Why: specific error messages reveal internal structure to attackers. Stack traces,
table names, query structure, and key names have no business in a response body.

---

## TRY/CATCH patterns

| Pattern | When | Components |
|---|---|---|
| 1 — TRY wraps EXECUTE only | All guards are in-memory checks | orgAuthMiddleware, correlationIdMiddleware, jwtMiddleware, POST /v1/session, GET /v1/fan/:id/profile, household routes |
| 2 — TRY wraps GUARD and EXECUTE together | GUARD has db calls that can throw | resolverEngine |
| 3 — Multiple TRY/CATCH blocks | Different failure modes need different DLQ reason codes | POST /v1/ingest/nfc |

---

## Custom error types

| Error | Thrown by | Caught by |
|---|---|---|
| NormalizationError | normalizer.js | Adapter layer → 400. Written to ingest_failures DLQ. |
| JWTError | jwt.js | jwtMiddleware → 401. Internal reason never exposed. |
| ConflictError | resolverEngine | Endpoint layer → 409. Client should retry. |
| ResolverError | resolverEngine | Endpoint layer → 500. Failure audit written before throw. |
| StartupError | jwt.js init | Thrown at startup if keys missing. Prevents Cloud Run start. |

---

## HTTP status code rules

| Code | Meaning in this system |
|---|---|
| 200 | Success |
| 400 | Bad input — normalization failure, missing required field, non-string body field |
| 401 | Unknown caller — missing or invalid credentials |
| 403 | Known caller, access denied — inactive org, erased fan, JWT mismatch, child token on household route |
| 404 | Record not found |
| 409 | Conflict — concurrent write, already-resolved conflict, multi-hop merge block, duplicate guardian |
| 410 | Gone — expired claim token (NOT 404) |
| 500 | Internal failure — generic message only, full detail in logs |
| 503 | Degraded — health check only |

**401 vs 403:** 401 = I don't know who you are. 403 = I know who you are but you cannot proceed.

---

## Architecture invariants (do not violate)

- **Tenant isolation is absolute.** `org_id` on every table, in every query, plus RLS (`FORCE ROW LEVEL SECURITY`) at the DB level. `org_id` always comes from `req.context` (set by orgAuthMiddleware), never trusted from the request body. Body `org_id` mismatch → 400. **NOTE: this holds in Postgres only — see Firestore section for the gap.**
- **Guards before transactions.** Validate everything (Zone 1) before `BEGIN`. No wasted DB work on bad input. Open transactions as late as possible — early open = longer lock hold.
- **Pure functions, no side effects:** normalizer.js, probabilisticMatcher.js, jwt.js — no DB, no network. normalizer.js exports `NORMALIZATION_VERSION = 'v1'` (Stage 7), stamped onto every `resolution_trace` row alongside `SCORER_VERSION`.
- **audit_log is always the LAST write inside every transaction.** It records what already happened. If the audit write fails the whole transaction rolls back. No write ever exists without a corresponding audit event. Append-only is DB-enforced by the `enforce_audit_log_append_only` trigger (`prevent_audit_log_mutation`, migration_003) — fires on UPDATE OR DELETE regardless of connecting role, including superuser. This closes the "needs Tanner" item that used to sit in Open (see Open — RLS/superuser note for the related but distinct gap this does NOT close). `resolution_trace` (Stage 7) uses the same append-only-trigger pattern. **Split verdict vs. a REVOKE, verified via `pg_trigger`:** stronger than a REVOKE for UPDATE and DELETE (applies regardless of role, including superuser — a REVOKE can't bind a superuser). WEAKER than a REVOKE for TRUNCATE, which bypasses both `enforce_audit_log_append_only` and `enforce_resolution_trace_append_only` entirely — both are `FOR EACH ROW` on UPDATE OR DELETE (tgtype bit 32 unset on both), and row-level triggers never fire on TRUNCATE; that requires a separate `FOR EACH STATEMENT` trigger on the TRUNCATE event, which does not exist. (`information_schema.triggers` can't show this either way — TRUNCATE triggers aren't part of the SQL standard it models; `pg_trigger` is the authoritative source.) TRUNCATE guard tracked as a new Open item.
- **`rlsContextMiddleware`'s `set_config` is session-scoped (`false`), not transaction-scoped (`true`) — deliberately, despite migration_003's Part 3 comment recommending `true`.** The middleware runs outside any explicit transaction, so a transaction-scoped setting would expire before the handler's queries or resolverEngine's later `BEGIN` ever saw it. Do not "fix" the code to match the migration comment. Consequence: session settings persist on a pooled connection past `client.release()` — node-postgres does not `DISCARD` automatically. A released client can carry the prior request's `app.current_org_id` and `statement_timeout` into the next request that gets that connection. Inert today (only `orgAuthMiddleware` and `health.js` use `pool` directly, and `org` isn't RLS-protected) but arms the moment any code queries an RLS-protected table via `pool` instead of `req.db`. Tracked as a new Open item.
- **Postgres is truth; Firestore is enhancement.** Firestore sync runs AFTER commit, failures are caught/logged/swallowed, never block the response or roll back Postgres. (`PERMISSION_DENIED` locally is expected.)
- **Application guards are optimizations; database constraints are guarantees.** "Check then insert" has a race window — the unique index is the real protection.
- **Blocking sets a hard RECALL CEILING.** Anything in no block is unreachable regardless of threshold tuning — not "scores lower," never scored. Same shape as the DOB veto (Scoring section): a chosen, documented loss in exchange for a guarantee. Do NOT close the gap by adding a fallback unnarrowed scan; that reintroduces the exact failure blocking fixed, hidden under a layer that looks principled. The correct responses are a new block key or persisting more identifiers — both product decisions.
- **Soft delete only.** Fan records are never hard-deleted (`deleted_at` set instead). This is what makes merges reversible.
- **migration_003 is APPLIED** — its own file header still says "DO NOT RUN — blocked on GCP credentials" (not edited; that's the migration file's job, not this file's). Verified this session: `enforce_audit_log_append_only` exists on `audit_log` firing on UPDATE and DELETE; RLS is enabled AND forced on 13 tables, each with a `tenant_isolation` policy; `org` is exempt by design (it's the auth table).
- **Use `req.db` (RLS-scoped) inside routes; `pool` directly only where RLS context isn't set yet** (orgAuthMiddleware, health.js).
- **Parameterized queries ($1, $2) everywhere** — never concatenate values into SQL strings.
- **Raw API keys are never stored** — only `sha256(rawKey)`. JWT private key never logged, never returned.
- **`fan_id` in URL params is always verified against the JWT claim** before any db call.
- **`deleted_at` check required** before issuing a JWT or returning a profile.
- **Child tokens (`acting_as: 'child'`) may never manage household accounts.** Enforcement is a router-level `router.use()` guard at the TOP of the route file, not inside individual handlers — this prevents silent omissions when new routes are added. → 403 `'child tokens cannot manage household accounts'`.

---

## Blocking (retrieval) — resolverEngine.js

**Replaced a `LIMIT 100` scan that was a correctness ceiling, not a perf issue.** The
pre-blocking candidate query took 100 arbitrary fans per org with no `ORDER BY` and no
narrowing. At Thunder scale (2.3M CRM + 1.7M Ticketmaster records) the true match was
essentially never among those 100 — real duplicates silently became PATH B while the system
returned a clean `200`. No error, no signal anything was wrong. `findBlockCandidates`
(resolverEngine.js) replaces it: narrow to fans sharing an exact key with the inbound tap,
then score only within that set.

**Three keys, unioned:**
- `email` — exact `identifier_link` probe
- `guardian_email` — exact `identifier_link` probe
- `name_dob` — self-join on `name_last_word` + exact `dob`

`name_dob` keys on the **last word of the name**, not the full name. Exact-string blocking
on a fuzzy-compared field would drop the jon/john case Sprint 5 fixed to preserve. Last-word
keying retrieves 'bob smith' and 'robert smith' under the same key ('smith') — `dob` carries
the selectivity, and the fuzzy name comparison still runs downstream, inside scoring, on
whatever this key retrieves.

**UNION, not intersect — deduped on `fan_id`.** Intersecting would shrink the reachable set
to the weakest key; adding a key would make recall *worse* instead of better. Union means
every key is a strictly additive candidate source.

**`BLOCK_SIZE_CAP = 50` — a block over the cap is DROPPED WHOLE, not truncated.** At that
size the key has failed to discriminate and its members are close to random relative to the
truth; scoring them risks manufacturing a false conflict, which is worse than missing a
duplicate. A hard drop is also deterministic with no `ORDER BY` — a truncated LIMIT would
silently return an arbitrary 50 of the block.

**Oversized blocks are only reachable via `guardian_email`.** `uq_identifier_per_org`
(migration_013) makes a duplicate identifier value structurally impossible within an org
outside `source_system = 'fan_pass'` rows — so the `email` key can never produce a block
bigger than 1 live fan. The cap only ever fires on `guardian_email`, because household
sibling rows are deliberately written with `source_system = 'fan_pass'` to bypass that same
index. Non-obvious — currently visible only as a side effect of how the oversized-block test
fixture had to be built (Lesson 25).

**REPLACE, not wrap.** No fallback to an unnarrowed scan when a block comes back empty or
gets dropped. A fallback would write `candidates_considered: 100, candidates_scored: 100, no
match` — claiming a search happened when the system actually sampled 100 arbitrary fans out
of millions. See the recall-ceiling invariant, above (Architecture invariants).

**Self-join at query time; a materialized `blocking_key` table is the deferred production
answer.** `findBlockCandidates` self-joins `identifier_link` per request. A materialized
`blocking_key (fan_id, key_type, key_value, org_id)` table is the intended production
shape — same retrieval, no per-request self-join. Not built. A fourth block key is a
separate, equally deferred extension — new keys are additive (see UNION, above), not a
redesign.

**migration_016** adds `identifier_link.name_last_word` (generated column:
`substring(identifier_value from '[^[:space:]]+$')`, `CASE`-guarded to
`identifier_type = 'name'`, `STORED`), a partial index
(`idx_identifier_link_name_last_word`), and four `resolution_trace` columns:
`block_keys_available` (`text[]`), `block_results` (`jsonb`, per-key
`{key, block_size, dropped}` — deliberately not CHECK-constrained, see the
`audit_log.event_type` lesson), `blocks_dropped` (`integer`), `block_size_cap` (`integer`).

**Three skip reasons, in precedence order —
`no_block_key` → `block_dropped_oversize` → `empty_block`:**
- `no_block_key` — nothing to search on. **This is the recall ceiling** (see Architecture
  invariants).
- `block_dropped_oversize` — a deliberate miss: a block existed and was thrown out for
  exceeding the cap.
- `empty_block` — every available key ran and came back with nothing. The system working as
  intended — no duplicate exists.

Dropped beats empty deliberately: a deliberate miss must never be masked by a sibling block
that legitimately came up empty.

**What blocking retired as *retrieval* paths (not as scoring signals).** `name_plus_zip`,
`name_alone`, and `device_id` can still fire inside `scoreMatch` — but only as tiebreakers
among candidates another key already surfaced. None of the three can *originate* a match
anymore; only `email`, `guardian_email`, and `name_dob` can retrieve a candidate in the
first place. (`device_id` was already excluded from ever backing an `identifier_link` row —
see Scoring — so this changes nothing new for it.)

**PATH B fans minted by a bare NFC tap are structurally unreachable by all three keys.**
PATH B/C/D write exactly one `identifier_link` row — the singular
`identifier_type`/`identifier_value` from the tap (see The four resolution paths, below);
everything in the `identifiers` object is scored and discarded, never persisted. A fan
minted from a bare `nfc_uid` tap therefore holds only an `nfc_uid` row — no `email`, no
`guardian_email`, no `name`+`dob` pair — so none of the three block keys can ever retrieve
it on a later tap. Measured on the demo org (`scripts/seedDemoOrg.js`): 2 of 10 fans are
unreachable this way (the fans minted by Scenario 2's and Scenario 3's NFC taps). Closing
this is a product decision about persisting advisory identifiers from a tap, not a code
change.

---

## The four resolution paths (resolverEngine.js)

- **PATH A** — exact identifier_link match (hard match). `match_type: 'hard'`, `is_new_record: false`, confidence 1.0. Updates `last_seen_at`. JOINs `fan` and checks `deleted_at IS NULL` (a deleted fan's tap falls through to PATH B).
- **PATH B** — no match. New fan created. `match_type: 'hard'`, `is_new_record: true`, confidence 1.0. (`'hard'` here means "this link is certain," not "fan existed before" — `is_new_record` answers that.)
- **PATH C** — soft match, score ≥ 0.85. `match_type: 'soft'`. Mints a NEW fan and creates a pending `conflict_queue` row for staff review.
- **PATH D** — soft match, 0.60 ≤ score < 0.85. `match_type: 'conflict'`. Also mints a new fan + pending conflict_queue row.

**Nothing auto-merges.** PATH C and PATH D both create a pending conflict_queue row and
wait for a human. The difference is confidence and review priority, not automation.
The actual merge happens only on `POST /v1/conflicts/:id/confirm`.

Inbound shape: `/v1/resolve` and `/v1/ingest/nfc` accept an optional `identifiers: {}` object
(email, name, dob, zip, device_id, guardian_email) alongside the singular
`identifier_type`/`identifier_value`. The singular field wins on conflict. Without this,
only one signal could ever fire and PATH C was unreachable. The identifiers object is
type-checked (string-or-absent) and normalized (email, name, dob, zip, guardian_email) via
the shared `normalizeIdentifiersObject` (normalizer.js) — **both `/v1/resolve` and
`/v1/ingest/nfc` call it identically**, so normalization no longer varies by endpoint.
`device_id` passes through unnormalized on both routes — not in `ALLOWED_TYPES` (see Scoring).

Eligibility gate (`passesSignalEligibilityGate`, resolverEngine.js, called in the candidate
loop before scoreMatch): existence-only — it checks fields are non-null, never compares
values. PASS if ≥1 STRONG signal OR ≥2 WEAK signals; FAIL → skip candidate (no entry in
signals_matched).
- STRONG: `email_similarity`, `name_plus_dob`, `guardian_email`
- WEAK: `name_plus_zip`, `device_id`, `name_alone`

**Structurally inert under blocking.** Every candidate that reaches the gate was retrieved
by a block key whose own STRONG signal is guaranteed to fire on that candidate (see
Blocking, above) — so every block-retrieved candidate passes by construction.
`candidates_gated` is 0 on every resolution today. This is kept deliberately, not dead
code: it's the safety net for a future fourth block key that might not carry the same
guarantee, and for `all_candidates_gated`, which is real and reachable through
resolverEngine's mocked-DB test coverage (resolverEngine.test.js) even though
`tests/modules/resolverEngine.trace.test.js` documents it as unreachable through real block
retrieval (`test.skip`, with the full reasoning inline).

PATH B, C, and D each write exactly ONE `identifier_link` row — the singular
`identifier_type`/`identifier_value` from the tap. Fields arriving in the identifiers
object are SCORED but never PERSISTED. Consequence: a fan cannot accumulate both a name
row and a dob row from a single call. Multi-identifier fans are only built via multiple
resolves plus a merge (PATH C/D → confirm consolidates identifier_link rows onto the
target). This materially affects fixture and seed-script design.

Candidate query is retrieval-narrowed via blocking, not a `LIMIT 100` scan — see Blocking,
above.

Thresholds: PATH C 0.85, PATH D 0.60. **Monique confirmed these against the PRE-Sprint-5
scorer.** Scores shifted in Sprint 5 (the name double-count that could push a single
name+DOB to 1.0 is gone) — worth re-confirming with her, do not assume they still hold.

---

## Scoring (probabilisticMatcher.js) — post-Sprint-5

**Signature (Stage 7):** `scoreMatch(candidateRecord, inboundIdentifiers, now = Date.now())`.
The third arg is an injected clock (epoch ms) — strict, throws `NormalizationError` on
non-finite input (no silent coercion of a bad clock into a plausible-looking wrong score).
Default preserves production behavior; only the Stage 7 evaluation harness injects a frozen
clock. `getRecencyMultiplier` and `monthsBetween` also take a trailing `now = Date.now()`.
Still a pure function — deterministic, no side effects — just no longer implicitly
wall-clock-dependent.

**Additive with disagreement penalties, clamped to [0,1].** Agreement signals sum
(`score = Math.min(1.0, score + adjusted)`, `let score = 0.0` must stay — was `Math.max`,
a bug), then conflict penalties subtract once, then `Math.max(0.0, Math.min(1.0, score))`.
Penalties are NOT recency-adjusted — a conflict is a conflict regardless of staleness.
`signals_matched` holds only the best candidate's signals; only matters for PATH C/D.

**DOB veto — safety invariant, NOT a config dial.** Conflicting DOB (present on both,
different) → hard block: `scoreMatch` returns
`{score: 0.0, signals_matched: [], conflicts_detected: [dob], dob_veto: true}`
before any signal is scored, so no agreement signal (not even a perfect email) can
override it. **Per-candidate, not per-request** — the inbound may still match a different
candidate whose DOB agrees. resolverEngine is unaware: a vetoed candidate scores 0 and
loses in the existing loop. A cross-DOB merge is a privacy incident regardless of
objective. Do not make this tunable.

**`name_alone` no longer double-counts.** When `name_plus_dob` fires, `name_alone` must NOT
also fire for the same name (`nameCountedInCompositeSignal` flag). Pre-Sprint-5 a matching
name+DOB scored 1.0 (0.7 + 0.3) — the same name paid twice, straight to PATH C off one
name and one birthday. Now 0.7. `name_plus_zip` does NOT suppress `name_alone`.

**Comparison functions (re-aimed Sprint 5 — they were backwards):**
- **email → EXACT.** Near-miss emails are different people, not typos
  (`jsmith@` vs `jsmith2@` scored ~0.94 under the old fuzzy rule and fired as a match).
  Signal key stays `email_similarity` for persisted conflict_queue JSON compatibility and
  because passesSignalEligibilityGate's STRONG list keys off it. `similarity` is 1.0 or
  the signal doesn't fire.
- **name → FUZZY**, `levenshteinSimilarity >= SIGNAL_CONFIG.comparison.name_similarity_threshold`
  (0.85). 'jon smith'/'john smith' = 0.9 passes. Threshold is tighter than it looks: 'jon'
  vs 'john' ALONE is 0.75 and would fail — it only passes on full-name strings.
  **Does NOT handle nicknames** ('bob smith'/'robert smith' ≈ 0.67) — Levenshtein measures
  typos, not synonyms. Nickname matching remains unimplemented (own body of work).
- `normalizedNameMatch` is called in four places (name_plus_dob, name_plus_zip, name_alone,
  detectConflicts). Changing the body re-aims all four consistently — that is intentional.
  A name that fuzzy-matches must not also be flagged as a name conflict.

**SIGNAL_CONFIG** is the single source of truth:
- `agreement` — mirrors SIGNAL_WEIGHTS (email_similarity 0.7, name_plus_dob 0.7,
  name_plus_zip 0.6, guardian_email 0.65, device_id 0.5, name_alone 0.3)
- `disagreement` — email 0.3 / name 0.2 / zip 0.1. **Placeholders. Thunder-owned.**
  **No `dob` key** — dob is a veto, never a penalty.
- `comparison.name_similarity_threshold` — 0.85

`SIGNAL_WEIGHTS` still exists and the six signal blocks still read from it; `SIGNAL_CONFIG.agreement`
mirrors it. Consolidating the two was deliberately left out of Sprint 5 — surface it before doing it.

**`device_id` is intentionally absent from normalizer `ALLOWED_TYPES` — always has been**
(`git log -S "device_id" -- normalizer.js` returns empty: never added, never removed).
Consequence: `device_id` is a SOFT SIGNAL ONLY. It can never back an `identifier_link` row
and therefore can never produce a PATH A hard match — a fan tapping from the same device
scores 0.5 (its agreement weight) rather than matching deterministically. This is intended
behavior, not a gap: a device is evidence of identity, not a claim to it (shared tablets,
borrowed phones, resold hardware). resolve.js's own exclusion comment
(`device_id excluded — not in normalizer ALLOWED_TYPES`) shows this was already known at
least once.

**Exports (Stage 7 added three):** `scoreMatch, detectConflicts, SIGNAL_CONFIG,
getRecencyMultiplier, SCORER_VERSION, computeScorerFingerprint`. `SCORER_VERSION` is a
composite string `'v1+<8-hex>'` — the `v1` prefix is hand-bumped when scoring LOGIC changes,
the 8-hex suffix is an auto sha256 fingerprint over `SIGNAL_CONFIG` + `SIGNAL_WEIGHTS`
(order-independent) that changes whenever CONFIG changes. Both are stamped onto every
`resolution_trace` row (see Status — Stage 7) so a trace can be tied back to the exact
scoring logic + config that produced it.

`scoreMatch` returns `{score, signals_matched, conflicts_detected, penalties_applied}`
(+ `dob_veto: true` on a veto). resolverEngine reads only `score` and `signals_matched`;
extra keys are ignored by design.

---

## Firestore — READ THIS, the April doc was wrong

**Named database: `golden-record`. Collection: `golden-record`.** (The April CLAUDE.md said
collection `fans` — that was never true in code.)

Document ID = `fan_id` (UUID matching Postgres `fan.id`).
Shape: `{fan_id, org_id, loyalty_points, stamps, avatar, created_at}`.

**The complete Firestore surface is three touchpoints — there is no other Firestore code:**
1. `resolverEngine.js` — `.set()` after COMMIT, when `is_new_record === true`
2. `household.js` — `.set()` after commit, on child fan creation
3. `profile.js` (`GET /v1/fan/:id/profile`) — `.get()`

**Two writes, both `.set()` at creation. One read. Zero updates. Zero deletes.**

Consequences that follow from that, all currently inert but real:
- **The April doc said "written on PATH B (new record) only" — false.** The condition is
  `is_new_record === true`, which is **PATH B, C, and D**. Every soft match mints a new fan
  and therefore a new Firestore doc.
- **Orphan docs accumulate and nothing cleans them.** Three sources: (a) merge soft-deletes
  fan B in Postgres, doc B stays forever; (b) every confirmed PATH C/D conflict orphans the
  fresh doc that was minted for the new fan; (c) `deleted_at` never propagates to Firestore.
  Firestore doc count drifts permanently from live-fan count. Sweepable later —
  `merge_history` records exactly which docs to reconcile.
- **Tenant isolation is NOT enforced in Firestore.** The collection is flat, keyed by bare
  `fan_id`, with no org partition and no RLS equivalent. The doc stores `org_id`; nothing
  reads it. `profile.js` never checks `doc.data().org_id === req.context.org_id`. Isolation
  currently holds **transitively** — the Postgres query above the Firestore read already
  proved the fan belongs to the org. Any future code that reads Firestore WITHOUT that
  Postgres precheck (admin tool, batch job, second-tenant dashboard) crosses tenants with
  no guard. See Open — PII/security track.
- Missing document = empty wallet state (`{loyalty_points: 0, stamps: [], avatar: null}`),
  not an error. `profile.js` also defensively coerces bad types on read.

---

## Merge / unmerge (conflicts.js)

`POST /v1/conflicts/:id/confirm` (component 19):
1. Guards: conflict exists + pending; fan_id_a exists and not deleted; **no prior active
   merge with fan_id_a as target** (multi-hop block — see below).
2. `UPDATE identifier_link SET fan_id = A, merged_from_fan_id = B WHERE fan_id = B` —
   identifiers physically MOVE, they are not copied.
3. `UPDATE fan SET deleted_at = NOW() WHERE id = B` — loser soft-deleted.
4. conflict_queue → `confirmed`.
5. `INSERT INTO merge_history (fan_id_source=B, fan_id_target=A, status='active')`.
6. audit_log `conflict_confirmed` — last write.

`POST /v1/conflicts/:id/unmerge` (component 26) reverses it via the `merged_from_fan_id`
provenance column: identifiers move back, fan B undeleted, conflict_queue → `unmerged`,
merge_history → `reversed` (CAS on `status='active'`), related_fans row, audit
`merge_reversed`.

**Multi-hop merges are blocked deliberately.** `identifier_link.merged_from_fan_id` is a
single column, not a chain. A second merge into the same target would stomp the first
merge's provenance marker, making the first unmerge silently no-op (the UPDATE
`WHERE merged_from_fan_id = original_source` returns 0 rows). The guard returns 409
`'multi-hop merge not supported'`. This is a defensive block, not a chain-history solution.

**Consequence worth knowing:** because identifiers MOVE, identifier-based lookup forwards
to the survivor for free — a tap on B's old NFC card resolves to A via PATH A, no alias
layer needed. A bare-`fan_id`-UUID holder is covered too: `GET /v1/fan/:id/profile`
(profile.js) forwards a merged fan to its survivor (`200` + `merged_from` + the survivor's
profile) instead of `403`, using the same `merge_history` lookup this section describes.
This closes the former "Canonical ID / alias resolution" Open item.

---

## JWT claim propagation (three-step rule — all required or the claim silently vanishes)

Every new JWT claim must be:
1. written in `signToken`,
2. explicitly returned in `verifyToken`'s return object,
3. explicitly attached to `req.context` in jwtMiddleware.

Miss any step and the claim disappears with no error. Precedent: the `acting_as` incident.

Token lifetimes: adult fan 15 min; child (`acting_as: 'child'`) 8 hours; claim token 30 days
(sha256 hash stored, raw token never persisted, compared via `crypto.timingSafeEqual`
against all aged_up members — never a `WHERE claim_token = $1`).

---

## audit_log event_type discipline (recurring drift trap)

Every new `event_type` written in code must be added to the `audit_log` CHECK constraint in
the SAME change. This has broken production THREE times (migrations 007, 009, 010 —
event_type ×2, match_type ×1). Currently allowed: resolution, session_issued,
conflict_confirmed, conflict_rejected, merge_reversed, household_created,
household_member_added, household_member_updated, household_member_severed,
household_member_aged_up, child_session_issued, profile_claimed, ingest_failure.
Verify against the latest migration before any INSERT with a new event_type.

---

## Table dependency levels (write/cleanup order)

- L0: org (read-only during requests)
- L1: fan, staging_household_data
- L2: household, identifier_link, household_member, audit_log, conflict_queue, related_fans
- L3: merge_history (deepest — references conflict_queue + fan + org)

Append-only by convention: audit_log, ingest_failures. **merge_history is NOT append-only** —
unmerge legitimately UPDATEs it (status active→reversed). Don't REVOKE UPDATE on merge_history.

Key tables:
- `household_member.link_type` is always `'hard'` on INSERT. `'soft'` is documented but never written — soft/probable matches live in `staging_household_data`.
- `staging_household_data` holds probable parent-child matches (written by resolverEngine when guardian_email fires). Admin `soft_links` reads from here WHERE `promoted_at IS NULL`, NOT from household_member.
- `stewardship_tier` is always `'platform'` — the documented org/fan tiers were never built. Real governance lives in `household_member.status` (active/severed/aged_up). Don't build features trusting stewardship_tier.
- `resolved_by`/`merged_by`/`severed_by`/`aged_up_initiated_by` are TEXT = org_name, NOT individual staff identity (no staff auth layer exists).

**Uniqueness indexes on identifier_link — two, scoped to disjoint row sets, they never conflict:**
- `uq_identifier_per_org` on (identifier_type, identifier_value, org_id) **WHERE source_system != 'fan_pass'** — migration_013, revised 2026-06-28. The `WHERE` clause is load-bearing: siblings legitimately share `guardian_email`/`guardian_phone`, and an unfiltered index blocked adding a second child to any household. **Do NOT remove the WHERE clause to "simplify."**
- `uq_identifier_link_managed` on (fan_id, identifier_type, org_id) WHERE source_system = 'fan_pass' — "one identifier per child," allows different children to share a guardian.

---

## Idempotency key construction

- **POST /v1/resolve:** `sha256(identifier_type + "|" + normalized_value + "|" + org_id)`
- **POST /v1/ingest/nfc:** `sha256(normalized_uid + "|" + org_id + "|" + station_id)`

`tapped_at` is excluded from the NFC key — hardware clock skew on retry generates a
different timestamp and breaks idempotency.

---

## Standard ops

- Redeploy: `gcloud run deploy golden-record`, image `gcr.io/identity-resolution-production/golden-record`, region us-central1.
- Cloud SQL proxy on port 5433 (production); local Postgres on 5432.
- Migration: `psql $DATABASE_URL -f migrations/migration_0XX.sql`. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block.
- Manual local cleanup of a test org: `psql $DATABASE_URL -c "DELETE FROM ... WHERE org_id = '...'"` in FK order (children before org).

Required env vars: `DATABASE_URL`, `FIRESTORE_PROJECT_ID`, `JWT_PRIVATE_KEY`,
`JWT_PUBLIC_KEY` (local only — Secret Manager in Cloud Run), `RATE_LIMIT_WINDOW_MS`,
`RATE_LIMIT_MAX_REQUESTS`, `CORS_ORIGIN`.

**CORS — Authorization header fix (2026-08-02, commit f41193d).** `allowedHeaders`
previously listed `X-Api-Key` (dead — nothing reads it) but not `Authorization` (the header
`orgAuthMiddleware` actually reads via `req.headers['authorization']`) — every real
cross-origin browser call would have failed preflight. 75+ existing tests never caught it:
supertest sends no `Origin` header, and `cors` only enforces `allowedHeaders` during a real
preflight. Fixed — `ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'X-Fan-Token']`,
single-sourced off `index.js`, with a real-`OPTIONS`-request regression test
(`tests/cors.preflight.test.js`). **Still open:** `CORS_ORIGIN` is unset in Cloud Run —
breaks the Firebase-hosted frontend on deploy.

---

## Status as of 2026-08-17

**Sprint 5 — anti-signal scoring: COMPLETE.** All four prompts shipped, 75/75 passing.
The scorer went from additive-only (every signal adds, nothing subtracts — a conflicting
field was silently identical to a missing one) to a full disagreement model:

1. `SIGNAL_CONFIG` + `detectConflicts()` — config-driven, detection only, no behavior change.
2. **DOB veto** — conflicting DOB is a per-candidate hard block before scoring. Safety
   invariant, not a dial. Killed the false-merge nightmare case (similar email + same name
   + different DOB).
3. **Penalties live + name double-count killed.** name+DOB dropped 1.0 → 0.7. Some pairs
   that hit PATH C now land in PATH D; very weak ones fall to PATH B. That is the system
   being honest about how much evidence it has, not a regression.
4. **Comparisons re-aimed** — email → exact, name → fuzzy. Changed match rates by design.

**Deferred to Thunder (config defaults until stated):** penalty sizes (0.3/0.2/0.1),
thresholds (PATH C 0.85 / PATH D 0.60 — **Monique confirmed these pre-Sprint-5; scores
shifted, re-confirm**), and the core objective — tolerate duplicate fans vs. tolerate false
merges. The dial is built; they set it. Ask framed for them: *every possible match already
goes to staff review — the system never merges anyone on its own. What we're setting is how
eagerly it raises its hand.*

**Prior hardening (carried forward, all passing):** acting_as enforcement; soft_links reads
staging; inbound shape; eligibility gate; PATH A/B/C/D synthetic tests (10/10 each); PATH A
deleted_at JOIN; fan_id_b duplicate-pending-conflict constraint; multi-hop merge block;
idempotency_key event_type scoping; migration_012 (three defensive CHECK constraints:
audit_log status/error_detail, conflict_queue fan_a≠fan_b, merge_history status/reversed
pairing); migration_013 (scoped uq_identifier_per_org — **this closes the June-25 "no DB
uniqueness on identifier_link" gap**). Concurrency: confirm/reject/unmerge/age-up/claim/
sever all CAS-guarded, double-submit tests passing (11/11, 8/8, 7/7, 7/7); create-household,
PUT update, child-session confirmed safe. Invariant checker (tests/helpers/invariants.js):
I1 cross-org identifier leak, I3 conflict_queue score bounds, I5 merge consolidation, I7
audit completeness — red-green proven; I4/I6 DB-enforced via migration_012; self-test 9/9.
Fuzz: validation.resolveIdentifiers 24/24, validation.householdFields 27/27, fuzz.household
17/17, zero hard gaps. All three hardening legs (concurrency, invariant, fuzz) closed across
resolution, conflict, and household endpoint groups.

**Guard breakers (Tier 1): COMPLETE.** inactive org ✅, caller-not-parent ✅, circular
household (DB trigger) ✅, expired claim token ✅, conflict already resolved ✅.

**Stage 7 — evaluation/calibration (2026-07-30): IN PROGRESS, write-half complete.**
Not the same as "Stage 7 complete" — the harness is not built, no Thunder labels exist yet,
BigQuery is not in use. What's shipped:

- **migration_014** — three new tables. `resolution_trace` (append-only via trigger,
  `FORCE ROW LEVEL SECURITY`, semantic CHECK constraints not enumerated here — see the
  migration). `trace_label` (0..N rows per trace, unique per `(trace_id, labeled_by)`,
  mutable by design — a human verdict can be corrected). `evaluation_corpus` (synthetic +
  promoted; synthetic rows require `candidate_snapshot` and are replayable, promoted rows
  point at a `trace_id` and are not).
- **resolverEngine writes a `resolution_trace` on every resolution** — one write, at the
  convergence point, after `COMMIT`, in its own try/catch, swallowed on failure (a trace
  write failure must never break an already-committed resolution — Stage 7 decision B).
  PATH A still reaches this and writes a `scoring_status: 'skipped'` /
  `skip_reason: 'deterministic_match'` stub — it does not skip the write, only the scoring.
  The idempotency short-circuit and the 23505 concurrent-insert recovery path both return
  before this block and write no trace.
- **Traces store derived `signal_results`, not raw candidate values (PII).** Consequence:
  production traces are NOT replayable against a live scorer — only synthetic
  `evaluation_corpus` rows (which carry their own `candidate_snapshot`) are. Related and
  separately tracked: the trace also records only the *winning* candidate, not why the
  others lost — see Open, "Trace records the winner, not why others lost."
- **Zero trustworthy production labels.** Every existing `conflict_queue` row is a seed
  fixture, not a human-adjudicated verdict. The corpus is synthetic-primary. Ground-truth
  verdicts are Thunder-owned — Aaron and Monique construct labeled pairs, Thunder sets the
  rules for what counts as a correct match.
- **Evaluation is pairwise.** Every merge cluster today is size 2 (one confirm = one
  source + one target), so B³ cluster scoring collapses to pairwise until multi-hop merge
  chains exist (see Open — multi-hop merge chain history).
- **resolverEngine calls `scoreMatch` with only TWO args, not three.** `scoreMatch`'s
  signature (see Scoring) is `(candidateRecord, inboundIdentifiers, now = Date.now())` —
  production resolverEngine does not pass `now`, so live scoring always uses the default
  wall clock. This is fine (that's the default-preserves-production-behavior design), but
  it means the injected-clock parameter is currently exercised only by the Stage 7
  evaluation harness, never in the request path. Not fixed here — separate prompt if it
  ever needs to change.

**Blocking — retrieval narrowing (2026-08-17): COMPLETE.** migrations 015 (conflict_queue
review-screen index) and 016 (name_last_word column + resolution_trace block-metadata
columns) plus the resolverEngine wiring (findBlockCandidates, block instrumentation on
resolution_trace) replace the LIMIT 100 candidate scan. Full detail lives in the Blocking
section, above The four resolution paths. 13/13 blocking-retrieval tests passing
(resolverEngine.blocking.test.js); 13 passed / 1 skipped on trace instrumentation
(resolverEngine.trace.test.js — the skip is the all_candidates_gated reachability finding,
documented in-file). Full suite: 11 failed / 546 passed / 1 skipped / 558 total — same 2+9
pre-existing failures, zero regressions from the blocking build.

---

## Open — needs others / deferred

**Next bodies of work (SEPARATE tracks — do NOT fold into scoring):**

- **Stage 7 — evaluation/calibration.** No B³ cluster scoring, no calibration metrics, no
  adjudicated labels. 75 passing tests prove correctness, not match *quality* — nobody can
  currently answer "did Sprint 5 reduce false merges?" This gates learned weights (can't
  derive weights from data until quality is measurable) and the signal-weights table.
  **BigQuery enters HERE** — cross-dataset match-quality analysis, off the live Postgres path.
- **PII security hardening.** Have access control (RLS/JWT). Missing: encryption at rest for
  PII fields, read-logging in audit_log (writes logged, reads not), field-level tokenization.
  **Also on this track: Firestore tenant isolation is transitive, not enforced** (see Firestore
  section) — fix is either an `org_id` check after every Firestore read, or partitioning the
  path (`orgs/{org_id}/fans/{fan_id}`) so isolation is structural. Needs Tanner / Cloud SQL access.

**Tracked maturity gaps (found 2026-07-14, none are Sprint 5):**

- **Wallet-merge gap — ARMS ITSELF THE DAY POINTS SHIP.** Merge moves identifier_link rows
  and soft-deletes fan B, but never touches Firestore. B's doc — with B's points and stamps —
  is orphaned. Nothing merges, sums, or deletes it. No error; the read succeeds and returns
  A's wallet as if B's never existed. Inert today (points not started, every doc is
  `{loyalty_points: 0, stamps: []}` and **no code path anywhere can change a point value** —
  Firestore is write-once). **Requirement for the points sprint, not a bug to fix later:**
  the merge path must reconcile wallets from day one, and unmerge must be able to reverse it.
  Open design question: sum/max/union? Can unmerge unsum? (You can't unsum without recording
  provenance.)
- **Points storage — Firestore vs Postgres (decide before the points sprint).** Points are a
  *balance*, not a preference. Fintech/healthcare pattern: the ledger lives in the system of
  record (transactional, auditable, reversible); the serving layer holds a rebuildable cached
  projection. Ledger-in-Postgres inside the merge transaction makes the wallet-merge gap
  vanish and matches the stated split (Postgres = brain, Firestore = fan-facing, BigQuery =
  analytics). Points-as-truth-in-Firestore violates that split.
- **Automatic re-resolution trigger — mechanism yes, trigger no.** Every resolver path is
  forward-only: act on the current tap, stop. Nothing re-opens a past decision when
  contradicting evidence arrives later. Unmerge exists but only fires when a human calls the
  endpoint. Normal for MVP (a bad auto-trigger thrashes records apart) — but a real gap.
- **Merge-built fans cap at two identifier types.** The eligibility gate requires composite
  signals to have both fields present on the CANDIDATE, so only email_similarity and
  guardian_email (single-field STRONG signals) can bootstrap a fan. The multi-hop merge block
  allows a fan to absorb at most one merge ever, and a merge's loser is always a
  freshly-minted single-identifier fan. Consequence: a fan holding name + dob and no email is
  unreachable through the live API. Both guards are individually correct; this is their
  composition. Real ingestion is unaffected — fans arrive with what a touchpoint has and merge
  once. Open question: how do fans accumulate more than two identifier types over time in
  production? (Found seeding `scripts/seedDemoOrg.js`, 2026-08-02 — confirmed empirically:
  two independent attempts to build a name+dob fan via chained resolve+confirm calls both
  failed, one against each guard.)
- **Trace records the winner, not why others lost.** (Found promoting Scenario 3's trace
  into `evaluation_corpus`, 2026-08-02.) `best_candidate_id` records the winning candidate
  only. Losing candidates appear in `candidate_ids` as bare UUIDs with no per-candidate
  outcome — nothing distinguishes a candidate that was DOB-vetoed from one that was gated or
  simply out-scored. `signal_results` holds only the best candidate's signals. Consequence:
  **the DOB veto is NOT reconstructable from a trace.** Scenario 3's trace shows fan B won at
  0.700; it cannot show that fan A was hard-blocked rather than out-scored. For evaluation,
  "why did this candidate lose" is often the more useful question and the trace cannot answer
  it. Same family as `scoreMatch`'s `conflicts_detected`/`penalties_applied` being computed
  and then discarded (see Scoring — "resolverEngine reads only `score` and `signals_matched`;
  extra keys are ignored by design") — both are the trace recording the winning path rather
  than the reasoning that eliminated alternatives. Fix shape if it ships: a per-candidate
  outcome array (candidate_id, gate_status, score, veto flag). Schema change, and it grows
  trace rows materially. Deferred.

**Deferred with known fix paths:**

- **RLS/superuser gap — DONE for audit_log append-only, OPEN for tenant isolation.**
  `FORCE ROW LEVEL SECURITY` closes the table-owner hole but NOT the superuser hole:
  Postgres `BYPASSRLS` exempts superusers before any policy evaluates. The app connects
  locally as `postgres` (superuser), so every RLS tenant-isolation policy is inert in local
  dev — isolation there holds only via application-level `org_id` filtering, not RLS. (The
  audit_log append-only piece of this is now closed — see Architecture invariants — because
  the enforcement trigger fires regardless of role, superuser included; that is a separate
  mechanism from RLS.) Open question, now confirmed relevant: does the production Cloud Run
  service account connect as a non-superuser role? If not, RLS tenant isolation is
  decorative in prod too, not just locally. Fix is the same as before: a limited DB role
  without BYPASSRLS — needs Tanner / Cloud SQL access.
- **Multi-hop merge chain history** — blocked defensively; proper chain-history table needs a
  schema change, deferred.
- **TRUNCATE bypasses the append-only triggers.** `enforce_audit_log_append_only` and
  `enforce_resolution_trace_append_only` are both `FOR EACH ROW` on UPDATE OR DELETE — row-
  level triggers never fire on TRUNCATE. A `FOR EACH STATEMENT ... TRUNCATE` trigger would
  close this; not built. Low urgency (TRUNCATE requires table-level privilege no request
  path grants), but the append-only guarantee is not as absolute as "regardless of role"
  implies — see Architecture invariants.
- **Pooled-connection session-setting carryover (rlsContextMiddleware).** `set_config`'s
  session scope (`false`, chosen deliberately — see Architecture invariants) means a
  released `pool` client keeps its prior request's `app.current_org_id` and
  `statement_timeout` — node-postgres does not `DISCARD` on release. Inert today (only
  `orgAuthMiddleware`/`health.js` use `pool` directly, against the non-RLS `org` table), but
  arms the moment any code queries an RLS-protected table via `pool` instead of `req.db`.
  Fix path: either a `DISCARD ALL` on client release, or ensure all RLS-protected queries go
  through `req.db` exclusively (current convention) and never relax that.
- **Signal weights table** — deferred. `SIGNAL_CONFIG` is the single-org precursor and the
  right migration path (a table reads into the same structure — no rework). A per-org DB table
  only earns its place once (a) a second tenant or self-serve tuning exists AND (b) Stage 7
  calibration can measure weight quality. Weights without calibration is guessing with extra
  database steps.
- **add-child concurrent duplicate race (KNOWN, TRIAGED, DEFERRED)** — household.js component
  29 READ 4 guards cross-household duplicate children (one active guardian per child per org,
  per Monique's Finding A ruling), but it's an application check-then-act BEFORE BEGIN. Two
  concurrent add-child requests for the same child (same name+dob) can both pass and both
  insert. Each creates a NEW fan with a different minor_fan_id, so
  `idx_household_member_minor_org` does NOT catch it — the collision is semantic (name+dob),
  not a key. Result: two fans, two active memberships, two guardians for one child.
  Reachability negligible in a single-org staff-mediated MVP. **Fix path, no schema redesign:**
  `CREATE UNIQUE INDEX CONCURRENTLY uq_active_child_per_org ON household_member (org_id,
  normalized_name, dob) WHERE status='active'` — requires denormalizing name+dob onto
  household_member (one additive column, written at insert; name currently lives only in
  identifier_link). Plus a 23505→409 catch in add-child so the loser gets a clean 'child
  already has a guardian' instead of a 500. Enforces a policy Monique already set — an
  implementation decision, not a new product question.
- **Finding A (duplicate child across households)** — blocked per Monique's MVP decision (one
  active guardian per child; shared custody deferred).
- **Coverage boundary (DELIBERATE TRIAGE, NOT AN OMISSION):** the hardening sprint covered
  /v1/resolve, /v1/ingest/nfc, confirm/reject/unmerge, and all household endpoints across
  concurrency, invariant, and fuzz passes. NOT given dedicated passes — low-complexity,
  low-risk surfaces with defenses already in code: /v1/session (single-field UUID-guarded
  body; UUID_RE rejects non-strings; concurrent sessions intentionally non-unique); /health
  (read-only infra probe); middleware (orgAuth, jwt, rls — exercised transitively by every
  test, explicit coded guards for malformed auth). Re-probe if scope expands.