// eval/runCorpus.js
// Stage 7 evaluation harness — CLI entry + DB I/O.
// Golden Record Fan Identity Platform — OKC Thunder — Thunder Innovations Cohort
//
// Usage: node eval/runCorpus.js <org_id>
//
// Reads evaluation_corpus + resolution_trace + trace_label for one org,
// replays each row through eval/harness.js, and writes eval/runs/<ISO>.json.
// Read-only against the app's data — writes only the local run file.
//
// Connects with its own pg.Client (not src/db/pool.js) — this is a one-shot
// CLI run, not a long-lived server process. Matches tests/migration_014.test.js.

'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

const harness = require('./harness');
const { SCORER_VERSION } = require('../src/modules/probabilisticMatcher');
const { NORMALIZATION_VERSION } = require('../src/modules/normalizer');
const { THRESHOLD_PATH_C, THRESHOLD_PATH_D } = require('../src/modules/resolverEngine');

const RUNS_DIR = path.join(__dirname, 'runs');

// computeVersionDrift — run-assembly concern, not a per-row scoring concern.
// scorer_version: ALL rows, read from evaluation_corpus.scorer_version
//   (nullable, unconstrained). Absent MUST read 'unknown', never false —
//   defaulting a missing version to agreement defeats the point of stamping it.
// normalization_version: PROMOTED rows only, read from the linked
//   resolution_trace.normalization_version (NOT NULL there). Synthetic rows
//   are hand-fabricated — no normalizer ever ran over them — so this is
//   'not_applicable', not false and not omitted.
function computeVersionDrift(corpusRow, traceRow, state) {
  let scorer_version_drift;
  if (corpusRow.scorer_version == null) {
    scorer_version_drift = 'unknown';
  } else {
    scorer_version_drift = corpusRow.scorer_version !== SCORER_VERSION;
  }

  let normalization_version_drift;
  if (state === 'synthetic') {
    normalization_version_drift = 'not_applicable';
  } else if (traceRow == null || traceRow.normalization_version == null) {
    normalization_version_drift = 'unknown';
  } else {
    normalization_version_drift = traceRow.normalization_version !== NORMALIZATION_VERSION;
  }

  return { scorer_version_drift, normalization_version_drift };
}

// buildRun — RECEIVE / GUARD / EXECUTE / RETURN. Read-only.
async function buildRun(client, org_id) {
  // GUARD
  if (!org_id) {
    throw new Error('buildRun: org_id is required');
  }

  // EXECUTE
  await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [org_id]);

  const corpusResult = await client.query(
    `SELECT * FROM evaluation_corpus WHERE org_id = $1`,
    [org_id]
  );
  const corpusRows = corpusResult.rows;

  const traceIds = corpusRows
    .map((r) => r.trace_id)
    .filter((id) => id != null);

  let traceRows = [];
  let labelRows  = [];
  if (traceIds.length > 0) {
    const traceResult = await client.query(
      `SELECT * FROM resolution_trace WHERE id = ANY($1::uuid[])`,
      [traceIds]
    );
    traceRows = traceResult.rows;

    const labelResult = await client.query(
      `SELECT * FROM trace_label WHERE trace_id = ANY($1::uuid[])`,
      [traceIds]
    );
    labelRows = labelResult.rows;
  }

  const traceMap = new Map(traceRows.map((t) => [t.id, t]));
  const labelMap = new Map();
  for (const label of labelRows) {
    const existing = labelMap.get(label.trace_id) || [];
    existing.push(label);
    labelMap.set(label.trace_id, existing);
  }

  const counts = {
    total:                   corpusRows.length,
    synthetic:               0,
    promoted_no_snapshot:    0,
    promoted_with_snapshot:  0,
    gated:                   0,
    skipped:                 0,
    scorer_version_drift:    0,
    scorer_version_unknown:  0,
  };

  const rows = corpusRows.map((corpusRow) => {
    const traceRow = corpusRow.trace_id != null ? (traceMap.get(corpusRow.trace_id) ?? null) : null;
    const labels   = corpusRow.trace_id != null ? (labelMap.get(corpusRow.trace_id) ?? []) : [];

    const evalResult = harness.evaluateRow(corpusRow, traceRow, labels);
    const drift       = computeVersionDrift(corpusRow, traceRow, evalResult.state);
    const row         = { ...evalResult, ...drift };

    counts[row.state] = (counts[row.state] ?? 0) + 1;
    if (row.gate_status === 'gated') counts.gated++;
    if (row.skipped) counts.skipped++;
    if (row.scorer_version_drift === true) counts.scorer_version_drift++;
    if (row.scorer_version_drift === 'unknown') counts.scorer_version_unknown++;

    return row;
  });

  // RETURN
  return {
    run_at:                 new Date().toISOString(),
    frozen_clock:            harness.FROZEN_CLOCK,
    scorer_version:          SCORER_VERSION,
    normalization_version:   NORMALIZATION_VERSION,
    thresholds:              { c: THRESHOLD_PATH_C, d: THRESHOLD_PATH_D },
    counts,
    rows,
  };
}

function writeRunFile(runObject, outDir = RUNS_DIR) {
  fs.mkdirSync(outDir, { recursive: true });
  const fileName = `${runObject.run_at.replace(/[:.]/g, '-')}.json`;
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(runObject, null, 2));
  return filePath;
}

async function main() {
  const org_id = process.argv[2];
  if (!org_id) {
    console.error('Usage: node eval/runCorpus.js <org_id>');
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const runObject = await buildRun(client, org_id);
    const filePath   = writeRunFile(runObject);
    console.log(`Run written: ${filePath}`);
    console.log('counts:', JSON.stringify(runObject.counts, null, 2));
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('runCorpus failed:', err);
    process.exit(1);
  });
}

module.exports = { buildRun, computeVersionDrift, writeRunFile, main };
