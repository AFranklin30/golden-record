'use strict';

require('dotenv').config();

const crypto = require('crypto');
const { Client } = require('pg');
const pool = require('../../src/db/pool');
const { countPendingIngestFailures } = require('../../src/routes/health');

function assertLocal() {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes('localhost:5432')) {
    throw new Error('tenant isolation tests only run against local Postgres on port 5432');
  }
}

async function ensureAppRole(password) {
  const existing = await pool.query(
    `SELECT 1 FROM pg_roles WHERE rolname = 'golden_record_app'`
  );
  if (existing.rowCount === 0) {
    await pool.query(
      `CREATE ROLE golden_record_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`
    );
  } else {
    await pool.query(
      `ALTER ROLE golden_record_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`
    );
  }

  await pool.query(`
    DO $$
    BEGIN
      EXECUTE format('GRANT CONNECT ON DATABASE %I TO golden_record_app', current_database());
    END $$
  `);
  await pool.query('GRANT USAGE ON SCHEMA public TO golden_record_app');
  await pool.query('GRANT SELECT ON org, operator TO golden_record_app');
  await pool.query('GRANT SELECT, INSERT, DELETE ON operator_session TO golden_record_app');
  await pool.query(`
    GRANT SELECT, INSERT, UPDATE ON
      fan,
      identifier_link,
      conflict_queue,
      household_member,
      staging_household_data,
      merge_history,
      export_run,
      import_row
      TO golden_record_app
  `);
  await pool.query('GRANT SELECT, INSERT ON household, related_fans, import_batch TO golden_record_app');
  await pool.query('GRANT SELECT, INSERT ON audit_log, ingest_failures TO golden_record_app');
  await pool.query('GRANT INSERT ON resolution_trace TO golden_record_app');
}

function appConnectionString(password) {
  const url = new URL(process.env.DATABASE_URL);
  url.username = 'golden_record_app';
  url.password = password;
  return url.toString();
}

describe('golden_record_app tenant isolation', () => {
  const orgA = crypto.randomUUID();
  const orgB = crypto.randomUUID();
  const fanA = crypto.randomUUID();
  const fanA2 = crypto.randomUUID();
  const fanB = crypto.randomUUID();
  const fanB2 = crypto.randomUUID();
  const linkA = crypto.randomUUID();
  const linkB = crypto.randomUUID();
  const conflictA = crypto.randomUUID();
  const conflictB = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const password = crypto.randomBytes(24).toString('hex');
  let appClient;

  beforeAll(async () => {
    assertLocal();
    await ensureAppRole(password);

    const hashA = crypto.createHash('sha256').update(`iso-a-${orgA}`).digest('hex');
    const hashB = crypto.createHash('sha256').update(`iso-b-${orgB}`).digest('hex');
    await pool.query(
      `INSERT INTO org (id, name, org_api_key_hash, is_active) VALUES
         ($1, 'isolation-a', $2, true),
         ($3, 'isolation-b', $4, true)`,
      [orgA, hashA, orgB, hashB]
    );
    await pool.query(
      `INSERT INTO fan (id, org_id) VALUES
         ($1, $2), ($3, $2), ($4, $5), ($6, $5)`,
      [fanA, orgA, fanA2, fanB, orgB, fanB2]
    );
    await pool.query(
      `INSERT INTO identifier_link
         (id, fan_id, org_id, identifier_type, identifier_value, source_system, schema_version)
       VALUES
         ($1, $2, $3, 'email', $4, 'staff_portal', '1.0'),
         ($5, $6, $7, 'email', $8, 'staff_portal', '1.0')`,
      [linkA, fanA, orgA, `a-${orgA}@example.com`, linkB, fanB, orgB, `b-${orgB}@example.com`]
    );
    await pool.query(
      `INSERT INTO conflict_queue
         (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status)
       VALUES
         ($1, $2, $3, $4, 0.700, '[]'::jsonb, 'pending'),
         ($5, $6, $7, $8, 0.700, '[]'::jsonb, 'pending')`,
      [conflictA, fanA, fanA2, orgA, conflictB, fanB, fanB2, orgB]
    );
    await pool.query(
      `INSERT INTO ingest_failures
         (org_id, source_system, raw_payload, reason_code, error_detail, status)
       VALUES
         ($1, 'nfc', '{}'::jsonb, 'normalization_error', 'isolation fixture', 'pending'),
         ($2, 'nfc', '{}'::jsonb, 'normalization_error', 'isolation fixture', 'pending')`,
      [orgA, orgB]
    );
    await pool.query(
      `INSERT INTO audit_log (id, org_id, event_type, status, schema_version)
       VALUES ($1, $2, 'resolution', 'success', '1.0')`,
      [auditId, orgA]
    );

    appClient = new Client({ connectionString: appConnectionString(password) });
    await appClient.connect();
  });

  afterAll(async () => {
    if (appClient) await appClient.end();
    await pool.query('DELETE FROM conflict_queue WHERE org_id = ANY($1::uuid[])', [[orgA, orgB]]);
    await pool.query('DELETE FROM identifier_link WHERE org_id = ANY($1::uuid[])', [[orgA, orgB]]);
    await pool.query('DELETE FROM ingest_failures WHERE org_id = ANY($1::uuid[])', [[orgA, orgB]]);
    await pool.query('DELETE FROM fan WHERE org_id = ANY($1::uuid[])', [[orgA, orgB]]);
    await pool.query('DELETE FROM org WHERE id = ANY($1::uuid[])', [[orgA, orgB]]).catch(() => {});
    await pool.end();
  });

  test('the application role is not a superuser and cannot bypass row-level security', async () => {
    const role = await pool.query(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcanlogin
         FROM pg_roles
        WHERE rolname = 'golden_record_app'`
    );
    expect(role.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcanlogin: true,
    });

    const who = await appClient.query(
      `SELECT current_user, current_setting('is_superuser') AS is_superuser`
    );
    expect(who.rows[0].current_user).toBe('golden_record_app');
    expect(who.rows[0].is_superuser).toBe('off');
  });

  test('a tenant sees its own fan, identifier, and conflict, and not the other organization', async () => {
    await appClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgA]);

    const fans = await appClient.query('SELECT id FROM fan');
    expect(fans.rows.map((row) => row.id).sort()).toEqual([fanA, fanA2].sort());

    const links = await appClient.query('SELECT id FROM identifier_link');
    expect(links.rows.map((row) => row.id)).toEqual([linkA]);

    const conflicts = await appClient.query('SELECT id FROM conflict_queue');
    expect(conflicts.rows.map((row) => row.id)).toEqual([conflictA]);

    const hidden = await appClient.query('SELECT id FROM fan WHERE id = $1', [fanB]);
    expect(hidden.rows).toEqual([]);
  });

  test('the other organization sees its own fan and not the first', async () => {
    await appClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgB]);
    const fans = await appClient.query('SELECT id FROM fan WHERE id = $1', [fanA]);
    expect(fans.rows).toEqual([]);
    const own = await appClient.query('SELECT id FROM fan WHERE id = $1', [fanB]);
    expect(own.rows.map((row) => row.id)).toEqual([fanB]);
  });

  test('a missing tenant setting errors instead of returning every fan', async () => {
    await appClient.query('RESET app.current_org_id');
    await expect(appClient.query('SELECT id FROM fan')).rejects.toThrow(/invalid input syntax for type uuid/);
  });

  test('an insert for another organization is rejected', async () => {
    await appClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgA]);
    await expect(
      appClient.query('INSERT INTO fan (id, org_id) VALUES ($1, $2)', [crypto.randomUUID(), orgB])
    ).rejects.toThrow(/row-level security policy/);
  });

  test('the health count under this role returns one organization', async () => {
    await appClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgB]);
    const count = await countPendingIngestFailures(appClient, orgA);
    expect(count).toBe(1);
  });

  test('deleting an audit row is rejected', async () => {
    await expect(
      appClient.query('DELETE FROM audit_log WHERE id = $1', [auditId])
    ).rejects.toThrow(/permission denied/);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('GRANT DELETE ON audit_log TO golden_record_app');
      await client.query('SET LOCAL ROLE golden_record_app');
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgA]);
      await expect(
        client.query('DELETE FROM audit_log WHERE id = $1', [auditId])
      ).rejects.toThrow(/append-only/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const privilege = await pool.query(
      `SELECT has_table_privilege('golden_record_app', 'audit_log', 'DELETE') AS can_delete`
    );
    expect(privilege.rows[0].can_delete).toBe(false);
  });
});
