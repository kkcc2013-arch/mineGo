// backend/shared/i18n/translationCache.js
// REQ-00294: 翻译缓存与版本管理系统

'use strict';

const Redis = require('ioredis');
const { Pool } = require('pg');
const { createLogger } = require('../logger');

const logger = createLogger('translation-cache');

class TranslationCache {
  constructor() {
    this.redis = new Redis(process.env.REDIS_URL);
    this.db = new Pool({ connectionString: process.env.DATABASE_URL });
    this.cachePrefix = 'i18n:translations:';
    this.versionKey = 'i18n:version';
    this.localCache = new Map();
    this.currentVersion = null;
    this.maxLocalCacheSize = 1000;
  }

  /**
   * 加载翻译数据
   */
  async loadTranslations(locale) {
    // 1. 检查本地缓存
    const cacheKey = `${this.cachePrefix}${locale}`;
    const cached = this.localCache.get(cacheKey);
    const currentVersion = await this.getVersion();
    
    if (cached && cached.version === currentVersion) {
      logger.debug({ locale, version: currentVersion }, 'Using local cache');
      return cached;
    }
    
    // 2. 从 Redis 加载
    try {
      const redisData = await this.redis.get(cacheKey);
      if (redisData) {
        const parsed = JSON.parse(redisData);
        this.localCache.set(cacheKey, parsed);
        logger.debug({ locale }, 'Loaded from Redis cache');
        return parsed;
      }
    } catch (err) {
      logger.error({ err, locale }, 'Failed to load from Redis');
    }
    
    // 3. 从数据库加载
    const dbData = await this.loadFromDatabase(locale);
    
    // 4. 写入缓存
    await this.redis.setex(cacheKey, 3600, JSON.stringify(dbData));
    this.localCache.set(cacheKey, dbData);
    
    logger.info({ locale, version: dbData.version }, 'Loaded translations from database');
    
    return dbData;
  }

  /**
   * 从数据库加载翻译
   */
  async loadFromDatabase(locale) {
    const client = await this.db.connect();
    
    try {
      const result = await client.query(`
        SELECT key, value, context, metadata
        FROM translations
        WHERE locale = $1 AND status = 'active'
      `, [locale]);
      
      const data = {};
      const contexts = new Set();
      
      for (const row of result.rows) {
        contexts.add(row.context || 'default');
        
        if (row.context) {
          if (!data[row.context]) data[row.context] = {};
          data[row.context][row.key] = row.value;
        } else {
          data[row.key] = row.value;
        }
      }
      
      return {
        data,
        version: await this.getVersion(),
        loadedAt: new Date().toISOString(),
        stats: {
          total: result.rows.length,
          contexts: Array.from(contexts)
        }
      };
    } finally {
      client.release();
    }
  }

  /**
   * 获取单个翻译
   */
  async get(key, locale, context = null) {
    const translations = await this.loadTranslations(locale);
    
    if (context) {
      return translations.data[context]?.[key] || null;
    }
    
    // 查找所有上下文
    for (const ctx of Object.keys(translations.data)) {
      if (typeof translations.data[ctx] === 'object' && translations.data[ctx][key]) {
        return translations.data[ctx][key];
      }
    }
    
    // 查找顶级键
    return translations.data[key] || null;
  }

  /**
   * 获取当前版本号
   */
  async getVersion() {
    if (this.currentVersion) {
      return this.currentVersion;
    }
    
    const version = await this.redis.get(this.versionKey);
    this.currentVersion = version || Date.now().toString();
    return this.currentVersion;
  }

  /**
   * 更新版本号（翻译更新时调用）
   */
  async updateVersion() {
    const newVersion = Date.now().toString();
    await this.redis.set(this.versionKey, newVersion);
    this.currentVersion = newVersion;
    
    // 清空本地缓存
    this.localCache.clear();
    
    // 发布更新事件
    await this.redis.publish('i18n:update', JSON.stringify({
      version: newVersion,
      timestamp: new Date().toISOString()
    }));
    
    logger.info({ version: newVersion }, 'Translation version updated');
  }

  /**
   * 热更新翻译
   */
  async hotReload(locale, keys = null) {
    const cacheKey = `${this.cachePrefix}${locale}`;
    
    // 删除缓存
    await this.redis.del(cacheKey);
    this.localCache.delete(cacheKey);
    
    // 更新版本
    await this.updateVersion();
    
    // 重新加载
    return this.loadTranslations(locale);
  }

  /**
   * 批量获取翻译
   */
  async getBatch(keys, locale, context = null) {
    const translations = await this.loadTranslations(locale);
    const result = {};
    
    for (const key of keys) {
      if (context) {
        result[key] = translations.data[context]?.[key] || key;
      } else {
        result[key] = await this.get(key, locale);
      }
    }
    
    return result;
  }

  /**
   * 清理本地缓存
   */
  clearLocalCache() {
    if (this.localCache.size > this.maxLocalCacheSize) {
      const entries = Array.from(this.localCache.entries());
      this.localCache = new Map(entries.slice(-this.maxLocalCacheSize / 2));
      logger.info('Local cache cleared');
    }
  }
}

module.exports = TranslationCache;
