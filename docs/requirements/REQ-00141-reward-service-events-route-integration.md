# REQ-00141: reward-service events 路由挂载与集成

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00141 |
| 标题 | reward-service events 路由挂载与集成 |
| 类别 | 集成与修复 |
| 优先级 | P0 |
| 状态 | new |
| 涉及服务 | reward-service、gateway |
| 创建时间 | 2026-06-12 03:30 |

## 背景与价值

`reward-service/src/routes/events.js` 文件已存在，包含完整的游戏活动系统 API 端点实现，但该路由从未挂载到服务主入口，导致所有活动相关功能无法使用。这是典型的"孤儿路由"问题，需要立即修复以解锁 REQ-00057（游戏活动系统）的全部功能。

**影响范围**：
- 活动列表查询、活动详情查询
- 用户参与活动、活动进度追踪
- 活动奖励领取、活动排行榜
- 活动任务、活动商店等功能

## 验收标准

- [ ] `node --check backend/services/reward-service/src/routes/events.js` 通过
- [ ] `grep -n "events" backend/services/reward-service/src/index.js` 显示挂载语句
- [ ] `curl -sf http://localhost:3006/api/v1/events` 返回 200（服务启动后）
- [ ] 所有 11 个端点可达（逐个 curl 测试）

## 完成定义（DoD）

代码已提交 + 路由已在 index.js 挂载 + 所有端点 curl 返回非 404 + CI 绿 = 完成。

## 技术方案

### 1. 挂载 events.js 路由

在 `backend/services/reward-service/src/index.js` 中添加：

```javascript
// 在文件顶部添加路由引入
const eventsRoutes = require('./routes/events');

// 在合适位置（建议在其他路由挂载之后）添加
// EVENT ROUTES (挂载 events.js 路由)
app.use('/api/v1/events', eventsRoutes);
```

### 2. 端点清单（events.js 已实现的端点）

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/v1/events` | GET | 活动列表查询 |
| `/api/v1/events/:eventId` | GET | 活动详情查询 |
| `/api/v1/events/:eventId/participate` | POST | 参与活动 |
| `/api/v1/events/:eventId/progress` | GET | 活动进度查询 |
| `/api/v1/events/:eventId/rewards` | GET | 活动奖励列表 |
| `/api/v1/events/:eventId/rewards/claim` | POST | 领取奖励 |
| `/api/v1/events/:eventId/leaderboard` | GET | 活动排行榜 |
| `/api/v1/events/:eventId/tasks` | GET | 活动任务列表 |
| `/api/v1/events/:eventId/tasks/:taskId/complete` | POST | 完成任务 |
| `/api/v1/events/:eventId/shop` | GET | 活动商店 |
| `/api/v1/events/:eventId/shop/purchase` | POST | 商店购买 |

### 3. Gateway 路由配置

确保 gateway 已正确代理 reward-service 的 `/api/v1/events/*` 路径。

## 影响范围

- `backend/services/reward-service/src/index.js` - 添加路由挂载
- `backend/gateway/src/index.js` - 确认代理配置（如需）

## 参考

- REQ-00057: 游戏活动系统与限时活动管理
- REQ-00135: reward-service events 路由挂载与集成（已有规划，本次实现）
- GUIDELINES.md §6: 集成欠账清单
