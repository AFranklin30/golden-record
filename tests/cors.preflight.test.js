'use strict';

// Real browser preflight test — the shape the suite otherwise lacks.
// Every other test in this suite drives the app through supertest with no
// Origin header, so no request is ever a CORS preflight and allowedHeaders
// is never exercised (see tasks/lessons.md — server-to-server tests cannot
// see browser-only failure modes). This file sends a real OPTIONS request
// with an Origin header against the actual exported app from index.js, so
// it reflects the real corsOptions.allowedHeaders, not a hand-copied mirror.

const request = require('supertest');
const http    = require('http');

// index.js calls app.listen(PORT) as a side effect of being required.
// Force PORT=0 (OS-assigned free port) and capture the server via the same
// listen-interception pattern as tests/startup/startup.test.js, so it can be
// closed in afterAll instead of leaking an open handle.
process.env.PORT = process.env.PORT || '0';

let serverRef = null;
const origListen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  serverRef = this;
  http.Server.prototype.listen = origListen; // restore after first call
  return origListen.apply(this, args);
};

const app = require('../index');

const ALLOWED_ORIGIN = 'https://fanpass.thunder.com';

describe('CORS preflight — allowedHeaders (browser-only failure mode)', () => {
  let savedCorsOrigin;

  beforeAll(() => {
    savedCorsOrigin = process.env.CORS_ORIGIN;
    process.env.CORS_ORIGIN = ALLOWED_ORIGIN;
  });

  afterAll((done) => {
    if (savedCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = savedCorsOrigin;

    if (serverRef) serverRef.close(done);
    else done();
  });

  test('1. preflight requesting Authorization is allowed', async () => {
    const res = await request(app)
      .options('/v1/resolve')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization');

    expect(res.headers['access-control-allow-headers'].toLowerCase()).toContain('authorization');
  });

  test('2. preflight requesting X-Fan-Token is allowed', async () => {
    const res = await request(app)
      .options('/v1/resolve')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-fan-token');

    expect(res.headers['access-control-allow-headers'].toLowerCase()).toContain('x-fan-token');
  });

  test('3. preflight requesting Content-Type is allowed', async () => {
    const res = await request(app)
      .options('/v1/resolve')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(res.headers['access-control-allow-headers'].toLowerCase()).toContain('content-type');
  });

  // 4 — red-green proof performed manually during implementation by
  // temporarily editing index.js's allowedHeaders and rerunning this file;
  // not encoded here because the `cors` middleware factory bakes
  // allowedHeaders into a closure at require-time (confirmed in
  // node_modules/cors/lib/index.js — configureAllowedHeaders reads the
  // static array once, not per request), so an in-process toggle would
  // require jest.resetModules() + re-require, not a value flip. See
  // check-in report for the actual before/after run.

  test('5. non-matching origin gets no access-control-allow-origin header', async () => {
    const res = await request(app)
      .options('/v1/resolve')
      .set('Origin', 'https://evil.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('6. no Origin header — server-to-server request still succeeds', async () => {
    const res = await request(app).get('/health');

    expect(res.status === 200 || res.status === 503).toBe(true);
    expect(typeof res.body.status).toBe('string');
  });

  test("7. preflight requesting X-Api-Key is NOT allowed — removal is intentional", async () => {
    const res = await request(app)
      .options('/v1/resolve')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-api-key');

    const allowHeader = (res.headers['access-control-allow-headers'] || '').toLowerCase();
    expect(allowHeader).not.toContain('x-api-key');
  });

  test("8. preflight requesting X-Correlation-Id is NOT allowed — removal is intentional", async () => {
    const res = await request(app)
      .options('/v1/resolve')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-correlation-id');

    const allowHeader = (res.headers['access-control-allow-headers'] || '').toLowerCase();
    expect(allowHeader).not.toContain('x-correlation-id');
  });
});
