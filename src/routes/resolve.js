'use strict';

const crypto = require('crypto');
const express = require('express');

const { normalizeIdentifier, NormalizationError } = require('../modules/normalizer');
const { resolverEngine, ConflictError, ResolverError } = require('../modules/resolverEngine');

const router = express.Router();

const logger = require('../lib/logger');

router.post('/v1/resolve', async (req, res) => {
  // RECEIVE
  const body             = req.body;
  const identifier_type  = body.identifier_type;
  const identifier_value = body.identifier_value;
  const schema_version   = body.schema_version;
  const source_system    = body.source_system || 'unknown';
  const org_id           = req.context.org_id;  // ground truth from orgAuthMiddleware

  // GUARD — in-memory only
  if (body.org_id !== undefined && body.org_id !== org_id) {
    return res.status(400).json({
      error: 'org_id mismatch',
      message: 'request body org_id does not match authenticated org'
    });
  }
  if (!identifier_type || !String(identifier_type).trim()) {
    return res.status(400).json({ error: 'identifier_type is required' });
  }
  if (identifier_value === null || identifier_value === undefined || identifier_value === '') {
    return res.status(400).json({ error: 'identifier_value is required' });
  }
  if (!schema_version || !String(schema_version).trim()) {
    return res.status(400).json({ error: 'schema_version is required' });
  }

  // GUARD — normalization (own try/catch, produces 400)
  let normalized_value;
  try {
    normalized_value = normalizeIdentifier(identifier_type, identifier_value);
  } catch (err) {
    if (err instanceof NormalizationError) {
      return res.status(400).json({ error: 'identifier_value failed normalization', detail: err.message });
    }
    throw err;
  }

  const idempotency_key = crypto
    .createHash('sha256')
    .update(`${identifier_type}|${normalized_value}|${org_id}`)
    .digest('hex');

  // EXECUTE
  let result;
  try {
    result = await resolverEngine({
      identifier_type,
      identifier_value: normalized_value,
      org_id,
      schema_version,
      idempotency_key,
      source_system
    }, req.db);
  } catch (err) {
    if (err instanceof ConflictError) {
      return res.status(409).json({ error: 'concurrent write conflict — retry request' });
    }
    if (err instanceof ResolverError) {
      logger.error('resolver engine failure', { error: err.message, org_id, correlation_id: req.context.correlation_id });
      return res.status(500).json({ error: 'resolver internal error' });
    }
    logger.error('unexpected resolve error', { error: err.message, org_id, correlation_id: req.context.correlation_id });
    return res.status(500).json({ error: 'resolver internal error' });
  }

  // RETURN
  if (result.match_type === 'hard' && result.is_new_record === false) {
    return res.status(200).json({
      fan_id:           result.fan_id,
      match_type:       'hard',
      confidence_score: 1.0,
      is_new_record:    false,
      requires_review:  false,
      conflict_id:      null,
      linked_systems:   result.linked_systems,
      linked_count:     result.linked_count,
      audit_event_id:   result.audit_event_id
    });
  }

  if (result.match_type === 'hard' && result.is_new_record === true) {
    return res.status(200).json({
      fan_id:           result.fan_id,
      match_type:       'hard',
      confidence_score: 1.0,
      is_new_record:    true,
      requires_review:  false,
      conflict_id:      null,
      linked_systems:   [],
      linked_count:     0,
      audit_event_id:   result.audit_event_id
    });
  }

  if (result.match_type === 'soft') {
    return res.status(200).json({
      fan_id:           result.fan_id,
      match_type:       'soft',
      confidence_score: result.confidence_score,
      is_new_record:    true,
      requires_review:  true,
      conflict_id:      result.conflict_id,
      linked_systems:   [],
      linked_count:     0,
      audit_event_id:   result.audit_event_id
    });
  }

  if (result.match_type === 'conflict') {
    return res.status(200).json({
      fan_id:           result.fan_id,
      match_type:       'conflict',
      confidence_score: result.confidence_score,
      is_new_record:    true,
      requires_review:  true,
      conflict_id:      result.conflict_id,
      linked_systems:   [],
      linked_count:     0,
      audit_event_id:   result.audit_event_id
    });
  }

  logger.error('unknown match_type in resolver result', { match_type: result.match_type, org_id, correlation_id: req.context.correlation_id });
  return res.status(500).json({ error: 'resolver internal error' });
});

module.exports = router;
