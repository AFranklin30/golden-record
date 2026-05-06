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

  await new Promise((resolve) => { server = app.listen(0, resolve); });
}

async function teardown() {
  server.close();
  await pool.end();
}

async function run() {
  console.log('\nPOST /v1/resolve — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  let r;

  // a) No Authorization header → orgAuthMiddleware blocks before handler
  r = await post('/v1/resolve', {
    body: { identifier_type: 'email', identifier_value: 'a@b.com', org_id: seedOrgId, schema_version: 'v1' }
  });
  assert('no auth header → 401', r.status === 401);

  // b) missing identifier_type → 400
  r = await post('/v1/resolve', {
    headers: { Authorization: VALID_AUTH },
    body: { identifier_value: 'a@b.com', org_id: seedOrgId, schema_version: 'v1' }
  });
  assert('missing identifier_type → 400',             r.status === 400);
  assert('missing identifier_type → error message',   r.body.error === 'identifier_type is required');

  // c) missing identifier_value → 400
  r = await post('/v1/resolve', {
    headers: { Authorization: VALID_AUTH },
    body: { identifier_type: 'email', org_id: seedOrgId, schema_version: 'v1' }
  });
  assert('missing identifier_value → 400',            r.status === 400);
  assert('missing identifier_value → error message',  r.body.error === 'identifier_value is required');

  // d) org_id not a UUID → 400
  r = await post('/v1/resolve', {
    headers: { Authorization: VALID_AUTH },
    body: { identifier_type: 'email', identifier_value: 'a@b.com', org_id: 'not-a-uuid', schema_version: 'v1' }
  });
  assert('invalid org_id UUID → 400',             r.status === 400);
  assert('invalid org_id UUID → error message',   r.body.error === 'org_id must be a valid UUID');

  // e) missing schema_version → 400
  r = await post('/v1/resolve', {
    headers: { Authorization: VALID_AUTH },
    body: { identifier_type: 'email', identifier_value: 'a@b.com', org_id: seedOrgId }
  });
  assert('missing schema_version → 400',           r.status === 400);
  assert('missing schema_version → error message', r.body.error === 'schema_version is required');

  // f) invalid email format → 400 normalization failure
  r = await post('/v1/resolve', {
    headers: { Authorization: VALID_AUTH },
    body: { identifier_type: 'email', identifier_value: 'not-an-email', org_id: seedOrgId, schema_version: 'v1' }
  });
  assert('bad email → 400',               r.status === 400);
  assert('bad email → normalization msg', r.body.error === 'identifier_value failed normalization');
  assert('bad email → detail present',    typeof r.body.detail === 'string' && r.body.detail.length > 0);

  // g) valid request, new fan → 200, is_new_record true
  const testEmail = `smoke-resolve-${Date.now()}@okc-thunder.test`;
  r = await post('/v1/resolve', {
    headers: { Authorization: VALID_AUTH },
    body: { identifier_type: 'email', identifier_value: testEmail, org_id: seedOrgId, schema_version: 'v1', source_system: 'smoke-test' }
  });
  assert('valid new fan → 200',                   r.status === 200);
  assert('valid new fan → fan_id UUID',           /^[0-9a-f-]{36}$/i.test(r.body.fan_id));
  assert('valid new fan → match_type "hard"',     r.body.match_type === 'hard');
  assert('valid new fan → confidence_score 1.0',  r.body.confidence_score === 1.0);
  assert('valid new fan → is_new_record true',    r.body.is_new_record === true);
  assert('valid new fan → audit_event_id UUID',   /^[0-9a-f-]{36}$/i.test(r.body.audit_event_id));
  assert('valid new fan → linked_systems array',  Array.isArray(r.body.linked_systems));

  const fanId = r.body.fan_id;

  // h) repeat same request → 200, idempotency early return — resolverEngine returns the
  //    stored audit_log row which has is_new_record: true (same value as original call)
  r = await post('/v1/resolve', {
    headers: { Authorization: VALID_AUTH },
    body: { identifier_type: 'email', identifier_value: testEmail, org_id: seedOrgId, schema_version: 'v1', source_system: 'smoke-test' }
  });
  assert('repeat request → 200',                        r.status === 200);
  assert('repeat request → same fan_id',                r.body.fan_id === fanId);
  assert('repeat request → is_new_record matches original', r.body.is_new_record === true);

  // i) X-Correlation-Id present on every protected response
  assert('X-Correlation-Id present on 200',       typeof r.headers['x-correlation-id'] === 'string'
                                                    && r.headers['x-correlation-id'].length === 36);

  // j) source_system omitted → defaults to "unknown", request still succeeds
  const testEmail2 = `smoke-resolve-nosrc-${Date.now()}@okc-thunder.test`;
  r = await post('/v1/resolve', {
    headers: { Authorization: VALID_AUTH },
    body: { identifier_type: 'email', identifier_value: testEmail2, org_id: seedOrgId, schema_version: 'v1' }
  });
  assert('no source_system → 200 (defaults to "unknown")', r.status === 200);

  await teardown();

  const total = passed + failed;
  console.log(`\n${total} checks: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Smoke test crashed:', err.message);
  process.exit(1);
});
