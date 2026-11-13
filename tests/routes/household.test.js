'use strict';

// Must be declared before require() of the module under test.
// jest.mock() is hoisted — intercepts the Firestore constructor
// used by household.js at module load time.
jest.mock('@google-cloud/firestore', () => ({
  Firestore: jest.fn().mockImplementation(() => ({
    collection: jest.fn().mockReturnValue({
      doc: jest.fn().mockReturnValue({
        set: jest.fn().mockResolvedValue({}),
      }),
    }),
  })),
}));

const express = require('express');
const request = require('supertest');

const CONTEXT_ORG_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_ORG_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';
const ADULT_FAN_ID   = 'cccccccc-0000-0000-0000-000000000003';
const OTHER_FAN_ID   = 'dddddddd-0000-0000-0000-000000000004';
const HOUSEHOLD_ID   = 'eeeeeeee-0000-0000-0000-000000000005';
const MINOR_FAN_ID   = 'ffffffff-0000-0000-0000-000000000006';
const MEMBER_ID      = '11111111-0000-0000-0000-000000000007';

let mockDb;

beforeEach(() => {
  jest.clearAllMocks();
  mockDb = { query: jest.fn() };
});

function buildApp(orgId = CONTEXT_ORG_ID, fanId = ADULT_FAN_ID, extraContext = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.context = {
      org_id:         orgId,
      org_name:       'Test Org',
      correlation_id: 'test-corr-id',
      fan_id:         fanId,
      ...extraContext,
    };
    req.db = mockDb;
    next();
  });
  app.use(require('../../src/routes/household'));
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Child-token router guard — router.use at top of household.js
// ─────────────────────────────────────────────────────────────────────────────
describe('child-token router guard', () => {
  // The guard fires before ANY handler, so any household route triggers it.
  // Using POST /v1/household as a representative probe.
  test('returns 403 with child guard message when acting_as is child', async () => {
    const childApp = buildApp(CONTEXT_ORG_ID, ADULT_FAN_ID, { acting_as: 'child' });
    const res = await request(childApp).post('/v1/household').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(res.body.message).toBe('child tokens cannot manage household accounts');
    expect(mockDb.query).not.toHaveBeenCalled();
  });
})

const householdRow = {
  id:           HOUSEHOLD_ID,
  org_id:       CONTEXT_ORG_ID,
  adult_fan_id: ADULT_FAN_ID,
  created_at:   new Date('2026-05-01T12:00:00Z'),
  created_by:   'fan',
};

// ─────────────────────────────────────────────────────────────────────────────
// Component 27 — POST /v1/household
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/household', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  // Call indices: 0=fan SELECT, 1=existing household SELECT,
  //               2=BEGIN, 3=household INSERT, 4=audit INSERT, 5=COMMIT
  function setupSuccessfulCreate() {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] }) // 0 — fan SELECT
      .mockResolvedValueOnce({ rows: [] })                                        // 1 — existing household SELECT
      .mockResolvedValueOnce({ rows: [] })                                        // 2 — BEGIN
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID, org_id: CONTEXT_ORG_ID, adult_fan_id: ADULT_FAN_ID, created_at: householdRow.created_at }] }) // 3 — household INSERT
      .mockResolvedValueOnce({ rows: [] })                                        // 4 — audit INSERT
      .mockResolvedValueOnce({ rows: [] });                                       // 5 — COMMIT
  }

  test('returns 201 with household_id, adult_fan_id, org_id, created_at on success', async () => {
    setupSuccessfulCreate();

    const res = await request(app).post('/v1/household').send();

    expect(res.status).toBe(201);
    expect(res.body.household_id).toBe(HOUSEHOLD_ID);
    expect(res.body.adult_fan_id).toBe(ADULT_FAN_ID);
    expect(res.body.org_id).toBe(CONTEXT_ORG_ID);
    expect(res.body.created_at).toBeDefined();
  });

  test('returns 409 with household_id in body when household already exists', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] });

    const res = await request(app).post('/v1/household').send();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('household already exists');
    expect(res.body.household_id).toBe(HOUSEHOLD_ID);
  });

  test('returns 403 when fan does not belong to org', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post('/v1/household').send();

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('fan record not found or does not belong to this org');
  });

  test('returns 403 when fan is soft-deleted', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: new Date() }] });

    const res = await request(app).post('/v1/household').send();

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('fan record has been erased — cannot create household');
  });

  test('fan query uses org_id from context — not from request body', async () => {
    setupSuccessfulCreate();

    await request(app).post('/v1/household').send();

    expect(mockDb.query.mock.calls[0][1][1]).toBe(CONTEXT_ORG_ID);
  });

  test('duplicate-check query uses org_id from context', async () => {
    setupSuccessfulCreate();

    await request(app).post('/v1/household').send();

    expect(mockDb.query.mock.calls[1][1][1]).toBe(CONTEXT_ORG_ID);
  });

  test('returns 500 with generic message on db error — no internal detail in response', async () => {
    // First call (fan SELECT) fails. Catch block calls ROLLBACK — needs a mock too.
    mockDb.query
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue({ rows: [] }); // ROLLBACK

    const res = await request(app).post('/v1/household').send();

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('household could not be created');
    expect(JSON.stringify(res.body)).not.toContain('connection refused');
  });

  // MEDIUM-2 — transaction integrity
  test('calls ROLLBACK and returns 500 when audit INSERT fails', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] }) // fan SELECT
      .mockResolvedValueOnce({ rows: [] })                                        // existing household SELECT
      .mockResolvedValueOnce({ rows: [] })                                        // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID, org_id: CONTEXT_ORG_ID, adult_fan_id: ADULT_FAN_ID, created_at: householdRow.created_at }] }) // household INSERT
      .mockRejectedValueOnce(new Error('audit constraint violation'))             // audit INSERT fails
      .mockResolvedValue({ rows: [] });                                           // ROLLBACK

    const res = await request(app).post('/v1/household').send();

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('household could not be created');

    const allSqls = mockDb.query.mock.calls.map(([sql]) => sql.toUpperCase().trim());
    expect(allSqls).toContain('ROLLBACK');
  });

  test('does not return 201 when audit INSERT fails — no household without audit trail', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID, org_id: CONTEXT_ORG_ID, adult_fan_id: ADULT_FAN_ID, created_at: householdRow.created_at }] })
      .mockRejectedValueOnce(new Error('pg: constraint violation'))
      .mockResolvedValue({ rows: [] });

    const res = await request(app).post('/v1/household').send();

    expect(res.status).not.toBe(201);
    expect(res.body.household_id).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component 29 — POST /v1/household/:adult_fan_id/members
// ─────────────────────────────────────────────────────────────────────────────

const STAGED_ID = '22222222-0000-0000-0000-000000000008';

const validBody = {
  first_name:     'Sam',
  last_name:      'Smith',
  dob:            '2015-03-10',
  guardian_email: 'guardian@example.com',
  guardian_phone: '+14155550101',
};

describe('POST /v1/household/:adult_fan_id/members', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  // Happy path: fan exists, household exists, no staged match
  // Call indices: 0=fan, 1=household, 2=staging, 3=BEGIN,
  //              4=fan INSERT, 5=name link, 6=dob link,
  //              7=guardian_email link, 8=guardian_phone link,
  //              9=household_member, 10=audit, 11=COMMIT
  function setupSuccessfulAdd() {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] }) // 0 — fan
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })                   // 1 — household
      .mockResolvedValueOnce({ rows: [] })                                        // 2 — no staging
      .mockResolvedValueOnce({ rows: [] })                                        // 3 — BEGIN
      .mockResolvedValueOnce({ rows: [{ id: MINOR_FAN_ID }] })                   // 4 — fan INSERT
      .mockResolvedValueOnce({ rows: [] })                                        // 5 — name link
      .mockResolvedValueOnce({ rows: [] })                                        // 6 — dob link
      .mockResolvedValueOnce({ rows: [] })                                        // 7 — email link
      .mockResolvedValueOnce({ rows: [] })                                        // 8 — phone link
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID }] })                      // 9 — household_member
      .mockResolvedValueOnce({ rows: [] })                                        // 10 — audit
      .mockResolvedValueOnce({ rows: [] });                                       // 11 — COMMIT
  }

  // Happy path: fan exists, household exists, staged match found
  // Call indices: 0-9 same, 10=staging UPDATE, 11=audit, 12=COMMIT
  function setupSuccessfulAddWithStagedMatch() {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] }) // 0 — fan
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })                   // 1 — household
      .mockResolvedValueOnce({ rows: [{ id: STAGED_ID }] })                      // 2 — staging match
      .mockResolvedValueOnce({ rows: [] })                                        // 3 — BEGIN
      .mockResolvedValueOnce({ rows: [{ id: MINOR_FAN_ID }] })                   // 4 — fan INSERT
      .mockResolvedValueOnce({ rows: [] })                                        // 5 — name link
      .mockResolvedValueOnce({ rows: [] })                                        // 6 — dob link
      .mockResolvedValueOnce({ rows: [] })                                        // 7 — email link
      .mockResolvedValueOnce({ rows: [] })                                        // 8 — phone link
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID }] })                      // 9 — household_member
      .mockResolvedValueOnce({ rows: [] })                                        // 10 — staging UPDATE
      .mockResolvedValueOnce({ rows: [] })                                        // 11 — audit
      .mockResolvedValueOnce({ rows: [] });                                       // 12 — COMMIT
  }

  // 1 — response shape
  test('returns 201 with all required response fields', async () => {
    setupSuccessfulAdd();

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.household_member_id).toBe(MEMBER_ID);
    expect(res.body.minor_fan_id).toBe(MINOR_FAN_ID);
    expect(res.body.adult_fan_id).toBe(ADULT_FAN_ID);
    expect(res.body.household_id).toBe(HOUSEHOLD_ID);
    expect(res.body.child_name).toBe('sam smith');
    expect(res.body.child_dob).toBe('2015-03-10');
    expect(res.body.link_type).toBe('hard');
    expect(res.body.status).toBe('active');
    expect(typeof res.body.staged_match).toBe('boolean');
    expect(res.body.created_at).toBeDefined();
  });

  // 2 — fan INSERT uses org_id from context, not body
  test('fan INSERT uses org_id from context — child fan record created in fan table', async () => {
    setupSuccessfulAdd();

    await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send({ ...validBody, org_id: 'attacker-supplied-org' });

    const fanInsertSql    = mockDb.query.mock.calls[4][0];
    const fanInsertParams = mockDb.query.mock.calls[4][1];

    expect(fanInsertSql.toUpperCase()).toContain('INSERT INTO FAN');
    expect(fanInsertParams[0]).toBe(CONTEXT_ORG_ID); // $1 — org_id from context
  });

  // 3 — identifier_link rows for name and dob
  test('identifier_link rows created for name and dob', async () => {
    setupSuccessfulAdd();

    await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send(validBody);

    const nameParams = mockDb.query.mock.calls[5][1];
    const dobParams  = mockDb.query.mock.calls[6][1];

    expect(nameParams[0]).toBe(MINOR_FAN_ID);   // $1 — fan_id
    expect(nameParams[1]).toBe('name');           // $2 — identifier_type
    expect(dobParams[0]).toBe(MINOR_FAN_ID);
    expect(dobParams[1]).toBe('dob');
  });

  // 4 — identifier_link for guardian_email with source_system fan_pass
  test('identifier_link row created for guardian_email with source_system fan_pass', async () => {
    setupSuccessfulAdd();

    await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send(validBody);

    const emailSql    = mockDb.query.mock.calls[7][0];
    const emailParams = mockDb.query.mock.calls[7][1];

    expect(emailSql).toContain('fan_pass');
    expect(emailParams[1]).toBe('guardian_email');
    expect(emailParams[2]).toBe('guardian@example.com');
  });

  // 5 — identifier_link for guardian_phone
  test('identifier_link row created for guardian_phone with source_system fan_pass', async () => {
    setupSuccessfulAdd();

    await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send(validBody);

    const phoneSql    = mockDb.query.mock.calls[8][0];
    const phoneParams = mockDb.query.mock.calls[8][1];

    expect(phoneSql).toContain('fan_pass');
    expect(phoneParams[1]).toBe('guardian_phone');
    expect(phoneParams[2]).toBe('+14155550101');
  });

  // 6 — household_member SQL contains link_type hard and status active
  test("household_member INSERT SQL specifies link_type 'hard' and status 'active'", async () => {
    setupSuccessfulAdd();

    await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send(validBody);

    const memberSql    = mockDb.query.mock.calls[9][0];
    const memberParams = mockDb.query.mock.calls[9][1];

    expect(memberSql).toContain("'hard'");
    expect(memberSql).toContain("'active'");
    // params: [$1=household_id, $2=adult_fan_id, $3=minor_fan_id, $4=org_id, $5=dob]
    expect(memberParams[1]).toBe(ADULT_FAN_ID); // $2 — adult_fan_id
    expect(memberParams[2]).toBe(MINOR_FAN_ID); // $3 — minor_fan_id
  });

  // 7 — staged_match false when no staging match
  test('staged_match is false when staging query returns no rows', async () => {
    setupSuccessfulAdd();

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send(validBody);

    expect(res.body.staged_match).toBe(false);
  });

  // 8 — staged_match true when staging match found
  test('staged_match is true when staging query returns a matching row', async () => {
    setupSuccessfulAddWithStagedMatch();

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send(validBody);

    expect(res.body.staged_match).toBe(true);
  });

  // 9 — staging UPDATE sets promoted_to = minor_fan_id
  test('staging promotion UPDATE called with minor_fan_id and staged record id on match', async () => {
    setupSuccessfulAddWithStagedMatch();

    await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send(validBody);

    // Call 10 is the staging UPDATE (after household_member at 9)
    const stagingUpdateSql    = mockDb.query.mock.calls[10][0].toUpperCase();
    const stagingUpdateParams = mockDb.query.mock.calls[10][1];

    expect(stagingUpdateSql).toContain('STAGING_HOUSEHOLD_DATA');
    expect(stagingUpdateParams[0]).toBe(MINOR_FAN_ID); // $1 — promoted_to
    expect(stagingUpdateParams[1]).toBe(STAGED_ID);    // $2 — staged record id
  });

  // 10 — 400 when first_name or last_name missing
  test('returns 400 when first_name is missing', async () => {
    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send({ ...validBody, first_name: undefined });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('first_name is required');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('returns 400 when last_name is missing', async () => {
    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send({ ...validBody, last_name: undefined });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('last_name is required');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  // 11 — 400 when dob missing
  test('returns 400 when dob is missing', async () => {
    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send({ ...validBody, dob: undefined });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('dob is required');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  // 12 — 400 when guardian_email missing (both required)
  test('returns 400 when guardian_email is missing', async () => {
    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send({ ...validBody, guardian_email: undefined });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('guardian_email is required');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('returns 400 when guardian_phone is missing', async () => {
    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send({ ...validBody, guardian_phone: undefined });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('guardian_phone is required');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  // 13 — 403 before any db call when fan_id mismatch
  test('returns 403 before any db call when JWT fan_id does not match adult_fan_id in URL', async () => {
    const otherApp = buildApp(CONTEXT_ORG_ID, OTHER_FAN_ID);

    const res = await request(otherApp)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send(validBody);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(res.body.message).toBe('token does not match requested household');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  // 14 — 404 when household does not exist (must call POST /v1/household first)
  test('returns 404 when no household exists — no household, fan, or member rows created', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] }) // READ 1 — fan found
      .mockResolvedValueOnce({ rows: [] });                                        // READ 2 — no household

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send(validBody);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('household not found');
    expect(res.body.message).toContain('POST /v1/household');
    // Only 2 db calls — no household INSERT, no fan INSERT, no household_member INSERT
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  // 15 — 404 when adult fan record not found for this org
  test('returns 404 when adult fan record not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // READ 1 — fan not found

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send(validBody);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('fan record not found');
  });

  test('fan lookup uses org_id from context — fan from different org returns 404', async () => {
    const otherOrgApp = buildApp(OTHER_ORG_ID, ADULT_FAN_ID);
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // fan not found under OTHER_ORG_ID

    const res = await request(otherOrgApp)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send(validBody);

    expect(res.status).toBe(404);
    // Verify the org_id used in the fan lookup is the context org_id (OTHER_ORG_ID)
    expect(mockDb.query.mock.calls[0][1][1]).toBe(OTHER_ORG_ID);
  });

  test('returns 500 with generic message on db error — no internal detail in response', async () => {
    mockDb.query
      .mockRejectedValueOnce(new Error('connection refused')) // READ 1 fails
      .mockResolvedValueOnce({ rows: [] });                   // ROLLBACK

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members`)
      .send(validBody);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('household member could not be created');
    expect(JSON.stringify(res.body)).not.toContain('connection refused');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component 30 — GET /v1/household/:adult_fan_id/members/:child_fan_id
// ─────────────────────────────────────────────────────────────────────────────

const memberDetailRow = {
  id:                     MEMBER_ID,
  household_id:           HOUSEHOLD_ID,
  adult_fan_id:           ADULT_FAN_ID,
  minor_fan_id:           MINOR_FAN_ID,
  org_id:                 CONTEXT_ORG_ID,
  link_type:              'hard',
  status:                 'active',
  dob:                    '2015-03-10',
  aged_up_at:             null,
  aged_up_initiated_by:   null,
  claim_token_expires_at: null,
  severed_at:             null,
  severed_by:             null,
  created_at:             new Date('2026-05-01T12:00:00Z'),
};

const identifierRows = [
  { identifier_type: 'name',           identifier_value: 'sam smith',             source_system: 'fan_pass', first_seen_at: new Date('2026-05-01T12:00:00Z') },
  { identifier_type: 'dob',            identifier_value: '2015-03-10',             source_system: 'fan_pass', first_seen_at: new Date('2026-05-01T12:00:00Z') },
  { identifier_type: 'guardian_email', identifier_value: 'guardian@example.com',  source_system: 'fan_pass', first_seen_at: new Date('2026-05-01T12:00:00Z') },
  { identifier_type: 'guardian_phone', identifier_value: '+14155550101',           source_system: 'fan_pass', first_seen_at: new Date('2026-05-01T12:00:00Z') },
];

describe('GET /v1/household/:adult_fan_id/members/:child_fan_id', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  // READ 1=fan, READ 2=household, READ 3=member, READ 4=identifiers
  function setupSuccessfulFetch() {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })  // READ 1 — fan
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })                     // READ 2 — household
      .mockResolvedValueOnce({ rows: [memberDetailRow] })                           // READ 3 — member
      .mockResolvedValueOnce({ rows: identifierRows });                             // READ 4 — identifiers
  }

  // 1 — full member record with all household_member fields
  test('returns 200 with all household_member fields in response', async () => {
    setupSuccessfulFetch();

    const res = await request(app)
      .get(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.household_member_id).toBe(MEMBER_ID);
    expect(res.body.minor_fan_id).toBe(MINOR_FAN_ID);
    expect(res.body.adult_fan_id).toBe(ADULT_FAN_ID);
    expect(res.body.household_id).toBe(HOUSEHOLD_ID);
    expect(res.body.org_id).toBe(CONTEXT_ORG_ID);
    expect(res.body.link_type).toBe('hard');
    expect(res.body.status).toBe('active');
    expect(res.body.dob).toBe('2015-03-10');
    expect(res.body.aged_up_at).toBeNull();
    expect(res.body.aged_up_initiated_by).toBeNull();
    expect(res.body.claim_token_expires_at).toBeNull();
    expect(res.body.severed_at).toBeNull();
    expect(res.body.severed_by).toBeNull();
    expect(res.body.created_at).toBeDefined();
  });

  // 2 — identifiers array shape and content
  test('returns identifiers array with all child identifier_link rows mapped correctly', async () => {
    setupSuccessfulFetch();

    const res = await request(app)
      .get(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(Array.isArray(res.body.identifiers)).toBe(true);
    expect(res.body.identifiers).toHaveLength(4);

    const nameId = res.body.identifiers.find(i => i.identifier_type === 'name');
    expect(nameId.identifier_value).toBe('sam smith');
    expect(nameId.source).toBe('fan_pass');
    expect(nameId.created_at).toBeDefined();

    const emailId = res.body.identifiers.find(i => i.identifier_type === 'guardian_email');
    expect(emailId.identifier_value).toBe('guardian@example.com');
    expect(emailId.source).toBe('fan_pass');
  });

  // 3 — 403 fires before any db call when JWT fan_id != adult_fan_id in URL
  test('returns 403 before any db call when JWT fan_id does not match adult_fan_id in URL', async () => {
    const otherApp = buildApp(CONTEXT_ORG_ID, OTHER_FAN_ID);

    const res = await request(otherApp)
      .get(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(res.body.message).toBe('token does not match requested household');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  // 4 — 404 when adult fan not found (READ 1)
  test('returns 404 when adult fan not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // READ 1 — fan not found

    const res = await request(app)
      .get(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('fan not found');
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  // 5 — 404 when household not found (READ 2)
  test('returns 404 when household not found for this adult', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] }) // READ 1 — fan found
      .mockResolvedValueOnce({ rows: [] });                                         // READ 2 — no household

    const res = await request(app)
      .get(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('household not found');
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  // 6 — 404 when household_member not found (READ 3)
  test('returns 404 when household member not found', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] }) // READ 1 — fan
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })                     // READ 2 — household
      .mockResolvedValueOnce({ rows: [] });                                         // READ 3 — no member

    const res = await request(app)
      .get(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('household member not found');
    expect(mockDb.query).toHaveBeenCalledTimes(3);
  });

  // 7 — 404 when member status is not active (severed/aged_up returns empty from SQL)
  test('returns 404 when member exists but status is severed — status filter in SQL excludes non-active', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] }) // READ 1 — fan
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })                     // READ 2 — household
      .mockResolvedValueOnce({ rows: [] }); // READ 3 — SQL WHERE status='active' returns nothing for severed row

    const res = await request(app)
      .get(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('household member not found');
  });

  // 8 — org isolation — org_id from context used in all queries
  test('org_id from context used in all queries — member from different org returns 404', async () => {
    const otherOrgApp = buildApp(OTHER_ORG_ID, ADULT_FAN_ID);
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // READ 1 — fan not found under OTHER_ORG_ID

    const res = await request(otherOrgApp)
      .get(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(404);
    expect(mockDb.query.mock.calls[0][1][1]).toBe(OTHER_ORG_ID);
  });

  // 9 — claim_token value never in response — only claim_token_expires_at
  test('claim_token value never appears in response — only claim_token_expires_at is returned', async () => {
    setupSuccessfulFetch();

    const res = await request(app)
      .get(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('"claim_token"');
    expect(res.body).not.toHaveProperty('claim_token');
    expect(res.body.claim_token_expires_at).toBeNull();
  });

  test('returns 400 for non-UUID adult_fan_id', async () => {
    const res = await request(app)
      .get(`/v1/household/not-a-uuid/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('adult_fan_id must be a valid UUID');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('returns 400 for non-UUID child_fan_id', async () => {
    const res = await request(app)
      .get(`/v1/household/${ADULT_FAN_ID}/members/not-a-uuid`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('child_fan_id must be a valid UUID');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('returns 403 when fan is soft-deleted', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: new Date() }] });

    const res = await request(app)
      .get(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('fan account is inactive');
  });

  test('READ 3 SQL contains status = active filter — soft links and severed members excluded', async () => {
    setupSuccessfulFetch();

    await request(app)
      .get(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    const memberSql = mockDb.query.mock.calls[2][0];
    expect(memberSql).toContain("status       = 'active'");
  });

  test('READ 4 SQL does not filter by identifier_type — returns all rows', async () => {
    setupSuccessfulFetch();

    await request(app)
      .get(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    const identifierSql = mockDb.query.mock.calls[3][0].toUpperCase();
    expect(identifierSql).not.toContain('IDENTIFIER_TYPE IN');
    expect(identifierSql).not.toContain("IDENTIFIER_TYPE =");
  });

  test('returns 500 with generic message on db error — no internal detail in response', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('relation "fan" does not exist'));

    const res = await request(app)
      .get(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('household member could not be retrieved');
    expect(JSON.stringify(res.body)).not.toContain('relation');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component 31 — PUT /v1/household/:adult_fan_id/members/:child_fan_id
// ─────────────────────────────────────────────────────────────────────────────

describe('PUT /v1/household/:adult_fan_id/members/:child_fan_id', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  // Mocks READ 1 (fan), READ 2 (household), READ 3 (member).
  // Remaining calls (BEGIN, upserts, audit, COMMIT) resolved with { rows: [] }.
  function setupReads() {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, minor_fan_id: MINOR_FAN_ID }] })
      .mockResolvedValue({ rows: [] });
  }

  // 1 — updates child_name when first_name + last_name provided
  test('updates child_name identifier_link row when first_name and last_name provided', async () => {
    setupReads();

    const res = await request(app)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ first_name: 'Alex', last_name: 'Smith' });

    expect(res.status).toBe(200);
    expect(res.body.household_member_id).toBe(MEMBER_ID);
    expect(res.body.minor_fan_id).toBe(MINOR_FAN_ID);
    expect(res.body.adult_fan_id).toBe(ADULT_FAN_ID);
    expect(res.body.updated_fields).toContain('child_name');
    expect(res.body.updated_at).toBeDefined();

    const upsertCall = mockDb.query.mock.calls.find(
      ([sql]) => sql.includes("'name'") && sql.includes('ON CONFLICT')
    );
    expect(upsertCall).toBeDefined();
    expect(upsertCall[1][0]).toBe(MINOR_FAN_ID);
    expect(upsertCall[1][1]).toBe('alex smith'); // normalizer lowercases
    expect(upsertCall[1][2]).toBe(CONTEXT_ORG_ID);
  });

  // 2 — updates dob identifier_link AND household_member.dob when child_dob provided
  test('updates dob identifier_link row and household_member.dob when child_dob provided', async () => {
    setupReads();

    const res = await request(app)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ dob: '2016-07-22' });

    expect(res.status).toBe(200);
    expect(res.body.updated_fields).toEqual(['child_dob']);

    const dobUpsert = mockDb.query.mock.calls.find(
      ([sql]) => sql.includes("'dob'") && sql.includes('ON CONFLICT')
    );
    expect(dobUpsert).toBeDefined();
    expect(dobUpsert[1][1]).toBe('2016-07-22');

    const dobUpdate = mockDb.query.mock.calls.find(
      ([sql]) => sql.includes('UPDATE household_member') && sql.includes('dob')
    );
    expect(dobUpdate).toBeDefined();
    expect(dobUpdate[1][0]).toBe('2016-07-22');
    expect(dobUpdate[1][1]).toBe(MEMBER_ID);
  });

  // 3 — updates guardian_email when provided
  test('updates guardian_email identifier_link row when guardian_email provided', async () => {
    setupReads();

    const res = await request(app)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ guardian_email: 'new@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.updated_fields).toEqual(['guardian_email']);

    const emailUpsert = mockDb.query.mock.calls.find(
      ([sql]) => sql.includes("'guardian_email'") && sql.includes('ON CONFLICT')
    );
    expect(emailUpsert).toBeDefined();
    expect(emailUpsert[1][1]).toBe('new@example.com');
  });

  // 4 — updates guardian_phone when provided
  test('updates guardian_phone identifier_link row when guardian_phone provided', async () => {
    setupReads();

    const res = await request(app)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ guardian_phone: '415-555-0199' });

    expect(res.status).toBe(200);
    expect(res.body.updated_fields).toEqual(['guardian_phone']);

    const phoneUpsert = mockDb.query.mock.calls.find(
      ([sql]) => sql.includes("'guardian_phone'") && sql.includes('ON CONFLICT')
    );
    expect(phoneUpsert).toBeDefined();
    expect(phoneUpsert[1][1]).toBe('+14155550199'); // E.164 normalized
  });

  // 5 — partial update — only provided fields change
  test('partial update — only provided fields are upserted, unprovided fields are not touched', async () => {
    setupReads();

    const res = await request(app)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ guardian_email: 'only@example.com' });

    expect(res.status).toBe(200);

    const allSqls = mockDb.query.mock.calls.map(([sql]) => sql);
    expect(allSqls.find(s => s.includes("'name'") && s.includes('ON CONFLICT'))).toBeUndefined();
    expect(allSqls.find(s => s.includes("'dob'") && s.includes('ON CONFLICT'))).toBeUndefined();
    expect(allSqls.find(s => s.includes("'guardian_phone'") && s.includes('ON CONFLICT'))).toBeUndefined();
    expect(allSqls.find(s => s.includes('UPDATE household_member') && s.includes('dob'))).toBeUndefined();
    expect(allSqls.find(s => s.includes("'guardian_email'") && s.includes('ON CONFLICT'))).toBeDefined();
  });

  // 6 — updated_fields array contains only the fields that changed
  test('updated_fields array contains exactly the fields that were updated', async () => {
    setupReads();

    const res = await request(app)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ guardian_email: 'a@example.com', guardian_phone: '415-555-0100' });

    expect(res.status).toBe(200);
    expect(res.body.updated_fields).toHaveLength(2);
    expect(res.body.updated_fields).toContain('guardian_email');
    expect(res.body.updated_fields).toContain('guardian_phone');
    expect(res.body.updated_fields).not.toContain('child_name');
    expect(res.body.updated_fields).not.toContain('child_dob');
  });

  // 7 — 400 when no editable fields provided
  test('returns 400 when no editable fields provided — no db calls made', async () => {
    const res = await request(app)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no editable fields provided');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  // 8 — 400 when child_dob is invalid date format
  test('returns 400 when child_dob is invalid date format — no db calls made', async () => {
    const res = await request(app)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ dob: 'not-a-date' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation failed');
    expect(res.body.detail).toBeDefined();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  // 9 — 400 when guardian_email is invalid format
  test('returns 400 when guardian_email is invalid format — no db calls made', async () => {
    const res = await request(app)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ guardian_email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation failed');
    expect(res.body.detail).toBeDefined();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  // 10 — 403 when JWT fan_id does not match adult_fan_id
  test('returns 403 before any db call when JWT fan_id does not match adult_fan_id', async () => {
    const otherApp = buildApp(CONTEXT_ORG_ID, OTHER_FAN_ID);

    const res = await request(otherApp)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ guardian_email: 'new@example.com' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(res.body.message).toBe('token does not match requested household');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  // 11 — 404 when household member not found
  test('returns 404 when household member not found', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })
      .mockResolvedValueOnce({ rows: [] }); // member not found

    const res = await request(app)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ guardian_email: 'new@example.com' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('household member not found');
    expect(mockDb.query).toHaveBeenCalledTimes(3);
  });

  // 12 — 404 when member status is not active
  test('returns 404 when member status is not active — WHERE status=active excludes severed and aged_up rows', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })
      .mockResolvedValueOnce({ rows: [] }); // severed row excluded by SQL WHERE status = 'active'

    const res = await request(app)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ guardian_email: 'new@example.com' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('household member not found');

    const memberSql = mockDb.query.mock.calls[2][0];
    expect(memberSql).toContain("status = 'active'");
  });

  // 13 — org_id from context enforced — different org returns 404
  test('org_id from context used in all queries — member from different org returns 404', async () => {
    const otherOrgApp = buildApp(OTHER_ORG_ID, ADULT_FAN_ID);
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // fan not found under OTHER_ORG_ID

    const res = await request(otherOrgApp)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ guardian_email: 'new@example.com' });

    expect(res.status).toBe(404);
    expect(mockDb.query.mock.calls[0][1][1]).toBe(OTHER_ORG_ID);
  });

  // 14 — ON CONFLICT upsert SQL shape verified
  test('identifier_link updated via ON CONFLICT upsert — SQL contains DO UPDATE SET with correct columns', async () => {
    setupReads();

    await request(app)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ first_name: 'Sam', last_name: 'Updated' });

    const upsertSql = mockDb.query.mock.calls.find(
      ([sql]) => sql.includes("'name'") && sql.includes('ON CONFLICT')
    )?.[0];
    expect(upsertSql).toBeDefined();
    expect(upsertSql).toContain('ON CONFLICT (fan_id, identifier_type, org_id)');
    expect(upsertSql).toContain('DO UPDATE SET');
    expect(upsertSql).toContain('identifier_value = EXCLUDED.identifier_value');
    expect(upsertSql).toContain('last_seen_at');
  });

  // 500 — generic error, no internals in response, ROLLBACK called
  test('returns 500 with generic message on db error — no internal detail in response', async () => {
    mockDb.query
      .mockRejectedValueOnce(new Error('connection refused')) // fan READ 1 fails
      .mockResolvedValueOnce({ rows: [] });                   // ROLLBACK

    const res = await request(app)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ guardian_email: 'new@example.com' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('household member could not be updated');
    expect(JSON.stringify(res.body)).not.toContain('connection refused');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component 32 — DELETE /v1/household/:adult_fan_id/members/:child_fan_id
// ─────────────────────────────────────────────────────────────────────────────

describe('DELETE /v1/household/:adult_fan_id/members/:child_fan_id', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  // Call sequence: 0=fan READ1, 1=household READ2, 2=member READ3,
  //               3=BEGIN, 4=UPDATE RETURNING, 5=audit, 6=COMMIT
  const SEVERED_AT = new Date('2026-05-31T23:30:00.000Z');

  function setupSuccessfulSever() {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })  // 0 — fan
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })                     // 1 — household
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, status: 'active' }] })      // 2 — member
      .mockResolvedValueOnce({ rows: [] })                                          // 3 — BEGIN
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, minor_fan_id: MINOR_FAN_ID, severed_at: SEVERED_AT, severed_by: 'guardian' }] }) // 4 — UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [] })                                          // 5 — audit
      .mockResolvedValueOnce({ rows: [] });                                         // 6 — COMMIT
  }

  // 1 — household_member status set to 'severed' — UPDATE SQL and response
  test("sets household_member status to 'severed' — UPDATE SQL and response body both confirm", async () => {
    setupSuccessfulSever();

    const res = await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('severed');

    const updateCall = mockDb.query.mock.calls.find(
      ([sql]) => sql.toUpperCase().includes('UPDATE HOUSEHOLD_MEMBER')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toContain("'severed'");
  });

  // 2 — severed_at timestamp is set in response
  test('severed_at timestamp is present and non-null in response', async () => {
    setupSuccessfulSever();

    const res = await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.severed_at).toBeDefined();
    expect(res.body.severed_at).not.toBeNull();
  });

  // 3 — severed_by is 'guardian'
  test("severed_by is 'guardian' in UPDATE SQL and response", async () => {
    setupSuccessfulSever();

    const res = await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.severed_by).toBe('guardian');

    const updateCall = mockDb.query.mock.calls.find(
      ([sql]) => sql.toUpperCase().includes('UPDATE HOUSEHOLD_MEMBER')
    );
    expect(updateCall[0]).toContain("'guardian'");
  });

  // 4 — child fan record is untouched — no UPDATE on fan table
  test('child fan record is untouched — no UPDATE on fan table after sever', async () => {
    setupSuccessfulSever();

    await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    const allSqls = mockDb.query.mock.calls.map(([sql]) => sql.toUpperCase());
    // Match only UPDATEs that target the fan table directly, not household_member which contains MINOR_FAN_ID
    const fanUpdates = allSqls.filter(s => /UPDATE\s+FAN[\s\n]/.test(s));
    expect(fanUpdates).toHaveLength(0);
  });

  // 5 — identifier_link rows are untouched — no DELETE on identifier_link
  test('identifier_link rows are not deleted or modified after sever', async () => {
    setupSuccessfulSever();

    await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    const allSqls = mockDb.query.mock.calls.map(([sql]) => sql.toUpperCase());
    const identifierChanges = allSqls.filter(
      s => s.includes('IDENTIFIER_LINK') && (s.includes('DELETE') || s.includes('UPDATE'))
    );
    expect(identifierChanges).toHaveLength(0);
  });

  // 6 — no related_fans row written — severance is not a permanently recorded relationship
  test('no related_fans row written — severance is not recorded in related_fans table', async () => {
    setupSuccessfulSever();

    await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    const allSqls = mockDb.query.mock.calls.map(([sql]) => sql.toUpperCase());
    const relatedFansCalls = allSqls.filter(s => s.includes('RELATED_FANS'));
    expect(relatedFansCalls).toHaveLength(0);
  });

  // 7 — audit event written with event_type household_member_severed
  test("audit event written with event_type 'household_member_severed' — always last write", async () => {
    setupSuccessfulSever();

    await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    const auditCall = mockDb.query.mock.calls.find(
      ([sql]) => sql.includes('audit_log') && sql.includes('household_member_severed')
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[1][0]).toBe(ADULT_FAN_ID); // adult fan_id in audit
    expect(auditCall[1][1]).toBe(CONTEXT_ORG_ID);
  });

  // 8 — 403 before any db call when JWT fan_id does not match adult_fan_id
  test('returns 403 before any db call when JWT fan_id does not match adult_fan_id in URL', async () => {
    const otherApp = buildApp(CONTEXT_ORG_ID, OTHER_FAN_ID);

    const res = await request(otherApp)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(res.body.message).toBe('token does not match requested household');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  // 9 — 404 when household member not found
  test('returns 404 when household member does not exist', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] }) // fan
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })                     // household
      .mockResolvedValueOnce({ rows: [] });                                         // member not found

    const res = await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('household member not found');
    expect(mockDb.query).toHaveBeenCalledTimes(3);
  });

  // 10 — 409 when member status is already severed
  test("returns 409 when member status is 'severed' — already severed", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, status: 'severed' }] });

    const res = await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('member is not active');
    expect(mockDb.query).toHaveBeenCalledTimes(3);
  });

  // 11 — 409 when member status is aged_up
  test("returns 409 when member status is 'aged_up' — aged-up member cannot be severed", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, status: 'aged_up' }] });

    const res = await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('member is not active');
    expect(mockDb.query).toHaveBeenCalledTimes(3);
  });

  // 12 — org isolation — member from different org returns 404
  test('org_id from context used in all queries — member from different org returns 404', async () => {
    const otherOrgApp = buildApp(OTHER_ORG_ID, ADULT_FAN_ID);
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // fan not found under OTHER_ORG_ID

    const res = await request(otherOrgApp)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(404);
    expect(mockDb.query.mock.calls[0][1][1]).toBe(OTHER_ORG_ID);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  // 13 — 409 when member already severed — no writes made after status check
  test('second sever attempt returns 409 — no BEGIN, UPDATE, or COMMIT called after status check', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, status: 'severed' }] });

    const res = await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(409);

    const allSqls = mockDb.query.mock.calls.map(([sql]) => sql.toUpperCase());
    expect(allSqls.find(s => s === 'BEGIN')).toBeUndefined();
    expect(allSqls.find(s => s.includes('UPDATE HOUSEHOLD_MEMBER'))).toBeUndefined();
    expect(allSqls.find(s => s === 'COMMIT')).toBeUndefined();
  });

  test('returns 400 for non-UUID adult_fan_id', async () => {
    const res = await request(app)
      .delete(`/v1/household/not-a-uuid/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('adult_fan_id must be a valid UUID');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('returns 400 for non-UUID child_fan_id', async () => {
    const res = await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/not-a-uuid`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('child_fan_id must be a valid UUID');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('returns 403 when fan is soft-deleted', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: new Date() }] });

    const res = await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('fan account is inactive');
  });

  test('returns 404 when household not found for this adult', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [] }); // no household

    const res = await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('household not found');
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  test('returns 500 with generic message on db error — no internal detail in response', async () => {
    mockDb.query
      .mockRejectedValueOnce(new Error('connection refused')) // READ 1 fails
      .mockResolvedValueOnce({ rows: [] });                   // ROLLBACK

    const res = await request(app)
      .delete(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('household member could not be severed');
    expect(JSON.stringify(res.body)).not.toContain('connection refused');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component 33 — POST /v1/household/:adult_fan_id/members/:child_fan_id/session
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/household/:adult_fan_id/members/:child_fan_id/session', () => {
  let app;
  const jwtLib = require('jsonwebtoken');

  beforeEach(() => {
    app = buildApp();
  });

  // READ 1=fan, READ 2=household, READ 3=member, WRITE 4=audit INSERT
  function setupSuccessfulSession() {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })               // READ 1 — adult fan
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })                                  // READ 2 — household
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, minor_fan_id: MINOR_FAN_ID }] })        // READ 3 — member
      .mockResolvedValueOnce({ rows: [] });                                                      // WRITE 4 — audit INSERT
  }

  // 1 — issued token passes verifyToken without throwing
  test('issued token passes verifyToken without throwing', async () => {
    setupSuccessfulSession();
    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/session`);
    expect(res.status).toBe(200);
    const { verifyToken } = require('../../src/modules/jwt');
    expect(() => verifyToken(`Bearer ${res.body.token}`)).not.toThrow();
  });

  // 2 — token sub claim equals minor_fan_id
  test('token sub claim equals minor_fan_id', async () => {
    setupSuccessfulSession();
    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/session`);
    expect(res.status).toBe(200);
    const decoded = jwtLib.decode(res.body.token);
    expect(decoded.sub).toBe(MINOR_FAN_ID);
  });

  // 3 — token org claim equals org_id from context
  test('token org claim equals org_id from context', async () => {
    setupSuccessfulSession();
    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/session`);
    expect(res.status).toBe(200);
    const decoded = jwtLib.decode(res.body.token);
    expect(decoded.org).toBe(CONTEXT_ORG_ID);
  });

  // 4 — token expiry is exactly 8 hours (28800 seconds) from issue
  test('token expiry is exactly 8 hours from issue', async () => {
    setupSuccessfulSession();
    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/session`);
    expect(res.status).toBe(200);
    const decoded = jwtLib.decode(res.body.token);
    expect(decoded.exp - decoded.iat).toBe(8 * 60 * 60);
  });

  // 5 — token acting_as claim equals 'child'
  test("token acting_as claim equals 'child'", async () => {
    setupSuccessfulSession();
    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/session`);
    expect(res.status).toBe(200);
    const decoded = jwtLib.decode(res.body.token);
    expect(decoded.acting_as).toBe('child');
  });

  // 6 — token guardian claim equals adult_fan_id
  test('token guardian claim equals adult_fan_id', async () => {
    setupSuccessfulSession();
    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/session`);
    expect(res.status).toBe(200);
    const decoded = jwtLib.decode(res.body.token);
    expect(decoded.guardian).toBe(ADULT_FAN_ID);
  });

  // 7 — token algorithm is RS256
  test('token algorithm is RS256', async () => {
    setupSuccessfulSession();
    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/session`);
    expect(res.status).toBe(200);
    const { header } = jwtLib.decode(res.body.token, { complete: true });
    expect(header.alg).toBe('RS256');
  });

  // 8 — existing signToken 15-minute default unchanged after expiresIn extension
  test('signToken 15-minute default is unchanged when expiresIn is not provided', () => {
    const { signToken: sign } = require('../../src/modules/jwt');
    const result  = sign({ fan_id: ADULT_FAN_ID, org_id: CONTEXT_ORG_ID });
    const decoded = jwtLib.decode(result.token);
    expect(decoded.exp - decoded.iat).toBe(15 * 60);
  });

  // 9 — 403 before any db call when JWT fan_id does not match adult_fan_id in URL
  test('returns 403 before any db call when JWT fan_id does not match adult_fan_id in URL', async () => {
    const otherApp = buildApp(CONTEXT_ORG_ID, OTHER_FAN_ID);
    const res = await request(otherApp)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/session`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(res.body.message).toBe('token does not match requested household');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  // 10 — 404 when household member does not exist
  test('returns 404 when household member does not exist', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] }) // fan
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })                    // household
      .mockResolvedValueOnce({ rows: [] });                                        // member not found
    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/session`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('household member not found');
    expect(mockDb.query).toHaveBeenCalledTimes(3);
  });

  // 11 — 404 when member status is not active — SQL filter on status='active' excludes severed/aged_up
  test("returns 404 when member status is not active — SQL WHERE status='active' returns empty row", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] }) // fan
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })                    // household
      .mockResolvedValueOnce({ rows: [] }); // severed/aged_up member excluded by SQL filter
    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/session`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('household member not found');
    const memberSql = mockDb.query.mock.calls[2][0];
    expect(memberSql).toContain("status = 'active'");
  });

  // 12 — org isolation — member from different org cannot get a child session
  test('org_id from context enforced — member from different org returns 404', async () => {
    const otherOrgApp = buildApp(OTHER_ORG_ID, ADULT_FAN_ID);
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // fan not found under OTHER_ORG_ID
    const res = await request(otherOrgApp)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/session`);
    expect(res.status).toBe(404);
    expect(mockDb.query.mock.calls[0][1][1]).toBe(OTHER_ORG_ID);
  });

  // ROUGH-3: tests 13-15 — child session audit event
  test('ROUGH-3: POST session writes audit_log INSERT after signToken', async () => {
    setupSuccessfulSession();
    await request(app).post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/session`);
    const auditCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO audit_log')
    );
    expect(auditCall).toBeDefined();
  });

  test('ROUGH-3: audit event_type is child_session_issued', async () => {
    setupSuccessfulSession();
    await request(app).post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/session`);
    const auditCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO audit_log')
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[0]).toContain('child_session_issued');
  });

  test('ROUGH-3: audit event fan_id is minor_fan_id not adult_fan_id', async () => {
    setupSuccessfulSession();
    await request(app).post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/session`);
    const auditCall = mockDb.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO audit_log')
    );
    expect(auditCall).toBeDefined();
    // $1 = fan_id (child), $2 = org_id
    expect(auditCall[1][0]).toBe(MINOR_FAN_ID);
    expect(auditCall[1][0]).not.toBe(ADULT_FAN_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pre-presentation fix verification tests
// BUG-1, BUG-2, BUG-4, ROUGH-1
// ─────────────────────────────────────────────────────────────────────────────

describe('BUG-1: GET /v1/household NaN limit/offset guards', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  test('BUG-1: ?limit=abc returns 400 — NaN does not reach Postgres', async () => {
    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}?limit=abc`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('BUG-1: ?offset=abc returns 400 — NaN does not reach Postgres', async () => {
    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}?offset=abc`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('BUG-1: valid limit and offset passes guards and reaches DB', async () => {
    // Mock fan found, no household → 200 with empty household
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, org_id: CONTEXT_ORG_ID, stewardship_tier: 'platform', record_version: 1, created_at: new Date() }] })
      .mockResolvedValueOnce({ rows: [] }); // no household

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}?limit=3&offset=0`);

    expect(res.status).toBe(200);
    expect(mockDb.query).toHaveBeenCalled();
  });
});

describe('BUG-2: PUT household member ON CONFLICT WHERE source_system', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  test('BUG-2: all four ON CONFLICT clauses in PUT handler include WHERE source_system', () => {
    const fs     = require('fs');
    const source = fs.readFileSync(
      require.resolve('../../src/routes/household.js'), 'utf8'
    );
    // Count how many ON CONFLICT clauses exist in the file
    const allConflicts = (source.match(/ON CONFLICT \(fan_id, identifier_type, org_id\)/g) || []).length;
    // Count how many have the WHERE source_system predicate
    const correctConflicts = (source.match(/ON CONFLICT \(fan_id, identifier_type, org_id\)\s+WHERE source_system = 'fan_pass'/g) || []).length;
    // All ON CONFLICT clauses in household.js are in the PUT handler — all four must have WHERE
    expect(allConflicts).toBe(4);
    expect(correctConflicts).toBe(4);
  });

  test('BUG-2: PUT member success path completes without ON CONFLICT error', async () => {
    // Full mock chain for PUT: fan, household, member, name lookup,
    // BEGIN, 4 identifier upserts, dob update on member, audit, COMMIT
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })                       // fan
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })                                          // household
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, minor_fan_id: MINOR_FAN_ID }] })                // member
      .mockResolvedValueOnce({ rows: [{ identifier_value: 'sam smith' }] })                             // existing name lookup
      .mockResolvedValue({ rows: [] });                                                                  // BEGIN + upserts + audit + COMMIT

    const res = await request(app)
      .put(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}`)
      .send({ first_name: 'Sam', dob: '2015-03-10', guardian_email: 'parent@example.com', guardian_phone: '+14055550100' });

    expect(res.status).toBe(200);
  });
});

describe('BUG-4: household.js Firestore client initialization', () => {
  test('BUG-4: Firestore constructor invocation in source includes databaseId golden-record', () => {
    // Source inspection — jest.clearAllMocks() in beforeEach wipes call history
    // before the test runs, making toHaveBeenCalledWith unreliable for module-load calls.
    // Reading the source directly is authoritative and not subject to mock state.
    const fs     = require('fs');
    const source = fs.readFileSync(
      require.resolve('../../src/routes/household.js'), 'utf8'
    );
    expect(source).toContain("databaseId: 'golden-record'");
    expect(source).toContain('new Firestore(');
  });

  test('BUG-4: collection name used is golden-record not fans', () => {
    const fs     = require('fs');
    const source = fs.readFileSync(
      require.resolve('../../src/routes/household.js'), 'utf8'
    );
    expect(source).toContain("collection('golden-record')");
    expect(source).not.toContain("collection('fans')");
  });

  test('BUG-4: req.firestore is not referenced anywhere in household.js', () => {
    const fs     = require('fs');
    const source = fs.readFileSync(
      require.resolve('../../src/routes/household.js'), 'utf8'
    );
    expect(source).not.toContain('req.firestore');
  });
});

describe('ROUGH-1: consistent 4xx error response shape', () => {
  let app;
  beforeEach(() => { app = buildApp(); });

  test('ROUGH-1: GET /v1/household/not-a-uuid returns 400 with error field', async () => {
    const res = await request(app).get('/v1/household/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('ROUGH-1: PUT /v1/household/not-a-uuid/members/... returns 400 with error field', async () => {
    const res = await request(app)
      .put('/v1/household/not-a-uuid/members/not-a-uuid')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('ROUGH-1: DELETE /v1/household/not-a-uuid/members/... returns 400 with error field', async () => {
    const res = await request(app)
      .delete('/v1/household/not-a-uuid/members/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('ROUGH-1: no 4xx response has message field without error field', async () => {
    // JWT mismatch 403 — has both error and message fields
    const res = await request(buildApp(CONTEXT_ORG_ID, OTHER_FAN_ID))
      .get(`/v1/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('error');
    expect(res.body).toHaveProperty('message');
    // The invariant: message field never appears without error field
    if (res.body.message !== undefined) {
      expect(res.body).toHaveProperty('error');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component 34 — POST /v1/household/:adult_fan_id/members/:child_fan_id/age-up
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/household/:adult_fan_id/members/:child_fan_id/age-up', () => {
  let app;
  const AGED_UP_AT    = new Date('2026-06-01T12:00:00.000Z');
  const CLAIM_EXPIRES = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  beforeEach(() => {
    app = buildApp();
  });

  // Call sequence: 0=fan, 1=household, 2=member (no status filter),
  //               3=guardian_email, 4=BEGIN,
  //               5=UPDATE RETURNING, 6=related_fans INSERT,
  //               7=audit_log INSERT, 8=COMMIT
  function setupSuccessfulAgeUp() {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })  // 0 — fan
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })                     // 1 — household
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, minor_fan_id: MINOR_FAN_ID, status: 'active' }] }) // 2 — member
      .mockResolvedValueOnce({ rows: [{ identifier_value: 'guardian@example.com' }] }) // 3 — guardian_email
      .mockResolvedValueOnce({ rows: [] })                                          // 4 — BEGIN
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, minor_fan_id: MINOR_FAN_ID, aged_up_at: AGED_UP_AT, aged_up_initiated_by: 'guardian', claim_token_expires_at: CLAIM_EXPIRES }] }) // 5 — UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [] })                                          // 6 — related_fans
      .mockResolvedValueOnce({ rows: [] })                                          // 7 — audit_log
      .mockResolvedValueOnce({ rows: [] });                                         // 8 — COMMIT
  }

  // 1 — household_member status set to aged_up in DB
  test("sets household_member status to 'aged_up' — UPDATE SQL and response body both confirm", async () => {
    setupSuccessfulAgeUp();

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('aged_up');

    const updateCall = mockDb.query.mock.calls.find(
      ([sql]) => sql.toUpperCase().includes('UPDATE HOUSEHOLD_MEMBER')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[0]).toContain("'aged_up'");
    expect(updateCall[1][2]).toBe(MEMBER_ID); // $3 — WHERE id = member.id
  });

  // 2 — aged_up_at timestamp is set
  test('aged_up_at timestamp is present and non-null in response', async () => {
    setupSuccessfulAgeUp();

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    expect(res.status).toBe(200);
    expect(res.body.aged_up_at).toBeDefined();
    expect(res.body.aged_up_at).not.toBeNull();
  });

  // 3 — aged_up_initiated_by is 'guardian'
  test("aged_up_initiated_by is 'guardian' in UPDATE SQL and response", async () => {
    setupSuccessfulAgeUp();

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    expect(res.status).toBe(200);
    expect(res.body.aged_up_initiated_by).toBe('guardian');

    const updateCall = mockDb.query.mock.calls.find(
      ([sql]) => sql.toUpperCase().includes('UPDATE HOUSEHOLD_MEMBER')
    );
    expect(updateCall[0]).toContain("'guardian'");
  });

  // 4 — claim_token in DB is sha256 hex — NOT the raw UUID token
  test('claim_token stored in DB is sha256 hex string — not raw UUID token', async () => {
    setupSuccessfulAgeUp();

    await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    const updateCall = mockDb.query.mock.calls.find(
      ([sql]) => sql.toUpperCase().includes('UPDATE HOUSEHOLD_MEMBER')
    );
    const tokenHash = updateCall[1][0]; // $1 — claim_token = token_hash

    // sha256 hex is exactly 64 lowercase hex characters, no dashes
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // raw token is two UUIDs concatenated — always contains dashes
    expect(tokenHash).not.toContain('-');
  });

  // 5 — claim_token_expires_at is ~30 days from now
  test('claim_token_expires_at passed to DB is approximately 30 days from now', async () => {
    setupSuccessfulAgeUp();

    const before = Date.now();

    await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    const updateCall = mockDb.query.mock.calls.find(
      ([sql]) => sql.toUpperCase().includes('UPDATE HOUSEHOLD_MEMBER')
    );
    const expiresAt       = updateCall[1][1]; // $2 — claim_token_expires_at
    const thirtyDaysMs    = 30 * 24 * 60 * 60 * 1000;
    const diff            = expiresAt.getTime() - before;

    expect(diff).toBeGreaterThanOrEqual(thirtyDaysMs - 1000);
    expect(diff).toBeLessThanOrEqual(thirtyDaysMs + 60000);
  });

  // 6 — related_fans row written with relationship aged_up and source household
  test("related_fans INSERT written with relationship 'aged_up', source 'household', correct fan IDs", async () => {
    setupSuccessfulAgeUp();

    await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    const relatedCall = mockDb.query.mock.calls.find(
      ([sql]) => sql.toUpperCase().includes('RELATED_FANS')
    );
    expect(relatedCall).toBeDefined();
    expect(relatedCall[0]).toContain("'aged_up'");
    expect(relatedCall[0]).toContain("'household'");
    expect(relatedCall[1][0]).toBe(ADULT_FAN_ID);   // $1 — fan_id_a = adult
    expect(relatedCall[1][1]).toBe(MINOR_FAN_ID);   // $2 — fan_id_b = minor
    expect(relatedCall[1][2]).toBe(CONTEXT_ORG_ID); // $3 — org_id
  });

  // 7 — audit event with event_type household_member_aged_up — last write before COMMIT
  test("audit event written with event_type 'household_member_aged_up' — immediately before COMMIT", async () => {
    setupSuccessfulAgeUp();

    await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    const auditCall = mockDb.query.mock.calls.find(
      ([sql]) => sql.includes('audit_log') && sql.includes('household_member_aged_up')
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[1][0]).toBe(ADULT_FAN_ID);   // fan_id = adult
    expect(auditCall[1][1]).toBe(CONTEXT_ORG_ID); // org_id

    // Audit must be immediately before COMMIT
    const allSqls   = mockDb.query.mock.calls.map(([sql]) => sql.toUpperCase());
    const auditIdx  = allSqls.findIndex(s => s.includes('AUDIT_LOG') && s.includes('HOUSEHOLD_MEMBER_AGED_UP'));
    const commitIdx = allSqls.findIndex(s => s === 'COMMIT');
    expect(auditIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBe(auditIdx + 1);
  });

  // 8 — raw claim token never appears in response body
  test('raw claim token never appears in response body — exact key set verified', async () => {
    setupSuccessfulAgeUp();

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('claim_token');

    // Response must contain exactly these keys — no extras
    const expectedKeys = new Set([
      'household_member_id', 'minor_fan_id', 'adult_fan_id',
      'status', 'aged_up_at', 'aged_up_initiated_by',
      'claim_token_expires_at', 'email_stub',
    ]);
    for (const key of Object.keys(res.body)) {
      expect(expectedKeys.has(key)).toBe(true);
    }
  });

  // 9 — token hash never appears in response body
  test('token hash (64-char sha256 hex) never appears in response body', async () => {
    setupSuccessfulAgeUp();

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    const updateCall = mockDb.query.mock.calls.find(
      ([sql]) => sql.toUpperCase().includes('UPDATE HOUSEHOLD_MEMBER')
    );
    const storedHash = updateCall[1][0]; // the actual hash stored in DB

    expect(JSON.stringify(res.body)).not.toContain(storedHash);
  });

  // 10 — email_stub is true in response
  test('email_stub is true in response', async () => {
    setupSuccessfulAgeUp();

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    expect(res.status).toBe(200);
    expect(res.body.email_stub).toBe(true);
  });

  // 11 — 403 before any db call when JWT fan_id does not match adult_fan_id
  test('returns 403 before any db call when JWT fan_id does not match adult_fan_id in URL', async () => {
    const otherApp = buildApp(CONTEXT_ORG_ID, OTHER_FAN_ID);

    const res = await request(otherApp)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(res.body.message).toBe('token does not match requested household');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  // 12 — 404 when household member not found
  test('returns 404 when household member not found — READ 3 returns empty', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] }) // fan
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })                     // household
      .mockResolvedValueOnce({ rows: [] });                                         // member not found

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('household member not found');
    expect(mockDb.query).toHaveBeenCalledTimes(3);
  });

  // 13 — 409 when member already aged_up
  test("returns 409 when member status is 'aged_up' — already aged up, no writes made", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, minor_fan_id: MINOR_FAN_ID, status: 'aged_up' }] });

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('member already aged up');
    expect(mockDb.query).toHaveBeenCalledTimes(3);

    const allSqls = mockDb.query.mock.calls.map(([sql]) => sql.toUpperCase());
    expect(allSqls.find(s => s === 'BEGIN')).toBeUndefined();
    expect(allSqls.find(s => s.includes('UPDATE HOUSEHOLD_MEMBER'))).toBeUndefined();
  });

  // 14 — 409 when member is severed
  test("returns 409 when member status is 'severed' — severed member cannot be aged up", async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, minor_fan_id: MINOR_FAN_ID, status: 'severed' }] });

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('member has been severed');
    expect(mockDb.query).toHaveBeenCalledTimes(3);
  });

  // 15 — org isolation — member from different org returns 404
  test('org_id from context enforced — member from different org returns 404', async () => {
    const otherOrgApp = buildApp(OTHER_ORG_ID, ADULT_FAN_ID);
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // fan not found under OTHER_ORG_ID

    const res = await request(otherOrgApp)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    expect(res.status).toBe(404);
    expect(mockDb.query.mock.calls[0][1][1]).toBe(OTHER_ORG_ID);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  // 16 — second age-up attempt returns 409 — no writes after status check
  test('second age-up attempt on same member returns 409 — no BEGIN, UPDATE, or COMMIT after status check', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: ADULT_FAN_ID, deleted_at: null }] })
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: MEMBER_ID, minor_fan_id: MINOR_FAN_ID, status: 'aged_up' }] });

    const res = await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    expect(res.status).toBe(409);

    const allSqls = mockDb.query.mock.calls.map(([sql]) => sql.toUpperCase());
    expect(allSqls.find(s => s === 'BEGIN')).toBeUndefined();
    expect(allSqls.find(s => s.includes('UPDATE HOUSEHOLD_MEMBER'))).toBeUndefined();
    expect(allSqls.find(s => s === 'COMMIT')).toBeUndefined();
  });

  // MEDIUM-1 — email stub log security
  test('email stub log does not contain the raw claim token', async () => {
    setupSuccessfulAgeUp();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    const stubCall = logSpy.mock.calls.find(([label]) => label === 'AGE-UP EMAIL STUB');
    expect(stubCall).toBeDefined();
    const logged = stubCall[1];

    // claim_url must be the literal redacted string — never a real token
    expect(logged.claim_url).toBe('https://example.com/claim/[REDACTED]');
    // A raw token is two UUIDs concatenated — 64+ hex chars, no dashes
    expect(JSON.stringify(logged)).not.toMatch(/[0-9a-f]{64}/);

    logSpy.mockRestore();
  });

  test('email stub log does not contain guardian email address', async () => {
    setupSuccessfulAgeUp();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await request(app)
      .post(`/v1/household/${ADULT_FAN_ID}/members/${MINOR_FAN_ID}/age-up`);

    const stubCall = logSpy.mock.calls.find(([label]) => label === 'AGE-UP EMAIL STUB');
    expect(stubCall).toBeDefined();
    const logged = stubCall[1];

    // 'to' field must be absent — guardian email is PII
    expect(logged.to).toBeUndefined();
    // The actual email value from the mock must not appear anywhere in the logged object
    expect(JSON.stringify(logged)).not.toContain('guardian@example.com');
    expect(logged.email_stub).toBe(true);

    logSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component 28 — GET /v1/household/:adult_fan_id
// ─────────────────────────────────────────────────────────────────────────────

const adultFanRow = {
  id:               ADULT_FAN_ID,
  org_id:           CONTEXT_ORG_ID,
  stewardship_tier: 'platform',
  record_version:   1,
  created_at:       new Date('2026-04-01T10:00:00Z'),
};

const childRow = {
  member_id:    MEMBER_ID,
  minor_fan_id: MINOR_FAN_ID,
  dob:          '2015-03-10',
  status:       'active',
  created_at:   new Date('2026-05-01T12:00:00Z'),
  name:         'Sam Smith',
};

describe('GET /v1/household/:adult_fan_id', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  function setupSuccessfulFetch() {
    mockDb.query
      .mockResolvedValueOnce({ rows: [adultFanRow] })          // READ 1 — fan
      .mockResolvedValueOnce({ rows: [{ id: HOUSEHOLD_ID }] }) // READ 2 — household
      .mockResolvedValueOnce({ rows: [childRow] })              // READ 3 — children
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });       // READ 4 — total count
  }

  test('returns 200 with adult object, children array, and pagination fields', async () => {
    setupSuccessfulFetch();

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.household_id).toBe(HOUSEHOLD_ID);
    expect(res.body.adult).toEqual({ fan_id: ADULT_FAN_ID, org_id: CONTEXT_ORG_ID });
    expect(Array.isArray(res.body.children)).toBe(true);
    expect(res.body.total_children).toBe(1);
    expect(res.body.limit).toBe(3);
    expect(res.body.offset).toBe(0);
  });

  test('each child has member_id, fan_id, name, dob, status, created_at', async () => {
    setupSuccessfulFetch();

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    const child = res.body.children[0];
    expect(child.member_id).toBe(MEMBER_ID);
    expect(child.fan_id).toBe(MINOR_FAN_ID);
    expect(child.name).toBe('Sam Smith');
    expect(child.dob).toBeDefined();
    expect(child.status).toBe('active');
    expect(child.created_at).toBeDefined();
  });

  test('total_children is an integer, not a string', async () => {
    setupSuccessfulFetch();

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(typeof res.body.total_children).toBe('number');
    expect(Number.isInteger(res.body.total_children)).toBe(true);
  });

  test('returns 200 with household_id null and empty children when fan has no household yet', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [adultFanRow] })  // READ 1 — fan found
      .mockResolvedValueOnce({ rows: [] });              // READ 2 — no household

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.household_id).toBeNull();
    expect(res.body.children).toEqual([]);
    expect(res.body.total_children).toBe(0);
    expect(res.body.adult).toEqual({ fan_id: ADULT_FAN_ID, org_id: CONTEXT_ORG_ID });
  });

  test('no household — READ 3 and READ 4 are not called', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [adultFanRow] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  test('READ 3 — children SQL filters link_type = hard, soft links excluded', async () => {
    setupSuccessfulFetch();

    await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    const childrenSql = mockDb.query.mock.calls[2][0];
    expect(childrenSql).toContain("link_type    = 'hard'");
  });

  test('READ 3 — children SQL LEFT JOINs identifier_link for child name', async () => {
    setupSuccessfulFetch();

    await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    const childrenSql = mockDb.query.mock.calls[2][0].toUpperCase();
    expect(childrenSql).toContain('LEFT JOIN');
    expect(childrenSql).toContain('IDENTIFIER_LINK');
  });

  test('READ 3 — children query scoped to household_id from READ 2', async () => {
    setupSuccessfulFetch();

    await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    const childrenParams = mockDb.query.mock.calls[2][1];
    expect(childrenParams[1]).toBe(HOUSEHOLD_ID);  // $2 — household.id
  });

  test('default limit is 3 when not provided', async () => {
    setupSuccessfulFetch();

    await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    const childrenParams = mockDb.query.mock.calls[2][1];
    expect(childrenParams[2]).toBe(3);   // $3 — limit
    expect(childrenParams[3]).toBe(0);   // $4 — offset
  });

  test('limit and offset from query string are passed to children query', async () => {
    setupSuccessfulFetch();

    await request(app).get(`/v1/household/${ADULT_FAN_ID}?limit=5&offset=10`);

    const childrenParams = mockDb.query.mock.calls[2][1];
    expect(childrenParams[2]).toBe(5);   // $3 — limit
    expect(childrenParams[3]).toBe(10);  // $4 — offset
  });

  test('limit and offset are reflected in response', async () => {
    setupSuccessfulFetch();

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}?limit=5&offset=10`);

    expect(res.body.limit).toBe(5);
    expect(res.body.offset).toBe(10);
  });

  test('returns 403 with forbidden error and message when fan_id does not match URL', async () => {
    const otherApp = buildApp(CONTEXT_ORG_ID, OTHER_FAN_ID);

    const res = await request(otherApp).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(res.body.message).toBe('token does not match requested household');
  });

  test('fan_id mismatch check fires before any db call — household existence not leaked', async () => {
    const otherApp = buildApp(CONTEXT_ORG_ID, OTHER_FAN_ID);

    await request(otherApp).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('returns 400 for non-UUID adult_fan_id', async () => {
    const res = await request(app).get('/v1/household/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('adult_fan_id must be a valid UUID');
  });

  test('returns 404 when fan not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('fan record not found');
  });

  test('returns 400 when limit exceeds 10', async () => {
    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}?limit=11`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('limit cannot exceed 10');
  });

  test('returns 400 when offset is negative', async () => {
    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}?offset=-1`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('offset cannot be negative');
  });

  test('org_id from context used in fan and household queries — not from URL', async () => {
    setupSuccessfulFetch();

    await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(mockDb.query.mock.calls[0][1][1]).toBe(CONTEXT_ORG_ID);  // READ 1 — fan
    expect(mockDb.query.mock.calls[1][1][1]).toBe(CONTEXT_ORG_ID);  // READ 2 — household
  });

  test('returns 500 with generic message on db error — no internal detail in response', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('relation "fan" does not exist'));

    const res = await request(app).get(`/v1/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('household could not be retrieved');
    expect(JSON.stringify(res.body)).not.toContain('relation');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component 35 — GET /v1/household/claim/:token
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/household/claim/:token', () => {
  const crypto       = require('crypto');
  const RAW_TOKEN    = 'test-claim-token-for-component-35-golden-record';
  const CLAIM_TOKEN  = crypto.createHash('sha256').update(RAW_TOKEN).digest('hex');
  const CLAIM_EXPIRES = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const EXPIRED_AT   = new Date(Date.now() - 1000);

  // Build an app that mounts ONLY claimRouter — no jwtMiddleware, no fan_id in context.
  function buildClaimApp(orgId = CONTEXT_ORG_ID) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.context = { org_id: orgId, org_name: 'Test Org', correlation_id: 'test-corr-id' };
      req.db = mockDb;
      next();
    });
    app.use(require('../../src/routes/household').householdClaimRouter);
    return app;
  }

  let claimApp;

  beforeEach(() => {
    claimApp = buildClaimApp();
  });

  // Valid member row returned by READ 1 (members query)
  const memberRow = {
    id:                     MEMBER_ID,
    minor_fan_id:           MINOR_FAN_ID,
    adult_fan_id:           ADULT_FAN_ID,
    claim_token:            CLAIM_TOKEN,
    claim_token_expires_at: CLAIM_EXPIRES,
  };

  // Call sequence:
  //   0 = members READ1 (SELECT ... FROM household_member WHERE org_id AND status)
  //   1 = fan READ2   (SELECT id, deleted_at FROM fan)
  //   2 = BEGIN
  //   3 = UPDATE household_member (clear token)
  //   4 = INSERT audit_log
  //   5 = COMMIT
  function setupSuccessfulClaim() {
    mockDb.query
      .mockResolvedValueOnce({ rows: [memberRow] })                                     // 0 — members
      .mockResolvedValueOnce({ rows: [{ id: MINOR_FAN_ID, deleted_at: null }] })        // 1 — fan
      .mockResolvedValueOnce({ rows: [] })                                               // 2 — BEGIN
      .mockResolvedValueOnce({ rows: [] })                                               // 3 — UPDATE
      .mockResolvedValueOnce({ rows: [] })                                               // 4 — audit
      .mockResolvedValueOnce({ rows: [] });                                              // 5 — COMMIT
  }

  // 1 — valid token returns 200 with all required response fields
  test('returns 200 with fan_id, token, expires_at, claimed_at on valid token', async () => {
    setupSuccessfulClaim();

    const res = await request(claimApp).get(`/v1/household/claim/${RAW_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.fan_id).toBe(MINOR_FAN_ID);
    expect(res.body.token).toBeDefined();
    expect(res.body.expires_at).toBeDefined();
    expect(res.body.claimed_at).toBeDefined();
  });

  // 2 — claim_token column is NULL in the UPDATE SQL after successful claim
  test('claim_token column is set to NULL in UPDATE SQL after successful claim', async () => {
    setupSuccessfulClaim();

    await request(claimApp).get(`/v1/household/claim/${RAW_TOKEN}`);

    const updateCall = mockDb.query.mock.calls.find(
      ([sql]) => sql.toUpperCase().includes('UPDATE HOUSEHOLD_MEMBER')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[0].toUpperCase()).toContain('CLAIM_TOKEN = NULL');
    expect(updateCall[1][0]).toBe(MEMBER_ID); // WHERE id = $1
  });

  // 3 — claim_token_expires_at column is NULL in the UPDATE SQL after successful claim
  test('claim_token_expires_at column is set to NULL in UPDATE SQL after successful claim', async () => {
    setupSuccessfulClaim();

    await request(claimApp).get(`/v1/household/claim/${RAW_TOKEN}`);

    const updateCall = mockDb.query.mock.calls.find(
      ([sql]) => sql.toUpperCase().includes('UPDATE HOUSEHOLD_MEMBER')
    );
    expect(updateCall[0].toUpperCase()).toContain('CLAIM_TOKEN_EXPIRES_AT = NULL');
  });

  // 4 — returned JWT sub claim equals minor_fan_id
  test('returned JWT sub claim equals minor_fan_id', async () => {
    setupSuccessfulClaim();

    const res = await request(claimApp).get(`/v1/household/claim/${RAW_TOKEN}`);

    expect(res.status).toBe(200);
    const jwtLib  = require('jsonwebtoken');
    const decoded = jwtLib.decode(res.body.token);
    expect(decoded.sub).toBe(MINOR_FAN_ID);
  });

  // 5 — returned JWT passes verifyToken without throwing
  test('returned JWT passes verifyToken without throwing', async () => {
    setupSuccessfulClaim();

    const res = await request(claimApp).get(`/v1/household/claim/${RAW_TOKEN}`);

    expect(res.status).toBe(200);
    const { verifyToken } = require('../../src/modules/jwt');
    expect(() => verifyToken(`Bearer ${res.body.token}`)).not.toThrow();
  });

  // 6 — 404 when no aged_up member matches the token
  test('returns 404 when no aged_up member matches the token', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // READ1 — no aged_up members

    const res = await request(claimApp).get(`/v1/household/claim/${RAW_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('claim token not found');
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  // 7 — 410 when token is expired
  test('returns 410 when claim token has expired', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ ...memberRow, claim_token_expires_at: EXPIRED_AT }]
    });

    const res = await request(claimApp).get(`/v1/household/claim/${RAW_TOKEN}`);

    expect(res.status).toBe(410);
    expect(res.body.error).toBe('claim token has expired');
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  // 8 — 403 when child fan is soft-deleted
  test('returns 403 when child fan record is soft-deleted', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [memberRow] })                                        // members
      .mockResolvedValueOnce({ rows: [{ id: MINOR_FAN_ID, deleted_at: new Date() }] });   // fan deleted

    const res = await request(claimApp).get(`/v1/household/claim/${RAW_TOKEN}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('fan account is inactive');
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  // 9 — token is single-use: second claim attempt returns 404
  test('token is single-use — second claim attempt returns 404 (no aged_up row after clear)', async () => {
    // Simulate state after first successful claim: claim_token cleared, no aged_up match
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(claimApp).get(`/v1/household/claim/${RAW_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('claim token not found');
  });

  // 10 — cannot claim token belonging to different org
  test('cannot claim token belonging to different org — org_id from context isolates the query', async () => {
    const otherOrgApp = buildClaimApp(OTHER_ORG_ID);
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // no aged_up members under OTHER_ORG_ID

    const res = await request(otherOrgApp).get(`/v1/household/claim/${RAW_TOKEN}`);

    expect(res.status).toBe(404);
    expect(mockDb.query.mock.calls[0][1][0]).toBe(OTHER_ORG_ID); // $1 in WHERE org_id = $1
  });

  // 11 — crypto.timingSafeEqual called — never string equality
  test('crypto.timingSafeEqual is called during token comparison — not string equality', async () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    setupSuccessfulClaim();

    await request(claimApp).get(`/v1/household/claim/${RAW_TOKEN}`);

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // 12 — 400 when token param is empty (URL-encoded whitespace)
  test('returns 400 when token param is empty or whitespace', async () => {
    const res = await request(claimApp).get('/v1/household/claim/%20');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('claim token is required');
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Component 36 — GET /v1/admin/household/:fan_id
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /v1/admin/household/:fan_id', () => {
  const RELATED_ID    = '22222222-0000-0000-0000-000000000008';
  const HOUSEHOLD_ID2 = '33333333-0000-0000-0000-000000000009';
  const STAGING_ID    = '77777777-0000-0000-0000-000000000013';

  const stagingRow = {
    id:           STAGING_ID,
    adult_fan_id: ADULT_FAN_ID,
    child_name:   'sam smith',
    child_dob:    '2015-06-10',
    source:       'youth_camp',
    confidence:   0.65,
    created_at:   new Date('2026-05-10T08:00:00Z'),
  };

  function buildAdminApp(orgId = CONTEXT_ORG_ID) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.context = {
        org_id:         orgId,
        org_name:       'Test Org',
        correlation_id: 'test-corr-id',
        // no fan_id — staff action, orgAuthMiddleware only
      };
      req.db = mockDb;
      next();
    });
    app.use(require('../../src/routes/admin/household'));
    return app;
  }

  const fanRow = {
    id:         ADULT_FAN_ID,
    deleted_at: null,
    created_at: new Date('2026-05-01T10:00:00Z'),
  };

  const hardMemberRow = {
    id:                     MEMBER_ID,
    household_id:           HOUSEHOLD_ID,
    adult_fan_id:           ADULT_FAN_ID,
    minor_fan_id:           MINOR_FAN_ID,
    link_type:              'hard',
    status:                 'active',
    dob:                    '2018-03-15',
    aged_up_at:             null,
    aged_up_initiated_by:   null,
    claim_token_expires_at: null,
    severed_at:             null,
    severed_by:             null,
    created_at:             new Date('2026-05-01T11:00:00Z'),
  };

  function setupFetch({ fan = fanRow, households = [], memberships = [], relatedFans = [], staging = [] } = {}) {
    mockDb.query
      .mockResolvedValueOnce({ rows: fan ? [fan] : [] })  // READ 1 — fan
      .mockResolvedValueOnce({ rows: households })         // READ 2 — households
      .mockResolvedValueOnce({ rows: memberships })        // READ 3 — all memberships
      .mockResolvedValueOnce({ rows: relatedFans })        // READ 4 — related_fans
      .mockResolvedValueOnce({ rows: staging });           // READ 5 — staging_household_data
  }

  let adminApp;
  beforeEach(() => { adminApp = buildAdminApp(); });

  // 1 — Returns fan_id, deleted_at, created_at from fan record
  test('returns 200 with fan_id, deleted_at, and created_at from fan record', async () => {
    setupFetch();

    const res = await request(adminApp).get(`/v1/admin/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.fan_id).toBe(ADULT_FAN_ID);
    expect(res.body.deleted_at).toBeNull();
    expect(res.body.created_at).toBeDefined();
  });

  // 2 — Returns all households where fan is the adult
  test('returns all households where fan is the adult in households array', async () => {
    const households = [
      { id: HOUSEHOLD_ID,  adult_fan_id: ADULT_FAN_ID, created_at: new Date('2026-05-01T11:00:00Z'), created_by: 'fan' },
      { id: HOUSEHOLD_ID2, adult_fan_id: ADULT_FAN_ID, created_at: new Date('2026-05-02T09:00:00Z'), created_by: 'fan' },
    ];
    setupFetch({ households });

    const res = await request(adminApp).get(`/v1/admin/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.households).toHaveLength(2);
    expect(res.body.households[0].household_id).toBe(HOUSEHOLD_ID);
    expect(res.body.households[0].adult_fan_id).toBe(ADULT_FAN_ID);
    expect(res.body.households[0].created_by).toBe('fan');
  });

  // 3 — Returns all household_member records regardless of status
  test('returns all household_member records regardless of status in memberships', async () => {
    const memberships = [
      { ...hardMemberRow, status: 'active' },
      { ...hardMemberRow, id: '44444444-0000-0000-0000-000000000010', status: 'severed',  severed_at: new Date(), severed_by: 'guardian' },
      { ...hardMemberRow, id: '55555555-0000-0000-0000-000000000011', status: 'aged_up',  aged_up_at: new Date(), aged_up_initiated_by: 'guardian' },
    ];
    setupFetch({ memberships });

    const res = await request(adminApp).get(`/v1/admin/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.memberships).toHaveLength(3);
    const statuses = res.body.memberships.map(m => m.status);
    expect(statuses).toContain('active');
    expect(statuses).toContain('severed');
    expect(statuses).toContain('aged_up');
  });

  // 4 — Returns severed members in memberships
  test('returns severed members in memberships array with severed_at and severed_by', async () => {
    const memberships = [
      { ...hardMemberRow, status: 'severed', severed_at: new Date('2026-05-20T14:00:00Z'), severed_by: 'guardian' },
    ];
    setupFetch({ memberships });

    const res = await request(adminApp).get(`/v1/admin/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.memberships).toHaveLength(1);
    expect(res.body.memberships[0].status).toBe('severed');
    expect(res.body.memberships[0].severed_by).toBe('guardian');
    expect(res.body.memberships[0].severed_at).toBeDefined();
  });

  // 5 — Returns aged_up members in memberships
  test('returns aged_up members in memberships array with aged_up_at and claim_token_expires_at', async () => {
    const memberships = [
      {
        ...hardMemberRow,
        status:                 'aged_up',
        aged_up_at:             new Date('2026-05-25T10:00:00Z'),
        aged_up_initiated_by:   'guardian',
        claim_token_expires_at: new Date('2026-06-25T10:00:00Z'),
      },
    ];
    setupFetch({ memberships });

    const res = await request(adminApp).get(`/v1/admin/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.memberships).toHaveLength(1);
    expect(res.body.memberships[0].status).toBe('aged_up');
    expect(res.body.memberships[0].aged_up_initiated_by).toBe('guardian');
    expect(res.body.memberships[0].claim_token_expires_at).toBeDefined();
  });

  // 6 — soft_links comes from staging_household_data (READ 5), not from memberships
  test('returns staging_household_data rows in soft_links array with new shape', async () => {
    setupFetch({ memberships: [hardMemberRow], staging: [stagingRow] });

    const res = await request(adminApp).get(`/v1/admin/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.memberships).toHaveLength(1);                            // hard member in memberships
    expect(res.body.soft_links).toHaveLength(1);                             // staging row in soft_links
    expect(res.body.soft_links[0].staging_id).toBe(STAGING_ID);
    expect(res.body.soft_links[0].adult_fan_id).toBe(ADULT_FAN_ID);
    expect(res.body.soft_links[0].child_name).toBe('sam smith');
    expect(res.body.soft_links[0].child_dob).toBe('2015-06-10');
    expect(res.body.soft_links[0].source).toBe('youth_camp');
    expect(res.body.soft_links[0].confidence).toBe(0.65);
    // old shape fields must not appear
    expect(res.body.soft_links[0].link_type).toBeUndefined();
    expect(res.body.soft_links[0].member_id).toBeUndefined();
  });

  // 7 — Returns related_fans records
  test('returns related_fans records for this fan', async () => {
    const relatedFans = [
      {
        id:           RELATED_ID,
        fan_id_a:     ADULT_FAN_ID,
        fan_id_b:     MINOR_FAN_ID,
        relationship: 'aged_up',
        source:       'household',
        created_at:   new Date('2026-05-25T10:00:00Z'),
      },
    ];
    setupFetch({ relatedFans });

    const res = await request(adminApp).get(`/v1/admin/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.related_fans).toHaveLength(1);
    expect(res.body.related_fans[0].fan_id_a).toBe(ADULT_FAN_ID);
    expect(res.body.related_fans[0].fan_id_b).toBe(MINOR_FAN_ID);
    expect(res.body.related_fans[0].relationship).toBe('aged_up');
    expect(res.body.related_fans[0].record_id).toBe(RELATED_ID);
  });

  // 8 — claim_token raw value never appears in response
  test('claim_token raw value never appears anywhere in response body', async () => {
    // Even if the mock injects claim_token into the row, the handler's explicit
    // field mapping must not expose it — only claim_token_expires_at is returned.
    const memberships = [
      {
        ...hardMemberRow,
        status:                 'aged_up',
        claim_token:            'super-secret-raw-token',
        claim_token_expires_at: new Date('2026-06-25T10:00:00Z'),
      },
    ];
    setupFetch({ memberships });

    const res = await request(adminApp).get(`/v1/admin/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-raw-token');
    expect(res.body.memberships[0].claim_token).toBeUndefined();
    expect(res.body.memberships[0].claim_token_expires_at).toBeDefined();
  });

  // 9 — Returns 400 for invalid UUID
  test('returns 400 for invalid fan_id — no db calls made', async () => {
    const res = await request(adminApp).get('/v1/admin/household/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('fan_id must be a valid UUID');
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  // 10 — Returns 404 when fan not found
  test('returns 404 when fan record does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // READ 1 — fan not found

    const res = await request(adminApp).get(`/v1/admin/household/${ADULT_FAN_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('fan not found');
    expect(mockDb.query).toHaveBeenCalledTimes(1); // only one read — stopped after 404
  });

  // 11 — Fan belonging to different org returns 404
  test('returns 404 when fan belongs to a different org — cross-tenant isolation', async () => {
    // WHERE id = $1 AND org_id = $2 returns no row when org_id does not match
    mockDb.query.mockResolvedValueOnce({ rows: [] }); // READ 1 — wrong org, empty result

    const res = await request(adminApp).get(`/v1/admin/household/${OTHER_FAN_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('fan not found');
    expect(mockDb.query).toHaveBeenCalledTimes(1); // halted — no further reads
  });

  // 12 — Fan appearing as minor shows in memberships array
  test('fan appearing as minor in another household appears in memberships array', async () => {
    const minorFanRow = {
      id:         MINOR_FAN_ID,
      deleted_at: null,
      created_at: new Date('2026-03-10T08:00:00Z'),
    };
    const asMinorRow = { ...hardMemberRow, adult_fan_id: ADULT_FAN_ID, minor_fan_id: MINOR_FAN_ID };

    mockDb.query
      .mockResolvedValueOnce({ rows: [minorFanRow] }) // READ 1 — fan (the minor)
      .mockResolvedValueOnce({ rows: [] })             // READ 2 — no households as adult
      .mockResolvedValueOnce({ rows: [asMinorRow] })  // READ 3 — appears as minor
      .mockResolvedValueOnce({ rows: [] })             // READ 4 — no related_fans
      .mockResolvedValueOnce({ rows: [] });            // READ 5 — staging_household_data

    const res = await request(adminApp).get(`/v1/admin/household/${MINOR_FAN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.fan_id).toBe(MINOR_FAN_ID);
    expect(res.body.households).toHaveLength(0);    // not an adult — no households
    expect(res.body.memberships).toHaveLength(1);
    expect(res.body.memberships[0].minor_fan_id).toBe(MINOR_FAN_ID);
  });
});
