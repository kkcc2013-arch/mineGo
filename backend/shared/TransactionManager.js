// backend/shared/TransactionManager.js
/**
 * REQ-00096: 数据库事务隔离级别控制与死锁检测机制
 * 
 * 功能：
 * - 支持可配置的事务隔离级别（READ COMMITTED、REPEATABLE READ、SERIALIZABLE）
 * - 自动死锁检测与智能重试机制
 * - 事务超时控制
 * - Prometheus 监控指标
 */

'use strict';

const { createLogger } = require('./logger');
const { incrementCounter, observeHistogram, setGauge } = require('./metrics');

const logger = createLogger('transaction-manager');

// PostgreSQL 隔离级别
const ISOLATION_LEVELS = {
  'READ COMMITTED': 'READ COMMITTED',
  'REPEATABLE READ': 'REPEATABLE READ',
  'SERIALIZABLE': 'SERIALIZABLE'
};

// PostgreSQL 错误代码
const ERROR_CODES = {
  DEADLOCK_DETECTED: '40P01',
  SERIALIZATION_FAILURE: '40001',
  LOCK_NOT_AVAILABLE: '55P03',
  QUERY_CANCELED: '57014'
};

// 默认配置
const DEFAULT_CONFIG = {
  defaultIsolationLevel: 'READ COMMITTED',
  defaultTimeout: 30000, // 30 seconds
  defaultMaxRetries: 3,
  retryDelayBase: 100, // milliseconds
  maxRetryDelay: 2000
};

/**
 * 检查是否为死锁错误
 * @param {Error} error - 错误对象
 * @returns {boolean} 是否为死锁错误
 */
function isDeadlockError(error) {
  return error && (
    error.code === ERROR_CODES.DEADLOCK_DETECTED ||
    error.code === ERROR_CODES.SERIALIZATION_FAILURE
  );
}

/**
 * 检查是否为超时错误
 * @param {Error} error - 错误对象
 * @returns {boolean} 是否为超时错误
 */
function isTimeoutError(error) {
  return error && (
    error.code === ERROR_CODES.QUERY_CANCELED ||
    error.message?.includes('timeout') ||
    error.message?.includes('Transaction timeout')
  );
}

/**
 * 解析死锁详情
 * @param {Error} error - 死锁错误
 * @returns {Object|null} 死锁详情
 */
function parseDeadlockDetail(error) {
  if (!error.detail) return null;

  // 解析 PostgreSQL 死锁详情消息
  // 示例: "Process 12345 waits for ShareLock on transaction 1234; blocked by process 67890."
  const processMatches = error.detail.match(/Process (\d+)/g);
  const processes = processMatches?.map(p => parseInt(p.replace('Process ', ''))) || [];

  return {
    code: error.code,
    message: error.message,
    detail: error.detail,
    processes,
    timestamp: Date.now()
  };
}

/**
 * 睡眠函数
 * @param {number} ms - 毫秒数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 计算重试延迟（指数退避）
 * @param {number} retryCount - 重试次数
 * @param {number} baseDelay - 基础延迟（毫秒）
 * @param {number} maxDelay - 最大延迟（毫秒）
 * @returns {number} 延迟时间
 */
function calculateRetryDelay(retryCount, baseDelay = 100, maxDelay = 2000) {
  const delay = baseDelay * Math.pow(2, retryCount);
  // 添加随机抖动（±25%）
  const jitter = delay * 0.25 * (Math.random() - 0.5);
  return Math.min(delay + jitter, maxDelay);
}

/**
 * 事务管理器类
 */
class TransactionManager {
  constructor(pool, config = {}) {
    this.pool = pool;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.activeTransactions = new Map();
  }

  /**
   * 执行事务
   * @param {Function} fn - 事务回调函数
   * @param {Object} options - 事务选项
   * @param {string} options.isolationLevel - 隔离级别
   * @param {number} options.timeout - 超时时间（毫秒）
   * @param {boolean} options.retryOnDeadlock - 死锁时是否重试
   * @param {number} options.maxRetries - 最大重试次数
   * @param {string} options.transactionName - 事务名称（用于监控）
   * @returns {Promise<any>} 事务结果
   */
  async execute(fn, options = {}) {
    const {
      isolationLevel = this.config.defaultIsolationLevel,
      timeout = this.config.defaultTimeout,
      retryOnDeadlock = true,
      maxRetries = this.config.defaultMaxRetries,
      transactionName = 'unknown'
    } = options;

    // 验证隔离级别
    if (!ISOLATION_LEVELS[isolationLevel]) {
      throw new Error(`Invalid isolation level: ${isolationLevel}`);
    }

    let retries = 0;
    let lastError = null;

    while (retries <= maxRetries) {
      try {
        const result = await this._executeWithTimeout(fn, isolationLevel, timeout, transactionName);
        
        // 成功，记录指标
        incrementCounter('db_transactions_total', 1, { 
          service: process.env.SERVICE_NAME || 'default',
          status: 'success',
          isolation_level: isolationLevel
        });

        return result;
      } catch (error) {
        lastError = error;

        // 死锁处理
        if (isDeadlockError(error) && retryOnDeadlock && retries < maxRetries) {
          retries++;
          
          logger.warn({
            event: 'deadlock_detected',
            transactionName,
            isolationLevel,
            retryCount: retries,
            maxRetries,
            errorCode: error.code,
            errorMessage: error.message
          });

          // 记录死锁重试指标
          incrementCounter('db_deadlock_retries_total', 1, {
            service: process.env.SERVICE_NAME || 'default',
            transaction_name: transactionName
          });

          // 记录死锁事件到数据库（异步）
          this._logDeadlockEvent(error, transactionName, retries).catch(err => {
            logger.error({ err }, 'Failed to log deadlock event');
          });

          // 指数退避重试
          const delay = calculateRetryDelay(
            retries, 
            this.config.retryDelayBase, 
            this.config.maxRetryDelay
          );
          await sleep(delay);
          continue;
        }

        // 超时或不可重试错误
        if (isTimeoutError(error)) {
          incrementCounter('db_transactions_total', 1, { 
            service: process.env.SERVICE_NAME || 'default',
            status: 'timeout',
            isolation_level: isolationLevel
          });
        } else {
          incrementCounter('db_transactions_total', 1, { 
            service: process.env.SERVICE_NAME || 'default',
            status: 'rollback',
            isolation_level: isolationLevel
          });
        }

        throw error;
      }
    }

    // 达到最大重试次数
    incrementCounter('db_transactions_total', 1, { 
      service: process.env.SERVICE_NAME || 'default',
      status: 'max_retries_exceeded',
      isolation_level: isolationLevel
    });

    throw lastError;
  }

  /**
   * 执行带超时的事务
   * @private
   */
  async _executeWithTimeout(fn, isolationLevel, timeout, transactionName) {
    const client = await this.pool.connect();
    const transactionId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();

    // 记录活跃事务
    this.activeTransactions.set(transactionId, {
      name: transactionName,
      isolationLevel,
      startTime,
      client
    });

    // 更新活跃事务计数
    setGauge('db_active_transactions', this.activeTransactions.size, {
      service: process.env.SERVICE_NAME || 'default'
    });

    let timeoutId = null;
    let completed = false;

    try {
      // 设置事务超时
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          if (!completed) {
            completed = true;
            reject(new Error(`Transaction timeout after ${timeout}ms`));
          }
        }, timeout);
      });

      // 开始事务
      await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);

      // 执行事务回调
      const result = await Promise.race([
        fn(client),
        timeoutPromise
      ]);

      // 提交事务
      if (!completed) {
        completed = true;
        await client.query('COMMIT');
      }

      // 记录事务时长
      const duration = Date.now() - startTime;
      observeHistogram('db_transaction_duration_seconds', duration / 1000, {
        service: process.env.SERVICE_NAME || 'default',
        isolation_level: isolationLevel,
        transaction_name: transactionName
      });

      return result;
    } catch (error) {
      // 回滚事务
      if (!completed) {
        completed = true;
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          logger.error({ err: rollbackError }, 'Rollback failed');
        }
      }

      throw error;
    } finally {
      // 清理超时定时器
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // 移除活跃事务记录
      this.activeTransactions.delete(transactionId);

      // 更新活跃事务计数
      setGauge('db_active_transactions', this.activeTransactions.size, {
        service: process.env.SERVICE_NAME || 'default'
      });

      // 释放连接
      client.release();
    }
  }

  /**
   * 记录死锁事件到数据库
   * @private
   */
  async _logDeadlockEvent(error, transactionName, retryCount) {
    const deadlockDetail = parseDeadlockDetail(error);
    
    try {
      await this.pool.query(`
        INSERT INTO deadlock_log (code, message, detail, processes, transaction_name, retry_count, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [
        error.code,
        error.message,
        error.detail || '',
        JSON.stringify(deadlockDetail?.processes || []),
        transactionName,
        retryCount
      ]);
    } catch (insertError) {
      logger.error({ err: insertError }, 'Failed to insert deadlock log');
    }
  }

  /**
   * 获取当前活跃事务列表
   * @returns {Array} 活跃事务列表
   */
  getActiveTransactions() {
    return Array.from(this.activeTransactions.entries()).map(([id, tx]) => ({
      id,
      name: tx.name,
      isolationLevel: tx.isolationLevel,
      duration: Date.now() - tx.startTime
    }));
  }

  /**
   * 获取活跃事务数量
   * @returns {number} 活跃事务数量
   */
  getActiveTransactionCount() {
    return this.activeTransactions.size;
  }
}

// 导出
module.exports = {
  TransactionManager,
  ISOLATION_LEVELS,
  ERROR_CODES,
  isDeadlockError,
  isTimeoutError,
  parseDeadlockDetail,
  calculateRetryDelay
};
