'use strict';

require('dotenv').config();

const crypto = require('crypto');
const { Client } = require('pg');
const cases = require('../eval/fixtures/level2-cases.json');
const { classifyObserved } = require('../eval/level2');
const { resolverEngine } = require('../src/modules/resolverEngine');
const { normalizeIdentifier } = require('../src/modules/normalizer');

function assertLocal() {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes('localhost:5432')) {
    throw new Error('level 2 resolver tests only run against local Postgres on port 5432');
  }
}

function uuid() {
  return crypto.randomUUID();
}

function normalizeFields(raw) {
  const fields = {};
  if (raw.email) fields.email = normalizeIdentifier('email', raw.email);
  if (raw.name) fields.name = normalizeIdentifier('name', raw.name);
  if (raw.dob) fields.dob = normalizeIdentifier('dob', raw.dob);
  if (raw.zip) fields.zip = normalizeIdentifier('zip', raw.zip);
  if (raw.guardian_email) fields.guardian_email = normalizeIdentifier('guardian_email', raw.guardian_email);
  if (raw.nfc_uid) fields.nfc_uid = normalizeIdentifier('nfc_uid', raw.nfc_uid);
  return fields;
}

function buildInput(orgId, shape, fields) {
  const identifiers = {};
  if (fields.name) identifiers.name = fields.name;
  if (fields.dob) identifiers.dob = fields.dob;
  if (fields.zip) identifiers.zip = fields.zip;
  if (fields.email) identifiers.email = fields.email;
  if (shape === 'advisory' && fields.guardian_email) identifiers.guardian_email = fields.guardian_email;

  if (shape === 'advisory') {
    return {
      identifier_type: 'nfc_uid',
      identifier_value: fields.nfc_uid,
      identifiers,
      org_id: orgId,
      schema_version: '1.0',
      idempotency_key: uuid(),
      source_system: 'csv_import',
    };
  }

  return {
    identifier_type: fields.email ? 'email' : 'name',
    identifier_value: fields.email || fields.name,
    identifiers,
    org_id: orgId,
    schema_version: '1.0',
    idempotency_key: uuid(),
    source_system: 'csv_import',
  };
}

function idList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value === '{}') return [];
  return value.replace(/[{}]/g, '').split(',').filter(Boolean);
}

describe('classifyObserved', () => {
  test('reads the trace class and does not treat a hard match as a blocking miss', () => {
    expect(classifyObserved({
      resolution_path: 'A', skip_reason: 'deterministic_match',
      candidates_considered: 0, candidates_scored: 0,
    }, 'match')).toBe('hard_match');
    expect(classifyObserved({
      resolution_path: 'D', skip_reason: null,
      candidates_considered: 1, candidates_scored: 1,
    }, 'match')).toBe('found');
    expect(classifyObserved({
      resolution_path: 'B', skip_reason: 'empty_block',
      candidates_considered: 0, candidates_scored: 0,
    }, 'match')).toBe('blocking_miss');
    expect(classifyObserved({
      resolution_path: 'B', skip_reason: null,
      candidates_considered: 1, candidates_scored: 1,
    }, 'match')).toBe('scoring_miss');
    expect(classifyObserved({
      resolution_path: 'B', skip_reason: 'empty_block',
      candidates_considered: 0, candidates_scored: 0,
    }, 'not_match')).toBe('correct_separation');
    expect(classifyObserved({
      resolution_path: 'C', skip_reason: null,
      candidates_considered: 1, candidates_scored: 1,
    }, 'not_match')).toBe('false_alarm');
    expect(classifyObserved({
      resolution_path: 'A', skip_reason: 'deterministic_match',
      candidates_considered: 0, candidates_scored: 0,
    }, 'not_match')).toBe('unclassified');
  });
});

test('a malformed birthday is rejected before the resolver', () => {
  expect(() => normalizeIdentifier('dob', 'not-a-date')).toThrow(/dob format invalid/);
});

describe('level 2 resolver', () => {
  let client;

  beforeAll(async () => {
    assertLocal();
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function seedOrg(orgId) {
    const hash = crypto.createHash('sha256').update(`level2-${orgId}`).digest('hex');
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash, is_active) VALUES ($1, $2, $3, true)`,
      [orgId, `_level2_${orgId.slice(0, 8)}`, hash]
    );
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
  }

  async function seedFan(fanId, orgId) {
    await client.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
      [fanId, orgId]
    );
  }

  async function seedIdentifier(fanId, orgId, type, value, sourceSystem) {
    await client.query(
      `INSERT INTO identifier_link
         (fan_id, org_id, identifier_type, identifier_value, source_system, schema_version, confidence_score,
          first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, '1.0', 1.0, NOW(), NOW())`,
      [fanId, orgId, type, value, sourceSystem]
    );
  }

  async function cleanup(orgId) {
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
    await client.query('DELETE FROM staging_household_data WHERE org_id = $1', [orgId]).catch(() => {});
    await client.query('DELETE FROM identifier_link WHERE org_id = $1', [orgId]).catch(() => {});
    await client.query('DELETE FROM fan WHERE org_id = $1', [orgId]).catch(() => {});
    await client.query('DELETE FROM org WHERE id = $1', [orgId]).catch(() => {});
  }

  test.each(cases)('$id observes $expected_class', async (spec) => {
    const orgId = uuid();
    const seeded = [];
    try {
      await seedOrg(orgId);
      const stored = normalizeFields(spec.person_a);
      const source = spec.person_a.source_system || 'csv_import';
      const copies = spec.seed_count || 1;
      for (let i = 0; i < copies; i += 1) {
        const fanId = uuid();
        seeded.push(fanId);
        await seedFan(fanId, orgId);
        for (const type of ['email', 'name', 'dob', 'zip', 'guardian_email']) {
          if (stored[type]) await seedIdentifier(fanId, orgId, type, stored[type], source);
        }
      }

      const submitted = normalizeFields(spec.person_b);
      const result = await resolverEngine(buildInput(orgId, spec.shape, submitted), client);
      const traceResult = await client.query(
        'SELECT * FROM resolution_trace WHERE audit_event_id = $1',
        [result.audit_event_id]
      );
      const trace = traceResult.rows[0];
      const seen = idList(trace.candidate_ids);

      expect(trace.resolution_path).toBe(spec.expected_path);
      expect(trace.skip_reason).toBe(spec.expected_skip_reason);
      expect(classifyObserved(trace, spec.expected_verdict)).toBe(spec.expected_class);
      if (spec.expect_retrieved) {
        expect(seen).toContain(seeded[0]);
      } else {
        expect(seen.filter((id) => seeded.includes(id))).toEqual([]);
      }
      if (spec.expected_class === 'found') {
        expect(result.conflict_id).toBeTruthy();
        const review = await client.query(
          'SELECT status, fan_id_a FROM conflict_queue WHERE id = $1',
          [result.conflict_id]
        );
        expect(review.rows[0].status).toBe('pending');
        expect(review.rows[0].fan_id_a).toBe(seeded[0]);
      }
      if (spec.expected_class === 'hard_match') {
        expect(result.fan_id).toBe(seeded[0]);
        expect(result.is_new_record).toBe(false);
      }
      if (spec.expected_class === 'scoring_miss') {
        expect(Number(trace.best_score)).toBe(0);
        expect(Number(trace.candidates_scored)).toBeGreaterThan(0);
      }
      if (spec.expect_score !== undefined) {
        expect(trace.best_score).not.toBeNull();
        expect(Number(trace.best_score)).toBe(spec.expect_score);
      }
      if (spec.expect_dob_veto) {
        const signals = Array.isArray(trace.signal_results) ? trace.signal_results : [];
        expect(signals).toEqual(expect.arrayContaining([
          expect.objectContaining({ signal: 'dob_veto' }),
        ]));
        expect(trace.best_candidate_id).toBe(seeded[0]);
        expect(Number(trace.best_score)).toBe(0);
        expect(trace.inbound_identifiers.email).toBeTruthy();
        expect(trace.inbound_identifiers.dob).toBeTruthy();
        expect(result.conflict_id).toBeTruthy();
        expect(result.is_new_record).toBe(true);
        const review = await client.query(
          'SELECT status, fan_id_a, fan_id_b FROM conflict_queue WHERE id = $1',
          [result.conflict_id]
        );
        expect(review.rows[0].status).toBe('pending');
        expect(review.rows[0].fan_id_a).toBe(seeded[0]);
        expect(review.rows[0].fan_id_b).toBe(result.fan_id);
        const emailOnNew = await client.query(
          `SELECT 1 FROM identifier_link WHERE fan_id = $1 AND identifier_type = 'email'`,
          [result.fan_id]
        );
        expect(emailOnNew.rows).toHaveLength(0);
        const emailOnOld = await client.query(
          `SELECT identifier_value FROM identifier_link
            WHERE fan_id = $1 AND org_id = $2 AND identifier_type = 'email'`,
          [seeded[0], orgId]
        );
        expect(emailOnOld.rows.length).toBeGreaterThan(0);
        const merges = await client.query(
          `SELECT 1 FROM merge_history
            WHERE fan_id_source = $1 OR fan_id_target = $1
               OR fan_id_source = $2 OR fan_id_target = $2`,
          [result.fan_id, seeded[0]]
        );
        expect(merges.rows).toHaveLength(0);
      }
      if (spec.expect_name_dob_veto) {
        const signals = Array.isArray(trace.signal_results) ? trace.signal_results : [];
        expect(signals).toEqual(expect.arrayContaining([
          expect.objectContaining({ signal: 'dob_veto' }),
        ]));
        expect(trace.best_candidate_id).toBe(seeded[0]);
        expect(Number(trace.best_score)).toBe(0);
        expect(trace.inbound_identifiers.name).toBeTruthy();
        expect(trace.inbound_identifiers.dob).toBeTruthy();
        const blocks = Array.isArray(trace.block_results) ? trace.block_results : [];
        const nameDob = blocks.find((row) => row.key === 'name_dob');
        expect(nameDob).toBeTruthy();
        expect(Number(nameDob.block_size)).toBe(0);
        expect(result.conflict_id).toBeTruthy();
        expect(result.is_new_record).toBe(true);
        const review = await client.query(
          'SELECT status, fan_id_a, fan_id_b FROM conflict_queue WHERE id = $1',
          [result.conflict_id]
        );
        expect(review.rows[0].status).toBe('pending');
        expect(review.rows[0].fan_id_a).toBe(seeded[0]);
        expect(review.rows[0].fan_id_b).toBe(result.fan_id);
        const nameOnNew = await client.query(
          `SELECT identifier_value FROM identifier_link
            WHERE fan_id = $1 AND org_id = $2 AND identifier_type = 'name'`,
          [result.fan_id, orgId]
        );
        const nameOnOld = await client.query(
          `SELECT identifier_value FROM identifier_link
            WHERE fan_id = $1 AND org_id = $2 AND identifier_type = 'name'`,
          [seeded[0], orgId]
        );
        expect(nameOnNew.rows.length).toBeGreaterThan(0);
        expect(nameOnOld.rows.length).toBeGreaterThan(0);
        expect(nameOnNew.rows[0].identifier_value).toBe(nameOnOld.rows[0].identifier_value);
        const merges = await client.query(
          `SELECT 1 FROM merge_history
            WHERE fan_id_source = $1 OR fan_id_target = $1
               OR fan_id_source = $2 OR fan_id_target = $2`,
          [result.fan_id, seeded[0]]
        );
        expect(merges.rows).toHaveLength(0);
      }
    } finally {
      await cleanup(orgId);
    }
  });
});
