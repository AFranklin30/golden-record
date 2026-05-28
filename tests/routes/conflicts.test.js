'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/db/pool', () => ({
  connect: jest.fn(),
  query:   jest.fn(),
}));

const pool = require('../../src/db/pool');

const CONTEXT_ORG_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_ORG_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';
const FAN_ID_A       = 'cccccccc-0000-0000-0000-000000000003';
const FAN_ID_B       = 'dddddddd-0000-0000-0000-000000000004';
const CONFLICT_ID    = 'eeeeeeee-0000-0000-0000-000000000005';

let mockClient;

beforeEach(() => {
  jest.clearAllMocks();
  mockClient = { query: jest.fn(), release: jest.fn() };
  pool.connect.mockResolvedValue(mockClient);
});

function buildApp(orgId = CONTEXT_ORG_ID) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.context = { org_id: orgId, org_name: 'Test Org', correlation_id: 'test-corr-id' };
    next();
  });
  app.use(require('../../src/routes/conflicts'));
  return app;
}

const pendingConflict = {
  id:               CONFLICT_ID,
  fan_id_a:         FAN_ID_A,
  fan_id_b:         FAN_ID_B,
  org_id:           CONTEXT_ORG_ID,
  confidence_score: 0.9,
  signals_matched:  { signal: 'email_similarity', score: 0.7 },
  status:           'pending',
  created_at:       new Date().toISOString(),
  reviewed_at:      null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Component 18 — GET /v1/conflicts
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/conflicts', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  test('returns only conflicts for authenticated org — org_id in query params', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [pendingConflict] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    await request(app).get('/v1/conflicts');

    expect(pool.query.mock.calls[0][1][0]).toBe(CONTEXT_ORG_ID);
    expect(pool.query.mock.calls[1][1][0]).toBe(CONTEXT_ORG_ID);
  });

  test('does NOT return conflicts from a different org', async () => {
    const otherApp = buildApp(OTHER_ORG_ID);

    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(otherApp).get('/v1/conflicts');

    expect(res.status).toBe(200);
    expect(res.body.conflicts).toHaveLength(0);
    // Verify query used OTHER_ORG_ID, not CONTEXT_ORG_ID
    expect(pool.query.mock.calls[0][1][0]).toBe(OTHER_ORG_ID);
    expect(pool.query.mock.calls[0][1][0]).not.toBe(CONTEXT_ORG_ID);
  });

  test('filters correctly by status: pending (default)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await request(app).get('/v1/conflicts');

    expect(pool.query.mock.calls[0][1][1]).toBe('pending');
  });

  test('filters correctly by status: confirmed', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await request(app).get('/v1/conflicts?status=confirmed');

    expect(pool.query.mock.calls[0][1][1]).toBe('confirmed');
  });

  test('filters correctly by status: rejected', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await request(app).get('/v1/conflicts?status=rejected');

    expect(pool.query.mock.calls[0][1][1]).toBe('rejected');
  });

  test('rejects invalid status value with 400', async () => {
    const res = await request(app).get('/v1/conflicts?status=invalid');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid status');
  });

  test('rejects limit above 100 with 400', async () => {
    const res = await request(app).get('/v1/conflicts?limit=101');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('limit exceeds maximum');
  });

  test('rejects limit below 1 with 400', async () => {
    const res = await request(app).get('/v1/conflicts?limit=0');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid limit');
  });

  test('rejects negative offset with 400', async () => {
    const res = await request(app).get('/v1/conflicts?offset=-1');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid offset');
  });

  test('returns empty conflicts array when none exist', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(app).get('/v1/conflicts');

    expect(res.status).toBe(200);
    expect(res.body.conflicts).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  test('results query uses ORDER BY confidence_score DESC', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await request(app).get('/v1/conflicts');

    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('ORDER BY confidence_score DESC');
  });

  test('pagination passes limit and offset to query', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await request(app).get('/v1/conflicts?limit=10&offset=20');

    const params = pool.query.mock.calls[0][1];
    expect(params[2]).toBe(10);   // limit
    expect(params[3]).toBe(20);   // offset
  });

  test('signals_matched returned as parsed JSON object not as string', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ ...pendingConflict, signals_matched: { signal: 'email_similarity', score: 0.7 } }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const res = await request(app).get('/v1/conflicts');

    expect(res.status).toBe(200);
    expect(typeof res.body.conflicts[0].signals_matched).toBe('object');
    expect(res.body.conflicts[0].signals_matched).not.toBeNull();
  });

  test('response includes total, status_filter, limit, offset', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [pendingConflict] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const res = await request(app).get('/v1/conflicts?limit=25&offset=0');

    expect(res.body).toHaveProperty('total', 1);
    expect(res.body).toHaveProperty('status_filter', 'pending');
    expect(res.body).toHaveProperty('limit', 25);
    expect(res.body).toHaveProperty('offset', 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component 19 — POST /v1/conflicts/:id/confirm
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/conflicts/:id/confirm', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  function setupSuccessfulConfirm() {
    mockClient.query
      .mockResolvedValueOnce({ rows: [pendingConflict] })             // 1. SELECT conflict
      .mockResolvedValueOnce({ rows: [{ deleted_at: null }] })        // 2. R3: SELECT fan_id_a.deleted_at — active
      .mockResolvedValue({ rows: [] });                               // 3+. BEGIN + all writes + COMMIT
  }

  test('returns 200 with confirmed status on success', async () => {
    setupSuccessfulConfirm();

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('confirmed');
    expect(res.body.conflict_id).toBe(CONFLICT_ID);
    expect(res.body.merged_into).toBe(FAN_ID_A);
  });

  test('moves all fan_id_b identifiers to fan_id_a', async () => {
    setupSuccessfulConfirm();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const updateCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE identifier_link')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toBe(FAN_ID_A);  // new fan_id
    expect(updateCall[1][1]).toBe(FAN_ID_B);  // old fan_id (WHERE fan_id = $2)
  });

  test('sets merged_from_fan_id on moved identifiers (Component 25 forward-port)', async () => {
    setupSuccessfulConfirm();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const updateCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE identifier_link')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toContain('merged_from_fan_id');
  });

  test('soft deletes fan_id_b (deleted_at is set)', async () => {
    setupSuccessfulConfirm();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const fanDeleteCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE fan') && c[0].includes('deleted_at')
    );
    expect(fanDeleteCall).toBeDefined();
    expect(fanDeleteCall[1][0]).toBe(FAN_ID_B);  // deleting fan_id_b
  });

  test('closes conflict_queue row status to confirmed', async () => {
    setupSuccessfulConfirm();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const conflictUpdateCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' &&
           c[0].includes('UPDATE conflict_queue') &&
           c[0].includes("'confirmed'")
    );
    expect(conflictUpdateCall).toBeDefined();
  });

  test('writes to merge_history with status active (Component 25 forward-port)', async () => {
    setupSuccessfulConfirm();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const mergeHistoryCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO merge_history')
    );
    expect(mergeHistoryCall).toBeDefined();
    expect(mergeHistoryCall[0]).toContain("'active'");
    // fan_id_source = fan_id_b, fan_id_target = fan_id_a
    expect(mergeHistoryCall[1][1]).toBe(FAN_ID_B);  // fan_id_source
    expect(mergeHistoryCall[1][2]).toBe(FAN_ID_A);  // fan_id_target
  });

  test('audit event is written as the last write before COMMIT', async () => {
    setupSuccessfulConfirm();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const sqlCalls       = mockClient.query.mock.calls.map(c => c[0]);
    const auditIdx       = sqlCalls.findIndex(s => typeof s === 'string' && s.includes('INSERT INTO audit_log'));
    const mergeHistIdx   = sqlCalls.findIndex(s => typeof s === 'string' && s.includes('INSERT INTO merge_history'));
    const commitIdx      = sqlCalls.findIndex(s => s === 'COMMIT');

    expect(mergeHistIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(mergeHistIdx);  // audit AFTER merge_history
    expect(commitIdx).toBeGreaterThan(auditIdx);     // COMMIT AFTER audit
  });

  test('returns 404 for unknown conflict_id', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [] });  // SELECT returns nothing

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('conflict not found');
  });

  test('returns 409 if conflict status is already confirmed', async () => {
    mockClient.query.mockResolvedValueOnce({
      rows: [{ ...pendingConflict, status: 'confirmed' }]
    });

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict already resolved');
  });

  test('returns 409 if conflict status is already rejected', async () => {
    mockClient.query.mockResolvedValueOnce({
      rows: [{ ...pendingConflict, status: 'rejected' }]
    });

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict already resolved');
  });

  test('cannot confirm conflict belonging to different org — returns 404', async () => {
    // With a different org context, org_id mismatch means SELECT returns no rows
    const otherApp = buildApp(OTHER_ORG_ID);
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(otherApp).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    expect(res.status).toBe(404);
    // Verify query used OTHER_ORG_ID
    expect(mockClient.query.mock.calls[0][1][1]).toBe(OTHER_ORG_ID);
  });

  test('fan_id_b identifiers moved to fan_id_a — no longer under fan_id_b', async () => {
    setupSuccessfulConfirm();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    // The UPDATE moves all rows WHERE fan_id = fan_id_b to have fan_id = fan_id_a
    const updateCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE identifier_link')
    );
    expect(updateCall).toBeDefined();
    // After this UPDATE, any SELECT WHERE fan_id = fan_id_b would return 0 rows
    expect(updateCall[1][0]).toBe(FAN_ID_A);  // SET fan_id = fan_id_a
    expect(updateCall[1][1]).toBe(FAN_ID_B);  // WHERE fan_id = fan_id_b
  });

  test('returns 400 for non-UUID conflict_id', async () => {
    const res = await request(app).post('/v1/conflicts/not-a-uuid/confirm').send();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('conflict_id must be a valid UUID');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component 20 — POST /v1/conflicts/:id/reject
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/conflicts/:id/reject', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  function setupSuccessfulReject() {
    mockClient.query
      .mockResolvedValueOnce({ rows: [pendingConflict] })  // SELECT conflict
      .mockResolvedValue({ rows: [] });                    // BEGIN + writes + COMMIT
  }

  test('returns 200 with rejected status on success', async () => {
    setupSuccessfulReject();

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.conflict_id).toBe(CONFLICT_ID);
  });

  test('does NOT move any identifiers (no UPDATE identifier_link)', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    const identifierMoveCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE identifier_link')
    );
    expect(identifierMoveCall).toBeUndefined();
  });

  test('does NOT set merged_from_fan_id on any row', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    const mergedFromCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('merged_from_fan_id')
    );
    expect(mergedFromCall).toBeUndefined();
  });

  test('does NOT soft delete fan_id_b (no UPDATE fan)', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    const fanDeleteCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE fan')
    );
    expect(fanDeleteCall).toBeUndefined();
  });

  test('closes conflict_queue row status to rejected', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    const conflictUpdateCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' &&
           c[0].includes('UPDATE conflict_queue') &&
           c[0].includes("'rejected'")
    );
    expect(conflictUpdateCall).toBeDefined();
  });

  test('does NOT write to merge_history', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    const mergeHistoryCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('merge_history')
    );
    expect(mergeHistoryCall).toBeUndefined();
  });

  test('audit event is written as the last write before COMMIT', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    const sqlCalls  = mockClient.query.mock.calls.map(c => c[0]);
    const auditIdx  = sqlCalls.findIndex(s => typeof s === 'string' && s.includes('INSERT INTO audit_log'));
    const commitIdx = sqlCalls.findIndex(s => s === 'COMMIT');

    expect(auditIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(auditIdx);  // COMMIT AFTER audit
  });

  test('returns 404 for unknown conflict_id', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('conflict not found');
  });

  test('returns 409 if conflict already resolved', async () => {
    mockClient.query.mockResolvedValueOnce({
      rows: [{ ...pendingConflict, status: 'confirmed' }]
    });

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict already resolved');
  });

  test('cannot reject conflict belonging to different org — returns 404', async () => {
    const otherApp = buildApp(OTHER_ORG_ID);
    mockClient.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(otherApp).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    expect(res.status).toBe(404);
    expect(mockClient.query.mock.calls[0][1][1]).toBe(OTHER_ORG_ID);
  });

  test('fan_id_b record still active after reject — no deleted_at set', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    const fanDeleteCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE fan')
    );
    expect(fanDeleteCall).toBeUndefined();
  });

  test('fan_id_b identifiers still queryable after reject — no identifier moves', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    // No UPDATE identifier_link means fan_id_b identifiers are untouched
    const identifierMoveCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE identifier_link')
    );
    expect(identifierMoveCall).toBeUndefined();
  });

  test('returns 400 for non-UUID conflict_id', async () => {
    const res = await request(app).post('/v1/conflicts/not-a-uuid/reject').send();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('conflict_id must be a valid UUID');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R3 regression — confirm when fan_id_a is soft-deleted
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/conflicts/:id/confirm — R3 regression: deleted fan_id_a', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  function setupDeletedFanA() {
    mockClient.query
      .mockResolvedValueOnce({ rows: [pendingConflict] })             // 1. SELECT conflict
      .mockResolvedValueOnce({ rows: [{ deleted_at: new Date() }] }); // 2. R3: fan_id_a is deleted
  }

  test('R3-A: confirm returns 409 when fan_id_a is soft deleted', async () => {
    setupDeletedFanA();

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/deleted|erased/i);
  });

  test('R3-B: no identifiers are moved when fan_id_a is deleted', async () => {
    setupDeletedFanA();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const identifierMoveCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE identifier_link')
    );
    expect(identifierMoveCall).toBeUndefined();
  });

  test('R3-C: fan_id_b record is completely unchanged after 409 — no UPDATE fan', async () => {
    setupDeletedFanA();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const fanUpdateCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE fan')
    );
    expect(fanUpdateCall).toBeUndefined();
  });

  test('R3-D: conflict_queue status remains pending after 409 — no UPDATE conflict_queue', async () => {
    setupDeletedFanA();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const conflictUpdateCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE conflict_queue')
    );
    expect(conflictUpdateCall).toBeUndefined();
  });
});
