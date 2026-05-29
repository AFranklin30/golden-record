'use strict';

const { scoreMatch } = require('../../src/modules/probabilisticMatcher');
const { NormalizationError } = require('../../src/modules/normalizer');

const ORG_ID       = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_ORG_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

// Day-based helper avoids calendar-month boundary issues (e.g. Mar 31 - 6mo = Oct 1)
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// Default last_seen_at is 10 days ago — safely inside ≤ 6 months → recency 1.0
// Tests that need a specific recency bucket override via candidate overrides
const RECENT = daysAgo(10);

function makeCandidate(overrides = {}) {
  return {
    id:                          'cccccccc-0000-0000-0000-000000000003',
    org_id:                      ORG_ID,
    email:                       null,
    email_last_seen_at:          RECENT,
    name:                        null,
    name_last_seen_at:           RECENT,
    dob:                         null,
    dob_last_seen_at:            RECENT,
    zip:                         null,
    zip_last_seen_at:            RECENT,
    device_id:                   null,
    device_last_seen_at:         RECENT,
    guardian_email:              null,
    guardian_email_last_seen_at: RECENT,
    ...overrides,
  };
}

function makeInbound(overrides = {}) {
  return {
    org_id:         ORG_ID,
    email:          null,
    name:           null,
    dob:            null,
    zip:            null,
    device_id:      null,
    guardian_email: null,
    ...overrides,
  };
}

describe('probabilisticMatcher — scoreMatch', () => {

  // ───────── guards ─────────

  test('throws NormalizationError when candidateRecord is null', () => {
    expect(() => scoreMatch(null, makeInbound())).toThrow(NormalizationError);
  });

  test('throws NormalizationError when inboundIdentifiers is null', () => {
    expect(() => scoreMatch(makeCandidate(), null)).toThrow(NormalizationError);
  });

  test('throws NormalizationError when org_id mismatch', () => {
    expect(() =>
      scoreMatch(
        makeCandidate({ org_id: OTHER_ORG_ID }),
        makeInbound({  org_id: ORG_ID })
      )
    ).toThrow(NormalizationError);
  });

  // ───────── baseline ─────────

  test('returns score 0.0 and empty signals_matched when all inbound fields are null', () => {
    const result = scoreMatch(makeCandidate(), makeInbound());
    expect(result.score).toBe(0);
    expect(result.signals_matched).toHaveLength(0);
  });

  // ───────── getRecencyMultiplier — tested via email_similarity signal ─────────
  //
  // 30.44 days/month → bucket boundaries in days:
  //   ≤ 6 months:  ≤ 182.64 days  — use 180 days
  //   ≤ 12 months: ≤ 365.28 days  — use 335 days (safely > 6mo, ≤ 12mo)
  //   ≤ 24 months: ≤ 730.56 days  — use 500 days (safely > 12mo, ≤ 24mo)
  //   > 24 months:                — use 760 days

  test('null last_seen_at returns recency 0.5 — adjusted score is raw_score * 0.5', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com', email_last_seen_at: null }),
      makeInbound({  email: 'fan@example.com' })
    );
    const sig = result.signals_matched.find(s => s.signal === 'email_similarity');
    expect(sig.recency_multiplier).toBe(0.5);
    expect(sig.adjusted_score).toBeCloseTo(0.35, 5);
    expect(result.score).toBeCloseTo(0.35, 5);
  });

  test('0 days ago returns recency 1.0', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com', email_last_seen_at: daysAgo(0) }),
      makeInbound({  email: 'fan@example.com' })
    );
    const sig = result.signals_matched.find(s => s.signal === 'email_similarity');
    expect(sig.recency_multiplier).toBe(1.0);
    expect(sig.adjusted_score).toBeCloseTo(0.7, 5);
  });

  test('180 days ago (≤ 6 months) returns recency 1.0', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com', email_last_seen_at: daysAgo(180) }),
      makeInbound({  email: 'fan@example.com' })
    );
    const sig = result.signals_matched.find(s => s.signal === 'email_similarity');
    expect(sig.recency_multiplier).toBe(1.0);
  });

  test('335 days ago (> 6 months, ≤ 12 months) returns recency 0.8 — adjusted score raw * 0.8', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com', email_last_seen_at: daysAgo(335) }),
      makeInbound({  email: 'fan@example.com' })
    );
    const sig = result.signals_matched.find(s => s.signal === 'email_similarity');
    expect(sig.recency_multiplier).toBe(0.8);
    expect(sig.adjusted_score).toBeCloseTo(0.56, 5);
    expect(result.score).toBeCloseTo(0.56, 5);
  });

  test('500 days ago (> 12 months, ≤ 24 months) returns recency 0.5', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com', email_last_seen_at: daysAgo(500) }),
      makeInbound({  email: 'fan@example.com' })
    );
    const sig = result.signals_matched.find(s => s.signal === 'email_similarity');
    expect(sig.recency_multiplier).toBe(0.5);
    expect(sig.adjusted_score).toBeCloseTo(0.35, 5);
  });

  test('760 days ago (> 24 months) returns recency 0.2 — adjusted score raw * 0.2', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com', email_last_seen_at: daysAgo(760) }),
      makeInbound({  email: 'fan@example.com' })
    );
    const sig = result.signals_matched.find(s => s.signal === 'email_similarity');
    expect(sig.recency_multiplier).toBe(0.2);
    expect(sig.adjusted_score).toBeCloseTo(0.14, 5);
    expect(result.score).toBeCloseTo(0.14, 5);
  });

  // ───────── Signal 1 — email_similarity ─────────

  test('email_similarity fires when levenshtein similarity >= 0.8', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com' }),
      makeInbound({  email: 'fan@example.com' })
    );
    expect(result.score).toBeCloseTo(0.7, 5);
    const sig = result.signals_matched.find(s => s.signal === 'email_similarity');
    expect(sig).toBeDefined();
    expect(sig.raw_score).toBe(0.7);
    expect(sig.recency_multiplier).toBe(1.0);
    expect(sig.adjusted_score).toBeCloseTo(0.7, 5);
    expect(sig.similarity).toBe(1.0);
  });

  test('email_similarity does not fire when levenshtein similarity < 0.8', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'aaaa@aaaa.com' }),
      makeInbound({  email: 'zzzz@zzzz.com' })
    );
    expect(result.signals_matched.some(s => s.signal === 'email_similarity')).toBe(false);
    expect(result.score).toBe(0);
  });

  test('email_similarity signals_matched entry includes similarity field', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com' }),
      makeInbound({  email: 'fan@example.com' })
    );
    const sig = result.signals_matched.find(s => s.signal === 'email_similarity');
    expect(sig).toBeDefined();
    expect(sig.similarity).toBeDefined();
    expect(typeof sig.similarity).toBe('number');
  });

  // ───────── Signal 2 — name_plus_dob ─────────

  test('name_plus_dob fires when both name and dob match', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'John Smith', dob: '1990-01-15' }),
      makeInbound({  name: 'John Smith', dob: '1990-01-15' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_plus_dob')).toBe(true);
    expect(result.score).toBeCloseTo(0.7, 5);
  });

  test('name_plus_dob does not fire when name matches but dob differs', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'John Smith', dob: '1990-01-15' }),
      makeInbound({  name: 'John Smith', dob: '1985-06-20' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_plus_dob')).toBe(false);
  });

  test('name_plus_dob does not fire when dob matches but name differs', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'John Smith', dob: '1990-01-15' }),
      makeInbound({  name: 'Jane Doe',   dob: '1990-01-15' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_plus_dob')).toBe(false);
  });

  // ───────── Signal 3 — name_plus_zip ─────────

  test('name_plus_zip fires when both name and zip match', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'Jane Doe', zip: '73102' }),
      makeInbound({  name: 'Jane Doe', zip: '73102' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_plus_zip')).toBe(true);
    expect(result.score).toBeCloseTo(0.6, 5);
  });

  test('name_plus_zip does not fire when only name matches', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'Jane Doe', zip: '73102' }),
      makeInbound({  name: 'Jane Doe', zip: '90210' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_plus_zip')).toBe(false);
  });

  // ───────── Signal 4 — guardian_email ─────────

  test('guardian_email fires on exact match', () => {
    const result = scoreMatch(
      makeCandidate({ guardian_email: 'parent@example.com' }),
      makeInbound({  guardian_email: 'parent@example.com' })
    );
    expect(result.signals_matched.some(s => s.signal === 'guardian_email')).toBe(true);
    expect(result.score).toBeCloseTo(0.65, 5);
  });

  test('guardian_email does not fire on similar but not identical email', () => {
    const result = scoreMatch(
      makeCandidate({ guardian_email: 'parent@example.com' }),
      makeInbound({  guardian_email: 'parent@example.org' })
    );
    expect(result.signals_matched.some(s => s.signal === 'guardian_email')).toBe(false);
  });

  test('guardian_email signals_matched entry has correct shape — no similarity field', () => {
    const result = scoreMatch(
      makeCandidate({ guardian_email: 'parent@example.com' }),
      makeInbound({  guardian_email: 'parent@example.com' })
    );
    const sig = result.signals_matched.find(s => s.signal === 'guardian_email');
    expect(sig).toBeDefined();
    expect(sig.raw_score).toBe(0.65);
    expect(sig.recency_multiplier).toBe(1.0);
    expect(sig.adjusted_score).toBeCloseTo(0.65, 5);
    expect(sig.similarity).toBeUndefined();
  });

  // ───────── Signal 5 — device_id ─────────

  test('device_id fires on exact match', () => {
    const result = scoreMatch(
      makeCandidate({ device_id: 'device-abc-123' }),
      makeInbound({  device_id: 'device-abc-123' })
    );
    expect(result.signals_matched.some(s => s.signal === 'device_id')).toBe(true);
    expect(result.score).toBeCloseTo(0.5, 5);
  });

  test('device_id does not fire when device IDs differ', () => {
    const result = scoreMatch(
      makeCandidate({ device_id: 'device-abc-111' }),
      makeInbound({  device_id: 'device-abc-999' })
    );
    expect(result.signals_matched.some(s => s.signal === 'device_id')).toBe(false);
  });

  // ───────── Signal 6 — name_alone ─────────

  test('name_alone fires when name matches even when dob and zip are null', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'Alice Thunder' }),
      makeInbound({  name: 'Alice Thunder' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(true);
    expect(result.score).toBeCloseTo(0.3, 5);
  });

  test('name_alone does not fire on partial name match', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'Alice Thunder' }),
      makeInbound({  name: 'Alice' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(false);
  });

  // ───────── MAX wins, not additive ─────────

  test('score is MAX of signals — not additive', () => {
    // email_similarity adjusted 0.7, name_alone adjusted 0.3 → MAX = 0.7, not 1.0
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com', name: 'Alice Thunder' }),
      makeInbound({  email: 'fan@example.com', name: 'Alice Thunder' })
    );
    expect(result.score).toBeCloseTo(0.7, 5);
    expect(result.score).not.toBeCloseTo(1.0, 1);
    expect(result.signals_matched.some(s => s.signal === 'email_similarity')).toBe(true);
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(true);
  });

  // ───────── signals_matched entry shape ─────────

  test('signals_matched entries use new shape (raw_score, recency_multiplier, adjusted_score)', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'Alice Thunder' }),
      makeInbound({  name: 'Alice Thunder' })
    );
    const sig = result.signals_matched.find(s => s.signal === 'name_alone');
    expect(sig).toBeDefined();
    expect(sig.raw_score).toBe(0.3);
    expect(typeof sig.recency_multiplier).toBe('number');
    expect(typeof sig.adjusted_score).toBe('number');
    expect(sig.adjusted_score).toBeCloseTo(sig.raw_score * sig.recency_multiplier, 10);
  });

  // ───────── name normalization ─────────

  test('name matching is case insensitive', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'JOHN DOE' }),
      makeInbound({  name: 'john doe' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(true);
  });

  test('name matching handles leading and trailing whitespace', () => {
    const result = scoreMatch(
      makeCandidate({ name: '  Jane Smith  ' }),
      makeInbound({  name: '  Jane Smith  ' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(true);
  });

  // ───────── levenshtein helpers ─────────

  test('levenshteinSimilarity returns 1.0 for identical email strings', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'identical@test.com' }),
      makeInbound({  email: 'identical@test.com' })
    );
    const sig = result.signals_matched.find(s => s.signal === 'email_similarity');
    expect(sig).toBeDefined();
    expect(sig.similarity).toBe(1.0);
  });

  test('levenshteinSimilarity returns low similarity for completely different strings', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'aaaa@aa.com' }),
      makeInbound({  email: 'zzzz@zz.com' })
    );
    expect(result.signals_matched.some(s => s.signal === 'email_similarity')).toBe(false);
  });

});
