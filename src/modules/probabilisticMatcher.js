// probabilisticMatcher.js
// Golden Record Fan Identity Platform
// OKC Thunder — Thunder Innovations Cohort
// Author: Aaron
// Sprint 2
//
// Pure function module — no database calls, no side effects.
// Called by resolverEngine.js after a hard match returns null.
// Exports: scoreMatch(candidateRecord, inboundIdentifiers)

'use strict';

const { NormalizationError } = require('./normalizer');

const SIGNAL_WEIGHTS = {
  email_similarity: 0.7,
  name_plus_dob:    0.7,
  name_plus_zip:    0.6,
  device_id:        0.5,
  name_alone:       0.3,
};

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

// nickname matching (Bob vs Robert) is Sprint 3 scope
function normalizedNameMatch(a, b) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function scoreMatch(candidateRecord, inboundIdentifiers) {
  // RECEIVE
  const candidate = candidateRecord;
  const inbound   = inboundIdentifiers;
  let score           = 0.0;
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
        score = Math.max(score, SIGNAL_WEIGHTS.email_similarity);
        signals_matched.push({
          signal:     'email_similarity',
          score:      SIGNAL_WEIGHTS.email_similarity,
          similarity: similarity,
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
        score = Math.max(score, SIGNAL_WEIGHTS.name_plus_dob);
        signals_matched.push({
          signal: 'name_plus_dob',
          score:  SIGNAL_WEIGHTS.name_plus_dob,
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
        score = Math.max(score, SIGNAL_WEIGHTS.name_plus_zip);
        signals_matched.push({
          signal: 'name_plus_zip',
          score:  SIGNAL_WEIGHTS.name_plus_zip,
        });
      }
    }

    // Signal 4 — device ID
    if (inbound.device_id != null && candidate.device_id != null) {
      if (inbound.device_id === candidate.device_id) {
        score = Math.max(score, SIGNAL_WEIGHTS.device_id);
        signals_matched.push({
          signal: 'device_id',
          score:  SIGNAL_WEIGHTS.device_id,
        });
      }
    }

    // Signal 5 — name alone
    if (inbound.name != null && candidate.name != null) {
      if (normalizedNameMatch(inbound.name, candidate.name)) {
        score = Math.max(score, SIGNAL_WEIGHTS.name_alone);
        signals_matched.push({
          signal: 'name_alone',
          score:  SIGNAL_WEIGHTS.name_alone,
        });
      }
    }
  } catch (err) {
    // Re-throw NormalizationErrors from helpers unchanged; wrap unexpected errors
    if (err instanceof NormalizationError) throw err;
    throw new NormalizationError(`scoreMatch internal error: ${err.message}`);
  }

  // RETURN
  return { score, signals_matched };
}

module.exports = { scoreMatch };
