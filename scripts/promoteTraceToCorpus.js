'use strict';

// scripts/promoteTraceToCorpus.js
// Golden Record
//
// Promotes one 'performed' resolution_trace row into evaluation_corpus,
// with a hand-built replayable candidate_snapshot and two deliberately
// disagreeing trace_label rows. Closes Stage 7 decisions 2 and 3 (where a
// promoted row's score/verdict come from) by producing the row that makes
// them observable in eval/runCorpus.js's output — see CLAUDE.md Stage 7.
//
// Run:  node scripts/promoteTraceToCorpus.js <org_id> <trace_id> [expected_verdict]
//
// Requires: local Postgres (localhost:5432) with migration_014 applied.
// This script must NEVER run against Cloud SQL — see guardLocalOnly below.

require('dotenv').config();

// ── Safety guard — local Postgres only, mirrors scripts/seedDemoOrg.js ────
(function guardLocalOnly() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error('BLOCKED: DATABASE_URL is not set. Add it to .env and point it at localhost:5432.');
    process.exit(1);
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    console.error('BLOCKED: DATABASE_URL could not be parsed. Check .env.');
    process.exit(1);
  }
  const host    = parsed.hostname;
  const port    = parsed.port || '5432';
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!isLocal || port === '5433') {
    console.error('BLOCKED: DATABASE_URL does not point to local Postgres on port 5432.');
    console.error(`  host: ${host}  port: ${port}`);
    console.error('  This script must never run against Cloud SQL (port 5433) or a remote host.');
    process.exit(1);
  }
}());

const crypto = require('crypto');
const { Client } = require('pg');
const { isValidUuid } = require('../src/lib/validate');

const VALID_VERDICTS = ['match', 'not_match', 'unsure'];
const DEFAULT_EXPECTED_VERDICT = 'not_match';
const DEFAULT_RATIONALE =
  'expected_verdict deliberately set to disagree with the production path ' +
  'outcome to test whether the harness preserves label disagreement. Not a ' +
  'substantive verdict on this pair.';
const CREATED_BY = 'aaron';

// The two labels are deliberately disagreeing by design (Stage 7 decision 3
// trap) — one MUST NOT be dropped or collapsed with the other.
const LABELS = [
  { labeled_by: 'aaron',   verdict: 'match' },
  { labeled_by: 'monique', verdict: 'not_match' },
];

class PromotionError extends Error {}

// Exact shape of resolverEngine.js's candidate SELECT (src/modules/resolverEngine.js,
// the LEFT JOIN block finding candidates for probabilistic scoring) — same
// 14 columns, same names, same JOIN structure. This is the ONLY way a
// promoted row can be replayed: resolution_trace.signal_results stores
// DERIVED signal results, not raw candidate field values (PII), so a
// snapshot can never be reconstructed from the trace itself — it must come
// from a fresh read of the actual fan.
const CANDIDATE_SELECT = `
  SELECT f.id, f.org_id,
         il_email.identifier_value    AS email,
         il_email.last_seen_at        AS email_last_seen_at,
         il_name.identifier_value     AS name,
         il_name.last_seen_at         AS name_last_seen_at,
         il_dob.identifier_value      AS dob,
         il_dob.last_seen_at          AS dob_last_seen_at,
         il_zip.identifier_value      AS zip,
         il_zip.last_seen_at          AS zip_last_seen_at,
         il_device.identifier_value   AS device_id,
         il_device.last_seen_at       AS device_last_seen_at,
         il_gemail.identifier_value   AS guardian_email,
         il_gemail.last_seen_at       AS guardian_email_last_seen_at
  FROM fan f
  LEFT JOIN identifier_link il_email
    ON il_email.fan_id = f.id AND il_email.identifier_type = 'email' AND il_email.org_id = $1
  LEFT JOIN identifier_link il_name
    ON il_name.fan_id = f.id AND il_name.identifier_type = 'name' AND il_name.org_id = $1
  LEFT JOIN identifier_link il_dob
    ON il_dob.fan_id = f.id AND il_dob.identifier_type = 'dob' AND il_dob.org_id = $1
  LEFT JOIN identifier_link il_zip
    ON il_zip.fan_id = f.id AND il_zip.identifier_type = 'zip' AND il_zip.org_id = $1
  LEFT JOIN identifier_link il_device
    ON il_device.fan_id = f.id AND il_device.identifier_type = 'device_id' AND il_device.org_id = $1
  LEFT JOIN identifier_link il_gemail
    ON il_gemail.fan_id = f.id AND il_gemail.identifier_type = 'guardian_email' AND il_gemail.org_id = $1
  WHERE f.id = $2 AND f.org_id = $1
`;

// promoteTraceToCorpus — RECEIVE / GUARD / EXECUTE / RETURN.
// org_id is always the caller-supplied argument, never trusted from the
// trace row — matches the platform's tenant-isolation discipline. Filters
// explicitly by org_id on every query rather than relying on RLS alone:
// local Postgres connects as the `postgres` superuser, which BYPASSRLS.
async function promoteTraceToCorpus(client, org_id, trace_id, options = {}) {
  const expected_verdict = options.expected_verdict ?? DEFAULT_EXPECTED_VERDICT;
  const rationale        = options.rationale ?? DEFAULT_RATIONALE;

  // GUARD — read the trace, scoped to this org explicitly.
  const traceResult = await client.query(
    `SELECT * FROM resolution_trace WHERE id = $1 AND org_id = $2`,
    [trace_id, org_id]
  );
  if (traceResult.rows.length === 0) {
    throw new PromotionError(
      `trace not found for org ${org_id}: ${trace_id} (does not exist, or belongs to a different org)`
    );
  }
  const trace = traceResult.rows[0];

  if (trace.scoring_status !== 'performed') {
    throw new PromotionError(
      `trace ${trace_id} is not eligible for promotion — scoring_status='${trace.scoring_status}', ` +
      `skip_reason='${trace.skip_reason}'. Only scoring_status='performed' traces have a comparable score.`
    );
  }

  // EXECUTE — STEP 1: fresh candidate read, module-independent of the trace.
  const candidateResult = await client.query(CANDIDATE_SELECT, [org_id, trace.best_candidate_id]);
  if (candidateResult.rows.length === 0) {
    throw new PromotionError(
      `best_candidate_id fan not found for org ${org_id}: ${trace.best_candidate_id}`
    );
  }
  const candidate_snapshot = candidateResult.rows[0];

  // EXECUTE — STEP 2/3: writes, transactional (corpus row + both labels
  // succeed together or not at all).
  const corpus_id = crypto.randomUUID();
  const label_ids = LABELS.map(() => crypto.randomUUID());

  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO evaluation_corpus
         (id, org_id, source, trace_id, inbound_identifiers, candidate_snapshot,
          expected_verdict, rationale, observed_score, observed_path,
          scorer_version, created_by)
       VALUES ($1, $2, 'promoted_trace', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        corpus_id,
        org_id,
        trace_id,
        JSON.stringify(trace.inbound_identifiers),
        JSON.stringify(candidate_snapshot),
        expected_verdict,
        rationale,
        trace.best_score,
        trace.resolution_path,
        // Read from the TRACE row, not the current SCORER_VERSION constant —
        // this row records what actually produced trace.best_score, which
        // may predate a later scorer config change.
        trace.scorer_version,
        CREATED_BY,
      ]
    );

    for (let i = 0; i < LABELS.length; i++) {
      await client.query(
        `INSERT INTO trace_label (id, trace_id, org_id, verdict, labeled_by, label_source)
         VALUES ($1, $2, $3, $4, $5, 'manual')`,
        [label_ids[i], trace_id, org_id, LABELS[i].verdict, LABELS[i].labeled_by]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505' && err.constraint === 'uq_evaluation_corpus_trace') {
      throw new PromotionError(`a corpus row already points at trace_id ${trace_id}`);
    }
    if (err.code === '23505') {
      throw new PromotionError(`unique constraint violated (${err.constraint}): ${err.detail || err.message}`);
    }
    throw err;
  }

  // RETURN
  return { corpus_id, label_ids };
}

async function main() {
  const [, , org_id, trace_id, expected_verdict] = process.argv;

  if (!org_id || !isValidUuid(org_id)) {
    console.error('Usage: node scripts/promoteTraceToCorpus.js <org_id> <trace_id> [expected_verdict]');
    console.error('  org_id missing or not a valid UUID.');
    process.exit(1);
  }
  if (!trace_id || !isValidUuid(trace_id)) {
    console.error('Usage: node scripts/promoteTraceToCorpus.js <org_id> <trace_id> [expected_verdict]');
    console.error('  trace_id missing or not a valid UUID.');
    process.exit(1);
  }
  if (expected_verdict !== undefined && !VALID_VERDICTS.includes(expected_verdict)) {
    console.error(`expected_verdict must be one of ${VALID_VERDICTS.join('|')}, got '${expected_verdict}'`);
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [org_id]);
    const result = await promoteTraceToCorpus(
      client,
      org_id,
      trace_id,
      expected_verdict !== undefined ? { expected_verdict } : {}
    );
    console.log(`Promoted trace ${trace_id} -> evaluation_corpus row ${result.corpus_id}`);
    console.log(`trace_label rows: ${result.label_ids.join(', ')}`);
  } catch (err) {
    if (err instanceof PromotionError) {
      console.error(`BLOCKED: ${err.message}`);
      process.exit(1);
    }
    throw err;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('promoteTraceToCorpus failed:', err);
    process.exit(1);
  });
}

module.exports = { promoteTraceToCorpus, PromotionError, CANDIDATE_SELECT, DEFAULT_RATIONALE };
