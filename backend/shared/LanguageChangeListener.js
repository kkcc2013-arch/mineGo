// backend/shared/LanguageChangeListener.js - REQ-00393 语言变更事件监听器
'use strict';

const EventBus = require('./EventBus');
const redis = require('./redis');
const { createLogger } = require('./logger');
const metrics = require('./metrics');
const languageService = require('./LanguageService');

const logger = createLogger('LanguageChangeListener');

class LanguageChangeListener {
  constructor() {
    this.subscribedServices = new Set();
    this.handlers = new Map();
  }

  /**
   * 初始化语言变更监听器
   * @param {string} serviceName - 服务名称
   */
  async init(serviceName) {
    if (this.subscribedServices.has(serviceName)) {
      logger.debug('服务已订阅语言变更', { serviceName });
      return;
    }
    
    this.subscribedServices.add(serviceName);
    
    // 订阅 Kafka 语言变更事件
    await EventBus.subscribe('user-language-changed', async (event) => {
      await this.handleLanguageChange(serviceName, event);
    });
    
    // 订阅语言同步事件
    await EventBus.subscribe('language-sync', async (event) => {
      if (event.targetService === serviceName) {
        await this.handleLanguageSync(serviceName, event);
      }
    });
    
    logger.info('语言变更监听器已初始化', { serviceName });
    metrics.increment('language.listener.subscribed');
  }

  /**
   * 处理语言变更事件
   */
  async handleLanguageChange(serviceName, event) {
    const startTime = Date.now();
    const { userId, language, previousLanguage, timestamp } = event;
    
    logger.info(`[${serviceName}] 收到语言变更事件`, {
      userId,
      language,
      previousLanguage
    });
    
    try {
      // 1. 更新本地缓存
      await redis.set(`user:lang:${userId}`, language, 'EX', 3600);
      
      // 2. 调用服务特定处理
      await this.handleServiceSpecific(serviceName, userId, language);
      
      // 3. 记录指标
      metrics.timing('language.change_handling', Date.now() - startTime);
      metrics.increment(`language.change.${serviceName}`);
      
    } catch (error) {
      logger.error(`[${serviceName}] 处理语言变更失败`, { userId, language, error });
      metrics.increment('language.change.error');
    }
  }

  /**
   * 处理语言同步事件
   */
  async handleLanguageSync(serviceName, event) {
    const { userId, language } = event;
    
    logger.debug(`[${serviceName}] 收到语言同步请求`, { userId, language });
    
    try {
      await this.handleServiceSpecific(serviceName, userId, language);
      metrics.increment(`language.sync.${serviceName}`);
    } catch (error) {
      logger.error(`[${serviceName}] 语言同步失败`, { userId, language, error });
    }
  }

  /**
   * 服务特定处理
   */
  async handleServiceSpecific(serviceName, userId, language) {
    // 查找注册的处理函数
    const handler = this.handlers.get(serviceName);
    if (handler) {
      await handler(userId, language);
    }
  }

  /**
   * 注册服务特定的语言变更处理函数
   * @param {string} serviceName - 服务名称
   * @param {function} handler - 处理函数 (userId, language) => Promise
   */
  registerHandler(serviceName, handler) {
    this.handlers.set(serviceName, handler);
    logger.info('注册语言变更处理器', { serviceName });
  }
}

// 各服务的特定处理逻辑
const serviceHandlers = {
  /**
   * gym-service: 更新 WebSocket 连接语言
   */
  gymService: async (userId, language) => {
    // WebSocket 连接管理由 gym-service 自己实现
    await redis.publish(`gym:language:${userId}`, JSON.stringify({
      userId,
      language,
      timestamp: Date.now()
    }));
  },

  /**
   * social-service: 更新聊天消息语言
   */
  socialService: async (userId, language) => {
    await redis.hset(`social:userSettings:${userId}`, 'language', language);
    await redis.publish(`social:language:${userId}`, JSON.stringify({
      userId,
      language,
      timestamp: Date.now()
    }));
  },

  /**
   * reward-service: 更新推送通知语言
   */
  rewardService: async (userId, language) => {
    await redis.hset(`reward:userSettings:${userId}`, 'notificationLanguage', language);
  },

  /**
   * catch-service: 更新捕捉提示语言
   */
  catchService: async (userId, language) => {
    await redis.hset(`catch:userSettings:${userId}`, 'language', language);
  },

  /**
   * location-service: 更新精灵信息语言
   */
  locationService: async (userId, language) => {
    await redis.hset(`location:userSettings:${userId}`, 'language', language);
  },

  /**
   * pokemon-service: 更新精灵展示语言
   */
  pokemonService: async (userId, language) => {
    await redis.hset(`pokemon:userSettings:${userId}`, 'language', language);
  }
};

// 导出单例
const languageChangeListener = new LanguageChangeListener();

// 自动注册默认处理器
for (const [serviceName, handler] of Object.entries(serviceHandlers)) {
  languageChangeListener.registerHandler(serviceName, handler);
}

module.exports = languageChangeListener;
module.exports.LanguageChangeListener = LanguageChangeListener;
module.exports.serviceHandlers = serviceHandlers;