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

jest.mock('../../src/modules/probabilisticMatcher', () => ({
  scoreMatch:     jest.fn(),
  SCORER_VERSION: 'v1+testmock',
}));

const { scoreMatch } = require('../../src/modules/probabilisticMatcher');
const { resolverEngine } = require('../../src/modules/resolverEngine');

const ORG_ID       = 'aaaaaaaa-0000-0000-0000-000000000001';
const CANDIDATE_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
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

let mockDb;

beforeEach(() => {
  jest.clearAllMocks();
  mockDb = { query: jest.fn().mockResolvedValue({ rows: [] }) }; // default for linked systems
  scoreMatch.mockReturnValue({ score: 0.0, signals_matched: [] });
});

// Sets up client.query responses for a full Path C run (score >= 0.85)
function setupPathC() {
  mockDb.query
    .mockResolvedValueOnce({ rows: [{ id: ORG_ID, is_active: true }] })  // 1. org check
    .mockResolvedValueOnce({ rows: [] })                                   // 2. idempotency
    .mockResolvedValueOnce({ rows: [] })                                   // 3. BEGIN
    .mockResolvedValueOnce({ rows: [] })                                   // 4. link check (no hard match)
    .mockResolvedValueOnce({ rows: [candidateRow] })                       // 5. candidates
    .mockResolvedValueOnce({ rows: [] })                                   // 6. INSERT fan
    .mockResolvedValueOnce({ rows: [] })                                   // 7. INSERT identifier_link
    .mockResolvedValueOnce({ rows: [] })                                   // 8. INSERT conflict_queue
    .mockResolvedValueOnce({ rows: [] })                                   // 9. INSERT audit_log
    .mockResolvedValueOnce({ rows: [] });                                  // 10. COMMIT
}

// Sets up client.query responses for a full Path D run (0.60 <= score < 0.85)
function setupPathD() {
  mockDb.query
    .mockResolvedValueOnce({ rows: [{ id: ORG_ID, is_active: true }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [candidateRow] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
}

// Sets up client.query responses for Path B (no candidates, score stays 0.0)
function setupPathB() {
  mockDb.query
    .mockResolvedValueOnce({ rows: [{ id: ORG_ID, is_active: true }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })  // link check
    .mockResolvedValueOnce({ rows: [] })  // candidates — empty, so no scoreMatch call
    .mockResolvedValueOnce({ rows: [] })  // INSERT fan
    .mockResolvedValueOnce({ rows: [] })  // INSERT identifier_link
    .mockResolvedValueOnce({ rows: [] })  // INSERT audit_log
    .mockResolvedValueOnce({ rows: [] }); // COMMIT
}

// Path D with guardian_email signal — staging INSERT fires between candidates and fan INSERT
function setupPathDWithGuardianEmail() {
  mockDb.query
    .mockResolvedValueOnce({ rows: [{ id: ORG_ID, is_active: true }] })  // 1. org
    .mockResolvedValueOnce({ rows: [] })                                   // 2. idempotency
    .mockResolvedValueOnce({ rows: [] })                                   // 3. BEGIN
    .mockResolvedValueOnce({ rows: [] })                                   // 4. link check
    .mockResolvedValueOnce({ rows: [guardianCandidateRow] })               // 5. candidates
    .mockResolvedValueOnce({ rows: [] })                                   // 6. INSERT staging_household_data
    .mockResolvedValueOnce({ rows: [] })                                   // 7. INSERT fan
    .mockResolvedValueOnce({ rows: [] })                                   // 8. INSERT identifier_link
    .mockResolvedValueOnce({ rows: [] })                                   // 9. INSERT conflict_queue
    .mockResolvedValueOnce({ rows: [] })                                   // 10. INSERT audit_log
    .mockResolvedValueOnce({ rows: [] });                                  // 11. COMMIT
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
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ORG_ID, is_active: true }] })
      .mockResolvedValueOnce({ rows: [{
        fan_id:           FAN_ID,
        match_type:       'soft',
        confidence_score: '0.9',
        is_new_record:    true,
        id:               AUDIT_ID,
      }] });  // idempotency hit — early return

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

  function setupOneCandidatePath() {
    // One candidate returned; scoreMatch scores 0.0 → Path B
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ORG_ID, is_active: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [candidateRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
  }

  test('identifier_type email: inbound.email set, all other signal fields null', async () => {
    setupOneCandidatePath();
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
      })
    );
  });

  test('identifier_type guardian_email: inbound.guardian_email set, email null', async () => {
    setupOneCandidatePath();
    scoreMatch.mockReturnValue({ score: 0.0, signals_matched: [] });

    await resolverEngine({ ...baseInput, identifier_type: 'guardian_email', identifier_value: 'parent@example.com' }, mockDb);

    expect(scoreMatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        email:          null,
        guardian_email: 'parent@example.com',
        name:           null,
      })
    );
  });

  test('identifier_type nfc_uid: all probabilistic signal fields null', async () => {
    setupOneCandidatePath();
    scoreMatch.mockReturnValue({ score: 0.0, signals_matched: [] });

    await resolverEngine({ ...baseInput, identifier_type: 'nfc_uid', identifier_value: 'AB:CD:EF:01' }, mockDb);

    expect(scoreMatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        email:          null,
        name:           null,
        dob:            null,
        zip:            null,
        device_id:      null,
        guardian_email: null,
      })
    );
  });

  test('inbound.org_id is always set', async () => {
    setupOneCandidatePath();
    scoreMatch.mockReturnValue({ score: 0.0, signals_matched: [] });

    await resolverEngine(baseInput, mockDb);

    expect(scoreMatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ org_id: ORG_ID })
    );
  });

});

describe('resolverEngine — trace failure is non-fatal', () => {

  test('trace INSERT failure does not throw or alter the resolution result', async () => {
    const logger   = require('../../src/lib/logger');
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    // PATH B (no candidates) — minimal setup. Force only the trace INSERT to fail.
    mockDb.query = jest.fn().mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('resolution_trace')) {
        return Promise.reject(new Error('forced trace failure'));
      }
      if (typeof sql === 'string' && sql.includes('FROM org')) {
        return Promise.resolve({ rows: [{ id: ORG_ID, is_active: true }] });
      }
      return Promise.resolve({ rows: [] });
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

  test('staging INSERT called when guardian_email signal is in bestSignals (Path D)', async () => {
    setupPathDWithGuardianEmail();
    scoreMatch.mockReturnValue({ score: 0.65, signals_matched: [guardianEmailSignal] });

    await resolverEngine(baseInput, mockDb);

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

    await resolverEngine(baseInput, mockDb);

    const stagingInsert = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('staging_household_data')
    );
    // params[1] is adult_fan_id — must be the candidate's id (bestMatch.id)
    expect(stagingInsert[1][1]).toBe(CANDIDATE_ID);
  });

  test('staging INSERT uses adjusted_score from the guardian_email signal', async () => {
    setupPathDWithGuardianEmail();
    scoreMatch.mockReturnValue({ score: 0.65, signals_matched: [guardianEmailSignal] });

    await resolverEngine(baseInput, mockDb);

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
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ORG_ID, is_active: true }] })  // org
      .mockResolvedValueOnce({ rows: [] })                                   // idempotency
      .mockResolvedValueOnce({ rows: [] })                                   // BEGIN
      .mockResolvedValueOnce({ rows: [] })                                   // link check
      .mockResolvedValueOnce({ rows: [guardianCandidateRow] })               // candidates
      .mockRejectedValueOnce(new Error('staging db unreachable'))            // staging INSERT throws
      .mockResolvedValueOnce({ rows: [] })                                   // INSERT fan (Path D continues)
      .mockResolvedValueOnce({ rows: [] })                                   // INSERT identifier_link
      .mockResolvedValueOnce({ rows: [] })                                   // INSERT conflict_queue
      .mockResolvedValueOnce({ rows: [] })                                   // INSERT audit_log
      .mockResolvedValueOnce({ rows: [] });                                  // COMMIT
    scoreMatch.mockReturnValue({ score: 0.65, signals_matched: [guardianEmailSignal] });

    const result = await resolverEngine(baseInput, mockDb);

    expect(result.match_type).toBe('conflict');
    expect(result.fan_id).toMatch(UUID_RE);
    expect(result.conflict_id).toMatch(UUID_RE);
  });

  test('staging INSERT failure does not cause a 500 — no ResolverError thrown', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ORG_ID, is_active: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [guardianCandidateRow] })
      .mockRejectedValueOnce(new Error('staging db unreachable'))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    scoreMatch.mockReturnValue({ score: 0.65, signals_matched: [guardianEmailSignal] });

    await expect(resolverEngine(baseInput, mockDb)).resolves.not.toThrow();
  });

  test('staging INSERT fires before Path D fan record creation', async () => {
    setupPathDWithGuardianEmail();
    scoreMatch.mockReturnValue({ score: 0.65, signals_matched: [guardianEmailSignal] });

    await resolverEngine(baseInput, mockDb);

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
