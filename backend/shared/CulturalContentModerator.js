// backend/shared/CulturalContentModerator.js
// REQ-00495: 文化敏感内容审核服务
'use strict';

const { query } = require('./db');
const { getCulturalContentFilter } = require('./CulturalContentFilter');
const { createLogger } = require('./logger');

const logger = createLogger('cultural-moderator');

class CulturalContentModerator {
  constructor(dbPool) {
    this.db = dbPool;
    this.culturalFilter = getCulturalContentFilter();
    this.sensitiveWordsCache = new Map();
    this.cacheTimeout = 3600000; // 1 hour
  }

  /**
   * 多文化敏感内容审核
   * @param {string} content - 待审核内容
   * @param {string} language - 语言代码
   * @param {string} regionCode - 地区代码
   * @param {string} contentType - 内容类型（nickname/guild_name/message）
   * @returns {object} 审核结果
   */
  async moderateUserContent(content, language, regionCode, contentType = 'ugc') {
    if (!content || typeof content !== 'string') {
      return { passed: false, reason: 'invalid_content' };
    }

    const trimmedContent = content.trim();
    if (trimmedContent.length === 0) {
      return { passed: false, reason: 'empty_content' };
    }

    const result = {
      passed: true,
      originalContent: content,
      filteredContent: content,
      detected: [],
      action: 'approve',
      severity: 0
    };

    try {
      // 1. 基础长度检查
      const lengthCheck = this.checkContentLength(trimmedContent, contentType);
      if (!lengthCheck.passed) {
        return lengthCheck;
      }

      // 2. 文化敏感词检查
      const culturalCheck = await this.checkCulturalSensitivity(trimmedContent, language);
      if (!culturalCheck.passed) {
        result.passed = false;
        result.detected = culturalCheck.detected;
        result.action = culturalCheck.action;
        result.severity = Math.max(result.severity, culturalCheck.severity);
        
        // 如果是替换模式，更新过滤后的内容
        if (culturalCheck.filteredContent) {
          result.filteredContent = culturalCheck.filteredContent;
        }
        
        // 如果需要拒绝，直接返回
        if (culturalCheck.action === 'reject') {
          result.reason = 'cultural_sensitivity_violation';
          await this.logModeration(contentType, null, content, result);
          return result;
        }
      }

      // 3. 政治敏感内容检测（特定地区）
      if (['CN', 'HK', 'MO', 'TW'].includes(regionCode)) {
        const politicalCheck = await this.checkPoliticalSensitivity(trimmedContent, language);
        if (!politicalCheck.passed) {
          result.passed = false;
          result.detected.push(...politicalCheck.detected);
          result.action = 'reject';
          result.severity = Math.max(result.severity, politicalCheck.severity);
          result.reason = 'political_sensitivity_violation';
          await this.logModeration(contentType, null, content, result);
          return result;
        }
      }

      // 4. 宗教敏感内容检测（中东地区）
      if (['SA', 'AE', 'KW', 'QA', 'BH', 'OM'].includes(regionCode)) {
        const religiousCheck = await this.checkReligiousSensitivity(trimmedContent, language);
        if (!religiousCheck.passed) {
          result.passed = false;
          result.detected.push(...religiousCheck.detected);
          result.action = 'reject';
          result.severity = Math.max(result.severity, religiousCheck.severity);
          result.reason = 'religious_sensitivity_violation';
          await this.logModeration(contentType, null, content, result);
          return result;
        }
      }

      // 5. 商标侵权检测
      const trademarkCheck = await this.checkTrademarkViolation(trimmedContent, language);
      if (!trademarkCheck.passed) {
        result.passed = false;
        result.detected.push(...trademarkCheck.detected);
        result.action = trademarkCheck.action;
        result.severity = Math.max(result.severity, trademarkCheck.severity);
        result.reason = 'trademark_violation';
        await this.logModeration(contentType, null, content, result);
        return result;
      }

      // 6. 根据严重程度决定最终动作
      if (result.severity >= 80) {
        result.action = 'reject';
        result.passed = false;
      } else if (result.severity >= 50) {
        result.action = 'review';
        result.status = 'pending_manual_review';
      } else if (result.severity >= 20) {
        result.action = 'warn';
        result.warning = '内容包含敏感词汇，请注意文明用语';
      }

      // 记录审核日志
      await this.logModeration(contentType, null, content, result);

      return result;
    } catch (err) {
      logger.error({ err, content, language, regionCode }, 'Content moderation failed');
      // 失败时默认通过（降级）
      return { passed: true, action: 'approve_fallback' };
    }
  }

  /**
   * 检查内容长度
   */
  checkContentLength(content, contentType) {
    const limits = {
      'nickname': { min: 2, max: 30 },
      'guild_name': { min: 2, max: 20 },
      'message': { min: 1, max: 500 }
    };

    const limit = limits[contentType] || limits['message'];
    
    if (content.length < limit.min) {
      return {
        passed: false,
        reason: 'content_too_short',
        min: limit.min
      };
    }

    if (content.length > limit.max) {
      return {
        passed: false,
        reason: 'content_too_long',
        max: limit.max,
        current: content.length
      };
    }

    return { passed: true };
  }

  /**
   * 检查文化敏感词
   */
  async checkCulturalSensitivity(content, language) {
    const sensitiveWords = await this.loadSensitiveWords(language);
    const detected = [];
    const lowerContent = content.toLowerCase();
    let filteredContent = content;
    let maxSeverity = 0;

    for (const wordInfo of sensitiveWords) {
      const word = wordInfo.word.toLowerCase();
      
      if (lowerContent.includes(word)) {
        detected.push({
          word: wordInfo.word,
          type: wordInfo.sensitivity_type,
          context: wordInfo.cultural_context,
          action: wordInfo.action,
          severity: wordInfo.severity
        });

        maxSeverity = Math.max(maxSeverity, wordInfo.severity);

        // 替换敏感词（用 *** 替代）
        if (wordInfo.action === 'replace' || wordInfo.action === 'reject') {
          const regex = new RegExp(wordInfo.word, 'gi');
          filteredContent = filteredContent.replace(regex, '***');
        }
      }
    }

    if (detected.length === 0) {
      return { passed: true };
    }

    // 根据检测到的最高严重程度决定动作
    let action = 'warn';
    if (maxSeverity >= 80) {
      action = 'reject';
    } else if (maxSeverity >= 50) {
      action = 'review';
    }

    return {
      passed: action !== 'reject',
      detected,
      action,
      severity: maxSeverity,
      filteredContent: filteredContent !== content ? filteredContent : null
    };
  }

  /**
   * 检查政治敏感性
   */
  async checkPoliticalSensitivity(content, language) {
    const politicalKeywords = {
      'zh': ['敏感词示例1', '敏感词示例2'],
      'zh-CN': ['敏感词示例1', '敏感词示例2']
    };

    const keywords = politicalKeywords[language] || [];
    const detected = [];
    const lowerContent = content.toLowerCase();

    for (const keyword of keywords) {
      if (lowerContent.includes(keyword.toLowerCase())) {
        detected.push({
          word: keyword,
          type: 'politics',
          action: 'reject',
          severity: 100
        });
      }
    }

    if (detected.length === 0) {
      return { passed: true };
    }

    return {
      passed: false,
      detected,
      severity: 100
    };
  }

  /**
   * 检查宗教敏感性
   */
  async checkReligiousSensitivity(content, language) {
    // 加载宗教敏感词
    const religiousKeywords = await this.loadSensitiveWordsByType('religion', language);
    const detected = [];
    const lowerContent = content.toLowerCase();

    for (const wordInfo of religiousKeywords) {
      const word = wordInfo.word.toLowerCase();
      if (lowerContent.includes(word)) {
        detected.push({
          word: wordInfo.word,
          type: 'religion',
          context: wordInfo.cultural_context,
          action: 'reject',
          severity: wordInfo.severity
        });
      }
    }

    if (detected.length === 0) {
      return { passed: true };
    }

    return {
      passed: false,
      detected,
      severity: Math.max(...detected.map(d => d.severity))
    };
  }

  /**
   * 检查商标侵权
   */
  async checkTrademarkViolation(content, language) {
    const trademarks = await this.loadSensitiveWordsByType('trademark', language);
    const detected = [];
    const lowerContent = content.toLowerCase();

    for (const tm of trademarks) {
      const word = tm.word.toLowerCase();
      if (lowerContent.includes(word)) {
        detected.push({
          word: tm.word,
          type: 'trademark',
          action: tm.action,
          severity: tm.severity
        });
      }
    }

    if (detected.length === 0) {
      return { passed: true };
    }

    const maxSeverity = Math.max(...detected.map(d => d.severity));
    const action = maxSeverity >= 70 ? 'reject' : 'review';

    return {
      passed: action !== 'reject',
      detected,
      action,
      severity: maxSeverity
    };
  }

  /**
   * 加载敏感词库
   */
  async loadSensitiveWords(language) {
    const cacheKey = `sensitive:${language}`;
    const cached = this.sensitiveWordsCache.get(cacheKey);
    
    if (cached) {
      return cached;
    }

    try {
      const { rows } = await query(`
        SELECT word, sensitivity_type, cultural_context, action, severity
        FROM cultural_sensitive_words
        WHERE language = $1 OR language = 'all'
      `, [language]);

      this.sensitiveWordsCache.set(cacheKey, rows);
      setTimeout(() => this.sensitiveWordsCache.delete(cacheKey), this.cacheTimeout);

      return rows;
    } catch (err) {
      logger.error({ err, language }, 'Failed to load sensitive words');
      return [];
    }
  }

  /**
   * 加载特定类型的敏感词
   */
  async loadSensitiveWordsByType(type, language) {
    const cacheKey = `sensitive:${type}:${language}`;
    const cached = this.sensitiveWordsCache.get(cacheKey);
    
    if (cached) {
      return cached;
    }

    try {
      const { rows } = await query(`
        SELECT word, sensitivity_type, cultural_context, action, severity
        FROM cultural_sensitive_words
        WHERE sensitivity_type = $1 AND (language = $2 OR language = 'all')
      `, [type, language]);

      this.sensitiveWordsCache.set(cacheKey, rows);
      setTimeout(() => this.sensitiveWordsCache.delete(cacheKey), this.cacheTimeout);

      return rows;
    } catch (err) {
      logger.error({ err, type, language }, 'Failed to load sensitive words by type');
      return [];
    }
  }

  /**
   * 记录审核日志
   */
  async logModeration(contentType, contentId, originalContent, result) {
    try {
      await query(`
        INSERT INTO content_moderation_logs (
          content_type, content_id, original_content, filtered_content,
          detected_violations, action_taken, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        contentType,
        contentId,
        originalContent,
        result.filteredContent,
        JSON.stringify(result.detected),
        result.action,
        result.passed ? 'approved' : (result.action === 'review' ? 'pending' : 'rejected')
      ]);

      logger.info({
        contentType,
        contentId,
        action: result.action,
        severity: result.severity
      }, 'Content moderation logged');
    } catch (err) {
      logger.error({ err, contentType }, 'Failed to log moderation');
    }
  }

  /**
   * 批量审核
   */
  async batchModerate(items, language, regionCode) {
    const results = [];
    
    for (const item of items) {
      const result = await this.moderateUserContent(
        item.content,
        language,
        regionCode,
        item.type
      );
      
      results.push({
        ...item,
        moderation: result
      });
    }

    return results;
  }

  /**
   * 获取审核统计
   */
  async getModerationStats(days = 7) {
    try {
      const { rows } = await query(`
        SELECT 
          content_type,
          action_taken,
          COUNT(*) as count,
          AVG(
            JSONB_ARRAY_LENGTH(detected_violations)
          ) as avg_violations
        FROM content_moderation_logs
        WHERE created_at >= NOW() - INTERVAL '${days} days'
        GROUP BY content_type, action_taken
        ORDER BY content_type, action_taken
      `);

      return rows;
    } catch (err) {
      logger.error({ err, days }, 'Failed to get moderation stats');
      return [];
    }
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this.sensitiveWordsCache.clear();
    logger.info('Sensitive words cache cleared');
  }
}

// 单例实例
let instance = null;

/**
 * 获取或创建 CulturalContentModerator 实例
 */
function getCulturalContentModerator(dbPool) {
  if (!instance) {
    instance = new CulturalContentModerator(dbPool);
  }
  return instance;
}

module.exports = {
  CulturalContentModerator,
  getCulturalContentModerator
};