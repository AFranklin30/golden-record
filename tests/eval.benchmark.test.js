'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const cases = require('../eval/fixtures/benchmarkCases');
const { actualBehavior, agrees, matchesPermitted, summarize, formatReport } = require('../eval/benchmark');
const { resolverEngine } = require('../src/modules/resolverEngine');
const { normalizeIdentifier } = require('../src/modules/normalizer');

const IDENTIFIER_TYPES = [
  'email', 'name', 'dob', 'zip', 'phone', 'nfc_uid', 'nba_id', 'ticketmaster_id',
  'guardian_email', 'guardian_phone',
];
const SIGNAL_FIELDS = ['name', 'dob', 'zip', 'email', 'guardian_email', 'device_id'];

function assertLocal() {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes('localhost:5432')) {
    throw new Error('benchmark tests only run against local Postgres on port 5432');
  }
}

function uuid() {
  return crypto.randomUUID();
}

function idList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value === '{}') return [];
  return value.replace(/[{}]/g, '').split(',').filter(Boolean);
}

function normalizeRecord(raw) {
  const fields = {};
  for (const type of IDENTIFIER_TYPES) {
    if (raw[type]) fields[type] = normalizeIdentifier(type, raw[type]);
  }
  if (raw.device_id) fields.device_id = raw.device_id;
  fields.source_system = raw.source_system || 'csv_import';
  return fields;
}

function buildInput(orgId, inbound) {
  const fields = normalizeRecord(inbound);
  const identifiers = {};
  for (const key of SIGNAL_FIELDS) {
    if (fields[key]) identifiers[key] = fields[key];
  }
  return {
    identifier_type: inbound.singular,
    identifier_value: fields[inbound.singular],
    identifiers,
    org_id: orgId,
    schema_version: '1.0',
    idempotency_key: uuid(),
    source_system: 'csv_import',
  };
}

function fanIndex(label) {
  const match = /^existing_(\d+)$/.exec(label || '');
  return match ? Number(match[1]) : null;
}

function resolvePermitted(permitted, existingIds) {
  return permitted.map((pair) => ({
    behavior: pair.behavior,
    fan: existingIds[fanIndex(pair.fan)],
    candidates_include: pair.candidates_include
      ? pair.candidates_include.map((label) => existingIds[fanIndex(label)])
      : undefined,
  }));
}

describe('benchmark metrics', () => {
  test('keeps a review out of precision and recall', () => {
    const summary = summarize([
      { category: 'exact_match', identity: 'same_person', expected: 'hard_match', actual: 'hard_match', policy_match: true, retrieval_expected: false, retrieved: false },
      { category: 'exact_match', identity: 'different_people', expected: 'hard_match', actual: 'hard_match', policy_match: true, retrieval_expected: false, retrieved: false },
      { category: 'exact_match', identity: 'same_person', expected: 'blocking_miss', actual: 'blocking_miss', policy_match: true, retrieval_expected: false, retrieved: false },
      { category: 'exact_match', identity: 'different_people', expected: 'blocking_miss', actual: 'blocking_miss', policy_match: true, retrieval_expected: false, retrieved: false },
      { category: 'exact_match', identity: 'same_person', expected: 'review', actual: 'review', policy_match: true, retrieval_expected: true, retrieved: true },
    ]);
    expect(summary.true_positives).toBe(1);
    expect(summary.false_positives).toBe(1);
    expect(summary.false_negatives).toBe(1);
    expect(summary.true_negatives).toBe(1);
    expect(summary.precision).toBe(0.5);
    expect(summary.recall).toBe(0.5);
    expect(summary.reviews).toBe(1);
    expect(summary.same_person_reviewed).toBe(1);
    expect(summary.correct_reviews).toBe(1);
    expect(summary.incorrect_new_person).toBe(1);
    const sharedName = [
      { behavior: 'hard_match', fan: 'existing_1' },
      { behavior: 'review', fan: 'existing_0', candidates_include: ['existing_0', 'existing_1'] },
    ];
    expect(matchesPermitted(sharedName, { behavior: 'hard_match', fan: 'existing_1', candidateIds: [] })).toBe(true);
    expect(matchesPermitted(sharedName, { behavior: 'hard_match', fan: 'existing_0', candidateIds: [] })).toBe(false);
    expect(matchesPermitted(sharedName, {
      behavior: 'review',
      fan: 'existing_0',
      candidateIds: ['existing_1', 'existing_0'],
    })).toBe(true);
    expect(matchesPermitted(sharedName, {
      behavior: 'review',
      fan: 'existing_1',
      candidateIds: ['existing_0', 'existing_1'],
    })).toBe(false);
    expect(matchesPermitted(sharedName, {
      behavior: 'review',
      fan: 'existing_0',
      candidateIds: ['existing_0'],
    })).toBe(false);
    expect(agrees('unspecified', 'scored_separation')).toBe(false);
    expect(actualBehavior({ resolution_path: 'B', skip_reason: 'empty_block' })).toBe('blocking_miss');
    expect(actualBehavior({ resolution_path: 'D', skip_reason: null })).toBe('review');
  });
});

describe('synthetic identity benchmark', () => {
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
    const hash = crypto.createHash('sha256').update(`benchmark-${orgId}`).digest('hex');
    await client.query(
      `INSERT INTO org (id, name, org_api_key_hash, is_active) VALUES ($1, $2, $3, true)`,
      [orgId, `_bench_${orgId.slice(0, 8)}`, hash]
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

  async function runScenario(spec) {
    const orgId = uuid();
    const existingIds = [];
    try {
      await seedOrg(orgId);
      const copies = spec.copies || 1;
      for (const record of spec.existing) {
        const stored = normalizeRecord(record);
        const times = spec.existing.length === 1 ? copies : 1;
        for (let i = 0; i < times; i += 1) {
          const fanId = uuid();
          existingIds.push(fanId);
          await seedFan(fanId, orgId);
          for (const type of IDENTIFIER_TYPES) {
            if (stored[type]) await seedIdentifier(fanId, orgId, type, stored[type], stored.source_system);
          }
        }
      }

      let result;
      try {
        result = await resolverEngine(buildInput(orgId, spec.inbound), client);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        return {
          id: spec.id,
          category: spec.category,
          identity: spec.identity,
          expected: spec.expected_behavior,
          actual: 'resolver_error',
          policy_match: false,
          check_failures: [err.message],
          retrieval_expected: spec.retrieval_expected === true,
          retrieved: false,
          notes: spec.notes,
          existing: spec.existing,
          inbound: spec.inbound,
          fan_id: null,
          is_new_record: null,
          conflict_fan_a: null,
          trace: {},
        };
      }
      const traceResult = await client.query(
        'SELECT * FROM resolution_trace WHERE audit_event_id = $1',
        [result.audit_event_id]
      );
      const trace = traceResult.rows[0];
      const candidateIds = idList(trace && trace.candidate_ids);
      let conflictFanA = null;
      if (result.conflict_id) {
        const review = await client.query(
          'SELECT fan_id_a, fan_id_b, status FROM conflict_queue WHERE id = $1',
          [result.conflict_id]
        );
        conflictFanA = review.rows[0] ? review.rows[0].fan_id_a : null;
      }
      const newTypesResult = await client.query(
        `SELECT identifier_type FROM identifier_link WHERE fan_id = $1 AND org_id = $2`,
        [result.fan_id, orgId]
      );
      const newTypes = newTypesResult.rows.map((row) => row.identifier_type);
      const mergeResult = await client.query(
        `SELECT 1 FROM merge_history
          WHERE fan_id_source = $1 OR fan_id_target = $1
             OR fan_id_source = ANY($2::uuid[]) OR fan_id_target = ANY($2::uuid[])`,
        [result.fan_id, existingIds]
      );

      const actual = actualBehavior(trace);
      const checkFailures = [];
      const checks = spec.checks || {};
      const matchedFan = trace && (trace.resolution_path === 'A' || trace.resolution_path === 'B')
        ? result.fan_id
        : conflictFanA;
      if (checks.matched_fan === 'any_existing') {
        if (!existingIds.includes(matchedFan)) checkFailures.push('matched fan was not one of the existing people');
      } else if (checks.matched_fan) {
        const index = fanIndex(checks.matched_fan);
        if (existingIds[index] !== matchedFan) checkFailures.push(`matched fan was not ${checks.matched_fan}`);
      }
      if (checks.retrieved_fan) {
        const index = fanIndex(checks.retrieved_fan);
        if (!candidateIds.includes(existingIds[index])) checkFailures.push(`did not retrieve ${checks.retrieved_fan}`);
      }
      for (const type of checks.new_lacks || []) {
        if (newTypes.includes(type)) checkFailures.push(`new person has ${type}`);
      }
      for (const type of checks.new_has || []) {
        if (!newTypes.includes(type)) checkFailures.push(`new person lacks ${type}`);
      }
      if (checks.block_key) {
        const blocks = Array.isArray(trace.block_results) ? trace.block_results : [];
        const block = blocks.find((row) => row.key === checks.block_key);
        if (!block) checkFailures.push(`missing block ${checks.block_key}`);
        else if (Number(block.block_size) !== checks.block_size) {
          checkFailures.push(`${checks.block_key} block size ${block.block_size}`);
        }
      }
      if (checks.no_merge && mergeResult.rows.length > 0) checkFailures.push('a merge was written');

      const personAllowed = Array.isArray(spec.permitted)
        ? matchesPermitted(resolvePermitted(spec.permitted, existingIds), {
          behavior: actual,
          fan: actual === 'review' ? conflictFanA : result.fan_id,
          candidateIds,
        })
        : agrees(spec.expected_behavior, actual);
      if (Array.isArray(spec.permitted) && !personAllowed) {
        checkFailures.push('result was not one of the permitted person outcomes');
      }

      const retrieved = checks.retrieved_fan
        ? candidateIds.includes(existingIds[fanIndex(checks.retrieved_fan)])
        : existingIds.some((id) => candidateIds.includes(id));

      return {
        id: spec.id,
        category: spec.category,
        identity: spec.identity,
        expected: spec.expected_behavior,
        actual,
        policy_match: personAllowed && checkFailures.length === 0,
        check_failures: checkFailures,
        retrieval_expected: spec.retrieval_expected === true,
        retrieved,
        notes: spec.notes,
        existing: spec.existing,
        inbound: spec.inbound,
        fan_id: result.fan_id,
        is_new_record: result.is_new_record,
        conflict_fan_a: conflictFanA,
        trace: {
          resolution_path: trace && trace.resolution_path,
          skip_reason: trace && trace.skip_reason,
          best_score: trace && trace.best_score,
          candidates_considered: trace && trace.candidates_considered,
          signal_results: trace && trace.signal_results,
          block_results: trace && trace.block_results,
        },
      };
    } finally {
      await cleanup(orgId);
    }
  }

  test('runs every scenario through the resolver and writes the report', async () => {
    const rows = [];
    for (const spec of cases) {
      rows.push(await runScenario(spec));
    }
    const summary = summarize(rows);
    const report = formatReport(summary, rows);
    const reportDir = path.join(__dirname, '..', 'eval', 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'benchmark-report.md'), report);
    fs.writeFileSync(path.join(reportDir, 'benchmark-report.json'), JSON.stringify({ summary, rows }, null, 2));

    const mismatches = rows.filter((row) => row.policy_match === false);
    expect(mismatches.map((row) => row.id)).toEqual([]);
    for (const id of [
      'children-share-guardian-email',
      'guardian-email-fifty',
      'guardian-email-retrieval',
    ]) {
      const row = rows.find((item) => item.id === id);
      expect(row.actual).toBe('review');
      expect(row.policy_match).toBe(true);
    }
    expect(summary.total).toBe(cases.length);
    expect(summary.policy_mismatches).toBe(0);
  }, 120000);
});
