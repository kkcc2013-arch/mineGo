# REQ-00152: gym-service battle 路由挂载与集成

- **编号**: REQ-00152
- **类别**: 集成与修复
- **优先级**: P0
- **状态**: done
- **涉及服务/模块**: gym-service、backend/services/gym-service/src/index.js、backend/services/gym-service/src/routes/battle.js
- **创建时间**: 2026-06-12 10:05
- **依赖需求**: REQ-00054（道馆战斗系统，已实现但路由未挂载）

## 1. 背景与问题

REQ-00054（道馆战斗系统）已实现完整的战斗引擎（battleEngine.js 17.8KB）和战斗 API 路由（battle.js 20KB，7 个端点），但 **battle.js 路由从未挂载到 gym-service 的 index.js**。

这导致：
- 7 个战斗 API 端点完全不可达（404）
- REQ-00054 标记为 done，但实际功能无法使用
- 道馆战斗系统（回合制战斗、属性克制、状态效果、AI 防守策略）全部失效
- 玩家无法进行道馆挑战、Raid 战斗

这是 GUIDELINES.md §6 明确列出的 P0 集成欠账。

## 2. 目标

挂载 battle.js 路由到 gym-service，解锁 REQ-00054 的全部功能，让 7 个战斗 API 端点立即可用。

## 3. 范围

- **包含**:
  - 在 gym-service/src/index.js 中挂载 battle 路由
  - 验证 7 个端点可达
  - 更新 INDEX.md 和 STATUS.md
  
- **不包含**:
  - 修改 battle.js 代码（已实现完整）
  - 新增功能或端点
  - 前端集成（已有 BattleScene.js）

## 4. 详细需求

### 4.1 路由挂载

在 `backend/services/gym-service/src/index.js` 中添加：

```javascript
const battleRoutes = require('./routes/battle');
app.use('/api/v1/gym/battle', battleRoutes);
```

### 4.2 验证端点

battle.js 包含以下 7 个端点（需全部验证可达）：

1. `POST /api/v1/gym/battle/start` - 开始战斗
2. `POST /api/v1/gym/battle/:battleId/action` - 执行战斗动作
3. `GET /api/v1/gym/battle/:battleId` - 查询战斗状态
4. `POST /api/v1/gym/battle/:battleId/flee` - 逃离战斗
5. `GET /api/v1/gym/battle/:battleId/replay` - 战斗回放
6. `POST /api/v1/gym/battle/team` - 保存战斗队伍预设
7. `GET /api/v1/gym/battle/team` - 查询战斗队伍预设

### 4.3 路由顺序

确保 battle 路由挂载在其他路由之后，避免路径冲突。

## 5. 验收标准（可测试）

- [ ] `node --check backend/services/gym-service/src/index.js` 通过
- [ ] `grep -q "battleRoutes" backend/services/gym-service/src/index.js` 返回 0（路由已挂载）
- [ ] `curl -sf http://localhost:3006/api/v1/gym/battle/team` 返回非 404（端点可达）
- [ ] `node backend/tests/unit/gym-battle.test.js` 通过（已有 40+ 测试）
- [ ] gym-service 启动无错误

## 6. 工作量估算

**S** - 仅需挂载 1 行代码 + 验证，无需新开发。

## 7. 优先级理由

P0 理由：
1. 解锁 REQ-00054（道馆战斗系统）的全部功能，这是核心游戏玩法
2. 代码已存在，仅需挂载，风险极低
3. 影响玩家核心体验（道馆挑战、Raid 战斗）
4. GUIDELINES.md 明确列出的 P0 集成欠账
