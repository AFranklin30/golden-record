'use strict';

require('dotenv').config();
process.env.PORT = '0';
process.env.RATE_LIMIT_MAX_REQUESTS = '1000';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const app = require('../../index');
const pool = require('../../src/db/pool');
const dashboardRouter = require('../../src/routes/dashboard');
const rlsContextMiddleware = require('../../src/middleware/rlsContextMiddleware');
const { createOperator } = require('../../src/modules/operatorAuth');

function assertLocal() {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes('localhost:5432')) {
    throw new Error('admin safety tests only run against local Postgres on port 5432');
  }
}

async function makeOrg(name) {
  const id = crypto.randomUUID();
  const rawKey = `safety-${crypto.randomUUID()}`;
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  await pool.query(
    `INSERT INTO org (id, name, org_api_key_hash, is_active) VALUES ($1, $2, $3, true)`,
    [id, name, hash]
  );
  return { id, rawKey, name };
}

describe('admin safety fixes (migration_022, last-admin lock, promoteOperator, generic 409)', () => {
  const createdOrgIds = [];
  const password = 'correct-horse-safety';
  const suffix = crypto.randomUUID().slice(0, 8);
  const migration022Sql = fs.readFileSync(
    path.join(__dirname, '../../migrations/migration_022.sql'),
    'utf8'
  );

  beforeAll(() => {
    assertLocal();
  });

  afterAll(async () => {
    for (const orgId of createdOrgIds) {
      await pool.query('DELETE FROM operator_session WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM operator WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM org WHERE id = $1', [orgId]).catch(() => {});
    }
    await pool.end();
  });

  test('migration_022 promotes the earliest active operator when no admin exists and does nothing on a second run', async () => {
    const org = await makeOrg(`mig022-org-${suffix}`);
    createdOrgIds.push(org.id);

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');

    // Insert an inactive earliest operator, an active earliest operator, and an active later operator — all role='operator'
    const inactiveId = crypto.randomUUID();
    const earliestActiveId = crypto.randomUUID();
    const laterActiveId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO operator (id, org_id, email, role, password_salt, password_hash, is_active, created_at)
       VALUES
         ($1, $4, $5, 'operator', $8, $9, false, NOW() - INTERVAL '3 hours'),
         ($2, $4, $6, 'operator', $8, $9, true,  NOW() - INTERVAL '2 hours'),
         ($3, $4, $7, 'operator', $8, $9, true,  NOW() - INTERVAL '1 hour')`,
      [
        inactiveId,
        earliestActiveId,
        laterActiveId,
        org.id,
        `mig022-inactive-${suffix}@example.com`,
        `mig022-earliest-${suffix}@example.com`,
        `mig022-later-${suffix}@example.com`,
        salt,
        hash,
      ]
    );

    // First run promotes earliestActiveId only
    await pool.query(migration022Sql);
    const afterFirst = await pool.query(
      `SELECT id, role FROM operator WHERE org_id = $1 ORDER BY created_at ASC`,
      [org.id]
    );
    expect(afterFirst.rows).toEqual([
      { id: inactiveId, role: 'operator' },
      { id: earliestActiveId, role: 'admin' },
      { id: laterActiveId, role: 'operator' },
    ]);

    // Second run is a safe no-op
    await pool.query(migration022Sql);
    const afterSecond = await pool.query(
      `SELECT id, role FROM operator WHERE org_id = $1 ORDER BY created_at ASC`,
      [org.id]
    );
    expect(afterSecond.rows).toEqual(afterFirst.rows);
  });

  test('two concurrent admin-deactivates-admin requests leave one active admin', async () => {
    const org = await makeOrg(`race-org-${suffix}`);
    createdOrgIds.push(org.id);

    const admin1 = await createOperator(pool, {
      orgId: org.id,
      email: `race-a1-${suffix}@example.com`,
      password,
    });
    const admin2 = await createOperator(pool, {
      orgId: org.id,
      email: `race-a2-${suffix}@example.com`,
      password,
      role: 'admin',
    });
    expect(admin1.role).toBe('admin');
    expect(admin2.role).toBe('admin');

    const agent1 = request.agent(app);
    const agent2 = request.agent(app);
    expect((await agent1.post('/v1/dashboard/session').send({ email: admin1.email, password })).status).toBe(200);
    expect((await agent2.post('/v1/dashboard/session').send({ email: admin2.email, password })).status).toBe(200);

    const [res1, res2] = await Promise.all([
      agent1.post(`/v1/dashboard/operators/${admin2.id}/deactivate`).send({}),
      agent2.post(`/v1/dashboard/operators/${admin1.id}/deactivate`).send({}),
    ]);

    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    expect(statuses[0]).toBe(200);
    expect([401, 409]).toContain(statuses[1]);

    const activeAdmins = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM operator
        WHERE org_id = $1 AND is_active = true AND role = 'admin'`,
      [org.id]
    );
    expect(activeAdmins.rows[0].n).toBe(1);
  });

  test('deactivating the last active admin returns 409', async () => {
    const org = await makeOrg(`last-admin-org-${suffix}`);
    createdOrgIds.push(org.id);

    const soleAdmin = await createOperator(pool, {
      orgId: org.id,
      email: `sole-admin-${suffix}@example.com`,
      password,
    });

    // Mount dashboardRouter with a distinct acting admin context to deterministically
    // exercise the last-active-admin guard (distinct from the self-deactivation guard).
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      req.context = {
        org_id: org.id,
        org_name: org.name,
        principal_type: 'operator',
        operator_id: crypto.randomUUID(),
        operator_email: `acting-admin-${suffix}@example.com`,
        operator_role: 'admin',
        correlation_id: 'last-admin-test',
      };
      next();
    });
    testApp.use(rlsContextMiddleware);
    testApp.use(dashboardRouter);

    const res = await request(testApp)
      .post(`/v1/dashboard/operators/${soleAdmin.id}/deactivate`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot deactivate the last active admin');

    const stillActive = await pool.query('SELECT is_active FROM operator WHERE id = $1', [soleAdmin.id]);
    expect(stillActive.rows[0].is_active).toBe(true);
  });

  test('after all operators are deactivated, the next operator created becomes admin', async () => {
    const org = await makeOrg(`rebootstrap-org-${suffix}`);
    createdOrgIds.push(org.id);

    const first = await createOperator(pool, {
      orgId: org.id,
      email: `first-deact-${suffix}@example.com`,
      password,
    });
    expect(first.role).toBe('admin');

    await pool.query('UPDATE operator SET is_active = false WHERE org_id = $1', [org.id]);

    const nextOp = await createOperator(pool, {
      orgId: org.id,
      email: `second-rebootstrap-${suffix}@example.com`,
      password,
    });
    expect(nextOp.role).toBe('admin');
  });

  test('scripts/promoteOperator.js promotes an active operator to admin and writes an audit row', async () => {
    const org = await makeOrg(`promote-org-${suffix}`);
    createdOrgIds.push(org.id);

    await createOperator(pool, {
      orgId: org.id,
      email: `promote-admin-${suffix}@example.com`,
      password,
    });
    const regular = await createOperator(pool, {
      orgId: org.id,
      email: `promote-target-${suffix}@example.com`,
      password,
    });
    expect(regular.role).toBe('operator');

    const output = execFileSync(
      process.execPath,
      [
        path.join(__dirname, '../../scripts/promoteOperator.js'),
        `--org=${org.id}`,
        `--email=${regular.email}`,
      ],
      { encoding: 'utf8', env: process.env }
    );
    expect(output).toContain(`operator ${regular.email} promoted to admin`);

    const stored = await pool.query('SELECT role FROM operator WHERE id = $1', [regular.id]);
    expect(stored.rows[0].role).toBe('admin');

    const audit = await pool.query(
      `SELECT event_type, actor_type, operator_id, actor_email, status
         FROM audit_log
        WHERE org_id = $1 AND event_type = 'operator_promoted'
        ORDER BY created_at DESC
        LIMIT 1`,
      [org.id]
    );
    expect(audit.rows[0]).toEqual({
      event_type: 'operator_promoted',
      actor_type: 'system',
      operator_id: regular.id,
      actor_email: regular.email,
      status: 'success',
    });
  });

  test('duplicate email returns a generic 409 that does not reveal cross-org existence', async () => {
    const orgA = await makeOrg(`dup-a-${suffix}`);
    const orgB = await makeOrg(`dup-b-${suffix}`);
    createdOrgIds.push(orgA.id, orgB.id);

    const adminA = await createOperator(pool, {
      orgId: orgA.id,
      email: `dup-admin-a-${suffix}@example.com`,
      password,
    });
    const adminB = await createOperator(pool, {
      orgId: orgB.id,
      email: `dup-admin-b-${suffix}@example.com`,
      password,
    });

    const agentA = request.agent(app);
    await agentA.post('/v1/dashboard/session').send({ email: adminA.email, password });

    // Duplicate email within same org
    const sameOrgDup = await agentA.post('/v1/dashboard/operators').send({
      email: adminA.email,
      password,
    });
    expect(sameOrgDup.status).toBe(409);
    expect(sameOrgDup.body).toEqual({ error: 'operator could not be created' });

    // Duplicate email belonging to another org — must return the exact same generic 409
    const crossOrgDup = await agentA.post('/v1/dashboard/operators').send({
      email: adminB.email,
      password,
    });
    expect(crossOrgDup.status).toBe(409);
    expect(crossOrgDup.body).toEqual(sameOrgDup.body);
    expect(JSON.stringify(crossOrgDup.body).toLowerCase()).not.toContain('exists');
  });
});
