// probabilisticMatcher.js
// Golden Record Fan Identity Platform
// OKC Thunder — Thunder Innovations Cohort
// Author: Aaron
// Sprint 3
//
// Pure function module — no database calls, no side effects.
// Called by resolverEngine.js after a hard match returns null.
// Exports: scoreMatch(candidateRecord, inboundIdentifiers)
//
// Candidate object shape (Option A — LEFT JOIN from resolverEngine):
//   { id, org_id,
//     email, email_last_seen_at,
//     name, name_last_seen_at,
//     dob, dob_last_seen_at,
//     zip, zip_last_seen_at,
//     device_id, device_last_seen_at,
//     guardian_email, guardian_email_last_seen_at }
//
// Inbound object shape:
//   { org_id, email, name, dob, zip, device_id, guardian_email }

'use strict';

const crypto = require('crypto');
const { NormalizationError } = require('./normalizer');

const SIGNAL_WEIGHTS = {
  email_similarity:   0.7,
  name_plus_dob:      0.7,
  name_plus_zip:      0.6,
  guardian_email:     0.65,
  device_id:          0.5,
  name_alone:         0.3,
};

// SIGNAL_CONFIG — single source of truth for Sprint 5 scoring.
// agreement: mirrors SIGNAL_WEIGHTS (wired into scoring in prompt 3).
// disagreement: penalty applied when a field is present on BOTH records but
//   differs. Conservative defaults — the Thunder sets final values later.
//   NOT read by the scorer yet (detection only this prompt).
// dob intentionally absent: conflicting DOB is a hard-block invariant
//   (prompt 2), not a tunable penalty.
const SIGNAL_CONFIG = {
  agreement: {
    email_similarity: 0.7,
    name_plus_dob:    0.7,
    name_plus_zip:    0.6,
    guardian_email:   0.65,
    device_id:        0.5,
    name_alone:       0.3,
  },
  disagreement: {
    email: 0.3,
    name:  0.2,
    zip:   0.1,
  },
  // comparison — how each field is compared. Calibration dials, Thunder-owned.
  // name_similarity_threshold: minimum levenshteinSimilarity for two names to
  //   count as the same person. 0.85 accepts 'jon smith' vs 'john smith'
  //   (0.9) and rejects genuinely different names. Does NOT catch nicknames
  //   ('bob smith' vs 'robert smith' = ~0.67) — that is a separate body of
  //   work, not a threshold problem.
  // email is compared EXACTLY — no threshold, by design (Sprint 5 prompt 4).
  comparison: {
    name_similarity_threshold: 0.85,
  },
};

// Recursively sort object keys so serialization is order-independent.
// A weight's VALUE changing must move the fingerprint; the literal's key
// ORDER changing must not. Pure — no I/O, no mutation of the input.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = canonicalize(value[key]);
    return acc;
  }, {});
}

// Fingerprint of everything the scorer reads that affects a score.
// Exported as a pure function so tests can prove: reorder -> same hash,
// value change -> different hash, without hardcoding a brittle literal.
function computeScorerFingerprint(config, weights) {
  const canonical = JSON.stringify(canonicalize({ config, weights }));
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 8);
}

// Composite scorer version. Manual 'v1' tracks LOGIC changes (bump by hand
// when you change code without moving a value). The hash tracks CONFIG
// changes (auto). See Stage 7 prompt 3 context for why both are needed.
const SCORER_VERSION = `v1+${computeScorerFingerprint(SIGNAL_CONFIG, SIGNAL_WEIGHTS)}`;

// Approximate months between last_seen_at and now.
// Uses 30.44 days/month — close enough for staleness bucketing.
function monthsBetween(last_seen_at, now = Date.now()) {
  const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;
  return (now - new Date(last_seen_at).getTime()) / MS_PER_MONTH;
}

function getRecencyMultiplier(last_seen_at, now = Date.now()) {
  if (last_seen_at == null) return 0.5;
  const months = monthsBetween(last_seen_at, now);
  if (months <= 6)  return 1.0;
  if (months <= 12) return 0.8;
  if (months <= 24) return 0.5;
  return 0.2;
}

// Wagner-Fischer dynamic programming — standard edit distance
function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

function levenshteinSimilarity(a, b) {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return 1.0;
  return 1.0 - levenshteinDistance(a, b) / maxLength;
}

// Name comparison — FUZZY as of Sprint 5 prompt 4.
// Names are where fuzzy matching earns its keep: 'jon smith' vs
// 'john smith' (similarity 0.9) is the same person and exact matching
// missed it entirely. Threshold is SIGNAL_CONFIG-driven, not hardcoded.
// STILL does not handle nicknames (Bob vs Robert ~0.67) — Levenshtein
// measures typos, not synonyms. That remains unimplemented and out of scope.
// Normalization (trim/lowercase) is retained: fuzziness is for typos, not
// for casing and whitespace, which normalizer.js already handles upstream.
function normalizedNameMatch(a, b) {
  const left  = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left === right) return true;
  return levenshteinSimilarity(left, right) >= SIGNAL_CONFIG.comparison.name_similarity_threshold;
}

// detectConflicts — pure. Flags fields present on BOTH records that disagree.
// Detection only: does not alter score. Consumed by scoring in prompts 2-3.
function detectConflicts(candidate, inbound) {
  const conflicts = [];

  if (inbound.dob != null && candidate.dob != null &&
      inbound.dob !== candidate.dob) {
    conflicts.push({ field: 'dob', inbound: inbound.dob, candidate: candidate.dob });
  }

  if (inbound.email != null && candidate.email != null &&
      inbound.email !== candidate.email) {
    conflicts.push({ field: 'email', inbound: inbound.email, candidate: candidate.email });
  }

  if (inbound.zip != null && candidate.zip != null &&
      inbound.zip !== candidate.zip) {
    conflicts.push({ field: 'zip', inbound: inbound.zip, candidate: candidate.zip });
  }

  if (inbound.name != null && candidate.name != null &&
      !normalizedNameMatch(inbound.name, candidate.name)) {
    conflicts.push({ field: 'name', inbound: inbound.name, candidate: candidate.name });
  }

  return conflicts;
}

function scoreMatch(candidateRecord, inboundIdentifiers, now = Date.now()) {
  // RECEIVE
  const candidate       = candidateRecord;
  const inbound         = inboundIdentifiers;
  let score             = 0.0;
  const signals_matched = [];

  // GUARD — all in-memory, before TRY (Pattern 1)
  if (candidate == null) {
    throw new NormalizationError('candidateRecord is required');
  }
  if (inbound == null) {
    throw new NormalizationError('inboundIdentifiers is required');
  }
  if (candidate.org_id !== inbound.org_id) {
    throw new NormalizationError('org_id mismatch — cannot score across tenants');
  }
  // STATED DECISION (do not substitute a lenient variant): `now` is strictly
  // a finite epoch-milliseconds number. A Date object, a string, or NaN
  // throws rather than silently coercing. Silent coercion of a bad clock
  // produces a plausible-looking wrong score, which is the failure mode this
  // whole prompt exists to eliminate.
  if (typeof now !== 'number' || Number.isFinite(now) === false) {
    throw new NormalizationError('now must be a finite epoch-milliseconds number');
  }

  // DOB VETO — safety invariant (Sprint 5 prompt 2).
  // A conflicting date of birth means different people. Hard-block the match
  // for THIS candidate: return score 0 before any signal is scored, so no
  // agreement signal (not even a perfect email) can override it. This is NOT
  // a config penalty — it is absolute. Per-candidate only: the inbound may
  // still match a different candidate whose dob agrees.
  if (
    inbound.dob != null && candidate.dob != null &&
    inbound.dob !== candidate.dob
  ) {
    return {
      score: 0.0,
      signals_matched: [],
      conflicts_detected: [
        { field: 'dob', inbound: inbound.dob, candidate: candidate.dob }
      ],
      dob_veto: true,
    };
  }

  // EXECUTE
  try {
    // Tracks whether the name has already been counted inside a stronger
    // composite signal. Prevents the name_alone double-count (Sprint 5 prompt 3).
    let nameCountedInCompositeSignal = false;

    // Signal 1 — email match (EXACT as of Sprint 5 prompt 4).
    // Fuzzy email was dangerous: 'jsmith@gmail.com' vs 'jsmith2@gmail.com'
    // scores ~0.94 and fired as a match, but a one-character email difference
    // is a DIFFERENT PERSON, not a typo. Exact only. The signal key stays
    // 'email_similarity' for persisted-JSON compatibility (see CLAUDE.md).
    if (inbound.email != null && candidate.email != null) {
      const similarity = inbound.email === candidate.email ? 1.0 : 0.0;
      if (similarity === 1.0) {
        const recency  = getRecencyMultiplier(candidate.email_last_seen_at, now);
        const adjusted = SIGNAL_WEIGHTS.email_similarity * recency;
        score = Math.min(1.0, score + adjusted);
        signals_matched.push({
          signal:             'email_similarity',
          raw_score:          SIGNAL_WEIGHTS.email_similarity,
          recency_multiplier: recency,
          adjusted_score:     adjusted,
          similarity:         similarity,
        });
      }
    }

    // Signal 2 — name + DOB
    if (
      inbound.name != null && inbound.dob != null &&
      candidate.name != null && candidate.dob != null
    ) {
      const nameMatch = normalizedNameMatch(inbound.name, candidate.name);
      const dobMatch  = inbound.dob === candidate.dob;
      if (nameMatch && dobMatch) {
        const recency  = getRecencyMultiplier(candidate.name_last_seen_at, now);
        const adjusted = SIGNAL_WEIGHTS.name_plus_dob * recency;
        score = Math.min(1.0, score + adjusted);
        signals_matched.push({
          signal:             'name_plus_dob',
          raw_score:          SIGNAL_WEIGHTS.name_plus_dob,
          recency_multiplier: recency,
          adjusted_score:     adjusted,
        });
        nameCountedInCompositeSignal = true;
      }
    }

    // Signal 3 — name + zip
    if (
      inbound.name != null && inbound.zip != null &&
      candidate.name != null && candidate.zip != null
    ) {
      const nameMatch = normalizedNameMatch(inbound.name, candidate.name);
      const zipMatch  = inbound.zip === candidate.zip;
      if (nameMatch && zipMatch) {
        const recency  = getRecencyMultiplier(candidate.name_last_seen_at, now);
        const adjusted = SIGNAL_WEIGHTS.name_plus_zip * recency;
        score = Math.min(1.0, score + adjusted);
        signals_matched.push({
          signal:             'name_plus_zip',
          raw_score:          SIGNAL_WEIGHTS.name_plus_zip,
          recency_multiplier: recency,
          adjusted_score:     adjusted,
        });
      }
    }

    // Signal 4 — guardian email (exact match — relationship signal for household)
    if (inbound.guardian_email != null && candidate.guardian_email != null) {
      if (inbound.guardian_email === candidate.guardian_email) {
        const recency  = getRecencyMultiplier(candidate.guardian_email_last_seen_at, now);
        const adjusted = SIGNAL_WEIGHTS.guardian_email * recency;
        score = Math.min(1.0, score + adjusted);
        signals_matched.push({
          signal:             'guardian_email',
          raw_score:          SIGNAL_WEIGHTS.guardian_email,
          recency_multiplier: recency,
          adjusted_score:     adjusted,
        });
      }
    }

    // Signal 5 — device ID
    if (inbound.device_id != null && candidate.device_id != null) {
      if (inbound.device_id === candidate.device_id) {
        const recency  = getRecencyMultiplier(candidate.device_last_seen_at, now);
        const adjusted = SIGNAL_WEIGHTS.device_id * recency;
        score = Math.min(1.0, score + adjusted);
        signals_matched.push({
          signal:             'device_id',
          raw_score:          SIGNAL_WEIGHTS.device_id,
          recency_multiplier: recency,
          adjusted_score:     adjusted,
        });
      }
    }

    // Signal 6 — name alone
    // Only fires when the name was NOT already counted inside name_plus_dob.
    // Without this guard the same matching name is paid twice (Sprint 5 prompt 3).
    if (
      inbound.name != null && candidate.name != null &&
      nameCountedInCompositeSignal === false
    ) {
      if (normalizedNameMatch(inbound.name, candidate.name)) {
        const recency  = getRecencyMultiplier(candidate.name_last_seen_at, now);
        const adjusted = SIGNAL_WEIGHTS.name_alone * recency;
        score = Math.min(1.0, score + adjusted);
        signals_matched.push({
          signal:             'name_alone',
          raw_score:          SIGNAL_WEIGHTS.name_alone,
          recency_multiplier: recency,
          adjusted_score:     adjusted,
        });
      }
    }
  } catch (err) {
    if (err instanceof NormalizationError) throw err;
    throw new NormalizationError(`scoreMatch internal error: ${err.message}`);
  }

  // RETURN
  // Sprint 5 prompt 3 — disagreement penalties now apply.
  // Agreement signals are summed above; penalties subtract once here, then
  // the score is clamped to [0,1]. dob is never penalized — a dob conflict is
  // a hard veto handled before scoring (prompt 2), so any dob entry that
  // reaches here cannot exist.
  const conflicts_detected = detectConflicts(candidate, inbound);
  const penalties_applied = [];

  for (const conflict of conflicts_detected) {
    if (conflict.field === 'dob') continue;             // veto territory, never a penalty
    // (email suppression removed in prompt 4 — with exact email matching, a
    //  fired signal and an email conflict are mutually exclusive by
    //  construction, so the guard was unreachable.)

    const penalty = SIGNAL_CONFIG.disagreement[conflict.field];
    if (penalty == null) continue;                       // unknown field — no penalty

    score = score - penalty;
    penalties_applied.push({
      field:   conflict.field,
      penalty: penalty,
    });
  }

  // Clamp to [0,1] — mirrors the 1.0 cap on the agreement side.
  score = Math.max(0.0, Math.min(1.0, score));

  return { score, signals_matched, conflicts_detected, penalties_applied };
}

module.exports = { scoreMatch, detectConflicts, SIGNAL_CONFIG, getRecencyMultiplier, SCORER_VERSION, computeScorerFingerprint };
