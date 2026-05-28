'use strict';

// All mocks must be declared before requiring the module under test.
// jest.mock() is hoisted automatically.

jest.mock('../../src/db/pool', () => ({
  connect: jest.fn(),
  query:   jest.fn(),
}));

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
  scoreMatch: jest.fn(),
}));

const pool        = require('../../src/db/pool');
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

const candidateRow = {
  id:               CANDIDATE_ID,
  org_id:           ORG_ID,
  identifier_type:  'email',
  identifier_value: 'similar@example.com',
};

let mockClient;

beforeEach(() => {
  jest.clearAllMocks();
  mockClient = { query: jest.fn(), release: jest.fn() };
  pool.connect.mockResolvedValue(mockClient);
  pool.query.mockResolvedValue({ rows: [] });           // linked systems query default
  scoreMatch.mockReturnValue({ score: 0.0, signals_matched: [] });
});

// Sets up client.query responses for a full Path C run (score >= 0.85)
function setupPathC() {
  mockClient.query
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
  mockClient.query
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
  mockClient.query
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

describe('resolverEngine — Path C (score >= 0.85)', () => {

  test('creates a new fan record in Postgres', async () => {
    setupPathC();
    scoreMatch.mockReturnValue({ score: 0.90, signals_matched: [] });

    await resolverEngine(baseInput);

    const fanInsert = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO fan')
    );
    expect(fanInsert).toBeDefined();
  });

  test('writes conflict_queue row with status pending', async () => {
    setupPathC();
    scoreMatch.mockReturnValue({ score: 0.90, signals_matched: [] });

    await resolverEngine(baseInput);

    const conflictInsert = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO conflict_queue')
    );
    expect(conflictInsert).toBeDefined();
    expect(conflictInsert[0]).toContain("'pending'");
  });

  test('returns match_type: soft', async () => {
    setupPathC();
    scoreMatch.mockReturnValue({ score: 0.90, signals_matched: [] });

    const result = await resolverEngine(baseInput);

    expect(result.match_type).toBe('soft');
  });

  test('returns conflict_id as a valid UUID', async () => {
    setupPathC();
    scoreMatch.mockReturnValue({ score: 0.90, signals_matched: [] });

    const result = await resolverEngine(baseInput);

    expect(result.conflict_id).toMatch(UUID_RE);
  });

  test('returns is_new_record: true', async () => {
    setupPathC();
    scoreMatch.mockReturnValue({ score: 0.90, signals_matched: [] });

    const result = await resolverEngine(baseInput);

    expect(result.is_new_record).toBe(true);
  });

});

describe('resolverEngine — Path D (0.60 <= score < 0.85)', () => {

  test('creates a new fan record in Postgres', async () => {
    setupPathD();
    scoreMatch.mockReturnValue({ score: 0.75, signals_matched: [] });

    await resolverEngine(baseInput);

    const fanInsert = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO fan')
    );
    expect(fanInsert).toBeDefined();
  });

  test('writes conflict_queue row with status pending', async () => {
    setupPathD();
    scoreMatch.mockReturnValue({ score: 0.75, signals_matched: [] });

    await resolverEngine(baseInput);

    const conflictInsert = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO conflict_queue')
    );
    expect(conflictInsert).toBeDefined();
    expect(conflictInsert[0]).toContain("'pending'");
  });

  test('returns match_type: conflict', async () => {
    setupPathD();
    scoreMatch.mockReturnValue({ score: 0.75, signals_matched: [] });

    const result = await resolverEngine(baseInput);

    expect(result.match_type).toBe('conflict');
  });

  test('returns conflict_id as a valid UUID', async () => {
    setupPathD();
    scoreMatch.mockReturnValue({ score: 0.75, signals_matched: [] });

    const result = await resolverEngine(baseInput);

    expect(result.conflict_id).toMatch(UUID_RE);
  });

});

describe('resolverEngine — Path B (score < 0.60)', () => {

  test('does NOT write to conflict_queue', async () => {
    setupPathB();

    await resolverEngine(baseInput);

    const conflictInsert = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('conflict_queue')
    );
    expect(conflictInsert).toBeUndefined();
  });

  test('returns match_type: hard and is_new_record: true', async () => {
    setupPathB();

    const result = await resolverEngine(baseInput);

    expect(result.match_type).toBe('hard');
    expect(result.is_new_record).toBe(true);
  });

  test('returns conflict_id: null', async () => {
    setupPathB();

    const result = await resolverEngine(baseInput);

    expect(result.conflict_id).toBeNull();
  });

});

describe('resolverEngine — audit event ordering', () => {

  test('audit event is always the last write before COMMIT', async () => {
    setupPathC();
    scoreMatch.mockReturnValue({ score: 0.90, signals_matched: [] });

    await resolverEngine(baseInput);

    const sqlCalls   = mockClient.query.mock.calls.map(c => c[0]);
    const auditIdx   = sqlCalls.findIndex(s => typeof s === 'string' && s.includes('INSERT INTO audit_log'));
    const conflictIdx = sqlCalls.findIndex(s => typeof s === 'string' && s.includes('INSERT INTO conflict_queue'));
    const commitIdx  = sqlCalls.findIndex(s => s === 'COMMIT');

    expect(conflictIdx).toBeGreaterThan(-1);  // conflict_queue was written
    expect(auditIdx).toBeGreaterThan(conflictIdx);   // audit AFTER conflict_queue
    expect(commitIdx).toBeGreaterThan(auditIdx);     // COMMIT AFTER audit
  });

});

describe('resolverEngine — R2 regression: deleted fans excluded from candidates', () => {

  test('R2-A: candidate query SQL includes f.deleted_at IS NULL filter', async () => {
    setupPathB();

    await resolverEngine(baseInput);

    const candidateCall = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' &&
           c[0].includes('FROM fan') &&
           c[0].includes('identifier_link')
    );
    expect(candidateCall).toBeDefined();
    expect(candidateCall[0]).toContain('deleted_at IS NULL');
  });

  test('R2-B: Path B fires when candidate query returns empty — deleted fans scenario', async () => {
    // Simulates: all probabilistic candidates had deleted_at set, query returns none
    setupPathB();

    const result = await resolverEngine(baseInput);

    expect(result.match_type).toBe('hard');
    expect(result.is_new_record).toBe(true);
    expect(result.conflict_id).toBeNull();

    const conflictInsert = mockClient.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('conflict_queue')
    );
    expect(conflictInsert).toBeUndefined();
  });

});

describe('resolverEngine — idempotency', () => {

  test('idempotency replay returns conflict_id: null not undefined (GAP-03 fix)', async () => {
    // idempotency check returns a prior Path C resolution from audit_log
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ id: ORG_ID, is_active: true }] })
      .mockResolvedValueOnce({ rows: [{
        fan_id:           FAN_ID,
        match_type:       'soft',
        confidence_score: '0.9',
        is_new_record:    true,
        id:               AUDIT_ID,
      }] });  // idempotency hit — early return

    const result = await resolverEngine(baseInput);

    // The key must exist and must be null, not undefined
    expect(result).toHaveProperty('conflict_id');
    expect(result.conflict_id).toBe(null);
    expect(result.match_type).toBe('soft');
    expect(result.fan_id).toBe(FAN_ID);
    expect(result.audit_event_id).toBe(AUDIT_ID);
  });

});
