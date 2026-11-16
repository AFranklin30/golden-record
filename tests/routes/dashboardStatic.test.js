'use strict';

const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '../../web/dist/index.html');
const describeBuilt = fs.existsSync(indexPath) ? describe : describe.skip;

describeBuilt('built dashboard served by Express', () => {
  let request;
  let app;

  beforeAll(() => {
    process.env.PORT = '0';
    request = require('supertest');
    app = require('../../index');
  });

  test('a dashboard route returns the application HTML', async () => {
    const res = await request(app).get('/reviews');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('id="root"');
    expect(res.text).not.toContain('Authorization header is missing');
  });

  test('an API route stays JSON when the dashboard files exist', async () => {
    const res = await request(app).get('/v1/dashboard/session');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toBe('unauthorized');
  });
});
