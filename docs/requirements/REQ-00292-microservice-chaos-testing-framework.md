# REQ-00292：微服务混沌测试框架与故障注入系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00292 |
| 标题 | 微服务混沌测试框架与故障注入系统 |
| 类别 | 测试覆盖 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | backend/tests/chaos, backend/services/*, backend/shared, infrastructure |
| 创建时间 | 2026-06-23 01:00 UTC |
| 依赖需求 | REQ-00041（多区域灾备故障转移系统） |

## 1. 背景与问题

mineGo 项目已实现多区域灾备故障转移系统（REQ-00041）和熔断降级机制，但缺乏系统化的混沌测试能力：

1. **故障场景验证不足**：生产环境的故障场景（网络延迟、服务宕机、数据库连接池耗尽）无法在测试环境中复现
2. **韧性测试缺失**：无法验证服务在极端条件下的行为是否符合预期
3. **故障注入能力缺失**：没有标准化的故障注入工具，难以测试服务的容错能力
4. **爆炸半径不可控**：缺乏故障隔离机制，测试可能影响其他服务

### 目标
构建完整的混沌测试框架，支持：
- 可控的故障注入（网络、服务、数据库、缓存）
- 自动化混沌测试场景
- 服务韧性验证
- 最小爆炸半径控制

## 2. 目标

- 实现 6 种故障注入器（网络延迟、网络分区、服务宕机、CPU 压力、数据库故障、Redis 故障）
- 建立 10+ 预定义混沌测试场景
- 支持 Kubernetes Pod Chaos Monkey 集成
- 提供混沌测试报告和健康评分

## 3. 范围

### 包含
- 故障注入器框架和 6 种注入器实现
- 混沌测试场景 DSL 和预定义场景
- 服务韧性验证器
- 混沌测试报告生成器
- API 管理端点

### 不包含
- 生产环境混沌测试（仅用于 staging/test）
- 第三方混沌工程平台集成（如 Gremlin、ChaosBlade）

## 4. 详细需求

### 4.1 故障注入器框架

```javascript
// backend/tests/chaos/fault-injector.js
class FaultInjector {
  constructor(config) {
    this.type = config.type; // 'network-delay', 'network-partition', 'service-down', 'cpu-stress', 'db-failure', 'redis-failure'
    this.target = config.target;
    this.duration = config.duration || 60000; // 默认 60 秒
    this.intensity = config.intensity || 'medium'; // 'low', 'medium', 'high'
    this.active = false;
  }

  async inject() { throw new Error('Must implement inject()'); }
  async recover() { throw new Error('Must implement recover()'); }
  async getStatus() { return { active: this.active, type: this.type, target: this.target }; }
}
```

### 4.2 六种故障注入器

1. **NetworkDelayInjector** - 注入网络延迟（50ms-500ms）
2. **NetworkPartitionInjector** - 模拟网络分区
3. **ServiceDownInjector** - 模拟服务宕机（通过健康检查返回 503）
4. **CPUStressInjector** - 注入 CPU 压力（占用 CPU 资源）
5. **DatabaseFailureInjector** - 模拟数据库连接失败
6. **RedisFailureInjector** - 模拟 Redis 不可用

### 4.3 混沌测试场景 DSL

```yaml
# 混沌测试场景定义示例
name: "catch-service-resilience-test"
description: "验证捕捉服务在网络延迟下的韧性"
steps:
  - action: "inject"
    fault:
      type: "network-delay"
      target: "catch-service"
      duration: 30000
      delay: 200ms
  - action: "verify"
    assertions:
      - service: "catch-service"
        endpoint: "/api/v1/catch"
        expected: { status: 200, maxLatency: 500ms }
      - service: "catch-service"
        endpoint: "/health"
        expected: { status: 200 }
  - action: "recover"
    fault:
      type: "network-delay"
      target: "catch-service"
  - action: "verify"
    assertions:
      - service: "catch-service"
        endpoint: "/api/v1/catch"
        expected: { status: 200, maxLatency: 100ms }
```

### 4.4 预定义混沌测试场景

1. `catch-service-network-delay` - 捕捉服务网络延迟测试
2. `gym-service-high-latency` - 道馆服务高延迟测试
3. `payment-service-db-failure` - 支付服务数据库故障测试
4. `user-service-redis-down` - 用户服务 Redis 不可用测试
5. `gateway-cpu-stress` - 网关 CPU 压力测试
6. `multi-service-failure` - 多服务同时故障测试
7. `network-partition-simulation` - 网络分区模拟测试
8. `cascade-failure-test` - 级联故障测试
9. `full-recovery-test` - 全服务恢复测试
10. `latency-spike-test` - 延迟尖峰测试

### 4.5 服务韧性验证器

```javascript
// backend/tests/chaos/resilience-verifier.js
class ResilienceVerifier {
  // 验证服务在故障条件下的响应
  async verifyServiceHealth(service, assertions) {}
  
  // 验证熔断器状态
  async verifyCircuitBreaker(service, expectedState) {}
  
  // 验证降级响应
  async verifyDegradedResponse(service, endpoint, expectedBehavior) {}
  
  // 生成韧性评分
  calculateResilienceScore(testResults) {}
}
```

### 4.6 API 端点

- `POST /api/v1/chaos/inject` - 注入故障
- `POST /api/v1/chaos/recover` - 恢复故障
- `GET /api/v1/chaos/status` - 获取当前故障状态
- `POST /api/v1/chaos/scenario/run` - 运行混沌测试场景
- `GET /api/v1/chaos/scenarios` - 获取预定义场景列表
- `GET /api/v1/chaos/report` - 获取混沌测试报告

## 5. 验收标准

- [ ] **故障注入器**
  - [ ] 6 种故障注入器全部实现并可独立使用
  - [ ] 支持配置故障持续时间和强度
  - [ ] 故障恢复后服务状态正常

- [ ] **混沌测试场景**
  - [ ] 10+ 预定义场景可运行
  - [ ] 场景 DSL 支持自定义扩展
  - [ ] 场景执行结果可追溯

- [ ] **韧性验证**
  - [ ] 服务健康检查正确判断
  - [ ] 熔断器状态验证准确
  - [ ] 降级行为验证到位

- [ ] **安全控制**
  - [ ] 故障注入仅限 staging/test 环境
  - [ ] 最大故障持续时间限制（5 分钟）
  - [ ] 自动恢复机制防止故障残留

- [ ] **API 端点**
  - [ ] 所有 API 返回正确的响应
  - [ ] 错误处理完善
  - [ ] 权限验证到位

## 6. 工作量估算

**L (Large)** - 涉及 6 个故障注入器、场景框架、验证器和 API，预计需要 3-4 天开发时间。

## 7. 优先级理由

P1 优先级：
- 测试覆盖率是项目成熟度的关键指标（当前 7/10）
- 混沌测试是验证服务韧性的必要手段
- 支持 REQ-00041 多区域灾备系统的验证
- 提升生产环境稳定性信心
