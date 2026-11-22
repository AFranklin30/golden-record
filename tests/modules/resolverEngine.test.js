'use strict';

// All mocks must be declared before requiring the module under test.
// jest.mock() is hoisted automatically.

jest.mock('@google-cloud/firestore', () => ({
  Firestore: jest.fn().mockImplementation(() => ({
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        set: jest.fn().mockResolvedValue({}),
      }),
    }),
  })),
}));

jest.mock('../../src/modules/probabilisticMatcher', () => {
  const actual = jest.requireActual('../../src/modules/probabilisticMatcher');
  return {
    scoreMatch:                    jest.fn(),
    SCORER_VERSION:                'v1+testmock',
    levenshteinDistance:           actual.levenshteinDistance,
    givenNamesEquivalent:          actual.givenNamesEquivalent,
    isListedGivenName:             actual.isListedGivenName,
    populatedFirstNamesConflict:   actual.populatedFirstNamesConflict,
  };
});

const { scoreMatch } = require('../../src/modules/probabilisticMatcher');
const { resolverEngine } = require('../../src/modules/resolverEngine');

const ORG_ID       = 'aaaaaaaa-0000-0000-0000-000000000001';
const CANDIDATE_ID       = 'bbbbbbbb-0000-0000-0000-000000000002';
const FLOOR_CANDIDATE_ID = 'eeeeeeee-0000-0000-0000-000000000005';
const FAN_ID       = 'cccccccc-0000-0000-0000-000000000003';
const AUDIT_ID     = 'dddddddd-0000-0000-0000-000000000004';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const baseInput = {
  identifier_type:  'email',
  identifier_value: 'fan@example.com',
  org_id:           ORG_ID,
  schema_version:   'v1',
  idempotency_key:  'test-idempotency-hash',
  source_system:    'test',
};

// Rich LEFT JOIN shape — one row per fan, all signal columns present
const candidateRow = {
  id:                          CANDIDATE_ID,
  org_id:                      ORG_ID,
  email:                       'similar@example.com',
  email_last_seen_at:          new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
  name:                        null,
  name_last_seen_at:           null,
  dob:                         null,
  dob_last_seen_at:            null,
  zip:                         null,
  zip_last_seen_at:            null,
  device_id:                   null,
  device_last_seen_at:         null,
  guardian_email:              null,
  guardian_email_last_seen_at: null,
};

// Candidate with guardian_email set — used for soft link detection tests
const guardianCandidateRow = {
  ...candidateRow,
  guardian_email:              'parent@example.com',
  guardian_email_last_seen_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
};

// =============================================================================
// Mock db harness — dispatches on QUERY SHAPE, not call order.
//
// Positional mockResolvedValueOnce chains broke every time resolverEngine's
// query COUNT or ORDER changed shape (blocking added a probe query before the
// candidate join and made the join conditional — every canned answer after it
// shifted by one slot, turning one root cause into 18 confusing failures).
// Matching on a distinctive SQL fragment instead means a future query added
// to resolverEngine.js surfaces as one clear "unmocked query" error instead
// of silently misreading an unrelated canned answer. Same class of fix as
// Lesson 24 (assert what you mean, not an incidental detail).
//
// Each response defaults to `{ rows: [] }` (or a documented sane default —
// active org, no idempotency hit, no hard match) so a test only overrides
// what it actually needs. A response of `{ reject: <Error> }` simulates a
// failing query.
// =============================================================================

function buildMockDb(overrides = {}) {
  const responses = {
    org:                  { rows: [{ id: ORG_ID, is_active: true }] },
    idempotency:          { rows: [] },
    hardMatchLink:        { rows: [] },
    updateLastSeen:       { rows: [] },
    blockEmail:           { rows: [] },
    blockGuardianEmail:   { rows: [] },
    blockNameDob:         { rows: [] },
    blockSimilarSurname:  { rows: [] },
    blockExactName:       { rows: [] },
    blockNickname:        { rows: [] },
    storedNameAndDob:     { rows: [] },
    candidateJoin:        { rows: [] },
    staging:              { rows: [] },
    insertFan:            { rows: [] },
    insertIdentifierLink: { rows: [] },
    insertConflictQueue:  { rows: [] },
    resolutionTrace:      { rows: [] },
    auditLogSuccess:      { rows: [] },
    auditLogError:        { rows: [] },
    linkedSystems:        { rows: [] },
    ...overrides,
  };

  function respond(key) {
    const r = responses[key];
    if (r && Object.prototype.hasOwnProperty.call(r, 'reject')) {
      return Promise.reject(r.reject);
    }
    return Promise.resolve(r);
  }

  const query = jest.fn((sql) => {
    const text    = typeof sql === 'string' ? sql : String(sql);
    const trimmed = text.trim();

    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/i.test(trimmed)) {
      return Promise.resolve({ rows: [] });
    }
    if (/FROM org WHERE id/i.test(text)) {
      return respond('org');
    }
    if (/FROM audit_log/i.test(text) && /idempotency_key/i.test(text)) {
      return respond('idempotency');
    }
    if (/UPDATE identifier_link SET last_seen_at/i.test(text)) {
      return respond('updateLastSeen');
    }
    // PATH A hard-match link check AND the 23505 winner requery share this
    // exact SQL text — parameterized identifier_type ($1), not a literal.
    if (/il\.identifier_type = \$1/i.test(text) && /JOIN fan f/i.test(text)) {
      return respond('hardMatchLink');
    }
    if (/identifier_type IN \('name', 'dob'\)/i.test(text)) {
      return respond('storedNameAndDob');
    }
    if (/SELECT il\.fan_id/i.test(text) && /identifier_type = 'name'/i.test(text)) {
      return respond('blockExactName');
    }
    if (/FROM identifier_link il\b/i.test(text) && /il\.name_last_word/i.test(text)) {
      return respond('blockNickname');
    }
    // findBlockCandidates probes — distinguished from the candidate JOIN's
    // own `il_email.identifier_type = 'email'` alias by the bare `SELECT
    // il.fan_id` projection (the join selects many more columns).
    if (/SELECT il\.fan_id/i.test(text) && /identifier_type = 'email'/i.test(text)) {
      return respond('blockEmail');
    }
    if (/SELECT il\.fan_id/i.test(text) && /identifier_type = 'guardian_email'/i.test(text)) {
      return respond('blockGuardianEmail');
    }
    // similar_surname also selects name_last_word. Match it first.
    if (/split_part\(il_n\.identifier_value/i.test(text)) {
      return respond('blockSimilarSurname');
    }
    if (/il_n\.name_last_word/i.test(text)) {
      return respond('blockNameDob');
    }
    if (/LEFT JOIN identifier_link il_email/i.test(text)) {
      return respond('candidateJoin');
    }
    if (/INSERT INTO staging_household_data/i.test(text)) {
      return respond('staging');
    }
    if (text.includes('INSERT INTO fan (')) {
      return respond('insertFan');
    }
    if (text.includes('INSERT INTO identifier_link')) {
      return respond('insertIdentifierLink');
    }
    if (text.includes('INSERT INTO conflict_queue')) {
      return respond('insertConflictQueue');
    }
    if (text.includes('INSERT INTO resolution_trace')) {
      return respond('resolutionTrace');
    }
    if (text.includes('INSERT INTO audit_log') && text.includes("'error'")) {
      return respond('auditLogError');
    }
    if (text.includes('INSERT INTO audit_log') && text.includes("'success'")) {
      return respond('auditLogSuccess');
    }
    if (text.includes('SELECT DISTINCT source_system')) {
      return respond('linkedSystems');
    }

    return Promise.reject(new Error(`unmocked query: ${text.slice(0, 120)}`));
  });

  return { query };
}

// Finds the resolution_trace INSERT call and returns its resolution_path
// param (index 3 — see the VALUES list in resolverEngine.js's STEP 4C).
function tracePathOf(db) {
  const call = db.query.mock.calls.find(
    c => typeof c[0] === 'string' && c[0].includes('INSERT INTO resolution_trace')
  );
  return call ? call[1][3] : undefined;
}

// Any call shaped like one of findBlockCandidates' probes. Must check
// for the literal identifier_type — a bare `SELECT il.fan_id` prefix also
// matches the (differently-shaped) hard-match link check.
function blockProbeCalls(db) {
  return db.query.mock.calls.filter(c => {
    const sql = typeof c[0] === 'string' ? c[0] : '';
    return (
      (/SELECT il\.fan_id/i.test(sql) && /identifier_type = 'email'/i.test(sql)) ||
      (/SELECT il\.fan_id/i.test(sql) && /identifier_type = 'guardian_email'/i.test(sql)) ||
      /split_part\(il_n\.identifier_value/i.test(sql) ||
      /il_n\.name_last_word/i.test(sql)
    );
  });
}

let mockDb;

beforeEach(() => {
  jest.clearAllMocks();
  mockDb = buildMockDb();
  scoreMatch.mockReturnValue({ score: 0.0, signals_matched: [] });
});

// PATH A — hard match. Never enters the block phase at all.
function setupPathA() {
  mockDb = buildMockDb({
    hardMatchLink: { rows: [{ fan_id: CANDIDATE_ID, confidence_score: 1.0 }] },
  });
  return mockDb;
}

// PATH B — no usable candidate. The block probe finds a fan_id (the 'email'
// key is always available — baseInput's identifier_type is always 'email',
// so inbound.email is always populated), but the candidate JOIN comes back
// empty — the same "deleted between the block probe and the join" shape the
// original R2 test already documented. Chosen over "no key available" so the
// JOIN actually runs: the SQL-shape assertions below need a real query to
// inspect.
function setupPathB() {
  mockDb = buildMockDb({
    blockEmail:    { rows: [{ fan_id: CANDIDATE_ID }] },
    candidateJoin: { rows: [] },
  });
  return mockDb;
}

// PATH C — score >= 0.85. No fixture field needed to make this reachable —
// baseInput's identifier_type: 'email' already supplies the block key.
function setupPathC() {
  mockDb = buildMockDb({
    blockEmail:    { rows: [{ fan_id: CANDIDATE_ID }] },
    candidateJoin: { rows: [candidateRow] },
  });
  return mockDb;
}

// PATH D — 0.60 <= score < 0.85. Same retrieval shape as PATH C.
function setupPathD() {
  mockDb = buildMockDb({
    blockEmail:    { rows: [{ fan_id: CANDIDATE_ID }] },
    candidateJoin: { rows: [candidateRow] },
  });
  return mockDb;
}

// PATH D with guardian_email signal — staging INSERT fires between the
// candidate JOIN and the fan INSERT.
function setupPathDWithGuardianEmail() {
  mockDb = buildMockDb({
    blockEmail:    { rows: [{ fan_id: CANDIDATE_ID }] },
    candidateJoin: { rows: [guardianCandidateRow] },
  });
  return mockDb;
}

// Same as above, but the staging INSERT itself fails — used to prove the
// failure is swallowed (staging is wrapped in its own try/catch) and Path D
// still completes normally.
function setupPathDWithGuardianEmailStagingFailure() {
  mockDb = buildMockDb({
    blockEmail:    { rows: [{ fan_id: CANDIDATE_ID }] },
    candidateJoin: { rows: [guardianCandidateRow] },
    staging:       { reject: new Error('staging db unreachable') },
  });
  return mockDb;
}

describe('resolverEngine — Path C (score >= 0.85)', () => {

  test('creates a new fan record in Postgres', async () => {
    setupPathC();
    scoreMatch.mockReturnValue({ score: 0.90, signals_matched: [] });

    await resolverEngine(baseInput, mockDb);

    const fanInsert = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO fan')
    );
    expect(fanInsert).toBeDefined();
  });

  test('writes conflict_queue row with status pending', async () => {
    setupPathC();
    scoreMatch.mockReturnValue({ score: 0.90, signals_matched: [] });

    await resolverEngine(baseInput, mockDb);

    const conflictInsert = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO conflict_queue')
    );
    expect(conflictInsert).toBeDefined();
    expect(conflictInsert[0]).toContain("'pending'");
  });

  test('returns match_type: soft', async () => {
    setupPathC();
    scoreMatch.mockReturnValue({ score: 0.90, signals_matched: [] });

    const result = await resolverEngine(baseInput, mockDb);

    expect(result.match_type).toBe('soft');
  });

  test('returns conflict_id as a valid UUID', async () => {
    setupPathC();
    scoreMatch.mockReturnValue({ score: 0.90, signals_matched: [] });

    const result = await resolverEngine(baseInput, mockDb);

    expect(result.conflict_id).toMatch(UUID_RE);
  });

  test('returns is_new_record: true', async () => {
    setupPathC();
    scoreMatch.mockReturnValue({ score: 0.90, signals_matched: [] });

    const result = await resolverEngine(baseInput, mockDb);

    expect(result.is_new_record).toBe(true);
  });

});

describe('resolverEngine — Path D (0.60 <= score < 0.85)', () => {

  test('creates a new fan record in Postgres', async () => {
    setupPathD();
    scoreMatch.mockReturnValue({ score: 0.75, signals_matched: [] });

    await resolverEngine(baseInput, mockDb);

    const fanInsert = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO fan')
    );
    expect(fanInsert).toBeDefined();
  });

  test('writes conflict_queue row with status pending', async () => {
    setupPathD();
    scoreMatch.mockReturnValue({ score: 0.75, signals_matched: [] });

    await resolverEngine(baseInput, mockDb);

    const conflictInsert = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO conflict_queue')
    );
    expect(conflictInsert).toBeDefined();
    expect(conflictInsert[0]).toContain("'pending'");
  });

  test('returns match_type: conflict', async () => {
    setupPathD();
    scoreMatch.mockReturnValue({ score: 0.75, signals_matched: [] });

    const result = await resolverEngine(baseInput, mockDb);

    expect(result.match_type).toBe('conflict');
  });

  test('returns conflict_id as a valid UUID', async () => {
    setupPathD();
    scoreMatch.mockReturnValue({ score: 0.75, signals_matched: [] });

    const result = await resolverEngine(baseInput, mockDb);

    expect(result.conflict_id).toMatch(UUID_RE);
  });

});

describe('resolverEngine — Path B (score < 0.60)', () => {

  test('does NOT write to conflict_queue', async () => {
    setupPathB();

    await resolverEngine(baseInput, mockDb);

    const conflictInsert = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('conflict_queue')
    );
    expect(conflictInsert).toBeUndefined();
  });

  test('returns match_type: hard and is_new_record: true', async () => {
    setupPathB();

    const result = await resolverEngine(baseInput, mockDb);

    expect(result.match_type).toBe('hard');
    expect(result.is_new_record).toBe(true);
  });

  test('returns conflict_id: null', async () => {
    setupPathB();

    const result = await resolverEngine(baseInput, mockDb);

    expect(result.conflict_id).toBeNull();
  });

});

describe('resolverEngine — audit event ordering', () => {

  test('audit event is always the last write before COMMIT', async () => {
    setupPathC();
    scoreMatch.mockReturnValue({ score: 0.90, signals_matched: [] });

    await resolverEngine(baseInput, mockDb);

    const sqlCalls   = mockDb.query.mock.calls.map(c => c[0]);
    const auditIdx   = sqlCalls.findIndex(s => typeof s === 'string' && s.includes('INSERT INTO audit_log'));
    const conflictIdx = sqlCalls.findIndex(s => typeof s === 'string' && s.includes('INSERT INTO conflict_queue'));
    const commitIdx  = sqlCalls.findIndex(s => s === 'COMMIT');

    expect(conflictIdx).toBeGreaterThan(-1);  // conflict_queue was written
    expect(auditIdx).toBeGreaterThan(conflictIdx);   // audit AFTER conflict_queue
    expect(commitIdx).toBeGreaterThan(auditIdx);     // COMMIT AFTER audit
  });

});

describe('resolverEngine — R2 regression: deleted fans excluded from candidates', () => {

  test('R2-A: candidate query SQL uses LEFT JOIN and includes deleted_at IS NULL filter', async () => {
    setupPathB();

    await resolverEngine(baseInput, mockDb);

    const candidateCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' &&
           c[0].includes('FROM fan') &&
           c[0].includes('LEFT JOIN')
    );
    expect(candidateCall).toBeDefined();
    expect(candidateCall[0]).toContain('deleted_at IS NULL');
  });

  test('R2-B: Path B fires when candidate query returns empty — deleted fans scenario', async () => {
    // Simulates: all probabilistic candidates had deleted_at set, query returns none
    setupPathB();

    const result = await resolverEngine(baseInput, mockDb);

    expect(result.match_type).toBe('hard');
    expect(result.is_new_record).toBe(true);
    expect(result.conflict_id).toBeNull();

    const conflictInsert = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('conflict_queue')
    );
    expect(conflictInsert).toBeUndefined();
  });

});

describe('resolverEngine — idempotency', () => {

  test('idempotency replay returns conflict_id: null not undefined (GAP-03 fix)', async () => {
    // idempotency check returns a prior Path C resolution from audit_log
    mockDb = buildMockDb({
      idempotency: { rows: [{
        fan_id:           FAN_ID,
        match_type:       'soft',
        confidence_score: '0.9',
        is_new_record:    true,
        id:               AUDIT_ID,
      }] },
    });

    const result = await resolverEngine(baseInput, mockDb);

    // The key must exist and must be null, not undefined
    expect(result).toHaveProperty('conflict_id');
    expect(result.conflict_id).toBe(null);
    expect(result.match_type).toBe('soft');
    expect(result.fan_id).toBe(FAN_ID);
    expect(result.audit_event_id).toBe(AUDIT_ID);
  });

});

describe('resolverEngine — candidate query SQL shape', () => {

  test('query selects all 6 signal columns and their last_seen_at timestamps', async () => {
    setupPathB();

    await resolverEngine(baseInput, mockDb);

    const candidateCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('LEFT JOIN') && c[0].includes('FROM fan')
    );
    expect(candidateCall).toBeDefined();
    const sql = candidateCall[0];

    expect(sql).toContain('email_last_seen_at');
    expect(sql).toContain('name_last_seen_at');
    expect(sql).toContain('dob_last_seen_at');
    expect(sql).toContain('zip_last_seen_at');
    expect(sql).toContain('device_last_seen_at');
    expect(sql).toContain('guardian_email_last_seen_at');
    expect(sql).toContain("identifier_type = 'guardian_email'");
    expect(sql).toContain("identifier_type = 'name'");
    expect(sql).toContain("identifier_type = 'dob'");
    expect(sql).toContain("identifier_type = 'zip'");
  });

  test('query uses exactly 6 LEFT JOINs — one per signal type, no bare INNER JOIN', async () => {
    setupPathB();

    await resolverEngine(baseInput, mockDb);

    const candidateCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('LEFT JOIN') && c[0].includes('FROM fan')
    );
    const sql = candidateCall[0];
    const leftJoinCount = (sql.match(/LEFT JOIN/g) || []).length;
    expect(leftJoinCount).toBe(6);
  });

});

describe('resolverEngine — inbound object construction', () => {

  // 'email': block key available, candidate retrievable, gate passes on
  // email_similarity — this is the one variant expected to reach scoreMatch.
  //
  // 'guardian_email' / 'nfc_uid': the block probes are empty. Blocking does
  // not hand those calls a candidate, so scoreMatch is not called and the
  // resolution is a new person.
  function setupOneCandidatePath(kind = 'email') {
    if (kind === 'email') {
      mockDb = buildMockDb({
        blockEmail:    { rows: [{ fan_id: CANDIDATE_ID }] },
        candidateJoin: { rows: [candidateRow] },
      });
    } else {
      mockDb = buildMockDb();
    }
    return mockDb;
  }

  test('identifier_type email: inbound.email set, all other signal fields null', async () => {
    setupOneCandidatePath('email');
    scoreMatch.mockReturnValue({ score: 0.0, signals_matched: [] });

    await resolverEngine({ ...baseInput, identifier_type: 'email', identifier_value: 'fan@example.com' }, mockDb);

    expect(scoreMatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        email:          'fan@example.com',
        name:           null,
        dob:            null,
        zip:            null,
        device_id:      null,
        guardian_email: null,
      }),
      expect.any(Number)
    );
  });

  test('identifier_type guardian_email: no candidate, so scoreMatch is not called', async () => {
    setupOneCandidatePath('guardian_email');
    scoreMatch.mockReturnValue({ score: 0.0, signals_matched: [] });

    const result = await resolverEngine(
      { ...baseInput, identifier_type: 'guardian_email', identifier_value: 'parent@example.com' },
      mockDb
    );

    expect(scoreMatch).not.toHaveBeenCalled();
    expect(result.is_new_record).toBe(true);
    expect(result.match_type).toBe('hard');
    expect(result.conflict_id).toBeNull();
  });

  test('identifier_type nfc_uid: no block key, so scoreMatch is not called', async () => {
    setupOneCandidatePath('nfc_uid');
    scoreMatch.mockReturnValue({ score: 0.0, signals_matched: [] });

    const result = await resolverEngine(
      { ...baseInput, identifier_type: 'nfc_uid', identifier_value: 'AB:CD:EF:01' },
      mockDb
    );

    expect(scoreMatch).not.toHaveBeenCalled();
    expect(result.is_new_record).toBe(true);
    expect(result.match_type).toBe('hard');
    expect(result.conflict_id).toBeNull();
  });

  test('inbound.org_id is always set', async () => {
    setupOneCandidatePath('email');
    scoreMatch.mockReturnValue({ score: 0.0, signals_matched: [] });

    await resolverEngine(baseInput, mockDb);

    expect(scoreMatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ org_id: ORG_ID }),
      expect.any(Number)
    );
  });

});

describe('resolverEngine — trace failure is non-fatal', () => {

  test('trace INSERT failure does not throw or alter the resolution result', async () => {
    const logger   = require('../../src/lib/logger');
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    // PATH B (no candidates) — block probe empty, nothing to retrieve.
    // Force only the trace INSERT to fail.
    mockDb = buildMockDb({
      resolutionTrace: { reject: new Error('forced trace failure') },
    });

    const result = await resolverEngine(baseInput, mockDb);

    // Resolution succeeded despite trace failure
    expect(result.fan_id).toMatch(UUID_RE);
    expect(result.match_type).toBe('hard');
    expect(result.is_new_record).toBe(true);
    expect(result.audit_event_id).toMatch(UUID_RE);

    // logger.error called with the trace-specific message
    expect(errorSpy).toHaveBeenCalledWith(
      'resolution_trace write failed',
      expect.objectContaining({ error: 'forced trace failure' })
    );

    errorSpy.mockRestore();
  });

});

describe('resolverEngine — soft link detection', () => {

  const guardianEmailSignal = {
    signal:             'guardian_email',
    raw_score:          0.65,
    recency_multiplier: 1.0,
    adjusted_score:     0.65,
  };

  const namedInput = {
    ...baseInput,
    identifiers: { name: 'sam smith', guardian_email: 'parent@example.com' },
  };

  test('staging INSERT called when guardian_email signal is in bestSignals (Path D)', async () => {
    setupPathDWithGuardianEmail();
    scoreMatch.mockReturnValue({ score: 0.65, signals_matched: [guardianEmailSignal] });

    await resolverEngine(namedInput, mockDb);

    const stagingInsert = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('staging_household_data')
    );
    expect(stagingInsert).toBeDefined();
    expect(stagingInsert[0]).toContain('INSERT INTO staging_household_data');
    expect(stagingInsert[0]).toContain('ON CONFLICT DO NOTHING');
  });

  test('staging INSERT uses bestMatch.id as adult_fan_id', async () => {
    setupPathDWithGuardianEmail();
    scoreMatch.mockReturnValue({ score: 0.65, signals_matched: [guardianEmailSignal] });

    await resolverEngine(namedInput, mockDb);

    const stagingInsert = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('staging_household_data')
    );
    // params[1] is adult_fan_id — must be the candidate's id (bestMatch.id)
    expect(stagingInsert[1][1]).toBe(CANDIDATE_ID);
  });

  test('staging INSERT uses adjusted_score from the guardian_email signal', async () => {
    setupPathDWithGuardianEmail();
    scoreMatch.mockReturnValue({ score: 0.65, signals_matched: [guardianEmailSignal] });

    await resolverEngine(namedInput, mockDb);

    const stagingInsert = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('staging_household_data')
    );
    // params[7] is confidence
    expect(stagingInsert[1][7]).toBe(0.65);
  });

  test('staging INSERT NOT called when no guardian_email signal fires', async () => {
    setupPathD();
    scoreMatch.mockReturnValue({ score: 0.75, signals_matched: [] });

    await resolverEngine(baseInput, mockDb);

    const stagingInsert = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('staging_household_data')
    );
    expect(stagingInsert).toBeUndefined();
  });

  test('staging INSERT failure is non-fatal — Path D result returned normally', async () => {
    setupPathDWithGuardianEmailStagingFailure();
    scoreMatch.mockReturnValue({ score: 0.65, signals_matched: [guardianEmailSignal] });

    const result = await resolverEngine(namedInput, mockDb);

    expect(result.match_type).toBe('conflict');
    expect(result.fan_id).toMatch(UUID_RE);
    expect(result.conflict_id).toMatch(UUID_RE);
  });

  test('staging INSERT failure does not cause a 500 — no ResolverError thrown', async () => {
    setupPathDWithGuardianEmailStagingFailure();
    scoreMatch.mockReturnValue({ score: 0.65, signals_matched: [guardianEmailSignal] });

    await expect(resolverEngine(namedInput, mockDb)).resolves.not.toThrow();
  });

  test('staging INSERT is skipped when the incoming name is null, and Path D still completes', async () => {
    setupPathDWithGuardianEmail();
    scoreMatch.mockReturnValue({ score: 0.65, signals_matched: [guardianEmailSignal] });

    const result = await resolverEngine(baseInput, mockDb);

    const stagingInsert = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('staging_household_data')
    );
    expect(stagingInsert).toBeUndefined();
    expect(result.match_type).toBe('conflict');
    expect(result.conflict_id).toMatch(UUID_RE);
  });

  test('staging INSERT fires before Path D fan record creation', async () => {
    setupPathDWithGuardianEmail();
    scoreMatch.mockReturnValue({ score: 0.65, signals_matched: [guardianEmailSignal] });

    await resolverEngine(namedInput, mockDb);

    const sqlCalls = mockDb.query.mock.calls.map(c => c[0]);
    const stagingIdx = sqlCalls.findIndex(
      s => typeof s === 'string' && s.includes('staging_household_data')
    );
    const fanInsertIdx = sqlCalls.findIndex(
      s => typeof s === 'string' && s.includes('INSERT INTO fan')
    );
    expect(stagingIdx).toBeGreaterThan(-1);
    expect(fanInsertIdx).toBeGreaterThan(stagingIdx);
  });

});

describe('resolverEngine — resolution_path per setup helper (guards the fixtures themselves)', () => {

  test('setupPathA: resolution_path A, hard match, never enters the block phase', async () => {
    const db = setupPathA();

    const result = await resolverEngine(baseInput, db);

    expect(result.match_type).toBe('hard');
    expect(result.is_new_record).toBe(false);
    expect(tracePathOf(db)).toBe('A');
    expect(blockProbeCalls(db)).toEqual([]);
  });

  test('setupPathB: resolution_path B, new hard record, no conflict', async () => {
    const db = setupPathB();

    const result = await resolverEngine(baseInput, db);

    expect(result.match_type).toBe('hard');
    expect(result.is_new_record).toBe(true);
    expect(tracePathOf(db)).toBe('B');
  });

  test('setupPathC: resolution_path C, soft match', async () => {
    const db = setupPathC();
    scoreMatch.mockReturnValue({ score: 0.90, signals_matched: [] });

    const result = await resolverEngine(baseInput, db);

    expect(result.match_type).toBe('soft');
    expect(tracePathOf(db)).toBe('C');
  });

  test('setupPathD: resolution_path D, conflict match', async () => {
    const db = setupPathD();
    scoreMatch.mockReturnValue({ score: 0.75, signals_matched: [] });

    const result = await resolverEngine(baseInput, db);

    expect(result.match_type).toBe('conflict');
    expect(tracePathOf(db)).toBe('D');
  });

});

describe('resolverEngine — name-and-birthday review floor', () => {

  function conflictInsertOf(db) {
    return db.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO conflict_queue')
    );
  }

  function setupTwoCandidates() {
    return buildMockDb({
      blockEmail: { rows: [{ fan_id: CANDIDATE_ID }, { fan_id: FLOOR_CANDIDATE_ID }] },
      candidateJoin: {
        rows: [
          candidateRow,
          { ...candidateRow, id: FLOOR_CANDIDATE_ID },
        ],
      },
    });
  }

  test('name_plus_dob at 0.40 opens review and stores the real score', async () => {
    const db = setupPathD();
    scoreMatch.mockReturnValue({
      score: 0.40,
      signals_matched: [{ signal: 'name_plus_dob' }],
    });

    const result = await resolverEngine(baseInput, db);
    const conflictInsert = conflictInsertOf(db);

    expect(result.match_type).toBe('conflict');
    expect(result.confidence_score).toBe(0.40);
    expect(tracePathOf(db)).toBe('D');
    expect(conflictInsert).toBeDefined();
    expect(conflictInsert[1][1]).toBe(CANDIDATE_ID);
    expect(conflictInsert[1][4]).toBe(0.40);
  });

  test('a 0.40 score with no name_plus_dob signal stays a new fan and writes no queue row', async () => {
    const db = setupPathD();
    scoreMatch.mockReturnValue({
      score: 0.40,
      signals_matched: [{ signal: 'name_alone' }],
    });

    const result = await resolverEngine(baseInput, db);

    expect(result.match_type).toBe('hard');
    expect(result.confidence_score).toBe(1.0);
    expect(tracePathOf(db)).toBe('B');
    expect(conflictInsertOf(db)).toBeUndefined();
  });

  test('name_plus_dob at 0.90 stays path C', async () => {
    const db = setupPathC();
    scoreMatch.mockReturnValue({
      score: 0.90,
      signals_matched: [{ signal: 'name_plus_dob' }],
    });

    const result = await resolverEngine(baseInput, db);

    expect(result.match_type).toBe('soft');
    expect(result.confidence_score).toBe(0.90);
    expect(tracePathOf(db)).toBe('C');
  });

  test('a 0.70 score with no name_plus_dob signal stays path D', async () => {
    const db = setupPathD();
    scoreMatch.mockReturnValue({ score: 0.70, signals_matched: [] });

    const result = await resolverEngine(baseInput, db);

    expect(result.match_type).toBe('conflict');
    expect(result.confidence_score).toBe(0.70);
    expect(tracePathOf(db)).toBe('D');
  });

  test('a name-and-birthday candidate under 0.60 is reviewed ahead of a higher score that is still under 0.60', async () => {
    const db = setupTwoCandidates();
    scoreMatch
      .mockReturnValueOnce({ score: 0.50, signals_matched: [{ signal: 'device_id' }] })
      .mockReturnValueOnce({ score: 0.40, signals_matched: [{ signal: 'name_plus_dob' }] });

    const result = await resolverEngine(baseInput, db);
    const conflictInsert = conflictInsertOf(db);

    expect(result.match_type).toBe('conflict');
    expect(result.confidence_score).toBe(0.40);
    expect(tracePathOf(db)).toBe('D');
    expect(conflictInsert[1][1]).toBe(FLOOR_CANDIDATE_ID);
    expect(conflictInsert[1][4]).toBe(0.40);
  });

  test('a candidate that already clears 0.60 stays the winner over a lower name-and-birthday score', async () => {
    const db = setupTwoCandidates();
    scoreMatch
      .mockReturnValueOnce({ score: 0.70, signals_matched: [{ signal: 'email_similarity' }] })
      .mockReturnValueOnce({ score: 0.40, signals_matched: [{ signal: 'name_plus_dob' }] });

    const result = await resolverEngine(baseInput, db);
    const conflictInsert = conflictInsertOf(db);

    expect(result.match_type).toBe('conflict');
    expect(result.confidence_score).toBe(0.70);
    expect(tracePathOf(db)).toBe('D');
    expect(conflictInsert[1][1]).toBe(CANDIDATE_ID);
    expect(conflictInsert[1][4]).toBe(0.70);
  });

  test('name_plus_dob clamped to 0 still opens review and stores 0', async () => {
    const db = setupPathD();
    scoreMatch.mockReturnValue({
      score: 0,
      signals_matched: [{ signal: 'name_plus_dob' }],
    });

    const result = await resolverEngine(baseInput, db);
    const conflictInsert = conflictInsertOf(db);

    expect(result.match_type).toBe('conflict');
    expect(result.confidence_score).toBe(0);
    expect(tracePathOf(db)).toBe('D');
    expect(conflictInsert[1][4]).toBe(0);
  });

});

describe('mockDb harness — unmocked query guard', () => {

  test('an unmatched query throws with the offending SQL in the message', async () => {
    const db = buildMockDb();

    await expect(db.query('SELECT * FROM some_unmapped_table WHERE x = $1', [1]))
      .rejects.toThrow(/unmocked query: SELECT \* FROM some_unmapped_table/);
  });

});
