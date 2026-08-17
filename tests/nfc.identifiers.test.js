'use strict';

// =============================================================================
// nfc.identifiers.test.js
// POST /v1/ingest/nfc — identifiers-object guard (blocking prompt 1 of 5)
//
// Connects to: LOCAL Postgres only (localhost:5432 via DATABASE_URL).
// Never run against port 5433 (Cloud SQL proxy).
//
// Real Express app (orgAuthMiddleware -> rlsContextMiddleware ->
// correlationIdMiddleware -> nfc router) driven via supertest — nothing here
// mocks normalizer or resolverEngine. That's the point: the guard must be
// proven against the real normalizer, the real resolverEngine, and a real
// resolution_trace row, mirroring tests/validation.resolveIdentifiers.smoke.js
// and tests/migration_014.test.js conventions for real-DB Jest tests (which
// live at tests/ root — tests/routes/*.test.js is mocked-only).
//
// Cleanup note: resolution_trace and audit_log are both append-only (DELETE
// throws) — swallowed and left inert, same pattern as migration_014.test.js.
// The org row is therefore permanently pinned too; a fresh UUID per run makes
// that inert.
// =============================================================================

require('dotenv').config();

const crypto  = require('crypto');
const express = require('express');
const request = require('supertest');
const { Client } = require('pg');

const orgAuthMiddleware       = require('../src/middleware/orgAuthMiddleware');
const rlsContextMiddleware    = require('../src/middleware/rlsContextMiddleware');
const correlationIdMiddleware = require('../src/middleware/correlationIdMiddleware');
const nfcRouter                = require('../src/routes/nfc');
const resolveRouter             = require('../src/routes/resolve');

function orgKeyHash(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function freshNfcUid() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function buildApp(router) {
  const app = express();
  app.use(express.json());
  app.use(orgAuthMiddleware);
  app.use(rlsContextMiddleware);
  app.use(correlationIdMiddleware);
  app.use(router);
  return app;
}

describe('POST /v1/ingest/nfc — identifiers-object guard', () => {
  let client;
  let testOrgId;
  let rawKey;
  let nfcApp;
  let resolveApp;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    testOrgId = crypto.randomUUID();
    rawKey    = `test-key-nfc-identifiers-${testOrgId}`;

    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash) VALUES ($1, $2, $3)`,
      [testOrgId, '_nfc_identifiers_test_org', orgKeyHash(rawKey)]
    );
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

    nfcApp     = buildApp(nfcRouter);
    resolveApp = buildApp(resolveRouter);
  });

  afterAll(async () => {
    try {
      await client.query(`DELETE FROM staging_household_data WHERE org_id = $1`, [testOrgId]);
      await client.query(`DELETE FROM ingest_failures WHERE org_id = $1`, [testOrgId]);
      try { await client.query(`DELETE FROM resolution_trace WHERE org_id = $1`, [testOrgId]); } catch { /* append-only — expected */ }
      try { await client.query(`DELETE FROM audit_log WHERE org_id = $1`, [testOrgId]); } catch { /* append-only — expected */ }
      await client.query(`DELETE FROM conflict_queue  WHERE org_id = $1`, [testOrgId]);
      await client.query(`DELETE FROM identifier_link WHERE org_id = $1`, [testOrgId]);
      try { await client.query(`DELETE FROM fan WHERE org_id = $1`, [testOrgId]); } catch { /* blocked by audit_log FK — expected */ }
      try { await client.query(`DELETE FROM org WHERE id = $1`, [testOrgId]); } catch { /* blocked by fan FK if fan rows remain */ }
    } finally {
      await client.end();
    }
  });

  function postNfc(body) {
    return request(nfcApp)
      .post('/v1/ingest/nfc')
      .set('Authorization', `Bearer ${rawKey}`)
      .send(body);
  }

  function postResolve(body) {
    return request(resolveApp)
      .post('/v1/resolve')
      .set('Authorization', `Bearer ${rawKey}`)
      .send(body);
  }

  async function getTrace(auditEventId) {
    const result = await client.query(
      `SELECT inbound_identifiers FROM resolution_trace WHERE audit_event_id = $1`,
      [auditEventId]
    );
    return result.rows[0];
  }

  async function fanCount() {
    const result = await client.query(`SELECT COUNT(*) AS n FROM fan WHERE org_id = $1`, [testOrgId]);
    return parseInt(result.rows[0].n, 10);
  }

  async function ingestFailuresCount() {
    const result = await client.query(
      `SELECT COUNT(*) AS n FROM ingest_failures WHERE org_id = $1`,
      [testOrgId]
    );
    return parseInt(result.rows[0].n, 10);
  }

  test('1. normalization runs — trimmed/lowercased email lands in resolution_trace', async () => {
    const res = await postNfc({
      nfc_uid:        freshNfcUid(),
      station_id:     'gate-01',
      schema_version: 'v1',
      identifiers:    { email: '  JSmith@Example.COM  ' },
    });

    expect(res.status).toBe(200);
    const trace = await getTrace(res.body.audit_event_id);
    expect(trace.inbound_identifiers.email).toBe('jsmith@example.com');
  });

  test('2. casing normalized', async () => {
    const res = await postNfc({
      nfc_uid:        freshNfcUid(),
      station_id:     'gate-01',
      schema_version: 'v1',
      identifiers:    { email: 'AARON@X.COM' },
    });

    expect(res.status).toBe(200);
    const trace = await getTrace(res.body.audit_event_id);
    expect(trace.inbound_identifiers.email).toBe('aaron@x.com');
  });

  test('3. type check fires — non-string email rejected, no fan row created', async () => {
    const before = await fanCount();

    const res = await postNfc({
      nfc_uid:        freshNfcUid(),
      station_id:     'gate-01',
      schema_version: 'v1',
      identifiers:    { email: 12345 },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('identifiers field must be a string');
    const after = await fanCount();
    expect(after).toBe(before);
  });

  test('4. normalization failure — invalid email rejected', async () => {
    const res = await postNfc({
      nfc_uid:        freshNfcUid(),
      station_id:     'gate-01',
      schema_version: 'v1',
      identifiers:    { email: 'not-an-email' },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('identifiers field failed normalization');
  });

  test('5. no DLQ row written on identifiers-object failure', async () => {
    const before = await ingestFailuresCount();

    const res = await postNfc({
      nfc_uid:        freshNfcUid(),
      station_id:     'gate-01',
      schema_version: 'v1',
      identifiers:    { email: 'not-an-email' },
    });

    expect(res.status).toBe(400);
    const after = await ingestFailuresCount();
    expect(after).toBe(before);
  });

  test('6. non-object identifiers rejected', async () => {
    const res = await postNfc({
      nfc_uid:        freshNfcUid(),
      station_id:     'gate-01',
      schema_version: 'v1',
      identifiers:    ['a'],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('identifiers must be an object');
  });

  test('7. device_id passes through unnormalized, case preserved', async () => {
    const res = await postNfc({
      nfc_uid:        freshNfcUid(),
      station_id:     'gate-01',
      schema_version: 'v1',
      identifiers:    { email: 'a@b.com', device_id: 'AbC-123' },
    });

    expect(res.status).toBe(200);
    const trace = await getTrace(res.body.audit_event_id);
    expect(trace.inbound_identifiers.device_id).toBe('AbC-123');
  });

  describe('regression', () => {
    test('8. nfc without identifiers unchanged — idempotent on retry', async () => {
      const body = {
        nfc_uid:        freshNfcUid(),
        station_id:     'gate-01',
        schema_version: 'v1',
      };

      const first = await postNfc(body);
      expect(first.status).toBe(200);
      expect(first.body.match_type).toBe('hard');
      expect(first.body.is_new_record).toBe(true);

      const second = await postNfc(body);
      expect(second.status).toBe(200);
      expect(second.body.fan_id).toBe(first.body.fan_id);
    });

    test('9. resolve.js byte-identical after extraction', async () => {
      const case1 = await postResolve({
        identifier_type:  'nba_id',
        identifier_value: crypto.randomUUID(),
        schema_version:   'v1',
        identifiers:      { email: 12345 },
      });
      expect(case1.status).toBe(400);
      expect(case1.body.error).toBe('identifiers field must be a string');
      expect(case1.body.message).toBe('identifiers.email must be a string when provided');

      const case2 = await postResolve({
        identifier_type:  'nba_id',
        identifier_value: crypto.randomUUID(),
        schema_version:   'v1',
        identifiers:      { email: 'not-an-email' },
      });
      expect(case2.status).toBe(400);
      expect(case2.body.error).toBe('identifiers field failed normalization');
      expect(typeof case2.body.detail).toBe('string');
      expect(case2.body.detail.length).toBeGreaterThan(0);

      const case3 = await postResolve({
        identifier_type:  'nba_id',
        identifier_value: crypto.randomUUID(),
        schema_version:   'v1',
        identifiers:      { email: '  A@B.COM ' },
      });
      expect(case3.status).toBe(200);
      const trace = await getTrace(case3.body.audit_event_id);
      expect(trace.inbound_identifiers.email).toBe('a@b.com');
    });
  });
});
