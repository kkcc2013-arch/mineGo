# REQ-00135: reward-service events 路由挂载与集成

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00135 |
| 标题 | reward-service events 路由挂载与集成 |
| 类别 | 集成与修复 |
| 优先级 | P0 |
| 状态 | new |
| 涉及服务 | reward-service |
| 创建时间 | 2026-06-11 23:40 |

## 背景与价值

**现状**：`backend/services/reward-service/src/routes/events.js` 已实现完整的游戏活动系统 API（11 个端点），但从未在 `reward-service/src/index.js` 中挂载，导致游戏活动功能完全不可用。

**影响**：
- 玩家无法查看当前活动、参与限时活动
- 活动奖励领取、进度追踪功能失效
- 活动排行榜、活动任务查询不可用
- 活动商店、兑换功能无法使用

**价值**：挂载后立即解锁 11 个活动相关端点，无需额外开发，玩家可立即使用活动系统功能。

## 验收标准（必须全部通过）

### 1. 语法检查
```bash
node --check backend/services/reward-service/src/routes/events.js
node --check backend/services/reward-service/src/index.js
```

### 2. 路由挂载验证
```bash
grep -q "eventsRouter" backend/services/reward-service/src/index.js
grep -q "app.use.*events" backend/services/reward-service/src/index.js
```

### 3. 端点可达性验证（服务启动后）
```bash
# 假设 reward-service 运行在 localhost:3005
curl -sf http://localhost:3005/events
curl -sf http://localhost:3005/events/active
curl -sf -H "Authorization: Bearer test-token" http://localhost:3005/events/my
```

### 4. 单元测试（如有）
```bash
ls backend/tests/unit/event*.test.js 2>/dev/null || echo "No test file found"
```

## 技术方案

### 1. 在 reward-service/src/index.js 中添加路由挂载

```javascript
// 在文件顶部导入区域添加
const eventsRouter = require('./routes/events');

// 在现有路由挂载区域添加（建议在其他业务路由之后）
app.use('/events', eventsRouter);
```

### 2. 挂载位置建议

建议在以下位置插入：
- 在中间件挂载之后
- 在 `app.use(errorHandler);` 之前

### 3. 路由端点清单

挂载后将解锁以下 11 个端点：

| 方法 | 路径 | 功能 | 认证 |
|------|------|------|------|
| GET | /events | 获取所有活动列表 | 可选 |
| GET | /events/active | 获取当前进行中的活动 | 可选 |
| GET | /events/:eventId | 获取活动详情 | 可选 |
| GET | /events/my | 获取用户参与的活动 | 需要 |
| POST | /events/:eventId/join | 参与活动 | 需要 |
| GET | /events/:eventId/progress | 获取活动进度 | 需要 |
| POST | /events/:eventId/claim | 领取活动奖励 | 需要 |
| GET | /events/:eventId/leaderboard | 活动排行榜 | 可选 |
| GET | /events/:eventId/tasks | 活动任务列表 | 需要 |
| POST | /events/:eventId/tasks/:taskId/complete | 完成活动任务 | 需要 |
| GET | /events/:eventId/shop | 活动商店 | 需要 |

### 4. 依赖检查

确认以下依赖已存在：
- `eventService.js` - 活动服务核心逻辑
- `../shared/db` - 数据库连接
- `../shared/logger` - 日志模块
- `../shared/metrics` - Prometheus 指标

## 影响范围

- **修改文件**：
  - `backend/services/reward-service/src/index.js`（添加路由挂载）

- **解锁功能**：
  - 游戏活动系统的全部功能
  - 11 个活动相关 API 端点立即可用

- **无需修改**：
  - `routes/events.js`（已实现完整）
  - `eventService.js`（已实现完整）

## 完成定义（DoD）

代码已提交 ≠ 完成。以下条件全部满足才算完成：

1. ✅ 路由已在 `reward-service/src/index.js` 挂载
2. ✅ 语法检查通过（`node --check`）
3. ✅ 服务启动成功，无报错
4. ✅ 所有 11 个端点可达（curl 返回非 404）
5. ✅ CI 流水线通过

## 参考

- 路由文件：`backend/services/reward-service/src/routes/events.js`
- 服务文件：`backend/services/reward-service/src/eventService.js`
- GUIDELINES.md §6 欠账清单
