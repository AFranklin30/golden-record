// probabilisticMatcher.unit.js
// Golden Record Fan Identity Platform
// Golden Record
// Sprint 4 — soft matching correctness, step 2 of 3
//
// Pure function test — no database, no pool, no RLS.
// Directly exercises scoreMatch() with controlled inputs.
// Run: node tests/probabilisticMatcher.unit.js

'use strict';

const { scoreMatch } = require('../src/modules/probabilisticMatcher');

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        expected: ${JSON.stringify(expected)}`);
    console.error(`        actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertClose(label, actual, expected, tolerance = 1e-9) {
  if (Math.abs(actual - expected) <= tolerance) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        expected: ${expected} (±${tolerance})`);
    console.error(`        actual:   ${actual}`);
    failed++;
  }
}

function assertContainsSignal(label, signals_matched, signalName) {
  const found = signals_matched.some(s => s.signal === signalName);
  if (found) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        expected signal '${signalName}' in signals_matched`);
    console.error(`        actual signals: ${JSON.stringify(signals_matched.map(s => s.signal))}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Shared candidate — used in TEST 1 and TEST 2
// email has a one-char typo on inbound side to trigger email_similarity
// name + dob exact match to trigger name_plus_dob
// ---------------------------------------------------------------------------
const NOW = new Date().toISOString();

const candidateA = {
  id:                          'test-candidate-uuid',
  org_id:                      'test-org-uuid',
  email:                       'additive@test-synth.com',
  email_last_seen_at:          NOW,
  name:                        'Additive Test',
  name_last_seen_at:           NOW,
  dob:                         '1990-01-01',
  dob_last_seen_at:            NOW,
  zip:                         null,
  zip_last_seen_at:            null,
  device_id:                   null,
  device_last_seen_at:         null,
  guardian_email:              null,
  guardian_email_last_seen_at: null,
};

// ---------------------------------------------------------------------------
// TEST 1 — two strong signals fire, proves additive beats Math.max
//
// email_similarity: levenshtein('addit1ve@test-synth.com','additive@test-synth.com')
//   = 1 edit, maxLen = 23 → similarity ≈ 0.957 >= 0.8 → fires
//   adjusted = 0.7 × 1.0 = 0.70
// name_plus_dob: exact name + exact dob → fires
//   adjusted = 0.7 × 1.0 = 0.70
// additive sum: 0.70 + 0.70 = 1.40 → capped → 1.0
// Math.max would have returned exactly 0.70
// ---------------------------------------------------------------------------
console.log('\nTEST 1 — two strong signals, additive beats Math.max');

const inbound1 = {
  org_id:        'test-org-uuid',
  email:         'addit1ve@test-synth.com',  // one-char typo
  name:          'Additive Test',             // exact match
  dob:           '1990-01-01',               // exact match
  zip:           null,
  device_id:     null,
  guardian_email: null,
};

const result1 = scoreMatch(candidateA, inbound1);

assert(
  '1. result.score > 0.7 (proves additive — Math.max would have been exactly 0.7)',
  result1.score > 0.7,
  true
);
assertClose(
  '2. result.score === 1.0 (0.70 + 0.70 = 1.40, capped at 1.0)',
  result1.score,
  1.0
);
assert(
  '3. signals_matched.length >= 2',
  result1.signals_matched.length >= 2,
  true
);
assertContainsSignal(
  '4. signals_matched contains email_similarity',
  result1.signals_matched,
  'email_similarity'
);
assertContainsSignal(
  '5. signals_matched contains name_plus_dob',
  result1.signals_matched,
  'name_plus_dob'
);

// Assertion 6 — every entry has the required shape fields
const shapeOk = result1.signals_matched.every(
  s => 'signal' in s &&
       'raw_score' in s &&
       'recency_multiplier' in s &&
       'adjusted_score' in s
);
assert(
  '6. every signals_matched entry has signal, raw_score, recency_multiplier, adjusted_score',
  shapeOk,
  true
);

// ---------------------------------------------------------------------------
// TEST 2 — single signal, existing behavior preserved
//
// email only — name and dob both null → name_plus_dob cannot fire
// adjusted = 0.7 × 1.0 = 0.70
// score = Math.min(1.0, 0 + 0.70) = 0.70
// same result Math.max would have produced for a single signal
// ---------------------------------------------------------------------------
console.log('\nTEST 2 — single signal, existing behavior preserved');

const inbound2 = {
  org_id:        'test-org-uuid',
  email:         'addit1ve@test-synth.com',
  name:          null,
  dob:           null,
  zip:           null,
  device_id:     null,
  guardian_email: null,
};

const result2 = scoreMatch(candidateA, inbound2);

assertClose(
  '7. result.score === 0.7 (single signal, no stacking)',
  result2.score,
  0.7
);
assert(
  '8. signals_matched.length === 1',
  result2.signals_matched.length,
  1
);
assert(
  '9. signals_matched[0].signal === email_similarity',
  result2.signals_matched[0].signal,
  'email_similarity'
);

// ---------------------------------------------------------------------------
// TEST 3 — score never exceeds 1.0 (all six signals fire)
//
// email_similarity: typo email → adjusted 0.7 × 1.0 = 0.70
// name_plus_dob:    exact      → adjusted 0.7 × 1.0 = 0.70
// name_plus_zip:    exact      → adjusted 0.6 × 1.0 = 0.60
// guardian_email:   exact      → adjusted 0.65 × 1.0 = 0.65
// device_id:        exact      → adjusted 0.5 × 1.0 = 0.50
// name_alone:       exact      → adjusted 0.3 × 1.0 = 0.30
// sum: 3.45 → capped → 1.0
// ---------------------------------------------------------------------------
console.log('\nTEST 3 — all six signals fire, score capped at 1.0');

const candidateAll = {
  id:                          'test-candidate-all-uuid',
  org_id:                      'test-org-uuid',
  email:                       'allsix@test-synth.com',
  email_last_seen_at:          NOW,
  name:                        'All Six',
  name_last_seen_at:           NOW,
  dob:                         '1985-06-15',
  dob_last_seen_at:            NOW,
  zip:                         '73101',
  zip_last_seen_at:            NOW,
  device_id:                   'device-abc-123',
  device_last_seen_at:         NOW,
  guardian_email:              'guardian@test-synth.com',
  guardian_email_last_seen_at: NOW,
};

const inbound3 = {
  org_id:         'test-org-uuid',
  email:          'a1lsix@test-synth.com',   // one-char typo → similarity fires
  name:           'All Six',                 // exact
  dob:            '1985-06-15',             // exact
  zip:            '73101',                  // exact
  device_id:      'device-abc-123',         // exact
  guardian_email: 'guardian@test-synth.com', // exact
};

const result3 = scoreMatch(candidateAll, inbound3);

assertClose(
  '10. result.score === 1.0 (3.45 sum capped at 1.0)',
  result3.score,
  1.0
);
assert(
  '11. signals_matched.length === 6 (all six fired)',
  result3.signals_matched.length,
  6
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(50)}`);
console.log(`  ${passed} passed  /  ${failed} failed  /  ${passed + failed} total`);
if (failed > 0) {
  console.error('\nSOME ASSERTIONS FAILED');
  process.exit(1);
} else {
  console.log('\nAll assertions passed.');
}
