const { IPlugin } = require('../IPlugin');
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const { getRedisClient } = require('../../cache');

/**
 * 限流插件 - API 请求限流
 */
class RateLimitPlugin extends IPlugin {
  static get meta() {
    return {
      name: 'rateLimit',
      version: '1.0.0',
      description: 'API 请求限流中间件，支持 Redis 存储',
      author: 'mineGo Team',
      dependencies: [],
      priority: 20,
      category: 'security',
    };
  }

  static get configSchema() {
    return {
      type: 'object',
      properties: {
        windowMs: { type: 'number' },
        max: { type: 'number' },
        skipFailedRequests: { type: 'boolean' },
        useRedis: { type: 'boolean' },
      },
      required: [],
    };
  }

  static get defaultConfig() {
    return {
      windowMs: 60 * 1000, // 1 分钟
      max: 100, // 每分钟最多 100 次请求
      skipFailedRequests: false,
      useRedis: true,
    };
  }

  async init(config, context) {
    this.config = config;
    this.logger = context.logger.child({ plugin: 'rateLimit' });
    this.redis = getRedisClient ? getRedisClient() : null;
    this.limiter = null;
    
    this.logger.info({ config }, 'RateLimit plugin initialized');
  }

  async start(context) {
    // 创建限流器
    const options = {
      windowMs: this.config.windowMs,
      max: this.config.max,
      skipFailedRequests: this.config.skipFailedRequests,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        this.logger.warn(
          { ip: req.ip, path: req.path },
          'Rate limit exceeded'
        );
        res.status(429).json({
          error: 'Too many requests',
          retryAfter: Math.ceil(this.config.windowMs / 1000),
        });
      },
    };

    // 使用 Redis 存储（分布式限流）
    if (this.config.useRedis && this.redis) {
      options.store = new RedisStore({
        sendCommand: (...args) => this.redis.call(...args),
      });
    }

    this.limiter = rateLimit(options);
    this.logger.info('RateLimit plugin started');
  }

  async stop(context) {
    this.logger.info('RateLimit plugin stopped');
  }

  async healthCheck() {
    return {
      status: 'healthy',
      details: {
        max: this.config.max,
        windowMs: this.config.windowMs,
        useRedis: this.config.useRedis && this.redis,
      },
    };
  }

  getMiddleware() {
    if (!this.limiter) {
      throw new Error('RateLimit plugin not started');
    }
    return this.limiter;
  }
}

module.exports = RateLimitPlugin;
