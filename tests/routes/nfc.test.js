'use strict';

const express = require('express');
const request = require('supertest');

const CONTEXT_ORG_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_ORG_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';

jest.mock('../../src/modules/normalizer', () => ({
  normalizeIdentifier: (_type, value) => {
    // Minimal NFC UID normalization stub — returns a valid normalized form
    const stripped = value.replace(/[:\-\s]/g, '').toUpperCase();
    return stripped.match(/.{2}/g).join(':');
  },
  NormalizationError: class NormalizationError extends Error {}
}));

jest.mock('../../src/modules/resolverEngine', () => ({
  resolverEngine: jest.fn().mockResolvedValue({
    fan_id:           'cccccccc-0000-0000-0000-000000000003',
    match_type:       'hard',
    confidence_score: 1.0,
    is_new_record:    false,
    linked_systems:   [],
    linked_count:     0,
    audit_event_id:   'dddddddd-0000-0000-0000-000000000004'
  }),
  ConflictError: class ConflictError extends Error {},
  ResolverError:  class ResolverError extends Error {}
}));

// pool is imported by nfc.js for DLQ writes — stub it so no DB connection required
jest.mock('../../src/db/pool', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] })
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  // Simulates orgAuthMiddleware having set authenticated context
  app.use((req, _res, next) => {
    req.context = { org_id: CONTEXT_ORG_ID, org_name: 'Test Org' };
    next();
  });
  app.use(require('../../src/routes/nfc'));
  return app;
}

const validBody = {
  nfc_uid:        'A1B2C3D4',
  station_id:     'gate-01',
  schema_version: 'v1'
};

describe('POST /v1/ingest/nfc — TASK-01: org_id binding', () => {
  let app;
  const { resolverEngine } = require('../../src/modules/resolverEngine');

  beforeEach(() => {
    app = buildApp();
    resolverEngine.mockClear();
  });

  // Case 1: no body org_id — uses context org_id, resolves successfully
  test('no body org_id resolves using context org_id', async () => {
    const res = await request(app).post('/v1/ingest/nfc').send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.fan_id).toBe('cccccccc-0000-0000-0000-000000000003');
    expect(resolverEngine).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: CONTEXT_ORG_ID })
    );
  });

  // Case 2: matching body org_id — passes mismatch guard, resolves correctly
  test('matching body org_id resolves correctly', async () => {
    const res = await request(app)
      .post('/v1/ingest/nfc')
      .send({ ...validBody, org_id: CONTEXT_ORG_ID });
    expect(res.status).toBe(200);
    expect(res.body.session_ready).toBe(true);
    expect(resolverEngine).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: CONTEXT_ORG_ID })
    );
  });

  // Case 3: mismatched body org_id — returns 400, never reaches resolverEngine
  test('mismatched body org_id returns 400', async () => {
    const res = await request(app)
      .post('/v1/ingest/nfc')
      .send({ ...validBody, org_id: OTHER_ORG_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('org_id mismatch');
    expect(res.body.message).toMatch(/does not match authenticated org/);
    expect(resolverEngine).not.toHaveBeenCalled();
  });

  // Case 4: cross-tenant write structurally blocked — resolver always receives context org_id
  test('resolverEngine always receives context org_id regardless of body', async () => {
    await request(app).post('/v1/ingest/nfc').send(validBody);
    const call = resolverEngine.mock.calls[0][0];
    expect(call.org_id).toBe(CONTEXT_ORG_ID);
    expect(call.org_id).not.toBe(OTHER_ORG_ID);
  });
});
