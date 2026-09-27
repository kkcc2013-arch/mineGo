/**
 * REQ-00040: 网关 Redis 读缓存层
 *
 * 为什么重写：原 cacheMiddleware 通过拦截 res.json 写缓存，但网关路由的响应由 http-proxy-middleware
 * 直接流式转发，从不经过 res.json —— 缓存从未被写入过；且缓存键使用了不存在的 req.user.id，
 * 所有用户共用一份数据。
 *
 * 行为
 * - 只缓存 GET 且下游返回 200 + JSON 的响应；X-Cache: HIT / MISS / BYPASS
 * - perUser 路由的键包含用户 id 与"用户缓存版本号"：该用户任一写操作成功后版本号 +1，
 *   其所有缓存条目立即失效（旧条目随 TTL 过期），无需扫描删除
 * - Redis 故障时快速失败并直接回源（commandTimeout + 关闭离线队列），不影响请求
 * - 指标：minego_gateway_cache_requests_total{route,result}，命中率 = hit / (hit + miss)
 */
'use strict';

const Redis = require('ioredis');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const promClient = require('prom-client');
const metrics = require('@pmg/shared/metrics');
const { createLogger } = require('@pmg/shared/logger');
const { verifyAccess } = require('@pmg/shared/auth');

const logger = createLogger('gateway-response-cache');

let client = null;
function redis() {
  if (!client) {
    const opts = {
      enableOfflineQueue: false,     // 断连时命令立即失败 → 回源
      maxRetriesPerRequest: 1,
      commandTimeout: Number(process.env.GATEWAY_CACHE_TIMEOUT_MS || 150),
      retryStrategy: (times) => Math.min(times * 200, 5000),
    };
    client = process.env.GATEWAY_CACHE_REDIS_URL
      ? new Redis(process.env.GATEWAY_CACHE_REDIS_URL, opts)
      : new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD,
        ...opts,
      });
    client.on('error', (err) => logger.debug({ err: err.message }, 'cache redis error'));
  }
  return client;
}

const registry = metrics.register || promClient.register;
const cacheCounter = registry.getSingleMetric('minego_gateway_cache_requests_total') || new promClient.Counter({
  name: 'minego_gateway_cache_requests_total',
  help: 'Gateway response cache lookups by route and result (hit/miss/bypass/error)',
  labelNames: ['route', 'result'],
  registers: [registry],
});

// 命中统计：Prometheus（按进程）+ Redis 哈希（跨 PM2 cluster 实例汇总，供管理接口查看）
const STATS_KEY = 'gwcache:stats';
function count(route, result) {
  cacheCounter.inc({ route, result });
  if (result !== 'error') redis().hincrby(STATS_KEY, `${route}:${result}`, 1).catch(() => {});
}

async function getStats() {
  const raw = await redis().hgetall(STATS_KEY).catch(() => ({}));
  const routes = {};
  let hit = 0, miss = 0;
  for (const [k, v] of Object.entries(raw || {})) {
    const idx = k.lastIndexOf(':');
    const route = k.slice(0, idx), result = k.slice(idx + 1);
    routes[route] = routes[route] || { hit: 0, miss: 0, bypass: 0 };
    routes[route][result] = Number(v);
  }
  for (const s of Object.values(routes)) {
    s.hitRate = s.hit + s.miss ? +(s.hit / (s.hit + s.miss)).toFixed(4) : null;
    hit += s.hit; miss += s.miss;
  }
  return { hitRate: hit + miss ? +(hit / (hit + miss)).toFixed(4) : null, hit, miss, routes };
}

const userVersionKey = (userId) => `cache:ver:${userId}`;

async function userVersion(userId) {
  const v = await redis().get(userVersionKey(userId));
  return v || '0';
}

/** 写操作成功后使该用户的缓存失效（全局中间件，放在所有路由之前） */
function invalidateOnWrite() {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      let userId = req.user && (req.user.sub || req.user.id);
      if (!userId) {
        // 部分路由（如 /v1/gdpr）由下游服务鉴权，网关上没有 req.user：自行校验 token 取用户
        const h = req.headers.authorization || '';
        if (h.startsWith('Bearer ')) {
          try { userId = verifyAccess(h.slice(7)).sub; } catch { /* 无效 token 不处理 */ }
        }
      }
      if (!userId) return;
      redis().incr(userVersionKey(userId))
        .then(() => redis().expire(userVersionKey(userId), 7 * 86400))
        .catch(() => { /* Redis 不可用：缓存条目随 TTL 过期 */ });
    });
    next();
  };
}

function sortedQuery(req) {
  const q = req.query || {};
  return Object.keys(q).sort().map((k) => `${k}=${Array.isArray(q[k]) ? q[k].join(',') : q[k]}`).join('&');
}

/**
 * 带缓存的代理
 * @param {object} opts
 * @param {string} opts.route      指标/键使用的路由名
 * @param {string} opts.target     下游地址
 * @param {object} opts.pathRewrite
 * @param {number} opts.ttl        秒
 * @param {boolean} opts.perUser   是否按用户隔离（需要在 authMiddleware 之后）
 * @param {function} [opts.onError]
 */
function cachedProxy({ route, target, pathRewrite, ttl, perUser = true, onError }) {
  const keyPrefix = `gwcache:${route}:`;

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    xfwd: true,
    pathRewrite,
    selfHandleResponse: true,
    on: {
      proxyRes: responseInterceptor(async (buffer, proxyRes, req, res) => {
        const key = req._gwCacheKey;
        const type = String(proxyRes.headers['content-type'] || '');
        if (key && proxyRes.statusCode === 200 && type.includes('application/json')) {
          redis().set(key, JSON.stringify({ type, body: buffer.toString('utf8') }), 'EX', ttl)
            .catch(() => count(route, 'error'));
        }
        if (key) res.setHeader('X-Cache', 'MISS');
        return buffer;
      }),
      error: onError,
    },
  });

  return async (req, res, next) => {
    if (req.method !== 'GET') return proxy(req, res, next);
    let key = null;
    try {
      const userId = req.user && (req.user.sub || req.user.id);
      if (perUser && !userId) {
        count(route, 'bypass');
        res.setHeader('X-Cache', 'BYPASS');
        return proxy(req, res, next);
      }
      const scope = perUser ? `u:${userId}:v${await userVersion(userId)}:` : '';
      key = `${keyPrefix}${scope}${req.path}?${sortedQuery(req)}`;
      const cached = await redis().get(key);
      if (cached) {
        const { type, body } = JSON.parse(cached);
        count(route, 'hit');
        res.setHeader('Content-Type', type);
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).send(body);
      }
      count(route, 'miss');
      req._gwCacheKey = key;
    } catch (err) {
      // Redis 不可用 / 超时：降级为直接回源
      count(route, 'error');
      res.setHeader('X-Cache', 'BYPASS');
      req._gwCacheKey = null;
    }
    return proxy(req, res, next);
  };
}

// 启动即建立连接（关闭了离线队列，未连接时的请求会直接回源）
redis();

module.exports = { cachedProxy, invalidateOnWrite, getStats };
