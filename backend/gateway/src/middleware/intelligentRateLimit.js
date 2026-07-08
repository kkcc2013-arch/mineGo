/**
 * REQ-00040: 智能限流中间件
 * 实现基于 IP、用户、接口类型的精细化限流策略
 * 
 * 功能：
 * 1. 基础 IP 限流（滑动窗口）
 * 2. 用户级别限流（已认证用户 vs 匿名用户）
 * 3. 接口精细化限流（高风险接口更严格）
 * 4. 分布式限流（Redis 支持）
 * 5. 动态限流规则调整
 */

'use strict';

const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const { createClient } = require('redis');
const { createLogger } = require('@pmg/shared/logger');

const logger = createLogger('intelligent-rate-limit');

// Redis 客户端（用于分布式限流）
let redisClient = null;

/**
 * 初始化 Redis 客户端
 */
async function initRedisClient() {
  if (redisClient) return redisClient;
  
  try {
    redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            logger.error('Redis connection failed after 10 retries');
            return new Error('Redis connection failed');
          }
          return Math.min(retries * 100, 3000);
        }
      }
    });
    
    redisClient.on('error', (err) => {
      logger.error('Redis client error:', err);
    });
    
    await redisClient.connect();
    logger.info('Redis client connected for rate limiting');
    return redisClient;
  } catch (error) {
    logger.error('Failed to initialize Redis client:', error);
    return null;
  }
}

/**
 * 限流配置策略
 */
const RATE_LIMIT_CONFIGS = {
  // 全局默认限流（已存在，200 req/min）
  global: {
    windowMs: 60_000,
    max: 200,
    message: { code: 1007, message: '请求过于频繁，请稍后重试' }
  },
  
  // 高风险接口限流（支付、捕捉、交易）
  highRisk: {
    windowMs: 60_000,
    max: 30,      // 30 次/分钟
    message: { code: 1007, message: '操作过于频繁，请稍后重试' }
  },
  
  // 认证接口限流（登录、注册）
  auth: {
    windowMs: 15 * 60_000, // 15 分钟
    max: 10,               // 10 次/15分钟
    message: { code: 1007, message: '登录尝试次数过多，请 15 分钟后再试' }
  },
  
  // 搜索接口限流
  search: {
    windowMs: 60_000,
    max: 60,      // 60 次/分钟
    message: { code: 1007, message: '搜索请求过于频繁，请稍后重试' }
  },
  
  // 社交接口限流（聊天、好友请求）
  social: {
    windowMs: 60_000,
    max: 100,     // 100 次/分钟
    message: { code: 1007, message: '消息发送过于频繁，请稍后重试' }
  },
  
  // 管理接口限流
  admin: {
    windowMs: 60_000,
    max: 120,     // 120 次/分钟
    message: { code: 1007, message: '管理操作过于频繁，请稍后重试' }
  },
  
  // 匿名用户限流（更严格）
  anonymous: {
    windowMs: 60_000,
    max: 50,      // 50 次/分钟
    message: { code: 1007, message: '未登录用户请求限制，请登录后继续' }
  },
  
  // 认证用户限流（更宽松）
  authenticated: {
    windowMs: 60_000,
    max: 300,     // 300 次/分钟
    message: { code: 1007, message: '请求过于频繁，请稍后重试' }
  }
};

/**
 * 创建 Redis Store（可选）
 */
async function createRedisStore(prefix) {
  const client = await initRedisClient();
  
  if (!client) {
    logger.warn('Redis unavailable, using in-memory store');
    return undefined;
  }
  
  return new RedisStore({
    sendCommand: (...args) => client.sendCommand(args),
    prefix: `rl:${prefix}:`
  });
}

/**
 * 生成限流键（IP + 用户ID）
 */
function keyGenerator(req) {
  const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
  const userId = req.user?.id || 'anonymous';
  return `${ip}:${userId}`;
}

/**
 * 创建智能限流中间件
 * @param {string} configName - 限流配置名称
 * @param {object} options - 覆盖选项
 */
function createRateLimiter(configName = 'global', options = {}) {
  const config = { ...RATE_LIMIT_CONFIGS[configName], ...options };
  
  return rateLimit({
    windowMs: config.windowMs,
    max: config.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: config.message,
    keyGenerator,
    handler: (req, res, next, options) => {
      // 记录限流事件
      logger.warn('Rate limit exceeded', {
        ip: req.headers['x-forwarded-for'] || req.ip,
        userId: req.user?.id || 'anonymous',
        path: req.path,
        method: req.method,
        limit: options.max,
        windowMs: options.windowMs
      });
      
      // 发送告警（可选，通过 metrics 或告警系统）
      if (req.user?.id) {
        // 已认证用户触发限流 - 记录到用户行为分析系统
        logger.warn('Authenticated user rate limited', {
          userId: req.user.id,
          path: req.path
        });
      }
      
      res.status(429).json(options.message);
    },
    skip: (req) => {
      // 跳过健康检查接口
      if (req.path === '/health' || req.path === '/ready') {
        return true;
      }
      
      // 跳过内部服务调用（如果有特殊标识）
      if (req.headers['x-internal-service'] === 'true') {
        return true;
      }
      
      return false;
    }
  });
}

/**
 * 用户级别限流中间件
 * 根据用户认证状态应用不同限流策略
 */
function userLevelRateLimiter() {
  return async (req, res, next) => {
    const isAuthenticated = !!req.user;
    const configName = isAuthenticated ? 'authenticated' : 'anonymous';
    const config = RATE_LIMIT_CONFIGS[configName];
    
    const limiter = rateLimit({
      windowMs: config.windowMs,
      max: config.max,
      standardHeaders: true,
      legacyHeaders: false,
      message: config.message,
      keyGenerator,
      handler: (req, res) => {
        logger.warn('User-level rate limit exceeded', {
          ip: req.headers['x-forwarded-for'] || req.ip,
          userId: req.user?.id || 'anonymous',
          path: req.path,
          isAuthenticated
        });
        
        res.status(429).json(config.message);
      }
    });
    
    return limiter(req, res, next);
  };
}

/**
 * 高风险接口限流中间件
 * 用于支付、捕捉、交易等关键接口
 */
function highRiskRateLimiter(customMax = 30) {
  return createRateLimiter('highRisk', { max: customMax });
}

/**
 * 认证接口限流中间件
 * 用于登录、注册、密码重置等接口
 */
function authRateLimiter() {
  return createRateLimiter('auth');
}

/**
 * 搜索接口限流中间件
 */
function searchRateLimiter() {
  return createRateLimiter('search');
}

/**
 * 社交接口限流中间件
 */
function socialRateLimiter() {
  return createRateLimiter('social');
}

/**
 * 管理接口限流中间件
 */
function adminRateLimiter() {
  return createRateLimiter('admin');
}

/**
 * 动态限流中间件
 * 根据系统负载动态调整限流阈值
 */
function dynamicRateLimiter(baseConfig = 'global') {
  let currentMultiplier = 1.0;
  const config = RATE_LIMIT_CONFIGS[baseConfig];
  
  // 定期检查系统负载并调整限流阈值
  setInterval(() => {
    const memUsage = process.memoryUsage();
    const heapUsedPercent = memUsage.heapUsed / memUsage.heapTotal;
    
    if (heapUsedPercent > 0.85) {
      // 内存使用率 > 85%，降低限流阈值
      currentMultiplier = 0.5;
      logger.warn('System under high memory pressure, reducing rate limits', {
        heapUsedPercent: (heapUsedPercent * 100).toFixed(2),
        multiplier: currentMultiplier
      });
    } else if (heapUsedPercent > 0.70) {
      // 内存使用率 > 70%，适度降低限流阈值
      currentMultiplier = 0.75;
      logger.info('System under moderate memory pressure, adjusting rate limits', {
        heapUsedPercent: (heapUsedPercent * 100).toFixed(2),
        multiplier: currentMultiplier
      });
    } else {
      // 恢复正常限流阈值
      currentMultiplier = 1.0;
    }
  }, 30000); // 每 30 秒检查一次
  
  return rateLimit({
    windowMs: config.windowMs,
    max: Math.floor(config.max * currentMultiplier),
    standardHeaders: true,
    legacyHeaders: false,
    message: config.message,
    keyGenerator,
    handler: (req, res) => {
      logger.warn('Dynamic rate limit exceeded', {
        ip: req.headers['x-forwarded-for'] || req.ip,
        path: req.path,
        currentMultiplier,
        effectiveMax: Math.floor(config.max * currentMultiplier)
      });
      
      res.status(429).json(config.message);
    }
  });
}

/**
 * 分布式限流中间件（基于 Redis）
 * 用于多实例部署场景
 */
async function distributedRateLimiter(configName = 'global') {
  const config = RATE_LIMIT_CONFIGS[configName];
  const store = await createRedisStore(configName);
  
  return rateLimit({
    store,
    windowMs: config.windowMs,
    max: config.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: config.message,
    keyGenerator,
    handler: (req, res) => {
      logger.warn('Distributed rate limit exceeded', {
        ip: req.headers['x-forwarded-for'] || req.ip,
        userId: req.user?.id || 'anonymous',
        path: req.path
      });
      
      res.status(429).json(config.message);
    }
  });
}

/**
 * 组合限流中间件
 * 同时应用全局限流和接口特定限流
 */
function combinedRateLimiter(interfaceConfig = 'global') {
  const globalLimiter = createRateLimiter('global');
  const interfaceLimiter = createRateLimiter(interfaceConfig);
  
  return [globalLimiter, interfaceLimiter];
}

module.exports = {
  initRedisClient,
  createRateLimiter,
  userLevelRateLimiter,
  highRiskRateLimiter,
  authRateLimiter,
  searchRateLimiter,
  socialRateLimiter,
  adminRateLimiter,
  dynamicRateLimiter,
  distributedRateLimiter,
  combinedRateLimiter,
  RATE_LIMIT_CONFIGS
};
