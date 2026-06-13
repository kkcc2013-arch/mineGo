# REQ-00128: social-service PVP 路由挂载与集成

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00128 |
| 标题 | social-service PVP 路由挂载与集成 |
| 类别 | 集成与修复 |
| 优先级 | P0 |
| 状态 | done |
| 涉及服务 | social-service |
| 创建时间 | 2026-06-11 21:05 |

## 背景与价值

**问题**：`backend/services/social-service/src/routes/pvp.js` 已实现完整的 PVP 玩家对战系统 API（13+ 个端点），但从未在 `index.js` 中挂载，导致所有 PVP 功能无法使用。

**影响**：
- REQ-00073（玩家对战系统 PVP Duel）标记为"已完成"，但实际功能不可达
- 玩家无法进行匹配、创建对战房间、发起/结束战斗等核心操作
- ELO 排名、战斗历史、赛季奖励等功能无法使用

**价值**：挂载后立即解锁 REQ-00073 的全部功能，无需额外开发。

## 验收标准（必填，必须是可执行命令）

- [ ] `node --check backend/services/social-service/src/index.js` 通过
- [ ] `node --check backend/services/social-service/src/routes/pvp.js` 通过
- [ ] `grep -q "pvpRoutes" backend/services/social-service/src/index.js` 路由已挂载
- [ ] `curl -sf http://localhost:8086/health` 返回 200（服务可启动）
- [ ] 启动服务后，`curl -sf http://localhost:8086/pvp/match/join -X POST -H "Authorization: Bearer test"` 返回非 404

## 技术方案

### 1. 路由挂载
在 `social-service/src/index.js` 中：

```javascript
// 在文件顶部添加
const pvpRoutes = require('./routes/pvp');

// 在路由区域添加
app.use('/pvp', pvpRoutes);
```

### 2. 端点清单（共 13+ 个）

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/pvp/match/join` | 加入匹配队列 |
| POST | `/pvp/match/leave` | 离开匹配队列 |
| GET | `/pvp/match/status` | 查询匹配状态 |
| POST | `/pvp/battle/create` | 创建对战房间 |
| GET | `/pvp/battle/:roomId` | 获取房间信息 |
| POST | `/pvp/battle/:roomId/start` | 开始战斗 |
| POST | `/pvp/battle/:roomId/action` | 执行战斗动作 |
| POST | `/pvp/battle/:roomId/end` | 结束战斗 |
| GET | `/pvp/history` | 战斗历史 |
| GET | `/pvp/ranking` | ELO 排名 |
| POST | `/pvp/team` | 设置 PVP 队伍 |
| GET | `/pvp/team` | 获取 PVP 队伍 |
| GET | `/pvp/seasons` | 赛季列表 |

### 3. 依赖检查
- `shared/db` 已存在
- `shared/auth` 已存在
- `shared/logger` 已存在
- `shared/pvpMatching` 已存在
- `shared/pvpBattleRoom` 已存在
- 无新增依赖

## 影响范围

- `backend/services/social-service/src/index.js`（修改）
- 解锁 REQ-00073 的全部功能

## 参考

- 关联需求：REQ-00073（玩家对战系统 PVP Duel）
- 欠账来源：GUIDELINES.md §6 集成欠账清单
