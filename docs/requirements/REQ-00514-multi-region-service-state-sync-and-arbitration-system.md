# REQ-00514：多区域服务状态同步与智能仲裁系统

- **编号**：REQ-00514
- **类别**：容灾/高可用
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gateway、infrastructure/k8s/multi-region、backend/shared/FailoverController.js、backend/shared/ReplicationMonitor.js、Redis、Kafka
- **创建时间**：2026-07-08 21:00
- **依赖需求**：REQ-00375（多区域灾备自动化切换系统）、REQ-00510（部署健康检查系统）

## 1. 背景与问题

当前项目已实现多区域灾备自动化切换系统（REQ-00375）和生产部署健康检查系统（REQ-00510），具备：
- `FailoverController.js` - 灾备切换控制器
- `ReplicationMonitor.js` - 数据复制监控
- `infrastructure/k8s/dr/disaster-recovery.yaml` - 灾备配置
- `infrastructure/k8s/multi-region/` - 多区域配置

**现有痛点：**
1. 各区域服务健康状态缺乏统一仲裁机制，切换决策依赖单一阈值判断
2. 部分服务故障（如某区域 Redis 单节点故障）可能触发不必要的全局切换
3. 缺乏"降级优先"策略，小故障直接触发灾备切换而非局部修复
4. 多区域状态同步延迟导致仲裁信息不一致，可能出现"脑裂"
5. 缺乏服务依赖拓扑分析，无法智能判断故障传播链路

## 2. 目标

建立多区域服务状态智能仲裁系统，实现：
- 统一的服务健康状态收集与同步机制（延迟 < 500ms）
- 智能仲裁引擎，区分"局部故障"和"全局故障"
- "降级优先"策略：局部故障优先尝试修复，避免不必要的全局切换
- 服务依赖拓扑分析，智能判断故障传播影响
- 防脑裂机制：分布式锁 + 多节点投票决策

## 3. 范围

- **包含**：
  - MultiRegionStateCollector - 多区域状态收集器
  - ServiceDependencyAnalyzer - 服务依赖拓扑分析器
  - ArbitrationEngine - 智能仲裁引擎（局部故障 vs 全局故障）
  - DegradationFirstPolicy - 降级优先策略执行器
  - SplitBrainPrevention - 防脑裂机制（Redis 分布式锁 + 投票）
  - ArbitrationDecisionLogger - 仲裁决策日志与审计

- **不包含**：
  - 灾备切换执行逻辑（已有 FailoverController）
  - 数据复制机制（已有 ReplicationMonitor）
  - 健康检查逻辑（已有 DeploymentHealthVerifier）

## 4. 详细需求

### 4.1 MultiRegionStateCollector 状态收集器

```javascript
class MultiRegionStateCollector {
  // 配置
  regions: ['primary', 'secondary', 'backup']
  syncIntervalMs: 500  // 状态同步间隔
  heartbeatTimeoutMs: 3000
  
  // 核心方法
  async collectRegionHealth(region) // 收集单区域健康状态
  async syncStateToAllRegions() // 广播状态到所有区域
  async getStateSnapshot() // 获取全局状态快照
  
  // 状态结构
  stateSnapshot: {
    timestamp: ISO8601,
    regions: {
      primary: { healthy: bool, services: {...}, latency: ms },
      secondary: { healthy: bool, services: {...}, latency: ms },
      backup: { healthy: bool, services: {...}, latency: ms }
    },
    arbitrationLocked: bool, // 是否正在仲裁
    activeRegion: string // 当前活跃区域
  }
}
```

### 4.2 ServiceDependencyAnalyzer 服务依赖分析器

```javascript
class ServiceDependencyAnalyzer {
  // 服务依赖拓扑（从配置加载）
  topology: {
    gateway: ['user', 'pokemon', 'catch', 'gym', 'social', 'reward', 'payment'],
    catch: ['pokemon', 'location', 'reward'],
    gym: ['pokemon', 'social'],
    payment: ['reward', 'user']
    // ...
  }
  
  // 核心方法
  analyzeImpactChain(failedService) // 分析故障传播链
  getAffectedServices(region, service) // 获取受影响服务列表
  calculateSeverity(region, service) // 计算故障严重度 (0-100)
}
```

### 4.3 ArbitrationEngine 智能仲裁引擎

```javascript
class ArbitrationEngine {
  // 仲裁规则
  rules: {
    localFault: { // 局部故障：单服务/单节点
      threshold: 30, // 严重度 < 30 视为局部
      action: 'degradation' // 降级而非切换
    },
    regionalFault: { // 区域故障：多服务/多节点
      threshold: 60,
      action: 'regional_switch' // 区域内切换
    },
    globalFault: { // 全局故障：核心服务全区域故障
      threshold: 80,
      action: 'failover' // 全局灾备切换
    }
  }
  
  // 核心方法
  async arbitrate(stateSnapshot) // 执行仲裁决策
  classifyFault(region, service) // 分类故障类型
  generateDecision(faultType, severity) // 生成决策
  executeDecision(decision) // 执行决策
}
```

### 4.4 DegradationFirstPolicy 降级优先策略

```javascript
class DegradationFirstPolicy {
  // 降级策略配置
  strategies: {
    redis_single_node: { // Redis 单节点故障
      action: 'switch_to_replica',
      timeout: 30s, // 30秒尝试修复
      fallback: 'regional_failover'
    },
    database_connection_pool: { // DB 连接池故障
      action: 'reduce_connections',
      timeout: 60s,
      fallback: 'regional_failover'
    },
    kafka_partition: { // Kafka 分区故障
      action: 'rebalance',
      timeout: 45s,
      fallback: 'global_failover'
    }
  }
  
  // 核心方法
  async tryLocalFix(region, fault) // 尝试局部修复
  async escalateIfNeeded() // 修复失败后升级
}
```

### 4.5 SplitBrainPrevention 防脑裂机制

```javascript
class SplitBrainPrevention {
  // 分布式锁（Redis RedLock）
  lockKey: 'minego:arbitration:lock'
  lockTimeoutMs: 10000
  quorum: 3 // 需要 3/5 区域同意
  
  // 核心方法
  async acquireArbitrationLock() // 获取仲裁锁
  async voteForSwitch(decision) // 多区域投票
  async checkQuorum(votes) // 检查是否达成共识
  async releaseLock() // 释放锁
}
```

## 5. 验收标准（可测试）

- [ ] 状态同步延迟 < 500ms（所有区域状态快照一致性）
- [ ] 局部故障（Redis 单节点）触发降级而非全局切换（测试用例验证）
- [ ] 区域故障（多服务故障）触发区域内切换而非全局切换
- [ ] 全局故障（gateway 全区域故障）在 30 秒内触发全局灾备切换
- [ ] 防脑裂机制验证：并发仲裁请求只有一个成功执行
- [ ] 单元测试覆盖：状态收集器、依赖分析器、仲裁引擎各 10+ 用例
- [ ] 集成测试：模拟多区域故障场景，验证决策正确性

## 6. 工作量估算

L（Large）
- 需要设计分布式状态同步机制
- 智能仲裁引擎需要复杂的规则配置
- 防脑裂机制需要 RedLock 实现
- 与现有 FailoverController 集成

## 7. 优先级理由

P1 级别：
- 多区域灾备已实现（REQ-00375），但缺乏智能仲裁会导致误切换
- 误切换可能造成不必要的业务中断
- 防脑裂是生产环境高可用基础设施的必要保障
- 对项目"生产可用"贡献显著