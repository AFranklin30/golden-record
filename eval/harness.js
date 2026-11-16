// eval/harness.js
// Stage 7 evaluation harness — pure scoring/replay logic.
// Golden Record
//
// Pure function module — no database calls, no side effects. DB I/O lives in
// eval/runCorpus.js. Mirrors probabilisticMatcher.js's purity discipline.
//
// probabilisticMatcher is required as a module object (not destructured) so
// tests can jest.spyOn(probabilisticMatcher, 'scoreMatch') and see calls made
// through evaluateRow.

'use strict';

const probabilisticMatcher = require('../src/modules/probabilisticMatcher');
const { normalizeIdentifier } = require('../src/modules/normalizer');
const {
  pathForMatch,
  passesSignalEligibilityGate,
} = require('../src/modules/resolverEngine');

const VERDICTS       = ['match', 'not_match', 'unsure'];
const LABEL_SOURCE    = 'manual';
const FROZEN_CLOCK    = Date.parse('2026-07-01T00:00:00.000Z');
const SCORE_TOLERANCE = 0.0005; // best_score is numeric(4,3)
const BLOCK_MISS_REASONS = ['no_block_key', 'empty_block', 'block_dropped_oversize'];
const REPLAY_SIZES = [100, 1000, 5000];

if (typeof FROZEN_CLOCK !== 'number' || Number.isFinite(FROZEN_CLOCK) === false) {
  throw new Error('eval/harness.js: FROZEN_CLOCK failed to parse to a finite epoch-ms number');
}

const INBOUND_FIELDS = ['email', 'name', 'dob', 'zip', 'device_id', 'guardian_email'];

// parseInboundIdentifiers — normalizes both shapes seen in
// resolution_trace.inbound_identifiers / evaluation_corpus.inbound_identifiers:
//   - PATH A stub: single key { [identifier_type]: identifier_value }, no org_id.
//   - Every other path: full 7-key { org_id, email, name, dob, zip, device_id, guardian_email }.
function parseInboundIdentifiers(jsonb) {
  const keys = Object.keys(jsonb);
  const isSingular = keys.length === 1 && keys[0] !== 'org_id' && INBOUND_FIELDS.includes(keys[0]);

  if (isSingular) {
    const inbound = { org_id: null };
    for (const field of INBOUND_FIELDS) {
      inbound[field] = field === keys[0] ? jsonb[keys[0]] : null;
    }
    return { inbound, shape: 'singular' };
  }

  const inbound = { org_id: jsonb.org_id ?? null };
  for (const field of INBOUND_FIELDS) {
    inbound[field] = jsonb[field] ?? null;
  }
  return { inbound, shape: 'full' };
}

// evaluateRow — RECEIVE / GUARD / EXECUTE / RETURN. No DB write.
function evaluateRow(corpusRow, traceRow, labelRows) {
  // RECEIVE
  const hasSnapshot = corpusRow.candidate_snapshot != null;
  const hasTrace     = corpusRow.trace_id != null;

  // GUARD — classify state
  let state;
  if (corpusRow.source === 'synthetic') {
    state = 'synthetic';
  } else if (hasSnapshot) {
    state = 'promoted_with_snapshot';
  } else {
    state = 'promoted_no_snapshot';
  }

  const block_outcome = blockOutcome(traceRow);

  // GUARD — unscored trace has no comparable score. Do not replay even if a
  // snapshot is present. Do not throw — PATH A stubs legitimately land here.
  if (state !== 'synthetic' && traceRow.scoring_status !== 'performed') {
    return {
      corpus_id:            corpusRow.id,
      state,
      skipped:              true,
      skip_reason:          'trace_not_scored',
      score_source:         null,
      gate_status:          null,
      replayed_score:       null,
      replayed_path:        null,
      signals_matched:      null,
      conflicts_detected:   null,
      penalties_applied:    null,
      dob_veto:             false,
      trace_score:          null,
      delta:                null,
      agrees:               null,
      expected_verdict:     corpusRow.expected_verdict,
      labels:               [],
      label_disagreement:   false,
      verdict_vs_expected:  [],
      block_outcome,
    };
  }

  // EXECUTE — replay (only when a snapshot is present)
  let gate_status       = null;
  let replayed_score     = null;
  let replayed_path      = null;
  let signals_matched    = null;
  let conflicts_detected = null;
  let penalties_applied  = null;
  let dob_veto           = false;
  let inbound            = null;

  if (hasSnapshot) {
    ({ inbound } = parseInboundIdentifiers(corpusRow.inbound_identifiers));

    const gatePassed = passesSignalEligibilityGate(corpusRow.candidate_snapshot, inbound);

    if (!gatePassed) {
      gate_status = 'gated';
    } else {
      gate_status = 'passed';
      const result = probabilisticMatcher.scoreMatch(
        corpusRow.candidate_snapshot,
        inbound,
        FROZEN_CLOCK
      );
      replayed_score     = result.score;
      signals_matched    = result.signals_matched;
      conflicts_detected = result.conflicts_detected;
      penalties_applied  = result.penalties_applied;
      dob_veto           = result.dob_veto === true;

      replayed_path = pathForMatch(replayed_score, signals_matched);
    }
  }

  // EXECUTE — trace score (only when a trace is present; reaching here means
  // scoring_status === 'performed', guaranteed by the guard above)
  let trace_score = null;
  if (hasTrace) {
    trace_score = parseFloat(traceRow.best_score);
  }

  // EXECUTE — score_source
  let score_source = null;
  if (hasSnapshot && hasTrace) {
    score_source = 'both';
  } else if (hasSnapshot) {
    score_source = 'replayed';
  } else if (hasTrace) {
    score_source = 'from_trace';
  }

  // EXECUTE — delta / agrees. Tolerance comparison only — never ===.
  let delta  = null;
  let agrees = null;
  if (score_source === 'both' && gate_status === 'passed') {
    delta  = replayed_score - trace_score;
    agrees = Math.abs(delta) <= SCORE_TOLERANCE;
  }

  // EXECUTE — labels. Preserve every labeler's verdict; never collapse to one
  // and never let expected_verdict shadow disagreement.
  const labels = hasTrace
    ? labelRows.map((r) => ({ labeled_by: r.labeled_by, verdict: r.verdict }))
    : [];
  const label_disagreement = new Set(labels.map((l) => l.verdict)).size > 1;
  const verdict_vs_expected = labels.map((l) => ({
    labeled_by:      l.labeled_by,
    verdict:         l.verdict,
    matches_expected: l.verdict === corpusRow.expected_verdict,
  }));

  // RETURN
  return {
    corpus_id: corpusRow.id,
    state,
    skipped: false,
    skip_reason: null,
    score_source,
    gate_status,
    replayed_score,
    replayed_path,
    signals_matched,
    conflicts_detected,
    penalties_applied,
    dob_veto,
    trace_score,
    delta,
    agrees,
    expected_verdict: corpusRow.expected_verdict,
    labels,
    label_disagreement,
    verdict_vs_expected,
    block_outcome,
  };
}

// summarizeScorecard — pure. Totals evaluateRow results. Does not rescore.
// A row counts only when the label is match or not_match, the row was not
// skipped, and the harness either gated it or assigned a path.
function summarizeScorecard(rows) {
  const counts = {
    found: 0,
    silent_miss: 0,
    correct_separation: 0,
    false_alarm: 0,
    excluded: 0,
  };

  for (const row of rows) {
    counts[classifyScorecardRow(row)] += 1;
  }

  const recallDenom = counts.found + counts.silent_miss;
  const precisionDenom = counts.found + counts.false_alarm;

  return {
    ...counts,
    recall: recallDenom > 0 ? counts.found / recallDenom : null,
    precision: precisionDenom > 0 ? counts.found / precisionDenom : null,
  };
}

function blockOutcome(traceRow) {
  if (traceRow == null) return null;
  if (BLOCK_MISS_REASONS.includes(traceRow.skip_reason)) return traceRow.skip_reason;
  const results = Array.isArray(traceRow.block_results) ? traceRow.block_results : [];
  if (results.length > 0 && results.every((item) => item && item.dropped === true)) {
    return 'block_dropped_oversize';
  }
  if (results.some((item) => item && item.dropped === false)) return 'retrieved';
  return null;
}

// A blocking miss is a labeled match the retriever never handed to scoring.
// A scoring miss is a labeled match that was retrieved and then landed on
// path B or the gate. summarizeScorecard still reports both inside silent_miss
// when the row was actually scored.
function classifyBlocking(row) {
  if (row.expected_verdict !== 'match') return 'not_applicable';
  if (BLOCK_MISS_REASONS.includes(row.block_outcome)) return 'blocking_miss';
  if (row.skipped === true) return 'not_applicable';
  const separated = row.replayed_path === 'B' || row.gate_status === 'gated';
  if (row.block_outcome === 'retrieved' && separated) return 'scoring_miss';
  return 'not_applicable';
}

function summarizeBlocking(rows) {
  const counts = { blocking_miss: 0, scoring_miss: 0 };
  for (const row of rows) {
    const kind = classifyBlocking(row);
    if (kind === 'blocking_miss' || kind === 'scoring_miss') counts[kind] += 1;
  }
  return counts;
}

function normalizePair(fields) {
  const inbound = {
    org_id: null, email: null, name: null, dob: null, zip: null, device_id: null, guardian_email: null,
  };
  const snapshot = {
    id: '00000000-0000-4000-8000-000000000001',
    org_id: null,
    email: null, email_last_seen_at: null,
    name: null, name_last_seen_at: null,
    dob: null, dob_last_seen_at: null,
    zip: null, zip_last_seen_at: null,
    device_id: null, device_last_seen_at: null,
    guardian_email: null, guardian_email_last_seen_at: null,
  };
  if (fields == null) return { inbound, snapshot: null };
  for (const field of INBOUND_FIELDS) {
    if (fields[field] == null || fields[field] === '') continue;
    const value = field === 'device_id'
      ? fields[field]
      : normalizeIdentifier(field, String(fields[field]));
    inbound[field] = value;
    snapshot[field] = value;
    if (field !== 'device_id') snapshot[`${field}_last_seen_at`] = '2026-07-01T00:00:00.000Z';
    if (field === 'device_id') snapshot.device_last_seen_at = '2026-07-01T00:00:00.000Z';
  }
  return { inbound, snapshot };
}

function replayScenarios(scenarios) {
  return scenarios.map((scenario) => {
    const candidate = normalizePair(scenario.candidate);
    const inbound = normalizePair(scenario.inbound);
    const corpus = {
      id: scenario.id,
      source: scenario.source || 'synthetic',
      trace_id: scenario.trace ? scenario.id : null,
      inbound_identifiers: inbound.inbound,
      candidate_snapshot: scenario.candidate == null ? null : candidate.snapshot,
      expected_verdict: scenario.expected_verdict,
    };
    if (scenario.candidate) {
      for (const field of INBOUND_FIELDS) {
        if (candidate.snapshot[field] != null) {
          corpus.candidate_snapshot[field] = candidate.snapshot[field];
          const seen = field === 'device_id' ? 'device_last_seen_at' : `${field}_last_seen_at`;
          corpus.candidate_snapshot[seen] = candidate.snapshot[seen];
        }
      }
    }
    const row = evaluateRow(corpus, scenario.trace || null, []);
    return {
      ...row,
      scenario_id: scenario.id,
      known_non_signal: scenario.known_non_signal || null,
    };
  });
}

// Repeats the same scored pairs. This is scoring time only. It does not
// search a fan table, so it is not a blocking measurement.
function timeReplay(scenarios, sizes = REPLAY_SIZES) {
  const scored = scenarios.filter((scenario) => scenario.trace == null || scenario.trace.scoring_status === 'performed');
  return sizes.map((pairs) => {
    const started = Date.now();
    for (let i = 0; i < pairs; i += 1) {
      replayScenarios([scored[i % scored.length]]);
    }
    return { pairs, duration_ms: Date.now() - started };
  });
}

function classifyScorecardRow(row) {
  if (row.skipped === true) return 'excluded';
  if (row.expected_verdict !== 'match' && row.expected_verdict !== 'not_match') return 'excluded';

  const queued = row.replayed_path === 'C' || row.replayed_path === 'D';
  const separated = row.replayed_path === 'B' || row.gate_status === 'gated';
  if (!queued && !separated) return 'excluded';

  if (row.expected_verdict === 'match' && queued) return 'found';
  if (row.expected_verdict === 'match' && separated) return 'silent_miss';
  if (row.expected_verdict === 'not_match' && separated) return 'correct_separation';
  return 'false_alarm';
}

module.exports = {
  VERDICTS,
  LABEL_SOURCE,
  FROZEN_CLOCK,
  SCORE_TOLERANCE,
  parseInboundIdentifiers,
  evaluateRow,
  summarizeScorecard,
  summarizeBlocking,
  classifyBlocking,
  replayScenarios,
  timeReplay,
  BLOCK_MISS_REASONS,
  REPLAY_SIZES,
};
