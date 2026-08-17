'use strict';

const crypto  = require('crypto');
const express = require('express');

const { normalizeIdentifier, NormalizationError, normalizeIdentifiersObject } = require('../modules/normalizer');
const { resolverEngine, ConflictError, ResolverError } = require('../modules/resolverEngine');

const router = express.Router();

const logger  = require('../lib/logger');

router.post('/v1/ingest/nfc', async (req, res) => {
  // RECEIVE
  const body           = req.body;
  const nfc_uid        = body.nfc_uid;
  const station_id     = body.station_id;
  const schema_version = body.schema_version;
  const tapped_at      = body.tapped_at || new Date().toISOString();
  const identifiers    = body.identifiers || null;
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

  // GUARD — tapped_at bounds (5 min future tolerance, 24 hr past limit)
  const tappedAtMs   = Date.parse(tapped_at);
  if (isNaN(tappedAtMs)) {
    return res.status(400).json({ error: 'tapped_at is not a valid ISO 8601 timestamp' });
  }
  const nowMs = Date.now();
  if (tappedAtMs > nowMs + 5 * 60 * 1000) {
    return res.status(400).json({ error: 'tapped_at is too far in the future' });
  }
  if (tappedAtMs < nowMs - 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: 'tapped_at is too far in the past' });
  }

  // GUARD — identifiers object: type check + normalization (shared with resolve.js)
  // DELIBERATE: no ingest_failures write here — a bad identifiers field on an
  // otherwise-valid tap is caller error, not lost input. DLQ-ing it would
    // recreate the resolve/nfc asymmetry this change removes, in reverse.
  // Do not "fix" this.
  
  const identifiersResult = normalizeIdentifiersObject(identifiers);
  if (!identifiersResult.ok) {
    return res.status(identifiersResult.status).json(identifiersResult.body);
  }
  const normalizedIdentifiers = identifiersResult.value;

  // nfc_uid hashed in DLQ payload — raw PII must not persist in ingest_failures
  const dlqPayload = { ...body, nfc_uid: crypto.createHash('sha256').update(String(nfc_uid)).digest('hex') };

  // EXECUTE — TRY/CATCH 1: normalization failure
  let normalized_uid;
  try {
    normalized_uid = normalizeIdentifier('nfc_uid', nfc_uid);
  } catch (err) {
    if (err instanceof NormalizationError) {
      try {
        await req.db.query(
          `INSERT INTO ingest_failures (id, org_id, source_system, raw_payload, reason_code, error_detail)
           VALUES ($1, $2, 'nfc', $3, 'normalization_error', $4)`,
          [crypto.randomUUID(), org_id, dlqPayload, err.message]
        );
      } catch (dlqErr) {
        logger.error('DLQ write failed after normalization error', { event: 'dlq_write_failure', reason_code: 'normalization_error', org_id, station_id, error: dlqErr.message, correlation_id: req.context.correlation_id });
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
      identifiers: normalizedIdentifiers,
      org_id,
      schema_version,
      idempotency_key,
      source_system: 'nfc'
    }, req.db);
  } catch (err) {
    if (err instanceof ConflictError) {
      return res.status(409).json({ error: 'concurrent write conflict — retry tap' });
    }
    if (err instanceof ResolverError) {
      try {
        await req.db.query(
          `INSERT INTO ingest_failures (id, org_id, source_system, raw_payload, reason_code, error_detail)
           VALUES ($1, $2, 'nfc', $3, 'resolver_error', $4)`,
          [crypto.randomUUID(), org_id, dlqPayload, err.message]
        );
      } catch (dlqErr) {
        logger.error('DLQ write failed after resolver error', { event: 'dlq_write_failure', reason_code: 'resolver_error', org_id, station_id, error: dlqErr.message, correlation_id: req.context.correlation_id });
      }
      return res.status(500).json({ error: 'resolver internal error' });
    }
    logger.error('unexpected nfc ingest error', { error: err.message, org_id, station_id, correlation_id: req.context.correlation_id });
    return res.status(500).json({ error: 'resolver internal error' });
  }

  // RETURN
  const { match_type, is_new_record } = result;

  if (match_type === 'hard' && is_new_record === false) {
    return res.status(200).json({
      fan_id:           result.fan_id,
      match_type:       'hard',
      confidence_score: 1.0,
      is_new_record:    false,
      requires_review:  false,
      conflict_id:      null,
      linked_systems:   result.linked_systems,
      linked_count:     result.linked_count,
      audit_event_id:   result.audit_event_id,
      session_ready:    true
    });
  }

  if (match_type === 'hard' && is_new_record === true) {
    return res.status(200).json({
      fan_id:           result.fan_id,
      match_type:       'hard',
      confidence_score: 1.0,
      is_new_record:    true,
      requires_review:  false,
      conflict_id:      null,
      linked_systems:   [],
      linked_count:     0,
      audit_event_id:   result.audit_event_id,
      session_ready:    true
    });
  }

  if (match_type === 'soft') {
    return res.status(200).json({
      fan_id:           result.fan_id,
      match_type:       'soft',
      confidence_score: result.confidence_score,
      is_new_record:    true,
      requires_review:  true,
      conflict_id:      result.conflict_id,
      linked_systems:   [],
      linked_count:     0,
      audit_event_id:   result.audit_event_id,
      session_ready:    true
    });
  }

  if (match_type === 'conflict') {
    return res.status(200).json({
      fan_id:           result.fan_id,
      match_type:       'conflict',
      confidence_score: result.confidence_score,
      is_new_record:    true,
      requires_review:  true,
      conflict_id:      result.conflict_id,
      linked_systems:   [],
      linked_count:     0,
      audit_event_id:   result.audit_event_id,
      session_ready:    true
    });
  }

  logger.error('unexpected match_type in nfc ingest response', { match_type, org_id, correlation_id: req.context.correlation_id });
  return res.status(500).json({ error: 'resolver internal error' });
});

module.exports = router;
