# REQ-00131: pokemon-service achievements 路由挂载与集成

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00131 |
| 标题 | pokemon-service achievements 路由挂载与集成 |
| 类别 | 集成与修复 |
| 优先级 | P0 |
| 状态 | new |
| 涉及服务 | pokemon-service |
| 创建时间 | 2026-06-11 23:00 |

## 背景与价值

**现状**：`backend/services/pokemon-service/src/routes/achievements.js` 已实现完整的成就系统 API（8 个端点），但从未在 `pokemon-service/src/index.js` 中挂载，导致 REQ-00076（精灵成就系统与里程碑奖励）的功能完全不可用。

**影响**：
- 玩家无法查看成就进度、领取成就奖励
- 称号系统无法使用
- 成就排行榜不可访问
- 里程碑奖励功能完全失效

**价值**：挂载后立即解锁 8 个成就相关端点，无需额外开发，玩家可立即使用成就系统功能。

## 验收标准（必须全部通过）

### 1. 语法检查
```bash
node --check backend/services/pokemon-service/src/routes/achievements.js
node --check backend/services/pokemon-service/src/index.js
```

### 2. 路由挂载验证
```bash
grep -q "achievementsRouter" backend/services/pokemon-service/src/index.js
grep -q "app.use.*achievements" backend/services/pokemon-service/src/index.js
```

### 3. 端点可达性验证（服务启动后）
```bash
# 假设 pokemon-service 运行在 localhost:3003
curl -sf -H "X-User-Id: 1" http://localhost:3003/achievements/my
curl -sf -H "X-User-Id: 1" http://localhost:3003/achievements/my/progress
curl -sf -H "X-User-Id: 1" http://localhost:3003/achievements/leaderboard/global
curl -sf -H "X-User-Id: 1" http://localhost:3003/achievements/titles
```

### 4. 单元测试（如有）
```bash
# 检查是否有相关测试文件
ls backend/tests/unit/achievement*.test.js 2>/dev/null || echo "No test file found"
```

## 技术方案

### 1. 在 pokemon-service/src/index.js 中添加路由挂载

```javascript
// 在文件顶部导入区域添加
const achievementsRouter = require('./routes/achievements');

// 在现有路由挂载区域添加（建议在其他业务路由之后）
app.use('/achievements', achievementsRouter);
```

### 2. 挂载位置建议

建议在以下位置插入：
- 在 `app.use('/pokemon', showcaseRouter);` 之后
- 在 `app.use(errorHandler);` 之前

### 3. 路由端点清单

挂载后将解锁以下 8 个端点：

| 方法 | 路径 | 功能 | 认证 |
|------|------|------|------|
| GET | /achievements/my | 获取用户成就列表 | 需要 |
| GET | /achievements/my/progress | 获取成就进度概览 | 需要 |
| GET | /achievements/:achievementId | 获取单个成就详情 | 需要 |
| POST | /achievements/:achievementId/claim | 领取成就奖励 | 需要 |
| GET | /achievements/leaderboard/global | 成就排行榜 | 不需要 |
| POST | /achievements/titles/:titleId/activate | 激活称号 | 需要 |
| GET | /achievements/titles | 获取用户称号列表 | 需要 |
| POST | /achievements/event | 记录成就事件 | 需要 |

### 4. 依赖检查

确认以下依赖已存在：
- `achievementService.js` - 成就服务核心逻辑
- `../shared/db` - 数据库连接
- `../shared/logger` - 日志模块
- `../shared/metrics` - Prometheus 指标

## 影响范围

- **修改文件**：
  - `backend/services/pokemon-service/src/index.js`（添加路由挂载）

- **解锁功能**：
  - REQ-00076（精灵成就系统与里程碑奖励）的全部功能
  - 8 个成就相关 API 端点立即可用

- **无需修改**：
  - `routes/achievements.js`（已实现完整）
  - `achievementService.js`（已实现完整）

## 完成定义（DoD）

代码已提交 ≠ 完成。以下条件全部满足才算完成：

1. ✅ 路由已在 `pokemon-service/src/index.js` 挂载
2. ✅ 语法检查通过（`node --check`）
3. ✅ 服务启动成功，无报错
4. ✅ 所有 8 个端点可达（curl 返回非 404）
5. ✅ CI 流水线通过

## 参考

- 关联需求：REQ-00076（精灵成就系统与里程碑奖励）
- 路由文件：`backend/services/pokemon-service/src/routes/achievements.js`
- 服务文件：`backend/services/pokemon-service/src/achievementService.js`
- GUIDELINES.md §6 欠账清单
