'use strict';

/**
 * REQ-00398: API 错误消息动态翻译管理系统
 * 动态翻译管理器 - 从数据库加载翻译，支持缓存、回退、缺失检测
 */

const { db, pool } = require('./db');
const logger = require('./logger');
const Redis = require('ioredis');
const translationMetrics = require('./translationMetrics');

class DynamicTranslationManager {
  constructor(config = {}) {
    this.redis = config.redis || new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    this.cachePrefix = 'error_translations:';
    this.cacheTTL = config.cacheTTL || 3600; // 1小时缓存
    this.fallbackChain = {
      'ja-JP': ['en-US', 'zh-CN'],
      'zh-TW': ['zh-CN', 'en-US'],
      'en-US': ['zh-CN'],
      'zh-CN': ['en-US'],
      'ko-KR': ['en-US', 'zh-CN'],
      'es-ES': ['en-US'],
      'fr-FR': ['en-US'],
      'de-DE': ['en-US']
    };
    this.supportedLanguages = ['zh-CN', 'en-US', 'ja-JP', 'zh-TW', 'ko-KR', 'es-ES', 'fr-FR', 'de-DE'];
    this.defaultLanguage = 'zh-CN';
    this.initialized = false;
    this.pendingMissingReports = [];
    this.flushInterval = null;
  }

  /**
   * 初始化 - 预热缓存
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      logger.info('Initializing DynamicTranslationManager...');
      
      // 预热缓存：加载所有翻译
      await this.preloadAllTranslations();
      
      // 启动缺失翻译批量报告定时器
      this.flushInterval = setInterval(() => this.flushMissingReports(), 30000);
      
      this.initialized = true;
      logger.info('DynamicTranslationManager initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize DynamicTranslationManager', { error: error.message });
      throw error;
    }
  }

  /**
   * 预热缓存：加载所有翻译到 Redis
   */
  async preloadAllTranslations() {
    try {
      const result = await db.query(
        `SELECT error_code, language, message FROM error_translations 
         WHERE version = (SELECT MAX(version) FROM error_translations WHERE error_code = t.error_code AND language = t.language)`
      );
      
      if (result.rows.length === 0) {
        logger.warn('No translations found in database');
        return;
      }
      
      // 批量写入 Redis
      const pipeline = this.redis.pipeline();
      
      for (const row of result.rows) {
        const cacheKey = `${this.cachePrefix}${row.error_code}:${row.language}`;
        pipeline.setex(cacheKey, this.cacheTTL, row.message);
      }
      
      await pipeline.exec();
      
      logger.info('Preloaded translations to cache', { count: result.rows.length });
      translationMetrics.cacheHits.inc({ language: 'preload' }, result.rows.length);
    } catch (error) {
      logger.error('Failed to preload translations', { error: error.message });
    }
  }

  /**
   * 获取本地化错误消息
   * @param {string} errorCode - 错误码
   * @param {string} language - 目标语言
   * @param {Object} params - 参数对象
   * @returns {string} 本地化消息
   */
  async getLocalizedMessage(errorCode, language = this.defaultLanguage, params = {}) {
    const startTime = Date.now();
    
    try {
      // 标准化语言代码
      language = this.normalizeLanguage(language);
      
      // 1. 尝试从 Redis 缓存获取
      const cacheKey = `${this.cachePrefix}${errorCode}:${language}`;
      let message = await this.redis.get(cacheKey);
      
      if (message) {
        translationMetrics.cacheHits.inc({ language });
        translationMetrics.translationLatency.observe({ source: 'cache' }, (Date.now() - startTime) / 1000);
        return this.interpolateMessage(message, params);
      }
      
      translationMetrics.cacheMisses.inc({ language });
      
      // 2. 从数据库查询
      const result = await db.query(
        `SELECT message FROM error_translations 
         WHERE error_code = $1 AND language = $2 
         ORDER BY version DESC LIMIT 1`,
        [errorCode, language]
      );
      
      if (result.rows.length > 0) {
        message = result.rows[0].message;
        // 缓存结果
        await this.redis.setex(cacheKey, this.cacheTTL, message);
        translationMetrics.translationLatency.observe({ source: 'database' }, (Date.now() - startTime) / 1000);
        return this.interpolateMessage(message, params);
      }
      
      // 3. 使用回退策略
      message = await this.getFallbackMessage(errorCode, language);
      
      // 4. 记录缺失翻译（批量）
      this.pendingMissingReports.push({ errorCode, language, timestamp: Date.now() });
      
      return this.interpolateMessage(message, params);
      
    } catch (error) {
      logger.error('Failed to get localized message', {
        errorCode,
        language,
        error: error.message
      });
      
      // 最终回退：返回错误码
      return `Error: ${errorCode}`;
    }
  }

  /**
   * 回退策略获取消息
   */
  async getFallbackMessage(errorCode, requestedLanguage) {
    const fallbackLanguages = this.fallbackChain[requestedLanguage] || ['en-US', 'zh-CN'];
    
    for (const fallbackLang of fallbackLanguages) {
      // 先查缓存
      const cacheKey = `${this.cachePrefix}${errorCode}:${fallbackLang}`;
      let message = await this.redis.get(cacheKey);
      
      if (message) {
        translationMetrics.fallbackUsed.inc({
          error_code: errorCode,
          requested_lang: requestedLanguage,
          fallback_lang: fallbackLang
        });
        logger.warn('Using fallback translation from cache', {
          errorCode,
          requestedLang: requestedLanguage,
          fallbackLang
        });
        return message;
      }
      
      // 再查数据库
      const result = await db.query(
        `SELECT message FROM error_translations 
         WHERE error_code = $1 AND language = $2 
         ORDER BY version DESC LIMIT 1`,
        [errorCode, fallbackLang]
      );
      
      if (result.rows.length > 0) {
        message = result.rows[0].message;
        // 缓存结果
        await this.redis.setex(cacheKey, this.cacheTTL, message);
        
        translationMetrics.fallbackUsed.inc({
          error_code: errorCode,
          requested_lang: requestedLanguage,
          fallback_lang: fallbackLang
        });
        
        logger.warn('Using fallback translation from database', {
          errorCode,
          requestedLang: requestedLanguage,
          fallbackLang
        });
        
        return message;
      }
    }
    
    // 最终回退：返回错误码
    return `Error: ${errorCode}`;
  }

  /**
   * 参数插值
   * @param {string} message - 消息模板
   * @param {Object} params - 参数对象
   * @returns {string} 插值后的消息
   */
  interpolateMessage(message, params) {
    if (!params || Object.keys(params).length === 0) {
      return message;
    }
    
    return message.replace(/\{(\w+)\}/g, (match, key) => {
      return params[key] !== undefined ? String(params[key]) : match;
    });
  }

  /**
   * 标准化语言代码
   */
  normalizeLanguage(language) {
    if (!language) return this.defaultLanguage;
    
    // 转换为标准格式 zh-CN
    const normalized = language.toLowerCase().replace('_', '-');
    
    // 检查是否支持
    if (this.supportedLanguages.includes(normalized)) {
      return normalized;
    }
    
    // 尝试匹配主语言
    const mainLang = normalized.split('-')[0];
    const matched = this.supportedLanguages.find(l => l.startsWith(mainLang));
    
    return matched || this.defaultLanguage;
  }

  /**
   * 批量获取翻译
   */
  async getBatchTranslations(errorCodes, language) {
    const translations = {};
    language = this.normalizeLanguage(language);
    
    // 批量查询缓存
    const cacheKeys = errorCodes.map(code => `${this.cachePrefix}${code}:${language}`);
    const cachedResults = await this.redis.mget(...cacheKeys);
    
    const uncachedCodes = [];
    
    for (let i = 0; i < errorCodes.length; i++) {
      if (cachedResults[i]) {
        translations[errorCodes[i]] = cachedResults[i];
      } else {
        uncachedCodes.push(errorCodes[i]);
      }
    }
    
    // 批量查询数据库
    if (uncachedCodes.length > 0) {
      const result = await db.query(
        `SELECT error_code, message FROM error_translations 
         WHERE error_code = ANY($1) AND language = $2 
         ORDER BY version DESC`,
        [uncachedCodes, language]
      );
      
      for (const row of result.rows) {
        translations[row.error_code] = row.message;
        // 缓存结果
        await this.redis.setex(
          `${this.cachePrefix}${row.error_code}:${language}`,
          this.cacheTTL,
          row.message
        );
      }
      
      // 对仍然缺失的，使用回退
      for (const code of uncachedCodes) {
        if (!translations[code]) {
          translations[code] = await this.getFallbackMessage(code, language);
          this.pendingMissingReports.push({ errorCode: code, language });
        }
      }
    }
    
    return translations;
  }

  /**
   * 批量报告缺失翻译
   */
  async flushMissingReports() {
    if (this.pendingMissingReports.length === 0) return;
    
    const reports = [...this.pendingMissingReports];
    this.pendingMissingReports = [];
    
    try {
      // 按错误码聚合
      const aggregated = {};
      
      for (const report of reports) {
        if (!aggregated[report.errorCode]) {
          aggregated[report.errorCode] = [];
        }
        if (!aggregated[report.errorCode].includes(report.language)) {
          aggregated[report.errorCode].push(report.language);
        }
      }
      
      // 批量更新数据库
      for (const [errorCode, languages] of Object.entries(aggregated)) {
        const existing = await db.query(
          'SELECT * FROM missing_translation_alerts WHERE error_code = $1',
          [errorCode]
        );
        
        const missingLanguages = existing.rows.length > 0
          ? [...existing.rows[0].missing_languages, ...languages].filter((l, i, arr) => arr.indexOf(l) === i)
          : languages;
        
        const severity = missingLanguages.length >= 2 ? 'critical' : 'warning';
        
        if (existing.rows.length > 0) {
          await db.query(
            `UPDATE missing_translation_alerts 
             SET missing_languages = $1, 
                 last_detected = CURRENT_TIMESTAMP,
                 detection_count = detection_count + 1,
                 severity = $2
             WHERE error_code = $3`,
            [missingLanguages, severity, errorCode]
          );
        } else {
          await db.query(
            `INSERT INTO missing_translation_alerts 
             (error_code, missing_languages, severity) 
             VALUES ($1, $2, $3)`,
            [errorCode, missingLanguages, severity]
          );
        }
      }
      
      // 更新 Prometheus 指标
      const criticalCount = await this.getMissingCount('critical');
      const warningCount = await this.getMissingCount('warning');
      
      translationMetrics.missingTranslations.set({ severity: 'critical' }, criticalCount);
      translationMetrics.missingTranslations.set({ severity: 'warning' }, warningCount);
      
      logger.info('Flushed missing translation reports', { count: Object.keys(aggregated).length });
    } catch (error) {
      logger.error('Failed to flush missing reports', { error: error.message });
      // 重新放回队列
      this.pendingMissingReports.unshift(...reports);
    }
  }

  /**
   * 获取缺失翻译数量
   */
  async getMissingCount(severity) {
    const result = await db.query(
      'SELECT COUNT(*) FROM missing_translation_alerts WHERE severity = $1 AND NOT acknowledged',
      [severity]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * 清除缓存
   */
  async clearCache(errorCode = null, language = null) {
    try {
      if (errorCode && language) {
        await this.redis.del(`${this.cachePrefix}${errorCode}:${language}`);
      } else if (errorCode) {
        const keys = await this.redis.keys(`${this.cachePrefix}${errorCode}:*`);
        if (keys.length > 0) await this.redis.del(...keys);
      } else {
        const keys = await this.redis.keys(`${this.cachePrefix}*`);
        if (keys.length > 0) await this.redis.del(...keys);
      }
      
      logger.info('Cleared translation cache', { errorCode, language });
    } catch (error) {
      logger.error('Failed to clear cache', { error: error.message });
    }
  }

  /**
   * 创建或更新翻译
   */
  async saveTranslation(errorCode, language, message, paramsTemplate = null, metadata = null, userId = null) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取现有翻译
      const existing = await client.query(
        'SELECT * FROM error_translations WHERE error_code = $1 AND language = $2',
        [errorCode, language]
      );
      
      let result;
      
      if (existing.rows.length > 0) {
        // 更新
        result = await client.query(
          `UPDATE error_translations 
           SET message = $1, params_template = $2, metadata = $3, 
               version = version + 1, updated_at = CURRENT_TIMESTAMP, updated_by = $4
           WHERE error_code = $5 AND language = $6
           RETURNING *`,
          [message, paramsTemplate, metadata, userId, errorCode, language]
        );
        
        // 记录审计日志
        await client.query(
          `INSERT INTO error_translation_audit 
           (error_code, language, old_message, new_message, old_metadata, new_metadata, changed_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [errorCode, language, existing.rows[0].message, message, 
           existing.rows[0].metadata, metadata, userId]
        );
      } else {
        // 创建
        result = await client.query(
          `INSERT INTO error_translations 
           (error_code, language, message, params_template, metadata, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [errorCode, language, message, paramsTemplate, metadata, userId]
        );
      }
      
      await client.query('COMMIT');
      
      // 清除缓存
      await this.clearCache(errorCode, language);
      
      // 如果该错误码曾有缺失告警，更新告警状态
      await this.updateMissingAlertAfterSave(errorCode, language);
      
      logger.info('Translation saved', { errorCode, language, userId });
      
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to save translation', { error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 保存翻译后更新缺失告警
   */
  async updateMissingAlertAfterSave(errorCode, language) {
    const result = await db.query(
      'SELECT * FROM missing_translation_alerts WHERE error_code = $1',
      [errorCode]
    );
    
    if (result.rows.length > 0) {
      const alert = result.rows[0];
      const updatedMissing = alert.missing_languages.filter(l => l !== language);
      
      if (updatedMissing.length === 0) {
        // 所有缺失都已补齐，删除告警
        await db.query('DELETE FROM missing_translation_alerts WHERE error_code = $1', [errorCode]);
        logger.info('Missing translation alert removed', { errorCode });
      } else {
        // 更新缺失列表
        await db.query(
          'UPDATE missing_translation_alerts SET missing_languages = $1 WHERE error_code = $2',
          [updatedMissing, errorCode]
        );
      }
    }
  }

  /**
   * 删除翻译
   */
  async deleteTranslation(errorCode, language, userId = null) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const existing = await client.query(
        'SELECT * FROM error_translations WHERE error_code = $1 AND language = $2',
        [errorCode, language]
      );
      
      if (existing.rows.length === 0) {
        throw new Error('Translation not found');
      }
      
      await client.query(
        'DELETE FROM error_translations WHERE error_code = $1 AND language = $2',
        [errorCode, language]
      );
      
      // 记录审计日志
      await client.query(
        `INSERT INTO error_translation_audit 
         (error_code, language, old_message, new_message, old_metadata, new_metadata, changed_by, change_reason)
         VALUES ($1, $2, $3, NULL, $4, NULL, $5, 'deleted')`,
        [errorCode, language, existing.rows[0].message, existing.rows[0].metadata, userId]
      );
      
      await client.query('COMMIT');
      
      // 清除缓存
      await this.clearCache(errorCode, language);
      
      logger.info('Translation deleted', { errorCode, language, userId });
      
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取翻译列表
   */
  async getTranslations(filters = {}) {
    const { language, errorCode, page = 1, limit = 50 } = filters;
    const offset = (page - 1) * limit;
    
    let query = 'SELECT * FROM error_translations WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (language) {
      query += ` AND language = $${paramIndex++}`;
      params.push(language);
    }
    
    if (errorCode) {
      query += ` AND error_code ILIKE $${paramIndex++}`;
      params.push(`%${errorCode}%`);
    }
    
    query += ` ORDER BY error_code, language LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(limit, offset);
    
    const result = await db.query(query, params);
    
    // 获取总数
    let countQuery = 'SELECT COUNT(*) FROM error_translations WHERE 1=1';
    if (language) countQuery += ` AND language = '${language}'`;
    if (errorCode) countQuery += ` AND error_code ILIKE '%${errorCode}%'`;
    
    const countResult = await db.query(countQuery);
    
    return {
      data: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count, 10)
      }
    };
  }

  /**
   * 获取缺失翻译告警
   */
  async getMissingAlerts(filters = {}) {
    const { severity, acknowledged } = filters;
    
    let query = 'SELECT * FROM missing_translation_alerts WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (severity) {
      query += ` AND severity = $${paramIndex++}`;
      params.push(severity);
    }
    
    if (acknowledged !== undefined) {
      query += ` AND acknowledged = $${paramIndex++}`;
      params.push(acknowledged === 'true');
    }
    
    query += ' ORDER BY detection_count DESC, last_detected DESC';
    
    const result = await db.query(query, params);
    
    return result.rows;
  }

  /**
   * 确认缺失翻译告警
   */
  async acknowledgeAlert(alertId, userId) {
    await db.query(
      `UPDATE missing_translation_alerts 
       SET acknowledged = TRUE, acknowledged_by = $1, acknowledged_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [userId, alertId]
    );
    
    logger.info('Missing translation alert acknowledged', { alertId, userId });
  }

  /**
   * 批量导入翻译
   */
  async importTranslations(language, translations, userId = null) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const results = {
        imported: 0,
        updated: 0,
        failed: 0,
        errors: []
      };
      
      for (const [errorCode, message] of Object.entries(translations)) {
        try {
          const existing = await client.query(
            'SELECT * FROM error_translations WHERE error_code = $1 AND language = $2',
            [errorCode, language]
          );
          
          if (existing.rows.length > 0) {
            await client.query(
              `UPDATE error_translations 
               SET message = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
               WHERE error_code = $3 AND language = $4`,
              [message, userId, errorCode, language]
            );
            
            // 审计日志
            await client.query(
              `INSERT INTO error_translation_audit 
               (error_code, language, old_message, new_message, changed_by)
               VALUES ($1, $2, $3, $4, $5)`,
              [errorCode, language, existing.rows[0].message, message, userId]
            );
            
            results.updated++;
          } else {
            await client.query(
              `INSERT INTO error_translations (error_code, language, message, created_by)
               VALUES ($1, $2, $3, $4)`,
              [errorCode, language, message, userId]
            );
            results.imported++;
          }
        } catch (error) {
          results.failed++;
          results.errors.push({ errorCode, error: error.message });
        }
      }
      
      await client.query('COMMIT');
      
      // 清除缓存
      await this.clearCache();
      
      logger.info('Batch import completed', { language, results, userId });
      
      return results;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 导出翻译
   */
  async exportTranslations(language) {
    const result = await db.query(
      'SELECT error_code, message FROM error_translations WHERE language = $1 ORDER BY error_code',
      [language]
    );
    
    const translations = {};
    for (const row of result.rows) {
      translations[row.error_code] = row.message;
    }
    
    return translations;
  }

  /**
   * 获取翻译覆盖率
   */
  async getCoverage() {
    const result = await db.query(`
      SELECT 
        language,
        COUNT(*) as translation_count,
        COUNT(DISTINCT error_code) as unique_codes,
        ROUND(COUNT(*) * 100.0 / NULLIF((SELECT COUNT(DISTINCT error_code) FROM error_translations), 0), 2) as coverage_percentage
      FROM error_translations
      GROUP BY language
      ORDER BY language
    `);
    
    return result.rows;
  }

  /**
   * 关闭资源
   */
  async shutdown() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    
    // 最后一次刷新缺失报告
    await this.flushMissingReports();
    
    // 关闭 Redis 连接
    if (this.redis) {
      await this.redis.quit();
    }
    
    logger.info('DynamicTranslationManager shutdown complete');
  }
}

// 导出单例实例
const instance = new DynamicTranslationManager();

module.exports = instance;
module.exports.DynamicTranslationManager = DynamicTranslationManager;