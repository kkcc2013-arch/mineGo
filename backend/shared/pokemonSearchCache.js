/**
 * REQ-00498: 精灵搜索缓存服务
 * 提供精灵列表和搜索结果的 Redis 缓存
 */

'use strict';

const { createLogger } = require('./logger');
const { getJSON, setJSON } = require('./redisUtils');

const logger = createLogger('pokemon-search-cache');

const CACHE_CONFIG = {
  LIST_TTL: 300,          // 精灵列表缓存 5 分钟
  SEARCH_TTL: 60,         // 搜索结果缓存 1 分钟
  STATS_TTL: 600,         // 统计数据缓存 10 分钟
  PREFIX: 'pokemon:list:',
  SEARCH_PREFIX: 'pokemon:search:',
  STATS_PREFIX: 'pokemon:stats:'
};

class PokemonSearchCache {
  constructor(redis) {
    this.redis = redis;
  }

  /**
   * 缓存精灵列表 ID
   * @param {number} userId - 用户 ID
   * @param {string} sort - 排序字段
   * @param {object} filter - 筛选条件
   * @param {number[]} pokemonIds - 精灵 ID 数组
   */
  async cacheList(userId, sort, filter, pokemonIds) {
    const filterKey = this._encodeFilter(filter);
    const key = `${CACHE_CONFIG.PREFIX}${userId}:${sort}:${filterKey}`;
    
    try {
      await setJSON(key, {
        ids: pokemonIds,
        cachedAt: Date.now(),
        total: pokemonIds.length
      }, CACHE_CONFIG.LIST_TTL);
      
      logger.debug({ userId, sort, filterKey, count: pokemonIds.length }, 'Cached pokemon list');
      
      // 统计缓存写入
      this._incrementMetric('cache_writes', 'list');
    } catch (error) {
      logger.error({ error, userId, sort }, 'Failed to cache pokemon list');
    }
  }

  /**
   * 获取缓存的精灵列表 ID
   * @param {number} userId - 用户 ID
   * @param {string} sort - 排序字段
   * @param {object} filter - 筛选条件
   * @returns {object|null} 缓存数据或 null
   */
  async getListIds(userId, sort, filter) {
    const filterKey = this._encodeFilter(filter);
    const key = `${CACHE_CONFIG.PREFIX}${userId}:${sort}:${filterKey}`;
    
    try {
      const cached = await getJSON(key);
      
      if (cached) {
        logger.debug({ userId, sort, filterKey, count: cached.ids.length }, 'Cache hit for pokemon list');
        this._incrementMetric('cache_hits', 'list');
        return cached;
      }
      
      this._incrementMetric('cache_misses', 'list');
      return null;
    } catch (error) {
      logger.error({ error, userId, sort }, 'Failed to get cached pokemon list');
      return null;
    }
  }

  /**
   * 缓存搜索结果
   * @param {number} userId - 用户 ID
   * @param {string} term - 搜索词
   * @param {number[]} resultIds - 结果精灵 ID 数组
   */
  async cacheSearch(userId, term, resultIds) {
    const key = `${CACHE_CONFIG.SEARCH_PREFIX}${userId}:${term.toLowerCase()}`;
    
    try {
      await setJSON(key, {
        ids: resultIds,
        cachedAt: Date.now(),
        term: term.toLowerCase()
      }, CACHE_CONFIG.SEARCH_TTL);
      
      logger.debug({ userId, term, count: resultIds.length }, 'Cached search results');
      this._incrementMetric('cache_writes', 'search');
    } catch (error) {
      logger.error({ error, userId, term }, 'Failed to cache search results');
    }
  }

  /**
   * 获取缓存的搜索结果
   * @param {number} userId - 用户 ID
   * @param {string} term - 搜索词
   * @returns {number[]|null} 结果 ID 数组或 null
   */
  async getSearchResults(userId, term) {
    const key = `${CACHE_CONFIG.SEARCH_PREFIX}${userId}:${term.toLowerCase()}`;
    
    try {
      const cached = await getJSON(key);
      
      if (cached) {
        logger.debug({ userId, term, count: cached.ids.length }, 'Cache hit for search');
        this._incrementMetric('cache_hits', 'search');
        return cached.ids;
      }
      
      this._incrementMetric('cache_misses', 'search');
      return null;
    } catch (error) {
      logger.error({ error, userId, term }, 'Failed to get cached search results');
      return null;
    }
  }

  /**
   * 缓存精灵统计数据
   * @param {number} userId - 用户 ID
   * @param {object} stats - 统计数据
   */
  async cacheStats(userId, stats) {
    const key = `${CACHE_CONFIG.STATS_PREFIX}${userId}`;
    
    try {
      await setJSON(key, {
        ...stats,
        cachedAt: Date.now()
      }, CACHE_CONFIG.STATS_TTL);
      
      logger.debug({ userId, stats }, 'Cached pokemon stats');
    } catch (error) {
      logger.error({ error, userId }, 'Failed to cache pokemon stats');
    }
  }

  /**
   * 获取缓存的统计数据
   * @param {number} userId - 用户 ID
   * @returns {object|null} 统计数据或 null
   */
  async getStats(userId) {
    const key = `${CACHE_CONFIG.STATS_PREFIX}${userId}`;
    
    try {
      return await getJSON(key);
    } catch (error) {
      logger.error({ error, userId }, 'Failed to get cached stats');
      return null;
    }
  }

  /**
   * 失效用户所有精灵缓存
   * @param {number} userId - 用户 ID
   * @param {string} reason - 失效原因
   */
  async invalidateUser(userId, reason = 'unknown') {
    try {
      // 删除列表缓存
      const listPattern = `${CACHE_CONFIG.PREFIX}${userId}:*`;
      const listKeys = await this._deleteByPattern(listPattern);
      
      // 删除搜索缓存
      const searchPattern = `${CACHE_CONFIG.SEARCH_PREFIX}${userId}:*`;
      const searchKeys = await this._deleteByPattern(searchPattern);
      
      // 删除统计缓存
      const statsKey = `${CACHE_CONFIG.STATS_PREFIX}${userId}`;
      await this.redis.del(statsKey);
      
      const totalDeleted = listKeys + searchKeys + 1;
      
      logger.info({ userId, reason, deletedKeys: totalDeleted }, 'Invalidated user pokemon cache');
      
      // 统计失效次数
      this._incrementMetric('cache_invalidations', reason);
      
      return totalDeleted;
    } catch (error) {
      logger.error({ error, userId, reason }, 'Failed to invalidate user cache');
      return 0;
    }
  }

  /**
   * 失效特定精灵的缓存（影响搜索结果）
   * @param {number} userId - 用户 ID
   * @param {number} pokemonId - 精灵 ID
   */
  async invalidatePokemon(userId, pokemonId) {
    // 由于精灵可能在多个搜索结果中，简单方案是失效整个用户搜索缓存
    const searchPattern = `${CACHE_CONFIG.SEARCH_PREFIX}${userId}:*`;
    const deleted = await this._deleteByPattern(searchPattern);
    
    logger.debug({ userId, pokemonId, deletedKeys: deleted }, 'Invalidated pokemon-specific cache');
    
    return deleted;
  }

  /**
   * 获取缓存命中率统计
   * @returns {object} 缓存命中率数据
   */
  async getCacheHitRate() {
    try {
      const hits = await this.redis.get('pokemon:cache_hits_total') || 0;
      const misses = await this.redis.get('pokemon:cache_misses_total') || 0;
      
      const total = parseInt(hits) + parseInt(misses);
      const hitRate = total > 0 ? parseInt(hits) / total : 0;
      
      return {
        hits: parseInt(hits),
        misses: parseInt(misses),
        total,
        hitRate: hitRate.toFixed(2)
      };
    } catch (error) {
      logger.error({ error }, 'Failed to get cache hit rate');
      return { hits: 0, misses: 0, total: 0, hitRate: '0.00' };
    }
  }

  /**
   * 编码筛选条件为字符串键
   * @private
   */
  _encodeFilter(filter) {
    if (!filter || Object.keys(filter).length === 0) {
      return 'all';
    }
    
    const parts = [];
    if (filter.type) parts.push(`t:${filter.type}`);
    if (filter.minCp) parts.push(`min:${filter.minCp}`);
    if (filter.maxCp) parts.push(`max:${filter.maxCp}`);
    if (filter.rarity) parts.push(`r:${filter.rarity}`);
    
    return parts.join('_') || 'all';
  }

  /**
   * 按模式删除键
   * @private
   */
  async _deleteByPattern(pattern) {
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(keys);
      }
      return keys.length;
    } catch (error) {
      logger.error({ error, pattern }, 'Failed to delete keys by pattern');
      return 0;
    }
  }

  /**
   * 增加缓存统计指标
   * @private
   */
  async _incrementMetric(type, subtype) {
    try {
      const key = `pokemon:cache_${type}_${subtype}`;
      await this.redis.incr(key);
      await this.redis.incr(`pokemon:cache_${type}_total`);
    } catch (error) {
      // 静默失败，不影响主流程
    }
  }
}

module.exports = PokemonSearchCache;