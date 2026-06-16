/**
 * 翻译管理核心模块
 * REQ-00137: 游戏内容本地化内容管理与翻译工作流系统
 */

const { getClient } = require('./db');
const { getRedisClient } = require('./redis');
const logger = require('./logger');

class TranslationManager {
  constructor() {
    this.cachePrefix = 'translation:';
    this.cacheTTL = 3600; // 1小时
    this.supportedLanguages = ['zh-CN', 'en-US', 'ja-JP'];
    this.defaultLanguage = 'zh-CN';
  }

  /**
   * 获取翻译内容（带缓存）
   */
  async getTranslation(key, language) {
    const redis = getRedisClient();
    const cacheKey = `${this.cachePrefix}${language}:${key}`;
    
    try {
      // 尝试从缓存获取
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      logger.warn('Redis cache read failed', { error: err.message });
    }
    
    const client = await getClient();
    try {
      const result = await client.query(`
        SELECT t.content, t.status, t.version
        FROM translations t
        JOIN translation_keys tk ON tk.id = t.key_id
        WHERE tk.key = $1 AND t.language = $2 AND t.status = 'approved'
        ORDER BY t.version DESC
        LIMIT 1
      `, [key, language]);
      
      if (result.rows.length === 0) {
        // 尝试回退到默认语言
        return await this.getFallbackTranslation(key, language);
      }
      
      const translation = result.rows[0];
      
      // 缓存结果
      try {
        await redis.setex(cacheKey, this.cacheTTL, JSON.stringify(translation));
      } catch (err) {
        logger.warn('Redis cache write failed', { error: err.message });
      }
      
      return translation;
    } finally {
      client.release();
    }
  }

  /**
   * 回退翻译（当目标语言没有翻译时）
   */
  async getFallbackTranslation(key, language) {
    if (language === this.defaultLanguage) {
      return null; // 默认语言也没有，返回 null
    }
    
    // 尝试默认语言
    return await this.getTranslation(key, this.defaultLanguage);
  }

  /**
   * 批量获取翻译（用于客户端加载）
   */
  async getTranslationsByCategory(category, language) {
    const redis = getRedisClient();
    const cacheKey = `${this.cachePrefix}category:${language}:${category}`;
    
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      logger.warn('Redis cache read failed', { error: err.message });
    }
    
    const client = await getClient();
    try {
      const result = await client.query(`
        SELECT tk.key, t.content
        FROM translation_keys tk
        JOIN translations t ON t.key_id = tk.id
        WHERE tk.category = $1 
          AND t.language = $2 
          AND t.status = 'approved'
          AND tk.is_active = true
      `, [category, language]);
      
      const translations = {};
      result.rows.forEach(row => {
        translations[row.key] = row.content;
      });
      
      try {
        await redis.setex(cacheKey, this.cacheTTL, JSON.stringify(translations));
      } catch (err) {
        logger.warn('Redis cache write failed', { error: err.message });
      }
      
      return translations;
    } finally {
      client.release();
    }
  }

  /**
   * 获取所有翻译（客户端初始化）
   */
  async getAllTranslations(language) {
    const client = await getClient();
    try {
      const result = await client.query(`
        SELECT tk.key, tk.category, t.content
        FROM translation_keys tk
        LEFT JOIN translations t ON t.key_id = tk.id AND t.language = $1 AND t.status = 'approved'
        WHERE tk.is_active = true
      `, [language]);
      
      const translations = {
        pokemon: {},
        skill: {},
        item: {},
        achievement: {},
        ui: {},
        system: {}
      };
      
      result.rows.forEach(row => {
        if (row.content && translations[row.category]) {
          translations[row.category][row.key] = row.content;
        }
      });
      
      return translations;
    } finally {
      client.release();
    }
  }

  /**
   * 提交翻译
   */
  async submitTranslation(params) {
    const { keyId, language, content, translatedBy } = params;
    const client = await getClient();
    
    try {
      await client.query('BEGIN');
      
      // 获取当前版本
      const current = await client.query(`
        SELECT version, content FROM translations
        WHERE key_id = $1 AND language = $2
        ORDER BY version DESC LIMIT 1
      `, [keyId, language]);
      
      const newVersion = current.rows.length > 0 ? current.rows[0].version + 1 : 1;
      
      // 插入新翻译
      const result = await client.query(`
        INSERT INTO translations (key_id, language, content, status, translated_by, version)
        VALUES ($1, $2, $3, 'pending', $4, $5)
        RETURNING *
      `, [keyId, language, content, translatedBy, newVersion]);
      
      // 记录历史
      if (current.rows.length > 0) {
        await client.query(`
          INSERT INTO translation_history (key_id, language, old_content, new_content, changed_by)
          VALUES ($1, $2, $3, $4, $5)
        `, [keyId, language, current.rows[0].content, content, translatedBy]);
      }
      
      await client.query('COMMIT');
      
      // 清除缓存
      await this.clearTranslationCache(keyId, language);
      
      logger.info('Translation submitted', { keyId, language, version: newVersion });
      
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to submit translation', { error: error.message, keyId, language });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 审核翻译
   */
  async reviewTranslation(translationId, status, reviewedBy, reason = null) {
    const client = await getClient();
    
    try {
      await client.query('BEGIN');
      
      const result = await client.query(`
        UPDATE translations 
        SET status = $1, reviewed_by = $2, reviewed_at = NOW()
        WHERE id = $3
        RETURNING *
      `, [status, reviewedBy, translationId]);
      
      if (result.rows.length === 0) {
        throw new Error('Translation not found');
      }
      
      // 更新进度
      await this.updateProgress(result.rows[0].language);
      
      await client.query('COMMIT');
      
      // 清除缓存
      await this.clearTranslationCache(result.rows[0].key_id, result.rows[0].language);
      
      logger.info('Translation reviewed', { translationId, status, reviewedBy });
      
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to review translation', { error: error.message, translationId });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 更新翻译进度
   */
  async updateProgress(language) {
    const client = await getClient();
    
    try {
      const stats = await client.query(`
        SELECT 
          COUNT(DISTINCT tk.id) as total_keys,
          COUNT(DISTINCT CASE WHEN t.id IS NOT NULL THEN tk.id END) as translated_keys,
          COUNT(DISTINCT CASE WHEN t.status = 'approved' THEN tk.id END) as approved_keys
        FROM translation_keys tk
        LEFT JOIN translations t ON t.key_id = tk.id AND t.language = $1
        WHERE tk.is_active = true
      `, [language]);
      
      const { total_keys, translated_keys, approved_keys } = stats.rows[0];
      const completionPct = total_keys > 0 ? (approved_keys / total_keys * 100) : 0;
      
      await client.query(`
        INSERT INTO translation_progress (language, total_keys, translated_keys, approved_keys, completion_pct)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (language) DO UPDATE SET
          total_keys = EXCLUDED.total_keys,
          translated_keys = EXCLUDED.translated_keys,
          approved_keys = EXCLUDED.approved_keys,
          completion_pct = EXCLUDED.completion_pct,
          last_updated = NOW()
      `, [language, total_keys, translated_keys, approved_keys, completionPct]);
      
      logger.debug('Translation progress updated', { language, completionPct });
    } finally {
      client.release();
    }
  }

  /**
   * 获取翻译进度
   */
  async getProgress() {
    const client = await getClient();
    
    try {
      const result = await client.query(`
        SELECT language, total_keys, translated_keys, approved_keys, completion_pct, last_updated
        FROM translation_progress
        ORDER BY language
      `);
      
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * 获取缺失翻译
   */
  async getMissingTranslations(language, limit = 100, offset = 0) {
    const client = await getClient();
    
    try {
      const result = await client.query(`
        SELECT tk.id, tk.key, tk.category, tk.description, tk.context
        FROM translation_keys tk
        LEFT JOIN translations t ON t.key_id = tk.id AND t.language = $1
        WHERE tk.is_active = true
          AND (t.id IS NULL OR t.status != 'approved')
        ORDER BY tk.category, tk.key
        LIMIT $2 OFFSET $3
      `, [language, limit, offset]);
      
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * 导出语言包
   */
  async exportLanguagePack(language) {
    const client = await getClient();
    
    try {
      const result = await client.query(`
        SELECT tk.key, tk.category, t.content
        FROM translation_keys tk
        JOIN translations t ON t.key_id = tk.id
        WHERE t.language = $1 AND t.status = 'approved' AND tk.is_active = true
        ORDER BY tk.category, tk.key
      `, [language]);
      
      const languagePack = {
        language,
        exportedAt: new Date().toISOString(),
        version: '1.0.0',
        translations: {}
      };
      
      result.rows.forEach(row => {
        if (!languagePack.translations[row.category]) {
          languagePack.translations[row.category] = {};
        }
        languagePack.translations[row.category][row.key] = row.content;
      });
      
      logger.info('Language pack exported', { language, count: result.rows.length });
      
      return languagePack;
    } finally {
      client.release();
    }
  }

  /**
   * 批量导入翻译
   */
  async importTranslations(language, translations, importedBy) {
    const client = await getClient();
    const results = { success: 0, failed: 0, errors: [] };
    
    try {
      await client.query('BEGIN');
      
      for (const [key, content] of Object.entries(translations)) {
        try {
          // 获取或创建翻译键
          let keyResult = await client.query(
            'SELECT id FROM translation_keys WHERE key = $1',
            [key]
          );
          
          let keyId;
          if (keyResult.rows.length === 0) {
            // 自动创建翻译键
            const category = this.detectCategory(key);
            const insertResult = await client.query(`
              INSERT INTO translation_keys (key, category)
              VALUES ($1, $2)
              RETURNING id
            `, [key, category]);
            keyId = insertResult.rows[0].id;
          } else {
            keyId = keyResult.rows[0].id;
          }
          
          // 提交翻译
          await this.submitTranslation({
            keyId,
            language,
            content,
            translatedBy: importedBy
          });
          
          results.success++;
        } catch (err) {
          results.failed++;
          results.errors.push({ key, error: err.message });
        }
      }
      
      await client.query('COMMIT');
      
      // 更新进度
      await this.updateProgress(language);
      
      logger.info('Translations imported', { language, ...results });
      
      return results;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 检测翻译键类别
   */
  detectCategory(key) {
    if (key.startsWith('pokemon.') || key.includes('species')) return 'pokemon';
    if (key.startsWith('skill.') || key.includes('move')) return 'skill';
    if (key.startsWith('item.')) return 'item';
    if (key.startsWith('achievement.')) return 'achievement';
    if (key.startsWith('ui.')) return 'ui';
    return 'system';
  }

  /**
   * 清除翻译缓存
   */
  async clearTranslationCache(keyId, language) {
    const redis = getRedisClient();
    const client = await getClient();
    
    try {
      // 获取翻译键
      const keyResult = await client.query(
        'SELECT key, category FROM translation_keys WHERE id = $1',
        [keyId]
      );
      
      if (keyResult.rows.length > 0) {
        const { key, category } = keyResult.rows[0];
        
        // 清除单个翻译缓存
        await redis.del(`${this.cachePrefix}${language}:${key}`);
        
        // 清除分类缓存
        await redis.del(`${this.cachePrefix}category:${language}:${category}`);
      }
    } catch (err) {
      logger.warn('Failed to clear translation cache', { error: err.message });
    } finally {
      client.release();
    }
  }

  /**
   * 清除所有翻译缓存
   */
  async clearAllCache() {
    const redis = getRedisClient();
    
    try {
      const keys = await redis.keys(`${this.cachePrefix}*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      logger.info('All translation cache cleared');
    } catch (err) {
      logger.warn('Failed to clear all translation cache', { error: err.message });
    }
  }

  /**
   * 获取翻译历史
   */
  async getHistory(keyId, language, limit = 20) {
    const client = await getClient();
    
    try {
      const result = await client.query(`
        SELECT id, old_content, new_content, changed_by, change_reason, changed_at
        FROM translation_history
        WHERE key_id = $1 AND language = $2
        ORDER BY changed_at DESC
        LIMIT $3
      `, [keyId, language, limit]);
      
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * 回滚翻译版本
   */
  async rollbackTranslation(keyId, language, version, rolledBackBy) {
    const client = await getClient();
    
    try {
      await client.query('BEGIN');
      
      // 获取目标版本
      const target = await client.query(`
        SELECT content FROM translations
        WHERE key_id = $1 AND language = $2 AND version = $3
      `, [keyId, language, version]);
      
      if (target.rows.length === 0) {
        throw new Error('Target version not found');
      }
      
      // 提交新版本（内容为旧版本）
      const result = await this.submitTranslation({
        keyId,
        language,
        content: target.rows[0].content,
        translatedBy: rolledBackBy
      });
      
      await client.query('COMMIT');
      
      logger.info('Translation rolled back', { keyId, language, version });
      
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 创建翻译键
   */
  async createTranslationKey(params) {
    const { key, category, description, context } = params;
    const client = await getClient();
    
    try {
      const result = await client.query(`
        INSERT INTO translation_keys (key, category, description, context)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [key, category, description, context]);
      
      // 更新所有语言进度
      for (const lang of this.supportedLanguages) {
        await this.updateProgress(lang);
      }
      
      logger.info('Translation key created', { key, category });
      
      return result.rows[0];
    } finally {
      client.release();
    }
  }

  /**
   * 获取翻译键列表
   */
  async getTranslationKeys(filters = {}) {
    const { category, search, isActive, limit = 50, offset = 0 } = filters;
    const client = await getClient();
    
    try {
      let query = 'SELECT * FROM translation_keys WHERE 1=1';
      const params = [];
      let paramIndex = 1;
      
      if (category) {
        query += ` AND category = $${paramIndex++}`;
        params.push(category);
      }
      
      if (search) {
        query += ` AND (key ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }
      
      if (isActive !== undefined) {
        query += ` AND is_active = $${paramIndex++}`;
        params.push(isActive);
      }
      
      query += ` ORDER BY category, key LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
      params.push(limit, offset);
      
      const result = await client.query(query, params);
      
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * 批量创建翻译键
   */
  async batchCreateKeys(keys) {
    const client = await getClient();
    const results = { success: 0, failed: 0, errors: [] };
    
    try {
      await client.query('BEGIN');
      
      for (const keyData of keys) {
        try {
          await client.query(`
            INSERT INTO translation_keys (key, category, description, context)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (key) DO NOTHING
          `, [keyData.key, keyData.category, keyData.description, keyData.context]);
          
          results.success++;
        } catch (err) {
          results.failed++;
          results.errors.push({ key: keyData.key, error: err.message });
        }
      }
      
      await client.query('COMMIT');
      
      // 更新进度
      for (const lang of this.supportedLanguages) {
        await this.updateProgress(lang);
      }
      
      return results;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = new TranslationManager();
