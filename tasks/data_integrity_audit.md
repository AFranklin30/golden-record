# Data Integrity Audit — 38B
# Golden Record
# Author: Aaron (audited by Claude Code)
# Date: 2026-06-02
# Branch: sprint-3

---

## Audit Scope

Verifies that every architectural assumption in application code has a
corresponding database constraint enforcing it. Checks for gaps where
the application assumes something is true but the database would allow
violation if application code had a bug.

Database queried: 127.0.0.1:5432 (local postgres, migrations run through migration_007)
Code reviewed: src/routes/conflicts.js, src/routes/household.js

---

## Findings

---

### CHECK 1 — identifier_link Fan Pass uniqueness

CHECK:    Unique index on identifier_link (fan_id, identifier_type, org_id)
          to support ON CONFLICT upsert in Component 31 (PUT household member)

STATUS:   FAIL

FINDING:  No unique index exists on (fan_id, identifier_type, org_id) on
          identifier_link. The supplementary query confirmed the only indexes
          are the primary key on id, a non-unique (fan_id, org_id) index, a
          non-unique (identifier_type, identifier_value, org_id) lookup index,
          and a partial index on merged_from_fan_id. There is no unique
          constraint these three columns can target.

          Component 31 (household.js:623-685) uses:
            ON CONFLICT (fan_id, identifier_type, org_id) DO UPDATE SET ...
          for every identifier field in the child profile edit endpoint.

          Postgres requires an exact unique index or exclusion constraint
          matching the ON CONFLICT column list. Without it, every call to
          PUT /v1/household/:adult_fan_id/members/:child_fan_id will fail
          at the database with:
            ERROR: there is no unique or exclusion constraint matching
                   the ON CONFLICT specification

          Tests pass because they mock req.db.query. Production database
          rejects the statement entirely.

          Also absent: the partial unique index uq_identifier_link_managed
          (fan_id, identifier_type, org_id) WHERE source_system = 'fan_pass'
          that was the originally specified constraint. The broader
          non-partial unique index is also missing.

FIX:      Add a migration with:
            CREATE UNIQUE INDEX uq_identifier_link_managed
              ON identifier_link (fan_id, identifier_type, org_id)
              WHERE source_system = 'fan_pass';
          OR add a plain unique index if fan_pass exclusivity is not required:
            CREATE UNIQUE INDEX uq_identifier_link_fan_type_org
              ON identifier_link (fan_id, identifier_type, org_id);
          The ON CONFLICT clause in Component 31 must match whichever
          constraint is created (partial indexes require a matching WHERE
          clause in the ON CONFLICT).

---

### CHECK 2 — conflict_queue duplicate pairs

CHECK:    Partial unique index on conflict_queue (fan_id_a, fan_id_b, org_id)
          WHERE status = 'pending' to prevent duplicate pending pairs

STATUS:   RISK

FINDING:  uq_conflict_queue_pair does not exist. The probabilistic matcher
          could insert duplicate pending conflict_queue rows for the same
          fan pair if it runs twice on the same fan pair before either
          record is resolved (e.g. two rapid ingestion events for the
          same NFC UID, or a retry storm). The dashboard would show
          duplicate conflicts to staff — resolving one leaves the other
          orphaned forever.

FIX:      Add a migration with:
            CREATE UNIQUE INDEX uq_conflict_queue_pair
              ON conflict_queue (fan_id_a, fan_id_b, org_id)
              WHERE status = 'pending';

---

### CHECK 3 — merge_history race condition

CHECK:    Partial unique index on merge_history (conflict_id)
          WHERE status = 'active' to prevent concurrent unmerge

STATUS:   RISK

FINDING:  uq_merge_history_active does not exist. The unmerge handler
          (conflicts.js:311-326) reads merge_history WHERE status = 'active'
          then opens a transaction to set it to 'reversed'. A concurrent
          second unmerge request can pass the READ check before either
          transaction commits, resulting in two simultaneous unmerge
          operations on the same merge record. The second UPDATE would
          update 0 rows silently, but both would write to related_fans
          (creating duplicates) and both would write audit events —
          producing a corrupted audit trail with no data loss signal.

FIX:      Add a migration with:
            CREATE UNIQUE INDEX uq_merge_history_active
              ON merge_history (conflict_id)
              WHERE status = 'active';
          The second concurrent unmerge would fail at the unique constraint
          and be caught by the outer catch block returning 500, which is
          the correct behavior for a race condition.

---

### CHECK 4 — related_fans duplicate rows

CHECK:    Unique index on related_fans (fan_id_a, fan_id_b, org_id, relationship)
          to prevent duplicate relationship records

STATUS:   RISK

FINDING:  uq_related_fans_pair does not exist. Two code paths write to
          related_fans:
          - Age-up (household.js:989-994): writes 'aged_up' relationship
          - Unmerge (conflicts.js:368-373): writes 'unmerged' relationship
          If either operation is retried (network timeout, client retry, or
          unmerge race from CHECK 3), duplicate rows accumulate. The admin
          household view (Component 36) renders related_fans directly with
          no deduplication, so staff would see duplicate relationship entries
          that cannot be distinguished from legitimate distinct events.

FIX:      Add a migration with:
            CREATE UNIQUE INDEX uq_related_fans_pair
              ON related_fans (fan_id_a, fan_id_b, org_id, relationship);

---

### CHECK 5 — household one per adult per org

CHECK:    Unique index on household (adult_fan_id, org_id)

STATUS:   PASS

FINDING:  idx_household_adult_org exists as a UNIQUE index:
            CREATE UNIQUE INDEX idx_household_adult_org
              ON public.household USING btree (adult_fan_id, org_id)
          The application guard (household.js:47-56) reads first and
          returns 409 — the unique index is a backstop if the guard
          is bypassed by a concurrent duplicate request.

FIX:      None.

---

### CHECK 6 — household_member one active per minor per org

CHECK:    Partial unique index on household_member (minor_fan_id, org_id)
          WHERE status = 'active'

STATUS:   PASS

FINDING:  idx_household_member_minor_org exists as a UNIQUE partial index:
            CREATE UNIQUE INDEX idx_household_member_minor_org
              ON public.household_member USING btree (minor_fan_id, org_id)
              WHERE (status = 'active'::text)
          This correctly prevents a minor from being in two active households
          simultaneously while allowing the same minor to appear in historical
          severed or aged_up records.

FIX:      None.

---

### CHECK 7 — audit_log append-only

CHECK:    Trigger on audit_log preventing UPDATE and DELETE

STATUS:   PASS

FINDING:  enforce_audit_log_append_only trigger exists for both DELETE and
          UPDATE events on audit_log. The CLAUDE.md audit law (no UPDATE or
          DELETE on audit_log) is enforced at the database level, not just
          application code.

FIX:      None.

---

### CHECK 8 — audit_log event_type CHECK constraint

CHECK:    CHECK constraint on audit_log.event_type includes all event types
          written by application code

STATUS:   FAIL

FINDING:  The constraint contains only 4 values:
            'resolution', 'session_issued',
            'conflict_confirmed', 'conflict_rejected'

          Application code writes 7 additional event types not in the
          constraint. Each of these writes would be rejected by Postgres
          with a CHECK constraint violation, causing the entire transaction
          to roll back and returning a 500 to the caller:

          merge_reversed         — conflicts.js:377 (Component 26 unmerge)
          household_created      — household.js:74  (Component 27)
          household_member_added — household.js:351 (Component 29)
          household_member_updated — household.js:689 (Component 31)
          household_member_severed — household.js:790 (Component 32)
          household_member_aged_up — household.js:998 (Component 34)
          profile_claimed        — household.js:1125 (Component 35)

          Tests pass because req.db.query is mocked. The constraint is
          never exercised by the test suite. Every one of these endpoints
          is broken in production for any request that reaches the audit
          log write step.

          Note: child_session_issued (Component 33) does not write to
          audit_log in the current code — no issue there.

FIX:      Add a migration that drops and recreates the constraint with all
          11 current event types:
            ALTER TABLE audit_log
              DROP CONSTRAINT audit_log_event_type_check;
            ALTER TABLE audit_log
              ADD CONSTRAINT audit_log_event_type_check
              CHECK (event_type IN (
                'resolution',
                'session_issued',
                'conflict_confirmed',
                'conflict_rejected',
                'merge_reversed',
                'household_created',
                'household_member_added',
                'household_member_updated',
                'household_member_severed',
                'household_member_aged_up',
                'profile_claimed'
              ));

---

### CHECK 9 — audit_log identifier_type CHECK constraint

CHECK:    CHECK constraint on audit_log.identifier_type includes all 10
          identifier types now accepted by normalizer.js

STATUS:   FAIL

FINDING:  The constraint contains only 5 values:
            'email', 'phone', 'nfc_uid', 'nba_id', 'ticketmaster_id'

          Missing Sprint 3 additions: 'name', 'dob', 'zip',
          'guardian_email', 'guardian_phone'

          resolverEngine.js writes identifier_type to audit_log on every
          resolution event. If POST /v1/resolve or POST /v1/ingest/nfc is
          called with any of the 5 missing types (now valid per the
          normalizer), resolverEngine's audit log write fails with a CHECK
          constraint violation — rolling back the entire resolution
          transaction and returning 500.

          Lower severity than CHECK 8 because household endpoints do not
          write identifier_type to audit_log (they write event_type only),
          so the household flows are not affected. The risk applies to the
          resolve and ingest/nfc flows when called with new identifier types.

FIX:      Add a migration that drops and recreates the constraint with all
          10 identifier types:
            ALTER TABLE audit_log
              DROP CONSTRAINT audit_log_identifier_type_check;
            ALTER TABLE audit_log
              ADD CONSTRAINT audit_log_identifier_type_check
              CHECK (identifier_type IS NULL OR identifier_type IN (
                'email', 'phone', 'nfc_uid', 'nba_id', 'ticketmaster_id',
                'name', 'dob', 'zip', 'guardian_email', 'guardian_phone'
              ));
          Note: IS NULL OR is required because identifier_type is nullable
          on audit_log (session_issued and household events omit it).

---

### CHECK 10 — identifier_link identifier_type CHECK constraint

CHECK:    CHECK constraint on identifier_link.identifier_type includes all
          10 current identifier types

STATUS:   PASS

FINDING:  migration_005 correctly updated this constraint to include all 10
          types: email, phone, nfc_uid, nba_id, ticketmaster_id, name, dob,
          zip, guardian_email, guardian_phone. Verified by direct query.

FIX:      None.

---

### CHECK 11 — RLS on all tenant tables

CHECK:    Row-level security enabled on all 10 tenant tables

STATUS:   FAIL

FINDING:  4 of 10 tenant tables have RLS enabled (sprint 1 tables covered
          by migration_003). 6 Sprint 2 and Sprint 3 tables have RLS = false:

            conflict_queue         rowsecurity = false
            household              rowsecurity = false
            household_member       rowsecurity = false
            merge_history          rowsecurity = false
            related_fans           rowsecurity = false
            staging_household_data rowsecurity = false

          migration_003 was written and partially run locally but has not
          been run on Cloud SQL (GCP credentials pending per handoff). Even
          locally, migration_003 only covered the Sprint 1 tables. No
          subsequent migration extended RLS to the 6 newer tables.

          Without RLS, a multi-org deployment relies entirely on the
          application's WHERE org_id = $N clauses for tenant isolation. Any
          query that omits the org_id filter — whether from a bug, a future
          migration script, or a direct psql session — would expose
          cross-tenant data.

FIX:      Add RLS enable statements and org_id policies to the next migration
          for all 6 tables. Pattern from migration_003:
            ALTER TABLE conflict_queue ENABLE ROW LEVEL SECURITY;
            CREATE POLICY conflict_queue_org_isolation ON conflict_queue
              USING (org_id = current_setting('app.current_org_id')::uuid);
          Repeat for household, household_member, merge_history,
          related_fans, staging_household_data.

---

### CHECK 12 — circular household trigger

CHECK:    Trigger on household_member preventing circular household
          relationships (A is minor under B, B cannot be minor under A)

STATUS:   PASS

FINDING:  prevent_circular_household trigger exists on household_member
          for INSERT events. The trigger calls check_no_circular_household()
          which queries existing active relationships before allowing the
          insert. Verified by direct query.

FIX:      None.

---

### CHECK 13 — fan soft delete pattern

CHECK:    fan.deleted_at column exists and is nullable

STATUS:   PASS

FINDING:  deleted_at column exists on fan table, is_nullable = YES.
          Soft delete pattern is correctly implemented — no hard deletes
          required. All endpoints check deleted_at before issuing tokens
          or returning profile data.

FIX:      None.

---

### CHECK 14 — merge_history status transitions (code review)

CHECK:    No endpoint sets status = 'active' on an existing merge_history
          row, no endpoint reverts 'reversed' back to 'active'

STATUS:   PASS

FINDING:  Code review of conflicts.js confirms:
          - INSERT sets status = 'active' (line 169): only inside confirm
            handler, only for new rows
          - UPDATE sets status = 'reversed' (lines 360-365): only inside
            unmerge handler
          - No code path sets status = 'active' on an existing row
          - No code path changes 'reversed' to any other value
          Status machine is unidirectional: active → reversed only.

FIX:      None.

---

### CHECK 15 — staging promotion idempotency

CHECK:    staging_household_data query in Component 29 includes
          WHERE promoted_at IS NULL

STATUS:   PASS

FINDING:  Code review of household.js lines 286-296 confirms the staging
          lookup query includes AND promoted_at IS NULL as a filter
          condition. A previously promoted staging record is invisible to
          subsequent calls for the same child name and dob. The idempotency
          guard is present and correct.

FIX:      None.

---

## Summary

| Check | Status | Description                                           |
|-------|--------|-------------------------------------------------------|
| 1     | FAIL   | No unique index on identifier_link — ON CONFLICT broken |
| 2     | RISK   | No duplicate prevention on conflict_queue pairs       |
| 3     | RISK   | No race protection on merge_history active records    |
| 4     | RISK   | No uniqueness on related_fans — duplicates possible   |
| 5     | PASS   | household unique index per adult per org              |
| 6     | PASS   | household_member partial unique per minor per org     |
| 7     | PASS   | audit_log append-only trigger (DELETE + UPDATE)       |
| 8     | FAIL   | 7 event_types missing from audit_log CHECK constraint |
| 9     | FAIL   | 5 identifier_types missing from audit_log CHECK       |
| 10    | PASS   | identifier_link identifier_type constraint complete   |
| 11    | FAIL   | RLS missing on 6 of 10 tenant tables                  |
| 12    | PASS   | circular household trigger exists                     |
| 13    | PASS   | fan.deleted_at nullable — soft delete correct         |
| 14    | PASS   | merge_history status transitions code review          |
| 15    | PASS   | staging promotion idempotency code review             |

**Total PASS:   8**
**Total FAIL:   4**
**Total RISK:   3**
**Total VERIFY: 0**

---

## Priority Fix List

### P1 — Blocking (production broken today)

**CHECK 8 — audit_log event_type constraint (FAIL)**
Every household and unmerge audit log write fails in production with a
CHECK constraint violation. 7 endpoints return 500 on any request that
reaches the audit write step. Fix: add migration to update constraint.

**CHECK 1 — identifier_link ON CONFLICT target (FAIL)**
PUT /v1/household/:id/members/:child_id (Component 31) returns 500 on
every call in production. Postgres rejects the ON CONFLICT clause because
no unique index on (fan_id, identifier_type, org_id) exists.
Fix: add the unique index before deploying.

### P2 — Data integrity (broken under load or concurrent access)

**CHECK 9 — audit_log identifier_type constraint (FAIL)**
POST /v1/resolve and POST /v1/ingest/nfc fail in production if called
with name, dob, zip, guardian_email, or guardian_phone identifier types.
Fix: update constraint to include all 10 types with IS NULL OR pattern.

**CHECK 11 — RLS on Sprint 2 and Sprint 3 tables (FAIL)**
6 tenant tables have no row-level security. Cross-tenant isolation relies
entirely on application code. Fix: extend migration_003 pattern to all
6 new tables before any second org is onboarded.

### P3 — Risk (race conditions, retry storms)

**CHECK 3 — merge_history race condition (RISK)**
Two concurrent unmerge calls can both read status = 'active', both proceed
through their transaction, creating duplicate audit events and related_fans
rows. Fix: add partial unique index on conflict_id WHERE status = 'active'.

**CHECK 2 — conflict_queue duplicate pairs (RISK)**
Rapid re-ingestion or retry storms can create duplicate pending conflicts
for the same fan pair. Fix: add partial unique index.

**CHECK 4 — related_fans duplicates (RISK)**
Age-up or unmerge retries insert duplicate relationship rows. Fix: add
unique index on (fan_id_a, fan_id_b, org_id, relationship).

---

## Migration Recommendation

All seven fixes belong in a single new migration (migration_008.sql):
- DROP + recreate audit_log_event_type_check with all 11 values
- DROP + recreate audit_log_identifier_type_check with IS NULL OR + 10 values
- CREATE UNIQUE INDEX uq_identifier_link_managed (or non-partial variant)
- CREATE UNIQUE INDEX uq_conflict_queue_pair (partial, WHERE status = 'pending')
- CREATE UNIQUE INDEX uq_merge_history_active (partial, WHERE status = 'active')
- CREATE UNIQUE INDEX uq_related_fans_pair
- ENABLE ROW LEVEL SECURITY + policies on 6 tables

Run locally first, verify with the query patterns used in this audit,
then run on Cloud SQL once GCP credentials arrive.
