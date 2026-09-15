'use strict';

// =============================================================================
// tests/routes/export.test.js — GET /v1/export/fans
//
// Connects to LOCAL Postgres ONLY (localhost:5432 via DATABASE_URL). Never
// point this at Cloud SQL (port 5433) or a remote host.
//
// Unlike most tests/routes/*.test.js (conflicts.test.js, household.test.js),
// this file does NOT mock req.db/req.context and mount only the router under
// test. Two of this endpoint's required behaviors — a real 401/403 from
// orgAuthMiddleware, and a real merge produced by the real confirm endpoint —
// only exist when the real middleware chain and a real database are in the
// request path. See tasks/lessons.md #26: the two patterns in tests/routes/
// exist for a reason, not by drift — pick the one the test list actually needs.
// =============================================================================

require('dotenv').config();

(function guardLocalOnly() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('BLOCKED: DATABASE_URL is not set. Add it to .env and point it at localhost:5432.');
  }
  const parsed = new URL(raw);
  const host = parsed.hostname;
  const port = parsed.port || '5432';
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocal || port === '5433') {
    throw new Error(`BLOCKED: DATABASE_URL (${host}:${port}) does not point to local Postgres on port 5432.`);
  }
}());

const crypto  = require('crypto');
const express = require('express');
const request = require('supertest');
const { parse } = require('csv-parse/sync');

const pool                    = require('../../src/db/pool');
const orgAuthMiddleware       = require('../../src/middleware/orgAuthMiddleware');
const rlsContextMiddleware    = require('../../src/middleware/rlsContextMiddleware');
const correlationIdMiddleware = require('../../src/middleware/correlationIdMiddleware');
const exportRouter            = require('../../src/routes/export');
const conflictsRouter         = require('../../src/routes/conflicts');

const hashKey = (rawKey) => crypto.createHash('sha256').update(rawKey).digest('hex');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(orgAuthMiddleware);
  app.use(rlsContextMiddleware);
  app.use(correlationIdMiddleware);
  app.use(exportRouter);
  app.use(conflictsRouter);
  return app;
}

let app;
let orgId, rawKey;
let otherOrgId;
let inactiveOrgId, inactiveRawKey;
const fanIds          = [];
const conflictIds      = [];
const mergeHistoryIds  = [];
const otherFanIds     = [];

async function createOrg(name, { isActive = true } = {}) {
  const id  = crypto.randomUUID();
  const key = `raw-key-${id}`;
  await pool.query(
    `INSERT INTO org (id, name, is_active, org_api_key_hash) VALUES ($1, $2, $3, $4)`,
    [id, name, isActive, hashKey(key)]
  );
  return { id, rawKey: key };
}

async function insertFan(org) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
     VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
    [id, org]
  );
  return id;
}

async function insertIdentifier(fanId, org, type, value) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO identifier_link
       (id, fan_id, org_id, identifier_type, identifier_value, source_system,
        schema_version, confidence_score, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, 'test', 'v1', 1.0, NOW(), NOW())`,
    [id, fanId, org, type, value]
  );
  return id;
}

beforeAll(async () => {
  app = buildApp();

  ({ id: orgId, rawKey } = await createOrg('Export Test Org'));
  ({ id: otherOrgId } = await createOrg('Export Test Org — Other'));
  ({ id: inactiveOrgId, rawKey: inactiveRawKey } = await createOrg('Export Test Org — Inactive', { isActive: false }));
});

afterAll(async () => {
  // FK cleanup order: merge_history / conflict_queue -> identifier_link -> fan
  // -> export_run -> org. audit_log is append-only by convention — this
  // endpoint never writes to it, so there is nothing to leave behind there.
  const allFanIds = [...fanIds, ...otherFanIds];
  const allOrgIds = [orgId, otherOrgId, inactiveOrgId];

  for (const id of mergeHistoryIds) {
    await pool.query(`DELETE FROM merge_history WHERE id = $1`, [id]).catch(() => {});
  }
  for (const id of conflictIds) {
    await pool.query(`DELETE FROM conflict_queue WHERE id = $1`, [id]).catch(() => {});
  }
  if (allFanIds.length > 0) {
    await pool.query(`DELETE FROM identifier_link WHERE fan_id = ANY($1::uuid[])`, [allFanIds]).catch(() => {});
    await pool.query(`DELETE FROM fan WHERE id = ANY($1::uuid[])`, [allFanIds]).catch(() => {});
  }
  await pool.query(`DELETE FROM export_run WHERE org_id = ANY($1::uuid[])`, [allOrgIds]).catch(() => {});
  await pool.query(`DELETE FROM org WHERE id = ANY($1::uuid[])`, [allOrgIds]).catch(() => {});

  await pool.end();
});

function auth(req, key) {
  return req.set('Authorization', `Bearer ${key}`);
}

function parseCsv(text) {
  return parse(text, { columns: true, skip_empty_lines: false });
}

const EXPECTED_HEADER = [
  'fan_id', 'created_at', 'updated_at',
  'email', 'name', 'dob', 'zip', 'device_id', 'guardian_email',
  'email_last_seen_at', 'name_last_seen_at', 'dob_last_seen_at',
  'zip_last_seen_at', 'device_last_seen_at', 'guardian_email_last_seen_at',
  'merged_from'
];

describe('GET /v1/export/fans', () => {

  // ───────────────────────────────────────────────────────────────────────
  // 1, 2 — basic export, header + column order
  // ───────────────────────────────────────────────────────────────────────
  test('1/2 — exports 3 seeded fans with the exact header row and column order', async () => {
    const fanA = await insertFan(orgId); fanIds.push(fanA);
    const fanB = await insertFan(orgId); fanIds.push(fanB);
    const fanC = await insertFan(orgId); fanIds.push(fanC);
    await insertIdentifier(fanA, orgId, 'email', 'basic-a@example.com');
    await insertIdentifier(fanB, orgId, 'email', 'basic-b@example.com');
    await insertIdentifier(fanC, orgId, 'email', 'basic-c@example.com');

    const res = await auth(request(app).get('/v1/export/fans'), rawKey);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);

    const lines = res.text.trim().split('\n');
    expect(lines[0].split(',')).toEqual(EXPECTED_HEADER);

    const rows = parseCsv(res.text).filter(r => [fanA, fanB, fanC].includes(r.fan_id));
    expect(rows).toHaveLength(3);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3 — missing identifiers are empty strings, not 'null'/'undefined'
  // ───────────────────────────────────────────────────────────────────────
  test('3 — a fan with only an email has every other identifier column empty', async () => {
    const fan = await insertFan(orgId); fanIds.push(fan);
    await insertIdentifier(fan, orgId, 'email', 'only-email@example.com');

    const res = await auth(request(app).get('/v1/export/fans'), rawKey);
    const row = parseCsv(res.text).find(r => r.fan_id === fan);

    expect(row).toBeDefined();
    expect(row.email).toBe('only-email@example.com');
    for (const col of ['name', 'dob', 'zip', 'device_id', 'guardian_email',
                        'name_last_seen_at', 'dob_last_seen_at', 'zip_last_seen_at',
                        'device_last_seen_at', 'guardian_email_last_seen_at', 'merged_from']) {
      expect(row[col]).toBe('');
      expect(row[col]).not.toMatch(/null|undefined/i);
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // 4 — soft-deleted fans excluded
  // ───────────────────────────────────────────────────────────────────────
  test('4 — a soft-deleted fan does not appear', async () => {
    const fan = await insertFan(orgId); fanIds.push(fan);
    await insertIdentifier(fan, orgId, 'email', 'deleted-fan@example.com');
    await pool.query(`UPDATE fan SET deleted_at = NOW() WHERE id = $1`, [fan]);

    const res = await auth(request(app).get('/v1/export/fans'), rawKey);
    const row = parseCsv(res.text).find(r => r.fan_id === fan);

    expect(row).toBeUndefined();
  });

  // ───────────────────────────────────────────────────────────────────────
  // 5 — merged fans appear once, as the survivor, via the REAL confirm endpoint
  // ───────────────────────────────────────────────────────────────────────
  test('5 — merged fan B is absent, survivor A appears once with merged_from = B', async () => {
    const fanA = await insertFan(orgId); fanIds.push(fanA);
    const fanB = await insertFan(orgId); fanIds.push(fanB);
    await insertIdentifier(fanA, orgId, 'email', 'merge-survivor@example.com');
    await insertIdentifier(fanB, orgId, 'name', 'merge loser');

    const conflictId = crypto.randomUUID();
    conflictIds.push(conflictId);
    await pool.query(
      `INSERT INTO conflict_queue (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status, created_at)
       VALUES ($1, $2, $3, $4, 0.9, '{}', 'pending', NOW())`,
      [conflictId, fanA, fanB, orgId]
    );

    const confirmRes = await auth(request(app).post(`/v1/conflicts/${conflictId}/confirm`), rawKey);
    expect(confirmRes.status).toBe(200);

    const mergeRow = await pool.query(
      `SELECT id FROM merge_history WHERE conflict_id = $1`, [conflictId]
    );
    mergeHistoryIds.push(...mergeRow.rows.map(r => r.id));

    const res = await auth(request(app).get('/v1/export/fans'), rawKey);
    const rows = parseCsv(res.text);

    expect(rows.find(r => r.fan_id === fanB)).toBeUndefined();
    const survivorRow = rows.find(r => r.fan_id === fanA);
    expect(survivorRow).toBeDefined();
    expect(survivorRow.merged_from.split(';')).toContain(fanB);
    expect(rows.filter(r => r.fan_id === fanA)).toHaveLength(1);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 6 — CSV escaping, verified with a real parser
  // ───────────────────────────────────────────────────────────────────────
  test('6 — names with commas and embedded quotes round-trip through a real CSV parser', async () => {
    const fanComma = await insertFan(orgId); fanIds.push(fanComma);
    const fanQuote = await insertFan(orgId); fanIds.push(fanQuote);
    await insertIdentifier(fanComma, orgId, 'name', 'Smith, John');
    await insertIdentifier(fanQuote, orgId, 'name', 'The "Big" Fan');

    const res = await auth(request(app).get('/v1/export/fans'), rawKey);
    const rows = parseCsv(res.text);

    const commaRow = rows.find(r => r.fan_id === fanComma);
    const quoteRow = rows.find(r => r.fan_id === fanQuote);

    expect(commaRow.name).toBe('Smith, John');
    expect(quoteRow.name).toBe('The "Big" Fan');
  });

  // ───────────────────────────────────────────────────────────────────────
  // 7 — empty org
  // ───────────────────────────────────────────────────────────────────────
  test('7 — an org with zero fans gets a 200 header-only CSV and export_run row_count 0', async () => {
    const { id: emptyOrgId, rawKey: emptyRawKey } = await createOrg('Export Test Org — Empty');

    const res = await auth(request(app).get('/v1/export/fans'), emptyRawKey);

    expect(res.status).toBe(200);
    const lines = res.text.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0].split(',')).toEqual(EXPECTED_HEADER);

    const runRow = await pool.query(
      `SELECT status, row_count FROM export_run WHERE org_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [emptyOrgId]
    );
    expect(runRow.rows[0].status).toBe('success');
    expect(runRow.rows[0].row_count).toBe(0);

    await pool.query(`DELETE FROM export_run WHERE org_id = $1`, [emptyOrgId]);
    await pool.query(`DELETE FROM org WHERE id = $1`, [emptyOrgId]);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 8 — cross-org isolation
  // ───────────────────────────────────────────────────────────────────────
  test('8 — exporting as org A never returns org B fans, row count matches org A only', async () => {
    const fanOther = await insertFan(otherOrgId); otherFanIds.push(fanOther);
    await insertIdentifier(fanOther, otherOrgId, 'email', 'other-org-fan@example.com');

    const resA = await auth(request(app).get('/v1/export/fans'), rawKey);
    const rowsA = parseCsv(resA.text);
    expect(rowsA.find(r => r.fan_id === fanOther)).toBeUndefined();

    const countA = await pool.query(`SELECT COUNT(*) FROM fan WHERE org_id = $1 AND deleted_at IS NULL`, [orgId]);
    expect(rowsA).toHaveLength(parseInt(countA.rows[0].count, 10));
  });

  // ───────────────────────────────────────────────────────────────────────
  // 9 — export_run success row
  // ───────────────────────────────────────────────────────────────────────
  test('9 — export_run success row has row_count matching the CSV, completed_at, requested_by = org_name', async () => {
    const res = await auth(request(app).get('/v1/export/fans'), rawKey);
    const rows = parseCsv(res.text);

    const runRow = await pool.query(
      `SELECT status, row_count, completed_at, requested_by
       FROM export_run WHERE org_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [orgId]
    );

    expect(runRow.rows[0].status).toBe('success');
    expect(runRow.rows[0].row_count).toBe(rows.length);
    expect(runRow.rows[0].completed_at).not.toBeNull();
    expect(runRow.rows[0].requested_by).toBe('Export Test Org');
  });

  // ───────────────────────────────────────────────────────────────────────
  // 10 — export_run failure path, generic 500, no orphaned running row
  // ───────────────────────────────────────────────────────────────────────
  test('10 — a failing query yields export_run failed, a generic 500, and no stuck running row', async () => {
    const realConnect = pool.connect.bind(pool);
    let forcedQuerySpy;

    // pool.query() (used by orgAuthMiddleware and by this test's own
    // verification queries) calls pool.connect(callback) internally —
    // callback-style, one argument. rlsContextMiddleware is the only caller
    // that does `await pool.connect()` with NO arguments (promise-style).
    // Branching on argument count means only the client this specific
    // request's req.db actually is gets its .query patched — every other
    // connect() in this test (auth lookup, verification reads) passes
    // straight through to the real implementation untouched.
    const connectSpy = jest.spyOn(pool, 'connect').mockImplementation((...args) => {
      if (args.length > 0) {
        return realConnect(...args);
      }
      return realConnect().then((client) => {
        const originalQuery = client.query.bind(client);
        forcedQuerySpy = jest.spyOn(client, 'query').mockImplementation((text, params) => {
          if (typeof text === 'string' && text.includes('FROM fan f')) {
            return Promise.reject(new Error('simulated export query failure'));
          }
          return originalQuery(text, params);
        });
        return client;
      });
    });

    try {
      const res = await auth(request(app).get('/v1/export/fans'), rawKey);

      // Restore immediately — the patch was only needed to fail THIS
      // request's own query. Left in place any longer, the patched client
      // goes back to the pool's idle list on release and can be handed to
      // this test's own verification pool.query() calls next. pool.query()
      // calls client.query(text, values, callback) internally (3-arg
      // callback style); a mock written for (text, params) promise-style
      // silently drops that callback, so the real driver never reports
      // completion and the call hangs forever — invisible to
      // statement_timeout, because no query ever reaches Postgres. Restoring
      // before touching pool.query() again sidesteps that pg-internals trap
      // entirely rather than making the mock handle both calling conventions.
      connectSpy.mockRestore();
      if (forcedQuerySpy) forcedQuerySpy.mockRestore();

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('export could not be completed');
      expect(res.body.correlation_id).toBeDefined();
      const bodyText = JSON.stringify(res.body);
      expect(bodyText).not.toMatch(/simulated export query failure|FROM fan f|identifier_link|stack/i);

      const runRows = await pool.query(
        `SELECT status, error_detail, completed_at FROM export_run
         WHERE org_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [orgId]
      );
      expect(runRows.rows).toHaveLength(1);
      expect(runRows.rows[0].status).toBe('failed');
      expect(runRows.rows[0].error_detail).toContain('simulated export query failure');
      expect(runRows.rows[0].completed_at).not.toBeNull();

      // No orphaned 'running' row for this org — the failure UPDATE is not
      // itself on the path that just failed.
      const stillRunning = await pool.query(
        `SELECT COUNT(*) FROM export_run WHERE org_id = $1 AND status = 'running'`,
        [orgId]
      );
      expect(parseInt(stillRunning.rows[0].count, 10)).toBe(0);
    } finally {
      connectSpy.mockRestore();
      if (forcedQuerySpy) forcedQuerySpy.mockRestore();
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // 11 — unknown query parameter rejected
  // ───────────────────────────────────────────────────────────────────────
  test('11 — an unknown query parameter (e.g. since) is rejected with 400, not silently ignored', async () => {
    const res = await auth(request(app).get('/v1/export/fans?since=2026-01-01'), rawKey);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported query parameter');
  });

  // ───────────────────────────────────────────────────────────────────────
  // 12 — auth required (real orgAuthMiddleware, real 401/403)
  // ───────────────────────────────────────────────────────────────────────
  test('12a — no API key returns 401', async () => {
    const res = await request(app).get('/v1/export/fans');
    expect(res.status).toBe(401);
  });

  test('12b — an invalid API key returns 401', async () => {
    const res = await auth(request(app).get('/v1/export/fans'), 'not-a-real-key');
    expect(res.status).toBe(401);
  });

  test('12c — an inactive org returns 403', async () => {
    const res = await auth(request(app).get('/v1/export/fans'), inactiveRawKey);
    expect(res.status).toBe(403);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 13 — Content-Disposition header with today's date
  // ───────────────────────────────────────────────────────────────────────
  test('13 — Content-Disposition header names a file containing today\'s ISO date', async () => {
    const res = await auth(request(app).get('/v1/export/fans'), rawKey);
    const isoDate = new Date().toISOString().slice(0, 10);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain(`golden-record-fans-${isoDate}.csv`);
  });

});
