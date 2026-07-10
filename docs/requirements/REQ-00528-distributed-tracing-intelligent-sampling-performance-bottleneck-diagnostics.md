# REQ-00528：分布式追踪智能采样与性能瓶颈自动诊断系统

- **编号**：REQ-00528
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、backend/shared/tracing、backend/shared/perfAnalyzer、所有后端服务、infrastructure/monitoring
- **创建时间**：2026-07-10 07:00 UTC
- **依赖需求**：REQ-00480（日志异常检测与智能告警聚合）、REQ-00502（性能分析与深度优化框架）

## 1. 背景与问题

当前项目已实现完善的可观测性体系：
- 日志异常检测与智能告警聚合系统（REQ-00480）
- 性能分析与深度优化框架（REQ-00502）
- 监控指标生命周期管理（REQ-00491）
- 全链路监控可视化大屏（REQ-00504）

**现有痛点：**
1. 分布式追踪数据量巨大（日均 5M+ traces），缺乏智能采样机制，存储成本高
2. 性能瓶颈定位依赖人工分析，缺乏自动诊断能力
3. 跨服务调用链路复杂，难以快速识别慢查询和异常依赖
4. 缺乏基于历史数据的智能采样策略（如异常 trace 100% 采样，正常 trace 1% 采样）
5. 性能瓶颈分析缺乏与业务指标的关联（如某接口慢影响多少用户）

## 2. 目标

建立分布式追踪智能采样与性能瓶颈自动诊断系统，实现：
- 智能采样策略：基于错误率、延迟、业务重要性动态调整采样率（目标：存储成本降低 70%）
- 性能瓶颈自动诊断：识别慢服务、慢查询、异常依赖链路
- 业务影响分析：将性能问题关联到受影响用户数、业务指标
- 根因推荐：基于历史数据推荐可能的根因和修复建议
- 自适应阈值：基于历史基线自动调整异常检测阈值

## 3. 范围

- **包含**：
  - IntelligentTraceSampler - 智能采样器（动态采样率调整）
  - TraceAnalyzer - 追踪数据分析器
  - PerformanceBottleneckDetector - 性能瓶颈检测器
  - BusinessImpactCalculator - 业务影响计算器
  - RootCauseRecommender - 根因推荐引擎
  - AdaptiveThresholdManager - 自适应阈值管理器
  - TraceSamplingPolicy - 采样策略配置与规则引擎

- **不包含**：
  - 基础追踪收集（已有 OpenTelemetry 集成）
  - 日志异常检测（已有 REQ-00480）
  - 性能分析框架（已有 REQ-00502）
  - 可视化大屏（已有 REQ-00504）

## 4. 详细需求

### 4.1 IntelligentTraceSampler 智能采样器

```javascript
class IntelligentTraceSampler {
  // 采样策略
  samplingPolicies: {
    error: 1.0,           // 错误 trace 100% 采样
    slow: 1.0,            // 慢 trace 100% 采样
    normal: 0.01,         // 正常 trace 1% 采样
    businessCritical: 0.5 // 关键业务 50% 采样
  }
  
  // 核心方法
  async shouldSample(trace) {
    // 1. 错误判断
    if (trace.hasError()) return true;
    
    // 2. 延迟判断
    if (trace.duration > this.slowThreshold) return true;
    
    // 3. 业务重要性判断
    if (this.isBusinessCritical(trace)) return Math.random() < 0.5;
    
    // 4. 正常请求 - 动态采样
    return Math.random() < this.calculateDynamicSamplingRate();
  }
  
  async calculateDynamicSamplingRate() {
    // 基于当前存储成本和查询负载动态调整
    const storageUsage = await this.getStorageUsage();
    const queryLoad = await this.getQueryLoad();
    
    // 成本优化算法
    if (storageUsage > 80%) return 0.005;  // 降低采样率
    if (queryLoad < 50%) return 0.02;      // 提高采样率
    return 0.01;
  }
  
  // 业务重要性判断
  businessCriticalRoutes: [
    '/api/payments/*',
    '/api/catch/*',
    '/api/gym/battle',
    '/api/trade/*'
  ]
}
```

### 4.2 TraceAnalyzer 追踪数据分析器

```javascript
class TraceAnalyzer {
  // 分析维度
  async analyzeServiceLatency(serviceName, timeRange) {
    // 分析某服务的延迟分布
    return {
      p50: 120,  // ms
      p95: 450,
      p99: 1200,
      slowestOperations: [
        { operation: 'db.query', avgDuration: 320, count: 1523 },
        { operation: 'redis.get', avgDuration: 50, count: 8234 }
      ]
    };
  }
  
  async analyzeCrossServiceDependencies(timeRange) {
    // 分析跨服务依赖
    return {
      serviceDependencies: {
        'gateway': ['user-service', 'pokemon-service', 'catch-service'],
        'catch-service': ['pokemon-service', 'user-service', 'location-service']
      },
      problematicDependencies: [
        {
          from: 'gateway',
          to: 'user-service',
          avgLatency: 450,
          errorRate: 0.02,
          impact: 'high'
        }
      ]
    };
  }
  
  async identifySlowTraces(limit = 100) {
    // 识别慢 trace
    return await db.query(`
      SELECT trace_id, duration, service_name, operation
      FROM traces
      WHERE timestamp > NOW() - INTERVAL '1 hour'
      ORDER BY duration DESC
      LIMIT $1
    `, [limit]);
  }
}
```

### 4.3 PerformanceBottleneckDetector 性能瓶颈检测器

```javascript
class PerformanceBottleneckDetector {
  // 瓶颈类型
  bottleneckTypes: {
    DATABASE_SLOW_QUERY: 'database_slow_query',
    EXTERNAL_API_TIMEOUT: 'external_api_timeout',
    MEMORY_PRESSURE: 'memory_pressure',
    CPU_BOTTLENECK: 'cpu_bottleneck',
    NETWORK_LATENCY: 'network_latency',
    LOCK_CONTENTION: 'lock_contention'
  }
  
  // 核心检测方法
  async detectBottlenecks(timeRange) {
    const bottlenecks = [];
    
    // 1. 数据库慢查询
    const slowQueries = await this.detectSlowDatabaseQueries(timeRange);
    bottlenecks.push(...slowQueries.map(q => ({
      type: 'database_slow_query',
      severity: q.duration > 5000 ? 'critical' : 'high',
      location: q.service,
      details: q,
      affectedUsers: q.callCount * q.avgUsersPerCall
    })));
    
    // 2. 外部 API 超时
    const apiTimeouts = await this.detectAPITimeouts(timeRange);
    bottlenecks.push(...apiTimeouts);
    
    // 3. 内存压力
    const memoryIssues = await this.detectMemoryPressure(timeRange);
    bottlenecks.push(...memoryIssues);
    
    // 4. CPU 瓶颈
    const cpuBottlenecks = await this.detectCPUBottlenecks(timeRange);
    bottlenecks.push(...cpuBottlenecks);
    
    return bottlenecks.sort((a, b) => 
      this.severityWeight(b.severity) - this.severityWeight(a.severity)
    );
  }
  
  // 检测数据库慢查询
  async detectSlowDatabaseQueries(timeRange) {
    const traces = await this.traceAnalyzer.getTraces({
      operation: 'db.query',
      minDuration: 1000, // 1 秒
      timeRange
    });
    
    return traces.map(trace => ({
      service: trace.serviceName,
      query: trace.tags.query,
      duration: trace.duration,
      callCount: trace.callCount,
      avgUsersPerCall: trace.avgUsersPerCall
    }));
  }
}
```

### 4.4 BusinessImpactCalculator 业务影响计算器

```javascript
class BusinessImpactCalculator {
  // 计算业务影响
  async calculateImpact(bottleneck) {
    const impact = {
      affectedUsers: 0,
      affectedRequests: 0,
      revenueImpact: 0,
      userExperienceScore: 0,
      businessMetrics: {}
    };
    
    // 1. 计算受影响用户数
    impact.affectedUsers = await this.getAffectedUsers(bottleneck);
    
    // 2. 计算受影响请求数
    impact.affectedRequests = await this.getAffectedRequests(bottleneck);
    
    // 3. 计算收入影响（支付相关）
    if (this.isPaymentRelated(bottleneck)) {
      impact.revenueImpact = await this.calculateRevenueImpact(bottleneck);
    }
    
    // 4. 用户体验评分（0-100）
    impact.userExperienceScore = await this.calculateUXScore(bottleneck);
    
    // 5. 关联业务指标
    impact.businessMetrics = await this.getRelatedBusinessMetrics(bottleneck);
    
    return impact;
  }
  
  // 用户体验评分
  async calculateUXScore(bottleneck) {
    const baseScore = 100;
    
    // 延迟影响
    if (bottleneck.duration > 5000) baseScore -= 40;
    else if (bottleneck.duration > 2000) baseScore -= 20;
    else if (bottleneck.duration > 1000) baseScore -= 10;
    
    // 错误率影响
    if (bottleneck.errorRate > 0.1) baseScore -= 30;
    else if (bottleneck.errorRate > 0.05) baseScore -= 20;
    else if (bottleneck.errorRate > 0.01) baseScore -= 10;
    
    // 受影响用户数影响
    if (bottleneck.affectedUsers > 1000) baseScore -= 20;
    else if (bottleneck.affectedUsers > 100) baseScore -= 10;
    
    return Math.max(0, baseScore);
  }
}
```

### 4.5 RootCauseRecommender 根因推荐引擎

```javascript
class RootCauseRecommender {
  // 历史根因知识库
  historicalRootCauses: [
    {
      pattern: { service: 'user-service', operation: 'db.query', duration: '>5000' },
      rootCauses: [
        { cause: 'missing_index', probability: 0.7, fix: 'Add index on users.email' },
        { cause: 'connection_pool_exhaustion', probability: 0.2, fix: 'Increase pool size' }
      ]
    },
    {
      pattern: { service: 'gateway', operation: 'http.request', errorRate: '>0.05' },
      rootCauses: [
        { cause: 'downstream_timeout', probability: 0.6, fix: 'Check downstream service health' },
        { cause: 'circuit_breaker_open', probability: 0.3, fix: 'Review circuit breaker config' }
      ]
    }
  ]
  
  // 推荐根因
  async recommendRootCause(bottleneck) {
    const recommendations = [];
    
    // 1. 模式匹配
    for (const historical of this.historicalRootCauses) {
      if (this.matchesPattern(bottleneck, historical.pattern)) {
        recommendations.push(...historical.rootCauses);
      }
    }
    
    // 2. 基于相似 trace 的分析
    const similarTraces = await this.findSimilarTraces(bottleneck);
    if (similarTraces.length > 0) {
      const pastFixes = await this.extractPastFixes(similarTraces);
      recommendations.push(...pastFixes);
    }
    
    // 3. 规则引擎推荐
    const ruleBasedRecommendations = await this.applyRules(bottleneck);
    recommendations.push(...ruleBasedRecommendations);
    
    // 去重并排序
    return this.deduplicateAndSort(recommendations);
  }
  
  // 提取历史修复
  async extractPastFixes(similarTraces) {
    const fixes = [];
    for (const trace of similarTraces) {
      if (trace.fix) {
        fixes.push({
          cause: trace.diagnosedCause,
          probability: trace.fixSuccessRate,
          fix: trace.fix,
          reference: trace.traceId
        });
      }
    }
    return fixes;
  }
}
```

### 4.6 AdaptiveThresholdManager 自适应阈值管理器

```javascript
class AdaptiveThresholdManager {
  // 自适应阈值配置
  thresholds: {
    slowTrace: {
      base: 2000,  // ms
      adaptive: true,
      windowSize: 3600  // 1 小时窗口
    },
    errorRate: {
      base: 0.05,
      adaptive: true,
      sensitivity: 'medium'  // low, medium, high
    }
  }
  
  // 计算自适应阈值
  async calculateAdaptiveThreshold(metric, serviceName) {
    // 获取历史基线
    const baseline = await this.getBaseline(metric, serviceName);
    
    // 获取近期数据
    const recentData = await this.getRecentData(metric, serviceName, 3600);
    
    // 计算动态阈值
    const mean = recentData.reduce((a, b) => a + b, 0) / recentData.length;
    const stdDev = Math.sqrt(
      recentData.reduce((sq, n) => sq + Math.pow(n - mean, 2), 0) / recentData.length
    );
    
    // 基于 3-sigma 规则
    const adaptiveThreshold = mean + 3 * stdDev;
    
    // 与基线取最大值
    return Math.max(baseline, adaptiveThreshold);
  }
  
  // 更新历史基线
  async updateBaseline(metric, serviceName, value) {
    await db.query(`
      INSERT INTO baseline_thresholds (metric, service, value, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (metric, service) 
      DO UPDATE SET value = $3, updated_at = NOW()
    `, [metric, serviceName, value]);
  }
}
```

### 4.7 API 集成

```javascript
// 路由配置
router.get('/api/monitoring/traces/sampling-stats', async (req, res) => {
  const stats = await intelligentTraceSampler.getSamplingStats();
  res.json(stats);
});

router.get('/api/monitoring/bottlenecks', async (req, res) => {
  const bottlenecks = await performanceBottleneckDetector.detectBottlenecks(
    req.query.timeRange
  );
  res.json(bottlenecks);
});

router.get('/api/monitoring/bottlenecks/:id/impact', async (req, res) => {
  const bottleneck = await getBottleneck(req.params.id);
  const impact = await businessImpactCalculator.calculateImpact(bottleneck);
  res.json(impact);
});

router.get('/api/monitoring/bottlenecks/:id/recommendations', async (req, res) => {
  const bottleneck = await getBottleneck(req.params.id);
  const recommendations = await rootCauseRecommender.recommendRootCause(bottleneck);
  res.json(recommendations);
});
```

### 4.8 数据存储

```sql
-- 追踪采样策略表
CREATE TABLE trace_sampling_policies (
  id SERIAL PRIMARY KEY,
  policy_name VARCHAR(100) NOT NULL,
  service_pattern VARCHAR(255),
  operation_pattern VARCHAR(255),
  sampling_rate DECIMAL(5, 4) NOT NULL,
  priority INTEGER DEFAULT 0,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 性能瓶颈记录表
CREATE TABLE performance_bottlenecks (
  id SERIAL PRIMARY KEY,
  trace_id VARCHAR(255),
  bottleneck_type VARCHAR(50) NOT NULL,
  service_name VARCHAR(100) NOT NULL,
  operation VARCHAR(255),
  severity VARCHAR(20) NOT NULL, -- critical, high, medium, low
  duration_ms INTEGER,
  error_rate DECIMAL(5, 4),
  affected_users INTEGER,
  affected_requests INTEGER,
  business_impact JSONB,
  recommendations JSONB,
  resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- 基线阈值表
CREATE TABLE baseline_thresholds (
  id SERIAL PRIMARY KEY,
  metric VARCHAR(100) NOT NULL,
  service VARCHAR(100) NOT NULL,
  value DECIMAL(10, 4) NOT NULL,
  window_seconds INTEGER DEFAULT 3600,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(metric, service)
);

-- 索引
CREATE INDEX idx_trace_sampling_policies_priority ON trace_sampling_policies(priority DESC);
CREATE INDEX idx_performance_bottlenecks_created ON performance_bottlenecks(created_at DESC);
CREATE INDEX idx_performance_bottlenecks_severity ON performance_bottlenecks(severity, created_at DESC);
```

## 5. 验收标准（可测试）

- [ ] **智能采样功能**：错误 trace 采样率 100%，慢 trace 采样率 100%，正常 trace 采样率可动态调整（默认 1%）
- [ ] **存储成本降低**：追踪数据存储量减少至少 70%（对比全量采样）
- [ ] **瓶颈检测准确性**：能准确识别数据库慢查询、API 超时、内存压力、CPU 瓶颈等 5 种以上瓶颈类型
- [ ] **业务影响计算**：能准确计算受影响用户数、请求数、用户体验评分（误差 < 10%）
- [ ] **根因推荐准确性**：推荐的前 3 个根因中至少 1 个正确的概率 > 80%
- [ ] **自适应阈值功能**：阈值能根据历史数据自动调整，波动范围在基线的 ±30% 以内
- [ ] **API 可用性**：所有监控 API 响应时间 < 500ms（P95）
- [ ] **集成测试**：与现有 OpenTelemetry 追踪系统无缝集成，不影响原有追踪功能
- [ ] **单元测试覆盖**：核心模块测试覆盖率 > 85%

## 6. 工作量估算

**规模**：L（大型）

**理由**：
- 涉及 6 个核心模块设计和实现
- 需要与现有 OpenTelemetry、性能分析框架（REQ-00502）深度集成
- 需要设计智能采样算法、根因推荐引擎、自适应阈值算法
- 需要处理大规模追踪数据（日均 5M+ traces）
- 需要设计数据库表和索引优化

## 7. 优先级理由

**P1 理由**：
1. **生产可用关键路径**：追踪数据存储成本是生产环境的重要考量，智能采样可显著降低成本
2. **性能问题定位效率**：自动诊断可大幅缩短问题定位时间（从小时级到分钟级）
3. **业务价值明确**：业务影响量化让技术团队和管理层对性能问题的价值达成共识
4. **依赖已就绪**：REQ-00480（日志异常检测）、REQ-00502（性能分析框架）已完成
5. **可观测性完善**：这是可观测性体系的关键补充，使监控从"被动告警"到"主动诊断"