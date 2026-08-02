'use strict';

const { scoreMatch, detectConflicts, SIGNAL_CONFIG, getRecencyMultiplier, SCORER_VERSION, computeScorerFingerprint } = require('../../src/modules/probabilisticMatcher');
const { NormalizationError, NORMALIZATION_VERSION } = require('../../src/modules/normalizer');

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

  test('email_similarity fires on exact match', () => {
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

  test('email_similarity does not fire on non-matching email', () => {
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
    // name_plus_dob 0.7 * 1.0 = 0.7. name_alone is suppressed (Sprint 5 prompt 3).
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
    // name_plus_zip 0.6 + name_alone 0.3 = 0.9 (additive)
    const result = scoreMatch(
      makeCandidate({ name: 'Jane Doe', zip: '73102' }),
      makeInbound({  name: 'Jane Doe', zip: '73102' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_plus_zip')).toBe(true);
    expect(result.score).toBeCloseTo(0.9, 5);
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

  test('score is additive — email 0.7 + name_alone 0.3 = 1.0', () => {
    // email_similarity adjusted 0.7 * 1.0 = 0.70
    // name_alone adjusted 0.3 * 1.0 = 0.30 → additive sum 1.0
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com', name: 'Alice Thunder' }),
      makeInbound({  email: 'fan@example.com', name: 'Alice Thunder' })
    );
    expect(result.score).toBeCloseTo(1.0, 5);
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

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 5 prompt 1 — detectConflicts + SIGNAL_CONFIG
// Pure function tests — no DB, no seeding, no cleanup.
// ─────────────────────────────────────────────────────────────────────────────

describe('probabilisticMatcher — detectConflicts + SIGNAL_CONFIG (Sprint 5 prompt 1)', () => {

  // ───────── return contract ─────────

  test('scoreMatch result includes conflicts_detected as an array', () => {
    const result = scoreMatch(makeCandidate(), makeInbound());
    expect(Array.isArray(result.conflicts_detected)).toBe(true);
  });

  // ───────── detection cases 1–6 ─────────

  test('case 1 — dob conflict: both present, differ → one entry field dob', () => {
    const conflicts = detectConflicts(
      makeCandidate({ dob: '1990-01-01' }),
      makeInbound({  dob: '1985-06-20' })
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('dob');
  });

  test('case 2 — email conflict: both present, non-equal → one entry field email', () => {
    const conflicts = detectConflicts(
      makeCandidate({ email: 'old@example.com' }),
      makeInbound({  email: 'new@example.com' })
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('email');
  });

  test('case 3 — zip conflict: both present, non-equal → one entry field zip', () => {
    const conflicts = detectConflicts(
      makeCandidate({ zip: '73102' }),
      makeInbound({  zip: '90210' })
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('zip');
  });

  test('case 4 — name conflict: genuinely different names differ under normalizedNameMatch → one entry field name', () => {
    // 'john smith' vs 'michael jones': levenshtein similarity well below 0.85 → conflict.
    // (Note: 'jon smith' vs 'john smith' now MATCH at 0.9 ≥ 0.85 — see Sprint 5 prompt 4.)
    const conflicts = detectConflicts(
      makeCandidate({ name: 'john smith' }),
      makeInbound({  name: 'michael jones' })
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe('name');
  });

  test('case 5 — absence is not disagreement: inbound dob null, candidate dob present → no dob conflict', () => {
    const conflicts = detectConflicts(
      makeCandidate({ dob: '1990-01-01' }),
      makeInbound({  dob: null })
    );
    expect(conflicts.some(c => c.field === 'dob')).toBe(false);
  });

  test('case 6 — multiple conflicts: dob and zip both differ → length 2, both fields present', () => {
    const conflicts = detectConflicts(
      makeCandidate({ dob: '1990-01-01', zip: '73102' }),
      makeInbound({  dob: '1985-06-20', zip: '90210' })
    );
    expect(conflicts).toHaveLength(2);
    expect(conflicts.map(c => c.field)).toContain('dob');
    expect(conflicts.map(c => c.field)).toContain('zip');
  });

  // ───────── regression cases 7–8 ─────────

  test('case 7 — score unchanged: single email signal scores SIGNAL_CONFIG.agreement.email_similarity * 1.0', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com' }),
      makeInbound({  email: 'fan@example.com' })
    );
    expect(result.score).toBeCloseTo(SIGNAL_CONFIG.agreement.email_similarity * 1.0, 5);
  });

  test('case 8 — signals_matched unchanged: email_similarity entry shape intact after conflicts_detected added to return', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com' }),
      makeInbound({  email: 'fan@example.com' })
    );
    const sig = result.signals_matched.find(s => s.signal === 'email_similarity');
    expect(sig).toBeDefined();
    expect(sig.raw_score).toBe(SIGNAL_CONFIG.agreement.email_similarity);
    expect(sig.recency_multiplier).toBe(1.0);
    expect(sig.adjusted_score).toBeCloseTo(SIGNAL_CONFIG.agreement.email_similarity, 5);
    expect(sig.similarity).toBe(1.0);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 5 prompt 2 — DOB veto (safety invariant)
// Pure function tests — no DB, no seeding, no cleanup.
// ─────────────────────────────────────────────────────────────────────────────

describe('probabilisticMatcher — DOB veto (Sprint 5 prompt 2)', () => {

  // ───────── veto cases ─────────

  test('case 1 — conflicting dob hard-blocks: score 0.0, dob_veto true, signals_matched empty', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'Jane Doe', dob: '1985-11-22' }),
      makeInbound({  name: 'Jane Doe', dob: '1990-03-01' })
    );
    expect(result.score).toBe(0.0);
    expect(result.dob_veto).toBe(true);
    expect(result.signals_matched).toHaveLength(0);
  });

  test('case 2 — veto beats a perfect email: same email but conflicting dob → score 0.0, dob_veto true', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'jane@example.com', dob: '1985-11-22' }),
      makeInbound({  email: 'jane@example.com', dob: '1990-03-01' })
    );
    expect(result.score).toBe(0.0);
    expect(result.dob_veto).toBe(true);
  });

  test('case 3 — veto emits conflicts_detected with exactly one dob entry', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'Jane Doe', dob: '1985-11-22' }),
      makeInbound({  name: 'Jane Doe', dob: '1990-03-01' })
    );
    expect(result.conflicts_detected).toHaveLength(1);
    expect(result.conflicts_detected[0].field).toBe('dob');
    expect(result.conflicts_detected[0].inbound).toBe('1990-03-01');
    expect(result.conflicts_detected[0].candidate).toBe('1985-11-22');
  });

  // ───────── non-veto / regression cases ─────────

  test('case 4 — matching dob does not veto: name_plus_dob fires normally, score > 0, dob_veto absent', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'Jane Doe', dob: '1990-03-01' }),
      makeInbound({  name: 'Jane Doe', dob: '1990-03-01' })
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.signals_matched.some(s => s.signal === 'name_plus_dob')).toBe(true);
    expect(result.dob_veto).toBeFalsy();
  });

  test('case 5 — missing inbound dob does not veto: email fires, score > 0, no veto', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'jane@example.com', dob: '1990-01-01' }),
      makeInbound({  email: 'jane@example.com', dob: null })
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.signals_matched.some(s => s.signal === 'email_similarity')).toBe(true);
    expect(result.dob_veto).toBeFalsy();
  });

  test('case 6 — missing candidate dob does not veto: email fires, score > 0, no veto', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'jane@example.com', dob: null }),
      makeInbound({  email: 'jane@example.com', dob: '1990-01-01' })
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.signals_matched.some(s => s.signal === 'email_similarity')).toBe(true);
    expect(result.dob_veto).toBeFalsy();
  });

  test('case 7 — no dob on either side: email fires as normal, dob_veto absent', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'jane@example.com' }),
      makeInbound({  email: 'jane@example.com' })
    );
    expect(result.score).toBeCloseTo(0.7, 5);
    expect(result.signals_matched.some(s => s.signal === 'email_similarity')).toBe(true);
    expect(result.dob_veto).toBeFalsy();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 5 prompt 3 — penalties live + kill name double-count
// Pure function tests — no DB, no seeding, no cleanup.
// Recency = 1.0 throughout (RECENT = 10 days ago, within ≤ 6 months bucket).
// ─────────────────────────────────────────────────────────────────────────────

describe('probabilisticMatcher — penalties + name double-count (Sprint 5 prompt 3)', () => {

  // ───────── name double-count cases ─────────

  test('case 1 — name_plus_dob suppresses name_alone: signals_matched has exactly one name-based signal', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'jane doe', dob: '1990-03-01' }),
      makeInbound({  name: 'jane doe', dob: '1990-03-01' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_plus_dob')).toBe(true);
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(false);
    const nameSignals = result.signals_matched.filter(s => s.signal.includes('name'));
    expect(nameSignals).toHaveLength(1);
  });

  test('case 2 — name_alone still fires when no dob present (guard does not kill legitimate case)', () => {
    // No dob on either side → name_plus_dob cannot fire → nameCountedInCompositeSignal stays false
    const result = scoreMatch(
      makeCandidate({ name: 'alice thunder', device_id: 'device-abc-x' }),
      makeInbound({  name: 'alice thunder', device_id: 'device-abc-x' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(true);
  });

  test('case 3 — score reflects de-duplication: name_plus_dob 0.7 * 1.0 only, not 0.7 + 0.3', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'jane doe', dob: '1990-03-01' }),
      makeInbound({  name: 'jane doe', dob: '1990-03-01' })
    );
    // 0.7 * recency(1.0) = 0.7. name_alone suppressed — no +0.3.
    expect(result.score).toBeCloseTo(SIGNAL_CONFIG.agreement.name_plus_dob * 1.0, 5);
  });

  // ───────── penalty cases ─────────

  test('case 4 — zip conflict subtracts 0.1 after name_plus_dob fires', () => {
    // name_plus_dob: +0.7. zip conflict: -0.1. Score = 0.6.
    const result = scoreMatch(
      makeCandidate({ name: 'jane doe', dob: '1990-03-01', zip: '73102' }),
      makeInbound({  name: 'jane doe', dob: '1990-03-01', zip: '90210' })
    );
    expect(result.score).toBeCloseTo(0.7 - SIGNAL_CONFIG.disagreement.zip, 5);
    expect(result.penalties_applied).toContainEqual({ field: 'zip', penalty: SIGNAL_CONFIG.disagreement.zip });
  });

  test('case 5 — name conflict subtracts 0.2 (device_id + guardian_email cap to 1.0, then -0.2 = 0.8)', () => {
    // device_id 0.5 + guardian_email 0.65 → capped to 1.0. Name conflict -0.2 → 0.8.
    const result = scoreMatch(
      makeCandidate({ name: 'john smith', device_id: 'device-abc', guardian_email: 'parent@example.com' }),
      makeInbound({  name: 'jane doe',   device_id: 'device-abc', guardian_email: 'parent@example.com' })
    );
    expect(result.score).toBeCloseTo(1.0 - SIGNAL_CONFIG.disagreement.name, 5);
    expect(result.penalties_applied).toContainEqual({ field: 'name', penalty: SIGNAL_CONFIG.disagreement.name });
  });

  test('case 6 — near-miss email seam closed (prompt 4): signal does NOT fire, conflict detected, penalty IS applied', () => {
    // 'jsmith@gmail.com' vs 'jsmith2@gmail.com': not equal → signal does NOT fire (exact only).
    // Conflict IS detected. emailSignalFired suppression removed in prompt 4.
    // No agreement signals → pre-penalty score 0.0. Email penalty −0.3 → clamped to 0.0.
    const result = scoreMatch(
      makeCandidate({ email: 'jsmith2@gmail.com' }),
      makeInbound({  email: 'jsmith@gmail.com'  })
    );
    const emailConflict = result.conflicts_detected.find(c => c.field === 'email');
    expect(emailConflict).toBeDefined();                                      // conflict IS detected
    expect(result.signals_matched.some(s => s.signal === 'email_similarity')).toBe(false); // signal NOT fired
    expect(result.penalties_applied.some(p => p.field === 'email')).toBe(true);            // penalty IS applied
    expect(result.score).toBe(0.0);                                           // clamped from −0.3
  });

  test('case 7 — email penalty APPLIES when email_similarity did not fire', () => {
    // 'jane@example.com' vs 'completely-different@other.com': similarity << 0.8 → no signal.
    // device_id + guardian_email cap score to 1.0. Email conflict -0.3 → 0.7.
    const result = scoreMatch(
      makeCandidate({ email: 'completely-different@other.com', device_id: 'device-xyz', guardian_email: 'parent@example.com' }),
      makeInbound({  email: 'jane@example.com',               device_id: 'device-xyz', guardian_email: 'parent@example.com' })
    );
    expect(result.penalties_applied).toContainEqual({ field: 'email', penalty: SIGNAL_CONFIG.disagreement.email });
    expect(result.score).toBeCloseTo(1.0 - SIGNAL_CONFIG.disagreement.email, 5);
  });

  test('case 8 — multiple penalties stack: name (-0.2) + zip (-0.1) both subtracted', () => {
    // device_id fires (+0.5). Names differ (-0.2). Zips differ (-0.1). Score = 0.5 - 0.3 = 0.2.
    const result = scoreMatch(
      makeCandidate({ device_id: 'device-multi', name: 'john smith', zip: '73102' }),
      makeInbound({  device_id: 'device-multi', name: 'jane doe',   zip: '90210' })
    );
    expect(result.penalties_applied).toHaveLength(2);
    expect(result.penalties_applied.some(p => p.field === 'name')).toBe(true);
    expect(result.penalties_applied.some(p => p.field === 'zip')).toBe(true);
    const totalPenalty = SIGNAL_CONFIG.disagreement.name + SIGNAL_CONFIG.disagreement.zip;
    expect(result.score).toBeCloseTo(0.5 - totalPenalty, 5);
  });

  test('case 9 — score floors at 0.0 when penalties exceed agreement score', () => {
    // device_id fires (+0.5). email conflict (-0.3) + name conflict (-0.2) + zip conflict (-0.1) = -0.6.
    // 0.5 - 0.6 = -0.1, clamped to 0.0.
    const result = scoreMatch(
      makeCandidate({ device_id: 'device-floor', name: 'john smith', zip: '73102', email: 'john@example.com'       }),
      makeInbound({  device_id: 'device-floor', name: 'jane doe',   zip: '90210', email: 'completely@different.net' })
    );
    expect(result.score).toBe(0.0);
  });

  // ───────── regression cases ─────────

  test('case 10 — no conflicts = no penalties: clean pair returns penalties_applied empty', () => {
    // email exact match + name + dob all agree. Cap absorbs name_alone de-dup. Score = 1.0.
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com', name: 'jane doe', dob: '1990-03-01' }),
      makeInbound({  email: 'fan@example.com', name: 'jane doe', dob: '1990-03-01' })
    );
    expect(result.penalties_applied).toHaveLength(0);
    expect(result.score).toBeCloseTo(1.0, 5);
  });

  test('case 11 — missing != conflict: inbound.zip null does not trigger zip penalty', () => {
    // name_plus_dob fires (+0.7). inbound.zip null → detectConflicts skips zip → no penalty.
    const result = scoreMatch(
      makeCandidate({ name: 'jane doe', dob: '1990-03-01', zip: '73102' }),
      makeInbound({  name: 'jane doe', dob: '1990-03-01', zip: null    })
    );
    expect(result.penalties_applied).toHaveLength(0);
    expect(result.score).toBeCloseTo(SIGNAL_CONFIG.agreement.name_plus_dob * 1.0, 5);
  });

  test('case 12 — DOB veto still short-circuits before penalty loop', () => {
    // Conflicting dob + matching email. Veto returns early — penalty loop never runs.
    const result = scoreMatch(
      makeCandidate({ email: 'jane@example.com', dob: '1985-11-22' }),
      makeInbound({  email: 'jane@example.com', dob: '1990-03-01' })
    );
    expect(result.score).toBe(0.0);
    expect(result.dob_veto).toBe(true);
    expect(result.signals_matched).toHaveLength(0);
    // penalties_applied is absent (veto returns before the penalty block)
    expect(!result.penalties_applied || result.penalties_applied.length === 0).toBe(true);
  });

  test('case 13 — 1.0 cap still holds with no conflicts: score never exceeds 1.0', () => {
    // email (0.7) + guardian_email (0.65) + device_id (0.5) → sum 1.85, capped to 1.0.
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com', guardian_email: 'parent@example.com', device_id: 'device-cap' }),
      makeInbound({  email: 'fan@example.com', guardian_email: 'parent@example.com', device_id: 'device-cap' })
    );
    expect(result.score).toBe(1.0);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 5 prompt 4 — re-aim comparisons (email exact, name fuzzy)
// Pure function tests — no DB, no seeding, no cleanup.
// Recency = 1.0 throughout (RECENT = 10 days ago, within ≤ 6 months bucket).
// ─────────────────────────────────────────────────────────────────────────────

describe('probabilisticMatcher — email exact + name fuzzy (Sprint 5 prompt 4)', () => {

  // ───────── email exact cases ─────────

  test('case 1 — near-miss email NO LONGER matches: jsmith@gmail.com vs jsmith2@gmail.com → no email_similarity signal', () => {
    // HEADLINE FIX. Pre-prompt-4: levenshtein ~0.94 ≥ 0.8 → signal fired.
    // Post-prompt-4: not equal → similarity 0.0 → signal does not fire.
    const result = scoreMatch(
      makeCandidate({ email: 'jsmith2@gmail.com' }),
      makeInbound({  email: 'jsmith@gmail.com'  })
    );
    expect(result.signals_matched.some(s => s.signal === 'email_similarity')).toBe(false);
  });

  test('case 2 — near-miss email now PENALIZED: penalty unsealed by removal of emailSignalFired suppression', () => {
    // Same near-miss pair + device_id + guardian_email so the candidate still scores.
    // device_id (0.5) + guardian_email (0.65) → capped to 1.0. Email conflict −0.3 → 0.7.
    const result = scoreMatch(
      makeCandidate({ email: 'jsmith2@gmail.com', device_id: 'dev-abc', guardian_email: 'parent@example.com' }),
      makeInbound({  email: 'jsmith@gmail.com',  device_id: 'dev-abc', guardian_email: 'parent@example.com' })
    );
    expect(result.penalties_applied).toContainEqual({ field: 'email', penalty: SIGNAL_CONFIG.disagreement.email });
    expect(result.score).toBeCloseTo(1.0 - SIGNAL_CONFIG.disagreement.email, 5);
  });

  test('case 3 — exact email still matches: identical emails → email_similarity fires, similarity === 1.0', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com' }),
      makeInbound({  email: 'fan@example.com' })
    );
    expect(result.signals_matched.some(s => s.signal === 'email_similarity')).toBe(true);
    const sig = result.signals_matched.find(s => s.signal === 'email_similarity');
    expect(sig.similarity).toBe(1.0);
    expect(result.score).toBeCloseTo(SIGNAL_CONFIG.agreement.email_similarity * 1.0, 5);
  });

  test('case 4 — nightmare case dead: near-miss emails + same name + no dob → score well below PATH_C threshold', () => {
    // Pre-prompt-4: email (~0.94) fired +0.7 AND name_alone fired +0.3 → 1.0 → PATH C.
    // Post-prompt-4: email does not fire (not equal). name_alone fires +0.3. Email conflict −0.3 → 0.0.
    // Must be well below 0.85 (PATH_C threshold). Assert < 0.5 for a clear margin.
    const result = scoreMatch(
      makeCandidate({ email: 'jane2@x.com', name: 'jane doe' }),
      makeInbound({  email: 'jane@x.com',  name: 'jane doe' })
    );
    expect(result.signals_matched.some(s => s.signal === 'email_similarity')).toBe(false);
    expect(result.score).toBeLessThan(0.5);
  });

  // ───────── name fuzzy cases ─────────

  test('case 5 — typo name now matches: "jon smith" vs "john smith" + matching dob → name_plus_dob fires', () => {
    // Pre-prompt-4: exact match failed → name_plus_dob did not fire.
    // Post-prompt-4: levenshtein('jon smith','john smith') = 0.9 ≥ 0.85 → match.
    const result = scoreMatch(
      makeCandidate({ name: 'john smith', dob: '1990-01-15' }),
      makeInbound({  name: 'jon smith',  dob: '1990-01-15' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_plus_dob')).toBe(true);
    expect(result.score).toBeCloseTo(SIGNAL_CONFIG.agreement.name_plus_dob * 1.0, 5);
  });

  test('case 6 — fuzzy-matching name is NOT a conflict: "jon smith" vs "john smith" → no name entry in conflicts_detected, no name penalty', () => {
    // normalizedNameMatch is called by both scorer and detectConflicts — both re-aimed.
    // A name that fuzzy-matches must not simultaneously be flagged as a conflict.
    const result = scoreMatch(
      makeCandidate({ name: 'john smith', dob: '1990-01-15' }),
      makeInbound({  name: 'jon smith',  dob: '1990-01-15' })
    );
    expect(result.conflicts_detected.some(c => c.field === 'name')).toBe(false);
    expect(result.penalties_applied.some(p => p.field === 'name')).toBe(false);
  });

  test('case 7 — exact name still matches: identical names fire via fast-path (left === right)', () => {
    const result = scoreMatch(
      makeCandidate({ name: 'alice thunder' }),
      makeInbound({  name: 'alice thunder' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(true);
  });

  test('case 8 — genuinely different names do NOT match: conflict detected and penalty applied', () => {
    // 'jane doe' vs 'michael rodriguez': levenshtein similarity well below 0.85 → no match.
    // device_id provides agreement so the score starts above 0.
    const result = scoreMatch(
      makeCandidate({ name: 'michael rodriguez', device_id: 'dev-xyz' }),
      makeInbound({  name: 'jane doe',           device_id: 'dev-xyz' })
    );
    expect(result.signals_matched.some(s => s.signal.includes('name'))).toBe(false);
    expect(result.conflicts_detected.some(c => c.field === 'name')).toBe(true);
    expect(result.penalties_applied).toContainEqual({ field: 'name', penalty: SIGNAL_CONFIG.disagreement.name });
  });

  test('case 9 — nickname matching remains unimplemented (DESIGN DECISION 2): "bob smith" vs "robert smith" → no name signal', () => {
    // levenshtein('bob smith','robert smith') ≈ 0.67 < 0.85 — Levenshtein measures typos,
    // not synonyms. This test EXISTS TO DOCUMENT the known gap, not to flag a bug.
    const result = scoreMatch(
      makeCandidate({ name: 'robert smith' }),
      makeInbound({  name: 'bob smith' })
    );
    expect(result.signals_matched.some(s => s.signal.includes('name'))).toBe(false);
  });

  test('case 10 — threshold is config-driven: SIGNAL_CONFIG.comparison.name_similarity_threshold === 0.85 and pairs below it do not match', () => {
    expect(SIGNAL_CONFIG.comparison.name_similarity_threshold).toBe(0.85);
    // 'jon' alone vs 'john': distance 1 over maxLen 4 → similarity 0.75 < 0.85.
    // Add dob so name_plus_dob would fire IF name matched — proves threshold gates it.
    const result = scoreMatch(
      makeCandidate({ name: 'john', dob: '1990-01-15' }),
      makeInbound({  name: 'jon',  dob: '1990-01-15' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_plus_dob')).toBe(false);
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(false);
  });

  // ───────── regression cases ─────────

  test('case 11 — DOB veto still wins: conflicting dob + exact matching email → score 0.0, dob_veto true', () => {
    // Re-aiming comparisons must not affect the veto — it runs before scoring.
    const result = scoreMatch(
      makeCandidate({ email: 'jane@example.com', dob: '1985-11-22' }),
      makeInbound({  email: 'jane@example.com', dob: '1990-03-01' })
    );
    expect(result.score).toBe(0.0);
    expect(result.dob_veto).toBe(true);
  });

  test('case 12 — name double-count still dead through fuzzy path: "jon smith"/"john smith" + dob → name_plus_dob fires, name_alone does NOT', () => {
    // Prompt 3 suppression (nameCountedInCompositeSignal) must still work when the
    // name match is fuzzy rather than exact.
    const result = scoreMatch(
      makeCandidate({ name: 'john smith', dob: '1990-01-15' }),
      makeInbound({  name: 'jon smith',  dob: '1990-01-15' })
    );
    expect(result.signals_matched.some(s => s.signal === 'name_plus_dob')).toBe(true);
    expect(result.signals_matched.some(s => s.signal === 'name_alone')).toBe(false);
    const nameSignals = result.signals_matched.filter(s => s.signal.includes('name'));
    expect(nameSignals).toHaveLength(1);
  });

  test('case 13 — penalties still clamp: enough conflicts to drive score negative → score === 0.0, never below', () => {
    // device_id (+0.5). email conflict (−0.3) + name conflict (−0.2) + zip conflict (−0.1) = −0.6.
    // Net: 0.5 − 0.6 = −0.1 → clamped to 0.0.
    const result = scoreMatch(
      makeCandidate({ device_id: 'dev-clamp', email: 'a@x.com', name: 'john smith',    zip: '73102' }),
      makeInbound({  device_id: 'dev-clamp', email: 'b@y.com', name: 'michael jones', zip: '90210' })
    );
    expect(result.score).toBe(0.0);
  });

  test('case 14 — cap still holds: email + guardian_email exceed 1.0, clamped to 1.0, no conflicts', () => {
    // email (0.7) + guardian_email (0.65) = 1.35 → capped to 1.0.
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com', guardian_email: 'parent@example.com' }),
      makeInbound({  email: 'fan@example.com', guardian_email: 'parent@example.com' })
    );
    expect(result.score).toBe(1.0);
  });

  test('case 15 — eligibility gate untouched: near-miss emails still PASS the gate even though signal no longer fires', () => {
    // passesSignalEligibilityGate checks field existence, not comparison result.
    // Re-aiming email to exact must not change which candidates are admitted.
    // The gate is exercised indirectly: both email fields are non-null, so the gate
    // would pass this candidate — scoring proceeds (resulting in 0 signals + penalty).
    // If the gate had accidentally been tightened, score would be 0 with NO penalty.
    const result = scoreMatch(
      makeCandidate({ email: 'jsmith2@gmail.com' }),
      makeInbound({  email: 'jsmith@gmail.com'  })
    );
    // Gate passed → scoring ran → email conflict was detected and penalty applied.
    const emailConflict = result.conflicts_detected.find(c => c.field === 'email');
    expect(emailConflict).toBeDefined();
    expect(result.penalties_applied.some(p => p.field === 'email')).toBe(true);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 7 prep prompt 1 — clock injection (deterministic scorer)
// Pure function tests — no DB, no seeding, no cleanup.
//
// Problem: scoreMatch() → getRecencyMultiplier() → monthsBetween() called
// Date.now() internally. Same (candidate, inbound) pair returned different
// scores on different calendar days, making Stage 7 corpus replays
// non-reproducible.
//
// Fix: `now` injected as a default parameter through all three layers.
// Default = Date.now() so production call sites are unaffected.
// ─────────────────────────────────────────────────────────────────────────────

describe('probabilisticMatcher — clock injection (Stage 7 prep)', () => {

  // Frozen reference point. All last_seen_at values derived by subtraction —
  // never hardcoded dates, so the tests don't rot the same way the scorer did.
  const FROZEN_NOW  = new Date('2026-07-01T00:00:00Z').getTime();
  const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;  // matches module constant

  function monthsMs(n) { return Math.round(n * MS_PER_MONTH); }

  // Minimal fixture — email only, all other fields null, same org_id.
  // Isolates one signal and one recency multiplier per test.
  function makeFrozenCandidate(emailLastSeenAt) {
    return makeCandidate({ email: 'fan@example.com', email_last_seen_at: emailLastSeenAt });
  }
  const frozenInbound = makeInbound({ email: 'fan@example.com' });

  // ───────── cases 1–4: frozen clock, different recency buckets ─────────

  test('case 1 — 3 months old, frozen clock: recency 1.0, score === 0.7', () => {
    const c = makeFrozenCandidate(new Date(FROZEN_NOW - monthsMs(3)).toISOString());
    expect(scoreMatch(c, frozenInbound, FROZEN_NOW).score).toBe(0.7);
  });

  test('case 2 — 8 months old, frozen clock: recency 0.8, score toBeCloseTo 0.56', () => {
    const c = makeFrozenCandidate(new Date(FROZEN_NOW - monthsMs(8)).toISOString());
    expect(scoreMatch(c, frozenInbound, FROZEN_NOW).score).toBeCloseTo(0.56, 5);
  });

  test('case 3 — 18 months old, frozen clock: recency 0.5, score toBeCloseTo 0.35', () => {
    const c = makeFrozenCandidate(new Date(FROZEN_NOW - monthsMs(18)).toISOString());
    expect(scoreMatch(c, frozenInbound, FROZEN_NOW).score).toBeCloseTo(0.35, 5);
  });

  test('case 4 — 30 months old, frozen clock: recency 0.2, score toBeCloseTo 0.14', () => {
    const c = makeFrozenCandidate(new Date(FROZEN_NOW - monthsMs(30)).toISOString());
    expect(scoreMatch(c, frozenInbound, FROZEN_NOW).score).toBeCloseTo(0.14, 5);
  });

  // ───────── case 5: THE BUG — clock is the only variable ─────────

  test('case 5 — THE BUG FIXED: same pair, different `now`, different path — clock is the only variable', () => {
    // Pre-fix: scoreMatch read Date.now() internally. Three calendar weeks later,
    // an identical pair crossed the 6-month bucket boundary and dropped to PATH D.
    // Post-fix: `now` is injected, replays are deterministic.
    const c = makeFrozenCandidate(new Date(FROZEN_NOW - monthsMs(5)).toISOString());

    // At FROZEN_NOW: 5 months old → recency 1.0 → score 0.7 (above PATH_D 0.60)
    expect(scoreMatch(c, frozenInbound, FROZEN_NOW).score).toBe(0.7);

    // Same pair, clock advanced 3 months: 8 months old → recency 0.8 → score 0.56
    // (below PATH_C 0.85, still above PATH_D 0.60 — but with other signals could shift paths)
    expect(scoreMatch(c, frozenInbound, FROZEN_NOW + monthsMs(3)).score).toBeCloseTo(0.56, 5);
  });

  // ───────── case 6: 6-month bucket boundary (via getRecencyMultiplier directly) ─────────

  test('case 6 — boundary: exactly 6 months old returns 1.0; one day beyond returns 0.8', () => {
    const sixMonthsMs  = monthsMs(6);
    const atBoundary   = new Date(FROZEN_NOW - sixMonthsMs).toISOString();
    const beyondByADay = new Date(FROZEN_NOW - sixMonthsMs - 86400000).toISOString();

    expect(getRecencyMultiplier(atBoundary,   FROZEN_NOW)).toBe(1.0);
    expect(getRecencyMultiplier(beyondByADay, FROZEN_NOW)).toBe(0.8);
  });

  // ───────── case 7: null last_seen_at always 0.5 (via getRecencyMultiplier directly) ─────────

  test('case 7 — null last_seen_at returns 0.5 regardless of clock value', () => {
    expect(getRecencyMultiplier(null, FROZEN_NOW)).toBe(0.5);
    expect(getRecencyMultiplier(null, FROZEN_NOW + 10 * 365 * 86400000)).toBe(0.5);
  });

  // ───────── case 8: bad clock rejects non-finite / non-number input ─────────

  test('case 8 — bad clock throws NormalizationError: string, NaN, Date object all rejected', () => {
    const c = makeFrozenCandidate(new Date(FROZEN_NOW - monthsMs(3)).toISOString());
    expect(() => scoreMatch(c, frozenInbound, 'yesterday')).toThrow(NormalizationError);
    expect(() => scoreMatch(c, frozenInbound, NaN)).toThrow(NormalizationError);
    expect(() => scoreMatch(c, frozenInbound, new Date())).toThrow(NormalizationError);
  });

  // ───────── case 9 (regression): two-argument call still works ─────────

  test('case 9 (regression) — two-argument call unchanged: no third arg, production path unaffected', () => {
    // email_last_seen_at is effectively now — safely inside ≤ 6 months bucket.
    const c = makeCandidate({ email: 'fan@example.com', email_last_seen_at: new Date().toISOString() });
    const i = makeInbound({  email: 'fan@example.com' });
    expect(scoreMatch(c, i).score).toBe(0.7);
  });

  // ───────── case 10 (regression): DOB veto unchanged and clock-independent ─────────

  test('case 10 (regression) — DOB veto still fires correctly with and without explicit clock', () => {
    // Veto block runs after the now-guard. With a valid `now` the guard passes
    // and the veto still short-circuits before any signal is scored.
    const c = makeCandidate({ email: 'jane@example.com', dob: '1985-11-22' });
    const i = makeInbound({  email: 'jane@example.com', dob: '1990-03-01' });

    const withClock    = scoreMatch(c, i, FROZEN_NOW);
    const withoutClock = scoreMatch(c, i);

    expect(withClock.score).toBe(0.0);
    expect(withClock.dob_veto).toBe(true);
    expect(withClock.signals_matched).toHaveLength(0);

    expect(withoutClock.score).toBe(0.0);
    expect(withoutClock.dob_veto).toBe(true);
    expect(withoutClock.signals_matched).toHaveLength(0);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Stage 7 prompt 3 — SCORER_VERSION + NORMALIZATION_VERSION constants
// Pure constant / function tests — no DB, no seeding, no cleanup.
// ─────────────────────────────────────────────────────────────────────────────

describe('probabilisticMatcher — SCORER_VERSION + computeScorerFingerprint (Stage 7 prompt 3)', () => {

  // ───────── format ─────────

  test('case 1 — SCORER_VERSION matches /^v\\d+\\+[0-9a-f]{8}$/', () => {
    expect(SCORER_VERSION).toMatch(/^v\d+\+[0-9a-f]{8}$/);
  });

  // ───────── determinism ─────────

  test('case 2 — deterministic: computeScorerFingerprint called twice returns the same value', () => {
    // SIGNAL_CONFIG.agreement mirrors SIGNAL_WEIGHTS (same values, deferred consolidation).
    const first  = computeScorerFingerprint(SIGNAL_CONFIG, SIGNAL_CONFIG.agreement);
    const second = computeScorerFingerprint(SIGNAL_CONFIG, SIGNAL_CONFIG.agreement);
    expect(first).toBe(second);
  });

  // ───────── order-independence ─────────

  test('case 3 — order-independent: reordering top-level keys in config and weights does not change the fingerprint', () => {
    const { agreement, comparison, disagreement } = SIGNAL_CONFIG;
    const reorderedConfig  = { disagreement, comparison, agreement };

    const { email_similarity, name_plus_dob, name_plus_zip, guardian_email, device_id, name_alone } = SIGNAL_CONFIG.agreement;
    const reorderedWeights = { name_alone, device_id, guardian_email, name_plus_zip, name_plus_dob, email_similarity };

    const original  = computeScorerFingerprint(SIGNAL_CONFIG, SIGNAL_CONFIG.agreement);
    const reordered = computeScorerFingerprint(reorderedConfig, reorderedWeights);
    expect(reordered).toBe(original);
  });

  // ───────── value-sensitivity ─────────

  test('case 4 — value-sensitive (config): agreement.name_alone 0.3 -> 0.25 changes the fingerprint', () => {
    const mutatedConfig = JSON.parse(JSON.stringify(SIGNAL_CONFIG));
    mutatedConfig.agreement.name_alone = 0.25;
    expect(computeScorerFingerprint(mutatedConfig, SIGNAL_CONFIG.agreement))
      .not.toBe(computeScorerFingerprint(SIGNAL_CONFIG, SIGNAL_CONFIG.agreement));
  });

  test('case 5 — value-sensitive (weights): changing a weight value changes the fingerprint', () => {
    // SIGNAL_WEIGHTS is not exported; SIGNAL_CONFIG.agreement is its structural mirror.
    // This proves hashing the weights argument matters — config-only hashing would miss it.
    const baseWeights    = { ...SIGNAL_CONFIG.agreement };
    const mutatedWeights = { ...baseWeights, name_alone: 0.25 };
    expect(computeScorerFingerprint(SIGNAL_CONFIG, mutatedWeights))
      .not.toBe(computeScorerFingerprint(SIGNAL_CONFIG, baseWeights));
  });

  test('case 6 — nested-value-sensitive: comparison.name_similarity_threshold 0.85 -> 0.80 changes the fingerprint', () => {
    const mutatedConfig = JSON.parse(JSON.stringify(SIGNAL_CONFIG));
    mutatedConfig.comparison.name_similarity_threshold = 0.80;
    expect(computeScorerFingerprint(mutatedConfig, SIGNAL_CONFIG.agreement))
      .not.toBe(computeScorerFingerprint(SIGNAL_CONFIG, SIGNAL_CONFIG.agreement));
  });

  // ───────── SCORER_VERSION wiring ─────────

  test('case 7 — SCORER_VERSION hash portion equals computeScorerFingerprint(SIGNAL_CONFIG, SIGNAL_CONFIG.agreement)', () => {
    // SIGNAL_WEIGHTS (unexported) mirrors SIGNAL_CONFIG.agreement in values; canonicalize
    // sorts keys, so source literal order does not affect the hash. Proves the constant
    // uses the exported function at init time, not a stale copy.
    const hashPortion = SCORER_VERSION.split('+')[1];
    expect(hashPortion).toBe(computeScorerFingerprint(SIGNAL_CONFIG, SIGNAL_CONFIG.agreement));
  });

  // ───────── NORMALIZATION_VERSION ─────────

  test('case 8 — NORMALIZATION_VERSION === \'v1\' and is exported from normalizer.js', () => {
    expect(NORMALIZATION_VERSION).toBe('v1');
  });

  // ───────── regression ─────────

  test('case 9 (regression) — scoreMatch email exact 0.7 score byte-for-byte unchanged by adding constants', () => {
    const result = scoreMatch(
      makeCandidate({ email: 'fan@example.com' }),
      makeInbound({  email: 'fan@example.com' })
    );
    expect(result.score).toBeCloseTo(0.7, 5);
    const sig = result.signals_matched.find(s => s.signal === 'email_similarity');
    expect(sig.similarity).toBe(1.0);
    expect(sig.raw_score).toBe(0.7);
    expect(sig.recency_multiplier).toBe(1.0);
    expect(sig.adjusted_score).toBeCloseTo(0.7, 5);
  });

  test('case 10 (regression) — all original exports still present on probabilisticMatcher module', () => {
    // Adding new exports must not remove or shadow the four pre-existing ones.
    expect(typeof scoreMatch).toBe('function');
    expect(typeof detectConflicts).toBe('function');
    expect(typeof SIGNAL_CONFIG).toBe('object');
    expect(typeof getRecencyMultiplier).toBe('function');
    expect(typeof SCORER_VERSION).toBe('string');
    expect(typeof computeScorerFingerprint).toBe('function');
  });

});
