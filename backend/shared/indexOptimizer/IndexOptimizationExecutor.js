// backend/shared/indexOptimizer/IndexOptimizationExecutor.js
'use strict';

const { createLogger } = require('../logger');

const logger = createLogger('index-optimization-executor');

/**
 * 索引优化执行器
 * 负责安全执行索引优化操作
 */
class IndexOptimizationExecutor {
  constructor(pool, config = {}) {
    this.pool = pool;
    this.config = {
      maxConcurrentOperations: config.maxConcurrentOperations || 1,
      executionWindow: config.executionWindow || { start: 2, end: 6 }, // 2:00-6:00 AM
      dryRun: config.dryRun !== false,
      notificationWebhook: config.notificationWebhook,
      maxTimeout: config.maxTimeout || 3600000, // 1小时超时
      checkLoadBeforeExecute: config.checkLoadBeforeExecute !== false
    };
    this.executionLog = [];
    this.isExecuting = false;
  }

  /**
   * 执行索引优化操作
   */
  async executeOptimization(recommendation) {
    // 检查执行窗口
    if (!this.isInExecutionWindow()) {
      return {
        success: false,
        reason: '当前不在执行窗口内（默认凌晨 2-6 点）',
        recommendation,
        dryRun: this.config.dryRun
      };
    }

    // 检查是否已有执行进行中
    if (this.isExecuting && !this.config.dryRun) {
      return {
        success: false,
        reason: '已有优化操作正在执行',
        recommendation,
        dryRun: this.config.dryRun
      };
    }

    // 检查数据库负载
    if (this.config.checkLoadBeforeExecute) {
      const loadCheck = await this.checkDatabaseLoad();
      if (!loadCheck.safe) {
        return {
          success: false,
          reason: `数据库负载过高: ${loadCheck.reason}`,
          recommendation,
          loadCheck,
          dryRun: this.config.dryRun
        };
      }
    }

    const logEntry = {
      id: `opt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      recommendation,
      status: 'STARTED',
      sql: recommendation.sql,
      dryRun: this.config.dryRun
    };

    this.executionLog.push(logEntry);

    try {
      this.isExecuting = true;

      if (this.config.dryRun) {
        // 模拟执行
        logEntry.status = 'DRY_RUN';
        logEntry.result = '模拟执行成功（dry-run 模式）';
        logEntry.duration = 0;
        
        logger.info({
          id: logEntry.id,
          operation: recommendation.type,
          sql: recommendation.sql
        }, 'Dry-run 模式：模拟执行索引优化');
        
        return {
          success: true,
          dryRun: true,
          log: logEntry
        };
      } else {
        // 实际执行
        await this.pool.query(`SET statement_timeout = ${this.config.maxTimeout}`);
        
        const startTime = Date.now();
        const result = await this.pool.query(recommendation.sql);
        const endTime = Date.now();
        
        logEntry.status = 'COMPLETED';
        logEntry.result = result;
        logEntry.duration = endTime - startTime;
        
        logger.info({
          id: logEntry.id,
          operation: recommendation.type,
          duration: logEntry.duration,
          sql: recommendation.sql
        }, '索引优化操作执行完成');
        
        await this.notifyExecution(logEntry);
        
        return {
          success: true,
          log: logEntry
        };
      }
    } catch (error) {
      logEntry.status = 'FAILED';
      logEntry.error = error.message;
      logEntry.errorCode = error.code;
      
      logger.error({
        id: logEntry.id,
        error: error.message,
        sql: recommendation.sql
      }, '索引优化操作执行失败');
      
      await this.notifyExecution(logEntry);
      
      return {
        success: false,
        error: error.message,
        log: logEntry
      };
    } finally {
      this.isExecuting = false;
      
      // 重置超时设置
      try {
        await this.pool.query('SET statement_timeout = 30000');
      } catch (e) {
        // 忽略重置失败
      }
    }
  }

  /**
   * 执行多个优化操作（批量）
   */
  async executeBatch(recommendations) {
    const results = [];
    
    for (const rec of recommendations) {
      // 如果前一个操作失败，暂停后续执行
      if (results.some(r => !r.success && !r.dryRun)) {
        logger.warn('前一个优化操作失败，暂停批量执行');
        break;
      }
      
      const result = await this.executeOptimization(rec);
      results.push(result);
      
      // 操作间隔
      if (this.config.dryRun) {
        await new Promise(resolve => setTimeout(resolve, 100));
      } else {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 实际执行间隔2秒
      }
    }
    
    return {
      total: recommendations.length,
      executed: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    };
  }

  /**
   * 检查是否在执行窗口内
   */
  isInExecutionWindow() {
    if (this.config.dryRun) {
      return true; // Dry-run 模式不检查时间窗口
    }
    
    const now = new Date();
    const hour = now.getHours();
    const { start, end } = this.config.executionWindow;
    
    // 支持跨午夜窗口（如 22:00 - 06:00）
    if (start < end) {
      return hour >= start && hour < end;
    } else {
      return hour >= start || hour < end;
    }
  }

  /**
   * 检查数据库负载
   */
  async checkDatabaseLoad() {
    try {
      const result = await this.pool.query(`
        SELECT
          (SELECT count(*) FROM pg_stat_activity) as total_connections,
          (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') as active_queries,
          (SELECT avg(extract(epoch from now() - query_start))::float
           FROM pg_stat_activity 
           WHERE state = 'active' AND query_start < now() - interval '10 seconds') as avg_query_age,
          (SELECT max(extract(epoch from now() - query_start))::float
           FROM pg_stat_activity 
           WHERE state = 'active' AND query_start < now() - interval '5 minutes') as max_query_age
      `);
      
      const stats = result.rows[0];
      
      // 活跃连接数检查
      if (parseInt(stats.total_connections) > 50) {
        return { 
          safe: false, 
          reason: `活跃连接数过高: ${stats.total_connections} (> 50)`,
          stats
        };
      }
      
      // 活跃查询数检查
      if (parseInt(stats.active_queries) > 20) {
        return { 
          safe: false, 
          reason: `活跃查询数过高: ${stats.active_queries} (> 20)`,
          stats
        };
      }
      
      // 查询平均时长检查
      if (parseFloat(stats.avg_query_age) > 30) {
        return { 
          safe: false, 
          reason: `查询平均时长过长: ${stats.avg_query_age?.toFixed(1)}s (> 30s)`,
          stats
        };
      }
      
      // 长时间运行查询检查
      if (parseFloat(stats.max_query_age) > 300) {
        return { 
          safe: false, 
          reason: `存在长时间运行查询: ${stats.max_query_age?.toFixed(0)}s (> 300s)`,
          stats
        };
      }
      
      return { safe: true, stats };
      
    } catch (error) {
      logger.error({ error: error.message }, '检查数据库负载失败');
      return { safe: false, reason: `负载检查失败: ${error.message}` };
    }
  }

  /**
   * 发送执行通知
   */
  async notifyExecution(logEntry) {
    if (!this.config.notificationWebhook) {
      return;
    }
    
    try {
      const axios = require('axios');
      
      const color = logEntry.status === 'COMPLETED' ? 'good' :
                    logEntry.status === 'DRY_RUN' ? '#888888' :
                    logEntry.status === 'FAILED' ? 'danger' : 'warning';
      
      const text = logEntry.status === 'COMPLETED' ?
        `✅ 索引优化执行成功` :
        logEntry.status === 'DRY_RUN' ?
        `🔍 索引优化 Dry-run` :
        `❌ 索引优化执行失败`;
      
      await axios.post(this.config.notificationWebhook, {
        text,
        attachments: [{
          color,
          fields: [
            { title: '操作类型', value: logEntry.recommendation.type, short: true },
            { title: '索引名称', value: logEntry.recommendation.indexName, short: true },
            { title: '表名', value: logEntry.recommendation.tableName, short: true },
            { title: '状态', value: logEntry.status, short: true },
            { title: '执行 SQL', value: `\`\`\`${logEntry.sql}\`\`\``, short: false },
            ...(logEntry.duration ? [{ title: '耗时', value: `${logEntry.duration}ms`, short: true }] : []),
            ...(logEntry.error ? [{ title: '错误信息', value: logEntry.error, short: false }] : [])
          ],
          ts: Math.floor(Date.now() / 1000)
        }]
      }, {
        timeout: 5000
      });
      
    } catch (error) {
      logger.error({ error: error.message }, '发送通知失败');
    }
  }

  /**
   * 获取执行日志
   */
  getExecutionLog(limit = 100) {
    return this.executionLog.slice(-limit);
  }

  /**
   * 清空执行日志
   */
  clearLog() {
    this.executionLog = [];
    logger.info('执行日志已清空');
  }

  /**
   * 获取执行统计
   */
  getExecutionStats() {
    const completed = this.executionLog.filter(l => l.status === 'COMPLETED').length;
    const failed = this.executionLog.filter(l => l.status === 'FAILED').length;
    const dryRun = this.executionLog.filter(l => l.status === 'DRY_RUN').length;
    
    return {
      total: this.executionLog.length,
      completed,
      failed,
      dryRun,
      successRate: this.executionLog.length > 0 ?
        (completed / (completed + failed) * 100).toFixed(1) : 0
    };
  }
}

module.exports = { IndexOptimizationExecutor };