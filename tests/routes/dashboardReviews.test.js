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
    throw new Error('dashboard review tests only run against local Postgres on port 5432');
  }
}

async function makeOrg(name) {
  const id = crypto.randomUUID();
  const rawKey = `reviews-${crypto.randomUUID()}`;
  const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
  await pool.query(
    `INSERT INTO org (id, name, org_api_key_hash, is_active) VALUES ($1, $2, $3, true)`,
    [id, name, hash]
  );
  return { id, name };
}

async function seedPair(orgId, status) {
  const fanA = crypto.randomUUID();
  const fanB = crypto.randomUUID();
  const conflictId = crypto.randomUUID();
  await pool.query('INSERT INTO fan (id, org_id) VALUES ($1, $2), ($3, $2)', [fanA, orgId, fanB]);
  await pool.query(
    `INSERT INTO conflict_queue
       (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status)
     VALUES ($1, $2, $3, $4, 0.700, '[]'::jsonb, $5)`,
    [conflictId, fanA, fanB, orgId, status]
  );
  return { fanA, fanB, conflictId };
}

describe('dashboard review history and unmerge', () => {
  let orgA;
  let orgB;
  const password = 'correct-horse';
  const emailA = `reviews-a-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const emailB = `reviews-b-${crypto.randomUUID().slice(0, 8)}@example.com`;

  beforeAll(async () => {
    assertLocal();
    orgA = await makeOrg('review-org-a');
    orgB = await makeOrg('review-org-b');
    await createOperator(pool, { orgId: orgA.id, email: emailA, password });
    await createOperator(pool, { orgId: orgB.id, email: emailB, password });
  });

  afterAll(async () => {
    for (const orgId of [orgA.id, orgB.id]) {
      await pool.query('DELETE FROM operator_session WHERE org_id = $1', [orgId]);
      await pool.query('DELETE FROM operator WHERE org_id = $1', [orgId]);
      await pool.query('DELETE FROM export_run WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM merge_history WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM related_fans WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM identifier_link WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM import_row WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM import_batch WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM conflict_queue WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM resolution_trace WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM fan WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM org WHERE id = $1', [orgId]).catch(() => {});
    }
    await pool.end();
  });

  test('pending stays the default, and completed statuses stay inside the organization', async () => {
    const pending = await seedPair(orgA.id, 'pending');
    const confirmed = await seedPair(orgA.id, 'confirmed');
    const rejected = await seedPair(orgA.id, 'rejected');
    const other = await seedPair(orgB.id, 'confirmed');

    const agent = request.agent(app);
    const signedOut = await agent.get('/v1/dashboard/reviews?status=confirmed');
    expect(signedOut.status).toBe(401);

    await agent.post('/v1/dashboard/session').send({ email: emailA, password });

    const defaults = await agent.get('/v1/dashboard/reviews');
    expect(defaults.status).toBe(200);
    const defaultIds = defaults.body.reviews.map((row) => row.conflict_id);
    expect(defaultIds).toContain(pending.conflictId);
    expect(defaultIds).not.toContain(confirmed.conflictId);
    expect(defaultIds).not.toContain(rejected.conflictId);

    const confirmedList = await agent.get('/v1/dashboard/reviews?status=confirmed');
    expect(confirmedList.status).toBe(200);
    const confirmedIds = confirmedList.body.reviews.map((row) => row.conflict_id);
    expect(confirmedIds).toContain(confirmed.conflictId);
    expect(confirmedIds).not.toContain(other.conflictId);
    expect(confirmedIds).not.toContain(pending.conflictId);
    expect(confirmedList.body.reviews.find((row) => row.conflict_id === confirmed.conflictId).status).toBe('confirmed');

    const rejectedList = await agent.get('/v1/dashboard/reviews?status=rejected');
    expect(rejectedList.status).toBe(200);
    expect(rejectedList.body.reviews.map((row) => row.conflict_id)).toContain(rejected.conflictId);

    const badStatus = await agent.get('/v1/dashboard/reviews?status=merged');
    expect(badStatus.status).toBe(400);

    const opened = await agent.get(`/v1/dashboard/reviews/${confirmed.conflictId}`);
    expect(opened.status).toBe(200);
    expect(opened.body.status).toBe('confirmed');

    const hidden = await agent.get(`/v1/dashboard/reviews/${other.conflictId}`);
    expect(hidden.status).toBe(404);
  });

  test('a signed-in operator can unmerge only their own confirmed review', async () => {
    const own = await seedPair(orgA.id, 'confirmed');
    const other = await seedPair(orgB.id, 'confirmed');
    await pool.query(
      `INSERT INTO merge_history
         (id, fan_id_source, fan_id_target, org_id, conflict_id, merged_by, status, merged_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW()),
              ($7, $8, $9, $10, $11, $12, 'active', NOW())`,
      [
        crypto.randomUUID(), own.fanB, own.fanA, orgA.id, own.conflictId, orgA.name,
        crypto.randomUUID(), other.fanB, other.fanA, orgB.id, other.conflictId, orgB.name,
      ]
    );
    await pool.query(
      `INSERT INTO identifier_link
         (fan_id, org_id, identifier_type, identifier_value, source_system, schema_version, confidence_score, merged_from_fan_id)
       VALUES ($1, $2, 'email', $3, 'customer_import', '1.0', 1.0, $4)`,
      [own.fanA, orgA.id, `moved-${own.fanB.slice(0, 8)}@example.com`, own.fanB]
    );
    await pool.query('UPDATE fan SET deleted_at = NOW() WHERE id = $1', [own.fanB]);

    const anonymous = await request(app).post(`/v1/dashboard/conflicts/${own.conflictId}/unmerge`).send({});
    expect(anonymous.status).toBe(401);

    const agent = request.agent(app);
    await agent.post('/v1/dashboard/session').send({ email: emailA, password });

    const badId = await agent.post('/v1/dashboard/conflicts/not-a-uuid/unmerge').send({});
    expect(badId.status).toBe(400);

    const crossed = await agent.post(`/v1/dashboard/conflicts/${other.conflictId}/unmerge`).send({
      org_id: orgB.id,
    });
    expect(crossed.status).toBe(404);
    const otherStill = await pool.query(
      `SELECT status FROM merge_history WHERE conflict_id = $1`,
      [other.conflictId]
    );
    expect(otherStill.rows[0].status).toBe('active');

    const undone = await agent.post(`/v1/dashboard/conflicts/${own.conflictId}/unmerge`).send({
      org_id: orgB.id,
    });
    expect(undone.status).toBe(200);
    expect(undone.body.status).toBe('unmerged');

    const again = await agent.post(`/v1/dashboard/conflicts/${own.conflictId}/unmerge`).send({});
    expect(again.status).toBe(409);

    const fan = await pool.query('SELECT deleted_at FROM fan WHERE id = $1', [own.fanB]);
    expect(fan.rows[0].deleted_at).toBeNull();
    const link = await pool.query(
      `SELECT fan_id, merged_from_fan_id FROM identifier_link WHERE org_id = $1 AND fan_id = $2`,
      [orgA.id, own.fanB]
    );
    expect(link.rows).toHaveLength(1);
    expect(link.rows[0].merged_from_fan_id).toBeNull();
    const history = await pool.query(
      `SELECT status FROM merge_history WHERE conflict_id = $1`,
      [own.conflictId]
    );
    expect(history.rows[0].status).toBe('reversed');
    const audit = await pool.query(
      `SELECT event_type FROM audit_log WHERE org_id = $1 AND event_type = 'merge_reversed' AND fan_id = $2`,
      [orgA.id, own.fanA]
    );
    expect(audit.rows.length).toBeGreaterThan(0);

    const listed = await agent.get('/v1/dashboard/reviews?status=unmerged');
    expect(listed.body.reviews.map((row) => row.conflict_id)).toContain(own.conflictId);
  });

  test('import, merge, undo, and a kept-separate pair follow the existing resolver', async () => {
    const stamp = crypto.randomUUID().slice(0, 8);
    const csv = [
      'first_name,last_name,email,birthday,zip',
      `Jane,Doe,jane.one.${stamp}@example.com,1990-04-02,73101`,
      `Jane,Doe,jane.two.${stamp}@example.com,1990-04-02,73102`,
      `Robert,Miles,robert.one.${stamp}@example.com,1984-02-11,10001`,
      `Robert,Miles,robert.two.${stamp}@example.com,1984-02-11,10002`,
    ].join('\n');

    const agent = request.agent(app);
    await agent.post('/v1/dashboard/session').send({ email: emailA, password });
    const imported = await agent.post('/v1/dashboard/imports').send({
      filename: 'synthetic.csv',
      csv,
    });
    expect(imported.status).toBe(200);
    const reviewRows = imported.body.rows.filter((row) => row.conflict_id);
    expect(reviewRows).toHaveLength(2);

    const jane = reviewRows[0];
    const robert = reviewRows[1];
    const opened = await agent.get(`/v1/dashboard/reviews/${jane.conflict_id}`);
    expect(opened.status).toBe(200);
    expect(opened.body.status).toBe('pending');

    const merged = await agent.post(`/v1/dashboard/conflicts/${jane.conflict_id}/confirm`).send({});
    expect(merged.status).toBe(200);
    expect(merged.body.status).toBe('confirmed');

    const survivorId = opened.body.fan_id_a;
    const retired = opened.body.fan_id_b;
    expect(jane.fan_id).toBe(retired);
    const survivor = await pool.query('SELECT deleted_at FROM fan WHERE id = $1', [survivorId]);
    const retiredFan = await pool.query('SELECT deleted_at FROM fan WHERE id = $1', [retired]);
    expect(survivor.rows[0].deleted_at).toBeNull();
    expect(retiredFan.rows[0].deleted_at).not.toBeNull();
    const moved = await pool.query(
      `SELECT identifier_value FROM identifier_link
        WHERE org_id = $1 AND fan_id = $2 AND identifier_type = 'email' AND identifier_value = $3`,
      [orgA.id, survivorId, `jane.two.${stamp}@example.com`]
    );
    expect(moved.rows).toHaveLength(1);

    const confirmedList = await agent.get('/v1/dashboard/reviews?status=confirmed');
    expect(confirmedList.body.reviews.map((row) => row.conflict_id)).toContain(jane.conflict_id);

    const mergedExport = await agent.get('/v1/dashboard/exports/fans');
    expect(mergedExport.status).toBe(200);
    const mergedIds = mergedExport.text.split('\n').slice(1).map((line) => line.split(',')[0]);
    expect(mergedIds).toContain(survivorId);
    expect(mergedIds).not.toContain(retired);
    expect(mergedExport.text).toContain(retired);

    const undone = await agent.post(`/v1/dashboard/conflicts/${jane.conflict_id}/unmerge`).send({});
    expect(undone.status).toBe(200);
    expect(undone.body.status).toBe('unmerged');
    const restored = await pool.query('SELECT deleted_at FROM fan WHERE id = $1', [retired]);
    expect(restored.rows[0].deleted_at).toBeNull();
    const returned = await pool.query(
      `SELECT fan_id FROM identifier_link
        WHERE org_id = $1 AND identifier_type = 'email' AND identifier_value = $2`,
      [orgA.id, `jane.two.${stamp}@example.com`]
    );
    expect(returned.rows[0].fan_id).toBe(retired);
    const history = await pool.query(
      `SELECT status, reversed_at FROM merge_history WHERE conflict_id = $1`,
      [jane.conflict_id]
    );
    expect(history.rows[0].status).toBe('reversed');
    expect(history.rows[0].reversed_at).not.toBeNull();
    const confirmedAudit = await pool.query(
      `SELECT 1 FROM audit_log WHERE org_id = $1 AND event_type = 'conflict_confirmed' AND fan_id = $2`,
      [orgA.id, survivorId]
    );
    const reversedAudit = await pool.query(
      `SELECT 1 FROM audit_log WHERE org_id = $1 AND event_type = 'merge_reversed' AND fan_id = $2`,
      [orgA.id, survivorId]
    );
    expect(confirmedAudit.rows).toHaveLength(1);
    expect(reversedAudit.rows).toHaveLength(1);

    const detail = await agent.get(`/v1/dashboard/reviews/${jane.conflict_id}`);
    expect(detail.body.status).toBe('unmerged');
    const unmergedList = await agent.get('/v1/dashboard/reviews?status=unmerged');
    expect(unmergedList.body.reviews.map((row) => row.conflict_id)).toContain(jane.conflict_id);

    const separateExport = await agent.get('/v1/dashboard/exports/fans');
    const separateIds = separateExport.text.split('\n').slice(1).map((line) => line.split(',')[0]);
    expect(separateIds).toContain(survivorId);
    expect(separateIds).toContain(retired);
    const survivorLine = separateExport.text.split('\n').find((line) => line.startsWith(survivorId));
    expect(survivorLine.includes(retired)).toBe(false);

    const kept = await agent.post(`/v1/dashboard/conflicts/${robert.conflict_id}/reject`).send({});
    expect(kept.status).toBe(200);
    expect(kept.body.status).toBe('rejected');
    const rejectedList = await agent.get('/v1/dashboard/reviews?status=rejected');
    expect(rejectedList.body.reviews.map((row) => row.conflict_id)).toContain(robert.conflict_id);
    const robertFans = await pool.query(
      `SELECT deleted_at FROM fan WHERE id IN (
         SELECT fan_id_a FROM conflict_queue WHERE id = $1
         UNION
         SELECT fan_id_b FROM conflict_queue WHERE id = $1
       )`,
      [robert.conflict_id]
    );
    expect(robertFans.rows.every((row) => row.deleted_at === null)).toBe(true);
  });
});
