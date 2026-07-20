/**
 * REQ-00585: 数据库死锁检测与自动化记录分析系统
 * 
 * 功能：
 * - PostgreSQL 死锁实时监控与捕获
 * - 死锁上下文关联（trace_id、SQL、事务信息）
 * - 死锁分析报告与根因定位
 * - Prometheus 指标与 Grafana 告警集成
 * - 死锁趋势分析与可视化
 * 
 * @module dbDeadlockMonitor
 */

'use strict';

const { createLogger } = require('./logger');

// Metrics - with fallback for test environments
let incrementCounter, observeHistogram, setGauge;
try {
  const metrics = require('./metrics');
  incrementCounter = metrics.incrementCounter;
  observeHistogram = metrics.observeHistogram;
  setGauge = metrics.setGauge;
} catch (e) {
  incrementCounter = () => {};
  observeHistogram = () => {};
  setGauge = () => {};
}

// OpenTelemetry imports - with fallback for test environments
let context, trace, getTracer;
try {
  const otel = require('@opentelemetry/api');
  context = otel.context;
  trace = otel.trace;
  getTracer = require('./tracing').getTracer;
} catch (e) {
  context = { active: () => null };
  trace = { getSpan: () => null };
  getTracer = () => null;
}

const logger = createLogger('db-deadlock-monitor');

// PostgreSQL 错误代码
const PG_ERROR_CODES = {
  DEADLOCK_DETECTED: '40P01',
  SERIALIZATION_FAILURE: '40001',
  LOCK_NOT_AVAILABLE: '55P03',
  QUERY_CANCELED: '57014'
};

// 死锁严重级别
const DEADLOCK_SEVERITY = {
  LOW: 'low',       // 单次死锁，自动重试成功
  MEDIUM: 'medium', // 短时间内多次死锁
  HIGH: 'high',     // 死锁导致事务失败
  CRITICAL: 'critical' // 死锁导致服务不可用
};

/**
 * 死锁记录结构
 */
class DeadlockRecord {
  constructor(data = {}) {
    this.id = data.id || `DL-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.timestamp = data.timestamp || Date.now();
    this.code = data.code || PG_ERROR_CODES.DEADLOCK_DETECTED;
    this.message = data.message || '';
    this.detail = data.detail || '';
    this.hint = data.hint || '';
    this.service = data.service || process.env.SERVICE_NAME || 'unknown';
    this.traceId = data.traceId || null;
    this.transactionName = data.transactionName || 'unknown';
    this.sqlQueries = data.sqlQueries || [];
    this.involvedProcesses = data.involvedProcesses || [];
    this.involvedTables = data.involvedTables || [];
    this.lockTypes = data.lockTypes || [];
    this.retryCount = data.retryCount || 0;
    this.resolved = data.resolved || false;
    this.severity = data.severity || DEADLOCK_SEVERITY.LOW;
    this.context = data.context || {};
  }

  toJSON() {
    return {
      id: this.id,
      timestamp: this.timestamp,
      datetime: new Date(this.timestamp).toISOString(),
      code: this.code,
      message: this.message,
      detail: this.detail,
      hint: this.hint,
      service: this.service,
      trace_id: this.traceId,
      transaction_name: this.transactionName,
      sql_queries: this.sqlQueries,
      involved_processes: this.involvedProcesses,
      involved_tables: this.involvedTables,
      lock_types: this.lockTypes,
      retry_count: this.retryCount,
      resolved: this.resolved,
      severity: this.severity,
      context: this.context
    };
  }
}

/**
 * 死锁分析器
 */
class DeadlockAnalyzer {
  constructor() {
    this.patterns = new Map();
    this.tableLockMatrix = new Map();
  }

  /**
   * 解析死锁详情，提取关键信息
   * @param {string} detail - PostgreSQL 死锁详情消息
   * @returns {Object} 解析结果
   */
  parseDeadlockDetail(detail) {
    if (!detail) return { processes: [], tables: [], lockTypes: [] };

    const processes = [];
    const tables = [];
    const lockTypes = [];

    // 解析进程信息: "Process 12345 waits for ..."
    const processMatches = detail.match(/Process (\d+)/g);
    if (processMatches) {
      processMatches.forEach(p => {
        const pid = parseInt(p.replace('Process ', ''));
        if (!processes.includes(pid)) processes.push(pid);
      });
    }

    // 解析表信息: "relation 12345 of database 12345" 或 "User lock on ..."
    const relationMatches = detail.match(/relation (\d+)/g);
    if (relationMatches) {
      relationMatches.forEach(r => {
        const relId = parseInt(r.replace('relation ', ''));
        if (!tables.includes(relId)) tables.push(relId);
      });
    }

    // 解析锁类型: "ShareLock", "ExclusiveLock", "RowShareLock", etc.
    const lockMatches = detail.match(/(ShareLock|ExclusiveLock|RowShareLock|RowExclusiveLock|AccessShareLock|AccessExclusiveLock)/g);
    if (lockMatches) {
      lockMatches.forEach(l => {
        if (!lockTypes.includes(l)) lockTypes.push(l);
      });
    }

    return { processes, tables, lockTypes };
  }

  /**
   * 计算死锁严重性
   * @param {Object} deadlock - 死锁记录
   * @param {Object} stats - 统计信息
   * @returns {string} 严重级别
   */
  calculateSeverity(deadlock, stats = {}) {
    // 如果死锁导致事务失败
    if (!deadlock.resolved && deadlock.retryCount >= 3) {
      return DEADLOCK_SEVERITY.CRITICAL;
    }

    // 短时间内高频死锁
    const recentCount = stats.recentDeadlocks || 0;
    if (recentCount >= 5) {
      return DEADLOCK_SEVERITY.HIGH;
    }
    if (recentCount >= 3) {
      return DEADLOCK_SEVERITY.MEDIUM;
    }

    // 涉及多个进程或多个表
    if (deadlock.involvedProcesses.length > 3 || deadlock.involvedTables.length > 2) {
      return DEADLOCK_SEVERITY.MEDIUM;
    }

    return DEADLOCK_SEVERITY.LOW;
  }

  /**
   * 分析死锁模式
   * @param {Array} deadlocks - 死锁记录列表
   * @returns {Object} 模式分析结果
   */
  analyzePatterns(deadlocks) {
    const patterns = {
      frequentTables: {},
      frequentOperations: {},
      timeDistribution: {},
      serviceDistribution: {},
      avgRetryCount: 0
    };

    let totalRetries = 0;

    for (const dl of deadlocks) {
      // 统计涉及的表
      for (const table of dl.involvedTables) {
        patterns.frequentTables[table] = (patterns.frequentTables[table] || 0) + 1;
      }

      // 统计操作类型
      for (const sql of dl.sqlQueries) {
        const op = sql.trim().split(' ')[0].toUpperCase();
        patterns.frequentOperations[op] = (patterns.frequentOperations[op] || 0) + 1;
      }

      // 时间分布（按小时）
      const hour = new Date(dl.timestamp).getHours();
      patterns.timeDistribution[hour] = (patterns.timeDistribution[hour] || 0) + 1;

      // 服务分布
      patterns.serviceDistribution[dl.service] = (patterns.serviceDistribution[dl.service] || 0) + 1;

      totalRetries += dl.retryCount;
    }

    if (deadlocks.length > 0) {
      patterns.avgRetryCount = totalRetries / deadlocks.length;
    }

    return patterns;
  }

  /**
   * 生成死锁报告
   * @param {Object} deadlock - 死锁记录
   * @returns {string} Markdown 格式报告
   */
  generateReport(deadlock) {
    const lines = [
      `# 死锁分析报告`,
      ``,
      `## 基本信息`,
      `- **ID**: ${deadlock.id}`,
      `- **时间**: ${new Date(deadlock.timestamp).toISOString()}`,
      `- **服务**: ${deadlock.service}`,
      `- **事务**: ${deadlock.transactionName}`,
      `- **Trace ID**: ${deadlock.traceId || 'N/A'}`,
      `- **严重性**: ${deadlock.severity}`,
      ``,
      `## 错误详情`,
      `- **错误码**: ${deadlock.code}`,
      `- **消息**: ${deadlock.message}`,
      `- **详情**: ${deadlock.detail}`,
      `- **提示**: ${deadlock.hint || 'N/A'}`,
      ``,
      `## 涉及对象`,
      `### 进程`,
      ...deadlock.involvedProcesses.map(p => `- PID: ${p}`),
      ``,
      `### 表`,
      ...deadlock.involvedTables.map(t => `- Table OID: ${t}`),
      ``,
      `### 锁类型`,
      ...deadlock.lockTypes.map(l => `- ${l}`),
      ``,
      `## SQL 语句`,
      ...deadlock.sqlQueries.map((sql, i) => `${i + 1}. \`${sql.substring(0, 200)}\``),
      ``,
      `## 处理结果`,
      `- **重试次数**: ${deadlock.retryCount}`,
      `- **是否解决**: ${deadlock.resolved ? '是' : '否'}`
    ];

    return lines.join('\n');
  }
}

/**
 * 数据库死锁监控器
 */
class DbDeadlockMonitor {
  constructor(config = {}) {
    this.config = {
      enableMetrics: config.enableMetrics !== false,
      enableAlerts: config.enableAlerts !== false,
      maxHistorySize: config.maxHistorySize || 1000,
      analysisWindowMs: config.analysisWindowMs || 3600000, // 1 hour
      alertThreshold: config.alertThreshold || 3, // 1小时内超过3次死锁告警
      ...config
    };

    this.analyzer = new DeadlockAnalyzer();
    this.history = [];
    this.stats = {
      totalDetected: 0,
      totalResolved: 0,
      totalFailed: 0,
      recentDeadlocks: 0,
      lastResetTime: Date.now()
    };

    this.alertHandlers = [];
    this.queryContextMap = new Map(); // 存储查询上下文
    this.activeTransactions = new Map(); // 活跃事务追踪

    this._initializeMetrics();
    this._startPeriodicTasks();
  }

  /**
   * 初始化 Prometheus 指标
   */
  _initializeMetrics() {
    if (!this.config.enableMetrics) return;

    // 这些指标会在 metrics.js 中注册
    this.metrics = {
      deadlocksDetected: {
        name: 'minego_db_deadlocks_detected_total',
        labels: ['service', 'severity']
      },
      deadlocksResolved: {
        name: 'minego_db_deadlocks_resolved_total',
        labels: ['service']
      },
      deadlockRetryCount: {
        name: 'minego_db_deadlock_retry_count',
        labels: ['service', 'transaction_name']
      },
      deadlockResolutionTime: {
        name: 'minego_db_deadlock_resolution_time_seconds',
        labels: ['service']
      },
      activeTransactionsAtDeadlock: {
        name: 'minego_db_active_transactions_at_deadlock',
        labels: ['service']
      },
      deadlockByTable: {
        name: 'minego_db_deadlock_by_table_total',
        labels: ['service', 'table']
      },
      deadlockByLockType: {
        name: 'minego_db_deadlock_by_lock_type_total',
        labels: ['service', 'lock_type']
      }
    };
  }

  /**
   * 启动周期性任务
   */
  _startPeriodicTasks() {
    // 每5分钟重置近期统计
    this._resetInterval = setInterval(() => {
      this.stats.recentDeadlocks = 0;
    }, 300000);

    // 每小时执行模式分析
    this._analysisInterval = setInterval(() => {
      this._runPatternAnalysis();
    }, this.config.analysisWindowMs);

    // 防止阻止进程退出
    if (this._resetInterval) this._resetInterval.unref();
    if (this._analysisInterval) this._analysisInterval.unref();
  }

  /**
   * 记录查询上下文（在执行 SQL 前调用）
   * @param {string} queryId - 查询 ID
   * @param {Object} context - 上下文信息
   */
  recordQueryContext(queryId, context) {
    this.queryContextMap.set(queryId, {
      sql: context.sql,
      params: context.params,
      traceId: context.traceId,
      transactionName: context.transactionName,
      timestamp: Date.now()
    });

    // 限制内存使用
    if (this.queryContextMap.size > 10000) {
      const oldestKey = this.queryContextMap.keys().next().value;
      this.queryContextMap.delete(oldestKey);
    }
  }

  /**
   * 记录活跃事务
   * @param {string} txId - 事务 ID
   * @param {Object} info - 事务信息
   */
  recordActiveTransaction(txId, info) {
    this.activeTransactions.set(txId, {
      ...info,
      startTime: Date.now()
    });

    try {
      setGauge('minego_db_active_transactions', this.activeTransactions.size, {
        service: process.env.SERVICE_NAME || 'default'
      });
    } catch (e) {
      // Metrics not available
    }
  }

  /**
   * 移除活跃事务记录
   * @param {string} txId - 事务 ID
   */
  removeActiveTransaction(txId) {
    this.activeTransactions.delete(txId);

    try {
      setGauge('minego_db_active_transactions', this.activeTransactions.size, {
        service: process.env.SERVICE_NAME || 'default'
      });
    } catch (e) {
      // Metrics not available
    }
  }

  /**
   * 捕获死锁事件
   * @param {Error} error - 死锁错误
   * @param {Object} ctx - 上下文信息
   * @returns {DeadlockRecord} 死锁记录
   */
  captureDeadlock(error, ctx = {}) {
    const detail = this.analyzer.parseDeadlockDetail(error.detail);

    // 尝试关联查询上下文
    let sqlQueries = ctx.sqlQueries || [];
    let traceId = ctx.traceId || null;

    // 从 OpenTelemetry 获取当前 trace_id
    try {
      const currentSpan = trace.getSpan(context.active());
      if (currentSpan) {
        traceId = currentSpan.spanContext().traceId;
      }
    } catch (e) {
      // OpenTelemetry not available, skip trace_id extraction
    }

    // 创建死锁记录
    const record = new DeadlockRecord({
      code: error.code,
      message: error.message,
      detail: error.detail,
      hint: error.hint,
      service: process.env.SERVICE_NAME || 'unknown',
      traceId: traceId,
      transactionName: ctx.transactionName || 'unknown',
      sqlQueries: sqlQueries,
      involvedProcesses: detail.processes,
      involvedTables: detail.tables,
      lockTypes: detail.lockTypes,
      retryCount: ctx.retryCount || 0,
      resolved: false
    });

    // 计算严重性
    record.severity = this.analyzer.calculateSeverity(record, this.stats);

    // 更新统计
    this.stats.totalDetected++;
    this.stats.recentDeadlocks++;

    // 添加到历史
    this._addToHistory(record);

    // 更新指标
    this._updateMetrics(record);

    // 记录日志
    logger.error({
      event: 'deadlock_detected',
      deadlock: record.toJSON()
    }, 'Database deadlock detected');

    // 发送告警
    this._sendAlert(record);

    // 检查是否需要触发高级别告警
    if (this.stats.recentDeadlocks >= this.config.alertThreshold) {
      this._sendThresholdAlert();
    }

    return record;
  }

  /**
   * 标记死锁已解决
   * @param {string} deadlockId - 死锁 ID
   * @param {Object} resolution - 解决信息
   */
  markResolved(deadlockId, resolution = {}) {
    const record = this.history.find(r => r.id === deadlockId);
    if (record) {
      record.resolved = true;
      record.retryCount = resolution.retryCount || record.retryCount;
      
      this.stats.totalResolved++;
      
      incrementCounter('minego_db_deadlocks_resolved_total', 1, {
        service: record.service
      });

      logger.info({
        event: 'deadlock_resolved',
        deadlock_id: deadlockId,
        retry_count: record.retryCount
      }, 'Deadlock resolved');
    }
  }

  /**
   * 记录死锁处理失败
   * @param {string} deadlockId - 死锁 ID
   */
  markFailed(deadlockId) {
    const record = this.history.find(r => r.id === deadlockId);
    if (record) {
      this.stats.totalFailed++;
      
      logger.error({
        event: 'deadlock_failed',
        deadlock_id: deadlockId
      }, 'Deadlock handling failed - transaction aborted');
    }
  }

  /**
   * 添加到历史记录
   */
  _addToHistory(record) {
    this.history.push(record);

    // 保持历史记录在限制内
    while (this.history.length > this.config.maxHistorySize) {
      this.history.shift();
    }
  }

  /**
   * 更新 Prometheus 指标
   */
  _updateMetrics(record) {
    if (!this.config.enableMetrics) return;

    // 死锁检测计数
    incrementCounter('minego_db_deadlocks_detected_total', 1, {
      service: record.service,
      severity: record.severity
    });

    // 重试次数
    if (record.retryCount > 0) {
      incrementCounter('minego_db_deadlock_retry_count', record.retryCount, {
        service: record.service,
        transaction_name: record.transactionName
      });
    }

    // 活跃事务数
    setGauge('minego_db_active_transactions_at_deadlock', this.activeTransactions.size, {
      service: record.service
    });

    // 按表统计
    for (const table of record.involvedTables) {
      incrementCounter('minego_db_deadlock_by_table_total', 1, {
        service: record.service,
        table: String(table)
      });
    }

    // 按锁类型统计
    for (const lockType of record.lockTypes) {
      incrementCounter('minego_db_deadlock_by_lock_type_total', 1, {
        service: record.service,
        lock_type: lockType
      });
    }
  }

  /**
   * 发送告警
   */
  async _sendAlert(record) {
    if (!this.config.enableAlerts) return;

    const alert = {
      severity: record.severity === DEADLOCK_SEVERITY.CRITICAL ? 'critical' :
                record.severity === DEADLOCK_SEVERITY.HIGH ? 'warning' : 'info',
      event: 'db_deadlock_detected',
      service: record.service,
      message: `Database deadlock detected in ${record.transactionName}`,
      details: record.toJSON()
    };

    for (const handler of this.alertHandlers) {
      try {
        await handler(alert);
      } catch (err) {
        logger.error({ err }, 'Failed to send deadlock alert');
      }
    }

    // 尝试使用 AlertManager
    try {
      const { getAlertManager } = require('./alerting');
      const alertManager = getAlertManager();
      await alertManager.send(alert);
    } catch (err) {
      // AlertManager 未初始化，忽略
    }
  }

  /**
   * 发送阈值告警
   */
  async _sendThresholdAlert() {
    const alert = {
      severity: 'warning',
      event: 'db_deadlock_threshold_exceeded',
      service: process.env.SERVICE_NAME || 'unknown',
      message: `High deadlock frequency detected: ${this.stats.recentDeadlocks} deadlocks in recent period`,
      details: {
        recentDeadlocks: this.stats.recentDeadlocks,
        threshold: this.config.alertThreshold
      }
    };

    for (const handler of this.alertHandlers) {
      try {
        await handler(alert);
      } catch (err) {
        logger.error({ err }, 'Failed to send threshold alert');
      }
    }
  }

  /**
   * 执行模式分析
   */
  _runPatternAnalysis() {
    if (this.history.length === 0) return;

    const recentDeadlocks = this.history.filter(
      dl => Date.now() - dl.timestamp < this.config.analysisWindowMs
    );

    if (recentDeadlocks.length === 0) return;

    const patterns = this.analyzer.analyzePatterns(recentDeadlocks);

    logger.info({
      event: 'deadlock_pattern_analysis',
      patterns,
      sampleCount: recentDeadlocks.length
    }, 'Deadlock pattern analysis completed');

    // 如果发现频繁死锁的表，记录建议
    const topTables = Object.entries(patterns.frequentTables)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    if (topTables.length > 0 && topTables[0][1] >= 3) {
      logger.warn({
        event: 'deadlock_hot_tables',
        tables: topTables
      }, 'Frequent deadlock detected on specific tables - consider query optimization');
    }
  }

  /**
   * 添加告警处理器
   * @param {Function} handler - 告警处理函数
   */
  addAlertHandler(handler) {
    this.alertHandlers.push(handler);
  }

  /**
   * 获取死锁历史
   * @param {Object} options - 查询选项
   * @returns {Array} 死锁记录列表
   */
  getHistory(options = {}) {
    let result = [...this.history];

    if (options.service) {
      result = result.filter(r => r.service === options.service);
    }

    if (options.severity) {
      result = result.filter(r => r.severity === options.severity);
    }

    if (options.since) {
      result = result.filter(r => r.timestamp >= options.since);
    }

    if (options.limit) {
      result = result.slice(-options.limit);
    }

    return result.map(r => r.toJSON());
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      ...this.stats,
      historySize: this.history.length,
      activeTransactions: this.activeTransactions.size,
      uptime: Date.now() - this.stats.lastResetTime
    };
  }

  /**
   * 获取模式分析结果
   * @returns {Object} 模式分析
   */
  getPatterns() {
    const recentDeadlocks = this.history.filter(
      dl => Date.now() - dl.timestamp < this.config.analysisWindowMs
    );
    return this.analyzer.analyzePatterns(recentDeadlocks);
  }

  /**
   * 生成死锁报告
   * @param {string} deadlockId - 死锁 ID（可选，不传则生成汇总报告）
   * @returns {string} Markdown 格式报告
   */
  generateReport(deadlockId) {
    if (deadlockId) {
      const record = this.history.find(r => r.id === deadlockId);
      if (record) {
        return this.analyzer.generateReport(record);
      }
      return 'Deadlock not found';
    }

    // 生成汇总报告
    const patterns = this.getPatterns();
    const recentCount = this.history.filter(
      dl => Date.now() - dl.timestamp < 3600000
    ).length;

    const lines = [
      `# 数据库死锁监控报告`,
      ``,
      `## 统计概览`,
      `- **总检测次数**: ${this.stats.totalDetected}`,
      `- **已解决**: ${this.stats.totalResolved}`,
      `- **失败**: ${this.stats.totalFailed}`,
      `- **近期死锁（1小时）**: ${recentCount}`,
      ``,
      `## 模式分析`,
      `### 频繁涉及的表`,
      ...Object.entries(patterns.frequentTables)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([table, count]) => `- Table ${table}: ${count} 次`),
      ``,
      `### 操作分布`,
      ...Object.entries(patterns.frequentOperations)
        .sort((a, b) => b[1] - a[1])
        .map(([op, count]) => `- ${op}: ${count} 次`),
      ``,
      `### 服务分布`,
      ...Object.entries(patterns.serviceDistribution)
        .sort((a, b) => b[1] - a[1])
        .map(([service, count]) => `- ${service}: ${count} 次`)
    ];

    return lines.join('\n');
  }

  /**
   * 重置统计
   */
  reset() {
    this.history = [];
    this.stats = {
      totalDetected: 0,
      totalResolved: 0,
      totalFailed: 0,
      recentDeadlocks: 0,
      lastResetTime: Date.now()
    };
    this.queryContextMap.clear();
    logger.info('Deadlock monitor reset');
  }

  /**
   * 停止监控
   */
  stop() {
    if (this._resetInterval) {
      clearInterval(this._resetInterval);
      this._resetInterval = null;
    }
    if (this._analysisInterval) {
      clearInterval(this._analysisInterval);
      this._analysisInterval = null;
    }
    logger.info('Deadlock monitor stopped');
  }
}

// 单例实例
let monitorInstance = null;

/**
 * 获取死锁监控器单例
 * @param {Object} config - 配置
 * @returns {DbDeadlockMonitor}
 */
function getDbDeadlockMonitor(config) {
  if (!monitorInstance) {
    monitorInstance = new DbDeadlockMonitor(config);
  }
  return monitorInstance;
}

/**
 * 重置监控器（用于测试）
 */
function resetDbDeadlockMonitor() {
  if (monitorInstance) {
    monitorInstance.stop();
    monitorInstance = null;
  }
}

module.exports = {
  DbDeadlockMonitor,
  DeadlockAnalyzer,
  DeadlockRecord,
  PG_ERROR_CODES,
  DEADLOCK_SEVERITY,
  getDbDeadlockMonitor,
  resetDbDeadlockMonitor
};
