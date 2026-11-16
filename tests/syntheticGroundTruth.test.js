'use strict';

const fs = require('fs');
const path = require('path');
const { buildGroundTruth } = require('../scripts/buildSyntheticDemoCsv');

const FILE = path.join(__dirname, '..', 'demo', 'synthetic-200-ground-truth.json');

describe('synthetic 200-row ground truth', () => {
  test('has one label per row and the bucket counts the builder already uses', () => {
    const committed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const rebuilt = buildGroundTruth();
    expect(rebuilt).toEqual(committed);

    const labels = committed.labels;
    expect(labels).toHaveLength(200);
    expect(labels.map((label) => label.row)).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 1)
    );
    expect(new Set(labels.map((label) => label.row)).size).toBe(200);

    const buckets = {};
    const outcomes = {};
    for (const label of labels) {
      expect(Object.keys(label)).toEqual([
        'row', 'bucket', 'identity', 'person_key', 'same_as_original_row', 'intended_outcome',
      ]);
      buckets[label.bucket] = (buckets[label.bucket] || 0) + 1;
      outcomes[label.intended_outcome] = (outcomes[label.intended_outcome] || 0) + 1;
      expect(['original', 'same_person', 'distinct_person']).toContain(label.identity);
      expect(['hard_match', 'review', 'separate']).toContain(label.intended_outcome);
      if (label.identity === 'same_person') {
        const original = labels[label.same_as_original_row - 1];
        expect(original.identity).toBe('original');
        expect(original.person_key).toBe(label.person_key);
      } else {
        expect(label.same_as_original_row).toBeNull();
      }
    }

    expect(buckets).toEqual({
      original: 80,
      same_email: 5,
      nickname: 10,
      spelling: 10,
      same_name: 20,
      no_email: 15,
      different_birthday: 60,
    });
    expect(committed.buckets).toEqual(buckets);
    expect(outcomes).toEqual({ hard_match: 20, review: 40, separate: 140 });
    expect(committed.outcomes).toEqual(outcomes);

    expect(labels.filter((label) => label.bucket === 'same_email').every((label) => label.intended_outcome === 'hard_match')).toBe(true);
    expect(labels.filter((label) => label.bucket === 'no_email').every((label) => label.intended_outcome === 'hard_match')).toBe(true);
    expect(labels.filter((label) => ['nickname', 'spelling', 'same_name'].includes(label.bucket)).every((label) => label.intended_outcome === 'review')).toBe(true);
    expect(labels.filter((label) => label.bucket === 'different_birthday').every((label) => label.identity === 'distinct_person' && label.intended_outcome === 'separate')).toBe(true);
    expect(labels.filter((label) => label.bucket === 'original').every((label) => label.identity === 'original' && label.intended_outcome === 'separate')).toBe(true);
  });
});
