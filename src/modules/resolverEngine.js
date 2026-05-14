'use strict';

const crypto    = require('crypto');
const pool      = require('../db/pool');
const { Firestore } = require('@google-cloud/firestore');

require('dotenv').config();

const firestore = new Firestore({ projectId: process.env.FIRESTORE_PROJECT_ID });

const logger = { error: console.error };

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
async function resolverEngine(input) {
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
  let linked_systems   = [];
  let linked_count     = 0;

  const client = await pool.connect();

  // OUTER TRY — Pattern 2: wraps GUARD and EXECUTE together
  try {

    // GUARD 1 — verify org exists and is active
    const orgResult = await client.query(
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
    const idempotencyResult = await client.query(
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
        is_new_record:    e.is_new_record,
        linked_systems:   [],
        linked_count:     0,
        audit_event_id:   e.id
      };
    }

    // EXECUTE — BEGIN TRANSACTION
    await client.query('BEGIN');

    const linkResult = await client.query(
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

      await client.query(
        `UPDATE identifier_link SET last_seen_at = NOW()
         WHERE identifier_type = $1 AND identifier_value = $2 AND org_id = $3`,
        [identifier_type, identifier_value, org_id]
      );

    } else {
      // PATH B — new record
      const new_fan_id = crypto.randomUUID();

      await client.query(
        `INSERT INTO fan (id, org_id, stewardship_tier, record_version, created_at, updated_at)
         VALUES ($1, $2, 'platform', 1, NOW(), NOW())`,
        [new_fan_id, org_id]
      );
      await client.query(
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

    // STEP 3 — audit event — always last write in transaction
    audit_event_id = crypto.randomUUID();
    await client.query(
      `INSERT INTO audit_log
         (id, fan_id, org_id, event_type, match_type, confidence_score,
          is_new_record, idempotency_key, identifier_type, schema_version, status, created_at)
       VALUES ($1, $2, $3, 'resolution', $4, $5, $6, $7, $8, $9, 'success', NOW())`,
      [audit_event_id, fan_id, org_id, match_type, confidence_score,
       is_new_record, idempotency_key, identifier_type, schema_version]
    );

    await client.query('COMMIT');

    // STEP 4B — Firestore sync — after COMMIT, outside transaction, new records only
    if (is_new_record === true) {
      try {
        await firestore.collection('fans').doc(fan_id).set({
          fan_id:     fan_id,
          org_id:     org_id,
          loyalty_points: 0,
          stamps:     [],
          avatar:     null,
          created_at: new Date().toISOString()
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
    const linkedResult = await pool.query(
      'SELECT DISTINCT source_system FROM identifier_link WHERE fan_id = $1 AND org_id = $2',
      [fan_id, org_id]
    );
    linked_systems = linkedResult.rows.map(row => row.source_system);
    linked_count   = linked_systems.length;

  } catch (err) {

    if (err instanceof ConflictError || err.code === '40001') {
      await client.query('ROLLBACK').catch(() => {});
      throw new ConflictError('record_version conflict — concurrent write');
    }

    await client.query('ROLLBACK').catch(() => {});

    try {
      await pool.query(
        `INSERT INTO audit_log
           (id, org_id, event_type, identifier_type, idempotency_key, status, error_detail, created_at)
         VALUES ($1, $2, 'resolution', $3, $4, 'error', $5, NOW())`,
        [crypto.randomUUID(), org_id, identifier_type, idempotency_key, err.message]
      );
    } catch {
      logger.error('audit log write failed', { org_id, identifier_type, error: err.message });
    }

    throw new ResolverError(`resolver failure: ${err.message}`);

  } finally {
    client.release();
  }

  // RETURN
  return { fan_id, match_type, confidence_score, is_new_record,
           linked_systems, linked_count, audit_event_id };
}

module.exports = { resolverEngine, ConflictError, ResolverError };
