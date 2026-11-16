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
    throw new Error('dashboard record tests only run against local Postgres on port 5432');
  }
}

async function makeOrg(name) {
  const id = crypto.randomUUID();
  const hash = crypto.createHash('sha256').update(`records-${id}`).digest('hex');
  await pool.query(
    `INSERT INTO org (id, name, org_api_key_hash, is_active) VALUES ($1, $2, $3, true)`,
    [id, name, hash]
  );
  return { id, name };
}

async function addFan(orgId, identifiers) {
  const fanId = crypto.randomUUID();
  await pool.query('INSERT INTO fan (id, org_id) VALUES ($1, $2)', [fanId, orgId]);
  for (const [type, value] of Object.entries(identifiers)) {
    await pool.query(
      `INSERT INTO identifier_link
         (fan_id, org_id, identifier_type, identifier_value, source_system, schema_version, confidence_score)
       VALUES ($1, $2, $3, $4, 'csv_import', '1.0', 1.0)`,
      [fanId, orgId, type, value]
    );
  }
  return fanId;
}

async function addBatch(orgId, filename) {
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO import_batch (id, org_id, filename) VALUES ($1, $2, $3)',
    [id, orgId, filename]
  );
  return id;
}

async function addRow(orgId, batchId, fields) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO import_row
       (id, batch_id, org_id, row_number, status, fan_id, resolution_path, conflict_id, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id, batchId, orgId, fields.rowNumber, fields.status,
      fields.fanId || null, fields.path || null, fields.conflictId || null, fields.error || null,
    ]
  );
  return id;
}

describe('dashboard imported records', () => {
  let orgA;
  let orgB;
  const password = 'correct-horse';
  const emailA = `records-a-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const emailB = `records-b-${crypto.randomUUID().slice(0, 8)}@example.com`;
  let pathB;
  let pathD;
  let pathA;
  let errorRow;
  let otherRow;

  beforeAll(async () => {
    assertLocal();
    orgA = await makeOrg('records-org-a');
    orgB = await makeOrg('records-org-b');
    await createOperator(pool, { orgId: orgA.id, email: emailA, password });
    await createOperator(pool, { orgId: orgB.id, email: emailB, password });

    const fanB = await addFan(orgA.id, { name: 'ada lovelace', email: 'ada@example.com' });
    const fanD = await addFan(orgA.id, { name: 'bob adler', email: 'bob.adler.2@example.com' });
    const conflictId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO conflict_queue
         (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status)
       VALUES ($1, $2, $3, $4, 0.400, '[{"signal":"name_plus_dob"}]'::jsonb, 'pending')`,
      [conflictId, fanB, fanD, orgA.id]
    );
    const batch = await addBatch(orgA.id, 'customers.csv');
    pathB = await addRow(orgA.id, batch, { rowNumber: 1, status: 'complete', fanId: fanB, path: 'B' });
    pathD = await addRow(orgA.id, batch, { rowNumber: 2, status: 'complete', fanId: fanD, path: 'D', conflictId });
    pathA = await addRow(orgA.id, batch, { rowNumber: 3, status: 'complete', fanId: fanB, path: 'A' });
    errorRow = await addRow(orgA.id, batch, { rowNumber: 4, status: 'error', error: 'row could not be read' });

    const otherFan = await addFan(orgB.id, { name: 'ada lovelace', email: 'ada@example.com' });
    const otherBatch = await addBatch(orgB.id, 'other.csv');
    otherRow = await addRow(orgB.id, otherBatch, { rowNumber: 1, status: 'complete', fanId: otherFan, path: 'B' });
  });

  afterAll(async () => {
    for (const orgId of [orgA.id, orgB.id]) {
      await pool.query('DELETE FROM operator_session WHERE org_id = $1', [orgId]);
      await pool.query('DELETE FROM operator WHERE org_id = $1', [orgId]);
      await pool.query('DELETE FROM merge_history WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM identifier_link WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM import_row WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM import_batch WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM conflict_queue WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM fan WHERE org_id = $1', [orgId]).catch(() => {});
      await pool.query('DELETE FROM org WHERE id = $1', [orgId]).catch(() => {});
    }
    await pool.end();
  });

  test('lists paths, a review, an existing person, and an error without another organization', async () => {
    const agent = request.agent(app);
    expect((await agent.get('/v1/dashboard/records')).status).toBe(401);
    await agent.post('/v1/dashboard/session').send({ email: emailA, password });

    const listed = await agent.get('/v1/dashboard/records');
    expect(listed.status).toBe(200);
    const ids = listed.body.records.map((row) => row.import_row_id);
    expect(ids).toEqual(expect.arrayContaining([pathB, pathD, pathA, errorRow]));
    expect(ids).not.toContain(otherRow);

    const fresh = listed.body.records.find((row) => row.import_row_id === pathB);
    expect(fresh.resolution_path).toBe('B');
    expect(fresh.review_opened).toBe(false);
    expect(fresh.person.email).toEqual(['ada@example.com']);
    expect(fresh.confidence_score).toBeNull();

    const flagged = listed.body.records.find((row) => row.import_row_id === pathD);
    expect(flagged.review_opened).toBe(true);
    expect(flagged.confidence_score).toBe('0.400');
    expect(flagged.person.name).toEqual(['bob adler']);

    const again = listed.body.records.find((row) => row.import_row_id === pathA);
    expect(again.resolution_path).toBe('A');
    expect(again.fan_id).toBe(fresh.fan_id);
    expect(again.person.email).toEqual(['ada@example.com']);

    const failed = listed.body.records.find((row) => row.import_row_id === errorRow);
    expect(failed.fan_id).toBeNull();
    expect(failed.person).toEqual({});
    expect(failed.error).toBe('row could not be read');

    const none = await agent.get('/v1/dashboard/records?review=none');
    expect(none.body.records.map((row) => row.import_row_id)).toEqual(expect.arrayContaining([pathB, pathA, errorRow]));
    expect(none.body.records.map((row) => row.import_row_id)).not.toContain(pathD);

    const queued = await agent.get('/v1/dashboard/records?review=queued');
    expect(queued.body.records.map((row) => row.import_row_id)).toEqual([pathD]);

    const found = await agent.get('/v1/dashboard/records?q=ada@example.com');
    const foundIds = found.body.records.map((row) => row.import_row_id);
    expect(foundIds).toEqual(expect.arrayContaining([pathB, pathA]));
    expect(foundIds).not.toContain(otherRow);
    expect(foundIds).not.toContain(errorRow);

    const hidden = await agent.get(`/v1/dashboard/records/${otherRow}`);
    expect(hidden.status).toBe(404);

    const opened = await agent.get(`/v1/dashboard/records/${pathB}`);
    expect(opened.status).toBe(200);
    expect(opened.body.record.review_opened).toBe(false);
    expect(opened.body.record.person.name).toEqual(['ada lovelace']);

    expect((await agent.get('/v1/dashboard/records?path=Z')).status).toBe(400);
    expect((await agent.get('/v1/dashboard/records?review=unique')).status).toBe(400);
  });

  test('hides one person, keeps stored identifiers, and drops a pending review', async () => {
    const agent = request.agent(app);
    const kept = await addFan(orgA.id, { name: 'kept person', email: 'kept.hide@example.com' });
    const hiddenFan = await addFan(orgA.id, { name: 'hide me', email: 'hide.me@example.com' });
    const otherFan = await addFan(orgA.id, { name: 'other side', email: 'other.side@example.com' });
    const conflictId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO conflict_queue
         (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status)
       VALUES ($1, $2, $3, $4, 0.700, '[{"signal":"name_plus_dob"}]'::jsonb, 'pending')`,
      [conflictId, otherFan, hiddenFan, orgA.id]
    );
    const batch = await addBatch(orgA.id, 'hide-one.csv');
    const rowId = await addRow(orgA.id, batch, { rowNumber: 1, status: 'complete', fanId: hiddenFan, path: 'B' });

    expect((await agent.post(`/v1/dashboard/fans/${hiddenFan}/hide`)).status).toBe(401);
    await agent.post('/v1/dashboard/session').send({ email: emailA, password });
    expect((await agent.post('/v1/dashboard/fans/not-a-uuid/hide')).status).toBe(400);

    const other = request.agent(app);
    await other.post('/v1/dashboard/session').send({ email: emailB, password });
    const cross = await other.post(`/v1/dashboard/fans/${hiddenFan}/hide`).send({ org_id: orgA.id });
    expect(cross.status).toBe(404);

    const hidden = await agent.post(`/v1/dashboard/fans/${hiddenFan}/hide`).send({ org_id: orgB.id });
    expect(hidden.status).toBe(200);
    expect(hidden.body.fan_id).toBe(hiddenFan);

    const fan = await pool.query('SELECT deleted_at FROM fan WHERE id = $1', [hiddenFan]);
    expect(fan.rows[0].deleted_at).not.toBeNull();
    const stillThere = await pool.query(
      'SELECT identifier_value FROM identifier_link WHERE fan_id = $1 AND identifier_type = $2',
      [hiddenFan, 'email']
    );
    expect(stillThere.rows[0].identifier_value).toBe('hide.me@example.com');
    const audit = await pool.query(
      `SELECT event_type FROM audit_log WHERE fan_id = $1 AND event_type = 'record_hidden'`,
      [hiddenFan]
    );
    expect(audit.rows).toHaveLength(1);

    const again = await agent.post(`/v1/dashboard/fans/${hiddenFan}/hide`);
    expect(again.status).toBe(409);

    const pending = await agent.get('/v1/dashboard/reviews?status=pending');
    expect(pending.body.reviews.map((row) => row.conflict_id)).not.toContain(conflictId);

    const exported = await agent.get('/v1/dashboard/exports/fans');
    expect(exported.text).not.toContain('hide.me@example.com');
    expect(exported.text).toContain('kept.hide@example.com');

    const record = await agent.get(`/v1/dashboard/records/${rowId}`);
    expect(record.body.record.deleted_at).not.toBeNull();
    expect(record.body.record.person.email).toEqual(['hide.me@example.com']);
    expect(kept).toBeTruthy();
  });

  test('refuses to hide a person in an active merge', async () => {
    const agent = request.agent(app);
    await agent.post('/v1/dashboard/session').send({ email: emailA, password });
    const source = await addFan(orgA.id, { email: 'merged.source@example.com' });
    const target = await addFan(orgA.id, { email: 'merged.target@example.com' });
    await pool.query(
      `INSERT INTO merge_history (fan_id_source, fan_id_target, org_id, status, merged_by)
       VALUES ($1, $2, $3, 'active', 'records-org-a')`,
      [source, target, orgA.id]
    );

    const sourceHide = await agent.post(`/v1/dashboard/fans/${source}/hide`);
    const targetHide = await agent.post(`/v1/dashboard/fans/${target}/hide`);
    expect(sourceHide.status).toBe(409);
    expect(sourceHide.body.error).toBe('record is part of an active merge');
    expect(targetHide.status).toBe(409);

    const fans = await pool.query(
      'SELECT id, deleted_at FROM fan WHERE id = ANY($1::uuid[])',
      [[source, target]]
    );
    expect(fans.rows.every((row) => row.deleted_at === null)).toBe(true);
  });

  test('hides people minted by one file and keeps the file', async () => {
    const agent = request.agent(app);
    await agent.post('/v1/dashboard/session').send({ email: emailA, password });
    const minted = await addFan(orgA.id, { email: 'minted.batch@example.com' });
    const existing = await addFan(orgA.id, { email: 'existing.batch@example.com' });
    const merged = await addFan(orgA.id, { email: 'merged.batch@example.com' });
    const survivor = await addFan(orgA.id, { email: 'survivor.batch@example.com' });
    await pool.query(
      `INSERT INTO merge_history (fan_id_source, fan_id_target, org_id, status, merged_by)
       VALUES ($1, $2, $3, 'active', 'records-org-a')`,
      [merged, survivor, orgA.id]
    );
    const batch = await addBatch(orgA.id, 'batch-hide.csv');
    await addRow(orgA.id, batch, { rowNumber: 1, status: 'complete', fanId: minted, path: 'B' });
    await addRow(orgA.id, batch, { rowNumber: 2, status: 'complete', fanId: existing, path: 'A' });
    await addRow(orgA.id, batch, { rowNumber: 3, status: 'error', error: 'row could not be read' });
    await addRow(orgA.id, batch, { rowNumber: 4, status: 'complete', fanId: merged, path: 'D' });

    const wrong = await agent.post(`/v1/dashboard/imports/${batch}/remove`).send({ confirm_filename: 'other.csv' });
    expect(wrong.status).toBe(400);
    const missing = await agent.post(`/v1/dashboard/imports/${batch}/remove`).send({});
    expect(missing.status).toBe(400);

    const other = request.agent(app);
    await other.post('/v1/dashboard/session').send({ email: emailB, password });
    const cross = await other.post(`/v1/dashboard/imports/${batch}/remove`).send({
      confirm_filename: 'batch-hide.csv',
      org_id: orgA.id,
    });
    expect(cross.status).toBe(404);

    const removed = await agent.post(`/v1/dashboard/imports/${batch}/remove`).send({
      confirm_filename: 'batch-hide.csv',
      org_id: orgB.id,
    });
    expect(removed.status).toBe(200);
    expect(removed.body.removed.map((row) => row.fan_id)).toEqual([minted]);
    expect(removed.body.left_in_place.map((row) => row.reason)).toEqual([
      'already this person; not removed',
      'no person stored',
    ]);
    expect(removed.body.skipped).toEqual([
      { row_number: 4, fan_id: merged, reason: 'record is part of an active merge' },
    ]);

    const stored = await pool.query(
      'SELECT filename, data_removed_at FROM import_batch WHERE id = $1',
      [batch]
    );
    expect(stored.rows[0].filename).toBe('batch-hide.csv');
    expect(stored.rows[0].data_removed_at).not.toBeNull();
    const emails = await pool.query(
      `SELECT identifier_value FROM identifier_link
        WHERE fan_id = ANY($1::uuid[]) AND identifier_type = 'email'`,
      [[minted, existing, merged]]
    );
    expect(emails.rows.map((row) => row.identifier_value).sort()).toEqual([
      'existing.batch@example.com',
      'merged.batch@example.com',
      'minted.batch@example.com',
    ]);
    const mintedFan = await pool.query('SELECT deleted_at FROM fan WHERE id = $1', [minted]);
    const existingFan = await pool.query('SELECT deleted_at FROM fan WHERE id = $1', [existing]);
    expect(mintedFan.rows[0].deleted_at).not.toBeNull();
    expect(existingFan.rows[0].deleted_at).toBeNull();

    const second = await agent.post(`/v1/dashboard/imports/${batch}/remove`).send({ confirm_filename: 'batch-hide.csv' });
    expect(second.status).toBe(409);

    const listed = await agent.get('/v1/dashboard/imports');
    const item = listed.body.imports.find((row) => row.id === batch);
    expect(item.data_removed_at).toBeTruthy();
  });
});
