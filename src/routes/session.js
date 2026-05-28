'use strict';

const crypto  = require('crypto');
const express = require('express');
const pool    = require('../db/pool');
const { signToken } = require('../modules/jwt');

const router = express.Router();
const logger = { error: console.error, warn: console.warn };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/v1/session', async (req, res) => {
  // RECEIVE
  const body           = req.body;
  const fan_id         = body.fan_id;
  const org_id         = req.context.org_id;  // ground truth from orgAuthMiddleware
  const schema_version = body.schema_version;

  // GUARD — in-memory only
  if (body.org_id !== undefined && body.org_id !== org_id) {
    return res.status(400).json({
      error: 'org_id mismatch',
      message: 'request body org_id does not match authenticated org'
    });
  }
  if (!fan_id || !String(fan_id).trim()) {
    return res.status(400).json({ error: 'fan_id is required' });
  }
  if (!UUID_RE.test(fan_id)) {
    return res.status(400).json({ error: 'fan_id must be a valid UUID' });
  }
  if (!schema_version || !String(schema_version).trim()) {
    return res.status(400).json({ error: 'schema_version is required' });
  }

  // EXECUTE
  let tokenResult;
  try {
    const fanResult = await pool.query(
      'SELECT id, org_id, stewardship_tier, deleted_at FROM fan WHERE id = $1 AND org_id = $2',
      [fan_id, org_id]
    );
    const fan = fanResult.rows[0];
    if (!fan) {
      return res.status(404).json({ error: 'fan record not found — resolve identifier first' });
    }
    if (fan.deleted_at) {
      return res.status(403).json({ error: 'fan record has been erased — cannot issue session' });
    }

    tokenResult = signToken({ fan_id, org_id });

    await pool.query(
      `INSERT INTO audit_log
         (id, fan_id, org_id, event_type, schema_version, jti, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      [crypto.randomUUID(), fan_id, org_id, 'session_issued', schema_version, tokenResult.jti, 'success']
    );
  } catch (err) {
    if (tokenResult) {
      logger.error('token_without_audit', {
        event:          'token_without_audit',
        fan_id,
        org_id,
        jti:            tokenResult.jti,
        error:          err.message,
        correlation_id: req.context.correlation_id
      });
    } else {
      logger.error('session endpoint failure', { fan_id, org_id, error: err.message, correlation_id: req.context.correlation_id });
    }
    return res.status(500).json({ error: 'session could not be issued' });
  }

  // RETURN
  return res.status(200).json({
    token:      tokenResult.token,
    fan_id,
    expires_at: tokenResult.expires_at,
    token_type: 'Bearer'
  });
});

module.exports = router;
