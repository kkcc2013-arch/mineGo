# REQ-00274: 游戏活动服务单元测试覆盖

- **编号**：REQ-00274
- **类别**：测试覆盖
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：reward-service、backend/tests/unit
- **创建时间**：2026-06-22 00:47
- **依赖需求**：REQ-00057（游戏活动系统与限时活动管理）

## 1. 背景与问题

当前 reward-service 的 `eventService.js` 是核心业务模块（约 850 行代码），负责游戏活动系统的所有核心功能，但缺少专门的单元测试覆盖。

**现有痛点**：
1. **测试覆盖率不足**：当前只有 1 个集成测试文件 `reward.integration.test.js`，缺少针对 eventService 的单元测试
2. **回归风险高**：活动系统涉及调度、状态管理、奖励发放等复杂逻辑，修改后难以验证
3. **边界条件未测试**：活动时间边界、并发参与、库存扣减等边界条件缺少测试
4. **定时任务逻辑未覆盖**：活动调度器、统计聚合器等定时任务逻辑未被测试
5. **错误路径未验证**：活动创建失败、库存不足、购买超限等错误场景缺少验证

**代码现状**：
- `backend/services/reward-service/src/eventService.js` - 850+ 行核心业务逻辑
- `backend/tests/unit/` - 128 个单元测试文件，但无 `eventService.test.js`
- 集成测试只覆盖了基本的 API 端点，未覆盖服务层逻辑

## 2. 目标

为 eventService 实现全面的单元测试覆盖：

1. **核心功能测试**：活动创建、调度、激活、停用等核心流程
2. **边界条件测试**：时间边界、数量限制、并发控制
3. **错误路径测试**：各种异常场景的处理
4. **定时任务测试**：调度器、聚合器的定时逻辑
5. **测试覆盖率 ≥ 90%**：行覆盖率、分支覆盖率

预期收益：
- 降低回归风险，修改活动系统时可快速验证
- 提升代码质量，暴露潜在 bug
- 为后续重构提供安全网
- 达到 REQ-00272 API 契约测试系统的补充覆盖

## 3. 范围

### 包含
- eventService.js 所有公共方法的单元测试
- 定时任务逻辑测试（使用 jest.useFakeTimers）
- 数据库 Mock（使用 pg-mem 或 jest.mock）
- 事件发布 Mock
- 边界条件测试
- 错误路径测试
- 并发场景测试

### 不包含
- 其他 reward-service 模块的测试（单独需求）
- E2E 端到端测试（属于集成测试）
- 数据库迁移测试（已有覆盖）
- 前端活动组件测试

## 4. 详细需求

### 4.1 测试文件结构

```
backend/tests/unit/
└── eventService.test.js       # 主测试文件（新建）
```

### 4.2 测试用例清单

#### 4.2.1 初始化测试
```javascript
describe('EventService - Initialization', () => {
  test('should initialize successfully and load scheduled events');
  test('should not reinitialize if already initialized');
  test('should handle initialization failure gracefully');
  test('should start event scheduler after initialization');
  test('should start stats aggregator after initialization');
});
```

#### 4.2.2 活动创建测试
```javascript
describe('EventService - createEvent', () => {
  test('should create event with valid data');
  test('should reject invalid event type');
  test('should create event spawns for spawn_boost type');
  test('should create event tasks when provided');
  test('should create event shop when provided');
  test('should schedule event if starting within 30 minutes');
  test('should publish EVENT_CREATED event');
  test('should validate event config against type schema');
  test('should handle database errors gracefully');
});
```

#### 4.2.3 活动调度测试
```javascript
describe('EventService - scheduleEvent', () => {
  test('should schedule future event correctly');
  test('should activate event if already started');
  test('should schedule event end time');
  test('should update event status to scheduled');
  test('should clear existing scheduler when re-scheduling');
});
```

#### 4.2.4 活动激活/停用测试
```javascript
describe('EventService - activateEvent / deactivateEvent', () => {
  test('should update status to active');
  test('should add to activeEvents map');
  test('should publish EVENT_ACTIVATED event');
  test('should notify spawn boost for spawn_boost type');
  test('should update status to completed on deactivate');
  test('should clear scheduler on deactivate');
  test('should aggregate final stats on deactivate');
  test('should publish EVENT_DEACTIVATED event');
});
```

#### 4.2.5 活动参与测试
```javascript
describe('EventService - joinEvent', () => {
  test('should create participation record');
  test('should reject if event not active');
  test('should return existing participation if already joined');
  test('should increment participant count');
  test('should publish EVENT_JOINED event');
});
```

#### 4.2.6 任务完成测试
```javascript
describe('EventService - completeEventTask', () => {
  test('should complete task and grant rewards');
  test('should reject if task not found');
  test('should reject if non-repeatable task already completed');
  test('should allow repeatable task multiple times up to max');
  test('should update completed_count correctly');
});
```

#### 4.2.7 活动商店测试
```javascript
describe('EventService - purchaseFromEventShop', () => {
  test('should process valid purchase');
  test('should reject if event not active');
  test('should reject if shop item not found');
  test('should reject if insufficient stock');
  test('should reject if purchase limit exceeded');
  test('should reject if daily limit exceeded');
  test('should deduct currency correctly');
  test('should update sold_count');
  test('should publish REWARD_GRANT event');
});
```

#### 4.2.8 奖励领取测试
```javascript
describe('EventService - claimEventRewards', () => {
  test('should grant event rewards on claim');
  test('should reject if user not participating');
  test('should reject if rewards already claimed');
  test('should update rewards_claimed status');
  test('should increment completion_count');
});
```

#### 4.2.9 定时任务测试
```javascript
describe('EventService - Scheduled Tasks', () => {
  test('should check scheduled events every minute');
  test('should activate events when start time reached');
  test('should deactivate events when end time reached');
  test('should aggregate stats every 5 minutes');
});
```

#### 4.2.10 查询功能测试
```javascript
describe('EventService - Query Functions', () => {
  test('getActiveEventsForUser should return active events with user progress');
  test('getAllActiveEvents should return all active events');
  test('getEvent should return event by id');
  test('getEventLeaderboard should return ranked participants');
  test('searchEvents should filter by status, type, date');
});
```

#### 4.2.11 活动控制测试
```javascript
describe('EventService - Event Control', () => {
  test('pauseEvent should update status and clear activeEvents');
  test('resumeEvent should reactivate if end time not passed');
  test('cancelEvent should update status and clear schedulers');
});
```

#### 4.2.12 边界条件测试
```javascript
describe('EventService - Edge Cases', () => {
  test('should handle event starting exactly at now');
  test('should handle event ending exactly at now');
  test('should handle concurrent joinEvent calls');
  test('should handle concurrent purchaseFromEventShop calls');
  test('should handle max purchase limit exactly');
  test('should handle zero stock correctly');
  test('should handle empty rewards array');
});
```

#### 4.2.13 错误处理测试
```javascript
describe('EventService - Error Handling', () => {
  test('should throw on invalid event type');
  test('should throw on non-existent event');
  test('should throw on non-existent task');
  test('should throw on non-existent shop item');
  test('should handle database connection error');
  test('should handle event bus publish failure');
});
```

### 4.3 Mock 策略

```javascript
// 数据库 Mock
jest.mock('../../shared/db', () => ({
  db: {
    query: jest.fn()
  }
}));

// EventBus Mock
jest.mock('../../shared/EventBus', () => ({
  publishEvent: jest.fn(),
  EVENTS: {
    EVENT_CREATED: 'event.created',
    EVENT_ACTIVATED: 'event.activated',
    // ...
  }
}));

// Logger Mock
jest.mock('../../shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn()
  })
}));

// node-cron Mock
jest.mock('node-cron', () => ({
  schedule: jest.fn((pattern, callback) => ({
    start: jest.fn(),
    stop: jest.fn()
  }))
}));
```

### 4.4 测试数据构建

```javascript
// 测试数据工厂
const createTestEvent = (overrides = {}) => ({
  eventKey: 'test-event-001',
  title: 'Test Event',
  description: 'Test Description',
  eventType: 'spawn_boost',
  startTime: new Date(Date.now() + 3600000), // 1 hour later
  endTime: new Date(Date.now() + 7200000),   // 2 hours later
  timezone: 'UTC',
  scopeType: 'global',
  scopeConfig: {},
  eventConfig: {
    spawns: [{
      pokemonSpeciesId: 25, // Pikachu
      spawnRateMultiplier: 2.0,
      shinyRateMultiplier: 1.5
    }]
  },
  rewards: [{ type: 'coins', amount: 100 }],
  ...overrides
});

const createTestShopItem = (overrides = {}) => ({
  itemKey: 'rare-candy',
  itemName: 'Rare Candy',
  itemType: 'item',
  itemData: { itemId: 'rare-candy' },
  costType: 'coins',
  costAmount: 100,
  purchaseLimit: 10,
  dailyLimit: 2,
  totalStock: 1000,
  ...overrides
});
```

### 4.5 覆盖率目标

| 指标 | 目标 |
|------|------|
| 行覆盖率 (Lines) | ≥ 90% |
| 分支覆盖率 (Branches) | ≥ 85% |
| 函数覆盖率 (Functions) | ≥ 95% |
| 语句覆盖率 (Statements) | ≥ 90% |

## 5. 验收标准（可测试）

- [ ] 创建 `backend/tests/unit/eventService.test.js` 文件
- [ ] 所有 60+ 测试用例通过
- [ ] 行覆盖率 ≥ 90%
- [ ] 分支覆盖率 ≥ 85%
- [ ] 所有核心方法有对应的测试
- [ ] 边界条件测试覆盖时间边界、数量限制
- [ ] 错误路径测试覆盖所有异常场景
- [ ] 定时任务逻辑使用 `jest.useFakeTimers` 测试
- [ ] Mock 正确隔离数据库、EventBus、Logger
- [ ] 测试可在 30 秒内完成（单元测试应快速）

## 6. 工作量估算

**M (Medium)**

理由：
- 单一服务文件（约 850 行），但逻辑复杂
- 需要编写 60+ 测试用例
- 需要处理定时任务的 Mock
- 需要构建测试数据工厂
- 已有测试框架和 Mock 模式可复用

预计开发时间：1 天

## 7. 优先级理由

**P2 理由**：
1. **提升代码质量**：活动系统是核心业务模块，需要测试保障
2. **降低回归风险**：每次修改活动系统都可快速验证
3. **补充测试缺口**：当前 128 个单元测试，缺少活动服务覆盖
4. **为重构铺垫**：后续功能增强需要测试保障
5. **符合测试覆盖类别**：作为 REQ-00272 契约测试的补充

## 8. 相关需求

- REQ-00057: 游戏活动系统与限时活动管理（被测需求）
- REQ-00272: API 契约测试系统与自动化 Mock 服务生成
- REQ-00220: 实时业务指标服务单元测试覆盖（参考）

## 9. 风险评估

### 技术风险（低）
- Jest 测试框架已成熟使用
- Mock 策略与现有测试一致
- 测试数据构建模式已有参考

### 维护风险（低）
- 单元测试与实现代码解耦
- 测试失败可快速定位问题
- 覆盖率报告可追踪

## 10. 后续优化方向

1. **性能测试**：活动参与高并发场景测试
2. **快照测试**：活动数据结构快照验证
3. **变异测试**：使用 Stryker 验证测试质量
4. **持续监控**：CI 中强制覆盖率门槛
