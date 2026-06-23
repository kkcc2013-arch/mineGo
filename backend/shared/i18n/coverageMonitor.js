// backend/shared/i18n/coverageMonitor.js
// REQ-00294: 翻译覆盖率监控与质量反馈系统

'use strict';

const { Pool } = require('pg');
const Redis = require('ioredis');
const Prometheus = require('prom-client');
const { createLogger } = require('../logger');

const logger = createLogger('coverage-monitor');

class TranslationCoverageMonitor {
  constructor() {
    this.db = new Pool({ connectionString: process.env.DATABASE_URL });
    this.redis = new Redis(process.env.REDIS_URL);
    
    // Prometheus 指标
    this.metrics = {
      coverageGauge: new Prometheus.Gauge({
        name: 'i18n_translation_coverage_percent',
        help: 'Translation coverage percentage by locale',
        labelNames: ['locale', 'context']
      }),
      
      missingKeysCounter: new Prometheus.Counter({
        name: 'i18n_missing_keys_total',
        help: 'Total number of missing translation keys',
        labelNames: ['locale', 'context']
      }),
      
      feedbackCounter: new Prometheus.Counter({
        name: 'i18n_translation_feedback_total',
        help: 'Translation quality feedback count',
        labelNames: ['locale', 'rating']
      }),
      
      translationsTotal: new Prometheus.Gauge({
        name: 'i18n_translations_total',
        help: 'Total number of translations',
        labelNames: ['locale', 'status']
      })
    };
  }

  /**
   * 计算翻译覆盖率
   */
  async calculateCoverage(locale) {
    const client = await this.db.connect();
    
    try {
      // 获取所有翻译键
      const allKeys = await client.query(`
        SELECT key, context
        FROM translation_keys
        WHERE status = 'active'
      `);
      
      // 获取已翻译的键
      const translatedKeys = await client.query(`
        SELECT key, context
        FROM translations
        WHERE locale = $1 AND status = 'active'
      `, [locale]);
      
      // 按上下文计算覆盖率
      const coverage = {};
      const contexts = new Set(allKeys.rows.map(k => k.context || 'default'));
      
      for (const context of contexts) {
        const total = allKeys.rows.filter(k => (k.context || 'default') === context).length;
        const translated = translatedKeys.rows.filter(k => (k.context || 'default') === context).length;
        const percentage = total > 0 ? (translated / total) * 100 : 100;
        
        coverage[context] = {
          total,
          translated,
          missing: total - translated,
          percentage: parseFloat(percentage.toFixed(2))
        };
        
        // 更新 Prometheus 指标
        this.metrics.coverageGauge.set({ locale, context }, percentage);
        this.metrics.missingKeysCounter.inc({ locale, context }, total - translated);
      }
      
      return coverage;
    } finally {
      client.release();
    }
  }

  /**
   * 检测缺失的翻译键
   */
  async findMissingTranslations(locale) {
    const client = await this.db.connect();
    
    try {
      const result = await client.query(`
        SELECT tk.key, tk.context, tk.description
        FROM translation_keys tk
        WHERE tk.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM translations t
            WHERE t.key = tk.key 
              AND t.context = tk.context
              AND t.locale = $1
              AND t.status = 'active'
          )
        ORDER BY tk.context, tk.key
      `, [locale]);
      
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * 生成覆盖率报告
   */
  async generateCoverageReport() {
    const locales = ['zh-CN', 'zh-TW', 'en-US', 'en-GB', 'ja-JP'];
    const report = {
      generatedAt: new Date().toISOString(),
      locales: {}
    };
    
    for (const locale of locales) {
      const coverage = await this.calculateCoverage(locale);
      const missing = await this.findMissingTranslations(locale);
      
      // 计算总体覆盖率
      let totalKeys = 0;
      let translatedKeys = 0;
      
      for (const ctx of Object.values(coverage)) {
        totalKeys += ctx.total;
        translatedKeys += ctx.translated;
      }
      
      const overallPercentage = totalKeys > 0 
        ? parseFloat(((translatedKeys / totalKeys) * 100).toFixed(2))
        : 100;
      
      report.locales[locale] = {
        coverage,
        overall: {
          total: totalKeys,
          translated: translatedKeys,
          missing: totalKeys - translatedKeys,
          percentage: overallPercentage
        },
        missingKeys: missing.slice(0, 20) // 只显示前20个
      };
      
      // 更新 Prometheus 指标
      this.metrics.translationsTotal.set({ locale, status: 'active' }, translatedKeys);
      this.metrics.translationsTotal.set({ locale, status: 'missing' }, totalKeys - translatedKeys);
    }
    
    return report;
  }

  /**
   * 收集玩家翻译反馈
   */
  async collectFeedback(userId, locale, key, rating, comment = null) {
    const client = await this.db.connect();
    
    try {
      await client.query(`
        INSERT INTO translation_feedback (user_id, locale, translation_key, rating, comment)
        VALUES ($1, $2, $3, $4, $5)
      `, [userId, locale, key, rating, comment]);
      
      // 更新 Prometheus 指标
      this.metrics.feedbackCounter.inc({ locale, rating });
      
      // 如果评分过低，触发告警
      if (rating <= 2) {
        await this.alertLowQualityTranslation(locale, key, rating, comment);
      }
      
      logger.info({ userId, locale, key, rating }, 'Translation feedback collected');
    } finally {
      client.release();
    }
  }

  /**
   * 低质量翻译告警
   */
  async alertLowQualityTranslation(locale, key, rating, comment) {
    logger.warn({ locale, key, rating, comment }, 'Low quality translation detected');
    
    // 发送 Redis 告警
    await this.redis.publish('i18n:quality-alert', JSON.stringify({
      locale,
      key,
      rating,
      comment,
      timestamp: new Date().toISOString()
    }));
    
    // TODO: 集成告警系统（Slack/Email）
  }

  /**
   * 获取翻译质量统计
   */
  async getQualityStats(locale, timeRange = '7d') {
    const client = await this.db.connect();
    
    try {
      const result = await client.query(`
        SELECT 
          rating,
          COUNT(*) as count,
          AVG(CASE WHEN comment IS NOT NULL THEN 1 ELSE 0 END) as comment_rate
        FROM translation_feedback
        WHERE locale = $1
          AND created_at > NOW() - INTERVAL '${timeRange}'
        GROUP BY rating
        ORDER BY rating
      `, [locale]);
      
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * 获取需要审核的翻译
   */
  async getTranslationsNeedingReview(locale) {
    const client = await this.db.connect();
    
    try {
      const result = await client.query(`
        SELECT t.key, t.value, t.context, t.created_at
        FROM translations t
        WHERE t.locale = $1
          AND t.status = 'active'
          AND t.reviewed_at IS NULL
        ORDER BY t.created_at DESC
        LIMIT 50
      `, [locale]);
      
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * 标记翻译为已审核
   */
  async markAsReviewed(locale, key, reviewerId) {
    const client = await this.db.connect();
    
    try {
      await client.query(`
        UPDATE translations
        SET reviewed_at = NOW(), reviewed_by = $3
        WHERE locale = $1 AND key = $2 AND status = 'active'
      `, [locale, key, reviewerId]);
      
      logger.info({ locale, key, reviewerId }, 'Translation marked as reviewed');
    } finally {
      client.release();
    }
  }

  /**
   * 自动验证翻译
   */
  async autoValidateTranslation(locale, key, value) {
    const issues = [];
    
    // 1. 检查空值
    if (!value || value.trim() === '') {
      issues.push({ type: 'empty', severity: 'high' });
    }
    
    // 2. 检查参数占位符一致性
    const sourceValue = await this.getSourceValue(key);
    if (sourceValue) {
      const sourceParams = this.extractParams(sourceValue);
      const targetParams = this.extractParams(value);
      
      for (const param of sourceParams) {
        if (!targetParams.includes(param)) {
          issues.push({ 
            type: 'missing_param', 
            param, 
            severity: 'high' 
          });
        }
      }
    }
    
    // 3. 检查长度异常
    const sourceLength = sourceValue?.length || 0;
    const targetLength = value?.length || 0;
    
    if (targetLength > sourceLength * 3 || targetLength < sourceLength * 0.3) {
      issues.push({ 
        type: 'length_anomaly', 
        sourceLength, 
        targetLength, 
        severity: 'medium' 
      });
    }
    
    return {
      valid: issues.length === 0,
      issues
    };
  }

  /**
   * 提取参数占位符
   */
  extractParams(text) {
    const params = [];
    const regex = /\{(\w+)\}/g;
    let match;
    
    while ((match = regex.exec(text)) !== null) {
      params.push(match[1]);
    }
    
    return params;
  }

  /**
   * 获取源语言值
   */
  async getSourceValue(key) {
    const client = await this.db.connect();
    
    try {
      const result = await client.query(`
        SELECT value FROM translations
        WHERE key = $1 AND locale = 'en-US' AND status = 'active'
      `, [key]);
      
      return result.rows[0]?.value || null;
    } finally {
      client.release();
    }
  }
}

module.exports = new TranslationCoverageMonitor();