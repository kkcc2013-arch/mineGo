# REQ-00398: API 错误消息动态翻译管理系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00398 |
| 标题 | API 错误消息动态翻译管理系统 |
| 类别 | 国际化/本地化 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | gateway、所有微服务、backend/shared/i18n、backend/shared/errorHandler.js、admin-dashboard、database/migrations |
| 创建时间 | 2026-06-30 21:15 |

## 需求描述

当前系统错误消息翻译硬编码在 `i18n.js` 文件中，存在以下问题：

1. **扩展性差**：添加新语言需要修改代码文件并重新部署
2. **维护困难**：翻译人员需要了解代码结构，难以协作
3. **更新成本高**：修改翻译需要代码发布流程，无法实时更新
4. **缺失检测缺失**：无法及时发现新增错误码缺少翻译
5. **一致性难以保证**：术语翻译不一致，影响用户体验

本需求旨在构建一个动态、可扩展、易维护的 API 错误消息翻译管理系统：

- **动态翻译数据库**：将错误消息存储在数据库中，支持热更新
- **翻译管理后台**：提供 Web 界面供翻译人员管理翻译内容
- **缺失检测机制**：自动检测缺失的翻译并发出告警
- **智能回退策略**：缺少翻译时使用智能回退机制（en-US → zh-CN）
- **版本控制与审计**：记录翻译变更历史，支持回滚
- **批量导入导出**：支持 PO/JSON 格式批量导入导出翻译

## 技术方案

### 1. 数据库设计

#### 错误码翻译表
```sql
CREATE TABLE error_translations (
  id SERIAL PRIMARY KEY,
  error_code VARCHAR(100) NOT NULL,
  language VARCHAR(10) NOT NULL,
  message TEXT NOT NULL,
  params_template JSONB, -- 参数插值模板，如 {"pokemon": "string", "distance": "number"}
  metadata JSONB, -- 额外元数据（来源、审核状态等）
  version INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER REFERENCES users(id),
  updated_by INTEGER REFERENCES users(id),
  
  CONSTRAINT unique_error_translation UNIQUE(error_code, language)
);

CREATE INDEX idx_error_translations_code ON error_translations(error_code);
CREATE INDEX idx_error_translations_lang ON error_translations(language);
CREATE INDEX idx_error_translations_version ON error_translations(error_code, language, version);
```

#### 翻译审计日志表
```sql
CREATE TABLE error_translation_audit (
  id SERIAL PRIMARY KEY,
  error_code VARCHAR(100) NOT NULL,
  language VARCHAR(10) NOT NULL,
  old_message TEXT,
  new_message TEXT NOT NULL,
  old_metadata JSONB,
  new_metadata JSONB,
  changed_by INTEGER REFERENCES users(id),
  change_reason TEXT,
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_translation_audit_error ON error_translation_audit(error_code, language);
CREATE INDEX idx_translation_audit_time ON error_translation_audit(changed_at);
```

#### 缺失翻译告警表
```sql
CREATE TABLE missing_translation_alerts (
  id SERIAL PRIMARY KEY,
  error_code VARCHAR(100) NOT NULL,
  missing_languages TEXT[] NOT NULL,
  severity VARCHAR(20) DEFAULT 'warning', -- info, warning, critical
  first_detected TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_detected TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  detection_count INTEGER DEFAULT 1,
  acknowledged BOOLEAN DEFAULT FALSE,
  acknowledged_by INTEGER REFERENCES users(id),
  acknowledged_at TIMESTAMP,
  
  CONSTRAINT unique_missing_alert UNIQUE(error_code)
);
```

### 2. 后端核心服务

#### 动态翻译管理器 (backend/shared/DynamicTranslationManager.js)
```javascript
'use strict';

const { db } = require('./db');
const logger = require('./logger');
const Redis = require('ioredis');

class DynamicTranslationManager {
  constructor() {
    this.redis = new Redis(process.env.REDIS_URL);
    this.cachePrefix = 'error_translations:';
    this.cacheTTL = 3600; // 1小时缓存
    this.fallbackChain = {
      'ja-JP': ['en-US', 'zh-CN'],
      'zh-TW': ['zh-CN', 'en-US'],
      'en-US': ['zh-CN'],
      'zh-CN': ['en-US']
    };
  }

  /**
   * 获取本地化错误消息
   * @param {string} errorCode - 错误码
   * @param {string} language - 目标语言
   * @param {Object} params - 参数对象
   * @returns {string} 本地化消息
   */
  async getLocalizedMessage(errorCode, language = 'zh-CN', params = {}) {
    // 1. 尝试从 Redis 缓存获取
    const cacheKey = `${this.cachePrefix}${errorCode}:${language}`;
    let message = await this.redis.get(cacheKey);
    
    if (!message) {
      // 2. 从数据库查询
      const result = await db.query(
        `SELECT message, params_template FROM error_translations 
         WHERE error_code = $1 AND language = $2 
         ORDER BY version DESC LIMIT 1`,
        [errorCode, language]
      );
      
      if (result.rows.length > 0) {
        message = result.rows[0].message;
        // 缓存结果
        await this.redis.setex(cacheKey, this.cacheTTL, message);
      } else {
        // 3. 使用回退策略
        message = await this.getFallbackMessage(errorCode, language);
        
        // 4. 记录缺失翻译
        await this.recordMissingTranslation(errorCode, language);
      }
    }
    
    // 5. 参数插值
    return this.interpolateMessage(message, params);
  }

  /**
   * 回退策略获取消息
   */
  async getFallbackMessage(errorCode, language) {
    const fallbackLanguages = this.fallbackChain[language] || ['en-US', 'zh-CN'];
    
    for (const fallbackLang of fallbackLanguages) {
      const result = await db.query(
        `SELECT message FROM error_translations 
         WHERE error_code = $1 AND language = $2 
         ORDER BY version DESC LIMIT 1`,
        [errorCode, fallbackLang]
      );
      
      if (result.rows.length > 0) {
        logger.warn('Using fallback translation', {
          errorCode,
          requestedLang: language,
          fallbackLang,
          message: result.rows[0].message
        });
        return result.rows[0].message;
      }
    }
    
    // 最终回退：返回错误码
    return `Error: ${errorCode}`;
  }

  /**
   * 参数插值
   */
  interpolateMessage(message, params) {
    if (!params || Object.keys(params).length === 0) {
      return message;
    }
    
    return message.replace(/\{(\w+)\}/g, (match, key) => {
      return params[key] !== undefined ? params[key] : match;
    });
  }

  /**
   * 记录缺失翻译
   */
  async recordMissingTranslation(errorCode, language) {
    try {
      const existing = await db.query(
        `SELECT * FROM missing_translation_alerts WHERE error_code = $1`,
        [errorCode]
      );
      
      const missingLanguages = existing.rows.length > 0 
        ? existing.rows[0].missing_languages 
        : [];
      
      if (!missingLanguages.includes(language)) {
        missingLanguages.push(language);
        
        if (existing.rows.length > 0) {
          await db.query(
            `UPDATE missing_translation_alerts 
             SET missing_languages = $1, 
                 last_detected = CURRENT_TIMESTAMP,
                 detection_count = detection_count + 1
             WHERE error_code = $2`,
            [missingLanguages, errorCode]
          );
        } else {
          await db.query(
            `INSERT INTO missing_translation_alerts 
             (error_code, missing_languages, severity) 
             VALUES ($1, $2, $3)`,
            [errorCode, missingLanguages, 'warning']
          );
        }
      }
    } catch (error) {
      logger.error('Failed to record missing translation', {
        errorCode,
        language,
        error: error.message
      });
    }
  }

  /**
   * 批量获取翻译
   */
  async getBatchTranslations(errorCodes, language) {
    const translations = {};
    
    for (const errorCode of errorCodes) {
      translations[errorCode] = await this.getLocalizedMessage(errorCode, language);
    }
    
    return translations;
  }

  /**
   * 清除缓存
   */
  async clearCache(errorCode, language) {
    const pattern = errorCode 
      ? `${this.cachePrefix}${errorCode}:*`
      : `${this.cachePrefix}*`;
    
    const keys = await this.redis.keys(pattern);
    
    if (keys.length > 0) {
      await this.redis.del(...keys);
      logger.info('Cleared translation cache', { errorCode, language, keysCleared: keys.length });
    }
  }
}

module.exports = new DynamicTranslationManager();
```

#### 翻译 CRUD API (backend/services/user-service/routes/translations.js)
```javascript
'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../../shared/auth');
const { db } = require('../../shared/db');
const logger = require('../../shared/logger');
const dynamicTranslationManager = require('../../shared/DynamicTranslationManager');

// 获取翻译列表
router.get('/translations', auth.requireAdmin, async (req, res) => {
  const { language, error_code, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  
  let query = 'SELECT * FROM error_translations WHERE 1=1';
  const params = [];
  let paramIndex = 1;
  
  if (language) {
    query += ` AND language = $${paramIndex++}`;
    params.push(language);
  }
  
  if (error_code) {
    query += ` AND error_code ILIKE $${paramIndex++}`;
    params.push(`%${error_code}%`);
  }
  
  query += ` ORDER BY error_code, language LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
  params.push(limit, offset);
  
  const result = await db.query(query, params);
  
  res.json({
    success: true,
    data: result.rows,
    pagination: {
      page,
      limit,
      total: result.rows.length
    }
  });
});

// 创建/更新翻译
router.post('/translations', auth.requireAdmin, async (req, res) => {
  const { error_code, language, message, params_template, metadata } = req.body;
  
  // 验证必填字段
  if (!error_code || !language || !message) {
    return res.status(400).json({
      success: false,
      error: 'error_code, language, and message are required'
    });
  }
  
  const client = await db.pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 检查是否已存在
    const existing = await client.query(
      'SELECT * FROM error_translations WHERE error_code = $1 AND language = $2',
      [error_code, language]
    );
    
    let result;
    
    if (existing.rows.length > 0) {
      // 更新现有翻译
      result = await client.query(
        `UPDATE error_translations 
         SET message = $1, params_template = $2, metadata = $3, 
             version = version + 1, updated_at = CURRENT_TIMESTAMP, updated_by = $4
         WHERE error_code = $5 AND language = $6
         RETURNING *`,
        [message, params_template, metadata, req.user.id, error_code, language]
      );
      
      // 记录审计日志
      await client.query(
        `INSERT INTO error_translation_audit 
         (error_code, language, old_message, new_message, old_metadata, new_metadata, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          error_code, language, 
          existing.rows[0].message, message,
          existing.rows[0].metadata, metadata,
          req.user.id
        ]
      );
    } else {
      // 创建新翻译
      result = await client.query(
        `INSERT INTO error_translations 
         (error_code, language, message, params_template, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [error_code, language, message, params_template, metadata, req.user.id]
      );
    }
    
    await client.query('COMMIT');
    
    // 清除缓存
    await dynamicTranslationManager.clearCache(error_code, language);
    
    logger.info('Translation saved', {
      error_code,
      language,
      changed_by: req.user.id
    });
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to save translation', {
      error: error.message,
      error_code,
      language
    });
    res.status(500).json({
      success: false,
      error: 'Failed to save translation'
    });
  } finally {
    client.release();
  }
});

// 删除翻译
router.delete('/translations/:error_code/:language', auth.requireAdmin, async (req, res) => {
  const { error_code, language } = req.params;
  
  const client = await db.pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // 获取旧值
    const existing = await client.query(
      'SELECT * FROM error_translations WHERE error_code = $1 AND language = $2',
      [error_code, language]
    );
    
    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Translation not found'
      });
    }
    
    // 删除翻译
    await client.query(
      'DELETE FROM error_translations WHERE error_code = $1 AND language = $2',
      [error_code, language]
    );
    
    // 记录审计日志
    await client.query(
      `INSERT INTO error_translation_audit 
       (error_code, language, old_message, new_message, old_metadata, new_metadata, changed_by, change_reason)
       VALUES ($1, $2, $3, NULL, $4, NULL, $5, 'deleted')`,
      [error_code, language, existing.rows[0].message, existing.rows[0].metadata, req.user.id]
    );
    
    await client.query('COMMIT');
    
    // 清除缓存
    await dynamicTranslationManager.clearCache(error_code, language);
    
    logger.info('Translation deleted', {
      error_code,
      language,
      deleted_by: req.user.id
    });
    
    res.json({
      success: true,
      message: 'Translation deleted successfully'
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to delete translation', {
      error: error.message,
      error_code,
      language
    });
    res.status(500).json({
      success: false,
      error: 'Failed to delete translation'
    });
  } finally {
    client.release();
  }
});

// 获取缺失翻译告警
router.get('/missing-translations', auth.requireAdmin, async (req, res) => {
  const { severity, acknowledged } = req.query;
  
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
  
  res.json({
    success: true,
    data: result.rows
  });
});

// 确认缺失翻译告警
router.post('/missing-translations/:id/acknowledge', auth.requireAdmin, async (req, res) => {
  const { id } = req.params;
  
  await db.query(
    `UPDATE missing_translation_alerts 
     SET acknowledged = TRUE, acknowledged_by = $1, acknowledged_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [req.user.id, id]
  );
  
  res.json({
    success: true,
    message: 'Alert acknowledged'
  });
});

// 批量导入翻译
router.post('/translations/import', auth.requireAdmin, async (req, res) => {
  const { format, language, translations } = req.body;
  
  // 支持 JSON 和 PO 格式
  // JSON: { "ERROR_CODE": "Message", ... }
  // PO: 标准 PO 文件格式
  
  const client = await db.pool.connect();
  
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
            [message, req.user.id, errorCode, language]
          );
          results.updated++;
        } else {
          await client.query(
            `INSERT INTO error_translations (error_code, language, message, created_by)
             VALUES ($1, $2, $3, $4)`,
            [errorCode, language, message, req.user.id]
          );
          results.imported++;
        }
      } catch (error) {
        results.failed++;
        results.errors.push({ errorCode, error: error.message });
      }
    }
    
    await client.query('COMMIT');
    
    // 清除所有缓存
    await dynamicTranslationManager.clearCache();
    
    logger.info('Batch import completed', {
      language,
      ...results,
      imported_by: req.user.id
    });
    
    res.json({
      success: true,
      data: results
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Batch import failed', {
      error: error.message,
      language
    });
    res.status(500).json({
      success: false,
      error: 'Import failed'
    });
  } finally {
    client.release();
  }
});

// 导出翻译
router.get('/translations/export/:language', auth.requireAdmin, async (req, res) => {
  const { language } = req.params;
  const { format = 'json' } = req.query;
  
  const result = await db.query(
    'SELECT error_code, message FROM error_translations WHERE language = $1 ORDER BY error_code',
    [language]
  );
  
  const translations = {};
  for (const row of result.rows) {
    translations[row.error_code] = row.message;
  }
  
  if (format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="translations-${language}.json"`);
    res.json(translations);
  } else if (format === 'po') {
    // 生成 PO 格式
    let poContent = `# Error Translations for ${language}\n`;
    poContent += `# Generated: ${new Date().toISOString()}\n\n`;
    
    for (const [code, msg] of Object.entries(translations)) {
      poContent += `msgid "${code}"\n`;
      poContent += `msgstr "${msg}"\n\n`;
    }
    
    res.setHeader('Content-Disposition', `attachment; filename="translations-${language}.po"`);
    res.setHeader('Content-Type', 'text/plain');
    res.send(poContent);
  } else {
    res.status(400).json({
      success: false,
      error: 'Unsupported format'
    });
  }
});

module.exports = router;
```

### 3. 定时任务：缺失翻译检测

#### 后台任务 (backend/jobs/checkMissingTranslations.js)
```javascript
'use strict';

const { db } = require('../shared/db');
const logger = require('../shared/logger');
const nodemailer = require('nodemailer');

const ERROR_CODES = require('../shared/errorCodes').ERROR_CODES;
const SUPPORTED_LANGUAGES = ['zh-CN', 'en-US', 'ja-JP'];

async function checkMissingTranslations() {
  logger.info('Starting missing translation check');
  
  const missingTranslations = [];
  
  for (const errorCode of Object.keys(ERROR_CODES)) {
    for (const language of SUPPORTED_LANGUAGES) {
      const result = await db.query(
        'SELECT * FROM error_translations WHERE error_code = $1 AND language = $2',
        [errorCode, language]
      );
      
      if (result.rows.length === 0) {
        missingTranslations.push({ errorCode, language });
      }
    }
  }
  
  if (missingTranslations.length > 0) {
    logger.warn('Missing translations detected', {
      count: missingTranslations.length,
      codes: missingTranslations.slice(0, 10) // 只记录前10个
    });
    
    // 发送邮件告警
    await sendMissingTranslationAlert(missingTranslations);
    
    // 更新告警表
    for (const missing of missingTranslations) {
      const existing = await db.query(
        'SELECT * FROM missing_translation_alerts WHERE error_code = $1',
        [missing.errorCode]
      );
      
      const missingLanguages = existing.rows.length > 0
        ? existing.rows[0].missing_languages
        : [];
      
      if (!missingLanguages.includes(missing.language)) {
        missingLanguages.push(missing.language);
        
        if (existing.rows.length > 0) {
          await db.query(
            `UPDATE missing_translation_alerts 
             SET missing_languages = $1, last_detected = CURRENT_TIMESTAMP, detection_count = detection_count + 1
             WHERE error_code = $2`,
            [missingLanguages, missing.errorCode]
          );
        } else {
          await db.query(
            `INSERT INTO missing_translation_alerts (error_code, missing_languages, severity)
             VALUES ($1, $2, $3)`,
            [missing.errorCode, missingLanguages, 'warning']
          );
        }
      }
    }
  } else {
    logger.info('All error codes have complete translations');
  }
  
  return missingTranslations;
}

async function sendMissingTranslationAlert(missingTranslations) {
  // 配置邮件传输
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  
  const mailOptions = {
    from: process.env.ALERT_FROM_EMAIL,
    to: process.env.TRANSLATION_TEAM_EMAIL,
    subject: `[mineGo] Missing Translation Alert - ${missingTranslations.length} items`,
    html: `
      <h2>Missing Translation Alert</h2>
      <p>${missingTranslations.length} error codes are missing translations.</p>
      <h3>Details (showing first 20):</h3>
      <ul>
        ${missingTranslations.slice(0, 20).map(m => 
          `<li><strong>${m.errorCode}</strong> - ${m.language}</li>`
        ).join('')}
      </ul>
      <p><a href="${process.env.ADMIN_URL}/translations/missing">View all missing translations</a></p>
      <hr>
      <p>This is an automated message from mineGo Translation System.</p>
    `
  };
  
  try {
    await transporter.sendMail(mailOptions);
    logger.info('Missing translation alert sent', { count: missingTranslations.length });
  } catch (error) {
    logger.error('Failed to send missing translation alert', { error: error.message });
  }
}

// 作为独立脚本运行
if (require.main === module) {
  checkMissingTranslations()
    .then(() => process.exit(0))
    .catch(error => {
      logger.error('Missing translation check failed', { error: error.message });
      process.exit(1);
    });
}

module.exports = { checkMissingTranslations };
```

### 4. 管理后台界面

#### 前端组件 (frontend/admin-dashboard/src/components/TranslationManager.jsx)
```jsx
import React, { useState, useEffect } from 'react';
import { Table, Button, Modal, Form, Input, Select, message, Upload, Tabs } from 'antd';
import { DownloadOutlined, UploadOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';

const { TabPane } = Tabs;

const TranslationManager = () => {
  const [translations, setTranslations] = useState([]);
  const [missingAlerts, setMissingAlerts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editModal, setEditModal] = useState(false);
  const [currentTranslation, setCurrentTranslation] = useState(null);
  const [form] = Form.useForm();
  const [language] = useState('en-US');

  useEffect(() => {
    loadTranslations();
    loadMissingAlerts();
  }, []);

  const loadTranslations = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/translations');
      const data = await response.json();
      setTranslations(data.data);
    } catch (error) {
      message.error('Failed to load translations');
    } finally {
      setLoading(false);
    }
  };

  const loadMissingAlerts = async () => {
    try {
      const response = await fetch('/api/missing-translations');
      const data = await response.json();
      setMissingAlerts(data.data);
    } catch (error) {
      message.error('Failed to load missing translation alerts');
    }
  };

  const handleSave = async (values) => {
    try {
      const method = currentTranslation ? 'POST' : 'POST';
      const response = await fetch('/api/translations', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      });
      
      if (response.ok) {
        message.success('Translation saved successfully');
        loadTranslations();
        setEditModal(false);
        form.resetFields();
      } else {
        message.error('Failed to save translation');
      }
    } catch (error) {
      message.error('Error saving translation');
    }
  };

  const handleExport = async () => {
    try {
      const response = await fetch(`/api/translations/export/${language}?format=json`);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `translations-${language}.json`;
      a.click();
      message.success('Export completed');
    } catch (error) {
      message.error('Export failed');
    }
  };

  const handleImport = async (file) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const translations = JSON.parse(e.target.result);
        const response = await fetch('/api/translations/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ language, translations })
        });
        
        const data = await response.json();
        if (data.success) {
          message.success(`Imported: ${data.data.imported}, Updated: ${data.data.updated}, Failed: ${data.data.failed}`);
          loadTranslations();
        }
      } catch (error) {
        message.error('Import failed');
      }
    };
    reader.readAsText(file);
    return false;
  };

  const columns = [
    { title: 'Error Code', dataIndex: 'error_code', key: 'error_code', width: 200 },
    { title: 'Language', dataIndex: 'language', key: 'language', width: 100 },
    { title: 'Message', dataIndex: 'message', key: 'message', ellipsis: true },
    { title: 'Version', dataIndex: 'version', key: 'version', width: 80 },
    { 
      title: 'Actions', 
      key: 'actions', 
      width: 150,
      render: (_, record) => (
        <>
          <Button 
            icon={<EditOutlined />} 
            size="small" 
            onClick={() => {
              setCurrentTranslation(record);
              form.setFieldsValue(record);
              setEditModal(true);
            }}
            style={{ marginRight: 8 }}
          />
          <Button 
            icon={<DeleteOutlined />} 
            size="small" 
            danger
            onClick={() => handleDelete(record)}
          />
        </>
      )
    }
  ];

  const missingColumns = [
    { title: 'Error Code', dataIndex: 'error_code', key: 'error_code' },
    { title: 'Missing Languages', dataIndex: 'missing_languages', key: 'missing_languages', render: langs => langs.join(', ') },
    { title: 'Detection Count', dataIndex: 'detection_count', key: 'detection_count' },
    { title: 'Last Detected', dataIndex: 'last_detected', key: 'last_detected', render: date => new Date(date).toLocaleString() },
    { 
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Button 
          size="small"
          onClick={() => acknowledgeAlert(record.id)}
        >
          Acknowledge
        </Button>
      )
    }
  ];

  return (
    <div className="translation-manager">
      <div style={{ marginBottom: 16 }}>
        <Button icon={<DownloadOutlined />} onClick={handleExport} style={{ marginRight: 8 }}>
          Export
        </Button>
        <Upload
          accept=".json,.po"
          beforeUpload={handleImport}
          showUploadList={false}
        >
          <Button icon={<UploadOutlined />}>Import</Button>
        </Upload>
      </div>

      <Tabs defaultActiveKey="translations">
        <TabPane tab="Translations" key="translations">
          <Table 
            dataSource={translations} 
            columns={columns} 
            rowKey="id"
            loading={loading}
            pagination={{ pageSize: 50 }}
          />
        </TabPane>
        <TabPane tab={`Missing (${missingAlerts.length})`} key="missing">
          <Table 
            dataSource={missingAlerts} 
            columns={missingColumns} 
            rowKey="id"
          />
        </TabPane>
      </Tabs>

      <Modal
        title="Edit Translation"
        visible={editModal}
        onCancel={() => setEditModal(false)}
        footer={null}
      >
        <Form form={form} onFinish={handleSave}>
          <Form.Item name="error_code" label="Error Code" rules={[{ required: true }]}>
            <Input disabled={currentTranslation} />
          </Form.Item>
          <Form.Item name="language" label="Language" rules={[{ required: true }]}>
            <Select>
              <Select.Option value="zh-CN">中文（简体）</Select.Option>
              <Select.Option value="en-US">English</Select.Option>
              <Select.Option value="ja-JP">日本語</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="message" label="Message" rules={[{ required: true }]}>
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit">
              Save
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TranslationManager;
```

### 5. 定时任务配置

#### Cron Job (backend/jobs/cron.js)
```javascript
const cron = require('node-cron');
const { checkMissingTranslations } = require('./checkMissingTranslations');

// 每天凌晨 2 点检查缺失翻译
cron.schedule('0 2 * * *', () => {
  console.log('Running missing translation check...');
  checkMissingTranslations();
});

console.log('Translation check cron job scheduled');
```

### 6. 监控指标

#### Prometheus 指标 (backend/shared/translationMetrics.js)
```javascript
'use strict';

const client = require('prom-client');

const translationMetrics = {
  cacheHits: new client.Counter({
    name: 'translation_cache_hits_total',
    help: 'Total number of translation cache hits',
    labelNames: ['language']
  }),
  
  cacheMisses: new client.Counter({
    name: 'translation_cache_misses_total',
    help: 'Total number of translation cache misses',
    labelNames: ['language']
  }),
  
  fallbackUsed: new client.Counter({
    name: 'translation_fallback_used_total',
    help: 'Total number of fallback translations used',
    labelNames: ['error_code', 'requested_lang', 'fallback_lang']
  }),
  
  missingTranslations: new client.Gauge({
    name: 'translation_missing_total',
    help: 'Number of missing translations',
    labelNames: ['severity']
  }),
  
  translationLatency: new client.Histogram({
    name: 'translation_lookup_duration_seconds',
    help: 'Time spent looking up translations',
    labelNames: ['source'], // 'cache' or 'database'
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1]
  })
};

module.exports = translationMetrics;
```

## 验收标准

- [ ] 数据库表结构正确创建并通过迁移测试
- [ ] 动态翻译管理器能够从数据库加载翻译并缓存
- [ ] 缺少翻译时使用回退策略获取消息
- [ ] 翻译 CRUD API 正常工作，支持创建、更新、删除操作
- [ ] 管理后台能够显示翻译列表并支持编辑
- [ ] 批量导入导出功能正常工作（JSON 和 PO 格式）
- [ ] 缺失翻译检测定时任务正常运行并发送邮件告警
- [ ] 所有翻译变更有审计日志记录
- [ ] Prometheus 指标正常收集
- [ ] 单元测试覆盖率达到 80%+
- [ ] API 文档完整（OpenAPI 格式）
- [ ] 性能测试：翻译查询延迟 < 5ms（缓存命中），< 20ms（数据库查询）
- [ ] 安全性测试：非管理员无法修改翻译
- [ ] 审计日志查询功能可用

## 影响范围

- **新增文件**:
  - `backend/shared/DynamicTranslationManager.js`
  - `backend/jobs/checkMissingTranslations.js`
  - `backend/shared/translationMetrics.js`
  - `frontend/admin-dashboard/src/components/TranslationManager.jsx`
  - `database/migrations/*_create_error_translations_tables.sql`

- **修改文件**:
  - `backend/shared/errorHandler.js` - 集成动态翻译管理器
  - `backend/services/user-service/index.js` - 挂载翻译管理路由
  - `backend/jobs/cron.js` - 添加缺失翻译检测定时任务
  - `docs/api-spec/openapi.yaml` - 添加翻译 API 文档

- **数据库变更**:
  - 新增 `error_translations` 表
  - 新增 `error_translation_audit` 表
  - 新增 `missing_translation_alerts` 表

- **运维变更**:
  - 添加邮件告警配置（SMTP）
  - 添加缺失翻译检测定时任务
  - 添加翻译缓存监控

## 参考

- [i18next - Internationalization framework](https://www.i18next.com/)
- [GNU gettext PO file format](https://www.gnu.org/software/gettext/manual/html_node/PO-Files.html)
- [PostgreSQL JSONB performance](https://www.postgresql.org/docs/current/datatype-json.html)
- [Prometheus best practices](https://prometheus.io/docs/practices/)
