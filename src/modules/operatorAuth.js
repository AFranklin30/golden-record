'use strict';

const crypto = require('crypto');

const SESSION_MS = 12 * 60 * 60 * 1000;
const VALID_ROLES = ['admin', 'operator'];

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
const DUMMY_HASH = hashPassword(crypto.randomBytes(32).toString('hex'), DUMMY_SALT);

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

async function insertOperatorRow(conn, { orgId, email, password, role }) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@') || normalized.length > 320) {
    throw new Error('operator email is invalid');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new Error('operator password must be 8 to 200 characters');
  }
  if (role !== undefined && !VALID_ROLES.includes(role)) {
    throw new Error('operator role must be admin or operator');
  }

  await conn.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`operator_org_${orgId}`]);
  const existing = await conn.query(
    `SELECT COUNT(*)::int AS n
       FROM operator
      WHERE org_id = $1
        AND is_active = true
        AND role = 'admin'`,
    [orgId]
  );
  const assignedRole = existing.rows[0].n === 0 ? 'admin' : (role || 'operator');

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const result = await conn.query(
    `INSERT INTO operator (org_id, email, role, password_salt, password_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, org_id, email, role, is_active, created_at`,
    [orgId, normalized, assignedRole, salt, passwordHash]
  );
  return result.rows[0];
}

async function createOperator(client, options) {
  if (typeof client.connect === 'function' && typeof client.totalCount === 'number') {
    const conn = await client.connect();
    try {
      await conn.query('BEGIN');
      const created = await insertOperatorRow(conn, options);
      await conn.query('COMMIT');
      return created;
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }
  return insertOperatorRow(client, options);
}

async function openSession(pool, { email, password }) {
  const normalized = normalizeEmail(email || '');
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT op.id, op.org_id, op.email, op.role, op.password_salt, op.password_hash, op.is_active,
              org.name AS org_name, org.is_active AS org_active
         FROM operator op
         JOIN org ON org.id = op.org_id
        WHERE op.email = $1`,
      [normalized]
    );
    const operator = result.rows[0];
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) return null;

    const salt = operator ? operator.password_salt : DUMMY_SALT;
    const expectedHex = operator ? operator.password_hash : DUMMY_HASH;
    const actual = Buffer.from(hashPassword(password, salt), 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    const passwordMatches = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    if (!operator || !operator.is_active || !operator.org_active || !passwordMatches) return null;

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_MS);
    await client.query('BEGIN');
    try {
      // audit_log has FORCE row-level security. The third argument keeps the
      // tenant setting inside this transaction, then clears it on commit.
      await client.query(
        `SELECT set_config('app.current_org_id', $1, true)`,
        [operator.org_id]
      );
      await client.query(
        `INSERT INTO operator_session (operator_id, org_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [operator.id, operator.org_id, hashToken(token), expiresAt]
      );
      await client.query(
        `INSERT INTO audit_log
           (org_id, event_type, status, schema_version, actor_type, operator_id, actor_email)
         VALUES ($1, 'dashboard_session_issued', 'success', '1.0', 'operator', $2, $3)`,
        [operator.org_id, operator.id, operator.email]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    return {
      token,
      expires_at: expiresAt,
      operator_id: operator.id,
      email: operator.email,
      role: operator.role,
      org_id: operator.org_id,
      org_name: operator.org_name,
    };
  } finally {
    client.release();
  }
}

async function readSession(client, token) {
  if (!token) return null;
  const result = await client.query(
    `SELECT s.id, s.operator_id, s.org_id, s.expires_at, op.email, op.role, op.is_active,
            org.name AS org_name, org.is_active AS org_active
       FROM operator_session s
       JOIN operator op ON op.id = s.operator_id
       JOIN org ON org.id = s.org_id
      WHERE s.token_hash = $1`,
    [hashToken(token)]
  );
  const session = result.rows[0];
  if (!session) return null;
  if (session.expires_at < new Date() || !session.is_active || !session.org_active) return null;
  return session;
}

async function promoteOperatorRow(conn, { orgId, email }) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@') || normalized.length > 320) {
    throw new Error('operator email is invalid');
  }
  await conn.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`operator_org_${orgId}`]);
  const existing = await conn.query(
    `SELECT id, org_id, email, role, is_active
       FROM operator
      WHERE org_id = $1 AND email = $2
      FOR UPDATE`,
    [orgId, normalized]
  );
  if (existing.rows.length === 0) {
    throw new Error('operator not found');
  }
  if (!existing.rows[0].is_active) {
    throw new Error('cannot promote inactive operator');
  }

  const updated = await conn.query(
    `UPDATE operator
        SET role = 'admin'
      WHERE id = $1 AND org_id = $2
      RETURNING id, org_id, email, role, is_active`,
    [existing.rows[0].id, orgId]
  );
  await conn.query(
    `SELECT set_config('app.current_org_id', $1, true)`,
    [orgId]
  );
  await conn.query(
    `INSERT INTO audit_log
       (org_id, event_type, status, schema_version, actor_type, operator_id, actor_email)
     VALUES ($1, 'operator_promoted', 'success', '1.0', 'system', $2, $3)`,
    [orgId, updated.rows[0].id, updated.rows[0].email]
  );
  return updated.rows[0];
}

async function promoteOperator(client, options) {
  if (typeof client.connect === 'function' && typeof client.totalCount === 'number') {
    const conn = await client.connect();
    try {
      await conn.query('BEGIN');
      const promoted = await promoteOperatorRow(conn, options);
      await conn.query('COMMIT');
      return promoted;
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }
  return promoteOperatorRow(client, options);
}

async function closeSession(client, token) {
  if (!token) return;
  await client.query('DELETE FROM operator_session WHERE token_hash = $1', [hashToken(token)]);
}

module.exports = {
  createOperator,
  promoteOperator,
  openSession,
  readSession,
  closeSession,
  SESSION_MS,
  VALID_ROLES,
};
