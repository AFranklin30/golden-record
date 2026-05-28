'use strict';

const { scoreMatch } = require('../../src/modules/probabilisticMatcher');
const { NormalizationError } = require('../../src/modules/normalizer');

const ORG_ID       = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_ORG_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeCandidate(overrides = {}) {
  return {
    id:        'cccccccc-0000-0000-0000-000000000003',
    org_id:    ORG_ID,
    email:     null,
    phone:     null,
    device_id: null,
    name:      null,
    dob:       null,
    zip:       null,
    ...overrides,
  };
}

function makeInbound(overrides = {}) {
  return {
    org_id:    ORG_ID,
    email:     null,
    phone:     null,
    device_id: null,
    name:      null,
    dob:       null,
    zip:       null,
    ...overrides,
  };
}

describe('probabilisticMatcher — scoreMatch', () => {

  // ───────── baseline ─────────

  test('returns 0.0 when all signals are null', () => {
    const result = scoreMatch(makeCandidate(), makeInbound());
    expect(result.score).toBe(0);
    expect(result.signals_matched).toHaveLength(0);
  });

  // ───────── email_similarity ─────────

  test('email_similarity fires when levenshtein similarity >= 0.8', () => {
    // identical strings → similarity 1.0
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com' }),
      makeInbound({  email: 'fan@example.com' })
    );
    expect(result.score).toBe(0.7);
    const sig = result.signals_matched.find(s => s.signal === 'email_similarity');
    expect(sig).toBeDefined();
    expect(sig.similarity).toBe(1.0);
  });

  test('email_similarity does not fire when levenshtein similarity < 0.8', () => {
    // completely different strings — similarity well below 0.8
    const result = scoreMatch(
      makeCandidate({ email: 'aaaa@aaaa.com' }),
      makeInbound({  email: 'zzzz@zzzz.com' })
    );
    expect(result.signals_matched.some(s => s.signal === 'email_similarity')).toBe(false);
    expect(result.score).toBe(0);
  });

  // ───────── name_plus_dob ─────────

  test('name_plus_dob fires when both name and dob match', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'John Smith', dob: '1990-01-15' }),
      makeInbound({  name: 'John Smith', dob: '1990-01-15' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_plus_dob')).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.7);
  });

  test('name_plus_dob does not fire when name matches but dob differs', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'John Smith', dob: '1990-01-15' }),
      makeInbound({  name: 'John Smith', dob: '1985-06-20' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_plus_dob')).toBe(false);
  });

  // ───────── name_plus_zip ─────────

  test('name_plus_zip fires when both name and zip match', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'Jane Doe', zip: '73102' }),
      makeInbound({  name: 'Jane Doe', zip: '73102' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_plus_zip')).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.6);
  });

  // ───────── device_id ─────────

  test('device_id fires on exact match', () => {
    const result = scoreMatch(
      makeCandidate({ device_id: 'device-abc-123' }),
      makeInbound({  device_id: 'device-abc-123' })
    );
    expect(result.signals_matched.some(s => s.signal === 'device_id')).toBe(true);
    expect(result.score).toBe(0.5);
  });

  test('device_id does not fire when device IDs differ', () => {
    const result = scoreMatch(
      makeCandidate({ device_id: 'device-abc-111' }),
      makeInbound({  device_id: 'device-abc-999' })
    );
    expect(result.signals_matched.some(s => s.signal === 'device_id')).toBe(false);
  });

  // ───────── name_alone ─────────

  test('name_alone fires on normalized name match', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'Alice Thunder' }),
      makeInbound({  name: 'Alice Thunder' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(true);
    expect(result.score).toBe(0.3);
  });

  test('name_alone does not fire on partial name match', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'Alice Thunder' }),
      makeInbound({  name: 'Alice' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(false);
  });

  // ───────── MAX wins, not additive ─────────

  test('score is MAX of signals, not their sum', () => {
    // email_similarity = 0.7, name_alone = 0.3 → result must be 0.7, not 1.0
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com', name: 'Alice Thunder' }),
      makeInbound({  email: 'fan@example.com', name: 'Alice Thunder' })
    );
    expect(result.score).toBe(0.7);
    expect(result.score).not.toBe(1.0);
    // both signals fired
    expect(result.signals_matched.some(s => s.signal === 'email_similarity')).toBe(true);
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(true);
  });

  // ───────── guards ─────────

  test('throws NormalizationError when org_id differs between candidate and inbound', () => {
    expect(() =>
      scoreMatch(
        makeCandidate({ org_id: OTHER_ORG_ID }),
        makeInbound({  org_id: ORG_ID })
      )
    ).toThrow(NormalizationError);
  });

  test('throws NormalizationError when candidateRecord is null', () => {
    expect(() => scoreMatch(null, makeInbound())).toThrow(NormalizationError);
  });

  test('throws NormalizationError when inboundIdentifiers is null', () => {
    expect(() => scoreMatch(makeCandidate(), null)).toThrow(NormalizationError);
  });

  // ───────── levenshteinSimilarity helpers ─────────

  test('levenshteinSimilarity returns 1.0 for identical strings', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'identical@test.com' }),
      makeInbound({  email: 'identical@test.com' })
    );
    const sig = result.signals_matched.find(s => s.signal === 'email_similarity');
    expect(sig).toBeDefined();
    expect(sig.similarity).toBe(1.0);
  });

  test('levenshteinSimilarity returns low similarity for completely different strings', () => {
    // "a@a.com" vs "z@z.com" — different enough that signal does not fire
    const result = scoreMatch(
      makeCandidate({ email: 'aaaa@aa.com' }),
      makeInbound({  email: 'zzzz@zz.com' })
    );
    expect(result.signals_matched.some(s => s.signal === 'email_similarity')).toBe(false);
  });

  // ───────── normalizedNameMatch helpers ─────────

  test('normalizedNameMatch handles case differences', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'JOHN DOE' }),
      makeInbound({  name: 'john doe' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(true);
  });

  test('normalizedNameMatch handles leading and trailing whitespace', () => {
    const result = scoreMatch(
      makeCandidate({ name: '  Jane Smith  ' }),
      makeInbound({  name: '  Jane Smith  ' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(true);
  });

});
