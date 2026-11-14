'use strict';

const crypto = require('crypto');
const { createOperator } = require('./operatorAuth');

class DemoInitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DemoInitError';
    this.code = code;
  }
}

// A direct Neon endpoint. The pooled hostname puts "-pooler" in the first
// label and is rejected separately.
const NEON_HOST = /^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)?\.[a-z0-9-]+\.(aws|azure)\.neon\.tech$/;

function inspectDemoTarget(connectionString, expectHost, expectDatabase) {
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new DemoInitError('connection', 'GOLDEN_RECORD_DEMO_DATABASE_URL is required');
  }
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new DemoInitError('connection', 'database connection could not be parsed');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new DemoInitError('connection', 'database connection must be a postgres URL');
  }

  const host = url.hostname.toLowerCase();
  const port = url.port || '5432';
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const sslValues = url.searchParams.getAll('sslmode').map((value) => value.toLowerCase());
  const expectedHost = String(expectHost || '').toLowerCase();

  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost')
  ) {
    throw new DemoInitError('host_rejected', 'localhost is rejected');
  }
  if (
    port === '5433' ||
    host.includes('cloudsql') ||
    host.endsWith('.sql.goog') ||
    host.includes('googleapis')
  ) {
    throw new DemoInitError('host_rejected', 'Cloud SQL is rejected');
  }
  if (host.includes('pooler')) {
    throw new DemoInitError('host_rejected', 'a pooled endpoint is rejected');
  }
  if (port !== '5432') {
    throw new DemoInitError('host_rejected', 'only port 5432 is accepted');
  }
  if (!NEON_HOST.test(host)) {
    throw new DemoInitError('host_rejected', 'host must be a direct Neon hostname');
  }
  if (host !== expectedHost) {
    throw new DemoInitError('host_rejected', 'host does not match --expect-host');
  }
  if (!expectDatabase || database !== expectDatabase) {
    throw new DemoInitError('database', 'database does not match --expect-database');
  }
  if (sslValues.length !== 1 || sslValues[0] !== 'require') {
    throw new DemoInitError('sslmode', 'sslmode=require is required');
  }

  return { host, port, database };
}

function assertConfirmed(target, confirm) {
  const expected = `${target.host}/${target.database}`;
  if (confirm !== expected) {
    throw new DemoInitError('confirm', `confirmation must be ${expected}`);
  }
  return expected;
}

function redactSecrets(message, connectionString) {
  let text = String(message || '');
  if (connectionString) {
    text = text.split(connectionString).join('[redacted]');
    try {
      const password = new URL(connectionString).password;
      if (password) text = text.split(decodeURIComponent(password)).join('[redacted]');
    } catch {
      // The connection string was already rejected. There is nothing further to redact.
    }
  }
  return text;
}

async function initializeHostedDemo(client, { orgName, email, password }) {
  const name = typeof orgName === 'string' ? orgName.trim() : '';
  if (!name || name.length > 200) {
    throw new DemoInitError('input', 'organization name is required');
  }

  const identity = await client.query(
    `SELECT current_user AS role_name,
            current_setting('is_superuser') AS is_superuser,
            has_table_privilege(current_user, 'org', 'INSERT') AS can_insert_org,
            has_table_privilege(current_user, 'operator', 'INSERT') AS can_insert_operator`
  );
  const who = identity.rows[0];
  if (!who || who.is_superuser === 'on' || who.is_superuser === true) {
    throw new DemoInitError('privilege', 'this command refuses a superuser connection');
  }
  if (!who.can_insert_org || !who.can_insert_operator) {
    throw new DemoInitError(
      'privilege',
      'the connection cannot create an organization. Use the Neon owner role, not golden_record_app.'
    );
  }

  await client.query('BEGIN');
  try {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('golden_record_hosted_demo_init'))`);
    const orgs = await client.query('SELECT COUNT(*)::int AS n FROM org');
    const operators = await client.query('SELECT COUNT(*)::int AS n FROM operator');
    if (orgs.rows[0].n > 0 || operators.rows[0].n > 0) {
      throw new DemoInitError('exists', 'an organization or operator already exists');
    }

    const orgId = crypto.randomUUID();
    const apiKeyHash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
    await client.query(
      `INSERT INTO org (id, name, is_active, org_api_key_hash) VALUES ($1, $2, true, $3)`,
      [orgId, name, apiKeyHash]
    );
    const operator = await createOperator(client, { orgId, email, password });
    await client.query('COMMIT');
    return { orgId, orgName: name, email: operator.email };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the transaction is already closed */ }
    throw err;
  }
}

module.exports = {
  DemoInitError,
  inspectDemoTarget,
  assertConfirmed,
  initializeHostedDemo,
  redactSecrets,
};
