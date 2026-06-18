// gateway/src/index.js  — lightweight API Gateway
'use strict';
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { createProxyMiddleware } = require('http-proxy-middleware');
const swaggerUi    = require('swagger-ui-express');
const YAML         = require('yamljs');
const path         = require('path');
const { verifyAccess } = require('@pmg/shared/auth');
const { createLogger, requestLogger } = require('@pmg/shared/logger');
const metrics = require('@pmg/shared/metrics');
const { authWithBlacklistMiddleware } = require('./middleware/jwtBlacklist');

// REQ-00031: API 响应缓存层
const cache = require('@pmg/shared/cache');
const { cacheMiddleware } = require('@pmg/shared/cacheMiddleware');
const cacheInvalidation = require('@pmg/shared/cacheInvalidation');
const { cacheRoutes, presets } = require('./cacheConfig');

// REQ-00039: 缓存预热系统
const cacheWarmup = require('@pmg/shared/cacheWarmup');

// REQ-00044: API 版本管理
const { apiVersionMiddleware, CURRENT_VERSION } = require('./middleware/apiVersion');
const apiVersionRoutes = require('./routes/apiVersion');

// v1 版本路由
const catchV1Routes = require('./routes/v1/catch');
const usersV1Routes = require('./routes/v1/users');

// v2 版本路由
const catchV2Routes = require('./routes/v2/catch');
const usersV2Routes = require('./routes/v2/users');
const pokemonV2Routes = require('./routes/v2/pokemon');

// REQ-00040: 云成本监控与预算告警
const costReportRoutes = require('./routes/costReport');

// REQ-00085: 配置中心与动态配置热更新系统
const configRoutes = require('./routes/configRoutes');

// REQ-00103: 微服务依赖图与循环依赖检测系统
const dependenciesRoutes = require('./routes/dependencies');

// REQ-00102: 精灵昼夜循环系统
const timePeriodRoutes = require('./routes/timePeriod');

// REQ-00072: API 响应压缩
const { createCompressionMiddleware } = require('@pmg/shared/compression');

// REQ-00111: API 安全响应头与 CSP 强化系统
const { apiSecurityHeaders, cspHeaders, sensitiveSecurityHeaders } = require('@pmg/shared/securityHeaders');
const { setCSRFCookie, verifyCSRF } = require('@pmg/shared/csrfProtection');
const securityRoutes = require('./routes/security');

// REQ-00130: 实时业务事件流监控与分析系统
const businessEventsRoutes = require('./routes/businessEvents');

// REQ-00043: 延迟队列管理接口
const delayQueueAdminRoutes = require('./routes/delayQueueAdmin');

const logger = createLogger('gateway');
const SERVICE_NAME = 'gateway';

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Service registry ─────────────────────────────────────────
const SERVICES = {
  user:     process.env.USER_SERVICE_URL     || 'http://localhost:8081',
  location: process.env.LOCATION_SERVICE_URL || 'http://localhost:8082',
  pokemon:  process.env.POKEMON_SERVICE_URL  || 'http://localhost:8083',
  catch:    process.env.CATCH_SERVICE_URL    || 'http://localhost:8084',
  gym:      process.env.GYM_SERVICE_URL      || 'http://localhost:8085',
  social:   process.env.SOCIAL_SERVICE_URL   || 'http://localhost:8086',
  reward:   process.env.REWARD_SERVICE_URL   || 'http://localhost:8087',
  payment:  process.env.PAYMENT_SERVICE_URL  || 'http://localhost:8088',
};

// ── Middleware ────────────────────────────────────────────────
// REQ-00111: 安全响应头
app.use(apiSecurityHeaders);

// REQ-00111: CSRF 保护
app.use(setCSRFCookie());

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Idempotency-Key','X-Request-ID','X-Trace-ID'],
}));

// Global rate limit
app.use(rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 1007, message: '请求过于频繁，请稍后重试' },
  keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip,
}));

// Request ID & Trace ID injection
app.use((req, res, next) => {
  const traceId = req.headers['x-trace-id'] || uuidv4();
  const spanId = uuidv4();
  req.headers['x-request-id'] = req.headers['x-request-id'] || `gw-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  req.headers['x-trace-id'] = traceId;
  req.headers['x-span-id'] = spanId;
  res.setHeader('X-Trace-Id', traceId);
  next();
});

// Structured logging & metrics
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));

// REQ-00072: API 响应压缩（在路由之前）
app.use(createCompressionMiddleware());

// ── REQ-00044: API Version Middleware ────────────────────────────
app.use(apiVersionMiddleware);

// ── REQ-00111: Security Routes ────────────────────────────
app.use('/api/v1/security', securityRoutes);

// ── REQ-00130: Business Events Routes ────────────────────────────
app.use('/api/events', businessEventsRoutes);

// ── Health ────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const checks = await Promise.allSettled(
    Object.entries(SERVICES).map(async ([name, url]) => {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      return { name, status: r.ok ? 'up' : 'down' };
    })
  );
  const services = checks.map(r => r.status === 'fulfilled' ? r.value : { name: '?', status: 'down' });
  const allUp = services.every(s => s.status === 'up');
  res.status(allUp ? 200 : 503).json({ gateway: 'ok', services });
});

// ── Metrics ────────────────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', metrics.register.contentType);
    res.send(await metrics.register.metrics());
  } catch (err) {
    logger.error({ err }, 'Failed to generate metrics');
    res.status(500).json({ error: 'Metrics generation failed' });
  }
});

// ── API Documentation (Swagger UI) ─────────────────────────────
try {
  const openapiPath = path.join(__dirname, '../../../docs/api-spec/openapi/bundled.yaml');
  const swaggerDocument = YAML.load(openapiPath);
  
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'mineGo API Documentation',
    customfavIcon: '/favicon.ico',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      filter: true,
      syntaxHighlight: {
        activate: true,
        theme: 'monokai'
      }
    }
  }));
  
  logger.info('Swagger UI available at /api-docs');
} catch (err) {
  logger.warn({ err }, 'Swagger UI not available (OpenAPI spec not found)');
}

// ── Auth middleware for protected routes ──────────────────────
// Uses authWithBlacklistMiddleware which includes JWT blacklist check
const authMiddleware = authWithBlacklistMiddleware;

// ── Initialize Cache System (REQ-00031) ───────────────────────
// ── Initialize Cache Warmup (REQ-00039) ───────────────────────
const getRedis = require('@pmg/shared/redis').getRedis;

(async () => {
  try {
    // 初始化缓存模块
    cache.init({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD
    });
    
    logger.info('Cache system initialized');
    
    // 初始化缓存预热系统（非阻塞）
    const redisClient = getRedis();
    cacheWarmup.initialize({ redis: redisClient })
      .then(result => {
        logger.info({ itemsLoaded: result.itemsLoaded }, 'Cache warmup completed');
      })
      .catch(err => {
        logger.error({ err }, 'Cache warmup failed, continuing without warm cache');
      });
  } catch (err) {
    logger.error({ err }, 'Failed to initialize cache system');
  }
})();

// ── Proxy factory ─────────────────────────────────────────────
function proxy(target, pathRewrite) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite,
    on: {
      error: (err, req, res) => {
        logger.error({ err, reqId: req.headers['x-request-id'], path: req.path }, 'Proxy error');
        if (!res.headersSent) {
          res.status(502).json({ code: 9002, message: '下游服务暂时不可用', data: null });
        }
      },
    },
  });
}

// ── API Version Management (REQ-00044) ────────────────────────────
// 版本信息 API
app.use('/api/version', apiVersionRoutes);

// ── v1 API Routes (Legacy) ──────────────────────────────────────────
// Public (no auth)
app.use('/api/v1/auth',     proxy(SERVICES.user, { '^/api/v1/': '/' }));

// Protected v1 routes
app.use('/api/v1/catch',
  authMiddleware,
  rateLimit({ windowMs: 60_000, max: 120 }),
  catchV1Routes
);

app.use('/api/v1/users',
  authMiddleware,
  usersV1Routes
);

// ── v2 API Routes (Current) ──────────────────────────────────────────
// Public (no auth)
app.use('/api/v2/auth',     proxy(SERVICES.user, { '^/api/v2/': '/' }));

// Protected v2 routes
app.use('/api/v2/catch',
  authMiddleware,
  rateLimit({ windowMs: 60_000, max: 120 }),
  catchV2Routes
);

app.use('/api/v2/users',
  authMiddleware,
  usersV2Routes
);

app.use('/api/v2/pokemon',
  authMiddleware,
  pokemonV2Routes
);

// ── Legacy Routes (Default to current version) ──────────────────────
// 以下路由保持向后兼容，默认使用当前版本
// Public (no auth)
app.use('/v1/auth',     proxy(SERVICES.user, { '^/v1/': '/auth/' }));

// Protected with cache (REQ-00031)
// 用户资料 - 缓存 5 分钟
app.get('/v1/users/:id/profile',
  authMiddleware,
  cacheMiddleware({ ...presets.userData, keyPrefix: 'api:profile:', ttl: 300 }),
  proxy(SERVICES.user, { '^/': '/users/' })
);

// 用户统计 - 缓存 5 分钟
app.get('/v1/users/:id/stats',
  authMiddleware,
  cacheMiddleware({ ...presets.userData, keyPrefix: 'api:user-stats:', ttl: 300 }),
  proxy(SERVICES.user, { '^/': '/users/' })
);

// 其他用户路由（不缓存）
app.use('/v1/users',
  authMiddleware,
  proxy(SERVICES.user, { '^/': '/users/' })
);

// 好友列表 - 缓存 3 分钟
app.get('/v1/friends',
  authMiddleware,
  cacheMiddleware({ ...presets.list, keyPrefix: 'api:friends:', ttl: 180 }),
  proxy(SERVICES.social, { '^/': '/friends/' })
);

// 其他好友路由（不缓存）
app.use('/v1/friends',
  authMiddleware,
  proxy(SERVICES.social, { '^/': '/friends/' })
);

app.use('/v1/trades',
  authMiddleware,
  proxy(SERVICES.social, { '^/': '/trades/' })
);

app.use('/v1/map',
  authMiddleware,
  proxy(SERVICES.location, { '^/': '/map/' })
);

app.use('/v1/location',
  authMiddleware,
  proxy(SERVICES.location, { '^/': '/location/' })
);

// 精灵图鉴 - 缓存 1 小时（静态数据）
app.get('/v1/pokemon/pokedex',
  cacheMiddleware({ ...presets.static, keyPrefix: 'api:pokedex:', ttl: 3600 }),
  proxy(SERVICES.pokemon, { '^/': '/pokemon/' })
);

// 用户精灵列表 - 缓存 2 分钟
app.get('/v1/pokemon',
  authMiddleware,
  cacheMiddleware({ ...presets.userData, keyPrefix: 'api:pokemon-list:', ttl: 120 }),
  proxy(SERVICES.pokemon, { '^/': '/pokemon/' })
);

// 其他精灵路由（不缓存）
app.use('/v1/pokemon',
  authMiddleware,
  proxy(SERVICES.pokemon, { '^/': '/pokemon/' })
);

app.use('/v1/pokestops',
  authMiddleware,
  proxy(SERVICES.pokemon, { '^/': '/pokestops/' })
);

app.use('/v1/catch',
  authMiddleware,
  rateLimit({ windowMs: 60_000, max: 120 }),
  proxy(SERVICES.catch, { '^/': '/catch/' })
);

// 道馆附近查询 - 缓存 1 分钟
app.get('/v1/gyms/nearby',
  authMiddleware,
  cacheMiddleware({ ...presets.dynamic, keyPrefix: 'api:gyms-nearby:', ttl: 60 }),
  proxy(SERVICES.gym, { '^/': '/gyms/' })
);

// 其他道馆路由（不缓存）
app.use('/v1/gyms',
  authMiddleware,
  proxy(SERVICES.gym, { '^/': '/gyms/' })
);

// Raid 附近查询 - 缓存 30 秒
app.get('/v1/raids/nearby',
  authMiddleware,
  cacheMiddleware({ ...presets.dynamic, keyPrefix: 'api:raids-nearby:', ttl: 30 }),
  proxy(SERVICES.gym, { '^/': '/raids/' })
);

// 其他 Raid 路由（不缓存）
app.use('/v1/raids',
  authMiddleware,
  proxy(SERVICES.gym, { '^/': '/raids/' })
);

app.use('/v1/payment',
  authMiddleware,
  proxy(SERVICES.payment, { '^/': '/payment/' })
);

// Payment webhook (no auth — signed by channel)
app.use('/v1/payment/webhook',
  proxy(SERVICES.payment, { '^/': '/payment/webhook/' })
);

// ── Cache Warmup Management API (REQ-00039) ────────────────────
// 获取预热状态
app.get('/admin/cache/warmup/status', async (req, res) => {
  try {
    const status = cacheWarmup.getStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    logger.error({ err }, 'Failed to get warmup status');
    res.status(500).json({ success: false, error: err.message });
  }
});

// 手动触发预热
app.post('/admin/cache/warmup/trigger', async (req, res) => {
  try {
    const { name } = req.body;
    await cacheWarmup.triggerWarmup(name);
    res.json({ success: true, message: name ? `Warmup triggered for ${name}` : 'Full warmup triggered' });
  } catch (err) {
    logger.error({ err }, 'Failed to trigger warmup');
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Cost Monitoring API (REQ-00040) ────────────────────────────
// 成本概览和报告
app.use('/api/costs', costReportRoutes);

// 预算管理
app.use('/api/budgets', costReportRoutes);

// ── Config Management API (REQ-00085) ────────────────────────────
// 配置中心管理接口
app.use('/admin/config', configRoutes);

// 配置中心健康检查（无需认证）
app.use('/config/health', configRoutes);

// ── Dependencies Analysis API (REQ-00103) ────────────────────────────
// 微服务依赖分析接口（管理员专用）
app.use('/api/admin/dependencies', dependenciesRoutes);

// ── Delay Queue Admin API (REQ-00043) ────────────────────────────
// 延迟队列管理接口（管理员专用）
app.use('/api/admin/delay-queue', delayQueueAdminRoutes);

// ── Time Period API (REQ-00102) ────────────────────────────
// 昼夜循环系统接口（公开）
app.use('/api/time', timePeriodRoutes);

// 404 fallback
app.use((req, res) => res.status(404).json({ code: 1005, message: `路由不存在: ${req.method} ${req.path}`, data: null }));

app.listen(PORT, () => logger.info({ port: PORT }, 'API Gateway started'));
module.exports = app;
