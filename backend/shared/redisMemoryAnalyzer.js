/**
 * Redis 内存分析器
 * REQ-00070: Redis 内存优化与自动 TTL 策略
 * 
 * 功能：
 * - 分析 Redis 内存使用情况
 * - 识别无 TTL 的 Key
 * - 分析热点 Key（内存占用最高的 Key）
 * - 统计 Key 类型分布
 * - 生成内存使用报告
 */

const Redis = require('ioredis');
const { createLogger } = require('./logger');
const { incrementCounter, gauge, observeHistogram } = require('./metrics');

const logger = createLogger('redis-memory-analyzer');

/**
 * Redis 内存分析器
 */
class RedisMemoryAnalyzer {
  /**
   * @param {Object} config - 配置选项
   * @param {string} config.redisUrl - Redis 连接 URL
   * @param {number} config.scanBatchSize - SCAN 批量大小
   * @param {number} config.topNCount - Top N Key 数量
   */
  constructor(config = {}) {
    this.redisUrl = config.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
    this.scanBatchSize = config.scanBatchSize || 1000;
    this.topNCount = config.topNCount || 20;
    
    this.redis = null;
    this.isInitialized = false;
  }

  /**
   * 初始化分析器
   */
  async init() {
    if (this.isInitialized) {
      return;
    }
    
    try {
      this.redis = new Redis(this.redisUrl, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true
      });
      
      await this.redis.ping();
      
      this.isInitialized = true;
      logger.info('RedisMemoryAnalyzer initialized');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize RedisMemoryAnalyzer');
      throw err;
    }
  }

  /**
   * 确保已初始化
   */
  async ensureInit() {
    if (!this.isInitialized) {
      await this.init();
    }
  }

  /**
   * 分析 Redis 内存使用
   * @returns {Promise<Object>} 内存分析报告
   */
  async analyze() {
    await this.ensureInit();
    
    const startTime = Date.now();
    
    try {
      // 1. 获取内存信息
      const memoryInfo = await this.getMemoryInfo();
      
      // 2. 分析 Key 类型分布
      const keyTypeDistribution = await this.getKeyTypeDistribution();
      
      // 3. 统计无 TTL 的 Key
      const keysWithoutTTL = await this.countKeysWithoutTTL();
      
      // 4. 获取 Top N 内存占用 Key
      const topKeys = await this.getTopKeys(this.topNCount);
      
      // 5. 统计 TTL 分布
      const ttlDistribution = await this.getTTLDistribution();
      
      const duration = Date.now() - startTime;
      
      const report = {
        timestamp: new Date().toISOString(),
        duration,
        memory: memoryInfo,
        keys: {
          total: keyTypeDistribution.total,
          withoutTTL: keysWithoutTTL,
          typeDistribution: keyTypeDistribution.types
        },
        topKeys,
        ttlDistribution,
        recommendations: this.generateRecommendations(memoryInfo, keysWithoutTTL)
      };
      
      logger.info({
        duration,
        usagePercent: memoryInfo.usagePercent,
        keysWithoutTTL
      }, 'Redis memory analysis completed');
      
      // 更新 Prometheus 指标
      this.updateMetrics(report);
      
      return report;
    } catch (err) {
      logger.error({ err }, 'Redis memory analysis failed');
      throw err;
    }
  }

  /**
   * 获取内存信息
   * @returns {Promise<Object>} 内存信息
   */
  async getMemoryInfo() {
    const info = await this.redis.info('memory');
    const stats = this.parseMemoryInfo(info);
    
    return {
      usedMemory: stats.used_memory || 0,
      usedMemoryHuman: stats.used_memory_human || '0B',
      maxMemory: stats.maxmemory || 0,
      maxMemoryHuman: stats.maxmemory_human || '0B',
      usagePercent: stats.maxmemory > 0 
        ? ((stats.used_memory / stats.maxmemory) * 100).toFixed(2)
        : 0,
      fragmentationRatio: stats.mem_fragmentation_ratio || 1.0,
      peakMemory: stats.used_memory_peak || 0,
      peakMemoryHuman: stats.used_memory_peak_human || '0B'
    };
  }

  /**
   * 解析 Redis INFO memory 输出
   * @param {string} info - INFO 命令输出
   * @returns {Object} 解析后的统计信息
   */
  parseMemoryInfo(info) {
    const stats = {};
    const lines = info.split('\r\n');
    
    for (const line of lines) {
      if (line.includes(':')) {
        const [key, value] = line.split(':');
        stats[key] = isNaN(value) ? value : parseInt(value);
      }
    }
    
    return stats;
  }

  /**
   * 获取 Key 类型分布
   * @returns {Promise<Object>} 类型分布统计
   */
  async getKeyTypeDistribution() {
    let cursor = '0';
    const typeCount = {};
    let total = 0;
    
    do {
      const result = await this.redis.scan(cursor, 'COUNT', this.scanBatchSize);
      cursor = result[0];
      const keys = result[1];
      
      if (keys.length === 0) continue;
      
      // 批量获取 Key 类型
      const pipelines = keys.map(key => ['type', key]);
      const types = await this.redis.pipeline(pipelines).exec();
      
      for (const [err, type] of types) {
        if (!err) {
          typeCount[type] = (typeCount[type] || 0) + 1;
          total++;
        }
      }
      
      // 避免长时间占用 Redis
      if (total % 10000 === 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } while (cursor !== '0');
    
    return {
      total,
      types: typeCount
    };
  }

  /**
   * 统计无 TTL 的 Key 数量
   * @returns {Promise<number>} 无 TTL 的 Key 数量
   */
  async countKeysWithoutTTL() {
    let cursor = '0';
    let count = 0;
    
    do {
      const result = await this.redis.scan(cursor, 'COUNT', this.scanBatchSize);
      cursor = result[0];
      const keys = result[1];
      
      if (keys.length === 0) continue;
      
      // 批量获取 TTL
      const pipelines = keys.map(key => ['ttl', key]);
      const ttls = await this.redis.pipeline(pipelines).exec();
      
      for (const [err, ttl] of ttls) {
        if (!err && ttl === -1) { // -1 表示无 TTL
          count++;
        }
      }
      
      // 避免长时间占用 Redis
      if (count % 5000 === 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } while (cursor !== '0');
    
    return count;
  }

  /**
   * 获取内存占用最高的 Top N Key
   * @param {number} limit - Top N 数量
   * @returns {Promise<Array>} Top N Key 列表
   */
  async getTopKeys(limit = 20) {
    let cursor = '0';
    const keyMemory = [];
    
    do {
      const result = await this.redis.scan(cursor, 'COUNT', this.scanBatchSize);
      cursor = result[0];
      const keys = result[1];
      
      if (keys.length === 0) continue;
      
      // 批量获取 Key 内存占用（使用 MEMORY USAGE 命令）
      for (const key of keys) {
        try {
          const usage = await this.redis.memory('USAGE', key);
          if (usage && usage > 0) {
            keyMemory.push({ key, usage });
          }
        } catch (err) {
          // 某些 Key 可能不支持 MEMORY USAGE，忽略错误
        }
        
        // 控制采样速度
        if (keyMemory.length % 1000 === 0) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      
      // 如果已经收集足够多的样本，可以提前退出
      if (keyMemory.length >= limit * 10) {
        break;
      }
    } while (cursor !== '0');
    
    // 排序并返回 Top N
    keyMemory.sort((a, b) => b.usage - a.usage);
    
    return keyMemory.slice(0, limit).map(item => ({
      key: item.key,
      memoryBytes: item.usage,
      memoryHuman: this.formatBytes(item.usage)
    }));
  }

  /**
   * 统计 TTL 分布
   * @returns {Promise<Object>} TTL 分布统计
   */
  async getTTLDistribution() {
    const { getTTLBucket } = require('./cacheTTLConfig');
    
    let cursor = '0';
    const distribution = {};
    
    do {
      const result = await this.redis.scan(cursor, 'COUNT', this.scanBatchSize);
      cursor = result[0];
      const keys = result[1];
      
      if (keys.length === 0) continue;
      
      // 批量获取 TTL
      const pipelines = keys.map(key => ['ttl', key]);
      const ttls = await this.redis.pipeline(pipelines).exec();
      
      for (const [err, ttl] of ttls) {
        if (!err) {
          const bucket = getTTLBucket(ttl);
          distribution[bucket] = (distribution[bucket] || 0) + 1;
        }
      }
      
      // 避免长时间占用 Redis
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (cursor !== '0');
    
    return distribution;
  }

  /**
   * 生成优化建议
   * @param {Object} memoryInfo - 内存信息
   * @param {number} keysWithoutTTL - 无 TTL 的 Key 数量
   * @returns {Array} 优化建议列表
   */
  generateRecommendations(memoryInfo, keysWithoutTTL) {
    const recommendations = [];
    
    // 1. 内存使用率建议
    const usagePercent = parseFloat(memoryInfo.usagePercent);
    if (usagePercent > 80) {
      recommendations.push({
        severity: 'critical',
        category: 'memory',
        message: `内存使用率 ${usagePercent}% 过高，建议清理数据或扩容`,
        action: '清理无 TTL 的 Key 或增加 Redis 内存'
      });
    } else if (usagePercent > 60) {
      recommendations.push({
        severity: 'warning',
        category: 'memory',
        message: `内存使用率 ${usagePercent}%，建议关注`,
        action: '监控内存增长趋势'
      });
    }
    
    // 2. 无 TTL Key 建议
    if (keysWithoutTTL > 1000) {
      recommendations.push({
        severity: 'warning',
        category: 'ttl',
        message: `${keysWithoutTTL} 个 Key 未设置 TTL，可能导致内存泄漏`,
        action: '使用 redisCleanupTask 清理长时间未访问的 Key'
      });
    }
    
    // 3. 内存碎片建议
    if (memoryInfo.fragmentationRatio > 1.5) {
      recommendations.push({
        severity: 'warning',
        category: 'fragmentation',
        message: `内存碎片率 ${memoryInfo.fragmentationRatio.toFixed(2)} 过高`,
        action: '执行 MEMORY PURGE 或重启 Redis'
      });
    }
    
    return recommendations;
  }

  /**
   * 更新 Prometheus 指标
   * @param {Object} report - 分析报告
   */
  updateMetrics(report) {
    try {
      gauge('redis_memory_used_bytes', report.memory.usedMemory);
      gauge('redis_memory_max_bytes', report.memory.maxMemory);
      gauge('redis_memory_usage_percent', parseFloat(report.memory.usagePercent));
      gauge('redis_memory_fragmentation_ratio', report.memory.fragmentationRatio);
      
      gauge('redis_key_count_total', report.keys.total);
      gauge('redis_keys_without_ttl', report.keys.withoutTTL);
      
      // Key 类型分布
      for (const [type, count] of Object.entries(report.keys.typeDistribution)) {
        gauge('redis_key_count_by_type', count, { type });
      }
      
      // TTL 分布
      for (const [bucket, count] of Object.entries(report.ttlDistribution)) {
        gauge('redis_keys_ttl_bucket', count, { bucket });
      }
    } catch (err) {
      logger.error({ err }, 'Failed to update Redis memory metrics');
    }
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
      this.isInitialized = false;
      
      logger.info('RedisMemoryAnalyzer closed');
    }
  }
}

// 单例实例
let analyzerInstance = null;

/**
 * 获取分析器单例实例
 * @param {Object} config - 配置选项
 * @returns {RedisMemoryAnalyzer} 分析器实例
 */
function getRedisMemoryAnalyzer(config = {}) {
  if (!analyzerInstance) {
    analyzerInstance = new RedisMemoryAnalyzer(config);
  }
  return analyzerInstance;
}

module.exports = {
  RedisMemoryAnalyzer,
  getRedisMemoryAnalyzer
};
