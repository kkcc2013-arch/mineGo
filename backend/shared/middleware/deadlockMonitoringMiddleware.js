/**
 * REQ-00585: 死锁监控中间件
 * 
 * 集成到数据库查询和事务管理中，自动捕获和记录死锁事件
 * 
 * @module deadlockMonitoringMiddleware
 */

'use strict';

const { getDbDeadlockMonitor, PG_ERROR_CODES, DEADLOCK_SEVERITY } = require('../dbDeadlockMonitor');
const { createLogger } = require('../logger');
const { context, trace } = require('@opentelemetry/api');

const logger = createLogger('deadlock-middleware');

/**
 * 创建死锁监控中间件
 * @param {Object} config - 配置
 * @returns {Object} 中间件对象
 */
function createDeadlockMiddleware(config = {}) {
  const monitor = getDbDeadlockMonitor(config);

  return {
    /**
     * 包装查询函数
     * @param {Function} originalQuery - 原始查询函数
     * @returns {Function} 包装后的查询函数
     */
    wrapQuery(originalQuery) {
      return async function wrappedQuery(text, params) {
        const queryId = `Q-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // 获取 trace_id
        let traceId = null;
        const currentSpan = trace.getSpan(context.active());
        if (currentSpan) {
          traceId = currentSpan.spanContext().traceId;
        }

        // 记录查询上下文
        monitor.recordQueryContext(queryId, {
          sql: text,
          params: params,
          traceId: traceId,
          transactionName: 'ad-hoc'
        });

        try {
          const result = await originalQuery(text, params);
          return result;
        } catch (error) {
          // 检测死锁错误
          if (error.code === PG_ERROR_CODES.DEADLOCK_DETECTED) {
            monitor.captureDeadlock(error, {
              sqlQueries: [text],
              traceId: traceId,
              transactionName: 'ad-hoc'
            });
          }
          throw error;
        } finally {
          monitor.queryContextMap.delete(queryId);
        }
      };
    },

    /**
     * 包装事务函数
     * @param {Function} originalTransaction - 原始事务函数
     * @returns {Function} 包装后的事务函数
     */
    wrapTransaction(originalTransaction) {
      return async function wrappedTransaction(fn, options = {}) {
        const txId = `TX-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const transactionName = options.transactionName || 'anonymous';
        const sqlQueries = [];

        // 获取 trace_id
        let traceId = null;
        const currentSpan = trace.getSpan(context.active());
        if (currentSpan) {
          traceId = currentSpan.spanContext().traceId;
        }

        // 记录活跃事务
        monitor.recordActiveTransaction(txId, {
          name: transactionName,
          traceId: traceId,
          isolationLevel: options.isolationLevel
        });

        // 包装客户端以捕获 SQL
        const wrappedFn = async (client) => {
          const originalClientQuery = client.query.bind(client);
          
          // 替换 client.query 以捕获 SQL
          client.query = async function(...args) {
            const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
            if (sql && !sql.includes('BEGIN') && !sql.includes('COMMIT') && !sql.includes('ROLLBACK')) {
              sqlQueries.push(sql);
            }
            return originalClientQuery(...args);
          };

          try {
            return await fn(client);
          } finally {
            // 恢复原始 query
            client.query = originalClientQuery;
          }
        };

        let lastError = null;
        let deadlockRecord = null;

        try {
          const result = await originalTransaction(wrappedFn, options);
          return result;
        } catch (error) {
          lastError = error;

          // 检测死锁错误
          if (error.code === PG_ERROR_CODES.DEADLOCK_DETECTED ||
              error.code === PG_ERROR_CODES.SERIALIZATION_FAILURE) {
            
            deadlockRecord = monitor.captureDeadlock(error, {
              sqlQueries: sqlQueries,
              traceId: traceId,
              transactionName: transactionName,
              retryCount: options.currentRetry || 0
            });

            logger.warn({
              event: 'transaction_deadlock',
              transaction_name: transactionName,
              deadlock_id: deadlockRecord.id,
              retry_count: options.currentRetry || 0
            }, 'Transaction deadlock detected');
          }

          throw error;
        } finally {
          monitor.removeActiveTransaction(txId);
        }
      };
    },

    /**
     * 包装 TransactionManager
     * @param {Object} txManager - TransactionManager 实例
     */
    wrapTransactionManager(txManager) {
      const originalExecute = txManager.execute.bind(txManager);
      const wrappedMiddleware = this;

      txManager.execute = async function(fn, options = {}) {
        const txId = `TX-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const transactionName = options.transactionName || 'anonymous';
        const sqlQueries = [];

        // 获取 trace_id
        let traceId = null;
        const currentSpan = trace.getSpan(context.active());
        if (currentSpan) {
          traceId = currentSpan.spanContext().traceId;
        }

        // 记录活跃事务
        monitor.recordActiveTransaction(txId, {
          name: transactionName,
          traceId: traceId,
          isolationLevel: options.isolationLevel
        });

        // 包装回调以捕获 SQL
        const wrappedFn = async (client) => {
          const originalClientQuery = client.query.bind(client);
          
          client.query = async function(...args) {
            const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
            if (sql && !sql.includes('BEGIN') && !sql.includes('COMMIT') && !sql.includes('ROLLBACK') && !sql.includes('SET')) {
              sqlQueries.push(sql);
            }
            return originalClientQuery(...args);
          };

          try {
            return await fn(client);
          } finally {
            client.query = originalClientQuery;
          }
        };

        let retries = 0;
        const maxRetries = options.maxRetries || 3;

        // 修改 options 以追踪重试
        const wrappedOptions = {
          ...options,
          currentRetry: 0
        };

        try {
          const result = await originalExecute(wrappedFn, wrappedOptions);
          
          // 如果有过重试，标记死锁已解决
          if (wrappedOptions.currentRetry > 0) {
            // 死锁已通过重试解决
            logger.info({
              transaction_name: transactionName,
              retry_count: wrappedOptions.currentRetry
            }, 'Transaction recovered from deadlock after retry');
          }

          return result;
        } catch (error) {
          // 检测死锁错误
          if (error.code === PG_ERROR_CODES.DEADLOCK_DETECTED ||
              error.code === PG_ERROR_CODES.SERIALIZATION_FAILURE) {
            
            const deadlockRecord = monitor.captureDeadlock(error, {
              sqlQueries: sqlQueries,
              traceId: traceId,
              transactionName: transactionName,
              retryCount: wrappedOptions.currentRetry
            });

            monitor.markFailed(deadlockRecord.id);
          }

          throw error;
        } finally {
          monitor.removeActiveTransaction(txId);
        }
      };

      return txManager;
    },

    /**
     * 获取监控器实例
     */
    getMonitor() {
      return monitor;
    }
  };
}

/**
 * 初始化死锁监控
 * @param {Object} db - 数据库模块
 * @param {Object} config - 配置
 * @returns {Object} 中间件实例
 */
function initializeDeadlockMonitoring(db, config = {}) {
  const middleware = createDeadlockMiddleware(config);

  // 包装 query 函数
  const originalQuery = db.query;
  db.query = middleware.wrapQuery(originalQuery);

  // 包装 transaction 函数
  const originalTransaction = db.transaction;
  db.transaction = middleware.wrapTransaction(originalTransaction);

  // 如果有 TransactionManager 实例，也包装它
  if (db.TransactionManager) {
    // 注意：TransactionManager 是类，需要在实例化后包装
    const originalTransactionManager = db.TransactionManager;
    db.TransactionManager = class extends originalTransactionManager {
      constructor(pool, options = {}) {
        super(pool, options);
        middleware.wrapTransactionManager(this);
      }
    };
  }

  logger.info('Deadlock monitoring middleware initialized');

  return middleware;
}

module.exports = {
  createDeadlockMiddleware,
  initializeDeadlockMonitoring
};
