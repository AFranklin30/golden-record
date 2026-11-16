'use strict';

require('dotenv').config();

const crypto = require('crypto');
const { Client } = require('pg');
const request = require('supertest');
const app = require('../../index');
const { parseCustomerRow, importCustomers } = require('../../src/modules/customerImport');

const FILE = [
  'first_name,last_name,email,birthday,zip,phone',
  'Robert,Smith,robert@example.com,1985-04-12,78701,5125550101',
  'Robert,Smith,robert@example.com,1985-04-12,78701,5125550101',
  'John,Jones,john@example.com,1990-06-15,78702,5125550102',
  'Jon,Jones,jon@example.com,1990-06-15,78702,5125550103',
  'Bob,Smith,bob@example.com,1985-04-12,78701,5125550104',
  'Robert,Smith,robert.alt@example.com,1985-04-12,78701,5125550105',
  'Bob,Smith,bob.jones@example.com,1985-04-12,78703,5125550106',
  'Robert,Jones,robert.jones@example.com,1985-04-12,78703,5125550107',
  'Alice,Brown,alice@example.com,1988-09-20,78704,5125550108',
  'Alice,Brown,alice@example.com,1992-09-20,78704,5125550109',
].join('\n');

function assertLocalDatabase() {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes('localhost:5432')) {
    throw new Error('customer import tests only run against local Postgres on port 5432');
  }
}

async function fanIdForEmail(client, orgId, email) {
  const result = await client.query(
    `SELECT fan_id FROM identifier_link
      WHERE org_id = $1 AND identifier_type = 'email' AND identifier_value = $2`,
    [orgId, email]
  );
  return result.rows.map((row) => row.fan_id);
}

async function valuesFor(client, orgId, fanId, type) {
  const result = await client.query(
    `SELECT identifier_value FROM identifier_link
      WHERE org_id = $1 AND fan_id = $2 AND identifier_type = $3
      ORDER BY identifier_value`,
    [orgId, fanId, type]
  );
  return result.rows.map((row) => row.identifier_value);
}

describe('customer CSV import', () => {
  let client;
  let orgId;
  const rawKey = `import-test-${crypto.randomUUID()}`;

  beforeAll(async () => {
    assertLocalDatabase();
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    orgId = crypto.randomUUID();
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash, is_active)
       VALUES ($1, $2, $3, true)`,
      [orgId, 'customer-import-test', hash]
    );
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    await client.query('DELETE FROM import_row WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM import_batch WHERE org_id = $1', [orgId]);
    await client.query('DELETE FROM export_run WHERE org_id = $1', [orgId]).catch(() => {});
    await client.query('DELETE FROM merge_history WHERE org_id = $1', [orgId]).catch(() => {});
    await client.query('DELETE FROM conflict_queue WHERE org_id = $1', [orgId]).catch(() => {});
    await client.query('DELETE FROM identifier_link WHERE org_id = $1', [orgId]).catch(() => {});
    await client.query('DELETE FROM fan WHERE org_id = $1 AND deleted_at IS NULL', [orgId]).catch(() => {});
    await client.query('DELETE FROM fan WHERE org_id = $1', [orgId]).catch(() => {});
    await client.query('DELETE FROM org WHERE id = $1', [orgId]).catch(() => {});
    await client.end();
  });

  test('a row without an email or a name and birthday creates no fan', async () => {
    expect(parseCustomerRow({ zip: '78701' }).ok).toBe(false);

    const before = await client.query('SELECT count(*)::int AS n FROM fan WHERE org_id = $1', [orgId]);
    const imported = await importCustomers(client, {
      orgId,
      rows: [{ first_name: 'Only', zip: '78701', phone: '5125550199' }],
    });

    expect(imported.rows[0].status).toBe('error');
    expect(imported.rows[0].fan_id).toBeNull();
    const after = await client.query('SELECT count(*)::int AS n FROM fan WHERE org_id = $1', [orgId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test('the ten-row file stores people, opens reviews, and does not merge them', async () => {
    const imported = await importCustomers(client, { orgId, csv: FILE, filename: 'acceptance.csv' });
    const completed = imported.rows.filter((row) => row.status === 'complete');
    expect(completed).toHaveLength(10);
    expect(imported.rows[1].replayed).toBe(true);
    expect(imported.rows[1].fan_id).toBe(imported.rows[0].fan_id);

    const fans = await client.query(
      'SELECT id, deleted_at FROM fan WHERE org_id = $1',
      [orgId]
    );
    expect(fans.rows).toHaveLength(9);
    expect(fans.rows.every((row) => row.deleted_at === null)).toBe(true);

    const robertIds = await fanIdForEmail(client, orgId, 'robert@example.com');
    const johnIds = await fanIdForEmail(client, orgId, 'john@example.com');
    const jonIds = await fanIdForEmail(client, orgId, 'jon@example.com');
    const bobIds = await fanIdForEmail(client, orgId, 'bob@example.com');
    const altIds = await fanIdForEmail(client, orgId, 'robert.alt@example.com');
    const bobJonesIds = await fanIdForEmail(client, orgId, 'bob.jones@example.com');
    const robertJonesIds = await fanIdForEmail(client, orgId, 'robert.jones@example.com');
    const aliceIds = await fanIdForEmail(client, orgId, 'alice@example.com');

    expect(robertIds).toHaveLength(1);
    expect(aliceIds).toHaveLength(1);
    expect(new Set([
      robertIds[0], johnIds[0], jonIds[0], bobIds[0], altIds[0], bobJonesIds[0], robertJonesIds[0], aliceIds[0],
    ]).size).toBe(8);

    expect(await valuesFor(client, orgId, robertIds[0], 'name')).toEqual(['robert smith']);
    expect(await valuesFor(client, orgId, robertIds[0], 'dob')).toEqual(['1985-04-12']);
    expect(await valuesFor(client, orgId, robertIds[0], 'zip')).toEqual(['78701']);
    expect(await valuesFor(client, orgId, robertIds[0], 'phone')).toEqual(['+15125550101']);

    const aliceNewId = imported.rows[9].fan_id;
    expect(aliceNewId).not.toBe(aliceIds[0]);
    expect(await valuesFor(client, orgId, aliceIds[0], 'dob')).toEqual(['1988-09-20']);
    expect(await valuesFor(client, orgId, aliceIds[0], 'phone')).toEqual(['+15125550108']);
    expect(await valuesFor(client, orgId, aliceNewId, 'email')).toEqual([]);
    expect(await valuesFor(client, orgId, aliceNewId, 'name')).toEqual(['alice brown']);
    expect(await valuesFor(client, orgId, aliceNewId, 'dob')).toEqual(['1992-09-20']);
    expect(await valuesFor(client, orgId, aliceNewId, 'phone')).toEqual(['+15125550109']);
    expect(imported.rows[9].resolution_path).toBe('D');
    expect(imported.rows[9].conflict_id).toBeTruthy();
    expect(imported.rows[9].skipped.dob).toBeUndefined();

    const conflicts = await client.query(
      `SELECT id, fan_id_a, fan_id_b, status FROM conflict_queue WHERE org_id = $1`,
      [orgId]
    );
    expect(conflicts.rows).toHaveLength(5);
    expect(conflicts.rows.every((row) => row.status === 'pending')).toBe(true);

    const pair = (left, right) => conflicts.rows.find((row) =>
      (row.fan_id_a === left && row.fan_id_b === right) ||
      (row.fan_id_a === right && row.fan_id_b === left)
    );
    expect(pair(aliceIds[0], aliceNewId).status).toBe('pending');
    expect(pair(johnIds[0], jonIds[0])).toBeTruthy();
    expect(pair(robertIds[0], bobIds[0])).toBeTruthy();
    expect(pair(bobJonesIds[0], robertJonesIds[0])).toBeUndefined();

    const trace = await client.query(
      `SELECT inbound_identifiers FROM resolution_trace
        WHERE org_id = $1 AND resulting_fan_id = $2
        ORDER BY created_at
        LIMIT 1`,
      [orgId, robertIds[0]]
    );
    expect(trace.rows[0].inbound_identifiers.phone).toBeUndefined();

    const beforeLinks = await client.query(
      'SELECT count(*)::int AS n FROM identifier_link WHERE org_id = $1',
      [orgId]
    );
    const again = await importCustomers(client, { orgId, csv: FILE, filename: 'acceptance.csv' });
    expect(again.rows.every((row) => row.replayed)).toBe(true);
    const afterFans = await client.query('SELECT count(*)::int AS n FROM fan WHERE org_id = $1', [orgId]);
    const afterConflicts = await client.query(
      'SELECT count(*)::int AS n FROM conflict_queue WHERE org_id = $1',
      [orgId]
    );
    const afterLinks = await client.query(
      'SELECT count(*)::int AS n FROM identifier_link WHERE org_id = $1',
      [orgId]
    );
    expect(afterFans.rows[0].n).toBe(9);
    expect(afterConflicts.rows[0].n).toBe(5);
    expect(afterLinks.rows[0].n).toBe(beforeLinks.rows[0].n);

    const johnConflict = pair(johnIds[0], jonIds[0]);
    const confirmed = await request(app)
      .post(`/v1/conflicts/${johnConflict.id}/confirm`)
      .set('Authorization', `Bearer ${rawKey}`);
    expect(confirmed.status).toBe(200);

    const jon = await client.query('SELECT deleted_at FROM fan WHERE id = $1', [jonIds[0]]);
    const john = await client.query('SELECT deleted_at FROM fan WHERE id = $1', [johnIds[0]]);
    expect(jon.rows[0].deleted_at).not.toBeNull();
    expect(john.rows[0].deleted_at).toBeNull();

    const exported = await request(app)
      .get('/v1/export/fans')
      .set('Authorization', `Bearer ${rawKey}`);
    expect(exported.status).toBe(200);
    const exportedFanIds = exported.text.trim().split('\n').slice(1).map((line) => line.split(',')[0]);
    expect(exportedFanIds).toContain(johnIds[0]);
    expect(exportedFanIds).not.toContain(jonIds[0]);
    expect(exported.text).toContain(jonIds[0]);
    expect(exportedFanIds).toContain(robertIds[0]);
    expect(exportedFanIds).toContain(aliceIds[0]);
    expect(exportedFanIds).toContain(aliceNewId);

    const bobConflict = pair(robertIds[0], bobIds[0]);
    const firstSmith = await request(app)
      .post(`/v1/conflicts/${bobConflict.id}/confirm`)
      .set('Authorization', `Bearer ${rawKey}`);
    expect(firstSmith.status).toBe(200);

    const bob = await client.query('SELECT deleted_at FROM fan WHERE id = $1', [bobIds[0]]);
    const robert = await client.query('SELECT deleted_at FROM fan WHERE id = $1', [robertIds[0]]);
    expect(bob.rows[0].deleted_at).not.toBeNull();
    expect(robert.rows[0].deleted_at).toBeNull();

    const stillPending = await client.query(
      `SELECT id, fan_id_a FROM conflict_queue WHERE org_id = $1 AND status = 'pending'`,
      [orgId]
    );
    expect(stillPending.rows).toHaveLength(3);

    const repeated = await request(app)
      .post(`/v1/conflicts/${bobConflict.id}/confirm`)
      .set('Authorization', `Bearer ${rawKey}`);
    expect(repeated.status).toBe(409);

    const intoRobert = stillPending.rows.find((row) => row.fan_id_a === robertIds[0]);
    if (intoRobert) {
      const second = await request(app)
        .post(`/v1/conflicts/${intoRobert.id}/confirm`)
        .set('Authorization', `Bearer ${rawKey}`);
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('multi-hop merge not supported');
    }
  }, 60000);
});
