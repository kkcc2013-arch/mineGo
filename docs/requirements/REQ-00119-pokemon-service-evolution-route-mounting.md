# REQ-00119: pokemon-service 进化路由挂载与集成

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00119 |
| 标题 | pokemon-service 进化路由挂载与集成 |
| 类别 | 集成与修复 |
| 优先级 | P0 |
| 状态 | new |
| 涉及服务 | pokemon-service |
| 创建时间 | 2026-06-11 17:30 |

## 背景与价值

**问题**：`backend/services/pokemon-service/src/routes/evolution.js` 已实现完整的精灵进化与成长系统 API（7 个端点），但从未在 `index.js` 中挂载，导致所有进化相关功能无法使用。

**影响**：
- REQ-00065（精灵进化与成长系统）标记为"已完成"，但实际功能不可达
- 用户无法检查精灵进化条件、执行进化、添加经验值等核心操作
- 进化历史、进化道具查询等辅助功能无法使用

**价值**：挂载后立即解锁 REQ-00065 的全部功能，无需额外开发。

## 验收标准（必填，必须是可执行命令）

- [ ] `node --check backend/services/pokemon-service/src/index.js` 通过
- [ ] `node --check backend/services/pokemon-service/src/routes/evolution.js` 通过
- [ ] `grep -q "evolutionRouter" backend/services/pokemon-service/src/index.js` 路由已挂载
- [ ] `curl -sf http://localhost:8083/health` 返回 200（服务可启动）
- [ ] 启动服务后，`curl -sf http://localhost:8083/pokemon/1/evolution/check -H "x-user-id: test"` 返回非 404

## 技术方案

### 1. 路由挂载
在 `pokemon-service/src/index.js` 中添加：

```javascript
// REQ-00119: 精灵进化与成长系统路由
const evolutionRouter = require('./routes/evolution');
app.use('/pokemon', evolutionRouter);
```

### 2. 端点清单（共 7 个）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/pokemon/:id/evolution/check` | 检查精灵是否可以进化 |
| POST | `/pokemon/:id/evolution/execute` | 执行进化 |
| POST | `/pokemon/:id/experience` | 添加经验值 |
| POST | `/pokemon/:id/friendship` | 增加亲密度 |
| GET | `/pokemon/:id/stats` | 获取精灵详细属性 |
| GET | `/pokemon/evolution/items` | 获取所有进化道具 |
| GET | `/pokemon/evolution/history/:userId` | 获取用户进化历史 |

### 3. 依赖检查
- `evolutionService.js` 必须存在且可加载
- `shared/logger` 已存在
- 无新增依赖

## 影响范围

- `backend/services/pokemon-service/src/index.js`（修改）
- 解锁 REQ-00065 的全部功能

## 参考

- 关联需求：REQ-00065（精灵进化与成长系统）
- 欠账来源：GUIDELINES.md §6 集成欠账清单
