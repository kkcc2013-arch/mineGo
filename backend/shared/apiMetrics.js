/**
 * REQ-00044: API 版本管理 Prometheus 指标
 */

'use strict';

const promClient = require('prom-client');

// 版本使用计数器
const versionUsageCounter = new promClient.Counter({
  name: 'api_version_usage_total',
  help: 'Total API requests by version',
  labelNames: ['version', 'endpoint']
});

// 废弃版本使用计数器
const versionDeprecationCounter = new promClient.Counter({
  name: 'api_version_deprecated_usage_total',
  help: 'Deprecated API version usage count',
  labelNames: ['version', 'endpoint']
});

// 版本分布直方图
const versionDistributionGauge = new promClient.Gauge({
  name: 'api_version_distribution',
  help: 'Current API version distribution',
  labelNames: ['version']
});

// 废弃告警计数
const deprecationWarningCounter = new promClient.Counter({
  name: 'api_deprecation_warning_total',
  help: 'Deprecation warnings sent',
  labelNames: ['version']
});

module.exports = {
  versionUsageCounter,
  versionDeprecationCounter,
  versionDistributionGauge,
  deprecationWarningCounter
};
