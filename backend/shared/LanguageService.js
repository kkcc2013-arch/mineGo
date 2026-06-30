// backend/shared/LanguageService.js - REQ-00393 语言服务核心模块
'use strict';

const db = require('./db');
const redis = require('./redis');
const EventBus = require('./EventBus');
const { createLogger } = require('./logger');
const metrics = require('./metrics');

const logger = createLogger('LanguageService');

class LanguageService {
  constructor() {
    this.cachePrefix = 'user:lang:';
    this.cacheTTL = 3600; // 1小时
    this.validLanguages = ['zh', 'en', 'ja'];
    this.defaultLanguage = 'en';
  }

  /**
   * 获取用户当前语言（优先从缓存）
   * @param {string} userId - 用户ID
   * @returns {Promise<string>} - 语言代码
   */
  async getLanguage(userId) {
    const startTime = Date.now();
    
    try {
      // 先查缓存
      const cached = await redis.get(`${this.cachePrefix}${userId}`);
      if (cached && this.validLanguages.includes(cached)) {
        metrics.timing('language.get.cache', Date.now() - startTime);
        return cached;
      }
      
      // 查数据库
      const result = await db.query(
        `SELECT language FROM users WHERE id = $1`,
        [userId]
      );
      
      const language = result.rows[0]?.language || this.defaultLanguage;
      
      // 写入缓存
      await redis.set(`${this.cachePrefix}${userId}`, language, 'EX', this.cacheTTL);
      
      metrics.timing('language.get.database', Date.now() - startTime);
      metrics.increment('language.get.cache_miss');
      
      return language;
      
    } catch (error) {
      logger.error('获取用户语言失败', { userId, error });
      metrics.increment('language.get.error');
      return this.defaultLanguage;
    }
  }

  /**
   * 更新用户语言偏好
   * @param {string} userId - 用户ID
   * @param {string} language - 新语言代码
   * @returns {Promise<{success: boolean, language: string, previousLanguage: string}>}
   */
  async updateLanguage(userId, language) {
    const startTime = Date.now();
    
    // 验证语言有效性
    if (!this.validLanguages.includes(language)) {
      throw new Error(`Invalid language: ${language}`);
    }
    
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取当前语言
      const currentResult = await client.query(
        `SELECT language FROM users WHERE id = $1`,
        [userId]
      );
      const previousLanguage = currentResult.rows[0]?.language || this.defaultLanguage;
      
      // 更新数据库
      await client.query(
        `UPDATE users SET language = $1, language_updated_at = NOW() WHERE id = $2`,
        [language, userId]
      );
      
      // 更新 Redis 缓存
      await redis.set(`${this.cachePrefix}${userId}`, language, 'EX', this.cacheTTL);
      
      // 更新会话中的语言
      await this.updateSessionLanguage(userId, language);
      
      // 发布语言变更事件
      await EventBus.publish('user-language-changed', {
        userId,
        language,
        previousLanguage,
        timestamp: Date.now(),
        source: 'language_service'
      });
      
      await client.query('COMMIT');
      
      metrics.timing('language.update', Date.now() - startTime);
      metrics.increment(`language.switch.${language}`);
      
      logger.info('用户语言已更新', { userId, previousLanguage, newLanguage: language });
      
      return {
        success: true,
        language,
        previousLanguage
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      metrics.increment('language.update.error');
      logger.error('更新用户语言失败', { userId, language, error });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 更新会话语言（保持登录状态）
   * @param {string} userId - 用户ID
   * @param {string} language - 新语言
   */
  async updateSessionLanguage(userId, language) {
    try {
      // 获取所有活跃会话
      const sessionKeys = await redis.keys(`session:*:${userId}`);
      
      const updates = [];
      
      for (const sessionKey of sessionKeys) {
        const sessionData = await redis.get(sessionKey);
        if (sessionData) {
          const session = JSON.parse(sessionData);
          session.language = language;
          session.languageUpdatedAt = Date.now();
          
          // 保持原有 TTL
          const ttl = await redis.ttl(sessionKey);
          updates.push({
            key: sessionKey,
            data: JSON.stringify(session),
            ttl: ttl > 0 ? ttl : this.cacheTTL
          });
        }
      }
      
      // 批量更新会话
      if (updates.length > 0) {
        const multi = redis.multi();
        for (const update of updates) {
          multi.set(update.key, update.data, 'EX', update.ttl);
        }
        await multi.exec();
      }
      
      // 更新会话元数据
      await redis.hset(`user:sessionMeta:${userId}`, 'language', language);
      
      logger.debug('会话语言已更新', { userId, language, sessionCount: sessionKeys.length });
      metrics.increment('language.session_updated');
      
    } catch (error) {
      logger.error('更新会话语言失败', { userId, language, error });
      // 不抛出错误，允许继续执行
    }
  }

  /**
   * 同步语言到指定服务
   * @param {string} userId - 用户ID
   * @param {string} targetService - 目标服务名称
   */
  async syncLanguageToService(userId, targetService) {
    const language = await this.getLanguage(userId);
    
    await EventBus.publish('language-sync', {
      userId,
      language,
      targetService,
      timestamp: Date.now()
    });
    
    logger.debug('语言同步事件已发布', { userId, language, targetService });
  }

  /**
   * 批量获取用户语言
   * @param {string[]} userIds - 用户ID数组
   * @returns {Promise<Map<string, string>>} - userId -> language 映射
   */
  async batchGetLanguages(userIds) {
    const startTime = Date.now();
    const result = new Map();
    
    try {
      // 批量从缓存获取
      const keys = userIds.map(id => `${this.cachePrefix}${id}`);
      const cachedValues = await redis.mget(...keys);
      
      // 处理缓存命中
      const missedIds = [];
      for (let i = 0; i < userIds.length; i++) {
        const cached = cachedValues[i];
        if (cached && this.validLanguages.includes(cached)) {
          result.set(userIds[i], cached);
        } else {
          missedIds.push(userIds[i]);
        }
      }
      
      // 批量从数据库获取缺失的
      if (missedIds.length > 0) {
        const dbResult = await db.query(
          `SELECT id, language FROM users WHERE id = ANY($1)`,
          [missedIds]
        );
        
        for (const row of dbResult.rows) {
          const language = row.language || this.defaultLanguage;
          result.set(row.id, language);
          
          // 回填缓存
          await redis.set(`${this.cachePrefix}${row.id}`, language, 'EX', this.cacheTTL);
        }
        
        // 未找到的用户使用默认语言
        for (const userId of missedIds) {
          if (!result.has(userId)) {
            result.set(userId, this.defaultLanguage);
          }
        }
      }
      
      metrics.timing('language.batch_get', Date.now() - startTime);
      metrics.histogram('language.batch_size', userIds.length);
      
      return result;
      
    } catch (error) {
      logger.error('批量获取语言失败', { count: userIds.length, error });
      metrics.increment('language.batch_get.error');
      
      // 返回默认语言
      for (const userId of userIds) {
        result.set(userId, this.defaultLanguage);
      }
      return result;
    }
  }

  /**
   * 获取语言使用统计
   * @returns {Promise<object>}
   */
  async getLanguageStats() {
    try {
      const result = await db.query(`
        SELECT 
          language,
          COUNT(*) as user_count,
          COUNT(*) FILTER (WHERE language_updated_at > NOW() - INTERVAL '24 hours') as recent_changes,
          COUNT(*) FILTER (WHERE language_updated_at > NOW() - INTERVAL '7 days') as weekly_changes
        FROM users
        GROUP BY language
        ORDER BY user_count DESC
      `);
      
      const total = result.rows.reduce((sum, row) => sum + parseInt(row.user_count), 0);
      
      return {
        stats: result.rows,
        total,
        supportedLanguages: this.validLanguages,
        defaultLanguage: this.defaultLanguage
      };
      
    } catch (error) {
      logger.error('获取语言统计失败', { error });
      return {
        stats: [],
        total: 0,
        supportedLanguages: this.validLanguages,
        defaultLanguage: this.defaultLanguage
      };
    }
  }

  /**
   * 验证语言代码
   * @param {string} language - 语言代码
   * @returns {boolean}
   */
  isValidLanguage(language) {
    return this.validLanguages.includes(language);
  }

  /**
   * 获取支持的语言列表
   * @returns {string[]}
   */
  getSupportedLanguages() {
    return [...this.validLanguages];
  }
}

// 导出单例
const languageService = new LanguageService();

module.exports = languageService;
module.exports.LanguageService = LanguageService;