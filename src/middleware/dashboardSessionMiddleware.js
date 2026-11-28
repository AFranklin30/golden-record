'use strict';

const pool = require('../db/pool');
const logger = require('../lib/logger');
const { readSession } = require('../modules/operatorAuth');

const COOKIE_NAME = 'gr_session';

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header || typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return null;
}

async function dashboardSessionMiddleware(req, res, next) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) {
    return res.status(401).json({ error: 'unauthorized', message: 'sign in required' });
  }

  try {
    const session = await readSession(pool, token);
    if (!session) {
      return res.status(401).json({ error: 'unauthorized', message: 'sign in required' });
    }
    req.context = {
      org_id: session.org_id,
      org_name: session.org_name,
      principal_type: 'operator',
      operator_id: session.operator_id,
      operator_email: session.email,
      operator_role: session.role,
    };
    next();
  } catch (err) {
    logger.error('dashboard session lookup failed', { error: err.message });
    return res.status(500).json({ error: 'internal error' });
  }
}

module.exports = dashboardSessionMiddleware;
module.exports.COOKIE_NAME = COOKIE_NAME;
module.exports.readCookie = readCookie;
