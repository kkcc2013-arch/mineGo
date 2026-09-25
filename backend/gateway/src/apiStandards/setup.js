/**
 * 网关侧 API 设计规范装配（Epic E25）
 *
 * 导出单例 apiStd（转换管道 + 各注册表）、性能预算管理器、流式压缩中间件、代理重试包装、批量执行器，
 * 以及 start()：加载数据库状态、同步契约版本、启动定时任务。
 */
'use strict';

const promClient = require('prom-client');
const metrics = require('@pmg/shared/metrics');
const { createLogger } = require('@pmg/shared/logger');
const { verifyAccess } = require('@pmg/shared/auth');
const { createApiStandards } = require('@pmg/shared/apiStandards');
const { createStreamingCompression } = require('@pmg/shared/apiStandards/streamingCompression');
const perf = require('@pmg/shared/apiStandards/performanceBudget');
const { BatchExecutor } = require('@pmg/shared/apiStandards/batch');
const { RetryManager, RetryBudget, RetryStatsRecorder } = require('@pmg/shared/RetryManager');
const { getVersionRegistry } = require('../middleware/apiVersion');

const logger = createLogger('api-standards');

let db = null;
function query(sql, params) {
  if (!db) db = require('@pmg/shared/db');
  return db.query(sql, params);
}

let redisClient = null;
function redis() {
  if (!redisClient) {
    try { redisClient = require('@pmg/shared/redis').getRedis(); } catch { redisClient = null; }
  }
  return redisClient;
}

function metric(Type, cfg) {
  return metrics.register.getSingleMetric(cfg.name) || new Type({ ...cfg, registers: [metrics.register] });
}

// ── 版本注册表与管道 ─────────────────────────────────────────
const versionRegistry = getVersionRegistry({ query, logger });
// 与 apiVersion 中间件共享同一个版本注册表
const apiStd = createApiStandards({ query, logger, verifyToken: verifyAccess, versionRegistry });

// ── REQ-00476 性能预算 ───────────────────────────────────────
let budgetConfig;
try {
  budgetConfig = perf.loadConfigFile();
} catch (err) {
  logger.warn({ err: err.message }, 'performance-budget.yaml 加载失败，使用默认预算');
  budgetConfig = perf.normalizeConfig({ defaults: {}, budgets: {} });
}
const perfMetrics = {
  histogram: metric(promClient.Histogram, { name: 'api_performance_budget_duration_seconds', help: 'Request duration by budgeted route', labelNames: ['route', 'budget_type'], buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1, 2, 3, 5] }),
  violations: metric(promClient.Counter, { name: 'api_performance_budget_violations_total', help: 'Performance budget violations', labelNames: ['route', 'budget_type', 'level'] }),
  alerts: metric(promClient.Counter, { name: 'api_performance_budget_alerts_total', help: 'Strict budget violation alerts', labelNames: ['route', 'level', 'severity'] }),
};
const budgetManager = new perf.PerformanceBudgetManager({
  config: budgetConfig,
  redis: null, // start() 后接入 Redis
  logger,
  metrics: perfMetrics,
  onAlert(alert) {
    query(`INSERT INTO api_performance_alerts (endpoint, alert_type, severity, message, metrics_after) VALUES ($1, 'budget_violation', $2, $3, $4)`,
      [alert.route, alert.severity, `${alert.route} ${alert.level}=${alert.value}ms 超出 ${alert.budgetType} 预算 ${alert.budget}ms`, JSON.stringify(alert)]).catch(() => {});
  },
});

function perfBudgetMiddleware() {
  return (req, res, next) => {
    const t0 = process.hrtime.bigint();
    const path = req.path;
    const method = req.method;
    res.on('finish', () => {
      if (!/^\/(v\d+|api|admin)\//.test(path) || req.headers['x-benchmark-probe'] === 'skip') return;
      budgetManager.record(method, path, Number(process.hrtime.bigint() - t0) / 1e6, res.statusCode);
    });
    next();
  };
}

// ── REQ-00526 流式压缩 ──────────────────────────────────────
const compressionMetrics = {
  bytes: metric(promClient.Counter, { name: 'gateway_stream_compression_bytes_total', help: 'Bytes before/after streaming compression', labelNames: ['encoding', 'stage'] }),
  ratio: metric(promClient.Histogram, { name: 'gateway_stream_compression_ratio', help: 'Compression ratio (1 - out/in)', labelNames: ['encoding'], buckets: [0.1, 0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95] }),
  streams: metric(promClient.Counter, { name: 'gateway_stream_compression_responses_total', help: 'Compressed responses', labelNames: ['encoding', 'streaming'] }),
};
function compressionMiddleware() {
  return createStreamingCompression({
    threshold: Number(process.env.COMPRESSION_THRESHOLD || 1024),
    brotliQuality: Number(process.env.COMPRESSION_BROTLI_QUALITY || 4),
    metrics: compressionMetrics,
    skipPaths: ['/metrics', '/api-docs'],
    skip: (req, res) => res.locals && res.locals.compress === false,
  });
}

// ── REQ-00402 重试（代理 + 批量子请求） ─────────────────────────
const retryRecorder = new RetryStatsRecorder({ query, serviceName: 'gateway' });
const retryManagers = {
  batch: new RetryManager({ serviceName: 'gateway-batch', maxRetries: 2, initialDelay: 50, maxDelay: 1000, jitterType: 'full', timeout: 10000, retryBudget: new RetryBudget({ maxBudget: 50, refillRate: 10 }), ...retryRecorder.hooks() }),
};
const proxyRetryCounter = metric(promClient.Counter, { name: 'gateway_proxy_retries_total', help: 'Idempotent proxy retries on upstream connection errors', labelNames: ['target', 'code', 'outcome'] });
const proxyBudget = new RetryBudget({ maxBudget: 30, refillRate: 5 });
const RETRYABLE_CONN = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

/**
 * 给 http-proxy-middleware 加上"幂等请求连接失败重试"：GET/HEAD/OPTIONS 在上游连接错误
 * （服务重启/滚动发布瞬间）时指数退避 + full jitter 重试最多 2 次；预算耗尽或响应头已发出则直接报错
 */
function withProxyRetry(createMw, onFinalError, { target = 'unknown', maxRetries = 2 } = {}) {
  let mw;
  const handleError = (err, req, res) => {
    const attempt = req._proxyRetry || 0;
    const idempotent = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (idempotent && RETRYABLE_CONN.has(err.code) && attempt < maxRetries && res && !res.headersSent && typeof res.status === 'function' && proxyBudget.allow()) {
      req._proxyRetry = attempt + 1;
      const delay = Math.round(Math.random() * Math.min(800, 100 * 2 ** attempt));
      proxyRetryCounter.inc({ target, code: err.code, outcome: 'retry' });
      setTimeout(() => {
        req.url = req._proxyUrl;
        mw(req, res, (e) => onFinalError(e || err, req, res));
      }, delay);
      return;
    }
    if (attempt > 0) proxyRetryCounter.inc({ target, code: err.code || 'unknown', outcome: 'give_up' });
    onFinalError(err, req, res);
  };
  mw = createMw(handleError);
  return (req, res, next) => {
    if (req._proxyUrl === undefined || !req._proxyRetry) req._proxyUrl = req.url;
    return mw(req, res, next);
  };
}

// ── REQ-00308 批量执行器（回环调用网关自身） ─────────────────────
const batchMetrics = {
  requests: metric(promClient.Counter, { name: 'api_batch_requests_total', help: 'Batch requests', labelNames: ['template', 'result'] }),
  subrequests: metric(promClient.Counter, { name: 'api_batch_subrequests_total', help: 'Batch sub-requests', labelNames: ['status_class', 'cached'] }),
  duration: metric(promClient.Histogram, { name: 'api_batch_duration_seconds', help: 'Batch total duration', labelNames: ['template'], buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5] }),
  size: metric(promClient.Histogram, { name: 'api_batch_size', help: 'Sub-requests per batch', buckets: [1, 2, 3, 5, 10, 20] }),
  cost: metric(promClient.Counter, { name: 'api_batch_cost_saved_usd_total', help: 'Estimated cost saved by batching (USD)' }),
};

function selfBaseUrl() {
  return process.env.GATEWAY_SELF_URL || `http://127.0.0.1:${process.env.PORT || 8080}`;
}

const batchExecutor = new BatchExecutor({
  metrics: batchMetrics,
  retryManager: retryManagers.batch,
  logger,
  cache: {
    get: (k) => (redis() ? redis().get(k) : Promise.resolve(null)),
    set: (k, v, ttl) => (redis() ? redis().set(k, v, 'EX', ttl) : Promise.resolve()),
  },
  async dispatch(sub, { signal, ctx }) {
    const headers = {
      accept: 'application/json',
      'x-batch-subrequest': '1',
      'x-request-id': `${ctx.requestId || 'batch'}-${sub.id}`.slice(0, 64).replace(/[^A-Za-z0-9._-]/g, '_'),
    };
    for (const h of ['authorization', 'accept-language', 'x-language', 'x-client-id', 'x-client-version', 'x-platform', 'user-agent']) {
      if (ctx.headers && ctx.headers[h]) headers[h] = ctx.headers[h];
    }
    if (ctx.clientIp) headers['x-forwarded-for'] = ctx.clientIp;
    for (const [k, v] of Object.entries(sub.headers || {})) {
      if (/^(if-none-match|x-idempotency-key|idempotency-key|accept-version)$/i.test(k)) headers[k.toLowerCase()] = String(v);
    }
    let body;
    if (sub.body !== undefined && sub.method !== 'GET') {
      body = JSON.stringify(sub.body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(selfBaseUrl() + sub.path, { method: sub.method, headers, body, signal });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text.slice(0, 500); }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: json };
  },
});

// ── REQ-00407：弃用接口剩余天数（Grafana "即将下线 API" 面板与告警用） ─────
const deprecationDaysGauge = metric(promClient.Gauge, { name: 'api_deprecation_days_remaining', help: 'Days until sunset for registered deprecated endpoints', labelNames: ['endpoint', 'method', 'successor'] });
function refreshDeprecationGauge() {
  try {
    deprecationDaysGauge.reset();
    for (const d of apiStd.deprecations.list()) {
      if (!d.sunsetAt || d.status === 'cancelled') continue;
      deprecationDaysGauge.set({ endpoint: d.endpoint, method: d.method, successor: d.successor || '' }, Math.ceil((new Date(d.sunsetAt).getTime() - Date.now()) / 86400000));
    }
  } catch { /* ignore */ }
}

// ── 启动 ────────────────────────────────────────────────────
let started = false;
async function start() {
  if (started) return;
  started = true;
  budgetManager.redis = redis();
  try {
    await apiStd.start();
    logger.info({ pipelines: apiStd.engine.list().length, contracts: apiStd.schemas.list().length }, 'API standards pipeline started');
  } catch (err) {
    logger.error({ err: err.message }, 'API standards start failed (pipeline continues with defaults)');
  }
  // 周期评估性能预算（百分位违规）；刷新弃用剩余天数指标
  refreshDeprecationGauge();
  const t = setInterval(() => { try { budgetManager.evaluate(); } catch { /* ignore */ } refreshDeprecationGauge(); }, 60000);
  if (t.unref) t.unref();
  // 弃用接口通知（每天一次，Redis 锁保证多实例只跑一次）
  const n = setInterval(() => { runDeprecationNotifier({ lock: true }).catch(() => {}); }, 6 * 3600 * 1000);
  if (n.unref) n.unref();
}

/**
 * REQ-00407：识别 30 天内下线、且仍被频繁调用的弃用接口，给对应用户发站内通知（notification_history）
 */
async function runDeprecationNotifier({ days = 30, minCalls = 5, lock = false } = {}) {
  if (lock && redis()) {
    const ok = await redis().set('apistd:deprecation-notifier:lock', String(process.pid), 'EX', 20 * 3600, 'NX').catch(() => null);
    if (!ok) return { skipped: 'locked' };
  }
  await apiStd.deprecations.flush();
  const { rows } = await query(
    `SELECT c.id, c.client_id, c.user_id, c.deprecated_call_count, d.id AS deprecation_id, d.method, d.endpoint, d.sunset_at, d.successor_endpoint
       FROM client_migration_status c JOIN api_deprecations d ON d.id = c.deprecation_id
      WHERE d.status = 'active' AND d.sunset_at <= NOW() + ($1 || ' days')::interval
        AND c.deprecated_call_count >= $2 AND c.migrated_at IS NULL
        AND (c.notification_sent_at IS NULL OR c.notification_sent_at < NOW() - INTERVAL '7 days')
      ORDER BY c.deprecated_call_count DESC LIMIT 500`, [String(days), minCalls]);
  let notified = 0, logged = 0;
  for (const r of rows) {
    const payload = { endpoint: `${r.method} ${r.endpoint}`, sunsetAt: r.sunset_at, successor: r.successor_endpoint, calls: r.deprecated_call_count, migrationGuide: `/api/deprecations/${r.deprecation_id}/migration-guide` };
    if (r.user_id) {
      await query(`INSERT INTO notification_history (user_id, type, data) VALUES ($1, 'api_deprecation', $2)`, [r.user_id, JSON.stringify(payload)]).catch(() => {});
      notified++;
    } else {
      logger.warn({ deprecationNotice: payload, clientId: r.client_id }, `客户端 ${r.client_id} 仍在调用即将下线的接口`);
      logged++;
    }
    await query('UPDATE client_migration_status SET notification_sent_at = NOW() WHERE id = $1', [r.id]).catch(() => {});
  }
  return { candidates: rows.length, notified, logged };
}

module.exports = {
  apiStd,
  versionRegistry,
  budgetManager,
  budgetConfig,
  perfBudgetMiddleware,
  compressionMiddleware,
  withProxyRetry,
  batchExecutor,
  retryManagers,
  retryRecorder,
  runDeprecationNotifier,
  refreshDeprecationGauge,
  start,
  query,
  redis,
  logger,
};
