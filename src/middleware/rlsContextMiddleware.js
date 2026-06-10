'use strict';

const pool   = require('../db/pool');
const logger = { error: console.error };

async function rlsContextMiddleware(req, res, next) {
  // RECEIVE
  const org_id = req.context && req.context.org_id;

  // GUARD
  if (!org_id) {
    logger.error('rlsContextMiddleware: org_id missing from request context');
    return res.status(500).json({ error: 'internal error', message: 'request context is incomplete' });
  }

  // EXECUTE
  let client;
  try {
    client = await pool.connect();
    await client.query(
      'SELECT set_config($1, $2, false), set_config($3, $4, false)',
      ['app.current_org_id', org_id, 'statement_timeout', '10000']
    );
    req.db = client;

    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        client.release();
      }
    };
    res.on('finish', releaseOnce);
    res.on('close', releaseOnce);

    next();
  } catch (err) {
    logger.error('rlsContextMiddleware: connection or set_config failed', {
      error:  err.message,
      org_id: org_id
    });
    if (client) client.release();
    return res.status(500).json({ error: 'internal error', message: 'request could not be initialized' });
  }
}

module.exports = rlsContextMiddleware;
