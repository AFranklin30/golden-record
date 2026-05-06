'use strict';

const crypto = require('crypto');
const express = require('express');

const { normalizeIdentifier, NormalizationError } = require('../modules/normalizer');
const { resolverEngine, ConflictError, ResolverError } = require('../modules/resolverEngine');

const router = express.Router();

const logger = { error: console.error, warn: console.warn };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/v1/resolve', async (req, res) => {
  // RECEIVE
  const body             = req.body;
  const identifier_type  = body.identifier_type;
  const identifier_value = body.identifier_value;
  const org_id           = body.org_id;
  const schema_version   = body.schema_version;
  const source_system    = body.source_system || 'unknown';

  // GUARD — in-memory only
  if (!identifier_type || !String(identifier_type).trim()) {
    return res.status(400).json({ error: 'identifier_type is required' });
  }
  if (identifier_value === null || identifier_value === undefined || identifier_value === '') {
    return res.status(400).json({ error: 'identifier_value is required' });
  }
  if (!org_id || !UUID_RE.test(org_id)) {
    return res.status(400).json({ error: 'org_id must be a valid UUID' });
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
    });
  } catch (err) {
    if (err instanceof ConflictError) {
      return res.status(409).json({ error: 'concurrent write conflict — retry request' });
    }
    if (err instanceof ResolverError) {
      logger.error('resolver engine failure', { error: err.message, org_id });
      return res.status(500).json({ error: 'resolver internal error' });
    }
    logger.error('unexpected resolve error', { error: err.message, org_id });
    return res.status(500).json({ error: 'resolver internal error' });
  }

  // RETURN
  return res.status(200).json({
    fan_id:           result.fan_id,
    match_type:       result.match_type,
    confidence_score: result.confidence_score,
    is_new_record:    result.is_new_record,
    linked_systems:   result.linked_systems,
    linked_count:     result.linked_count,
    audit_event_id:   result.audit_event_id
  });
});

module.exports = router;
