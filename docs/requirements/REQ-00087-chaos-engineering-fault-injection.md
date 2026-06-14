# REQ-00087：混沌工程与故障注入测试系统

- **编号**：REQ-00087
- **类别**：容灾/高可用
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gateway、所有微服务、backend/shared、infrastructure/k8s、backend/tests/chaos
- **创建时间**：2026-06-10 10:00
- **依赖需求**：REQ-00014（服务熔断与降级机制）

## 1. 背景与问题

mineGo 作为生产级 AR 手游后端，需要具备强大的容灾能力。当前虽然已实现熔断、降级、健康检查等机制，但缺乏系统性的故障验证手段：

1. **故障场景未验证**：熔断、降级逻辑在真实故障下是否生效未经验证
2. **恢复能力未知**：服务恢复后的数据一致性、状态恢复能力未经测试
3. **级联风险**：微服务间的故障传播路径和影响范围不明确
4. **演练成本高**：手动故障注入耗时且风险大，缺乏自动化演练工具

混沌工程通过受控的故障注入，主动发现系统弱点，验证容灾机制有效性。

## 2. 目标

构建完整的混沌工程测试系统，实现：
1. 自动化故障注入（网络延迟、服务宕机、资源耗尽等）
2. 实验场景编排与自动化执行
3. 系统稳态验证与回归检测
4. 故障影响分析与报告生成

## 3. 范围

- **包含**：
  - ChaosEngine 核心引擎
  - FaultInjector 故障注入器（网络、进程、资源、数据）
  - ChaosExperiment 实验编排器
  - SteadyStateValidator 稳态验证器
  - ChaosReport 分析报告生成
  - K8s Chaos Mesh 集成配置

- **不包含**：
  - 生产环境自动故障注入（仅限测试环境）
  - 真实用户流量影响（使用影子流量）

## 4. 详细需求

### 4.1 ChaosEngine 核心引擎
```javascript
class ChaosEngine {
  // 实验生命周期管理
  async planExperiment(config)     // 规划实验
  async executeExperiment(plan)    // 执行实验
  async abortExperiment(id)        // 中止实验
  async getExperimentStatus(id)    // 获取状态
  
  // 故障注入控制
  async injectFault(type, target, params)
  async recoverFault(injectionId)
  
  // 稳态监控
  async monitorSteadyState(baseline)
  async detectAnomaly(metrics)
}
```

### 4.2 故障注入类型
| 类型 | 描述 | 参数 |
|------|------|------|
| network-delay | 网络延迟 | latency, jitter, correlation |
| network-loss | 网络丢包 | loss, correlation |
| network-partition | 网络分区 | source, destination |
| process-kill | 进程终止 | signal, gracePeriod |
| process-stress | 进程压力 | cpu, memory |
| service-down | 服务下线 | serviceName, duration |
| database-failure | 数据库故障 | type (timeout/error/unavailable) |
| cache-failure | 缓存故障 | redis-node, type |

### 4.3 实验场景
1. **单服务故障**：单个微服务宕机，验证熔断降级
2. **数据库故障**：PostgreSQL/Redis 故障，验证数据层容灾
3. **网络分区**：服务间网络隔离，验证降级策略
4. **资源耗尽**：CPU/内存压力，验证自动扩缩容
5. **级联故障**：多服务同时故障，验证系统韧性

### 4.4 稳态验证指标
- API 成功率 > 99%（非故障服务）
- 响应时间 P99 < 2s（降级模式）
- 错误率无异常突增
- 数据一致性检查通过
- 熔断器正确触发

### 4.5 K8s Chaos Mesh 集成
```yaml
# NetworkChaos 示例
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: api-delay
spec:
  action: delay
  mode: one
  selector:
    namespaces:
      - minego
    labelSelectors:
      app: gateway
  delay:
    latency: "500ms"
    jitter: "100ms"
  duration: "5m"
```

## 5. 验收标准（可测试）

- [x] ChaosEngine 可规划并执行故障注入实验
- [x] 支持 network-delay、network-loss、process-kill、service-down 等 8+ 故障类型
- [x] 实验执行后自动恢复，系统状态回归正常
- [x] 稳态验证器可检测异常并生成报告
- [x] 与现有 CircuitBreaker、DegradationManager 集成验证
- [x] 提供 CLI 工具和 API 接口
- [x] 单元测试覆盖率 > 80%

## 6. 工作量估算

**L** - 涉及核心引擎、多种故障注入器、稳态验证、K8s 集成，预计 3-5 天开发时间。

## 7. 优先级理由

P1 级别：混沌工程是生产级系统的必要保障，验证已实现的熔断、降级、高可用机制是否真正有效，是"最后一道防线"测试。
