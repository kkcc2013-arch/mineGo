# REQ-00579：年龄限制中间件测试覆盖

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00579 |
| 标题 | 年龄限制中间件测试覆盖 |
| 类别 | 测试覆盖 |
| 优先级 | P0 |
| 状态 | done |
| 涉及服务 | gateway, user-service |
| 创建时间 | 2026-07-16 18:00 |
| 依赖需求 | REQ-00578 |

## 1. 背景与问题

年龄限制中间件（`gateway/src/middleware/ageRestriction.js`）是 COPPA 合规和未成年人保护的核心组件，负责：
- 检查未成年人的游戏时间限制
- 验证家长同意状态
- 限制特定功能访问
- 追踪游戏时长

当前该中间件缺乏单元测试和集成测试覆盖，存在以下风险：
- 修改代码可能引入回归缺陷
- 未成年人保护逻辑的正确性无法验证
- 合规审计时无法提供测试证据

## 2. 目标

为年龄限制中间件建立完整的测试覆盖，确保：
- 所有核心功能有单元测试
- 边界条件（时区、午夜跨天）被测试
- 与用户服务的集成有集成测试
- 测试覆盖率 ≥ 85%

## 3. 范围

### 包含
- `gateway/src/middleware/ageRestriction.js` 单元测试
- `shared/ageVerification.js` 单元测试
- 时间限制逻辑的边界测试
- 游戏时长追踪的集成测试
- Mock 数据和测试工具函数

### 不包含
- 其他中间件的测试
- E2E 测试（已有独立需求）

## 4. 详细需求

### 4.1 单元测试文件
创建 `backend/gateway/tests/middleware/ageRestriction.test.js`：
- `checkPlayTimeLimitMiddleware()` 测试
- `checkFeatureRestriction()` 测试
- `checkLoginPermissionMiddleware()` 测试
- `trackPlayTimeMiddleware()` 测试

### 4.2 年龄验证模块测试
创建 `backend/shared/tests/ageVerification.test.js`：
- `calculateAge()` 边界测试（生日当天、时区）
- `getAgeBracket()` 分类测试
- `checkPlayTimeLimit()` 逻辑测试
- `recordPlayTime()` 测试
- Redis 缓存失效测试

### 4.3 测试用例设计
```
正常流程:
- 成年用户不限制
- 13-17岁用户正常游戏
- 13岁以下有家长同意正常游戏

限制流程:
- 达到每日时长限制后拒绝
- 宵禁时间段拒绝
- 无家长同意拒绝登录
- 敏感功能禁用

边界条件:
- 午夜跨天重置
- 时区转换
- 并发请求计费
```

### 4.4 Mock 策略
- Mock Redis 客户端
- Mock 数据库查询
- Mock 时间函数（用于测试宵禁）

## 5. 验收标准（可测试）
- [ ] `ageRestriction.test.js` 包含 ≥ 20 个测试用例
- [ ] `ageVerification.test.js` 包含 ≥ 15 个测试用例
- [ ] 测试覆盖率 ≥ 85%（行覆盖率）
- [ ] 所有测试用例通过
- [ ] CI 流水线包含测试执行步骤
- [ ] 存在边界条件测试（时区、跨天）

## 6. 工作量估算
**M（中等）**
- 需要理解现有中间件逻辑
- 需要 Mock Redis 和数据库
- 边界条件测试设计

## 7. 优先级理由
P0 理由：未成年人保护是合规核心需求 REQ-00578 的测试保障，缺乏测试可能导致合规风险。