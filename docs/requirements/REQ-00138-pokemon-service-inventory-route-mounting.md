# REQ-00138: pokemon-service inventory 路由挂载与集成

- 类别: 集成与修复
- 优先级: P0
- 父需求: REQ-00047（精灵道具与背包管理系统）
- 状态: done

## 背景与价值

**现状**：`backend/services/pokemon-service/src/routes/inventory.js` 已完整实现背包管理功能（12 个端点），但从未在 `index.js` 挂载，导致：
- REQ-00047（精灵道具与背包管理系统）标记为"已完成"但功能实际不可用
- 用户无法使用背包查询、道具使用、丢弃等核心功能
- 道具合成、兑换等高级功能完全无法访问

**价值**：挂载路由后，立即解锁 REQ-00047 的全部功能，12 个端点立即可用。

## 验收标准（可执行命令）

- [ ] `node --check backend/services/pokemon-service/src/index.js` 通过
- [ ] `node --check backend/services/pokemon-service/src/routes/inventory.js` 通过
- [ ] `curl -sf http://localhost:3003/inventory -H "Authorization: Bearer test"` 返回非 404（需要认证，返回 401 或 200）
- [ ] `curl -sf http://localhost:3003/inventory/stats -H "Authorization: Bearer test"` 返回非 404
- [ ] `grep -q "inventory" backend/services/pokemon-service/src/index.js` 验证路由已挂载
- [ ] `node backend/tests/unit/inventory.test.js` 通过（如有）

## 实现内容

### 1. 在 pokemon-service/src/index.js 挂载路由

```javascript
// 在已有路由挂载代码之后添加
const inventoryRouter = require('./routes/inventory');
app.use('/inventory', inventoryRouter);
```

### 2. 验证端点可达

inventory.js 提供的 12 个端点：
- `GET /inventory` - 查询背包
- `GET /inventory/stats` - 背包统计
- `GET /inventory/categories/:category` - 按类别查询
- `POST /inventory/:itemId/use` - 使用道具
- `POST /inventory/:itemId/discard` - 丢弃道具
- `POST /inventory/organize` - 整理背包
- `POST /inventory/sort` - 排序背包
- `GET /inventory/capacity` - 查询容量
- `POST /inventory/capacity/expand` - 扩展容量
- `POST /inventory/items/:itemId1/combine` - 合成道具
- `POST /inventory/items/exchange` - 兑换道具
- `GET /inventory/history` - 操作历史

## 完成定义（DoD）

代码已提交 ≠ 完成。全部验收命令通过 + 路由可达 + CI 绿 = 完成。

## 关联需求

- 父需求：REQ-00047（精灵道具与背包管理系统）
- 相关：REQ-00132（pokemon-service inventory 路由挂载与集成，状态：new）
