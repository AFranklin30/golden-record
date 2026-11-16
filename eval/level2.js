'use strict';

// Level 2 — classify a resolution_trace the resolver already wrote.
// No scoring, no candidate query, no second matcher.

const BLOCK_MISS_REASONS = ['no_block_key', 'empty_block', 'block_dropped_oversize'];

function classifyObserved(trace, expectedVerdict) {
  // RECEIVE
  const path = trace && trace.resolution_path;
  const skipReason = trace && trace.skip_reason;
  const considered = Number(trace && trace.candidates_considered) || 0;
  const scored = Number(trace && trace.candidates_scored) || 0;
  const queued = path === 'C' || path === 'D';

  // GUARD
  if (expectedVerdict !== 'match' && expectedVerdict !== 'not_match') return 'unclassified';
  if (trace == null) return 'unclassified';

  // EXECUTE
  if (expectedVerdict === 'match' && path === 'A' && skipReason === 'deterministic_match') {
    return 'hard_match';
  }
  if (expectedVerdict === 'match' && BLOCK_MISS_REASONS.includes(skipReason)) {
    return 'blocking_miss';
  }
  if (expectedVerdict === 'match' && queued && considered > 0) {
    return 'found';
  }
  if (expectedVerdict === 'match' && path === 'B' && scored > 0) {
    return 'scoring_miss';
  }
  if (expectedVerdict === 'not_match' && path === 'B') {
    return 'correct_separation';
  }
  if (expectedVerdict === 'not_match' && queued) {
    return 'false_alarm';
  }

  // RETURN — a labeled non-match that hard-matched is recorded, not renamed
  return 'unclassified';
}

module.exports = {
  BLOCK_MISS_REASONS,
  classifyObserved,
};
