'use strict';

// Extensions belong to the isolated test database, not a disposable test schema.
// Serialize first-time installation when process suites run concurrently.
async function ensureUuidExtension(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(8273765, 1)');
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

module.exports = { ensureUuidExtension };
