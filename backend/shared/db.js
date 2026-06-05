// shared/db.js  — PostgreSQL connection pool
const { Pool } = require('pg');
const path = require('path');

let pool = null;
let migrationsInitialized = false;

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

/**
 * Initialize database migrations
 * Should be called once during application startup
 */
async function initializeMigrations() {
  if (migrationsInitialized) {
    return;
  }
  
  try {
    // Import migration runner
    const migratePath = path.join(__dirname, '..', '..', 'database', 'migrate.js');
    const { verifyChecksums, runPendingMigrations } = require(migratePath);
    
    // Verify checksums of already executed migrations
    const verifyResult = await verifyChecksums();
    if (!verifyResult.valid) {
      console.error('[DB] Migration checksum verification failed!');
      for (const err of verifyResult.errors) {
        console.error(`  ${err.version}: ${err.message}`);
      }
      throw new Error('Migration checksum verification failed');
    }
    
    console.log('[DB] Migration checksums verified');
    
    // Run pending migrations if AUTO_MIGRATE is enabled
    if (process.env.AUTO_MIGRATE === 'true') {
      console.log('[DB] Running pending migrations...');
      const result = await runPendingMigrations();
      console.log(`[DB] Migrations complete: ${result.ran} executed`);
    }
    
    migrationsInitialized = true;
  } catch (err) {
    console.error('[DB] Migration initialization failed:', err.message);
    throw err;
  }
}

module.exports = { getPool, query, transaction, initializeMigrations };
