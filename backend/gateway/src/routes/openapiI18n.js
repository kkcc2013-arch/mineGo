// backend/gateway/src/routes/openapiI18n.js
// OpenAPI Documentation i18n Support (REQ-00155)
'use strict';

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } = require('../../../shared/i18n');
const { createLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');

const logger = createLogger('openapi-i18n');
const router = express.Router();

const TRANSLATIONS_DIR = path.join(__dirname, '../../../docs/api-spec/openapi/translations');

/**
 * GET /api-docs/:lang - 获取指定语言的 OpenAPI 文档
 * 
 * @param {string} lang - 语言代码 (zh-CN, en-US, ja-JP)
 * @returns {object} OpenAPI 规范对象
 */
router.get('/:lang', async (req, res, next) => {
  try {
    const lang = req.params.lang;
    
    // 验证语言代码
    if (!SUPPORTED_LANGUAGES.includes(lang)) {
      return res.status(400).json({
        error: 'Unsupported language',
        supportedLanguages: SUPPORTED_LANGUAGES
      });
    }
    
    // 读取对应语言的 OpenAPI 文件
    const filePath = path.join(TRANSLATIONS_DIR, `${lang}.yaml`);
    const content = await fs.readFile(filePath, 'utf-8');
    
    // 解析 YAML
    const openapiSpec = yaml.load(content);
    
    // 记录指标
    metrics.openapiDocRequests?.inc({ language: lang, status: 'success' }) ||
      logger.info({ lang }, 'OpenAPI doc requested');
    
    // 设置响应头
    res.set('Content-Type', 'application/json');
    res.set('Content-Language', lang);
    res.json(openapiSpec);
    
  } catch (err) {
    if (err.code === 'ENOENT') {
      metrics.openapiDocRequests?.inc({ language: req.params.lang, status: 'not_found' });
      return res.status(404).json({ error: 'Language file not found' });
    }
    logger.error({ err, lang: req.params.lang }, 'Failed to load OpenAPI doc');
    next(err);
  }
});

/**
 * GET /api-docs/languages - 获取支持的语言列表
 */
router.get('/languages/list', (req, res) => {
  const languageNames = {
    'zh-CN': '简体中文',
    'en-US': 'English',
    'ja-JP': '日本語'
  };
  
  res.json({
    default: DEFAULT_LANGUAGE,
    supported: SUPPORTED_LANGUAGES.map(lang => ({
      code: lang,
      name: languageNames[lang]
    }))
  });
});

/**
 * GET /api-docs/compare/:lang1/:lang2 - 对比两种语言的翻译覆盖率
 * 
 * 用于检测缺失的翻译键
 */
router.get('/compare/:lang1/:lang2', async (req, res, next) => {
  try {
    const { lang1, lang2 } = req.params;
    
    if (!SUPPORTED_LANGUAGES.includes(lang1) || !SUPPORTED_LANGUAGES.includes(lang2)) {
      return res.status(400).json({ error: 'Invalid language code' });
    }
    
    const [spec1, spec2] = await Promise.all([
      loadOpenAPISpec(lang1),
      loadOpenAPISpec(lang2)
    ]);
    
    const keys1 = extractDescriptionKeys(spec1);
    const keys2 = extractDescriptionKeys(spec2);
    
    const missing = keys1.filter(k => !keys2.includes(k));
    const extra = keys2.filter(k => !keys1.includes(k));
    
    const coverage = keys1.length > 0 
      ? ((keys1.length - missing.length) / keys1.length * 100).toFixed(2)
      : 0;
    
    res.json({
      lang1,
      lang2,
      lang1Count: keys1.length,
      lang2Count: keys2.length,
      missingInLang2: missing,
      extraInLang2: extra,
      coverage: `${coverage}%`
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api-docs/coverage - 获取所有语言的翻译覆盖率
 */
router.get('/coverage', async (req, res, next) => {
  try {
    const specs = {};
    const coverages = {};
    
    for (const lang of SUPPORTED_LANGUAGES) {
      specs[lang] = await loadOpenAPISpec(lang);
    }
    
    const baseKeys = extractDescriptionKeys(specs[DEFAULT_LANGUAGE]);
    
    for (const lang of SUPPORTED_LANGUAGES) {
      const langKeys = extractDescriptionKeys(specs[lang]);
      const missing = baseKeys.filter(k => !langKeys.includes(k));
      const coverage = baseKeys.length > 0
        ? ((baseKeys.length - missing.length) / baseKeys.length * 100).toFixed(2)
        : 0;
      
      coverages[lang] = {
        total: langKeys.length,
        missing: missing.length,
        coverage: parseFloat(coverage)
      };
      
      // 更新 Prometheus 指标
      if (metrics.openapiTranslationCoverage) {
        metrics.openapiTranslationCoverage.set({ language: lang }, parseFloat(coverage));
      }
    }
    
    res.json({
      baseLanguage: DEFAULT_LANGUAGE,
      baseKeys: baseKeys.length,
      coverages
    });
    
  } catch (err) {
    next(err);
  }
});

// ── Helper Functions ────────────────────────────────────────────────

async function loadOpenAPISpec(lang) {
  const filePath = path.join(TRANSLATIONS_DIR, `${lang}.yaml`);
  const content = await fs.readFile(filePath, 'utf-8');
  return yaml.load(content);
}

function extractDescriptionKeys(spec, prefix = '') {
  const keys = [];
  
  if (!spec || typeof spec !== 'object') return keys;
  
  // info 字段
  if (spec.info) {
    if (spec.info.title) keys.push('info.title');
    if (spec.info.description) keys.push('info.description');
  }
  
  // tags
  if (spec.tags && Array.isArray(spec.tags)) {
    spec.tags.forEach(tag => {
      if (tag.description) {
        keys.push(`tags.${tag.name}.description`);
      }
    });
  }
  
  // paths
  if (spec.paths) {
    for (const [pathName, methods] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!operation || typeof operation !== 'object') continue;
        
        const pathPrefix = `paths.${pathName}.${method}`;
        
        if (operation.summary) {
          keys.push(`${pathPrefix}.summary`);
        }
        if (operation.description) {
          keys.push(`${pathPrefix}.description`);
        }
        
        // parameters
        if (operation.parameters && Array.isArray(operation.parameters)) {
          operation.parameters.forEach(param => {
            if (param.description) {
              keys.push(`${pathPrefix}.parameters.${param.name}.description`);
            }
          });
        }
        
        // requestBody
        if (operation.requestBody?.description) {
          keys.push(`${pathPrefix}.requestBody.description`);
        }
        
        // responses
        if (operation.responses) {
          for (const [status, response] of Object.entries(operation.responses)) {
            if (response?.description) {
              keys.push(`${pathPrefix}.responses.${status}.description`);
            }
          }
        }
      }
    }
  }
  
  return keys;
}

module.exports = router;
