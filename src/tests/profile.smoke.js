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
const profileRouter           = require('../routes/profile');
const { signToken }           = require('../modules/jwt');

const VALID_RAW_KEY = 'dev-api-key-thunder-2026';
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

function get(path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req  = http.request(
      { hostname: 'localhost', port, path, method: 'GET', headers },
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
  app.use(profileRouter);

  await new Promise((resolve) => { server = app.listen(0, resolve); });
}

async function teardown() {
  server.close();
  await pool.end();
}

async function run() {
  console.log('\nGET /v1/fan/:id/profile — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  // Create a real fan + mint a JWT for happy-path scenarios
  const uniqueEmail = `smoke-profile-${crypto.randomBytes(4).toString('hex')}@test.com`;
  const resolveRes  = await post('/v1/resolve', {
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
  const fanId = resolveRes.body.fan_id;

  const sessionRes = await post('/v1/session', {
    headers: { Authorization: VALID_AUTH },
    body: { fan_id: fanId, org_id: seedOrgId, schema_version: 'v1' }
  });
  if (sessionRes.status !== 200) {
    console.error('Session issuance failed — cannot continue:', sessionRes.body);
    process.exit(1);
  }
  const fanJwt = sessionRes.body.token;

  // Mint a JWT for a fan that does not exist in the database (signToken has no db check)
  const ghostFanId  = crypto.randomUUID();
  const ghostResult = signToken({ fan_id: ghostFanId, org_id: seedOrgId });
  const ghostJwt    = ghostResult.token;

  let r;

  // Headers for dual-authenticated requests:
  //   Authorization: Bearer <org-key>   → orgAuthMiddleware
  //   X-Fan-Token:   <raw-jwt>          → jwtMiddleware (no Bearer prefix on custom header)
  const authHeaders = (jwt) => ({
    Authorization: VALID_AUTH,
    'x-fan-token': jwt
  });

  // a) No Authorization header → orgAuthMiddleware blocks → 401
  r = await get(`/v1/fan/${fanId}/profile`);
  assert('a) no auth header → 401', r.status === 401);

  // b) Valid org key, no X-Fan-Token → jwtMiddleware blocks → 401
  r = await get(`/v1/fan/${fanId}/profile`, { headers: { Authorization: VALID_AUTH } });
  assert('b) org key only, no X-Fan-Token → 401',          r.status === 401);
  assert('b) message = invalid or expired token',           r.body.message === 'invalid or expired token');

  // c) Both headers valid, url fan_id not a UUID → 400 (guard fires before db)
  r = await get('/v1/fan/not-a-uuid/profile', { headers: authHeaders(fanJwt) });
  assert('c) url fan_id not UUID → 400',                   r.status === 400);
  assert('c) error = fan_id must be a valid UUID',          r.body.error === 'fan_id must be a valid UUID');

  // d) Both headers valid, url fan_id is a different UUID than JWT claim → 403 guard
  const differentUUID = crypto.randomUUID();
  r = await get(`/v1/fan/${differentUUID}/profile`, { headers: authHeaders(fanJwt) });
  assert('d) url_fan_id != jwt_fan_id → 403',              r.status === 403);
  assert('d) message = token does not match requested profile',
         r.body.message === 'token does not match requested profile');

  // e) JWT minted for non-existent fan, url matches JWT claim → 404
  r = await get(`/v1/fan/${ghostFanId}/profile`, { headers: authHeaders(ghostJwt) });
  assert('e) fan not in db → 404',                         r.status === 404);
  assert('e) error = fan record not found',                 r.body.error === 'fan record not found');

  // f) Valid JWT, existing fan, url matches JWT claim → 200
  r = await get(`/v1/fan/${fanId}/profile`, { headers: authHeaders(fanJwt) });
  assert('f) happy path → 200',                            r.status === 200);

  // g) 200 response shape — all required fields present
  const b = r.body;
  assert('g) fan_id correct',                              b.fan_id         === fanId);
  assert('g) org_id correct',                              b.org_id         === seedOrgId);
  assert('g) stewardship_tier present',                    typeof b.stewardship_tier === 'string');
  assert('g) record_version present',                      b.record_version !== undefined);
  assert('g) linked_systems is array',                     Array.isArray(b.linked_systems));
  assert('g) linked_systems has at least 1 entry',         b.linked_systems.length >= 1);
  assert('g) linked_systems entry has type field',         b.linked_systems[0].type       !== undefined);
  assert('g) linked_systems entry has source field',       b.linked_systems[0].source     !== undefined);
  assert('g) linked_systems entry has confidence field',   b.linked_systems[0].confidence !== undefined);
  assert('g) wallet present',                              b.wallet       !== undefined);
  assert('g) record_created_at present',                   b.record_created_at !== undefined);
  assert('g) record_updated_at present',                   b.record_updated_at !== undefined);

  // h) Firestore unavailable locally → wallet is empty default, not 500
  assert('h) wallet.loyalty_points is a number',           typeof b.wallet.loyalty_points === 'number');
  assert('h) wallet.stamps is an array',                   Array.isArray(b.wallet.stamps));
  assert('h) wallet.avatar present in response',           'avatar' in b.wallet);

  // i) X-Correlation-Id present when correlationIdMiddleware runs (i.e., after orgAuth passes)
  // Requests blocked by orgAuthMiddleware do NOT get X-Correlation-Id — correlationId runs after orgAuth.
  const noJwtRes = await get(`/v1/fan/${fanId}/profile`, { headers: { Authorization: VALID_AUTH } });
  assert('i) X-Correlation-Id on 401 (org passed, no X-Fan-Token)', !!noJwtRes.headers['x-correlation-id']);
  assert('i) X-Correlation-Id on 200',                              !!r.headers['x-correlation-id']);

  console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed\n`);

  await teardown();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
