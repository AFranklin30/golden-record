'use strict';

require('dotenv').config();
process.env.PORT = '0';

const crypto = require('crypto');
const request = require('supertest');
const app = require('../../index');
const pool = require('../../src/db/pool');

function assertLocal() {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes('localhost:5432')) {
    throw new Error('health tests only run against local Postgres on port 5432');
  }
}

async function makeOrg(name) {
  const id = crypto.randomUUID();
  const rawKey = `health-${crypto.randomUUID()}`;
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  await pool.query(
    `INSERT INTO org (id, name, org_api_key_hash, is_active) VALUES ($1, $2, $3, true)`,
    [id, name, hash]
  );
  return { id, rawKey };
}

async function addFailure(orgId, status) {
  await pool.query(
    `INSERT INTO ingest_failures
       (org_id, source_system, raw_payload, reason_code, error_detail, status)
     VALUES ($1, 'nfc', '{}'::jsonb, 'normalization_error', 'health isolation fixture', $2)`,
    [orgId, status]
  );
}

describe('GET /health queue depth', () => {
  let orgA;
  let orgB;

  beforeAll(async () => {
    assertLocal();
    orgA = await makeOrg('health-a');
    orgB = await makeOrg('health-b');
    await addFailure(orgA.id, 'pending');
    await addFailure(orgA.id, 'retried');
    await addFailure(orgB.id, 'pending');
    await addFailure(orgB.id, 'pending');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM ingest_failures WHERE org_id = ANY($1::uuid[])', [[orgA.id, orgB.id]]);
    await pool.query('DELETE FROM org WHERE id = ANY($1::uuid[])', [[orgA.id, orgB.id]]);
    await pool.end();
  });

  test('an organization key counts only that organization\'s pending rows', async () => {
    const responseA = await request(app)
      .get('/health')
      .set('Authorization', `Bearer ${orgA.rawKey}`);
    expect(responseA.status).toBe(200);
    expect(responseA.body.queue_depth).toBe(1);

    const responseB = await request(app)
      .get('/health')
      .set('Authorization', `Bearer ${orgB.rawKey}`);
    expect(responseB.status).toBe(200);
    expect(responseB.body.queue_depth).toBe(2);
  });

  test('a request without a key does not report a queue depth', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.queue_depth).toBeUndefined();
  });
});
