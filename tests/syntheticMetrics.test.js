'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  EXPECTED,
  POLICY_OUTCOME,
  classify,
  evaluate,
  joinRows,
} = require('../eval/syntheticMetrics');
const { buildDataset, buildExtension, csvText } = require('../scripts/syntheticDataset');

const ROOT = path.join(__dirname, '..');
const LABELS = path.join(ROOT, 'demo', 'synthetic-ground-truth-v2.json');
const RESULTS = path.join(ROOT, 'eval', 'reports', 'synthetic-360-import-results.json');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function probe(overrides) {
  return {
    row: 10,
    set: 'B',
    scenario_id: 'FIXTURE',
    case_group: 'fixture',
    case_id: 'FIXTURE-01',
    role: 'probe',
    person_key: 'person',
    anchor_row: 2,
    identity_truth: 'same_person',
    indistinguishable: false,
    policy_expected: 'separate',
    expected_path: 'B',
    flag: null,
    notes: 'fixture',
    engine_outcome: 'new',
    path: 'B',
    score: null,
    scoring_status: 'skipped',
    skip_reason: 'empty_block',
    signals: [],
    matched_row: null,
    matched_person_key: null,
    error: null,
    import_status: 'complete',
    replayed: false,
    resolver_called: true,
    fan_id_present: true,
    explanation: null,
    ...overrides,
  };
}

describe('synthetic identity metrics', () => {
  test('classifies from identity truth and engine outcome', () => {
    expect(classify(probe({
      identity_truth: 'same_person',
      engine_outcome: 'auto_merge',
      path: 'A',
      matched_row: 2,
      matched_person_key: 'person',
      policy_expected: 'separate',
      expected_path: 'B',
    }))).toBe('true_positive');

    expect(classify(probe({
      identity_truth: 'distinct_person',
      person_key: 'other',
      engine_outcome: 'auto_merge',
      path: 'A',
      matched_row: 2,
      matched_person_key: 'anchor-person',
      policy_expected: 'hard_match',
      expected_path: 'A',
    }))).toBe('false_positive');

    expect(classify(probe({
      identity_truth: 'same_person',
      engine_outcome: 'auto_merge',
      path: 'A',
      matched_row: 9,
      matched_person_key: 'someone-else',
    }))).toBe('false_positive_wrong_fan');

    expect(classify(probe({
      identity_truth: 'same_person',
      engine_outcome: 'new',
      path: 'B',
      policy_expected: 'review',
      expected_path: 'D',
    }))).toBe('false_negative');

    expect(classify(probe({
      identity_truth: 'distinct_person',
      person_key: 'other',
      engine_outcome: 'new',
      path: 'B',
    }))).toBe('true_negative');

    expect(classify(probe({
      identity_truth: 'same_person',
      engine_outcome: 'review',
      path: 'D',
      matched_row: 2,
      matched_person_key: 'person',
      policy_expected: 'hard_match',
      expected_path: 'A',
    }))).toBe('review_same_person');

    expect(classify(probe({
      identity_truth: 'distinct_person',
      person_key: 'other',
      engine_outcome: 'review',
      path: 'D',
      matched_row: 2,
      matched_person_key: 'anchor-person',
    }))).toBe('review_distinct_person');

    expect(classify(probe({
      identity_truth: 'same_person',
      engine_outcome: 'replay',
      path: 'B',
      replayed: true,
      resolver_called: false,
      matched_row: 2,
      matched_person_key: 'person',
      policy_expected: 'hard_match',
      expected_path: 'A',
    }))).toBe('replay');

    expect(classify(probe({
      identity_truth: 'same_person',
      engine_outcome: 'import_error',
      path: 'D',
      import_status: 'error',
      error: 'row could not be stored',
      matched_row: 2,
      matched_person_key: 'person',
      policy_expected: 'review',
      expected_path: 'D',
    }))).toBe('import_error');

    expect(classify(probe({
      role: 'anchor',
      identity_truth: 'first_seen',
      anchor_row: null,
      engine_outcome: 'new',
      path: 'B',
    }))).toBe('introduction');
  });

  test('keeps reviews, replays, and import errors out of precision and recall', () => {
    const rows = [
      probe({ row: 1, role: 'anchor', identity_truth: 'first_seen', anchor_row: null, person_key: 'p', engine_outcome: 'new', path: 'B' }),
      probe({
        row: 2,
        identity_truth: 'same_person',
        engine_outcome: 'auto_merge',
        path: 'A',
        anchor_row: 1,
        matched_row: 1,
        matched_person_key: 'p',
        person_key: 'p',
      }),
      probe({
        row: 3,
        identity_truth: 'distinct_person',
        person_key: 'q',
        engine_outcome: 'auto_merge',
        path: 'A',
        anchor_row: 1,
        matched_row: 1,
        matched_person_key: 'p',
        policy_expected: 'hard_match',
        expected_path: 'A',
      }),
      probe({
        row: 4,
        identity_truth: 'same_person',
        person_key: 'p',
        engine_outcome: 'review',
        path: 'D',
        anchor_row: 1,
        matched_row: 1,
        matched_person_key: 'p',
      }),
      probe({
        row: 5,
        identity_truth: 'same_person',
        person_key: 'p',
        engine_outcome: 'new',
        path: 'B',
        anchor_row: 1,
      }),
      probe({
        row: 6,
        identity_truth: 'distinct_person',
        person_key: 'r',
        engine_outcome: 'new',
        path: 'B',
        anchor_row: 1,
      }),
      probe({
        row: 7,
        identity_truth: 'same_person',
        person_key: 'p',
        engine_outcome: 'replay',
        path: 'B',
        replayed: true,
        resolver_called: false,
        anchor_row: 1,
        matched_row: 1,
        matched_person_key: 'p',
      }),
      probe({
        row: 8,
        identity_truth: 'same_person',
        person_key: 'p',
        engine_outcome: 'import_error',
        path: 'D',
        import_status: 'error',
        anchor_row: 1,
        matched_row: 1,
        matched_person_key: 'p',
      }),
    ];
    const metrics = evaluate(rows, null);
    expect(metrics.overall.precision).toMatchObject({ numerator: 1, denominator: 2 });
    expect(metrics.overall.recall).toMatchObject({ numerator: 1, denominator: 2 });
    expect(metrics.overall.false_matches).toBe(1);
    expect(metrics.overall.missed_matches).toBe(1);
    expect(metrics.overall.reviews).toBe(1);
    expect(metrics.overall.replays).toBe(1);
    expect(metrics.overall.import_errors).toBe(1);
    expect(metrics.overall.found_rate).toMatchObject({ numerator: 2, denominator: 3 });
    expect(metrics.reviews.total).toBe(1);
    expect(metrics.reviews.eligible).toBe(5);
    expect(metrics.new_records.engine_outcome_new).toBe(3);
    expect(metrics.new_records.introductions).toBe(1);
    expect(metrics.rows.find((row) => row.row === 4).in_recall_denominator).toBe(false);
    expect(metrics.rows.find((row) => row.row === 7).in_precision_denominator).toBe(false);
    expect(metrics.rows.find((row) => row.row === 8).in_review_volume).toBe(false);
  });

  test('measures the committed 360-row import without using policy as identity', () => {
    const labelBytes = fs.readFileSync(LABELS);
    const importBytes = fs.readFileSync(RESULTS);
    expect(sha256(labelBytes)).toBe(EXPECTED.label_sha256);
    expect(sha256(importBytes)).toBe(EXPECTED.import_results_sha256);
    expect(sha256(csvText(buildDataset().rows))).toBe(EXPECTED.set_a_csv_sha256);
    expect(sha256(csvText(buildExtension().rows))).toBe(EXPECTED.set_b_csv_sha256);

    const labelDoc = JSON.parse(labelBytes.toString('utf8'));
    const importDoc = JSON.parse(importBytes.toString('utf8'));
    expect(importDoc.label_sha256).toBe(EXPECTED.label_sha256);
    expect(POLICY_OUTCOME).toEqual({
      hard_match: 'auto_merge',
      review: 'review',
      separate: 'new',
      import_replay: 'replay',
      import_error: 'import_error',
    });

    const metrics = evaluate(joinRows(labelDoc.labels, importDoc.rows), {
      label_sha256: EXPECTED.label_sha256,
      set_a_csv_sha256: EXPECTED.set_a_csv_sha256,
      set_b_csv_sha256: EXPECTED.set_b_csv_sha256,
      import_results_sha256: EXPECTED.import_results_sha256,
      import_results_label_sha256: importDoc.label_sha256,
    });

    expect(metrics.population.rows).toBe(360);
    expect(metrics.population.probes).toBe(200);
    expect(metrics.population.introductions).toBe(160);
    expect(metrics.population.same_person_probes).toBe(99);
    expect(metrics.population.distinct_person_probes).toBe(101);
    expect(metrics.by_set.A.precision).toMatchObject({ numerator: 15, denominator: 15, value: 1 });
    expect(metrics.by_set.A.recall).toMatchObject({ numerator: 15, denominator: 15, value: 1 });
    expect(metrics.by_set.B.precision).toMatchObject({ numerator: 13, denominator: 32 });
    expect(metrics.by_set.B.recall).toMatchObject({ numerator: 13, denominator: 26 });
    expect(metrics.overall.precision).toMatchObject({ numerator: 28, denominator: 47 });
    expect(metrics.overall.recall).toMatchObject({ numerator: 28, denominator: 41 });
    expect(metrics.overall.false_matches).toBe(19);
    expect(metrics.overall.missed_matches).toBe(13);
    expect(metrics.overall.true_negatives).toBe(60);
    expect(metrics.reviews.total).toBe(65);
    expect(metrics.reviews.eligible).toBe(185);
    expect(metrics.reviews.same_person_linked_to_anchor).toBe(49);
    expect(metrics.reviews.distinct_person_linked_to_anchor).toBe(16);
    expect(metrics.reviews.marked_indistinguishable).toBe(0);
    expect(metrics.replays.rows).toBe(5);
    expect(metrics.replays.resolver_called).toBe(0);
    expect(metrics.import_errors.rows).toBe(10);
    expect(metrics.policy_conformance.mismatches).toEqual([]);
    expect(metrics.new_records.engine_outcome_new).toBe(233);
    expect(metrics.new_records.introductions).toBe(160);

    const text = JSON.stringify(metrics);
    expect(text).not.toContain(importDoc.org_id);
    expect(text).not.toContain(importDoc.batch_id);
    for (const row of metrics.rows) {
      if (row.identity_truth === 'distinct_person' && row.engine_outcome === 'auto_merge') {
        expect(row.identity_class).toBe('false_positive');
      }
      if (row.engine_outcome === 'replay') {
        expect(row.in_precision_numerator).toBe(false);
        expect(row.in_recall_numerator).toBe(false);
      }
      if (row.engine_outcome === 'review') expect(row.in_recall_denominator).toBe(false);
      if (row.engine_outcome === 'import_error') {
        expect(row.identity_class).toBe('import_error');
        expect(row.in_review_volume).toBe(false);
      }
    }
  });
});
