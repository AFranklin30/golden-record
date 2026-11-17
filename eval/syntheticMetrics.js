'use strict';

// Pairwise identity metrics for the committed 360-row synthetic import.
// Definitions: docs/evaluation/s1-05-metric-definitions.md
//
//   node scripts/buildSyntheticDemoCsv.js --labels
//   node eval/syntheticMetrics.js
//
// The script checks the dataset hashes, reads the committed S1-04 results,
// and writes a new report. It does not call the resolver, the matcher, or
// the importer, and it does not write the import results file.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LABEL_PATH = path.join(ROOT, 'demo', 'synthetic-ground-truth-v2.json');
const SET_A_PATH = path.join(ROOT, 'demo', 'synthetic-customers-200.csv');
const SET_B_PATH = path.join(ROOT, 'demo', 'synthetic-extension-160.csv');
const MANIFEST_PATH = path.join(ROOT, 'demo', 'synthetic-dataset-manifest.json');
const IMPORT_PATH = path.join(ROOT, 'eval', 'reports', 'synthetic-360-import-results.json');
const JSON_PATH = path.join(ROOT, 'eval', 'reports', 'synthetic-360-metrics.json');
const REPORT_PATH = path.join(ROOT, 'eval', 'reports', 'synthetic-360-metrics-report.md');

const EXPECTED = {
  label_sha256: '0db2aa4810cd02583749830190f8877ca66b0d681882641099c57ac1a92af8b4',
  set_a_csv_sha256: '3fb01339fa4144d63a566c97a39fe3869cd96a1c9d4df86fb288a3a783bf2bc7',
  set_b_csv_sha256: '9c010f0ee4fa88ecc4b6e57f7cae4f8766a42475640e0ba40a02ec9862f062f8',
  import_results_sha256: '33afd385694b08a6edfbbaddf015be4b3b605cf727e07c46728a166daf6820ba',
};

const POLICY_OUTCOME = {
  hard_match: 'auto_merge',
  review: 'review',
  separate: 'new',
  import_replay: 'replay',
  import_error: 'import_error',
};

const NEVER_SCORED = new Set(['no_block_key', 'empty_block', 'block_dropped_oversize']);

const CLASSES = [
  'introduction',
  'introduction_other',
  'replay',
  'import_error',
  'true_positive',
  'false_positive',
  'false_positive_wrong_fan',
  'false_negative',
  'true_negative',
  'review_same_person',
  'review_distinct_person',
  'review_wrong_target_same_person',
  'review_wrong_target_distinct_person',
];

const PRECISION_DENOMINATOR = new Set([
  'true_positive',
  'false_positive',
  'false_positive_wrong_fan',
]);

const RECALL_DENOMINATOR = new Set(['true_positive', 'false_negative']);

const REVIEW_CLASSES = new Set([
  'review_same_person',
  'review_distinct_person',
  'review_wrong_target_same_person',
  'review_wrong_target_distinct_person',
]);

const ELIGIBLE_CLASSES = new Set([
  ...PRECISION_DENOMINATOR,
  ...RECALL_DENOMINATOR,
  'true_negative',
  ...REVIEW_CLASSES,
]);

const COMPARED_FIELDS = [
  'set',
  'scenario_id',
  'case_id',
  'role',
  'person_key',
  'anchor_row',
  'identity_truth',
  'policy_expected',
  'expected_path',
];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function round4(value) {
  if (value == null) return null;
  return Math.round(value * 10000) / 10000;
}

function ratio(numerator, denominator) {
  if (!denominator) return null;
  return numerator / denominator;
}

function fraction(numerator, denominator, boundOnPerfect) {
  const out = {
    numerator,
    denominator,
    value: round4(ratio(numerator, denominator)),
  };
  if (boundOnPerfect && denominator > 0 && numerator === denominator) {
    out.rule_of_three = {
      numerator: 3,
      denominator,
      value: round4(3 / denominator),
    };
  }
  return out;
}

function emptyCounts() {
  const counts = {};
  for (const name of CLASSES) counts[name] = 0;
  return counts;
}

function fail(message) {
  const error = new Error(message);
  error.code = 'METRIC_STOP';
  throw error;
}

function linkedToAnchor(row) {
  return row.matched_row === row.anchor_row;
}

function classify(row) {
  if (row.role === 'first_seen' || row.role === 'anchor') {
    if (row.identity_truth !== 'first_seen') {
      fail(`row ${row.row} introduction identity is ${row.identity_truth}`);
    }
    if (row.anchor_row != null) fail(`row ${row.row} introduction has an anchor`);
    if (row.engine_outcome === 'new') {
      if (row.path !== 'B') fail(`row ${row.row} new introduction path is ${row.path}`);
      return 'introduction';
    }
    return 'introduction_other';
  }

  if (row.role !== 'probe') fail(`row ${row.row} role ${row.role}`);
  if (row.anchor_row == null) fail(`row ${row.row} probe has no anchor`);
  if (row.identity_truth !== 'same_person' && row.identity_truth !== 'distinct_person') {
    fail(`row ${row.row} identity ${row.identity_truth}`);
  }

  if (row.engine_outcome === 'replay') {
    if (row.replayed !== true) fail(`row ${row.row} replay flag is not set`);
    if (row.resolver_called !== false) fail(`row ${row.row} replay called the resolver`);
    return 'replay';
  }

  if (row.engine_outcome === 'import_error') {
    if (row.import_status !== 'error') fail(`row ${row.row} import error status is ${row.import_status}`);
    return 'import_error';
  }

  const linked = linkedToAnchor(row);
  const same = row.identity_truth === 'same_person';

  if (row.engine_outcome === 'auto_merge') {
    if (row.path !== 'A') fail(`row ${row.row} auto-merge path is ${row.path}`);
    if (same) {
      if (linked && row.matched_person_key !== row.person_key) {
        fail(`row ${row.row} same-person auto-merge person key does not match the anchor`);
      }
      return linked ? 'true_positive' : 'false_positive_wrong_fan';
    }
    return 'false_positive';
  }

  if (row.engine_outcome === 'review') {
    if (row.path !== 'C' && row.path !== 'D') fail(`row ${row.row} review path is ${row.path}`);
    if (same) {
      if (linked && row.matched_person_key !== row.person_key) {
        fail(`row ${row.row} same-person review person key does not match the anchor`);
      }
      return linked ? 'review_same_person' : 'review_wrong_target_same_person';
    }
    return linked ? 'review_distinct_person' : 'review_wrong_target_distinct_person';
  }

  if (row.engine_outcome === 'new') {
    if (row.path !== 'B') fail(`row ${row.row} new path is ${row.path}`);
    if (row.matched_row != null) fail(`row ${row.row} new record has a matched row`);
    return same ? 'false_negative' : 'true_negative';
  }

  fail(`row ${row.row} engine outcome ${row.engine_outcome}`);
}

function countOf(counts, names) {
  let total = 0;
  for (const name of names) total += counts[name] || 0;
  return total;
}

function neverScored(rows) {
  const byReason = {};
  let never = 0;
  let other = 0;
  for (const row of rows) {
    const reason = row.skip_reason || 'none';
    byReason[reason] = (byReason[reason] || 0) + 1;
    if (row.scoring_status === 'skipped' && NEVER_SCORED.has(row.skip_reason)) never += 1;
    else other += 1;
  }
  return { rows: rows.length, never_scored: never, other, by_skip_reason: byReason };
}

function slice(rows) {
  const counts = emptyCounts();
  const personKeys = {};
  for (const name of CLASSES) personKeys[name] = new Set();
  for (const row of rows) {
    counts[row.identity_class] += 1;
    personKeys[row.identity_class].add(row.person_key);
  }
  const personKeyCounts = {};
  for (const name of CLASSES) personKeyCounts[name] = personKeys[name].size;

  const truePositives = counts.true_positive;
  const falsePositivesLinked = rows.filter((row) => row.identity_class === 'false_positive' && row.linked_to_anchor).length;
  const falsePositivesElsewhere = rows.filter((row) => row.identity_class === 'false_positive' && !row.linked_to_anchor).length;
  const falsePositives = counts.false_positive + counts.false_positive_wrong_fan;
  const falseNegatives = counts.false_negative;
  const reviews = countOf(counts, REVIEW_CLASSES);
  const eligible = countOf(counts, ELIGIBLE_CLASSES);
  const probes = rows.filter((row) => row.role === 'probe').length;
  const foundNumerator = truePositives + counts.review_same_person;
  const foundDenominator = rows.filter((row) => row.role === 'probe' && row.identity_truth === 'same_person').length;

  return {
    rows: rows.length,
    probes,
    introductions: counts.introduction + counts.introduction_other,
    counts,
    person_key_counts: personKeyCounts,
    true_positives: truePositives,
    false_matches: falsePositives,
    false_positives_linked_to_anchor: falsePositivesLinked,
    false_positives_elsewhere: falsePositivesElsewhere,
    false_positives_wrong_fan: counts.false_positive_wrong_fan,
    missed_matches: falseNegatives,
    true_negatives: counts.true_negative,
    reviews,
    review_same_person: counts.review_same_person,
    review_distinct_person: counts.review_distinct_person,
    review_wrong_target: counts.review_wrong_target_same_person + counts.review_wrong_target_distinct_person,
    reviews_marked_indistinguishable: rows.filter((row) => REVIEW_CLASSES.has(row.identity_class) && row.indistinguishable).length,
    replays: counts.replay,
    import_errors: counts.import_error,
    eligible,
    precision: fraction(truePositives, truePositives + falsePositives, true),
    recall: fraction(truePositives, truePositives + falseNegatives, true),
    found_rate: fraction(foundNumerator, foundDenominator, false),
    review_percentage_of_eligible: fraction(reviews, eligible, false),
    review_percentage_of_probes: fraction(reviews, probes, false),
    review_yield: fraction(counts.review_same_person, reviews, false),
  };
}

function groupRows(rows, key) {
  const order = [];
  const groups = new Map();
  for (const row of rows) {
    const id = row[key];
    if (!groups.has(id)) {
      groups.set(id, []);
      order.push(id);
    }
    groups.get(id).push(row);
  }
  return order.map((id) => ({ id, rows: groups.get(id) }));
}

function histogram(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row[key] == null ? 'none' : String(row[key]);
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function policyByClass(rows) {
  const table = {};
  for (const row of rows) {
    if (!table[row.identity_class]) table[row.identity_class] = {};
    const policy = row.policy_expected;
    table[row.identity_class][policy] = (table[row.identity_class][policy] || 0) + 1;
  }
  return table;
}

function exampleFor(rows, id, title, predicate) {
  const row = rows.find(predicate);
  if (!row) return null;
  return {
    id,
    title,
    row: row.row,
    set: row.set,
    scenario_id: row.scenario_id,
    case_group: row.case_group,
    case_id: row.case_id,
    identity_truth: row.identity_truth,
    policy_expected: row.policy_expected,
    engine_outcome: row.engine_outcome,
    path: row.path,
    score: row.score,
    identity_class: row.identity_class,
    linked_to_anchor: row.linked_to_anchor,
    indistinguishable: row.indistinguishable,
    skip_reason: row.skip_reason,
    error: row.error,
    explanation: row.explanation,
    notes: row.notes,
  };
}

function buildExamples(rows) {
  const rules = [
    ['true_positive', 'Correct automatic association', (row) => row.identity_class === 'true_positive'],
    ['true_negative', 'Correct separation', (row) => row.identity_class === 'true_negative'],
    ['false_positive', 'Incorrect automatic association', (row) => row.identity_class === 'false_positive'],
    ['indistinguishable_false_positive', 'Incorrect automatic association marked indistinguishable', (row) => row.identity_class === 'false_positive' && row.indistinguishable === true],
    ['false_negative', 'Missed duplicate', (row) => row.identity_class === 'false_negative'],
    ['review_same_person', 'Same person held for review', (row) => row.identity_class === 'review_same_person'],
    ['review_distinct_person', 'Different people held for review', (row) => row.identity_class === 'review_distinct_person'],
    ['replay', 'Replay of an earlier row', (row) => row.identity_class === 'replay'],
    ['import_error_distinct', 'Import error for a different person', (row) => row.identity_class === 'import_error' && row.identity_truth === 'distinct_person'],
    ['import_error_same', 'Import error for the same person', (row) => row.identity_class === 'import_error' && row.identity_truth === 'same_person'],
    ['mb3_probe', 'First MB-3 probe', (row) => row.scenario_id === 'MB-3' && row.role === 'probe'],
    ['mb4_probe', 'First MB-4 probe', (row) => row.scenario_id === 'MB-4' && row.role === 'probe'],
  ];
  return rules.map(([id, title, predicate]) => exampleFor(rows, id, title, predicate)).filter(Boolean);
}

function assertClosed(metrics) {
  const counts = metrics.overall.counts;
  const classSum = CLASSES.reduce((sum, name) => sum + counts[name], 0);
  if (classSum !== metrics.population.rows) {
    fail(`class counts sum to ${classSum}, expected ${metrics.population.rows}`);
  }
  if (metrics.overall.probes + metrics.overall.introductions !== metrics.population.rows) {
    fail('probes and introductions do not cover every row');
  }
  for (const name of CLASSES) {
    const split = metrics.by_set.A.counts[name] + metrics.by_set.B.counts[name];
    if (split !== counts[name]) fail(`set split for ${name} is ${split}, overall is ${counts[name]}`);
  }
  const groupRowsSum = metrics.by_scenario_group.reduce((sum, group) => sum + group.rows, 0);
  if (groupRowsSum !== metrics.population.rows) fail(`scenario groups cover ${groupRowsSum} rows`);
  const groupProbes = metrics.by_scenario_group.reduce((sum, group) => sum + group.probes, 0);
  if (groupProbes !== metrics.population.probes) fail(`scenario groups cover ${groupProbes} probes`);
  if (metrics.overall.true_positives + metrics.overall.false_matches !== metrics.overall.precision.denominator) {
    fail('precision denominator does not match the false-match split');
  }
  if (metrics.overall.false_positives_linked_to_anchor + metrics.overall.false_positives_elsewhere !== metrics.overall.counts.false_positive) {
    fail('distinct false positives do not split by link target');
  }
}

function evaluate(rows, attestation) {
  if (!Array.isArray(rows)) fail('expected joined rows');
  const classified = rows.map((row) => {
    const identityClass = classify(row);
    const policyOutcome = POLICY_OUTCOME[row.policy_expected];
    if (!policyOutcome) fail(`row ${row.row} policy ${row.policy_expected}`);
    return {
      row: row.row,
      set: row.set,
      scenario_id: row.scenario_id,
      case_group: row.case_group,
      case_id: row.case_id,
      role: row.role,
      person_key: row.person_key,
      anchor_row: row.anchor_row,
      matched_row: row.matched_row,
      identity_truth: row.identity_truth,
      policy_expected: row.policy_expected,
      engine_outcome: row.engine_outcome,
      path: row.path,
      score: row.score,
      scoring_status: row.scoring_status,
      skip_reason: row.skip_reason,
      signals: row.signals,
      indistinguishable: row.indistinguishable === true,
      flag: row.flag,
      identity_class: identityClass,
      linked_to_anchor: row.role === 'probe' ? linkedToAnchor(row) : null,
      in_precision_denominator: PRECISION_DENOMINATOR.has(identityClass),
      in_precision_numerator: identityClass === 'true_positive',
      in_recall_denominator: RECALL_DENOMINATOR.has(identityClass),
      in_recall_numerator: identityClass === 'true_positive',
      in_review_volume: REVIEW_CLASSES.has(identityClass),
      error: row.error,
      import_status: row.import_status,
      replayed: row.replayed === true,
      resolver_called: row.resolver_called === true,
      fan_id_present: row.fan_id_present === true,
      policy_engine_outcome: policyOutcome,
      policy_outcome_matches: policyOutcome === row.engine_outcome,
      explanation: row.explanation,
      notes: row.notes,
    };
  });

  const personKeys = new Set(classified.map((row) => row.person_key));
  const personGroups = new Map();
  for (const row of classified) {
    if (!personGroups.has(row.person_key)) personGroups.set(row.person_key, []);
    personGroups.get(row.person_key).push(row);
  }
  const personKeySizes = {};
  let sizeThreeWithReplay = 0;
  for (const group of personGroups.values()) {
    personKeySizes[group.length] = (personKeySizes[group.length] || 0) + 1;
    if (group.length === 3 && group.some((row) => row.identity_class === 'replay')) sizeThreeWithReplay += 1;
  }
  const probes = classified.filter((row) => row.role === 'probe');
  const samePersonProbes = probes.filter((row) => row.identity_truth === 'same_person');
  const distinctProbes = probes.filter((row) => row.identity_truth === 'distinct_person');
  const overall = slice(classified);
  const bySet = {
    A: slice(classified.filter((row) => row.set === 'A')),
    B: slice(classified.filter((row) => row.set === 'B')),
  };
  const byScenarioGroup = groupRows(classified, 'case_group').map((group) => ({
    case_group: group.id,
    ...slice(group.rows),
  }));
  const byScenario = groupRows(classified, 'scenario_id').map((group) => ({
    scenario_id: group.id,
    ...slice(group.rows),
    indistinguishable_probes: group.rows.filter((row) => row.role === 'probe' && row.indistinguishable).length,
  }));

  const reviews = classified.filter((row) => REVIEW_CLASSES.has(row.identity_class));
  const newRows = classified.filter((row) => row.engine_outcome === 'new');
  const replayRows = classified.filter((row) => row.identity_class === 'replay');
  const errorRows = classified.filter((row) => row.identity_class === 'import_error');
  const policyMismatches = classified.filter((row) => !row.policy_outcome_matches);

  const metrics = {
    kind: 'synthetic-360-identity-metrics',
    definitions: 'docs/evaluation/s1-05-metric-definitions.md',
    unit: 'pairwise',
    unit_reason: 'Each probe label is one relationship to one anchor. Five people also have a replay, which is a second row and not a second resolution. Cluster scores are not computed.',
    inputs: attestation || null,
    population: {
      rows: classified.length,
      probes: probes.length,
      same_person_probes: samePersonProbes.length,
      distinct_person_probes: distinctProbes.length,
      introductions: overall.introductions,
      person_keys: personKeys.size,
      person_key_sizes: personKeySizes,
      person_keys_with_three_rows_and_a_replay: sizeThreeWithReplay,
      sets: {
        A: { rows: bySet.A.rows, probes: bySet.A.probes },
        B: { rows: bySet.B.rows, probes: bySet.B.probes },
      },
    },
    overall,
    by_set: bySet,
    by_scenario_group: byScenarioGroup,
    by_scenario: byScenario,
    confusion: {
      eligible_probes: {
        same_person: {
          auto_merge: overall.counts.true_positive + overall.counts.false_positive_wrong_fan,
          review: overall.counts.review_same_person + overall.counts.review_wrong_target_same_person,
          new: overall.counts.false_negative,
        },
        distinct_person: {
          auto_merge: overall.counts.false_positive,
          review: overall.counts.review_distinct_person + overall.counts.review_wrong_target_distinct_person,
          new: overall.counts.true_negative,
        },
      },
      held_out: {
        replay: { same_person: replayRows.filter((row) => row.identity_truth === 'same_person').length, distinct_person: replayRows.filter((row) => row.identity_truth === 'distinct_person').length },
        import_error: { same_person: errorRows.filter((row) => row.identity_truth === 'same_person').length, distinct_person: errorRows.filter((row) => row.identity_truth === 'distinct_person').length },
      },
    },
    new_records: {
      engine_outcome_new: newRows.length,
      introductions: overall.counts.introduction,
      introduction_other: overall.counts.introduction_other,
      true_negatives: overall.counts.true_negative,
      missed_matches: overall.counts.false_negative,
      true_negatives_scoring: neverScored(classified.filter((row) => row.identity_class === 'true_negative')),
      missed_matches_scoring: neverScored(classified.filter((row) => row.identity_class === 'false_negative')),
    },
    reviews: {
      total: reviews.length,
      eligible: overall.eligible,
      percentage_of_eligible: overall.review_percentage_of_eligible,
      percentage_of_probes: overall.review_percentage_of_probes,
      percentage_of_all_rows: fraction(reviews.length, classified.length, false),
      same_person_linked_to_anchor: overall.counts.review_same_person,
      distinct_person_linked_to_anchor: overall.counts.review_distinct_person,
      wrong_target: overall.review_wrong_target,
      marked_indistinguishable: overall.reviews_marked_indistinguishable,
      yield: overall.review_yield,
      by_score: histogram(reviews, 'score'),
      by_path: histogram(reviews, 'path'),
    },
    replays: {
      rows: replayRows.length,
      same_person: replayRows.filter((row) => row.identity_truth === 'same_person').length,
      linked_to_anchor: replayRows.filter((row) => row.linked_to_anchor).length,
      resolver_called: replayRows.filter((row) => row.resolver_called).length,
      by_path: histogram(replayRows, 'path'),
      fan_id_present: replayRows.filter((row) => row.fan_id_present).length,
    },
    import_errors: {
      rows: errorRows.length,
      fan_id_present: errorRows.filter((row) => row.fan_id_present).length,
      resolver_called: errorRows.filter((row) => row.resolver_called).length,
      groups: groupRows(errorRows, 'scenario_id').map((group) => ({
        scenario_id: group.id,
        rows: group.rows.length,
        identity_truth: histogram(group.rows, 'identity_truth'),
        path: histogram(group.rows, 'path'),
        error: histogram(group.rows, 'error'),
        scoring_status: histogram(group.rows, 'scoring_status'),
        skip_reason: histogram(group.rows, 'skip_reason'),
        linked_to_anchor: group.rows.filter((row) => row.linked_to_anchor).length,
        fan_id_present: group.rows.filter((row) => row.fan_id_present).length,
      })),
    },
    policy_conformance: {
      rows: classified.length,
      matches: classified.length - policyMismatches.length,
      mismatches: policyMismatches.map((row) => ({
        row: row.row,
        scenario_id: row.scenario_id,
        policy_expected: row.policy_expected,
        engine_outcome: row.engine_outcome,
        identity_class: row.identity_class,
      })),
      by_identity_class: policyByClass(classified),
    },
    examples: buildExamples(classified),
    rows: classified.map((row) => ({
      row: row.row,
      set: row.set,
      scenario_id: row.scenario_id,
      case_group: row.case_group,
      case_id: row.case_id,
      role: row.role,
      person_key: row.person_key,
      anchor_row: row.anchor_row,
      matched_row: row.matched_row,
      identity_truth: row.identity_truth,
      policy_expected: row.policy_expected,
      engine_outcome: row.engine_outcome,
      path: row.path,
      score: row.score,
      skip_reason: row.skip_reason,
      indistinguishable: row.indistinguishable,
      identity_class: row.identity_class,
      linked_to_anchor: row.linked_to_anchor,
      in_precision_denominator: row.in_precision_denominator,
      in_precision_numerator: row.in_precision_numerator,
      in_recall_denominator: row.in_recall_denominator,
      in_recall_numerator: row.in_recall_numerator,
      in_review_volume: row.in_review_volume,
      policy_outcome_matches: row.policy_outcome_matches,
    })),
  };

  assertClosed(metrics);
  return metrics;
}

function showFraction(item) {
  if (!item || item.denominator === 0) return 'n/a (denominator 0)';
  let bound = '';
  if (item.rule_of_three && item.denominator === 15) {
    bound = '; zero errors across these 15 automatic decisions gives an approximate 95% upper bound on the error rate of 3/15 = 0.2 (20%). This is an approximate statistical bound, not a guarantee of real-world performance, and it does not mean the true rate is necessarily below 20%';
  } else if (item.rule_of_three) {
    bound = `; zero errors in ${item.denominator}, rule-of-three upper bound 3 / ${item.denominator} = ${item.rule_of_three.value}`;
  }
  return `${item.numerator} / ${item.denominator} = ${item.value}${bound}`;
}

function countLine(sliceMetrics) {
  return [
    `TP ${sliceMetrics.true_positives}`,
    `FP ${sliceMetrics.false_matches}`,
    `FN ${sliceMetrics.missed_matches}`,
    `TN ${sliceMetrics.true_negatives}`,
    `reviews ${sliceMetrics.reviews}`,
    `replays ${sliceMetrics.replays}`,
    `import errors ${sliceMetrics.import_errors}`,
  ].join(', ');
}

function formatReport(metrics) {
  const lines = [];
  const overall = metrics.overall;
  const setA = metrics.by_set.A;
  const setB = metrics.by_set.B;
  lines.push('# Synthetic 360 identity-resolution metrics');
  lines.push('');
  lines.push('Pairwise measurement of the committed S1-04 import against the recipe labels. Identity truth, the policy-expected outcome, the engine outcome, and the import outcome are kept apart. Definitions: `docs/evaluation/s1-05-metric-definitions.md`.');
  lines.push('');
  lines.push('## Inputs');
  lines.push('');
  const inputs = metrics.inputs || {};
  lines.push(`- Label sha256: \`${inputs.label_sha256}\`.`);
  lines.push(`- Set A CSV sha256: \`${inputs.set_a_csv_sha256}\`.`);
  lines.push(`- Set B CSV sha256: \`${inputs.set_b_csv_sha256}\`.`);
  lines.push(`- Import results sha256: \`${inputs.import_results_sha256}\`.`);
  lines.push(`- Import results label sha256: \`${inputs.import_results_label_sha256}\`.`);
  lines.push('- The evaluator read the committed results file. It did not run the import again.');
  lines.push('');
  lines.push('## Population');
  lines.push('');
  lines.push(`- Rows: ${metrics.population.rows}.`);
  lines.push(`- Probes: ${metrics.population.probes} (${metrics.population.same_person_probes} same person, ${metrics.population.distinct_person_probes} distinct person).`);
  lines.push(`- Introductions: ${metrics.population.introductions}.`);
  lines.push(`- Person keys: ${metrics.population.person_keys}. A key can appear on an introduction and again on a probe.`);
  lines.push(`- Set A: ${metrics.population.sets.A.rows} rows, ${metrics.population.sets.A.probes} probes.`);
  lines.push(`- Set B: ${metrics.population.sets.B.rows} rows, ${metrics.population.sets.B.probes} probes.`);
  lines.push('');
  lines.push('The rates below are pairwise: one probe, one anchor, one decision. Record counts are printed next to them. Auto-merge means path A associated the probe with an existing fan. No review was confirmed.');
  lines.push('');
  lines.push('## Precision and recall');
  lines.push('');
  lines.push('Set A and Set B are the figures to read. The pooled line adds the same counts. It is not one population.');
  lines.push('');
  lines.push(`- Set A precision: ${showFraction(setA.precision)}.`);
  lines.push(`- Set A recall: ${showFraction(setA.recall)}.`);
  lines.push(`- Set A found rate: ${showFraction(setA.found_rate)}.`);
  lines.push(`- Set A counts: ${countLine(setA)}.`);
  if (setA.precision.rule_of_three && setA.precision.denominator === 15) {
    lines.push(`The 3/15 bound covers only Set A's ${setA.precision.denominator} automatic decisions. It does not cover Set A's ${setA.reviews} reviews or Set A's ${setA.replays} replays.`);
  }
  lines.push(`- Set B precision: ${showFraction(setB.precision)}.`);
  lines.push(`- Set B recall: ${showFraction(setB.recall)}.`);
  lines.push(`- Set B found rate: ${showFraction(setB.found_rate)}.`);
  lines.push(`- Set B counts: ${countLine(setB)}.`);
  lines.push(`Set B was designed to produce the ${setB.false_matches + setB.missed_matches} observed identity errors: ${setB.false_matches} distinct-person probes expected to auto-merge and ${setB.missed_matches} same-person probes expected to be stored as new. Those ${setB.false_matches + setB.missed_matches} rows are the entire error count, and Set B has ${setB.true_negatives} true negatives. Its purpose is to expose policy weaknesses under adversarial conditions. It does not represent a real-world data distribution and must not be presented as a real-world accuracy estimate.`);
  lines.push(`- Pooled precision: ${showFraction(overall.precision)}.`);
  lines.push(`- Pooled recall: ${showFraction(overall.recall)}.`);
  lines.push(`- Pooled found rate: ${showFraction(overall.found_rate)}.`);
  lines.push(`- Pooled counts: ${countLine(overall)}.`);
  lines.push('');
  lines.push(`False matches: ${overall.false_matches}. Distinct-person auto-merges: ${overall.counts.false_positive} (${overall.false_positives_linked_to_anchor} linked to the anchor, ${overall.false_positives_elsewhere} linked elsewhere). Same-person auto-merges onto another fan: ${overall.false_positives_wrong_fan}.`);
  lines.push('');
  lines.push(`Missed matches: ${overall.missed_matches}. These are same-person probes stored as new people. Same-person reviews held out of recall: ${overall.review_same_person}.`);
  lines.push('');
  const samePersonReplays = metrics.rows.filter((row) => row.identity_class === 'replay' && row.identity_truth === 'same_person').length;
  const samePersonImportErrors = metrics.rows.filter((row) => row.identity_class === 'import_error' && row.identity_truth === 'same_person').length;
  const rp2 = metrics.import_errors.groups.find((group) => group.scenario_id === 'RP-2');
  const rp2Same = rp2 && rp2.identity_truth.same_person ? rp2.identity_truth.same_person : 0;
  const replayReviews = metrics.rows.filter((row) => row.identity_class === 'replay' && row.in_review_volume).length;
  const importErrorReviews = metrics.rows.filter((row) => row.identity_class === 'import_error' && row.in_review_volume).length;
  const earlierFoundDenominator = overall.found_rate.denominator - samePersonReplays - samePersonImportErrors;
  lines.push(`Found rate follows the dataset spec: true positives plus same-person reviews, divided by all same-person probes. It is not recall. Set A and Set B use that same denominator. The earlier pooled denominator was ${overall.found_rate.numerator} / ${earlierFoundDenominator}. It left out ${samePersonReplays} same-person import replays and ${rp2Same} RP-2 import errors. Neither group is a review. Replay rows in the review count: ${replayReviews}. Import-error rows in the review count: ${importErrorReviews}.`);
  lines.push('');
  lines.push('Recall leaves out same-person reviews, replays, and import errors. Set A recall can be 1 while many same-person probes are reviews or replays. Those exclusions are the counts above.');
  lines.push('');
  lines.push('## Review volume');
  lines.push('');
  lines.push(`- Reviews: ${metrics.reviews.total}.`);
  lines.push(`- Eligible probes: ${metrics.reviews.eligible}. Eligible means a probe whose engine outcome is auto-merge, review, or new.`);
  lines.push(`- Reviews as a share of eligible probes: ${showFraction(metrics.reviews.percentage_of_eligible)}.`);
  lines.push(`- Reviews as a share of all probes: ${showFraction(metrics.reviews.percentage_of_probes)}.`);
  lines.push(`- Reviews as a share of all rows: ${showFraction(metrics.reviews.percentage_of_all_rows)}.`);
  lines.push(`- Same person, linked to the anchor: ${metrics.reviews.same_person_linked_to_anchor}.`);
  lines.push(`- Different person, linked to the anchor: ${metrics.reviews.distinct_person_linked_to_anchor}.`);
  lines.push(`- Wrong target: ${metrics.reviews.wrong_target}.`);
  lines.push(`- Reviews marked indistinguishable: ${metrics.reviews.marked_indistinguishable}.`);
  lines.push(`- Review yield (same-person reviews linked to the anchor / reviews): ${showFraction(metrics.reviews.yield)}.`);
  lines.push(`- Review paths: ${JSON.stringify(metrics.reviews.by_path)}.`);
  lines.push(`- Review scores: ${JSON.stringify(metrics.reviews.by_score)}. A score is the engine's number. It does not decide whether the case was ambiguous.`);
  lines.push('');
  lines.push('The labels do not mark a review as genuine ambiguity or as an unnecessary intervention. A same-person review is a real duplicate the engine did not merge. A distinct-person review is two different people the engine did not merge.');
  lines.push('');
  lines.push('## Confusion matrix');
  lines.push('');
  lines.push('Eligible probes only. Replays and import errors are outside this grid.');
  lines.push('');
  lines.push('| Identity truth | Auto-merge | Review | New |');
  lines.push('|---|---:|---:|---:|');
  const confusion = metrics.confusion.eligible_probes;
  lines.push(`| Same person | ${confusion.same_person.auto_merge} | ${confusion.same_person.review} | ${confusion.same_person.new} |`);
  lines.push(`| Distinct person | ${confusion.distinct_person.auto_merge} | ${confusion.distinct_person.review} | ${confusion.distinct_person.new} |`);
  lines.push('');
  lines.push('Same-person auto-merge in this grid is a true positive plus any same-person auto-merge onto the wrong fan. Distinct-person auto-merge is a false match. Same-person new is a missed match. Distinct-person new is a true negative.');
  lines.push('');
  lines.push(`Held out of the grid: replays ${metrics.confusion.held_out.replay.same_person} same person and ${metrics.confusion.held_out.replay.distinct_person} distinct person; import errors ${metrics.confusion.held_out.import_error.same_person} same person and ${metrics.confusion.held_out.import_error.distinct_person} distinct person.`);
  lines.push('');
  lines.push(`True negatives never scored: ${metrics.new_records.true_negatives_scoring.never_scored} of ${metrics.new_records.true_negatives_scoring.rows}. Skip reasons: ${JSON.stringify(metrics.new_records.true_negatives_scoring.by_skip_reason)}.`);
  lines.push('');
  lines.push(`Missed matches never scored: ${metrics.new_records.missed_matches_scoring.never_scored} of ${metrics.new_records.missed_matches_scoring.rows}. Skip reasons: ${JSON.stringify(metrics.new_records.missed_matches_scoring.by_skip_reason)}.`);
  lines.push('');
  lines.push('## New records');
  lines.push('');
  lines.push(`- Engine outcome new: ${metrics.new_records.engine_outcome_new}.`);
  lines.push(`- Introductions: ${metrics.new_records.introductions}.`);
  lines.push(`- Introductions with another outcome: ${metrics.new_records.introduction_other}.`);
  lines.push(`- Distinct probes stored as new people: ${metrics.new_records.true_negatives}.`);
  lines.push(`- Same-person probes stored as new people: ${metrics.new_records.missed_matches}.`);
  lines.push('');
  lines.push('## Import errors');
  lines.push('');
  lines.push(`Rows: ${metrics.import_errors.rows}. Fan id present on ${metrics.import_errors.fan_id_present}. Resolver called on ${metrics.import_errors.resolver_called}. A fan id on an error row is not counted as a stored person. These rows are outside precision, recall, review volume, and new-record totals.`);
  lines.push('');
  for (const group of metrics.import_errors.groups) {
    lines.push(`- ${group.scenario_id}: ${group.rows} rows, identity ${JSON.stringify(group.identity_truth)}, path ${JSON.stringify(group.path)}, error ${JSON.stringify(group.error)}, scoring ${JSON.stringify(group.scoring_status)}, skip reason ${JSON.stringify(group.skip_reason)}, linked to the anchor ${group.linked_to_anchor}.`);
  }
  lines.push('');
  lines.push('## Replays');
  lines.push('');
  lines.push(`Rows: ${metrics.replays.rows}. Same person: ${metrics.replays.same_person}. Linked to the anchor: ${metrics.replays.linked_to_anchor}. Resolver called: ${metrics.replays.resolver_called}. Paths: ${JSON.stringify(metrics.replays.by_path)}.`);
  lines.push('');
  lines.push('A replay returns the earlier row. It is not a new person and it is not a duplicate-detection success.');
  lines.push('');
  lines.push('## Scenario groups');
  lines.push('');
  lines.push('| Group | Rows | Probes | Eligible | TP | FP | FN | TN | Reviews | Precision | Recall | Reviews / eligible |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|');
  for (const group of metrics.by_scenario_group) {
    lines.push(`| ${group.case_group} | ${group.rows} | ${group.probes} | ${group.eligible} | ${group.true_positives} | ${group.false_matches} | ${group.missed_matches} | ${group.true_negatives} | ${group.reviews} | ${showFraction(group.precision)} | ${showFraction(group.recall)} | ${showFraction(group.review_percentage_of_eligible)} |`);
  }
  lines.push('');
  lines.push('## Scenarios');
  lines.push('');
  lines.push('Probe decisions only. Anchor rows in the same scenario are introductions and stay out of these rates.');
  lines.push('');
  lines.push('| Scenario | Probes | Introductions | TP | FP | FN | TN | Reviews | Replays | Import errors | Precision | Recall |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|');
  for (const scenario of metrics.by_scenario) {
    lines.push(`| ${scenario.scenario_id} | ${scenario.probes} | ${scenario.introductions} | ${scenario.true_positives} | ${scenario.false_matches} | ${scenario.missed_matches} | ${scenario.true_negatives} | ${scenario.reviews} | ${scenario.replays} | ${scenario.import_errors} | ${showFraction(scenario.precision)} | ${showFraction(scenario.recall)} |`);
  }
  lines.push('');
  const classCountGap = CLASSES.filter((name) => overall.counts[name] !== overall.person_key_counts[name]);
  if (classCountGap.length === 0) {
    lines.push('In this file, every class has the same pair count and person-key count. A person key is not split across two rows of one class.');
  } else {
    lines.push(`Pair count and person-key count differ for: ${classCountGap.join(', ')}.`);
  }
  lines.push('');
  lines.push('## Policy conformance');
  lines.push('');
  lines.push(`Policy-expected outcome matched the engine outcome on ${metrics.policy_conformance.matches} of ${metrics.policy_conformance.rows} rows. Mismatches: ${metrics.policy_conformance.mismatches.length}.`);
  lines.push('');
  lines.push('This table is not an identity result. A matching policy can still auto-merge two different people, or store one person as two.');
  lines.push('');
  lines.push('| Identity class | Policy-expected counts |');
  lines.push('|---|---|');
  for (const name of CLASSES) {
    const policies = metrics.policy_conformance.by_identity_class[name];
    if (!policies) continue;
    lines.push(`| ${name} | ${JSON.stringify(policies)} |`);
  }
  lines.push('');
  lines.push('## Examples');
  lines.push('');
  lines.push('Each example is the earliest row in file order for that rule.');
  lines.push('');
  for (const example of metrics.examples) {
    lines.push(`### ${example.title}`);
    lines.push('');
    lines.push(`Row ${example.row}, set ${example.set}, scenario ${example.scenario_id}, group ${example.case_group}, case ${example.case_id}.`);
    lines.push('');
    lines.push(`- Identity truth: ${example.identity_truth}.`);
    lines.push(`- Policy-expected: ${example.policy_expected}.`);
    lines.push(`- Engine outcome: ${example.engine_outcome}, path ${example.path}, score ${example.score}.`);
    lines.push(`- Class: ${example.identity_class}. Linked to the anchor: ${example.linked_to_anchor}. Indistinguishable: ${example.indistinguishable}.`);
    if (example.skip_reason) lines.push(`- Skip reason: ${example.skip_reason}.`);
    if (example.error) lines.push(`- Import error: ${example.error}.`);
    if (example.explanation) lines.push(`- Trace explanation: ${example.explanation}.`);
    lines.push(`- Label note: ${example.notes}`);
    lines.push('');
  }
  lines.push('## Limitations');
  lines.push('');
  lines.push('The rows are a designed synthetic set. A rate here is not a rate for a live fan file, and it is not a measurement of any real customer.');
  lines.push('');
  lines.push('Small scenarios are behavior checks. The ratio is the count over the denominator in that row.');
  lines.push('');
  lines.push('Reviews were not confirmed or rejected. Precision and recall describe automatic associations only. Found rate divides true positives plus same-person reviews by all same-person probes.');
  lines.push('');
  lines.push(`Set B was designed to produce the ${setB.false_matches + setB.missed_matches} observed identity errors: ${setB.false_matches} distinct-person probes expected to auto-merge and ${setB.missed_matches} same-person probes expected to be stored as new. Those ${setB.false_matches + setB.missed_matches} rows are the entire error count, and Set B has ${setB.true_negatives} true negatives. Its purpose is to expose policy weaknesses under adversarial conditions. It does not represent a real-world data distribution and must not be presented as a real-world accuracy estimate.`);
  lines.push('');
  lines.push('The 60-scenario benchmark is a different population. Its precision is not a baseline for this file.');
  lines.push('');
  const mb3 = metrics.by_scenario.find((item) => item.scenario_id === 'MB-3');
  const mb4 = metrics.by_scenario.find((item) => item.scenario_id === 'MB-4');
  const ca4 = metrics.by_scenario.find((item) => item.scenario_id === 'CA-4');
  if (mb3 && mb4) {
    lines.push(`MB-3 probes are classed as ${mb3.false_matches} false matches. MB-4 probes are classed as ${mb4.true_positives} true positives. The dataset spec says those two scenarios share the columns an import can see and carry opposite identity truth. This report does not re-check the CSV, and it does not drop the MB-3 rows out of the false-match count.`);
    lines.push('');
  }
  if (ca4) {
    lines.push(`CA-4 has ${ca4.indistinguishable_probes} probes marked indistinguishable and ${ca4.false_matches} false matches. The flag stays a description. The false matches stay in the count.`);
    lines.push('');
  }
  const sizeThree = metrics.population.person_key_sizes['3'] || 0;
  lines.push(`${sizeThree} person keys have three rows. ${metrics.population.person_keys_with_three_rows_and_a_replay} of those keys include a replay. The metrics stay pairwise, so a replay is not scored as the resolution of another probe for that person.`);
  lines.push('');
  lines.push('## Reproduce');
  lines.push('');
  lines.push('```');
  lines.push('node scripts/buildSyntheticDemoCsv.js --labels');
  lines.push('node eval/syntheticMetrics.js');
  lines.push('```');
  lines.push('');
  lines.push('The second command checks the three dataset hashes and the committed import-results hash, then writes `eval/reports/synthetic-360-metrics.json` and this file. It does not need a database.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function joinRows(labels, importRows) {
  if (!Array.isArray(labels) || labels.length !== 360) fail(`expected 360 labels, found ${labels && labels.length}`);
  if (!Array.isArray(importRows) || importRows.length !== 360) {
    fail(`expected 360 import rows, found ${importRows && importRows.length}`);
  }
  const byRow = new Map(importRows.map((row) => [row.row, row]));
  return labels.map((label) => {
    const imported = byRow.get(label.row);
    if (!imported) fail(`no import result for row ${label.row}`);
    for (const key of COMPARED_FIELDS) {
      if (label[key] !== imported[key]) {
        fail(`row ${label.row} ${key} differs: label ${label[key]} import ${imported[key]}`);
      }
    }
    return {
      row: label.row,
      set: label.set,
      scenario_id: label.scenario_id,
      case_group: label.case_group,
      case_id: label.case_id,
      role: label.role,
      person_key: label.person_key,
      anchor_row: label.anchor_row,
      identity_truth: label.identity_truth,
      indistinguishable: label.indistinguishable === true,
      policy_expected: label.policy_expected,
      expected_path: label.expected_path,
      flag: label.flag,
      notes: label.notes,
      engine_outcome: imported.engine_outcome,
      path: imported.path,
      score: imported.score,
      scoring_status: imported.scoring_status,
      skip_reason: imported.skip_reason,
      signals: imported.signals || [],
      matched_row: imported.matched_row,
      matched_person_key: imported.matched_person_key,
      error: imported.error,
      import_status: imported.import_status,
      replayed: imported.replayed === true,
      resolver_called: imported.resolver_called === true,
      fan_id_present: imported.fan_id != null && imported.fan_id !== '',
      explanation: imported.explanation,
    };
  });
}

function verifyHashes(files) {
  const hashes = {
    label_sha256: sha256(files.labelBytes),
    set_a_csv_sha256: sha256(files.setABytes),
    set_b_csv_sha256: sha256(files.setBBytes),
    import_results_sha256: sha256(files.importBytes),
  };
  const mismatches = [];
  for (const key of Object.keys(EXPECTED)) {
    if (hashes[key] !== EXPECTED[key]) mismatches.push(`${key}: ${hashes[key]}`);
  }
  if (files.manifest) {
    for (const key of ['label_sha256', 'set_a_csv_sha256', 'set_b_csv_sha256']) {
      if (files.manifest[key] !== EXPECTED[key]) mismatches.push(`manifest ${key}: ${files.manifest[key]}`);
    }
  }
  if (files.importDocument && files.importDocument.label_sha256 !== EXPECTED.label_sha256) {
    mismatches.push(`import results label_sha256: ${files.importDocument.label_sha256}`);
  }
  if (mismatches.length > 0) fail(`dataset hashes do not match.\n${mismatches.join('\n')}`);
  return {
    ...hashes,
    import_results_label_sha256: files.importDocument ? files.importDocument.label_sha256 : null,
    manifest_matches: true,
  };
}

function readInputs() {
  const labelBytes = fs.readFileSync(LABEL_PATH);
  const setABytes = fs.readFileSync(SET_A_PATH);
  const setBBytes = fs.readFileSync(SET_B_PATH);
  const importBytes = fs.readFileSync(IMPORT_PATH);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const importDocument = JSON.parse(importBytes.toString('utf8'));
  const attestation = verifyHashes({
    labelBytes,
    setABytes,
    setBBytes,
    importBytes,
    manifest,
    importDocument,
  });
  const labels = JSON.parse(labelBytes.toString('utf8')).labels;
  const joined = joinRows(labels, importDocument.rows);
  return { joined, attestation };
}

function main() {
  const { joined, attestation } = readInputs();
  const metrics = evaluate(joined, attestation);
  const json = `${JSON.stringify(metrics, null, 2)}\n`;
  const report = formatReport(metrics);
  const generatedId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  if (generatedId.test(JSON.stringify(metrics.rows)) || generatedId.test(JSON.stringify(metrics.examples))) {
    fail('metrics output contains a generated id');
  }
  fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true });
  fs.writeFileSync(JSON_PATH, json);
  fs.writeFileSync(REPORT_PATH, report);
  console.log(`wrote ${JSON_PATH}`);
  console.log(`wrote ${REPORT_PATH}`);
  console.log(`set A precision ${showFraction(metrics.by_set.A.precision)}`);
  console.log(`set A recall ${showFraction(metrics.by_set.A.recall)}`);
  console.log(`set B precision ${showFraction(metrics.by_set.B.precision)}`);
  console.log(`set B recall ${showFraction(metrics.by_set.B.recall)}`);
  console.log(`pooled precision ${showFraction(metrics.overall.precision)}`);
  console.log(`pooled recall ${showFraction(metrics.overall.recall)}`);
  console.log(`false matches ${metrics.overall.false_matches}`);
  console.log(`missed matches ${metrics.overall.missed_matches}`);
  console.log(`reviews ${metrics.reviews.total} / eligible ${metrics.reviews.eligible}`);
  console.log(`import errors ${metrics.import_errors.rows}`);
  console.log(`replays ${metrics.replays.rows}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(err && err.code === 'METRIC_STOP' ? 2 : 1);
  }
}

module.exports = {
  EXPECTED,
  POLICY_OUTCOME,
  classify,
  evaluate,
  formatReport,
  joinRows,
  verifyHashes,
  showFraction,
  fraction,
};
