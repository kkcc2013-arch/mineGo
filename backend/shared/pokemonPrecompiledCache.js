/**
 * REQ-00481: 精灵数据预编译缓存系统
 * 预编译缓存管理器 - 多级缓存架构（L1 内存 + L2 Redis）
 */

'use strict';

const Redis = require('ioredis');
const { createLogger } = require('./logger');
const { query } = require('./db');
const LRUCache = require('./LRUCache');
const pokemonDataCompiler = require('./pokemonDataCompiler');
const metrics = require('./metrics');

const logger = createLogger('PokemonPrecompiledCache');

/**
 * 精灵预编译缓存管理器
 */
class PokemonPrecompiledCache {
  constructor(config = {}) {
    // L1 内存缓存
    this.l1Cache = new LRUCache({
      maxSize: config.l1MaxSize || 5000,
      defaultTTL: config.l1TTL || 300000, // 5 分钟
      maxMemoryMB: config.l1MaxMemoryMB || 100
    });
    
    // L2 Redis 缓存
    this.redis = config.redis || new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    this.l2TTL = config.l2TTL || 3600; // 1 小时
    this.cachePrefix = 'pokemon:precompiled:';
    
    // 版本管理
    this.currentVersion = null;
    
    // 统计
    this.stats = {
      l1Hits: 0,
      l2Hits: 0,
      misses: 0,
      updates: 0
    };
    
    // 初始化标志
    this.initialized = false;
  }

  /**
   * 初始化缓存
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      // 初始化编译器
      await pokemonDataCompiler.initialize();
      
      // 获取当前版本
      const versionKey = `${this.cachePrefix}version`;
      this.currentVersion = await this.redis.get(versionKey);
      
      if (!this.currentVersion) {
        this.currentVersion = Date.now().toString();
        await this.redis.set(versionKey, this.currentVersion);
      }
      
      // 预热热点数据
      await this.warmup();
      
      this.initialized = true;
      logger.info('PokemonPrecompiledCache initialized', { version: this.currentVersion });
    } catch (err) {
      logger.error('Failed to initialize cache', { err: err.message });
      throw err;
    }
  }

  /**
   * 获取精灵数据（多级缓存）
   * @param {number} pokemonId - 精灵 ID
   * @returns {Object} 精灵数据
   */
  async get(pokemonId) {
    const startTime = Date.now();
    const cacheKey = `${this.cachePrefix}${this.currentVersion}:${pokemonId}`;
    
    try {
      // L1: 内存缓存
      const l1Data = this.l1Cache.get(cacheKey);
      if (l1Data) {
        this.stats.l1Hits++;
        this.recordMetric('hit', 'l1', startTime);
        return l1Data;
      }
      
      // L2: Redis 缓存
      const l2Data = await this.redis.getBuffer(cacheKey);
      if (l2Data) {
        const decoded = pokemonDataCompiler.decodeData(l2Data);
        
        // 回填 L1
        this.l1Cache.set(cacheKey, decoded, this.l1Cache.defaultTTL);
        
        this.stats.l2Hits++;
        this.recordMetric('hit', 'l2', startTime);
        return decoded;
      }
      
      // L3: 数据库查询并编译
      const data = await this.fetchAndCompile(pokemonId);
      if (data) {
        // 存储到缓存
        await this.set(pokemonId, data);
        this.recordMetric('miss', null, startTime);
        return data;
      }
      
      this.stats.misses++;
      this.recordMetric('miss', null, startTime);
      return null;
    } catch (err) {
      logger.error('Failed to get pokemon', { pokemonId, err: err.message });
      return null;
    }
  }

  /**
   * 批量获取精灵数据
   * @param {Array} pokemonIds - 精灵 ID 列表
   * @returns {Object} 精灵数据映射
   */
  async getBatch(pokemonIds) {
    const result = {};
    const missedIds = [];
    
    // 先从 L1 获取
    for (const id of pokemonIds) {
      const cacheKey = `${this.cachePrefix}${this.currentVersion}:${id}`;
      const data = this.l1Cache.get(cacheKey);
      
      if (data) {
        result[id] = data;
        this.stats.l1Hits++;
      } else {
        missedIds.push(id);
      }
    }
    
    // 批量从 L2 获取
    if (missedIds.length > 0) {
      const pipeline = this.redis.pipeline();
      const keys = missedIds.map(id => `${this.cachePrefix}${this.currentVersion}:${id}`);
      
      keys.forEach(key => pipeline.getBuffer(key));
      
      const results = await pipeline.exec();
      
      for (let i = 0; i < results.length; i++) {
        const [err, buffer] = results[i];
        const id = missedIds[i];
        
        if (!err && buffer) {
          const decoded = pokemonDataCompiler.decodeData(buffer);
          result[id] = decoded;
          
          // 回填 L1
          const cacheKey = `${this.cachePrefix}${this.currentVersion}:${id}`;
          this.l1Cache.set(cacheKey, decoded, this.l1Cache.defaultTTL);
          
          this.stats.l2Hits++;
        }
      }
    }
    
    // 查询未命中的数据
    const stillMissed = pokemonIds.filter(id => !result[id]);
    
    if (stillMissed.length > 0) {
      const batchData = await this.fetchAndCompileBatch(stillMissed);
      
      for (const [id, data] of Object.entries(batchData)) {
        result[id] = data;
        await this.set(id, data);
      }
    }
    
    return result;
  }

  /**
   * 设置缓存数据
   * @param {number} pokemonId - 精灵 ID
   * @param {Object} data - 精灵数据
   */
  async set(pokemonId, data) {
    const cacheKey = `${this.cachePrefix}${this.currentVersion}:${pokemonId}`;
    
    try {
      // 编译数据
      const compiled = pokemonDataCompiler.compileSpeciesData(data);
      
      // 存储 L2
      await this.redis.setex(cacheKey, this.l2TTL, compiled);
      
      // 存储 L1
      this.l1Cache.set(cacheKey, data, this.l1Cache.defaultTTL);
      
      this.stats.updates++;
      logger.debug('Pokemon cached', { pokemonId });
    } catch (err) {
      logger.error('Failed to set cache', { pokemonId, err: err.message });
    }
  }

  /**
   * 从数据库获取并编译数据
   * @param {number} pokemonId - 精灵 ID
   * @returns {Object} 编译后的数据
   */
  async fetchAndCompile(pokemonId) {
    try {
      const { rows } = await query(`
        SELECT * FROM pokemon_species WHERE id = $1
      `, [pokemonId]);
      
      if (rows.length === 0) return null;
      
      const species = rows[0];
      const compiled = pokemonDataCompiler.compileSpeciesData(species);
      
      return compiled;
    } catch (err) {
      logger.error('Failed to fetch and compile', { pokemonId, err: err.message });
      return null;
    }
  }

  /**
   * 批量获取并编译数据
   * @param {Array} pokemonIds - 精灵 ID 列表
   * @returns {Object} 编译数据映射
   */
  async fetchAndCompileBatch(pokemonIds) {
    try {
      const placeholders = pokemonIds.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await query(`
        SELECT * FROM pokemon_species WHERE id IN (${placeholders})
      `, pokemonIds);
      
      const result = {};
      
      for (const species of rows) {
        const compiled = pokemonDataCompiler.compileSpeciesData(species);
        result[species.id] = compiled;
      }
      
      return result;
    } catch (err) {
      logger.error('Failed to fetch and compile batch', { err: err.message });
      return {};
    }
  }

  /**
   * 预热缓存
   */
  async warmup() {
    try {
      logger.info('Starting cache warmup...');
      const startTime = Date.now();
      
      // 获取热点精灵列表
      const { rows } = await query(`
        SELECT DISTINCT ON (ps.id) ps.*
        FROM pokemon_species ps
        LEFT JOIN pokemon_instances pi ON ps.id = pi.species_id
        GROUP BY ps.id
        ORDER BY COUNT(pi.id) DESC
        LIMIT 500
      `);
      
      // 批量编译和缓存
      for (const species of rows) {
        await this.set(species.id, species);
      }
      
      const warmupTime = Date.now() - startTime;
      logger.info('Cache warmup completed', { count: rows.length, timeMs: warmupTime });
      
      return { count: rows.length, timeMs: warmupTime };
    } catch (err) {
      logger.error('Failed to warmup cache', { err: err.message });
      throw err;
    }
  }

  /**
   * 更新缓存版本
   */
  async updateVersion() {
    const oldVersion = this.currentVersion;
    const newVersion = Date.now().toString();
    
    this.currentVersion = newVersion;
    await this.redis.set(`${this.cachePrefix}version`, newVersion);
    
    // 清理旧版本缓存
    if (oldVersion) {
      await this.cleanupOldVersion(oldVersion);
    }
    
    logger.info('Version updated', { oldVersion, newVersion });
    
    return { oldVersion, newVersion };
  }

  /**
   * 清理旧版本缓存
   * @param {string} version - 版本号
   */
  async cleanupOldVersion(version) {
    const pattern = `${this.cachePrefix}${version}:*`;
    
    try {
      const keys = await this.redis.keys(pattern);
      
      if (keys.length > 0) {
        await this.redis.del(...keys);
        logger.info('Old version cleaned up', { version, count: keys.length });
      }
    } catch (err) {
      logger.error('Failed to cleanup old version', { version, err: err.message });
    }
  }

  /**
   * 使缓存失效
   * @param {number} pokemonId - 精灵 ID（可选，不提供则清空所有）
   */
  async invalidate(pokemonId = null) {
    if (pokemonId) {
      const cacheKey = `${this.cachePrefix}${this.currentVersion}:${pokemonId}`;
      
      // 删除 L1
      this.l1Cache.delete(cacheKey);
      
      // 删除 L2
      await this.redis.del(cacheKey);
      
      logger.info('Cache invalidated', { pokemonId });
    } else {
      // 清空所有
      this.l1Cache.clear();
      
      const pattern = `${this.cachePrefix}${this.currentVersion}:*`;
      const keys = await this.redis.keys(pattern);
      
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      
      logger.info('All cache invalidated');
    }
  }

  /**
   * 记录指标
   */
  recordMetric(type, layer, startTime) {
    if (!metrics) return;
    
    const duration = (Date.now() - startTime) / 1000;
    
    if (type === 'hit' && layer) {
      metrics.cacheHitsTotal?.inc({ layer: `pokemon_precompiled_${layer}` });
      metrics.cacheLatency?.observe({ operation: 'get', layer }, duration);
    } else if (type === 'miss') {
      metrics.cacheMissesTotal?.inc({ type: 'pokemon_precompiled' });
    }
  }

  /**
   * 获取缓存统计
   * @returns {Object}
   */
  getStats() {
    const l1Stats = this.l1Cache.getStats();
    
    return {
      l1: l1Stats,
      l2: {
        hits: this.stats.l2Hits
      },
      total: {
        hits: this.stats.l1Hits + this.stats.l2Hits,
        misses: this.stats.misses,
        updates: this.stats.updates,
        hitRate: this.calculateHitRate()
      },
      version: this.currentVersion,
      initialized: this.initialized
    };
  }

  /**
   * 计算命中率
   */
  calculateHitRate() {
    const total = this.stats.l1Hits + this.stats.l2Hits + this.stats.misses;
    return total > 0 ? (this.stats.l1Hits + this.stats.l2Hits) / total : 0;
  }

  /**
   * 关闭缓存
   */
  async close() {
    try {
      this.l1Cache.close();
      await this.redis.quit();
      
      logger.info('PokemonPrecompiledCache closed');
    } catch (err) {
      logger.error('Failed to close cache', { err: err.message });
    }
  }
}

// 单例
let instance = null;

function getInstance(config) {
  if (!instance) {
    instance = new PokemonPrecompiledCache(config);
  }
  return instance;
}

module.exports = {
  PokemonPrecompiledCache,
  getInstance
};