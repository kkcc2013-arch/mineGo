# REQ-00121: social-service 排行榜路由挂载与集成

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00121 |
| 标题 | social-service 排行榜路由挂载与集成 |
| 类别 | 集成与修复 |
| 优先级 | P0 |
| 状态 | done |
| 涉及服务 | social-service |
| 创建时间 | 2026-06-11 17:40 |

## 背景与价值

**问题**：`backend/services/social-service/src/routes/leaderboard.js` 已实现完整的玩家排行榜系统 API（6 个端点），但从未在 `index.js` 中挂载，导致所有排行榜功能无法使用。

**影响**：
- REQ-00074（玩家排行榜系统）标记为"已完成"，但实际功能不可达
- 用户无法查看各类排行榜（CP、捕捉数量、道馆胜利等）
- 无法查看自己的排名、领取赛季奖励等核心操作

**价值**：挂载后立即解锁 REQ-00074 的全部功能，无需额外开发。

## 验收标准（必填，必须是可执行命令）

- [ ] `node --check backend/services/social-service/src/index.js` 通过
- [ ] `node --check backend/services/social-service/src/routes/leaderboard.js` 通过
- [ ] `grep -q "leaderboardRouter" backend/services/social-service/src/index.js` 路由已挂载
- [ ] `curl -sf http://localhost:8086/health` 返回 200（服务可启动）
- [ ] 启动服务后，`curl -sf http://localhost:8086/leaderboard/cp` 返回非 404

## 技术方案

### 1. 路由挂载
在 `social-service/src/index.js` 中添加：

```javascript
// REQ-00121: 玩家排行榜系统路由
const leaderboardRouter = require('./routes/leaderboard');
app.use('/leaderboard', leaderboardRouter);
```

### 2. 端点清单（共 6 个）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/leaderboard/:type` | 获取排行榜列表（支持 cp/catches/gym_wins/friendship） |
| GET | `/leaderboard/:type/rank` | 获取用户在指定排行榜的排名 |
| GET | `/leaderboard/:type/seasons` | 获取指定排行榜的赛季列表 |
| POST | `/leaderboard/season/:seasonId/claim` | 领取赛季奖励 |
| GET | `/leaderboard/my-history` | 获取用户历史排名记录 |
| GET | `/leaderboard/types/list` | 获取所有排行榜类型列表 |

### 3. 依赖检查
- `shared/db` 已存在
- `shared/redis` 已存在
- `shared/auth` 已存在
- 无新增依赖

## 影响范围

- `backend/services/social-service/src/index.js`（修改）
- 解锁 REQ-00074 的全部功能

## 参考

- 关联需求：REQ-00074（玩家排行榜系统）
- 欠账来源：GUIDELINES.md §6 集成欠账清单
