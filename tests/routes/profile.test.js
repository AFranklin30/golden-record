'use strict';

// Must be declared before require() of the module under test.
// jest.mock() is hoisted — intercepts the Firestore constructor used by
// profile.js at module load time.
jest.mock('@google-cloud/firestore', () => ({
  Firestore: jest.fn().mockImplementation(() => ({
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        get: jest.fn().mockResolvedValue({ exists: false }),
      }),
    }),
  })),
}));

const express = require('express');
const request = require('supertest');

const { signToken } = require('../../src/modules/jwt');

const CONTEXT_ORG_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const FAN_ID          = 'cccccccc-0000-0000-0000-000000000003';
const SURVIVOR_FAN_ID = 'dddddddd-0000-0000-0000-000000000004';
const OTHER_FAN_ID    = 'eeeeeeee-0000-0000-0000-000000000005';

let mockDb;

beforeEach(() => {
  jest.clearAllMocks();
  mockDb = { query: jest.fn() };
});

// profile.js embeds jwtMiddleware directly in the route (router.get(path,
// jwtMiddleware, handler)) — unlike household.js/conflicts.js, there's no
// outer router.use() a test can skip mounting. So this test uses the real
// jwtMiddleware + real signToken to produce a valid X-Fan-Token, per the
// root CLAUDE.md rule that middleware-level guards go through the real
// Express app via supertest, not a bypass.
function buildApp(orgId = CONTEXT_ORG_ID) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.context = { org_id: orgId, org_name: 'Test Org', correlation_id: 'test-corr-id' };
    req.db = mockDb;
    next();
  });
  app.use(require('../../src/routes/profile'));
  return app;
}

function tokenFor(fanId, orgId = CONTEXT_ORG_ID) {
  return signToken({ fan_id: fanId, org_id: orgId }).token;
}

function mergedFanRow(id = FAN_ID) {
  return {
    id, org_id: CONTEXT_ORG_ID, stewardship_tier: 'platform', record_version: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    deleted_at: new Date().toISOString(),
  };
}

function activeFanRow(id) {
  return {
    id, org_id: CONTEXT_ORG_ID, stewardship_tier: 'platform', record_version: 2,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    deleted_at: null,
  };
}

describe('GET /v1/fan/:id/profile — canonical ID forwarding (Fix 3)', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  // 7 — a merged-away fan (deleted_at set, active merge_history row) returns
  // the SURVIVOR'S FULL PROFILE (not just an id pointer), plus merged_from,
  // with 200, not 403. A client asking for a profile must not have to make a
  // second call.
  test('a merged-away fan returns the survivor\'s full profile with merged_from, 200 not 403', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [mergedFanRow()] })                          // 0: primary fan lookup (deleted)
      .mockResolvedValueOnce({ rows: [{ fan_id_target: SURVIVOR_FAN_ID }] })       // 1: merge_history lookup
      .mockResolvedValueOnce({ rows: [activeFanRow(SURVIVOR_FAN_ID)] })           // 2: survivor fan lookup
      .mockResolvedValueOnce({ rows: [] });                                       // 3: survivor identifier_link lookup

    const res = await request(app)
      .get(`/v1/fan/${FAN_ID}/profile`)
      .set('X-Fan-Token', tokenFor(FAN_ID));

    expect(res.status).toBe(200);
    expect(res.body.fan_id).toBe(SURVIVOR_FAN_ID);
    expect(res.body.merged_from).toBe(FAN_ID);
    expect(res.body.message).toBe('fan record was merged');
    // The full survivor profile, not just an id pointer.
    expect(res.body.stewardship_tier).toBe('platform');
    expect(res.body.record_version).toBe(2);
    expect(res.body.linked_systems).toEqual([]);
    expect(res.body.wallet).toEqual({ loyalty_points: 0, stamps: [], avatar: null });
    expect(res.body.record_created_at).toBeDefined();
    expect(res.body.record_updated_at).toBeDefined();

    expect(mockDb.query).toHaveBeenCalledTimes(4);
    // identifier_link lookup must be scoped to the SURVIVOR's fan_id, not
    // the requested (merged-away) fan_id.
    expect(mockDb.query.mock.calls[3][1]).toEqual([SURVIVOR_FAN_ID, CONTEXT_ORG_ID]);
  });

  // 8 — regression: a soft-deleted fan with NO merge_history row still 403s
  // 'erased'. Forwarding must not swallow genuine erasure.
  test('a soft-deleted fan with no merge_history row still 403s erased', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [mergedFanRow()] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/v1/fan/${FAN_ID}/profile`)
      .set('X-Fan-Token', tokenFor(FAN_ID));

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('fan record has been erased');
  });

  // 9 — org scoping: the merge_history lookup must be scoped to the
  // authenticated org, not just the fan_id, since it's a cross-fan lookup
  // and isolation is not transitive here.
  test('merge_history lookup is scoped to the authenticated org_id', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [mergedFanRow()] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get(`/v1/fan/${FAN_ID}/profile`)
      .set('X-Fan-Token', tokenFor(FAN_ID));

    const mergeHistoryCall = mockDb.query.mock.calls[1];
    expect(mergeHistoryCall[1]).toEqual([FAN_ID, CONTEXT_ORG_ID]);
  });

  // 10 — JWT verification runs first: url_fan_id === jwt_fan_id enforced
  // before any of this. A mismatched token still 403s, before any db call.
  test('a mismatched token 403s before any db call', async () => {
    const res = await request(app)
      .get(`/v1/fan/${FAN_ID}/profile`)
      .set('X-Fan-Token', tokenFor(OTHER_FAN_ID));

    expect(res.status).toBe(403);
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
