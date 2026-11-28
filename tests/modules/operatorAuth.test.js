'use strict';

const crypto = require('crypto');
const { openSession } = require('../../src/modules/operatorAuth');

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function fakePool(operator) {
  const queries = [];
  let released = false;
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (String(sql).includes('FROM operator')) return { rows: operator ? [operator] : [] };
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  return {
    queries,
    released: () => released,
    pool: { connect: async () => client },
  };
}

describe('openSession tenant setting', () => {
  const orgId = 'aaaaaaaa-0000-0000-0000-0000000000aa';
  const salt = 'salt-for-test';
  const password = 'correct-horse';
  const operator = {
    id: 'bbbbbbbb-0000-0000-0000-0000000000bb',
    org_id: orgId,
    email: 'ada@example.com',
    role: 'admin',
    password_salt: salt,
    password_hash: hashPassword(password, salt),
    is_active: true,
    org_name: 'Example Org',
    org_active: true,
  };

  test('a correct password sets the tenant inside the transaction before the audit insert', async () => {
    const fake = fakePool(operator);
    const session = await openSession(fake.pool, { email: operator.email, password });

    expect(session.org_id).toBe(orgId);
    expect(session.operator_id).toBe(operator.id);
    expect(session.role).toBe('admin');
    const sql = fake.queries.map((query) => query.sql);
    const beginAt = sql.findIndex((text) => text === 'BEGIN');
    const settingAt = sql.findIndex((text) => text.includes('set_config'));
    const auditAt = sql.findIndex((text) => text.includes('INSERT INTO audit_log'));
    const commitAt = sql.findIndex((text) => text === 'COMMIT');

    expect(beginAt).toBeGreaterThanOrEqual(0);
    expect(settingAt).toBeGreaterThan(beginAt);
    expect(auditAt).toBeGreaterThan(settingAt);
    expect(commitAt).toBeGreaterThan(auditAt);
    expect(fake.queries[settingAt].sql).toContain('app.current_org_id');
    expect(fake.queries[settingAt].sql).toContain('true');
    expect(fake.queries[settingAt].params).toEqual([orgId]);
    expect(fake.queries[auditAt].params).toEqual([orgId, operator.id, operator.email]);
    expect(fake.released()).toBe(true);
  });

  test('a wrong password does not open a transaction', async () => {
    const fake = fakePool(operator);
    const session = await openSession(fake.pool, { email: operator.email, password: 'wrong-password' });

    expect(session).toBeNull();
    expect(fake.queries.map((query) => query.sql)).not.toContain('BEGIN');
    expect(fake.released()).toBe(true);
  });
});
