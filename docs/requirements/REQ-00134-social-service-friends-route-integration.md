# REQ-00134: social-service friends 路由挂载与集成

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00134 |
| 标题 | social-service friends 路由挂载与集成 |
| 类别 | 集成与修复 |
| 优先级 | P0 |
| 状态 | done |
| 涉及服务 | social-service |
| 创建时间 | 2026-06-11 23:30 |

## 背景与价值

**现状**：`backend/services/social-service/src/routes/friends.js` 已实现完整的好友系统 API（17 个端点），但从未在 `social-service/src/index.js` 中挂载，导致好友系统功能完全不可用。

**影响**：
- 玩家无法添加好友、查看好友列表
- 好友申请、接受、拒绝功能失效
- 好友在线状态、亲密度查询不可用
- 好友推荐、搜索功能无法使用

**价值**：挂载后立即解锁 17 个好友相关端点，无需额外开发，玩家可立即使用好友系统功能。

## 验收标准（必须全部通过）

### 1. 语法检查
```bash
node --check backend/services/social-service/src/routes/friends.js
node --check backend/services/social-service/src/index.js
```

### 2. 路由挂载验证
```bash
grep -q "friendsRouter" backend/services/social-service/src/index.js
grep -q "app.use.*friends" backend/services/social-service/src/index.js
```

### 3. 端点可达性验证（服务启动后）
```bash
# 假设 social-service 运行在 localhost:3004
curl -sf -H "Authorization: Bearer test-token" http://localhost:3004/friends
curl -sf -H "Authorization: Bearer test-token" http://localhost:3004/friends/requests
curl -sf -H "Authorization: Bearer test-token" http://localhost:3004/friends/online
```

### 4. 单元测试（如有）
```bash
ls backend/tests/unit/friend*.test.js 2>/dev/null || echo "No test file found"
```

## 技术方案

### 1. 在 social-service/src/index.js 中添加路由挂载

```javascript
// 在文件顶部导入区域添加
const friendsRouter = require('./routes/friends');

// 在现有路由挂载区域添加（建议在其他业务路由之后）
app.use('/friends', friendsRouter);
```

### 2. 挂载位置建议

建议在以下位置插入：
- 在 `app.use('/leaderboard', leaderboardRouter);` 之后
- 在 `app.use(errorHandler);` 之前

### 3. 路由端点清单

挂载后将解锁以下 17 个端点：

| 方法 | 路径 | 功能 | 认证 |
|------|------|------|------|
| GET | /friends | 获取好友列表 | 需要 |
| POST | /friends/request | 发送好友申请 | 需要 |
| GET | /friends/requests | 获取好友申请列表 | 需要 |
| POST | /friends/requests/:requestId/accept | 接受好友申请 | 需要 |
| POST | /friends/requests/:requestId/reject | 拒绝好友申请 | 需要 |
| DELETE | /friends/:friendId | 删除好友 | 需要 |
| GET | /friends/:friendId | 获取好友详情 | 需要 |
| GET | /friends/online | 获取在线好友 | 需要 |
| GET | /friends/search | 搜索好友 | 需要 |
| GET | /friends/recommendations | 获取好友推荐 | 需要 |
| POST | /friends/:friendId/block | 拉黑好友 | 需要 |
| DELETE | /friends/:friendId/block | 取消拉黑 | 需要 |
| GET | /friends/blocked | 获取拉黑列表 | 需要 |
| GET | /friends/:friendId/intimacy | 获取亲密度 | 需要 |
| POST | /friends/:friendId/gift | 赠送礼物 | 需要 |
| GET | /friends/stats | 好友统计信息 | 需要 |
| POST | /friends/:friendId/note | 设置好友备注 | 需要 |

### 4. 依赖检查

确认以下依赖已存在：
- `friendService.js` - 好友服务核心逻辑
- `../shared/db` - 数据库连接
- `../shared/logger` - 日志模块
- `../shared/metrics` - Prometheus 指标

## 影响范围

- **修改文件**：
  - `backend/services/social-service/src/index.js`（添加路由挂载）

- **解锁功能**：
  - 好友系统的全部功能
  - 17 个好友相关 API 端点立即可用

- **无需修改**：
  - `routes/friends.js`（已实现完整）
  - `friendService.js`（已实现完整）

## 完成定义（DoD）

代码已提交 ≠ 完成。以下条件全部满足才算完成：

1. ✅ 路由已在 `social-service/src/index.js` 挂载
2. ✅ 语法检查通过（`node --check`）
3. ✅ 服务启动成功，无报错
4. ✅ 所有 17 个端点可达（curl 返回非 404）
5. ✅ CI 流水线通过

## 参考

- 路由文件：`backend/services/social-service/src/routes/friends.js`
- 服务文件：`backend/services/social-service/src/friendService.js`
- GUIDELINES.md §6 欠账清单
