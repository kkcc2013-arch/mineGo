// backend/shared/transactionManager.js
// Database transaction isolation level control and deadlock detection

'use strict';

const { createLogger } = require('./logger');
const { getPool } = require('./db');
const { Counter, Histogram } = require('prom-client');

const logger = createLogger('transaction-manager');

/**
 * Transaction isolation levels
 */
const IsolationLevel = {
  READ_COMMITTED: 'READ COMMITTED',
  REPEATABLE_READ: 'REPEATABLE READ',
  SERIALIZABLE: 'SERIALIZABLE',
};

/**
 * Transaction options
 * @typedef {Object} TransactionOptions
 * @property {string} isolationLevel - Isolation level
 * @property {number} maxRetries - Maximum retry attempts (default: 3)
 * @property {number} retryDelay - Base retry delay in ms (default: 100)
 * @property {boolean} enableMetrics - Enable Prometheus metrics (default: true)
 */

// Default options
const DEFAULT_OPTIONS = {
  isolationLevel: IsolationLevel.READ_COMMITTED,
  maxRetries: 3,
  retryDelay: 100,
  enableMetrics: true,
};

// Prometheus metrics
const metrics = {
  transactionStarted: new Counter({
    name: 'db_transaction_started_total',
    help: 'Total number of transactions started',
    labelNames: ['isolation_level', 'service'],
  }),
  
  transactionCompleted: new Counter({
    name: 'db_transaction_completed_total',
    help: 'Total number of transactions completed successfully',
    labelNames: ['isolation_level', 'service'],
  }),
  
  transactionFailed: new Counter({
    name: 'db_transaction_failed_total',
    help: 'Total number of transactions failed',
    labelNames: ['isolation_level', 'service', 'error_type'],
  }),
  
  transactionRetries: new Counter({
    name: 'db_transaction_retries_total',
    help: 'Total number of transaction retries due to deadlock',
    labelNames: ['isolation_level', 'service'],
  }),
  
  transactionDuration: new Histogram({
    name: 'db_transaction_duration_seconds',
    help: 'Transaction duration in seconds',
    labelNames: ['isolation_level', 'service'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  }),
  
  lockWaitDuration: new Histogram({
    name: 'db_lock_wait_duration_seconds',
    help: 'Lock wait duration in seconds',
    labelNames: ['service'],
    buckets: [0.1, 0.5, 1, 2, 5, 10],
  }),
};

/**
 * Check if error is a deadlock error
 * @param {Error} err - Error object
 * @returns {boolean} True if deadlock error
 */
function isDeadlockError(err) {
  // PostgreSQL deadlock error codes
  const DEADLOCK_CODES = [
    '40P01', // deadlock_detected
    '55P03', // lock_not_available
  ];
  
  const DEADLOCK_MESSAGES = [
    'deadlock detected',
    'could not obtain lock',
    'lock not available',
    'canceling statement due to lock timeout',
  ];
  
  const code = err.code || err.sqlState;
  const message = err.message?.toLowerCase() || '';
  
  return DEADLOCK_CODES.includes(code) || 
         DEADLOCK_MESSAGES.some(msg => message.includes(msg));
}

/**
 * Check if error is a serialization failure
 * @param {Error} err - Error object
 * @returns {boolean} True if serialization failure
 */
function isSerializationError(err) {
  // PostgreSQL serialization failure error code: 40001
  return err.code === '40001' || 
         err.message?.toLowerCase().includes('could not serialize access');
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a transaction with isolation level control
 * @param {Function} callback - Transaction callback function(client)
 * @param {TransactionOptions} options - Transaction options
 * @returns {Promise<any>} Transaction result
 */
async function transactionWithIsolation(callback, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const serviceName = process.env.SERVICE_NAME || 'default';
  const isolationLevel = opts.isolationLevel;
  
  const startTime = Date.now();
  
  // Record transaction start
  if (opts.enableMetrics) {
    metrics.transactionStarted.inc({ 
      isolation_level: isolationLevel.replace(' ', '_').toLowerCase(), 
      service: serviceName 
    });
  }
  
  let lastError = null;
  
  for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
    const pool = getPool();
    const client = await pool.connect();
    
    try {
      // Start transaction with isolation level
      await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
      
      // Execute callback
      const result = await callback(client);
      
      // Commit transaction
      await client.query('COMMIT');
      
      const duration = (Date.now() - startTime) / 1000;
      
      // Record success metrics
      if (opts.enableMetrics) {
        metrics.transactionCompleted.inc({ 
          isolation_level: isolationLevel.replace(' ', '_').toLowerCase(), 
          service: serviceName 
        });
        metrics.transactionDuration.observe({ 
          isolation_level: isolationLevel.replace(' ', '_').toLowerCase(), 
          service: serviceName 
        }, duration);
      }
      
      if (attempt > 1) {
        logger.info({ 
          isolationLevel, 
          attempt, 
          duration,
          service: serviceName 
        }, 'Transaction succeeded after retry');
      }
      
      return result;
      
    } catch (err) {
      // Rollback transaction
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error({ err: rollbackErr }, 'Failed to rollback transaction');
      }
      
      lastError = err;
      
      const isDeadlock = isDeadlockError(err);
      const isSerialization = isSerializationError(err);
      
      // Record failure metrics
      if (opts.enableMetrics) {
        const errorType = isDeadlock ? 'deadlock' : 
                         isSerialization ? 'serialization' : 'other';
        metrics.transactionFailed.inc({ 
          isolation_level: isolationLevel.replace(' ', '_').toLowerCase(), 
          service: serviceName,
          error_type: errorType
        });
      }
      
      // Retry on deadlock or serialization failure
      if ((isDeadlock || isSerialization) && attempt < opts.maxRetries) {
        const retryDelayMs = opts.retryDelay * attempt;
        
        logger.warn({ 
          err: err.message,
          code: err.code,
          isolationLevel, 
          attempt, 
          maxRetries: opts.maxRetries,
          retryDelayMs,
          service: serviceName 
        }, 'Transaction failed due to deadlock/serialization, retrying');
        
        // Record retry
        if (opts.enableMetrics) {
          metrics.transactionRetries.inc({ 
            isolation_level: isolationLevel.replace(' ', '_').toLowerCase(), 
            service: serviceName 
          });
        }
        
        // Exponential backoff
        await sleep(retryDelayMs);
        
      } else {
        // Non-retryable error or max retries reached
        logger.error({ 
          err: err.message,
          code: err.code,
          isolationLevel, 
          attempt, 
          service: serviceName 
        }, 'Transaction failed');
        
        throw err;
      }
      
    } finally {
      client.release();
    }
  }
  
  // Should not reach here, but throw last error just in case
  throw lastError;
}

/**
 * Get current lock wait information
 * @returns {Promise<Array>} Lock wait information
 */
async function getLockWaitInfo() {
  const { query } = require('./db');
  
  const result = await query(`
    SELECT 
      blocked.pid AS blocked_pid,
      blocked.query AS blocked_query,
      blocked.query_start AS blocked_query_start,
      blocking.pid AS blocking_pid,
      blocking.query AS blocking_query,
      blocking.query_start AS blocking_query_start,
      EXTRACT(EPOCH FROM (now() - blocked.query_start)) AS wait_seconds,
      blocked_locks.locktype AS lock_type,
      blocked_locks.mode AS lock_mode
    FROM pg_stat_activity blocked
    JOIN pg_locks blocked_locks ON blocked.pid = blocked_locks.pid
    JOIN pg_locks blocking_locks ON blocked_locks.locktype = blocking_locks.locktype
      AND blocked_locks.database IS NOT DISTINCT FROM blocking_locks.database
      AND blocked_locks.relation IS NOT DISTINCT FROM blocking_locks.relation
      AND blocked_locks.page IS NOT DISTINCT FROM blocking_locks.page
      AND blocked_locks.tuple IS NOT DISTINCT FROM blocking_locks.tuple
      AND blocked_locks.virtualxid IS NOT DISTINCT FROM blocking_locks.virtualxid
      AND blocked_locks.pid != blocking_locks.pid
    JOIN pg_stat_activity blocking ON blocking_locks.pid = blocking.pid
    WHERE NOT blocked_locks.granted
    ORDER BY wait_seconds DESC
    LIMIT 20
  `);
  
  const serviceName = process.env.SERVICE_NAME || 'default';
  
  // Record lock wait durations
  for (const row of result.rows) {
    if (row.wait_seconds > 0) {
      metrics.lockWaitDuration.observe({ service: serviceName }, row.wait_seconds);
    }
  }
  
  return result.rows;
}

/**
 * Get deadlock statistics from PostgreSQL
 * @returns {Promise<Object>} Deadlock statistics
 */
async function getDeadlockStats() {
  const { query } = require('./db');
  
  const result = await query(`
    SELECT 
      datname AS database,
      xact_commit,
      xact_rollback,
      conflicts,
      deadlocks
    FROM pg_stat_database
    WHERE datname = current_database()
  `);
  
  return result.rows[0] || {};
}

/**
 * Get transaction metrics
 * @returns {Object} Transaction metrics
 */
function getTransactionMetrics() {
  const serviceName = process.env.SERVICE_NAME || 'default';
  
  return {
    isolationLevels: Object.values(IsolationLevel),
    service: serviceName,
    metrics: {
      transactionStarted: metrics.transactionStarted,
      transactionCompleted: metrics.transactionCompleted,
      transactionFailed: metrics.transactionFailed,
      transactionRetries: metrics.transactionRetries,
      transactionDuration: metrics.transactionDuration,
      lockWaitDuration: metrics.lockWaitDuration,
    },
  };
}

/**
 * Convenience functions for common isolation levels
 */

async function transactionReadCommitted(callback, options = {}) {
  return transactionWithIsolation(callback, { 
    ...options, 
    isolationLevel: IsolationLevel.READ_COMMITTED 
  });
}

async function transactionRepeatableRead(callback, options = {}) {
  return transactionWithIsolation(callback, { 
    ...options, 
    isolationLevel: IsolationLevel.REPEATABLE_READ 
  });
}

async function transactionSerializable(callback, options = {}) {
  return transactionWithIsolation(callback, { 
    ...options, 
    isolationLevel: IsolationLevel.SERIALIZABLE 
  });
}

module.exports = {
  // Constants
  IsolationLevel,
  
  // Main functions
  transactionWithIsolation,
  isDeadlockError,
  isSerializationError,
  
  // Convenience functions
  transactionReadCommitted,
  transactionRepeatableRead,
  transactionSerializable,
  
  // Monitoring functions
  getLockWaitInfo,
  getDeadlockStats,
  getTransactionMetrics,
};
