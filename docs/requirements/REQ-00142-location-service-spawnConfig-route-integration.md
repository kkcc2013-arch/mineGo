# REQ-00142: location-service spawnConfig 路由挂载与集成

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00142 |
| 标题 | location-service spawnConfig 路由挂载与集成 |
| 类别 | 集成与修复 |
| 优先级 | P0 |
| 状态 | done |
| 涉及服务 | location-service |
| 创建时间 | 2026-06-12 04:10 |

## 背景与价值

**现状**：`backend/services/location-service/src/routes/spawnConfig.js` 已实现完整的精灵刷新配置管理 API（管理员端点），但从未在 `location-service/src/index.js` 中挂载，导致精灵刷新管理系统功能完全不可用。

**影响**：
- 管理员无法配置各区域的精灵刷新数量
- 无法设置刷新倍率（活动加成等）
- 无法管理稀有精灵刷新点
- 无法查看刷新统计信息

**价值**：挂载后立即解锁精灵刷新配置管理功能，无需额外开发，管理员可立即配置游戏内容。

## 验收标准（必须全部通过）

### 1. 语法检查
```bash
node --check backend/services/location-service/src/routes/spawnConfig.js
node --check backend/services/location-service/src/index.js
```

### 2. 路由挂载验证
```bash
grep -q "spawnConfig" backend/services/location-service/src/index.js
grep -q "app.use.*spawn" backend/services/location-service/src/index.js
```

### 3. 端点可达性验证（服务启动后）
```bash
# 假设 location-service 运行在 localhost:3003
curl -sf -H "Authorization: Bearer admin-token" http://localhost:3003/api/admin/spawn/config/cell/test
```

## 技术方案

### 1. 修复 spawnConfig.js 的导入问题

当前文件使用 `@pmg/shared/logger`，需要改为正确路径：
```javascript
const { createLogger } = require('../../../shared/logger');
```

### 2. 在 location-service/src/index.js 中添加路由挂载

```javascript
// 在文件顶部导入区域添加
const spawnConfigRouter = require('./routes/spawnConfig');

// 在现有路由挂载区域添加（建议在其他业务路由之后）
app.use('/api/admin/spawn', spawnConfigRouter);
```

### 3. 路由端点清单

挂载后将解锁以下管理员端点：

| 方法 | 路径 | 功能 | 认证 |
|------|------|------|------|
| GET | /api/admin/spawn/config/cell/:geohash | 获取单元格刷新配置 | 管理员 |
| PUT | /api/admin/spawn/config/cell/:geohash | 更新单元格刷新配置 | 管理员 |
| GET | /api/admin/spawn/config/rarity | 获取稀有度配置 | 管理员 |
| PUT | /api/admin/spawn/config/rarity | 更新稀有度配置 | 管理员 |
| GET | /api/admin/spawn/spawnpoints | 获取刷新点列表 | 管理员 |
| POST | /api/admin/spawn/spawnpoints | 创建刷新点 | 管理员 |
| DELETE | /api/admin/spawn/spawnpoints/:id | 删除刷新点 | 管理员 |
| GET | /api/admin/spawn/stats | 获取刷新统计 | 管理员 |

### 4. 依赖检查

确认以下依赖已存在：
- `../../../shared/logger` - 日志模块
- `../../../shared/db` - 数据库连接

## 影响范围

- **修改文件**：
  - `backend/services/location-service/src/index.js`（添加路由挂载）
  - `backend/services/location-service/src/routes/spawnConfig.js`（修复导入路径）

- **解锁功能**：
  - 精灵刷新配置管理系统的全部功能
  - 8+ 个管理员 API 端点立即可用

- **无需修改**：
  - 其他服务或模块

## 完成定义（DoD）

代码已提交 ≠ 完成。以下条件全部满足才算完成：

1. ✅ 路由已在 `location-service/src/index.js` 挂载
2. ✅ 语法检查通过（`node --check`）
3. ✅ 服务启动成功，无报错
4. ✅ 所有端点可达（curl 返回非 404）
5. ✅ CI 流水线通过

## 参考

- 路由文件：`backend/services/location-service/src/routes/spawnConfig.js`
- REQ-00069: 精灵资源管理系统与动态刷新控制
- GUIDELINES.md §6 欠账清单
