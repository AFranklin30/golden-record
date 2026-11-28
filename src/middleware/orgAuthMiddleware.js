'use strict';

const crypto = require('crypto');
const pool   = require('../db/pool');
const logger = require('../lib/logger');

async function orgAuthMiddleware(req, res, next) {
  // RECEIVE
  const authHeader = req.headers['authorization'];

  // GUARD — in-memory only, no TRY needed here
  if (!authHeader || !authHeader.trim()) {
    return res.status(401).json({ error: 'unauthorized', message: 'Authorization header is missing' });
  }
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized', message: 'must use Bearer scheme' });
  }
  const rawKey = authHeader.slice('Bearer '.length).trim();
  if (!rawKey) {
    return res.status(401).json({ error: 'unauthorized', message: 'Bearer token is empty' });
  }
  if (rawKey.length > 512) {
    return res.status(401).json({ error: 'unauthorized', message: 'invalid credentials' });
  }

  // EXECUTE — TRY wraps all db work (Pattern 1)
  try {
    const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
    const result    = await pool.query(
      'SELECT id, name, is_active FROM org WHERE org_api_key_hash = $1',
      [hashedKey]
    );
    const org = result.rows[0];

    if (!org) {
      logger.warn('org auth failed — key not found', { ip: req.ip });
      return res.status(401).json({ error: 'unauthorized', message: 'invalid credentials' });
    }
    if (!org.is_active) {
      logger.warn('org auth failed — org inactive', { org_id: org.id, ip: req.ip });
      return res.status(403).json({ error: 'forbidden', message: 'org account is inactive' });
    }

    req.context = { org_id: org.id, org_name: org.name, principal_type: 'integration' };
    next();
  } catch (err) {
    logger.error('org auth db failure', { error: err.message, ip: req.ip });
    return res.status(500).json({ error: 'internal error', message: 'authentication could not be completed' });
  }
}

module.exports = orgAuthMiddleware;
