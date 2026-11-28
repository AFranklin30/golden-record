'use strict';

require('dotenv').config();
process.env.PORT = '0';
process.env.RATE_LIMIT_MAX_REQUESTS = '1000';

const crypto = require('crypto');
const request = require('supertest');
const app = require('../../index');
const pool = require('../../src/db/pool');
const { createOperator } = require('../../src/modules/operatorAuth');

function assertLocal() {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes('localhost:5432')) {
    throw new Error('authorization tests only run against local Postgres on port 5432');
  }
}

async function makeOrg(name) {
  const id = crypto.randomUUID();
  const rawKey = `authz-${crypto.randomUUID()}`;
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  await pool.query(
    `INSERT INTO org (id, name, org_api_key_hash, is_active) VALUES ($1, $2, $3, true)`,
    [id, name, hash]
  );
  return { id, rawKey, name };
}

async function seedConflict(orgId) {
  const fanA = crypto.randomUUID();
  const fanB = crypto.randomUUID();
  const conflictId = crypto.randomUUID();
  await pool.query('INSERT INTO fan (id, org_id) VALUES ($1, $2), ($3, $2)', [fanA, orgId, fanB]);
  await pool.query(
    `INSERT INTO identifier_link
       (fan_id, org_id, identifier_type, identifier_value, source_system, schema_version, confidence_score)
     VALUES ($1, $2, 'email', $3, 'csv_import', '1.0', 1.0),
            ($4, $2, 'email', $5, 'csv_import', '1.0', 1.0)`,
    [fanA, orgId, `a-${fanA.slice(0, 8)}@example.com`, fanB, `b-${fanB.slice(0, 8)}@example.com`]
  );
  await pool.query(
    `INSERT INTO conflict_queue
       (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status)
     VALUES ($1, $2, $3, $4, 0.720, '[{"signal":"name_plus_dob"}]'::jsonb, 'pending')`,
    [conflictId, fanA, fanB, orgId]
  );
  return { fanA, fanB, conflictId };
}

describe('operator authorization, management, integration separation, and attribution', () => {
  let orgA;
  let orgB;
  let adminA;
  let regularA;
  let adminB;
  const password = 'correct-horse-authz';
  const suffix = crypto.randomUUID().slice(0, 8);

  beforeAll(async () => {
    assertLocal();
    orgA = await makeOrg(`authz-org-a-${suffix}`);
    orgB = await makeOrg(`authz-org-b-${suffix}`);

    adminA = await createOperator(pool, {
      orgId: orgA.id,
      email: `admin-a-${suffix}@example.com`,
      password,
    });
    regularA = await createOperator(pool, {
      orgId: orgA.id,
      email: `operator-a-${suffix}@example.com`,
      password,
    });
    adminB = await createOperator(pool, {
      orgId: orgB.id,
      email: `admin-b-${suffix}@example.com`,
      password,
    });
  });

  afterAll(async () => {
    for (const orgId of [orgA.id, orgB.id]) {
      await pool.query('DELETE FROM operator_session WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM export_run WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM merge_history WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM related_fans WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM import_row WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM import_batch WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM identifier_link WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM conflict_queue WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM resolution_trace WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM fan WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM operator WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM org WHERE id = $1', [orgId]).catch(() => {});
    }
    await pool.end();
  });

  test('first operator per organization becomes admin and second becomes regular operator', async () => {
    expect(adminA.role).toBe('admin');
    expect(regularA.role).toBe('operator');
    expect(adminB.role).toBe('admin');

    const agent = request.agent(app);
    const signIn = await agent.post('/v1/dashboard/session').send({
      email: adminA.email,
      password,
    });
    expect(signIn.status).toBe(200);
    expect(signIn.body.role).toBe('admin');
    expect(signIn.body.operator_id).toBe(adminA.id);

    const session = await agent.get('/v1/dashboard/session');
    expect(session.status).toBe(200);
    expect(session.body).toEqual({
      operator_id: adminA.id,
      email: adminA.email,
      role: 'admin',
      org_name: orgA.name,
    });

    const loginAudit = await pool.query(
      `SELECT actor_type, operator_id, actor_email
         FROM audit_log
        WHERE org_id = $1 AND event_type = 'dashboard_session_issued'
        ORDER BY created_at DESC
        LIMIT 1`,
      [orgA.id]
    );
    expect(loginAudit.rows[0]).toEqual({
      actor_type: 'operator',
      operator_id: adminA.id,
      actor_email: adminA.email,
    });
  });

  test('admin can list, create, and deactivate operators in own org only; deactivation revokes active sessions', async () => {
    const adminAgent = request.agent(app);
    await adminAgent.post('/v1/dashboard/session').send({ email: adminA.email, password });

    // List only own org operators
    const listed = await adminAgent.get('/v1/dashboard/operators');
    expect(listed.status).toBe(200);
    const listedEmails = listed.body.operators.map((op) => op.email);
    expect(listedEmails).toContain(adminA.email);
    expect(listedEmails).toContain(regularA.email);
    expect(listedEmails).not.toContain(adminB.email);

    // Admin cannot deactivate self
    const selfDeactivate = await adminAgent.post(`/v1/dashboard/operators/${adminA.id}/deactivate`).send({});
    expect(selfDeactivate.status).toBe(409);

    // Admin cannot deactivate another org's operator
    const crossDeactivate = await adminAgent.post(`/v1/dashboard/operators/${adminB.id}/deactivate`).send({
      org_id: orgB.id,
    });
    expect(crossDeactivate.status).toBe(404);

    // Create a new regular operator (body org_id spoof must be ignored)
    const tempEmail = `temp-op-${suffix}@example.com`;
    const created = await adminAgent.post('/v1/dashboard/operators').send({
      email: tempEmail,
      password,
      org_id: orgB.id,
    });
    expect(created.status).toBe(201);
    expect(created.body.operator.email).toBe(tempEmail);
    expect(created.body.operator.role).toBe('operator');
    expect(created.body.operator.is_active).toBe(true);

    const createdId = created.body.operator.id;
    const storedOp = await pool.query('SELECT org_id, role FROM operator WHERE id = $1', [createdId]);
    expect(storedOp.rows[0]).toEqual({ org_id: orgA.id, role: 'operator' });

    // Temp operator signs in and has a live session
    const tempAgent = request.agent(app);
    const tempLogin = await tempAgent.post('/v1/dashboard/session').send({ email: tempEmail, password });
    expect(tempLogin.status).toBe(200);
    expect((await tempAgent.get('/v1/dashboard/session')).status).toBe(200);

    // Admin deactivates temp operator
    const deactivated = await adminAgent.post(`/v1/dashboard/operators/${createdId}/deactivate`).send({});
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.operator.is_active).toBe(false);

    // Existing session is immediately rejected and sign-in fails
    expect((await tempAgent.get('/v1/dashboard/session')).status).toBe(401);
    expect((await tempAgent.post('/v1/dashboard/session').send({ email: tempEmail, password })).status).toBe(401);

    // Audit attribution for operator_created and operator_deactivated
    const opAudits = await pool.query(
      `SELECT event_type, actor_type, operator_id, actor_email
         FROM audit_log
        WHERE org_id = $1 AND event_type IN ('operator_created', 'operator_deactivated')
        ORDER BY created_at ASC`,
      [orgA.id]
    );
    expect(opAudits.rows.map((r) => r.event_type)).toEqual(['operator_created', 'operator_deactivated']);
    for (const row of opAudits.rows) {
      expect(row.actor_type).toBe('operator');
      expect(row.operator_id).toBe(adminA.id);
      expect(row.actor_email).toBe(adminA.email);
    }
  });

  test('regular operator cannot manage operators, even when spoofing role in request body', async () => {
    const opAgent = request.agent(app);
    const login = await opAgent.post('/v1/dashboard/session').send({ email: regularA.email, password });
    expect(login.status).toBe(200);
    expect(login.body.role).toBe('operator');

    const listRes = await opAgent.get('/v1/dashboard/operators');
    expect(listRes.status).toBe(403);

    const createRes = await opAgent.post('/v1/dashboard/operators').send({
      email: `blocked-${suffix}@example.com`,
      password,
      role: 'admin',
      operator_role: 'admin',
      operator_id: adminA.id,
    });
    expect(createRes.status).toBe(403);

    const deactivateRes = await opAgent.post(`/v1/dashboard/operators/${adminA.id}/deactivate`).send({
      operator_role: 'admin',
      operator_id: adminA.id,
    });
    expect(deactivateRes.status).toBe(403);
  });

  test('regular operator can review, confirm, unmerge, reject, import, and export with accurate attribution', async () => {
    const opAgent = request.agent(app);
    await opAgent.post('/v1/dashboard/session').send({ email: regularA.email, password });

    // Confirm + unmerge
    const c1 = await seedConflict(orgA.id);
    const confirmRes = await opAgent.post(`/v1/dashboard/conflicts/${c1.conflictId}/confirm`).send({
      operator_id: adminA.id,
      operator_email: adminA.email,
    });
    expect(confirmRes.status).toBe(200);

    const afterConfirmQueue = await pool.query(
      'SELECT status, reviewed_by FROM conflict_queue WHERE id = $1',
      [c1.conflictId]
    );
    expect(afterConfirmQueue.rows[0]).toEqual({
      status: 'confirmed',
      reviewed_by: regularA.email,
    });

    const afterConfirmMerge = await pool.query(
      'SELECT merged_by, reversed_by FROM merge_history WHERE conflict_id = $1',
      [c1.conflictId]
    );
    expect(afterConfirmMerge.rows[0]).toEqual({
      merged_by: regularA.email,
      reversed_by: null,
    });

    const reviewDetail = await opAgent.get(`/v1/dashboard/reviews/${c1.conflictId}`);
    expect(reviewDetail.status).toBe(200);
    expect(reviewDetail.body.reviewed_by).toBe(regularA.email);

    const unmergeRes = await opAgent.post(`/v1/dashboard/conflicts/${c1.conflictId}/unmerge`).send({});
    expect(unmergeRes.status).toBe(200);

    const afterUnmergeMerge = await pool.query(
      'SELECT status, merged_by, reversed_by FROM merge_history WHERE conflict_id = $1',
      [c1.conflictId]
    );
    expect(afterUnmergeMerge.rows[0]).toEqual({
      status: 'reversed',
      merged_by: regularA.email,
      reversed_by: regularA.email,
    });

    // Reject
    const c2 = await seedConflict(orgA.id);
    const rejectRes = await opAgent.post(`/v1/dashboard/conflicts/${c2.conflictId}/reject`).send({});
    expect(rejectRes.status).toBe(200);

    const afterRejectQueue = await pool.query(
      'SELECT status, reviewed_by FROM conflict_queue WHERE id = $1',
      [c2.conflictId]
    );
    expect(afterRejectQueue.rows[0]).toEqual({
      status: 'rejected',
      reviewed_by: regularA.email,
    });

    // Audit log attribution for confirm, unmerge, reject
    const audits = await pool.query(
      `SELECT event_type, actor_type, operator_id, actor_email
         FROM audit_log
        WHERE org_id = $1
          AND event_type IN ('conflict_confirmed', 'merge_reversed', 'conflict_rejected')
        ORDER BY created_at ASC`,
      [orgA.id]
    );
    expect(audits.rows.map((r) => r.event_type)).toEqual([
      'conflict_confirmed',
      'merge_reversed',
      'conflict_rejected',
    ]);
    for (const row of audits.rows) {
      expect(row.actor_type).toBe('operator');
      expect(row.operator_id).toBe(regularA.id);
      expect(row.actor_email).toBe(regularA.email);
    }

    // Export via dashboard attributes export_run.requested_by to operator email
    const exportRes = await opAgent.get('/v1/dashboard/exports/fans');
    expect(exportRes.status).toBe(200);
    const expRow = await pool.query(
      'SELECT requested_by FROM export_run WHERE org_id = $1 ORDER BY started_at DESC LIMIT 1',
      [orgA.id]
    );
    expect(expRow.rows[0].requested_by).toBe(regularA.email);
  });

  test('integrations cannot perform human conflict-review actions or manage operators, while M2M routes stay working', async () => {
    const c = await seedConflict(orgA.id);

    // Integrations are blocked (403) from human review mutations even if spoofing operator fields
    const confirmAttempt = await request(app)
      .post(`/v1/conflicts/${c.conflictId}/confirm`)
      .set('Authorization', `Bearer ${orgA.rawKey}`)
      .send({
        principal_type: 'operator',
        operator_id: adminA.id,
        operator_email: adminA.email,
        operator_role: 'admin',
      });
    expect(confirmAttempt.status).toBe(403);

    const rejectAttempt = await request(app)
      .post(`/v1/conflicts/${c.conflictId}/reject`)
      .set('Authorization', `Bearer ${orgA.rawKey}`)
      .send({});
    expect(rejectAttempt.status).toBe(403);

    const unmergeAttempt = await request(app)
      .post(`/v1/conflicts/${c.conflictId}/unmerge`)
      .set('Authorization', `Bearer ${orgA.rawKey}`)
      .send({});
    expect(unmergeAttempt.status).toBe(403);

    // Conflict remains untouched (pending)
    const untouched = await pool.query('SELECT status, reviewed_by FROM conflict_queue WHERE id = $1', [c.conflictId]);
    expect(untouched.rows[0]).toEqual({ status: 'pending', reviewed_by: null });

    // Integrations cannot access dashboard operator management
    const opListAttempt = await request(app)
      .get('/v1/dashboard/operators')
      .set('Authorization', `Bearer ${orgA.rawKey}`);
    expect(opListAttempt.status).toBe(401);

    // Integrations can still perform authorized M2M operations
    const resolveRes = await request(app)
      .post('/v1/resolve')
      .set('Authorization', `Bearer ${orgA.rawKey}`)
      .send({
        identifier_type: 'email',
        identifier_value: `m2m-${suffix}@example.com`,
        schema_version: '1.0',
        source_system: 'test_integration',
      });
    expect(resolveRes.status).toBe(200);

    const listConflictsRes = await request(app)
      .get('/v1/conflicts')
      .set('Authorization', `Bearer ${orgA.rawKey}`);
    expect(listConflictsRes.status).toBe(200);

    const exportRes = await request(app)
      .get('/v1/export/fans')
      .set('Authorization', `Bearer ${orgA.rawKey}`);
    expect(exportRes.status).toBe(200);
  });
});
