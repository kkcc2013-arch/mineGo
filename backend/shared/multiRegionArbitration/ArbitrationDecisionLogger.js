/**
 * REQ-00514: 多区域服务状态同步与智能仲裁系统
 * ArbitrationDecisionLogger - 仲裁决策日志与审计
 * 
 * 功能：
 * - 记录所有仲裁决策
 * - 提供审计查询
 * - 生成决策报告
 * 
 * 创建时间: 2026-07-08 22:00 UTC
 */

'use strict';

const { createLogger } = require('../logger');
const { Pool } = require('pg');
const Redis = require('ioredis');
const promClient = require('prom-client');

const logger = createLogger('arbitration-decision-logger');

// ============================================================
// Prometheus 指标
// ============================================================

const metrics = {
  decisionsLogged: new promClient.Counter({
    name: 'minego_arbitration_decisions_logged_total',
    help: 'Total arbitration decisions logged',
    labelNames: ['decision_type', 'fault_type', 'result']
  }),
  
  auditQueries: new promClient.Counter({
    name: 'minego_arbitration_audit_queries_total',
    help: 'Total audit queries executed',
    labelNames: ['query_type', 'result']
  }),
  
  logWriteLatency: new promClient.Histogram({
    name: 'minego_arbitration_log_write_latency_ms',
    help: 'Log write latency in milliseconds',
    labelNames: ['storage'],
    buckets: [1, 5, 10, 25, 50, 100, 250]
  })
};

// ============================================================
// 配置
// ============================================================

const DEFAULT_CONFIG = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/minego',
  
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  redisKeyPrefix: 'minego:arbitration:log:',
  
  logRetentionDays: 90,
  maxLogSize: 10000,
  
  enableDatabaseLogging: true,
  enableRedisLogging: true,
  enableConsoleLogging: true
};

// ============================================================
// ArbitrationDecisionLogger 类
// ============================================================

class ArbitrationDecisionLogger {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // 数据库连接池
    this.dbPool = null;
    
    // Redis 连接
    this.redis = null;
    
    // 内存缓存（用于快速查询最近决策）
    this.memoryCache = [];
    
    // 初始化标志
    this.initialized = false;
  }

  /**
   * 初始化
   */
  async initialize() {
    try {
      // 初始化数据库连接池
      if (this.config.enableDatabaseLogging) {
        this.dbPool = new Pool({
          connectionString: this.config.databaseUrl,
          max: 5,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 2000
        });
        
        // 创建表（如果不存在）
        await this.createTables();
      }
      
      // 初始化 Redis 连接
      if (this.config.enableRedisLogging) {
        this.redis = new Redis(this.config.redisUrl);
      }
      
      this.initialized = true;
      
      logger.info('ArbitrationDecisionLogger initialized', {
        databaseEnabled: this.config.enableDatabaseLogging,
        redisEnabled: this.config.enableRedisLogging
      });
      
      return true;
    } catch (error) {
      logger.error('Failed to initialize ArbitrationDecisionLogger', { error: error.message });
      throw error;
    }
  }

  /**
   * 创建数据库表
   */
  async createTables() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS arbitration_decisions (
        id SERIAL PRIMARY KEY,
        decision_id VARCHAR(100) UNIQUE NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        fault_type VARCHAR(50) NOT NULL,
        fault_severity INTEGER,
        decision_type VARCHAR(50) NOT NULL,
        action VARCHAR(100),
        priority INTEGER,
        
        affected_region VARCHAR(50),
        affected_service VARCHAR(50),
        
        healthy_regions TEXT[],
        recovery_plan JSONB,
        
        execution_status VARCHAR(50),
        execution_result JSONB,
        execution_duration_ms INTEGER,
        
        escalation_level INTEGER DEFAULT 0,
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        
        INDEX idx_timestamp (timestamp DESC),
        INDEX idx_fault_type (fault_type),
        INDEX idx_decision_type (decision_type),
        INDEX idx_region (affected_region),
        INDEX idx_service (affected_service)
      );
      
      CREATE TABLE IF NOT EXISTS arbitration_audit_log (
        id SERIAL PRIMARY KEY,
        decision_id VARCHAR(100) NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        event_timestamp TIMESTAMPTZ NOT NULL,
        event_data JSONB,
        user_id VARCHAR(100),
        ip_address VARCHAR(50),
        
        created_at TIMESTAMPTZ DEFAULT NOW(),
        
        INDEX idx_decision_id (decision_id),
        INDEX idx_event_type (event_type)
      );
    `;
    
    try {
      await this.dbPool.query(createTableSQL);
      logger.debug('Database tables created/verified');
    } catch (error) {
      logger.warn('Failed to create tables', { error: error.message });
      // 表可能已存在，继续执行
    }
  }

  /**
   * 记录决策
   */
  async logDecision(decision) {
    const startTime = Date.now();
    
    const logEntry = {
      decisionId: decision.id,
      timestamp: decision.timestamp || new Date().toISOString(),
      faultType: decision.faultType,
      faultSeverity: decision.faultSeverity,
      decisionType: decision.type,
      action: decision.action,
      priority: decision.priority,
      
      affectedRegion: decision.affectedRegion,
      affectedService: decision.affectedService,
      
      healthyRegions: decision.healthyRegions || [],
      recoveryPlan: decision.recoveryPlan || [],
      
      executionStatus: decision.executionResult?.status || 'pending',
      executionResult: decision.executionResult || null,
      executionDurationMs: decision.executionResult?.duration || null,
      
      escalationLevel: decision.escalationLevel || 0
    };
    
    try {
      // 并行写入多个存储
      const writePromises = [];
      
      // 写入数据库
      if (this.config.enableDatabaseLogging && this.dbPool) {
        writePromises.push(this.writeToDatabase(logEntry));
      }
      
      // 写入 Redis
      if (this.config.enableRedisLogging && this.redis) {
        writePromises.push(this.writeToRedis(logEntry));
      }
      
      // 写入内存缓存
      writePromises.push(this.writeToMemory(logEntry));
      
      // 等待所有写入完成
      await Promise.all(writePromises);
      
      const latency = Date.now() - startTime;
      
      metrics.decisionsLogged.inc({
        decision_type: decision.type,
        fault_type: decision.faultType,
        result: 'success'
      });
      
      logger.info('Decision logged', {
        decisionId: logEntry.decisionId,
        decisionType: logEntry.decisionType,
        latency
      });
      
      return logEntry;
    } catch (error) {
      metrics.decisionsLogged.inc({
        decision_type: decision.type,
        fault_type: decision.faultType,
        result: 'error'
      });
      
      logger.error('Failed to log decision', { 
        decisionId: logEntry.decisionId,
        error: error.message 
      });
      
      throw error;
    }
  }

  /**
   * 写入数据库
   */
  async writeToDatabase(logEntry) {
    const startTime = Date.now();
    
    const insertSQL = `
      INSERT INTO arbitration_decisions (
        decision_id, timestamp, fault_type, fault_severity,
        decision_type, action, priority, affected_region,
        affected_service, healthy_regions, recovery_plan,
        execution_status, execution_result, execution_duration_ms,
        escalation_level
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (decision_id) DO UPDATE SET
        execution_status = EXCLUDED.execution_status,
        execution_result = EXCLUDED.execution_result,
        execution_duration_ms = EXCLUDED.execution_duration_ms
    `;
    
    const values = [
      logEntry.decisionId,
      logEntry.timestamp,
      logEntry.faultType,
      logEntry.faultSeverity,
      logEntry.decisionType,
      logEntry.action,
      logEntry.priority,
      logEntry.affectedRegion,
      logEntry.affectedService,
      logEntry.healthyRegions,
      JSON.stringify(logEntry.recoveryPlan),
      logEntry.executionStatus,
      JSON.stringify(logEntry.executionResult),
      logEntry.executionDurationMs,
      logEntry.escalationLevel
    ];
    
    await this.dbPool.query(insertSQL, values);
    
    const latency = Date.now() - startTime;
    metrics.logWriteLatency.observe({ storage: 'database' }, latency);
  }

  /**
   * 写入 Redis
   */
  async writeToRedis(logEntry) {
    const startTime = Date.now();
    
    const key = `${this.config.redisKeyPrefix}${logEntry.decisionId}`;
    const value = JSON.stringify(logEntry);
    
    // 设置 7 天过期
    await this.redis.set(key, value, 'EX', 7 * 24 * 60 * 60);
    
    // 同时添加到时间序列列表
    const listKey = `${this.config.redisKeyPrefix}timeline`;
    await this.redis.lpush(listKey, logEntry.decisionId);
    await this.redis.ltrim(listKey, 0, this.config.maxLogSize - 1);
    
    const latency = Date.now() - startTime;
    metrics.logWriteLatency.observe({ storage: 'redis' }, latency);
  }

  /**
   * 写入内存缓存
   */
  async writeToMemory(logEntry) {
    this.memoryCache.unshift(logEntry);
    
    // 限制缓存大小
    if (this.memoryCache.length > this.config.maxLogSize) {
      this.memoryCache = this.memoryCache.slice(0, this.config.maxLogSize);
    }
  }

  /**
   * 记录审计事件
   */
  async logAuditEvent(decisionId, eventType, eventData, userId = null, ipAddress = null) {
    const auditEntry = {
      decisionId,
      eventType,
      eventTimestamp: new Date().toISOString(),
      eventData,
      userId,
      ipAddress
    };
    
    try {
      // 写入数据库
      if (this.config.enableDatabaseLogging && this.dbPool) {
        const insertSQL = `
          INSERT INTO arbitration_audit_log (
            decision_id, event_type, event_timestamp,
            event_data, user_id, ip_address
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `;
        
        await this.dbPool.query(insertSQL, [
          auditEntry.decisionId,
          auditEntry.eventType,
          auditEntry.eventTimestamp,
          JSON.stringify(auditEntry.eventData),
          auditEntry.userId,
          auditEntry.ipAddress
        ]);
      }
      
      metrics.auditQueries.inc({ query_type: 'log', result: 'success' });
      
      logger.debug('Audit event logged', { decisionId, eventType });
      
      return auditEntry;
    } catch (error) {
      metrics.auditQueries.inc({ query_type: 'log', result: 'error' });
      
      logger.error('Failed to log audit event', { 
        decisionId, 
        eventType, 
        error: error.message 
      });
      
      throw error;
    }
  }

  /**
   * 查询决策历史
   */
  async queryDecisions(filters = {}, limit = 50, offset = 0) {
    try {
      // 优先从内存缓存查询最近决策
      if (!filters.startDate && !filters.endDate && limit <= 100) {
        const cachedResults = this.queryFromMemory(filters, limit);
        if (cachedResults.length > 0) {
          metrics.auditQueries.inc({ query_type: 'query', result: 'cache_hit' });
          return cachedResults;
        }
      }
      
      // 从数据库查询
      if (this.config.enableDatabaseLogging && this.dbPool) {
        const results = await this.queryFromDatabase(filters, limit, offset);
        metrics.auditQueries.inc({ query_type: 'query', result: 'database' });
        return results;
      }
      
      // 从 Redis 查询
      if (this.config.enableRedisLogging && this.redis) {
        const results = await this.queryFromRedis(filters, limit);
        metrics.auditQueries.inc({ query_type: 'query', result: 'redis' });
        return results;
      }
      
      return [];
    } catch (error) {
      metrics.auditQueries.inc({ query_type: 'query', result: 'error' });
      
      logger.error('Failed to query decisions', { error: error.message });
      
      return [];
    }
  }

  /**
   * 从内存缓存查询
   */
  queryFromMemory(filters, limit) {
    let results = [...this.memoryCache];
    
    if (filters.decisionType) {
      results = results.filter(r => r.decisionType === filters.decisionType);
    }
    
    if (filters.faultType) {
      results = results.filter(r => r.faultType === filters.faultType);
    }
    
    if (filters.region) {
      results = results.filter(r => r.affectedRegion === filters.region);
    }
    
    if (filters.service) {
      results = results.filter(r => r.affectedService === filters.service);
    }
    
    return results.slice(0, limit);
  }

  /**
   * 从数据库查询
   */
  async queryFromDatabase(filters, limit, offset) {
    let sql = 'SELECT * FROM arbitration_decisions WHERE 1=1';
    const values = [];
    let paramIndex = 1;
    
    if (filters.decisionId) {
      sql += ` AND decision_id = $${paramIndex++}`;
      values.push(filters.decisionId);
    }
    
    if (filters.decisionType) {
      sql += ` AND decision_type = $${paramIndex++}`;
      values.push(filters.decisionType);
    }
    
    if (filters.faultType) {
      sql += ` AND fault_type = $${paramIndex++}`;
      values.push(filters.faultType);
    }
    
    if (filters.region) {
      sql += ` AND affected_region = $${paramIndex++}`;
      values.push(filters.region);
    }
    
    if (filters.service) {
      sql += ` AND affected_service = $${paramIndex++}`;
      values.push(filters.service);
    }
    
    if (filters.startDate) {
      sql += ` AND timestamp >= $${paramIndex++}`;
      values.push(filters.startDate);
    }
    
    if (filters.endDate) {
      sql += ` AND timestamp <= $${paramIndex++}`;
      values.push(filters.endDate);
    }
    
    sql += ` ORDER BY timestamp DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    values.push(limit, offset);
    
    const result = await this.dbPool.query(sql, values);
    
    return result.rows;
  }

  /**
   * 从 Redis 查询
   */
  async queryFromRedis(filters, limit) {
    const listKey = `${this.config.redisKeyPrefix}timeline`;
    const decisionIds = await this.redis.lrange(listKey, 0, limit - 1);
    
    const results = [];
    
    for (const decisionId of decisionIds) {
      const key = `${this.config.redisKeyPrefix}${decisionId}`;
      const value = await this.redis.get(key);
      
      if (value) {
        const entry = JSON.parse(value);
        
        // 应用过滤器
        if (filters.decisionType && entry.decisionType !== filters.decisionType) continue;
        if (filters.faultType && entry.faultType !== filters.faultType) continue;
        if (filters.region && entry.affectedRegion !== filters.region) continue;
        if (filters.service && entry.affectedService !== filters.service) continue;
        
        results.push(entry);
      }
    }
    
    return results;
  }

  /**
   * 获取单个决策详情
   */
  async getDecision(decisionId) {
    try {
      // 先查内存
      const cached = this.memoryCache.find(d => d.decisionId === decisionId);
      if (cached) {
        return cached;
      }
      
      // 查数据库
      if (this.config.enableDatabaseLogging && this.dbPool) {
        const sql = 'SELECT * FROM arbitration_decisions WHERE decision_id = $1';
        const result = await this.dbPool.query(sql, [decisionId]);
        
        if (result.rows.length > 0) {
          return result.rows[0];
        }
      }
      
      // 查 Redis
      if (this.config.enableRedisLogging && this.redis) {
        const key = `${this.config.redisKeyPrefix}${decisionId}`;
        const value = await this.redis.get(key);
        
        if (value) {
          return JSON.parse(value);
        }
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to get decision', { decisionId, error: error.message });
      return null;
    }
  }

  /**
   * 获取审计日志
   */
  async getAuditLog(decisionId) {
    try {
      if (!this.config.enableDatabaseLogging || !this.dbPool) {
        return [];
      }
      
      const sql = `
        SELECT * FROM arbitration_audit_log 
        WHERE decision_id = $1 
        ORDER BY event_timestamp DESC
      `;
      
      const result = await this.dbPool.query(sql, [decisionId]);
      
      return result.rows;
    } catch (error) {
      logger.error('Failed to get audit log', { decisionId, error: error.message });
      return [];
    }
  }

  /**
   * 生成决策报告
   */
  async generateReport(startDate, endDate) {
    try {
      const filters = { startDate, endDate };
      const decisions = await this.queryDecisions(filters, 1000);
      
      // 统计分析
      const report = {
        period: { startDate, endDate },
        totalDecisions: decisions.length,
        
        byFaultType: {},
        byDecisionType: {},
        byRegion: {},
        byService: {},
        
        averageSeverity: 0,
        averageExecutionTime: 0,
        
        successRate: 0,
        escalationRate: 0,
        
        timeline: []
      };
      
      // 按类型统计
      for (const decision of decisions) {
        // 故障类型
        const faultType = decision.faultType || 'unknown';
        report.byFaultType[faultType] = (report.byFaultType[faultType] || 0) + 1;
        
        // 决策类型
        const decisionType = decision.decisionType || 'unknown';
        report.byDecisionType[decisionType] = (report.byDecisionType[decisionType] || 0) + 1;
        
        // 区域
        const region = decision.affectedRegion || 'unknown';
        report.byRegion[region] = (report.byRegion[region] || 0) + 1;
        
        // 服务
        const service = decision.affectedService || 'unknown';
        report.byService[service] = (report.byService[service] || 0) + 1;
      }
      
      // 计算平均值
      const severities = decisions.map(d => d.faultSeverity).filter(s => s != null);
      const execTimes = decisions.map(d => d.executionDurationMs).filter(t => t != null);
      
      report.averageSeverity = severities.length > 0
        ? severities.reduce((a, b) => a + b, 0) / severities.length
        : 0;
      
      report.averageExecutionTime = execTimes.length > 0
        ? execTimes.reduce((a, b) => a + b, 0) / execTimes.length
        : 0;
      
      // 成功率
      const successful = decisions.filter(d => d.executionStatus === 'recovered' || d.executionStatus === 'completed').length;
      report.successRate = decisions.length > 0 ? (successful / decisions.length) * 100 : 0;
      
      // 升级率
      const escalated = decisions.filter(d => d.escalationLevel > 0).length;
      report.escalationRate = decisions.length > 0 ? (escalated / decisions.length) * 100 : 0;
      
      // 时间线（按小时分组）
      const timelineMap = new Map();
      for (const decision of decisions) {
        const hour = decision.timestamp.slice(0, 13); // YYYY-MM-DDTHH
        timelineMap.set(hour, (timelineMap.get(hour) || 0) + 1);
      }
      
      report.timeline = Array.from(timelineMap.entries())
        .map(([hour, count]) => ({ hour, count }))
        .sort((a, b) => a.hour.localeCompare(b.hour));
      
      return report;
    } catch (error) {
      logger.error('Failed to generate report', { error: error.message });
      
      return {
        error: error.message,
        totalDecisions: 0
      };
    }
  }

  /**
   * 清理过期日志
   */
  async cleanupOldLogs() {
    const cutoffDate = new Date(Date.now() - this.config.logRetentionDays * 24 * 60 * 60 * 1000);
    
    try {
      // 清理数据库
      if (this.config.enableDatabaseLogging && this.dbPool) {
        const sql = 'DELETE FROM arbitration_decisions WHERE timestamp < $1';
        const result = await this.dbPool.query(sql, [cutoffDate]);
        
        logger.info('Old logs cleaned up from database', {
          deletedCount: result.rowCount,
          cutoffDate
        });
      }
      
      // Redis 会自动过期，无需手动清理
      
      // 清理内存缓存
      const originalLength = this.memoryCache.length;
      this.memoryCache = this.memoryCache.filter(entry => {
        const entryDate = new Date(entry.timestamp);
        return entryDate >= cutoffDate;
      });
      
      logger.info('Old logs cleaned up from memory', {
        deletedCount: originalLength - this.memoryCache.length
      });
    } catch (error) {
      logger.error('Failed to cleanup old logs', { error: error.message });
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      initialized: this.initialized,
      memoryCacheSize: this.memoryCache.length,
      databaseEnabled: this.config.enableDatabaseLogging,
      redisEnabled: this.config.enableRedisLogging,
      logRetentionDays: this.config.logRetentionDays
    };
  }

  /**
   * 停止
   */
  async stop() {
    if (this.dbPool) {
      await this.dbPool.end();
    }
    
    if (this.redis) {
      await this.redis.quit();
    }
    
    logger.info('ArbitrationDecisionLogger stopped');
  }
}

module.exports = ArbitrationDecisionLogger;