# REQ-00124：消息中心服务单元测试覆盖

- **编号**：REQ-00124
- **类别**：测试覆盖
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：user-service、backend/services/user-service/src/routes/messageCenter.js、backend/tests/unit/
- **创建时间**：2026-06-11 19:10
- **依赖需求**：REQ-00099（游戏消息中心与通知管理系统）、REQ-00120（消息中心路由挂载）

## 1. 背景与问题

REQ-00120 已将消息中心路由挂载到 user-service，解锁了 REQ-00099 的全部功能。但 `backend/tests/unit/messageCenter.test.js` 文件不存在，导致：

1. **测试覆盖缺失**：消息中心的 8 个 API 端点没有单元测试
2. **回归风险高**：未来修改可能导致功能损坏而无法及时发现
3. **文档不足**：缺少测试代码作为 API 使用示例
4. **CI/CD 保护弱**：没有自动化测试保护核心通知功能

当前单元测试文件数量：82 个，但缺少 messageCenter 测试。

## 2. 目标

为消息中心服务编写完整的单元测试，确保：

1. 所有 8 个 API 端点都有测试覆盖
2. 测试覆盖率 ≥ 90%（语句覆盖）
3. 包含正常流程和边界情况
4. Mock 外部依赖（数据库、Redis）
5. 测试可集成到 CI/CD 流程

## 3. 范围

### 包含
- `GET /notifications` - 获取通知列表（分页、筛选）
- `GET /notifications/unread-count` - 获取未读数量（按类型分组）
- `PATCH /notifications/:id/read` - 标记单条已读
- `POST /notifications/batch-read` - 批量标记已读
- `DELETE /notifications/:id` - 删除单条通知
- `POST /notifications/clear-read` - 批量删除已读通知
- `GET /notifications/stats` - 获取通知统计
- `PATCH /notifications/preferences` - 更新通知偏好

### 不包含
- 集成测试（已有单独的集成测试框架）
- E2E 测试（已有 Playwright E2E 测试）
- 前端组件测试

## 4. 详细需求

### 4.1 测试文件结构

创建 `backend/tests/unit/messageCenter.test.js`，包含以下测试套件：

```javascript
describe('MessageCenter API', () => {
  describe('GET /notifications', () => {
    it('should return notification list with pagination')
    it('should filter by status (unread/read)')
    it('should filter by notification type')
    it('should respect pagination limits')
    it('should return unread count in response')
    it('should require authentication')
  })
  
  describe('GET /notifications/unread-count', () => {
    it('should return unread count by type')
    it('should cache result in Redis')
    it('should refresh cache after 60 seconds')
  })
  
  describe('PATCH /notifications/:id/read', () => {
    it('should mark notification as read')
    it('should return 404 for non-existent notification')
    it('should clear unread count cache')
    it('should be idempotent')
  })
  
  describe('POST /notifications/batch-read', () => {
    it('should mark multiple notifications as read')
    it('should mark all unread when all=true')
    it('should validate request body')
    it('should return updated count')
  })
  
  describe('DELETE /notifications/:id', () => {
    it('should delete notification')
    it('should return 404 for non-existent notification')
    it('should clear unread count cache')
  })
  
  describe('POST /notifications/clear-read', () => {
    it('should delete all read notifications')
    it('should support beforeDate filter')
    it('should return deleted count')
  })
  
  describe('GET /notifications/stats', () => {
    it('should return notification statistics')
    it('should group by notification type')
    it('should include last notification timestamp')
  })
  
  describe('PATCH /notifications/preferences', () => {
    it('should update notification types preferences')
    it('should update quiet hours settings')
    it('should validate quietHours format (HH:MM)')
    it('should reject invalid parameters')
  })
})
```

### 4.2 Mock 策略

- **数据库 Mock**: 使用 Jest mock 或内存数据库
- **Redis Mock**: 使用 `redis-mock` 或 Jest mock
- **认证 Mock**: 使用共享的 `mockAuth` 辅助函数

### 4.3 测试数据

创建测试数据工厂：

```javascript
const createTestNotification = (overrides = {}) => ({
  id: 'test-notification-id',
  user_id: 'test-user-id',
  notification_type: 'RARE_SPAWN',
  title: '测试通知',
  body: '这是一条测试通知',
  data: {},
  read: false,
  created_at: new Date(),
  ...overrides
})
```

### 4.4 覆盖率目标

| 指标 | 目标 |
|------|------|
| 语句覆盖率 | ≥ 90% |
| 分支覆盖率 | ≥ 85% |
| 函数覆盖率 | ≥ 95% |
| 行覆盖率 | ≥ 90% |

### 4.5 Prometheus 指标测试

确保测试覆盖以下指标：
- `minego_message_center_notifications_fetched_total`
- `minego_message_center_notifications_marked_read_total`
- `minego_message_center_notifications_deleted_total`
- `minego_message_center_unread_count_queries_total`

## 5. 验收标准（可测试）

- [ ] `node --check backend/tests/unit/messageCenter.test.js` 通过
- [ ] 测试文件包含至少 30 个测试用例
- [ ] `npm test -- messageCenter.test.js` 全部通过
- [ ] `npm test -- --coverage --testPathPattern=messageCenter` 显示覆盖率 ≥ 90%
- [ ] 测试覆盖所有 8 个 API 端点
- [ ] 测试包含认证失败场景
- [ ] 测试包含边界情况（空列表、无效参数等）
- [ ] CI 流程中测试自动运行

## 6. 工作量估算

**M (Medium)**

理由：
- 已有参考实现（其他测试文件如 `notifications.test.js`）
- API 结构清晰，测试场景明确
- 需要编写 30+ 测试用例
- 需要 Mock 数据库和 Redis

预计工时：4-6 小时

## 7. 优先级理由

**P1 理由**：
1. **测试覆盖是项目成熟度的关键指标**（权重 10%）
2. **消息中心是核心用户功能**，涉及通知推送、已读状态等关键交互
3. **REQ-00120 刚完成**，现在补充测试可以确保代码质量
4. **符合测试左移原则**，在功能发布后立即补充测试
5. **当前测试覆盖得分 13/10**，需要保持并提升

## 8. 相关文件

### 需要测试的文件
- `backend/services/user-service/src/routes/messageCenter.js` (主文件)
- `backend/services/user-service/src/handlers/notificationHandler.js` (事件处理器)

### 参考测试文件
- `backend/tests/unit/notifications.test.js` (推送通知测试)
- `backend/tests/unit/auth.test.js` (认证测试示例)
- `backend/tests/unit/state-persistence.test.js` (Mock 示例)

### 相关需求
- REQ-00099: 游戏消息中心与通知管理系统
- REQ-00120: user-service 消息中心路由挂载与集成
- REQ-00026: 游戏内实时推送通知系统
