'use strict';

const express              = require('express');
const http                 = require('http');
const correlationIdMiddleware = require('../middleware/correlationIdMiddleware');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${path}`, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({
          status:  res.statusCode,
          headers: res.headers,
          body:    JSON.parse(body)
        });
      });
    }).on('error', reject);
  });
}

async function run() {
  const app = express();

  // Seed middleware — simulates orgAuthMiddleware having run
  app.use((req, _res, next) => {
    req.context = { org_id: 'test-org', org_name: 'Test Org' };
    next();
  });

  app.use(correlationIdMiddleware);

  // Handler echoes correlation_id from context so we can verify it was set
  app.get('/ping', (req, res) => {
    res.status(200).json({ ok: true, correlation_id_from_context: req.context.correlation_id });
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    console.log('\ncorrelationIdMiddleware smoke tests\n');

    const res = await get(port, '/ping');

    // 1. Status 200 — next() was called
    check('Happy path: 200 returned (next() was called)', res.status === 200);

    // 2. X-Correlation-Id header present
    const headerVal = res.headers['x-correlation-id'];
    check('X-Correlation-Id header present', Boolean(headerVal));

    // 3. Header value is valid UUID format
    check('Header value is valid UUID format', UUID_RE.test(headerVal));

    // 4. req.context.correlation_id set and matches header
    const contextVal = res.body.correlation_id_from_context;
    check('req.context.correlation_id set on request object', Boolean(contextVal));
    check('req.context.correlation_id matches X-Correlation-Id header', contextVal === headerVal);

    // 5. Each request gets a distinct UUID
    const res2 = await get(port, '/ping');
    const headerVal2 = res2.headers['x-correlation-id'];
    check('Each request receives a distinct UUID', headerVal !== headerVal2);

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
