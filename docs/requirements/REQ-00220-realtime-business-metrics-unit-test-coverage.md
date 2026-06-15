# REQ-00220：实时业务指标服务单元测试覆盖

- **编号**：REQ-00220
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/realtimeBusinessMetrics.js、backend/tests/unit、gateway、所有微服务
- **创建时间**：2026-06-15 14:00
- **依赖需求**：REQ-00002（结构化日志与 Prometheus 指标集成）

## 1. 背景与问题

`realtimeBusinessMetrics.js` 是 mineGo 项目的核心可观测性模块，负责实时收集和计算业务指标（DAU/MAU、捕捉成功率、道馆战斗活跃度、支付转化率等）。该模块已被 gateway 和所有微服务引用，但目前**缺少单元测试覆盖**。

当前问题：
- 无测试覆盖，代码变更可能引入回归缺陷
- 指标计算逻辑复杂（滑动窗口、百分位统计、异常检测），需要验证正确性
- Prometheus 指标暴露格式需要测试验证
- 缺少边界条件测试（空数据、极端值、并发场景）

## 2. 目标

为 `realtimeBusinessMetrics.js` 建立完整的单元测试覆盖，确保：
- 核心计算逻辑正确性验证
- 边界条件和异常场景覆盖
- Prometheus 指标格式合规性验证
- 测试覆盖率达到 ≥85%

## 3. 范围

- **包含**：
  - 单元测试文件创建：`backend/tests/unit/realtimeBusinessMetrics.test.js`
  - 指标计算逻辑测试（DAU/MAU、捕捉率、战斗活跃度、支付转化）
  - 滑动窗口统计测试
  - 百分位计算测试（P50/P90/P99）
  - 异常检测与告警阈值测试
  - Prometheus 指标格式验证
  - 边界条件测试（空数据、极端值、并发）
  - Mock 时间和 Redis 依赖

- **不包含**：
  - 集成测试（已有其他需求覆盖）
  - 性能基准测试
  - E2E 测试

## 4. 详细需求

### 4.1 测试文件结构

```javascript
// backend/tests/unit/realtimeBusinessMetrics.test.js
describe('RealtimeBusinessMetrics', () => {
  describe('MetricCollection', () => { /* 指标收集 */ });
  describe('SlidingWindow', () => { /* 滑动窗口统计 */ });
  describe('PercentileCalculation', () => { /* 百分位计算 */ });
  describe('AnomalyDetection', () => { /* 异常检测 */ });
  describe('PrometheusFormat', () => { /* 指标格式 */ });
  describe('EdgeCases', () => { /* 边界条件 */ });
});
```

### 4.2 核心测试场景

**指标收集测试**：
- DAU/MAU 计算正确性
- 捕捉成功率计算（成功数/总尝试数）
- 道馆战斗活跃度统计
- 支付转化率计算
- 多维度指标聚合

**滑动窗口测试**：
- 1分钟/5分钟/1小时窗口数据聚合
- 窗口过期数据清理
- 窗口边界数据处理
- 时间跳跃场景

**百分位计算测试**：
- P50/P90/P99 计算正确性
- 小样本场景（<100条）
- 大样本场景（>10000条）
- 重复值处理

**异常检测测试**：
- 阈值触发告警
- 突增/突降检测
- 历史基线对比
- 告警去重与冷却

**Prometheus 格式测试**：
- 指标名称规范（前缀、单位）
- 标签格式正确性
- HELP/TYPE 注释合规
- Histogram 格式验证

**边界条件测试**：
- 空数据集处理
- 全零值处理
- 极端大值（Number.MAX_SAFE_INTEGER）
- 负值处理（应拒绝或取绝对值）
- 并发写入安全性

### 4.3 Mock 策略

```javascript
// Mock Redis
jest.mock('../../shared/redis', () => ({
  hincrby: jest.fn(),
  hgetall: jest.fn(),
  expire: jest.fn()
}));

// Mock 时间
jest.useFakeTimers();
jest.setSystemTime(new Date('2026-06-15T14:00:00Z'));
```

### 4.4 测试数据工厂

```javascript
const createMetricData = (overrides = {}) => ({
  userId: 'user-123',
  action: 'catch',
  success: true,
  timestamp: Date.now(),
  metadata: {},
  ...overrides
});
```

## 5. 验收标准（可测试）

- [ ] 测试文件 `realtimeBusinessMetrics.test.js` 创建成功
- [ ] 所有测试用例通过（npm test）
- [ ] 测试覆盖率 ≥85%（语句、分支、函数、行）
- [ ] 核心计算逻辑至少 10 个测试场景覆盖
- [ ] 边界条件至少 6 个测试场景覆盖
- [ ] Prometheus 格式验证测试通过
- [ ] 测试执行时间 <5秒
- [ ] 无测试警告或 deprecated 调用
- [ ] CI 流水线测试步骤通过

## 6. 工作量估算

**M（中等）**
- 理由：模块约 400 行代码，计算逻辑较复杂，需要 Mock Redis 和时间，预计 25-35 个测试用例

## 7. 优先级理由

**P1 理由**：
1. 该模块是核心可观测性组件，被所有服务引用
2. 无测试覆盖是技术债，影响代码变更信心
3. 指标计算错误会导致运营决策失误
4. 测试覆盖是生产就绪的基本要求
5. 与 REQ-00002（Prometheus 指标集成）形成闭环验证
