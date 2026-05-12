'use strict';

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');

// Attempts to authenticate an org API key from the Authorization header.
// Returns true only if the key maps to an active org. Never throws.
async function tryOrgAuth(req) {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
    const rawKey = authHeader.slice('Bearer '.length).trim();
    if (!rawKey || rawKey.length > 512) return false;
    const hashedKey = crypto.createHash('sha256').update(rawKey).digest('hex');
    const { rows } = await pool.query(
      'SELECT is_active FROM org WHERE org_api_key_hash = $1',
      [hashedKey]
    );
    const org = rows[0];
    return !!(org && org.is_active);
  } catch {
    return false;
  }
}

router.get('/health', async (req, res) => {
  // RECEIVE
  const results = {
    db:            'disconnected',
    queue_depth:   0,
    error_rate_5m: 0.0,
    timestamp:     new Date().toISOString()
  };

  // EXECUTE — independent blocks, never throw

  // Block 1 — db probe
  try {
    await pool.query('SELECT 1');
    results.db = 'connected';
  } catch (err) {
    results.db = 'disconnected';
    console.error('health check db probe failed', { error: err.message });
  }

  // Block 2 — queue depth
  try {
    const { rows } = await pool.query(
      "SELECT COUNT(*) FROM ingest_failures WHERE status = 'pending'"
    );
    results.queue_depth = parseInt(rows[0].count, 10);
  } catch {
    // stays 0
  }

  // Block 3 — error rate (last 5 minutes)
  try {
    const totalResult = await pool.query(
      "SELECT COUNT(*) FROM audit_log WHERE created_at > NOW() - INTERVAL '5 minutes'"
    );
    const errorsResult = await pool.query(
      "SELECT COUNT(*) FROM audit_log WHERE created_at > NOW() - INTERVAL '5 minutes' AND status = 'error'"
    );
    const total  = parseInt(totalResult.rows[0].count, 10);
    const errors = parseInt(errorsResult.rows[0].count, 10);
    if (total > 0) results.error_rate_5m = errors / total;
  } catch {
    // stays 0.0
  }

  // Block 4 — auth check (determines response tier, never throws)
  const isAuthenticated = await tryOrgAuth(req);

  // RETURN
  const isHealthy =
    results.db === 'connected' &&
    results.queue_depth < 10000 &&
    results.error_rate_5m < 0.01;

  const status     = isHealthy ? 'ok' : 'degraded';
  const httpStatus = isHealthy ? 200 : 503;

  if (isAuthenticated) {
    return res.status(httpStatus).json({
      status,
      db:            results.db,
      queue_depth:   results.queue_depth,
      error_rate_5m: results.error_rate_5m,
      timestamp:     results.timestamp
    });
  }

  return res.status(httpStatus).json({ status, timestamp: results.timestamp });
});

module.exports = router;
