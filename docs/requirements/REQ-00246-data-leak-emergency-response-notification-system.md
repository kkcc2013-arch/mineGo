# REQ-00246：数据泄露应急响应与通知系统

- **编号**：REQ-00246
- **类别**：合规/隐私
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、所有微服务、backend/shared/DataLeakResponder.js、backend/jobs、infrastructure/k8s/monitoring、admin-dashboard
- **创建时间**：2026-06-16 05:00
- **依赖需求**：REQ-00016（GDPR 合规）、REQ-00127（用户数据删除请求管理）

## 1. 背景与问题

GDPR、CCPA 等隐私法规要求企业在发现数据泄露后 72 小时内通知监管机构，并及时告知受影响用户。当前 mineGo 项目缺乏系统化的数据泄露应急响应机制：

1. **无自动化检测**：敏感数据异常访问、批量导出、未授权访问等泄露征兆缺乏自动检测与告警
2. **响应流程缺失**：发生泄露时无标准化响应流程，依赖人工决策，易错过合规时限
3. **通知机制不完善**：无法快速生成监管报告、批量通知受影响用户、记录响应全过程
4. **事后审计困难**：泄露事件缺乏完整审计日志，难以追溯根因和改进防护措施

## 2. 目标

建立自动化数据泄露应急响应与通知系统，实现：

1. 实时检测潜在数据泄露征兆（异常访问模式、批量数据操作、权限越界等）
2. 自动触发分级响应流程，确保 72 小时合规通知时限
3. 一键生成监管报告模板和用户通知内容
4. 完整记录事件生命周期，支持事后审计和根因分析

## 3. 范围

- **包含**：
  - 数据泄露征兆检测引擎（基于访问日志、审计日志分析）
  - 分级响应流程管理（P1/P2/P3 严重度分级）
  - 监管通知报告自动生成（GDPR、CCPA 模板）
  - 受影响用户批量通知系统
  - 事件时间线与审计日志管理
  - 管理后台事件仪表板

- **不包含**：
  - 数据加密与脱敏（已有其他需求覆盖）
  - 网络层入侵检测（属于安全加固范畴）
  - 法律合规咨询（需人工专业判断）

## 4. 详细需求

### 4.1 泄露征兆检测引擎

```javascript
// 泄露检测规则示例
const leakDetectionRules = [
  {
    id: 'bulk-export',
    type: 'threshold',
    metric: 'user_data_export_count',
    threshold: 100, // 单次导出超过100条用户数据
    window: '5m',
    severity: 'P2'
  },
  {
    id: 'unauthorized-access',
    type: 'pattern',
    pattern: 'access_denied_count_spike',
    threshold: 50,
    window: '10m',
    severity: 'P1'
  },
  {
    id: 'sensitive-query',
    type: 'audit',
    tables: ['users', 'payments', 'social_friends'],
    operations: ['SELECT', 'EXPORT'],
    volumeThreshold: 1000,
    severity: 'P1'
  }
];
```

- 集成 Kafka 消费审计日志，实时分析异常模式
- 支持自定义检测规则，热加载配置
- 检测到潜在泄露时触发事件创建

### 4.2 分级响应流程

```javascript
// 响应流程定义
const responseWorkflows = {
  P1: { // 严重泄露
    autoNotify: true,
    notifyRegulator: true,
    notifyUsers: true,
    timeLimit: 72 * 60, // 72小时（分钟）
    steps: [
      'contain_breach',      // 遏制泄露
      'assess_impact',       // 影响评估
      'notify_regulator',    // 通知监管机构
      'notify_users',        // 通知用户
      'remediate',           // 修复
      'post_mortem'          // 事后总结
    ]
  },
  P2: { // 中等风险
    autoNotify: false,
    notifyRegulator: false,
    notifyUsers: true,
    timeLimit: 168 * 60, // 7天
    steps: ['assess_impact', 'notify_users', 'remediate']
  },
  P3: { // 低风险
    autoNotify: false,
    notifyRegulator: false,
    notifyUsers: false,
    timeLimit: 720 * 60, // 30天
    steps: ['assess_impact', 'remediate']
  }
};
```

### 4.3 监管报告生成

- GDPR 报告模板：包含泄露性质、受影响数据类别、可能后果、已采取措施
- CCPA 报告模板：包含泄露类型、受影响消费者数量、通知时间线
- 支持多语言报告生成
- 自动填充时间戳、受影响范围等数据

### 4.4 用户通知系统

```javascript
// 通知模板
const userNotificationTemplates = {
  'data-breach': {
    channels: ['email', 'in-app', 'push'],
    template: {
      zh: '我们检测到您的数据可能受到影响...',
      en: 'We detected your data may be affected...',
      ja: 'お客様のデータが影響を受ける可能性が...'
    },
    includeRecommendations: true
  }
};
```

- 支持邮件、应用内通知、推送多渠道
- 根据用户语言偏好自动选择模板
- 记录通知送达状态

### 4.5 事件时间线管理

```javascript
// 事件数据结构
const leakEvent = {
  id: 'LEAK-2026-001',
  detectedAt: '2026-06-16T05:00:00Z',
  severity: 'P1',
  status: 'contained', // detected, contained, notified, resolved, closed
  affectedData: {
    userCount: 5000,
    dataTypes: ['email', 'phone', 'payment_info'],
    scope: 'partial'
  },
  timeline: [
    { time: '05:00', action: 'detected', actor: 'system' },
    { time: '05:05', action: 'containment_started', actor: 'admin' },
    { time: '05:30', action: 'contained', actor: 'admin' },
    { time: '06:00', action: 'regulator_notified', actor: 'admin' }
  ],
  rootCause: null,
  remediation: null
};
```

### 4.6 管理后台仪表板

- 事件列表视图（支持筛选、排序）
- 单事件详情页（完整时间线、受影响范围）
- 响应进度追踪（倒计时、步骤完成状态）
- 统计报表（泄露频率、响应时间、影响范围趋势）

## 5. 验收标准（可测试）

- [ ] 检测引擎能在 5 分钟内识别批量数据导出异常并创建事件
- [ ] P1 级别事件自动触发响应流程，72 小时倒计时正确显示
- [ ] 监管报告模板包含所有必需字段，支持中/英/日三语
- [ ] 用户通知能在事件确认后 1 小时内送达 95% 受影响用户
- [ ] 事件时间线完整记录所有响应动作，支持审计导出
- [ ] 管理后台能正确展示事件列表和详情，响应进度实时更新
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试覆盖完整响应流程

## 6. 工作量估算

**L（Large）** - 涉及多个模块开发：
- 检测引擎：2天
- 响应流程管理：2天
- 报告生成：1天
- 用户通知：1天
- 管理后台：2天
- 测试与文档：1天

总计约 9 人天

## 7. 优先级理由

**P1 理由**：
1. **合规强制要求**：GDPR 第 33 条明确要求 72 小时内通知，违规将面临高额罚款（最高 2000 万欧元或 4% 全球营业额）
2. **用户信任保护**：及时透明的泄露通知是维护用户信任的关键
3. **风险缓解**：自动化响应显著缩短响应时间，降低泄露影响范围
4. **当前成熟度缺口**：STATUS.md 显示"安全与合规"维度得分 12/15，泄露响应是主要缺口之一
