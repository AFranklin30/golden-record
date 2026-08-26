'use strict';
// tests/validation.resolveIdentifiers.smoke.js
//
// Standalone smoke test — hits the REAL local database.
// Run manually:  node tests/validation.resolveIdentifiers.smoke.js
//
// NOT a Jest test. Do not run via npm test.
//
// Validates the Zone-1 identifiers-object guard added to POST /v1/resolve.
// STRICT REJECT design: a malformed identifiers field → 400, symmetric with
// the singular identifier_value path.
//
// Normalization deferral: identifiers field values are type-checked but not
// normalized. Multi-signal matches through the identifiers object compare raw
// values against normalized candidates, reducing match accuracy. Fix path:
// per-field normalization in the resolve Zone-1 guard, which reopens the
// strict-vs-lenient decision per field. Deferred post-June 29.

require('dotenv').config();

// ── Safety guard ──────────────────────────────────────────────────────────────
(function guardLocalOnly() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error('BLOCKED: DATABASE_URL is not set. Add it to .env and point it at localhost:5432.');
    process.exit(1);
  }
  let parsed;
  try { parsed = new URL(raw); } catch {
    console.error('BLOCKED: DATABASE_URL could not be parsed. Check .env.');
    process.exit(1);
  }
  const host    = parsed.hostname;
  const port    = parsed.port || '5432';
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocal || port === '5433') {
    console.error('BLOCKED: DATABASE_URL does not point to local Postgres on port 5432.');
    console.error(`  host: ${host}  port: ${port}`);
    process.exit(1);
  }
}());
// ─────────────────────────────────────────────────────────────────────────────

const http    = require('http');
const express = require('express');
const crypto  = require('crypto');
const pool    = require('../src/db/pool');

const orgAuthMiddleware       = require('../src/middleware/orgAuthMiddleware');
const rlsContextMiddleware    = require('../src/middleware/rlsContextMiddleware');
const correlationIdMiddleware = require('../src/middleware/correlationIdMiddleware');
const resolveRouter           = require('../src/routes/resolve');

const ORG_KEY = 'test-key-validation-resolve-identifiers';
const orgHash = crypto.createHash('sha256').update(ORG_KEY).digest('hex');

let server;
let testOrgId;
let countClient;
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL  ${message}`);
    failed++;
  } else {
    console.log(`  PASS  ${message}`);
    passed++;
  }
}

function post(body) {
  return new Promise((resolve, reject) => {
    const port    = server.address().port;
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path:     '/v1/resolve',
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization':  `Bearer ${ORG_KEY}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function countRows() {
  const fan      = await countClient.query(
    'SELECT COUNT(*) AS n FROM fan                    WHERE org_id = $1', [testOrgId]
  );
  const link     = await countClient.query(
    'SELECT COUNT(*) AS n FROM identifier_link        WHERE org_id = $1', [testOrgId]
  );
  const conflict = await countClient.query(
    'SELECT COUNT(*) AS n FROM conflict_queue         WHERE org_id = $1', [testOrgId]
  );
  const staging  = await countClient.query(
    'SELECT COUNT(*) AS n FROM staging_household_data WHERE org_id = $1', [testOrgId]
  );
  return {
    fan:      parseInt(fan.rows[0].n,      10),
    link:     parseInt(link.rows[0].n,     10),
    conflict: parseInt(conflict.rows[0].n, 10),
    staging:  parseInt(staging.rows[0].n,  10),
  };
}

function rowDelta(before, after) {
  return {
    fan:      after.fan      - before.fan,
    link:     after.link     - before.link,
    conflict: after.conflict - before.conflict,
    staging:  after.staging  - before.staging,
    get total() { return this.fan + this.link + this.conflict + this.staging; },
  };
}

async function run() {
  console.log('\nvalidation.resolveIdentifiers — Zone-1 identifiers guard\n');
  console.log('══════════════════════════════════════════════════════════════\n');

  // ── SETUP ─────────────────────────────────────────────────────────────────
  testOrgId = crypto.randomUUID();

  const app = express();
  app.use(express.json());
  app.use(orgAuthMiddleware);
  app.use(rlsContextMiddleware);
  app.use(correlationIdMiddleware);
  app.use(resolveRouter);
  await new Promise((res) => { server = app.listen(0, res); });

  const orgResult = await pool.query(
    `INSERT INTO org (id, name, org_api_key_hash)
     VALUES ($1, '_validation_resolve_identifiers', $2)
     ON CONFLICT (org_api_key_hash) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [testOrgId, orgHash]
  );
  testOrgId = orgResult.rows[0].id;

  countClient = await pool.connect();
  await countClient.query(
    `SELECT set_config('app.current_org_id', $1, false)`,
    [testOrgId]
  );

  try {

    // ── REJECTION CASES ─────────────────────────────────────────────────────
    console.log('REJECTION CASES — each must return 400 with zero row writes');
    console.log('──────────────────────────────────────────────────────────────');

    // Case 1 — identifiers = "notanobject"
    {
      console.log('\nCase 1: identifiers = "notanobject"');
      const before = await countRows();
      const resp   = await post({
        identifier_type: 'nba_id', identifier_value: crypto.randomUUID(),
        schema_version: 'v1', identifiers: 'notanobject',
      });
      const after  = await countRows();
      const d      = rowDelta(before, after);
      assert(resp.status === 400,                                         'Case 1: status === 400');
      assert(resp.body.error === 'identifiers must be an object',         'Case 1: error === "identifiers must be an object"');
      assert(d.total === 0,                                               'Case 1: row-delta === 0');
    }

    // Case 2 — identifiers = ["x"]
    {
      console.log('\nCase 2: identifiers = ["x"]');
      const before = await countRows();
      const resp   = await post({
        identifier_type: 'nba_id', identifier_value: crypto.randomUUID(),
        schema_version: 'v1', identifiers: ['x'],
      });
      const after  = await countRows();
      const d      = rowDelta(before, after);
      assert(resp.status === 400,                                         'Case 2: status === 400');
      assert(resp.body.error === 'identifiers must be an object',         'Case 2: error === "identifiers must be an object"');
      assert(d.total === 0,                                               'Case 2: row-delta === 0');
    }

    // Case 3 — identifiers = 42
    {
      console.log('\nCase 3: identifiers = 42');
      const before = await countRows();
      const resp   = await post({
        identifier_type: 'nba_id', identifier_value: crypto.randomUUID(),
        schema_version: 'v1', identifiers: 42,
      });
      const after  = await countRows();
      const d      = rowDelta(before, after);
      assert(resp.status === 400,                                         'Case 3: status === 400');
      assert(resp.body.error === 'identifiers must be an object',         'Case 3: error === "identifiers must be an object"');
      assert(d.total === 0,                                               'Case 3: row-delta === 0');
    }

    // Case 4 — identifiers = { email: 42 }
    {
      console.log('\nCase 4: identifiers = { email: 42 }');
      const before = await countRows();
      const resp   = await post({
        identifier_type: 'nba_id', identifier_value: crypto.randomUUID(),
        schema_version: 'v1', identifiers: { email: 42 },
      });
      const after  = await countRows();
      const d      = rowDelta(before, after);
      assert(resp.status === 400,                                         'Case 4: status === 400');
      assert(resp.body.error === 'identifiers field must be a string',    'Case 4: error === "identifiers field must be a string"');
      assert(resp.body.message === 'identifiers.email must be a string when provided',
                                                                          'Case 4: message names the field');
      assert(d.total === 0,                                               'Case 4: row-delta === 0');
    }

    // Case 5 — identifiers = { name: { x: 1 } }
    {
      console.log('\nCase 5: identifiers = { name: { x: 1 } }');
      const before = await countRows();
      const resp   = await post({
        identifier_type: 'nba_id', identifier_value: crypto.randomUUID(),
        schema_version: 'v1', identifiers: { name: { x: 1 } },
      });
      const after  = await countRows();
      const d      = rowDelta(before, after);
      assert(resp.status === 400,                                         'Case 5: status === 400');
      assert(resp.body.error === 'identifiers field must be a string',    'Case 5: error === "identifiers field must be a string"');
      assert(resp.body.message === 'identifiers.name must be a string when provided',
                                                                          'Case 5: message names the field');
      assert(d.total === 0,                                               'Case 5: row-delta === 0');
    }

    // Case 6 — identifiers = { guardian_email: ["a"] }
    {
      console.log('\nCase 6: identifiers = { guardian_email: ["a"] }');
      const before = await countRows();
      const resp   = await post({
        identifier_type: 'nba_id', identifier_value: crypto.randomUUID(),
        schema_version: 'v1', identifiers: { guardian_email: ['a'] },
      });
      const after  = await countRows();
      const d      = rowDelta(before, after);
      assert(resp.status === 400,                                         'Case 6: status === 400');
      assert(resp.body.error === 'identifiers field must be a string',    'Case 6: error === "identifiers field must be a string"');
      assert(resp.body.message === 'identifiers.guardian_email must be a string when provided',
                                                                          'Case 6: message names the field');
      assert(d.total === 0,                                               'Case 6: row-delta === 0');
    }

    // ── ACCEPTANCE / REGRESSION CASES ───────────────────────────────────────
    console.log('\nACCEPTANCE / REGRESSION CASES — guard must not over-reject');
    console.log('──────────────────────────────────────────────────────────────');

    // Case 7 — identifiers omitted (singular path only)
    {
      console.log('\nCase 7: identifiers omitted entirely');
      const resp = await post({
        identifier_type: 'nba_id', identifier_value: crypto.randomUUID(),
        schema_version: 'v1',
      });
      assert(resp.status === 200, 'Case 7: status === 200 (null identifiers still valid)');
    }

    // Case 8 — identifiers = { email: "real@example.com", name: "jane doe" } (all strings)
    {
      console.log('\nCase 8: identifiers = { email: "real@example.com", name: "jane doe" }');
      const resp = await post({
        identifier_type: 'nba_id', identifier_value: crypto.randomUUID(),
        schema_version: 'v1',
        identifiers: { email: 'real@example.com', name: 'jane doe' },
      });
      assert(resp.status === 200, 'Case 8: status === 200 (all-string identifiers valid)');
    }

    // Case 9 — identifiers = { email: null, name: "jane doe" } (null field treated as absent)
    {
      console.log('\nCase 9: identifiers = { email: null, name: "jane doe" }');
      const resp = await post({
        identifier_type: 'nba_id', identifier_value: crypto.randomUUID(),
        schema_version: 'v1',
        identifiers: { email: null, name: 'jane doe' },
      });
      assert(resp.status === 200, 'Case 9: status === 200 (null field treated as absent, not rejected)');
    }

  } finally {

    countClient.release();
    if (server) server.close();

    console.log('\nCleaning up test data...');
    const c = await pool.connect();
    try {
      await c.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);
      await c.query(`DELETE FROM staging_household_data WHERE org_id = $1`, [testOrgId]);
      // audit_log: append-only trigger blocks DELETE; swallow the error.
      // audit_log_fan_id_fkey then blocks fan deletion — fan/org rows from acceptance
      // cases (7-9) accumulate across runs. ON CONFLICT on org_api_key_hash makes
      // re-runs idempotent; stale fans carry nba_id only and don't affect scoring.
      try { await c.query(`DELETE FROM audit_log WHERE org_id = $1`, [testOrgId]); } catch { /* append-only — expected */ }
      await c.query(`DELETE FROM conflict_queue  WHERE org_id = $1`, [testOrgId]);
      await c.query(`DELETE FROM identifier_link WHERE org_id = $1`, [testOrgId]);
      try { await c.query(`DELETE FROM fan WHERE org_id = $1`, [testOrgId]); } catch { /* blocked by audit_log FK — expected */ }
      try { await c.query(`DELETE FROM org WHERE id     = $1`, [testOrgId]); } catch { /* blocked by fan FK if fan rows remain */ }
      console.log('Cleanup complete.\n');
    } catch (cleanupErr) {
      console.error('Cleanup error — rows may remain:', cleanupErr.message);
    } finally {
      c.release();
    }
  }

  const total = passed + failed;
  console.log(`${total} checks: ${passed} passed, ${failed} failed\n`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test crashed:', err.message);
  console.error(err.stack);
  pool.end();
  process.exit(1);
});
