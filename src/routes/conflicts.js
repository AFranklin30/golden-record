'use strict';

const crypto  = require('crypto');
const express = require('express');

const router = express.Router();
const logger = { error: console.error };

const UUID_RE          = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_STATUSES = ['pending', 'confirmed', 'rejected', 'unmerged'];

// COMPONENT 18 — GET /v1/conflicts
router.get('/v1/conflicts', async (req, res) => {
  // RECEIVE
  const org_id = req.context.org_id;
  const status = req.query.status || 'pending';
  const limit  = req.query.limit  !== undefined ? parseInt(req.query.limit,  10) : 50;
  const offset = req.query.offset !== undefined ? parseInt(req.query.offset, 10) : 0;

  // GUARD
  if (!ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({
      error:   'invalid status',
      message: 'status must be one of: pending, confirmed, rejected, unmerged'
    });
  }
  if (isNaN(limit) || limit < 1) {
    return res.status(400).json({
      error:   'invalid limit',
      message: 'limit must be at least 1'
    });
  }
  if (limit > 100) {
    return res.status(400).json({
      error:   'limit exceeds maximum',
      message: 'limit cannot exceed 100'
    });
  }
  if (isNaN(offset) || offset < 0) {
    return res.status(400).json({
      error:   'invalid offset',
      message: 'offset cannot be negative'
    });
  }

  // EXECUTE
  try {
    const conflictsResult = await req.db.query(
      `SELECT id, fan_id_a, fan_id_b, confidence_score, signals_matched,
              status, created_at, reviewed_at
       FROM conflict_queue
       WHERE org_id = $1 AND status = $2
       ORDER BY confidence_score DESC
       LIMIT $3 OFFSET $4`,
      [org_id, status, limit, offset]
    );

    const countResult = await req.db.query(
      'SELECT COUNT(*) FROM conflict_queue WHERE org_id = $1 AND status = $2',
      [org_id, status]
    );

    // RETURN
    return res.status(200).json({
      conflicts: conflictsResult.rows.map(c => ({
        conflict_id:      c.id,
        fan_id_a:         c.fan_id_a,
        fan_id_b:         c.fan_id_b,
        confidence_score: c.confidence_score,
        signals_matched:  c.signals_matched,
        status:           c.status,
        created_at:       c.created_at,
        reviewed_at:      c.reviewed_at
      })),
      total:         parseInt(countResult.rows[0].count, 10),
      status_filter: status,
      limit:         limit,
      offset:        offset
    });
  } catch (err) {
    logger.error('conflict list fetch failed', {
      error:          err.message,
      org_id:         org_id,
      correlation_id: req.context.correlation_id
    });
    return res.status(500).json({ error: 'conflict queue could not be retrieved' });
  }
});

// COMPONENT 19 — POST /v1/conflicts/:id/confirm
router.post('/v1/conflicts/:id/confirm', async (req, res) => {
  // RECEIVE
  const conflict_id = req.params.id;
  const org_id      = req.context.org_id;

  // GUARD
  if (!conflict_id || !String(conflict_id).trim()) {
    return res.status(400).json({ error: 'conflict_id is required' });
  }
  if (!UUID_RE.test(conflict_id)) {
    return res.status(400).json({ error: 'conflict_id must be a valid UUID' });
  }

  // EXECUTE
  try {
    // READ — verify conflict exists, belongs to org, is pending
    const conflictResult = await req.db.query(
      `SELECT id, fan_id_a, fan_id_b, org_id, status
       FROM conflict_queue
       WHERE id = $1 AND org_id = $2`,
      [conflict_id, org_id]
    );

    if (conflictResult.rows.length === 0) {
      return res.status(404).json({ error: 'conflict not found' });
    }

    const conflict = conflictResult.rows[0];

    if (conflict.status !== 'pending') {
      return res.status(409).json({ error: 'conflict already resolved' });
    }

    const fanAResult = await req.db.query(
      'SELECT deleted_at FROM fan WHERE id = $1 AND org_id = $2',
      [conflict.fan_id_a, org_id]
    );
    if (fanAResult.rows.length === 0) {
      return res.status(404).json({ error: 'target fan record not found' });
    }
    if (fanAResult.rows[0].deleted_at !== null) {
      return res.status(409).json({
        error: 'merge target has been deleted',
        message: 'fan_id_a no longer exists — this conflict cannot be confirmed'
      });
    }

    await req.db.query('BEGIN');

    // STEP 1 — move fan_id_b identifiers to fan_id_a AND track provenance for unmerge
    await req.db.query(
      `UPDATE identifier_link
       SET fan_id = $1, merged_from_fan_id = $2
       WHERE fan_id = $2 AND org_id = $3`,
      [conflict.fan_id_a, conflict.fan_id_b, org_id]
    );

    // STEP 2 — soft delete fan_id_b — merged, no longer active
    await req.db.query(
      `UPDATE fan
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND org_id = $2`,
      [conflict.fan_id_b, org_id]
    );

    // STEP 3 — close conflict as confirmed
    await req.db.query(
      `UPDATE conflict_queue
       SET status = 'confirmed', reviewed_at = NOW()
       WHERE id = $1`,
      [conflict_id]
    );

    // STEP 3B — write merge_history record for unmerge audit trail
    await req.db.query(
      `INSERT INTO merge_history
         (id, fan_id_source, fan_id_target, org_id, conflict_id, merged_by, status, merged_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW())`,
      [crypto.randomUUID(), conflict.fan_id_b, conflict.fan_id_a, org_id, conflict_id, req.context.org_name]
    );

    // STEP 4 — audit event — always last write in transaction
    await req.db.query(
      `INSERT INTO audit_log (id, fan_id, org_id, event_type, status, created_at)
       VALUES ($1, $2, $3, 'conflict_confirmed', 'success', NOW())`,
      [crypto.randomUUID(), conflict.fan_id_a, org_id]
    );

    await req.db.query('COMMIT');

    // RETURN
    return res.status(200).json({
      conflict_id: conflict_id,
      status:      'confirmed',
      merged_into: conflict.fan_id_a,
      resolved_at: new Date().toISOString()
    });

  } catch (err) {
    await req.db.query('ROLLBACK').catch(() => {});
    logger.error('conflict confirm failed', {
      error:          err.message,
      conflict_id:    conflict_id,
      org_id:         org_id,
      correlation_id: req.context.correlation_id
    });
    return res.status(500).json({ error: 'conflict could not be confirmed' });
  }
});

// COMPONENT 20 — POST /v1/conflicts/:id/reject
router.post('/v1/conflicts/:id/reject', async (req, res) => {
  // RECEIVE
  const conflict_id = req.params.id;
  const org_id      = req.context.org_id;

  // GUARD
  if (!conflict_id || !String(conflict_id).trim()) {
    return res.status(400).json({ error: 'conflict_id is required' });
  }
  if (!UUID_RE.test(conflict_id)) {
    return res.status(400).json({ error: 'conflict_id must be a valid UUID' });
  }

  // EXECUTE
  try {
    // READ — verify conflict exists, belongs to org, is pending
    const conflictResult = await req.db.query(
      `SELECT id, fan_id_a, fan_id_b, org_id, status
       FROM conflict_queue
       WHERE id = $1 AND org_id = $2`,
      [conflict_id, org_id]
    );

    if (conflictResult.rows.length === 0) {
      return res.status(404).json({ error: 'conflict not found' });
    }

    const conflict = conflictResult.rows[0];

    if (conflict.status !== 'pending') {
      return res.status(409).json({ error: 'conflict already resolved' });
    }

    await req.db.query('BEGIN');

    // STEP 1 — close conflict as rejected
    // Both fan records stay separate — no identifier moves, no soft delete
    await req.db.query(
      `UPDATE conflict_queue
       SET status = 'rejected', reviewed_at = NOW()
       WHERE id = $1`,
      [conflict_id]
    );

    // STEP 2 — audit event — always last write in transaction
    await req.db.query(
      `INSERT INTO audit_log (id, fan_id, org_id, event_type, status, created_at)
       VALUES ($1, $2, $3, 'conflict_rejected', 'success', NOW())`,
      [crypto.randomUUID(), conflict.fan_id_a, org_id]
    );

    await req.db.query('COMMIT');

    // RETURN
    return res.status(200).json({
      conflict_id: conflict_id,
      status:      'rejected',
      resolved_at: new Date().toISOString()
    });

  } catch (err) {
    await req.db.query('ROLLBACK').catch(() => {});
    logger.error('conflict reject failed', {
      error:          err.message,
      conflict_id:    conflict_id,
      org_id:         org_id,
      correlation_id: req.context.correlation_id
    });
    return res.status(500).json({ error: 'conflict could not be rejected' });
  }
});

// COMPONENT 26 — POST /v1/conflicts/:id/unmerge
router.post('/v1/conflicts/:id/unmerge', async (req, res) => {
  // RECEIVE
  const conflict_id = req.params.id;
  const org_id      = req.context.org_id;

  // GUARD
  if (!conflict_id || !String(conflict_id).trim()) {
    return res.status(400).json({ error: 'conflict_id is required' });
  }
  if (!UUID_RE.test(conflict_id)) {
    return res.status(400).json({ error: 'conflict_id must be a valid UUID' });
  }

  // EXECUTE
  try {
    // READ 1 — verify conflict exists, belongs to org, was confirmed
    const conflictResult = await req.db.query(
      `SELECT id, fan_id_a, fan_id_b, org_id, status
       FROM conflict_queue
       WHERE id = $1 AND org_id = $2`,
      [conflict_id, org_id]
    );

    if (conflictResult.rows.length === 0) {
      return res.status(404).json({ error: 'conflict not found' });
    }

    const conflict = conflictResult.rows[0];

    if (conflict.status !== 'confirmed') {
      return res.status(409).json({
        error:   'conflict is not confirmed',
        message: 'only confirmed merges can be reversed'
      });
    }

    // READ 2 — find active merge_history record for this conflict
    const mergeResult = await req.db.query(
      `SELECT id, fan_id_source, fan_id_target, status
       FROM merge_history
       WHERE conflict_id = $1 AND org_id = $2 AND status = 'active'`,
      [conflict_id, org_id]
    );

    if (mergeResult.rows.length === 0) {
      return res.status(404).json({
        error:   'merge history not found',
        message: 'this merge cannot be reversed'
      });
    }

    const mergeRecord = mergeResult.rows[0];

    await req.db.query('BEGIN');

    // STEP 1 — move identifiers back to fan_id_source using merged_from_fan_id provenance
    await req.db.query(
      `UPDATE identifier_link
       SET fan_id = merged_from_fan_id,
           merged_from_fan_id = NULL
       WHERE fan_id = $1
         AND merged_from_fan_id = $2
         AND org_id = $3`,
      [mergeRecord.fan_id_target, mergeRecord.fan_id_source, org_id]
    );

    // STEP 2 — reactivate fan_id_source
    await req.db.query(
      `UPDATE fan
       SET deleted_at = NULL, updated_at = NOW()
       WHERE id = $1 AND org_id = $2`,
      [mergeRecord.fan_id_source, org_id]
    );

    // STEP 3 — update conflict_queue status to unmerged
    await req.db.query(
      `UPDATE conflict_queue
       SET status = 'unmerged', reviewed_at = NOW()
       WHERE id = $1`,
      [conflict_id]
    );

    // STEP 4 — update merge_history status to reversed
    await req.db.query(
      `UPDATE merge_history
       SET status = 'reversed',
           reversed_at = NOW(),
           reversed_by = $1
       WHERE id = $2`,
      [req.context.org_name, mergeRecord.id]
    );

    // STEP 5 — write to related_fans
    await req.db.query(
      `INSERT INTO related_fans
         (id, fan_id_a, fan_id_b, org_id, relationship, source, created_at)
       VALUES ($1, $2, $3, $4, 'unmerged', 'merge_history', NOW())`,
      [crypto.randomUUID(), mergeRecord.fan_id_target, mergeRecord.fan_id_source, org_id]
    );

    // STEP 6 — audit event — always last write in transaction
    await req.db.query(
      `INSERT INTO audit_log (id, fan_id, org_id, event_type, status, created_at)
       VALUES ($1, $2, $3, 'merge_reversed', 'success', NOW())`,
      [crypto.randomUUID(), mergeRecord.fan_id_target, org_id]
    );

    await req.db.query('COMMIT');

    // RETURN
    return res.status(200).json({
      conflict_id:     conflict_id,
      status:          'unmerged',
      fan_id_restored: mergeRecord.fan_id_source,
      fan_id_target:   mergeRecord.fan_id_target,
      reversed_at:     new Date().toISOString()
    });

  } catch (err) {
    await req.db.query('ROLLBACK').catch(() => {});
    logger.error('unmerge failed', {
      error:          err.message,
      conflict_id:    conflict_id,
      org_id:         org_id,
      correlation_id: req.context.correlation_id
    });
    return res.status(500).json({ error: 'unmerge could not be completed' });
  }
});

module.exports = router;







