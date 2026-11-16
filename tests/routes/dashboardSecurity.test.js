'use strict';

require('dotenv').config();
process.env.PORT = '0';
process.env.RATE_LIMIT_MAX_REQUESTS = '1000';

const crypto = require('crypto');
const request = require('supertest');
const app = require('../../index');
const pool = require('../../src/db/pool');
const { createOperator } = require('../../src/modules/operatorAuth');

const REJECTED = { error: 'unauthorized', message: 'invalid credentials' };

function assertLocal() {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes('localhost:5432')) {
    throw new Error('dashboard security tests only run against local Postgres on port 5432');
  }
}

async function makeOrg(name) {
  const id = crypto.randomUUID();
  const rawKey = `security-${crypto.randomUUID()}`;
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  await pool.query(
    `INSERT INTO org (id, name, org_api_key_hash, is_active) VALUES ($1, $2, $3, true)`,
    [id, name, hash]
  );
  return { id, rawKey, name };
}

describe('dashboard authentication and authorization', () => {
  let orgA;
  let orgB;
  const password = 'correct-horse';
  const emailA = `a-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const emailB = `b-${crypto.randomUUID().slice(0, 8)}@example.com`;

  beforeAll(async () => {
    assertLocal();
    orgA = await makeOrg('security-org-a');
    orgB = await makeOrg('security-org-b');
    await createOperator(pool, { orgId: orgA.id, email: emailA, password });
    await createOperator(pool, { orgId: orgB.id, email: emailB, password });
  });

  afterAll(async () => {
    for (const orgId of [orgA.id, orgB.id]) {
      await pool.query('DELETE FROM operator_session WHERE org_id = $1', [orgId]);
      await pool.query('DELETE FROM operator WHERE org_id = $1', [orgId]);
      await pool.query('DELETE FROM import_row WHERE org_id = $1', [orgId]);
      await pool.query('DELETE FROM import_batch WHERE org_id = $1', [orgId]);
      await pool.query('DELETE FROM conflict_queue WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM fan WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM org WHERE id = $1', [orgId]).catch(() => {});
    }
    await pool.end();
  });

  test('unknown email, wrong password, inactive operator, and inactive org look the same', async () => {
    const unknown = await request(app).post('/v1/dashboard/session').send({
      email: 'nobody@example.com',
      password,
    });
    const wrong = await request(app).post('/v1/dashboard/session').send({
      email: emailA,
      password: 'wrong-password',
    });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(REJECTED);
    expect(wrong.body).toEqual(unknown.body);
    expect(JSON.stringify(wrong.body)).not.toContain(password);
    expect(JSON.stringify(wrong.body)).not.toContain('wrong-password');

    await pool.query('UPDATE operator SET is_active = false WHERE email = $1', [emailA]);
    const inactiveOperator = await request(app).post('/v1/dashboard/session').send({
      email: emailA,
      password,
    });
    expect(inactiveOperator.status).toBe(401);
    expect(inactiveOperator.body).toEqual(REJECTED);
    await pool.query('UPDATE operator SET is_active = true WHERE email = $1', [emailA]);

    await pool.query('UPDATE org SET is_active = false WHERE id = $1', [orgA.id]);
    const inactiveOrg = await request(app).post('/v1/dashboard/session').send({
      email: emailA,
      password,
    });
    expect(inactiveOrg.status).toBe(401);
    expect(inactiveOrg.body).toEqual(REJECTED);
    await pool.query('UPDATE org SET is_active = true WHERE id = $1', [orgA.id]);
  });

  test('a non-string password is rejected and a quote in the email is not a server error', async () => {
    const shaped = await request(app).post('/v1/dashboard/session').send({
      email: emailA,
      password: { bad: true },
    });
    expect(shaped.status).toBe(400);
    expect(JSON.stringify(shaped.body)).not.toContain('password_hash');

    const injected = await request(app).post('/v1/dashboard/session').send({
      email: "' OR 1=1 --",
      password,
    });
    expect(injected.status).toBe(401);
    expect(injected.body).toEqual(REJECTED);
    const orgs = await pool.query('SELECT count(*)::int AS n FROM org WHERE id = ANY($1::uuid[])', [[orgA.id, orgB.id]]);
    expect(orgs.rows[0].n).toBe(2);
  });

  test('sign-out and an expired cookie are both rejected', async () => {
    const agent = request.agent(app);
    const signed = await agent.post('/v1/dashboard/session').send({ email: emailA, password });
    expect(signed.status).toBe(200);
    const cookie = signed.headers['set-cookie'].join(';').toLowerCase();
    expect(cookie).toContain('httponly');
    expect(cookie).toContain('samesite=lax');
    expect(JSON.stringify(signed.body)).not.toContain(orgA.rawKey);

    const signedOut = await agent.delete('/v1/dashboard/session');
    expect(signedOut.status).toBe(200);
    const after = await agent.get('/v1/dashboard/imports');
    expect(after.status).toBe(401);

    const again = request.agent(app);
    await again.post('/v1/dashboard/session').send({ email: emailA, password });
    await pool.query(
      `UPDATE operator_session SET expires_at = NOW() - INTERVAL '1 minute' WHERE org_id = $1`,
      [orgA.id]
    );
    const expired = await again.get('/v1/dashboard/session');
    expect(expired.status).toBe(401);
  });

  test('one organization cannot read or confirm another organization', async () => {
    const batchId = crypto.randomUUID();
    const fanA = crypto.randomUUID();
    const fanB = crypto.randomUUID();
    const conflictId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO import_batch (id, org_id, filename) VALUES ($1, $2, 'secret.csv')`,
      [batchId, orgB.id]
    );
    await pool.query('INSERT INTO fan (id, org_id) VALUES ($1, $2), ($3, $2)', [fanA, orgB.id, fanB]);
    await pool.query(
      `INSERT INTO conflict_queue
         (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status)
       VALUES ($1, $2, $3, $4, 0.700, '[]'::jsonb, 'pending')`,
      [conflictId, fanA, fanB, orgB.id]
    );

    const agent = request.agent(app);
    await agent.post('/v1/dashboard/session').send({ email: emailA, password });

    const list = await agent.get('/v1/dashboard/imports');
    expect(list.status).toBe(200);
    expect(list.body.imports.map((row) => row.id)).not.toContain(batchId);

    const detail = await agent.get(`/v1/dashboard/imports/${batchId}`);
    expect(detail.status).toBe(404);

    const review = await agent.get(`/v1/dashboard/reviews/${conflictId}`);
    expect(review.status).toBe(404);

    const confirmed = await agent.post(`/v1/dashboard/conflicts/${conflictId}/confirm`).send({
      org_id: orgB.id,
    });
    expect(confirmed.status).toBe(404);
    const stillThere = await pool.query('SELECT deleted_at FROM fan WHERE id = $1', [fanB]);
    expect(stillThere.rows[0].deleted_at).toBeNull();

    const apiExport = await agent.get('/v1/export/fans');
    expect(apiExport.status).toBe(401);
  });
});
