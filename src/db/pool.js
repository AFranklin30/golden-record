'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  max:                     5,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', (client) => {
  client.query('SET statement_timeout = 10000').catch(err => {
    console.error('pool connect statement_timeout failed', err.message);
  });
});

module.exports = pool;
