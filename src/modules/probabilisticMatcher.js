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

const { NormalizationError } = require('./normalizer');

const SIGNAL_WEIGHTS = {
  email_similarity:   0.7,
  name_plus_dob:      0.7,
  name_plus_zip:      0.6,
  guardian_email:     0.65,
  device_id:          0.5,
  name_alone:         0.3,
};

// Approximate months between last_seen_at and now.
// Uses 30.44 days/month — close enough for staleness bucketing.
function monthsBetween(last_seen_at) {
  const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;
  return (Date.now() - new Date(last_seen_at).getTime()) / MS_PER_MONTH;
}

function getRecencyMultiplier(last_seen_at) {
  if (last_seen_at == null) return 0.5;
  const months = monthsBetween(last_seen_at);
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

// nickname matching (Bob vs Robert) is Sprint 3 scope — not yet implemented
function normalizedNameMatch(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function scoreMatch(candidateRecord, inboundIdentifiers) {
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

  // EXECUTE
  try {
    // Signal 1 — email similarity (fuzzy)
    if (inbound.email != null && candidate.email != null) {
      const similarity = levenshteinSimilarity(inbound.email, candidate.email);
      if (similarity >= 0.8) {
        const recency  = getRecencyMultiplier(candidate.email_last_seen_at);
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
        const recency  = getRecencyMultiplier(candidate.name_last_seen_at);
        const adjusted = SIGNAL_WEIGHTS.name_plus_dob * recency;
        score = Math.min(1.0, score + adjusted);
        signals_matched.push({
          signal:             'name_plus_dob',
          raw_score:          SIGNAL_WEIGHTS.name_plus_dob,
          recency_multiplier: recency,
          adjusted_score:     adjusted,
        });
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
        const recency  = getRecencyMultiplier(candidate.name_last_seen_at);
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
        const recency  = getRecencyMultiplier(candidate.guardian_email_last_seen_at);
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
        const recency  = getRecencyMultiplier(candidate.device_last_seen_at);
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
    if (inbound.name != null && candidate.name != null) {
      if (normalizedNameMatch(inbound.name, candidate.name)) {
        const recency  = getRecencyMultiplier(candidate.name_last_seen_at);
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
  return { score, signals_matched };
}

module.exports = { scoreMatch };
