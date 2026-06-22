# REQ-00284：分布式事务编排与 Saga 补偿机制系统

- **编号**：REQ-00284
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared, gateway, catch-service, gym-service, payment-service, social-service
- **创建时间**：2026-06-22 06:00
- **依赖需求**：REQ-00277（服务发现与动态路由系统）

## 1. 背景与问题

mineGo 项目采用微服务架构，存在多个跨服务业务流程：

1. **精灵捕捉流程**：涉及 catch-service（捕捉）、pokemon-service（精灵归属）、reward-service（奖励发放）、user-service（经验更新）
2. **道馆战斗流程**：涉及 gym-service（战斗）、pokemon-service（精灵状态）、reward-service（奖励）、social-service（通知）
3. **精灵交易流程**：涉及 social-service（交易）、pokemon-service（归属变更）、user-service（记录）
4. **支付流程**：涉及 payment-service（支付）、reward-service（商品发放）、user-service（余额更新）

当前问题：
- 各服务独立处理，缺乏统一的事务编排机制
- 部分失败时无自动补偿，可能导致数据不一致
- 无事务状态追踪和恢复能力
- 跨服务操作失败后需要人工干预

## 2. 目标

实现基于 Saga 模式的分布式事务编排系统：

1. **事务编排器**：统一管理跨服务事务流程
2. **补偿机制**：自动执行补偿操作，保证最终一致性
3. **状态持久化**：事务状态存储在数据库，支持故障恢复
4. **可观测性**：完整的事务执行日志和指标

## 3. 范围

- **包含**：
  - SagaOrchestrator 核心编排器
  - SagaStep 步骤定义与执行
  - CompensatingAction 补偿动作管理
  - SagaRepository 事务状态持久化
  - 事务超时与重试策略
  - Prometheus 指标与日志

- **不包含**：
  - 2PC/XA 两阶段提交（不适用于微服务）
  - TCC 模式实现（Saga 更适合长事务）
  - 前端事务可视化界面

## 4. 详细需求

### 4.1 SagaOrchestrator 编排器

```javascript
// backend/shared/SagaOrchestrator.js
class SagaOrchestrator {
  /**
   * 执行 Saga 事务
   * @param {string} sagaType - 事务类型（catch-pokemon, gym-battle, pokemon-trade, payment）
   * @param {Object} context - 事务上下文数据
   * @param {SagaStep[]} steps - 步骤定义数组
   * @returns {Promise<SagaResult>}
   */
  async execute(sagaType, context, steps) {}

  /**
   * 查询事务状态
   * @param {string} sagaId - 事务 ID
   */
  async getStatus(sagaId) {}

  /**
   * 手动重试失败事务
   * @param {string} sagaId
   */
  async retry(sagaId) {}

  /**
   * 恢复未完成事务（服务重启后调用）
   */
  async recoverPendingSagas() {}
}
```

### 4.2 SagaStep 步骤定义

```javascript
// backend/shared/SagaStep.js
class SagaStep {
  constructor(config) {
    this.name = config.name;           // 步骤名称
    this.execute = config.execute;     // 执行函数
    this.compensate = config.compensate; // 补偿函数
    this.timeout = config.timeout || 30000; // 超时时间
    this.retryPolicy = config.retryPolicy || { maxAttempts: 3, backoff: 'exponential' };
  }
}

// 示例：精灵捕捉 Saga
const catchPokemonSaga = [
  new SagaStep({
    name: 'validate-catch',
    execute: async (ctx) => catchService.validate(ctx),
    compensate: async (ctx) => null // 验证无需补偿
  }),
  new SagaStep({
    name: 'create-pokemon',
    execute: async (ctx) => pokemonService.create(ctx),
    compensate: async (ctx) => pokemonService.delete(ctx.pokemonId)
  }),
  new SagaStep({
    name: 'grant-rewards',
    execute: async (ctx) => rewardService.grant(ctx),
    compensate: async (ctx) => rewardService.revoke(ctx.rewardIds)
  }),
  new SagaStep({
    name: 'update-user-stats',
    execute: async (ctx) => userService.updateStats(ctx),
    compensate: async (ctx) => userService.revertStats(ctx)
  })
];
```

### 4.3 事务状态持久化

```sql
-- 数据库表结构
CREATE TABLE saga_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  saga_type VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL, -- pending, running, completed, failed, compensating, compensated
  context JSONB NOT NULL,
  current_step INTEGER DEFAULT 0,
  total_steps INTEGER NOT NULL,
  executed_steps JSONB DEFAULT '[]',
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE TABLE saga_step_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  saga_id UUID REFERENCES saga_transactions(id),
  step_name VARCHAR(100) NOT NULL,
  step_index INTEGER NOT NULL,
  action VARCHAR(20) NOT NULL, -- execute, compensate
  status VARCHAR(20) NOT NULL, -- success, failed, skipped
  input JSONB,
  output JSONB,
  error TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_saga_status ON saga_transactions(status, expires_at);
CREATE INDEX idx_saga_type ON saga_transactions(saga_type, started_at);
```

### 4.4 补偿执行策略

- **顺序补偿**：按执行逆序依次执行补偿
- **并行补偿**：无依赖步骤可并行补偿
- **幂等保证**：所有补偿操作必须幂等
- **失败处理**：补偿失败记录日志，支持人工干预

### 4.5 超时与重试

```javascript
const defaultRetryPolicy = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoff: 'exponential', // exponential, linear, fixed
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']
};
```

### 4.6 Prometheus 指标

```
saga_started_total{type}
saga_completed_total{type, status}
saga_step_duration_seconds{type, step, action}
saga_compensation_triggered_total{type, step}
saga_recovery_total{status}
```

## 5. 验收标准（可测试）

- [ ] SagaOrchestrator 能成功执行完整的 4 步骤精灵捕捉流程
- [ ] 第 3 步骤失败时，自动执行前 2 步骤的补偿操作
- [ ] 服务重启后，能恢复 status=running 的事务并继续执行
- [ ] 超时事务自动标记为 failed 并触发补偿
- [ ] 所有补偿操作执行 2 次结果与执行 1 次相同（幂等性）
- [ ] Prometheus 指标正确记录事务执行情况
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试验证跨服务事务一致性

## 6. 工作量估算

**XL** - 涉及核心基础设施，需要：
- SagaOrchestrator 核心实现（2 天）
- 数据库表与 Repository（1 天）
- 各服务 Saga 定义与补偿函数（2 天）
- 测试与文档（1 天）

## 7. 优先级理由

P1 理由：
1. 跨服务事务一致性是微服务架构的核心挑战
2. 当前支付、交易等关键流程缺乏事务保障，存在数据不一致风险
3. 作为基础设施，后续所有跨服务流程都将依赖此系统
4. REQ-00277 服务发现完成后，事务编排是下一个关键解耦需求
