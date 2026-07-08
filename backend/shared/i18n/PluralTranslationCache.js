/**
 * 复数翻译缓存 - 优化翻译加载性能
 */

const NodeCache = require('node-cache');
const logger = require('../logger');

class PluralTranslationCache {
  constructor(options = {}) {
    // 默认缓存配置
    this.cache = new NodeCache({
      stdTTL: options.ttl || 3600, // 1 小时缓存
      checkperiod: options.checkperiod || 600, // 10 分钟检查
      useClones: false,
      maxKeys: options.maxKeys || 10000
    });
    
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      clears: 0
    };
    
    logger.info('[PluralTranslationCache] Initialized with TTL:', options.ttl || 3600);
  }

  /**
   * 获取缓存
   * @param {string} key - 翻译键
   * @param {string} locale - 语言代码
   * @returns {Promise<string|null>} 翻译文本
   */
  async get(key, locale) {
    const cacheKey = `${locale}:${key}`;
    const value = this.cache.get(cacheKey);
    
    if (value !== undefined) {
      this.stats.hits++;
      return value;
    }
    
    this.stats.misses++;
    return null;
  }

  /**
   * 设置缓存
   * @param {string} key - 翻译键
   * @param {string} locale - 语言代码
   * @param {string} value - 翻译文本
   * @returns {Promise<boolean>} 是否成功
   */
  async set(key, locale, value) {
    const cacheKey = `${locale}:${key}`;
    const success = this.cache.set(cacheKey, value);
    
    if (success) {
      this.stats.sets++;
    }
    
    return success;
  }

  /**
   * 清除缓存
   * @returns {Promise<void>}
   */
  async clear() {
    this.cache.flushAll();
    this.stats.clears++;
    logger.info('[PluralTranslationCache] Cache cleared');
  }

  /**
   * 获取缓存统计
   * @returns {Object} 统计信息
   */
  getStats() {
    const cacheStats = this.cache.getStats();
    
    return {
      ...this.stats,
      keys: cacheStats.keys,
      ksize: cacheStats.ksize,
      vsize: cacheStats.vsize,
      hitRate: this.stats.hits > 0 ? 
        (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2) + '%' : 
        '0%'
    };
  }

  /**
   * 批量获取
   * @param {string[]} keys - 翻译键数组
   * @param {string} locale - 语言代码
   * @returns {Promise<Object>} 翻译映射
   */
  async mget(keys, locale) {
    const cacheKeys = keys.map(key => `${locale}:${key}`);
    const values = this.cache.mget(cacheKeys);
    
    const result = {};
    for (const [cacheKey, value] of Object.entries(values)) {
      const key = cacheKey.replace(`${locale}:`, '');
      result[key] = value;
      this.stats.hits++;
    }
    
    // 未命中计数
    for (const key of keys) {
      if (!result[key]) {
        this.stats.misses++;
      }
    }
    
    return result;
  }

  /**
   * 批量设置
   * @param {Object} translations - 翻译映射 { key: value }
   * @param {string} locale - 语言代码
   * @returns {Promise<void>}
   */
  async mset(translations, locale) {
    const cacheData = {};
    
    for (const [key, value] of Object.entries(translations)) {
      cacheData[`${locale}:${key}`] = value;
    }
    
    this.cache.mset(cacheData);
    this.stats.sets += Object.keys(translations).length;
  }
}

module.exports = PluralTranslationCache;