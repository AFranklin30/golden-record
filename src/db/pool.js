'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const logger = require('../lib/logger');

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  max:                     5,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 15000,
});

// Neon closes idle connections when a compute suspends. Without a listener,
// node-postgres raises that error on the process.
pool.on('error', (err) => {
  logger.error('idle database client failed', { error: err.message });
});

module.exports = pool;
