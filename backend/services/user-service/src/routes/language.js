// user-service/src/routes/language.js - REQ-00393 动态语言切换无需重新登录系统
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../../../../shared/db');
const redis = require('../../../../shared/redis');
const EventBus = require('../../../../shared/EventBus');
const { createLogger } = require('../../../../shared/logger');
const { verifyAccess } = require('../../../../shared/auth');

const logger = createLogger('user-service:language');

// 支持的语言列表
const VALID_LANGUAGES = ['zh', 'en', 'ja'];

// 缓存配置
const CACHE_PREFIX = 'user:lang:';
const CACHE_TTL = 3600; // 1小时

/**
 * 获取用户当前语言偏好
 * GET /language
 */
router.get('/', verifyAccess, async (req, res) => {
  const userId = req.user.id;
  
  try {
    // 先查缓存
    const cachedLanguage = await redis.get(`${CACHE_PREFIX}${userId}`);
    
    if (cachedLanguage) {
      return res.json({
        language: cachedLanguage,
        source: 'cache',
        supportedLanguages: VALID_LANGUAGES
      });
    }
    
    // 查数据库
    const result = await db.query(
      `SELECT language, language_updated_at FROM users WHERE id = $1`,
      [userId]
    );
    
    const language = result.rows[0]?.language || 'en'; // 默认英文
    
    // 写入缓存
    await redis.set(`${CACHE_PREFIX}${userId}`, language, 'EX', CACHE_TTL);
    
    res.json({
      language,
      updatedAt: result.rows[0]?.language_updated_at,
      source: 'database',
      supportedLanguages: VALID_LANGUAGES
    });
    
  } catch (error) {
    logger.error('获取用户语言失败', { userId, error });
    res.status(500).json({
      error: '获取语言失败',
      code: 'LANGUAGE_FETCH_ERROR'
    });
  }
});

/**
 * 更新用户语言偏好（无需重新登录）
 * PUT /language
 */
router.put('/', verifyAccess, async (req, res) => {
  const userId = req.user.id;
  const { language } = req.body;
  
  // 验证语言有效性
  if (!VALID_LANGUAGES.includes(language)) {
    return res.status(400).json({
      error: '无效的语言代码',
      code: 'INVALID_LANGUAGE',
      supportedLanguages: VALID_LANGUAGES
    });
  }
  
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    
    // 获取当前语言
    const currentResult = await client.query(
      `SELECT language FROM users WHERE id = $1`,
      [userId]
    );
    const previousLanguage = currentResult.rows[0]?.language || 'en';
    
    // 更新数据库
    await client.query(
      `UPDATE users SET language = $1, language_updated_at = NOW() WHERE id = $2`,
      [language, userId]
    );
    
    // 更新 Redis 缓存
    await redis.set(`${CACHE_PREFIX}${userId}`, language, 'EX', CACHE_TTL);
    
    // 更新会话中的语言（保持登录状态）
    await updateSessionLanguage(userId, language);
    
    // 发布语言变更事件到 Kafka
    await EventBus.publish('user-language-changed', {
      userId,
      language,
      previousLanguage,
      timestamp: Date.now(),
      source: 'user_request'
    });
    
    await client.query('COMMIT');
    
    // 返回新语言的欢迎消息
    const welcomeMessages = {
      zh: '语言已切换为中文',
      en: 'Language switched to English',
      ja: '言語が日本語に切り替わりました'
    };
    
    logger.info('用户语言已更新', { userId, previousLanguage, newLanguage: language });
    
    res.json({
      success: true,
      language,
      previousLanguage,
      message: welcomeMessages[language],
      sessionPreserved: true
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('更新用户语言失败', { userId, language, error });
    res.status(500).json({
      error: '语言切换失败',
      code: 'LANGUAGE_UPDATE_ERROR'
    });
  } finally {
    client.release();
  }
});

/**
 * 更新会话语言（保持登录状态）
 */
async function updateSessionLanguage(userId, language) {
  try {
    // 获取所有活跃会话
    const sessionKeys = await redis.keys(`session:*:${userId}`);
    
    for (const sessionKey of sessionKeys) {
      const sessionData = await redis.get(sessionKey);
      if (sessionData) {
        const session = JSON.parse(sessionData);
        session.language = language;
        session.languageUpdatedAt = Date.now();
        
        // 保持原有 TTL
        const ttl = await redis.ttl(sessionKey);
        await redis.set(sessionKey, JSON.stringify(session), 'EX', ttl > 0 ? ttl : 3600);
      }
    }
    
    // 更新 JWT token 中的语言信息（通过 Redis）
    await redis.hset(`user:sessionMeta:${userId}`, 'language', language);
    
    logger.debug('会话语言已更新', { userId, language, sessionCount: sessionKeys.length });
    
  } catch (error) {
    logger.error('更新会话语言失败', { userId, language, error });
    // 不抛出错误，允许继续执行
  }
}

/**
 * 批量更新用户语言（管理员接口）
 * POST /language/batch
 */
router.post('/batch', verifyAccess, async (req, res) => {
  // 检查管理员权限
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      error: '需要管理员权限',
      code: 'ADMIN_ACCESS_REQUIRED'
    });
  }
  
  const { userIds, language } = req.body;
  
  if (!VALID_LANGUAGES.includes(language) || !Array.isArray(userIds)) {
    return res.status(400).json({
      error: '参数无效',
      code: 'INVALID_PARAMETERS'
    });
  }
  
  try {
    const results = [];
    
    for (const userId of userIds) {
      try {
        // 更新数据库
        await db.query(
          `UPDATE users SET language = $1, language_updated_at = NOW() WHERE id = $2`,
          [language, userId]
        );
        
        // 更新缓存
        await redis.set(`${CACHE_PREFIX}${userId}`, language, 'EX', CACHE_TTL);
        
        // 发布事件
        await EventBus.publish('user-language-changed', {
          userId,
          language,
          timestamp: Date.now(),
          source: 'admin_batch'
        });
        
        results.push({ userId, success: true });
        
      } catch (error) {
        results.push({ userId, success: false, error: error.message });
      }
    }
    
    res.json({
      success: true,
      language,
      processed: userIds.length,
      results
    });
    
  } catch (error) {
    logger.error('批量更新语言失败', { language, userIds, error });
    res.status(500).json({
      error: '批量更新失败',
      code: 'BATCH_LANGUAGE_UPDATE_ERROR'
    });
  }
});

/**
 * 获取语言使用统计（管理员接口）
 * GET /language/stats
 */
router.get('/stats', verifyAccess, async (req, res) => {
  // 检查管理员权限
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      error: '需要管理员权限',
      code: 'ADMIN_ACCESS_REQUIRED'
    });
  }
  
  try {
    const result = await db.query(`
      SELECT 
        language,
        COUNT(*) as user_count,
        COUNT(*) FILTER (WHERE language_updated_at > NOW() - INTERVAL '24 hours') as recent_changes
      FROM users
      GROUP BY language
      ORDER BY user_count DESC
    `);
    
    const total = result.rows.reduce((sum, row) => sum + parseInt(row.user_count), 0);
    
    res.json({
      stats: result.rows,
      total,
      supportedLanguages: VALID_LANGUAGES,
      defaultLanguage: 'en'
    });
    
  } catch (error) {
    logger.error('获取语言统计失败', { error });
    res.status(500).json({
      error: '获取统计失败',
      code: 'LANGUAGE_STATS_ERROR'
    });
  }
});

/**
 * 语言偏好推送接口（供其他服务调用）
 * POST /language/notify
 */
router.post('/notify', async (req, res) => {
  const { userId, targetService } = req.body;
  
  try {
    // 获取用户当前语言
    const language = await redis.get(`${CACHE_PREFIX}${userId}`);
    
    if (!language) {
      const result = await db.query(
        `SELECT language FROM users WHERE id = $1`,
        [userId]
      );
      language = result.rows[0]?.language || 'en';
      await redis.set(`${CACHE_PREFIX}${userId}`, language, 'EX', CACHE_TTL);
    }
    
    // 推送给目标服务
    await EventBus.publish('language-sync', {
      userId,
      language,
      targetService,
      timestamp: Date.now()
    });
    
    res.json({
      success: true,
      userId,
      language,
      targetService
    });
    
  } catch (error) {
    logger.error('语言通知失败', { userId, targetService, error });
    res.status(500).json({
      error: '通知失败',
      code: 'LANGUAGE_NOTIFY_ERROR'
    });
  }
});

module.exports = router;