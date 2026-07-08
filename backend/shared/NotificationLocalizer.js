// backend/shared/NotificationLocalizer.js
// REQ-00496: 推送通知内容多语言本地化与智能语言适配系统
'use strict';

const { createLogger } = require('./logger');
const logger = createLogger('NotificationLocalizer');

const DEFAULT_LANGUAGE = 'zh-CN';
const FALLBACK_LANGUAGE = 'en-US';
const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'];

class NotificationLocalizer {
  /**
   * @param {Pool} db - PostgreSQL connection pool
   * @param {Object} redis - Redis client instance
   */
  constructor(db, redis = null) {
    this.db = db;
    this.redis = redis;
    this.templateCache = new Map();
    this.userLanguageCache = new Map();
    // 内存缓存 TTL（5分钟）
    this.cacheTTLMs = 5 * 60 * 1000;
  }

  /**
   * 获取用户通知语言
   * @param {string} userId - 用户ID
   * @returns {Promise<string>} 语言代码
   */
  async getUserNotificationLanguage(userId) {
    // 1. 检查内存缓存
    const memCached = this.userLanguageCache.get(userId);
    if (memCached && Date.now() - memCached.timestamp < this.cacheTTLMs) {
      return memCached.language;
    }

    // 2. 检查 Redis 缓存
    if (this.redis) {
      try {
        const redisCached = await this.redis.get(`notif_lang:${userId}`);
        if (redisCached) {
          this.userLanguageCache.set(userId, { language: redisCached, timestamp: Date.now() });
          return redisCached;
        }
      } catch (err) {
        logger.warn({ module: 'getUserNotificationLanguage', userId, error: err.message }, 'Redis cache read failed');
      }
    }

    // 3. 查询数据库
    let language = DEFAULT_LANGUAGE;
    let source = 'default';

    try {
      // 3.1 先查缓存表
      const { rows: [cached] } = await this.db.query(
        'SELECT language, language_source FROM user_notification_language_cache WHERE user_id = $1',
        [userId]
      );

      if (cached?.language) {
        language = cached.language;
        source = cached.language_source || 'cache';
      } else {
        // 3.2 查询用户表
        const { rows: [user] } = await this.db.query(
          'SELECT language_preference FROM users WHERE id = $1',
          [userId]
        );

        if (user?.language_preference && SUPPORTED_LANGUAGES.includes(user.language_preference)) {
          language = user.language_preference;
          source = 'preference';
        }

        // 更新缓存表
        await this.db.query(
          `INSERT INTO user_notification_language_cache (user_id, language, language_source)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO UPDATE 
           SET language = $2, language_source = $3, updated_at = NOW()`,
          [userId, language, source]
        );
      }
    } catch (err) {
      logger.error({ module: 'getUserNotificationLanguage', userId, error: err.message }, 'Database query failed');
    }

    // 4. 更新缓存
    this.userLanguageCache.set(userId, { language, timestamp: Date.now() });

    if (this.redis) {
      try {
        await this.redis.setex(`notif_lang:${userId}`, 3600, language);
      } catch (err) {
        logger.warn({ module: 'getUserNotificationLanguage', userId, error: err.message }, 'Redis cache write failed');
      }
    }

    return language;
  }

  /**
   * 根据模板生成多语言通知
   * @param {string} templateKey - 模板键
   * @param {Object} variables - 变量值
   * @param {string} userId - 目标用户ID
   * @returns {Promise<Object>} 本地化后的通知内容
   */
  async localizeNotification(templateKey, variables = {}, userId) {
    const language = await this.getUserNotificationLanguage(userId);
    const template = await this.getTemplate(templateKey, language);

    if (!template) {
      // 回退到默认语言
      const fallbackTemplate = await this.getTemplate(templateKey, FALLBACK_LANGUAGE);
      if (!fallbackTemplate) {
        // 回退到中文
        const defaultTemplate = await this.getTemplate(templateKey, DEFAULT_LANGUAGE);
        if (!defaultTemplate) {
          logger.warn({ module: 'localizeNotification', templateKey, language }, 'Template not found');
          return this.generateDefaultNotification(templateKey, variables);
        }
        return this.fillTemplate(defaultTemplate, variables);
      }
      return this.fillTemplate(fallbackTemplate, variables);
    }

    return this.fillTemplate(template, variables);
  }

  /**
   * 获取模板（带缓存）
   */
  async getTemplate(templateKey, language) {
    const cacheKey = `${templateKey}:${language}`;

    // 1. 内存缓存
    const memCached = this.templateCache.get(cacheKey);
    if (memCached && Date.now() - memCached.timestamp < this.cacheTTLMs) {
      return memCached.template;
    }

    // 2. Redis 缓存
    if (this.redis) {
      try {
        const redisCached = await this.redis.get(`template:${cacheKey}`);
        if (redisCached) {
          const parsed = JSON.parse(redisCached);
          this.templateCache.set(cacheKey, { template: parsed, timestamp: Date.now() });
          return parsed;
        }
      } catch (err) {
        logger.warn({ module: 'getTemplate', templateKey, language, error: err.message }, 'Redis cache read failed');
      }
    }

    // 3. 数据库查询
    try {
      const { rows } = await this.db.query(`
        SELECT t.template_key, t.category, t.priority, t.variables,
               c.title_template, c.body_template, c.action_text, c.cultural_variant
        FROM notification_templates t
        JOIN notification_template_contents c ON t.id = c.template_id
        WHERE t.template_key = $1 AND c.language = $2
      `, [templateKey, language]);

      if (rows.length === 0) return null;

      const template = rows[0];
      this.templateCache.set(cacheKey, { template, timestamp: Date.now() });

      if (this.redis) {
        try {
          await this.redis.setex(`template:${cacheKey}`, 86400, JSON.stringify(template));
        } catch (err) {
          logger.warn({ module: 'getTemplate', templateKey, language, error: err.message }, 'Redis cache write failed');
        }
      }

      return template;
    } catch (err) {
      logger.error({ module: 'getTemplate', templateKey, language, error: err.message }, 'Database query failed');
      return null;
    }
  }

  /**
   * 填充模板变量
   */
  fillTemplate(template, variables) {
    let title = template.title_template || '';
    let body = template.body_template || '';
    let actionText = template.action_text || '查看';

    // 替换变量
    for (const [key, value] of Object.entries(variables)) {
      const stringValue = String(value ?? '');
      title = title.replace(new RegExp(`{{${key}}}`, 'g'), stringValue);
      body = body.replace(new RegExp(`{{${key}}}`, 'g'), stringValue);
    }

    return {
      title,
      body,
      actionText,
      category: template.category,
      priority: template.priority,
      templateKey: template.template_key
    };
  }

  /**
   * 批量本地化（支持不同语言的用户）
   */
  async batchLocalize(templateKey, variables, userIds) {
    if (!userIds || userIds.length === 0) {
      return {};
    }

    // 获取所有用户的语言
    const languages = await Promise.all(
      userIds.map(userId => this.getUserNotificationLanguage(userId))
    );

    // 按语言分组
    const groupedByLanguage = {};
    userIds.forEach((userId, i) => {
      const lang = languages[i];
      if (!groupedByLanguage[lang]) groupedByLanguage[lang] = [];
      groupedByLanguage[lang].push(userId);
    });

    // 获取各语言模板
    const templates = {};
    for (const lang of Object.keys(groupedByLanguage)) {
      templates[lang] = await this.getTemplate(templateKey, lang);
      // 回退处理
      if (!templates[lang]) {
        templates[lang] = await this.getTemplate(templateKey, FALLBACK_LANGUAGE) ||
          await this.getTemplate(templateKey, DEFAULT_LANGUAGE);
      }
    }

    // 生成本地化内容
    const results = {};
    for (const [lang, users] of Object.entries(groupedByLanguage)) {
      const template = templates[lang];
      if (template) {
        results[lang] = {
          content: this.fillTemplate(template, variables),
          userIds: users
        };
      } else {
        // 无模板时使用默认通知
        results[lang] = {
          content: this.generateDefaultNotification(templateKey, variables),
          userIds: users
        };
      }
    }

    return results;
  }

  /**
   * 生成默认通知（无模板时）
   */
  generateDefaultNotification(templateKey, variables) {
    // 尝试从变量构建一个基本通知
    const keys = Object.keys(variables);
    let body = keys.map(k => `${k}: ${variables[k]}`).join(', ');
    
    return {
      title: templateKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      body: body || '您有一条新通知',
      actionText: '查看',
      category: 'system',
      priority: 'normal',
      templateKey
    };
  }

  /**
   * 更新用户语言偏好
   */
  async updateUserLanguage(userId, language, source = 'preference') {
    if (!SUPPORTED_LANGUAGES.includes(language)) {
      language = DEFAULT_LANGUAGE;
    }

    try {
      await this.db.query(
        `INSERT INTO user_notification_language_cache (user_id, language, language_source)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE 
         SET language = $2, language_source = $3, updated_at = NOW()`,
        [userId, language, source]
      );

      // 更新缓存
      this.userLanguageCache.set(userId, { language, timestamp: Date.now() });

      if (this.redis) {
        await this.redis.setex(`notif_lang:${userId}`, 3600, language);
      }

      logger.info({ module: 'updateUserLanguage', userId, language, source }, 'User language updated');
      return true;
    } catch (err) {
      logger.error({ module: 'updateUserLanguage', userId, language, error: err.message }, 'Failed to update user language');
      return false;
    }
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this.templateCache.clear();
    this.userLanguageCache.clear();
  }

  /**
   * 获取支持的 languages
   */
  getSupportedLanguages() {
    return [...SUPPORTED_LANGUAGES];
  }

  /**
   * 获取默认语言
   */
  getDefaultLanguage() {
    return DEFAULT_LANGUAGE;
  }

  /**
   * 获取回退语言
   */
  getFallbackLanguage() {
    return FALLBACK_LANGUAGE;
  }
}

/**
 * 工厂函数
 */
function createNotificationLocalizer(db, redis = null) {
  return new NotificationLocalizer(db, redis);
}

/**
 * Express 中间件：自动附加本地化信息到请求
 */
function localizationMiddleware(localizer) {
  return async (req, res, next) => {
    if (req.user?.sub) {
      try {
        req.notificationLanguage = await localizer.getUserNotificationLanguage(req.user.sub);
      } catch (err) {
        req.notificationLanguage = DEFAULT_LANGUAGE;
      }
    }

    req.localizer = localizer;
    next();
  };
}

module.exports = {
  NotificationLocalizer,
  createNotificationLocalizer,
  localizationMiddleware,
  DEFAULT_LANGUAGE,
  FALLBACK_LANGUAGE,
  SUPPORTED_LANGUAGES
};