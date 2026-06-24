// shared/db.js — PostgreSQL connection pool with shared pool manager
const path = require('path');
const { context, trace } = require('@opentelemetry/api');
const { getTracer } = require('./tracing');
const { getPoolManager, metrics: poolMetrics } = require('./DatabasePool');

// 使用 shared/metrics.js 中的 dbQueryDuration metric，避免重复注册
const { dbQueryDuration } = require('./metrics');

let poolManager = null;
let migrationsInitialized = false;

/**
 * Get the pool manager instance
 */
function getPoolManagerInstance() {
  if (!poolManager) {
    poolManager = getPoolManager();
  }
  return poolManager;
}

/**
 * Get the default pool (backwards compatible)
 */
function getPool() {
  const serviceName = process.env.SERVICE_NAME || 'default';
  return getPoolManagerInstance().getPool(serviceName);
}

/**
 * Execute a database query
 * @param {string} text - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 */
async function query(text, params) {
  const start = Date.now();
  const serviceName = process.env.SERVICE_NAME || 'default';
  const poolManager = getPoolManagerInstance();
  const pool = poolManager.getPool(serviceName);
  const poolName = poolManager.getPoolName(serviceName);
  
  // Get current tracing context
  const currentSpan = trace.getSpan(context.active());
  let dbSpan = null;
  
  // Create database tracing span
  if (currentSpan) {
    const tracer = getTracer('mineGo-db');
    const operation = text.trim().split(' ')[0].toUpperCase();
    
    dbSpan = tracer.startSpan(`db.query ${operation}`, {
      attributes: {
        'db.system': 'postgresql',
        'db.statement': text.substring(0, 500),
        'db.operation': operation,
      },
    });
  }

  const acquireStart = Date.now();
  const client = await pool.connect();
  const acquireDuration = Date.now() - acquireStart;
  
  try {
    const res = await client.query(text, params);
    const dur = Date.now() - start;
    
    // Record query duration (使用 service 和 query_name 标签)
    const operation = text.trim().split(' ')[0].toUpperCase();
    dbQueryDuration.observe({ service: serviceName, query_name: operation }, dur);
    
    // Record to span
    if (dbSpan) {
      dbSpan.setAttributes({
        'db.rows_affected': res.rowCount || 0,
        'db.duration_ms': dur,
        'db.connection_acquire_ms': acquireDuration,
      });
      dbSpan.setStatus({ code: 0 });
      dbSpan.end();
    }
    
    if (dur > 500) {
      console.warn('[DB] Slow query (%dms): %s', dur, text.substring(0, 120));
    }
    
    return res;
  } catch (err) {
    // Record error to span
    if (dbSpan) {
      dbSpan.setStatus({ code: 2, message: err.message });
      dbSpan.recordException(err);
      dbSpan.end();
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute a database transaction
 * @param {Function} fn - Transaction callback
 * @returns {Promise<any>} Transaction result
 */
async function transaction(fn) {
  const serviceName = process.env.SERVICE_NAME || 'default';
  const poolManager = getPoolManagerInstance();
  const pool = poolManager.getPool(serviceName);
  
  const client = await pool.connect();
  
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

/**
 * Get pool statistics
 * @returns {Object} Pool statistics
 */
function getPoolStats() {
  const poolManager = getPoolManagerInstance();
  return poolManager.getStats();
}

/**
 * Get aggregate pool statistics
 * @returns {Object} Aggregate statistics
 */
function getAggregateStats() {
  const poolManager = getPoolManagerInstance();
  return poolManager.getAggregateStats();
}

/**
 * Health check for database pools
 * @returns {Promise<Object>} Health check results
 */
async function healthCheck() {
  const poolManager = getPoolManagerInstance();
  return poolManager.healthCheck();
}

/**
 * Close all database pools
 */
async function closePools() {
  if (poolManager) {
    await poolManager.closeAll();
  }
}

/**
 * Get service-specific pool configuration
 * @param {string} serviceName - Service name
 * @returns {Object} Pool configuration
 */
function getServicePoolConfig(serviceName) {
  const { SERVICE_POOL_CONFIG } = require('./DatabasePool');
  return SERVICE_POOL_CONFIG[serviceName] || SERVICE_POOL_CONFIG['default'];
}
module.exports = {
  getPool,
  getClient,
  query,
  transaction,
  initializeMigrations,
  getPoolStats,
  getAggregateStats,
  healthCheck,
  closePools,
  getServicePoolConfig,
  getPoolManagerInstance,
  // Transaction manager with isolation level control
  transactionManager: require('./transactionManager'),
};

async function getClient() {
  return await getPool().connect();
}
