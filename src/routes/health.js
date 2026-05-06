'use strict';

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/health', async (req, res) => {
  // RECEIVE
  const results = {
    db: 'disconnected',
    queue_depth: 0,
    error_rate_5m: 0.0,
    timestamp: new Date().toISOString()
  };

  // EXECUTE — three independent blocks, never throw

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
    const total = parseInt(totalResult.rows[0].count, 10);
    const errors = parseInt(errorsResult.rows[0].count, 10);
    if (total > 0) results.error_rate_5m = errors / total;
  } catch {
    // stays 0.0
  }

  // RETURN
  const isHealthy =
    results.db === 'connected' &&
    results.queue_depth < 10000 &&
    results.error_rate_5m < 0.01;

  return res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    db: results.db,
    queue_depth: results.queue_depth,
    error_rate_5m: results.error_rate_5m,
    timestamp: results.timestamp
  });
});

module.exports = router;
