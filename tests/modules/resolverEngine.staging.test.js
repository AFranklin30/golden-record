'use strict';

require('dotenv').config();

const crypto = require('crypto');
const { Client } = require('pg');
const { resolverEngine } = require('../../src/modules/resolverEngine');

function assertLocal() {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes('localhost:5432')) {
    throw new Error('staging tests only run against local Postgres on port 5432');
  }
}

function uuid() {
  return crypto.randomUUID();
}

describe('resolverEngine — staging insert on local Postgres', () => {
  let client;

  beforeAll(async () => {
    assertLocal();
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function seedChild(orgId, fanId) {
    const hash = crypto.createHash('sha256').update(`staging-${orgId}`).digest('hex');
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash, is_active) VALUES ($1, $2, $3, true)`,
      [orgId, `_staging_${orgId.slice(0, 8)}`, hash]
    );
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [fanId, orgId]
    );
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, org_id, identifier_type, identifier_value, source_system,
          schema_version, confidence_score, first_seen_at, last_seen_at)
       VALUES ($1, $2, 'guardian_email', $3, 'fan_pass', '1.0', 1.0, NOW(), NOW())`,
      [fanId, orgId, `parent.${orgId.slice(0, 8)}@example.com`]
    );
    return `parent.${orgId.slice(0, 8)}@example.com`;
  }

  async function cleanup(orgId) {
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
    await client.query('DELETE FROM staging_household_data WHERE org_id = $1', [orgId]).catch(() => {});
    await client.query('DELETE FROM conflict_queue WHERE org_id = $1', [orgId]).catch(() => {});
    await client.query('DELETE FROM identifier_link WHERE org_id = $1', [orgId]).catch(() => {});
  }

  function call(orgId, guardianEmail, extra) {
    return resolverEngine({
      identifier_type: 'nfc_uid',
      identifier_value: 'D4E5F6A7',
      identifiers: { guardian_email: guardianEmail, ...extra },
      org_id: orgId,
      schema_version: '1.0',
      idempotency_key: uuid(),
      source_system: 'csv_import',
    }, client);
  }

  test('a null name skips the staging row and still opens the review', async () => {
    const orgId = uuid();
    const fanId = uuid();
    try {
      const guardianEmail = await seedChild(orgId, fanId);
      const result = await call(orgId, guardianEmail, { name: null });
      const staging = await client.query(
        'SELECT child_name FROM staging_household_data WHERE org_id = $1',
        [orgId]
      );
      const review = await client.query(
        'SELECT fan_id_a, status FROM conflict_queue WHERE id = $1',
        [result.conflict_id]
      );
      expect(staging.rows).toHaveLength(0);
      expect(result.match_type).toBe('conflict');
      expect(review.rows[0].status).toBe('pending');
      expect(review.rows[0].fan_id_a).toBe(fanId);
    } finally {
      await cleanup(orgId);
    }
  });

  test('an empty name is stored as a blank child name and the review still opens', async () => {
    const orgId = uuid();
    const fanId = uuid();
    try {
      const guardianEmail = await seedChild(orgId, fanId);
      const result = await call(orgId, guardianEmail, { name: '' });
      const staging = await client.query(
        'SELECT child_name FROM staging_household_data WHERE org_id = $1',
        [orgId]
      );
      const review = await client.query(
        'SELECT status FROM conflict_queue WHERE id = $1',
        [result.conflict_id]
      );
      expect(staging.rows).toHaveLength(1);
      expect(staging.rows[0].child_name).toBe('');
      expect(review.rows[0].status).toBe('pending');
    } finally {
      await cleanup(orgId);
    }
  });

  test('a staging insert that fails for another reason still commits the review', async () => {
    const orgId = uuid();
    const fanId = uuid();
    try {
      const guardianEmail = await seedChild(orgId, fanId);
      const result = await call(orgId, guardianEmail, { name: 'sam smith', dob: 'not-a-date' });
      const staging = await client.query(
        'SELECT id FROM staging_household_data WHERE org_id = $1',
        [orgId]
      );
      const review = await client.query(
        'SELECT fan_id_a, status FROM conflict_queue WHERE id = $1',
        [result.conflict_id]
      );
      expect(staging.rows).toHaveLength(0);
      expect(result.match_type).toBe('conflict');
      expect(review.rows[0].status).toBe('pending');
      expect(review.rows[0].fan_id_a).toBe(fanId);
    } finally {
      await cleanup(orgId);
    }
  });
});
