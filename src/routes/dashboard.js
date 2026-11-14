'use strict';

const express = require('express');
const logger = require('../lib/logger');
const { UUID_RE } = require('../lib/validate');
const { readCustomerCsv, parseCustomerRow, importCustomers } = require('../modules/customerImport');
const conflictsRouter = require('./conflicts');
const exportRouter = require('./export');

const router = express.Router();
const PREVIEW_LIMIT = 25;
const REVIEW_STATUSES = ['pending', 'confirmed', 'rejected', 'unmerged'];

function dispatch(target, req, res, url) {
  req.url = url;
  target(req, res, (err) => {
    if (err) {
      logger.error('dashboard forward failed', {
        error: err.message,
        org_id: req.context && req.context.org_id,
      });
      if (!res.headersSent) return res.status(500).json({ error: 'internal error' });
      return;
    }
    if (!res.headersSent) return res.status(404).json({ error: 'not found' });
  });
}

router.get('/v1/dashboard/session', (req, res) => {
  return res.status(200).json({
    email: req.context.operator_email,
    org_name: req.context.org_name,
  });
});

router.post('/v1/dashboard/imports/preview', (req, res) => {
  const csv = req.body && req.body.csv;
  const mapping = req.body ? req.body.mapping : undefined;
  if (typeof csv !== 'string') {
    return res.status(400).json({ error: 'csv is required' });
  }
  const read = readCustomerCsv(csv, mapping);
  if (!read.ok) return res.status(400).json({ error: read.error });

  const checked = read.rows.map((row, index) => {
    const parsed = parseCustomerRow(row);
    return {
      row_number: index + 1,
      values: row,
      status: parsed.ok ? 'ok' : 'error',
      error: parsed.ok ? null : parsed.error,
    };
  });
  return res.status(200).json({
    headers: read.headers,
    total: checked.length,
    error_count: checked.filter((row) => row.status === 'error').length,
    preview: checked.slice(0, PREVIEW_LIMIT),
  });
});

router.post('/v1/dashboard/imports', async (req, res) => {
  const csv = req.body && req.body.csv;
  const mapping = req.body ? req.body.mapping : undefined;
  const filename = req.body && typeof req.body.filename === 'string' ? req.body.filename.slice(0, 200) : null;
  if (typeof csv !== 'string') {
    return res.status(400).json({ error: 'csv is required' });
  }
  const read = readCustomerCsv(csv, mapping);
  if (!read.ok) return res.status(400).json({ error: read.error });

  try {
    const result = await importCustomers(req.db, {
      orgId: req.context.org_id,
      rows: read.rows,
      filename,
    });
    const rows = result.rows.map((row) => ({
      row_number: row.row_number,
      status: row.status,
      fan_id: row.fan_id,
      resolution_path: row.resolution_path || null,
      conflict_id: row.conflict_id || null,
      error: row.error || null,
      skipped: row.skipped || null,
      replayed: Boolean(row.replayed),
    }));
    return res.status(200).json({
      batch_id: result.batch_id,
      total: rows.length,
      error_count: rows.filter((row) => row.status === 'error').length,
      rows,
    });
  } catch (err) {
    logger.error('dashboard import failed', {
      error: err.message,
      org_id: req.context.org_id,
      correlation_id: req.context.correlation_id,
    });
    return res.status(500).json({ error: 'import could not be completed' });
  }
});

router.get('/v1/dashboard/imports', async (req, res) => {
  try {
    const result = await req.db.query(
      `SELECT b.id, b.filename, b.created_at,
              COUNT(r.id)::int AS row_count,
              COUNT(r.id) FILTER (WHERE r.status = 'error')::int AS error_count
         FROM import_batch b
         LEFT JOIN import_row r ON r.batch_id = b.id
        WHERE b.org_id = $1
        GROUP BY b.id
        ORDER BY b.created_at DESC
        LIMIT 50`,
      [req.context.org_id]
    );
    return res.status(200).json({ imports: result.rows });
  } catch (err) {
    logger.error('dashboard import list failed', {
      error: err.message,
      org_id: req.context.org_id,
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

router.get('/v1/dashboard/imports/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'import id must be a uuid' });
  }
  try {
    const batch = await req.db.query(
      `SELECT id, filename, created_at FROM import_batch WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.context.org_id]
    );
    if (batch.rows.length === 0) return res.status(404).json({ error: 'import not found' });
    const rows = await req.db.query(
      `SELECT row_number, status, fan_id, resolution_path, conflict_id, error, skipped
         FROM import_row
        WHERE batch_id = $1 AND org_id = $2
        ORDER BY row_number
        LIMIT 200`,
      [req.params.id, req.context.org_id]
    );
    return res.status(200).json({ import: batch.rows[0], rows: rows.rows });
  } catch (err) {
    logger.error('dashboard import detail failed', {
      error: err.message,
      org_id: req.context.org_id,
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

async function peopleFor(db, orgId, fanIds) {
  const result = await db.query(
    `SELECT fan_id, identifier_type, identifier_value
       FROM identifier_link
      WHERE org_id = $1
        AND fan_id = ANY($2::uuid[])
        AND identifier_type IN ('name', 'email', 'dob', 'zip', 'phone')
      ORDER BY identifier_type, identifier_value`,
    [orgId, fanIds]
  );
  const byFan = {};
  for (const row of result.rows) {
    if (!byFan[row.fan_id]) byFan[row.fan_id] = {};
    if (!byFan[row.fan_id][row.identifier_type]) byFan[row.fan_id][row.identifier_type] = [];
    byFan[row.fan_id][row.identifier_type].push(row.identifier_value);
  }
  return byFan;
}

router.get('/v1/dashboard/reviews', async (req, res) => {
  const status = req.query.status === undefined ? 'pending' : req.query.status;
  if (typeof status !== 'string' || !REVIEW_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  try {
    const result = await req.db.query(
      `SELECT id, fan_id_a, fan_id_b, confidence_score, status, created_at, reviewed_at
         FROM conflict_queue
        WHERE org_id = $1 AND status = $2
        ORDER BY created_at DESC
        LIMIT 100`,
      [req.context.org_id, status]
    );
    const fanIds = result.rows.flatMap((row) => [row.fan_id_a, row.fan_id_b]);
    const people = fanIds.length ? await peopleFor(req.db, req.context.org_id, fanIds) : {};
    return res.status(200).json({
      reviews: result.rows.map((row) => ({
        conflict_id: row.id,
        fan_id_a: row.fan_id_a,
        fan_id_b: row.fan_id_b,
        confidence_score: row.confidence_score,
        status: row.status,
        created_at: row.created_at,
        reviewed_at: row.reviewed_at,
        person_a: people[row.fan_id_a] || {},
        person_b: people[row.fan_id_b] || {},
      })),
    });
  } catch (err) {
    logger.error('dashboard review list failed', {
      error: err.message,
      org_id: req.context.org_id,
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

router.get('/v1/dashboard/reviews/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'review id must be a uuid' });
  }
  try {
    const result = await req.db.query(
      `SELECT id, fan_id_a, fan_id_b, confidence_score, signals_matched, status, created_at, reviewed_at
         FROM conflict_queue
        WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.context.org_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'review not found' });
    const row = result.rows[0];
    const people = await peopleFor(req.db, req.context.org_id, [row.fan_id_a, row.fan_id_b]);
    return res.status(200).json({
      conflict_id: row.id,
      fan_id_a: row.fan_id_a,
      fan_id_b: row.fan_id_b,
      confidence_score: row.confidence_score,
      signals_matched: row.signals_matched,
      status: row.status,
      created_at: row.created_at,
      reviewed_at: row.reviewed_at,
      person_a: people[row.fan_id_a] || {},
      person_b: people[row.fan_id_b] || {},
    });
  } catch (err) {
    logger.error('dashboard review detail failed', {
      error: err.message,
      org_id: req.context.org_id,
    });
    return res.status(500).json({ error: 'internal error' });
  }
});

router.post('/v1/dashboard/conflicts/:id/confirm', (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'conflict_id must be a valid UUID' });
  }
  dispatch(conflictsRouter, req, res, `/v1/conflicts/${req.params.id}/confirm`);
});

router.post('/v1/dashboard/conflicts/:id/reject', (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'conflict_id must be a valid UUID' });
  }
  dispatch(conflictsRouter, req, res, `/v1/conflicts/${req.params.id}/reject`);
});

router.post('/v1/dashboard/conflicts/:id/unmerge', (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'conflict_id must be a valid UUID' });
  }
  dispatch(conflictsRouter, req, res, `/v1/conflicts/${req.params.id}/unmerge`);
});

router.get('/v1/dashboard/exports/fans', (req, res) => {
  dispatch(exportRouter, req, res, '/v1/export/fans');
});

module.exports = router;
