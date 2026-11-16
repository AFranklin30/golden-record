'use strict';

// Synthetic identity benchmark.
// Classifies a trace the resolver already wrote. It does not score and it
// does not decide that two people are the same.

const BLOCK_MISS_REASONS = ['no_block_key', 'empty_block', 'block_dropped_oversize'];

function actualBehavior(trace) {
  if (trace == null) return 'missing_trace';
  const path = trace.resolution_path;
  if (path === 'A') return 'hard_match';
  if (path === 'C' || path === 'D') return 'review';
  if (path === 'B' && BLOCK_MISS_REASONS.includes(trace.skip_reason)) return 'blocking_miss';
  if (path === 'B') return 'scored_separation';
  return 'unknown';
}

function agrees(expected, actual) {
  if (expected === 'unspecified') return actual === 'hard_match' || actual === 'review';
  return expected === actual;
}

function matchesPermitted(permitted, observed) {
  const candidateIds = observed.candidateIds || [];
  return permitted.some((pair) => {
    if (pair.behavior !== observed.behavior) return false;
    if (pair.fan != null && pair.fan !== observed.fan) return false;
    if (Array.isArray(pair.candidates_include)) {
      return pair.candidates_include.every((id) => candidateIds.includes(id));
    }
    return true;
  });
}

function isAutomatic(actual) {
  return actual === 'hard_match' || actual === 'blocking_miss' || actual === 'scored_separation';
}

function isPathB(actual) {
  return actual === 'blocking_miss' || actual === 'scored_separation';
}

function ratio(numerator, denominator) {
  if (!denominator) return null;
  return numerator / denominator;
}

function f1(precision, recall) {
  if (precision == null || recall == null) return null;
  if (precision + recall === 0) return null;
  return (2 * precision * recall) / (precision + recall);
}

function round4(value) {
  if (value == null) return null;
  return Math.round(value * 10000) / 10000;
}

function summarize(rows) {
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;
  let reviews = 0;
  let correctReviews = 0;
  let incorrectReviews = 0;
  let missedReviews = 0;
  let samePerson = 0;
  let samePersonReviewed = 0;
  let incorrectNewPerson = 0;
  let retrievalExpected = 0;
  let retrievalHit = 0;
  let blockingMisses = 0;
  let reviewsOfDifferentPeople = 0;
  let policyMismatches = 0;
  let unspecified = 0;

  const byCategory = {};

  for (const row of rows) {
    const category = byCategory[row.category] || {
      category: row.category,
      total: 0,
      policy_matches: 0,
      true_positives: 0,
      false_positives: 0,
      false_negatives: 0,
      reviews: 0,
    };
    category.total += 1;
    if (row.policy_match) category.policy_matches += 1;
    else policyMismatches += 1;

    if (row.actual === 'review') {
      reviews += 1;
      category.reviews += 1;
      if (row.identity === 'different_people') reviewsOfDifferentPeople += 1;
    }
    if (row.expected === 'review' && row.actual === 'review') correctReviews += 1;
    if (row.actual === 'review' && row.expected !== 'review' && row.expected !== 'unspecified') {
      incorrectReviews += 1;
    }
    if (row.expected === 'review' && row.actual !== 'review') missedReviews += 1;
    if (row.expected === 'unspecified') unspecified += 1;

    if (row.retrieval_expected) {
      retrievalExpected += 1;
      if (row.retrieved) retrievalHit += 1;
    }
    if (row.identity === 'same_person' && row.actual === 'blocking_miss') blockingMisses += 1;

    if (row.identity === 'same_person') {
      samePerson += 1;
      if (row.actual === 'review') samePersonReviewed += 1;
      if (isPathB(row.actual)) incorrectNewPerson += 1;
    }

    if (row.identity !== 'ambiguous' && row.expected !== 'unspecified' && isAutomatic(row.actual)) {
      if (row.identity === 'same_person' && row.actual === 'hard_match') {
        truePositives += 1;
        category.true_positives += 1;
      } else if (row.identity === 'different_people' && row.actual === 'hard_match') {
        falsePositives += 1;
        category.false_positives += 1;
      } else if (row.identity === 'same_person' && isPathB(row.actual)) {
        falseNegatives += 1;
        category.false_negatives += 1;
      } else if (row.identity === 'different_people' && isPathB(row.actual)) {
        trueNegatives += 1;
      }
    }

    byCategory[row.category] = category;
  }

  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);

  return {
    total: rows.length,
    true_positives: truePositives,
    false_positives: falsePositives,
    true_negatives: trueNegatives,
    false_negatives: falseNegatives,
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1(precision, recall)),
    reviews,
    correct_reviews: correctReviews,
    incorrect_reviews: incorrectReviews,
    missed_reviews: missedReviews,
    review_rate: round4(ratio(reviews, rows.length)),
    correct_review_rate: round4(ratio(correctReviews, reviews)),
    incorrect_review_rate: round4(ratio(incorrectReviews, reviews)),
    reviews_of_different_people: reviewsOfDifferentPeople,
    same_person: samePerson,
    same_person_reviewed: samePersonReviewed,
    incorrect_new_person: incorrectNewPerson,
    incorrect_new_person_rate: round4(ratio(incorrectNewPerson, samePerson)),
    retrieval_expected: retrievalExpected,
    retrieval_hits: retrievalHit,
    candidate_retrieval_rate: round4(ratio(retrievalHit, retrievalExpected)),
    blocking_misses: blockingMisses,
    policy_mismatches: policyMismatches,
    unspecified,
    by_category: Object.values(byCategory),
  };
}

function percent(value) {
  if (value == null) return 'n/a';
  return `${Math.round(value * 1000) / 10}%`;
}

function traceLines(row) {
  const trace = row.trace || {};
  return [
    `- Path: ${trace.resolution_path || 'none'}. Skip: ${trace.skip_reason || 'none'}. Score: ${trace.best_score == null ? 'none' : trace.best_score}.`,
    `- Candidates considered: ${trace.candidates_considered}. Signals: ${JSON.stringify(trace.signal_results || [])}.`,
    `- Fan: ${row.fan_id || 'none'}. Conflict with: ${row.conflict_fan_a || 'none'}. New record: ${row.is_new_record}.`,
  ];
}

function formatReport(summary, rows) {
  const lines = [];
  lines.push('# Synthetic identity benchmark');
  lines.push('');
  lines.push('Measured against the resolver as of the November 15, 2026 matching policy. Identity ground truth is separate from the resolution the engine produced. Automatic matches are not mixed with reviews.');
  lines.push('');
  lines.push(`Scenarios: ${summary.total}.`);
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push('Automatic decisions are hard matches and path B outcomes. A review is left out of precision and recall.');
  lines.push('');
  lines.push(`- True positives: ${summary.true_positives}.`);
  lines.push(`- False positives: ${summary.false_positives}.`);
  lines.push(`- True negatives: ${summary.true_negatives}.`);
  lines.push(`- False negatives: ${summary.false_negatives}.`);
  lines.push(`- Precision: ${percent(summary.precision)}.`);
  lines.push(`- Recall: ${percent(summary.recall)}.`);
  lines.push(`- F1: ${percent(summary.f1)}.`);
  lines.push(`- Review rate: ${percent(summary.review_rate)} (${summary.reviews} reviews).`);
  lines.push(`- Correct review rate: ${percent(summary.correct_review_rate)} (${summary.correct_reviews} reviews that the policy predicted).`);
  lines.push(`- Incorrect review rate: ${percent(summary.incorrect_review_rate)} (${summary.incorrect_reviews} reviews the policy did not predict).`);
  lines.push(`- Missed reviews: ${summary.missed_reviews}.`);
  lines.push(`- Reviews of people who are not the same person: ${summary.reviews_of_different_people}.`);
  lines.push(`- Same person sent to review, excluded from recall: ${summary.same_person_reviewed}.`);
  lines.push(`- Candidate retrieval rate: ${percent(summary.candidate_retrieval_rate)} (${summary.retrieval_hits} of ${summary.retrieval_expected}).`);
  lines.push(`- Blocking misses, where the same person was not retrieved: ${summary.blocking_misses}.`);
  lines.push(`- Incorrect new-person rate: ${percent(summary.incorrect_new_person_rate)} (${summary.incorrect_new_person} of ${summary.same_person} same-person scenarios created a new person without review).`);
  lines.push(`- Policy mismatches: ${summary.policy_mismatches}.`);
  lines.push(`- Unspecified row order: ${summary.unspecified}.`);
  lines.push('');
  lines.push('## Results by category');
  lines.push('');
  for (const category of summary.by_category) {
    lines.push(`- ${category.category}: ${category.total} scenarios, ${category.policy_matches} matched the policy, ${category.true_positives} true positives, ${category.false_positives} false positives, ${category.false_negatives} false negatives, ${category.reviews} reviews.`);
  }
  lines.push('');

  const failures = rows.filter((row) => (
    row.policy_match === false
    || (row.check_failures && row.check_failures.length > 0)
    || (row.identity === 'same_person' && isPathB(row.actual))
    || (row.identity === 'different_people' && row.actual === 'hard_match')
  ));

  lines.push('## Failures and weaknesses');
  lines.push('');
  if (failures.length === 0) {
    lines.push('No automatic false positives, false negatives, or policy mismatches.');
  }
  for (const row of failures) {
    lines.push(`### ${row.id}`);
    lines.push('');
    lines.push(`Category: ${row.category}. Identity: ${row.identity}.`);
    lines.push('');
    lines.push('Existing records:');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(row.existing, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('Incoming record:');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(row.inbound, null, 2));
    lines.push('```');
    lines.push('');
    lines.push(`Expected: ${row.expected}. Actual: ${row.actual}.`);
    if (row.check_failures && row.check_failures.length > 0) {
      lines.push(`Check failures: ${row.check_failures.join('; ')}.`);
    }
    lines.push('');
    lines.push(...traceLines(row));
    lines.push('');
    lines.push(row.notes || 'The engine followed the path above.');
    lines.push('');
  }

  lines.push('## Limitations');
  lines.push('');
  lines.push('- A guardian-email match with no incoming name still opens a review. No household staging row is written, because that row requires a child name.');
  lines.push('- A phone on a customer file is stored after the match. It does not find a person. A phone sent as the singular identifier hard-matches before a birthday is read.');
  lines.push('- Guardian phone is stored for a household and is not a search key.');
  lines.push('- Guardian email is shared by a household. It does not identify one child. More than 50 live people on one guardian email are dropped and not scored.');
  lines.push('- The same exact name and the same birthday still hard-match, including two different people.');
  lines.push('- An exact name or exact email with one birthday missing still hard-matches.');
  lines.push('- Card and account ids hard-match even when the birthday on the same call differs.');
  lines.push('- When several people share a name and only one of the stored birthdays matches, the lookup has no order, so the result is either a hard match or a review.');
  lines.push('- An email or exact-name birthday review replaces a higher-scoring different person found on the same call.');
  lines.push('- A changed last name, with no shared email and no shared birthday, is not retrieved.');
  lines.push('- Nothing in this run merged two people.');
  lines.push('');
  lines.push('## Later scenarios worth adding');
  lines.push('');
  lines.push('- A street address, which this resolver does not store.');
  lines.push('- A phone number used as a search key on a customer file.');
  lines.push('- More than two imports in a row, including a review that is later confirmed or rejected.');
  lines.push('- Names outside the five nickname groups.');
  lines.push('- A tie broken by a stable order, once the lookup has an order.');
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  BLOCK_MISS_REASONS,
  actualBehavior,
  agrees,
  matchesPermitted,
  summarize,
  formatReport,
};
