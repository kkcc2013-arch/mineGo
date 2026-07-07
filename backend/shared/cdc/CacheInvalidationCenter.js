/**
 * 缓存失效中心 - 整合 CDC 监听、映射和重试队列
 * 
 * REQ-00479: 数据库查询结果缓存自动失效策略系统
 * 
 * 特性：
 * - 接收 CDC 变更事件
 * - 自动映射到缓存键
 * - 执行失效并处理失败重试
 * - 提供性能监控和统计
 */

const { createLogger } = require('../logger');
const cache = require('../cache');
const PgCDCListener = require('./PgCDCListener');
const ChangeToCacheMapper = require('./ChangeToCacheMapper');
const InvalidationRetryQueue = require('./InvalidationRetryQueue');

const logger = createLogger('cache-invalidation-center');

class CacheInvalidationCenter {
  constructor(config = {}) {
    this.config = {
      // CDC 监听配置
      cdc: config.cdc || {},
      
      // 映射规则
      mappingRules: config.mappingRules || {},
      
      // 重试队列配置
      retryQueue: config.retryQueue || {},
      
      // 失效超时
      invalidationTimeout: config.invalidationTimeout || 1000,
      
      // 批量失效大小
      batchSize: config.batchSize || 50,
      
      // 是否启用
      enabled: config.enabled !== false
    };
    
    // 初始化组件
    this.cdcListener = new PgCDCListener(this.config.cdc);
    this.mapper = new ChangeToCacheMapper(this.config.mappingRules);
    this.retryQueue = new InvalidationRetryQueue(this.config.retryQueue);
    
    // 统计数据
    this.stats = {
      eventsReceived: 0,
      invalidationsSucceeded: 0,
      invalidationsFailed: 0,
      patternsInvalidated: 0,
      avgLatency: 0,
      maxLatency: 0
    };
    
    // 延迟记录
    this.latencyRecords = [];
  }
  
  /**
   * 启动缓存失效中心
   */
  async start() {
    if (!this.config.enabled) {
      logger.info('Cache invalidation center disabled');
      return;
    }
    
    try {
      // 初始化重试队列
      await this.retryQueue.init();
      
      // 设置 CDC 事件监听
      this.cdcListener.on('change', async (changeEvent) => {
        await this.handleChangeEvent(changeEvent);
      });
      
      this.cdcListener.on('error', (error) => {
        logger.error({ error }, 'CDC listener error');
      });
      
      // 启动 CDC 监听
      await this.cdcListener.start();
      
      logger.info('Cache invalidation center started');
      
    } catch (error) {
      logger.error({ error }, 'Failed to start cache invalidation center');
      throw error;
    }
  }
  
  /**
   * 处理变更事件
   */
  async handleChangeEvent(changeEvent) {
    const startTime = Date.now();
    
    this.stats.eventsReceived++;
    
    try {
      // 映射变更到缓存键模式
      const patterns = this.mapper.map(changeEvent);
      
      if (patterns.length === 0) {
        logger.debug({ 
          table: changeEvent.table, 
          operation: changeEvent.operation 
        }, 'No cache patterns for change event');
        return;
      }
      
      logger.info({ 
        table: changeEvent.table,
        operation: changeEvent.operation,
        patterns: patterns.length,
        timestamp: changeEvent.timestamp
      }, 'Processing change event');
      
      // 执行批量失效
      const results = await this.batchInvalidate(patterns, changeEvent);
      
      // 记录延迟
      const latency = Date.now() - startTime;
      this.recordLatency(latency);
      
      // 检查是否在 100ms 内完成
      if (latency > 100) {
        logger.warn({ 
          latency, 
          patterns: patterns.length,
          table: changeEvent.table 
        }, 'Invalidation latency exceeded 100ms');
      }
      
      logger.debug({ 
        latency, 
        succeeded: results.succeeded,
        failed: results.failed 
      }, 'Change event processed');
      
    } catch (error) {
      logger.error({ 
        error, 
        table: changeEvent.table,
        operation: changeEvent.operation 
      }, 'Failed to handle change event');
      
      this.stats.invalidationsFailed++;
    }
  }
  
  /**
   * 批量失效缓存
   */
  async batchInvalidate(patterns, changeEvent) {
    const results = {
      succeeded: 0,
      failed: 0,
      retries: 0
    };
    
    // 分批处理，避免一次性处理太多模式
    const batches = this.chunkArray(patterns, this.config.batchSize);
    
    for (const batch of batches) {
      const batchResults = await Promise.allSettled(
        batch.map(pattern => this.invalidatePattern(pattern))
      );
      
      for (let i = 0; i < batchResults.length; i++) {
        const result = batchResults[i];
        const pattern = batch[i];
        
        if (result.status === 'fulfilled') {
          results.succeeded++;
          this.stats.patternsInvalidated++;
          
        } else {
          results.failed++;
          this.stats.invalidationsFailed++;
          
          // 入队重试
          try {
            await this.retryQueue.enqueue(pattern, 'invalidation_failed', {
              table: changeEvent.table,
              operation: changeEvent.operation,
              error: result.reason?.message
            });
            results.retries++;
            
          } catch (enqueueError) {
            logger.error({ 
              enqueueError, 
              pattern 
            }, 'Failed to enqueue retry');
          }
        }
      }
    }
    
    this.stats.invalidationsSucceeded += results.succeeded;
    
    return results;
  }
  
  /**
   * 失效单个缓存模式
   */
  async invalidatePattern(pattern) {
    try {
      await cache.delPattern(pattern);
      
      logger.debug({ pattern }, 'Cache pattern invalidated');
      
    } catch (error) {
      logger.error({ error, pattern }, 'Pattern invalidation failed');
      throw error;
    }
  }
  
  /**
   * 手动触发失效
   */
  async manualInvalidate(table, operation, data) {
    const changeEvent = {
      table,
      operation,
      data,
      timestamp: Date.now()
    };
    
    await this.handleChangeEvent(changeEvent);
  }
  
  /**
   * 手动失效指定模式
   */
  async invalidateByPattern(pattern) {
    try {
      await cache.delPattern(pattern);
      this.stats.patternsInvalidated++;
      this.stats.invalidationsSucceeded++;
      
      logger.info({ pattern }, 'Manual pattern invalidation completed');
      
    } catch (error) {
      this.stats.invalidationsFailed++;
      
      // 入队重试
      await this.retryQueue.enqueue(pattern, 'manual_failed');
      
      throw error;
    }
  }
  
  /**
   * 记录延迟
   */
  recordLatency(latency) {
    this.latencyRecords.push(latency);
    
    // 保持最近 1000 条记录
    if (this.latencyRecords.length > 1000) {
      this.latencyRecords.shift();
    }
    
    // 更新统计
    this.stats.avgLatency = this.calculateAverage(this.latencyRecords);
    this.stats.maxLatency = Math.max(this.stats.maxLatency, latency);
  }
  
  /**
   * 计算平均值
   */
  calculateAverage(arr) {
    if (arr.length === 0) return 0;
    return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  }
  
  /**
   * 分块数组
   */
  chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
  
  /**
   * 获取统计信息
   */
  async getStats() {
    const cdcStats = this.cdcListener.getStats();
    const queueStats = await this.retryQueue.getStats();
    
    return {
      center: {
        ...this.stats,
        enabled: this.config.enabled
      },
      cdc: cdcStats,
      queue: queueStats
    };
  }
  
  /**
   * 健康检查
   */
  async healthCheck() {
    const status = {
      status: 'ok',
      components: {}
    };
    
    // 检查 CDC
    status.components.cdc = this.cdcListener.isListening ? 'healthy' : 'unhealthy';
    
    // 检查重试队列
    try {
      await this.retryQueue.redis.ping();
      status.components.queue = 'healthy';
    } catch {
      status.components.queue = 'unhealthy';
    }
    
    // 检查缓存连接
    try {
      await cache.get('health:check');
      status.components.cache = 'healthy';
    } catch {
      status.components.cache = 'unhealthy';
    }
    
    // 整体状态
    const unhealthyCount = Object.values(status.components)
      .filter(s => s === 'unhealthy').length;
    
    if (unhealthyCount > 0) {
      status.status = unhealthyCount === Object.keys(status.components).length 
        ? 'critical' 
        : 'degraded';
    }
    
    return status;
  }
  
  /**
   * 停止服务
   */
  async stop() {
    try {
      await this.cdcListener.stop();
      await this.retryQueue.close();
      
      logger.info('Cache invalidation center stopped');
      
    } catch (error) {
      logger.error({ error }, 'Error stopping cache invalidation center');
    }
  }
}

module.exports = CacheInvalidationCenter;