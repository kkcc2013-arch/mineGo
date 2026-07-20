// backend/gateway/src/routes/i18n.js
// REQ-00294: 国际化 API 路由

'use strict';

const express = require('express');
const router = express.Router();
const TranslationCache = require('../../../shared/i18n/translationCache');
const coverageMonitor = require('../../../shared/i18n/coverageMonitor');
const machineTranslation = require('../../../shared/i18n/machineTranslation');
const RegionalAdapter = require('../../../shared/i18n/regionalAdapter');
const { authenticate: authMiddleware } = require('../middleware/auth');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('i18n-routes');
const translationCache = new TranslationCache();
const regionalAdapter = new RegionalAdapter();

/**
 * 获取翻译数据
 * GET /api/v1/i18n/translations/:locale
 */
router.get('/translations/:locale', async (req, res) => {
  try {
    const { locale } = req.params;
    const { version } = req.query;
    
    // 验证 locale
    const supportedLocales = ['zh-CN', 'zh-TW', 'en-US', 'en-GB', 'ja-JP'];
    if (!supportedLocales.includes(locale)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_LOCALE',
          message: `Unsupported locale: ${locale}`,
          supportedLocales
        }
      });
    }
    
    const translations = await translationCache.loadTranslations(locale);
    
    // 如果客户端版本一致，返回 304
    if (version && version === translations.version) {
      return res.status(304).send();
    }
    
    res.json({
      success: true,
      locale,
      data: translations.data,
      version: translations.version,
      stats: translations.stats
    });
  } catch (error) {
    logger.error({ error }, 'Failed to load translations');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to load translations' }
    });
  }
});

/**
 * 热更新翻译
 * POST /api/v1/i18n/translations/reload
 * 管理员接口
 */
router.post('/translations/reload', authMiddleware, async (req, res) => {
  try {
    const { locale, keys } = req.body;
    
    const translations = await translationCache.hotReload(locale, keys);
    
    logger.info({ locale, keys }, 'Translations hot reload');
    
    res.json({
      success: true,
      locale,
      data: translations.data,
      version: translations.version
    });
  } catch (error) {
    logger.error({ error }, 'Failed to reload translations');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to reload translations' }
    });
  }
});

/**
 * 翻译覆盖率报告
 * GET /api/v1/i18n/coverage
 */
router.get('/coverage', async (req, res) => {
  try {
    const report = await coverageMonitor.generateCoverageReport();
    res.json({
      success: true,
      report
    });
  } catch (error) {
    logger.error({ error }, 'Failed to generate coverage report');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to generate coverage report' }
    });
  }
});

/**
 * 提交翻译反馈
 * POST /api/v1/i18n/feedback
 */
router.post('/feedback', authMiddleware, async (req, res) => {
  try {
    const { locale, key, rating, comment } = req.body;
    
    // 验证评分
    if (rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_RATING', message: 'Rating must be between 1 and 5' }
      });
    }
    
    await coverageMonitor.collectFeedback(
      req.user.id,
      locale,
      key,
      rating,
      comment
    );
    
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Failed to collect feedback');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to collect feedback' }
    });
  }
});

/**
 * 机器翻译接口
 * POST /api/v1/i18n/translate
 */
router.post('/translate', async (req, res) => {
  try {
    const { text, sourceLocale, targetLocale } = req.body;
    
    if (!text || !sourceLocale || !targetLocale) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_PARAMS', message: 'text, sourceLocale, targetLocale required' }
      });
    }
    
    const result = await machineTranslation.translate(text, sourceLocale, targetLocale);
    
    res.json({
      success: true,
      result
    });
  } catch (error) {
    logger.error({ error }, 'Failed to translate');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

/**
 * 批量翻译
 * POST /api/v1/i18n/translate/batch
 */
router.post('/translate/batch', async (req, res) => {
  try {
    const { texts, sourceLocale, targetLocale } = req.body;
    
    if (!texts || !Array.isArray(texts)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_TEXTS', message: 'texts must be an array' }
      });
    }
    
    const results = await machineTranslation.batchTranslate(texts, sourceLocale, targetLocale);
    
    res.json({
      success: true,
      results
    });
  } catch (error) {
    logger.error({ error }, 'Failed to batch translate');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

/**
 * 区域化格式化接口
 * POST /api/v1/i18n/format
 */
router.post('/format', async (req, res) => {
  try {
    const { type, value, locale, options } = req.body;
    
    let result;
    
    switch (type) {
      case 'datetime':
        result = regionalAdapter.formatDateTime(value, locale, options);
        break;
      case 'number':
        result = regionalAdapter.formatNumber(value, locale, options);
        break;
      case 'currency':
        result = regionalAdapter.formatCurrency(value, locale, options);
        break;
      case 'relativeTime':
        result = regionalAdapter.formatRelativeTime(value, locale);
        break;
      case 'list':
        result = regionalAdapter.formatList(value, locale);
        break;
      default:
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_TYPE', message: 'Invalid format type' }
        });
    }
    
    res.json({
      success: true,
      result
    });
  } catch (error) {
    logger.error({ error }, 'Failed to format');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

/**
 * 获取支持的语言列表
 * GET /api/v1/i18n/locales
 */
router.get('/locales', (req, res) => {
  const supportedLocales = ['zh-CN', 'zh-TW', 'en-US', 'en-GB', 'ja-JP'];
  
  const localeInfo = {
    'zh-CN': { name: '简体中文', nativeName: '简体中文', timezone: 'Asia/Shanghai' },
    'zh-TW': { name: '繁體中文', nativeName: '繁體中文', timezone: 'Asia/Taipei' },
    'en-US': { name: 'English (US)', nativeName: 'English', timezone: 'America/New_York' },
    'en-GB': { name: 'English (UK)', nativeName: 'English', timezone: 'Europe/London' },
    'ja-JP': { name: 'Japanese', nativeName: '日本語', timezone: 'Asia/Tokyo' }
  };
  
  res.json({
    success: true,
    locales: supportedLocales,
    info: localeInfo
  });
});

/**
 * 获取机器翻译提供商状态
 * GET /api/v1/i18n/translate/providers
 */
router.get('/translate/providers', (req, res) => {
  const status = machineTranslation.getProviderStatus();
  res.json({
    success: true,
    providers: status
  });
});

/**
 * 获取翻译质量统计
 * GET /api/v1/i18n/quality/:locale
 */
router.get('/quality/:locale', async (req, res) => {
  try {
    const { locale } = req.params;
    const { range } = req.query;
    
    const stats = await coverageMonitor.getQualityStats(locale, range || '7d');
    
    res.json({
      success: true,
      locale,
      stats
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get quality stats');
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get quality stats' }
    });
  }
});

module.exports = router;