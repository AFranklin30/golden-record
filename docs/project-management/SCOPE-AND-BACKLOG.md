# Golden Record — Scope and Backlog

Verified against `main` commit `7fa878d` on 2026-11-16.
The MVP scope in this file is **PROPOSED**. It is not approved until S0-06.

## Proposed MVP scope

A prospect can watch the current engine do four things on synthetic data:

1. Tell a clear duplicate from a clear non-match.
2. Hold an uncertain pair for a person.
3. Record that person's confirm, reject, or unmerge.
4. Export the fans and the review decisions, with a short explanation and counts that match a written report.

Then the same walkthrough runs on a hosted API and a hosted database, in one org, with tenant isolation checked.

A later pilot, not this MVP build, takes one real CSV through that same path in a new org.

### In scope, because it already exists and the demo uses it

| Capability | Evidence |
|---|---|
| Deterministic match | Path A in `src/modules/resolverEngine.js`: exact `identifier_link` hit, `match_type: hard`, `is_new_record: false`. |
| New fan when nothing matches | Path B in the same file: `match_type: hard`, `is_new_record: true`, confidence 1.0. |
| Probabilistic score | `src/modules/probabilisticMatcher.js`. Exact email, fuzzy name at 0.85, DOB veto, disagreement penalties. Weights: email 0.7, name+DOB 0.7, name+zip 0.6, guardian email 0.65, device 0.5, name alone 0.3. |
| Two review bands | Path C at score >= 0.85 (`match_type: soft`). Path D at score >= 0.60 and < 0.85 (`match_type: conflict`). Both insert a new fan and a pending `conflict_queue` row. |
| No automatic merge | Confirm is `POST /v1/conflicts/:id/confirm` in `src/routes/conflicts.js`. |
| Human review list | `GET /v1/conflicts` returns score, `signals_matched`, status, and fan ids. Status filter includes pending, confirmed, rejected, unmerged. |
| Reject | `POST /v1/conflicts/:id/reject`. |
| Unmerge | `POST /v1/conflicts/:id/unmerge` moves identifiers back, clears `deleted_at` on the losing fan, marks the conflict unmerged, and writes `merge_reversed`. A second unmerge is a 409. A second merge into the same target is blocked with `multi-hop merge not supported`. |
| Explanation data | `signals_matched` on the conflict row, plus `resolution_trace` (`signal_results`, path, score, block metadata). The trace stores the winning candidate's signals. It does not store why each losing candidate lost. |
| Audit | `audit_log` insert is the last write in the resolution and conflict transactions. Append-only trigger exists. Allowed `event_type` values were read from the live check constraint after migration replay. |
| Normalization | `src/modules/normalizer.js`. Allowed types include email, phone, nfc_uid, nba_id, ticketmaster_id, name, dob, zip, guardian_email, guardian_phone. |
| Tenant columns and policies | Migrations `003`, `006`, `008`, `014`, and `017`. After replay: RLS enabled and forced on 14 tables, `tenant_isolation` policy on each, `org` exempt. |
| Org API key | `src/middleware/orgAuthMiddleware.js`. Bearer key, stored as SHA-256. Unknown key 401. Inactive org 403. |
| Fan JWT | `src/modules/jwt.js` and `src/middleware/jwtMiddleware.js`, used by profile and household routes. |
| Fan CSV export | `GET /v1/export/fans` in `src/routes/export.js`. Full snapshot, no query parameters, `export_run` row written. |
| Evaluation harness | `eval/harness.js`, `eval/runCorpus.js`. Scorecard definitions are in the harness. |
| Synthetic demo seed | `scripts/seedDemoOrg.js`. Five scenarios and 8 synthetic pairs. This audit ran it. |
| Health | `GET /health`. Unauthenticated body is status and timestamp. `status: ok` means the database probe succeeded and the ingest-failure count is under 10000. |
| Deploy artifact | `Dockerfile` (Node 20). README documents `gcloud run deploy`. Render health URL responded on 2026-11-16. |
| Tests | Jest suite under `tests/**/*.test.js`. 24 files. Result of this audit is in `SPRINT-TRACKER.md`. |

### In scope, because it is missing and the demo needs it

- A locked record of the current 9-row scorecard.
- A 200-record synthetic dataset with ground truth, and a report from running the current engine.
- A minimal way to see the queue, decisions, unmerge, explanation, and counts. Only after D-005.
- A review-decision CSV. The fan snapshot export stays.
- Hosted Postgres, migrations applied, non-superuser isolation check, backend deploy pinned to a commit, synthetic data loaded, one hosted walkthrough.
- Demo script, overview, sample report, CSV workflow, and a one-customer pilot proposal. All synthetic.

## Excluded from the MVP

These are out unless Aaron writes a scope change.

- A new matching engine, new signals, new thresholds, or an auto-merge.
- Nickname or AI matching.
- A universal file-adapter framework.
- CRM connectors and direct connections to a customer's production database.
- Per-customer policy configuration.
- A multi-tenant admin product and per-staff accounts. The actor on confirm and unmerge is `org_name`. There is no staff login table.
- Large-scale or distributed processing.
- Analytics beyond the benchmark counts and the demo screen.
- More household, NFC, age-up, claim-token, or loyalty work.
- Points, wallet merge, and Firestore as a system of record.
- BigQuery.
- Rebuilding or rerunning the deleted client evaluation.
- Using the brief's 691 / 60-scenario / 90.5% / 79.2% figures as a target or a current result.
- Changing path C so that it returns the existing fan. The README sentence is wrong; the code stays.
- A dry-run mode that does not write. Deferred, not a prerequisite. See D-007.
- Git history rewrite. See D-004.

## Deferred

| Item | Why it waits |
|---|---|
| F-01 Real CSV pilot | Needs a customer file and Sprint 4's workflow doc. The file stays out of git. |
| F-02 Score without writing | Only if an isolated org is not acceptable for that customer. |
| F-03 A column adapter | Only if that file's columns do not map onto the normalizer's types. |
| Multi-hop merge history | The product blocks a second merge into the same target. A chain table is a schema change. The demo uses a single merge and one unmerge. |
| Plain-language explanations for every losing candidate | Traces store the winner. Building a per-candidate outcome array is a schema change. The demo explains the queued pair from `signals_matched`. |
| Firestore tenant isolation and wallet merge | No demo feature reads the wallet as truth. Profile reads Firestore after a Postgres check. Points are not updated anywhere. |
| Pooled-connection RLS leakage | Documented in `CLAUDE.md`. The demo keeps using `req.db` inside routes. No new `pool` query against an RLS table is added. |
| Individual staff identity | Not required to show org-level review. |
| CI | There is no `.github` workflow. Worth adding later. Not required to measure the synthetic set locally. |
| README and API contract refresh | Done as part of the Sprint 4 overview (D-011), not as a separate documentation project. |

## Future improvements

Not scheduled. Listed so they are not mistaken for MVP tasks.

- Materialized blocking keys. The resolver self-joins `identifier_link` today.
- More than the three block keys (email, guardian email, name+date of birth).
- Persisting the advisory identifiers that arrive on a tap. A fan created from only an NFC id cannot be found by the three block keys later.
- Calibration of the penalty sizes and thresholds once a larger labeled synthetic set exists. Still a product decision, still not part of Sprint 1.
- Structured log shipping beyond `console` in `src/lib/logger.js`.
- `CORS_ORIGIN` is required for a browser. It is unset-safe in code (browsers are blocked when it is missing). The hosted value is **UNVERIFIED**.

## Scope-change requests

None from a customer.

The only open request is internal: S0-06, Aaron accepting this proposed scope or cutting it. Suggested cuts if the schedule has to shrink are in `PROJECT-STATUS.md`.
