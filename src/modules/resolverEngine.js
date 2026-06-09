'use strict';

const crypto    = require('crypto');
const { Firestore } = require('@google-cloud/firestore');
const { scoreMatch } = require('./probabilisticMatcher');

require('dotenv').config();

const THRESHOLD_PATH_C = 0.85;
const THRESHOLD_PATH_D = 0.60;

const firestore = new Firestore({
  projectId:  process.env.FIRESTORE_PROJECT_ID,
  databaseId: 'golden-record',
});

const logger = { error: console.error, warn: console.warn };

class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
  }
}

class ResolverError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResolverError';
  }
}

// RECEIVE
async function resolverEngine(input, db) {
  const identifier_type  = input.identifier_type;
  const identifier_value = input.identifier_value;
  const org_id           = input.org_id;
  const schema_version   = input.schema_version;
  const idempotency_key  = input.idempotency_key;
  const source_system    = input.source_system;

  let fan_id           = null;
  let match_type       = null;
  let confidence_score = null;
  let is_new_record    = null;
  let audit_event_id   = null;
  let conflict_id      = null;
  let linked_systems   = [];
  let linked_count     = 0;

  // OUTER TRY — Pattern 2: wraps GUARD and EXECUTE together
  try {

    // GUARD 1 — verify org exists and is active
    const orgResult = await db.query(
      'SELECT id, is_active FROM org WHERE id = $1',
      [org_id]
    );
    if (orgResult.rows.length === 0) {
      throw new ResolverError(`org_id not found: ${org_id}`);
    }
    if (orgResult.rows[0].is_active === false) {
      throw new ResolverError(`org is inactive: ${org_id}`);
    }

    // GUARD 2 — idempotency check
    const idempotencyResult = await db.query(
      `SELECT fan_id, match_type, confidence_score, is_new_record, id
       FROM audit_log
       WHERE idempotency_key = $1 AND org_id = $2
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [idempotency_key, org_id]
    );
    if (idempotencyResult.rows.length > 0) {
      const e = idempotencyResult.rows[0];
      return {
        fan_id:           e.fan_id,
        match_type:       e.match_type,
        confidence_score: e.confidence_score,
        is_new_record:    false,
        linked_systems:   [],
        linked_count:     0,
        audit_event_id:   e.id,
        conflict_id:      null  // not stored in audit_log — query GET /v1/conflicts if needed
      };
    }

    // EXECUTE — BEGIN TRANSACTION
    await db.query('BEGIN');

    const linkResult = await db.query(
      `SELECT fan_id, confidence_score FROM identifier_link
       WHERE identifier_type = $1 AND identifier_value = $2 AND org_id = $3`,
      [identifier_type, identifier_value, org_id]
    );

    if (linkResult.rows.length > 0) {
      // PATH A — hard match
      fan_id           = linkResult.rows[0].fan_id;
      match_type       = 'hard';
      confidence_score = 1.0;
      is_new_record    = false;

      await db.query(
        `UPDATE identifier_link SET last_seen_at = NOW()
         WHERE identifier_type = $1 AND identifier_value = $2 AND org_id = $3`,
        [identifier_type, identifier_value, org_id]
      );

    } else {
      // STEP 1 — find candidates for probabilistic scoring (module call before any db write)
      const candidateRows = await db.query(
        `SELECT f.id, f.org_id,
                il_email.identifier_value    AS email,
                il_email.last_seen_at        AS email_last_seen_at,
                il_name.identifier_value     AS name,
                il_name.last_seen_at         AS name_last_seen_at,
                il_dob.identifier_value      AS dob,
                il_dob.last_seen_at          AS dob_last_seen_at,
                il_zip.identifier_value      AS zip,
                il_zip.last_seen_at          AS zip_last_seen_at,
                il_device.identifier_value   AS device_id,
                il_device.last_seen_at       AS device_last_seen_at,
                il_gemail.identifier_value   AS guardian_email,
                il_gemail.last_seen_at       AS guardian_email_last_seen_at
         FROM fan f
         LEFT JOIN identifier_link il_email
           ON il_email.fan_id = f.id
           AND il_email.identifier_type = 'email'
           AND il_email.org_id = $1
         LEFT JOIN identifier_link il_name
           ON il_name.fan_id = f.id
           AND il_name.identifier_type = 'name'
           AND il_name.org_id = $1
         LEFT JOIN identifier_link il_dob
           ON il_dob.fan_id = f.id
           AND il_dob.identifier_type = 'dob'
           AND il_dob.org_id = $1
         LEFT JOIN identifier_link il_zip
           ON il_zip.fan_id = f.id
           AND il_zip.identifier_type = 'zip'
           AND il_zip.org_id = $1
         LEFT JOIN identifier_link il_device
           ON il_device.fan_id = f.id
           AND il_device.identifier_type = 'device_id'
           AND il_device.org_id = $1
         LEFT JOIN identifier_link il_gemail
           ON il_gemail.fan_id = f.id
           AND il_gemail.identifier_type = 'guardian_email'
           AND il_gemail.org_id = $1
         WHERE f.org_id = $1
           AND f.deleted_at IS NULL
         LIMIT 100`,
        [org_id]
      );

      // Build inbound object — maps current identifier to signal fields
      const inbound = {
        org_id:         org_id,
        email:          identifier_type === 'email'          ? identifier_value : null,
        name:           identifier_type === 'name'           ? identifier_value : null,
        dob:            identifier_type === 'dob'            ? identifier_value : null,
        zip:            identifier_type === 'zip'            ? identifier_value : null,
        device_id:      identifier_type === 'device_id'      ? identifier_value : null,
        guardian_email: identifier_type === 'guardian_email' ? identifier_value : null,
      };

      // STEP 2 — score each candidate, track best
      let bestMatch   = null;
      let bestScore   = 0.0;
      let bestSignals = [];

      for (const candidate of candidateRows.rows) {
        const result = scoreMatch(candidate, inbound);
        if (result.score > bestScore) {
          bestScore   = result.score;
          bestMatch   = candidate;
          bestSignals = result.signals_matched;
        }
      }

      // Soft link detection — guardian_email signal triggers staging write
      const guardianEmailSignal = bestSignals.find(s => s.signal === 'guardian_email');
      if (guardianEmailSignal !== undefined) {
        try {
          await db.query(
            `INSERT INTO staging_household_data
               (id, adult_fan_id, org_id, child_name, child_dob,
                source, raw_data, confidence, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT DO NOTHING`,
            [
              crypto.randomUUID(),
              bestMatch.id,
              org_id,
              inbound.name,
              inbound.dob,
              source_system,
              JSON.stringify(inbound),
              guardianEmailSignal.adjusted_score,
            ]
          );
        } catch (stagingErr) {
          logger.warn('soft link staging failed', {
            event:  'soft_link_staging_failure',
            error:  stagingErr.message,
            org_id: org_id,
          });
        }
      }

      if (bestScore >= THRESHOLD_PATH_C) {
        // PATH C — high confidence soft match, hold for staff review (priority 1)
        const new_fan_id = crypto.randomUUID();
        fan_id           = new_fan_id;
        match_type       = 'soft';
        confidence_score = bestScore;
        is_new_record    = true;

        await db.query(
          `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
           VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
          [new_fan_id, org_id]
        );
        await db.query(
          `INSERT INTO identifier_link
             (fan_id, identifier_type, identifier_value, org_id, source_system,
              schema_version, confidence_score, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
          [new_fan_id, identifier_type, identifier_value, org_id,
           source_system, schema_version, bestScore]
        );

        conflict_id = crypto.randomUUID();
        await db.query(
          `INSERT INTO conflict_queue
             (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())`,
          [conflict_id, bestMatch.id, new_fan_id, org_id,
           bestScore, JSON.stringify(bestSignals)]
        );

      } else if (bestScore >= THRESHOLD_PATH_D) {
        // PATH D — lower confidence possible match, hold for staff review (priority 2)
        const new_fan_id = crypto.randomUUID();
        fan_id           = new_fan_id;
        match_type       = 'conflict';
        confidence_score = bestScore;
        is_new_record    = true;

        await db.query(
          `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
           VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
          [new_fan_id, org_id]
        );
        await db.query(
          `INSERT INTO identifier_link
             (fan_id, identifier_type, identifier_value, org_id, source_system,
              schema_version, confidence_score, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
          [new_fan_id, identifier_type, identifier_value, org_id,
           source_system, schema_version, bestScore]
        );

        conflict_id = crypto.randomUUID();
        await db.query(
          `INSERT INTO conflict_queue
             (id, fan_id_a, fan_id_b, org_id, confidence_score, signals_matched, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())`,
          [conflict_id, bestMatch.id, new_fan_id, org_id,
           bestScore, JSON.stringify(bestSignals)]
        );

      } else {
        // PATH B — no match, new record (score below THRESHOLD_PATH_D or no candidates)
        const new_fan_id = crypto.randomUUID();

        await db.query(
          `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
           VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
          [new_fan_id, org_id]
        );
        await db.query(
          `INSERT INTO identifier_link
             (fan_id, identifier_type, identifier_value, org_id, source_system,
              schema_version, confidence_score, first_seen_at, last_seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, 1.0, NOW(), NOW())`,
          [new_fan_id, identifier_type, identifier_value, org_id, source_system, schema_version]
        );

        fan_id           = new_fan_id;
        match_type       = 'hard';
        confidence_score = 1.0;
        is_new_record    = true;
      }
    }

    // STEP 3 — audit event — always last write in transaction
    audit_event_id = crypto.randomUUID();
    await db.query(
      `INSERT INTO audit_log
         (id, fan_id, org_id, event_type, match_type, confidence_score,
          is_new_record, idempotency_key, identifier_type, schema_version, status, created_at)
       VALUES ($1, $2, $3, 'resolution', $4, $5, $6, $7, $8, $9, 'success', NOW())`,
      [audit_event_id, fan_id, org_id, match_type, confidence_score,
       is_new_record, idempotency_key, identifier_type, schema_version]
    );

    await db.query('COMMIT');

    // STEP 4B — Firestore sync — after COMMIT, outside transaction, new records only
    if (is_new_record === true) {
      try {
        await firestore.collection('golden-record').doc(fan_id).set({
          fan_id:         fan_id,
          org_id:         org_id,
          loyalty_points: 0,
          stamps:         [],
          avatar:         null,
          created_at:     new Date().toISOString()
        });
      } catch (firestoreErr) {
        logger.error('Firestore sync failed for new fan', {
          fan_id:  fan_id,
          org_id:  org_id,
          error:   firestoreErr.message
        });
        // do NOT throw — Postgres record is committed and valid
      }
    }

    // STEP 5 — linked systems query — after COMMIT, outside transaction
    const linkedResult = await db.query(
      'SELECT DISTINCT source_system FROM identifier_link WHERE fan_id = $1 AND org_id = $2',
      [fan_id, org_id]
    );
    linked_systems = linkedResult.rows.map(row => row.source_system);
    linked_count   = linked_systems.length;

  } catch (err) {

    if (err instanceof ConflictError || err.code === '40001') {
      await db.query('ROLLBACK').catch(() => {});
      throw new ConflictError('record_version conflict — concurrent write');
    }

    await db.query('ROLLBACK').catch(() => {});

    try {
      await db.query(
        `INSERT INTO audit_log
           (id, org_id, event_type, identifier_type, idempotency_key, status, error_detail, created_at)
         VALUES ($1, $2, 'resolution', $3, $4, 'error', $5, NOW())`,
        [crypto.randomUUID(), org_id, identifier_type, idempotency_key, err.message]
      );
    } catch {
      logger.error('audit log write failed', { org_id, identifier_type, error: err.message });
    }

    throw new ResolverError(`resolver failure: ${err.message}`);

  }

  // RETURN
  return { fan_id, match_type, confidence_score, is_new_record,
           linked_systems, linked_count, audit_event_id, conflict_id };
}

module.exports = { resolverEngine, ConflictError, ResolverError };
