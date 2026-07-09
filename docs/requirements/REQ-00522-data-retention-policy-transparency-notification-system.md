# REQ-00522：数据保留政策透明化与用户通知系统

- **编号**：REQ-00522
- **类别**：合规/隐私
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、backend/shared/dataRetentionPolicyService.js、backend/jobs/retentionNotificationJob.js、game-client、admin-dashboard
- **创建时间**：2026-07-09 03:00
- **依赖需求**：REQ-00016（GDPR合规）、REQ-00053（用户隐私偏好中心）

## 1. 背景与问题

### 现状分析
项目已实现数据生命周期管理（DataLifecycleManager），具备完整的数据分类和保留策略：
- 临时数据：7 天
- 操作日志：90 天
- 交易记录：3 年（财务合规）
- 用户数据：账户存续期间
- 历史数据：365 天

### 合规缺口
根据 GDPR 第 13、14 条规定，数据控制者必须告知数据主体：
1. **个人数据的存储期限**（或判定期限的标准）
2. **定期审查机制**
3. **数据到期后的处理方式**

当前问题：
- **用户不可见**：保留政策仅在代码中定义，用户无法查看
- **无主动通知**：数据即将到期时没有通知用户
- **缺少透明度**：用户不知道哪些数据会被保留多久
- **无法行使权利**：用户无法在到期前行使数据导出、修正等权利

### 业务影响
- GDPR 合规风险（可能面临最高 2000 万欧元或全球营业额 4% 罚款）
- 用户信任度降低（不透明的数据处理）
- 数据治理效率低（无用户参与的自动化清理）

## 2. 目标

建立一个**透明、可审计、用户友好**的数据保留政策展示与通知系统：

1. **透明化展示**：在隐私中心展示各类数据的保留期限和处理方式
2. **主动通知**：数据即将到期前通知用户，给予行使权利的机会
3. **可视化追踪**：用户可查看个人数据的保留状态和时间线
4. **合规审计**：完整记录通知发送和用户响应情况
5. **多语言支持**：支持中英文等多语言保留政策展示

### 可量化目标
- 用户隐私中心保留政策页面访问率 ≥ 30%
- 数据到期通知送达率 ≥ 95%
- 用户提前行使数据权利比例 ≥ 20%
- GDPR 合规审计通过率 100%

## 3. 范围

### 包含
- **保留政策 API**：查询各类数据的保留期限和处理方式
- **隐私中心页面**：用户可查看保留政策、数据状态、即将到期的数据
- **通知系统**：邮件、推送、站内信多渠道通知
- **数据状态追踪**：用户个人数据保留时间线可视化
- **管理员配置**：动态调整保留政策和通知时机
- **审计日志**：记录通知发送、用户查看、数据清理操作
- **多语言支持**：保留政策的中英文版本

### 不包含
- 数据归档存储系统（已有 DataLifecycleManager）
- 数据删除执行逻辑（已有 DataLifecycleManager）
- 第三方数据处理协议（REQ-00467 已实现）
- 数据主体权利请求处理（REQ-00384 已实现）

## 4. 详细需求

### 4.1 数据保留政策服务（Backend）

#### 4.1.1 RetentionPolicyService 核心类
```javascript
// backend/shared/dataRetentionPolicyService.js

class RetentionPolicyService {
  // 获取所有保留政策
  async getPolicies(locale = 'zh-CN') {
    return {
      categories: [
        {
          id: 'TEMPORARY',
          name: '临时数据',
          retentionDays: 7,
          description: '验证码、临时令牌等',
          examples: ['验证码', '临时令牌', '上传临时文件'],
          cleanupPolicy: 'hard_delete',
          policyBasis: '业务需求'
        },
        {
          id: 'OPERATION_LOGS',
          name: '操作日志',
          retentionDays: 90,
          description: '登录日志、API 调用日志',
          examples: ['登录日志', 'API 调用日志', '审计日志'],
          cleanupPolicy: 'hard_delete',
          policyBasis: '安全审计要求'
        },
        {
          id: 'TRANSACTION_RECORDS',
          name: '交易记录',
          retentionDays: 1095, // 3 年
          description: '支付订单、精币流水',
          examples: ['支付订单', '精币流水', '购买记录'],
          cleanupPolicy: 'archive_then_delete',
          policyBasis: '财务合规要求（税法）'
        },
        {
          id: 'USER_DATA',
          name: '用户数据',
          retentionDays: null,
          description: '用户信息、精灵数据、好友关系',
          examples: ['用户信息', '精灵数据', '好友关系'],
          cleanupPolicy: 'user_initiated',
          policyBasis: '账户存续期间'
        },
        {
          id: 'HISTORICAL_DATA',
          name: '历史数据',
          retentionDays: 365,
          description: '战斗记录、活动历史',
          examples: ['战斗记录', '活动历史', '排行榜快照'],
          cleanupPolicy: 'archive_then_delete',
          policyBasis: '业务分析需求'
        },
        {
          id: 'LOCATION_HISTORY',
          name: '位置历史',
          retentionDays: 90,
          description: '精灵位置历史、用户移动轨迹',
          examples: ['精灵位置记录', '用户移动轨迹'],
          cleanupPolicy: 'hard_delete',
          policyBasis: '隐私保护要求'
        }
      ],
      lastUpdated: '2026-07-09',
      version: '1.0'
    };
  }

  // 获取用户数据保留状态
  async getUserDataStatus(userId) {
    // 查询各类数据的创建时间、过期时间、状态
    return {
      categories: [
        {
          id: 'OPERATION_LOGS',
          recordCount: 1523,
          earliestRecord: '2025-01-15',
          latestRecord: '2026-07-08',
          willExpireOn: '2026-10-08',
          daysUntilExpiry: 90
        },
        {
          id: 'TRANSACTION_RECORDS',
          recordCount: 89,
          earliestRecord: '2024-03-20',
          latestRecord: '2026-07-08',
          willExpireOn: '2027-03-20',
          daysUntilExpiry: 254
        },
        {
          id: 'USER_DATA',
          recordCount: 45,
          status: 'active',
          policy: '账户存续期间保留'
        }
      ],
      totalRecords: 1657,
      dataVolumeMB: 12.5
    };
  }

  // 获取即将到期的数据
  async getExpiringData(userId, daysThreshold = 30) {
    return {
      expiringCategories: [
        {
          id: 'LOCATION_HISTORY',
          name: '位置历史',
          recordCount: 1250,
          willExpireOn: '2026-07-20',
          daysUntilExpiry: 11,
          actions: ['export', 'extend'] // 可执行的操作
        }
      ],
      totalExpiringRecords: 1250
    };
  }
}
```

#### 4.1.2 保留政策版本管理
- 支持政策版本化（v1.0, v1.1...）
- 政策变更时记录变更历史
- 用户同意新版本时更新同意记录

#### 4.1.3 合规依据文档
- 每类保留政策需关联法律依据
- 支持上传合规文档（PDF）
- 管理员可编辑法律依据说明

### 4.2 通知系统

#### 4.2.1 RetentionNotificationJob 定时任务
```javascript
// backend/jobs/retentionNotificationJob.js

class RetentionNotificationJob {
  // 执行通知检查（每天运行）
  async execute() {
    // 1. 查询即将到期的用户数据
    const expiringUsers = await this.getUsersWithExpiringData();
    
    // 2. 发送通知
    for (const user of expiringUsers) {
      await this.sendNotification(user);
    }
    
    // 3. 记录日志
    await this.logNotifications(expiringUsers);
  }

  // 通知时机
  // - 数据到期前 30 天
  // - 数据到期前 7 天
  // - 数据到期前 1 天
  // - 数据到期当天

  // 通知渠道
  // - 邮件（主要）
  // - 推送通知
  // - 站内信
  // - 游戏内弹窗（可选）
}
```

#### 4.2.2 通知模板
```javascript
const NOTIFICATION_TEMPLATES = {
  email: {
    subject: {
      'zh-CN': '您的数据即将到期 - 请查看您的选项',
      'en-US': 'Your Data Will Expire Soon - Review Your Options'
    },
    body: `
尊敬的 {{userName}}：

根据我们的数据保留政策，您的以下数据将于 {{expiryDate}} 到期：
- {{dataCategory}}：{{recordCount}} 条记录

到期后，这些数据将被：
{{cleanupAction}}

您可以在数据到期前行使以下权利：
1. 导出数据
2. 申请延长保留（需说明理由）
3. 提前删除数据
4. 修正数据

请访问隐私中心查看详情：{{privacyCenterUrl}}

如有疑问，请联系数据保护官：dpo@minego.game

此致
mineGo 数据保护团队
    `
  }
};
```

### 4.3 用户界面（game-client）

#### 4.3.1 隐私中心保留政策页面
```
┌─────────────────────────────────────────────┐
│  数据保留政策                                │
├─────────────────────────────────────────────┤
│  最后更新：2026-07-09  版本：v1.0           │
├─────────────────────────────────────────────┤
│  📋 我们如何管理您的数据                     │
│                                              │
│  根据法律法规和业务需求，我们会将您的         │
│  数据保留一定期限。以下是各类数据的保留       │
│  政策：                                      │
│                                              │
│  ┌─────────────────────────────────────┐   │
│  │ 临时数据 (7 天)                     │   │
│  │ • 验证码、临时令牌                  │   │
│  │ • 法律依据：业务需求                │   │
│  │ • 处理方式：到期后永久删除          │   │
│  └─────────────────────────────────────┘   │
│                                              │
│  ┌─────────────────────────────────────┐   │
│  │ 操作日志 (90 天) ⚠️ 即将到期         │   │
│  │ • 登录日志、API 调用日志            │   │
│  │ • 法律依据：安全审计要求            │   │
│  │ • 处理方式：到期后永久删除          │   │
│  │ • 您的数据：1,523 条记录            │   │
│  │   将于 2026-10-08 到期              │   │
│  └─────────────────────────────────────┘   │
│                                              │
│  [查看我的数据状态] [导出所有数据]           │
└─────────────────────────────────────────────┘
```

#### 4.3.2 数据状态时间线
```
┌─────────────────────────────────────────────┐
│  我的数据状态                                │
├─────────────────────────────────────────────┤
│  📊 总览                                     │
│  • 总记录数：1,657 条                        │
│  • 数据量：12.5 MB                           │
│  • 即将到期：1,250 条位置历史（11 天后）     │
│                                              │
│  📅 时间线                                   │
│  2024-03-20 ──┐                             │
│               │ 交易记录 (保留 3 年)        │
│  2027-03-20 ──┘                             │
│                                              │
│  2025-09-08 ──┐                             │
│               │ 位置历史 (保留 90 天)       │
│  2025-12-07 ──┘ ✅ 已清理                  │
│                                              │
│  2026-04-09 ──┐                             │
│               │ 位置历史 (保留 90 天)       │
│  2026-07-09 ──┘ ⚠️ 即将到期                │
│                                              │
│  [导出即将到期数据] [申请延长保留]           │
└─────────────────────────────────────────────┘
```

### 4.4 管理员界面（admin-dashboard）

#### 4.4.1 保留政策配置页面
```
┌─────────────────────────────────────────────┐
│  数据保留政策管理                            │
├─────────────────────────────────────────────┤
│  [新增政策] [导入政策] [导出政策]            │
│                                              │
│  类别      保留期限  法律依据      状态      │
│  ─────────────────────────────────────────  │
│  临时数据   7 天    业务需求      ✅ 启用   │
│  操作日志   90 天   安全审计      ✅ 启用   │
│  交易记录   3 年    财务合规      ✅ 启用   │
│  用户数据   永久    账户存续      ✅ 启用   │
│  历史数据   365 天  业务分析      ✅ 启用   │
│                                              │
│  [编辑] [查看历史版本] [合规审计]            │
└─────────────────────────────────────────────┘
```

#### 4.4.2 通知配置页面
```
┌─────────────────────────────────────────────┐
│  到期通知配置                                │
├─────────────────────────────────────────────┤
│  通知时机：                                  │
│  ☑️ 到期前 30 天                            │
│  ☑️ 到期前 7 天                             │
│  ☑️ 到期前 1 天                             │
│  ☑️ 到期当天                                │
│                                              │
│  通知渠道：                                  │
│  ☑️ 邮件 (主要)                             │
│  ☑️ 推送通知                                │
│  ☑️ 站内信                                  │
│  ⬜ 游戏内弹窗                               │
│                                              │
│  通知统计（最近 30 天）：                    │
│  • 已发送通知：1,234 条                      │
│  • 送达率：98.5%                             │
│  • 用户操作率：23.4%                         │
│    - 导出数据：156 次                        │
│    - 申请延长：89 次                         │
│    - 提前删除：45 次                         │
│                                              │
│  [保存配置] [预览通知] [测试发送]            │
└─────────────────────────────────────────────┘
```

### 4.5 API 设计

#### 4.5.1 用户端 API
```
GET  /api/v1/privacy/retention-policies
     获取所有数据保留政策

GET  /api/v1/privacy/my-data/status
     获取个人数据保留状态

GET  /api/v1/privacy/my-data/expiring
     获取即将到期的数据

POST /api/v1/privacy/my-data/export
     导出指定类别的数据

POST /api/v1/privacy/my-data/extend
     申请延长数据保留期

POST /api/v1/privacy/retention/acknowledge
     确认已阅读保留政策
```

#### 4.5.2 管理员 API
```
GET    /api/v1/admin/retention-policies
       获取保留政策列表

POST   /api/v1/admin/retention-policies
       创建新保留政策

PUT    /api/v1/admin/retention-policies/:id
       更新保留政策

DELETE /api/v1/admin/retention-policies/:id
       删除保留政策（需无关联数据）

GET    /api/v1/admin/retention-notifications/stats
       获取通知统计

GET    /api/v1/admin/retention-notifications/history
       获取通知历史
```

### 4.6 数据库设计

#### 4.6.1 保留政策表
```sql
CREATE TABLE data_retention_policies (
  id SERIAL PRIMARY KEY,
  category_id VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  name_en VARCHAR(100),
  retention_days INTEGER,
  description TEXT,
  description_en TEXT,
  examples JSONB,
  cleanup_policy VARCHAR(50) NOT NULL,
  legal_basis TEXT NOT NULL,
  legal_basis_en TEXT,
  is_active BOOLEAN DEFAULT true,
  version VARCHAR(20) DEFAULT '1.0',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### 4.6.2 政策版本历史表
```sql
CREATE TABLE retention_policy_versions (
  id SERIAL PRIMARY KEY,
  policy_id INTEGER REFERENCES data_retention_policies(id),
  version VARCHAR(20) NOT NULL,
  changes JSONB NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  change_reason TEXT
);
```

#### 4.6.3 通知记录表
```sql
CREATE TABLE retention_notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  policy_category VARCHAR(50) NOT NULL,
  record_count INTEGER NOT NULL,
  expiry_date DATE NOT NULL,
  notification_type VARCHAR(50) NOT NULL, -- '30d', '7d', '1d', 'expired'
  channel VARCHAR(50) NOT NULL, -- 'email', 'push', 'in-app'
  status VARCHAR(50) DEFAULT 'sent', -- 'sent', 'delivered', 'failed'
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMP,
  user_action VARCHAR(50), -- 'export', 'extend', 'delete', 'viewed'
  action_at TIMESTAMP
);

CREATE INDEX idx_retention_notifications_user ON retention_notifications(user_id, sent_at DESC);
CREATE INDEX idx_retention_notifications_status ON retention_notifications(status, sent_at);
```

#### 4.6.4 用户数据状态缓存表
```sql
CREATE TABLE user_data_retention_status (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
  category_id VARCHAR(50) NOT NULL,
  record_count INTEGER NOT NULL,
  earliest_record_date DATE,
  latest_record_date DATE,
  expiry_date DATE,
  data_volume_kb BIGINT,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, category_id)
);

CREATE INDEX idx_user_data_retention_expiry ON user_data_retention_status(expiry_date, user_id);
```

### 4.7 监控与指标

#### 4.7.1 Prometheus 指标
```javascript
// 保留政策相关指标
retention_policies_total                    // 保留政策总数
retention_notifications_sent_total          // 发送通知总数（按类型、渠道分组）
retention_notifications_delivered_total     // 送达通知总数
retention_user_actions_total                // 用户操作总数（按操作类型分组）
retention_data_expiring_count               // 即将到期数据量（按类别分组）
retention_data_export_requests_total        // 数据导出请求数
retention_extend_requests_total             // 延长保留请求数
```

#### 4.7.2 告警规则
```yaml
# 数据到期通知送达率低于 90%
- alert: RetentionNotificationDeliveryLow
  expr: |
    rate(retention_notifications_delivered_total[1h]) / 
    rate(retention_notifications_sent_total[1h]) < 0.9
  for: 2h
  annotations:
    summary: "数据到期通知送达率过低"
    description: "最近 1 小时通知送达率低于 90%，当前：{{ $value | humanizePercentage }}"
```

### 4.8 多语言支持

#### 4.8.1 政策内容多语言
- 政策名称、描述、示例支持中英文
- 法律依据说明支持中英文
- 通知模板支持中英文

#### 4.8.2 用户界面多语言
- 根据用户语言偏好自动切换
- 支持动态切换语言

## 5. 验收标准（可测试）

### 5.1 功能验收
- [ ] 用户可在隐私中心查看所有数据保留政策（包含保留期限、法律依据、处理方式）
- [ ] 保留政策页面支持中英文切换
- [ ] 用户可查看个人数据的保留状态（各类别记录数、最早/最新记录时间、到期时间）
- [ ] 用户可查看即将到期的数据列表（包含记录数、到期时间、可执行操作）
- [ ] 用户可导出即将到期的数据（支持 JSON/CSV 格式）
- [ ] 用户可申请延长数据保留期（需填写理由）

### 5.2 通知验收
- [ ] 数据到期前 30 天自动发送通知（邮件 + 推送 + 站内信）
- [ ] 数据到期前 7 天自动发送通知
- [ ] 数据到期前 1 天自动发送通知
- [ ] 数据到期当天自动发送通知
- [ ] 通知包含数据类别、记录数、到期时间、可执行操作
- [ ] 通知内容支持中英文
- [ ] 通知送达率 ≥ 95%

### 5.3 管理员验收
- [ ] 管理员可创建、编辑、删除保留政策
- [ ] 管理员可配置通知时机和渠道
- [ ] 管理员可查看通知统计（发送数、送达率、用户操作率）
- [ ] 管理员可查看通知历史记录
- [ ] 政策变更自动记录版本历史

### 5.4 合规验收
- [ ] 每类保留政策均关联法律依据
- [ ] 用户查看保留政策时记录审计日志
- [ ] 用户执行数据操作时记录审计日志
- [ ] 通知发送、送达、用户操作均有审计记录
- [ ] 支持 GDPR 合规审计报告导出

### 5.5 性能验收
- [ ] 保留政策查询响应时间 < 200ms
- [ ] 用户数据状态查询响应时间 < 500ms
- [ ] 即将到期数据查询响应时间 < 500ms
- [ ] 通知任务执行时间 < 5 分钟（1000 用户）

### 5.6 测试覆盖
- [ ] RetentionPolicyService 单元测试覆盖率 ≥ 80%
- [ ] RetentionNotificationJob 单元测试覆盖率 ≥ 80%
- [ ] API 集成测试覆盖率 ≥ 90%
- [ ] 用户界面 E2E 测试覆盖主要流程

## 6. 工作量估算

**L（Large）**

**理由**：
1. **后端开发**（3 天）：
   - RetentionPolicyService 核心服务（1 天）
   - 数据状态追踪服务（0.5 天）
   - 通知系统和定时任务（1 天）
   - API 开发和测试（0.5 天）

2. **前端开发**（2 天）：
   - 隐私中心保留政策页面（1 天）
   - 数据状态时间线可视化（0.5 天）
   - 导出和延长功能集成（0.5 天）

3. **管理员界面**（1 天）：
   - 保留政策配置页面（0.5 天）
   - 通知配置和统计页面（0.5 天）

4. **数据库和迁移**（0.5 天）：
   - 表设计和创建
   - 初始数据插入
   - 迁移脚本

5. **测试和文档**（1.5 天）：
   - 单元测试（1 天）
   - 集成测试（0.3 天）
   - API 文档（0.2 天）

**总计**：8 人天

## 7. 优先级理由

**P1（高优先级）**

**理由**：
1. **合规必要性**：GDPR 明确要求告知用户数据保留期限，缺失将面临合规风险
2. **用户信任**：透明的数据保留政策是建立用户信任的基础
3. **业务连续性**：避免用户数据意外丢失导致投诉和法律纠纷
4. **成本低效益高**：相比 GDPR 罚款（最高 2000 万欧元），开发成本可忽略
5. **依赖已具备**：数据生命周期管理、隐私偏好中心等基础设施已就绪

**对"项目可用"的贡献**：
- 满足 GDPR 核心合规要求
- 提升用户对数据处理的透明度和信任度
- 建立完善的数据治理体系
- 为项目上线扫清合规障碍
