'use strict';

/**
 * 翻译 API 路由
 * REQ-00551: 跨语言实时聊天翻译系统
 */

const express = require('express');
const router = express.Router();
const RealtimeTranslationEngine = require('../../../shared/ai/realtimeTranslationEngine');
const { createLogger } = require('../../../shared/logger');
const { authMiddleware } = require('../../../shared/auth');
const { rateLimiter } = require('../../../shared/rateLimiter');

const logger = createLogger('translation-routes');

// 翻译引擎实例
let translationEngine = null;

/**
 * 初始化翻译引擎
 */
function initTranslationEngine(config) {
  if (!translationEngine) {
    translationEngine = new RealtimeTranslationEngine(config);
    logger.info('Translation engine initialized');
  }
  return translationEngine;
}

/**
 * POST /api/v1/translation/translate
 * 翻译文本
 */
router.post('/translate', 
  authMiddleware,
  rateLimiter({ windowMs: 60000, max: 100 }), // 每分钟最多 100 次
  async (req, res) => {
    try {
      const { text, targetLanguage, sourceLanguage } = req.body;

      // 参数验证
      if (!text || !targetLanguage) {
        return res.status(400).json({
          success: false,
          error: 'MISSING_PARAMETERS',
          message: 'text and targetLanguage are required'
        });
      }

      if (text.length > 5000) {
        return res.status(400).json({
          success: false,
          error: 'TEXT_TOO_LONG',
          message: 'Text exceeds maximum length of 5000 characters'
        });
      }

      logger.debug('Translation request', {
        userId: req.user.id,
        textLength: text.length,
        targetLanguage,
        sourceLanguage: sourceLanguage || 'auto'
      });

      const translation = await translationEngine.translate(text, targetLanguage, {
        sourceLang: sourceLanguage || 'auto'
      });

      res.json({
        success: true,
        data: {
          translatedText: translation.translatedText,
          sourceLanguage: translation.sourceLanguage,
          targetLanguage,
          cached: translation.cached,
          engine: translation.engine,
          latencyMs: translation.latencyMs
        }
      });

    } catch (error) {
      logger.error({ error: error.message }, 'Translation request failed');
      res.status(500).json({
        success: false,
        error: 'TRANSLATION_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * POST /api/v1/translation/batch
 * 批量翻译
 */
router.post('/batch',
  authMiddleware,
  rateLimiter({ windowMs: 60000, max: 20 }), // 每分钟最多 20 次
  async (req, res) => {
    try {
      const { messages, targetLanguage } = req.body;

      // 参数验证
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_MESSAGES',
          message: 'messages must be a non-empty array'
        });
      }

      if (messages.length > 50) {
        return res.status(400).json({
          success: false,
          error: 'TOO_MANY_MESSAGES',
          message: 'Maximum 50 messages per batch'
        });
      }

      if (!targetLanguage) {
        return res.status(400).json({
          success: false,
          error: 'MISSING_TARGET_LANGUAGE',
          message: 'targetLanguage is required'
        });
      }

      logger.debug('Batch translation request', {
        userId: req.user.id,
        messageCount: messages.length,
        targetLanguage
      });

      const translations = await translationEngine.batchTranslate(messages, targetLanguage);

      res.json({
        success: true,
        data: {
          translations,
          count: translations.length
        }
      });

    } catch (error) {
      logger.error({ error: error.message }, 'Batch translation failed');
      res.status(500).json({
        success: false,
        error: 'BATCH_TRANSLATION_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * GET /api/v1/translation/terms
 * 获取游戏术语词典
 */
router.get('/terms',
  authMiddleware,
  async (req, res) => {
    try {
      const { category, language } = req.query;

      // 从数据库查询术语
      const db = req.app.locals.db;
      let query = 'SELECT term_key, source_term, translations, category FROM game_term_dictionary';
      const conditions = [];
      const params = [];

      if (language) {
        conditions.push('source_language = $' + (params.length + 1));
        params.push(language);
      }

      if (category) {
        conditions.push('category = $' + (params.length + 1));
        params.push(category);
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      const result = await db.query(query, params);

      res.json({
        success: true,
        data: {
          terms: result.rows,
          count: result.rows.length
        }
      });

    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get game terms');
      res.status(500).json({
        success: false,
        error: 'DATABASE_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * POST /api/v1/translation/feedback
 * 提交翻译质量反馈
 */
router.post('/feedback',
  authMiddleware,
  async (req, res) => {
    try {
      const { messageId, rating, suggestedTranslation, issueType } = req.body;

      // 参数验证
      if (!messageId || !rating) {
        return res.status(400).json({
          success: false,
          error: 'MISSING_PARAMETERS',
          message: 'messageId and rating are required'
        });
      }

      if (rating < 1 || rating > 5) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_RATING',
          message: 'rating must be between 1 and 5'
        });
      }

      const db = req.app.locals.db;
      
      // 插入反馈记录
      await db.query(`
        INSERT INTO translation_feedback 
          (message_id, user_id, rating, suggested_translation, issue_type, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [messageId, req.user.id, rating, suggestedTranslation, issueType]);

      logger.info('Translation feedback received', {
        userId: req.user.id,
        messageId,
        rating,
        issueType
      });

      res.json({
        success: true,
        message: 'Feedback submitted successfully'
      });

    } catch (error) {
      logger.error({ error: error.message }, 'Failed to submit feedback');
      res.status(500).json({
        success: false,
        error: 'DATABASE_ERROR',
        message: error.message
      });
    }
  }
);

/**
 * GET /api/v1/translation/stats
 * 获取翻译用量统计（管理员）
 */
router.get('/stats',
  authMiddleware,
  async (req, res) => {
    try {
      // 检查管理员权限
      if (!req.user.isAdmin) {
        return res.status(403).json({
          success: false,
          error: 'FORBIDDEN',
          message: 'Admin access required'
        });
      }

      const { date, startDate, endDate } = req.query;
      const db = req.app.locals.db;

      let query = `
        SELECT 
          date,
          source_language,
          target_language,
          SUM(message_count) as total_messages,
          SUM(character_count) as total_characters,
          SUM(api_calls) as total_api_calls,
          SUM(cache_hits) as total_cache_hits,
          AVG(avg_latency_ms) as avg_latency,
          SUM(cost_usd) as total_cost
        FROM translation_usage_stats
      `;

      const conditions = [];
      const params = [];

      if (date) {
        conditions.push('date = $' + (params.length + 1));
        params.push(date);
      } else if (startDate && endDate) {
        conditions.push('date BETWEEN $' + (params.length + 1) + ' AND $' + (params.length + 2));
        params.push(startDate, endDate);
      } else {
        // 默认最近 7 天
        conditions.push('date >= CURRENT_DATE - INTERVAL \'7 days\'');
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      query += ' GROUP BY date, source_language, target_language ORDER BY date DESC';

      const result = await db.query(query, params);

      // 计算缓存命中率
      const stats = result.rows.map(row => ({
        ...row,
        cache_hit_rate: row.total_api_calls > 0 
          ? (row.total_cache_hits / row.total_api_calls * 100).toFixed(2) + '%'
          : '0%'
      }));

      res.json({
        success: true,
        data: {
          stats,
          count: stats.length
        }
      });

    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get translation stats');
      res.status(500).json({
        success: false,
        error: 'DATABASE_ERROR',
        message: error.message
      });
    }
  }
);

module.exports = {
  router,
  initTranslationEngine
};