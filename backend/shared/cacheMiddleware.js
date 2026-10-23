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
const crypto = require('node:crypto');
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
const MAX_RESPONSE_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_HEADERS = ['content-type', 'content-language', 'etag', 'last-modified', 'cache-control'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function defaultKeyGenerator(req) {
  const pathname = (req.originalUrl || req.path).split('?')[0].split('/').map(segment => {
    const decoded = decodeURIComponent(segment);
    return encodeURIComponent(UUID.test(decoded) ? decoded.toLowerCase() : decoded);
  }).join('/');
  const parts = [pathname, 'q:' + crypto.createHash('sha256').update(JSON.stringify(canonical(req.query || {}))).digest('hex')];
  if (req.user) {
    const subject = req.user.sub ?? req.user.id;
    if (typeof subject !== 'string' || !subject) throw new Error('Verified cache subject is missing');
    parts.push('user:' + (UUID.test(subject) ? subject.toLowerCase() : encodeURIComponent(subject)));
  }
  const language = String(req.language || req.headers?.['accept-language'] || '');
  parts.push('lang:' + crypto.createHash('sha256').update(language).digest('hex'));
  return parts.join(':');
}

function generateCacheKey(req, config) {
  return config.keyPrefix + (config.keyGenerator ? config.keyGenerator(req) : defaultKeyGenerator(req));
}

function cacheMiddleware(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  return async (req, res, next) => {
    if (req.method !== 'GET' || (req.user && !config.cacheUserData) || config.skipConditions.some(condition => condition(req))) return next();
    try {
      const key = generateCacheKey(req, config);
      const entry = await cache.readForFill(key);
      if (entry.disabled) { res.set('X-Cache', 'BYPASS'); return next(); }
      if (entry.hit) {
        const saved = entry.value;
        if (saved?.cacheEnvelope === 1) {
          for (const [name, value] of Object.entries(saved.headers)) res.set(name, value);
          res.status(saved.status);
          res.set('X-Cache', 'HIT');
          return res.json(saved.body);
        }
        // Old raw values are not accepted as HTTP responses.
      }
      res.set('X-Cache', 'MISS');
      let captured = false;
      const save = (body, status, headers) => {
        if (captured) return;
        captured = true;
        const [min, max] = config.statusCodeRange;
        const type = String(headers['content-type'] || 'application/json');
        const vary = String(headers.vary || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (status < min || status > max || headers['set-cookie'] || res.getHeader('set-cookie') ||
            /(?:^|,)\s*(?:no-store|no-cache)\b/i.test(String(headers['cache-control'] || '')) ||
            !/^application\/(?:[a-z0-9.-]+\+)?json(?:;|$)/i.test(type) ||
            vary.some(name => !['accept-encoding', 'accept-language', 'authorization'].includes(name))) return;
        const empty = isEmptyResponse(body);
        if (empty && !config.cacheEmpty) return;
        const encoded = JSON.stringify(body);
        if (encoded === undefined || Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) return;
        const storedHeaders = Object.fromEntries(SAFE_HEADERS.filter(name => headers[name] !== undefined).map(name => [name, headers[name]]));
        const pending = cache.set(key, {cacheEnvelope: 1, status, headers: storedHeaders, body}, empty ? config.emptyTtl : config.ttl, {token: entry.token});
        cache.track(pending).catch(() => logger.warn({code: 'CACHE_FILL_FAILED'}, 'Response cache fill failed'));
      };
      const originalJson = res.json.bind(res);
      res.json = body => {
        save(body, res.statusCode, res.getHeaders());
        return originalJson(body);
      };
      // http-proxy writes response bytes directly instead of calling res.json.
      // Observe a bounded identity-encoded stream without delaying its delivery.
      req.cacheCapture = upstream => {
        if (upstream.headers['content-encoding'] && upstream.headers['content-encoding'] !== 'identity') return;
        let chunks = [], bytes = 0, failed = false;
        upstream.on('data', chunk => {
          if (failed) return;
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) { failed = true; chunks = []; return; }
          chunks.push(chunk);
        });
        upstream.once('error', () => { failed = true; chunks = []; });
        upstream.once('aborted', () => { failed = true; chunks = []; });
        upstream.once('end', () => {
          if (failed || !upstream.complete) return;
          try { save(JSON.parse(Buffer.concat(chunks).toString('utf8')), upstream.statusCode, upstream.headers); }
          catch { /* Non-JSON responses continue to stream without a cache fill. */ }
          chunks = [];
        });
      };
      return next();
    } catch {
      logger.warn({code: 'CACHE_MIDDLEWARE_BYPASS'}, 'Response cache unavailable');
      return next();
    }
  };
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
