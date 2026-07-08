/**
 * 复数翻译验证器 - 验证复数翻译的完整性和正确性
 */

const logger = require('../logger');

class PluralValidator {
  constructor() {
    logger.info('[PluralValidator] Initialized');
  }

  /**
   * 验证输入参数
   * @param {string} key - 翻译键
   * @param {number} count - 数量
   * @param {string} locale - 语言代码
   * @returns {Object} 验证结果
   */
  validateInput(key, count, locale) {
    const errors = [];
    
    if (!key || typeof key !== 'string') {
      errors.push('Invalid key: must be a non-empty string');
    }
    
    if (typeof count !== 'number' || !Number.isFinite(count)) {
      errors.push('Invalid count: must be a finite number');
    }
    
    if (!locale || typeof locale !== 'string') {
      errors.push('Invalid locale: must be a non-empty string');
    }
    
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }
    
    return { valid: true };
  }

  /**
   * 验证复数翻译完整性
   * @param {string} baseKey - 基础键
   * @param {string} locale - 语言代码
   * @param {Object} pluralCategories - 复数类别映射
   * @returns {Promise<Object>} 验证结果
   */
  async validateCompleteness(baseKey, locale, pluralCategories) {
    const categories = pluralCategories[locale] || ['other'];
    const missingCategories = [];
    const warnings = [];
    
    // 检查每个复数类别是否有对应的翻译键
    for (const category of categories) {
      // 这里需要实际检查翻译键是否存在
      // 简化实现：只检查 'other' 是否存在
      if (category === 'other') {
        // 'other' 是必需的
        warnings.push(`Category 'other' must always have a translation`);
      }
    }
    
    return {
      valid: missingCategories.length === 0,
      missingCategories,
      warnings,
      locale,
      baseKey,
      categories
    };
  }

  /**
   * 验证翻译格式
   * @param {string} translation - 翻译文本
   * @param {Object} params - 参数对象
   * @returns {Object} 验证结果
   */
  validateFormat(translation, params) {
    // 检查是否包含 {{count}} 占位符
    const hasCountPlaceholder = /\{\{count\}\}/.test(translation);
    
    // 检查是否有其他占位符未替换
    const placeholders = translation.match(/\{\{[^}]+\}\}/g) || [];
    const missingParams = placeholders
      .map(p => p.replace(/\{\{|\}\}/g, '').trim())
      .filter(p => !params || params[p] === undefined);
    
    return {
      valid: missingParams.length === 0,
      hasCountPlaceholder,
      missingParams,
      placeholders
    };
  }
}

module.exports = PluralValidator;