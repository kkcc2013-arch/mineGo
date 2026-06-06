/**
 * API 响应缓存中间件 - Express 中间件
 * 
 * REQ-00031: API 响应缓存层与缓存失效策略
 * 
 * 特性：
 * - 自动缓存 GET 请求响应
 * - 支持自定义缓存键生成
 * - 支持用户特定数据缓存
 * - 支持条件跳过缓存
 * - 缓存穿透保护（空值缓存）
 */

const cache = require('./cache');
const { createLogger } = require('./logger');

const logger = createLogger('cache-middleware');

// 默认配置
const DEFAULT_OPTIONS = {
  ttl: 300,                    // 默认缓存 5 分钟
  keyPrefix: 'api:',           // 缓存键前缀
  cacheUserData: false,        // 是否缓存用户特定数据
  cacheEmpty: true,            // 是否缓存空响应（防止穿透）
  emptyTtl: 60,                // 空响应缓存时间（秒）
  skipConditions: [],          // 跳过缓存的条件
  statusCodeRange: [200, 299]  // 缓存的状态码范围
};

/**
 * API 响应缓存中间件
 * 
 * @param {Object} options - 配置选项
 * @param {number} options.ttl - 缓存时间（秒）
 * @param {string} options.keyPrefix - 缓存键前缀
 * @param {Function} options.keyGenerator - 自定义键生成函数
 * @param {boolean} options.cacheUserData - 是否缓存用户特定数据
 * @param {boolean} options.cacheEmpty - 是否缓存空响应
 * @param {number} options.emptyTtl - 空响应缓存时间
 * @param {Array<Function>} options.skipConditions - 跳过缓存的条件函数
 * @param {Array<number>} options.statusCodeRange - 缓存的状态码范围
 * @returns {Function} Express 中间件
 */
function cacheMiddleware(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  
  return async (req, res, next) => {
    // 只缓存 GET 请求
    if (req.method !== 'GET') {
      return next();
    }
    
    // 检查跳过条件
    for (const condition of config.skipConditions) {
      if (condition(req)) {
        logger.debug({ path: req.path }, 'Cache skipped by condition');
        return next();
      }
    }
    
    // 跳过认证用户特定数据（除非显式允许）
    if (req.user && !config.cacheUserData) {
      logger.debug({ path: req.path, userId: req.user.id }, 'Cache skipped for user data');
      return next();
    }
    
    // 生成缓存键
    const cacheKey = generateCacheKey(req, config);
    
    try {
      // 尝试从缓存获取
      const cached = await cache.get(cacheKey);
      
      if (cached !== null) {
        logger.debug({ 
          key: cacheKey, 
          path: req.path,
          cached: true 
        }, 'Cache hit, returning cached response');
        
        // 添加缓存命中标记
        res.set('X-Cache', 'HIT');
        return res.json(cached);
      }
      
      // 缓存未命中，拦截 res.json 以缓存响应
      const originalJson = res.json.bind(res);
      
      res.json = (data) => {
        // 检查状态码是否在缓存范围内
        const [minCode, maxCode] = config.statusCodeRange;
        const shouldCache = res.statusCode >= minCode && res.statusCode <= maxCode;
        
        if (shouldCache) {
          // 确定缓存 TTL
          let ttl = config.ttl;
          
          // 空响应使用较短的 TTL（防止穿透）
          if (config.cacheEmpty && isEmptyResponse(data)) {
            ttl = config.emptyTtl;
            logger.debug({ key: cacheKey, ttl }, 'Caching empty response');
          }
          
          // 异步设置缓存（不阻塞响应）
          cache.set(cacheKey, data, ttl).catch(err => {
            logger.error({ err, key: cacheKey }, 'Cache set failed');
          });
          
          // 添加缓存未命中标记
          res.set('X-Cache', 'MISS');
        }
        
        return originalJson(data);
      };
      
      next();
    } catch (err) {
      logger.error({ err, key: cacheKey, path: req.path }, 'Cache middleware error');
      // 缓存错误不应影响请求处理
      next();
    }
  };
}

/**
 * 生成缓存键
 * @param {Object} req - Express 请求对象
 * @param {Object} config - 配置选项
 * @returns {string} 缓存键
 */
function generateCacheKey(req, config) {
  if (config.keyGenerator) {
    return config.keyPrefix + config.keyGenerator(req);
  }
  
  return config.keyPrefix + defaultKeyGenerator(req);
}

/**
 * 默认键生成函数
 * @param {Object} req - Express 请求对象
 * @returns {string} 缓存键后缀
 */
function defaultKeyGenerator(req) {
  const parts = [req.path];
  
  // 添加查询参数
  if (Object.keys(req.query).length > 0) {
    const sortedQuery = Object.keys(req.query)
      .sort()
      .map(key => `${key}=${req.query[key]}`)
      .join('&');
    parts.push(sortedQuery);
  }
  
  // 添加用户 ID（如果缓存用户数据）
  if (req.user) {
    parts.push(`user:${req.user.id}`);
  }
  
  // 添加语言偏好
  if (req.language) {
    parts.push(`lang:${req.language}`);
  }
  
  return parts.join(':');
}

/**
 * 检查是否为空响应
 * @param {any} data - 响应数据
 * @returns {boolean}
 */
function isEmptyResponse(data) {
  if (data === null || data === undefined) {
    return true;
  }
  
  if (Array.isArray(data) && data.length === 0) {
    return true;
  }
  
  if (typeof data === 'object') {
    // 检查空对象
    if (Object.keys(data).length === 0) {
      return true;
    }
    
    // 检查空数据字段
    if (data.data !== undefined) {
      if (Array.isArray(data.data) && data.data.length === 0) {
        return true;
      }
      if (data.data === null) {
        return true;
      }
    }
    
    // 检查错误响应
    if (data.error || data.success === false) {
      return false;
    }
  }
  
  return false;
}

/**
 * 缓存清理中间件 - 用于手动清除特定缓存
 * 
 * @param {Object} options - 配置选项
 * @param {string} options.pattern - 缓存键模式
 * @returns {Function} Express 中间件
 */
function cacheClearMiddleware(options = {}) {
  return async (req, res, next) => {
    try {
      const pattern = options.pattern || `api:${req.path}:*`;
      await cache.delPattern(pattern);
      
      logger.info({ pattern }, 'Cache cleared');
      next();
    } catch (err) {
      logger.error({ err }, 'Cache clear error');
      next();
    }
  };
}

/**
 * 缓存预热中间件 - 在服务启动时预热热点数据
 * 
 * @param {Object} options - 配置选项
 * @param {Array<Object>} options.endpoints - 需要预热的端点列表
 * @returns {Function} 初始化函数
 */
function cacheWarmup(options = {}) {
  const { endpoints = [] } = options;
  
  return async () => {
    logger.info({ count: endpoints.length }, 'Starting cache warmup');
    
    for (const endpoint of endpoints) {
      try {
        const { key, fetcher, ttl = 300 } = endpoint;
        
        logger.debug({ key }, 'Warming up cache');
        
        const data = await fetcher();
        
        if (data !== null && data !== undefined) {
          await cache.set(key, data, ttl);
          logger.debug({ key }, 'Cache warmed up');
        }
      } catch (err) {
        logger.error({ err, endpoint }, 'Cache warmup failed');
      }
    }
    
    logger.info('Cache warmup completed');
  };
}

/**
 * 条件跳过缓存的辅助函数
 */
const skipConditions = {
  // 跳过特定查询参数
  hasQueryParam: (param) => (req) => req.query[param] !== undefined,
  
  // 跳过特定请求头
  hasHeader: (header) => (req) => req.get(header) !== undefined,
  
  // 跳过特定路径
  pathMatches: (pattern) => (req) => pattern.test(req.path),
  
  // 跳过调试请求
  isDebug: () => (req) => req.query.debug === 'true',
  
  // 跳过分页请求（超过一定页数）
  isDeepPagination: (maxPage = 10) => (req) => {
    const page = parseInt(req.query.page || '1', 10);
    return page > maxPage;
  }
};

/**
 * 创建常用缓存配置
 */
const presets = {
  // 静态数据缓存（长 TTL，无用户数据）
  static: {
    ttl: 3600,
    cacheUserData: false,
    cacheEmpty: true
  },
  
  // 用户数据缓存（中等 TTL）
  userData: {
    ttl: 300,
    cacheUserData: true,
    cacheEmpty: true
  },
  
  // 频繁变化的数据（短 TTL）
  dynamic: {
    ttl: 60,
    cacheUserData: true,
    cacheEmpty: false
  },
  
  // 列表数据缓存
  list: {
    ttl: 180,
    cacheUserData: true,
    cacheEmpty: true,
    emptyTtl: 30
  }
};

module.exports = {
  cacheMiddleware,
  cacheClearMiddleware,
  cacheWarmup,
  skipConditions,
  presets,
  defaultKeyGenerator,
  isEmptyResponse
};
