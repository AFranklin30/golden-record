'use strict';

const express = require('express');
const pool = require('../db/pool');
const logger = require('../lib/logger');
const { openSession, closeSession, SESSION_MS } = require('../modules/operatorAuth');
const { COOKIE_NAME, readCookie } = require('../middleware/dashboardSessionMiddleware');

const router = express.Router();

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MS,
  };
}

router.post('/v1/dashboard/session', async (req, res) => {
  const email = req.body && req.body.email;
  const password = req.body && req.body.password;
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const session = await openSession(pool, { email, password });
    if (!session) {
      return res.status(401).json({ error: 'unauthorized', message: 'invalid credentials' });
    }
    res.cookie(COOKIE_NAME, session.token, cookieOptions());
    return res.status(200).json({
      operator_id: session.operator_id,
      email: session.email,
      role: session.role,
      org_name: session.org_name,
    });
  } catch (err) {
    logger.error('dashboard sign-in failed', { error: err.message });
    return res.status(500).json({ error: 'internal error' });
  }
});

router.delete('/v1/dashboard/session', async (req, res) => {
  try {
    await closeSession(pool, readCookie(req, COOKIE_NAME));
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return res.status(200).json({ signed_out: true });
  } catch (err) {
    logger.error('dashboard sign-out failed', { error: err.message });
    return res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
