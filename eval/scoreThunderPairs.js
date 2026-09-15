// eval/scoreThunderPairs.js
// Score-distribution analysis against real (double-blind-anonymized) Thunder
// staging data. Golden Record Fan Identity Platform — OKC Thunder — Thunder
// Innovations Cohort.
//
// Usage: node eval/scoreThunderPairs.js
//
// NOT the Stage 7 harness (eval/runCorpus.js). That replays evaluation_corpus
// rows carrying a candidate_snapshot + expected_verdict. Thunder staging rows
// have neither. This script builds candidate/inbound objects directly from
// thunder.league / thunder.tb / thunder.ticketing and calls scoreMatch.
//
// Answers "how does the scorer behave on real data" — NOT "is the scorer
// correct." There is no ground truth for this data, so this is a score
// DISTRIBUTION relative to THRESHOLD_PATH_C/D, not a recall/precision
// measurement.
//
// last_seen_at DECISION (confirmed with Aaron before this script was written):
// every signal's last_seen_at is set to the frozen run clock, so
// getRecencyMultiplier returns 1.0 everywhere. This is a clean UPPER BOUND —
// staging data carries no real last_seen_at, and 1.0 isolates "does the raw
// signal composition cross threshold" from a recency assumption that has no
// basis for a static offline snapshot. Report all scores as an upper bound,
// never as a realistic estimate.
//
// Read-only against thunder.*. No writes to any Golden Record table. Local
// Postgres (5432) only — asserted at startup.

'use strict';

require('dotenv').config();

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const { scoreMatch, SCORER_VERSION } = require('../src/modules/probabilisticMatcher');
const { THRESHOLD_PATH_C, THRESHOLD_PATH_D } = require('../src/modules/resolverEngine');

const RUNS_DIR = path.join(__dirname, 'runs');
const ORG_ID   = '00000000-0000-0000-0000-000000000000'; // shared fixed org for both sides of every pair — required by scoreMatch's org_id-match guard; not a real org, never written anywhere.

// STRONG per passesSignalEligibilityGate (resolverEngine.js): email_similarity,
// name_plus_dob, guardian_email. WEAK: name_plus_zip, device_id, name_alone.
// Reimplemented here (not imported) because passesSignalEligibilityGate is not
// exported for use outside resolverEngine's own candidate loop shape — but the
// logic below is copied verbatim, field-for-field, from resolverEngine.js
// lines 38-83, not reinvented.
function passesSignalEligibilityGate(candidate, inbound) {
  let strongCount = 0;
  let weakCount = 0;

  if (inbound.email != null && candidate.email != null) strongCount++;
  if (inbound.name != null && inbound.dob != null && candidate.name != null && candidate.dob != null) strongCount++;
  if (inbound.guardian_email != null && candidate.guardian_email != null) strongCount++;
  if (inbound.name != null && inbound.zip != null && candidate.name != null && candidate.zip != null) weakCount++;
  if (inbound.device_id != null && candidate.device_id != null) weakCount++;
  if (inbound.name != null && candidate.name != null) weakCount++;

  return strongCount >= 1 || weakCount >= 2;
}

function assertLocalPostgres(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch (err) {
    console.error(`Could not parse DATABASE_URL: ${err.message}`);
    process.exit(1);
  }
  const host = url.hostname;
  const port = url.port || '5432';
  const isLocal = (host === 'localhost' || host === '127.0.0.1') && port === '5432';
  if (!isLocal) {
    console.error(
      `Refusing to run: DATABASE_URL points at ${host}:${port}, not localhost:5432. ` +
      `The thunder schema exists only in local Postgres. This script must never point at Cloud SQL.`
    );
    process.exit(1);
  }
}

// Builds the flat 14-key shape scoreMatch/passesSignalEligibilityGate expect
// (resolverEngine.js lines 326-338). Missing fields are null, never undefined.
function makeRecord({ name, email, dob, zip, device_id, guardian_email }, frozenClock) {
  return {
    id: null,
    org_id: ORG_ID,
    email: email ?? null,
    email_last_seen_at: email != null ? frozenClock : null,
    name: name ?? null,
    name_last_seen_at: name != null ? frozenClock : null,
    dob: dob ?? null,
    dob_last_seen_at: dob != null ? frozenClock : null,
    zip: zip ?? null,
    zip_last_seen_at: zip != null ? frozenClock : null,
    device_id: device_id ?? null,
    device_last_seen_at: device_id != null ? frozenClock : null,
    guardian_email: guardian_email ?? null,
    guardian_email_last_seen_at: guardian_email != null ? frozenClock : null,
  };
}

function nullIfEmpty(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t === '' ? null : t;
}

// --- Cohort queries -------------------------------------------------------

async function fetchCohortA(client) {
  // League JOIN tb on exact (case/whitespace-insensitive) email.
  const { rows } = await client.query(`
    SELECT l.row_id AS league_row_id, l.name AS league_name, l.email AS league_email,
           t.row_id AS tb_row_id, t.first_name, t.last_name, t.email AS tb_email, t.zip AS tb_zip
    FROM thunder.league l
    JOIN thunder.tb t
      ON lower(trim(l.email)) = lower(trim(t.email))
    WHERE l.email IS NOT NULL AND t.email IS NOT NULL
      AND trim(l.email) <> '' AND trim(t.email) <> ''
    ORDER BY l.row_id, t.row_id
  `);
  return rows.map((r) => ({
    league: { name: nullIfEmpty(r.league_name), email: nullIfEmpty(r.league_email) },
    tb: {
      name: nullIfEmpty([r.first_name, r.last_name].filter(Boolean).join(' ')) || null,
      email: nullIfEmpty(r.tb_email),
      zip: nullIfEmpty(r.tb_zip),
    },
    key: `${r.league_row_id}|${r.tb_row_id}`,
  }));
}

async function fetchCohortB(client) {
  // League JOIN tb on exact name, but DISAGREEING email (by construction).
  const { rows } = await client.query(`
    SELECT l.row_id AS league_row_id, l.name AS league_name, l.email AS league_email,
           t.row_id AS tb_row_id, t.first_name, t.last_name, t.email AS tb_email, t.zip AS tb_zip
    FROM thunder.league l
    JOIN thunder.tb t
      ON lower(trim(l.name)) = lower(trim(t.first_name || ' ' || t.last_name))
    WHERE lower(trim(coalesce(l.email, ''))) <> lower(trim(coalesce(t.email, '')))
    ORDER BY l.row_id, t.row_id
  `);
  return rows.map((r) => ({
    league: { name: nullIfEmpty(r.league_name), email: nullIfEmpty(r.league_email) },
    tb: {
      name: nullIfEmpty([r.first_name, r.last_name].filter(Boolean).join(' ')) || null,
      email: nullIfEmpty(r.tb_email),
      zip: nullIfEmpty(r.tb_zip),
    },
    key: `${r.league_row_id}|${r.tb_row_id}`,
  }));
}

async function fetchCohortC(client) {
  // Ticketing has multiple rows per person (multiple seats/events) — dedupe to
  // one representative row per (owner_name, zip5) BEFORE joining, or the pair
  // count balloons from ~198 to ~1,295 (confirmed against the SQL baseline
  // while building this script — see tasks/todo.md). tb carries no such
  // duplication (5,613 rows / 5,613 distinct name+zip5, verified separately).
  const { rows } = await client.query(`
    WITH ticketing_dedup AS (
      SELECT DISTINCT ON (lower(trim(owner_name)), left(trim(zip), 5))
        row_id, owner_name, zip
      FROM thunder.ticketing
      WHERE owner_name IS NOT NULL AND zip IS NOT NULL
        AND trim(owner_name) <> '' AND trim(zip) <> ''
      ORDER BY lower(trim(owner_name)), left(trim(zip), 5), row_id
    )
    SELECT tk.row_id AS ticketing_row_id, tk.owner_name, tk.zip AS ticketing_zip,
           t.row_id AS tb_row_id, t.first_name, t.last_name, t.zip AS tb_zip
    FROM ticketing_dedup tk
    JOIN thunder.tb t
      ON lower(trim(tk.owner_name)) = lower(trim(t.first_name || ' ' || t.last_name))
     AND left(trim(tk.zip), 5) = left(trim(t.zip), 5)
    ORDER BY tk.row_id, t.row_id
  `);
  return rows.map((r) => ({
    ticketing: {
      name: nullIfEmpty(r.owner_name),
      zip: nullIfEmpty(r.ticketing_zip) ? nullIfEmpty(r.ticketing_zip).slice(0, 5) : null,
    },
    tb: {
      name: nullIfEmpty([r.first_name, r.last_name].filter(Boolean).join(' ')) || null,
      zip: nullIfEmpty(r.tb_zip),
    },
    key: `${r.ticketing_row_id}|${r.tb_row_id}`,
  }));
}

// --- Scoring ---------------------------------------------------------------

function scorePair(sideA, sideB, frozenClock) {
  const candidate = makeRecord(sideA, frozenClock);
  const inbound = makeRecord(sideB, frozenClock);

  const gatedAtoB = !passesSignalEligibilityGate(candidate, inbound);
  const resultAtoB = gatedAtoB ? null : scoreMatch(candidate, inbound, frozenClock);

  const gatedBtoA = !passesSignalEligibilityGate(inbound, candidate);
  const resultBtoA = gatedBtoA ? null : scoreMatch(inbound, candidate, frozenClock);

  return {
    a_as_candidate: { gated: gatedAtoB, result: resultAtoB },
    b_as_candidate: { gated: gatedBtoA, result: resultBtoA },
  };
}

function band(score) {
  if (score >= THRESHOLD_PATH_C) return 'path_c';
  if (score >= THRESHOLD_PATH_D) return 'path_d';
  return 'path_b';
}

function histogramBucket(score) {
  const clamped = Math.max(0, Math.min(1, score));
  const bucketIndex = Math.min(19, Math.floor(clamped / 0.05));
  const lo = (bucketIndex * 0.05).toFixed(2);
  const hi = ((bucketIndex + 1) * 0.05).toFixed(2);
  return `${lo}-${hi}`;
}

function median(sortedArr) {
  if (sortedArr.length === 0) return null;
  const mid = Math.floor(sortedArr.length / 2);
  return sortedArr.length % 2 === 0
    ? (sortedArr[mid - 1] + sortedArr[mid]) / 2
    : sortedArr[mid];
}

function hashId(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function summarizeCohort(cohortName, pairs, frozenClock) {
  const scored = [];
  const histogram = {};
  const bandCounts = { path_c: 0, path_d: 0, path_b: 0 };
  const signalCounts = {};
  const penaltyFieldCounts = {};
  let gateFailures = 0;
  let dobVetoCount = 0;
  let directionDiffCount = 0;
  const sampleCandidates = [];

  for (const pair of pairs) {
    const [sideAKey, sideBKey] = Object.keys(pair).filter((k) => k !== 'key');
    const sideA = pair[sideAKey];
    const sideB = pair[sideBKey];

    const { a_as_candidate, b_as_candidate } = scorePair(sideA, sideB, frozenClock);

    if (a_as_candidate.gated) gateFailures++;
    if (b_as_candidate.gated) gateFailures++;

    const scoreForward = a_as_candidate.result ? a_as_candidate.result.score : null;
    const scoreReverse = b_as_candidate.result ? b_as_candidate.result.score : null;

    // Use the forward direction (sideB as inbound against sideA as candidate)
    // as the primary reported score per pair; both directions are still
    // aggregated separately for the direction-symmetry check below.
    for (const result of [a_as_candidate.result, b_as_candidate.result]) {
      if (result == null) continue;
      scored.push(result.score);
      const b = histogramBucket(result.score);
      histogram[b] = (histogram[b] || 0) + 1;
      bandCounts[band(result.score)]++;
      if (result.dob_veto) dobVetoCount++;
      for (const sig of result.signals_matched) {
        signalCounts[sig.signal] = (signalCounts[sig.signal] || 0) + 1;
        // Proves the frozen-clock assumption held for every scored signal
        // (criterion 5) rather than assuming it from the call site: every
        // last_seen_at was set to the same frozen clock as `now`, so every
        // signal's elapsed time is exactly 0 months -> recency 1.0. A value
        // other than 1.0 here means some record's last_seen_at diverged from
        // the frozen clock.
        if (sig.recency_multiplier !== 1.0) {
          throw new Error(
            `Frozen-clock invariant broken: signal '${sig.signal}' got recency_multiplier ` +
            `${sig.recency_multiplier}, expected 1.0. A record's last_seen_at diverged from the frozen clock.`
          );
        }
      }
      for (const penalty of result.penalties_applied) {
        penaltyFieldCounts[penalty.field] = (penaltyFieldCounts[penalty.field] || 0) + 1;
      }
    }

    if (scoreForward != null && scoreReverse != null && Math.abs(scoreForward - scoreReverse) > 1e-9) {
      directionDiffCount++;
    }

    sampleCandidates.push({
      key: pair.key,
      hashed_id: hashId(pair.key),
      score_forward: scoreForward,
      score_reverse: scoreReverse,
      signals_forward: a_as_candidate.result ? a_as_candidate.result.signals_matched.map((s) => s.signal) : [],
      conflicts_forward: a_as_candidate.result ? a_as_candidate.result.conflicts_detected : [],
      // raw values retained only in-memory for the stdout sample print, never
      // written to the JSON file
      _raw: { sideA, sideB },
    });
  }

  scored.sort((a, b) => a - b);

  return {
    cohort: cohortName,
    pairs_found: pairs.length,
    scores_computed: scored.length,
    gate_failures: gateFailures,
    dob_veto_count: dobVetoCount,
    direction_mismatch_count: directionDiffCount,
    min: scored.length ? scored[0] : null,
    max: scored.length ? scored[scored.length - 1] : null,
    mean: scored.length ? scored.reduce((s, v) => s + v, 0) / scored.length : null,
    median: median(scored),
    histogram,
    band_counts: bandCounts,
    signal_counts: signalCounts,
    penalty_field_counts: penaltyFieldCounts,
    below_0_7_forward_count: sampleCandidates.filter((s) => s.score_forward != null && s.score_forward < 0.7).length,
    _sampleCandidates: sampleCandidates,
  };
}

function pickRandomSample(sampleCandidates, n = 5) {
  const pool = [...sampleCandidates];
  const picked = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

function stripForFile(cohortSummary) {
  const { _sampleCandidates, ...rest } = cohortSummary;
  return {
    ...rest,
    sample_hashed_ids: _sampleCandidates.slice(0, 5).map((s) => s.hashed_id),
  };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  assertLocalPostgres(connectionString);

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const frozenClock = Date.now();
    console.log(`Frozen clock for this run: ${frozenClock} (${new Date(frozenClock).toISOString()})`);
    console.log('last_seen_at strategy: FROZEN CLOCK on every present signal (recency_multiplier = 1.0 everywhere).');
    console.log('These scores are an UPPER BOUND, not a realistic estimate — see file header.');
    console.log(`scorer_version: ${SCORER_VERSION}`);
    console.log('');

    const [cohortAPairs, cohortBPairs, cohortCPairs] = await Promise.all([
      fetchCohortA(client),
      fetchCohortB(client),
      fetchCohortC(client),
    ]);

    console.log(`Cohort A (email-agreeing): ${cohortAPairs.length} pairs found (expected ~1,069)`);
    console.log(`Cohort B (name-agreeing, email-disagreeing): ${cohortBPairs.length} pairs found (expected ~2,704)`);
    console.log(`Cohort C (name+zip5-agreeing, deduped on ticketing side): ${cohortCPairs.length} pairs found (expected ~198)`);
    console.log('');

    const summaries = {
      cohort_a: summarizeCohort('cohort_a_email_agree', cohortAPairs, frozenClock),
      cohort_b: summarizeCohort('cohort_b_name_agree_email_disagree', cohortBPairs, frozenClock),
      cohort_c: summarizeCohort('cohort_c_name_zip5_agree', cohortCPairs, frozenClock),
    };

    // --- Verification checks (printed, not enforced as jest) ---
    console.log('--- Verification ---');
    const dobVetoTotal = summaries.cohort_a.dob_veto_count + summaries.cohort_b.dob_veto_count + summaries.cohort_c.dob_veto_count;
    console.log(`Total dob_veto count across all cohorts: ${dobVetoTotal} (must be 0 — there is no dob in this data)`);
    if (dobVetoTotal !== 0) {
      console.error('FAIL: dob_veto fired on data with no dob field. Candidate mapping is wrong. Stopping.');
      process.exit(1);
    }
    const belowSeventyCount = summaries.cohort_a.below_0_7_forward_count;
    console.log(`Cohort A pairs scoring below 0.7 (forward direction): ${belowSeventyCount} of ${summaries.cohort_a._sampleCandidates.length}`);
    if (belowSeventyCount > 0) {
      console.log('  Every pair in A agrees on email (+0.7 at recency 1.0). A score below 0.7 means a disagreement');
      console.log('  penalty (name or zip conflict) subtracted from that base. Reporting reasons for the first 10:');
      const examples = summaries.cohort_a._sampleCandidates
        .filter((s) => s.score_forward != null && s.score_forward < 0.7)
        .slice(0, 10);
      for (const s of examples) {
        console.log(`    key=${s.key} score=${s.score_forward} conflicts=${JSON.stringify(s.conflicts_forward.map((c) => c.field))}`);
      }
    }
    console.log(`Cohort A min score: ${summaries.cohort_a.min} (every pair agrees on email by construction — expect >= 0.7 with frozen-clock recency unless a name/zip disagreement penalty applied — see above)`);
    console.log(`Cohort B penalties: penalty_field_counts should show 'email' penalties firing (pairs disagree on email by construction, so email_similarity never fires — the disagreement penalty applies instead).`);
    console.log(`  Cohort B signal_counts: ${JSON.stringify(summaries.cohort_b.signal_counts)}`);
    console.log(`  Cohort B penalty_field_counts: ${JSON.stringify(summaries.cohort_b.penalty_field_counts)}`);
    console.log('');

    // --- Per-cohort report ---
    for (const key of ['cohort_a', 'cohort_b', 'cohort_c']) {
      const s = summaries[key];
      console.log(`=== ${s.cohort} ===`);
      console.log(`  pairs_found: ${s.pairs_found}, scores_computed: ${s.scores_computed}, gate_failures: ${s.gate_failures}`);
      console.log(`  min: ${s.min}  max: ${s.max}  mean: ${s.mean}  median: ${s.median}`);
      console.log(`  band_counts: ${JSON.stringify(s.band_counts)}`);
      console.log(`  direction_mismatch_count: ${s.direction_mismatch_count}`);
      console.log(`  signal_counts: ${JSON.stringify(s.signal_counts)}`);
      console.log('  histogram:', JSON.stringify(s.histogram));
      console.log('  5 random sample pairs (raw values — stdout only, not written to file):');
      for (const sample of pickRandomSample(s._sampleCandidates, 5)) {
        console.log(`    key=${sample.key} score_fwd=${sample.score_forward} score_rev=${sample.score_reverse} signals=${JSON.stringify(sample.signals_forward)}`);
        console.log(`      sideA=${JSON.stringify(sample._raw.sideA)} sideB=${JSON.stringify(sample._raw.sideB)}`);
      }
      console.log('');
    }

    // --- Write JSON file (no raw name/email — hashed ids only) ---
    const runObject = {
      run_at: new Date().toISOString(),
      frozen_clock: frozenClock,
      frozen_clock_iso: new Date(frozenClock).toISOString(),
      last_seen_at_strategy: 'frozen_clock_recency_1.0_upper_bound',
      scorer_version: SCORER_VERSION,
      thresholds: { path_c: THRESHOLD_PATH_C, path_d: THRESHOLD_PATH_D },
      note: 'Score DISTRIBUTION only. No ground truth exists for this data — do not interpret as accuracy.',
      cohorts: {
        cohort_a: stripForFile(summaries.cohort_a),
        cohort_b: stripForFile(summaries.cohort_b),
        cohort_c: stripForFile(summaries.cohort_c),
      },
    };

    fs.mkdirSync(RUNS_DIR, { recursive: true });
    const fileName = `${runObject.run_at.replace(/[:.]/g, '-')}-thunder-pairs.json`;
    const filePath = path.join(RUNS_DIR, fileName);
    fs.writeFileSync(filePath, JSON.stringify(runObject, null, 2));
    console.log(`Run written: ${filePath}`);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('scoreThunderPairs failed:', err);
    process.exit(1);
  });
}

module.exports = {
  assertLocalPostgres,
  makeRecord,
  passesSignalEligibilityGate,
  fetchCohortA,
  fetchCohortB,
  fetchCohortC,
  summarizeCohort,
  scorePair,
};
