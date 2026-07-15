'use strict';

/**
 * WebSocket 聊天消息翻译中间件
 * REQ-00551: 跨语言实时聊天翻译系统
 */

const RealtimeTranslationEngine = require('../../../shared/ai/realtimeTranslationEngine');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('chat-translation-middleware');

class ChatTranslationMiddleware {
  constructor(config = {}) {
    this.engine = new RealtimeTranslationEngine(config);
    this.enabled = config.enabled !== false;
    this.translationThreshold = config.translationThreshold || 100; // 最小字符数阈值
    
    logger.info('ChatTranslationMiddleware initialized', { enabled: this.enabled });
  }

  /**
   * 处理聊天消息翻译
   * @param {WebSocket} ws - WebSocket 连接
   * @param {Object} message - 消息对象
   * @param {Function} next - 下一个中间件
   */
  async handleChatMessage(ws, message, next) {
    try {
      // 检查中间件是否启用
      if (!this.enabled) {
        return next();
      }

      // 仅处理聊天消息
      if (message.type !== 'chat' && message.type !== 'group_chat' && message.type !== 'team_chat') {
        return next();
      }

      // 跳过空消息
      if (!message.content || message.content.trim().length === 0) {
        return next();
      }

      // 跳过过短消息（减少不必要的翻译成本）
      if (message.content.length < this.translationThreshold) {
        return next();
      }

      // 获取接收者语言偏好
      const recipientLang = await this.getRecipientLanguage(ws, message);
      const senderLang = message.senderLanguage || ws.userLanguage || 'en-US';

      // 相同语言不翻译
      if (senderLang === recipientLang) {
        return next();
      }

      logger.debug('Translating message', {
        messageId: message.id,
        senderLang,
        recipientLang,
        contentLength: message.content.length
      });

      // 执行翻译
      const translation = await this.engine.translate(
        message.content,
        recipientLang,
        { sourceLang: senderLang }
      );

      // 添加翻译结果到消息
      message.translation = {
        translatedText: translation.translatedText,
        sourceLanguage: translation.sourceLanguage,
        targetLanguage: recipientLang,
        cached: translation.cached,
        engine: translation.engine,
        latencyMs: translation.latencyMs
      };

      // 保留原文
      message.originalContent = message.content;
      
      logger.debug('Message translated', {
        messageId: message.id,
        cached: translation.cached,
        latencyMs: translation.latencyMs
      });

      next();
    } catch (error) {
      // 翻译失败不影响消息发送
      logger.error({ error: error.message, messageId: message.id }, 'Chat translation error');
      next();
    }
  }

  /**
   * 获取接收者语言偏好
   * @param {WebSocket} ws - WebSocket 连接
   * @param {Object} message - 消息对象
   * @returns {Promise<string>} 语言代码
   */
  async getRecipientLanguage(ws, message) {
    // 私聊：获取对方语言
    if (message.type === 'chat' && message.recipientId) {
      const recipient = await this.getUserPreferences(message.recipientId);
      return recipient?.language || ws.userLanguage || 'en-US';
    }

    // 群聊/团队聊天：使用用户自己的语言（客户端处理显示）
    if (message.type === 'group_chat' || message.type === 'team_chat') {
      return ws.userLanguage || 'en-US';
    }

    return 'en-US';
  }

  /**
   * 获取用户语言偏好
   * @param {string} userId - 用户ID
   * @returns {Promise<Object>} 用户偏好设置
   */
  async getUserPreferences(userId) {
    // TODO: 从用户服务或缓存获取用户语言偏好
    // 这里应该调用 user-service 或从 Redis 缓存中获取
    return { language: 'en-US' };
  }

  /**
   * 批量翻译多条消息
   * @param {Array} messages - 消息数组
   * @param {string} targetLang - 目标语言
   * @returns {Promise<Array>} 翻译后的消息数组
   */
  async batchTranslateMessages(messages, targetLang) {
    const results = [];
    
    for (const message of messages) {
      try {
        const translation = await this.engine.translate(
          message.content,
          targetLang,
          { sourceLang: message.sourceLanguage || 'auto' }
        );

        results.push({
          ...message,
          translation: {
            translatedText: translation.translatedText,
            sourceLanguage: translation.sourceLanguage,
            targetLanguage,
            cached: translation.cached,
            latencyMs: translation.latencyMs
          }
        });
      } catch (error) {
        logger.error({ error: error.message, messageId: message.id }, 'Batch translation error');
        results.push(message);
      }
    }

    return results;
  }

  /**
   * 检查是否需要翻译
   * @param {string} content - 消息内容
   * @param {string} senderLang - 发送者语言
   * @param {string} recipientLang - 接收者语言
   * @returns {boolean} 是否需要翻译
   */
  shouldTranslate(content, senderLang, recipientLang) {
    // 相同语言不翻译
    if (senderLang === recipientLang) {
      return false;
    }

    // 空消息不翻译
    if (!content || content.trim().length === 0) {
      return false;
    }

    // 过短消息不翻译
    if (content.length < this.translationThreshold) {
      return false;
    }

    return true;
  }
}

module.exports = ChatTranslationMiddleware;