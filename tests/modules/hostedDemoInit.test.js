'use strict';

const { spawnSync } = require('child_process');
const {
  DemoInitError,
  inspectDemoTarget,
  assertConfirmed,
  initializeHostedDemo,
  redactSecrets,
} = require('../../src/modules/hostedDemoInit');

const HOST = 'ep-demo-123.us-east-2.aws.neon.tech';
const DATABASE = 'neondb';
const PASSWORD = 'owner-secret';
const VALID = `postgresql://demo_owner:${PASSWORD}@${HOST}:5432/${DATABASE}?sslmode=require`;

function fakeClient({ identity, orgCount = 0, operatorCount = 0, operatorError = null }) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      const text = String(sql);
      queries.push(text);
      if (text.includes('current_user')) return { rows: [identity] };
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (text.includes('FROM org')) return { rows: [{ n: orgCount }] };
      if (text.includes('FROM operator')) return { rows: [{ n: operatorCount }] };
      if (text.includes('INSERT INTO org')) return { rows: [] };
      if (text.includes('INSERT INTO operator')) {
        if (operatorError) throw new Error(operatorError);
        return { rows: [{ id: 'operator-id', org_id: params[0], email: params[1] }] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

const owner = {
  role_name: 'neondb_owner',
  is_superuser: 'off',
  can_insert_org: true,
  can_insert_operator: true,
};

describe('hosted demo target', () => {
  test('a direct Neon URL with sslmode=require is accepted', () => {
    const target = inspectDemoTarget(VALID, HOST, DATABASE);
    expect(target).toEqual({ host: HOST, port: '5432', database: DATABASE });
    expect(JSON.stringify(target)).not.toContain(PASSWORD);
    expect(assertConfirmed(target, `${HOST}/${DATABASE}`)).toBe(`${HOST}/${DATABASE}`);
  });

  test('a direct Neon hostname with a cell label is accepted', () => {
    const host = 'ep-example-123.c-9.us-east-2.aws.neon.tech';
    const connectionString = `postgresql://demo_owner:${PASSWORD}@${host}:5432/${DATABASE}?sslmode=require`;
    expect(inspectDemoTarget(connectionString, host, DATABASE)).toEqual({
      host,
      port: '5432',
      database: DATABASE,
    });
  });

  test.each([
    ['localhost', `postgresql://demo_owner:${PASSWORD}@localhost:5432/${DATABASE}?sslmode=require`, HOST, DATABASE],
    ['loopback', `postgresql://demo_owner:${PASSWORD}@127.0.0.1:5432/${DATABASE}?sslmode=require`, '127.0.0.1', DATABASE],
    ['cloud sql port', `postgresql://demo_owner:${PASSWORD}@${HOST}:5433/${DATABASE}?sslmode=require`, HOST, DATABASE],
    ['pooled endpoint', `postgresql://demo_owner:${PASSWORD}@ep-demo-123-pooler.us-east-2.aws.neon.tech:5432/${DATABASE}?sslmode=require`, 'ep-demo-123-pooler.us-east-2.aws.neon.tech', DATABASE],
    ['other host', `postgresql://demo_owner:${PASSWORD}@db.example.com:5432/${DATABASE}?sslmode=require`, 'db.example.com', DATABASE],
    ['wrong expected host', VALID, 'ep-other-123.us-east-2.aws.neon.tech', DATABASE],
    ['wrong database', VALID, HOST, 'otherdb'],
  ])('rejects %s', (_label, connectionString, expectHost, expectDatabase) => {
    expect(() => inspectDemoTarget(connectionString, expectHost, expectDatabase)).toThrow(DemoInitError);
  });

  test.each([
    ['missing', `postgresql://demo_owner:${PASSWORD}@${HOST}:5432/${DATABASE}`],
    ['disabled', `postgresql://demo_owner:${PASSWORD}@${HOST}:5432/${DATABASE}?sslmode=disable`],
    ['verify-full', `postgresql://demo_owner:${PASSWORD}@${HOST}:5432/${DATABASE}?sslmode=verify-full`],
  ])('rejects sslmode %s', (_label, connectionString) => {
    try {
      inspectDemoTarget(connectionString, HOST, DATABASE);
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(DemoInitError);
      expect(err.code).toBe('sslmode');
      expect(err.message).not.toContain(PASSWORD);
    }
  });

  test('a mismatched confirmation does not count as accepted', () => {
    const target = inspectDemoTarget(VALID, HOST, DATABASE);
    expect(() => assertConfirmed(target, 'yes')).toThrow(DemoInitError);
  });

  test('an error message does not keep the connection secret', () => {
    const redacted = redactSecrets(`connect failed for ${VALID}`, VALID);
    expect(redacted).not.toContain(PASSWORD);
    expect(redacted).not.toContain(VALID);
  });
});

describe('hosted demo initialization', () => {
  test('an empty database inserts one organization and one operator', async () => {
    const client = fakeClient({ identity: owner });
    const created = await initializeHostedDemo(client, {
      orgName: 'Equip AI Labs',
      email: 'Ada@Example.com',
      password: 'correct-horse',
    });

    expect(created.orgName).toBe('Equip AI Labs');
    expect(created.email).toBe('ada@example.com');
    expect(created.password).toBeUndefined();
    expect(client.queries.some((sql) => sql.includes('INSERT INTO org'))).toBe(true);
    expect(client.queries.some((sql) => sql.includes('INSERT INTO operator'))).toBe(true);
    expect(client.queries.at(-1)).toBe('COMMIT');
    expect(client.queries.join('\n')).not.toMatch(/DELETE|TRUNCATE|UPDATE/i);
  });

  test('an existing organization stops before any insert', async () => {
    const client = fakeClient({ identity: owner, orgCount: 1 });
    await expect(initializeHostedDemo(client, {
      orgName: 'Equip AI Labs',
      email: 'ada@example.com',
      password: 'correct-horse',
    })).rejects.toMatchObject({ code: 'exists' });

    expect(client.queries.some((sql) => sql.includes('INSERT INTO'))).toBe(false);
    expect(client.queries).toContain('ROLLBACK');
  });

  test('the application role is refused before a transaction', async () => {
    const client = fakeClient({
      identity: {
        role_name: 'golden_record_app',
        is_superuser: 'off',
        can_insert_org: false,
        can_insert_operator: false,
      },
    });
    await expect(initializeHostedDemo(client, {
      orgName: 'Equip AI Labs',
      email: 'ada@example.com',
      password: 'correct-horse',
    })).rejects.toMatchObject({ code: 'privilege' });
    expect(client.queries).not.toContain('BEGIN');
  });

  test('a superuser connection is refused', async () => {
    const client = fakeClient({
      identity: { ...owner, is_superuser: 'on' },
    });
    await expect(initializeHostedDemo(client, {
      orgName: 'Equip AI Labs',
      email: 'ada@example.com',
      password: 'correct-horse',
    })).rejects.toMatchObject({ code: 'privilege' });
    expect(client.queries).not.toContain('BEGIN');
  });

  test('an operator failure rolls the organization back', async () => {
    const client = fakeClient({ identity: owner, operatorError: 'operator email is invalid' });
    await expect(initializeHostedDemo(client, {
      orgName: 'Equip AI Labs',
      email: 'not-an-email',
      password: 'correct-horse',
    })).rejects.toThrow('operator email is invalid');
    expect(client.queries).toContain('ROLLBACK');
    expect(client.queries).not.toContain('COMMIT');
  });
});

describe('initHostedDemo command', () => {
  test('DATABASE_URL is not used when the demo connection is absent', () => {
    const result = spawnSync(process.execPath, ['scripts/initHostedDemo.js'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: `postgresql://postgres:${PASSWORD}@localhost:5432/golden_record`,
        GOLDEN_RECORD_DEMO_DATABASE_URL: '',
        GOLDEN_RECORD_DEMO_OPERATOR_PASSWORD: '',
      },
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(PASSWORD);
    expect(`${result.stdout}${result.stderr}`).not.toContain('localhost');
  });
});
