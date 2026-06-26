'use strict';
// tests/helpers/invariants.js
//
// assertInvariants(client, orgId) — runs a battery of SQL checks asserting
// global data-integrity properties of the golden-record identity graph.
//
// Returns: Array<{ invariant: string, detail: string, rows: object[] }>
// Empty array = clean. Caller asserts .length === 0.
//
// Does NOT throw — returns all violations and lets the caller decide.
//
// MUST be called with a postgres (superuser) client that bypasses RLS.
// RLS-scoped clients cannot detect cross-org leaks (I1) — they are invisible
// under tenant isolation and only visible with RLS off.
//
// Usage:
//   const client = await pool.connect();   // pool connects as postgres
//   const violations = await assertInvariants(client, orgId);
//   assert(violations.length === 0, JSON.stringify(violations));

async function assertInvariants(client, orgId) {
  const violations = [];

  // I1 — no cross-org / orphan identifier_link.
  // Every identifier_link.fan_id must reference a fan in the SAME org.
  // FK guarantees the fan exists; it does NOT guarantee same-org.
  // This catches tenant leaks that RLS makes invisible to app-level queries.
  const i1 = await client.query(
    `SELECT il.id, il.fan_id, il.org_id, f.org_id AS fan_org
     FROM identifier_link il
     JOIN fan f ON f.id = il.fan_id
     WHERE il.org_id = $1 AND f.org_id <> il.org_id`,
    [orgId]
  );
  if (i1.rows.length > 0) {
    violations.push({
      invariant: 'I1',
      detail:    'identifier_link.org_id does not match fan.org_id — cross-org or orphan link',
      rows:      i1.rows,
    });
  }

  // I2 — identifier uniqueness.
  // No (identifier_type, identifier_value, org_id) maps to more than one fan_id.
  // uq_identifier_per_org was found ABSENT in Step 0 (confirmed 2026-06-23),
  // making this checker the only runtime guard for this invariant.
  const i2 = await client.query(
    `SELECT identifier_type, identifier_value, COUNT(DISTINCT fan_id) AS fan_count
     FROM identifier_link
     WHERE org_id = $1
     GROUP BY identifier_type, identifier_value
     HAVING COUNT(DISTINCT fan_id) > 1`,
    [orgId]
  );
  if (i2.rows.length > 0) {
    violations.push({
      invariant: 'I2',
      detail:    'identifier (type, value) maps to multiple distinct fan_ids in the same org',
      rows:      i2.rows,
    });
  }

  // I3 — conflict_queue score bounds.
  // confidence_score is NUMERIC(4,3) with no range CHECK constraint, so an
  // additive-scoring regression (>1.0) is storable. This catches it at runtime.
  const i3 = await client.query(
    `SELECT id, confidence_score
     FROM conflict_queue
     WHERE org_id = $1 AND (confidence_score < 0 OR confidence_score > 1)`,
    [orgId]
  );
  if (i3.rows.length > 0) {
    violations.push({
      invariant: 'I3',
      detail:    'conflict_queue.confidence_score is outside [0, 1]',
      rows:      i3.rows,
    });
  }

  // I4 — no self-conflict.
  // Belt-and-suspenders: conflict_queue_fan_a_not_fan_b_check (migration_012)
  // enforces this at the DB level. This check catches any bypass.
  const i4 = await client.query(
    `SELECT id FROM conflict_queue
     WHERE org_id = $1 AND fan_id_a = fan_id_b`,
    [orgId]
  );
  if (i4.rows.length > 0) {
    violations.push({
      invariant: 'I4',
      detail:    'conflict_queue row where fan_id_a = fan_id_b (self-conflict)',
      rows:      i4.rows,
    });
  }

  // I5 — merge consolidation.
  // Every ACTIVE merge_history row's fan_id_source must be soft-deleted.
  // A live merge means the absorbed fan is gone. No schema constraint enforces
  // this — it is pure application logic, making this a high-value check.
  const i5 = await client.query(
    `SELECT mh.id, mh.fan_id_source
     FROM merge_history mh
     JOIN fan f ON f.id = mh.fan_id_source
     WHERE mh.org_id = $1 AND mh.status = 'active' AND f.deleted_at IS NULL`,
    [orgId]
  );
  if (i5.rows.length > 0) {
    violations.push({
      invariant: 'I5',
      detail:    'active merge_history row: fan_id_source fan is not soft-deleted',
      rows:      i5.rows,
    });
  }

  // I6 — merge_history status/reversed pairing.
  // Belt-and-suspenders: merge_history_status_reversed_check (migration_012) enforces.
  // active  → reversed_at IS NULL  AND reversed_by IS NULL
  // reversed → reversed_at IS NOT NULL AND reversed_by IS NOT NULL
  const i6 = await client.query(
    `SELECT id FROM merge_history
     WHERE org_id = $1 AND (
       (status = 'active'   AND (reversed_at IS NOT NULL OR reversed_by IS NOT NULL)) OR
       (status = 'reversed' AND (reversed_at IS NULL     OR reversed_by IS NULL))
     )`,
    [orgId]
  );
  if (i6.rows.length > 0) {
    violations.push({
      invariant: 'I6',
      detail:    'merge_history status/reversed fields are inconsistent',
      rows:      i6.rows,
    });
  }

  // I7 — audit completeness (approximate).
  // Every CONFIRMED conflict must have at least one conflict_confirmed audit row
  // for its fan_id_a. audit_log has no conflict_id column, so this is an
  // approximate check — not a strict 1:1 per conflict_queue row. A fan_id_a
  // with ANY conflict_confirmed event passes. The limitation is intentional:
  // strict 1:1 would require audit_log.conflict_id which does not exist today.
  const i7 = await client.query(
    `SELECT cq.id FROM conflict_queue cq
     WHERE cq.org_id = $1 AND cq.status = 'confirmed'
       AND NOT EXISTS (
         SELECT 1 FROM audit_log al
         WHERE al.org_id      = cq.org_id
           AND al.event_type  = 'conflict_confirmed'
           AND al.fan_id      = cq.fan_id_a
       )`,
    [orgId]
  );
  if (i7.rows.length > 0) {
    violations.push({
      invariant: 'I7',
      detail:    'confirmed conflict_queue row with no conflict_confirmed audit event for fan_id_a',
      rows:      i7.rows,
    });
  }

  return violations;
}

module.exports = { assertInvariants };
