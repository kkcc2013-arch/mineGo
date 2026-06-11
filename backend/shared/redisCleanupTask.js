/**
 * Redis 清理任务
 * REQ-00070: Redis 内存优化与自动 TTL 策略
 * 
 * 功能：
 * - 清理长时间未访问的无 TTL Key
 * - 触发内存碎片整理
 * - 定期执行内存分析
 * - 更新 Prometheus 指标
 */

const { createLogger } = require('./logger');
const { incrementCounter, gauge } = require('./metrics');
const { getRedisMemoryAnalyzer } = require('./redisMemoryAnalyzer');
const Redis = require('ioredis');

const logger = createLogger('redis-cleanup-task');

/**
 * Redis 清理任务
 */
class RedisCleanupTask {
  /**
   * @param {Object} config - 配置选项
   * @param {string} config.redisUrl - Redis 连接 URL
   * @param {number} config.idleThresholdDays - 未访问阈值（天）
   * @param {number} config.scanBatchSize - SCAN 批量大小
   * @param {boolean} config.enableDefrag - 是否启用内存碎片整理
   */
  constructor(config = {}) {
    this.redisUrl = config.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
    this.idleThresholdDays = config.idleThresholdDays || 7;
    this.scanBatchSize = config.scanBatchSize || 1000;
    this.enableDefrag = config.enableDefrag !== false;
    
    this.redis = null;
    this.analyzer = null;
    this.isRunning = false;
    
    // 统计数据
    this.stats = {
      lastRun: null,
      totalRuns: 0,
      cleanedKeys: 0,
      freedMemory: 0,
      errors: 0
    };
  }

  /**
   * 初始化清理任务
   */
  async init() {
    if (this.redis) {
      return;
    }
    
    try {
      this.redis = new Redis(this.redisUrl, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true
      });
      
      await this.redis.ping();
      
      this.analyzer = getRedisMemoryAnalyzer({ redisUrl: this.redisUrl });
      await this.analyzer.init();
      
      logger.info('RedisCleanupTask initialized');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize RedisCleanupTask');
      throw err;
    }
  }

  /**
   * 执行清理任务
   * @returns {Promise<Object>} 清理结果
   */
  async run() {
    if (this.isRunning) {
      logger.warn('Cleanup task is already running');
      return null;
    }
    
    this.isRunning = true;
    const startTime = Date.now();
    
    try {
      await this.init();
      
      logger.info('Starting Redis cleanup task');
      
      // 1. 清理长时间未访问的无 TTL Key
      const cleanResult = await this.cleanStaleKeys();
      
      // 2. 触发内存碎片整理
      const defragResult = await this.defragment();
      
      // 3. 执行内存分析
      const analysis = await this.analyzer.analyze();
      
      const duration = Date.now() - startTime;
      
      // 更新统计
      this.stats.lastRun = new Date().toISOString();
      this.stats.totalRuns++;
      this.stats.cleanedKeys += cleanResult.cleanedCount;
      this.stats.freedMemory += cleanResult.freedMemory;
      
      const result = {
        success: true,
        duration,
        cleanedKeys: cleanResult.cleanedCount,
        freedMemory: cleanResult.freedMemory,
        defragEnabled: defragResult.enabled,
        memoryBefore: analysis.memory,
        recommendations: analysis.recommendations
      };
      
      logger.info({
        duration,
        cleanedKeys: cleanResult.cleanedCount,
        freedMemory: cleanResult.freedMemory
      }, 'Redis cleanup task completed');
      
      // 更新 Prometheus 指标
      this.updateMetrics(result);
      
      return result;
    } catch (err) {
      this.stats.errors++;
      
      logger.error({ err }, 'Redis cleanup task failed');
      
      incrementCounter('redis_cleanup_errors_total');
      
      throw err;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 清理长时间未访问的无 TTL Key
   * @returns {Promise<Object>} 清理结果
   */
  async cleanStaleKeys() {
    const idleThresholdSeconds = this.idleThresholdDays * 24 * 60 * 60;
    let cursor = '0';
    let cleanedCount = 0;
    let freedMemory = 0;
    
    logger.info({
      idleThresholdDays: this.idleThresholdDays,
      idleThresholdSeconds
    }, 'Starting stale key cleanup');
    
    do {
      const result = await this.redis.scan(cursor, 'COUNT', this.scanBatchSize);
      cursor = result[0];
      const keys = result[1];
      
      if (keys.length === 0) continue;
      
      // 批量获取 TTL 和空闲时间
      for (const key of keys) {
        try {
          const ttl = await this.redis.ttl(key);
          
          // 只处理无 TTL 的 Key
          if (ttl === -1) {
            const idleTime = await this.redis.object('idletime', key);
            
            // 如果超过阈值，删除该 Key
            if (idleTime && idleTime > idleThresholdSeconds) {
              // 先获取内存占用
              const usage = await this.redis.memory('USAGE', key);
              
              await this.redis.del(key);
              
              cleanedCount++;
              freedMemory += usage || 0;
              
              logger.debug({
                key,
                idleTime,
                idleDays: (idleTime / 86400).toFixed(2),
                freedMemory: usage
              }, 'Deleted stale key without TTL');
            }
          }
        } catch (err) {
          // 某些 Key 可能不支持 OBJECT IDLETIME，忽略错误
          logger.debug({ err, key }, 'Failed to check key idle time');
        }
        
        // 控制清理速度，避免影响 Redis 性能
        if (cleanedCount % 100 === 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      
      // 避免长时间占用 Redis
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (cursor !== '0');
    
    logger.info({
      cleanedCount,
      freedMemory,
      freedMemoryHuman: this.formatBytes(freedMemory)
    }, 'Stale key cleanup completed');
    
    incrementCounter('redis_keys_cleaned_total', cleanedCount);
    
    return {
      cleanedCount,
      freedMemory
    };
  }

  /**
   * 触发内存碎片整理
   * @returns {Promise<Object>} 整理结果
   */
  async defragment() {
    if (!this.enableDefrag) {
      return { enabled: false };
    }
    
    try {
      // Redis 4.0+ 支持 MEMORY PURGE 命令
      await this.redis.call('MEMORY', 'PURGE');
      
      logger.info('Memory defragmentation triggered');
      
      incrementCounter('redis_defrag_total');
      
      return { enabled: true, success: true };
    } catch (err) {
      logger.warn({ err }, 'Memory defragmentation failed or not supported');
      
      return { enabled: true, success: false, error: err.message };
    }
  }

  /**
   * 更新 Prometheus 指标
   * @param {Object} result - 清理结果
   */
  updateMetrics(result) {
    try {
      gauge('redis_cleanup_last_run_timestamp', Date.now() / 1000);
      gauge('redis_cleanup_keys_total', this.stats.cleanedKeys);
      gauge('redis_cleanup_memory_freed_bytes', this.stats.freedMemory);
      incrementCounter('redis_cleanup_runs_total');
    } catch (err) {
      logger.error({ err }, 'Failed to update cleanup metrics');
    }
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * 格式化字节数
   * @param {number} bytes - 字节数
   * @returns {string} 格式化字符串
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0B';
    
    const units = ['B', 'KB', 'MB', 'GB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return `${(bytes / Math.pow(k, i)).toFixed(2)}${units[i]}`;
  }

  /**
   * 关闭连接
   */
  async close() {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
    
    if (this.analyzer) {
      await this.analyzer.close();
    }
    
    logger.info('RedisCleanupTask closed');
  }
}

// 单例实例
let cleanupInstance = null;

/**
 * 获取清理任务单例实例
 * @param {Object} config - 配置选项
 * @returns {RedisCleanupTask} 清理任务实例
 */
function getRedisCleanupTask(config = {}) {
  if (!cleanupInstance) {
    cleanupInstance = new RedisCleanupTask(config);
  }
  return cleanupInstance;
}

/**
 * 启动定时清理任务
 * @param {Object} config - 配置选项
 * @param {string} config.schedule - Cron 表达式（默认每天凌晨 2 点）
 * @returns {RedisCleanupTask} 清理任务实例
 */
function scheduleCleanup(config = {}) {
  const cron = require('node-cron');
  const schedule = config.schedule || '0 2 * * *'; // 每天凌晨 2 点
  
  const cleanupTask = getRedisCleanupTask(config);
  
  const task = cron.schedule(schedule, async () => {
    try {
      logger.info('Starting scheduled Redis cleanup');
      await cleanupTask.run();
    } catch (err) {
      logger.error({ err }, 'Scheduled Redis cleanup failed');
    }
  });
  
  logger.info({ schedule }, 'Scheduled Redis cleanup task');
  
  cleanupTask.cronTask = task;
  
  return cleanupTask;
}

module.exports = {
  RedisCleanupTask,
  getRedisCleanupTask,
  scheduleCleanup
};
