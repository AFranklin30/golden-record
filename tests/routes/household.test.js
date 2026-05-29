'use strict';

const express = require('express');
const request = require('supertest');

const CONTEXT_ORG_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_ORG_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';
const ADULT_FAN_ID   = 'cccccccc-0000-0000-0000-000000000003';
const OTHER_FAN_ID   = 'dddddddd-0000-0000-0000-000000000004';
const HOUSEHOLD_ID   = 'eeeeeeee-0000-0000-0000-000000000005';

let mockDb;

beforeEach(() => {
  jest.clearAllMocks();
  mockDb = { query: jest.fn() };
});

function buildApp(orgId = CONTEXT_ORG_ID, fanId = ADULT_FAN_ID) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.context = {
      org_id:         orgId,
      org_name:       'Test Org',
      correlation_id: 'test-corr-id',
      fan_id:         fanId,
    };
    req.db = mockDb;
    next();
  });
  app.use(require('../../src/routes/household'));
  return app;
}

const householdRow = {
  id:           HOUSEHOLD_ID,
  org_id:       CONTEXT_ORG_ID,
  adult_fan_id: ADULT_FAN_ID,
  created_at:   new Date('2026-05-01T12:00:00Z'),
  created_by:   'fan',
};

// ─────────────────────────────────────────────────────────────────────────────
// Component 27 — POST /v1/household
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/household', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  function setupSuccessfulCreate() {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID, org_id: CONTEXT_ORG_ID, adult_fan_id: ADULT_FAN_ID, created_at: householdRow.created_at }] })
      .mockResolvedValue({ rows: [] });
  }

  test('returns 201 with household_id, adult_fan_id, org_id, created_at on success', async () => {
    setupSuccessfulCreate();

    const res = await request(app).post('/v1/household').send();

    expect(res.status).toBe(201);
    expect(res.body.household_id).toBe(HOUSEHOLD_ID);
    expect(res.body.adult_fan_id).toBe(ADULT_FAN_ID);
    expect(res.body.org_id).toBe(CONTEXT_ORG_ID);
    expect(res.body.created_at).toBeDefined();
  });

  test('returns 409 with household_id in body when household already exists', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] });

    const res = await request(app).post('/v1/household').send();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('household already exists');
    expect(res.body.household_id).toBe(HOUSEHOLD_ID);
  });

  test('returns 403 when fan does not belong to org', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post('/v1/household').send();

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('fan record not found or does not belong to this org');
  });

  test('returns 403 when fan is soft-deleted', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: new Date() }] });

    const res = await request(app).post('/v1/household').send();

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('fan record has been erased — cannot create household');
  });

  test('fan query uses org_id from context — not from request body', async () => {
    setupSuccessfulCreate();

    await request(app).post('/v1/household').send();

    expect(mockDb.query.mock.calls[0][1][1]).toBe(CONTEXT_ORG_ID);
  });

  test('duplicate-check query uses org_id from context', async () => {
    setupSuccessfulCreate();

    await request(app).post('/v1/household').send();

    expect(mockDb.query.mock.calls[1][1][1]).toBe(CONTEXT_ORG_ID);
  });

  test('returns 500 with generic message on db error — no internal detail in response', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app).post('/v1/household').send();

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('household could not be created');
    expect(JSON.stringify(res.body)).not.toContain('connection refused');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component 28 — GET /v1/household/:adult_fan_id
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/household/:adult_fan_id', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  function setupSuccessfulFetch(memberCount = '3') {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [householdRow] })
      .mockResolvedValueOnce({ rows: [{ count: memberCount }] });
  }

  test('returns 200 with correct response shape on success', async () => {
    setupSuccessfulFetch();

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.household_id).toBe(HOUSEHOLD_ID);
    expect(res.body.adult_fan_id).toBe(ADULT_FAN_ID);
    expect(res.body.org_id).toBe(CONTEXT_ORG_ID);
    expect(res.body.member_count).toBe(3);
    expect(res.body.created_by).toBe('fan');
    expect(res.body.created_at).toBeDefined();
  });

  test('member_count is returned as an integer, not a string', async () => {
    setupSuccessfulFetch('5');

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.member_count).toBe('number');
    expect(Number.isInteger(res.body.member_count)).toBe(true);
    expect(res.body.member_count).toBe(5);
  });

  test('member_count is 0 when household has no active members', async () => {
    setupSuccessfulFetch('0');

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.member_count).toBe(0);
  });

  test('returns 403 access denied when authenticated fan does not match URL adult_fan_id', async () => {
    const otherApp = buildApp(CONTEXT_ORG_ID, OTHER_FAN_ID);

    const res = await request(otherApp).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('access denied');
  });

  test('fan_id mismatch check fires before any db call — household existence not leaked', async () => {
    const otherApp = buildApp(CONTEXT_ORG_ID, OTHER_FAN_ID);

    await request(otherApp).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('returns 400 for non-UUID adult_fan_id', async () => {
    const res = await request(app).get('/v1/household/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('adult_fan_id must be a valid UUID');
  });

  test('returns 404 when fan not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('fan not found');
  });

  test('returns 403 when fan is soft-deleted', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: new Date() }] });

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('fan account is inactive');
  });

  test('returns 404 when household not found', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('household not found');
  });

  test('READ 3 — count SQL filters by status active', async () => {
    setupSuccessfulFetch();

    await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    const countSql = mockDb.query.mock.calls[2][0];
    expect(countSql).toContain("status = 'active'");
  });

  test('READ 3 — count query scoped to household_id returned by READ 2', async () => {
    setupSuccessfulFetch();

    await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    const countParams = mockDb.query.mock.calls[2][1];
    expect(countParams[0]).toBe(HOUSEHOLD_ID);
  });

  test('org_id from context used in fan and household queries — not from URL', async () => {
    setupSuccessfulFetch();

    await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(mockDb.query.mock.calls[0][1][1]).toBe(CONTEXT_ORG_ID);  // READ 1 — fan
    expect(mockDb.query.mock.calls[1][1][1]).toBe(CONTEXT_ORG_ID);  // READ 2 — household
  });

  test('returns 500 with generic message on db error — no internal detail in response', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('relation "fan" does not exist'));

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('household could not be retrieved');
    expect(JSON.stringify(res.body)).not.toContain('relation');
  });
});
