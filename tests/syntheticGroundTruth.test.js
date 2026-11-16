'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  SEED,
  SET_B_PLAN,
  buildDataset,
  buildExtension,
  buildGroundTruth,
  csvText,
  serializeDocument,
  blockKeys,
} = require('../scripts/syntheticDataset');

const ROOT = path.join(__dirname, '..');
const V2 = path.join(ROOT, 'demo', 'synthetic-ground-truth-v2.json');
const V1 = path.join(ROOT, 'demo', 'synthetic-200-ground-truth.json');
const MANIFEST = path.join(ROOT, 'demo', 'synthetic-dataset-manifest.json');
const SET_A_CSV_SHA256 = '3fb01339fa4144d63a566c97a39fe3869cd96a1c9d4df86fb288a3a783bf2bc7';

const LABEL_KEYS = [
  'row', 'set', 'scenario_id', 'case_group', 'case_id', 'role', 'person_key',
  'anchor_row', 'identity_truth', 'truth_basis', 'indistinguishable',
  'policy_expected', 'expected_path', 'policy_basis', 'severity_if_auto_merged',
  'flag', 'truth_policy_disagreement', 'notes',
];

describe('synthetic ground truth v2', () => {
  const committed = JSON.parse(fs.readFileSync(V2, 'utf8'));
  const rebuilt = buildGroundTruth();
  const labels = committed.labels;
  const extension = buildExtension();

  test('rebuilds the committed file and keeps Set A bytes', () => {
    expect(rebuilt).toEqual(committed);
    expect(committed.version).toBe(2);
    expect(committed.seed).toBe(SEED);
    expect(labels).toHaveLength(360);
    expect(labels.map((label) => label.row)).toEqual(
      Array.from({ length: 360 }, (_, index) => index + 1)
    );
    const setAHash = crypto.createHash('sha256').update(csvText(buildDataset().rows)).digest('hex');
    expect(setAHash).toBe(SET_A_CSV_SHA256);

    const previous = JSON.parse(fs.readFileSync(V1, 'utf8'));
    expect(previous.labels).toHaveLength(200);
    expect(previous.labels[0].intended_outcome).toBe('separate');
  });

  test('labels match the schema and the scenario counts', () => {
    const probesByScenario = {};
    for (const label of labels) {
      expect(Object.keys(label)).toEqual(LABEL_KEYS);
      expect(label.truth_basis).toBe('recipe');
      expect(['A', 'B']).toContain(label.set);
      expect(['anchor', 'probe', 'first_seen']).toContain(label.role);
      expect(['same_person', 'distinct_person', 'first_seen']).toContain(label.identity_truth);
      expect(['hard_match', 'review', 'separate', 'import_replay', 'import_error']).toContain(label.policy_expected);
      expect(['A', 'B', 'C', 'D']).toContain(label.expected_path);
      expect(typeof label.policy_basis).toBe('string');
      expect(label.policy_basis.length).toBeGreaterThan(0);
      expect(typeof label.notes).toBe('string');
      expect([null, 'S0', 'S1', 'S2']).toContain(label.flag);
      expect(typeof label.truth_policy_disagreement).toBe('boolean');
      expect(label.indistinguishable).toBe(label.scenario_id === 'CA-4' && label.role === 'probe');
      if (label.role === 'probe' && label.set === 'B') {
        probesByScenario[label.scenario_id] = (probesByScenario[label.scenario_id] || 0) + 1;
      }
    }

    expect(probesByScenario).toEqual(Object.fromEntries(
      SET_B_PLAN.map((scenario) => [scenario.id, scenario.cases])
    ));
    expect(labels.filter((label) => label.set === 'A')).toHaveLength(200);
    expect(labels.filter((label) => label.set === 'B' && label.role === 'anchor')).toHaveLength(80);
    expect(labels.filter((label) => label.set === 'B' && label.role === 'probe')).toHaveLength(80);
    expect(labels.filter((label) => label.scenario_id === 'A-ORIGINAL')).toHaveLength(80);
    expect(labels.filter((label) => label.scenario_id === 'A-SAME-EMAIL')).toHaveLength(5);
    expect(labels.filter((label) => label.scenario_id === 'A-NICKNAME')).toHaveLength(10);
    expect(labels.filter((label) => label.scenario_id === 'A-SPELLING')).toHaveLength(10);
    expect(labels.filter((label) => label.scenario_id === 'A-SAME-NAME')).toHaveLength(20);
    expect(labels.filter((label) => label.scenario_id === 'A-NO-EMAIL')).toHaveLength(15);
    expect(labels.filter((label) => label.scenario_id === 'A-DIFF-DOB')).toHaveLength(60);

    const disagreements = labels.filter((label) => label.truth_policy_disagreement);
    expect(disagreements).toHaveLength(32);
    expect(disagreements.every((label) => label.flag === 'S0' || label.flag === 'S2')).toBe(true);
    expect(labels.filter((label) => label.flag === 'S0')).toHaveLength(19);
    expect(labels.filter((label) => label.flag === 'S2')).toHaveLength(13);
    expect(labels.filter((label) => label.flag === 'S1')).toHaveLength(10);
    expect(committed.disagreement_count).toBe(32);
  });

  test('every Set B probe points at its anchor and shares no block key outside that case', () => {
    const byRow = new Map(labels.map((label) => [label.row, label]));
    const probes = labels.filter((label) => label.set === 'B' && label.role === 'probe');
    expect(probes).toHaveLength(extension.pairs.length);
    for (const probe of probes) {
      const anchor = byRow.get(probe.anchor_row);
      expect(anchor.role).toBe('anchor');
      expect(anchor.case_id).toBe(probe.case_id);
      expect(anchor.scenario_id).toBe(probe.scenario_id);
      expect(anchor.set).toBe('B');
      if (probe.identity_truth === 'same_person') {
        expect(probe.person_key).toBe(anchor.person_key);
      } else {
        expect(probe.person_key).not.toBe(anchor.person_key);
      }
    }

    const holders = new Map();
    function claim(caseId, record) {
      for (const key of blockKeys(record)) {
        if (!holders.has(key)) holders.set(key, new Set());
        holders.get(key).add(caseId);
      }
    }
    buildDataset().rows.forEach((record, index) => claim(`set-a-${index}`, record));
    extension.pairs.forEach((pair) => {
      claim(pair.caseId, pair.anchor);
      claim(pair.caseId, pair.probe);
    });
    for (const pair of extension.pairs) {
      for (const key of blockKeys(pair.probe)) {
        const outside = [...holders.get(key)].filter((owner) => owner !== pair.caseId);
        expect(outside).toEqual([]);
      }
    }
  });

  test('label generation does not import the engine', () => {
    const labelSource = fs.readFileSync(path.join(ROOT, 'scripts', 'syntheticDataset.js'), 'utf8');
    expect(labelSource).not.toMatch(/probabilisticMatcher|resolverEngine|customerImport|scoreMatch|parseCustomerRow/);

    const cli = fs.readFileSync(path.join(ROOT, 'scripts', 'buildSyntheticDemoCsv.js'), 'utf8');
    const gateAt = cli.indexOf('function runSetAScoreGate');
    expect(gateAt).toBeGreaterThan(0);
    expect(cli.slice(0, gateAt)).not.toMatch(/probabilisticMatcher|resolverEngine|customerImport|scoreMatch|parseCustomerRow/);

    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const labelBytes = serializeDocument(committed);
    const hash = crypto.createHash('sha256').update(labelBytes).digest('hex');
    expect(manifest.seed).toBe(SEED);
    expect(manifest.label_sha256).toBe(hash);
    expect(manifest.row_count).toBe(360);
    expect(manifest.disagreement_count).toBe(32);
    expect(manifest.source_commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
