/**
 * 复数规则匹配器 - 基于 CLDR 复数规则标准
 * 参考：https://www.unicode.org/reports/tr35/tr35-numbers.html#Language_Plural_Rules
 */

const logger = require('../logger');

/**
 * CLDR 复数规则定义（简化版）
 * 完整规则参见：https://unicode-org.github.io/cldr-staging/charts/37/supplemental/language_plural_rules.html
 */
const PLURAL_RULES = {
  // 英语规则
  'en': {
    one: (n) => n === 1,
    other: () => true
  },
  'en-US': {
    one: (n) => n === 1,
    other: () => true
  },
  'en-GB': {
    one: (n) => n === 1,
    other: () => true
  },

  // 中文规则（无复数）
  'zh': {
    other: () => true
  },
  'zh-CN': {
    other: () => true
  },
  'zh-TW': {
    other: () => true
  },

  // 日语规则（无复数）
  'ja': {
    other: () => true
  },
  'ja-JP': {
    other: () => true
  },

  // 俄语规则（4 种形式）
  // one: n % 10 = 1 且 n % 100 != 11
  // few: n % 10 in 2..4 且 n % 100 not in 12..14
  // many: n % 10 = 0 或 n % 10 in 5..9 或 n % 100 in 11..14
  // other: 其他情况
  'ru': {
    one: (n) => n % 10 === 1 && n % 100 !== 11,
    few: (n) => {
      const mod10 = n % 10;
      const mod100 = n % 100;
      return mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14);
    },
    many: (n) => {
      const mod10 = n % 10;
      const mod100 = n % 100;
      return mod10 === 0 || (mod10 >= 5 && mod10 <= 9) || (mod100 >= 11 && mod100 <= 14);
    },
    other: () => true
  },
  'ru-RU': {
    one: (n) => n % 10 === 1 && n % 100 !== 11,
    few: (n) => {
      const mod10 = n % 10;
      const mod100 = n % 100;
      return mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14);
    },
    many: (n) => {
      const mod10 = n % 10;
      const mod100 = n % 100;
      return mod10 === 0 || (mod10 >= 5 && mod10 <= 9) || (mod100 >= 11 && mod100 <= 14);
    },
    other: () => true
  },

  // 阿拉伯语规则（6 种形式）
  // zero: n = 0
  // one: n = 1
  // two: n = 2
  // few: n % 100 in 3..10
  // many: n % 100 in 11..99
  // other: 其他情况（包括负数和小数）
  'ar': {
    zero: (n) => n === 0,
    one: (n) => n === 1,
    two: (n) => n === 2,
    few: (n) => n % 100 >= 3 && n % 100 <= 10,
    many: (n) => n % 100 >= 11 && n % 100 <= 99,
    other: () => true
  },
  'ar-SA': {
    zero: (n) => n === 0,
    one: (n) => n === 1,
    two: (n) => n === 2,
    few: (n) => n % 100 >= 3 && n % 100 <= 10,
    many: (n) => n % 100 >= 11 && n % 100 <= 99,
    other: () => true
  },

  // 波兰语规则（类似俄语）
  'pl': {
    one: (n) => n === 1,
    few: (n) => {
      const mod10 = n % 10;
      const mod100 = n % 100;
      return mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14);
    },
    many: (n) => {
      const mod10 = n % 10;
      const mod100 = n % 100;
      return (n !== 1 && mod10 >= 0 && mod10 <= 1) || (mod10 >= 5 && mod10 <= 9) || (mod100 >= 12 && mod100 <= 14);
    },
    other: () => true
  },
  'pl-PL': {
    one: (n) => n === 1,
    few: (n) => {
      const mod10 = n % 10;
      const mod100 = n % 100;
      return mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14);
    },
    many: (n) => {
      const mod10 = n % 10;
      const mod100 = n % 100;
      return (n !== 1 && mod10 >= 0 && mod10 <= 1) || (mod10 >= 5 && mod10 <= 9) || (mod100 >= 12 && mod100 <= 14);
    },
    other: () => true
  },

  // 法语规则（one 用于 0 和 1）
  'fr': {
    one: (n) => n === 0 || n === 1,
    other: () => true
  },
  'fr-FR': {
    one: (n) => n === 0 || n === 1,
    other: () => true
  },

  // 德语规则
  'de': {
    one: (n) => n === 1,
    other: () => true
  },
  'de-DE': {
    one: (n) => n === 1,
    other: () => true
  },

  // 西班牙语规则
  'es': {
    one: (n) => n === 1,
    other: () => true
  },
  'es-ES': {
    one: (n) => n === 1,
    other: () => true
  },
  'es-MX': {
    one: (n) => n === 1,
    other: () => true
  },

  // 希伯来语规则
  'he': {
    one: (n) => n === 1,
    two: (n) => n === 2,
    many: (n) => n >= 10 && n % 10 === 0,
    other: () => true
  },
  'he-IL': {
    one: (n) => n === 1,
    two: (n) => n === 2,
    many: (n) => n >= 10 && n % 10 === 0,
    other: () => true
  },

  // 乌克兰语规则（类似俄语）
  'uk': {
    one: (n) => n % 10 === 1 && n % 100 !== 11,
    few: (n) => {
      const mod10 = n % 10;
      const mod100 = n % 100;
      return mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14);
    },
    many: (n) => {
      const mod10 = n % 10;
      const mod100 = n % 100;
      return mod10 === 0 || (mod10 >= 5 && mod10 <= 9) || (mod100 >= 11 && mod100 <= 14);
    },
    other: () => true
  },
  'uk-UA': {
    one: (n) => n % 10 === 1 && n % 100 !== 11,
    few: (n) => {
      const mod10 = n % 10;
      const mod100 = n % 100;
      return mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14);
    },
    many: (n) => {
      const mod10 = n % 10;
      const mod100 = n % 100;
      return mod10 === 0 || (mod10 >= 5 && mod10 <= 9) || (mod100 >= 11 && mod100 <= 14);
    },
    other: () => true
  },

  // 捷克语规则
  'cs': {
    one: (n) => n === 1,
    few: (n) => n >= 2 && n <= 4,
    many: () => false, // 捷克语通常不使用 many
    other: () => true
  },
  'cs-CZ': {
    one: (n) => n === 1,
    few: (n) => n >= 2 && n <= 4,
    many: () => false,
    other: () => true
  },

  // 意大利语规则
  'it': {
    one: (n) => n === 1,
    other: () => true
  },
  'it-IT': {
    one: (n) => n === 1,
    other: () => true
  },

  // 荷兰语规则
  'nl': {
    one: (n) => n === 1,
    other: () => true
  },
  'nl-NL': {
    one: (n) => n === 1,
    other: () => true
  },

  // 土耳其语规则
  'tr': {
    one: (n) => n === 1,
    other: () => true
  },
  'tr-TR': {
    one: (n) => n === 1,
    other: () => true
  },

  // 希腊语规则
  'el': {
    one: (n) => n === 1,
    other: () => true
  },
  'el-GR': {
    one: (n) => n === 1,
    other: () => true
  },

  // 韩语规则（无复数）
  'ko': {
    other: () => true
  },
  'ko-KR': {
    other: () => true
  },

  // 泰语规则（无复数）
  'th': {
    other: () => true
  },
  'th-TH': {
    other: () => true
  },

  // 越南语规则（无复数）
  'vi': {
    other: () => true
  },
  'vi-VN': {
    other: () => true
  },

  // 葡萄牙语规则
  'pt': {
    one: (n) => n === 1,
    other: () => true
  },
  'pt-BR': {
    one: (n) => n === 1,
    other: () => true
  }
};

/**
 * 复数类别优先级（按 CLDR 定义顺序）
 */
const CATEGORY_PRIORITY = ['zero', 'one', 'two', 'few', 'many', 'other'];

class PluralRuleMatcher {
  constructor() {
    this.rules = PLURAL_RULES;
    this.categoryPriority = CATEGORY_PRIORITY;
    
    logger.info('[PluralRuleMatcher] Initialized with rules for', 
      Object.keys(this.rules).length, 'locales');
  }

  /**
   * 匹配复数规则
   * @param {number} count - 数量（绝对值）
   * @param {string} locale - 语言代码
   * @param {boolean} isInteger - 是否为整数
   * @returns {string} 复数类别
   */
  matchRule(count, locale, isInteger = true) {
    // 转换为整数处理
    const n = Math.floor(count);

    // 获取该语言的规则
    const rules = this.getRules(locale);

    if (!rules) {
      logger.warn(`[PluralRuleMatcher] No rules found for locale: ${locale}, using 'other'`);
      return 'other';
    }

    // 按优先级顺序匹配
    for (const category of this.categoryPriority) {
      if (rules[category]) {
        try {
          if (rules[category](n)) {
            return category;
          }
        } catch (error) {
          logger.error(`[PluralRuleMatcher] Error evaluating rule for ${locale}.${category}:`, error);
        }
      }
    }

    // 如果所有规则都不匹配，返回 'other'
    return 'other';
  }

  /**
   * 获取语言规则
   * @param {string} locale - 语言代码
   * @returns {Object|null} 规则对象
   */
  getRules(locale) {
    // 精确匹配
    if (this.rules[locale]) {
      return this.rules[locale];
    }

    // 语言前缀匹配（如 'en' 匹配 'en-US'）
    const langPrefix = locale.split('-')[0];
    if (this.rules[langPrefix]) {
      return this.rules[langPrefix];
    }

    // 尝试查找相近语言
    for (const [key, rules] of Object.entries(this.rules)) {
      if (key.startsWith(langPrefix)) {
        return rules;
      }
    }

    return null;
  }

  /**
   * 解析 CLDR 规则表达式（字符串格式）
   * @param {string} expression - CLDR 规则表达式（如 'n % 10 = 1 and n % 100 != 11'）
   * @returns {Function} 规则函数
   */
  parseRuleExpression(expression) {
    if (!expression || expression.trim() === '') {
      return () => true; // 空规则总是返回 true
    }

    try {
      // 转换 CLDR 表达式为 JavaScript
      // CLDR 使用 'n' 表示数字，'and' 'or' 表示逻辑运算
      // '=' 表示等于，'!=' 表示不等于，'%' 表示取模
      
      let jsExpression = expression
        .replace(/n/g, 'n')
        .replace(/and/gi, '&&')
        .replace(/or/gi, '||')
        .replace(/=/g, '===')
        .replace(/!=/g, '!==')
        .replace(/\.\./g, '>= && <=') // 处理范围表达式（简化版）
        .replace(/in/gi, '>= && <='); // 处理 'in' 关键字

      // 创建规则函数
      return new Function('n', `return ${jsExpression};`);
    } catch (error) {
      logger.error('[PluralRuleMatcher] Error parsing rule expression:', expression, error);
      return () => false;
    }
  }

  /**
   * 计算规则结果
   * @param {number} count - 数量
   * @param {Function|Object} rule - 规则函数或规则对象
   * @returns {boolean} 规则是否匹配
   */
  evaluateRule(count, rule) {
    if (typeof rule === 'function') {
      try {
        return rule(count);
      } catch (error) {
        logger.error('[PluralRuleMatcher] Error evaluating rule:', error);
        return false;
      }
    }

    if (typeof rule === 'object' && rule.test) {
      // 支持正则表达式规则
      return rule.test(String(count));
    }

    return false;
  }

  /**
   * 添加自定义规则
   * @param {string} locale - 语言代码
   * @param {Object} customRules - 自定义规则对象
   */
  addCustomRules(locale, customRules) {
    if (!this.rules[locale]) {
      this.rules[locale] = {};
    }

    for (const [category, rule] of Object.entries(customRules)) {
      if (typeof rule === 'string') {
        // 字符串规则，解析为函数
        this.rules[locale][category] = this.parseRuleExpression(rule);
      } else if (typeof rule === 'function') {
        this.rules[locale][category] = rule;
      }
    }

    logger.info(`[PluralRuleMatcher] Added custom rules for locale: ${locale}`);
  }

  /**
   * 批量匹配复数规则
   * @param {number[]} counts - 数量数组
   * @param {string} locale - 语言代码
   * @returns {Object[]} 匹配结果数组 [{ count, category }]
   */
  batchMatchRule(counts, locale) {
    return counts.map(count => ({
      count,
      category: this.matchRule(Math.abs(count), locale, Number.isInteger(count))
    }));
  }

  /**
   * 获取规则的示例数字
   * @param {string} locale - 语言代码
   * @param {string} category - 复数类别
   * @param {number} maxExamples - 最大示例数量
   * @returns {number[]} 示例数字数组
   */
  getExampleNumbers(locale, category, maxExamples = 5) {
    const examples = [];
    const rules = this.getRules(locale);

    if (!rules || !rules[category]) {
      return examples;
    }

    // 测试数字范围
    for (let n = 0; n <= 200; n++) {
      if (rules[category](n)) {
        examples.push(n);
        if (examples.length >= maxExamples) break;
      }
    }

    return examples;
  }

  /**
   * 验证规则完整性
   * @param {string} locale - 语言代码
   * @returns {Object} 验证结果
   */
  validateRules(locale) {
    const rules = this.getRules(locale);
    
    if (!rules) {
      return {
        valid: false,
        error: `No rules found for locale: ${locale}`
      };
    }

    // 检查是否包含 'other' 规则（必须有）
    if (!rules.other) {
      return {
        valid: false,
        error: `Missing 'other' category for locale: ${locale}`
      };
    }

    // 验证每个规则是否为有效函数
    const invalidCategories = [];
    for (const [category, rule] of Object.entries(rules)) {
      if (typeof rule !== 'function') {
        invalidCategories.push(category);
      }
    }

    if (invalidCategories.length > 0) {
      return {
        valid: false,
        error: `Invalid rule functions for categories: ${invalidCategories.join(', ')}`
      };
    }

    return {
      valid: true,
      categories: Object.keys(rules)
    };
  }

  /**
   * 获取支持的语言列表
   * @returns {string[]} 支持的语言代码数组
   */
  getSupportedLocales() {
    return Object.keys(this.rules);
  }

  /**
   * 获取语言的复数类别数量
   * @param {string} locale - 语言代码
   * @returns {number} 复数类别数量
   */
  getCategoryCount(locale) {
    const rules = this.getRules(locale);
    return rules ? Object.keys(rules).length : 1;
  }
}

module.exports = PluralRuleMatcher;