'use strict';

// =============================================================================
// findBlockCandidates.test.js
// Blocking retrieval — narrowing helper (prompt 3 of 5)
//
// Connects to: LOCAL Postgres only (localhost:5432 via DATABASE_URL).
// Never run against port 5433 (Cloud SQL proxy).
//
// Handler-level logic — calls findBlockCandidates directly, no supertest.
// Fresh test org(s)/UUIDs per run. Cleanup in FK order in a finally block.
// findBlockCandidates never writes, so there is nothing in audit_log to leave
// behind from this file specifically — cleanup here is just fan/identifier_link.
// =============================================================================

require('dotenv').config();

const { Client } = require('pg');
const crypto     = require('crypto');
const { findBlockCandidates, BLOCK_SIZE_CAP } = require('../../src/modules/resolverEngine');

function randomUUID() {
  return crypto.randomUUID();
}

function orgKeyHash(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

describe('findBlockCandidates', () => {
  let client;
  let testOrgId;

  async function seedOrg(client, orgId, seed) {
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash) VALUES ($1, $2, $3)`,
      [orgId, '_findblock_test_org_' + seed, orgKeyHash('findblock-' + seed + '-' + orgId)]
    );
  }

  async function seedFan(client, fanId, orgId) {
    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [fanId, orgId]
    );
  }

  async function seedIdentifier(client, fanId, type, value, orgId, sourceSystem = 'test') {
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, identifier_type, identifier_value, org_id,
          source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, 'v1', 1.0, NOW(), NOW())`,
      [fanId, type, value, orgId, sourceSystem]
    );
  }

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    testOrgId = randomUUID();
    await seedOrg(client, testOrgId, 'main');

    await client.query(
      `SELECT set_config('app.current_org_id', $1, false)`,
      [testOrgId]
    );
  });

  afterAll(async () => {
    // FK order: identifier_link -> fan -> org (children before org).
    await client.query(`DELETE FROM identifier_link WHERE org_id = $1`, [testOrgId]);
    await client.query(`DELETE FROM fan WHERE org_id = $1`, [testOrgId]);
    await client.query(`DELETE FROM org WHERE id = $1`, [testOrgId]);
    await client.end();
  });

  // 1 — email key retrieves.
  test('email key retrieves', async () => {
    const fanId = randomUUID();
    try {
      await seedFan(client, fanId, testOrgId);
      await seedIdentifier(client, fanId, 'email', 'a@b.com', testOrgId);

      const result = await findBlockCandidates({ email: 'a@b.com' }, testOrgId, client);

      expect(result.fanIds).toEqual([fanId]);
      expect(result.blockResults).toContainEqual({ key: 'email', block_size: 1, dropped: false });
    } finally {
      await client.query(`DELETE FROM identifier_link WHERE fan_id = $1`, [fanId]);
      await client.query(`DELETE FROM fan WHERE id = $1`, [fanId]);
    }
  });

  // 2 — email key excludes non-sharers.
  test('email key excludes non-sharers', async () => {
    const fanId = randomUUID();
    const otherFanIds = Array.from({ length: 5 }, () => randomUUID());
    try {
      await seedFan(client, fanId, testOrgId);
      await seedIdentifier(client, fanId, 'email', 'a@b.com', testOrgId);

      for (let i = 0; i < otherFanIds.length; i++) {
        await seedFan(client, otherFanIds[i], testOrgId);
        await seedIdentifier(client, otherFanIds[i], 'email', `other${i}@b.com`, testOrgId);
      }

      const result = await findBlockCandidates({ email: 'a@b.com' }, testOrgId, client);

      expect(result.fanIds).toEqual([fanId]);
      expect(result.fanIds.length).toBe(1);
    } finally {
      const all = [fanId, ...otherFanIds];
      await client.query(`DELETE FROM identifier_link WHERE fan_id = ANY($1)`, [all]);
      await client.query(`DELETE FROM fan WHERE id = ANY($1)`, [all]);
    }
  });

  // 3 — guardian_email key retrieves.
  test('guardian_email key retrieves', async () => {
    const fanId = randomUUID();
    try {
      await seedFan(client, fanId, testOrgId);
      await seedIdentifier(client, fanId, 'guardian_email', 'g@h.com', testOrgId);

      const result = await findBlockCandidates({ guardian_email: 'g@h.com' }, testOrgId, client);

      expect(result.fanIds).toEqual([fanId]);
      expect(result.blockResults).toContainEqual({ key: 'guardian_email', block_size: 1, dropped: false });
    } finally {
      await client.query(`DELETE FROM identifier_link WHERE fan_id = $1`, [fanId]);
      await client.query(`DELETE FROM fan WHERE id = $1`, [fanId]);
    }
  });

  // 4 — name_dob retrieves across a first-name difference (last-word key).
  test('name_dob retrieves across a first-name difference', async () => {
    const fanId = randomUUID();
    try {
      await seedFan(client, fanId, testOrgId);
      await seedIdentifier(client, fanId, 'name', 'robert smith', testOrgId);
      await seedIdentifier(client, fanId, 'dob', '1990-01-01', testOrgId);

      const result = await findBlockCandidates(
        { name: 'bob smith', dob: '1990-01-01' }, testOrgId, client
      );

      expect(result.fanIds).toEqual([fanId]);
      expect(result.blockResults).toContainEqual({ key: 'name_dob', block_size: 1, dropped: false });
      expect(result.blockResults).toContainEqual({ key: 'similar_surname', block_size: 0, dropped: false });
    } finally {
      await client.query(`DELETE FROM identifier_link WHERE fan_id = $1`, [fanId]);
      await client.query(`DELETE FROM fan WHERE id = $1`, [fanId]);
    }
  });

  // 5 — name_dob excludes on dob mismatch.
  test('name_dob excludes on dob mismatch', async () => {
    const fanId = randomUUID();
    try {
      await seedFan(client, fanId, testOrgId);
      await seedIdentifier(client, fanId, 'name', 'robert smith', testOrgId);
      await seedIdentifier(client, fanId, 'dob', '1990-01-01', testOrgId);

      const result = await findBlockCandidates(
        { name: 'bob smith', dob: '1991-01-01' }, testOrgId, client
      );

      expect(result.blockResults).toContainEqual({ key: 'name_dob', block_size: 0, dropped: false });
      expect(result.blockResults).toContainEqual({ key: 'nickname_surname', block_size: 1, dropped: false });
      expect(result.fanIds).toEqual([fanId]);
    } finally {
      await client.query(`DELETE FROM identifier_link WHERE fan_id = $1`, [fanId]);
      await client.query(`DELETE FROM fan WHERE id = $1`, [fanId]);
    }
  });

  // 6 — name_dob requires BOTH fields.
  test('name_dob requires both fields — no dob means key is absent and no probe runs', async () => {
    const spy = jest.spyOn(client, 'query');
    try {
      const result = await findBlockCandidates({ name: 'bob smith' }, testOrgId, client);

      expect(result.keysAvailable).not.toContain('name_dob');
      expect(result.keysAvailable).not.toContain('similar_surname');
      const nameDobCall = spy.mock.calls.find(
        c => typeof c[0] === 'string' && c[0].includes('il_n.name_last_word')
      );
      expect(nameDobCall).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  // 7 — union, not intersect.
  test('union, not intersect — surfaces candidates from either key', async () => {
    const fanA = randomUUID(); // email only
    const fanB = randomUUID(); // name + dob only
    try {
      await seedFan(client, fanA, testOrgId);
      await seedIdentifier(client, fanA, 'email', 'union@test.com', testOrgId);

      await seedFan(client, fanB, testOrgId);
      await seedIdentifier(client, fanB, 'name', 'union person', testOrgId);
      await seedIdentifier(client, fanB, 'dob', '1985-05-05', testOrgId);

      const result = await findBlockCandidates(
        { email: 'union@test.com', name: 'union person', dob: '1985-05-05' },
        testOrgId, client
      );

      expect(result.fanIds.sort()).toEqual([fanA, fanB].sort());
      expect(result.fanIds.length).toBe(2);
    } finally {
      const all = [fanA, fanB];
      await client.query(`DELETE FROM identifier_link WHERE fan_id = ANY($1)`, [all]);
      await client.query(`DELETE FROM fan WHERE id = ANY($1)`, [all]);
    }
  });

  // 8 — dedupe. Exact surname also satisfies similar_surname, so three keys hit.
  test('dedupe — a fan matching email, name_dob, and similar_surname appears once', async () => {
    const fanId = randomUUID();
    try {
      await seedFan(client, fanId, testOrgId);
      await seedIdentifier(client, fanId, 'email', 'dedupe@test.com', testOrgId);
      await seedIdentifier(client, fanId, 'name', 'dedupe person', testOrgId);
      await seedIdentifier(client, fanId, 'dob', '1980-01-01', testOrgId);

      const result = await findBlockCandidates(
        { email: 'dedupe@test.com', name: 'dedupe person', dob: '1980-01-01' },
        testOrgId, client
      );

      expect(result.fanIds).toEqual([fanId]);
      expect(result.fanIds.length).toBe(1);
      expect(result.blockResults).toEqual(expect.arrayContaining([
        { key: 'email', block_size: 1, dropped: false },
        { key: 'name_dob', block_size: 1, dropped: false },
        { key: 'similar_surname', block_size: 1, dropped: false },
      ]));
    } finally {
      await client.query(`DELETE FROM identifier_link WHERE fan_id = $1`, [fanId]);
      await client.query(`DELETE FROM fan WHERE id = $1`, [fanId]);
    }
  });

  // 9 — drop at the cap.
  test('drop at the cap — 51 sharers drops the block whole', async () => {
    const fanIds = Array.from({ length: BLOCK_SIZE_CAP + 1 }, () => randomUUID());
    try {
      for (const id of fanIds) {
        await seedFan(client, id, testOrgId);
        // source_system 'fan_pass' — uq_identifier_per_org excludes fan_pass rows,
        // which is what lets 51 fans legitimately share one guardian_email.
        await seedIdentifier(client, id, 'guardian_email', 'big@fam.com', testOrgId, 'fan_pass');
      }

      const result = await findBlockCandidates(
        { guardian_email: 'big@fam.com' }, testOrgId, client
      );

      expect(result.fanIds).toEqual([]);
      expect(result.blockResults).toContainEqual({
        key: 'guardian_email', block_size: BLOCK_SIZE_CAP + 1, dropped: true
      });
    } finally {
      await client.query(`DELETE FROM identifier_link WHERE fan_id = ANY($1)`, [fanIds]);
      await client.query(`DELETE FROM fan WHERE id = ANY($1)`, [fanIds]);
    }
  });

  // 10 — boundary is inclusive.
  test('boundary is inclusive — exactly 50 sharers is kept', async () => {
    const fanIds = Array.from({ length: BLOCK_SIZE_CAP }, () => randomUUID());
    try {
      for (const id of fanIds) {
        await seedFan(client, id, testOrgId);
        await seedIdentifier(client, id, 'guardian_email', 'exactly50@fam.com', testOrgId, 'fan_pass');
      }

      const result = await findBlockCandidates(
        { guardian_email: 'exactly50@fam.com' }, testOrgId, client
      );

      expect(result.blockResults).toContainEqual({
        key: 'guardian_email', block_size: BLOCK_SIZE_CAP, dropped: false
      });
      expect(result.fanIds.length).toBe(BLOCK_SIZE_CAP);
    } finally {
      await client.query(`DELETE FROM identifier_link WHERE fan_id = ANY($1)`, [fanIds]);
      await client.query(`DELETE FROM fan WHERE id = ANY($1)`, [fanIds]);
    }
  });

  // 11 — deleted fans are not retrieved.
  test('deleted fans are not retrieved — filter is inside the probe', async () => {
    const fanId = randomUUID();
    try {
      await seedFan(client, fanId, testOrgId);
      await seedIdentifier(client, fanId, 'email', 'deleted@test.com', testOrgId);
      await client.query(`UPDATE fan SET deleted_at = NOW() WHERE id = $1`, [fanId]);

      const result = await findBlockCandidates({ email: 'deleted@test.com' }, testOrgId, client);

      expect(result.fanIds).toEqual([]);
      expect(result.blockResults).toContainEqual({ key: 'email', block_size: 0, dropped: false });
    } finally {
      await client.query(`DELETE FROM identifier_link WHERE fan_id = $1`, [fanId]);
      await client.query(`DELETE FROM fan WHERE id = $1`, [fanId]);
    }
  });

  // 12 — no keys available.
  test('no keys available — returns empty shapes and runs no query', async () => {
    const spy = jest.spyOn(client, 'query');
    try {
      const result = await findBlockCandidates({ zip: '73102' }, testOrgId, client);

      expect(result.fanIds).toEqual([]);
      expect(result.blockResults).toEqual([]);
      expect(result.keysAvailable).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // 13 — last-word parity, JS vs SQL.
  test('last-word parity — JS split/pop agrees with the SQL generated column', async () => {
    const fanId = randomUUID();
    const dob = '1975-03-03';
    try {
      await seedFan(client, fanId, testOrgId);
      await seedIdentifier(client, fanId, 'name', 'mary jane watson', testOrgId);
      await seedIdentifier(client, fanId, 'dob', dob, testOrgId);

      const result = await findBlockCandidates(
        { name: 'mary jane watson', dob }, testOrgId, client
      );

      expect(result.fanIds).toEqual([fanId]);
    } finally {
      await client.query(`DELETE FROM identifier_link WHERE fan_id = $1`, [fanId]);
      await client.query(`DELETE FROM fan WHERE id = $1`, [fanId]);
    }
  });

  // 14 — cross-org isolation.
  test('cross-org isolation — same email in two orgs only returns the queried org fan', async () => {
    const fanA = randomUUID();
    const fanZ = randomUUID();
    const otherOrgId = randomUUID();
    try {
      await seedOrg(client, otherOrgId, 'second');

      await seedFan(client, fanA, testOrgId);
      await seedIdentifier(client, fanA, 'email', 'crossorg@test.com', testOrgId);

      await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [otherOrgId]);
      await seedFan(client, fanZ, otherOrgId);
      await seedIdentifier(client, fanZ, 'email', 'crossorg@test.com', otherOrgId);
      await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [testOrgId]);

      const result = await findBlockCandidates({ email: 'crossorg@test.com' }, testOrgId, client);

      expect(result.fanIds).toEqual([fanA]);
    } finally {
      await client.query(`DELETE FROM identifier_link WHERE fan_id = $1`, [fanA]);
      await client.query(`DELETE FROM fan WHERE id = $1`, [fanA]);
      await client.query(`DELETE FROM identifier_link WHERE fan_id = $1`, [fanZ]);
      await client.query(`DELETE FROM fan WHERE id = $1`, [fanZ]);
      await client.query(`DELETE FROM org WHERE id = $1`, [otherOrgId]);
    }
  });
});
