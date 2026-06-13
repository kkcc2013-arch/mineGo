# REQ-00159：服务健康自愈与自动恢复系统

- **编号**：REQ-00159
- **类别**：容灾/高可用
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared、infrastructure/k8s
- **创建时间**：2026-06-13 10:05
- **依赖需求**：REQ-00061（服务健康仪表板与自动恢复）

## 1. 背景与问题

当前 mineGo 项目虽然实现了 Circuit Breaker、Fallback Strategy 和 Degradation Manager，但仍存在以下痛点：

1. **被动恢复**：服务崩溃后依赖 K8s 自动重启，但重启策略缺乏智能判断（如连续崩溃保护、崩溃窗口分析）
2. **健康检查粗粒度**：现有健康检查仅返回 HTTP 200，未检测依赖服务（DB、Redis、Kafka）的连通性
3. **故障传播延迟**：单个服务异常通过微服务链路传播，缺乏快速隔离机制
4. **恢复验证缺失**：服务重启后立即接收全量流量，未进行渐进式健康验证
5. **人工干预成本高**：故障诊断需要人工查看日志，缺乏自动化根因分析

当前代码中：
- `CircuitBreaker.js` 仅处理 HTTP 请求级别的熔断
- `DegradationManager.js` 提供降级策略，但缺乏自愈触发
- K8s 健康检查配置仅使用基本 `httpGet`，未检查依赖健康

## 2. 目标

构建智能服务健康自愈系统，实现：

1. **主动健康检测**：多层健康检查（自身 + 依赖服务），检测覆盖率达 100%
2. **智能自愈**：服务异常自动恢复，恢复成功率 ≥ 95%
3. **渐进式恢复**：服务重启后按流量百分比逐步恢复，降低二次故障风险
4. **故障隔离**：异常服务 30 秒内自动隔离，防止故障传播
5. **自动化根因分析**：故障发生后 5 分钟内生成诊断报告

预期收益：
- 服务平均恢复时间（MTTR）从 10 分钟降至 2 分钟
- 故障传播率降低 80%
- 人工干预率降低 70%

## 3. 范围

### 包含

1. **多层级健康检查系统**
   - HTTP 健康检查（/health/live、/health/ready）
   - 依赖服务健康检查（PostgreSQL、Redis、Kafka）
   - 资源健康检查（CPU、内存、磁盘、连接池）
   - 业务健康检查（关键业务指标监控）

2. **智能自愈引擎**
   - 崩溃模式识别（OOM、死锁、连接池耗尽）
   - 分级恢复策略（重启、重建连接、清理缓存、降级）
   - 崩溃保护（连续崩溃后进入安全模式）
   - 恢复验证（健康检查通过后才接收流量）

3. **故障隔离与路由控制**
   - 服务隔离标记（从服务发现中移除）
   - 流量控制（拒绝新请求，处理中请求继续）
   - 隔离通知（发送告警到监控系统）

4. **渐进式恢复系统**
   - 流量百分比控制（10% → 30% → 50% → 100%）
   - 健康度评分（基于错误率、延迟、资源使用）
   - 自动回滚（恢复期间异常立即回滚）

5. **自动化根因分析**
   - 日志分析（最近 1000 条日志）
   - 资源快照（崩溃前 CPU/内存曲线）
   - 依赖链路追踪（上游调用链）
   - 诊断报告生成（Markdown 格式）

### 不包含

- 跨机房故障转移（属于 REQ-00041 范围）
- 数据库主从切换（属于 REQ-00025 范围）
- 灰度发布系统（属于 REQ-00078 范围）
- 人工审批流程（纯自动化系统）

## 4. 详细需求

### 4.1 多层级健康检查

#### 4.1.1 健康检查端点规范

```javascript
// GET /health/live - 存活探针
{
  "status": "healthy" | "degraded" | "unhealthy",
  "uptime": 3600,
  "timestamp": "2026-06-13T10:00:00Z"
}

// GET /health/ready - 就绪探针
{
  "status": "ready" | "not_ready",
  "checks": {
    "database": { "status": "healthy", "latency_ms": 5 },
    "redis": { "status": "healthy", "latency_ms": 2 },
    "kafka": { "status": "healthy", "latency_ms": 10 },
    "resources": {
      "cpu_percent": 45,
      "memory_percent": 60,
      "disk_percent": 30
    }
  },
  "degradedServices": []
}
```

#### 4.1.2 健康检查实现

```javascript
// backend/shared/HealthChecker.js
class HealthChecker {
  constructor(config) {
    this.checks = new Map();
    this.criticalChecks = ['database', 'redis'];
    this.importantChecks = ['kafka', 'resources'];
  }
  
  // 注册健康检查
  register(name, checkFn, options = { critical: false, timeout: 5000 }) {
    this.checks.set(name, { checkFn, ...options });
  }
  
  // 执行所有检查
  async runAllChecks() {
    const results = {};
    for (const [name, config] of this.checks) {
      try {
        const start = Date.now();
        const result = await Promise.race([
          config.checkFn(),
          this.timeout(config.timeout)
        ]);
        results[name] = {
          status: 'healthy',
          latency_ms: Date.now() - start,
          ...result
        };
      } catch (error) {
        results[name] = {
          status: 'unhealthy',
          error: error.message
        };
      }
    }
    return this.calculateOverallStatus(results);
  }
  
  // 计算整体状态
  calculateOverallStatus(results) {
    const criticalUnhealthy = this.criticalChecks
      .some(name => results[name]?.status === 'unhealthy');
    
    if (criticalUnhealthy) {
      return { status: 'unhealthy', checks: results };
    }
    
    const importantUnhealthy = this.importantChecks
      .some(name => results[name]?.status === 'unhealthy');
    
    if (importantUnhealthy) {
      return { status: 'degraded', checks: results };
    }
    
    return { status: 'healthy', checks: results };
  }
}
```

### 4.2 智能自愈引擎

#### 4.2.1 崩溃模式识别

```javascript
// backend/shared/SelfHealingEngine.js
class SelfHealingEngine {
  constructor() {
    this.crashPatterns = {
      oom: {
        indicators: ['ENOMEM', 'out of memory', 'heap limit'],
        recovery: 'restart_with_memory_limit',
        cooldown: 60000
      },
      deadlock: {
        indicators: ['deadlock detected', 'lock wait timeout'],
        recovery: 'restart_with_connection_reset',
        cooldown: 30000
      },
      connection_pool_exhausted: {
        indicators: ['connection pool exhausted', 'ECONNREFUSED'],
        recovery: 'rebuild_connections',
        cooldown: 15000
      },
      redis_failure: {
        indicators: ['ECONNRESET', 'Redis connection lost'],
        recovery: 'reconnect_redis',
        cooldown: 10000
      }
    };
    
    this.crashHistory = [];
    this.maxHistorySize = 100;
  }
  
  // 分析崩溃原因
  analyzeCrash(errorLog, resourceSnapshot) {
    for (const [pattern, config] of Object.entries(this.crashPatterns)) {
      const matched = config.indicators.some(indicator =>
        errorLog.toLowerCase().includes(indicator.toLowerCase())
      );
      
      if (matched) {
        this.recordCrash(pattern, resourceSnapshot);
        return {
          pattern,
          recovery: config.recovery,
          confidence: this.calculateConfidence(pattern, resourceSnapshot)
        };
      }
    }
    
    return {
      pattern: 'unknown',
      recovery: 'restart',
      confidence: 0.5
    };
  }
  
  // 记录崩溃历史
  recordCrash(pattern, snapshot) {
    this.crashHistory.push({
      pattern,
      timestamp: Date.now(),
      snapshot
    });
    
    if (this.crashHistory.length > this.maxHistorySize) {
      this.crashHistory.shift();
    }
  }
  
  // 检查是否进入崩溃保护模式
  shouldEnterSafeMode() {
    const recentCrashes = this.crashHistory.filter(
      c => Date.now() - c.timestamp < 300000 // 5 分钟内
    );
    
    if (recentCrashes.length >= 3) {
      return {
        enter: true,
        reason: `连续崩溃 ${recentCrashes.length} 次，进入安全模式`,
        pattern: recentCrashes[0].pattern
      };
    }
    
    return { enter: false };
  }
}
```

#### 4.2.2 分级恢复策略

```javascript
// backend/shared/RecoveryStrategy.js
class RecoveryStrategy {
  constructor() {
    this.strategies = {
      restart: async (service) => {
        await this.gracefulShutdown(service);
        await this.waitForCleanup(5000);
        return this.startService(service);
      },
      
      restart_with_memory_limit: async (service) => {
        const currentLimit = service.config.memoryLimit || 512;
        const newLimit = Math.min(currentLimit * 1.5, 2048);
        service.config.memoryLimit = newLimit;
        await this.restart(service);
        return { memoryLimit: newLimit };
      },
      
      restart_with_connection_reset: async (service) => {
        await this.closeAllConnections(service);
        await this.restart(service);
        return { connectionsReset: true };
      },
      
      rebuild_connections: async (service) => {
        await service.dbPool.end();
        await service.redisClient.quit();
        service.dbPool = await this.createDbPool(service.config.db);
        service.redisClient = await this.createRedisClient(service.config.redis);
        return { connectionsRebuilt: true };
      },
      
      reconnect_redis: async (service) => {
        await service.redisClient.quit();
        service.redisClient = await this.createRedisClient(service.config.redis);
        return { redisReconnected: true };
      }
    };
  }
  
  async execute(strategyName, service) {
    const strategy = this.strategies[strategyName];
    if (!strategy) {
      throw new Error(`Unknown recovery strategy: ${strategyName}`);
    }
    
    const startTime = Date.now();
    try {
      const result = await strategy(service);
      return {
        success: true,
        strategy: strategyName,
        duration_ms: Date.now() - startTime,
        result
      };
    } catch (error) {
      return {
        success: false,
        strategy: strategyName,
        duration_ms: Date.now() - startTime,
        error: error.message
      };
    }
  }
}
```

### 4.3 故障隔离与路由控制

#### 4.3.1 服务隔离管理器

```javascript
// backend/shared/ServiceIsolationManager.js
class ServiceIsolationManager {
  constructor(serviceRegistry) {
    this.registry = serviceRegistry;
    this.isolatedServices = new Map();
  }
  
  // 隔离服务
  async isolate(serviceName, reason) {
    this.isolatedServices.set(serviceName, {
      isolatedAt: Date.now(),
      reason,
      status: 'isolated'
    });
    
    // 从服务发现中移除
    await this.registry.deregister(serviceName);
    
    // 发送隔离通知
    await this.notifyIsolation(serviceName, reason);
    
    // 设置隔离超时（10 分钟）
    setTimeout(() => {
      this.autoRecover(serviceName);
    }, 600000);
  }
  
  // 恢复服务
  async recover(serviceName) {
    const isolation = this.isolatedServices.get(serviceName);
    if (!isolation) {
      return { success: false, reason: 'Service not isolated' };
    }
    
    // 重新注册到服务发现
    await this.registry.register(serviceName);
    
    this.isolatedServices.delete(serviceName);
    
    await this.notifyRecovery(serviceName, isolation);
    
    return { success: true, downtime_ms: Date.now() - isolation.isolatedAt };
  }
  
  // 自动恢复尝试
  async autoRecover(serviceName) {
    const isolation = this.isolatedServices.get(serviceName);
    if (!isolation || isolation.status !== 'isolated') {
      return;
    }
    
    // 执行健康检查
    const health = await this.checkHealth(serviceName);
    
    if (health.status === 'healthy') {
      await this.recover(serviceName);
    } else {
      // 延长隔离时间
      setTimeout(() => this.autoRecover(serviceName), 60000);
    }
  }
}
```

### 4.4 渐进式恢复系统

#### 4.4.1 流量控制器

```javascript
// backend/shared/TrafficGradualRecovery.js
class TrafficGradualRecovery {
  constructor() {
    this.recoveryStages = [
      { percent: 10, duration: 60000, healthThreshold: 0.95 },
      { percent: 30, duration: 120000, healthThreshold: 0.90 },
      { percent: 50, duration: 180000, healthThreshold: 0.85 },
      { percent: 100, duration: 0, healthThreshold: 0.80 }
    ];
    
    this.activeRecoveries = new Map();
  }
  
  // 启动渐进式恢复
  async startRecovery(serviceName, initialHealth) {
    const recovery = {
      serviceName,
      startTime: Date.now(),
      currentStage: 0,
      healthHistory: [initialHealth],
      status: 'recovering'
    };
    
    this.activeRecoveries.set(serviceName, recovery);
    
    await this.applyStage(serviceName, 0);
    this.scheduleNextStage(serviceName);
  }
  
  // 应用流量百分比
  async applyStage(serviceName, stageIndex) {
    const stage = this.recoveryStages[stageIndex];
    const recovery = this.activeRecoveries.get(serviceName);
    
    // 更新路由权重
    await this.updateTrafficWeight(serviceName, stage.percent);
    
    recovery.currentStage = stageIndex;
    recovery.currentPercent = stage.percent;
    
    this.log(`Service ${serviceName} now receiving ${stage.percent}% traffic`);
  }
  
  // 调度下一阶段
  scheduleNextStage(serviceName) {
    const recovery = this.activeRecoveries.get(serviceName);
    const stage = this.recoveryStages[recovery.currentStage];
    
    setTimeout(async () => {
      const health = await this.checkHealth(serviceName);
      recovery.healthHistory.push(health);
      
      // 健康度达标，进入下一阶段
      if (health.score >= stage.healthThreshold) {
        if (recovery.currentStage < this.recoveryStages.length - 1) {
          await this.applyStage(serviceName, recovery.currentStage + 1);
          this.scheduleNextStage(serviceName);
        } else {
          this.completeRecovery(serviceName);
        }
      } else {
        // 健康度不达标，回滚
        await this.rollback(serviceName);
      }
    }, stage.duration);
  }
  
  // 回滚恢复
  async rollback(serviceName) {
    const recovery = this.activeRecoveries.get(serviceName);
    
    // 恢复到上一个阶段
    if (recovery.currentStage > 0) {
      await this.applyStage(serviceName, recovery.currentStage - 1);
      this.log(`Service ${serviceName} rolled back to stage ${recovery.currentStage - 1}`);
    } else {
      // 完全隔离
      await this.isolate(serviceName, 'Health check failed during recovery');
    }
  }
}
```

### 4.5 自动化根因分析

#### 4.5.1 诊断报告生成器

```javascript
// backend/shared/RootCauseAnalyzer.js
class RootCauseAnalyzer {
  constructor() {
    this.logBufferSize = 1000;
    this.metricsWindowSize = 3600000; // 1 小时
  }
  
  // 生成诊断报告
  async generateReport(serviceName, crashTime) {
    const [logs, metrics, traces, dependencies] = await Promise.all([
      this.fetchRecentLogs(serviceName, crashTime),
      this.fetchResourceMetrics(serviceName, crashTime),
      this.fetchTraces(serviceName, crashTime),
      this.analyzeDependencies(serviceName, crashTime)
    ]);
    
    const report = {
      service: serviceName,
      crashTime: crashTime,
      generatedAt: new Date().toISOString(),
      
      summary: {
        rootCause: this.identifyRootCause(logs, metrics),
        severity: this.assessSeverity(logs, metrics),
        affectedUsers: await this.estimateAffectedUsers(serviceName, crashTime)
      },
      
      timeline: this.buildTimeline(logs, metrics, crashTime),
      
      resourceSnapshot: {
        cpu: metrics.cpu.slice(-10),
        memory: metrics.memory.slice(-10),
        connections: metrics.connections.slice(-10)
      },
      
      errorAnalysis: {
        errorCount: this.countErrors(logs),
        errorTypes: this.categorizeErrors(logs),
        sampleErrors: this.extractSampleErrors(logs, 5)
      },
      
      dependencyHealth: dependencies,
      
      recommendations: this.generateRecommendations(logs, metrics, dependencies)
    };
    
    // 保存报告
    await this.saveReport(report);
    
    // 发送通知
    await this.notifyTeam(report);
    
    return report;
  }
  
  // 识别根因
  identifyRootCause(logs, metrics) {
    // 分析日志中的错误模式
    const errorPatterns = this.extractErrorPatterns(logs);
    
    // 检查资源指标
    const resourceIssues = this.detectResourceIssues(metrics);
    
    // 关联分析
    if (resourceIssues.memory > 90 && errorPatterns.includes('ENOMEM')) {
      return {
        type: 'memory_exhaustion',
        confidence: 0.95,
        evidence: `内存使用率 ${resourceIssues.memory}%，发现 OOM 错误`
      };
    }
    
    if (resourceIssues.connections > 80 && errorPatterns.includes('ECONNREFUSED')) {
      return {
        type: 'connection_pool_exhaustion',
        confidence: 0.90,
        evidence: `连接池使用率 ${resourceIssues.connections}%，发现连接拒绝错误`
      };
    }
    
    // 默认返回
    return {
      type: 'unknown',
      confidence: 0.50,
      evidence: '无法确定具体根因，建议人工分析'
    };
  }
  
  // 生成推荐建议
  generateRecommendations(logs, metrics, dependencies) {
    const recommendations = [];
    
    const rootCause = this.identifyRootCause(logs, metrics);
    
    switch (rootCause.type) {
      case 'memory_exhaustion':
        recommendations.push({
          priority: 'P0',
          action: '增加容器内存限制',
          details: '当前内存不足，建议增加至 1.5 倍'
        });
        recommendations.push({
          priority: 'P1',
          action: '检查内存泄漏',
          details: '分析内存增长曲线，排查泄漏点'
        });
        break;
        
      case 'connection_pool_exhaustion':
        recommendations.push({
          priority: 'P0',
          action: '扩大连接池',
          details: '当前连接池配置不足以支撑负载'
        });
        recommendations.push({
          priority: 'P1',
          action: '优化连接复用',
          details: '检查是否有连接未正确释放'
        });
        break;
        
      default:
        recommendations.push({
          priority: 'P1',
          action: '人工分析',
          details: '自动分析无法确定根因，建议人工介入'
        });
    }
    
    return recommendations;
  }
}
```

### 4.6 K8s 集成

#### 4.6.1 健康检查配置

```yaml
# infrastructure/k8s/services/user-service-deployment.yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 8081
  initialDelaySeconds: 30
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health/ready
    port: 8081
  initialDelaySeconds: 5
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 3

# 启动探针，防止启动期间被杀死
startupProbe:
  httpGet:
    path: /health/live
    port: 8081
  initialDelaySeconds: 10
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 30
```

#### 4.6.2 Pod 中断预算

```yaml
# infrastructure/k8s/services/pod-disruption-budget.yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: user-service-pdb
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: user-service
```

## 5. 验收标准（可测试）

- [ ] **健康检查覆盖**
  - 所有服务实现 `/health/live` 和 `/health/ready` 端点
  - 健康检查覆盖 PostgreSQL、Redis、Kafka 连通性
  - 健康检查覆盖 CPU、内存、磁盘资源

- [ ] **自愈能力**
  - OOM 崩溃后自动重启并调整内存限制
  - 连接池耗尽后自动重建连接池
  - Redis 连接断开后自动重连
  - 连续崩溃 3 次进入安全模式

- [ ] **故障隔离**
  - 异常服务 30 秒内从服务发现中移除
  - 隔离服务不再接收新请求
  - 隔离后 10 分钟自动尝试恢复

- [ ] **渐进式恢复**
  - 服务恢复后按 10% → 30% → 50% → 100% 逐步增加流量
  - 健康度低于阈值时自动回滚到上一阶段
  - 恢复过程可监控（提供 API 查询恢复状态）

- [ ] **根因分析**
  - 崩溃后 5 分钟内生成诊断报告
  - 报告包含资源快照、错误分析、推荐建议
  - 报告自动保存到 `logs/diagnostics/` 目录

- [ ] **监控集成**
  - 所有健康检查指标上报 Prometheus
  - 自愈事件发送到 Grafana 仪表板
  - 隔离/恢复事件发送告警通知

## 6. 工作量估算

**L（Large）** - 约 8-12 人日

理由：
- 需要实现 5 个核心模块（健康检查、自愈引擎、隔离管理、渐进恢复、根因分析）
- 需要改造所有 9 个微服务，添加健康检查端点
- 需要更新 K8s 配置，添加探针和 PDB
- 需要大量测试（崩溃模拟、恢复验证、隔离测试）
- 需要与现有监控系统（Prometheus、Grafana）集成

## 7. 优先级理由

**P1 优先级**：

1. **影响可用性**：服务崩溃后恢复时间长（当前平均 10 分钟），影响用户体验
2. **降低运维成本**：自动恢复减少人工干预 70%，显著降低运维负担
3. **防止故障传播**：快速隔离异常服务，避免级联故障
4. **提升 MTTR**：从 10 分钟降至 2 分钟，显著提升系统可用性
5. **依赖基础**：其他容灾能力（如流量切换、灰度发布）依赖于健康的服务状态

如果服务频繁崩溃且无法快速恢复，整个系统将处于不稳定状态，因此这是"项目可用"的关键需求。

## 8. 实现优先级

1. **Phase 1（核心）**：健康检查系统 + 基础自愈（重启策略）
2. **Phase 2（进阶）**：智能自愈引擎 + 崩溃模式识别
3. **Phase 3（完整）**：故障隔离 + 渐进式恢复 + 根因分析

建议先实现 Phase 1，验证效果后再逐步完善。
