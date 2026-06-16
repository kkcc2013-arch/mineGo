/**
 * 翻译管理路由
 * REQ-00137: 游戏内容本地化内容管理与翻译工作流系统
 */

const express = require('express');
const router = express.Router();
const translationManager = require('../shared/TranslationManager');
const { authenticate, requireAdmin } = require('../shared/auth');
const logger = require('../shared/logger');

/**
 * 获取所有翻译（客户端初始化）
 * GET /api/translations/load/:language
 */
router.get('/load/:language', async (req, res) => {
  try {
    const { language } = req.params;
    
    if (!['zh-CN', 'en-US', 'ja-JP'].includes(language)) {
      return res.status(400).json({ error: 'Unsupported language' });
    }
    
    const translations = await translationManager.getAllTranslations(language);
    
    res.json(translations);
  } catch (error) {
    logger.error('Failed to load translations', { error: error.message });
    res.status(500).json({ error: 'Failed to load translations' });
  }
});

/**
 * 获取分类翻译
 * GET /api/translations/category/:language/:category
 */
router.get('/category/:language/:category', async (req, res) => {
  try {
    const { language, category } = req.params;
    
    const translations = await translationManager.getTranslationsByCategory(category, language);
    
    res.json(translations);
  } catch (error) {
    logger.error('Failed to load category translations', { error: error.message });
    res.status(500).json({ error: 'Failed to load translations' });
  }
});

/**
 * 获取单个翻译
 * GET /api/translations/:key/:language
 */
router.get('/:key/:language', async (req, res) => {
  try {
    const { key, language } = req.params;
    
    const translation = await translationManager.getTranslation(key, language);
    
    if (!translation) {
      return res.status(404).json({ error: 'Translation not found' });
    }
    
    res.json(translation);
  } catch (error) {
    logger.error('Failed to get translation', { error: error.message });
    res.status(500).json({ error: 'Failed to get translation' });
  }
});

// ============ 管理接口（需要认证） ============

/**
 * 获取翻译键列表
 * GET /api/translations/keys
 */
router.get('/keys', authenticate, requireAdmin, async (req, res) => {
  try {
    const { category, search, isActive, limit, offset } = req.query;
    
    const keys = await translationManager.getTranslationKeys({
      category,
      search,
      isActive: isActive === 'true',
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0
    });
    
    res.json(keys);
  } catch (error) {
    logger.error('Failed to get translation keys', { error: error.message });
    res.status(500).json({ error: 'Failed to get translation keys' });
  }
});

/**
 * 创建翻译键
 * POST /api/translations/keys
 */
router.post('/keys', authenticate, requireAdmin, async (req, res) => {
  try {
    const { key, category, description, context } = req.body;
    
    if (!key || !category) {
      return res.status(400).json({ error: 'Key and category are required' });
    }
    
    const result = await translationManager.createTranslationKey({
      key,
      category,
      description,
      context
    });
    
    res.status(201).json(result);
  } catch (error) {
    logger.error('Failed to create translation key', { error: error.message });
    res.status(500).json({ error: 'Failed to create translation key' });
  }
});

/**
 * 批量导入翻译键
 * POST /api/translations/keys/import
 */
router.post('/keys/import', authenticate, requireAdmin, async (req, res) => {
  try {
    const { keys } = req.body;
    
    if (!Array.isArray(keys) || keys.length === 0) {
      return res.status(400).json({ error: 'Keys array is required' });
    }
    
    const result = await translationManager.batchCreateKeys(keys);
    
    res.json(result);
  } catch (error) {
    logger.error('Failed to import translation keys', { error: error.message });
    res.status(500).json({ error: 'Failed to import translation keys' });
  }
});

/**
 * 提交翻译
 * POST /api/translations/submit
 */
router.post('/submit', authenticate, async (req, res) => {
  try {
    const { keyId, language, content } = req.body;
    const userId = req.user.id;
    
    if (!keyId || !language || !content) {
      return res.status(400).json({ error: 'keyId, language and content are required' });
    }
    
    const result = await translationManager.submitTranslation({
      keyId,
      language,
      content,
      translatedBy: userId
    });
    
    res.status(201).json(result);
  } catch (error) {
    logger.error('Failed to submit translation', { error: error.message });
    res.status(500).json({ error: 'Failed to submit translation' });
  }
});

/**
 * 审核翻译
 * POST /api/translations/:id/review
 */
router.post('/:id/review', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reason } = req.body;
    const userId = req.user.id;
    
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    const result = await translationManager.reviewTranslation(
      parseInt(id),
      status,
      userId,
      reason
    );
    
    res.json(result);
  } catch (error) {
    logger.error('Failed to review translation', { error: error.message });
    res.status(500).json({ error: 'Failed to review translation' });
  }
});

/**
 * 获取翻译进度
 * GET /api/translations/progress
 */
router.get('/progress', authenticate, requireAdmin, async (req, res) => {
  try {
    const progress = await translationManager.getProgress();
    
    res.json(progress);
  } catch (error) {
    logger.error('Failed to get translation progress', { error: error.message });
    res.status(500).json({ error: 'Failed to get translation progress' });
  }
});

/**
 * 获取缺失翻译
 * GET /api/translations/missing/:language
 */
router.get('/missing/:language', authenticate, requireAdmin, async (req, res) => {
  try {
    const { language } = req.params;
    const { limit, offset } = req.query;
    
    const missing = await translationManager.getMissingTranslations(
      language,
      parseInt(limit) || 100,
      parseInt(offset) || 0
    );
    
    res.json(missing);
  } catch (error) {
    logger.error('Failed to get missing translations', { error: error.message });
    res.status(500).json({ error: 'Failed to get missing translations' });
  }
});

/**
 * 导出语言包
 * GET /api/translations/export/:language
 */
router.get('/export/:language', authenticate, requireAdmin, async (req, res) => {
  try {
    const { language } = req.params;
    
    const languagePack = await translationManager.exportLanguagePack(language);
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="translations-${language}.json"`);
    res.json(languagePack);
  } catch (error) {
    logger.error('Failed to export language pack', { error: error.message });
    res.status(500).json({ error: 'Failed to export language pack' });
  }
});

/**
 * 批量导入翻译
 * POST /api/translations/import
 */
router.post('/import', authenticate, requireAdmin, async (req, res) => {
  try {
    const { language, translations } = req.body;
    const userId = req.user.id;
    
    if (!language || !translations) {
      return res.status(400).json({ error: 'Language and translations are required' });
    }
    
    const result = await translationManager.importTranslations(language, translations, userId);
    
    res.json(result);
  } catch (error) {
    logger.error('Failed to import translations', { error: error.message });
    res.status(500).json({ error: 'Failed to import translations' });
  }
});

/**
 * 获取翻译历史
 * GET /api/translations/history/:keyId/:language
 */
router.get('/history/:keyId/:language', authenticate, requireAdmin, async (req, res) => {
  try {
    const { keyId, language } = req.params;
    const { limit } = req.query;
    
    const history = await translationManager.getHistory(
      parseInt(keyId),
      language,
      parseInt(limit) || 20
    );
    
    res.json(history);
  } catch (error) {
    logger.error('Failed to get translation history', { error: error.message });
    res.status(500).json({ error: 'Failed to get translation history' });
  }
});

/**
 * 回滚翻译版本
 * POST /api/translations/rollback/:keyId/:language/:version
 */
router.post('/rollback/:keyId/:language/:version', authenticate, requireAdmin, async (req, res) => {
  try {
    const { keyId, language, version } = req.params;
    const userId = req.user.id;
    
    const result = await translationManager.rollbackTranslation(
      parseInt(keyId),
      language,
      parseInt(version),
      userId
    );
    
    res.json(result);
  } catch (error) {
    logger.error('Failed to rollback translation', { error: error.message });
    res.status(500).json({ error: 'Failed to rollback translation' });
  }
});

/**
 * 清除翻译缓存
 * POST /api/translations/cache/clear
 */
router.post('/cache/clear', authenticate, requireAdmin, async (req, res) => {
  try {
    await translationManager.clearAllCache();
    
    res.json({ message: 'Cache cleared successfully' });
  } catch (error) {
    logger.error('Failed to clear translation cache', { error: error.message });
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

module.exports = router;
