'use strict';

require('dotenv').config();
process.env.PORT = '0';

const crypto = require('crypto');
const request = require('supertest');
const app = require('../../index');
const pool = require('../../src/db/pool');
const { createOperator } = require('../../src/modules/operatorAuth');

function assertLocal() {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes('localhost:5432')) {
    throw new Error('dashboard tests only run against local Postgres on port 5432');
  }
}

describe('dashboard session', () => {
  const orgId = crypto.randomUUID();
  const rawKey = `dashboard-test-${crypto.randomUUID()}`;
  const email = `operator-${orgId.slice(0, 8)}@example.com`;
  const password = 'correct-horse';
  let agent;

  beforeAll(async () => {
    assertLocal();
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    await pool.query(
      `INSERT INTO org (id, name, org_api_key_hash, is_active) VALUES ($1, $2, $3, true)`,
      [orgId, 'dashboard-test', hash]
    );
    await createOperator(pool, { orgId, email, password });
    agent = request.agent(app);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM operator_session WHERE org_id = $1', [orgId]);
    await pool.query('DELETE FROM operator WHERE org_id = $1', [orgId]).catch(() => {});
    await pool.query('DELETE FROM import_row WHERE org_id = $1', [orgId]);
    await pool.query('DELETE FROM import_batch WHERE org_id = $1', [orgId]);
    await pool.query('DELETE FROM merge_history WHERE org_id = $1', [orgId]).catch(() => {});
    await pool.query('DELETE FROM conflict_queue WHERE org_id = $1', [orgId]).catch(() => {});
    await pool.query('DELETE FROM identifier_link WHERE org_id = $1', [orgId]).catch(() => {});
    await pool.query('DELETE FROM fan WHERE org_id = $1', [orgId]).catch(() => {});
    await pool.query('DELETE FROM org WHERE id = $1', [orgId]).catch(() => {});
    await pool.end();
  });

  test('sign-in does not require or return the organization API key', async () => {
    const missing = await request(app).get('/v1/dashboard/session');
    expect(missing.status).toBe(401);

    const signed = await agent
      .post('/v1/dashboard/session')
      .send({ email, password });
    expect(signed.status).toBe(200);
    expect(signed.body.email).toBe(email);
    expect(JSON.stringify(signed.body)).not.toContain(rawKey);
    expect(signed.headers['set-cookie'].join(';').toLowerCase()).toContain('httponly');

    const me = await agent.get('/v1/dashboard/session');
    expect(me.status).toBe(200);
    expect(me.body.org_name).toBe('dashboard-test');

    const audit = await pool.query(
      `SELECT count(*)::int AS n
         FROM audit_log
        WHERE org_id = $1
          AND event_type = 'dashboard_session_issued'
          AND status = 'success'`,
      [orgId]
    );
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  test('preview writes nothing and import stores a person', async () => {
    const bad = await agent.post('/v1/dashboard/imports/preview').send({
      csv: 'zip\n78701\n',
    });
    expect(bad.status).toBe(200);
    expect(bad.body.error_count).toBe(1);
    const fans = await pool.query('SELECT count(*)::int AS n FROM fan WHERE org_id = $1', [orgId]);
    expect(fans.rows[0].n).toBe(0);

    const imported = await agent.post('/v1/dashboard/imports').send({
      csv: 'first_name,last_name,email,birthday,zip,phone\nAda,Lovelace,ada@example.com,1990-01-15,78701,5125550199\n',
      filename: 'one.csv',
    });
    expect(imported.status).toBe(200);
    expect(imported.body.error_count).toBe(0);
    expect(imported.body.rows[0].status).toBe('complete');

    const listed = await agent.get('/v1/dashboard/imports');
    expect(listed.status).toBe(200);
    expect(listed.body.imports.length).toBeGreaterThan(0);
  });

  test('confirm uses the session and the existing conflict route', async () => {
    const fanA = crypto.randomUUID();
    const fanB = crypto.randomUUID();
    const conflictId = crypto.randomUUID();
    await pool.query('INSERT INTO fan (id, org_id) VALUES ($1, $2), ($3, $2)', [fanA, orgId, fanB]);
    await pool.query(
      `INSERT INTO conflict_queue
         (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status)
       VALUES ($1, $2, $3, $4, 0.700, '[]'::jsonb, 'pending')`,
      [conflictId, fanA, fanB, orgId]
    );

    const confirmed = await agent.post(`/v1/dashboard/conflicts/${conflictId}/confirm`).send({});
    expect(confirmed.status).toBe(200);

    const fan = await pool.query('SELECT deleted_at FROM fan WHERE id = $1', [fanB]);
    expect(fan.rows[0].deleted_at).not.toBeNull();

    const exported = await agent.get('/v1/dashboard/exports/fans');
    expect(exported.status).toBe(200);
    expect(exported.text).toContain(fanA);
    expect(exported.text.split('\n').slice(1).map((line) => line.split(',')[0])).not.toContain(fanB);
  });
});
