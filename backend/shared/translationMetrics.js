'use strict';

/**
 * REQ-00398: 翻译系统 Prometheus 指标
 */

const client = require('prom-client');

// 注册指标到默认注册表
const register = client.register;

// 缓存命中计数器
const cacheHits = new client.Counter({
  name: 'translation_cache_hits_total',
  help: 'Total number of translation cache hits',
  labelNames: ['language']
});

// 缓存未命中计数器
const cacheMisses = new client.Counter({
  name: 'translation_cache_misses_total',
  help: 'Total number of translation cache misses',
  labelNames: ['language']
});

// 回退使用计数器
const fallbackUsed = new client.Counter({
  name: 'translation_fallback_used_total',
  help: 'Total number of fallback translations used',
  labelNames: ['error_code', 'requested_lang', 'fallback_lang']
});

// 缺失翻译数量
const missingTranslations = new client.Gauge({
  name: 'translation_missing_total',
  help: 'Number of missing translations',
  labelNames: ['severity']
});

// 翻译查询延迟直方图
const translationLatency = new client.Histogram({
  name: 'translation_lookup_duration_seconds',
  help: 'Time spent looking up translations',
  labelNames: ['source'],
  buckets: [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5]
});

// 翻译操作计数器
const translationOperations = new client.Counter({
  name: 'translation_operations_total',
  help: 'Total number of translation operations',
  labelNames: ['operation', 'status']
});

// 导入导出操作计数器
const importExportOperations = new client.Counter({
  name: 'translation_import_export_total',
  help: 'Total number of import/export operations',
  labelNames: ['type', 'format', 'status']
});

// 告警数量
const alertCounts = new client.Gauge({
  name: 'translation_alerts_total',
  help: 'Number of active translation alerts',
  labelNames: ['severity', 'acknowledged']
});

module.exports = {
  cacheHits,
  cacheMisses,
  fallbackUsed,
  missingTranslations,
  translationLatency,
  translationOperations,
  importExportOperations,
  alertCounts,
  register
};