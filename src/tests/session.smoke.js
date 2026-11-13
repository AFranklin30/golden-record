'use strict';

require('dotenv').config();

const http      = require('http');
const express   = require('express');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const pool      = require('../db/pool');

const orgAuthMiddleware       = require('../middleware/orgAuthMiddleware');
const correlationIdMiddleware = require('../middleware/correlationIdMiddleware');
const resolveRouter           = require('../routes/resolve');
const sessionRouter           = require('../routes/session');
const { verifyToken }         = require('../modules/jwt');

const VALID_RAW_KEY = 'dev-api-key-local-2026';
const VALID_AUTH    = `Bearer ${VALID_RAW_KEY}`;

let server;
let seedOrgId;
let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function post(path, { headers = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const port    = server.address().port;
    const payload = JSON.stringify(body);
    const req     = http.request(
      {
        hostname: 'localhost',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try   { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function setup() {
  const hash   = crypto.createHash('sha256').update(VALID_RAW_KEY).digest('hex');
  const result = await pool.query('SELECT id FROM org WHERE org_api_key_hash = $1', [hash]);
  if (!result.rows[0]) throw new Error('Seeded org not found — run migration_001.sql first');
  seedOrgId = result.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use(rateLimit({ windowMs: 60000, max: 100, standardHeaders: true, legacyHeaders: false }));
  app.use(orgAuthMiddleware);
  app.use(correlationIdMiddleware);
  app.use(resolveRouter);
  app.use(sessionRouter);

  await new Promise((resolve) => { server = app.listen(0, resolve); });
}

async function teardown() {
  server.close();
  await pool.end();
}

async function run() {
  console.log('\nPOST /v1/session — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  // Create a real fan via resolve so we have a valid fan_id for later scenarios
  const uniqueEmail = `smoke-session-${crypto.randomBytes(4).toString('hex')}@test.com`;
  const resolveRes = await post('/v1/resolve', {
    headers: { Authorization: VALID_AUTH },
    body: {
      identifier_type:  'email',
      identifier_value: uniqueEmail,
      org_id:           seedOrgId,
      schema_version:   'v1'
    }
  });
  if (resolveRes.status !== 200) {
    console.error('Fan creation via /v1/resolve failed — cannot continue:', resolveRes.body);
    process.exit(1);
  }
  const resolvedFanId = resolveRes.body.fan_id;

  const validBody = {
    fan_id:         resolvedFanId,
    org_id:         seedOrgId,
    schema_version: 'v1'
  };

  let r;

  // a) No Authorization header → orgAuthMiddleware blocks
  r = await post('/v1/session', { body: validBody });
  assert('a) no auth header → 401', r.status === 401);

  // b) Valid auth, fan_id missing → 400
  r = await post('/v1/session', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, fan_id: undefined }
  });
  assert('b) missing fan_id → 400',            r.status === 400);
  assert('b) missing fan_id → error message',  r.body.error === 'fan_id is required');

  // c) Valid auth, fan_id not UUID → 400
  r = await post('/v1/session', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, fan_id: 'not-a-uuid' }
  });
  assert('c) fan_id not UUID → 400',            r.status === 400);
  assert('c) fan_id not UUID → error message',  r.body.error === 'fan_id must be a valid UUID');

  // d) Valid auth, org_id missing → 400
  r = await post('/v1/session', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, org_id: undefined }
  });
  assert('d) missing org_id → 400',            r.status === 400);
  assert('d) missing org_id → error message',  r.body.error === 'org_id must be a valid UUID');

  // e) Valid auth, org_id not UUID → 400
  r = await post('/v1/session', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, org_id: 'not-a-uuid' }
  });
  assert('e) org_id not UUID → 400',            r.status === 400);
  assert('e) org_id not UUID → error message',  r.body.error === 'org_id must be a valid UUID');

  // f) Valid auth, schema_version missing → 400
  r = await post('/v1/session', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, schema_version: undefined }
  });
  assert('f) missing schema_version → 400',            r.status === 400);
  assert('f) missing schema_version → error message',  r.body.error === 'schema_version is required');

  // g) Valid auth, fan_id is a valid UUID but has no db row → 404
  r = await post('/v1/session', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, fan_id: crypto.randomUUID() }
  });
  assert('g) unknown fan_id → 404',            r.status === 404);
  assert('g) unknown fan_id → error message',  r.body.error === 'fan record not found — resolve identifier first');

  // h) Valid auth, existing fan → 200 with token, expires_at, token_type, fan_id
  r = await post('/v1/session', {
    headers: { Authorization: VALID_AUTH },
    body: validBody
  });
  assert('h) valid fan → 200',                     r.status === 200);
  assert('h) valid fan → token present',            typeof r.body.token === 'string' && r.body.token.length > 0);
  assert('h) valid fan → fan_id matches',           r.body.fan_id === resolvedFanId);
  assert('h) valid fan → expires_at ISO8601',       /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(r.body.expires_at));
  assert('h) valid fan → token_type Bearer',        r.body.token_type === 'Bearer');
  assert('h) valid fan → no internal error detail', r.body.error === undefined);

  // i) Returned token is a valid RS256 JWT with correct claims
  let decoded;
  try {
    decoded = verifyToken(`Bearer ${r.body.token}`);
  } catch (err) {
    decoded = null;
  }
  assert('i) token verifies as valid RS256 JWT',   decoded !== null);
  assert('i) token sub claim matches fan_id',      decoded && decoded.fan_id === resolvedFanId);
  assert('i) token org claim matches org_id',      decoded && decoded.org_id === seedOrgId);
  assert('i) token jti is a UUID',                 decoded && /^[0-9a-f-]{36}$/i.test(decoded.jti));

  // j) audit_log row written for session_issued with correct jti
  if (decoded) {
    const auditResult = await pool.query(
      `SELECT id FROM audit_log
       WHERE fan_id = $1 AND org_id = $2 AND event_type = 'session_issued' AND jti = $3`,
      [resolvedFanId, seedOrgId, decoded.jti]
    );
    assert('j) audit_log session_issued row written', auditResult.rows.length === 1);
  } else {
    assert('j) audit_log session_issued row written (skipped — token invalid)', false);
  }

  // k) X-Correlation-Id header present on every protected response (check last 200)
  assert('k) X-Correlation-Id present on 200', typeof r.headers['x-correlation-id'] === 'string'
                                                 && r.headers['x-correlation-id'].length === 36);

  await teardown();

  const total = passed + failed;
  console.log(`\n${total} checks: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Smoke test crashed:', err.message);
  process.exit(1);
});
