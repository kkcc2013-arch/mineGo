// shared/db.js  — PostgreSQL connection pool
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: parseInt(process.env.DB_POOL_MAX || '20'),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });

    pool.on('error', (err) => {
      console.error('[DB] Unexpected pool error', err);
    });
  }
  return pool;
}

async function query(text, params) {
  const start = Date.now();
  const client = await getPool().connect();
  try {
    const res = await client.query(text, params);
    const dur = Date.now() - start;
    if (dur > 500) {
      console.warn('[DB] Slow query (%dms): %s', dur, text.substring(0, 120));
    }
    return res;
  } finally {
    client.release();
  }
}

async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, transaction };
