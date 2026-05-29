'use strict';

const express = require('express');

const router = express.Router();
const logger = { error: console.error, warn: console.warn };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/v1/household', async (req, res) => {
  // RECEIVE
  const org_id       = req.context.org_id;
  const adult_fan_id = req.context.fan_id;

  // GUARD — in-memory only
  if (!adult_fan_id) {
    return res.status(400).json({ error: 'adult_fan_id is required' });
  }
  if (!UUID_RE.test(adult_fan_id)) {
    return res.status(400).json({ error: 'adult_fan_id must be a valid UUID' });
  }

  // EXECUTE
  let row;
  try {
    // DB read 1 — verify fan exists, belongs to org, not soft-deleted
    const fanResult = await req.db.query(
      'SELECT id, deleted_at FROM fan WHERE id = $1 AND org_id = $2',
      [adult_fan_id, org_id]
    );
    const fan = fanResult.rows[0];
    if (!fan) {
      return res.status(403).json({ error: 'fan record not found or does not belong to this org' });
    }
    if (fan.deleted_at) {
      return res.status(403).json({ error: 'fan record has been erased — cannot create household' });
    }

    // DB read 2 — check for existing household before writing
    const existingResult = await req.db.query(
      'SELECT id FROM household WHERE adult_fan_id = $1 AND org_id = $2',
      [adult_fan_id, org_id]
    );
    const existing = existingResult.rows[0];
    if (existing) {
      return res.status(409).json({
        error:        'household already exists',
        household_id: existing.id
      });
    }

    // DB write 1 — create household
    const insertResult = await req.db.query(
      `INSERT INTO household (id, org_id, adult_fan_id, created_by, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'fan', NOW())
       RETURNING id, org_id, adult_fan_id, created_at`,
      [org_id, adult_fan_id]
    );
    row = insertResult.rows[0];

    // DB write 2 — audit event — non-fatal if it fails
    try {
      await req.db.query(
        `INSERT INTO audit_log (id, fan_id, org_id, event_type, status, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'household_created', 'success', NOW())`,
        [adult_fan_id, org_id]
      );
    } catch (auditErr) {
      logger.error('audit log write failed after household creation', {
        error:          auditErr.message,
        fan_id:         adult_fan_id,
        org_id,
        correlation_id: req.context.correlation_id
      });
    }
  } catch (err) {
    logger.error('household creation failed', {
      error:          err.message,
      fan_id:         adult_fan_id,
      org_id,
      correlation_id: req.context.correlation_id
    });
    return res.status(500).json({ error: 'household could not be created' });
  }

  // RETURN
  return res.status(201).json({
    household_id: row.id,
    adult_fan_id: row.adult_fan_id,
    org_id:       row.org_id,
    created_at:   row.created_at
  });
});

router.get('/v1/household/:adult_fan_id', async (req, res) => {
  // RECEIVE
  const adult_fan_id          = req.params.adult_fan_id;
  const org_id                = req.context.org_id;
  const authenticated_fan_id  = req.context.fan_id;

  // GUARD — in-memory only, no db calls
  if (!adult_fan_id) {
    return res.status(400).json({ error: 'adult_fan_id is required' });
  }
  if (!UUID_RE.test(adult_fan_id)) {
    return res.status(400).json({ error: 'adult_fan_id must be a valid UUID' });
  }
  if (authenticated_fan_id !== adult_fan_id) {
    return res.status(403).json({ error: 'access denied' });
  }

  // EXECUTE
  let row, member_count;
  try {
    // READ 1 — verify fan exists, belongs to org, not soft-deleted
    const fanResult = await req.db.query(
      'SELECT id, deleted_at FROM fan WHERE id = $1 AND org_id = $2',
      [adult_fan_id, org_id]
    );
    const fan = fanResult.rows[0];
    if (!fan) {
      return res.status(404).json({ error: 'fan not found' });
    }
    if (fan.deleted_at) {
      return res.status(403).json({ error: 'fan account is inactive' });
    }

    // READ 2 — fetch household record
    const householdResult = await req.db.query(
      `SELECT id, org_id, adult_fan_id, created_at, created_by
       FROM household
       WHERE adult_fan_id = $1 AND org_id = $2`,
      [adult_fan_id, org_id]
    );
    row = householdResult.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'household not found' });
    }

    // READ 3 — fetch active member count
    const countResult = await req.db.query(
      `SELECT COUNT(*) FROM household_member
       WHERE household_id = $1
         AND org_id = $2
         AND status = 'active'`,
      [row.id, org_id]
    );
    member_count = parseInt(countResult.rows[0].count, 10);
  } catch (err) {
    logger.error('household fetch failed', {
      error:          err.message,
      fan_id:         adult_fan_id,
      org_id,
      correlation_id: req.context.correlation_id
    });
    return res.status(500).json({ error: 'household could not be retrieved' });
  }

  // RETURN
  return res.status(200).json({
    household_id: row.id,
    adult_fan_id: row.adult_fan_id,
    org_id:       row.org_id,
    member_count,
    created_at:   row.created_at,
    created_by:   row.created_by
  });
});

module.exports = router;
