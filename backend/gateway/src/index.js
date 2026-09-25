// gateway/src/index.js  — lightweight API Gateway
'use strict';
require('@pmg/shared/tracing').initTracing('api-gateway'); // REQ-00042：须先于 express/http/pg/redis 加载，自动埋点才生效（未配置 OTEL_EXPORTER_OTLP_ENDPOINT 时不启用）
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

// REQ-00072 → REQ-00526: API 响应压缩（流式 Brotli/gzip，见 apiStandards/setup.js）

// Epic E25 API 设计规范：转换管道（REQ-00542）/ 版本协商与生命周期（REQ-00201/520）/ 内容协商（REQ-00368/554）/
// 分页（REQ-00302/465）/ HATEOAS（REQ-00518）/ 错误统一（REQ-00386）/ 弃用（REQ-00407）/ 字段投影（REQ-00532/251）/
// 契约校验（REQ-00315/547）/ 批量（REQ-00308）/ 重试（REQ-00402）/ 性能预算（REQ-00476）
const apiStdSetup = require('./apiStandards/setup');
const apiStdRoutes = require('./routes/apiStandards');
const { createRetryMiddleware } = require('@pmg/shared/middleware/retryMiddleware');
const { buildErrorBody, statusDefault } = require('@pmg/shared/apiStandards/errorCatalog');

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
  allowedHeaders: ['Content-Type','Authorization','X-Idempotency-Key','X-Request-ID','X-Trace-ID',
    'Accept-Version','X-API-Version','X-Client-Id','X-Client-Version','X-Field-Aliases','Idempotency-Key','X-Language'],
  exposedHeaders: ['X-Trace-Id','X-API-Version','X-API-Supported-Versions','Deprecation','Sunset','Link','Retry-After',
    'X-Total-Count','X-Pipeline','X-Pipeline-Time','Server-Timing','X-Field-Aliases','X-Schema-Validation','X-Content-Fallback'],
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
  // 启用 OpenTelemetry 时以活动 span 的 trace id 为准（与出站 traceparent、Jaeger 一致）
  const traceId = traceContext.activeTraceId() || traceContext.traceIdFromHeaders(req.headers) || traceContext.newTraceId();
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

// REQ-00476: 性能预算（记录每个 API 请求耗时并与 config/performance-budget.yaml 比较）
app.use(apiStdSetup.perfBudgetMiddleware());
// REQ-00402: 把 RetryManager 注入请求上下文（req.retryManager / req.retryableFetch，出站调用幂等重试 + 重试预算）
app.use(createRetryMiddleware({ serviceName: 'gateway-outbound', maxRetries: 2, initialDelay: 100, maxDelay: 2000, enableBudget: true, budgetConfig: { maxBudget: 50, refillRate: 10 } }));

// REQ-00075: IP 封禁必须在所有业务路由之前执行（原先注册在路由之后，只对 404 生效）
app.use((req, res, next) => ipBanMiddleware(req, res, next));
app.use((req, res, next) => ipAccessLogMiddleware(req, res, next));

// REQ-00040: 用户写操作成功后使其读缓存失效
app.use(invalidateOnWrite());

// Structured logging & metrics
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));

// REQ-00526: 流式响应压缩（Brotli 优先；在路由与转换管道之前注册 → 压缩的是管道输出）
app.use(apiStdSetup.compressionMiddleware());

// REQ-00542: 请求/响应转换管道（内容协商 406/415、弃用 410、分页/字段参数、错误统一、HATEOAS、契约校验、序列化）
app.use(apiStdSetup.apiStd.middleware());

// ── REQ-00044 / REQ-00201: API Version Middleware（生命周期 + 410 + Deprecation/Sunset）────
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
  // REQ-00402: 幂等请求在上游连接失败（重启/发布瞬间）时退避重试
  return apiStdSetup.withProxyRetry((onError) => createProxyMiddleware({
    target,
    changeOrigin: true,
    xfwd: true, // 透传 X-Forwarded-For，下游服务按真实客户端 IP 限流
    pathRewrite,
    on: { error: onError },
  }), proxyError, { target });
}

// ── API Version Management (REQ-00044) ────────────────────────────
// 版本信息 API（标记弃用端点需要管理员）
app.use('/api/version/deprecation/mark', authMiddleware, requireAdmin, express.json());
app.use('/api/version', apiVersionRoutes);

// ── Epic E25: API 规范公开接口 / 批量 / 管理 ─────────────────────
// 资源发现、错误码目录、媒体类型、字段集、弃用公告与迁移文档（公开只读）
app.use('/api', apiStdRoutes.publicRouter);
// REQ-00308: 批量请求（子请求回环经网关执行，完整复用鉴权/限流/管道）
// （/api/batch 为需求文档中的无版本别名）
app.use(['/api/v1/batch', '/api/batch'], authMiddleware, apiStdRoutes.batchRouter);
// REQ-00350: 精灵详情批量查询（/v1/pokemon/batch/details 已由 /v1/pokemon 代理覆盖，这里提供 /api/v1 别名）
app.use(['/api/v1/pokemon/batch', '/api/pokemon/batch'], authMiddleware, userLevelRateLimiter(), proxy(SERVICES.pokemon, { '^/': '/pokemon/batch/' }));
// REQ-00542: 管道 / 转换器管理
app.use('/api/v1/pipelines', authMiddleware, requireAdmin, apiStdRoutes.pipelineRouter);
app.use('/api/v1/transformers', authMiddleware, requireAdmin, apiStdRoutes.transformerRouter);
// REQ-00407: 弃用登记（两个路径等价）
app.use(['/api/admin/deprecations', '/admin/api/deprecations'], authMiddleware, requireAdmin, apiStdRoutes.deprecationAdminRouter);
// REQ-00201/520: 版本生命周期、转换规则、变更记录、使用统计
app.use('/api/admin/api-versions', authMiddleware, requireAdmin, apiStdRoutes.versionAdminRouter);
// REQ-00315/547/532/476/329/520/402: 契约、字段集、运行时配置、性能预算、lint、兼容性报告、重试统计
app.use('/api/admin/api-standards', authMiddleware, requireAdmin, apiStdRoutes.adminRouter);

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

// 好友路由（不缓存：好友列表含在线状态且受对方隐私设置实时影响，对方接受请求/修改隐私不会使我的缓存失效）
app.use('/v1/friends',
  authMiddleware,
  proxy(SERVICES.social, { '^/': '/friends/' })
);

// REQ-00228：隐私设置与好友权限
app.use('/v1/privacy',
  authMiddleware,
  proxy(SERVICES.social, { '^/': '/privacy/' })
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

// ── E11 战斗与技能（gym-service /battle/*）──────────────────────
// 回放分享链接：公开访问（无需登录），查看次数/密码/有效期由服务端校验
app.get('/v1/battle/replays/shared/:code',
  proxy(SERVICES.gym, { '^/v1/': '/' })
);
// 能量/冷却/装备、连击、伤害、技能推荐、AI 助手、回放、竞技联赛、客户端帧率上报；
// 回合接口 /v1/battle/sessions/:id/* 与 /v1/gyms/battles/:id/* 等价
app.use('/v1/battle',
  authMiddleware,
  proxy(SERVICES.gym, { '^/': '/battle/' })
);
// 需求文档（REQ-00112 / REQ-00324）约定的接口路径
app.get('/api/pokemon/:id/energy', authMiddleware, proxy(SERVICES.gym, { '^/api/pokemon/': '/battle/pokemon/' }));
app.post('/api/pokemon/:id/energy/regenerate', authMiddleware, proxy(SERVICES.gym, { '^/api/pokemon/': '/battle/pokemon/' }));
app.post('/api/pokemon/:id/moves/check', authMiddleware, proxy(SERVICES.gym, { '^/api/pokemon/': '/battle/pokemon/' }));
app.get('/api/v1/pokemon/:speciesId/move-recommendations', authMiddleware,
  proxy(SERVICES.gym, { '^/api/v1/pokemon/([^/]+)/move-recommendations': '/battle/recommendations/$1' })
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

// REQ-00386: 统一 JSON 错误处理（原先由 Express 默认处理器输出 HTML，如 requireAdmin 的 403）
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err.statusCode || err.status || err.httpStatus) || 500;
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  if (safeStatus >= 500) logger.error({ err, path: req.path }, 'Unhandled gateway error');
  const legacy = typeof err.toJSON === 'function' ? err.toJSON(req.headers['x-request-id']) : null;
  if (legacy && typeof legacy === 'object') return res.status(safeStatus).json(legacy);
  const { body } = buildErrorBody(statusDefault(safeStatus).name, {
    status: safeStatus,
    message: safeStatus >= 500 ? '网关内部错误' : err.message,
    requestId: req.headers['x-request-id'],
  });
  return res.status(safeStatus).json(body);
});


const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'API Gateway started');
  apiStdSetup.start().catch((err) => logger.error({ err }, 'API standards start failed'));
});

// ── WebSocket 升级转发 ─────────────────────────────────────────
// /ws/raid → gym-service（团战实时同步，token 与参与资格由 gym-service 校验）
// /ws/battle → gym-service 实时对战 WebSocket（独立端口 WS_BATTLE_PORT，JWT 鉴权）
// /ws/friends → social-service 好友实时推送（E01，token 由 social-service 校验）
// /ws/messages → user-service 消息中心实时推送（E13 REQ-00261/00425，token 与登出黑名单由 user-service 握手时校验）
const WS_TARGETS = {
  '/ws/friends': SERVICES.social,
  '/ws/raid': SERVICES.gym,
  '/ws/notifications': SERVICES.gym,
  '/ws/messages': SERVICES.user,
  '/ws/battle': process.env.GYM_BATTLE_WS_URL || 'http://localhost:8089',
};
const wsProxies = Object.fromEntries(Object.entries(WS_TARGETS).map(([p, target]) => [p, createProxyMiddleware({
  target, ws: true, changeOrigin: true, pathFilter: p,
  // /ws/battle 在对战服务上监听根路径
  pathRewrite: p === '/ws/battle' ? { '^/ws/battle': '/' } : undefined,
  on: { error: (err, req, socket) => { logger.warn({ err, path: req && req.url }, 'WS proxy error'); if (socket && socket.destroy) socket.destroy(); } },
})]));
server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url || '').split('?')[0];
  const p = wsProxies[pathname];
  if (!p) { socket.destroy(); return; }
  p.upgrade(req, socket, head);
});
module.exports = app;
