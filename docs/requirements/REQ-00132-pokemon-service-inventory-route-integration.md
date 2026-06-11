# REQ-00132: pokemon-service inventory 路由挂载与集成

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00132 |
| 标题 | pokemon-service inventory 路由挂载与集成 |
| 类别 | 集成与修复 |
| 优先级 | P0 |
| 状态 | new |
| 涉及服务 | pokemon-service |
| 创建时间 | 2026-06-11 23:10 |

## 背景与价值

**现状**：`backend/services/pokemon-service/src/routes/inventory.js` 已实现完整的道具与背包管理系统 API（12 个端点），但从未在 `pokemon-service/src/index.js` 中挂载，导致 REQ-00047（精灵道具与背包管理系统）的功能完全不可用。

**影响**：
- 玩家无法查看背包、使用道具
- 道具使用、丢弃、整理等功能不可用
- 背包容量管理、分类查询功能失效
- 道具合成、兑换等高级功能无法使用

**价值**：挂载后立即解锁 12 个道具与背包相关端点，无需额外开发，玩家可立即使用背包系统功能。

## 验收标准（必须全部通过）

### 1. 语法检查
```bash
node --check backend/services/pokemon-service/src/routes/inventory.js
node --check backend/services/pokemon-service/src/index.js
```

### 2. 路由挂载验证
```bash
grep -q "inventoryRouter" backend/services/pokemon-service/src/index.js
grep -q "app.use.*inventory" backend/services/pokemon-service/src/index.js
```

### 3. 端点可达性验证（服务启动后）
```bash
# 假设 pokemon-service 运行在 localhost:3003
curl -sf -H "Authorization: Bearer test-token" http://localhost:3003/inventory
curl -sf -H "Authorization: Bearer test-token" http://localhost:3003/inventory/categories
curl -sf -H "Authorization: Bearer test-token" http://localhost:3003/inventory/stats
```

### 4. 单元测试（如有）
```bash
ls backend/tests/unit/inventory*.test.js 2>/dev/null || echo "No test file found"
```

## 技术方案

### 1. 在 pokemon-service/src/index.js 中添加路由挂载

```javascript
// 在文件顶部导入区域添加
const inventoryRouter = require('./routes/inventory');

// 在现有路由挂载区域添加（建议在其他业务路由之后）
app.use('/inventory', inventoryRouter);
```

### 2. 挂载位置建议

建议在以下位置插入：
- 在 `app.use('/pokemon', showcaseRouter);` 之后
- 在 `app.use(errorHandler);` 之前

### 3. 路由端点清单

挂载后将解锁以下 12 个端点：

| 方法 | 路径 | 功能 | 认证 |
|------|------|------|------|
| GET | /inventory | 获取玩家背包 | 需要 |
| GET | /inventory/:itemId | 获取道具详情 | 需要 |
| POST | /inventory/:itemId/use | 使用道具 | 需要 |
| DELETE | /inventory/:itemId | 丢弃道具 | 需要 |
| POST | /inventory/organize | 整理背包 | 需要 |
| GET | /inventory/categories | 获取背包分类 | 需要 |
| GET | /inventory/category/:category | 按分类查询道具 | 需要 |
| POST | /inventory/merge | 合并相同道具 | 需要 |
| POST | /inventory/split | 拆分堆叠道具 | 需要 |
| GET | /inventory/stats | 背包统计信息 | 需要 |
| POST | /inventory/expand | 扩展背包容量 | 需要 |
| POST | /inventory/exchange | 道具兑换 | 需要 |

### 4. 依赖检查

确认以下依赖已存在：
- `inventoryService.js` - 背包服务核心逻辑
- `../shared/auth` - 认证中间件
- `../shared/middleware/rateLimit` - 限流中间件
- `../shared/logger` - 日志模块
- `../shared/metrics` - Prometheus 指标

## 影响范围

- **修改文件**：
  - `backend/services/pokemon-service/src/index.js`（添加路由挂载）

- **解锁功能**：
  - REQ-00047（精灵道具与背包管理系统）的全部功能
  - 12 个道具与背包相关 API 端点立即可用

- **无需修改**：
  - `routes/inventory.js`（已实现完整）
  - `inventoryService.js`（已实现完整）

## 完成定义（DoD）

代码已提交 ≠ 完成。以下条件全部满足才算完成：

1. ✅ 路由已在 `pokemon-service/src/index.js` 挂载
2. ✅ 语法检查通过（`node --check`）
3. ✅ 服务启动成功，无报错
4. ✅ 所有 12 个端点可达（curl 返回非 404）
5. ✅ CI 流水线通过

## 参考

- 关联需求：REQ-00047（精灵道具与背包管理系统）
- 路由文件：`backend/services/pokemon-service/src/routes/inventory.js`
- 服务文件：`backend/services/pokemon-service/src/inventoryService.js`
- GUIDELINES.md §6 欠账清单
