# REQ-00053：用户隐私偏好管理中心与数据透明度报告

- **编号**：REQ-00053
- **类别**：合规/隐私
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：user-service、gateway、game-client、backend/shared、database/migrations
- **创建时间**：2026-06-09 15:00
- **依赖需求**：REQ-00016（GDPR合规）、REQ-00011（国际化）

## 1. 背景与问题

当前项目已实现 GDPR 和 COPPA 合规系统（REQ-00016、REQ-00034），支持用户数据导出、删除、加密存储和审计日志。然而，用户缺乏统一的隐私偏好管理中心，无法：

1. **查看数据收集详情**：用户不清楚哪些数据被收集、用途、存储期限
2. **精细化隐私控制**：无法按类别控制数据收集（如位置数据、行为数据、营销数据）
3. **隐私政策透明度**：隐私政策分散，缺少多语言版本和版本变更通知
4. **数据使用透明度报告**：缺少定期数据使用报告，违反 GDPR "透明原则"

根据 GDPR 第 12、13、14 条，数据控制者必须以"透明、易懂、可访问的方式"提供数据处理信息。当前系统虽合规，但用户体验不佳，可能面临监管审查。

## 2. 目标

构建完整的用户隐私偏好管理中心，实现：

1. **统一隐私仪表板**：前端可视化展示用户数据收集状态、隐私偏好、历史操作
2. **精细化隐私控制**：支持按类别开关数据收集（位置、行为、营销、分析等）
3. **数据透明度报告**：每月生成数据使用报告，展示数据访问、处理、共享记录
4. **隐私政策多语言版本管理**：支持中/英/日隐私政策，变更时自动通知用户
5. **一键数据管理**：集成导出、删除、匿名化功能，降低用户操作成本

预期收益：
- GDPR 透明原则合规性提升至 100%
- 用户隐私满意度提升 50%+
- 减少监管审查风险
- 降低用户投诉率

## 3. 范围

- **包含**：
  - 隐私偏好管理中心前端界面
  - 隐私偏好 API（获取、更新、历史记录）
  - 数据收集分类管理（8 大类）
  - 数据使用透明度报告生成引擎
  - 隐私政策版本管理系统
  - 隐私政策变更通知机制
  - 数据访问日志查询接口
  - 多语言隐私政策存储与切换

- **不包含**：
  - 第三方隐私认证（如 TRUSTe）
  - 跨境数据传输合规（已在 REQ-00016 覆盖）
  - 儿童隐私特殊保护（已在 REQ-00034 覆盖）
  - 隐私影响评估流程（内部流程文档）

## 4. 详细需求

### 4.1 数据收集分类系统

定义 8 大数据收集类别：

```javascript
const DATA_CATEGORIES = {
  LOCATION: {
    id: 'location',
    name: '位置数据',
    description: 'GPS坐标、移动轨迹、地理围栏',
    required: true, // 游戏核心功能必需
    retentionDays: 90,
    collectable: true
  },
  BEHAVIOR: {
    id: 'behavior',
    name: '行为数据',
    description: '捕捉记录、道馆战斗、社交互动',
    required: false,
    retentionDays: 365,
    collectable: true
  },
  MARKETING: {
    id: 'marketing',
    name: '营销数据',
    description: '推送通知、活动提醒、个性化推荐',
    required: false,
    retentionDays: 180,
    collectable: true
  },
  ANALYTICS: {
    id: 'analytics',
    name: '分析数据',
    description: '游戏使用统计、性能指标、崩溃报告',
    required: false,
    retentionDays: 365,
    collectable: true
  },
  SOCIAL: {
    id: 'social',
    name: '社交数据',
    description: '好友列表、聊天记录、精灵交易',
    required: false,
    retentionDays: 365,
    collectable: true
  },
  PAYMENT: {
    id: 'payment',
    name: '支付数据',
    description: '订单记录、支付方式、精币余额',
    required: false, // 可拒绝支付（仅免费游戏）
    retentionDays: 365,
    collectable: true
  },
  DEVICE: {
    id: 'device',
    name: '设备数据',
    description: '设备型号、操作系统、唯一标识符',
    required: true, // 反作弊必需
    retentionDays: 365,
    collectable: true
  },
  PROFILE: {
    id: 'profile',
    name: '个人资料',
    description: '用户名、头像、语言偏好、时区',
    required: false,
    retentionDays: '永久',
    collectable: true
  }
};
```

### 4.2 隐私偏好 API

#### GET /api/v1/user/privacy/preferences
获取用户隐私偏好：

```json
{
  "userId": "user-123",
  "preferences": {
    "location": { "collectable": true, "consentedAt": "2024-01-01" },
    "marketing": { "collectable": false, "consentedAt": null },
    "analytics": { "collectable": true, "consentedAt": "2024-01-01" }
  },
  "lastUpdated": "2024-06-01",
  "policyVersion": "v1.2",
  "policyAcceptedAt": "2024-01-01"
}
```

#### PATCH /api/v1/user/privacy/preferences
更新隐私偏好：

```json
{
  "marketing": false,
  "analytics": true
}
```

验证规则：
- `required` 类别不可关闭（返回 400 错误）
- 更新时记录时间戳和审计日志
- 关闭类别后 7 天内仍保留历史数据（给用户反悔期）

### 4.3 数据透明度报告

#### GET /api/v1/user/privacy/report
获取月度数据使用报告：

```json
{
  "month": "2024-06",
  "generatedAt": "2024-07-01",
  "summary": {
    "totalDataPoints": 12345,
    "dataByCategory": {
      "location": 5000,
      "behavior": 3000,
      "analytics": 2000
    },
    "accessCount": 150,
    "shareCount": 0
  },
  "details": [
    {
      "date": "2024-06-01",
      "category": "location",
      "action": "query",
      "purpose": "nearby-pokemon",
      "details": "查询附近精灵 50 次"
    }
  ],
  "thirdPartyShares": [],
  "retentionStatus": {
    "location": "保留 90 天",
    "behavior": "保留 365 天"
  }
}
```

报告生成逻辑：
- 每月 1 日自动生成上月报告
- 从 `audit_logs` 表聚合数据
- 按日期、类别、用途分组统计
- 检查数据保留期限，标记即将删除的数据

### 4.4 隐私政策版本管理

#### POST /api/v1/admin/privacy/policy
创建隐私政策新版本（管理员）：

```json
{
  "version": "v1.3",
  "effectiveDate": "2024-07-01",
  "changes": ["新增 AI 推荐数据收集条款", "修改数据保留期限"],
  "content": {
    "zh-CN": "隐私政策全文...",
    "en-US": "Privacy Policy...",
    "ja-JP": "プライバシー政策..."
  }
}
```

#### GET /api/v1/privacy/policy
获取当前隐私政策：

```json
{
  "version": "v1.2",
  "effectiveDate": "2024-01-01",
  "language": "zh-CN",
  "content": "隐私政策全文...",
  "previousVersions": [
    { "version": "v1.1", "effectiveDate": "2023-06-01" }
  ]
}
```

变更通知机制：
- 隐私政策变更时，推送通知所有用户
- 用户下次登录时强制显示政策变更弹窗
- 用户需重新同意才能继续使用
- 拒绝新政策的用户可选择账号删除

### 4.5 隐私仪表板前端

隐私偏好管理中心界面（game-client）：

```
┌─────────────────────────────────────┐
│  隐私管理中心                          │
├─────────────────────────────────────┤
│  📊 数据收集状态                       │
│  ├─ 位置数据      ✅ 必需              │
│  ├─ 营销数据      ❌ 已关闭            │
│  ├─ 分析数据      ✅ 已同意            │
│  └───────────────────────────────── │
│                                      │
│  📄 隐私政策                          │
│  当前版本: v1.2 (2024-01-01)          │
│  [查看政策] [查看历史版本]             │
│                                      │
│  📈 数据使用报告                       │
│  [查看本月报告] [下载历史报告]          │
│                                      │
│  🔧 数据管理                          │
│  [导出我的数据] [请求删除] [匿名化]     │
└─────────────────────────────────────┘
```

### 4.6 数据库表设计

```sql
-- 隐私偏好表
CREATE TABLE user_privacy_preferences (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  category VARCHAR(32) NOT NULL, -- location/marketing/etc
  collectable BOOLEAN NOT NULL DEFAULT true,
  consented_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, category)
);

-- 隐私政策版本表
CREATE TABLE privacy_policy_versions (
  id SERIAL PRIMARY KEY,
  version VARCHAR(16) NOT NULL UNIQUE, -- v1.2
  effective_date DATE NOT NULL,
  changes TEXT[],
  content_zh_cn TEXT NOT NULL,
  content_en_us TEXT NOT NULL,
  content_ja_jp TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 数据透明度报告表
CREATE TABLE data_transparency_reports (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  month VARCHAR(7) NOT NULL, -- 2024-06
  report_json JSONB NOT NULL,
  generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, month)
);

-- 用户政策接受记录
CREATE TABLE privacy_policy_acceptance (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  policy_version VARCHAR(16) NOT NULL,
  accepted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, policy_version)
);
```

### 4.7 审计日志查询扩展

扩展 `audit_logs` 表查询，支持按用户查询：

```sql
-- 添加索引
CREATE INDEX idx_audit_logs_user_action 
ON audit_logs(user_id, action, created_at DESC);

-- 查询接口
SELECT action, resource_type, resource_id, details, created_at
FROM audit_logs
WHERE user_id = 'user-123'
ORDER BY created_at DESC
LIMIT 100;
```

### 4.8 Prometheus 指标

新增隐私相关指标：

```javascript
// 隐私偏好变更计数
privacyPreferenceChanges: new Counter({
  name: 'privacy_preference_changes_total',
  help: 'Total privacy preference changes',
  labelNames: ['category', 'action']
});

// 数据导出请求计数
dataExportRequests: new Counter({
  name: 'data_export_requests_total',
  help: 'Total data export requests',
  labelNames: ['status']
});

// 隐私政策查看计数
policyViews: new Counter({
  name: 'privacy_policy_views_total',
  help: 'Total privacy policy views',
  labelNames: ['version', 'language']
});

// 透明度报告生成计数
transparencyReportsGenerated: new Counter({
  name: 'transparency_reports_generated_total',
  help: 'Total transparency reports generated'
});
```

## 5. 验收标准（可测试）

- [ ] 用户可在前端隐私中心查看所有 8 类数据收集状态
- [ ] 用户可切换非必需类别的数据收集开关（必需类别不可切换）
- [ ] 关闭某类别后，系统不再收集该类别数据，且 7 天内保留历史数据
- [ ] 用户可查看当前隐私政策（支持中/英/日三种语言）
- [ ] 用户可查看隐私政策历史版本列表
- [ ] 隐私政策变更时，用户登录时收到强制弹窗通知
- [ ] 用户重新同意新隐私政策后才能继续使用游戏
- [ ] 用户可查看月度数据使用报告（含数据访问次数、处理记录）
- [ ] 报告包含数据保留期限状态
- [ ] 用户可一键导出所有数据（JSON格式）
- [ ] 隐私偏好变更记录写入审计日志
- [ ] 4 个 Prometheus 指标正常暴露
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**M**（中等）

理由：
- 前端隐私中心 UI 约 2 天
- 隐私偏好 API 约 1 天
- 数据透明度报告引擎约 2 天
- 隐私政策版本管理约 1 天
- 数据库迁移和测试约 1 天
- 总计约 5-6 天

## 7. 优先级理由

**P2**（中等优先级）

理由：
1. **合规必要性**：GDPR 透明原则要求，但当前系统已基本合规（REQ-00016），此需求为体验优化而非硬性要求
2. **用户体验**：提升用户隐私控制感和信任度，降低投诉率
3. **监管风险**：虽非硬性要求，但完善透明度可减少监管审查风险
4. **依赖关系**：依赖 REQ-00016（GDPR合规）和 REQ-00011（国际化），已完成
5. **非核心功能**：不影响游戏核心玩法，可在后续迭代中实现

相比 P0/P1 的核心功能、安全加固、性能优化，此需求优先级适中。