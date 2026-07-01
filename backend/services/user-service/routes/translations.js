'use strict';

/**
 * REQ-00398: 翻译管理 API 路由
 * 提供翻译 CRUD、导入导出、缺失告警等功能
 */

const express = require('express');
const router = express.Router();
const auth = require('../shared/auth');
const { db } = require('../shared/db');
const logger = require('../shared/logger');
const dynamicTranslationManager = require('../../../shared/DynamicTranslationManager');
const translationMetrics = require('../../../shared/translationMetrics');
const { checkMissingTranslations, getCoverageReport } = require('../../../jobs/checkMissingTranslations');

// ============================================
// 中间件：管理员权限检查
// ============================================
router.use('/translations', auth.requireAdmin);
router.use('/missing-translations', auth.requireAdmin);
router.use('/translations/import', auth.requireAdmin);
router.use('/translations/export', auth.requireAdmin);

// ============================================
// 获取翻译列表
// ============================================
router.get('/translations', async (req, res) => {
  try {
    const { language, error_code, page, limit } = req.query;
    
    const result = await dynamicTranslationManager.getTranslations({
      language,
      errorCode: error_code,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 50
    });
    
    translationMetrics.translationOperations.inc({ operation: 'list', status: 'success' });
    
    res.json({
      success: true,
      data: result.data,
      pagination: result.pagination
    });
  } catch (error) {
    logger.error('Failed to list translations', { error: error.message });
    translationMetrics.translationOperations.inc({ operation: 'list', status: 'error' });
    res.status(500).json({
      success: false,
      error: 'Failed to list translations'
    });
  }
});

// ============================================
// 获取单个翻译
// ============================================
router.get('/translations/:error_code/:language', async (req, res) => {
  try {
    const { error_code, language } = req.params;
    
    const result = await db.query(
      `SELECT * FROM error_translations 
       WHERE error_code = $1 AND language = $2 
       ORDER BY version DESC LIMIT 1`,
      [error_code, language]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Translation not found'
      });
    }
    
    translationMetrics.translationOperations.inc({ operation: 'get', status: 'success' });
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    logger.error('Failed to get translation', { error: error.message });
    translationMetrics.translationOperations.inc({ operation: 'get', status: 'error' });
    res.status(500).json({
      success: false,
      error: 'Failed to get translation'
    });
  }
});

// ============================================
// 创建/更新翻译
// ============================================
router.post('/translations', async (req, res) => {
  try {
    const { error_code, language, message, params_template, metadata } = req.body;
    
    // 验证必填字段
    if (!error_code || !language || !message) {
      return res.status(400).json({
        success: false,
        error: 'error_code, language, and message are required'
      });
    }
    
    // 验证语言是否支持
    if (!dynamicTranslationManager.supportedLanguages.includes(language)) {
      return res.status(400).json({
        success: false,
        error: `Unsupported language: ${language}. Supported: ${dynamicTranslationManager.supportedLanguages.join(', ')}`
      });
    }
    
    const userId = req.user?.id || null;
    
    const result = await dynamicTranslationManager.saveTranslation(
      error_code,
      language,
      message,
      params_template,
      metadata,
      userId
    );
    
    translationMetrics.translationOperations.inc({ operation: 'save', status: 'success' });
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to save translation', { error: error.message });
    translationMetrics.translationOperations.inc({ operation: 'save', status: 'error' });
    res.status(500).json({
      success: false,
      error: 'Failed to save translation'
    });
  }
});

// ============================================
// 更新现有翻译
// ============================================
router.put('/translations/:error_code/:language', async (req, res) => {
  try {
    const { error_code, language } = req.params;
    const { message, params_template, metadata } = req.body;
    
    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'message is required'
      });
    }
    
    const userId = req.user?.id || null;
    
    const result = await dynamicTranslationManager.saveTranslation(
      error_code,
      language,
      message,
      params_template,
      metadata,
      userId
    );
    
    translationMetrics.translationOperations.inc({ operation: 'update', status: 'success' });
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to update translation', { error: error.message });
    translationMetrics.translationOperations.inc({ operation: 'update', status: 'error' });
    res.status(500).json({
      success: false,
      error: 'Failed to update translation'
    });
  }
});

// ============================================
// 删除翻译
// ============================================
router.delete('/translations/:error_code/:language', async (req, res) => {
  try {
    const { error_code, language } = req.params;
    const userId = req.user?.id || null;
    
    await dynamicTranslationManager.deleteTranslation(error_code, language, userId);
    
    translationMetrics.translationOperations.inc({ operation: 'delete', status: 'success' });
    
    res.json({
      success: true,
      message: 'Translation deleted successfully'
    });
  } catch (error) {
    logger.error('Failed to delete translation', { error: error.message });
    translationMetrics.translationOperations.inc({ operation: 'delete', status: 'error' });
    
    if (error.message === 'Translation not found') {
      return res.status(404).json({
        success: false,
        error: 'Translation not found'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to delete translation'
    });
  }
});

// ============================================
// 批量导入翻译
// ============================================
router.post('/translations/import', async (req, res) => {
  try {
    const { language, translations, format } = req.body;
    
    if (!language || !translations) {
      return res.status(400).json({
        success: false,
        error: 'language and translations are required'
      });
    }
    
    // 验证语言
    if (!dynamicTranslationManager.supportedLanguages.includes(language)) {
      return res.status(400).json({
        success: false,
        error: `Unsupported language: ${language}`
      });
    }
    
    const userId = req.user?.id || null;
    
    // 如果是 PO 格式，解析 PO 文件
    if (format === 'po') {
      translations = parsePoFile(translations);
    }
    
    const result = await dynamicTranslationManager.importTranslations(language, translations, userId);
    
    translationMetrics.importExportOperations.inc({ type: 'import', format: format || 'json', status: 'success' });
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to import translations', { error: error.message });
    translationMetrics.importExportOperations.inc({ type: 'import', format: 'unknown', status: 'error' });
    res.status(500).json({
      success: false,
      error: 'Failed to import translations'
    });
  }
});

// ============================================
// 导出翻译
// ============================================
router.get('/translations/export/:language', async (req, res) => {
  try {
    const { language } = req.params;
    const { format = 'json' } = req.query;
    
    const translations = await dynamicTranslationManager.exportTranslations(language);
    
    translationMetrics.importExportOperations.inc({ type: 'export', format, status: 'success' });
    
    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="translations-${language}.json"`);
      res.json(translations);
    } else if (format === 'po') {
      // 生成 PO 格式
      let poContent = `# Error Translations for ${language}\n`;
      poContent += `# Generated: ${new Date().toISOString()}\n`;
      poContent += `# Project: mineGo\n\n`;
      
      for (const [code, msg] of Object.entries(translations)) {
        poContent += `msgid "${code}"\n`;
        poContent += `msgstr "${msg.replace(/"/g, '\\"')}"\n\n`;
      }
      
      res.setHeader('Content-Disposition', `attachment; filename="translations-${language}.po"`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(poContent);
    } else if (format === 'csv') {
      // 生成 CSV 格式
      let csvContent = 'error_code,message\n';
      for (const [code, msg] of Object.entries(translations)) {
        csvContent += `"${code}","${msg.replace(/"/g, '\\"')}"\n`;
      }
      
      res.setHeader('Content-Disposition', `attachment; filename="translations-${language}.csv"`);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.send(csvContent);
    } else {
      return res.status(400).json({
        success: false,
        error: 'Unsupported format. Supported: json, po, csv'
      });
    }
  } catch (error) {
    logger.error('Failed to export translations', { error: error.message });
    translationMetrics.importExportOperations.inc({ type: 'export', format: 'unknown', status: 'error' });
    res.status(500).json({
      success: false,
      error: 'Failed to export translations'
    });
  }
});

// ============================================
// 获取缺失翻译告警列表
// ============================================
router.get('/missing-translations', async (req, res) => {
  try {
    const { severity, acknowledged } = req.query;
    
    const alerts = await dynamicTranslationManager.getMissingAlerts({
      severity,
      acknowledged
    });
    
    res.json({
      success: true,
      data: alerts
    });
  } catch (error) {
    logger.error('Failed to get missing alerts', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get missing alerts'
    });
  }
});

// ============================================
// 确认缺失翻译告警
// ============================================
router.post('/missing-translations/:id/acknowledge', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id || null;
    
    await dynamicTranslationManager.acknowledgeAlert(parseInt(id, 10), userId);
    
    res.json({
      success: true,
      message: 'Alert acknowledged'
    });
  } catch (error) {
    logger.error('Failed to acknowledge alert', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to acknowledge alert'
    });
  }
});

// ============================================
// 清除所有已确认的告警
// ============================================
router.delete('/missing-translations/acknowledged', async (req, res) => {
  try {
    await db.query(
      'DELETE FROM missing_translation_alerts WHERE acknowledged = TRUE'
    );
    
    res.json({
      success: true,
      message: 'All acknowledged alerts cleared'
    });
  } catch (error) {
    logger.error('Failed to clear acknowledged alerts', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to clear acknowledged alerts'
    });
  }
});

// ============================================
// 手动触发缺失翻译检查
// ============================================
router.post('/missing-translations/check', async (req, res) => {
  try {
    const result = await checkMissingTranslations();
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to check missing translations', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to check missing translations'
    });
  }
});

// ============================================
// 获取翻译覆盖率报告
// ============================================
router.get('/translations/coverage', async (req, res) => {
  try {
    const report = await getCoverageReport();
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    logger.error('Failed to get coverage report', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get coverage report'
    });
  }
});

// ============================================
// 清除翻译缓存
// ============================================
router.post('/translations/cache/clear', async (req, res) => {
  try {
    const { error_code, language } = req.body;
    
    await dynamicTranslationManager.clearCache(error_code, language);
    
    res.json({
      success: true,
      message: 'Cache cleared'
    });
  } catch (error) {
    logger.error('Failed to clear cache', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to clear cache'
    });
  }
});

// ============================================
// 获取翻译历史（审计日志）
// ============================================
router.get('/translations/:error_code/:language/history', async (req, res) => {
  try {
    const { error_code, language } = req.params;
    const { limit = 20 } = req.query;
    
    const result = await db.query(
      `SELECT * FROM error_translation_audit 
       WHERE error_code = $1 AND language = $2 
       ORDER BY changed_at DESC 
       LIMIT $3`,
      [error_code, language, parseInt(limit, 10)]
    );
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    logger.error('Failed to get translation history', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get translation history'
    });
  }
});

// ============================================
// 解析 PO 文件内容
// ============================================
function parsePoFile(content) {
  const translations = {};
  const lines = content.split('\n');
  
  let currentMsgid = null;
  
  for (const line of lines) {
    if (line.startsWith('msgid "')) {
      currentMsgid = line.slice(7, -1);
    } else if (line.startsWith('msgstr "') && currentMsgid) {
      const msgstr = line.slice(8, -1);
      if (currentMsgid && msgstr) {
        translations[currentMsgid] = msgstr.replace(/\\"/g, '"');
      }
      currentMsgid = null;
    }
  }
  
  return translations;
}

module.exports = router;