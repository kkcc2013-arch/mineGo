/**
 * i18n Routes - 国际化文本处理 API
 * 
 * 提供智能文本截断和本地化适配服务
 * 
 * @module gateway/src/routes/i18n
 */

const express = require('express');
const router = express.Router();
const { textTruncator } = require('../../backend/shared/i18n/textTruncator');
const auth = require('../middleware/auth');
const { rateLimiter } = require('../middleware/rateLimiter');

/**
 * @api {post} /api/v1/i18n/truncate 智能文本截断
 * @apiName TruncateText
 * @apiGroup i18n
 * @apiVersion 1.0.0
 * 
 * @apiBody {string[]} texts 待截断文本数组
 * @apiBody {number} maxLength 最大长度
 * @apiBody {string} [locale=en] 语言环境
 * @apiBody {string} [ellipsis=...] 省略符
 * @apiBody {boolean} [preservePlaceholders=true] 保护占位符
 * 
 * @apiSuccess {Object[]} results 截断结果数组
 * @apiSuccess {string} results.original 原始文本
 * @apiSuccess {string} results.truncated 截断后文本
 * @apiSuccess {boolean} results.wasTruncated 是否被截断
 * @apiSuccess {string} [results.reduction] 缩减比例
 */
router.post('/truncate', auth.optional, rateLimiter({ max: 1000, windowMs: 60000 }), async (req, res) => {
  try {
    const { texts, options = {} } = req.body;
    
    if (!Array.isArray(texts) || texts.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'texts must be a non-empty array'
      });
    }
    
    if (texts.length > 100) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Maximum 100 texts per request'
      });
    }
    
    const { maxLength = 100, locale = 'en', ellipsis = '...', preservePlaceholders = true } = options;
    
    if (maxLength < 5 || maxLength > 10000) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'maxLength must be between 5 and 10000'
      });
    }
    
    const results = textTruncator.truncateBatch(texts, {
      maxLength,
      locale,
      ellipsis,
      preservePlaceholders
    });
    
    res.json({
      success: true,
      results: results.map(r => ({
        original: r.original,
        truncated: r.truncated,
        wasTruncated: r.wasTruncated,
        originalLength: r.originalLength,
        truncatedLength: r.truncatedLength,
        reduction: r.reduction,
        warnings: r.warnings
      })),
      options: { maxLength, locale, ellipsis }
    });
    
  } catch (error) {
    console.error('Truncate error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * @api {post} /api/v1/i18n/truncate/single 单文本截断
 * @apiName TruncateSingleText
 * @apiGroup i18n
 * @apiVersion 1.0.0
 */
router.post('/truncate/single', auth.optional, rateLimiter({ max: 2000, windowMs: 60000 }), async (req, res) => {
  try {
    const { text, options = {} } = req.body;
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'text is required and must be a string'
      });
    }
    
    const { maxLength = 100, locale = 'en', ellipsis = '...', preservePlaceholders = true } = options;
    
    const result = textTruncator.truncate(text, {
      maxLength,
      locale,
      ellipsis,
      preservePlaceholders
    });
    
    res.json({
      success: true,
      ...result
    });
    
  } catch (error) {
    console.error('Truncate single error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * @api {post} /api/v1/i18n/truncate/preview 截断预览
 * @apiName TruncatePreview
 * @apiGroup i18n
 * @apiVersion 1.0.0
 * 
 * @apiDescription 批量预览截断效果，用于管理后台
 */
router.post('/truncate/preview', auth.required, rateLimiter({ max: 100, windowMs: 60000 }), async (req, res) => {
  try {
    const { locale = 'en', maxLength = 50, sampleTexts = [] } = req.body;
    
    // 如果没有提供示例文本，使用默认示例
    const defaultSamples = {
      'zh': [
        '这是一段很长的中文描述文字，用于测试智能截断功能是否正常工作。',
        '欢迎来到精灵宝可梦的世界！在这里你可以捕捉各种神奇的精灵。',
        '恭喜你成功捕捉了一只传说中的精灵，它拥有强大的战斗力。'
      ],
      'en': [
        'Welcome to the Pokemon Go game! You can catch various Pokemon in the real world.',
        'Congratulations on catching a legendary Pokemon! It has powerful abilities.',
        'This is a very long text that will be truncated based on the specified maximum length.'
      ],
      'ja': [
        'ポケモンGOの世界へようこそ！このゲームでは、現実世界でポケモンを捕まえることができます。',
        '伝説のポケモンを捕まえることができました！おめでとうございます！',
        'これは指定された最大長に基づいて切り捨てられる非常に長いテキストです。'
      ]
    };
    
    const texts = sampleTexts.length > 0 ? sampleTexts : (defaultSamples[locale] || defaultSamples['en']);
    
    const preview = textTruncator.getPreview(locale, maxLength, texts);
    
    res.json({
      success: true,
      preview
    });
    
  } catch (error) {
    console.error('Preview error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * @api {get} /api/v1/i18n/truncate/languages 获取支持的语言列表
 * @apiName GetSupportedLanguages
 * @apiGroup i18n
 * @apiVersion 1.0.0
 */
router.get('/truncate/languages', async (req, res) => {
  const supportedLanguages = [
    { code: 'zh', name: 'Chinese', nameNative: '中文' },
    { code: 'en', name: 'English', nameNative: 'English' },
    { code: 'ja', name: 'Japanese', nameNative: '日本語' },
    { code: 'ko', name: 'Korean', nameNative: '한국어' },
    { code: 'de', name: 'German', nameNative: 'Deutsch' },
    { code: 'fr', name: 'French', nameNative: 'Français' },
    { code: 'es', name: 'Spanish', nameNative: 'Español' },
    { code: 'ar', name: 'Arabic', nameNative: 'العربية' },
    { code: 'th', name: 'Thai', nameNative: 'ไทย' },
    { code: 'ru', name: 'Russian', nameNative: 'Русский' }
  ];
  
  res.json({
    success: true,
    languages: supportedLanguages,
    count: supportedLanguages.length
  });
});

/**
 * @api {post} /api/v1/i18n/truncate/auto 自动检测语言并截断
 * @apiName AutoTruncate
 * @apiGroup i18n
 * @apiVersion 1.0.0
 */
router.post('/truncate/auto', auth.optional, rateLimiter({ max: 1000, windowMs: 60000 }), async (req, res) => {
  try {
    const { text, maxLength = 100 } = req.body;
    
    if (!text || typeof text !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'text is required'
      });
    }
    
    const result = textTruncator.autoTruncate(text, maxLength);
    
    res.json({
      success: true,
      ...result,
      detectedLocale: textTruncator.detectLocale(text)
    });
    
  } catch (error) {
    console.error('Auto truncate error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;