'use strict';

const scenarios = require('../eval/fixtures/scenarios.json');
const harness = require('../eval/harness');

function row(rows, id) {
  return rows.find((item) => item.scenario_id === id);
}

describe('labeled scenario fixture', () => {
  const rows = harness.replayScenarios(scenarios);
  const card = harness.summarizeScorecard(rows);
  const blocking = harness.summarizeBlocking(rows);

  test('exact email is a hard match and stays out of precision', () => {
    const exact = row(rows, 'exact-email');
    expect(exact.skipped).toBe(true);
    expect(exact.skip_reason).toBe('trace_not_scored');
    expect(card.precision).toBe(1);
    expect(card.false_alarm).toBe(0);
  });

  test('nickname, spelling, missing email, and a different email open a review', () => {
    expect(row(rows, 'nickname-same-birthday').replayed_path).toBe('D');
    expect(row(rows, 'close-spelling').replayed_path).toBe('D');
    expect(row(rows, 'missing-email').replayed_path).toBe('D');
    expect(row(rows, 'different-email-same-name-birthday').replayed_path).toBe('D');
    expect(row(rows, 'messy-casing-and-date').replayed_path).toBe('C');
    expect(card.found).toBe(5);
  });

  test('a different birthday, a shared ZIP, and a missing birthday stay separated', () => {
    expect(row(rows, 'same-last-name-different-birthday').dob_veto).toBe(true);
    expect(row(rows, 'conflicting-birthdays').dob_veto).toBe(true);
    expect(row(rows, 'shared-zip-only').replayed_path).toBe('B');
    expect(row(rows, 'missing-birthday').replayed_path).toBe('B');
    expect(card.correct_separation).toBe(5);
    expect(card.silent_miss).toBe(1);
    expect(card.recall).toBeCloseTo(5 / 6);
  });

  test('phone and a shared family email are not scoring signals', () => {
    const phone = row(rows, 'same-phone');
    const family = row(rows, 'shared-family-email');
    expect(phone.known_non_signal).toBe('phone');
    expect(phone.gate_status).toBe('gated');
    expect(phone.signals_matched).toBeNull();
    expect(family.known_non_signal).toBe('family_email');
    expect(family.signals_matched).toEqual([]);
    expect(JSON.stringify(family.signals_matched)).not.toContain('guardian_email');
  });

  test('a block that never retrieved a labeled match is a blocking miss', () => {
    expect(row(rows, 'blocking-no-key').block_outcome).toBe('no_block_key');
    expect(row(rows, 'blocking-empty').block_outcome).toBe('empty_block');
    expect(row(rows, 'blocking-oversize').block_outcome).toBe('block_dropped_oversize');
    expect(blocking).toEqual({ blocking_miss: 3, scoring_miss: 1 });
    expect(card.silent_miss).toBe(1);
  });

  test('replay timing counts pairs and does not search a fan table', () => {
    const timed = harness.timeReplay(scenarios);
    expect(timed.map((item) => item.pairs)).toEqual([100, 1000, 5000]);
    for (const item of timed) {
      expect(item.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });
});
