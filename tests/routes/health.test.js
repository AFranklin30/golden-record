'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const request   = require('supertest');

// MEDIUM-3 — rate limit the health endpoint
// Tests use an isolated Express app that mirrors the healthLimitedRouter
// configuration in index.js (windowMs: 60000, max: 10).
// Each test suite gets a fresh app so counts don't bleed across tests.

function buildHealthApp(max = 10) {
  const limiter = rateLimit({
    windowMs:        60000,
    max,
    standardHeaders: true,
    legacyHeaders:   false,
  });

  const app = express();
  app.use(limiter);
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  return app;
}

describe('GET /health — rate limiter (MEDIUM-3)', () => {
  test('first 10 requests within 60 seconds all succeed', async () => {
    const app = buildHealthApp();

    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    }
  });

  test('returns 429 on the 11th request within 60 seconds', async () => {
    const app = buildHealthApp();

    for (let i = 0; i < 10; i++) {
      await request(app).get('/health');
    }

    const res = await request(app).get('/health');
    expect(res.status).toBe(429);
  });

  test('RateLimit-Limit header is present on responses', async () => {
    const app = buildHealthApp();

    const res = await request(app).get('/health');
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });
});
