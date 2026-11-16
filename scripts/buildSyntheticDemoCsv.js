'use strict';

// Builds demo/synthetic-customers-200.csv.
// Original people come first. Later rows resemble some of them so the
// existing importer and matcher can open reviews. Nothing here is a real person.
//
// The default run still checks Set A lookalikes and refuses to write the
// 200-row file if that check fails. That check is the old generator filter.
// It does not apply to Set B, and it does not create labels.
//
// node scripts/buildSyntheticDemoCsv.js --labels
// writes demo/synthetic-ground-truth-v2.json, demo/synthetic-extension-160.csv,
// and demo/synthetic-dataset-manifest.json. It does not call the resolver or
// the scorer. demo/synthetic-200-ground-truth.json is left as it was.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  SEED,
  buildDataset,
  buildExtension,
  buildGroundTruth,
  csvText,
  serializeDocument,
} = require('./syntheticDataset');

const DEMO = path.join(__dirname, '..', 'demo');

function writeText(fileName, text) {
  fs.mkdirSync(DEMO, { recursive: true });
  fs.writeFileSync(path.join(DEMO, fileName), text);
}

// The commit that contains scripts/syntheticDataset.js and the 360-row label
// file. A later commit records this value. This file cannot name the commit
// that adds the constant, because that commit's hash depends on this text.
const SOURCE_COMMIT = '0a56806f59a69fe2114891893918887d55c85ce5';

function sourceCommit() {
  return SOURCE_COMMIT;
}

function writeLabels() {
  const dataset = buildDataset();
  const extension = buildExtension();
  const document = buildGroundTruth();
  const labelText = serializeDocument(document);
  writeText('synthetic-customers-200.csv', csvText(dataset.rows));
  writeText('synthetic-extension-160.csv', csvText(extension.rows));
  writeText('synthetic-ground-truth-v2.json', labelText);
  const manifest = {
    version: 2,
    seed: SEED,
    import_order: 'Set A rows 1-200 in the original builder order, then Set B anchors in scenario order (rows 201-280), then Set B probes in that same case order (rows 281-360).',
    source_commit: sourceCommit(),
    stamp_note: 'source_commit is the commit that contains the dataset generator and the 360-row labels. This manifest names that commit from a later edit. A commit cannot contain its own hash. Check out source_commit and run node scripts/buildSyntheticDemoCsv.js --labels to rebuild the same label file and the same Set A CSV. That rebuild names this same commit.',
    label_file: 'demo/synthetic-ground-truth-v2.json',
    label_sha256: crypto.createHash('sha256').update(labelText).digest('hex'),
    set_a_csv_sha256: crypto.createHash('sha256').update(csvText(dataset.rows)).digest('hex'),
    set_b_csv_sha256: crypto.createHash('sha256').update(csvText(extension.rows)).digest('hex'),
    row_count: document.row_count,
    set_a_rows: 200,
    set_b_rows: 160,
    disagreement_count: document.disagreement_count,
  };
  writeText('synthetic-dataset-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote 200 Set A rows and ${extension.rows.length} Set B rows`);
  console.log(`wrote ${document.labels.length} labels to demo/synthetic-ground-truth-v2.json`);
  console.log(`label sha256 ${manifest.label_sha256}`);
}

// Set A only. This is the pre-existing filter. Set B never reaches it.
function runSetAScoreGate(dataset) {
  const { parseCustomerRow } = require('../src/modules/customerImport');
  const { scoreMatch } = require('../src/modules/probabilisticMatcher');
  const {
    originals,
    reviewByNickname,
    reviewBySpelling,
    reviewBySameName,
    highScore,
    differentBirthday,
    rows,
  } = dataset;

  for (const [index, built] of rows.entries()) {
    const parsed = parseCustomerRow(built);
    if (!parsed.ok) throw new Error(`row ${index + 1} failed: ${parsed.error}`);
  }

  const ORG = '00000000-0000-4000-8000-000000000001';

  function normalizedPerson(built) {
    const parsed = parseCustomerRow(built);
    return {
      org_id: ORG,
      name: parsed.fields.name || null,
      email: parsed.fields.email || null,
      dob: parsed.fields.dob || null,
      zip: parsed.fields.zip || null,
    };
  }

  function expectReview(original, lookalike, label) {
    const result = scoreMatch(normalizedPerson(original), { ...normalizedPerson(lookalike), org_id: ORG });
    const signals = result.signals_matched.map((item) => item.signal);
    const review = result.score >= 0.85 || result.score >= 0.60 || signals.includes('name_plus_dob');
    if (!review || result.dob_veto) {
      throw new Error(`${label} did not score as a review: ${result.score} ${signals.join(',')}`);
    }
    return { label, kind: 'review', score: result.score, signals };
  }

  function expectNoReview(original, other, label) {
    const result = scoreMatch(normalizedPerson(original), { ...normalizedPerson(other), org_id: ORG });
    const signals = result.signals_matched.map((item) => item.signal);
    const review = !result.dob_veto && (result.score >= 0.60 || signals.includes('name_plus_dob'));
    if (review) {
      throw new Error(`${label} scored as a review: ${result.score} ${signals.join(',')}`);
    }
    return { label, kind: 'separate', score: result.score, veto: Boolean(result.dob_veto) };
  }

  const samples = [
    ...reviewByNickname.map((lookalike, index) => expectReview(originals[index], lookalike, `nickname ${index + 1}`)),
    ...reviewBySpelling.map((lookalike, index) => expectReview(originals[10 + index], lookalike, `spelling ${index + 1}`)),
    ...reviewBySameName.map((lookalike, index) => expectReview(originals[20 + index], lookalike, `same name ${index + 1}`)),
    ...highScore.map((lookalike, index) => expectReview(originals[40 + index], lookalike, `high score ${index + 1}`)),
    ...differentBirthday.map((other, index) => expectNoReview(originals[index], other, `different birthday ${index + 1}`)),
  ];

  writeText('synthetic-customers-200.csv', csvText(rows));
  const reviewSamples = samples.filter((sample) => sample.kind === 'review');
  const quietSamples = samples.filter((sample) => sample.kind === 'separate');
  console.log(`wrote ${rows.length} rows to ${path.join(DEMO, 'synthetic-customers-200.csv')}`);
  console.log(`scored ${reviewSamples.length} lookalikes as reviews and ${quietSamples.length} different-birthday rows as separate people`);
}

function main() {
  if (process.argv.includes('--labels')) {
    writeLabels();
    return;
  }
  runSetAScoreGate(buildDataset());
}

if (require.main === module) {
  main();
}

module.exports = {
  buildDataset,
  buildExtension,
  buildGroundTruth,
  csvText,
  serializeDocument,
};
