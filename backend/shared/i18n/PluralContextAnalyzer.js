/**
 * 复数上下文分析器 - 分析名词/动词/形容词等不同上下文的复数形式
 */

const logger = require('../logger');

/**
 * 上下文类型定义
 */
const CONTEXT_TYPES = {
  noun: '名词复数',
  verb: '动词复数',
  adjective: '形容词复数',
  possessive: '所有格复数'
};

class PluralContextAnalyzer {
  constructor() {
    this.contextTypes = CONTEXT_TYPES;
    logger.info('[PluralContextAnalyzer] Initialized');
  }

  /**
   * 分析消息上下文
   * @param {string} key - 翻译键
   * @param {string} message - 消息内容
   * @returns {string} 上下文类型
   */
  analyzeContext(key, message) {
    // 根据键名推断上下文
    if (key.includes('.catch') || key.includes('.catches')) {
      return 'verb';
    }
    
    if (key.includes('.pokemon') || key.includes('.item') || key.includes('.trainer')) {
      return 'noun';
    }
    
    if (key.includes('.wild') || key.includes('.strong')) {
      return 'adjective';
    }
    
    if (key.includes('.trainer') || key.includes('.user')) {
      return 'possessive';
    }
    
    // 默认为名词
    return 'noun';
  }

  /**
   * 应用上下文转换
   * @param {string} message - 消息内容
   * @param {number} count - 数量
   * @param {string} locale - 语言代码
   * @param {string} context - 上下文类型
   * @returns {string} 转换后的消息
   */
  async applyContext(message, count, locale, context) {
    // 当前实现：保持原消息不变
    // 未来可扩展：根据上下文类型调整词形
    return message;
  }

  /**
   * 获取上下文描述
   * @param {string} context - 上下文类型
   * @returns {string} 描述
   */
  getContextDescription(context) {
    return this.contextTypes[context] || '未知上下文';
  }
}

module.exports = PluralContextAnalyzer;