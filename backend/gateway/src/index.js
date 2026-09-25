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
const { verifyAccess, requireAdmin } = require('@pmg/shared/auth');
const { createLogger, requestLogger } = require('@pmg/shared/logger');
const traceContext = require('@pmg/shared/traceContext');
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
// REQ-00040: 真正生效的网关读缓存（原 cacheMiddleware 对代理响应无效）
const { cachedProxy, invalidateOnWrite, getStats: getCacheStats } = require('./middleware/responseCache');

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
const PORT = process.env.PORT || 8080;

// 只信任来自本机反向代理的 X-Forwarded-For（可用 TRUST_PROXY 覆盖），否则 req.ip 可被伪造
app.set('trust proxy', require('@pmg/shared/trustProxy').parseTrustProxy(process.env.TRUST_PROXY));

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
  keyGenerator: (req) => req.ip,
}));

// 身份类请求头只能由网关在鉴权后写入，入口处一律清除客户端伪造的值
const TRUSTED_INTERNAL_HEADERS = ['x-user-id', 'x-user-level', 'x-user-jti', 'x-user-roles', 'x-internal-token', 'x-service-token'];
app.use((req, _res, next) => {
  for (const h of TRUSTED_INTERNAL_HEADERS) delete req.headers[h];
  next();
});

// Request ID & Trace ID injection
// REQ-00042: 统一 trace id（W3C 兼容 32 位 hex），透传给下游服务（x-trace-id + traceparent）
app.use((req, res, next) => {
  const traceId = traceContext.traceIdFromHeaders(req.headers) || traceContext.newTraceId();
  const spanId = traceContext.newSpanId();
  const rid = req.headers['x-request-id'];
  req.headers['x-request-id'] = (typeof rid === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(rid))
    ? rid : `gw-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  req.headers['x-trace-id'] = traceId;
  req.headers['x-span-id'] = spanId;
  const tp = traceContext.traceparent(traceId, spanId);
  if (tp) req.headers.traceparent = tp;
  res.setHeader('X-Trace-Id', traceId);
  next();
});

// REQ-00075: IP 封禁必须在所有业务路由之前执行（原先注册在路由之后，只对 404 生效）
app.use((req, res, next) => ipBanMiddleware(req, res, next));
app.use((req, res, next) => ipAccessLogMiddleware(req, res, next));

// REQ-00040: 用户写操作成功后使其读缓存失效
app.use(invalidateOnWrite());

// Structured logging & metrics
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));

// REQ-00072: API 响应压缩（在路由之前）
app.use(createCompressionMiddleware());

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
app.use('/api/events', authMiddleware, requireAdmin, businessEventsRoutes);

// ── REQ-00071: Autoscaling Routes ────────────────────────────
app.use('/api/v1/autoscaling', authMiddleware, requireAdmin, autoscalingRoutes);

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
function proxyError(err, req, res) {
  logger.error({ err, reqId: req.headers['x-request-id'], path: req.path }, 'Proxy error');
  if (res && !res.headersSent && typeof res.status === 'function') {
    res.status(502).json({ code: 9002, message: '下游服务暂时不可用', data: null });
  }
}

function proxy(target, pathRewrite) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    xfwd: true, // 透传 X-Forwarded-For，下游服务按真实客户端 IP 限流
    pathRewrite,
    on: { error: proxyError },
  });
}

// ── API Version Management (REQ-00044) ────────────────────────────
// 版本信息 API
app.use('/api/version', apiVersionRoutes);

// ── v1 API Routes (Legacy) ──────────────────────────────────────────
// Public (no auth) - REQ-00040: 认证接口限流
app.use('/api/v1/auth', authRateLimiter(), proxy(SERVICES.user, { '^/': '/auth/' }));

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

// ── v2 API Routes (Current) ──────────────────────────────────────────
// Public (no auth) - REQ-00040: 认证接口限流
app.use('/api/v2/auth', authRateLimiter(), proxy(SERVICES.user, { '^/': '/auth/' }));

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
app.use('/v1/auth',     proxy(SERVICES.user, { '^/': '/auth/' }));

// 用户资料 / 统计（REQ-00327/REQ-00387）：不再在网关按查看者缓存——网关缓存只随查看者自己的写操作失效，
// 被查看者改了资料后其他人最多 5 分钟看到旧数据。改由 user-service 按"被查看者 + 可见范围"缓存，
// 被查看者的资料/称号/成就/收藏室变化即时失效（shared/profileCache）。
// 分享卡片（公开资料，无需登录）
app.use('/v1/profile-cards', proxy(SERVICES.user, { '^/': '/profile-cards/' }));

// 其他用户路由（不缓存）
app.use('/v1/users',
  authMiddleware,
  proxy(SERVICES.user, { '^/': '/users/' })
);

// REQ-00044: GDPR 数据导出 / 删除。隐私政策公开；其余经网关鉴权（含 token 黑名单，
// 登出/吊销后的 token 不能再导出个人数据或发起删除）
app.get('/v1/gdpr/privacy-policy',
  proxy(SERVICES.user, { '^/v1/': '/' })
);
app.use('/v1/gdpr',
  authMiddleware,
  proxy(SERVICES.user, { '^/': '/gdpr/' })
);

// 好友列表 - 缓存 3 分钟
app.get('/v1/friends',
  authMiddleware,
  cachedProxy({ route: 'friends', target: SERVICES.social, pathRewrite: { '^/v1/': '/' }, ttl: 180, perUser: true, onError: proxyError })
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
  authMiddleware,
  cachedProxy({ route: 'pokedex', target: SERVICES.pokemon, pathRewrite: { '^/v1/': '/' }, ttl: 300, perUser: true, onError: proxyError })
);

// 用户精灵列表 - 缓存 2 分钟
app.get('/v1/pokemon',
  authMiddleware,
  cachedProxy({ route: 'pokemon-list', target: SERVICES.pokemon, pathRewrite: { '^/v1/': '/' }, ttl: 120, perUser: true, onError: proxyError })
);

// 背包 - 按用户缓存 60 秒，用户任一写操作（如捕捉成功）后立即失效（REQ-00040）
app.get('/v1/pokemon/my',
  authMiddleware,
  cachedProxy({ route: 'pokemon-my', target: SERVICES.pokemon, pathRewrite: { '^/v1/': '/' }, ttl: 60, perUser: true, onError: proxyError })
);

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
  cachedProxy({ route: 'gyms-nearby', target: SERVICES.gym, pathRewrite: { '^/v1/': '/' }, ttl: 60, perUser: false, onError: proxyError })
);

// 其他道馆路由（不缓存）
app.use('/v1/gyms',
  authMiddleware,
  proxy(SERVICES.gym, { '^/': '/gyms/' })
);

// Raid 附近查询 - 缓存 30 秒
app.get('/v1/raids/nearby',
  authMiddleware,
  cachedProxy({ route: 'raids-nearby', target: SERVICES.gym, pathRewrite: { '^/v1/': '/' }, ttl: 30, perUser: false, onError: proxyError })
);

// 其他 Raid 路由（不缓存）
app.use('/v1/raids',
  authMiddleware,
  proxy(SERVICES.gym, { '^/': '/raids/' })
);

// 奖励服务（每日奖励/任务/排行榜/赛季/活动）— 原网关缺少该路由，reward-service 无法从外部访问
app.use('/v1/rewards',
  authMiddleware,
  userLevelRateLimiter(),
  proxy(SERVICES.reward, { '^/': '/rewards/' })
);

app.use('/v1/events',
  authMiddleware,
  proxy(SERVICES.reward, { '^/': '/events/' })
);

// ── Epic E05/E13：成就、消息中心 ───────────────────────────────
// REQ-00076 成就（pokemon-service）
app.use('/v1/achievements',
  authMiddleware,
  proxy(SERVICES.pokemon, { '^/': '/achievements/' })
);
// REQ-00359/00403 精灵收藏室（pokemon-service）
app.use('/v1/collection-room',
  authMiddleware,
  proxy(SERVICES.pokemon, { '^/': '/collection-room/' })
);
// REQ-00099/00261/00425 消息中心（user-service）；实时推送见文末 /ws/notifications 升级代理
app.use('/v1/notifications',
  authMiddleware,
  proxy(SERVICES.user, { '^/': '/notifications/' })
);

// Payment webhook (no auth — signed by channel)；必须注册在需要鉴权的 /v1/payment 之前
app.use('/v1/payment/webhook',
  proxy(SERVICES.payment, { '^/': '/payment/webhook/' })
);

// REQ-00040: 支付接口高风险限流
app.use('/v1/payment',
  authMiddleware,
  highRiskRateLimiter(20), // 支付接口最严格限流
  proxy(SERVICES.payment, { '^/': '/payment/' })
);

// ── Cache Warmup Management API (REQ-00039) ────────────────────
// 获取预热状态
app.get('/admin/cache/warmup/status', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const status = cacheWarmup.getStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    logger.error({ err }, 'Failed to get warmup status');
    res.status(500).json({ success: false, error: err.message });
  }
});

// 手动触发预热
app.post('/admin/cache/warmup/trigger', authMiddleware, requireAdmin, express.json(), async (req, res) => {
  try {
    const { name } = req.body || {};
    await cacheWarmup.triggerWarmup(name);
    res.json({ success: true, message: name ? `Warmup triggered for ${name}` : 'Full warmup triggered' });
  } catch (err) {
    logger.error({ err }, 'Failed to trigger warmup');
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Cost Monitoring API (REQ-00040) ────────────────────────────
// 成本概览和报告
app.use('/api/costs', authMiddleware, requireAdmin, costReportRoutes);

// 预算管理
app.use('/api/budgets', authMiddleware, requireAdmin, costReportRoutes);

// ── Config Management API (REQ-00085) ────────────────────────────
// 配置中心管理接口
app.use('/admin/config', authMiddleware, requireAdmin, configRoutes);

// 配置中心健康检查（无需认证）
app.use('/config/health', configRoutes);

// ── Dependencies Analysis API (REQ-00103) ────────────────────────────
// 微服务依赖分析接口（管理员专用）
app.use('/api/admin/dependencies', authMiddleware, requireAdmin, dependenciesRoutes);

// ── Delay Queue Admin API (REQ-00043) ────────────────────────────
// 延迟队列管理接口（管理员专用）
app.use('/api/admin/delay-queue', authMiddleware, requireAdmin, delayQueueAdminRoutes);

// ── REQ-00040: 网关缓存命中率 ───────────────────────────────
app.get('/api/admin/cache/stats', authMiddleware, requireAdmin, async (req, res) => {
  res.json({ success: true, data: await getCacheStats() });
});

// ── REQ-00586: 反作弊管理（可疑玩家列表 / 证据）────────────────────
app.use('/api/admin/anticheat',
  authMiddleware,
  requireAdmin,
  proxy(SERVICES.location, { '^/': '/anticheat/' })
);

// ── Time Period API (REQ-00102) ────────────────────────────
// 昼夜循环系统接口（公开）
app.use('/api/time', timePeriodRoutes);

// ── IP Ban System (REQ-00075) ────────────────────────────
// 初始化 IP 封禁管理器
(async () => {
  try {
    const redisClient = getRedis();
    initIpBanManager({
      db: require('@pmg/shared/db'),
      redis: redisClient,
      publisher: redisClient,
      subscriber: redisClient.duplicate()
    });
    logger.info('IP Ban Manager initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize IP Ban Manager');
  }
})();

// IP 封禁管理 API（管理员）
app.use('/api/admin', authMiddleware, requireAdmin, ipBanAdminRoutes);

// 404 fallback
app.use((req, res) => res.status(404).json({ code: 1005, message: `路由不存在: ${req.method} ${req.path}`, data: null }));

const server = app.listen(PORT, () => logger.info({ port: PORT }, 'API Gateway started'));

// REQ-00261/00425: 消息实时推送 WebSocket（/ws/notifications?token=…）升级请求代理到 user-service，
// 鉴权（签名 + 登出黑名单）由 user-service 在握手时完成；其他路径的升级请求直接拒绝
const notificationWsProxy = createProxyMiddleware({
  target: SERVICES.user, changeOrigin: true, ws: true, pathFilter: '/ws/notifications', on: { error: proxyError },
});
server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').split('?')[0] === '/ws/notifications') return notificationWsProxy.upgrade(req, socket, head);
  socket.destroy();
});
module.exports = app;
