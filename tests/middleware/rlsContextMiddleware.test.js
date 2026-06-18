'use strict';

jest.mock('../../src/db/pool', () => ({
  connect: jest.fn(),
}));

const pool = require('../../src/db/pool');
const rlsContextMiddleware = require('../../src/middleware/rlsContextMiddleware');

const ORG_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

let mockClient;

beforeEach(() => {
  jest.clearAllMocks();
  mockClient = { query: jest.fn().mockResolvedValue({}), release: jest.fn() };
  pool.connect.mockResolvedValue(mockClient);
});

function buildReq(orgId = ORG_ID) {
  return { context: orgId ? { org_id: orgId } : {} };
}

function buildRes() {
  const handlers = {};
  return {
    status: jest.fn().mockReturnThis(),
    json:   jest.fn().mockReturnThis(),
    on:     jest.fn((event, fn) => { handlers[event] = fn; }),
    _fire:  (event) => { if (handlers[event]) handlers[event](); },
  };
}

describe('rlsContextMiddleware — happy path', () => {

  test('calls pool.connect()', async () => {
    const req  = buildReq();
    const res  = buildRes();
    const next = jest.fn();

    await rlsContextMiddleware(req, res, next);

    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  test('fires set_config with org_id', async () => {
    const req  = buildReq();
    const res  = buildRes();
    const next = jest.fn();

    await rlsContextMiddleware(req, res, next);

    const setConfigCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('set_config')
    );
    expect(setConfigCall).toBeDefined();
    expect(setConfigCall[1][1]).toBe(ORG_ID);
  });

  test('attaches client to req.db', async () => {
    const req  = buildReq();
    const res  = buildRes();
    const next = jest.fn();

    await rlsContextMiddleware(req, res, next);

    expect(req.db).toBe(mockClient);
  });

  test('calls next()', async () => {
    const req  = buildReq();
    const res  = buildRes();
    const next = jest.fn();

    await rlsContextMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

});

describe('rlsContextMiddleware — missing org_id guard', () => {

  test('returns 500 when org_id is missing from context', async () => {
    const req  = buildReq(null);
    const res  = buildRes();
    const next = jest.fn();

    await rlsContextMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  test('pool.connect() is never called when org_id missing', async () => {
    const req  = buildReq(null);
    const res  = buildRes();
    const next = jest.fn();

    await rlsContextMiddleware(req, res, next);

    expect(pool.connect).not.toHaveBeenCalled();
  });

});

describe('rlsContextMiddleware — pool.connect() failure', () => {

  test('returns 500 when pool.connect() throws', async () => {
    pool.connect.mockRejectedValue(new Error('connection refused'));
    const req  = buildReq();
    const res  = buildRes();
    const next = jest.fn();

    await rlsContextMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  test('client.release() is not called when pool.connect() throws', async () => {
    pool.connect.mockRejectedValue(new Error('connection refused'));
    const req  = buildReq();
    const res  = buildRes();
    const next = jest.fn();

    await rlsContextMiddleware(req, res, next);

    expect(mockClient.release).not.toHaveBeenCalled();
  });

});

describe('rlsContextMiddleware — set_config failure', () => {

  test('returns 500 when set_config query throws', async () => {
    mockClient.query.mockRejectedValue(new Error('set_config failed'));
    const req  = buildReq();
    const res  = buildRes();
    const next = jest.fn();

    await rlsContextMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });

  test('client.release() called exactly once when set_config throws', async () => {
    mockClient.query.mockRejectedValue(new Error('set_config failed'));
    const req  = buildReq();
    const res  = buildRes();
    const next = jest.fn();

    await rlsContextMiddleware(req, res, next);

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

});

describe('rlsContextMiddleware — double-release guard', () => {

  test('res.finish fires: client.release() called once', async () => {
    const req  = buildReq();
    const res  = buildRes();
    const next = jest.fn();

    await rlsContextMiddleware(req, res, next);
    res._fire('finish');

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  test('res.finish + res.close both fire: client.release() called ONCE', async () => {
    const req  = buildReq();
    const res  = buildRes();
    const next = jest.fn();

    await rlsContextMiddleware(req, res, next);
    res._fire('finish');
    res._fire('close');

    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

});
