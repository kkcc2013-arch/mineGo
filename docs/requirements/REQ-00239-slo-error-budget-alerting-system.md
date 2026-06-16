# REQ-00239：SLO 错误预算燃尽告警与服务健康评分系统

- **编号**：REQ-00239
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/sloBudgetTracker.js、infrastructure/k8s/monitoring、admin-dashboard
- **创建时间**：2026-06-16 01:00
- **依赖需求**：REQ-00002（结构化日志与 Prometheus 指标）、REQ-00005（Prometheus 告警规则）、REQ-00130（实时业务事件流监控）

## 1. 背景与问题

### 当前现状
- 项目已实现 OpenTelemetry 分布式追踪（`backend/shared/tracing.js`）
- Prometheus 指标和告警规则已完善（`infrastructure/k8s/monitoring/prometheus-rules.yml`）
- 实时业务指标监控已实现（`backend/shared/realtimeBusinessMetrics.js`）
- 但缺少 SLO（服务级别目标）定义和错误预算管理

### 核心问题
1. **被动告警**：当前告警基于阈值触发，缺少趋势预测和预算管理
2. **缺少服务健康评分**：无法快速评估整体服务健康状态
3. **错误预算不可见**：团队无法感知"还能承受多少故障"
4. **决策缺乏依据**：发布/暂停决策缺少量化数据支撑
5. **SLO 缺失**：没有定义关键服务的可用性目标

## 2. 目标

构建 SLO 错误预算燃尽告警与服务健康评分系统：
- **定义关键 SLO**：为 9 个微服务定义可用性、延迟、错误率 SLO
- **错误预算追踪**：实时计算错误预算消耗速度和剩余预算
- **燃尽告警**：当错误预算消耗过快时提前告警
- **服务健康评分**：综合评分 0-100，快速评估服务健康
- **可视化仪表板**：Grafana 仪表板展示 SLO 状态和预算趋势
- **发布决策辅助**：预算不足时自动建议暂停发布

## 3. 范围

### 包含
- SLO 定义配置（可用性 99.9%、延迟 P95 < 200ms）
- 错误预算计算引擎（基于 Prometheus 查询）
- 燃尽速率追踪与告警
- 服务健康评分算法
- Grafana SLO 仪表板
- 发布门禁检查 API
- 管理员 SLO 配置界面

### 不包含
- SLA 商业合同管理
- 客户-facing SLO 报告
- 自动扩缩容决策（属于 REQ-00071）

## 4. 详细需求

### 4.1 SLO 定义配置

```javascript
// backend/shared/sloConfig.js

/**
 * 服务级别目标配置
 */
const SLO_CONFIG = {
  // Gateway 服务
  gateway: {
    availability: {
      target: 99.9,           // 99.9% 可用性
      window: '30d',          // 30 天滚动窗口
      errorBudget: 0.1,       // 0.1% 错误预算
    },
    latency: {
      target: 200,            // P95 < 200ms
      threshold: 'p95',
      window: '5m',
    },
    errorRate: {
      target: 0.1,            // 错误率 < 0.1%
      window: '5m',
    },
  },
  
  // 用户服务
  'user-service': {
    availability: { target: 99.95, window: '30d' },
    latency: { target: 150, threshold: 'p95', window: '5m' },
    errorRate: { target: 0.05, window: '5m' },
  },
  
  // 捕捉服务（核心业务）
  'catch-service': {
    availability: { target: 99.9, window: '30d' },
    latency: { target: 250, threshold: 'p95', window: '5m' },
    errorRate: { target: 0.1, window: '5m' },
    businessSuccess: { target: 99.5, window: '1h' }, // 捕捉成功率
  },
  
  // 支付服务（最高优先级）
  'payment-service': {
    availability: { target: 99.99, window: '30d' },
    latency: { target: 100, threshold: 'p99', window: '5m' },
    errorRate: { target: 0.01, window: '5m' },
  },
  
  // 其他服务...
  'gym-service': {
    availability: { target: 99.5, window: '30d' },
    latency: { target: 300, threshold: 'p95', window: '5m' },
    errorRate: { target: 0.5, window: '5m' },
  },
  
  'pokemon-service': {
    availability: { target: 99.9, window: '30d' },
    latency: { target: 200, threshold: 'p95', window: '5m' },
    errorRate: { target: 0.1, window: '5m' },
  },
  
  'location-service': {
    availability: { target: 99.5, window: '30d' },
    latency: { target: 150, threshold: 'p95', window: '5m' },
    errorRate: { target: 0.5, window: '5m' },
  },
  
  'social-service': {
    availability: { target: 99.5, window: '30d' },
    latency: { target: 200, threshold: 'p95', window: '5m' },
    errorRate: { target: 0.5, window: '5m' },
  },
  
  'reward-service': {
    availability: { target: 99.9, window: '30d' },
    latency: { target: 150, threshold: 'p95', window: '5m' },
    errorRate: { target: 0.1, window: '5m' },
  },
};

module.exports = { SLO_CONFIG };
```

### 4.2 错误预算计算引擎

```javascript
// backend/shared/sloBudgetTracker.js

const promClient = require('prom-client');
const { query } = require('./db');
const { SLO_CONFIG } = require('./sloConfig');

class SLOBudgetTracker {
  constructor() {
    this.registerMetrics();
  }

  registerMetrics() {
    // 错误预算剩余百分比
    this.errorBudgetRemaining = new promClient.Gauge({
      name: 'minego_slo_error_budget_remaining',
      help: 'Error budget remaining percentage',
      labelNames: ['service', 'slo_type'],
    });

    // 错误预算消耗速率
    this.errorBudgetBurnRate = new promClient.Gauge({
      name: 'minego_slo_error_budget_burn_rate',
      help: 'Error budget burn rate (budget consumed per hour)',
      labelNames: ['service', 'slo_type'],
    });

    // 服务健康评分
    this.serviceHealthScore = new promClient.Gauge({
      name: 'minego_slo_service_health_score',
      help: 'Service health score (0-100)',
      labelNames: ['service'],
    });

    // SLO 达成状态
    this.sloStatus = new promClient.Gauge({
      name: 'minego_slo_status',
      help: 'SLO status (1=healthy, 0=breaching)',
      labelNames: ['service', 'slo_type'],
    });

    // 错误预算消耗预测
    this.errorBudgetForecast = new promClient.Gauge({
      name: 'minego_slo_error_budget_forecast_days',
      help: 'Predicted days until error budget exhausted',
      labelNames: ['service', 'slo_type'],
    });
  }

  /**
   * 计算服务错误预算
   */
  async calculateErrorBudget(serviceName) {
    const config = SLO_CONFIG[serviceName];
    if (!config) return null;

    const results = {};

    for (const [sloType, sloConfig] of Object.entries(config)) {
      const measurement = await this.measureSLO(serviceName, sloType, sloConfig);
      
      // 计算错误预算
      const target = sloConfig.target;
      const actual = measurement.value;
      const errorBudget = target - actual;
      const budgetUsed = Math.max(0, target - actual);
      const budgetRemaining = Math.max(0, target - budgetUsed);
      const budgetRemainingPercent = (budgetRemaining / (target - (100 - target))) * 100;

      // 计算燃尽速率（每小时消耗的预算百分比）
      const burnRate = await this.calculateBurnRate(serviceName, sloType);

      // 预测预算耗尽时间
      const forecastDays = burnRate > 0 ? budgetRemainingPercent / (burnRate * 24) : Infinity;

      results[sloType] = {
        target,
        actual,
        errorBudget,
        budgetUsed,
        budgetRemaining,
        budgetRemainingPercent,
        burnRate,
        forecastDays,
        status: actual >= target ? 'healthy' : 'breaching',
      };

      // 更新 Prometheus 指标
      this.errorBudgetRemaining.set(
        { service: serviceName, slo_type: sloType },
        budgetRemainingPercent
      );
      this.errorBudgetBurnRate.set(
        { service: serviceName, slo_type: sloType },
        burnRate
      );
      this.sloStatus.set(
        { service: serviceName, slo_type: sloType },
        actual >= target ? 1 : 0
      );
      this.errorBudgetForecast.set(
        { service: serviceName, slo_type: sloType },
        forecastDays === Infinity ? -1 : forecastDays
      );
    }

    // 计算服务健康评分
    const healthScore = this.calculateHealthScore(results);
    this.serviceHealthScore.set({ service: serviceName }, healthScore);

    return {
      service: serviceName,
      healthScore,
      slos: results,
    };
  }

  /**
   * 测量 SLO 实际值
   */
  async measureSLO(serviceName, sloType, config) {
    const window = config.window || '30d';
    
    switch (sloType) {
      case 'availability':
        return await this.measureAvailability(serviceName, window);
      case 'latency':
        return await this.measureLatency(serviceName, config);
      case 'errorRate':
        return await this.measureErrorRate(serviceName, window);
      case 'businessSuccess':
        return await this.measureBusinessSuccess(serviceName, window);
      default:
        return { value: 100 };
    }
  }

  /**
   * 测量可用性
   */
  async measureAvailability(serviceName, window) {
    // 从 Prometheus 查询可用性
    const query = `
      sum(rate(http_requests_total{service="${serviceName}",code!~"5.."}[${window}]))
      /
      sum(rate(http_requests_total{service="${serviceName}"}[${window}]))
      * 100
    `;
    
    const value = await this.queryPrometheus(query);
    return { value: value || 100 };
  }

  /**
   * 测量延迟
   */
  async measureLatency(serviceName, config) {
    const threshold = config.threshold || 'p95';
    const window = config.window || '5m';
    
    const query = `
      histogram_quantile(0.${threshold.slice(1)}, 
        sum(rate(http_request_duration_seconds_bucket{service="${serviceName}"}[${window}])) by (le)
      ) * 1000
    `;
    
    const value = await this.queryPrometheus(query);
    // 延迟 SLO：低于目标值为达标
    return { 
      value: value || 0,
      isLowerBetter: true,
    };
  }

  /**
   * 测量错误率
   */
  async measureErrorRate(serviceName, window) {
    const query = `
      sum(rate(http_requests_total{service="${serviceName}",code=~"5.."}[${window}]))
      /
      sum(rate(http_requests_total{service="${serviceName}"}[${window}]))
      * 100
    `;
    
    const value = await this.queryPrometheus(query);
    return { value: value || 0 };
  }

  /**
   * 计算燃尽速率
   */
  async calculateBurnRate(serviceName, sloType) {
    // 过去 1 小时消耗的预算百分比
    const oneHourAgo = Date.now() - 3600000;
    
    const query = `
      (
        minego_slo_error_budget_remaining{service="${serviceName}",slo_type="${sloType}"}
        -
        minego_slo_error_budget_remaining{service="${serviceName}",slo_type="${sloType}"}[1h]
      )
    `;
    
    const value = await this.queryPrometheus(query);
    return Math.abs(value || 0);
  }

  /**
   * 计算服务健康评分
   */
  calculateHealthScore(sloResults) {
    const weights = {
      availability: 0.4,
      latency: 0.3,
      errorRate: 0.2,
      businessSuccess: 0.1,
    };

    let totalScore = 0;
    let totalWeight = 0;

    for (const [sloType, result] of Object.entries(sloResults)) {
      const weight = weights[sloType] || 0.1;
      const sloScore = result.status === 'healthy' ? 100 : 
                       Math.max(0, 100 - Math.abs(result.target - result.actual) * 10);
      totalScore += sloScore * weight;
      totalWeight += weight;
    }

    return Math.round(totalScore / totalWeight);
  }

  /**
   * 查询 Prometheus
   */
  async queryPrometheus(query) {
    const axios = require('axios');
    const prometheusUrl = process.env.PROMETHEUS_URL || 'http://prometheus:9090';
    
    try {
      const response = await axios.get(`${prometheusUrl}/api/v1/query`, {
        params: { query },
        timeout: 5000,
      });
      
      if (response.data.status === 'success' && response.data.data.result.length > 0) {
        return parseFloat(response.data.data.result[0].value[1]);
      }
      return null;
    } catch (error) {
      console.error('Prometheus query failed:', error.message);
      return null;
    }
  }

  /**
   * 获取所有服务的 SLO 状态
   */
  async getAllServiceSLOs() {
    const results = {};
    
    for (const serviceName of Object.keys(SLO_CONFIG)) {
      results[serviceName] = await this.calculateErrorBudget(serviceName);
    }
    
    return results;
  }

  /**
   * 检查是否可以发布
   */
  async canRelease(serviceName) {
    const sloStatus = await this.calculateErrorBudget(serviceName);
    
    if (!sloStatus) return { allowed: true, reason: 'No SLO defined' };

    // 检查是否有 SLO 违规
    const breachingSLOs = Object.entries(sloStatus.slos)
      .filter(([_, data]) => data.status === 'breaching')
      .map(([type, _]) => type);

    if (breachingSLOs.length > 0) {
      return {
        allowed: false,
        reason: `SLO breaching: ${breachingSLOs.join(', ')}`,
        healthScore: sloStatus.healthScore,
      };
    }

    // 检查错误预算是否低于 20%
    const lowBudgetSLOs = Object.entries(sloStatus.slos)
      .filter(([_, data]) => data.budgetRemainingPercent < 20)
      .map(([type, data]) => ({ type, remaining: data.budgetRemainingPercent }));

    if (lowBudgetSLOs.length > 0) {
      return {
        allowed: true,
        warning: `Low error budget: ${lowBudgetSLOs.map(s => `${s.type}(${s.remaining.toFixed(1)}%)`).join(', ')}`,
        healthScore: sloStatus.healthScore,
      };
    }

    return {
      allowed: true,
      healthScore: sloStatus.healthScore,
    };
  }
}

module.exports = new SLOBudgetTracker();
```

### 4.3 Prometheus 告警规则

```yaml
# infrastructure/k8s/monitoring/slo-alerts.yml

groups:
  - name: slo_error_budget
    interval: 1m
    rules:
      # 错误预算快速燃尽告警
      - alert: SLOErrorBudgetBurningFast
        expr: |
          minego_slo_error_budget_burn_rate > 2
        for: 5m
        labels:
          severity: critical
          team: sre
        annotations:
          summary: "SLO error budget burning too fast: {{ $labels.service }}"
          description: |
            Service {{ $labels.service }} is burning error budget for {{ $labels.slo_type }} at {{ $value | printf "%.2f" }}% per hour.
            Current budget remaining: {{ $labels.service }} - check Grafana SLO dashboard.

      # 错误预算即将耗尽告警
      - alert: SLOErrorBudgetLow
        expr: |
          minego_slo_error_budget_remaining < 20
        for: 10m
        labels:
          severity: warning
          team: sre
        annotations:
          summary: "SLO error budget low: {{ $labels.service }}"
          description: |
            Service {{ $labels.service }} has only {{ $value | printf "%.1f" }}% error budget remaining for {{ $labels.slo_type }}.
            Consider postponing non-critical releases.

      # 错误预算耗尽告警
      - alert: SLOErrorBudgetExhausted
        expr: |
          minego_slo_error_budget_remaining <= 0
        for: 1m
        labels:
          severity: critical
          team: sre
        annotations:
          summary: "SLO error budget exhausted: {{ $labels.service }}"
          description: |
            Service {{ $labels.service }} has exhausted error budget for {{ $labels.slo_type }}.
            All hands on deck - service is in breach of SLO!

      # SLO 违规告警
      - alert: SLOBreach
        expr: |
          minego_slo_status == 0
        for: 5m
        labels:
          severity: critical
          team: sre
        annotations:
          summary: "SLO breach detected: {{ $labels.service }}"
          description: |
            Service {{ $labels.service }} is breaching SLO for {{ $labels.slo_type }}.
            Immediate attention required.

      # 服务健康评分低
      - alert: ServiceHealthScoreLow
        expr: |
          minego_slo_service_health_score < 70
        for: 10m
        labels:
          severity: warning
          team: sre
        annotations:
          summary: "Service health score low: {{ $labels.service }}"
          description: |
            Service {{ $labels.service }} health score is {{ $value }}.
            Check SLO dashboard for details.

      # 预测即将耗尽告警
      - alert: SLOBudgetExhaustionPredicted
        expr: |
          0 < minego_slo_error_budget_forecast_days < 7
        for: 30m
        labels:
          severity: warning
          team: sre
        annotations:
          summary: "SLO budget exhaustion predicted: {{ $labels.service }}"
          description: |
            Service {{ $labels.service }} {{ $labels.slo_type }} budget will exhaust in {{ $value | printf "%.1f" }} days.
            Take proactive action now.
```

### 4.4 管理 API

```javascript
// gateway/src/routes/slo.js

const express = require('express');
const router = express.Router();
const sloBudgetTracker = require('../../../shared/sloBudgetTracker');

/**
 * 获取所有服务的 SLO 状态
 */
router.get('/status', async (req, res) => {
  const status = await sloBudgetTracker.getAllServiceSLOs();
  
  res.json({
    success: true,
    data: status,
    summary: {
      totalServices: Object.keys(status).length,
      healthyServices: Object.values(status).filter(s => s.healthScore >= 70).length,
      breachingServices: Object.values(status).filter(s => 
        Object.values(s.slos).some(slo => slo.status === 'breaching')
      ).length,
    },
  });
});

/**
 * 获取单个服务的 SLO 状态
 */
router.get('/status/:service', async (req, res) => {
  const { service } = req.params;
  const status = await sloBudgetTracker.calculateErrorBudget(service);
  
  if (!status) {
    return res.status(404).json({
      success: false,
      error: 'Service not found or no SLO defined',
    });
  }
  
  res.json({ success: true, data: status });
});

/**
 * 检查是否可以发布
 */
router.get('/release-check/:service', async (req, res) => {
  const { service } = req.params;
  const check = await sloBudgetTracker.canRelease(service);
  
  res.json({
    success: true,
    data: check,
  });
});

/**
 * 获取服务健康评分
 */
router.get('/health-score/:service', async (req, res) => {
  const { service } = req.params;
  const status = await sloBudgetTracker.calculateErrorBudget(service);
  
  if (!status) {
    return res.status(404).json({
      success: false,
      error: 'Service not found',
    });
  }
  
  res.json({
    success: true,
    data: {
      service,
      healthScore: status.healthScore,
      status: status.healthScore >= 90 ? 'excellent' :
              status.healthScore >= 70 ? 'good' :
              status.healthScore >= 50 ? 'degraded' : 'critical',
    },
  });
});

module.exports = router;
```

### 4.5 Grafana 仪表板 JSON

```json
{
  "title": "mineGo SLO Dashboard",
  "panels": [
    {
      "title": "Service Health Scores",
      "type": "gauge",
      "datasource": "Prometheus",
      "targets": [
        {
          "expr": "minego_slo_service_health_score",
          "legendFormat": "{{ service }}"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "thresholds": {
            "mode": "absolute",
            "steps": [
              { "color": "red", "value": 0 },
              { "color": "yellow", "value": 50 },
              { "color": "green", "value": 70 },
              { "color": "dark-green", "value": 90 }
            ]
          },
          "min": 0,
          "max": 100
        }
      }
    },
    {
      "title": "Error Budget Remaining",
      "type": "stat",
      "datasource": "Prometheus",
      "targets": [
        {
          "expr": "minego_slo_error_budget_remaining",
          "legendFormat": "{{ service }} - {{ slo_type }}"
        }
      ]
    },
    {
      "title": "Error Budget Burn Rate",
      "type": "time series",
      "datasource": "Prometheus",
      "targets": [
        {
          "expr": "minego_slo_error_budget_burn_rate",
          "legendFormat": "{{ service }} - {{ slo_type }}"
        }
      ]
    },
    {
      "title": "SLO Status",
      "type": "table",
      "datasource": "Prometheus",
      "targets": [
        {
          "expr": "minego_slo_status",
          "format": "table"
        }
      ]
    }
  ]
}
```

## 5. 验收标准（可测试）

- [ ] 为 9 个微服务定义完整的 SLO 配置（可用性、延迟、错误率）
- [ ] 错误预算计算引擎正常工作，每分钟更新 Prometheus 指标
- [ ] 6 种 Prometheus 告警规则生效：快速燃尽、预算低、耗尽、违规、健康分低、预测耗尽
- [ ] 服务健康评分算法正确，0-100 分
- [ ] 管理员 API 提供 4 个接口：/status、/status/:service、/release-check/:service、/health-score/:service
- [ ] 发布门禁检查功能正常，预算不足时返回 allowed: false
- [ ] Grafana SLO 仪表板正确展示所有指标
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试验证 Prometheus 指标正确暴露

## 6. 工作量估算

**L（大型）**

**理由**：
- 需要设计完整的 SLO 配置体系
- 错误预算计算引擎涉及复杂的 Prometheus 查询
- 需要创建多个 Prometheus 告警规则
- Grafana 仪表板需要精心设计
- 需要与现有监控系统集成
- 预估工作量：4-5 天

## 7. 优先级理由

**P1（高优先级）**

**理由**：
1. **运维价值高**：SLO 是现代可观测性的核心组件，能够量化服务质量
2. **预防故障**：错误预算燃尽告警可以提前发现问题，避免大规模故障
3. **决策支撑**：为发布/暂停决策提供量化依据
4. **依赖已具备**：Prometheus、OpenTelemetry 已集成
5. **影响范围广**：所有微服务都受益
