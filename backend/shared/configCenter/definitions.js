// backend/shared/configCenter/definitions.js
// E15 配置中心：mineGo 各模块的类型化配置定义与默认值（数据库无记录 / 配置中心不可用时使用这些默认值）
// 新增可热更新的配置：在这里 define，然后在代码里 getConfigClient().get(key) / watch(key, cb)。
'use strict';

const { ConfigRegistry } = require('./schema');

const int = (min, max, dflt, extra = {}) => ({ type: 'number', integer: true, min, max, default: dflt, ...extra });
const num = (min, max, dflt, extra = {}) => ({ type: 'number', min, max, default: dflt, ...extra });
const bool = (dflt, extra = {}) => ({ type: 'boolean', default: dflt, ...extra });

const windowLimit = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: int(1, 1_000_000),
    windowSec: int(1, 86_400),
    description: { type: 'string', maxLength: 200 },
  },
  required: ['limit', 'windowSec'],
};

const planQuota = {
  type: 'object',
  additionalProperties: false,
  properties: {
    minute: int(1, 1_000_000),
    hour: int(1, 10_000_000),
    day: int(1, 100_000_000),
    tierFactor: num(0.1, 20),
    priority: int(0, 3),
  },
  required: ['minute', 'hour', 'day'],
};

const TIERS = ['payment', 'critical', 'important', 'normal', 'auth', 'admin', 'feedback', 'exempt'];

function buildRegistry() {
  const r = new ConfigRegistry();
  r.defineAll({
    // ── E18 限流与配额（网关 AdaptiveRateLimit 中间件读取，变更实时生效）──────────────
    'ratelimit.enabled': bool(true, { description: '新的分布式限流是否启用（网关原有全局限流始终生效）' }),
    'ratelimit.mode': { type: 'string', enum: ['enforce', 'shadow'], default: 'enforce',
      description: 'enforce=超限返回 429；shadow=只计数/打指标/加响应头，不拦截（上线观察用）' },
    'ratelimit.tiers': {
      type: 'object',
      description: '接口分级限额（已登录按用户、未登录按 IP 计数，滑动窗口）',
      additionalProperties: windowLimit,
      default: {
        payment: { limit: 15, windowSec: 60, description: '支付' },
        critical: { limit: 40, windowSec: 60, description: '捕捉/战斗/交易/团战' },
        important: { limit: 90, windowSec: 60, description: '精灵/好友/奖励/道馆' },
        normal: { limit: 180, windowSec: 60, description: '地图/位置/用户等' },
        auth: { limit: 20, windowSec: 60, description: '登录/验证码（按 IP）' },
        admin: { limit: 300, windowSec: 60, description: '管理接口' },
        feedback: { limit: 10, windowSec: 60, description: '反馈提交与附件上传' },
      },
    },
    'ratelimit.routes': {
      type: 'array',
      maxItems: 200,
      description: '路径 → 分级规则（按顺序首个匹配；路径先去掉 /api 与 /vN 前缀，如 /api/v2/catch/x → /catch/x）',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prefix: { type: 'string', pattern: /^\/[A-Za-z0-9/_:.-]*$/, maxLength: 200 },
          tier: { type: 'string', enum: TIERS },
          methods: { type: 'array', maxItems: 7, items: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] } },
          priority: int(0, 3),
        },
        required: ['prefix', 'tier'],
      },
      default: [
        { prefix: '/health', tier: 'exempt' },
        { prefix: '/metrics', tier: 'exempt' },
        { prefix: '/api-docs', tier: 'exempt' },
        { prefix: '/ws/', tier: 'exempt' },
        { prefix: '/payment/webhook', tier: 'exempt' },
        { prefix: '/admin', tier: 'admin', priority: 0 },
        { prefix: '/payment', tier: 'payment', priority: 0 },
        { prefix: '/auth', tier: 'auth', priority: 0 },
        { prefix: '/catch', tier: 'critical', priority: 1 },
        { prefix: '/battle', tier: 'critical', priority: 1 },
        { prefix: '/raids', tier: 'critical', priority: 1 },
        { prefix: '/trades', tier: 'critical', priority: 1 },
        { prefix: '/feedback', tier: 'feedback', methods: ['POST', 'PUT', 'PATCH', 'DELETE'], priority: 2 },
        { prefix: '/pokemon', tier: 'important', priority: 2 },
        { prefix: '/friends', tier: 'important', priority: 2 },
        { prefix: '/rewards', tier: 'important', priority: 2 },
        { prefix: '/gyms', tier: 'important', priority: 2 },
        { prefix: '/events', tier: 'important', priority: 3 },
        { prefix: '/map', tier: 'normal', priority: 2 },
        { prefix: '/location', tier: 'normal', priority: 2 },
        { prefix: '/users', tier: 'normal', priority: 2 },
      ],
    },
    'ratelimit.defaultTier': { type: 'string', enum: TIERS, default: 'normal' },
    'ratelimit.plans': {
      type: 'object',
      description: '用户套餐配额（user_quotas.quota_level）：minute 为滑动窗口，hour/day 为自然小时/日（UTC）；tierFactor 放大分级限额；priority 为排队优先级加成',
      additionalProperties: planQuota,
      default: {
        free: { minute: 300, hour: 5000, day: 30000, tierFactor: 1, priority: 0 },
        premium: { minute: 450, hour: 8000, day: 60000, tierFactor: 1.5, priority: 1 },
        vip: { minute: 600, hour: 12000, day: 100000, tierFactor: 2, priority: 1 },
        svip: { minute: 1000, hour: 20000, day: 200000, tierFactor: 3, priority: 2 },
      },
    },
    'ratelimit.adaptive': {
      type: 'object',
      description: '按系统负载自适应收紧：负载分 0-100 → 系数（REQ-00098：0.5-1.5；REQ-00234：最低 0.3）',
      properties: {
        enabled: bool(true),
        sampleIntervalMs: int(500, 60_000, 2000),
        cooldownSec: int(0, 600, 10),
        minFactor: num(0.05, 1, 0.3),
        maxFactor: num(1, 3, 1.5),
        cpuCriticalPercent: num(50, 100, 90),
        cpuCriticalFactor: num(0.05, 1, 0.5),
        levels: {
          type: 'array', minItems: 1, maxItems: 10,
          items: { type: 'object', additionalProperties: false, properties: { minScore: num(0, 100), factor: num(0.05, 3) }, required: ['minScore', 'factor'] },
        },
        manualOverride: { type: 'json', maxBytes: 1024 },
      },
      default: {
        enabled: true,
        sampleIntervalMs: 2000,
        cooldownSec: 10,
        minFactor: 0.3,
        maxFactor: 1.5,
        cpuCriticalPercent: 90,
        cpuCriticalFactor: 0.5,
        levels: [
          { minScore: 95, factor: 0.3 },
          { minScore: 80, factor: 0.5 },
          { minScore: 60, factor: 0.7 },
          { minScore: 25, factor: 1.0 },
          { minScore: 0, factor: 1.2 },
        ],
        manualOverride: null,
      },
    },
    'ratelimit.reputation': {
      type: 'object',
      description: '用户信誉度（6 维度加权）→ 配额系数',
      properties: {
        enabled: bool(true),
        cacheSec: int(60, 86_400, 3600),
        violationThreshold: int(1, 10_000, 30),
        violationWindowSec: int(60, 86_400, 600),
      },
      default: { enabled: true, cacheSec: 3600, violationThreshold: 30, violationWindowSec: 600 },
    },
    'ratelimit.antiCheat': {
      type: 'object',
      description: '反作弊联动：可信度（anticheat:trust:<uid>，100 为正常）低于阈值时降低配额系数',
      properties: {
        enabled: bool(true),
        rules: {
          type: 'array', maxItems: 10,
          items: { type: 'object', additionalProperties: false, properties: { maxTrust: num(0, 100), multiplier: num(0.05, 1) }, required: ['maxTrust', 'multiplier'] },
        },
      },
      default: { enabled: true, rules: [{ maxTrust: 20, multiplier: 0.3 }, { maxTrust: 40, multiplier: 0.5 }] },
    },
    'ratelimit.queue': {
      type: 'object',
      description: '优先级准入队列：并发超过 maxConcurrent 时按 4 级优先级排队，超出 maxQueue 或等待超时返回 503',
      properties: {
        enabled: bool(true),
        maxConcurrent: int(1, 100_000, 2000),
        maxQueue: int(0, 100_000, 10000),
        maxWaitMs: int(10, 60_000, 3000),
      },
      default: { enabled: true, maxConcurrent: 2000, maxQueue: 10000, maxWaitMs: 3000 },
    },
    'ratelimit.warnings': {
      type: 'object',
      properties: { thresholds: { type: 'array', maxItems: 5, items: num(0.1, 1) } },
      default: { thresholds: [0.8, 0.9] },
    },
    'ratelimit.redisTimeoutMs': int(5, 2000, 50, { description: 'Redis 限流脚本超时，超时即本地兜底（fail-open）' }),
    'ratelimit.exemptRoles': { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 }, default: [] },

    // ── E14 反馈 ────────────────────────────────────────────────
    'feedback.enabled': bool(true, { clientVisible: true, description: '游戏内反馈入口开关' }),
    'feedback.limits': {
      type: 'object',
      properties: {
        perHour: int(1, 1000, 10),
        perDay: int(1, 10_000, 30),
        commentsPerHour: int(1, 1000, 30),
        maxScreenshots: int(0, 5, 5),
        maxLogs: int(0, 3, 3),
        // user-service 全局 JSON 限制 1MB，base64 膨胀 4/3，单个附件上限不超过 700KB
        maxScreenshotBytes: int(10 * 1024, 700 * 1024, 640 * 1024),
        maxLogBytes: int(1024, 700 * 1024, 128 * 1024),
        duplicateWindowSec: int(0, 86_400, 600),
      },
      default: { perHour: 10, perDay: 30, commentsPerHour: 30, maxScreenshots: 5, maxLogs: 3,
        maxScreenshotBytes: 640 * 1024, maxLogBytes: 128 * 1024, duplicateWindowSec: 600 },
    },
    'feedback.trend': {
      type: 'object',
      properties: {
        enabled: bool(true),
        intervalHours: num(0.25, 48, 6),
        zThreshold: num(1, 10, 3),
        minCount: int(1, 10_000, 10),
        ratioThreshold: num(1, 100, 2),
      },
      default: { enabled: true, intervalHours: 6, zThreshold: 3, minCount: 10, ratioThreshold: 2 },
    },
    'feedback.duplicateThreshold': num(0.3, 0.99, 0.6),
    'feedback.attachmentRetentionDays': int(1, 3650, 90),

    // ── E15 实验 ────────────────────────────────────────────────
    'experiments.enabled': bool(true, { description: '实验总开关：关闭后所有用户进入对照组/默认配置' }),
    'experiments.guardrailCheckSec': int(30, 86_400, 300),

    // ── 服务通用（ServiceLauncher 读取，所有服务热更新）─────────────────
    'service.rateLimitMultiplier': num(0.1, 10, 1, { description: '各服务路由级限流阈值倍率（ServiceLauncher routes[].rateLimit）' }),
    'service.logLevel': { type: 'string', enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'], default: 'info' },

    // ── 游戏客户端（/v1/client-config 下发，客户端定期拉取，无需发版）─────────
    'client.remoteConfigPollSec': int(30, 86_400, 300, { clientVisible: true }),
    'client.features': {
      type: 'object',
      clientVisible: true,
      description: '客户端功能开关（实验变体可覆盖）',
      additionalProperties: { type: 'boolean' },
      default: { feedback: true, feedbackScreenshots: true, feedbackDiagnostics: true },
    },
    'client.tuning': {
      type: 'object',
      clientVisible: true,
      description: '客户端玩法参数（实验变体可覆盖）',
      additionalProperties: { type: 'number', min: -1e9, max: 1e9 },
      default: { mapRefreshSec: 30 },
    },
  });
  return r;
}

let registry = null;
function getRegistry() {
  if (!registry) registry = buildRegistry();
  return registry;
}

module.exports = { getRegistry, buildRegistry, TIERS };
