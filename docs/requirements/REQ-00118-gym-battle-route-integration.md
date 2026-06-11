# REQ-00118: gym-service 战斗路由挂载与集成

- **编号**：REQ-00118
- **类别**：集成与修复
- **优先级**：P0
- **状态**：done
- **涉及服务/模块**：gym-service、backend/services/gym-service/src/index.js、backend/services/gym-service/src/routes/battle.js
- **创建时间**：2026-06-11 17:15
- **依赖需求**：REQ-00054

## 1. 背景与问题

**P0 集成欠账**：`backend/services/gym-service/src/routes/battle.js` 文件已存在，包含完整的战斗系统 API（7个端点），但从未在 `index.js` 中挂载，导致：

1. 所有战斗 API 返回 404，无法访问
2. BattleEngine 核心模块从未被实际使用
3. REQ-00054 标记为"done"，但实际功能不可用
4. 用户无法使用完整的道馆战斗系统

这是典型的"孤儿路由"问题，违反 GUIDELINES.md 质量红线第 2 条。

## 2. 目标

将已实现的战斗路由挂载到 gym-service，使所有战斗 API 端点可访问：
- POST /api/v1/gym/:gymId/battle/start
- POST /api/v1/battle/:battleId/turn
- POST /api/v1/battle/:battleId/switch
- POST /api/v1/gym/:gymId/defend
- GET /api/v1/battle/:battleId/replay
- GET /api/v1/battle/teams
- POST /api/v1/battle/teams

## 3. 范围

### 包含
- 在 index.js 中 require 并挂载 battle 路由
- 替换现有的简化版战斗逻辑（line 214-280）
- 验证所有 7 个端点可达
- 更新文档说明

### 不包含
- BattleEngine 代码修改
- 新增战斗功能
- 数据库迁移

## 4. 详细需求

### 4.1 修改 index.js

**修改前**（line 1-10）：
```javascript
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const helmet    = require('helmet');
const { query, transaction } = require('../../../shared/db');
// ... 其他 imports
```

**修改后**：
```javascript
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const helmet    = require('helmet');
const { query, transaction } = require('../../../shared/db');
// ... 其他 imports
const battleRoutes = require('./routes/battle'); // 新增
```

**修改前**（line 200-280）：
```javascript
// POST /gyms/:id/battle
app.post('/gyms/:id/battle', requireAuth, validateLocation, checkRateLimit('GYM_BATTLE'), async (req, res, next) => {
  // Simplified battle simulation
  const { id } = req.params;
  // ... 简化版战斗逻辑
});
```

**修改后**：
```javascript
// 挂载战斗路由
app.use('/api/v1', battleRoutes);
```

### 4.2 验收命令

```bash
# 1. 语法检查
node --check backend/services/gym-service/src/index.js
node --check backend/services/gym-service/src/routes/battle.js
node --check backend/services/gym-service/src/battleEngine.js

# 2. 路由挂载验证
grep -n "battleRoutes" backend/services/gym-service/src/index.js

# 3. 端点可达性测试（需要服务运行）
curl -sf http://localhost:8085/api/v1/battle/teams
curl -sf -X POST http://localhost:8085/api/v1/gym/test-gym-id/battle/start -H "Content-Type: application/json" -d '{"teamIds":["test-id"]}' -H "Authorization: Bearer test-token"

# 4. 模块加载测试
node -e "const routes = require('./backend/services/gym-service/src/routes/battle.js'); console.log('Routes loaded:', typeof routes)"
node -e "const engine = require('./backend/services/gym-service/src/battleEngine.js'); console.log('BattleEngine loaded:', typeof engine.BattleEngine)"
```

## 5. 验收标准（可测试）

- [ ] `node --check backend/services/gym-service/src/index.js` 通过
- [ ] `node --check backend/services/gym-service/src/routes/battle.js` 通过
- [ ] `node --check backend/services/gym-service/src/battleEngine.js` 通过
- [ ] `grep -n "battleRoutes" backend/services/gym-service/src/index.js` 输出包含挂载行
- [ ] `node -e "require('./backend/services/gym-service/src/routes/battle.js')"` 加载成功
- [ ] `curl -sf http://localhost:8085/api/v1/battle/teams` 返回 200 或 401（需要认证）
- [ ] 所有 7 个战斗端点路径在 routes/battle.js 中存在

## 6. 工作量估算

**S（小型）**

- 代码修改：10 分钟
- 测试验证：20 分钟
- 文档更新：10 分钟

**总计**：40 分钟

## 7. 优先级理由

P0（最高优先级）：
- 功能已实现但不可用，属于集成欠账
- 影响核心业务流程（道馆战斗）
- 修复成本低，风险极小
- 违反质量红线，必须立即修复
