# Agent Configuration — Golden Record Fan Identity Platform
# OKC Thunder — Thunder Innovations Cohort
# Author: Aaron
# Version: 1.0 · April 2026 · Confidential
#
# FILE LOCATION IN REPO: .claude/CLAUDE.md
#
# Claude Code reads this file at session start.
# Read tasks/handoff.md second. Then load only the file you are working on.
# Never load the full codebase into context.

---

## 1. Plan Mode — Default Behavior

- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- Write plan to tasks/todo.md with checkable items before touching any file
- Check in with Aaron before starting implementation
- If something goes sideways — STOP and re-plan immediately, do not keep pushing
- Use plan mode for verification steps, not just building
- Ask yourself before every step: "Would a staff engineer approve this?"

---

## 2. Subagent Strategy — Surgical Not Liberal

- Use subagents for isolated, bounded tasks only
- Use subagents for parallel work only — two independent files with zero shared dependencies
- Never spawn a subagent for a task the main agent can do in one step
- Pass only the minimum context a subagent needs — never the full conversation
- Subagent output returns as a summary, not raw output
- Sequential components (normalizer → jwt → resolver) do NOT use subagents
- Subagents acceptable for: orgAuthMiddleware + correlationIdMiddleware in parallel only

---

## 3. Token Efficiency — This Is Law

- Read only the files needed for the current task
- Never load the full codebase into context — load by dependency order
- Load one module at a time following the build order below
- Summarize completed work before starting the next task
- tasks/todo.md is the handoff document between sessions
- tasks/handoff.md is the session boundary document — 5 lines max

**Session start sequence — always in this order:**
1. Read tasks/handoff.md (5 lines — what was done, what is next)
2. Read CLAUDE.md (project rules)
3. Read .claude/CLAUDE.md (this file — agent rules + pseudocode for current task)
4. Load only the file being worked on
5. Begin

---

## 4. File Scope Rule

- One file per task unless files are tightly coupled
- Never edit more than 3 files in a single agent step
- If a change touches more than 3 files — stop and re-plan
- Minimal code impact — simplest correct solution always wins
- No temporary fixes — find root causes, senior developer standards

---

## 5. Self-Improvement Loop

- After ANY correction from Aaron: update tasks/lessons.md with the pattern
- Write rules that prevent the same mistake from happening again
- lessons.md has a 20-entry cap — oldest entries rotate out when cap is hit
- Review lessons.md at session start if it exists
- Ruthlessly iterate on lessons until mistake rate drops

---

## 6. Verification Before Done

- Never mark a task complete without proving it works
- Run tests, check logs, demonstrate correctness
- Never fix a test to match broken code — fix the code to match the test
- Ask: "Would a staff engineer approve this?"

---

## 7. Autonomous Bug Fixing

- When given a bug report: just fix it, no hand-holding required
- Read the failing test first, then the code
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from Aaron

---

## 8. Demand Elegance

- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: implement the elegant solution
- Skip for simple obvious fixes — do not over-engineer
- Challenge your own work before presenting it

---

## 9. Session Handoff — Required at Every Session End

Write to tasks/handoff.md before closing. 5 lines max:

```
Completed: [what was finished this session]
Next: [exact next file in build order]
Blocked: [anything waiting on Aaron, King, Tanner, or credentials]
Decisions: [any architectural decisions made that affect downstream files]
Warnings: [anything the next session needs to know before touching code]
```

---

## 10. Task Management

1. Write plan to tasks/todo.md with checkable items
2. Check in with Aaron before starting implementation
3. Mark items complete as you go
4. High-level summary at each step
5. Add review section to tasks/todo.md on completion
6. Update tasks/lessons.md after any correction

---

## Core Principles

- Simplicity first — minimal code, minimal impact
- No laziness — find root causes, no temporary fixes
- Senior developer standards on every file
- One job per function, one job per endpoint
- The pseudocode is the spec — translate it, do not redesign it

---

---

# CLAUDE.md — Golden Record

Fan identity resolution platform. OKC Thunder Innovations Cohort. Sole backend engineer: Aaron Franklin.
Stack: Node.js / Express, Postgres (Cloud SQL), Firestore (named DB `golden-record`), Cloud Run, GCP.
Last updated: 2026-06-25. Presentation to Tanner: June 29th.

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

## Architecture invariants (do not violate)

- **Tenant isolation is absolute.** `org_id` on every table, in every query, plus RLS (`FORCE ROW LEVEL SECURITY`) at the DB level. `org_id` always comes from `req.context` (set by orgAuthMiddleware), never trusted from the request body. Body `org_id` mismatch → 400.
- **Guards before transactions.** Validate everything (Zone 1) before `BEGIN`. No wasted DB work on bad input.
- **Pure functions, no side effects:** normalizer.js, probabilisticMatcher.js, jwt.js — no DB, no network.
- **audit_log is always the LAST write inside every transaction.** It records what already happened.
- **Postgres is truth; Firestore is enhancement.** Firestore sync runs AFTER commit, failures are caught/logged/swallowed, never block the response or roll back Postgres. (`PERMISSION_DENIED` locally is expected.)
- **Application guards are optimizations; database constraints are guarantees.** "Check then insert" has a race window — the unique index is the real protection.
- **Soft delete only.** Fan records are never hard-deleted (`deleted_at` set instead). This is what makes merges reversible.
- **Use `req.db` (RLS-scoped) inside routes; `pool` directly only where RLS context isn't set yet** (orgAuthMiddleware, health.js).

---

## The four resolution paths (resolverEngine.js)

- **PATH A** — exact identifier_link match (hard match). Returns `match_type: 'hard'`, `is_new_record: false`, confidence 1.0. Updates `last_seen_at`. Now JOINs `fan` and checks `deleted_at IS NULL` (deleted fan's tap falls through to PATH B).
- **PATH B** — no match. New fan created. `match_type: 'hard'`, `is_new_record: true`, confidence 1.0. (`'hard'` here means "this link is certain," not "fan existed before" — `is_new_record` answers that.)
- **PATH C** — soft match, score ≥ 0.85. `match_type: 'soft'`. Creates a pending `conflict_queue` row for staff review.
- **PATH D** — soft match, 0.60 ≤ score < 0.85. `match_type: 'conflict'`. Also creates a pending conflict_queue row.

Scoring (post-fix): **additive, capped at 1.0** — `score = Math.min(1.0, score + adjusted)`, `let score = 0.0` must stay. (Was `Math.max` — a bug.) `signals_matched` holds only the best candidate's signals; only matters for PATH C/D. `name_alone` fires independently of `name_plus_dob` and is not deduplicated.

Inbound shape: `/v1/resolve` and `/v1/ingest/nfc` accept an optional `identifiers: {}` object (email, name, dob, zip, device_id, guardian_email) alongside the singular `identifier_type`/`identifier_value`. The singular field wins on conflict. Without this, only one signal could ever fire and PATH C was unreachable.

Eligibility gate (`passesSignalEligibilityGate`, resolverEngine.js, called in the candidate loop before scoreMatch): PASS if ≥1 STRONG signal OR ≥2 WEAK signals; FAIL → skip candidate (no entry in signals_matched).
- STRONG: `email_similarity`, `name_plus_dob`, `guardian_email`
- WEAK: `name_plus_zip`, `device_id`, `name_alone`

Thresholds: PATH C 0.85, PATH D 0.60. Confirmed by Monique as still valid post-additive.

---

## JWT claim propagation (three-step rule — all required or claim silently vanishes)

Every new JWT claim must be:
1. written in `signToken`,
2. explicitly returned in `verifyToken`'s return object,
3. explicitly attached to `req.context` in jwtMiddleware.

Miss any step and the claim disappears with no error. Precedent: the `acting_as` incident. `acting_as: 'child'` is enforced by a `router.use()` guard at the top of household routes → 403 `'child tokens cannot manage household accounts'`.

---

## audit_log event_type discipline (recurring drift trap)

Every new `event_type` value written in code must be added to the `audit_log` CHECK constraint in the SAME change. This has broken production THREE times (migrations 007, 009, 010 — event_type ×2, match_type ×1). Current allowed event_types include: resolution, session_issued, conflict_confirmed, conflict_rejected, merge_reversed, household_created, household_member_added, household_member_updated, household_member_severed, household_member_aged_up, child_session_issued, profile_claimed, ingest_failure. Verify against the latest migration before adding any new INSERT with a new event_type.

---

## Table dependency levels (write/cleanup order)

- L0: org (read-only during requests)
- L1: fan, staging_household_data
- L2: household, identifier_link, household_member, audit_log, conflict_queue, related_fans
- L3: merge_history (deepest — references conflict_queue + fan + org)

Append-only by convention: audit_log, ingest_failures. **merge_history is NOT append-only** — unmerge legitimately UPDATEs it (status active→reversed). Don't REVOKE UPDATE on merge_history.

Key tables:
- `household_member.link_type` is always `'hard'` on INSERT. `'soft'` is documented but never written — soft/probable matches live in `staging_household_data`, not here.
- `staging_household_data` holds probable parent-child matches (written by resolverEngine when guardian_email fires). Admin `soft_links` reads from here WHERE `promoted_at IS NULL`, NOT from household_member.
- `stewardship_tier` is always `'platform'` — the documented org/fan tiers were never built. Real governance lives in `household_member.status` (active/severed/aged_up). Don't build features trusting stewardship_tier.
- `resolved_by`/`merged_by`/`severed_by`/`aged_up_initiated_by` are TEXT = org_name, NOT individual staff identity (no staff auth layer exists).
- Claim tokens stored as sha256 hash only; raw token never persisted. Claim compare is timing-safe (`crypto.timingSafeEqual`) against all aged_up members, not a WHERE clause. Expired token → 410 (not 404).

---

## Standard ops

- Redeploy: `gcloud run deploy golden-record`, image `gcr.io/identity-resolution-production/golden-record`, region us-central1.
- Cloud SQL proxy on port 5433 (production); local Postgres on 5432.
- Manual local cleanup of a test org: `psql $DATABASE_URL -c "DELETE FROM ... WHERE org_id = '...'"` in FK order (children before org).

---

## Status as of 2026-06-25

**Fixed & passing:** acting_as enforcement; soft_links reads staging; inbound shape; additive scoring; eligibility gate; PATH A/B/C/D synthetic tests (10/10 each); PATH A deleted_at JOIN; fan_id_b duplicate-pending-conflict constraint; multi-hop merge block (conflicts.js component 19); idempotency_key event_type scoping; migration_012 (three defensive CHECK constraints: audit_log status/error_detail, conflict_queue fan_a≠fan_b, merge_history status/reversed pairing); admin household tests updated for the 5th read. Finding A (duplicate child across households) — blocked per Monique's MVP decision (one active guardian per child; sharing deferred to next sprint). Conflict confirm double-submit race fixed: CAS on the status UPDATE (WHERE status='pending') + new unique partial index uniq_active_merge_per_conflict on merge_history(conflict_id) WHERE status='active'; concurrent double-submit test passing. Reject + unmerge double-submit races fixed: CAS on the status UPDATE in each (reject WHERE status='pending'; unmerge STEP 4 WHERE status='active'), rollback+409 for the losing writer; concurrent double-submit test passing (11/11), including clean-rollback assertions proving the losing unmerge writer leaves no trace. Invariant checker built (tests/helpers/invariants.js, assertInvariants): I1 cross-org identifier leak, I3 conflict_queue score bounds, I5 merge consolidation, I7 audit completeness — all red-green proven; I4/I6 confirmed DB-enforced (migration_012); self-test passing (9/9). Age-up double-submit race fixed: CAS on STEP 1 UPDATE (AND status='active' + rowCount=0 → ROLLBACK + 409); concurrency.ageUpDoubleSubmit.smoke.js 8/8 passing. Household concurrency scan complete: age-up, claim, sever share the conflicts.js check-then-act pattern (read status pre-BEGIN, bare WHERE on the authoritative UPDATE); age-up fixed (CAS — credential race: claim_token overwrite blocked); claim + sever: CAS fixes shipped (concurrency.claimDoubleSubmit.smoke.js 7/7, concurrency.severDoubleSubmit.smoke.js 7/7 passing); create-household, update (PUT), child-session confirmed safe (unique index / idempotent upserts / stateless); add-child deferred (see Open section). Resolve fuzz probe + identifiers validation fix: validation.resolveIdentifiers 24/24. Household fuzz probe + non-string field validation fix: components 29 and 31 hardened against non-string body fields (typeof guard before .trim(); closed two 500 paths including the line-582 both-names-non-string path); validation.householdFields 27/27, fuzz.household 17/17, zero hard gaps. All three hardening legs (concurrency, invariant, fuzz) now closed across the resolution, conflict, and household endpoint groups.

**Guard breakers (Tier 1):** inactive org ✅, caller-not-parent ✅, circular household (DB trigger) ✅, expired claim token ✅, conflict already resolved ✅. Tier 1 complete.

**Open — needs others / deferred:**
- identifier_link uniqueness gap: uq_identifier_per_org does NOT exist in the live schema (confirmed via pg_constraint query — 0 rows). The CONSTRAINT clause in migration_001 was outside the CREATE TABLE parens and never applied. There is currently NO database-level uniqueness on (identifier_type, identifier_value, org_id). Invariant checker I2 catches duplicates after the fact, but nothing prevents them — two concurrent resolves of the same new identifier could each create a fan. Fix pending: a migration adding the unique index, with a pre-existing-duplicate check first (the index CREATE fails if dupes already exist). Higher priority than remaining test legs — this is a live gap in the core identity table.
- audit_log REVOKE UPDATE/DELETE — needs Tanner / Cloud SQL access. Locally the app connects as `postgres` (superuser), which bypasses REVOKE entirely. Production question: does the app connect as a superuser/table-owner? If so, enforcing append-only requires a separate limited DB role (SELECT+INSERT only on audit_log), not just a REVOKE.
- Multi-hop merge chain history — blocked defensively for now; proper chain-history table deferred to a later sprint.
- Signal weights table — deferred until a second org needs different weights.
- conflict_queue (org_id, status, confidence_score DESC) index — verify exists, add if missing (Sprint 5/6 perf).
- identifiers-object field normalization (KNOWN, NAMED DEFERRAL): identifiers field values are type-checked but not normalized in the Zone-1 guard. Multi-signal matches through the identifiers object compare raw values against normalized candidates stored in identifier_link, reducing match accuracy for signals like email (case) and name (whitespace). Fix path: per-field normalization in the resolve.js Zone-1 guard, which reopens the strict-vs-lenient decision per field (e.g. silently trim vs. reject a padded string). Deferred post-June 29.
- add-child concurrent duplicate race (KNOWN, TRIAGED, DEFERRED): household.js component 29 (add-child) guards cross-household duplicate children via READ 4 (one active guardian per child per org, per Monique's Finding A ruling). READ 4 is an application-level check-then-act BEFORE BEGIN, so two concurrent add-child requests for the same child (same name+dob) can both pass READ 4 and both insert. Each creates a NEW fan with a different minor_fan_id, so idx_household_member_minor_org (unique on minor_fan_id, org_id) does NOT catch it — the collision is on semantic identity (name+dob), not a key. Result: two fans, two active memberships, two guardians for one child — the exact thing READ 4 prevents in the sequential case. REACHABILITY: negligible in single-org staff-mediated MVP (requires two adults submitting same child within ms). Severity real, probability before June 29 near zero — deferred deliberately, not overlooked. FIX PATH (post-June 29, no schema redesign): partial unique index enforcing Monique's existing rule at the DB level — CREATE UNIQUE INDEX CONCURRENTLY uq_active_child_per_org ON household_member (org_id, normalized_name, dob) WHERE status='active'; requires denormalizing normalized name+dob onto household_member (one additive column, written at insert; name currently lives only in identifier_link). Plus a 23505→409 catch in add-child so the loser gets a clean 'child already has a guardian' instead of a 500. This enforces a policy Monique already set — it is an implementation decision, not a new product question.
- Coverage boundary (DELIBERATE TRIAGE, NOT AN OMISSION): hardening sprint covered /v1/resolve, /v1/ingest/nfc (resolution), confirm/reject/unmerge (conflicts), and all household endpoints (add-child/update/sever/age-up/claim) across concurrency, invariant, and fuzz passes. NOT given dedicated hardening passes — low-complexity, low-risk surfaces with defenses already present in code: /v1/session (single-field UUID-guarded body, issues a token + one audit row; UUID_RE rejects non-strings; concurrent sessions are intentionally non-unique — low fuzz/concurrency surface); /health (read-only infra probe, no mutation); middleware (orgAuth, jwt, rls — exercised transitively by every test; jwt.js and orgAuth have explicit coded guards for malformed auth). Re-probe post-June 29 if scope expands.