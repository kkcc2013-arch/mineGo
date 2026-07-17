# REQ-00591：本地化内容协作审批工作流系统

- **编号**：REQ-00591
- **类别**：国际化/本地化
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：gateway、admin-dashboard、backend/shared/i18n、PostgreSQL
- **创建时间**：2026-07-17 01:00
- **依赖需求**：REQ-00011、REQ-00137

## 1. 背景与问题

mineGo 项目已实现基础多语言支持（REQ-00011）和动态翻译管理（REQ-00398），支持中/英/日三语，但本地化内容管理流程存在以下问题：

1. **缺乏协作机制**：翻译人员无法协作编辑同一批内容，无任务分配和进度追踪
2. **缺少审批流程**：翻译内容直接生效，无审核环节，可能导致翻译质量问题和合规风险
3. **版本管理薄弱**：翻译历史无完整记录，无法回滚到特定版本
4. **质量评估缺失**：无翻译质量评分、对比审查、自动一致性检查
5. **通知机制不完善**：翻译任务分配、审批进度变更无实时通知

对于一款面向全球用户的AR手游，高质量本地化直接影响用户留存和合规性。当前的"单向推送"模式难以支撑多地区运营需求。

## 2. 目标

建立完整的本地化内容协作审批工作流系统，实现：
- 翻译任务创建、分配、协作编辑、提交审核、审批上线的完整流程
- 支持多角色（翻译者、审核者、管理员）协作
- 翻译版本管理和一键回滚
- 翻译质量评分和一致性检查
- 实时通知和进度看板

## 3. 范围

- **包含**：
  - 翻译任务管理（创建、分配、优先级、截止日期）
  - 多人协作编辑（锁定机制、冲突检测）
  - 审批工作流（提交→审核→批准/拒绝→发布）
  - 翻译版本管理（历史记录、版本对比、回滚）
  - 翻译质量评分（自动检查+人工评分）
  - 实时通知（WebSocket推送、邮件提醒）
  - 管理后台界面（任务看板、审批队列、进度统计）

- **不包含**：
  - 机器翻译集成（属于独立需求）
  - 游戏客户端实时语言切换（已实现）
  - 用户界面翻译编辑器（属于前端需求）

## 4. 详细需求

### 4.1 数据模型

```sql
-- 翻译任务表
CREATE TABLE localization_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  content_type VARCHAR(50) NOT NULL, -- 'ui', 'item', 'pokemon', 'quest', 'notification', 'error'
  target_languages TEXT[] NOT NULL,
  source_language VARCHAR(10) DEFAULT 'zh-CN',
  priority VARCHAR(10) DEFAULT 'normal', -- 'urgent', 'high', 'normal', 'low'
  status VARCHAR(20) DEFAULT 'draft', -- 'draft', 'assigned', 'in_progress', 'submitted', 'approved', 'published', 'rejected'
  assigned_to UUID[], -- 分配给的翻译者
  reviewer_id UUID,
  due_date TIMESTAMP,
  created_by UUID NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMP,
  metadata JSONB
);

-- 翻译条目表
CREATE TABLE localization_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES localization_tasks(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL, -- 翻译键
  source_text TEXT NOT NULL, -- 源文本
  translations JSONB NOT NULL DEFAULT '{}', -- { "en-US": "...", "ja-JP": "..." }
  context TEXT, -- 上下文说明
  max_length INTEGER, -- 最大长度限制
  placeholders TEXT[], -- 占位符列表
  status JSONB DEFAULT '{}', -- { "en-US": "pending", "ja-JP": "approved" }
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, key)
);

-- 翻译版本历史
CREATE TABLE localization_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID REFERENCES localization_entries(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  old_text TEXT,
  new_text TEXT NOT NULL,
  changed_by UUID NOT NULL,
  change_reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_entry_lang (entry_id, language)
);

-- 翻译审批记录
CREATE TABLE translation_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES localization_tasks(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  entry_key VARCHAR(255),
  reviewer_id UUID NOT NULL,
  action VARCHAR(20) NOT NULL, -- 'approved', 'rejected', 'requested_changes'
  comment TEXT,
  quality_score INTEGER CHECK (quality_score BETWEEN 1 AND 5),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 翻译锁定（防止编辑冲突）
CREATE TABLE translation_locks (
  entry_id UUID PRIMARY KEY REFERENCES localization_entries(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,
  locked_by UUID NOT NULL,
  locked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);

-- 翻译质量检查规则
CREATE TABLE quality_check_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  rule_type VARCHAR(50) NOT NULL, -- 'placeholder', 'length', 'format', 'consistency', 'custom'
  language VARCHAR(10), -- NULL 表示所有语言
  pattern TEXT,
  severity VARCHAR(20) DEFAULT 'warning', -- 'error', 'warning', 'info'
  enabled BOOLEAN DEFAULT TRUE,
  config JSONB
);
```

### 4.2 API 接口

```
POST   /api/v1/admin/localization/tasks              创建翻译任务
GET    /api/v1/admin/localization/tasks              列表查询（支持过滤）
GET    /api/v1/admin/localization/tasks/:id          获取任务详情
PUT    /api/v1/admin/localization/tasks/:id          更新任务信息
DELETE /api/v1/admin/localization/tasks/:id          删除任务

POST   /api/v1/admin/localization/tasks/:id/assign   分配任务给翻译者
POST   /api/v1/admin/localization/tasks/:id/submit   提交审核
POST   /api/v1/admin/localization/tasks/:id/approve  审批通过
POST   /api/v1/admin/localization/tasks/:id/reject   审批拒绝
POST   /api/v1/admin/localization/tasks/:id/publish  发布上线

GET    /api/v1/admin/localization/entries/:id        获取条目详情
PUT    /api/v1/admin/localization/entries/:id        更新翻译内容
POST   /api/v1/admin/localization/entries/:id/lock   锁定条目编辑
DELETE /api/v1/admin/localization/entries/:id/lock   解锁条目

GET    /api/v1/admin/localization/versions           版本历史查询
POST   /api/v1/admin/localization/versions/:id/rollback 版本回滚

POST   /api/v1/admin/localization/quality/check      执行质量检查
GET    /api/v1/admin/localization/quality/report     质量报告

GET    /api/v1/admin/localization/stats               统计数据
```

### 4.3 工作流状态机

```
          ┌─────────────────────────────────────────────────┐
          │                                                 │
          ▼                                                 │
       [draft] ──assign──► [assigned]                       │
          │                    │                            │
          │                  in_progress                    │
          │                    │                            │
          │                 submit ──────► [submitted]      │
          │                                   │             │
          │                            approve│      reject  │
          │                                   ▼             │
          │                              [approved]──────────┘
          │                                   │
          │                              publish
          │                                   │
          ▼                                   ▼
      [cancelled]                        [published]
```

### 4.4 WebSocket 事件

```javascript
// 任务状态变更
'task:status_changed' → { taskId, oldStatus, newStatus, changedBy }

// 条目锁定/解锁
'entry:locked'   → { entryId, language, lockedBy, expiresAt }
'entry:unlocked' → { entryId, language }

// 审批通知
'approval:requested' → { taskId, reviewerId, entries }
'approval:completed' → { taskId, approved, comment }

// 版本变更
'version:created' → { entryId, language, versionId, changedBy }
```

### 4.5 质量检查规则

1. **占位符一致性**：检查翻译中是否保留了所有 `{placeholder}`
2. **长度限制**：检查是否超出 maxLength 限制
3. **格式一致性**：检查数字、日期、货币格式
4. **术语一致性**：检查是否使用统一术语表
5. **空翻译检测**：检查是否有遗漏未翻译的条目
6. **HTML/XSS检测**：检查是否包含危险标签

## 5. 验收标准（可测试）

- [ ] 管理员可创建翻译任务，指定目标语言和截止日期
- [ ] 任务可分配给多个翻译者，支持任务认领和释放
- [ ] 翻译者编辑时自动锁定条目，防止并发冲突
- [ ] 提交审核后进入审批队列，审核者可批量审批
- [ ] 审批拒绝时必须填写原因，翻译者收到通知
- [ ] 发布后自动同步到生产翻译缓存
- [ ] 支持查看任意条目的完整版本历史
- [ ] 支持一键回滚到历史版本
- [ ] 质量检查自动执行，标注问题条目
- [ ] WebSocket 实时推送状态变更
- [ ] 管理后台显示翻译进度统计看板

## 6. 工作量估算

**XL** - 涉及完整的CRUD、工作流引擎、WebSocket实时通信、管理后台前端、质量检查引擎

预估工时：80-120 人时

## 7. 优先级理由

P2 级别：虽然本地化对用户体验重要，但当前系统已能支撑基础运营。本需求属于运营效率提升类，不阻塞核心功能，但为全球化运营提供必要基础设施。
