'use strict';

require('dotenv').config();

const http    = require('http');
const express = require('express');
const crypto  = require('crypto');
const pool    = require('../db/pool');
const orgAuthMiddleware = require('../middleware/orgAuthMiddleware');

// Ephemeral inactive org inserted for the 403 path, removed on teardown
const INACTIVE_RAW_KEY = 'smoke-test-inactive-org-key-do-not-use';
const INACTIVE_HASH    = crypto.createHash('sha256').update(INACTIVE_RAW_KEY).digest('hex');

let server;
let inactiveOrgId;
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

function hit(headers = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req  = http.request(
      { hostname: 'localhost', port, path: '/ping', method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
          catch { resolve({ status: res.statusCode, body }); }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function setup() {
  const result = await pool.query(
    `INSERT INTO org (name, is_active, org_api_key_hash)
     VALUES ('Smoke Test Inactive Org', false, $1)
     RETURNING id`,
    [INACTIVE_HASH]
  );
  inactiveOrgId = result.rows[0].id;

  const app = express();
  app.use(orgAuthMiddleware);
  app.get('/ping', (_req, res) => res.json({ ok: true }));

  await new Promise((resolve) => { server = app.listen(0, resolve); });
}

async function teardown() {
  if (inactiveOrgId) {
    await pool.query('DELETE FROM org WHERE id = $1', [inactiveOrgId]);
  }
  server.close();
  await pool.end();
}

async function run() {
  console.log('\norgAuthMiddleware — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  let r;

  // a) No Authorization header
  r = await hit();
  assert('no auth header → 401',              r.status === 401);
  assert('no auth header → correct message',  r.body.message === 'Authorization header is missing');

  // b) Wrong scheme
  r = await hit({ Authorization: 'Basic abc123' });
  assert('wrong scheme → 401',                r.status === 401);
  assert('wrong scheme → correct message',    r.body.message === 'must use Bearer scheme');

  // c) Empty token after "Bearer " — HTTP clients strip trailing whitespace, so
  //    'Bearer ' arrives as 'Bearer' and the scheme check fires (not the empty-token check).
  //    Both guards return 401; the scheme check is what's exercisable over HTTP.
  r = await hit({ Authorization: 'Bearer ' });
  assert('empty token → 401',                 r.status === 401);
  assert('empty token → 401 response',        r.body.error === 'unauthorized');

  // d) Key exceeds 512 chars
  r = await hit({ Authorization: 'Bearer ' + 'x'.repeat(513) });
  assert('key too long → 401',                r.status === 401);
  assert('key too long → correct message',    r.body.message === 'invalid credentials');

  // e) Valid format but key not in db
  r = await hit({ Authorization: 'Bearer not-a-real-key-abc123' });
  assert('unknown key → 401',                 r.status === 401);
  assert('unknown key → correct message',     r.body.message === 'invalid credentials');

  // f) Known key but org is inactive
  r = await hit({ Authorization: `Bearer ${INACTIVE_RAW_KEY}` });
  assert('inactive org → 403',                r.status === 403);
  assert('inactive org → correct message',    r.body.message === 'org account is inactive');

  // g) Valid key, active org (seed row)
  r = await hit({ Authorization: 'Bearer dev-api-key-local-2026' });
  assert('valid key → 200',                   r.status === 200);
  assert('valid key → ok body',               r.body.ok === true);

  await teardown();

  const total = passed + failed;
  console.log(`\n${total} checks: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Smoke test crashed:', err.message);
  process.exit(1);
});
