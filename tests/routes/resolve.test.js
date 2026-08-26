'use strict';

const express = require('express');
const request = require('supertest');

const CONTEXT_ORG_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_ORG_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';

jest.mock('../../src/modules/normalizer', () => ({
  normalizeIdentifier: (_type, value) => value.trim().toLowerCase(),
  NormalizationError: class NormalizationError extends Error {},
  // Route tests here never send an identifiers object needing rejection —
  // absent/present passthrough is all these fixtures exercise.
  normalizeIdentifiersObject: (identifiers) =>
    (identifiers === null || identifiers === undefined)
      ? { ok: true, value: null }
      : { ok: true, value: identifiers }
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

function buildApp() {
  const app = express();
  app.use(express.json());
  // Simulates orgAuthMiddleware + rlsContextMiddleware having set authenticated context
  app.use((req, _res, next) => {
    req.context = { org_id: CONTEXT_ORG_ID, org_name: 'Test Org' };
    req.db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    next();
  });
  app.use(require('../../src/routes/resolve'));
  return app;
}

const validBody = {
  identifier_type:  'email',
  identifier_value: 'fan@example.com',
  schema_version:   'v1'
};

const FAN_ID       = 'cccccccc-0000-0000-0000-000000000003';
const AUDIT_ID     = 'dddddddd-0000-0000-0000-000000000004';
const CONFLICT_ID  = 'eeeeeeee-0000-0000-0000-000000000005';
const UUID_RE      = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('POST /v1/resolve — TASK-01: org_id binding', () => {
  let app;
  const { resolverEngine } = require('../../src/modules/resolverEngine');

  beforeEach(() => {
    app = buildApp();
    resolverEngine.mockClear();
  });

  // Case 1: no body org_id — uses context org_id, resolves successfully
  test('no body org_id resolves using context org_id', async () => {
    const res = await request(app).post('/v1/resolve').send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.fan_id).toBe('cccccccc-0000-0000-0000-000000000003');
    expect(resolverEngine).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: CONTEXT_ORG_ID }),
      expect.anything()
    );
  });

  // Case 2: matching body org_id — passes mismatch guard, resolves correctly
  test('matching body org_id resolves correctly', async () => {
    const res = await request(app)
      .post('/v1/resolve')
      .send({ ...validBody, org_id: CONTEXT_ORG_ID });
    expect(res.status).toBe(200);
    expect(res.body.fan_id).toBe('cccccccc-0000-0000-0000-000000000003');
    expect(resolverEngine).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: CONTEXT_ORG_ID }),
      expect.anything()
    );
  });

  // Case 3: mismatched body org_id — returns 400, never reaches resolverEngine
  test('mismatched body org_id returns 400', async () => {
    const res = await request(app)
      .post('/v1/resolve')
      .send({ ...validBody, org_id: OTHER_ORG_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('org_id mismatch');
    expect(res.body.message).toMatch(/does not match authenticated org/);
    expect(resolverEngine).not.toHaveBeenCalled();
  });

  // Case 4: cross-tenant write structurally blocked — resolver always receives context org_id
  test('resolverEngine always receives context org_id regardless of body', async () => {
    // Even when no org_id is in body, the resolver gets the authenticated org's id
    await request(app).post('/v1/resolve').send(validBody);
    const call = resolverEngine.mock.calls[0][0];
    expect(call.org_id).toBe(CONTEXT_ORG_ID);
    expect(call.org_id).not.toBe(OTHER_ORG_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component 16 — Sprint 2 response fields: requires_review and conflict_id
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/resolve — Sprint 2 response fields', () => {
  let app;
  const { resolverEngine } = require('../../src/modules/resolverEngine');

  beforeEach(() => {
    app = buildApp();
    resolverEngine.mockClear();
  });

  // Path A — hard match, existing fan
  test('Path A: requires_review false, conflict_id null', async () => {
    resolverEngine.mockResolvedValueOnce({
      fan_id: FAN_ID, match_type: 'hard', confidence_score: 1.0,
      is_new_record: false, linked_systems: ['nfc'], linked_count: 1,
      audit_event_id: AUDIT_ID, conflict_id: null,
    });

    const res = await request(app).post('/v1/resolve').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.requires_review).toBe(false);
    expect(res.body.conflict_id).toBeNull();
    expect(res.body.match_type).toBe('hard');
    expect(res.body.is_new_record).toBe(false);
  });

  // Path B — hard match, new fan
  test('Path B: requires_review false, conflict_id null', async () => {
    resolverEngine.mockResolvedValueOnce({
      fan_id: FAN_ID, match_type: 'hard', confidence_score: 1.0,
      is_new_record: true, linked_systems: [], linked_count: 0,
      audit_event_id: AUDIT_ID, conflict_id: null,
    });

    const res = await request(app).post('/v1/resolve').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.requires_review).toBe(false);
    expect(res.body.conflict_id).toBeNull();
    expect(res.body.match_type).toBe('hard');
    expect(res.body.is_new_record).toBe(true);
  });

  // Path C — soft match
  test('Path C: requires_review true, conflict_id is valid UUID', async () => {
    resolverEngine.mockResolvedValueOnce({
      fan_id: FAN_ID, match_type: 'soft', confidence_score: 0.9,
      is_new_record: true, linked_systems: [], linked_count: 0,
      audit_event_id: AUDIT_ID, conflict_id: CONFLICT_ID,
    });

    const res = await request(app).post('/v1/resolve').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.requires_review).toBe(true);
    expect(res.body.conflict_id).toMatch(UUID_RE);
    expect(res.body.match_type).toBe('soft');
  });

  // Path D — conflict match
  test('Path D: requires_review true, conflict_id is valid UUID', async () => {
    resolverEngine.mockResolvedValueOnce({
      fan_id: FAN_ID, match_type: 'conflict', confidence_score: 0.75,
      is_new_record: true, linked_systems: [], linked_count: 0,
      audit_event_id: AUDIT_ID, conflict_id: CONFLICT_ID,
    });

    const res = await request(app).post('/v1/resolve').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.requires_review).toBe(true);
    expect(res.body.conflict_id).toMatch(UUID_RE);
    expect(res.body.match_type).toBe('conflict');
  });

  // All paths return the full required field set
  test('all paths return fan_id, confidence_score, is_new_record, linked_systems, linked_count, audit_event_id', async () => {
    resolverEngine.mockResolvedValueOnce({
      fan_id: FAN_ID, match_type: 'hard', confidence_score: 1.0,
      is_new_record: false, linked_systems: ['nfc'], linked_count: 1,
      audit_event_id: AUDIT_ID, conflict_id: null,
    });

    const res = await request(app).post('/v1/resolve').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('fan_id');
    expect(res.body).toHaveProperty('confidence_score');
    expect(res.body).toHaveProperty('is_new_record');
    expect(res.body).toHaveProperty('linked_systems');
    expect(res.body).toHaveProperty('linked_count');
    expect(res.body).toHaveProperty('audit_event_id');
  });

  // Path C match_type is 'soft', Path D is 'conflict'
  test('Path C match_type is soft', async () => {
    resolverEngine.mockResolvedValueOnce({
      fan_id: FAN_ID, match_type: 'soft', confidence_score: 0.88,
      is_new_record: true, linked_systems: [], linked_count: 0,
      audit_event_id: AUDIT_ID, conflict_id: CONFLICT_ID,
    });

    const res = await request(app).post('/v1/resolve').send(validBody);
    expect(res.body.match_type).toBe('soft');
  });

  test('Path D match_type is conflict', async () => {
    resolverEngine.mockResolvedValueOnce({
      fan_id: FAN_ID, match_type: 'conflict', confidence_score: 0.72,
      is_new_record: true, linked_systems: [], linked_count: 0,
      audit_event_id: AUDIT_ID, conflict_id: CONFLICT_ID,
    });

    const res = await request(app).post('/v1/resolve').send(validBody);
    expect(res.body.match_type).toBe('conflict');
  });
});
