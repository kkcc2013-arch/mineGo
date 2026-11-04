'use strict';
const {getManager}=require('./TransactionManager');
const registry=require('./metrics');
const tx=require('./transactionMetrics');
const IsolationLevel=Object.freeze({READ_COMMITTED:'READ COMMITTED',REPEATABLE_READ:'REPEATABLE READ',SERIALIZABLE:'SERIALIZABLE'});
const metrics={transactionStarted:tx.started,transactionCompleted:tx.completed,transactionFailed:tx.failed,transactionRetries:tx.legacyRetries,transactionDuration:tx.duration,
  lockWait:registry.register.getSingleMetric('db_lock_wait_duration_seconds')||registry.histogram('db_lock_wait_duration_seconds','Observed database lock waits',['service'],[0.1,0.5,1,2,5,10])};
// Legacy diagnostic classifiers remain broad; actual retry policy uses the core SQLSTATE checks.
const isDeadlockError=e=>!!e&&(['40P01','55P03'].includes(e.code||e.sqlState)||/deadlock detected|could not obtain lock|lock not available|canceling statement due to lock timeout/i.test(typeof e.message==='string'?e.message:''));
const isSerializationError=e=>!!e&&(e.code==='40001'||/could not serialize access/i.test(typeof e.message==='string'?e.message:''));
function transactionWithIsolation(fn,options={}){return getManager(require('./db').getPool()).execute(fn,options);}
function transactionReadCommitted(fn,o={}){return transactionWithIsolation(fn,{...o,isolationLevel:IsolationLevel.READ_COMMITTED});}
function transactionRepeatableRead(fn,o={}){return transactionWithIsolation(fn,{...o,isolationLevel:IsolationLevel.REPEATABLE_READ});}
function transactionSerializable(fn,o={}){return transactionWithIsolation(fn,{...o,isolationLevel:IsolationLevel.SERIALIZABLE});}
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
      metrics.lockWait.observe({ service: serviceName }, Number(row.wait_seconds));
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


function getTransactionMetrics(){return {isolationLevels:Object.values(IsolationLevel),service:process.env.SERVICE_NAME||'default',metrics:{...metrics,lockWaitDuration:metrics.lockWait}};}
module.exports={IsolationLevel,transactionWithIsolation,isDeadlockError,isSerializationError,transactionReadCommitted,transactionRepeatableRead,transactionSerializable,getLockWaitInfo,getDeadlockStats,getTransactionMetrics};
