'use strict';

const crypto  = require('crypto');
const express = require('express');

const { normalizeIdentifier, NormalizationError } = require('../modules/normalizer');
const { resolverEngine, ConflictError, ResolverError } = require('../modules/resolverEngine');
const pool = require('../db/pool');

const router = express.Router();

const logger  = { error: console.error, warn: console.warn };

router.post('/v1/ingest/nfc', async (req, res) => {
  // RECEIVE
  const body           = req.body;
  const nfc_uid        = body.nfc_uid;
  const station_id     = body.station_id;
  const schema_version = body.schema_version;
  const tapped_at      = body.tapped_at || new Date().toISOString();
  const org_id         = req.context.org_id;  // ground truth from orgAuthMiddleware

  // GUARD — in-memory only
  if (body.org_id !== undefined && body.org_id !== org_id) {
    return res.status(400).json({
      error: 'org_id mismatch',
      message: 'request body org_id does not match authenticated org'
    });
  }
  if (!nfc_uid || !String(nfc_uid).trim()) {
    return res.status(400).json({ error: 'nfc_uid is required' });
  }
  if (!station_id || !String(station_id).trim()) {
    return res.status(400).json({ error: 'station_id is required' });
  }
  if (String(station_id).length > 128) {
    return res.status(400).json({ error: 'station_id exceeds max length' });
  }
  if (!schema_version || !String(schema_version).trim()) {
    return res.status(400).json({ error: 'schema_version is required' });
  }

  // EXECUTE — TRY/CATCH 1: normalization failure
  let normalized_uid;
  try {
    normalized_uid = normalizeIdentifier('nfc_uid', nfc_uid);
  } catch (err) {
    if (err instanceof NormalizationError) {
      try {
        await pool.query(
          `INSERT INTO ingest_failures (id, org_id, source_system, raw_payload, reason_code, error_detail)
           VALUES ($1, $2, 'nfc', $3, 'normalization_error', $4)`,
          [crypto.randomUUID(), org_id, body, err.message]
        );
      } catch (dlqErr) {
        logger.error('DLQ write failed after normalization error', { org_id, station_id, error: dlqErr.message });
      }
      return res.status(400).json({ error: 'nfc_uid failed normalization', detail: err.message });
    }
    throw err;
  }

  // tapped_at excluded from idempotency key — hardware clock skew on retry breaks idempotency
  const idempotency_key = crypto
    .createHash('sha256')
    .update(`${normalized_uid}|${org_id}|${station_id}`)
    .digest('hex');

  // EXECUTE — TRY/CATCH 2: resolver failure
  let result;
  try {
    result = await resolverEngine({
      identifier_type:  'nfc_uid',
      identifier_value: normalized_uid,
      org_id,
      schema_version,
      idempotency_key,
      source_system: 'nfc'
    });
  } catch (err) {
    if (err instanceof ConflictError) {
      return res.status(409).json({ error: 'concurrent write conflict — retry tap' });
    }
    if (err instanceof ResolverError) {
      try {
        await pool.query(
          `INSERT INTO ingest_failures (id, org_id, source_system, raw_payload, reason_code, error_detail)
           VALUES ($1, $2, 'nfc', $3, 'resolver_error', $4)`,
          [crypto.randomUUID(), org_id, body, err.message]
        );
      } catch (dlqErr) {
        logger.error('DLQ write failed after resolver error', { org_id, station_id, error: dlqErr.message });
      }
      return res.status(500).json({ error: 'resolver internal error' });
    }
    logger.error('unexpected nfc ingest error', { error: err.message, org_id, station_id });
    return res.status(500).json({ error: 'resolver internal error' });
  }

  // RETURN
  return res.status(200).json({
    fan_id:           result.fan_id,
    match_type:       result.match_type,
    confidence_score: result.confidence_score,
    is_new_record:    result.is_new_record,
    audit_event_id:   result.audit_event_id,
    session_ready:    true
  });
});

module.exports = router;
