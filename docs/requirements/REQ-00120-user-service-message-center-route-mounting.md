# REQ-00120: user-service 消息中心路由挂载与集成

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00120 |
| 标题 | user-service 消息中心路由挂载与集成 |
| 类别 | 集成与修复 |
| 优先级 | P0 |
| 状态 | new |
| 涉及服务 | user-service |
| 创建时间 | 2026-06-11 17:35 |

## 背景与价值

**问题**：`backend/services/user-service/src/routes/messageCenter.js` 已实现完整的游戏消息中心 API（8 个端点），但从未在 `index.js` 中挂载，导致所有消息中心功能无法使用。

**影响**：
- REQ-00099（游戏消息中心与通知管理系统）标记为"已完成"，但实际功能不可达
- 用户无法查看通知列表、标记已读、删除通知等核心操作
- 未读数量查询、通知统计、偏好设置等辅助功能无法使用

**价值**：挂载后立即解锁 REQ-00099 的全部功能，无需额外开发。

## 验收标准（必填，必须是可执行命令）

- [ ] `node --check backend/services/user-service/src/index.js` 通过
- [ ] `node --check backend/services/user-service/src/routes/messageCenter.js` 通过
- [ ] `grep -q "messageCenterRouter" backend/services/user-service/src/index.js` 路由已挂载
- [ ] `curl -sf http://localhost:8081/health` 返回 200（服务可启动）
- [ ] 启动服务后，`curl -sf http://localhost:8081/notifications -H "Authorization: Bearer test"` 返回非 404

## 技术方案

### 1. 路由挂载
在 `user-service/src/index.js` 的 routes 数组中添加：

```javascript
{
  path: '/notifications',
  router: messageCenterRouter
}
```

### 2. 端点清单（共 8 个）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/notifications` | 获取通知列表（支持分页、筛选） |
| GET | `/notifications/unread-count` | 获取未读通知数量（按类型分组） |
| PATCH | `/notifications/:id/read` | 标记单个通知为已读 |
| POST | `/notifications/batch-read` | 批量标记通知为已读 |
| DELETE | `/notifications/:id` | 删除单个通知 |
| POST | `/notifications/clear-read` | 清除所有已读通知 |
| GET | `/notifications/stats` | 获取通知统计信息 |
| PATCH | `/notifications/preferences` | 更新通知偏好设置 |

### 3. 依赖检查
- `shared/db` 已存在
- `shared/redis` 已存在
- `shared/auth` 已存在
- `shared/logger` 已存在
- `prom-client` 已安装
- 无新增依赖

## 影响范围

- `backend/services/user-service/src/index.js`（修改）
- 解锁 REQ-00099 的全部功能

## 参考

- 关联需求：REQ-00099（游戏消息中心与通知管理系统）
- 欠账来源：GUIDELINES.md §6 集成欠账清单
