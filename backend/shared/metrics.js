// shared/metrics.js - Prometheus 指标模块
'use strict';
const promClient = require('prom-client');

// Cluster 模式支持：为每个进程创建独立的 Registry
// 这解决了 PM2 cluster 模式下多进程共享全局 registry 导致的重复注册问题
const registry = new promClient.Registry();

// 收集默认指标（CPU、内存、事件循环延迟等）
promClient.collectDefaultMetrics({
  register: registry,
  prefix: 'minego_',
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

// 辅助函数：安全创建 metric（避免重复注册）
// 注意：prom-client 构造选项是 registers（数组）。曾误写为 register: registry，
// 该字段被静默忽略，全部业务指标落入全局默认 registry，/metrics 端点一个业务指标都不暴露。
function safeCounter(options) {
  return new promClient.Counter({ ...options, registers: [registry] });
}
function safeGauge(options) {
  return new promClient.Gauge({ ...options, registers: [registry] });
}
function safeHistogram(options) {
  return new promClient.Histogram({ ...options, registers: [registry] });
}

// ============================================================
// HTTP 指标
// ============================================================
const httpRequestsTotal = safeCounter({
  name: 'minego_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['service', 'method', 'path', 'status'],
});

const httpRequestDuration = safeHistogram({
  name: 'minego_http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['service', 'method', 'path'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

const httpRequestsInProgress = safeGauge({
  name: 'minego_http_requests_in_progress',
  help: 'Number of HTTP requests currently in progress',
  labelNames: ['service', 'method', 'path'],
});

// ============================================================
// 数据库指标
// ============================================================
const dbQueryDuration = safeHistogram({
  name: 'minego_db_query_duration_ms',
  help: 'Database query duration in milliseconds',
  labelNames: ['service', 'query_name'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
});

const dbConnectionsActive = safeGauge({
  name: 'minego_db_connections_active',
  help: 'Number of active database connections',
  labelNames: ['service'],
});

const dbQueryErrors = safeCounter({
  name: 'minego_db_query_errors_total',
  help: 'Total number of database query errors',
  labelNames: ['service', 'query_name', 'error_type'],
});

// ============================================================
// Redis 缓存指标
// ============================================================
const cacheHitsTotal = safeCounter({
  name: 'minego_cache_hits_total',
  help: 'Total cache hit/miss count',
  labelNames: ['service', 'cache_name', 'result'], // result: hit|miss
});

const cacheOperationDuration = safeHistogram({
  name: 'minego_cache_operation_duration_ms',
  help: 'Cache operation duration in milliseconds',
  labelNames: ['service', 'cache_name', 'operation'],
  buckets: [0.5, 1, 2, 5, 10, 25, 50],
});

// REQ-00031: API 响应缓存层指标
const cacheMissesTotal = safeCounter({
  name: 'minego_cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['layer'], // layer: memory, redis
});

const cacheLatency = safeHistogram({
  name: 'minego_cache_latency_seconds',
  help: 'Cache operation latency in seconds',
  labelNames: ['operation', 'layer'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
});

// ============================================================
// REQ-00070: Redis 内存优化指标
// ============================================================
const redisMemoryUsed = safeGauge({
  name: 'minego_redis_memory_used_bytes',
  help: 'Redis used memory in bytes',
  labelNames: ['service'],
});

const redisMemoryMax = safeGauge({
  name: 'minego_redis_memory_max_bytes',
  help: 'Redis max memory limit in bytes',
  labelNames: ['service'],
});

const redisMemoryUsagePercent = safeGauge({
  name: 'minego_redis_memory_usage_percent',
  help: 'Redis memory usage percentage',
  labelNames: ['service'],
});

const redisMemoryFragmentationRatio = safeGauge({
  name: 'minego_redis_memory_fragmentation_ratio',
  help: 'Redis memory fragmentation ratio',
  labelNames: ['service'],
});

const redisKeyCount = safeGauge({
  name: 'minego_redis_key_count',
  help: 'Redis key count',
  labelNames: ['service', 'type'], // type: total, string, hash, list, set, zset
});

const redisKeysWithoutTTL = safeGauge({
  name: 'minego_redis_keys_without_ttl',
  help: 'Number of Redis keys without TTL',
  labelNames: ['service'],
});

const redisKeysTTLBucket = safeGauge({
  name: 'minego_redis_keys_ttl_bucket',
  help: 'Redis keys TTL distribution by bucket',
  labelNames: ['service', 'bucket'], // bucket: no_ttl, <1m, 1m-5m, etc.
});

const redisCleanupRunsTotal = safeCounter({
  name: 'minego_redis_cleanup_runs_total',
  help: 'Total number of Redis cleanup runs',
  labelNames: ['service'],
});

const redisCleanupKeysTotal = safeCounter({
  name: 'minego_redis_cleanup_keys_total',
  help: 'Total number of Redis keys cleaned up',
  labelNames: ['service'],
});

const redisCleanupMemoryFreedBytes = safeCounter({
  name: 'minego_redis_cleanup_memory_freed_bytes_total',
  help: 'Total Redis memory freed in bytes by cleanup',
  labelNames: ['service'],
});

const redisCleanupErrorsTotal = safeCounter({
  name: 'minego_redis_cleanup_errors_total',
  help: 'Total Redis cleanup errors',
  labelNames: ['service'],
});

const redisDefragTotal = safeCounter({
  name: 'minego_redis_defrag_total',
  help: 'Total Redis defragmentation operations',
  labelNames: ['service'],
});

const cacheKeysWithoutTTL = safeCounter({
  name: 'minego_cache_keys_without_ttl_total',
  help: 'Cache keys set without TTL (warning)',
  labelNames: ['service', 'key_prefix'],
});

const cacheSize = safeGauge({
  name: 'minego_cache_size_bytes',
  help: 'Current cache size in bytes',
  labelNames: ['layer'], // layer: memory, redis
});

const cacheKeysTotal = safeGauge({
  name: 'minego_cache_keys_total',
  help: 'Total number of keys in cache',
  labelNames: ['layer'],
});

const cacheInvalidationsTotal = safeCounter({
  name: 'minego_cache_invalidations_total',
  help: 'Total cache invalidations',
  labelNames: ['event', 'pattern'],
});

// ============================================================
// WebSocket 指标
// ============================================================
const websocketConnectionsActive = safeGauge({
  name: 'minego_websocket_connections_active',
  help: 'Number of active WebSocket connections',
  labelNames: ['service', 'room'],
});

const websocketMessagesTotal = safeCounter({
  name: 'minego_websocket_messages_total',
  help: 'Total number of WebSocket messages',
  labelNames: ['service', 'direction', 'type'], // direction: in|out
});

// ============================================================
// REQ-00080: API Schema 验证指标
// ============================================================
const apiValidationErrors = safeCounter({
  name: 'minego_api_validation_errors_total',
  help: 'API 验证错误总数',
  labelNames: ['service', 'operationId', 'type'], // type: request | response
});

const apiValidationDuration = safeHistogram({
  name: 'minego_api_validation_duration_seconds',
  help: 'API 验证耗时',
  labelNames: ['service', 'operationId', 'type'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
});

const schemaLoadErrors = safeCounter({
  name: 'minego_schema_load_errors_total',
  help: 'Schema 加载错误总数',
  labelNames: ['version', 'error'],
});

const apiSchemaConsistencyIssues = safeGauge({
  name: 'minego_api_schema_consistency_issues',
  help: 'API Schema 一致性问题数量',
  labelNames: ['type', 'severity'], // type: missing_schema | missing_route | param_mismatch
});

// ============================================================
// 业务指标
// ============================================================
const catchAttemptsTotal = safeCounter({
  name: 'minego_catch_attempts_total',
  help: 'Total number of catch attempts',
  labelNames: ['result'], // result: success|failed|escaped
});

const pokemonSpawnedTotal = safeCounter({
  name: 'minego_pokemon_spawned_total',
  help: 'Total number of wild pokemon spawned',
  labelNames: ['rarity'],
});

const raidParticipantsActive = safeGauge({
  name: 'minego_raid_participants_active',
  help: 'Number of active raid participants',
  labelNames: ['raid_id'],
});

// ============================================================
// 行为分析指标 (REQ-00028)
// ============================================================
const behaviorAnomalyDetected = safeCounter({
  name: 'minego_anticheat_behavior_anomaly_total',
  help: 'Behavior anomalies detected by type and severity',
  labelNames: ['type', 'severity'],
});

const behaviorScoreHistogram = safeHistogram({
  name: 'minego_anticheat_behavior_score',
  help: 'User behavior score distribution',
  buckets: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
});

const multiAccountDeviceDetected = safeCounter({
  name: 'minego_anticheat_multi_account_device_total',
  help: 'Multi-account on same device detected',
});

const analysisDurationHistogram = safeHistogram({
  name: 'minego_anticheat_analysis_duration_seconds',
  help: 'Time spent on behavior analysis',
  labelNames: ['analysis_type'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

const lowTrustUserGauge = safeGauge({
  name: 'minego_anticheat_low_trust_users',
  help: 'Number of users with low trust score (<50)',
});

const deviceFingerprintTotal = safeCounter({
  name: 'minego_anticheat_device_fingerprint_total',
  help: 'Total device fingerprints recorded',
});

const catchAttemptRecorded = safeCounter({
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
// 延迟队列指标 (REQ-00043)
// ============================================================
const delayQueueTasksScheduled = safeCounter({
  name: 'minego_delay_queue_tasks_scheduled_total',
  help: 'Total number of tasks scheduled in delay queue',
  labelNames: ['task_type', 'priority', 'delay_bucket'],
});

const delayQueueTasksStarted = safeCounter({
  name: 'minego_delay_queue_tasks_started_total',
  help: 'Total number of tasks started processing',
  labelNames: ['task_type'],
});

const delayQueueTasksCompleted = safeCounter({
  name: 'minego_delay_queue_tasks_completed_total',
  help: 'Total number of tasks completed successfully',
  labelNames: ['task_type'],
});

const delayQueueTasksRetried = safeCounter({
  name: 'minego_delay_queue_tasks_retried_total',
  help: 'Total number of task retries',
  labelNames: ['task_type', 'retry_attempt'],
});

const delayQueueTasksDeadLetter = safeCounter({
  name: 'minego_delay_queue_tasks_dead_letter_total',
  help: 'Total number of tasks sent to dead letter queue',
  labelNames: ['task_type'],
});

const delayQueueTaskDuration = safeHistogram({
  name: 'minego_delay_queue_task_duration_seconds',
  help: 'Duration of task execution in seconds',
  labelNames: ['task_type', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
});

const delayQueueBucketSize = safeGauge({
  name: 'minego_delay_queue_bucket_size',
  help: 'Current number of tasks in delay bucket',
  labelNames: ['bucket'],
});

const delayQueueDlqSize = safeGauge({
  name: 'minego_delay_queue_dlq_size',
  help: 'Current number of tasks in dead letter queue',
});

const delayQueueDlqMessages = safeCounter({
  name: 'minego_delay_queue_dlq_messages_total',
  help: 'Total DLQ messages received',
  labelNames: ['task_type'],
});

const delayQueueDlqAlerts = safeCounter({
  name: 'minego_delay_queue_dlq_alerts_sent_total',
  help: 'Total DLQ alerts sent',
  labelNames: ['task_type'],
});

const delayQueueDlqAutoRetried = safeCounter({
  name: 'minego_delay_queue_dlq_auto_retried_total',
  help: 'Total DLQ tasks auto-retried',
  labelNames: ['task_type'],
});

const delayBucketTasksMoved = safeCounter({
  name: 'minego_delay_bucket_tasks_moved_total',
  help: 'Total tasks moved from delay bucket to ready queue',
  labelNames: ['bucket', 'task_type'],
});

const delayBucketTasksRebucketed = safeCounter({
  name: 'minego_delay_bucket_tasks_rebucketed_total',
  help: 'Total tasks re-bucketed',
  labelNames: ['from_bucket', 'to_bucket'],
});

const delayQueueHealthScore = safeGauge({
  name: 'minego_delay_queue_health_score',
  help: 'Delay queue health score (0-100)',
});

// ============================================================
// 插件系统指标 (REQ-00050)
// ============================================================
const pluginLoadCount = safeCounter({
  name: 'minego_plugin_load_total',
  help: 'Total plugin load attempts',
  labelNames: ['status'],
});

const pluginRequestCount = safeCounter({
  name: 'minego_plugin_requests_total',
  help: 'Total plugin middleware requests',
  labelNames: ['plugin', 'status'],
});

const pluginLatency = safeHistogram({
  name: 'minego_plugin_latency_seconds',
  help: 'Plugin middleware latency in seconds',
  labelNames: ['plugin'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
});

const pluginHealthStatus = safeGauge({
  name: 'minego_plugin_health_status',
  help: 'Plugin health status (1=healthy, 0=unhealthy, 0.5=degraded)',
  labelNames: ['plugin'],
});

// ============================================================
// CAPTCHA 指标 (REQ-00064)
// ============================================================
const captchaTriggersTotal = safeCounter({
  name: 'minego_captcha_triggers_total',
  help: 'Total captcha triggers by reason and difficulty',
  labelNames: ['reason', 'difficulty'],
});

const captchaResultsTotal = safeCounter({
  name: 'minego_captcha_results_total',
  help: 'Total captcha results by type and status',
  labelNames: ['type', 'status'], // status: passed, failed, expired
});

const captchaResponseTime = safeHistogram({
  name: 'minego_captcha_response_time_seconds',
  help: 'Captcha response time distribution',
  labelNames: ['type', 'difficulty'],
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
});

const captchaPassRate = safeGauge({
  name: 'minego_captcha_pass_rate',
  help: 'Current captcha pass rate',
});

const captchaActiveSessions = safeGauge({
  name: 'minego_captcha_active_sessions',
  help: 'Current active captcha sessions',
});

const captchaAccountFrozen = safeCounter({
  name: 'minego_captcha_account_frozen_total',
  help: 'Total accounts frozen due to captcha failures',
});

// ============================================================
// 隐私偏好管理指标 (REQ-00053)
// ============================================================
const privacyPreferenceChanges = safeCounter({
  name: 'minego_privacy_preference_changes_total',
  help: 'Total privacy preference changes',
  labelNames: ['category', 'action'], // action: enable | disable
});

const dataExportRequests = safeCounter({
  name: 'minego_data_export_requests_total',
  help: 'Total data export requests',
  labelNames: ['status'], // status: success | failed
});

const policyViews = safeCounter({
  name: 'minego_privacy_policy_views_total',
  help: 'Total privacy policy views',
  labelNames: ['version', 'language'],
});

const transparencyReportsGenerated = safeCounter({
  name: 'minego_transparency_reports_generated_total',
  help: 'Total transparency reports generated',
});

const privacyPolicyAcceptances = safeCounter({
  name: 'minego_privacy_policy_acceptances_total',
  help: 'Total privacy policy acceptances',
  labelNames: ['version'],
});

const dataAccessLogsCount = safeCounter({
  name: 'minego_data_access_logs_total',
  help: 'Total data access logs recorded',
  labelNames: ['category', 'action'],
});

// ============================================================
// 导出所有指标和辅助函数
// ============================================================
module.exports = {
  // Prometheus registry (独立注册表，支持 cluster 模式)
  register: registry,
  
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
  cacheMissesTotal,
  cacheLatency,
  cacheSize,
  cacheKeysTotal,
  cacheInvalidationsTotal,
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
  
  // 延迟队列指标 (REQ-00043)
  delayQueueTasksScheduled,
  delayQueueTasksStarted,
  delayQueueTasksCompleted,
  delayQueueTasksRetried,
  delayQueueTasksDeadLetter,
  delayQueueTaskDuration,
  delayQueueBucketSize,
  delayQueueDlqSize,
  delayQueueDlqMessages,
  delayQueueDlqAlerts,
  delayQueueDlqAutoRetried,
  delayBucketTasksMoved,
  delayBucketTasksRebucketed,
  delayQueueHealthScore,
  
  // 插件系统指标 (REQ-00050)
  pluginLoadCount,
  pluginRequestCount,
  pluginLatency,
  pluginHealthStatus,
  
  // 插件系统指标 (REQ-00050)
  pluginLoadCount,
  pluginRequestCount,
  pluginLatency,
  pluginHealthStatus,
  
  // CAPTCHA 指标 (REQ-00064)
  captchaTriggersTotal,
  captchaResultsTotal,
  captchaResponseTime,
  captchaPassRate,
  captchaActiveSessions,
  captchaAccountFrozen,
  
  // API Schema 验证指标 (REQ-00080)
  apiValidationErrors,
  apiValidationDuration,
  schemaLoadErrors,
  apiSchemaConsistencyIssues,
  
  // 隐私偏好管理指标 (REQ-00053)
  privacyPreferenceChanges,
  dataExportRequests,
  policyViews,
  transparencyReportsGenerated,
  privacyPolicyAcceptances,
  dataAccessLogsCount,

  // 辅助函数
  promClient,
};
