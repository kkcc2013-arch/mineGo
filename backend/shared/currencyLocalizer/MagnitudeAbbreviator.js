/**
 * Magnitude Abbreviator - 数量级智能简写引擎
 * REQ-00550: 游戏内货币本地化显示与智能区域适配系统
 * 
 * 功能：
 * - 根据地区习惯显示大额数字简写
 * - 支持中文区域 万/亿
 * - 支持英语区域 K/M/B/T
 * - 支持日语区域 万/億
 * - 支持韩语区域 만/억
 * 
 * @module backend/shared/currencyLocalizer/MagnitudeAbbreviator
 * @version 1.0.0
 */

'use strict';

/**
 * 数量级简写规则 - 按地区分组
 */
const ABBREVIATION_RULES = {
  // 中文区域：万、亿
  'zh-CN': {
    groups: [
      { threshold: 100000000, suffix: '亿', divisor: 100000000 },
      { threshold: 10000, suffix: '万', divisor: 10000 }
    ],
    defaultPrecision: 1
  },
  'zh-TW': {
    groups: [
      { threshold: 100000000, suffix: '億', divisor: 100000000 },
      { threshold: 10000, suffix: '萬', divisor: 10000 }
    ],
    defaultPrecision: 1
  },
  // 日语区域：万、億（与中文相同逻辑）
  'ja-JP': {
    groups: [
      { threshold: 100000000, suffix: '億', divisor: 100000000 },
      { threshold: 10000, suffix: '万', divisor: 10000 }
    ],
    defaultPrecision: 1
  },
  // 韩语区域：만、억
  'ko-KR': {
    groups: [
      { threshold: 100000000, suffix: '억', divisor: 100000000 },
      { threshold: 10000, suffix: '만', divisor: 10000 }
    ],
    defaultPrecision: 1
  },
  // 英语区域：K、M、B、T
  'en-US': {
    groups: [
      { threshold: 1000000000000, suffix: 'T', divisor: 1000000000000 },
      { threshold: 1000000000, suffix: 'B', divisor: 1000000000 },
      { threshold: 1000000, suffix: 'M', divisor: 1000000 },
      { threshold: 1000, suffix: 'K', divisor: 1000 }
    ],
    defaultPrecision: 1
  },
  'en-GB': {
    groups: [
      { threshold: 1000000000000, suffix: 'T', divisor: 1000000000000 },
      { threshold: 1000000000, suffix: 'B', divisor: 1000000000 },
      { threshold: 1000000, suffix: 'M', divisor: 1000000 },
      { threshold: 1000, suffix: 'K', divisor: 1000 }
    ],
    defaultPrecision: 1
  },
  'en-AU': {
    groups: [
      { threshold: 1000000000000, suffix: 'T', divisor: 1000000000000 },
      { threshold: 1000000000, suffix: 'B', divisor: 1000000000 },
      { threshold: 1000000, suffix: 'M', divisor: 1000000 },
      { threshold: 1000, suffix: 'K', divisor: 1000 }
    ],
    defaultPrecision: 1
  },
  // 欧洲区域：通常使用 K、M、Mrd（德语）
  'de-DE': {
    groups: [
      { threshold: 1000000000000, suffix: 'Bio.', divisor: 1000000000000 },
      { threshold: 1000000000, suffix: 'Mrd.', divisor: 1000000000 },
      { threshold: 1000000, suffix: 'Mio.', divisor: 1000000 },
      { threshold: 1000, suffix: 'Tsd.', divisor: 1000 }
    ],
    defaultPrecision: 1
  },
  'fr-FR': {
    groups: [
      { threshold: 1000000000000, suffix: 'tn', divisor: 1000000000000 },
      { threshold: 1000000000, suffix: 'Md', divisor: 1000000000 },
      { threshold: 1000000, suffix: 'M', divisor: 1000000 },
      { threshold: 1000, suffix: 'k', divisor: 1000 }
    ],
    defaultPrecision: 1
  },
  // 西班牙语区域
  'es-ES': {
    groups: [
      { threshold: 1000000000000, suffix: 'B', divisor: 1000000000000 },
      { threshold: 1000000, suffix: 'M', divisor: 1000000 },
      { threshold: 1000, suffix: 'K', divisor: 1000 }
    ],
    defaultPrecision: 1
  },
  'pt-BR': {
    groups: [
      { threshold: 1000000000000, suffix: 'T', divisor: 1000000000000 },
      { threshold: 1000000000, suffix: 'B', divisor: 1000000000 },
      { threshold: 1000000, suffix: 'M', divisor: 1000000 },
      { threshold: 1000, suffix: 'K', divisor: 1000 }
    ],
    defaultPrecision: 1
  }
};

/**
 * 创建数量级简写器
 * @param {string} locale - 语言区域代码
 * @returns {Object} - 简写器实例
 */
function createMagnitudeAbbreviator(locale) {
  const rules = ABBREVIATION_RULES[locale] || ABBREVIATION_RULES['en-US'];

  return {
    /**
     * 简写数字
     * @param {number} num - 数字
     * @param {number} precision - 精度
     * @returns {string} - 简写后的字符串
     */
    abbreviate(num, precision = rules.defaultPrecision) {
      if (num < 1000) {
        return new Intl.NumberFormat(locale).format(num);
      }

      for (const group of rules.groups) {
        if (num >= group.threshold) {
          const abbreviated = num / group.divisor;
          const formatted = precision > 0
            ? abbreviated.toFixed(precision).replace(/\.0$/, '')
            : Math.floor(abbreviated);
          return `${formatted}${group.suffix}`;
        }
      }

      return new Intl.NumberFormat(locale).format(num);
    },

    /**
     * 解析简写数字
     * @param {string} str - 简写字符串
     * @returns {number|null} - 解析后的数字
     */
    parseAbbreviated(str) {
      const cleanStr = str.trim();

      // 尝试匹配简写
      for (const group of rules.groups) {
        const suffix = group.suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = cleanStr.match(new RegExp(`^([\\d,.]+)\\s*${suffix}$`, 'i'));
        if (match) {
          const base = parseFloat(match[1].replace(/,/g, ''));
          return base * group.divisor;
        }
      }

      // 尝试解析普通数字
      const numMatch = cleanStr.match(/^[\d,.]+$/);
      if (numMatch) {
        return parseFloat(numMatch[0].replace(/,/g, ''));
      }

      return null;
    },

    /**
     * 获取简写示例
     * @returns {Object} - 示例对象
     */
    getExamples() {
      return {
        thousand: this.abbreviate(1234),
        million: this.abbreviate(1234567),
        billion: this.abbreviate(1234567890),
        trillion: this.abbreviate(1234567890123)
      };
    },

    /**
     * 获取简写规则
     * @returns {Object} - 规则对象
     */
    getRules() {
      return {
        locale,
        groups: rules.groups,
        defaultPrecision: rules.defaultPrecision
      };
    }
  };
}

module.exports = createMagnitudeAbbreviator;