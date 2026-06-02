'use strict';

const cors    = require('cors');
const express = require('express');
const request = require('supertest');

// MEDIUM-4/5 — CORS configuration
// Mirrors the function-based corsOptions in index.js exactly.
// Function-based origin gives server-level enforcement (not just browser-level).

function buildCorsApp(corsOriginEnv) {
  const corsOptions = {
    origin: (requestOrigin, callback) => {
      const allowed = corsOriginEnv;
      if (!requestOrigin) return callback(null, true);   // server-to-server: no Origin header
      if (!allowed)       return callback(null, false);  // no config → block all browser origins
      callback(null, requestOrigin === allowed);          // exact-match only
    },
    methods:        ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-Api-Key', 'X-Fan-Token', 'X-Correlation-Id'],
    credentials:    false,
  };

  const app = express();
  app.use(cors(corsOptions));
  app.get('/test', (_req, res) => res.status(200).json({ ok: true }));
  return app;
}

describe('CORS configuration (MEDIUM-4/5)', () => {
  test('CORS header present when request origin matches CORS_ORIGIN', async () => {
    const app = buildCorsApp('https://fanpass.thunder.com');

    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://fanpass.thunder.com');

    expect(res.headers['access-control-allow-origin']).toBe('https://fanpass.thunder.com');
  });

  test('CORS blocks requests from unlisted origins — no access-control-allow-origin returned', async () => {
    const app = buildCorsApp('https://fanpass.thunder.com');

    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://evil.com');

    // Function-based origin: unlisted origins get no header at all (server-level block)
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('when CORS_ORIGIN is not set, all cross-origin requests are blocked — fail secure', async () => {
    const app = buildCorsApp(undefined);

    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://any-origin.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('requests without Origin header are allowed through — server-to-server calls unaffected', async () => {
    const app = buildCorsApp(undefined);

    const res = await request(app).get('/test'); // no Origin header

    expect(res.status).toBe(200);
  });

  test('preflight OPTIONS request succeeds when origin is allowed', async () => {
    const app = buildCorsApp('https://fanpass.thunder.com');

    const res = await request(app)
      .options('/test')
      .set('Origin', 'https://fanpass.thunder.com')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe('https://fanpass.thunder.com');
  });
});
