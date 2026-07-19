/**
 * Smart Text Truncator - 智能文本截断与本地化适配系统
 * 
 * 支持多语言特定的截断策略，保护占位符，保持语义完整性
 * 
 * @module backend/shared/i18n/textTruncator
 */

const logger = require('../logger');

/**
 * 基础截断策略类
 */
class BaseStrategy {
  /**
   * 截断文本
   * @param {string} text - 原始文本
   * @param {number} maxLength - 最大长度
   * @returns {string} 截断后的文本
   */
  truncate(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength);
  }

  /**
   * 查找最近的空格位置（用于单词边界截断）
   * @param {string} text - 文本
   * @param {number} start - 起始位置
   * @param {number} minThreshold - 最小阈值
   * @returns {number} 空格位置，找不到返回 -1
   */
  findNearestSpace(text, start, minThreshold) {
    for (let i = start; i >= minThreshold; i--) {
      if (text[i] === ' ' || text[i] === '\t' || text[i] === '\n') {
        return i;
      }
    }
    return -1;
  }
}

/**
 * 中文截断策略：优先在标点符号后截断
 */
class ChineseStrategy extends BaseStrategy {
  constructor() {
    super();
    this.punctuation = ['。', '，', '！', '？', '、', '；', '：', '"', '"', ''', ''', '）', '】', '》', '~'];
  }

  truncate(text, maxLength) {
    if (text.length <= maxLength) return text;

    // 智能截断：优先在标点符号后截断
    const threshold = Math.floor(maxLength * 0.7);
    let cutPoint = maxLength;

    // 向前查找最近的标点符号
    for (let i = maxLength - 1; i >= threshold; i--) {
      if (this.punctuation.includes(text[i])) {
        cutPoint = i + 1;
        break;
      }
    }

    // 如果没找到标点，使用硬截断
    if (cutPoint === maxLength) {
      // 检查是否截断了 Unicode 字符（如 emoji）
      cutPoint = this.safeCutPoint(text, maxLength);
    }

    return text.substring(0, cutPoint);
  }

  /**
   * 确保截断点不会破坏 Unicode 字符
   */
  safeCutPoint(text, position) {
    // 简单检查：如果截断点是代理对的第一个字符，向前移动
    if (position < text.length) {
      const charCode = text.charCodeAt(position);
      // 高代理位 (0xD800-0xDBFF)
      if (charCode >= 0xD800 && charCode <= 0xDBFF) {
        return position - 1;
      }
    }
    return position;
  }
}

/**
 * 英语截断策略：在单词边界截断
 */
class EnglishStrategy extends BaseStrategy {
  truncate(text, maxLength) {
    if (text.length <= maxLength) return text;

    // 向前查找空格
    const threshold = Math.floor(maxLength * 0.7);
    const spacePos = this.findNearestSpace(text, maxLength, threshold);

    let cutPoint;
    if (spacePos > 0) {
      cutPoint = spacePos;
    } else {
      // 如果找不到空格，使用硬截断
      cutPoint = maxLength;
    }

    return text.substring(0, cutPoint).trim();
  }
}

/**
 * 日语截断策略：可在任意位置截断（日语无空格）
 */
class JapaneseStrategy extends BaseStrategy {
  constructor() {
    super();
    // 日语句末标点
    this.sentenceEndMarkers = ['。', '！', '？', '…', '・'];
    // 日语小字符（可以在这些字符后截断）
    this.smallChars = ['ゃ', 'ゅ', 'ょ', 'っ', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ャ', 'ュ', 'ョ', 'ッ'];
  }

  truncate(text, maxLength) {
    if (text.length <= maxLength) return text;

    const threshold = Math.floor(maxLength * 0.8);
    let cutPoint = maxLength;

    // 向前查找句末标点
    for (let i = maxLength - 1; i >= threshold; i--) {
      if (this.sentenceEndMarkers.includes(text[i])) {
        cutPoint = i + 1;
        break;
      }
    }

    // 如果截断点前是小字符，向前移动一位
    if (cutPoint < text.length && this.smallChars.includes(text[cutPoint - 1])) {
      cutPoint -= 1;
    }

    return text.substring(0, cutPoint);
  }
}

/**
 * 德语截断策略：避免截断复合词
 */
class GermanStrategy extends BaseStrategy {
  truncate(text, maxLength) {
    if (text.length <= maxLength) return text;

    const threshold = Math.floor(maxLength * 0.7);
    
    // 向前查找空格（德语单词通常很长）
    const spacePos = this.findNearestSpace(text, maxLength, threshold);

    let cutPoint;
    if (spacePos > 0) {
      cutPoint = spacePos;
    } else {
      // 德语复合词较长，硬截断是最后手段
      cutPoint = maxLength;
    }

    return text.substring(0, cutPoint).trim();
  }
}

/**
 * 阿拉伯语截断策略：RTL 支持，保护连接字符
 */
class ArabicStrategy extends BaseStrategy {
  constructor() {
    super();
    // 阿拉伯语连接字符
    this.connectors = ['ـ', 'لا', 'لل'];
  }

  truncate(text, maxLength) {
    if (text.length <= maxLength) return text;

    // 阿拉伯语从右向左，但截断点计算方式相同
    let cutPoint = maxLength;

    // 避免在连接字符处截断
    if (cutPoint < text.length) {
      const remaining = text.substring(cutPoint, cutPoint + 2);
      for (const connector of this.connectors) {
        if (remaining.includes(connector)) {
          cutPoint -= connector.length;
          break;
        }
      }
    }

    return text.substring(0, cutPoint);
  }
}

/**
 * 泰语截断策略：在音节边界截断（无空格语言）
 */
class ThaiStrategy extends BaseStrategy {
  truncate(text, maxLength) {
    if (text.length <= maxLength) return text;

    // 泰语无空格，使用音节边界检测
    // 简化实现：在特定字符类后截断
    const threshold = Math.floor(maxLength * 0.8);
    let cutPoint = maxLength;

    // 泰语元音符号
    const vowelSigns = ['ะ', 'า', 'ำ', 'ิ', 'ี', 'ึ', 'ื', 'ุ', 'ู', 'เ', 'แ', 'โ', 'ใ', 'ไ'];
    
    for (let i = maxLength - 1; i >= threshold; i--) {
      if (vowelSigns.includes(text[i])) {
        cutPoint = i + 1;
        break;
      }
    }

    return text.substring(0, cutPoint);
  }
}

/**
 * 韩语截断策略：在音节边界截断
 */
class KoreanStrategy extends BaseStrategy {
  truncate(text, maxLength) {
    if (text.length <= maxLength) return text;

    // 韩语音节边界：空格或句号后
    const threshold = Math.floor(maxLength * 0.8);
    const breakChars = [' ', '다', '요', '죠', '까', '네'];
    
    let cutPoint = maxLength;
    for (let i = maxLength - 1; i >= threshold; i--) {
      if (breakChars.includes(text[i])) {
        cutPoint = i + 1;
        break;
      }
    }

    return text.substring(0, cutPoint);
  }
}

/**
 * 法语截断策略：在单词边界截断
 */
class FrenchStrategy extends EnglishStrategy {
  // 法语与英语类似，继承英语策略
}

/**
 * 西班牙语截断策略：在单词边界截断
 */
class SpanishStrategy extends EnglishStrategy {
  // 西班牙语与英语类似，继承英语策略
}

/**
 * 俄语截断策略：在单词边界截断
 */
class RussianStrategy extends EnglishStrategy {
  // 俄语与英语类似，继承英语策略
}

/**
 * 智能文本截断器
 */
class SmartTextTruncator {
  constructor(options = {}) {
    this.strategies = {
      'zh': new ChineseStrategy(),
      'zh-CN': new ChineseStrategy(),
      'zh-TW': new ChineseStrategy(),
      'zh-HK': new ChineseStrategy(),
      'ja': new JapaneseStrategy(),
      'en': new EnglishStrategy(),
      'en-US': new EnglishStrategy(),
      'en-GB': new EnglishStrategy(),
      'de': new GermanStrategy(),
      'de-DE': new GermanStrategy(),
      'ar': new ArabicStrategy(),
      'ar-SA': new ArabicStrategy(),
      'th': new ThaiStrategy(),
      'th-TH': new ThaiStrategy(),
      'ko': new KoreanStrategy(),
      'ko-KR': new KoreanStrategy(),
      'fr': new FrenchStrategy(),
      'fr-FR': new FrenchStrategy(),
      'es': new SpanishStrategy(),
      'es-ES': new SpanishStrategy(),
      'ru': new RussianStrategy(),
      'ru-RU': new RussianStrategy(),
      'default': new BaseStrategy()
    };

    // 默认省略符
    this.defaultEllipsis = '...';

    // 占位符正则
    this.placeholderRegex = /\{[^}]+\}/g;
    this.htmlTagRegex = /<\/?[a-zA-Z][^>]*>/g;
  }

  /**
   * 获取截断策略
   * @param {string} locale - 语言环境
   * @returns {BaseStrategy} 截断策略
   */
  getStrategy(locale) {
    if (!locale) return this.strategies.default;
    
    // 精确匹配
    if (this.strategies[locale]) {
      return this.strategies[locale];
    }

    // 语言代码匹配 (如 'en-US' -> 'en')
    const langCode = locale.split('-')[0];
    if (this.strategies[langCode]) {
      return this.strategies[langCode];
    }

    return this.strategies.default;
  }

  /**
   * 保护特殊元素（占位符、HTML标签等）
   * @param {string} text - 原始文本
   * @returns {Object} 包含保护后文本和占位符映射
   */
  protectSpecialElements(text) {
    const placeholders = [];
    let index = 0;

    // 提取并替换占位符
    let protectedText = text.replace(this.placeholderRegex, (match) => {
      const marker = `__PH_${index}__`;
      placeholders.push({ marker, original: match, index });
      index++;
      return marker;
    });

    // 提取并替换 HTML 标签
    const htmlTags = [];
    let tagIndex = 0;
    protectedText = protectedText.replace(this.htmlTagRegex, (match) => {
      const marker = `__HTML_${tagIndex}__`;
      htmlTags.push({ marker, original: match });
      tagIndex++;
      return marker;
    });

    return { protectedText, placeholders, htmlTags };
  }

  /**
   * 恢复占位符
   * @param {string} truncated - 截断后的文本
   * @param {Array} placeholders - 占位符映射
   * @returns {Object} 恢复后的文本和警告信息
   */
  restorePlaceholders(truncated, placeholders) {
    let result = truncated;
    const warnings = [];

    for (const { marker, original } of placeholders) {
      if (result.includes(marker)) {
        result = result.replace(marker, original);
      } else {
        // 占位符被截断，记录警告
        warnings.push(`Placeholder truncated: ${original}`);
        logger.warn(`Placeholder truncated during truncation: ${original}`);
      }
    }

    return { text: result, warnings };
  }

  /**
   * 恢复 HTML 标签
   * @param {string} text - 文本
   * @param {Array} htmlTags - HTML 标签映射
   * @returns {string} 恢复后的文本
   */
  restoreHtmlTags(text, htmlTags) {
    let result = text;
    for (const { marker, original } of htmlTags) {
      if (result.includes(marker)) {
        result = result.replace(marker, original);
      }
    }
    return result;
  }

  /**
   * 主截断方法
   * @param {string} text - 原始文本
   * @param {Object} options - 截断选项
   * @returns {Object} 截断结果
   */
  truncate(text, options = {}) {
    const {
      maxLength = 100,
      ellipsis = this.defaultEllipsis,
      locale = 'en',
      preservePlaceholders = true,
      respectHTML = true
    } = options;

    if (!text || text.length <= maxLength) {
      return {
        original: text,
        truncated: text,
        wasTruncated: false,
        warnings: []
      };
    }

    let processingText = text;
    let placeholders = [];
    let htmlTags = [];

    // 1. 保护特殊元素
    if (preservePlaceholders || respectHTML) {
      const protected = this.protectSpecialElements(processingText);
      processingText = protected.protectedText;
      placeholders = protected.placeholders;
      htmlTags = protected.htmlTags;
    }

    // 2. 选择截断策略
    const strategy = this.getStrategy(locale);

    // 3. 计算实际截断长度（留出省略符空间）
    const actualMaxLength = maxLength - ellipsis.length;
    
    if (actualMaxLength <= 0) {
      return {
        original: text,
        truncated: ellipsis.substring(0, maxLength),
        wasTruncated: true,
        warnings: ['maxLength too small for ellipsis']
      };
    }

    // 4. 执行截断
    let truncated = strategy.truncate(processingText, actualMaxLength);

    // 5. 恢复占位符
    const restoreResult = this.restorePlaceholders(truncated, placeholders);
    truncated = restoreResult.text;

    // 6. 恢复 HTML 标签
    if (respectHTML && htmlTags.length > 0) {
      truncated = this.restoreHtmlTags(truncated, htmlTags);
    }

    // 7. 添加省略符
    truncated = truncated.trim() + ellipsis;

    return {
      original: text,
      truncated,
      wasTruncated: true,
      originalLength: text.length,
      truncatedLength: truncated.length,
      reduction: ((1 - truncated.length / text.length) * 100).toFixed(1) + '%',
      warnings: restoreResult.warnings
    };
  }

  /**
   * 批量截断
   * @param {Array<string>} texts - 文本数组
   * @param {Object} options - 截断选项
   * @returns {Array<Object>} 截断结果数组
   */
  truncateBatch(texts, options = {}) {
    return texts.map(text => this.truncate(text, options));
  }

  /**
   * 获取截断预览（用于管理后台）
   * @param {string} locale - 语言环境
   * @param {number} maxLength - 最大长度
   * @param {Array<string>} sampleTexts - 示例文本
   * @returns {Object} 预览结果
   */
  getPreview(locale, maxLength, sampleTexts = []) {
    const results = this.truncateBatch(sampleTexts, { locale, maxLength });
    
    return {
      locale,
      maxLength,
      results: results.map(r => ({
        original: r.original,
        truncated: r.truncated,
        originalLength: r.originalLength,
        truncatedLength: r.truncatedLength,
        reduction: r.reduction,
        warnings: r.warnings
      })),
      summary: {
        totalTexts: sampleTexts.length,
        truncatedCount: results.filter(r => r.wasTruncated).length,
        avgReduction: this.calculateAvgReduction(results)
      }
    };
  }

  /**
   * 计算平均缩减比例
   * @param {Array} results - 截断结果
   * @returns {string} 平均缩减比例
   */
  calculateAvgReduction(results) {
    const reductions = results
      .filter(r => r.wasTruncated)
      .map(r => parseFloat(r.reduction));
    
    if (reductions.length === 0) return '0%';
    
    const avg = reductions.reduce((a, b) => a + b, 0) / reductions.length;
    return avg.toFixed(1) + '%';
  }

  /**
   * 检测语言环境并返回最优截断
   * @param {string} text - 文本
   * @param {number} maxLength - 最大长度
   * @returns {Object} 截断结果
   */
  autoTruncate(text, maxLength) {
    // 简单的语言检测
    const detectedLocale = this.detectLocale(text);
    return this.truncate(text, { maxLength, locale: detectedLocale });
  }

  /**
   * 检测文本语言
   * @param {string} text - 文本
   * @returns {string} 检测到的语言代码
   */
  detectLocale(text) {
    // 中文检测
    if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
    // 日语检测
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(text)) return 'ja';
    // 韩语检测
    if (/[\uac00-\ud7af]/.test(text)) return 'ko';
    // 阿拉伯语检测
    if (/[\u0600-\u06ff]/.test(text)) return 'ar';
    // 泰语检测
    if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
    // 俄语检测
    if (/[\u0400-\u04ff]/.test(text)) return 'ru';
    // 默认英语
    return 'en';
  }
}

// 导出单例
const textTruncator = new SmartTextTruncator();

module.exports = {
  SmartTextTruncator,
  textTruncator,
  ChineseStrategy,
  EnglishStrategy,
  JapaneseStrategy,
  GermanStrategy,
  ArabicStrategy,
  ThaiStrategy,
  KoreanStrategy,
  FrenchStrategy,
  SpanishStrategy,
  RussianStrategy,
  BaseStrategy
};