# REQ-00087：混沌工程与故障注入测试系统

- **编号**：REQ-00087
- **类别**：容灾/高可用
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared、infrastructure/k8s、backend/tests/chaos
- **创建时间**：2026-06-10 10:00
- **依赖需求**：REQ-00014（熔断器）、REQ-00068（降级管理器）、REQ-00061（健康仪表板）

## 1. 背景与问题

mineGo 项目已实现熔断器（REQ-00014）、降级管理器（REQ-00068）、多区域容灾（REQ-00041）等容灾机制，但缺乏主动验证这些机制是否有效工作的手段。当前问题：

1. **被动发现问题**：只有在真实故障发生时才能发现容灾机制失效，风险高
2. **缺乏韧性验证**：无法量化系统对各类故障的容忍能力
3. **测试覆盖不足**：现有测试主要覆盖正常路径，故障路径测试不足
4. **生产信心不足**：无法在类生产环境验证故障恢复能力

混沌工程通过主动注入故障，在受控环境下验证系统韧性，是提升系统可靠性的最佳实践。

## 2. 目标

建立完整的混沌工程与故障注入测试系统，实现：

1. **故障注入能力**：支持网络延迟/丢包、服务宕机、资源耗尽、数据库故障等多种故障类型
2. **自动化实验**：定期自动运行混沌实验，验证容灾机制有效性
3. **安全护栏**：实验过程中自动检测并终止影响过大的实验
4. **韧性评分**：量化系统韧性指标，跟踪改进趋势
5. **生产就绪**：支持在类生产环境安全运行混沌实验

预期收益：
- 容灾机制有效性验证覆盖率 90%+
- 故障发现时间从被动等待变为主动验证（每周/每月）
- 系统韧性可量化，支持持续改进

## 3. 范围

- **包含**：
  - 故障注入引擎（网络、服务、资源、数据库故障）
  - 混沌实验编排与调度
  - 安全护栏与自动终止机制
  - 韧性指标收集与评分系统
  - 实验报告与历史追踪
  - 与现有熔断器、降级管理器集成
  - K8s 环境故障注入支持

- **不包含**：
  - 生产环境混沌实验（仅限测试/预发布环境）
  - 真实用户流量影响
  - 第三方服务故障注入

## 4. 详细需求

### 4.1 故障注入引擎

```javascript
// backend/shared/chaos/FaultInjector.js
class FaultInjector {
  // 网络故障
  async injectNetworkDelay(target, delayMs, duration) {}
  async injectNetworkLoss(target, lossRate, duration) {}
  async injectNetworkPartition(source, target, duration) {}
  
  // 服务故障
  async injectServiceCrash(serviceName) {}
  async injectServiceError(serviceName, errorRate, errorType) {}
  async injectServiceLatency(serviceName, latencyMs) {}
  
  // 资源故障
  async injectCPUStress(target, utilization, duration) {}
  async injectMemoryStress(target, utilization, duration) {}
  async injectDiskStress(target, utilization, duration) {}
  
  // 数据库故障
  async injectDBConnectionFailure(dbName) {}
  async injectDBQueryDelay(dbName, delayMs) {}
  async injectDBQueryError(dbName, errorRate) {}
}
```

### 4.2 混沌实验定义

```javascript
// backend/tests/chaos/experiments/index.js
const experiments = {
  // 实验 1：网关服务宕机恢复验证
  gatewayCrashRecovery: {
    name: 'Gateway Crash Recovery',
    description: '验证网关服务宕机后自动恢复与流量切换',
    target: 'gateway',
    faults: [
      { type: 'serviceCrash', service: 'gateway' }
    ],
    assertions: [
      { metric: 'recoveryTime', operator: '<', value: 30000 }, // 30秒内恢复
      { metric: 'errorRate', operator: '<', value: 0.05 },     // 错误率 < 5%
      { metric: 'circuitBreakerTriggered', operator: '=', value: true }
    ],
    guardrails: {
      maxErrorRate: 0.1,        // 错误率超过 10% 终止
      maxRecoveryTime: 60000,   // 恢复时间超过 60s 终止
      affectedUsers: 100        // 影响用户超过 100 终止
    }
  },
  
  // 实验 2：数据库连接池耗尽验证
  dbPoolExhaustion: {
    name: 'Database Pool Exhaustion',
    description: '验证数据库连接池耗尽时的降级行为',
    target: 'database',
    faults: [
      { type: 'dbConnectionFailure', db: 'postgres' }
    ],
    assertions: [
      { metric: 'fallbackTriggered', operator: '=', value: true },
      { metric: 'degradedServiceAvailable', operator: '=', value: true }
    ]
  },
  
  // 实验 3：网络延迟验证
  networkLatency: {
    name: 'Network Latency Tolerance',
    description: '验证系统对网络延迟的容忍能力',
    target: 'network',
    faults: [
      { type: 'networkDelay', delay: 500, target: 'pokemon-service' }
    ],
    assertions: [
      { metric: 'timeoutRetryCount', operator: '>', value: 0 },
      { metric: 'circuitBreakerState', operator: '=', value: 'half-open' }
    ]
  }
};
```

### 4.3 安全护栏机制

```javascript
// backend/shared/chaos/Guardrail.js
class Guardrail {
  // 实验前检查
  async preExperimentCheck(experiment) {
    // 1. 确认目标服务健康
    // 2. 确认没有其他正在进行的实验
    // 3. 确认环境允许混沌实验
    // 4. 确认监控和告警系统正常
  }
  
  // 实验中监控
  async monitorExperiment(experiment) {
    const monitors = [
      this.monitorErrorRate(experiment),
      this.monitorRecoveryTime(experiment),
      this.monitorAffectedUsers(experiment),
      this.monitorSystemHealth(experiment)
    ];
    
    // 任一指标超阈值立即终止实验
    await Promise.race(monitors);
  }
  
  // 自动终止
  async terminateExperiment(experiment, reason) {
    // 1. 移除所有故障注入
    // 2. 触发服务恢复
    // 3. 记录终止原因
    // 4. 发送告警通知
  }
}
```

### 4.4 韧性评分系统

```javascript
// backend/shared/chaos/ResilienceScore.js
const resilienceDimensions = {
  availability: { weight: 0.3, metrics: ['uptime', 'recoveryTime'] },
  faultTolerance: { weight: 0.25, metrics: ['errorRate', 'fallbackRate'] },
  recoverability: { weight: 0.25, metrics: ['recoveryTime', 'dataConsistency'] },
  degradation: { weight: 0.2, metrics: ['degradedServiceAvailable', 'gracefulDegradation'] }
};

// 计算韧性评分（0-100）
function calculateResilienceScore(experimentResults) {
  let totalScore = 0;
  for (const [dimension, config] of Object.entries(resilienceDimensions)) {
    const dimensionScore = calculateDimensionScore(experimentResults, config.metrics);
    totalScore += dimensionScore * config.weight;
  }
  return totalScore;
}
```

### 4.5 实验报告格式

```markdown
# 混沌实验报告 - {experimentName}

## 实验信息
- 实验名称：{name}
- 执行时间：{timestamp}
- 执行环境：{environment}
- 持续时间：{duration}

## 故障注入
| 故障类型 | 目标 | 参数 | 状态 |
|---------|------|------|------|
| serviceCrash | gateway | - | ✅ 成功 |

## 验证结果
| 断言 | 预期 | 实际 | 结果 |
|-----|------|------|------|
| recoveryTime < 30s | < 30000ms | 15234ms | ✅ 通过 |
| errorRate < 5% | < 0.05 | 0.023 | ✅ 通过 |

## 韧性评分
- 可用性：85/100
- 容错性：90/100
- 可恢复性：88/100
- 降级能力：92/100
- **总分：88.5/100**

## 安全护栏
- 最大错误率：10% (实际：2.3%) ✅
- 最大恢复时间：60s (实际：15s) ✅
- 影响用户：100 (实际：23) ✅

## 建议
- 熔断器触发时间可适当缩短
- 建议增加重试次数配置
```

### 4.6 K8s 集成

```yaml
# infrastructure/k8s/chaos/chaos-engine.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: chaos-engine
  namespace: chaos-testing
spec:
  template:
    spec:
      serviceAccountName: chaos-engine-sa
      containers:
      - name: chaos-engine
        image: minego/chaos-engine:latest
        env:
        - name: TARGET_NAMESPACE
          value: "staging"
        - name: GUARDRAIL_ENABLED
          value: "true"
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: chaos-engine-role
rules:
- apiGroups: [""]
  resources: ["pods", "services"]
  verbs: ["get", "list", "delete", "create"]
- apiGroups: ["networking.k8s.io"]
  resources: ["networkpolicies"]
  verbs: ["get", "list", "create", "delete"]
```

### 4.7 API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/chaos/experiments` | GET | 获取所有实验定义 |
| `/api/chaos/experiments/:name` | GET | 获取实验详情 |
| `/api/chaos/experiments/:name/run` | POST | 执行实验 |
| `/api/chaos/experiments/:name/stop` | POST | 终止实验 |
| `/api/chaos/results` | GET | 获取实验结果列表 |
| `/api/chaos/results/:id` | GET | 获取实验报告 |
| `/api/chaos/score` | GET | 获取韧性评分 |
| `/api/chaos/history` | GET | 获取实验历史 |

## 5. 验收标准（可测试）

- [ ] 故障注入引擎支持至少 10 种故障类型（网络延迟/丢包/分区、服务宕机/错误/延迟、CPU/内存/磁盘压力、数据库连接/查询故障）
- [ ] 混沌实验执行后自动生成完整报告，包含故障注入、验证结果、韧性评分
- [ ] 安全护栏在错误率超过阈值时自动终止实验（测试验证）
- [ ] 韧性评分系统输出 0-100 分数，包含 4 个维度评分
- [ ] 至少定义 5 个混沌实验场景（网关宕机、数据库故障、网络延迟、资源耗尽、服务错误）
- [ ] 所有混沌实验在测试环境成功执行并通过验证
- [ ] 与熔断器（REQ-00014）、降级管理器（REQ-00068）集成验证
- [ ] Prometheus 指标暴露混沌实验状态和韧性评分
- [ ] 单元测试覆盖核心逻辑，覆盖率 > 80%

## 6. 工作量估算

**XL** - 涉及故障注入引擎、安全护栏、韧性评分、K8s 集成、多个 API 端点，预计需要 3-4 天开发时间。

## 7. 优先级理由

P1 级别：混沌工程是验证容灾机制有效性的关键手段，直接影响系统可靠性。虽然已有熔断器和降级机制，但缺乏主动验证手段，无法确保这些机制在真实故障场景下正常工作。混沌工程填补了这一空白，是生产就绪的重要保障。
