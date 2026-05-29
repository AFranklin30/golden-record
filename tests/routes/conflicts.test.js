'use strict';

const express = require('express');
const request = require('supertest');

const CONTEXT_ORG_ID   = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_ORG_ID     = 'bbbbbbbb-0000-0000-0000-000000000002';
const FAN_ID_A         = 'cccccccc-0000-0000-0000-000000000003';
const FAN_ID_B         = 'dddddddd-0000-0000-0000-000000000004';
const CONFLICT_ID      = 'eeeeeeee-0000-0000-0000-000000000005';
const MERGE_HISTORY_ID = 'ffffffff-0000-0000-0000-000000000006';

let mockDb;

beforeEach(() => {
  jest.clearAllMocks();
  mockDb = { query: jest.fn() };
});

function buildApp(orgId = CONTEXT_ORG_ID) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.context = { org_id: orgId, org_name: 'Test Org', correlation_id: 'test-corr-id' };
    req.db = mockDb;
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
    mockDb.query
      .mockResolvedValueOnce({ rows: [pendingConflict] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    await request(app).get('/v1/conflicts');

    expect(mockDb.query.mock.calls[0][1][0]).toBe(CONTEXT_ORG_ID);
    expect(mockDb.query.mock.calls[1][1][0]).toBe(CONTEXT_ORG_ID);
  });

  test('does NOT return conflicts from a different org', async () => {
    const otherApp = buildApp(OTHER_ORG_ID);

    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(otherApp).get('/v1/conflicts');

    expect(res.status).toBe(200);
    expect(res.body.conflicts).toHaveLength(0);
    // Verify query used OTHER_ORG_ID, not CONTEXT_ORG_ID
    expect(mockDb.query.mock.calls[0][1][0]).toBe(OTHER_ORG_ID);
    expect(mockDb.query.mock.calls[0][1][0]).not.toBe(CONTEXT_ORG_ID);
  });

  test('filters correctly by status: pending (default)', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await request(app).get('/v1/conflicts');

    expect(mockDb.query.mock.calls[0][1][1]).toBe('pending');
  });

  test('filters correctly by status: confirmed', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await request(app).get('/v1/conflicts?status=confirmed');

    expect(mockDb.query.mock.calls[0][1][1]).toBe('confirmed');
  });

  test('filters correctly by status: rejected', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await request(app).get('/v1/conflicts?status=rejected');

    expect(mockDb.query.mock.calls[0][1][1]).toBe('rejected');
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
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(app).get('/v1/conflicts');

    expect(res.status).toBe(200);
    expect(res.body.conflicts).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  test('results query uses ORDER BY confidence_score DESC', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await request(app).get('/v1/conflicts');

    const sql = mockDb.query.mock.calls[0][0];
    expect(sql).toContain('ORDER BY confidence_score DESC');
  });

  test('pagination passes limit and offset to query', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await request(app).get('/v1/conflicts?limit=10&offset=20');

    const params = mockDb.query.mock.calls[0][1];
    expect(params[2]).toBe(10);   // limit
    expect(params[3]).toBe(20);   // offset
  });

  test('signals_matched returned as parsed JSON object not as string', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ ...pendingConflict, signals_matched: { signal: 'email_similarity', score: 0.7 } }] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const res = await request(app).get('/v1/conflicts');

    expect(res.status).toBe(200);
    expect(typeof res.body.conflicts[0].signals_matched).toBe('object');
    expect(res.body.conflicts[0].signals_matched).not.toBeNull();
  });

  test('response includes total, status_filter, limit, offset', async () => {
    mockDb.query
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
    mockDb.query
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

    const updateCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE identifier_link')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toBe(FAN_ID_A);  // new fan_id
    expect(updateCall[1][1]).toBe(FAN_ID_B);  // old fan_id (WHERE fan_id = $2)
  });

  test('sets merged_from_fan_id on moved identifiers (Component 25 forward-port)', async () => {
    setupSuccessfulConfirm();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const updateCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE identifier_link')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toContain('merged_from_fan_id');
  });

  test('soft deletes fan_id_b (deleted_at is set)', async () => {
    setupSuccessfulConfirm();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const fanDeleteCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE fan') && c[0].includes('deleted_at')
    );
    expect(fanDeleteCall).toBeDefined();
    expect(fanDeleteCall[1][0]).toBe(FAN_ID_B);  // deleting fan_id_b
  });

  test('closes conflict_queue row status to confirmed', async () => {
    setupSuccessfulConfirm();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const conflictUpdateCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' &&
           c[0].includes('UPDATE conflict_queue') &&
           c[0].includes("'confirmed'")
    );
    expect(conflictUpdateCall).toBeDefined();
  });

  test('writes to merge_history with status active (Component 25 forward-port)', async () => {
    setupSuccessfulConfirm();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const mergeHistoryCall = mockDb.query.mock.calls.find(
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

    const sqlCalls       = mockDb.query.mock.calls.map(c => c[0]);
    const auditIdx       = sqlCalls.findIndex(s => typeof s === 'string' && s.includes('INSERT INTO audit_log'));
    const mergeHistIdx   = sqlCalls.findIndex(s => typeof s === 'string' && s.includes('INSERT INTO merge_history'));
    const commitIdx      = sqlCalls.findIndex(s => s === 'COMMIT');

    expect(mergeHistIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(mergeHistIdx);  // audit AFTER merge_history
    expect(commitIdx).toBeGreaterThan(auditIdx);     // COMMIT AFTER audit
  });

  test('returns 404 for unknown conflict_id', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });  // SELECT returns nothing

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('conflict not found');
  });

  test('returns 409 if conflict status is already confirmed', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ ...pendingConflict, status: 'confirmed' }]
    });

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict already resolved');
  });

  test('returns 409 if conflict status is already rejected', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ ...pendingConflict, status: 'rejected' }]
    });

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict already resolved');
  });

  test('cannot confirm conflict belonging to different org — returns 404', async () => {
    // With a different org context, org_id mismatch means SELECT returns no rows
    const otherApp = buildApp(OTHER_ORG_ID);
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(otherApp).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    expect(res.status).toBe(404);
    // Verify query used OTHER_ORG_ID
    expect(mockDb.query.mock.calls[0][1][1]).toBe(OTHER_ORG_ID);
  });

  test('fan_id_b identifiers moved to fan_id_a — no longer under fan_id_b', async () => {
    setupSuccessfulConfirm();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    // The UPDATE moves all rows WHERE fan_id = fan_id_b to have fan_id = fan_id_a
    const updateCall = mockDb.query.mock.calls.find(
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
    mockDb.query
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

    const identifierMoveCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE identifier_link')
    );
    expect(identifierMoveCall).toBeUndefined();
  });

  test('does NOT set merged_from_fan_id on any row', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    const mergedFromCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('merged_from_fan_id')
    );
    expect(mergedFromCall).toBeUndefined();
  });

  test('does NOT soft delete fan_id_b (no UPDATE fan)', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    const fanDeleteCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE fan')
    );
    expect(fanDeleteCall).toBeUndefined();
  });

  test('closes conflict_queue row status to rejected', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    const conflictUpdateCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' &&
           c[0].includes('UPDATE conflict_queue') &&
           c[0].includes("'rejected'")
    );
    expect(conflictUpdateCall).toBeDefined();
  });

  test('does NOT write to merge_history', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    const mergeHistoryCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('merge_history')
    );
    expect(mergeHistoryCall).toBeUndefined();
  });

  test('audit event is written as the last write before COMMIT', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    const sqlCalls  = mockDb.query.mock.calls.map(c => c[0]);
    const auditIdx  = sqlCalls.findIndex(s => typeof s === 'string' && s.includes('INSERT INTO audit_log'));
    const commitIdx = sqlCalls.findIndex(s => s === 'COMMIT');

    expect(auditIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(auditIdx);  // COMMIT AFTER audit
  });

  test('returns 404 for unknown conflict_id', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('conflict not found');
  });

  test('returns 409 if conflict already resolved', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ ...pendingConflict, status: 'confirmed' }]
    });

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict already resolved');
  });

  test('cannot reject conflict belonging to different org — returns 404', async () => {
    const otherApp = buildApp(OTHER_ORG_ID);
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(otherApp).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    expect(res.status).toBe(404);
    expect(mockDb.query.mock.calls[0][1][1]).toBe(OTHER_ORG_ID);
  });

  test('fan_id_b record still active after reject — no deleted_at set', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    const fanDeleteCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE fan')
    );
    expect(fanDeleteCall).toBeUndefined();
  });

  test('fan_id_b identifiers still queryable after reject — no identifier moves', async () => {
    setupSuccessfulReject();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/reject`).send();

    // No UPDATE identifier_link means fan_id_b identifiers are untouched
    const identifierMoveCall = mockDb.query.mock.calls.find(
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
// Component 26 — POST /v1/conflicts/:id/unmerge
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/conflicts/:id/unmerge', () => {
  let app;

  // fan_id_a = fan_id_target (the absorbing record, still active)
  // fan_id_b = fan_id_source (the one that was merged in, soft-deleted, now being restored)
  const confirmedConflict = {
    id:       CONFLICT_ID,
    fan_id_a: FAN_ID_A,
    fan_id_b: FAN_ID_B,
    org_id:   CONTEXT_ORG_ID,
    status:   'confirmed',
  };

  const activeMergeRecord = {
    id:             MERGE_HISTORY_ID,
    fan_id_source:  FAN_ID_B,  // was merged in — needs restoration
    fan_id_target:  FAN_ID_A,  // absorbed the merge
    status:         'active',
  };

  beforeEach(() => {
    app = buildApp();
  });

  function setupSuccessfulUnmerge() {
    mockDb.query
      .mockResolvedValueOnce({ rows: [confirmedConflict] })  // READ 1 — SELECT conflict_queue
      .mockResolvedValueOnce({ rows: [activeMergeRecord] })  // READ 2 — SELECT merge_history
      .mockResolvedValue({ rows: [] });                      // BEGIN + 6 writes + COMMIT
  }

  test('returns 200 with correct response shape on success', async () => {
    setupSuccessfulUnmerge();

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/unmerge`).send();

    expect(res.status).toBe(200);
    expect(res.body.conflict_id).toBe(CONFLICT_ID);
    expect(res.body.status).toBe('unmerged');
    expect(res.body.fan_id_restored).toBe(FAN_ID_B);
    expect(res.body.fan_id_target).toBe(FAN_ID_A);
    expect(res.body.reversed_at).toBeDefined();
  });

  test('STEP 1 — moves identifier_link rows back from fan_id_target to fan_id_source', async () => {
    setupSuccessfulUnmerge();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/unmerge`).send();

    const updateCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE identifier_link')
    );
    expect(updateCall).toBeDefined();
    // WHERE fan_id = fan_id_target AND merged_from_fan_id = fan_id_source
    expect(updateCall[1][0]).toBe(FAN_ID_A);  // fan_id_target (WHERE fan_id = $1)
    expect(updateCall[1][1]).toBe(FAN_ID_B);  // fan_id_source (WHERE merged_from_fan_id = $2)
    expect(updateCall[1][2]).toBe(CONTEXT_ORG_ID);
  });

  test('STEP 1 — SQL sets merged_from_fan_id = NULL to clean provenance after reversal', async () => {
    setupSuccessfulUnmerge();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/unmerge`).send();

    const updateCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE identifier_link')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toContain('merged_from_fan_id = NULL');
  });

  test('STEP 2 — reactivates fan_id_source by clearing deleted_at', async () => {
    setupSuccessfulUnmerge();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/unmerge`).send();

    const fanUpdateCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' &&
           c[0].includes('UPDATE fan') &&
           c[0].includes('deleted_at = NULL')
    );
    expect(fanUpdateCall).toBeDefined();
    expect(fanUpdateCall[1][0]).toBe(FAN_ID_B);  // fan_id_source restored
  });

  test('STEP 3 — conflict_queue status set to unmerged', async () => {
    setupSuccessfulUnmerge();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/unmerge`).send();

    const conflictUpdateCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' &&
           c[0].includes('UPDATE conflict_queue') &&
           c[0].includes("'unmerged'")
    );
    expect(conflictUpdateCall).toBeDefined();
    expect(conflictUpdateCall[1][0]).toBe(CONFLICT_ID);
  });

  test('STEP 4 — merge_history status set to reversed with reversed_by = org_name', async () => {
    setupSuccessfulUnmerge();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/unmerge`).send();

    const mergeHistoryUpdateCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' &&
           c[0].includes('UPDATE merge_history') &&
           c[0].includes("'reversed'")
    );
    expect(mergeHistoryUpdateCall).toBeDefined();
    expect(mergeHistoryUpdateCall[1][0]).toBe('Test Org');     // reversed_by = org_name
    expect(mergeHistoryUpdateCall[1][1]).toBe(MERGE_HISTORY_ID);
  });

  test('STEP 5 — related_fans row written with relationship unmerged', async () => {
    setupSuccessfulUnmerge();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/unmerge`).send();

    const relatedFansCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO related_fans')
    );
    expect(relatedFansCall).toBeDefined();
    expect(relatedFansCall[0]).toContain("'unmerged'");
    expect(relatedFansCall[0]).toContain("'merge_history'");
    expect(relatedFansCall[1][1]).toBe(FAN_ID_A);  // fan_id_a = fan_id_target
    expect(relatedFansCall[1][2]).toBe(FAN_ID_B);  // fan_id_b = fan_id_source
  });

  test('STEP 6 — audit event is last write before COMMIT', async () => {
    setupSuccessfulUnmerge();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/unmerge`).send();

    const sqlCalls       = mockDb.query.mock.calls.map(c => c[0]);
    const auditIdx       = sqlCalls.findIndex(s => typeof s === 'string' && s.includes('INSERT INTO audit_log'));
    const relatedFansIdx = sqlCalls.findIndex(s => typeof s === 'string' && s.includes('INSERT INTO related_fans'));
    const mergeHistIdx   = sqlCalls.findIndex(s => typeof s === 'string' && s.includes('UPDATE merge_history'));
    const commitIdx      = sqlCalls.findIndex(s => s === 'COMMIT');

    expect(auditIdx).toBeGreaterThan(relatedFansIdx);  // audit AFTER related_fans
    expect(auditIdx).toBeGreaterThan(mergeHistIdx);    // audit AFTER merge_history update
    expect(commitIdx).toBeGreaterThan(auditIdx);       // COMMIT AFTER audit
  });

  test('returns 409 when conflict status is pending', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [pendingConflict] });

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/unmerge`).send();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict is not confirmed');
    expect(res.body.message).toBe('only confirmed merges can be reversed');
  });

  test('returns 409 when conflict status is rejected', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ ...pendingConflict, status: 'rejected' }]
    });

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/unmerge`).send();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict is not confirmed');
  });

  test('returns 409 when conflict status is already unmerged — cannot reverse twice', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ ...confirmedConflict, status: 'unmerged' }]
    });

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/unmerge`).send();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict is not confirmed');
  });

  test('returns 404 when conflict not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/unmerge`).send();

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('conflict not found');
  });

  test('returns 404 when merge_history record not found', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [confirmedConflict] })  // conflict found
      .mockResolvedValueOnce({ rows: [] });                  // no active merge_history

    const res = await request(app).post(`/v1/conflicts/${CONFLICT_ID}/unmerge`).send();

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('merge history not found');
    expect(res.body.message).toBe('this merge cannot be reversed');
  });

  test('cannot unmerge conflict belonging to different org — returns 404', async () => {
    const otherApp = buildApp(OTHER_ORG_ID);
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(otherApp).post(`/v1/conflicts/${CONFLICT_ID}/unmerge`).send();

    expect(res.status).toBe(404);
    expect(mockDb.query.mock.calls[0][1][1]).toBe(OTHER_ORG_ID);
  });

  test('returns 400 for non-UUID conflict_id', async () => {
    const res = await request(app).post('/v1/conflicts/not-a-uuid/unmerge').send();
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
    mockDb.query
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

    const identifierMoveCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE identifier_link')
    );
    expect(identifierMoveCall).toBeUndefined();
  });

  test('R3-C: fan_id_b record is completely unchanged after 409 — no UPDATE fan', async () => {
    setupDeletedFanA();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const fanUpdateCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE fan')
    );
    expect(fanUpdateCall).toBeUndefined();
  });

  test('R3-D: conflict_queue status remains pending after 409 — no UPDATE conflict_queue', async () => {
    setupDeletedFanA();

    await request(app).post(`/v1/conflicts/${CONFLICT_ID}/confirm`).send();

    const conflictUpdateCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('UPDATE conflict_queue')
    );
    expect(conflictUpdateCall).toBeUndefined();
  });
});
