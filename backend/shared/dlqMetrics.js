/**
 * DLQ Prometheus Metrics - 死信队列 Prometheus 监控指标
 * REQ-00519: 后端任务队列可靠性增强与死信处理系统
 * 
 * 功能：
 * - DLQ 大小指标
 * - 任务执行指标
 * - 重试统计指标
 * - 告警触发指标
 * 
 * @module backend/shared/dlqMetrics
 * @version 1.0.0
 */

'use strict';

const promClient = require('prom-client');

/**
 * DLQ Metrics Registry
 */
const register = new promClient.Registry();

/**
 * DLQ 大小 Gauge
 */
const dlqSize = new promClient.Gauge({
  name: 'dlq_size',
  help: 'Current size of the Dead Letter Queue',
  labelNames: ['storage', 'task_type'],
  registers: [register]
});

/**
 * DLQ 按类型大小 Gauge
 */
const dlqSizeByType = new promClient.Gauge({
  name: 'dlq_size_by_type',
  help: 'DLQ size by task type',
  labelNames: ['task_type', 'error_code'],
  registers: [register]
});

/**
 * DLQ 告警触发 Counter
 */
const dlqAlertsTriggered = new promClient.Counter({
  name: 'dlq_alerts_triggered_total',
  help: 'Total number of DLQ alerts triggered',
  labelNames: ['severity', 'threshold'],
  registers: [register]
});

/**
 * 任务处理成功 Counter
 */
const tasksProcessed = new promClient.Counter({
  name: 'tasks_processed_total',
  help: 'Total number of tasks processed successfully',
  labelNames: ['task_type', 'attempt'],
  registers: [register]
});

/**
 * 任务处理失败 Counter
 */
const tasksFailed = new promClient.Counter({
  name: 'tasks_failed_total',
  help: 'Total number of tasks that failed after all retries',
  labelNames: ['task_type', 'error_type', 'moved_to_dlq'],
  registers: [register]
});

/**
 * 任务重试 Counter
 */
const tasksRetried = new promClient.Counter({
  name: 'tasks_retried_total',
  help: 'Total number of task retries',
  labelNames: ['task_type', 'attempt'],
  registers: [register]
});

/**
 * 任务移入 DLQ Counter
 */
const tasksToDLQ = new promClient.Counter({
  name: 'tasks_to_dlq_total',
  help: 'Total number of tasks moved to DLQ',
  labelNames: ['task_type', 'error_code'],
  registers: [register]
});

/**
 * 从 DLQ 重试 Counter
 */
const tasksRetryFromDLQ = new promClient.Counter({
  name: 'tasks_retry_from_dlq_total',
  help: 'Total number of tasks retried from DLQ',
  labelNames: ['task_type', 'success'],
  registers: [register]
});

/**
 * DLQ 清空 Counter
 */
const dlqCleared = new promClient.Counter({
  name: 'dlq_cleared_total',
  help: 'Total number of tasks cleared from DLQ',
  labelNames: ['task_type', 'reason'],
  registers: [register]
});

/**
 * 任务执行时间 Histogram
 */
const taskExecutionTime = new promClient.Histogram({
  name: 'task_execution_time_seconds',
  help: 'Task execution time in seconds',
  labelNames: ['task_type', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register]
});

/**
 * 重试延迟 Histogram
 */
const retryDelay = new promClient.Histogram({
  name: 'retry_delay_seconds',
  help: 'Retry delay in seconds',
  labelNames: ['task_type', 'attempt'],
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60, 120],
  registers: [register]
});

/**
 * DLQ 任务存活时间 Histogram
 */
const dlqTaskLifetime = new promClient.Histogram({
  name: 'dlq_task_lifetime_seconds',
  help: 'Time spent in DLQ before resolution in seconds',
  labelNames: ['task_type', 'resolution_type'],
  buckets: [60, 300, 600, 1800, 3600, 7200, 14400, 28800, 86400],
  registers: [register]
});

/**
 * DLQ Metrics Manager
 */
class DLQMetricsManager {
  constructor(options = {}) {
    this.register = register;
    this.options = options;
    this.intervalId = null;
    
    // 启动默认指标收集
    promClient.collectDefaultMetrics({ register });
  }

  /**
   * 更新 DLQ 大小指标
   * @param {Object} stats - DLQ 统计信息
   */
  updateDLQSize(stats) {
    dlqSize.set({ storage: 'redis' }, stats.redis?.size || 0);
    dlqSize.set({ storage: 'database' }, stats.database?.total || 0);
    
    for (const [taskType, count] of Object.entries(stats.byType || {})) {
      dlqSizeByType.set({ task_type: taskType }, count);
    }
    
    for (const [errorCode, count] of Object.entries(stats.byError || {})) {
      dlqSizeByType.set({ error_code: errorCode }, count);
    }
  }

  /**
   * 记录任务处理成功
   * @param {string} taskType - 任务类型
   * @param {number} attempt - 尝试次数
   */
  recordTaskProcessed(taskType, attempt) {
    tasksProcessed.inc({ task_type: taskType, attempt: String(attempt) });
  }

  /**
   * 记录任务处理失败
   * @param {string} taskType - 任务类型
   * @param {string} errorType - 错误类型
   * @param {boolean} movedToDLQ - 是否移入 DLQ
   */
  recordTaskFailed(taskType, errorType, movedToDLQ) {
    tasksFailed.inc({
      task_type: taskType,
      error_type: errorType,
      moved_to_dlq: String(movedToDLQ)
    });
    
    if (movedToDLQ) {
      tasksToDLQ.inc({ task_type: taskType });
    }
  }

  /**
   * 记录任务重试
   * @param {string} taskType - 任务类型
   * @param {number} attempt - 尝试次数
   */
  recordTaskRetried(taskType, attempt) {
    tasksRetried.inc({ task_type: taskType, attempt: String(attempt) });
  }

  /**
   * 记录任务执行时间
   * @param {string} taskType - 任务类型
   * @param {string} status - 状态
   * @param {number} durationMs - 执行时间（毫秒）
   */
  recordExecutionTime(taskType, status, durationMs) {
    taskExecutionTime.observe(
      { task_type: taskType, status },
      durationMs / 1000
    );
  }

  /**
   * 记录重试延迟
   * @param {string} taskType - 任务类型
   * @param {number} attempt - 尝试次数
   * @param {number} delayMs - 延迟时间（毫秒）
   */
  recordRetryDelay(taskType, attempt, delayMs) {
    retryDelay.observe(
      { task_type: taskType, attempt: String(attempt) },
      delayMs / 1000
    );
  }

  /**
   * 记录 DLQ 告警触发
   * @param {string} severity - 告警级别
   * @param {number} threshold - 告警阈值
   */
  recordDLQAlert(severity, threshold) {
    dlqAlertsTriggered.inc({
      severity,
      threshold: String(threshold)
    });
  }

  /**
   * 记录从 DLQ 重试
   * @param {string} taskType - 任务类型
   * @param {boolean} success - 是否成功
   */
  recordRetryFromDLQ(taskType, success) {
    tasksRetryFromDLQ.inc({
      task_type: taskType,
      success: String(success)
    });
  }

  /**
   * 记录 DLQ 清空
   * @param {string} taskType - 任务类型
   * @param {string} reason - 清空原因
   * @param {number} count - 清空数量
   */
  recordDLQCleared(taskType, reason, count) {
    dlqCleared.inc({ task_type: taskType || 'all', reason }, count);
  }

  /**
   * 记录 DLQ 任务存活时间
   * @param {string} taskType - 任务类型
   * @param {string} resolutionType - 解决类型
   * @param {number} lifetimeSeconds - 存活时间（秒）
   */
  recordDLQTaskLifetime(taskType, resolutionType, lifetimeSeconds) {
    dlqTaskLifetime.observe(
      { task_type: taskType, resolution_type: resolutionType },
      lifetimeSeconds
    );
  }

  /**
   * 启动定期指标收集
   * @param {Function} statsCollector - 统计收集函数
   * @param {number} intervalMs - 收集间隔（毫秒）
   */
  startPeriodicCollection(statsCollector, intervalMs = 60000) {
    this.intervalId = setInterval(async () => {
      try {
        const stats = await statsCollector();
        this.updateDLQSize(stats);
      } catch (error) {
        console.error('Failed to collect DLQ metrics:', error);
      }
    }, intervalMs);
  }

  /**
   * 停止定期指标收集
   */
  stopPeriodicCollection() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * 获取 Prometheus 指标
   * @returns {Promise<string>} - 指标输出
   */
  async getMetrics() {
    return await register.metrics();
  }

  /**
   * 获取所有指标对象
   * @returns {Object} - 指标对象集合
   */
  getMetricsObjects() {
    return {
      dlqSize,
      dlqSizeByType,
      dlqAlertsTriggered,
      tasksProcessed,
      tasksFailed,
      tasksRetried,
      tasksToDLQ,
      tasksRetryFromDLQ,
      dlqCleared,
      taskExecutionTime,
      retryDelay,
      dlqTaskLifetime
    };
  }
}

module.exports = {
  DLQMetricsManager,
  register,
  metrics: {
    dlqSize,
    dlqSizeByType,
    dlqAlertsTriggered,
    tasksProcessed,
    tasksFailed,
    tasksRetried,
    tasksToDLQ,
    tasksRetryFromDLQ,
    dlqCleared,
    taskExecutionTime,
    retryDelay,
    dlqTaskLifetime
  }
};