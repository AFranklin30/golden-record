'use strict';

require('dotenv').config();

const http      = require('http');
const express   = require('express');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const pool      = require('../db/pool');

const orgAuthMiddleware       = require('../middleware/orgAuthMiddleware');
const correlationIdMiddleware = require('../middleware/correlationIdMiddleware');
const nfcRouter               = require('../routes/nfc');

const VALID_RAW_KEY = 'dev-api-key-local-2026';
const VALID_AUTH    = `Bearer ${VALID_RAW_KEY}`;

// Valid 4-byte NFC UID (8 hex chars) — normalizes to AA:BB:CC:DD
const VALID_NFC_UID = 'AABBCCDD';

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
  app.use(nfcRouter);

  await new Promise((resolve) => { server = app.listen(0, resolve); });
}

async function teardown() {
  server.close();
  await pool.end();
}

async function run() {
  console.log('\nPOST /v1/ingest/nfc — smoke test\n');

  try {
    await setup();
  } catch (err) {
    console.error('Setup failed:', err.message);
    process.exit(1);
  }

  const validBody = {
    nfc_uid:        VALID_NFC_UID,
    org_id:         seedOrgId,
    station_id:     'gate-a-1',
    schema_version: 'v1'
  };

  let r;

  // a) No Authorization header → orgAuthMiddleware blocks
  r = await post('/v1/ingest/nfc', { body: validBody });
  assert('a) no auth header → 401', r.status === 401);

  // b) Valid auth, missing nfc_uid → 400
  r = await post('/v1/ingest/nfc', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, nfc_uid: undefined }
  });
  assert('b) missing nfc_uid → 400',              r.status === 400);
  assert('b) missing nfc_uid → error message',    r.body.error === 'nfc_uid is required');

  // c) Valid auth, missing org_id → 400
  r = await post('/v1/ingest/nfc', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, org_id: undefined }
  });
  assert('c) missing org_id → 400',               r.status === 400);
  assert('c) missing org_id → error message',     r.body.error === 'org_id must be a valid UUID');

  // d) Valid auth, org_id not UUID → 400
  r = await post('/v1/ingest/nfc', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, org_id: 'not-a-uuid' }
  });
  assert('d) invalid org_id → 400',               r.status === 400);
  assert('d) invalid org_id → error message',     r.body.error === 'org_id must be a valid UUID');

  // e) Valid auth, missing station_id → 400
  r = await post('/v1/ingest/nfc', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, station_id: undefined }
  });
  assert('e) missing station_id → 400',           r.status === 400);
  assert('e) missing station_id → error message', r.body.error === 'station_id is required');

  // f) Valid auth, station_id 129 chars → 400
  r = await post('/v1/ingest/nfc', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, station_id: 'x'.repeat(129) }
  });
  assert('f) station_id > 128 → 400',             r.status === 400);
  assert('f) station_id > 128 → error message',   r.body.error === 'station_id exceeds max length');

  // g) Valid auth, missing schema_version → 400
  r = await post('/v1/ingest/nfc', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, schema_version: undefined }
  });
  assert('g) missing schema_version → 400',           r.status === 400);
  assert('g) missing schema_version → error message', r.body.error === 'schema_version is required');

  // h) Non-hex nfc_uid → 400 normalization error + DLQ write
  r = await post('/v1/ingest/nfc', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, nfc_uid: 'GGHHIIJJ' }
  });
  assert('h) non-hex nfc_uid → 400',              r.status === 400);
  assert('h) non-hex nfc_uid → normalization msg',r.body.error === 'nfc_uid failed normalization');
  assert('h) non-hex nfc_uid → detail present',   typeof r.body.detail === 'string' && r.body.detail.length > 0);
  // Verify DLQ row was written
  const dlqResult = await pool.query(
    `SELECT id FROM ingest_failures
     WHERE org_id = $1 AND reason_code = 'normalization_error' AND source_system = 'nfc'
     ORDER BY created_at DESC LIMIT 1`,
    [seedOrgId]
  );
  assert('h) normalization_error DLQ row written', dlqResult.rows.length === 1);

  // i) Valid request, new fan → 200, session_ready: true
  const uniqueUid = crypto.randomBytes(4).toString('hex').toUpperCase();
  r = await post('/v1/ingest/nfc', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, nfc_uid: uniqueUid }
  });
  assert('i) valid tap → 200',                    r.status === 200);
  assert('i) valid tap → fan_id UUID',            /^[0-9a-f-]{36}$/i.test(r.body.fan_id));
  assert('i) valid tap → match_type "hard"',      r.body.match_type === 'hard');
  assert('i) valid tap → confidence_score 1.0',   r.body.confidence_score === 1.0);
  assert('i) valid tap → is_new_record true',     r.body.is_new_record === true);
  assert('i) valid tap → audit_event_id UUID',    /^[0-9a-f-]{36}$/i.test(r.body.audit_event_id));
  assert('i) valid tap → session_ready true',     r.body.session_ready === true);
  assert('i) valid tap → no linked_systems',      r.body.linked_systems === undefined);

  const fanId        = r.body.fan_id;
  const auditEventId = r.body.audit_event_id;

  // j) Repeat same request → 200, idempotency hit, same fan_id + audit_event_id
  r = await post('/v1/ingest/nfc', {
    headers: { Authorization: VALID_AUTH },
    body: { ...validBody, nfc_uid: uniqueUid, tapped_at: new Date().toISOString() }
  });
  assert('j) repeat tap → 200',                         r.status === 200);
  assert('j) repeat tap → same fan_id',                 r.body.fan_id === fanId);
  assert('j) repeat tap → same audit_event_id',         r.body.audit_event_id === auditEventId);
  assert('j) repeat tap → session_ready true',          r.body.session_ready === true);

  // k) X-Correlation-Id header on every protected response (check last 200)
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
