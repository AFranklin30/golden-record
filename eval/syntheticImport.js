'use strict';

// Import the 360-row synthetic set through importCustomers and write the raw
// per-row results. This does not score rows itself, and it does not change
// matching behavior. Run it only against local Postgres:
//
//   bash scripts/resetLocalDb.sh
//   node --unhandled-rejections=warn eval/syntheticImport.js
//
// The script rebuilds the dataset first. If the label file or the Set A CSV
// does not match the manifest hashes, it stops before any import.

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client } = require('pg');
const { importCustomers, readCustomerCsv } = require('../src/modules/customerImport');

const ROOT = path.join(__dirname, '..');
const DEMO = path.join(ROOT, 'demo');
const LABEL_PATH = path.join(DEMO, 'synthetic-ground-truth-v2.json');
const SET_A_PATH = path.join(DEMO, 'synthetic-customers-200.csv');
const SET_B_PATH = path.join(DEMO, 'synthetic-extension-160.csv');
const MANIFEST_PATH = path.join(DEMO, 'synthetic-dataset-manifest.json');
const OUT_PATH = path.join(ROOT, 'eval', 'reports', 'synthetic-360-import-results.json');

// These are the manifest values at source commit 0a56806, stamped on main
// at 526e4aa. They are compared after the rebuild, not copied from the file
// the rebuild just wrote.
const EXPECTED = {
  seed: 'synthetic-set-b-v1',
  source_commit: '0a56806f59a69fe2114891893918887d55c85ce5',
  label_sha256: '0db2aa4810cd02583749830190f8877ca66b0d681882641099c57ac1a92af8b4',
  set_a_csv_sha256: '3fb01339fa4144d63a566c97a39fe3869cd96a1c9d4df86fb288a3a783bf2bc7',
  set_b_csv_sha256: '9c010f0ee4fa88ecc4b6e57f7cae4f8766a42475640e0ba40a02ec9862f062f8',
};

const POLICY_OUTCOME = {
  hard_match: 'auto_merge',
  review: 'review',
  separate: 'new',
  import_replay: 'replay',
  import_error: 'import_error',
};

function guardLocalDatabase() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('BLOCKED: DATABASE_URL is not set. Point it at localhost:5432.');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('BLOCKED: DATABASE_URL could not be parsed.');
  }
  const host = parsed.hostname;
  const port = parsed.port || '5432';
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!local || port !== '5432') {
    throw new Error(`BLOCKED: DATABASE_URL must be local Postgres on port 5432 (host ${host}, port ${port}).`);
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function rebuildAndVerify() {
  execFileSync(process.execPath, ['scripts/buildSyntheticDemoCsv.js', '--labels'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const hashes = {
    label_sha256: sha256(LABEL_PATH),
    set_a_csv_sha256: sha256(SET_A_PATH),
    set_b_csv_sha256: sha256(SET_B_PATH),
  };
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const mismatches = [];
  for (const key of ['label_sha256', 'set_a_csv_sha256', 'set_b_csv_sha256']) {
    if (hashes[key] !== EXPECTED[key] || manifest[key] !== EXPECTED[key]) {
      mismatches.push(`${key}: file ${hashes[key]} manifest ${manifest[key]} expected ${EXPECTED[key]}`);
    }
  }
  if (manifest.seed !== EXPECTED.seed || manifest.source_commit !== EXPECTED.source_commit) {
    mismatches.push(`manifest identity: seed ${manifest.seed} source_commit ${manifest.source_commit}`);
  }
  if (mismatches.length > 0) {
    const error = new Error(`STOP: dataset hashes do not match the manifest.\n${mismatches.join('\n')}`);
    error.code = 'HASH_MISMATCH';
    throw error;
  }
  return hashes;
}

function loadInputs() {
  const labels = JSON.parse(fs.readFileSync(LABEL_PATH, 'utf8'));
  const setA = readCustomerCsv(fs.readFileSync(SET_A_PATH, 'utf8'));
  const setB = readCustomerCsv(fs.readFileSync(SET_B_PATH, 'utf8'));
  if (!setA.ok) throw new Error(`Set A CSV could not be read: ${setA.error}`);
  if (!setB.ok) throw new Error(`Set B CSV could not be read: ${setB.error}`);
  if (!Array.isArray(labels.labels) || labels.labels.length !== 360) {
    throw new Error(`Expected 360 labels, found ${labels.labels && labels.labels.length}.`);
  }
  if (setA.rows.length !== 200 || setB.rows.length !== 160) {
    throw new Error(`Expected 200 Set A rows and 160 Set B rows, found ${setA.rows.length} and ${setB.rows.length}.`);
  }
  labels.labels.forEach((label, index) => {
    if (label.row !== index + 1) throw new Error(`Label row ${label.row} is not in import order.`);
  });
  return { labels: labels.labels, rows: [...setA.rows, ...setB.rows] };
}

function readNumeric(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(3));
}

function signalNames(signalResults) {
  let parsed = signalResults;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => (item && item.signal) ? item.signal : 'unknown');
}

function explanationFor(trace) {
  if (!trace) return { produced: false, text: null };
  if (trace.scoring_status === 'skipped' && trace.skip_reason) {
    return { produced: true, text: `scoring skipped: ${trace.skip_reason}` };
  }
  if (trace.scoring_status === 'performed') {
    const names = signalNames(trace.signal_results);
    const text = names.length === 0
      ? 'scoring performed: no agreement signals'
      : `scoring performed: ${names.join(', ')}`;
    return { produced: true, text };
  }
  return { produced: false, text: null };
}

function engineOutcome({ status, replayed, path: resolutionPath }) {
  if (status === 'error') return 'import_error';
  if (replayed) return 'replay';
  if (resolutionPath === 'A') return 'auto_merge';
  if (resolutionPath === 'C' || resolutionPath === 'D') return 'review';
  if (resolutionPath === 'B') return 'new';
  return 'unexpected';
}

function indexBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const id = row[key];
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
}

async function importBatch(client, orgId, rows) {
  await client.query(
    `INSERT INTO org (id, name, is_active, org_api_key_hash)
     VALUES ($1, $2, true, $3)`,
    [orgId, 'synthetic-360-import', crypto.createHash('sha256').update(`synthetic-360-${orgId}`).digest('hex')]
  );
  return importCustomers(client, {
    orgId,
    rows,
    filename: 'synthetic-360.csv',
  });
}

async function readEngineRows(client, orgId, batchId) {
  const stored = await client.query(
    `SELECT row_number, row_key, status, fan_id, resolution_path, conflict_id,
            match_type, error
       FROM import_row
      WHERE batch_id = $1 AND org_id = $2
      ORDER BY row_number`,
    [batchId, orgId]
  );
  const audits = await client.query(
    `SELECT a.idempotency_key, a.confidence_score, a.match_type, a.fan_id,
            t.id AS trace_id, t.scoring_status, t.skip_reason, t.best_score,
            t.signal_results, t.best_candidate_id, t.resolution_path,
            t.is_new_record
       FROM audit_log a
       LEFT JOIN resolution_trace t ON t.audit_event_id = a.id
      WHERE a.org_id = $1
        AND a.event_type = 'resolution'
        AND a.status = 'success'`,
    [orgId]
  );
  const conflicts = await client.query(
    `SELECT id, fan_id_a, fan_id_b, confidence_score
       FROM conflict_queue
      WHERE org_id = $1`,
    [orgId]
  );
  return {
    storedByRow: new Map(stored.rows.map((row) => [row.row_number, row])),
    auditsByKey: indexBy(audits.rows, 'idempotency_key'),
    conflictsById: new Map(conflicts.rows.map((row) => [row.id, row])),
  };
}

function chooseAudit(audits) {
  if (!audits || audits.length === 0) return { audit: null, extra: 0 };
  const withTrace = audits.filter((row) => row.trace_id);
  return { audit: withTrace[0] || audits[0], extra: audits.length - 1 };
}

function assemble(labels, returnedRows, engine, findings) {
  const returnedByRow = new Map(returnedRows.map((row) => [row.row_number, row]));
  const owners = new Map();
  const records = [];

  for (const label of labels) {
    const returned = returnedByRow.get(label.row) || null;
    if (!returned) {
      findings.push({ row: label.row, scenario_id: label.scenario_id, finding: 'import returned no result for this row' });
    }
    const stored = engine.storedByRow.get(label.row) || null;
    const replayed = Boolean(returned && returned.replayed);
    if (replayed && stored) {
      findings.push({ row: label.row, scenario_id: label.scenario_id, finding: 'replay also inserted an import_row' });
    }

    const status = (stored && stored.status) || (returned && returned.status) || 'missing';
    const resolutionPath = (stored && stored.resolution_path) || (returned && returned.resolution_path) || null;
    const fanId = (stored && stored.fan_id) || (returned && returned.fan_id) || null;
    const conflictId = (stored && stored.conflict_id) || (returned && returned.conflict_id) || null;
    const error = (stored && stored.error) || (returned && returned.error) || null;
    const resolverCalled = !replayed && Boolean(stored && stored.row_key);
    const auditChoice = resolverCalled ? chooseAudit(engine.auditsByKey.get(stored.row_key)) : { audit: null, extra: 0 };
    if (auditChoice.extra > 0) {
      findings.push({ row: label.row, scenario_id: label.scenario_id, finding: 'more than one resolution audit for this row' });
    }
    const audit = auditChoice.audit;
    const trace = audit && audit.trace_id ? audit : null;
    if (resolverCalled && status !== 'error' && !trace) {
      findings.push({ row: label.row, scenario_id: label.scenario_id, finding: 'resolver finished without a resolution_trace' });
    }
    if (resolverCalled && status === 'error' && stored && stored.fan_id && !trace) {
      findings.push({ row: label.row, scenario_id: label.scenario_id, finding: 'import error after a fan was stored, and no trace was written' });
    }

    const conflict = conflictId ? engine.conflictsById.get(conflictId) || null : null;
    if ((resolutionPath === 'C' || resolutionPath === 'D') && !conflict) {
      findings.push({ row: label.row, scenario_id: label.scenario_id, finding: 'review path has no conflict_queue row' });
    }
    if (conflict && trace && trace.best_candidate_id && conflict.fan_id_a !== trace.best_candidate_id) {
      findings.push({ row: label.row, scenario_id: label.scenario_id, finding: 'conflict fan and trace candidate differ' });
    }

    let score = null;
    let scoreSource = null;
    if (trace && trace.scoring_status === 'performed') {
      score = readNumeric(trace.best_score);
      scoreSource = 'resolution_trace.best_score';
    } else if (trace) {
      score = readNumeric(audit.confidence_score);
      scoreSource = 'audit_log.confidence_score';
    } else if (audit) {
      score = readNumeric(audit.confidence_score);
      scoreSource = 'audit_log.confidence_score';
    }

    const createdFan = resolverCalled && fanId && resolutionPath && resolutionPath !== 'A';
    if (createdFan) {
      if (owners.has(fanId)) {
        findings.push({ row: label.row, scenario_id: label.scenario_id, finding: 'new fan id was already recorded for an earlier row' });
      } else {
        owners.set(fanId, { person_key: label.person_key, row: label.row });
      }
    }

    let matchedFanId = null;
    if (replayed || resolutionPath === 'A') matchedFanId = fanId;
    else if (resolutionPath === 'C' || resolutionPath === 'D') {
      matchedFanId = (conflict && conflict.fan_id_a) || (trace && trace.best_candidate_id) || null;
    }
    const owner = matchedFanId ? owners.get(matchedFanId) || null : null;
    if (matchedFanId && !owner) {
      findings.push({ row: label.row, scenario_id: label.scenario_id, finding: 'matched fan was not created by an earlier imported row' });
    }

    const explanation = resolverCalled ? explanationFor(trace) : { produced: false, text: null };
    const outcome = engineOutcome({ status, replayed, path: resolutionPath });
    const expectedOutcome = POLICY_OUTCOME[label.policy_expected] || null;
    if (!expectedOutcome) {
      findings.push({ row: label.row, scenario_id: label.scenario_id, finding: `unknown policy_expected ${label.policy_expected}` });
    }

    records.push({
      row: label.row,
      set: label.set,
      scenario_id: label.scenario_id,
      case_id: label.case_id,
      role: label.role,
      person_key: label.person_key,
      anchor_row: label.anchor_row,
      identity_truth: label.identity_truth,
      policy_expected: label.policy_expected,
      expected_path: label.expected_path,
      engine_outcome: outcome,
      path: resolutionPath,
      score,
      score_source: outcome === 'replay' ? null : scoreSource,
      scoring_status: trace ? trace.scoring_status : null,
      skip_reason: trace ? trace.skip_reason : null,
      signals: trace ? signalNames(trace.signal_results) : [],
      fan_id: fanId,
      matched_fan_id: matchedFanId,
      matched_person_key: owner ? owner.person_key : null,
      matched_row: owner ? owner.row : null,
      conflict_id: conflictId,
      error,
      replayed,
      resolver_called: resolverCalled,
      trace_produced: Boolean(trace),
      explanation_produced: explanation.produced,
      explanation: explanation.text,
      import_status: status,
      policy_outcome_differs: expectedOutcome == null || outcome !== expectedOutcome,
    });
  }

  for (const record of records) {
    if (record.engine_outcome !== 'replay' || record.score != null) continue;
    const stored = records.find((item) => item.row === record.matched_row);
    if (!stored) continue;
    record.score = stored.score;
    record.score_source = 'stored_row';
    record.scoring_status = stored.scoring_status;
    record.skip_reason = stored.skip_reason;
    record.signals = stored.signals;
  }

  return records;
}

function summarize(records, findings) {
  const byOutcome = {};
  for (const record of records) {
    byOutcome[record.engine_outcome] = (byOutcome[record.engine_outcome] || 0) + 1;
  }
  const byScenario = new Map();
  for (const record of records) {
    if (!byScenario.has(record.scenario_id)) {
      byScenario.set(record.scenario_id, { scenario_id: record.scenario_id, rows: 0, pairs: new Map(), mismatch_rows: [] });
    }
    const bucket = byScenario.get(record.scenario_id);
    bucket.rows += 1;
    const pairKey = `${record.policy_expected}|${record.engine_outcome}`;
    bucket.pairs.set(pairKey, (bucket.pairs.get(pairKey) || 0) + 1);
    if (record.policy_outcome_differs) bucket.mismatch_rows.push(record.row);
  }
  const scenarios = [...byScenario.values()].map((bucket) => ({
    scenario_id: bucket.scenario_id,
    rows: bucket.rows,
    pairs: [...bucket.pairs.entries()].map(([key, count]) => {
      const [policyExpected, outcome] = key.split('|');
      return {
        policy_expected: policyExpected,
        engine_outcome: outcome,
        rows: count,
        differs: POLICY_OUTCOME[policyExpected] !== outcome,
      };
    }),
    mismatch_rows: bucket.mismatch_rows,
  }));
  const mismatches = records.filter((record) => record.policy_outcome_differs).map((record) => ({
    row: record.row,
    set: record.set,
    scenario_id: record.scenario_id,
    role: record.role,
    policy_expected: record.policy_expected,
    engine_outcome: record.engine_outcome,
    path: record.path,
    score: record.score,
    error: record.error,
  }));
  return {
    disclaimer: 'Raw counts and a field comparison of policy_expected against engine_outcome. This is not a precision, recall, or accuracy claim.',
    rows_attempted: records.length,
    by_engine_outcome: byOutcome,
    explanation_produced: records.filter((record) => record.explanation_produced).length,
    explanation_missing: records.filter((record) => !record.explanation_produced).length,
    policy_comparison_by_scenario: scenarios,
    mismatch_count: mismatches.length,
    mismatches,
    finding_count: findings.length,
    findings,
  };
}

function buildDocument(hashes, orgId, batchId, records, summary) {
  return {
    kind: 'synthetic-360-import-raw-results',
    seed: EXPECTED.seed,
    source_commit: EXPECTED.source_commit,
    label_sha256: hashes.label_sha256,
    set_a_csv_sha256: hashes.set_a_csv_sha256,
    set_b_csv_sha256: hashes.set_b_csv_sha256,
    import_order: 'Set A rows 1-200, then Set B anchors rows 201-280, then Set B probes rows 281-360.',
    method: 'readCustomerCsv on the rebuilt Set A and Set B files, then importCustomers. The resolver runs only inside that import.',
    org_name: 'synthetic-360-import',
    org_id: orgId,
    batch_id: batchId,
    volatile_fields: [
      'org_id',
      'batch_id',
      'rows[].fan_id',
      'rows[].matched_fan_id',
      'rows[].conflict_id',
    ],
    volatile_note: 'Those ids are new on every run. The other fields come from the import result, the trace, and the label file, and should stay the same when the engine has not changed.',
    score_rule: 'When the trace says scoring was performed, score is resolution_trace.best_score. When scoring was skipped, score is audit_log.confidence_score for that resolution. A replay copies the stored row score and sets score_source to stored_row. A row that never reached the resolver has a null score.',
    explanation_rule: 'explanation_produced is true only when this row called the resolver and resolution_trace has a skip reason or a performed scoring record. The text uses the skip reason or the signal names. It does not include identifier values. A replay does not call the resolver, so it does not produce a new explanation.',
    summary,
    rows: records,
  };
}

async function main() {
  guardLocalDatabase();
  const hashes = rebuildAndVerify();
  const { labels, rows } = loadInputs();
  const orgId = crypto.randomUUID();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const imported = await importBatch(client, orgId, rows);
    if (!imported || !Array.isArray(imported.rows)) {
      throw new Error('importCustomers returned no rows.');
    }
    const findings = [];
    if (imported.rows.length !== 360) {
      findings.push({ row: null, scenario_id: null, finding: `import returned ${imported.rows.length} rows` });
    }
    const engine = await readEngineRows(client, orgId, imported.batch_id);
    const records = assemble(labels, imported.rows, engine, findings);
    const summary = summarize(records, findings);
    const document = buildDocument(hashes, orgId, imported.batch_id, records, summary);
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, `${JSON.stringify(document, null, 2)}\n`);
    console.log(`wrote ${OUT_PATH}`);
    console.log(`rows_attempted ${summary.rows_attempted}`);
    console.log(`by_engine_outcome ${JSON.stringify(summary.by_engine_outcome)}`);
    console.log(`explanation_produced ${summary.explanation_produced}`);
    console.log(`mismatch_count ${summary.mismatch_count}`);
    console.log(`finding_count ${summary.finding_count}`);
    if (summary.rows_attempted !== 360) {
      throw new Error(`STOP: only ${summary.rows_attempted} rows were assembled.`);
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(err && err.code === 'HASH_MISMATCH' ? 2 : 1);
  });
}

module.exports = {
  EXPECTED,
  POLICY_OUTCOME,
  engineOutcome,
  explanationFor,
  signalNames,
};
