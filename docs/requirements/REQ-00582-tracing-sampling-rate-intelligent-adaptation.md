# REQ-00582：微服务链路追踪采样率智能自适应与成本优化系统

- **编号**：REQ-00582
- **类别**：可观测性
- **优先级**：P1
- **状态**：new
- **涉及服务**：gateway, backend/shared/tracing
- **创建时间**：2026-07-16 20:15
- **依赖需求**：REQ-00148（分布式追踪）、REQ-00528（智能采样与性能瓶颈诊断）

## 1. 背景与问题

当前 mineGo 微服务架构已集成 OpenTelemetry/Jaeger 分布式追踪系统（REQ-00148），但存在以下问题：

1. **采样策略静态化**：当前采用固定 1% 采样率，无法根据流量模式动态调整
2. **成本与价值失衡**：高峰期追踪数据丢失关键信息，低峰期产生大量冗余数据
3. **存储成本高**：全量追踪数据导致存储成本持续增长
4. **关键请求遗漏**：错误请求、慢请求可能因采样率过低被遗漏

根据分析：
- 高峰期 10000 QPS 时 1% 采样率导致关键错误追踪丢失
- 低峰期 100 QPS 时 1% 采样率产生大量无用数据
- 存储成本月增长 15%

## 2. 目标

建立智能自适应采样率系统，实现：
- 根据流量模式动态调整采样率（0.1% - 100%）
- 错误请求和慢请求自动提高采样率至 100%
- 正常请求根据服务负载动态降低采样率
- 存储成本降低 60% 以上
- 关键追踪数据零丢失

## 3. 范围

### 包含
- 采样率自适应算法实现
- 错误/慢请求优先采样策略
- 采样率动态配置 API
- Prometheus 指标集成
- 成本监控仪表盘

### 不包含
- 追踪数据分析平台（已有 REQ-00517）
- 追踪数据存储优化（已有 REQ-00528）

## 4. 详细需求

### 4.1 智能采样率计算器

```javascript
// shared/tracing/intelligentSampler.js
class IntelligentSampler {
  constructor() {
    this.baseRate = 0.01; // 默认 1%
    this.minRate = 0.001; // 最小 0.1%
    this.maxRate = 1.0;   // 最大 100%
    this.errorRate = 1.0; // 错误请求 100% 采样
    this.slowThresholdMs = 1000; // 慢请求阈值
  }

  calculateSamplingRate(metrics) {
    // 1. 基础采样率基于 QPS
    let rate = this.baseRate;
    
    // 2. 流量自适应
    if (metrics.qps > 5000) {
      rate = this.maxRate * 0.1; // 高峰期 10%
    } else if (metrics.qps < 100) {
      rate = this.minRate; // 低峰期 0.1%
    }
    
    // 3. 错误率影响
    if (metrics.errorRate > 0.05) {
      rate = Math.min(rate * 2, this.maxRate);
    }
    
    // 4. 慢请求比例影响
    if (metrics.slowRequestRatio > 0.1) {
      rate = Math.min(rate * 1.5, this.maxRate);
    }
    
    return rate;
  }

  shouldSample(span, metrics) {
    // 错误请求必采样
    if (span.status === 'ERROR') return true;
    
    // 慢请求必采样
    if (span.duration > this.slowThresholdMs) return true;
    
    // 根据采样率决定
    return Math.random() < this.calculateSamplingRate(metrics);
  }
}
```

### 4.2 采样率动态调整策略

| 流量区间 | QPS 范围 | 基础采样率 | 错误采样率 | 慢请求采样率 |
|----------|----------|------------|------------|--------------|
| 低峰期 | < 100 | 0.1% | 100% | 100% |
| 正常期 | 100-1000 | 1% | 100% | 100% |
| 高峰期 | 1000-5000 | 5% | 100% | 100% |
| 极高峰期 | > 5000 | 10% | 100% | 100% |

### 4.3 优先采样规则

```javascript
// 优先采样条件（100% 采样）
const prioritySampleConditions = [
  span.statusCode >= 400,          // HTTP 错误
  span.duration > 1000,            // 慢请求
  span.attributes.has('error'),     // 应用错误
  span.name.includes('payment'),    // 支付相关
  span.name.includes('auth'),       // 认证相关
  span.attributes.get('user-type') === 'vip', // VIP 用户
];
```

### 4.4 采样率配置 API

```
GET /api/admin/tracing/sampling
POST /api/admin/tracing/sampling
{
  "baseRate": 0.01,
  "minRate": 0.001,
  "maxRate": 1.0,
  "adaptiveEnabled": true,
  "priorityRules": ["error", "slow", "payment", "auth"]
}
```

### 4.5 Prometheus 指标

```javascript
// 采样相关指标
const samplingMetrics = {
  // 采样率
  tracing_sampling_rate: gauge,
  
  // 采样决策
  tracing_sampling_decisions_total: counter,
  
  // 优先采样
  tracing_priority_sample_total: counter,
  
  // 存储成本估算
  tracing_storage_bytes_total: counter,
  
  // 采样节省率
  tracing_sampling_savings_ratio: gauge
};
```

## 5. 验收标准（可测试）

- [ ] 低峰期（QPS < 100）采样率 ≤ 0.5%
- [ ] 高峰期（QPS > 5000）采样率 ≥ 5%
- [ ] 错误请求采样率 = 100%
- [ ] 慢请求（> 1s）采样率 = 100%
- [ ] 存储成本降低 ≥ 60%（对比固定 1% 采样）
- [ ] 关键错误追踪零丢失
- [ ] 采样率调整延迟 < 10s
- [ ] 存在配置 API 端点
- [ ] Prometheus 指标正确导出

## 6. 工作量估算

**M（中等）**
- 需要修改现有追踪中间件
- 需要实现动态配置机制
- 需要集成 Prometheus 指标

## 7. 优先级理由

P1 理由：分布式追踪是可观测性核心组件，智能采样率优化可显著降低存储成本，同时保证关键追踪数据不丢失。与已有 REQ-00528（智能采样）形成互补，解决实际生产成本问题。