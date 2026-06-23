# REQ-00296: SLO 错误预算管理与自动降级系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00296 |
| 标题 | SLO 错误预算管理与自动降级系统 |
| 类别 | 稳定性/高可用 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway, 所有微服务, backend/shared/slo, backend/shared/middleware, monitoring, Prometheus, Grafana |
| 创建时间 | 2026-06-23 12:00 |

## 需求描述

建立完整的 SLO（服务级别目标）错误预算管理系统，实现：
1. **SLO 定义与跟踪**：支持多层级 SLO（服务级、接口级、功能级）
2. **错误预算计算**：实时计算错误预算消耗，预测预算耗尽时间
3. **自动降级触发**：当错误预算低于阈值时自动触发降级策略
4. **预算恢复策略**：系统恢复后自动解除降级状态
5. **可视化管理**：提供 Grafana 仪表盘展示 SLO 状态和错误预算

### 背景

当前系统虽然具备熔断、降级、限流能力，但缺乏基于 SLO 的统一管理机制：
- 无法基于业务重要性制定 SLO
- 错误预算消耗缺乏可视化
- 降级决策依赖人工干预
- 缺少预算耗尽前的预警机制

### 目标

- 实现 SLO 驱动的自动化降级
- 错误预算可视化与预警
- 提升系统整体稳定性评分至 15/15

## 技术方案

### 1. SLO 定义引擎

```javascript
// backend/shared/slo/SLODefinitionEngine.js
class SLODefinitionEngine {
  constructor() {
    this.slos = new Map(); // SLO 定义存储
    this.sliCollectors = new Map(); // SLI 收集器
  }

  /**
   * 定义服务级别目标
   * @param {Object} slo - SLO 定义
   */
  defineSLO(slo) {
    const {
      id,                    // SLO 标识
      service,               // 服务名称
      target,                // 目标值 (如 99.9%)
      window,                // 时间窗口 (如 '30d')
      sliType,               // SLI 类型: availability, latency, throughput
      thresholds: {
        warning,             // 警告阈值 (如 95% 预算剩余)
        critical,            // 临界阈值 (如 50% 预算剩余)
        exhausted            // 耗尽阈值 (如 10% 预算剩余)
      },
      degradations: {        // 降级策略
        warning: [],         // 警告级别降级措施
        critical: [],        // 临界级别降级措施
        exhausted: []        // 耗尽级别降级措施
      },
      metadata: {
        priority,            // 业务优先级
        owner,               // 责任人
        description          // 描述
      }
    } = slo;

    this.slos.set(id, {
      ...slo,
      createdAt: Date.now(),
      status: 'active'
    });

    // 初始化错误预算
    this.initializeBudget(id);
    
    return this.slos.get(id);
  }

  /**
   * 初始化错误预算
   */
  initializeBudget(sloId) {
    const slo = this.slos.get(sloId);
    const windowMs = this.parseWindow(slo.window);
    
    // 计算初始错误预算
    const totalBudget = this.calculateTotalBudget(slo.target, windowMs);
    
    this.slos.get(sloId).budget = {
      total: totalBudget,
      remaining: totalBudget,
      consumed: 0,
      burnRate: 0,
      lastUpdated: Date.now()
    };
  }

  /**
   * 计算总错误预算
   * @param {number} target - 目标可用性 (如 99.9)
   * @param {number} windowMs - 时间窗口（毫秒）
   */
  calculateTotalBudget(target, windowMs) {
    const errorRate = (100 - target) / 100; // 错误率
    const windowSeconds = windowMs / 1000;
    
    // 错误预算 = 时间窗口 × (1 - 目标可用性)
    return Math.floor(windowSeconds * errorRate);
  }

  /**
   * 解析时间窗口
   */
  parseWindow(window) {
    const units = {
      's': 1000,
      'm': 60 * 1000,
      'h': 60 * 60 * 1000,
      'd': 24 * 60 * 60 * 1000,
      'w': 7 * 24 * 60 * 60 * 1000
    };

    const match = window.match(/^(\d+)([smhdw])$/);
    if (!match) throw new Error(`Invalid window format: ${window}`);

    const [, value, unit] = match;
    return parseInt(value) * units[unit];
  }

  /**
   * 批量定义 SLO
   */
  defineSLOs(sloDefinitions) {
    return sloDefinitions.map(slo => this.defineSLO(slo));
  }
}

module.exports = SLODefinitionEngine;
```

### 2. 错误预算计算器

```javascript
// backend/shared/slo/ErrorBudgetCalculator.js
class ErrorBudgetCalculator {
  constructor(sloDefinitionEngine, prometheusClient) {
    this.sloEngine = sloDefinitionEngine;
    this.prometheus = prometheusClient;
    this.budgetHistory = new Map(); // 预算历史记录
  }

  /**
   * 更新错误预算
   * @param {string} sloId - SLO 标识
   * @param {number} errorCount - 错误数量
   */
  async updateBudget(sloId, errorCount) {
    const slo = this.sloEngine.slos.get(sloId);
    if (!slo) throw new Error(`SLO not found: ${sloId}`);

    const budget = slo.budget;
    
    // 更新预算消耗
    budget.consumed += errorCount;
    budget.remaining = Math.max(0, budget.total - budget.consumed);
    budget.lastUpdated = Date.now();

    // 计算燃烧率
    budget.burnRate = await this.calculateBurnRate(sloId);

    // 保存历史记录
    this.saveBudgetHistory(sloId, budget);

    // 检查是否需要触发降级
    await this.checkDegradationTriggers(sloId);

    return budget;
  }

  /**
   * 计算燃烧率
   */
  async calculateBurnRate(sloId) {
    const slo = this.sloEngine.slos.get(sloId);
    const windowMs = this.sloEngine.parseWindow(slo.window);
    
    // 查询过去 1 小时的错误率
    const oneHourAgo = Date.now() - 3600000;
    const history = this.budgetHistory.get(sloId) || [];
    const recentHistory = history.filter(h => h.timestamp >= oneHourAgo);

    if (recentHistory.length === 0) return 0;

    // 计算平均燃烧率
    const consumedInHour = recentHistory.reduce((sum, h) => {
      const prev = recentHistory[recentHistory.indexOf(h) - 1];
      return sum + (prev ? h.consumed - prev.consumed : 0);
    }, 0);

    // 标准化到整个时间窗口
    const windowHours = windowMs / 3600000;
    return (consumedInHour * windowHours) / slo.budget.total;
  }

  /**
   * 预测预算耗尽时间
   */
  predictExhaustionTime(sloId) {
    const slo = this.sloEngine.slos.get(sloId);
    const budget = slo.budget;

    if (budget.burnRate === 0) return null;

    const hoursRemaining = budget.remaining / (budget.burnRate * budget.total / 24);
    return {
      hoursRemaining,
      estimatedExhaustion: new Date(Date.now() + hoursRemaining * 3600000)
    };
  }

  /**
   * 保存预算历史
   */
  saveBudgetHistory(sloId, budget) {
    if (!this.budgetHistory.has(sloId)) {
      this.budgetHistory.set(sloId, []);
    }

    const history = this.budgetHistory.get(sloId);
    history.push({
      timestamp: Date.now(),
      remaining: budget.remaining,
      consumed: budget.consumed,
      burnRate: budget.burnRate
    });

    // 保留最近 30 天的历史
    const thirtyDaysAgo = Date.now() - 30 * 24 * 3600000;
    this.budgetHistory.set(sloId, 
      history.filter(h => h.timestamp >= thirtyDaysAgo)
    );
  }

  /**
   * 检查降级触发条件
   */
  async checkDegradationTriggers(sloId) {
    const slo = this.sloEngine.slos.get(sloId);
    const budget = slo.budget;
    const budgetPercentage = (budget.remaining / budget.total) * 100;

    // 确定当前状态
    let newState = 'healthy';
    if (budgetPercentage <= slo.thresholds.exhausted) {
      newState = 'exhausted';
    } else if (budgetPercentage <= slo.thresholds.critical) {
      newState = 'critical';
    } else if (budgetPercentage <= slo.thresholds.warning) {
      newState = 'warning';
    }

    // 状态变化时触发降级
    if (slo.currentState !== newState) {
      await this.triggerDegradation(sloId, newState);
      slo.currentState = newState;
    }
  }

  /**
   * 触发降级
   */
  async triggerDegradation(sloId, state) {
    const slo = this.sloEngine.slos.get(sloId);
    const degradations = slo.degradations[state] || [];

    console.log(`SLO ${sloId} entering ${state} state, triggering ${degradations.length} degradations`);

    for (const degradation of degradations) {
      await this.executeDegradation(slo.service, degradation);
    }
  }

  /**
   * 执行降级措施
   */
  async executeDegradation(service, degradation) {
    const { type, config } = degradation;

    switch (type) {
      case 'rate_limit':
        await this.applyRateLimit(service, config);
        break;
      case 'feature_disable':
        await this.disableFeature(service, config.feature);
        break;
      case 'circuit_breaker':
        await this.triggerCircuitBreaker(service, config);
        break;
      case 'fallback':
        await this.enableFallback(service, config);
        break;
      case 'scale_down':
        await this.scaleDown(service, config);
        break;
      default:
        console.warn(`Unknown degradation type: ${type}`);
    }
  }
}

module.exports = ErrorBudgetCalculator;
```

### 3. SLI 收集器

```javascript
// backend/shared/slo/SLICollector.js
class SLICollector {
  constructor(prometheusClient) {
    this.prometheus = prometheusClient;
    this.collectors = {
      availability: this.collectAvailabilitySLI.bind(this),
      latency: this.collectLatencySLI.bind(this),
      throughput: this.collectThroughputSLI.bind(this)
    };
  }

  /**
   * 收集可用性 SLI
   */
  async collectAvailabilitySLI(service, timeRange) {
    const query = `
      sum(rate(http_requests_total{service="${service}",status!~"5.."}[${timeRange}]))
      /
      sum(rate(http_requests_total{service="${service}"}[${timeRange}]))
    `;

    const result = await this.prometheus.query(query);
    return result * 100; // 转换为百分比
  }

  /**
   * 收集延迟 SLI
   */
  async collectLatencySLI(service, timeRange, threshold = 200) {
    const query = `
      sum(rate(http_request_duration_seconds_bucket{service="${service}",le="${threshold/1000}"}[${timeRange}]))
      /
      sum(rate(http_request_duration_seconds_count{service="${service}"}[${timeRange}]))
    `;

    const result = await this.prometheus.query(query);
    return result * 100; // 转换为百分比
  }

  /**
   * 收集吞吐量 SLI
   */
  async collectThroughputSLI(service, timeRange) {
    const query = `sum(rate(http_requests_total{service="${service}"}[${timeRange}]))`;
    const result = await this.prometheus.query(query);
    return result; // 请求/秒
  }

  /**
   * 批量收集 SLI
   */
  async collectAllSLIs(service, sloDefinitions) {
    const results = {};

    for (const slo of sloDefinitions) {
      const collector = this.collectors[slo.sliType];
      if (collector) {
        results[slo.id] = await collector(service, slo.window);
      }
    }

    return results;
  }
}

module.exports = SLICollector;
```

### 4. 自动降级管理器

```javascript
// backend/shared/slo/AutoDegradationManager.js
const CircuitBreaker = require('../circuit-breaker');
const RateLimiter = require('../rate-limiter');

class AutoDegradationManager {
  constructor() {
    this.activeDegradations = new Map(); // 当前活跃的降级措施
    this.degradationHistory = [];
  }

  /**
   * 应用限流
   */
  async applyRateLimit(service, config) {
    const { rate, burst } = config;
    const key = `ratelimit:${service}`;

    const limiter = new RateLimiter({
      windowMs: 60000,
      max: rate,
      skipFailedRequests: false
    });

    this.activeDegradations.set(key, {
      type: 'rate_limit',
      service,
      config,
      appliedAt: Date.now(),
      limiter
    });

    console.log(`Applied rate limit to ${service}: ${rate} req/min`);
  }

  /**
   * 禁用功能
   */
  async disableFeature(service, feature) {
    const key = `feature:${service}:${feature}`;

    this.activeDegradations.set(key, {
      type: 'feature_disable',
      service,
      feature,
      appliedAt: Date.now()
    });

    console.log(`Disabled feature ${feature} for ${service}`);
  }

  /**
   * 触发熔断器
   */
  async triggerCircuitBreaker(service, config) {
    const key = `circuit:${service}`;
    const { threshold, timeout } = config;

    const breaker = new CircuitBreaker({
      failureThreshold: threshold,
      resetTimeout: timeout
    });

    this.activeDegradations.set(key, {
      type: 'circuit_breaker',
      service,
      config,
      appliedAt: Date.now(),
      breaker
    });

    console.log(`Triggered circuit breaker for ${service}`);
  }

  /**
   * 启用降级响应
   */
  async enableFallback(service, config) {
    const key = `fallback:${service}`;

    this.activeDegradations.set(key, {
      type: 'fallback',
      service,
      config,
      appliedAt: Date.now()
    });

    console.log(`Enabled fallback for ${service}`);
  }

  /**
   * 缩减资源
   */
  async scaleDown(service, config) {
    const key = `scale:${service}`;
    const { replicas, reason } = config;

    // 调用 Kubernetes API 缩减副本
    // await k8sApi.patchNamespacedDeployment(...);

    this.activeDegradations.set(key, {
      type: 'scale_down',
      service,
      config,
      appliedAt: Date.now()
    });

    console.log(`Scaled down ${service} to ${replicas} replicas`);
  }

  /**
   * 撤销降级措施
   */
  async revokeDegradation(key) {
    const degradation = this.activeDegradations.get(key);
    if (!degradation) return;

    // 记录到历史
    this.degradationHistory.push({
      ...degradation,
      revokedAt: Date.now()
    });

    // 移除活跃降级
    this.activeDegradations.delete(key);

    console.log(`Revoked degradation: ${key}`);
  }

  /**
   * 检查服务是否降级
   */
  isServiceDegraded(service) {
    for (const [key, degradation] of this.activeDegradations) {
      if (degradation.service === service) {
        return true;
      }
    }
    return false;
  }

  /**
   * 获取所有活跃降级
   */
  getActiveDegradations() {
    return Array.from(this.activeDegradations.entries()).map(([key, value]) => ({
      key,
      ...value
    }));
  }
}

module.exports = AutoDegradationManager;
```

### 5. SLO 中间件

```javascript
// backend/shared/middleware/sloMiddleware.js
function sloMiddleware(sloEngine, budgetCalculator) {
  return async (req, res, next) => {
    // 获取服务对应的 SLO
    const serviceSLOs = Array.from(sloEngine.slos.values())
      .filter(slo => slo.service === req.serviceName);

    if (serviceSLOs.length === 0) {
      return next();
    }

    // 检查是否有降级措施
    const degradedSLOs = serviceSLOs.filter(slo => 
      slo.currentState && slo.currentState !== 'healthy'
    );

    // 如果有耗尽状态的 SLO，返回降级响应
    const exhaustedSLO = degradedSLOs.find(slo => slo.currentState === 'exhausted');
    if (exhaustedSLO) {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        reason: 'SLO error budget exhausted',
        retryAfter: 60
      });
    }

    // 包装响应以记录错误
    const originalEnd = res.end;
    res.end = function(...args) {
      // 记录响应状态
      const isError = res.statusCode >= 500;
      
      if (isError) {
        serviceSLOs.forEach(async slo => {
          await budgetCalculator.updateBudget(slo.id, 1);
        });
      }

      originalEnd.apply(res, args);
    };

    next();
  };
}

module.exports = sloMiddleware;
```

### 6. Prometheus 指标导出

```javascript
// backend/shared/slo/SLOMetricsExporter.js
const { Counter, Gauge, Histogram } = require('prom-client');

class SLOMetricsExporter {
  constructor() {
    // 错误预算指标
    this.errorBudgetRemaining = new Gauge({
      name: 'slo_error_budget_remaining_seconds',
      help: 'Remaining error budget in seconds',
      labelNames: ['slo_id', 'service', 'sli_type']
    });

    this.errorBudgetConsumed = new Counter({
      name: 'slo_error_budget_consumed_seconds_total',
      help: 'Total consumed error budget in seconds',
      labelNames: ['slo_id', 'service', 'sli_type']
    });

    this.errorBudgetBurnRate = new Gauge({
      name: 'slo_error_budget_burn_rate',
      help: 'Error budget burn rate',
      labelNames: ['slo_id', 'service', 'sli_type']
    });

    this.sloStatus = new Gauge({
      name: 'slo_status',
      help: 'SLO status: 0=healthy, 1=warning, 2=critical, 3=exhausted',
      labelNames: ['slo_id', 'service']
    });

    this.degradationCount = new Counter({
      name: 'slo_degradation_triggered_total',
      help: 'Total number of degradation triggers',
      labelNames: ['slo_id', 'service', 'state', 'type']
    });
  }

  /**
   * 导出 SLO 指标
   */
  exportMetrics(slos) {
    for (const [id, slo] of slos) {
      const labels = {
        slo_id: id,
        service: slo.service,
        sli_type: slo.sliType
      };

      // 导出预算指标
      this.errorBudgetRemaining.set(labels, slo.budget.remaining);
      this.errorBudgetConsumed.inc(labels, slo.budget.consumed);
      this.errorBudgetBurnRate.set(labels, slo.budget.burnRate);

      // 导出状态
      const statusMap = { healthy: 0, warning: 1, critical: 2, exhausted: 3 };
      this.sloStatus.set(
        { slo_id: id, service: slo.service },
        statusMap[slo.currentState || 'healthy']
      );
    }
  }

  /**
   * 记录降级触发
   */
  recordDegradation(sloId, service, state, type) {
    this.degradationCount.inc(
      { slo_id: sloId, service, state, type },
      1
    );
  }
}

module.exports = SLOMetricsExporter;
```

### 7. 预设 SLO 定义

```javascript
// backend/shared/slo/presetSLOs.js
const presetSLOs = [
  {
    id: 'pokemon-service-availability',
    service: 'pokemon-service',
    target: 99.9,
    window: '30d',
    sliType: 'availability',
    thresholds: {
      warning: 80,    // 80% 预算剩余
      critical: 50,   // 50% 预算剩余
      exhausted: 10   // 10% 预算剩余
    },
    degradations: {
      warning: [
        { type: 'rate_limit', config: { rate: 1000, burst: 1200 } }
      ],
      critical: [
        { type: 'feature_disable', feature: 'showcase' },
        { type: 'rate_limit', config: { rate: 500, burst: 600 } }
      ],
      exhausted: [
        { type: 'circuit_breaker', config: { threshold: 10, timeout: 30000 } },
        { type: 'fallback', config: { useCache: true } }
      ]
    },
    metadata: {
      priority: 'P0',
      owner: 'pokemon-team',
      description: '精灵服务可用性 SLO'
    }
  },
  {
    id: 'catch-service-latency',
    service: 'catch-service',
    target: 95,  // 95% 请求在 200ms 内响应
    window: '7d',
    sliType: 'latency',
    thresholds: {
      warning: 70,
      critical: 40,
      exhausted: 15
    },
    degradations: {
      warning: [
        { type: 'rate_limit', config: { rate: 2000, burst: 2500 } }
      ],
      critical: [
        { type: 'feature_disable', feature: 'ar-mode' },
        { type: 'rate_limit', config: { rate: 1000, burst: 1200 } }
      ],
      exhausted: [
        { type: 'fallback', config: { simplifiedCatch: true } }
      ]
    },
    metadata: {
      priority: 'P0',
      owner: 'catch-team',
      description: '捕捉服务延迟 SLO'
    }
  },
  {
    id: 'gateway-availability',
    service: 'gateway',
    target: 99.95,
    window: '30d',
    sliType: 'availability',
    thresholds: {
      warning: 85,
      critical: 60,
      exhausted: 20
    },
    degradations: {
      warning: [
        { type: 'rate_limit', config: { rate: 5000, burst: 6000 } }
      ],
      critical: [
        { type: 'scale_down', config: { replicas: 2, reason: 'budget_critical' } }
      ],
      exhausted: [
        { type: 'circuit_breaker', config: { threshold: 5, timeout: 60000 } }
      ]
    },
    metadata: {
      priority: 'P0',
      owner: 'platform-team',
      description: '网关服务可用性 SLO'
    }
  },
  {
    id: 'social-service-throughput',
    service: 'social-service',
    target: 1000,  // 最低 1000 req/s
    window: '7d',
    sliType: 'throughput',
    thresholds: {
      warning: 75,
      critical: 50,
      exhausted: 25
    },
    degradations: {
      warning: [],
      critical: [
        { type: 'feature_disable', feature: 'voice-chat' }
      ],
      exhausted: [
        { type: 'feature_disable', feature: 'guild-features' },
        { type: 'rate_limit', config: { rate: 500, burst: 600 } }
      ]
    },
    metadata: {
      priority: 'P1',
      owner: 'social-team',
      description: '社交服务吞吐量 SLO'
    }
  }
];

module.exports = presetSLOs;
```

### 8. Grafana 仪表盘配置

```json
{
  "dashboard": {
    "title": "SLO Error Budget Dashboard",
    "panels": [
      {
        "title": "Error Budget Remaining",
        "type": "gauge",
        "datasource": "Prometheus",
        "targets": [
          {
            "expr": "slo_error_budget_remaining_seconds / slo_error_budget_total_seconds * 100",
            "legendFormat": "{{service}} - {{sli_type}}"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "thresholds": {
              "mode": "absolute",
              "steps": [
                { "color": "red", "value": 0 },
                { "color": "yellow", "value": 50 },
                { "color": "green", "value": 80 }
              ]
            },
            "unit": "percent"
          }
        }
      },
      {
        "title": "Burn Rate",
        "type": "graph",
        "datasource": "Prometheus",
        "targets": [
          {
            "expr": "slo_error_budget_burn_rate",
            "legendFormat": "{{service}}"
          }
        ]
      },
      {
        "title": "SLO Status",
        "type": "stat",
        "datasource": "Prometheus",
        "targets": [
          {
            "expr": "slo_status",
            "legendFormat": "{{service}}"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "mappings": [
              { "value": "0", "text": "Healthy" },
              { "value": "1", "text": "Warning" },
              { "value": "2", "text": "Critical" },
              { "value": "3", "text": "Exhausted" }
            ]
          }
        }
      },
      {
        "title": "Active Degradations",
        "type": "table",
        "datasource": "Prometheus",
        "targets": [
          {
            "expr": "slo_degradation_triggered_total",
            "legendFormat": "{{service}} - {{type}}"
          }
        ]
      }
    ]
  }
}
```

### 9. 数据库表结构

```sql
-- 数据库迁移文件
-- database/migrations/20260623_120000__add_slo_management_tables.sql

-- SLO 定义表
CREATE TABLE slo_definitions (
  id VARCHAR(100) PRIMARY KEY,
  service VARCHAR(100) NOT NULL,
  target DECIMAL(5,2) NOT NULL,
  window VARCHAR(20) NOT NULL,
  sli_type VARCHAR(50) NOT NULL,
  thresholds JSONB NOT NULL,
  degradations JSONB NOT NULL,
  metadata JSONB,
  status VARCHAR(20) DEFAULT 'active',
  current_state VARCHAR(20) DEFAULT 'healthy',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_slo_definitions_service ON slo_definitions(service);
CREATE INDEX idx_slo_definitions_status ON slo_definitions(status);

-- 错误预算历史表
CREATE TABLE slo_budget_history (
  id SERIAL PRIMARY KEY,
  slo_id VARCHAR(100) NOT NULL REFERENCES slo_definitions(id),
  remaining_seconds DECIMAL(10,2) NOT NULL,
  consumed_seconds DECIMAL(10,2) NOT NULL,
  burn_rate DECIMAL(10,4),
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_budget_history_slo_id ON slo_budget_history(slo_id);
CREATE INDEX idx_budget_history_recorded_at ON slo_budget_history(recorded_at);

-- 降级历史表
CREATE TABLE slo_degradation_history (
  id SERIAL PRIMARY KEY,
  slo_id VARCHAR(100) NOT NULL REFERENCES slo_definitions(id),
  service VARCHAR(100) NOT NULL,
  degradation_type VARCHAR(50) NOT NULL,
  state VARCHAR(20) NOT NULL,
  config JSONB,
  applied_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP,
  duration_seconds INTEGER
);

CREATE INDEX idx_degradation_history_slo_id ON slo_degradation_history(slo_id);
CREATE INDEX idx_degradation_history_service ON slo_degradation_history(service);
CREATE INDEX idx_degradation_history_applied_at ON slo_degradation_history(applied_at);

-- 插入预设 SLO
INSERT INTO slo_definitions (id, service, target, window, sli_type, thresholds, degradations, metadata)
VALUES 
  ('pokemon-service-availability', 'pokemon-service', 99.9, '30d', 'availability',
   '{"warning": 80, "critical": 50, "exhausted": 10}'::jsonb,
   '{"warning": [{"type": "rate_limit", "config": {"rate": 1000}}], "critical": [{"type": "feature_disable", "feature": "showcase"}], "exhausted": [{"type": "circuit_breaker", "config": {"threshold": 10}}]}'::jsonb,
   '{"priority": "P0", "owner": "pokemon-team"}'::jsonb
  ),
  ('gateway-availability', 'gateway', 99.95, '30d', 'availability',
   '{"warning": 85, "critical": 60, "exhausted": 20}'::jsonb,
   '{"warning": [{"type": "rate_limit", "config": {"rate": 5000}}], "critical": [], "exhausted": [{"type": "circuit_breaker", "config": {"threshold": 5}}]}'::jsonb,
   '{"priority": "P0", "owner": "platform-team"}'::jsonb
  );
```

### 10. API 接口

```javascript
// backend/shared/routes/slo.js
const express = require('express');
const router = express.Router();

/**
 * GET /api/slo
 * 获取所有 SLO 定义
 */
router.get('/', async (req, res) => {
  const { service, status } = req.query;
  
  let slos = Array.from(req.sloEngine.slos.values());
  
  if (service) {
    slos = slos.filter(slo => slo.service === service);
  }
  
  if (status) {
    slos = slos.filter(slo => slo.currentState === status);
  }

  res.json({
    total: slos.length,
    slos: slos.map(slo => ({
      id: slo.id,
      service: slo.service,
      target: slo.target,
      window: slo.window,
      sliType: slo.sliType,
      budget: slo.budget,
      currentState: slo.currentState,
      metadata: slo.metadata
    }))
  });
});

/**
 * GET /api/slo/:id
 * 获取单个 SLO 详情
 */
router.get('/:id', async (req, res) => {
  const slo = req.sloEngine.slos.get(req.params.id);
  
  if (!slo) {
    return res.status(404).json({ error: 'SLO not found' });
  }

  res.json(slo);
});

/**
 * POST /api/slo
 * 创建新的 SLO 定义
 */
router.post('/', async (req, res) => {
  try {
    const slo = req.sloEngine.defineSLO(req.body);
    res.status(201).json(slo);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * PUT /api/slo/:id
 * 更新 SLO 定义
 */
router.put('/:id', async (req, res) => {
  const existing = req.sloEngine.slos.get(req.params.id);
  
  if (!existing) {
    return res.status(404).json({ error: 'SLO not found' });
  }

  const updated = { ...existing, ...req.body, updatedAt: Date.now() };
  req.sloEngine.slos.set(req.params.id, updated);
  
  res.json(updated);
});

/**
 * DELETE /api/slo/:id
 * 删除 SLO 定义
 */
router.delete('/:id', async (req, res) => {
  if (!req.sloEngine.slos.has(req.params.id)) {
    return res.status(404).json({ error: 'SLO not found' });
  }

  req.sloEngine.slos.delete(req.params.id);
  res.status(204).send();
});

/**
 * GET /api/slo/:id/budget
 * 获取错误预算详情
 */
router.get('/:id/budget', async (req, res) => {
  const slo = req.sloEngine.slos.get(req.params.id);
  
  if (!slo) {
    return res.status(404).json({ error: 'SLO not found' });
  }

  const prediction = req.budgetCalculator.predictExhaustionTime(req.params.id);

  res.json({
    budget: slo.budget,
    prediction,
    percentageRemaining: (slo.budget.remaining / slo.budget.total) * 100
  });
});

/**
 * GET /api/slo/:id/history
 * 获取预算历史
 */
router.get('/:id/history', async (req, res) => {
  const { from, to, limit = 100 } = req.query;
  
  const history = req.budgetCalculator.budgetHistory.get(req.params.id) || [];
  
  let filtered = history;
  if (from) {
    filtered = filtered.filter(h => h.timestamp >= new Date(from).getTime());
  }
  if (to) {
    filtered = filtered.filter(h => h.timestamp <= new Date(to).getTime());
  }

  res.json({
    slo_id: req.params.id,
    total: filtered.length,
    history: filtered.slice(-limit)
  });
});

/**
 * GET /api/slo/degradations/active
 * 获取当前活跃的降级措施
 */
router.get('/degradations/active', async (req, res) => {
  const degradations = req.degradationManager.getActiveDegradations();
  
  res.json({
    total: degradations.length,
    degradations
  });
});

/**
 * POST /api/slo/:id/revoke
 * 撤销降级措施
 */
router.post('/:id/revoke', async (req, res) => {
  const { degradationKey } = req.body;
  
  await req.degradationManager.revokeDegradation(degradationKey);
  
  res.json({ message: 'Degradation revoked successfully' });
});

module.exports = router;
```

## 验收标准

- [ ] SLO 定义引擎支持多层级 SLO 定义（服务级、接口级、功能级）
- [ ] 错误预算计算器实时计算预算消耗和燃烧率
- [ ] 支持预测预算耗尽时间功能
- [ ] 自动降级管理器支持 5 种降级类型：rate_limit、feature_disable、circuit_breaker、fallback、scale_down
- [ ] SLO 中间件集成到所有微服务
- [ ] Prometheus 指标正确导出：slo_error_budget_remaining、slo_error_budget_consumed、slo_error_budget_burn_rate、slo_status、slo_degradation_triggered
- [ ] Grafana 仪表盘展示错误预算、燃烧率、SLO 状态、活跃降级
- [ ] 数据库表结构正确创建，包含 slo_definitions、slo_budget_history、slo_degradation_history
- [ ] API 接口完整实现：GET /api/slo、POST /api/slo、GET /api/slo/:id/budget、GET /api/slo/:id/history
- [ ] 预设至少 4 个核心服务的 SLO 定义
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试验证完整降级流程
- [ ] 文档完整：API 文档、运维手册、故障排查指南

## 影响范围

- **新增文件**：
  - `backend/shared/slo/SLODefinitionEngine.js`
  - `backend/shared/slo/ErrorBudgetCalculator.js`
  - `backend/shared/slo/SLICollector.js`
  - `backend/shared/slo/AutoDegradationManager.js`
  - `backend/shared/slo/SLOMetricsExporter.js`
  - `backend/shared/slo/presetSLOs.js`
  - `backend/shared/middleware/sloMiddleware.js`
  - `backend/shared/routes/slo.js`
  - `backend/tests/unit/slo/*.test.js`
  - `backend/tests/integration/slo/*.test.js`
  - `database/migrations/20260623_120000__add_slo_management_tables.sql`

- **修改文件**：
  - `backend/gateway/src/index.js` - 注册 SLO 路由和中间件
  - `backend/services/*/src/index.js` - 集成 SLO 中间件
  - `backend/shared/index.js` - 导出 SLO 模块
  - `monitoring/grafana/dashboards/` - 新增 SLO 仪表盘

- **依赖服务**：
  - Prometheus - 存储和查询指标
  - Grafana - 可视化展示
  - PostgreSQL - 持久化 SLO 定义和历史数据
  - Redis - 缓存 SLO 状态和活跃降级

## 参考

- [Google SRE - SLO Error Budget](https://sre.google/sre-book/error-budget/)
- [OpenSLO Specification](https://github.com/OpenSLO/OpenSLO)
- [Prometheus SLO Best Practices](https://prometheus.io/docs/practices/slo/)
- [Grafana SLO Documentation](https://grafana.com/docs/grafana/latest/alerting/slo/)
