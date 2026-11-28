'use strict';

require('dotenv').config();

const pool = require('../src/db/pool');
const { promoteOperator } = require('../src/modules/operatorAuth');

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

async function main() {
  const url = process.env.DATABASE_URL || '';
  if (!url.includes('localhost')) {
    console.error('BLOCKED: DATABASE_URL does not contain localhost.');
    process.exit(1);
  }
  const orgId = arg('org');
  const email = arg('email');
  if (!orgId || !email) {
    console.error('Usage: node scripts/promoteOperator.js --org=<uuid> --email=<email>');
    process.exit(1);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const operator = await promoteOperator(client, { orgId, email });
    await client.query('COMMIT');
    console.log(`operator ${operator.email} promoted to ${operator.role} for org ${operator.org_id}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
