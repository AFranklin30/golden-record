'use strict';

const crypto = require('crypto');
const logger = { error: console.error };

async function correlationIdMiddleware(req, res, next) {
  // RECEIVE
  // (no external input — middleware generates its own)

  // GUARD
  // (none — crypto.randomUUID() requires no validation)

  // EXECUTE — TRY wraps EXECUTE only (Pattern 1)
  try {
    const correlationId = crypto.randomUUID();
    req.context.correlation_id = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
    next();
  } catch (err) {
    logger.error('correlationId middleware failure', { error: err.message });
    return res.status(500).json({ error: 'internal error', message: 'request could not be initialized' });
  }
}

module.exports = correlationIdMiddleware;
