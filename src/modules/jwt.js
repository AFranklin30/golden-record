'use strict';

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
require('dotenv').config();

class JWTError extends Error {
  constructor(message, code = 401) {
    super(message);
    this.name = 'JWTError';
    this.code = code;
  }
}

class StartupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StartupError';
  }
}

// MODULE INIT — throws at startup if keys are absent; prevents Cloud Run start
const PRIVATE_KEY = (process.env.JWT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const PUBLIC_KEY  = (process.env.JWT_PUBLIC_KEY  || '').replace(/\\n/g, '\n');
if (!PRIVATE_KEY || !PUBLIC_KEY) {
  throw new StartupError('JWT keys not found — service cannot start');
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const logger = { warn: console.warn };

// RECEIVE
function signToken(payload) {
  const fan_id = payload.fan_id;
  const org_id = payload.org_id;

  // GUARD
  if (!fan_id || !UUID_REGEX.test(fan_id)) throw new JWTError('fan_id required and must be UUID');
  if (!org_id || !UUID_REGEX.test(org_id)) throw new JWTError('org_id required and must be UUID');
  if (!PRIVATE_KEY) throw new JWTError('private key not loaded');

  // EXECUTE
  const issuedAt  = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 15 * 60;
  const claims = {
    iss: 'golden-record',
    aud: 'golden-record',
    sub: fan_id,
    org: org_id,
    iat: issuedAt,
    exp: expiresAt,
    jti: crypto.randomUUID()
  };
  const token = jwt.sign(claims, PRIVATE_KEY, { algorithm: 'RS256' });

  // RETURN
  return { token, expires_at: new Date(expiresAt * 1000).toISOString(), jti: claims.jti };
}

// RECEIVE
function verifyToken(authHeader) {
  const raw = authHeader;

  // GUARD — header shape
  if (!raw || raw.trim() === '') throw new JWTError('Authorization header is missing', 401);
  if (!raw.startsWith('Bearer '))  throw new JWTError('must use Bearer scheme', 401);
  const token = raw.slice('Bearer '.length).trim();
  if (token === '')                throw new JWTError('Bearer token is empty', 401);

  // EXECUTE
  let decoded;
  try {
    decoded = jwt.verify(token, PUBLIC_KEY, { algorithms: ['RS256'], clockTolerance: 30, issuer: 'golden-record', audience: 'golden-record' });
  } catch (err) {
    if (err.name === 'TokenExpiredError')                                      throw new JWTError('token has expired', 401);
    if (err.name === 'JsonWebTokenError' && err.message === 'invalid signature') throw new JWTError('token signature invalid', 401);
    if (err.name === 'JsonWebTokenError' && err.message === 'invalid algorithm') throw new JWTError('algorithm not permitted', 401);
    throw new JWTError('token is malformed', 401);
  }

  // GUARD — claims shape after decode
  if (!decoded.sub) throw new JWTError('token missing fan_id claim', 401);
  if (!decoded.org) throw new JWTError('token missing org_id claim', 401);

  // RETURN
  return {
    fan_id: decoded.sub,
    org_id: decoded.org,
    iat:    decoded.iat,
    exp:    decoded.exp,
    jti:    decoded.jti
  };
}

function jwtMiddleware(req, res, next) {
  const fanToken   = req.headers['x-fan-token'];
  const authHeader = fanToken !== undefined ? `Bearer ${fanToken}` : undefined;

  // TRY wraps EXECUTE only (Pattern 1 — GUARD has no db calls)
  try {
    const claims = verifyToken(authHeader);
    if (claims.org_id !== req.context.org_id) {
      throw new JWTError('org claim does not match authenticated org', 403);
    }
    req.context.fan_id = claims.fan_id;
    req.context.jti    = claims.jti;
    next();
  } catch (err) {
    if (err instanceof JWTError) {
      logger.warn('JWT verification failed', { reason: err.message, ip: req.ip, correlation_id: req.context?.correlation_id });
      const status = err.code || 401;
      const error  = status === 403 ? 'forbidden' : 'unauthorized';
      return res.status(status).json({ error, message: 'invalid or expired token' });
    }
    throw err;
  }
}

module.exports = { signToken, verifyToken, jwtMiddleware, JWTError, StartupError };
