/**
 * 复数形式本地化引擎 - 基于 CLDR 标准复数规则
 * 支持所有语言的复数形式，包括中文（无复数）、英文（单数/其他）、俄语（4种）、阿拉伯语（6种）等
 */

const PluralRuleMatcher = require('./PluralRuleMatcher');
const PluralContextAnalyzer = require('./PluralContextAnalyzer');
const PluralTranslationCache = require('./PluralTranslationCache');
const PluralValidator = require('./PluralValidator');
const logger = require('../logger');

/**
 * CLDR 复数类别定义
 * 参考：https://unicode-org.github.io/cldr-staging/charts/37/supplemental/language_plural_rules.html
 */
const PLURAL_CATEGORIES = {
  'zh-CN': ['other'],           // 中文无复数形式
  'zh-TW': ['other'],
  'ja-JP': ['other'],           // 日语无复数形式
  'en-US': ['one', 'other'],    // 英语：单数和其他
  'en-GB': ['one', 'other'],
  'es-ES': ['one', 'other'],    // 西班牙语
  'es-MX': ['one', 'other'],
  'fr-FR': ['one', 'other'],    // 法语：one 用于 0 和 1
  'de-DE': ['one', 'other'],    // 德语
  'ru-RU': ['one', 'few', 'many', 'other'], // 俄语 4 种形式
  'pl-PL': ['one', 'few', 'many', 'other'], // 波兰语 4 种形式
  'ar-SA': ['zero', 'one', 'two', 'few', 'many', 'other'], // 阿拉伯语 6 种形式
  'he-IL': ['one', 'two', 'many', 'other'], // 希伯来语
  'pt-BR': ['one', 'other'],
  'ko-KR': ['other'],           // 韩语无复数
  'th-TH': ['other'],           // 泰语无复数
  'vi-VN': ['other'],           // 越南语无复数
  'it-IT': ['one', 'other'],    // 意大利语
  'nl-NL': ['one', 'other'],    // 荷兰语
  'tr-TR': ['one', 'other'],    // 土耳其语
  'uk-UA': ['one', 'few', 'many', 'other'], // 乌克兰语
  'cs-CZ': ['one', 'few', 'many', 'other'], // 捷克语
  'el-GR': ['one', 'other']     // 希腊语
};

/**
 * 复数后缀映射
 */
const PLURAL_SUFFIXES = {
  '_zero': 'zero',
  '_one': 'one',
  '_two': 'two',
  '_few': 'few',
  '_many': 'many',
  '_other': 'other'
};

class PluralFormLocalization {
  constructor(options = {}) {
    this.ruleMatcher = new PluralRuleMatcher();
    this.contextAnalyzer = new PluralContextAnalyzer();
    this.cache = new PluralTranslationCache(options.cacheOptions);
    this.validator = new PluralValidator();
    this.translationLoader = options.translationLoader || null;
    this.defaultLocale = options.defaultLocale || 'en-US';
    
    // 复数类别映射
    this.pluralCategories = PLURAL_CATEGORIES;
    this.pluralSuffixes = PLURAL_SUFFIXES;
    
    logger.info('[PluralFormLocalization] Initialized with support for', 
      Object.keys(this.pluralCategories).length, 'locales');
  }

  /**
   * 本地化复数消息
   * @param {string} key - 翻译键
   * @param {number} count - 数量
   * @param {string} locale - 语言代码（如 'en-US', 'ru-RU'）
   * @param {Object} params - 其他参数（如 { pokemon: 'Pikachu' }）
   * @param {string} context - 上下文类型（noun/verb/adjective）
   * @returns {Promise<string>} 本地化后的消息
   */
  async localizePlural(key, count, locale = this.defaultLocale, params = {}, context = 'noun') {
    try {
      // 1. 验证参数
      this.validator.validateInput(key, count, locale);

      // 2. 选择复数形式
      const pluralForm = this.selectPluralForm(count, locale);

      // 3. 构建复数键
      const pluralKey = this.buildPluralKey(key, pluralForm);

      // 4. 获取翻译（优先从缓存）
      let translation = await this.cache.get(pluralKey, locale);
      
      if (!translation) {
        // 尝试加载翻译
        translation = await this.loadTranslation(pluralKey, locale, key);
      }

      // 5. 如果没有找到复数键，尝试默认键
      if (!translation) {
        translation = await this.cache.get(key, locale) || 
                      await this.loadTranslation(key, locale);
      }

      // 6. 如果仍无翻译，使用 fallback
      if (!translation) {
        translation = this.getFallbackMessage(key, count, locale, pluralForm);
        logger.warn(`[PluralFormLocalization] No translation found for key: ${key}, locale: ${locale}`);
      }

      // 7. 应用上下文分析（名词/动词/形容词）
      if (context !== 'noun') {
        translation = await this.contextAnalyzer.applyContext(translation, count, locale, context);
      }

      // 8. 替换参数（包括 {{count}}）
      const message = this.interpolateParams(translation, { ...params, count });

      // 9. 缓存结果
      await this.cache.set(pluralKey, locale, translation);

      return message;
    } catch (error) {
      logger.error('[PluralFormLocalization] Error in localizePlural:', error);
      // Fallback 到简单格式
      return this.getFallbackMessage(key, count, locale, 'other');
    }
  }

  /**
   * 选择正确的复数形式
   * @param {number} count - 数量
   * @param {string} locale - 语言代码
   * @returns {string} 复数类别（one/few/many/other 等）
   */
  selectPluralForm(count, locale) {
    // 特殊处理：负数和小数
    const absCount = Math.abs(count);
    const isInteger = Number.isInteger(absCount);

    // 获取该语言支持的复数类别
    const categories = this.getPluralCategories(locale);
    
    // 如果该语言只有 'other' 类别，直接返回
    if (categories.length === 1 && categories[0] === 'other') {
      return 'other';
    }

    // 使用规则匹配器计算复数形式
    return this.ruleMatcher.matchRule(absCount, locale, isInteger);
  }

  /**
   * 构建复数键
   * @param {string} baseKey - 基础键
   * @param {string} pluralForm - 复数形式
   * @returns {string} 复数键
   */
  buildPluralKey(baseKey, pluralForm) {
    return `${baseKey}_${pluralForm}`;
  }

  /**
   * 获取语言支持的复数类别
   * @param {string} locale - 语言代码
   * @returns {string[]} 复数类别数组
   */
  getPluralCategories(locale) {
    // 尝试精确匹配
    if (this.pluralCategories[locale]) {
      return this.pluralCategories[locale];
    }

    // 尝试语言前缀匹配（如 'en' 匹配 'en-US'）
    const langPrefix = locale.split('-')[0];
    for (const [key, categories] of Object.entries(this.pluralCategories)) {
      if (key.startsWith(langPrefix)) {
        return categories;
      }
    }

    // 默认返回 'other'
    return ['other'];
  }

  /**
   * 格式化复数消息（批量处理）
   * @param {Object[]} messages - 消息数组 [{ key, count, params }]
   * @param {string} locale - 语言代码
   * @returns {Promise<string[]>} 本地化后的消息数组
   */
  async formatPluralMessages(messages, locale) {
    const results = [];
    
    for (const msg of messages) {
      const message = await this.localizePlural(
        msg.key, 
        msg.count, 
        locale, 
        msg.params || {},
        msg.context || 'noun'
      );
      results.push(message);
    }
    
    return results;
  }

  /**
   * 加载翻译
   * @param {string} key - 翻译键
   * @param {string} locale - 语言代码
   * @param {string} fallbackKey - 备用键
   * @returns {Promise<string|null>} 翻译文本
   */
  async loadTranslation(key, locale, fallbackKey = null) {
    if (!this.translationLoader) {
      return null;
    }

    try {
      // 尝试加载精确键
      const translation = await this.translationLoader.load(key, locale);
      
      if (translation) {
        return translation;
      }

      // 尝试备用键
      if (fallbackKey) {
        return await this.translationLoader.load(fallbackKey, locale);
      }

      return null;
    } catch (error) {
      logger.error('[PluralFormLocalization] Error loading translation:', error);
      return null;
    }
  }

  /**
   * 获取 fallback 消息
   * @param {string} key - 翻译键
   * @param {number} count - 数量
   * @param {string} locale - 语言代码
   * @param {string} pluralForm - 复数形式
   * @returns {string} fallback 消息
   */
  getFallbackMessage(key, count, locale, pluralForm) {
    // 特殊情况的 fallback
    const fallbacks = {
      'catch.success': {
        'en-US': {
          one: 'You caught 1 Pokemon',
          other: `You caught ${count} Pokemon`
        },
        'ru-RU': {
          one: 'Вы поймали 1 Покемона',
          few: `Вы поймали ${count} Покемона`,
          many: `Вы поймали ${count} Покемонов`,
          other: `Вы поймали ${count} Покемонов`
        },
        'zh-CN': {
          other: `你捕获了 ${count} 只精灵`
        },
        'ja-JP': {
          other: `${count}匹のポケモンを捕まえた`
        }
      },
      'pokemon.count': {
        'en-US': {
          one: '1 Pokemon',
          other: `${count} Pokemon`
        },
        'zh-CN': {
          other: `${count} 只精灵`
        }
      },
      'items.in_bag': {
        'en-US': {
          one: '1 item in bag',
          other: `${count} items in bag`
        },
        'zh-CN': {
          other: `背包中有 ${count} 个物品`
        }
      }
    };

    // 尝试从 fallback 映射获取
    if (fallbacks[key] && fallbacks[key][locale]) {
      return fallbacks[key][locale][pluralForm] || fallbacks[key][locale]['other'];
    }

    // 默认 fallback
    if (locale.startsWith('zh') || locale.startsWith('ja') || locale.startsWith('ko')) {
      return `${key}: ${count}`;
    }

    // 英文及其他语言的简单 fallback
    if (count === 1) {
      return `${key} (1 item)`;
    }
    return `${key} (${count} items)`;
  }

  /**
   * 替换参数（插值）
   * @param {string} template - 模板字符串
   * @param {Object} params - 参数对象
   * @returns {string} 替换后的字符串
   */
  interpolateParams(template, params) {
    if (!template) return '';
    
    let result = template;
    
    for (const [key, value] of Object.entries(params)) {
      // 支持 {{key}} 格式
      const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      result = result.replace(pattern, String(value));
      
      // 支持 ${key} 格式（兼容）
      const pattern2 = new RegExp(`\\$\\{${key}\\}`, 'g');
      result = result2 ? result.replace(pattern2, String(value)) : result;
    }
    
    return result;
  }

  /**
   * 验证复数翻译完整性
   * @param {string} baseKey - 基础键
   * @param {string} locale - 语言代码
   * @returns {Promise<Object>} 验证结果
   */
  async validatePluralTranslations(baseKey, locale) {
    return await this.validator.validateCompleteness(baseKey, locale, this.pluralCategories);
  }

  /**
   * 获取复数规则信息（用于调试/展示）
   * @param {string} locale - 语言代码
   * @returns {Object} 复数规则信息
   */
  getPluralRulesInfo(locale) {
    const categories = this.getPluralCategories(locale);
    const rules = this.ruleMatcher.getRules(locale);
    
    return {
      locale,
      categories,
      rules,
      examples: this.generateExamples(locale, categories)
    };
  }

  /**
   * 生成复数示例
   * @param {string} locale - 语言代码
   * @param {string[]} categories - 复数类别
   * @returns {Object[]} 示例数组
   */
  generateExamples(locale, categories) {
    const examples = [];
    
    for (const category of categories) {
      // 找到该类别的示例数字
      const exampleNumbers = this.findExampleNumbers(category, locale);
      examples.push({
        category,
        numbers: exampleNumbers,
        description: this.getCategoryDescription(category)
      });
    }
    
    return examples;
  }

  /**
   * 找到属于某复数类别的示例数字
   * @param {string} category - 复数类别
   * @param {string} locale - 语言代码
   * @returns {number[]} 示例数字数组
   */
  findExampleNumbers(category, locale) {
    const testNumbers = [0, 1, 2, 3, 4, 5, 10, 11, 20, 21, 22, 100, 101, 102];
    const result = [];
    
    for (const num of testNumbers) {
      if (this.selectPluralForm(num, locale) === category) {
        result.push(num);
        if (result.length >= 3) break; // 每个类别最多 3 个示例
      }
    }
    
    return result;
  }

  /**
   * 获取复数类别描述
   * @param {string} category - 复数类别
   * @returns {string} 描述
   */
  getCategoryDescription(category) {
    const descriptions = {
      'zero': '零数形式（n = 0）',
      'one': '单数形式（n = 1）',
      'two': '双数形式（n = 2）',
      'few': '少量形式（如俄语 n % 10 in 2..4）',
      'many': '大量形式（如俄语 n % 10 = 0 or n % 10 in 5..9）',
      'other': '其他形式（默认）'
    };
    
    return descriptions[category] || '未知形式';
  }

  /**
   * 清除缓存
   */
  async clearCache() {
    await this.cache.clear();
    logger.info('[PluralFormLocalization] Cache cleared');
  }

  /**
   * 获取缓存统计
   * @returns {Object} 缓存统计信息
   */
  getCacheStats() {
    return this.cache.getStats();
  }
}

module.exports = PluralFormLocalization;