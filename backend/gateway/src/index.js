// gateway/src/index.js  — lightweight API Gateway
'use strict';
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { createProxyMiddleware } = require('./proxy');
const swaggerUi    = require('swagger-ui-express');
const YAML         = require('yamljs');
const path         = require('path');
const { requireAuth, requireAdmin, errorHandler } = require('@pmg/shared/auth');
const { ServiceLauncher } = require('@pmg/shared/ServiceLauncher');
const HealthChecker = require('@pmg/shared/HealthChecker');
const db = require('@pmg/shared/db');
const redis = require('@pmg/shared/redis');
const { getClientIp } = require('@pmg/shared/clientIp');
const { createLogger, requestLogger } = require('@pmg/shared/logger');
const metrics = require('@pmg/shared/metrics');
const { authWithBlacklistMiddleware } = require('./middleware/jwtBlacklist');

// ── Auth middleware for protected routes ──────────────────────
// Uses authWithBlacklistMiddleware which includes JWT blacklist check
const authMiddleware = authWithBlacklistMiddleware;

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

// REQ-00075: IP 黑名单与恶意 IP 自动封禁系统
const { initIpBanManager, ipBanMiddleware, ipAccessLogMiddleware } = require('./middleware/ipBan');
const ipBanAdminRoutes = require('./routes/admin/ipBan');

// REQ-00072: API 响应压缩
const { createCompressionMiddleware } = require('@pmg/shared/compression');

// REQ-00111: API 安全响应头与 CSP 强化系统
const { apiSecurityHeaders, cspHeaders, sensitiveSecurityHeaders } = require('@pmg/shared/securityHeaders');
const { setCSRFCookie, verifyCSRF } = require('@pmg/shared/csrfProtection');
const securityRoutes = require('./routes/security');

// REQ-00130: 实时业务事件流监控与分析系统
const businessEventsRoutes = require('./routes/businessEvents');

// REQ-00071: K8s Pod 资源自动扩缩容优化系统
const autoscalingRoutes = require('./routes/autoscaling');

// REQ-00043: 延迟队列管理接口
const delayQueueAdminRoutes = require('./routes/delayQueueAdmin');

// REQ-00045: 设备完整性与模拟器检测系统
const { deviceIntegrityCheck, checkDeviceRestriction } = require('@pmg/shared/deviceIntegrityMiddleware');
const deviceIntegrityRoutes = require('./routes/deviceIntegrity');

// REQ-00040: 智能限流系统
const {
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
  combinedRateLimiter
} = require('./middleware/intelligentRateLimit');

const logger = createLogger('gateway');
const SERVICE_NAME = 'gateway';

const app  = express();
app.set('trust proxy', process.env.GATEWAY_TRUST_PROXY ? process.env.GATEWAY_TRUST_PROXY.split(',').map(value => value.trim()) : false);
const PORT = process.env.PORT === undefined ? 8080 : Number(process.env.PORT);
const healthChecker = new HealthChecker({ serviceName: SERVICE_NAME });
let ipManager;
let warmupPromise;

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
  keyGenerator: getClientIp,
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

// Access control precedes every business and operational route.
app.use(ipBanMiddleware);
app.use(ipAccessLogMiddleware);

// ── REQ-00044: API Version Middleware ────────────────────────────
app.use(apiVersionMiddleware);

// ── REQ-00045: Device Integrity Check ────────────────────────────
// 设备完整性检测中间件（应用于所有需要认证的路由）
app.use(deviceIntegrityCheck({
  blockOnFailure: false, // 检测失败时不阻止，避免影响正常用户
  strictMode: false, // 非严格模式，允许旧版客户端
  skipPaths: ['/health', '/metrics', '/api/auth', '/api/v1/auth', '/api/v2/auth'],
}));

// 设备管理 API
app.use('/api/device', authMiddleware, deviceIntegrityRoutes);

// ── REQ-00111: Security Routes ────────────────────────────
app.use('/api/v1/security', securityRoutes);

// ── REQ-00130: Business Events Routes ────────────────────────────
app.use('/api/events', businessEventsRoutes);

// ── REQ-00071: Autoscaling Routes ────────────────────────────
app.use('/api/v1/autoscaling', autoscalingRoutes);

// ── Health ────────────────────────────────────────────────────
healthChecker.register('database', () => db.query('SELECT 1').then(() => ({})), { critical: true, timeout: 2000 });
healthChecker.register('redis', () => redis.getRedis().ping().then(() => ({})), { critical: true, timeout: 2000 });
healthChecker.register('ipAccessControl', async () => {
  if (!ipManager?.initialized) throw new Error('IP access control is not initialized');
  // Connectivity alone cannot prove the access-control schema remains usable.
  await db.query('SELECT ip_address FROM ip_blacklist LIMIT 0');
  await db.query('SELECT ip_address FROM ip_whitelist LIMIT 0');
}, { critical: true, timeout: 2000 });
for (const [name, url] of Object.entries(SERVICES)) {
  healthChecker.register(name, async () => {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('Downstream service is unavailable');
  }, { critical: true, timeout: 2500 });
}
app.get('/health/live', async (_req, res) => res.json(await healthChecker.livenessCheck()));
async function healthReport(_req, res) {
  const report = await healthChecker.runAllChecks();
  const ready = report.status === 'healthy';
  res.status(ready ? 200 : 503).json({ ...report, gateway: 'ok', status: ready ? 'ready' : 'not_ready',
    services: Object.keys(SERVICES).map(name => ({ name, status: report.checks[name].status === 'healthy' ? 'up' : 'down' })) });
}
app.get('/health', healthReport);
app.get('/health/ready', healthReport);

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

// ── Initialize Cache System (REQ-00031) ───────────────────────
// ── Initialize Cache Warmup (REQ-00039) ───────────────────────
// Dependencies are initialized by the service lifecycle before listening.

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

// IP appeal endpoints authenticate private operations inside user-service.
require('./routes/ipAppealProxy').mountIpAppealProxy(app, SERVICES.user);

// ── v1 API Routes (Legacy) ──────────────────────────────────────────
// Public (no auth) - REQ-00040: 认证接口限流
app.use('/api/v1/auth', authRateLimiter(), proxy(SERVICES.user, { '^/api/v1/': '/' }));

// Protected v1 routes - REQ-00040: 高风险接口限流
app.use('/api/v1/catch',
  authMiddleware,
  highRiskRateLimiter(30), // 捕捉接口更严格限流
  catchV1Routes
);

app.use('/api/v1/users',
  authMiddleware,
  usersV1Routes
);

// Privacy routes authenticate private requests inside user-service.
require('./routes/privacyProxy').mountPrivacyProxy(app, SERVICES.user);

// ── v2 API Routes (Current) ──────────────────────────────────────────
// Public (no auth) - REQ-00040: 认证接口限流
app.use('/api/v2/auth', authRateLimiter(), proxy(SERVICES.user, { '^/api/v2/': '/' }));

// Protected v2 routes - REQ-00040: 高风险接口限流
app.use('/api/v2/catch',
  authMiddleware,
  highRiskRateLimiter(30), // 捕捉接口更严格限流
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

// REQ-00040: 交易接口高风险限流
app.use('/v1/trades',
  authMiddleware,
  highRiskRateLimiter(40),
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
// 其他精灵路由（不缓存）- REQ-00040: 用户级限流
app.use('/v1/pokemon',
  authMiddleware,
  userLevelRateLimiter(),
  proxy(SERVICES.pokemon, { '^/': '/pokemon/' })
);

app.use('/v1/pokestops',
  authMiddleware,
  proxy(SERVICES.pokemon, { '^/': '/pokestops/' })
);

app.use('/v1/catch',
  authMiddleware,
  highRiskRateLimiter(30), // REQ-00040: 捕捉接口严格限流
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

// REQ-00040: 支付接口高风险限流
app.use('/v1/payment',
  authMiddleware,
  highRiskRateLimiter(20), // 支付接口最严格限流
  proxy(SERVICES.payment, { '^/': '/payment/' })
);

// Payment webhook (no auth — signed by channel)
app.use('/v1/payment/webhook',
  proxy(SERVICES.payment, { '^/': '/payment/webhook/' })
);

// ── Cache Warmup Management API (REQ-00039) ────────────────────
// 获取预热状态
app.get('/admin/cache/warmup/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const status = cacheWarmup.getStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    logger.error({ err }, 'Failed to get warmup status');
    res.status(500).json({ success: false, error: err.message });
  }
});

// 手动触发预热
app.post('/admin/cache/warmup/trigger', requireAuth, requireAdmin, express.json({ limit: '1mb' }), async (req, res) => {
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

// ── IP Ban System (REQ-00075) ────────────────────────────
// 初始化 IP 封禁管理器


// IP 封禁管理 API（管理员）
app.use('/api/admin', ipBanAdminRoutes);

// 404 fallback
app.use(errorHandler);
app.use((req, res) => res.status(404).json({ code: 1005, message: `路由不存在: ${req.method} ${req.path}`, data: null }));

// Preserve the gateway's streaming middleware and route order while sharing the
// same initialization, listener draining and signal handling as other services.
class GatewayLauncher extends ServiceLauncher {
  createApp() { return app; }
  finalizeApp() { return app; }
}
const service = new GatewayLauncher({
  serviceName: SERVICE_NAME,
  port: PORT,
  onInitialize: async () => {
    await db.query('SELECT 1');
    const redisClient = redis.getRedis();
    await redisClient.ping();
    ipManager = initIpBanManager({ db, redis: redisClient, autoInitialize: false });
    await ipManager.init();
    cache.init();
    // Warmup is optional and does not delay the listener. Shutdown awaits its
    // outcome before removing refresh timers and releasing storage resources.
    warmupPromise = cacheWarmup.initialize({ redis: redisClient }).catch(err => {
      logger.error({ err }, 'Cache warmup failed, continuing without warm cache');
    });
  },
  onShutdown: async () => {
    await warmupPromise;
    cacheWarmup.shutdown();
    healthChecker.stopPeriodicCheck();
    const results = await Promise.allSettled([
      ipManager ? ipManager.close() : Promise.resolve(), cache.close(), db.closePools(), redis.closeRedis()
    ]);
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Gateway cleanup failed');
  }
});
if (require.main === module) service.start().catch(err => {
  logger.error({ err }, 'Failed to start gateway');
  process.exitCode = 1;
});
module.exports = service;
