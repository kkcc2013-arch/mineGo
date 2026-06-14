# REQ-00213：GDPR 数据主体权利请求管理系统

- **编号**：REQ-00213
- **类别**：合规/隐私
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：user-service、gateway、admin-dashboard、backend/jobs、database/migrations
- **创建时间**：2026-06-14 22:00
- **依赖需求**：REQ-00016（GDPR 合规与用户数据隐私保护）

## 1. 背景与问题

当前 mineGo 项目已实现基础的 GDPR 数据导出和删除功能（REQ-00016），但缺乏完整的数据主体权利请求管理系统。GDPR 第 12-23 条规定，用户有权行使以下权利：
- 访问权（第 15 条）
- 更正权（第 16 条）
- 删除权/被遗忘权（第 17 条）
- 限制处理权（第 18 条）
- 数据可携带权（第 20 条）
- 反对权（第 21 条）

现有问题：
1. 缺乏统一的请求提交和跟踪界面
2. 无请求状态管理（待处理/处理中/已完成/已拒绝）
3. 无管理员审核工作流
4. 无请求处理时效监控（GDPR 要求 30 天内响应）
5. 无批量导出/删除功能
6. 无请求历史记录和审计追踪

## 2. 目标

建立完整的数据主体权利请求管理系统：
- 提供用户友好的请求提交界面
- 实现请求状态全生命周期管理
- 满足 GDPR 30 天响应时限要求
- 提供管理员审核和处理工具
- 支持多种数据主体权利类型
- 完整的审计追踪和合规报告

## 3. 范围

- **包含**：
  - 数据主体权利请求 API（创建、查询、状态更新）
  - 管理员审核界面和工作流
  - 请求处理定时任务（过期提醒）
  - 合规报告生成
  - 批量请求处理功能

- **不包含**：
  - 具体的数据导出/删除实现（已在 REQ-00016 完成）
  - 跨境数据传输处理（已在 REQ-00089 完成）
  - Cookie 同意管理

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 数据主体权利请求表
CREATE TABLE data_subject_requests (
  id SERIAL PRIMARY KEY,
  request_id VARCHAR(36) UNIQUE NOT NULL,  -- UUID
  user_id INTEGER NOT NULL REFERENCES users(id),
  request_type VARCHAR(50) NOT NULL,  -- access, rectification, erasure, restriction, portability, objection
  status VARCHAR(30) NOT NULL DEFAULT 'pending',  -- pending, in_progress, completed, rejected, expired
  details JSONB,  -- 请求详情
  admin_notes TEXT,  -- 管理员备注
  assigned_to INTEGER REFERENCES users(id),  -- 分配的管理员
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_date TIMESTAMPTZ NOT NULL,  -- 截止日期（30天）
  completed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  metadata JSONB  -- 额外元数据
);

-- 请求处理日志
CREATE TABLE dsr_processing_logs (
  id SERIAL PRIMARY KEY,
  request_id INTEGER REFERENCES data_subject_requests(id),
  action VARCHAR(100) NOT NULL,
  performed_by INTEGER REFERENCES users(id),
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB
);

CREATE INDEX idx_dsr_user_id ON data_subject_requests(user_id);
CREATE INDEX idx_dsr_status ON data_subject_requests(status);
CREATE INDEX idx_dsr_due_date ON data_subject_requests(due_date);
```

### 4.2 API 设计

**用户端 API**：
- `POST /api/dsr` - 创建数据主体请求
- `GET /api/dsr` - 获取用户的所有请求
- `GET /api/dsr/:id` - 获取请求详情
- `PUT /api/dsr/:id/cancel` - 取消请求

**管理员 API**：
- `GET /admin/dsr` - 列出所有请求（支持筛选）
- `PUT /admin/dsr/:id/status` - 更新请求状态
- `PUT /admin/dsr/:id/assign` - 分配请求
- `POST /admin/dsr/:id/complete` - 标记完成
- `POST /admin/dsr/:id/reject` - 拒绝请求
- `GET /admin/dsr/statistics` - 统计数据

### 4.3 定时任务

- 每 6 小时检查即将过期的请求（7 天内），发送提醒
- 每天检查过期请求，自动标记为 expired 并通知管理员
- 每周生成合规报告

### 4.4 前端组件

- `DSRRequestForm.js` - 请求提交表单
- `DSRStatusTracker.js` - 状态追踪组件
- `AdminDSRDashboard.js` - 管理员仪表板
- `DSRStatistics.js` - 统计图表

## 5. 验收标准（可测试）

- [ ] 用户可提交 6 种类型的数据主体请求
- [ ] 每个请求自动设置 30 天截止日期
- [ ] 管理员可查看、分配、处理请求
- [ ] 请求状态变更时发送通知给用户
- [ ] 即将过期请求自动发送提醒邮件
- [ ] 支持按用户/类型/状态筛选请求
- [ ] 审计日志完整记录所有操作
- [ ] 管理员仪表板显示统计数据
- [ ] API 返回正确的错误码和消息
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**M（中等）**
- 后端 API 和数据库：4 小时
- 定时任务：2 小时
- 管理员前端：3 小时
- 用户前端：2 小时
- 测试：2 小时
- 总计：约 13 小时

## 7. 优先级理由

P1 优先级：
1. GDPR 合规的法律要求，违规可能导致巨额罚款
2. 当前仅有基础删除功能，缺乏完整请求管理
3. 影响用户体验和信任度
4. 是 REQ-00016 的自然扩展，完善合规体系
