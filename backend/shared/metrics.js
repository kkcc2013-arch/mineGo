// shared/metrics.js - Prometheus 指标模块
'use strict';
const promClient = require('prom-client');

// 收集默认指标（CPU、内存、事件循环延迟等）
promClient.collectDefaultMetrics({
  prefix: 'minego_',
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

// ============================================================
// HTTP 指标
// ============================================================
const httpRequestsTotal = new promClient.Counter({
  name: 'minego_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['service', 'method', 'path', 'status'],
});

const httpRequestDuration = new promClient.Histogram({
  name: 'minego_http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['service', 'method', 'path'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

const httpRequestsInProgress = new promClient.Gauge({
  name: 'minego_http_requests_in_progress',
  help: 'Number of HTTP requests currently in progress',
  labelNames: ['service', 'method', 'path'],
});

// ============================================================
// 数据库指标
// ============================================================
const dbQueryDuration = new promClient.Histogram({
  name: 'minego_db_query_duration_ms',
  help: 'Database query duration in milliseconds',
  labelNames: ['service', 'query_name'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
});

const dbConnectionsActive = new promClient.Gauge({
  name: 'minego_db_connections_active',
  help: 'Number of active database connections',
  labelNames: ['service'],
});

const dbQueryErrors = new promClient.Counter({
  name: 'minego_db_query_errors_total',
  help: 'Total number of database query errors',
  labelNames: ['service', 'query_name', 'error_type'],
});

// ============================================================
// Redis 缓存指标
// ============================================================
const cacheHitsTotal = new promClient.Counter({
  name: 'minego_cache_hits_total',
  help: 'Total cache hit/miss count',
  labelNames: ['service', 'cache_name', 'result'], // result: hit|miss
});

const cacheOperationDuration = new promClient.Histogram({
  name: 'minego_cache_operation_duration_ms',
  help: 'Cache operation duration in milliseconds',
  labelNames: ['service', 'cache_name', 'operation'],
  buckets: [0.5, 1, 2, 5, 10, 25, 50],
});

// ============================================================
// WebSocket 指标
// ============================================================
const websocketConnectionsActive = new promClient.Gauge({
  name: 'minego_websocket_connections_active',
  help: 'Number of active WebSocket connections',
  labelNames: ['service', 'room'],
});

const websocketMessagesTotal = new promClient.Counter({
  name: 'minego_websocket_messages_total',
  help: 'Total number of WebSocket messages',
  labelNames: ['service', 'direction', 'type'], // direction: in|out
});

// ============================================================
// 业务指标
// ============================================================
const catchAttemptsTotal = new promClient.Counter({
  name: 'minego_catch_attempts_total',
  help: 'Total number of catch attempts',
  labelNames: ['result'], // result: success|failed|escaped
});

const pokemonSpawnedTotal = new promClient.Counter({
  name: 'minego_pokemon_spawned_total',
  help: 'Total number of wild pokemon spawned',
  labelNames: ['rarity'],
});

const raidParticipantsActive = new promClient.Gauge({
  name: 'minego_raid_participants_active',
  help: 'Number of active raid participants',
  labelNames: ['raid_id'],
});

// ============================================================
// 行为分析指标 (REQ-00028)
// ============================================================
const behaviorAnomalyDetected = new promClient.Counter({
  name: 'minego_anticheat_behavior_anomaly_total',
  help: 'Behavior anomalies detected by type and severity',
  labelNames: ['type', 'severity'],
});

const behaviorScoreHistogram = new promClient.Histogram({
  name: 'minego_anticheat_behavior_score',
  help: 'User behavior score distribution',
  buckets: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
});

const multiAccountDeviceDetected = new promClient.Counter({
  name: 'minego_anticheat_multi_account_device_total',
  help: 'Multi-account on same device detected',
});

const analysisDurationHistogram = new promClient.Histogram({
  name: 'minego_anticheat_analysis_duration_seconds',
  help: 'Time spent on behavior analysis',
  labelNames: ['analysis_type'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

const lowTrustUserGauge = new promClient.Gauge({
  name: 'minego_anticheat_low_trust_users',
  help: 'Number of users with low trust score (<50)',
});

const deviceFingerprintTotal = new promClient.Counter({
  name: 'minego_anticheat_device_fingerprint_total',
  help: 'Total device fingerprints recorded',
});

const catchAttemptRecorded = new promClient.Counter({
  name: 'minego_anticheat_catch_attempt_recorded_total',
  help: 'Total catch attempts recorded for analysis',
  labelNames: ['rarity', 'success'],
});

// ============================================================
// Express 中间件：自动记录 HTTP 指标
// ============================================================
function httpMetricsMiddleware(serviceName) {
  return (req, res, next) => {
    // 排除 /health 和 /metrics 端点
    if (req.path === '/health' || req.path === '/metrics') {
      return next();
    }

    const path = req.route?.path || req.path;
    const labels = { service: serviceName, method: req.method, path };
    
    httpRequestsInProgress.inc(labels);
    const startTime = Date.now();
    
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      
      httpRequestsTotal.inc({ ...labels, status: res.statusCode });
      httpRequestDuration.observe(labels, duration);
      httpRequestsInProgress.dec(labels);
    });
    
    next();
  };
}

// ============================================================
// 辅助函数：记录缓存操作
// ============================================================
function recordCacheHit(service, cacheName) {
  cacheHitsTotal.inc({ service, cache_name: cacheName, result: 'hit' });
}

function recordCacheMiss(service, cacheName) {
  cacheHitsTotal.inc({ service, cache_name: cacheName, result: 'miss' });
}

async function timeCacheOperation(service, cacheName, operation, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    cacheOperationDuration.observe({ service, cache_name: cacheName, operation }, Date.now() - start);
    return result;
  } catch (error) {
    cacheOperationDuration.observe({ service, cache_name: cacheName, operation }, Date.now() - start);
    throw error;
  }
}

// ============================================================
// 辅助函数：记录数据库查询
// ============================================================
async function timeDbQuery(service, queryName, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    dbQueryDuration.observe({ service, query_name: queryName }, Date.now() - start);
    return result;
  } catch (error) {
    dbQueryErrors.inc({ service, query_name: queryName, error_type: error.code || 'unknown' });
    throw error;
  }
}

// ============================================================
// 导出所有指标和辅助函数
// ============================================================
module.exports = {
  // Prometheus registry
  register: promClient.register,
  
  // HTTP 指标
  httpRequestsTotal,
  httpRequestDuration,
  httpRequestsInProgress,
  httpMetricsMiddleware,
  
  // 数据库指标
  dbQueryDuration,
  dbConnectionsActive,
  dbQueryErrors,
  timeDbQuery,
  
  // 缓存指标
  cacheHitsTotal,
  cacheOperationDuration,
  recordCacheHit,
  recordCacheMiss,
  timeCacheOperation,
  
  // WebSocket 指标
  websocketConnectionsActive,
  websocketMessagesTotal,
  
  // 业务指标
  catchAttemptsTotal,
  pokemonSpawnedTotal,
  raidParticipantsActive,
  
  // 行为分析指标 (REQ-00028)
  behaviorAnomalyDetected,
  behaviorScoreHistogram,
  multiAccountDeviceDetected,
  analysisDurationHistogram,
  lowTrustUserGauge,
  deviceFingerprintTotal,
  catchAttemptRecorded,
  counters: {
    behaviorAnomalyDetected,
    multiAccountDeviceDetected,
    deviceFingerprintTotal,
    catchAttemptRecorded,
  },
  histograms: {
    behaviorScoreHistogram,
    analysisDurationHistogram,
  },
  gauges: {
    lowTrustUserGauge,
  },
  
  // 辅助函数
  promClient,
};
