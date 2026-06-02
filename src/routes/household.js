'use strict';

const crypto  = require('crypto');
const express = require('express');

const { normalizeIdentifier, NormalizationError } = require('../modules/normalizer');
const { signToken } = require('../modules/jwt');

const router = express.Router();
const logger = {
  error: (...args) => console.error(...args),
  warn:  (...args) => console.warn(...args),
  info:  (...args) => console.log(...args),
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post('/v1/household', async (req, res) => {
  // RECEIVE
  const org_id       = req.context.org_id;
  const adult_fan_id = req.context.fan_id;

  // GUARD — in-memory only
  if (!adult_fan_id) {
    return res.status(400).json({ error: 'adult_fan_id is required' });
  }
  if (!UUID_RE.test(adult_fan_id)) {
    return res.status(400).json({ error: 'adult_fan_id must be a valid UUID' });
  }

  // EXECUTE
  let row;
  try {
    // DB read 1 — verify fan exists, belongs to org, not soft-deleted
    const fanResult = await req.db.query(
      'SELECT id, deleted_at FROM fan WHERE id = $1 AND org_id = $2',
      [adult_fan_id, org_id]
    );
    const fan = fanResult.rows[0];
    if (!fan) {
      return res.status(403).json({ error: 'fan record not found or does not belong to this org' });
    }
    if (fan.deleted_at) {
      return res.status(403).json({ error: 'fan record has been erased — cannot create household' });
    }

    // DB read 2 — check for existing household before writing
    const existingResult = await req.db.query(
      'SELECT id FROM household WHERE adult_fan_id = $1 AND org_id = $2',
      [adult_fan_id, org_id]
    );
    const existing = existingResult.rows[0];
    if (existing) {
      return res.status(409).json({
        error:        'household already exists',
        household_id: existing.id
      });
    }

    // TRANSACTION — household INSERT and audit are atomic: no household without audit trail
    await req.db.query('BEGIN');

    // DB write 1 — create household
    const insertResult = await req.db.query(
      `INSERT INTO household (id, org_id, adult_fan_id, created_by, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'fan', NOW())
       RETURNING id, org_id, adult_fan_id, created_at`,
      [org_id, adult_fan_id]
    );
    row = insertResult.rows[0];

    // DB write 2 — audit event — always last write in transaction
    await req.db.query(
      `INSERT INTO audit_log (id, fan_id, org_id, event_type, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'household_created', 'success', NOW())`,
      [adult_fan_id, org_id]
    );

    await req.db.query('COMMIT');
  } catch (err) {
    await req.db.query('ROLLBACK').catch(() => {});
    logger.error('household creation failed', {
      error:          err.message,
      fan_id:         adult_fan_id,
      org_id,
      correlation_id: req.context.correlation_id
    });
    return res.status(500).json({ error: 'household could not be created' });
  }

  // RETURN
  return res.status(201).json({
    household_id: row.id,
    adult_fan_id: row.adult_fan_id,
    org_id:       row.org_id,
    created_at:   row.created_at
  });
});

router.get('/v1/household/:adult_fan_id', async (req, res) => {
  // RECEIVE
  const url_adult_fan_id = req.params.adult_fan_id;
  const jwt_fan_id       = req.context.fan_id;
  const org_id           = req.context.org_id;
  const limit            = req.query.limit  !== undefined ? parseInt(req.query.limit,  10) : 3;
  const offset           = req.query.offset !== undefined ? parseInt(req.query.offset, 10) : 0;

  // GUARD — in-memory only, no db calls
  if (!url_adult_fan_id || !UUID_RE.test(url_adult_fan_id)) {
    return res.status(400).json({ error: 'adult_fan_id must be a valid UUID' });
  }
  if (url_adult_fan_id !== jwt_fan_id) {
    return res.status(403).json({ error: 'forbidden', message: 'token does not match requested household' });
  }
  if (limit > 10) {
    return res.status(400).json({ error: 'limit cannot exceed 10' });
  }
  if (offset < 0) {
    return res.status(400).json({ error: 'offset cannot be negative' });
  }

  // EXECUTE
  let adult, household, children, total_children;
  try {
    // READ 1 — adult fan record
    const fanResult = await req.db.query(
      `SELECT id, org_id, stewardship_tier, record_version, created_at
       FROM fan WHERE id = $1 AND org_id = $2`,
      [jwt_fan_id, org_id]
    );
    adult = fanResult.rows[0];
    if (!adult) {
      return res.status(404).json({ error: 'fan record not found' });
    }

    // READ 2 — household
    const householdResult = await req.db.query(
      `SELECT id FROM household WHERE adult_fan_id = $1 AND org_id = $2`,
      [jwt_fan_id, org_id]
    );
    household = householdResult.rows[0];

    if (!household) {
      return res.status(200).json({
        household_id:   null,
        adult:          { fan_id: adult.id, org_id: adult.org_id },
        children:       [],
        total_children: 0,
        limit,
        offset
      });
    }

    // READ 3 — children — hard links only, soft links never shown to fan
    const childrenResult = await req.db.query(
      `SELECT hm.id          AS member_id,
              hm.minor_fan_id,
              hm.dob,
              hm.status,
              hm.created_at,
              il_name.identifier_value AS name
       FROM household_member hm
       LEFT JOIN identifier_link il_name
         ON  il_name.fan_id          = hm.minor_fan_id
         AND il_name.identifier_type = 'name'
         AND il_name.org_id          = $1
       WHERE hm.household_id = $2
         AND hm.link_type    = 'hard'
         AND hm.status       = 'active'
       ORDER BY hm.created_at ASC
       LIMIT $3 OFFSET $4`,
      [org_id, household.id, limit, offset]
    );
    children = childrenResult.rows;

    // READ 4 — total count
    const countResult = await req.db.query(
      `SELECT COUNT(*) FROM household_member
       WHERE household_id = $1
         AND link_type    = 'hard'
         AND status       = 'active'`,
      [household.id]
    );
    total_children = parseInt(countResult.rows[0].count, 10);
  } catch (err) {
    logger.error('household fetch failed', {
      error:          err.message,
      fan_id:         jwt_fan_id,
      org_id,
      correlation_id: req.context.correlation_id
    });
    return res.status(500).json({ error: 'household could not be retrieved' });
  }

  // RETURN
  return res.status(200).json({
    household_id:   household.id,
    adult:          { fan_id: adult.id, org_id: adult.org_id },
    children:       children.map(c => ({
      member_id:  c.member_id,
      fan_id:     c.minor_fan_id,
      name:       c.name,
      dob:        c.dob,
      status:     c.status,
      created_at: c.created_at
    })),
    total_children,
    limit,
    offset
  });
});

// COMPONENT 29 — POST /v1/household/:adult_fan_id/members
router.post('/v1/household/:adult_fan_id/members', async (req, res) => {
  // RECEIVE
  const url_adult_fan_id = req.params.adult_fan_id;
  const jwt_fan_id       = req.context.fan_id;
  const org_id           = req.context.org_id;
  const { first_name, last_name, dob, guardian_email, guardian_phone } = req.body;

  // GUARD — in-memory only
  if (url_adult_fan_id !== jwt_fan_id) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!first_name || !first_name.trim()) {
    return res.status(400).json({ error: 'first_name is required' });
  }
  if (!last_name || !last_name.trim()) {
    return res.status(400).json({ error: 'last_name is required' });
  }
  if (!dob || !dob.trim()) {
    return res.status(400).json({ error: 'dob is required' });
  }
  if (!guardian_email || !guardian_email.trim()) {
    return res.status(400).json({ error: 'guardian_email is required' });
  }
  if (!guardian_phone || !guardian_phone.trim()) {
    return res.status(400).json({ error: 'guardian_phone is required' });
  }

  // NORMALIZATION — separate try/catch → 400
  let normalized_name, normalized_dob, normalized_email, normalized_phone;
  try {
    normalized_name  = normalizeIdentifier('name',           `${first_name} ${last_name}`);
    normalized_dob   = normalizeIdentifier('dob',            dob);
    normalized_email = normalizeIdentifier('guardian_email', guardian_email);
    normalized_phone = normalizeIdentifier('guardian_phone', guardian_phone);
  } catch (err) {
    if (err instanceof NormalizationError) {
      return res.status(400).json({ error: 'validation failed', detail: err.message });
    }
    throw err;
  }

  // EXECUTE
  let minor_fan_id, household_member_id, household_id, staged_id;
  try {
    // READ 1 — verify adult exists and is not erased
    const fanResult = await req.db.query(
      'SELECT id, deleted_at FROM fan WHERE id = $1 AND org_id = $2',
      [jwt_fan_id, org_id]
    );
    const adult = fanResult.rows[0];
    if (!adult) {
      return res.status(404).json({ error: 'fan record not found' });
    }
    if (adult.deleted_at) {
      return res.status(403).json({ error: 'fan record has been erased' });
    }

    // READ 2 — verify household exists (must be created first via POST /v1/household)
    const householdResult = await req.db.query(
      'SELECT id FROM household WHERE adult_fan_id = $1 AND org_id = $2',
      [jwt_fan_id, org_id]
    );
    const existingHousehold = householdResult.rows[0];
    if (!existingHousehold) {
      return res.status(404).json({
        error:   'household not found',
        message: 'create a household first via POST /v1/household',
      });
    }
    household_id = existingHousehold.id;

    // READ 3 — check staging_household_data for probable match
    const stagingResult = await req.db.query(
      `SELECT id FROM staging_household_data
       WHERE adult_fan_id = $1
         AND org_id       = $2
         AND promoted_at  IS NULL
         AND LOWER(child_name) = $3
         AND child_dob    = $4
       LIMIT 1`,
      [jwt_fan_id, org_id, normalized_name.toLowerCase(), normalized_dob]
    );
    staged_id = stagingResult.rows[0] ? stagingResult.rows[0].id : null;

    // TRANSACTION
    await req.db.query('BEGIN');

    // STEP 1 — create child fan record
    const fanInsertResult = await req.db.query(
      `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'platform', 1, NOW(), NOW())
       RETURNING id`,
      [org_id]
    );
    minor_fan_id = fanInsertResult.rows[0].id;

    // STEP 2 — create identifier_link rows for all four identifiers
    const identifiers = [
      { type: 'name',           value: normalized_name  },
      { type: 'dob',            value: normalized_dob   },
      { type: 'guardian_email', value: normalized_email },
      { type: 'guardian_phone', value: normalized_phone },
    ];
    for (const id of identifiers) {
      await req.db.query(
        `INSERT INTO identifier_link
           (fan_id, identifier_type, identifier_value, org_id,
            source_system, schema_version, confidence_score,
            first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, 'fan_pass', '1.0', 1.0, NOW(), NOW())`,
        [minor_fan_id, id.type, id.value, org_id]
      );
    }

    // STEP 3 — create household_member hard link
    const memberInsertResult = await req.db.query(
      `INSERT INTO household_member
         (id, household_id, adult_fan_id, minor_fan_id, org_id,
          link_type, status, dob, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'hard', 'active', $5, NOW())
       RETURNING id`,
      [household_id, jwt_fan_id, minor_fan_id, org_id, normalized_dob]
    );
    household_member_id = memberInsertResult.rows[0].id;

    // STEP 4 — promote staged record if match found
    if (staged_id) {
      await req.db.query(
        `UPDATE staging_household_data
         SET promoted_at = NOW(), promoted_to = $1
         WHERE id = $2`,
        [minor_fan_id, staged_id]
      );
    }

    // STEP 5 — audit event — always last write in transaction
    await req.db.query(
      `INSERT INTO audit_log (id, fan_id, org_id, event_type, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'household_member_added', 'success', NOW())`,
      [jwt_fan_id, org_id]
    );

    await req.db.query('COMMIT');

    // FIRESTORE SYNC — after commit, non-fatal
    if (req.firestore) {
      try {
        await req.firestore.collection('fans').doc(minor_fan_id).set({
          fan_id:         minor_fan_id,
          org_id,
          loyalty_points: 0,
          stamps:         [],
          avatar:         null,
          created_at:     new Date().toISOString(),
        });
      } catch (firestoreErr) {
        logger.error('Firestore sync failed for child fan', {
          fan_id: minor_fan_id,
          error:  firestoreErr.message,
        });
      }
    }
  } catch (err) {
    await req.db.query('ROLLBACK').catch(() => {});
    logger.error('child account creation failed', {
      error:          err.message,
      fan_id:         jwt_fan_id,
      org_id,
      correlation_id: req.context.correlation_id,
    });
    return res.status(500).json({ error: 'household member could not be created' });
  }

  // RETURN
  return res.status(201).json({
    household_member_id,
    minor_fan_id,
    adult_fan_id:  jwt_fan_id,
    household_id,
    child_name:    normalized_name,
    child_dob:     normalized_dob,
    link_type:     'hard',
    status:        'active',
    staged_match:  staged_id !== null,
    created_at:    new Date().toISOString(),
  });
});

// COMPONENT 30 — GET /v1/household/:adult_fan_id/members/:child_fan_id
router.get('/v1/household/:adult_fan_id/members/:child_fan_id', async (req, res) => {
  // RECEIVE
  const url_adult_fan_id = req.params.adult_fan_id;
  const child_fan_id     = req.params.child_fan_id;
  const jwt_fan_id       = req.context.fan_id;
  const org_id           = req.context.org_id;

  // GUARD — in-memory only
  if (!url_adult_fan_id || !UUID_RE.test(url_adult_fan_id)) {
    return res.status(400).json({ error: 'adult_fan_id must be a valid UUID' });
  }
  if (!child_fan_id || !UUID_RE.test(child_fan_id)) {
    return res.status(400).json({ error: 'child_fan_id must be a valid UUID' });
  }
  if (url_adult_fan_id !== jwt_fan_id) {
    return res.status(403).json({ error: 'forbidden', message: 'token does not match requested household' });
  }

  // EXECUTE
  let member, identifiers;
  try {
    // READ 1 — verify adult fan exists, belongs to org, not soft-deleted
    const fanResult = await req.db.query(
      'SELECT id, deleted_at FROM fan WHERE id = $1 AND org_id = $2',
      [jwt_fan_id, org_id]
    );
    const fan = fanResult.rows[0];
    if (!fan) {
      return res.status(404).json({ error: 'fan not found' });
    }
    if (fan.deleted_at) {
      return res.status(403).json({ error: 'fan account is inactive' });
    }

    // READ 2 — verify household exists for this adult
    const householdResult = await req.db.query(
      'SELECT id FROM household WHERE adult_fan_id = $1 AND org_id = $2',
      [jwt_fan_id, org_id]
    );
    if (!householdResult.rows[0]) {
      return res.status(404).json({ error: 'household not found' });
    }

    // READ 3 — fetch household_member — active only
    // claim_token is NOT selected — only claim_token_expires_at
    const memberResult = await req.db.query(
      `SELECT id, household_id, adult_fan_id, minor_fan_id,
              org_id, link_type, status, dob,
              aged_up_at, aged_up_initiated_by,
              claim_token_expires_at, severed_at,
              severed_by, created_at
       FROM household_member
       WHERE minor_fan_id = $1
         AND adult_fan_id = $2
         AND org_id       = $3
         AND status       = 'active'`,
      [child_fan_id, jwt_fan_id, org_id]
    );
    member = memberResult.rows[0];
    if (!member) {
      return res.status(404).json({ error: 'household member not found' });
    }

    // READ 4 — all identifier_link rows for child, no type filter
    const identifierResult = await req.db.query(
      `SELECT identifier_type, identifier_value, source_system, first_seen_at
       FROM identifier_link
       WHERE fan_id = $1 AND org_id = $2`,
      [child_fan_id, org_id]
    );
    identifiers = identifierResult.rows;
  } catch (err) {
    logger.error('household member fetch failed', {
      error:          err.message,
      fan_id:         jwt_fan_id,
      child_fan_id,
      org_id,
      correlation_id: req.context.correlation_id
    });
    return res.status(500).json({ error: 'household member could not be retrieved' });
  }

  // RETURN
  return res.status(200).json({
    household_member_id:    member.id,
    minor_fan_id:           member.minor_fan_id,
    adult_fan_id:           member.adult_fan_id,
    household_id:           member.household_id,
    org_id:                 member.org_id,
    link_type:              member.link_type,
    status:                 member.status,
    dob:                    member.dob,
    aged_up_at:             member.aged_up_at,
    aged_up_initiated_by:   member.aged_up_initiated_by,
    claim_token_expires_at: member.claim_token_expires_at,
    severed_at:             member.severed_at,
    severed_by:             member.severed_by,
    created_at:             member.created_at,
    identifiers:            identifiers.map(i => ({
      identifier_type:  i.identifier_type,
      identifier_value: i.identifier_value,
      source:           i.source_system,
      created_at:       i.first_seen_at,
    })),
  });
});

// COMPONENT 31 — PUT /v1/household/:adult_fan_id/members/:child_fan_id
router.put('/v1/household/:adult_fan_id/members/:child_fan_id', async (req, res) => {
  // RECEIVE
  const url_adult_fan_id = req.params.adult_fan_id;
  const child_fan_id     = req.params.child_fan_id;
  const jwt_fan_id       = req.context.fan_id;
  const org_id           = req.context.org_id;
  const { first_name, last_name, dob, guardian_email, guardian_phone } = req.body;

  // GUARD — in-memory only
  if (!url_adult_fan_id || !UUID_RE.test(url_adult_fan_id)) {
    return res.status(400).json({ error: 'adult_fan_id must be a valid UUID' });
  }
  if (!child_fan_id || !UUID_RE.test(child_fan_id)) {
    return res.status(400).json({ error: 'child_fan_id must be a valid UUID' });
  }
  if (url_adult_fan_id !== jwt_fan_id) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const nameProvided  = first_name != null || last_name != null;
  const dobProvided   = dob != null;
  const emailProvided = guardian_email != null;
  const phoneProvided = guardian_phone != null;

  if (!nameProvided && !dobProvided && !emailProvided && !phoneProvided) {
    return res.status(400).json({ error: 'no editable fields provided' });
  }

  // NORMALIZATION — separate try/catch → 400
  // Normalize only fields that don't require a db read to resolve
  let normalized_dob, normalized_email, normalized_phone;
  let prebuilt_name; // set only when both first_name and last_name are provided

  try {
    if (first_name != null && last_name != null) {
      prebuilt_name = normalizeIdentifier('name', `${first_name.trim()} ${last_name.trim()}`);
    }
    if (dobProvided)   normalized_dob   = normalizeIdentifier('dob',            dob);
    if (emailProvided) normalized_email = normalizeIdentifier('guardian_email', guardian_email);
    if (phoneProvided) normalized_phone = normalizeIdentifier('guardian_phone', guardian_phone);
  } catch (err) {
    if (err instanceof NormalizationError) {
      return res.status(400).json({ error: 'validation failed', detail: err.message });
    }
    throw err;
  }

  // EXECUTE
  let member_id, minor_fan_id, normalized_name;
  const updated_fields = [];

  try {
    // READ 1 — verify adult fan exists, not erased
    const fanResult = await req.db.query(
      'SELECT id, deleted_at FROM fan WHERE id = $1 AND org_id = $2',
      [jwt_fan_id, org_id]
    );
    const fan = fanResult.rows[0];
    if (!fan)            return res.status(404).json({ error: 'fan not found' });
    if (fan.deleted_at)  return res.status(403).json({ error: 'fan account is inactive' });

    // READ 2 — verify household exists
    const householdResult = await req.db.query(
      'SELECT id FROM household WHERE adult_fan_id = $1 AND org_id = $2',
      [jwt_fan_id, org_id]
    );
    if (!householdResult.rows[0]) {
      return res.status(404).json({ error: 'household not found' });
    }

    // READ 3 — verify household_member exists and is active
    const memberResult = await req.db.query(
      `SELECT id, minor_fan_id FROM household_member
       WHERE minor_fan_id = $1 AND adult_fan_id = $2
         AND org_id = $3 AND status = 'active'`,
      [child_fan_id, jwt_fan_id, org_id]
    );
    const member = memberResult.rows[0];
    if (!member) return res.status(404).json({ error: 'household member not found' });
    member_id    = member.id;
    minor_fan_id = member.minor_fan_id;

    // READ 4a — fetch existing name if only one half was supplied
    if (nameProvided && prebuilt_name == null) {
      const existingNameResult = await req.db.query(
        `SELECT identifier_value FROM identifier_link
         WHERE fan_id = $1 AND org_id = $2 AND identifier_type = 'name'
         LIMIT 1`,
        [minor_fan_id, org_id]
      );
      const existing  = existingNameResult.rows[0]?.identifier_value || '';
      const spaceIdx  = existing.indexOf(' ');
      const exFirst   = spaceIdx >= 0 ? existing.slice(0, spaceIdx) : existing;
      const exLast    = spaceIdx >= 0 ? existing.slice(spaceIdx + 1) : '';
      const newFirst  = first_name != null ? first_name.trim() : exFirst;
      const newLast   = last_name  != null ? last_name.trim()  : exLast;

      try {
        normalized_name = normalizeIdentifier('name', `${newFirst} ${newLast}`);
      } catch (normErr) {
        if (normErr instanceof NormalizationError) {
          return res.status(400).json({ error: 'validation failed', detail: normErr.message });
        }
        throw normErr;
      }
    } else {
      normalized_name = prebuilt_name; // null when nameProvided is false
    }

    // TRANSACTION
    await req.db.query('BEGIN');

    if (nameProvided) {
      await req.db.query(
        `INSERT INTO identifier_link
           (fan_id, identifier_type, identifier_value, org_id,
            source_system, schema_version, confidence_score,
            first_seen_at, last_seen_at)
         VALUES ($1, 'name', $2, $3, 'fan_pass', '1.0', 1.0, NOW(), NOW())
         ON CONFLICT (fan_id, identifier_type, org_id)
         DO UPDATE SET identifier_value = EXCLUDED.identifier_value,
                       last_seen_at     = NOW()`,
        [minor_fan_id, normalized_name, org_id]
      );
      updated_fields.push('child_name');
    }

    if (dobProvided) {
      await req.db.query(
        `INSERT INTO identifier_link
           (fan_id, identifier_type, identifier_value, org_id,
            source_system, schema_version, confidence_score,
            first_seen_at, last_seen_at)
         VALUES ($1, 'dob', $2, $3, 'fan_pass', '1.0', 1.0, NOW(), NOW())
         ON CONFLICT (fan_id, identifier_type, org_id)
         DO UPDATE SET identifier_value = EXCLUDED.identifier_value,
                       last_seen_at     = NOW()`,
        [minor_fan_id, normalized_dob, org_id]
      );
      await req.db.query(
        'UPDATE household_member SET dob = $1 WHERE id = $2',
        [normalized_dob, member_id]
      );
      updated_fields.push('child_dob');
    }

    if (emailProvided) {
      await req.db.query(
        `INSERT INTO identifier_link
           (fan_id, identifier_type, identifier_value, org_id,
            source_system, schema_version, confidence_score,
            first_seen_at, last_seen_at)
         VALUES ($1, 'guardian_email', $2, $3, 'fan_pass', '1.0', 1.0, NOW(), NOW())
         ON CONFLICT (fan_id, identifier_type, org_id)
         DO UPDATE SET identifier_value = EXCLUDED.identifier_value,
                       last_seen_at     = NOW()`,
        [minor_fan_id, normalized_email, org_id]
      );
      updated_fields.push('guardian_email');
    }

    if (phoneProvided) {
      await req.db.query(
        `INSERT INTO identifier_link
           (fan_id, identifier_type, identifier_value, org_id,
            source_system, schema_version, confidence_score,
            first_seen_at, last_seen_at)
         VALUES ($1, 'guardian_phone', $2, $3, 'fan_pass', '1.0', 1.0, NOW(), NOW())
         ON CONFLICT (fan_id, identifier_type, org_id)
         DO UPDATE SET identifier_value = EXCLUDED.identifier_value,
                       last_seen_at     = NOW()`,
        [minor_fan_id, normalized_phone, org_id]
      );
      updated_fields.push('guardian_phone');
    }

    // Audit event — always last write in transaction
    await req.db.query(
      `INSERT INTO audit_log (id, fan_id, org_id, event_type, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'household_member_updated', 'success', NOW())`,
      [jwt_fan_id, org_id]
    );

    await req.db.query('COMMIT');
  } catch (err) {
    await req.db.query('ROLLBACK').catch(() => {});
    logger.error('household member update failed', {
      error:          err.message,
      fan_id:         jwt_fan_id,
      child_fan_id,
      org_id,
      correlation_id: req.context.correlation_id,
    });
    return res.status(500).json({ error: 'household member could not be updated' });
  }

  // RETURN
  return res.status(200).json({
    household_member_id: member_id,
    minor_fan_id,
    adult_fan_id:        jwt_fan_id,
    updated_fields,
    updated_at:          new Date().toISOString(),
  });
});

// COMPONENT 32 — DELETE /v1/household/:adult_fan_id/members/:child_fan_id
router.delete('/v1/household/:adult_fan_id/members/:child_fan_id', async (req, res) => {
  // RECEIVE
  const url_adult_fan_id = req.params.adult_fan_id;
  const child_fan_id     = req.params.child_fan_id;
  const jwt_fan_id       = req.context.fan_id;
  const org_id           = req.context.org_id;

  // GUARD — in-memory only, no db calls
  if (!url_adult_fan_id || !UUID_RE.test(url_adult_fan_id)) {
    return res.status(400).json({ error: 'adult_fan_id must be a valid UUID' });
  }
  if (!child_fan_id || !UUID_RE.test(child_fan_id)) {
    return res.status(400).json({ error: 'child_fan_id must be a valid UUID' });
  }
  if (url_adult_fan_id !== jwt_fan_id) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // EXECUTE
  let member, updateResult;
  try {
    // READ 1 — verify adult fan exists, belongs to org, not soft-deleted
    const fanResult = await req.db.query(
      'SELECT id, deleted_at FROM fan WHERE id = $1 AND org_id = $2',
      [jwt_fan_id, org_id]
    );
    const fan = fanResult.rows[0];
    if (!fan)           return res.status(404).json({ error: 'fan not found' });
    if (fan.deleted_at) return res.status(403).json({ error: 'fan account is inactive' });

    // READ 2 — verify household exists for this adult
    const householdResult = await req.db.query(
      'SELECT id FROM household WHERE adult_fan_id = $1 AND org_id = $2',
      [jwt_fan_id, org_id]
    );
    if (!householdResult.rows[0]) {
      return res.status(404).json({ error: 'household not found' });
    }

    // READ 3 — verify household_member exists — no status filter in SQL
    // Status check in application code to distinguish 404 (not found) from 409 (found but not active)
    const memberResult = await req.db.query(
      `SELECT id, status FROM household_member
       WHERE minor_fan_id = $1 AND adult_fan_id = $2 AND org_id = $3`,
      [child_fan_id, jwt_fan_id, org_id]
    );
    member = memberResult.rows[0];
    if (!member) {
      return res.status(404).json({ error: 'household member not found' });
    }
    if (member.status !== 'active') {
      return res.status(409).json({ error: 'member is not active' });
    }

    // TRANSACTION
    await req.db.query('BEGIN');

    // STEP 1 — sever household_member link
    // Child fan record, identifier_link rows, and Firestore wallet are untouched
    const updateRes = await req.db.query(
      `UPDATE household_member
       SET status     = 'severed',
           severed_at = NOW(),
           severed_by = 'guardian'
       WHERE id = $1
       RETURNING id, minor_fan_id, severed_at, severed_by`,
      [member.id]
    );
    updateResult = updateRes.rows[0];

    // STEP 2 — audit event — always last write in transaction
    await req.db.query(
      `INSERT INTO audit_log (id, fan_id, org_id, event_type, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'household_member_severed', 'success', NOW())`,
      [jwt_fan_id, org_id]
    );

    await req.db.query('COMMIT');
  } catch (err) {
    await req.db.query('ROLLBACK').catch(() => {});
    logger.error('household member sever failed', {
      error:          err.message,
      fan_id:         jwt_fan_id,
      child_fan_id,
      org_id,
      correlation_id: req.context.correlation_id,
    });
    return res.status(500).json({ error: 'household member could not be severed' });
  }

  // RETURN
  return res.status(200).json({
    household_member_id: member.id,
    minor_fan_id:        child_fan_id,
    adult_fan_id:        jwt_fan_id,
    status:              'severed',
    severed_at:          updateResult.severed_at,
    severed_by:          updateResult.severed_by,
  });
});

// COMPONENT 33 — POST /v1/household/:adult_fan_id/members/:child_fan_id/session
router.post('/v1/household/:adult_fan_id/members/:child_fan_id/session', async (req, res) => {
  // RECEIVE
  const url_adult_fan_id = req.params.adult_fan_id;
  const child_fan_id     = req.params.child_fan_id;
  const jwt_fan_id       = req.context.fan_id;
  const org_id           = req.context.org_id;

  // GUARD — in-memory only, no db calls
  if (!url_adult_fan_id || !UUID_RE.test(url_adult_fan_id)) {
    return res.status(400).json({ error: 'adult_fan_id must be a valid UUID' });
  }
  if (!child_fan_id || !UUID_RE.test(child_fan_id)) {
    return res.status(400).json({ error: 'child_fan_id must be a valid UUID' });
  }
  if (url_adult_fan_id !== jwt_fan_id) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // EXECUTE — Pattern 1: single TRY wraps all db reads and token issuance
  let tokenResult;
  try {
    // READ 1 — verify adult fan exists, belongs to org, not soft-deleted
    const fanResult = await req.db.query(
      'SELECT id, deleted_at FROM fan WHERE id = $1 AND org_id = $2',
      [jwt_fan_id, org_id]
    );
    const fan = fanResult.rows[0];
    if (!fan)           return res.status(404).json({ error: 'fan not found' });
    if (fan.deleted_at) return res.status(403).json({ error: 'fan account is inactive' });

    // READ 2 — verify household exists for this adult
    const householdResult = await req.db.query(
      'SELECT id FROM household WHERE adult_fan_id = $1 AND org_id = $2',
      [jwt_fan_id, org_id]
    );
    if (!householdResult.rows[0]) {
      return res.status(404).json({ error: 'household not found' });
    }

    // READ 3 — verify member is active
    // SQL WHERE status = 'active' covers severed, aged_up, and not found — all return 404
    const memberResult = await req.db.query(
      `SELECT id, minor_fan_id FROM household_member
       WHERE minor_fan_id = $1 AND adult_fan_id = $2
         AND org_id = $3 AND status = 'active'`,
      [child_fan_id, jwt_fan_id, org_id]
    );
    if (!memberResult.rows[0]) {
      return res.status(404).json({ error: 'household member not found' });
    }

    // Issue child JWT — 8-hour expiry, no db writes, no audit event
    tokenResult = signToken({
      fan_id:    child_fan_id,
      org_id,
      expiresIn: 8 * 60 * 60,
      acting_as: 'child',
      guardian:  jwt_fan_id,
    });
  } catch (err) {
    logger.error('child session issue failed', {
      error:          err.message,
      fan_id:         jwt_fan_id,
      child_fan_id,
      org_id,
      correlation_id: req.context.correlation_id,
    });
    return res.status(500).json({ error: 'child session could not be issued' });
  }

  // RETURN
  return res.status(200).json({
    token:        tokenResult.token,
    expires_at:   tokenResult.expires_at,
    minor_fan_id: child_fan_id,
    acting_as:    'child',
  });
});

// COMPONENT 34 — POST /v1/household/:adult_fan_id/members/:child_fan_id/age-up
router.post('/v1/household/:adult_fan_id/members/:child_fan_id/age-up', async (req, res) => {
  // RECEIVE
  const url_adult_fan_id = req.params.adult_fan_id;
  const child_fan_id     = req.params.child_fan_id;
  const jwt_fan_id       = req.context.fan_id;
  const org_id           = req.context.org_id;

  // GUARD — in-memory only, no db calls
  if (!url_adult_fan_id || !UUID_RE.test(url_adult_fan_id)) {
    return res.status(400).json({ error: 'adult_fan_id must be a valid UUID' });
  }
  if (!child_fan_id || !UUID_RE.test(child_fan_id)) {
    return res.status(400).json({ error: 'child_fan_id must be a valid UUID' });
  }
  if (url_adult_fan_id !== jwt_fan_id) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // EXECUTE — Pattern 1: single TRY wraps all db reads and writes
  let updated, minor_fan_id, claim_expires, raw_token;
  try {
    // READ 1 — verify adult fan exists, belongs to org, not soft-deleted
    const fanResult = await req.db.query(
      'SELECT id, deleted_at FROM fan WHERE id = $1 AND org_id = $2',
      [jwt_fan_id, org_id]
    );
    const fan = fanResult.rows[0];
    if (!fan)           return res.status(404).json({ error: 'fan not found' });
    if (fan.deleted_at) return res.status(403).json({ error: 'fan account is inactive' });

    // READ 2 — verify household exists for this adult
    const householdResult = await req.db.query(
      'SELECT id FROM household WHERE adult_fan_id = $1 AND org_id = $2',
      [jwt_fan_id, org_id]
    );
    if (!householdResult.rows[0]) {
      return res.status(404).json({ error: 'household not found' });
    }

    // READ 3 — fetch member WITHOUT status filter
    // Status checked in app code to distinguish 404 (not found) from 409 (found but wrong state)
    const memberResult = await req.db.query(
      `SELECT id, minor_fan_id, status FROM household_member
       WHERE minor_fan_id = $1 AND adult_fan_id = $2 AND org_id = $3`,
      [child_fan_id, jwt_fan_id, org_id]
    );
    const member = memberResult.rows[0];
    if (!member) {
      return res.status(404).json({ error: 'household member not found' });
    }
    if (member.status === 'aged_up') {
      return res.status(409).json({ error: 'member already aged up' });
    }
    if (member.status === 'severed') {
      return res.status(409).json({ error: 'member has been severed' });
    }
    minor_fan_id = member.minor_fan_id;

    // READ 4 — guardian email — fetched for email service when real sender is wired up
    await req.db.query(
      `SELECT identifier_value FROM identifier_link
       WHERE fan_id = $1 AND org_id = $2 AND identifier_type = 'guardian_email'
       LIMIT 1`,
      [minor_fan_id, org_id]
    );

    // GENERATE — before transaction — hash stored, raw token only in email stub log
    raw_token          = crypto.randomUUID() + crypto.randomUUID();
    const token_hash   = crypto.createHash('sha256').update(raw_token).digest('hex');
    claim_expires      = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // TRANSACTION
    await req.db.query('BEGIN');

    // STEP 1 — update household_member — store hash, never raw token
    const updateResult = await req.db.query(
      `UPDATE household_member
       SET status                 = 'aged_up',
           aged_up_at             = NOW(),
           aged_up_initiated_by   = 'guardian',
           claim_token            = $1,
           claim_token_expires_at = $2
       WHERE id = $3
       RETURNING id, minor_fan_id, aged_up_at, aged_up_initiated_by, claim_token_expires_at`,
      [token_hash, claim_expires, member.id]
    );
    updated = updateResult.rows[0];

    // STEP 2 — write to related_fans — meaningful transition worth recording
    await req.db.query(
      `INSERT INTO related_fans
         (id, fan_id_a, fan_id_b, org_id, relationship, source, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'aged_up', 'household', NOW())`,
      [jwt_fan_id, minor_fan_id, org_id]
    );

    // STEP 3 — audit event — always last write in transaction
    await req.db.query(
      `INSERT INTO audit_log (id, fan_id, org_id, event_type, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'household_member_aged_up', 'success', NOW())`,
      [jwt_fan_id, org_id]
    );

    await req.db.query('COMMIT');

    // EMAIL STUB — after commit, fire and forget — token is a credential, never logged
    logger.info('AGE-UP EMAIL STUB', {
      subject:    'Your child can now claim their Thunder account',
      claim_url:  'https://fanpass.thunder.com/claim/[REDACTED]',
      expires_at: claim_expires,
      email_stub: true,
    });
  } catch (err) {
    await req.db.query('ROLLBACK').catch(() => {});
    logger.error('age-up initiation failed', {
      error:          err.message,
      fan_id:         jwt_fan_id,
      child_fan_id,
      org_id,
      correlation_id: req.context.correlation_id,
    });
    return res.status(500).json({ error: 'age-up could not be completed' });
  }

  // RETURN — raw token and hash never appear here
  return res.status(200).json({
    household_member_id:    updated.id,
    minor_fan_id,
    adult_fan_id:           jwt_fan_id,
    status:                 'aged_up',
    aged_up_at:             updated.aged_up_at,
    aged_up_initiated_by:   'guardian',
    claim_token_expires_at: claim_expires,
    email_stub:             true,
  });
});

// COMPONENT 35 — GET /v1/household/claim/:token
// Mounted on householdPublicRouter in index.js — no jwtMiddleware.
// Child presents the claim token forwarded by the guardian.
// Token is single-use and compared via crypto.timingSafeEqual.
const claimRouter = express.Router();

claimRouter.get('/v1/household/claim/:token', async (req, res) => {
  // RECEIVE
  const raw_token = req.params.token;
  const org_id    = req.context.org_id;

  // GUARD — in-memory only
  if (!raw_token || !raw_token.trim()) {
    return res.status(400).json({ error: 'claim token is required' });
  }

  // EXECUTE — Pattern 1: single TRY wraps all db work
  let member, tokenResult;
  try {
    // Compute sha256 hash of the incoming raw token for comparison
    const incoming_hash = crypto.createHash('sha256').update(raw_token).digest('hex');
    const incoming_buf  = Buffer.from(incoming_hash, 'hex');

    // READ 1 — fetch all aged_up members for this org
    // Timing-safe comparison in application code — never WHERE claim_token = $1
    const membersResult = await req.db.query(
      `SELECT id, minor_fan_id, adult_fan_id,
              claim_token, claim_token_expires_at
       FROM household_member
       WHERE org_id = $1
         AND status = 'aged_up'`,
      [org_id]
    );

    member = null;
    for (const row of membersResult.rows) {
      if (!row.claim_token) continue;
      try {
        const stored_buf = Buffer.from(row.claim_token, 'hex');
        if (stored_buf.length === incoming_buf.length &&
            crypto.timingSafeEqual(stored_buf, incoming_buf)) {
          member = row;
          break;
        }
      } catch (_) {
        // malformed stored hash — skip row
      }
    }

    if (!member) {
      return res.status(404).json({ error: 'claim token not found' });
    }

    // Expiry check — 410, not 404
    if (new Date(member.claim_token_expires_at) < new Date()) {
      return res.status(410).json({ error: 'claim token has expired' });
    }

    // READ 2 — verify child fan exists and is not soft-deleted
    const fanResult = await req.db.query(
      'SELECT id, deleted_at FROM fan WHERE id = $1 AND org_id = $2',
      [member.minor_fan_id, org_id]
    );
    const childFan = fanResult.rows[0];
    if (!childFan) {
      return res.status(404).json({ error: 'child fan record not found' });
    }
    if (childFan.deleted_at) {
      return res.status(403).json({ error: 'fan account is inactive' });
    }

    // TRANSACTION
    await req.db.query('BEGIN');

    // STEP 1 — clear claim token — single use
    await req.db.query(
      `UPDATE household_member
       SET claim_token = NULL,
           claim_token_expires_at = NULL
       WHERE id = $1`,
      [member.id]
    );

    // STEP 2 — issue standard 15-minute fan JWT (pure computation — no db write)
    tokenResult = signToken({ fan_id: member.minor_fan_id, org_id });

    // STEP 3 — audit event — always last write in transaction
    await req.db.query(
      `INSERT INTO audit_log (id, fan_id, org_id, event_type, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'profile_claimed', 'success', NOW())`,
      [member.minor_fan_id, org_id]
    );

    await req.db.query('COMMIT');
  } catch (err) {
    await req.db.query('ROLLBACK').catch(() => {});
    logger.error('profile claim failed', {
      error:          err.message,
      org_id,
      correlation_id: req.context.correlation_id,
    });
    return res.status(500).json({ error: 'profile could not be claimed' });
  }

  // RETURN
  return res.status(200).json({
    fan_id:     member.minor_fan_id,
    token:      tokenResult.token,
    expires_at: tokenResult.expires_at,
    claimed_at: new Date().toISOString(),
  });
});

router.householdClaimRouter = claimRouter;
module.exports = router;
