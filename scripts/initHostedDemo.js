'use strict';

const { Client } = require('pg');
const {
  inspectDemoTarget,
  assertConfirmed,
  initializeHostedDemo,
  redactSecrets,
} = require('../src/modules/hostedDemoInit');

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

async function main() {
  const connectionString = process.env.GOLDEN_RECORD_DEMO_DATABASE_URL || '';
  const password = process.env.GOLDEN_RECORD_DEMO_OPERATOR_PASSWORD || '';
  const expectHost = arg('expect-host');
  const expectDatabase = arg('expect-database');
  const email = arg('email');
  const orgName = arg('org-name');
  const confirm = arg('confirm');

  if (!connectionString || !password || !expectHost || !expectDatabase || !email || !orgName) {
    console.error(
      'Missing required input. Set GOLDEN_RECORD_DEMO_DATABASE_URL and GOLDEN_RECORD_DEMO_OPERATOR_PASSWORD. Pass --expect-host, --expect-database, --email, --org-name, and --confirm.'
    );
    process.exit(1);
  }

  const target = inspectDemoTarget(connectionString, expectHost, expectDatabase);
  console.log(`Target host: ${target.host}`);
  console.log(`Target database: ${target.database}`);
  assertConfirmed(target, confirm);

  const client = new Client({ connectionString });
  try {
    await client.connect();
    const created = await initializeHostedDemo(client, { orgName, email, password });
    console.log(`organization ${created.orgName} ${created.orgId}`);
    console.log(`operator ${created.email}`);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  const connectionString = process.env.GOLDEN_RECORD_DEMO_DATABASE_URL || '';
  console.error(redactSecrets(err.message, connectionString));
  process.exit(1);
});
