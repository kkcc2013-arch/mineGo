# REQ-00133: pokemon-service pokedex 路由挂载与集成

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00133 |
| 标题 | pokemon-service pokedex 路由挂载与集成 |
| 类别 | 集成与修复 |
| 优先级 | P0 |
| 状态 | done |
| 涉及服务 | pokemon-service |
| 创建时间 | 2026-06-11 23:20 |

## 背景与价值

**现状**：`backend/services/pokemon-service/src/routes/pokedex.js` 已实现完整的精灵图鉴系统 API（15 个端点），但从未在 `pokemon-service/src/index.js` 中挂载，导致精灵图鉴功能完全不可用。

**影响**：
- 玩家无法查看精灵图鉴、查询精灵信息
- 图鉴完成度统计、收集进度追踪功能失效
- 精灵属性、技能、进化链查询不可用
- 稀有度统计、地区分布查询功能无法使用

**价值**：挂载后立即解锁 15 个图鉴相关端点，无需额外开发，玩家可立即使用图鉴系统功能。

## 验收标准（必须全部通过）

### 1. 语法检查
```bash
node --check backend/services/pokemon-service/src/routes/pokedex.js
node --check backend/services/pokemon-service/src/index.js
```

### 2. 路由挂载验证
```bash
grep -q "pokedexRouter" backend/services/pokemon-service/src/index.js
grep -q "app.use.*pokedex" backend/services/pokemon-service/src/index.js
```

### 3. 端点可达性验证（服务启动后）
```bash
# 假设 pokemon-service 运行在 localhost:3003
curl -sf http://localhost:3003/pokedex
curl -sf http://localhost:3003/pokedex/stats
curl -sf http://localhost:3003/pokedex/completion
```

### 4. 单元测试（如有）
```bash
ls backend/tests/unit/pokedex*.test.js 2>/dev/null || echo "No test file found"
```

## 技术方案

### 1. 在 pokemon-service/src/index.js 中添加路由挂载

```javascript
// 在文件顶部导入区域添加
const pokedexRouter = require('./routes/pokedex');

// 在现有路由挂载区域添加（建议在其他业务路由之后）
app.use('/pokedex', pokedexRouter);
```

### 2. 挂载位置建议

建议在以下位置插入：
- 在 `app.use('/inventory', inventoryRouter);` 之后
- 在 `app.use(errorHandler);` 之前

### 3. 路由端点清单

挂载后将解锁以下 15 个端点：

| 方法 | 路径 | 功能 | 认证 |
|------|------|------|------|
| GET | /pokedex | 获取完整图鉴列表 | 可选 |
| GET | /pokedex/:pokemonId | 获取精灵详情 | 可选 |
| GET | /pokedex/:pokemonId/stats | 获取精灵属性统计 | 可选 |
| GET | /pokedex/:pokemonId/moves | 获取精灵可学技能 | 可选 |
| GET | /pokedex/:pokemonId/evolutions | 获取进化链 | 可选 |
| GET | /pokedex/search | 搜索精灵 | 可选 |
| GET | /pokedex/type/:type | 按属性查询精灵 | 可选 |
| GET | /pokedex/generation/:gen | 按世代查询精灵 | 可选 |
| GET | /pokedex/rarity/:rarity | 按稀有度查询精灵 | 可选 |
| GET | /pokedex/region/:region | 按地区查询精灵 | 可选 |
| GET | /pokedex/stats | 图鉴统计信息 | 可选 |
| GET | /pokedex/completion | 用户图鉴完成度 | 需要 |
| POST | /pokedex/favorites | 添加收藏精灵 | 需要 |
| DELETE | /pokedex/favorites/:pokemonId | 移除收藏精灵 | 需要 |
| GET | /pokedex/favorites | 获取收藏列表 | 需要 |

### 4. 依赖检查

确认以下依赖已存在：
- `pokedexService.js` - 图鉴服务核心逻辑
- `../shared/db` - 数据库连接
- `../shared/logger` - 日志模块
- `../shared/metrics` - Prometheus 指标

## 影响范围

- **修改文件**：
  - `backend/services/pokemon-service/src/index.js`（添加路由挂载）

- **解锁功能**：
  - 精灵图鉴系统的全部功能
  - 15 个图鉴相关 API 端点立即可用

- **无需修改**：
  - `routes/pokedex.js`（已实现完整）
  - `pokedexService.js`（已实现完整）

## 完成定义（DoD）

代码已提交 ≠ 完成。以下条件全部满足才算完成：

1. ✅ 路由已在 `pokemon-service/src/index.js` 挂载
2. ✅ 语法检查通过（`node --check`）
3. ✅ 服务启动成功，无报错
4. ✅ 所有 15 个端点可达（curl 返回非 404）
5. ✅ CI 流水线通过

## 参考

- 路由文件：`backend/services/pokemon-service/src/routes/pokedex.js`
- 服务文件：`backend/services/pokemon-service/src/pokedexService.js`
- GUIDELINES.md §6 欠账清单
