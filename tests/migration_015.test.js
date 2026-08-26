'use strict';

// =============================================================================
// migration_015.test.js
// conflict_queue review-screen index — idx_conflict_queue_org_status_score
//
// Connects to: LOCAL Postgres only (localhost:5432 via DATABASE_URL).
// Never run against port 5433 (Cloud SQL proxy).
//
// This test does not create or clean up any rows — it verifies a schema
// object (the index) and the migration file's own safety guard.
// =============================================================================

require('dotenv').config();

const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', 'migration_015.sql');
const INDEX_NAME      = 'idx_conflict_queue_org_status_score';

describe('migration_015 — conflict_queue org/status/score index', () => {
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  // 1 — the index exists with the expected column order (org_id, status,
  // confidence_score DESC).
  test('idx_conflict_queue_org_status_score exists with confidence_score DESC', async () => {
    const result = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      [INDEX_NAME]
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].indexdef).toContain('confidence_score DESC');
    expect(result.rows[0].indexdef).toContain('(org_id, status, confidence_score DESC)');
  });

  // 2 — running the migration a second time raises the migration's own
  // guard exception (an informative "already applied" message) rather than
  // silently succeeding or surfacing only a raw Postgres duplicate-index
  // error as the sole signal.
  test('running the migration twice raises the expected guard exception', () => {
    const result = spawnSync(
      'psql',
      [process.env.DATABASE_URL, '-f', MIGRATION_PATH],
      { encoding: 'utf8' }
    );

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(combinedOutput).toMatch(
      /migration_015 already applied.*idx_conflict_queue_org_status_score exists/i
    );
  });
});
