'use strict';

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const logger  = require('../lib/logger');

// RECEIVE — the bearer token is an organization API key, or absent.
// GUARD — unknown, inactive, and malformed keys produce no organization.
// Returns the organization id, or null. Never throws.
async function resolveActiveOrgId(req) {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
    const rawKey = authHeader.slice('Bearer '.length).trim();
    if (!rawKey || rawKey.length > 512) return null;
    const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
    const { rows } = await pool.query(
      'SELECT id, is_active FROM org WHERE org_api_key_hash = $1',
      [hashedKey]
    );
    const org = rows[0];
    if (!org || !org.is_active) return null;
    return org.id;
  } catch (err) {
    logger.error('health check org lookup failed', { error: err.message });
    return null;
  }
}

// EXECUTE — one organization's pending failures.
// The tenant setting is transaction-local, so it does not remain on the
// pooled connection after commit. The org_id predicate is the application
// guard. Row-level security is the database guard.
async function countPendingIngestFailures(client, orgId) {
  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT set_config('app.current_org_id', $1, true)`,
      [orgId]
    );
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n
         FROM ingest_failures
        WHERE org_id = $1
          AND status = 'pending'`,
      [orgId]
    );
    await client.query('COMMIT');
    return rows[0].n;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the transaction is already closed */ }
    throw err;
  }
}

router.get('/health', async (req, res) => {
  // RECEIVE
  const results = {
    db:          'disconnected',
    queue_depth: 0,
    timestamp:   new Date().toISOString()
  };

  // EXECUTE — independent blocks, never throw

  // Block 1 — db probe
  try {
    await pool.query('SELECT 1');
    results.db = 'connected';
  } catch (err) {
    results.db = 'disconnected';
    logger.error('health check db probe failed', { error: err.message });
  }

  // Block 2 — this organization's queue depth. No key means no count.
  const orgId = await resolveActiveOrgId(req);
  if (orgId) {
    const client = await pool.connect();
    try {
      results.queue_depth = await countPendingIngestFailures(client, orgId);
    } catch (err) {
      logger.error('health check queue depth failed', { error: err.message });
    } finally {
      client.release();
    }
  }

  // RETURN
  const isHealthy =
    results.db === 'connected' &&
    results.queue_depth < 10000;

  const status     = isHealthy ? 'ok' : 'degraded';
  const httpStatus = isHealthy ? 200 : 503;

  if (orgId) {
    return res.status(httpStatus).json({
      status,
      db:          results.db,
      queue_depth: results.queue_depth,
      timestamp:   results.timestamp
    });
  }

  return res.status(httpStatus).json({ status, timestamp: results.timestamp });
});

module.exports = router;
module.exports.countPendingIngestFailures = countPendingIngestFailures;
