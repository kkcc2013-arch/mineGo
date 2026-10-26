'use strict';

// Extensions belong to the isolated test database, not a disposable test schema.
// Serialize first-time installation when process suites run concurrently.
async function ensureExtensions(pool, names) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(8273765, 1)');
    for (const name of names) {
      // Only the fixed extension lists below reach this private helper.
      await client.query(`CREATE EXTENSION IF NOT EXISTS "${name}" WITH SCHEMA public`);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

const ensureUuidExtension = pool => ensureExtensions(pool, ['uuid-ossp']);
const ensureStorageExtensions = pool => ensureExtensions(pool, ['uuid-ossp', 'postgis', 'pgcrypto']);
module.exports = { ensureUuidExtension, ensureStorageExtensions };
