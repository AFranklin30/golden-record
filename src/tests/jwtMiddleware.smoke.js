'use strict';

const express       = require('express');
const http          = require('http');
const crypto        = require('crypto');
const jwtMiddleware = require('../middleware/jwtMiddleware');
const { signToken } = require('../modules/jwt');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function ping(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/ping', method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  const app = express();

  // Seed middleware — simulates orgAuthMiddleware + correlationIdMiddleware having run
  app.use((req, _res, next) => {
    req.context = {
      org_id:         crypto.randomUUID(),
      org_name:       'Test Org',
      correlation_id: crypto.randomUUID()
    };
    next();
  });

  app.use(jwtMiddleware);

  // Handler echoes fan_id and jti so we can assert they were set on req.context
  app.get('/ping', (req, res) => {
    res.status(200).json({ fan_id: req.context.fan_id, jti: req.context.jti });
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const TEST_FAN_ID = crypto.randomUUID();
  const TEST_ORG_ID = crypto.randomUUID();
  const { token } = signToken({ fan_id: TEST_FAN_ID, org_id: TEST_ORG_ID });

  try {
    console.log('\njwtMiddleware smoke tests\n');

    // a) No X-Fan-Token header → 401
    const resA = await ping(port, {});
    check('a) No X-Fan-Token header → 401', resA.status === 401);
    check('a) Response body has error field', resA.body.error === 'unauthorized');

    // b) X-Fan-Token present but empty → 401
    const resB = await ping(port, { 'x-fan-token': '' });
    check('b) Empty X-Fan-Token → 401', resB.status === 401);

    // c) Malformed token — internal reason must not be exposed
    const resC = await ping(port, { 'x-fan-token': 'not.a.real.jwt' });
    check('c) Malformed token → 401', resC.status === 401);
    check('c) Generic message only — internal reason not exposed', resC.body.message === 'invalid or expired token');

    // d) Valid signed token
    const resD = await ping(port, { 'x-fan-token': token });
    check('d) Valid token → 200 (next() called)', resD.status === 200);
    check('d) req.context.fan_id set to token sub claim', resD.body.fan_id === TEST_FAN_ID);
    check('d) req.context.jti set (valid UUID format)', UUID_RE.test(resD.body.jti));

  } finally {
    server.close();
  }

  console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Smoke test runner error:', err);
  process.exit(1);
});
