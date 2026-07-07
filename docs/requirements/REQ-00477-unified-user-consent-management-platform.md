# REQ-00477：统一用户同意管理平台

## 元信息
| 字段 | 值 |
|------|------|
| 编号 | REQ-00477 |
| 标题 | 统一用户同意管理平台 |
| 类别 | 合规/隐私 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、user-service、game-client、database/migrations |
| 创建时间 | 2026-07-07 08:00 UTC |
| 依赖需求 | REQ-00384（GDPR 数据主体权利请求管理）、REQ-00322（Cookie 同意管理） |

## 1. 背景与问题

mineGo 项目已实现了多个合规功能：
- GDPR 数据主体权利请求管理（REQ-00384）：支持数据访问、删除、修正请求
- Cookie 同意管理（REQ-00322）：网页端 cookie 弹窗和偏好设置
- 隐私政策版本管理（REQ-00341）：隐私政策更新通知系统
- 第三方数据处理协议管理（REQ-00467）：DPA 协议管理

但缺少一个**统一的同意管理平台**来整合所有用户同意：

### 1.1 同意分散管理问题
- **Cookie 同意**仅在网页端（admin-dashboard），缺少游戏客户端支持
- **隐私政策同意**无明确的同意收集机制，仅通知更新
- **数据处理同意**（如位置数据收集、行为分析）缺少明确同意流程
- **第三方数据共享同意**缺少用户授权界面

### 1.2 合规风险
- **GDPR 第 7 条**：数据处理需明确、具体的用户同意
- **CCPA**：加州用户有权选择退出数据销售
- **中国个人信息保护法**：处理敏感个人信息需单独同意
- 缺少统一的同意记录，难以证明合规性

### 1.3 用户体验问题
- 用户无法集中查看和管理所有同意项
- 同意状态分散，用户不知道哪些数据被如何处理
- 缺少便捷的同意撤回机制

## 2. 目标

实现一个**统一的用户同意管理平台**，包括：

1. **同意收集系统**：在关键操作前收集明确同意（注册、位置收集、数据分析等）
2. **同意管理中心**：用户可集中查看、管理、撤回所有同意项
3. **同意记录系统**：完整记录同意历史，用于合规审计
4. **多平台支持**：覆盖游戏客户端、管理后台、API 接口
5. **智能提醒系统**：根据法律要求定期提醒用户审查同意设置

**预期收益**：
- 降低合规风险，满足 GDPR、CCPA、中国个人信息保护法要求
- 提升用户信任度和透明度
- 简化合规审计流程
- 为未来扩展其他地区合规提供基础

## 3. 范围

### 包含
- 同意类型定义系统（GDPR、CCPA、数据收集、第三方共享等）
- 同意收集界面（注册流程、游戏内弹窗、隐私设置页）
- 同意管理 API（获取、更新、撤回、查询历史）
- 同意记录数据库（完整历史、时间戳、版本）
- 游戏客户端同意管理 UI（设置页面、同意弹窗）
- 合规审计 API（导出同意记录、生成合规报告）
- 同意过期与提醒系统（定期提醒用户审查）

### 不包含
- Cookie 同意弹窗（已有 REQ-00322，本需求集成而非重复）
- 隐私政策管理（已有 REQ-00341，本需求关联但不重复）
- 具体的数据处理逻辑（本需求管理同意，不执行数据处理）

## 4. 详细需求

### 4.1 同意类型定义

```javascript
const CONSENT_TYPES = {
  // 核心同意（必须，无法撤回）
  TERMS_OF_SERVICE: {
    id: 'tos',
    category: 'essential',
    required: true,
    versioned: true,
    description: '服务条款同意',
    gdpr_article: null, // 不属于 GDPR 范畴
    locales: {
      'zh-CN': '我已阅读并同意服务条款',
      'en-US': 'I have read and agree to the Terms of Service'
    }
  },
  
  PRIVACY_POLICY: {
    id: 'privacy_policy',
    category: 'essential',
    required: true,
    versioned: true,
    description: '隐私政策同意',
    gdpr_article: 'Art. 13',
    locales: {
      'zh-CN': '我已阅读并同意隐私政策',
      'en-US': 'I have read and agree to the Privacy Policy'
    }
  },
  
  // GDPR 同意
  DATA_PROCESSING: {
    id: 'data_processing',
    category: 'gdpr',
    required: false,
    versioned: true,
    description: '个人数据处理同意',
    gdpr_article: 'Art. 7',
    data_types: ['location', 'behavior', 'preferences', 'social'],
    locales: {
      'zh-CN': '我同意 mineGo 处理我的个人数据以提供游戏服务',
      'en-US': 'I consent to mineGo processing my personal data to provide game services'
    }
  },
  
  LOCATION_COLLECTION: {
    id: 'location_collection',
    category: 'gdpr_sensitive',
    required: false,
    versioned: true,
    description: '地理位置数据收集同意',
    gdpr_article: 'Art. 9', // 敏感数据
    sensitive: true,
    locales: {
      'zh-CN': '我同意收集我的地理位置数据用于游戏核心功能',
      'en-US': 'I consent to collecting my geolocation data for core game features'
    }
  },
  
  ANALYTICS_TRACKING: {
    id: 'analytics_tracking',
    category: 'gdpr',
    required: false,
    versioned: false,
    description: '行为分析同意',
    gdpr_article: 'Art. 7',
    locales: {
      'zh-CN': '我同意使用我的行为数据改进游戏体验',
      'en-US': 'I consent to using my behavior data to improve game experience'
    }
  },
  
  THIRD_PARTY_SHARING: {
    id: 'third_party_sharing',
    category: 'gdpr',
    required: false,
    versioned: true,
    description: '第三方数据共享同意',
    gdpr_article: 'Art. 7',
    related_requirement: 'REQ-00467',
    locales: {
      'zh-CN': '我同意与合作伙伴共享部分数据',
      'en-US': 'I consent to sharing some data with partners'
    }
  },
  
  // CCPA 同意
  DO_NOT_SELL: {
    id: 'do_not_sell',
    category: 'ccpa',
    required: false,
    versioned: false,
    description: 'CCPA 选择退出数据销售',
    ccpa_section: '1798.120',
    opt_out: true, // 选择退出而非同意
    locales: {
      'zh-CN': '我选择退出数据销售（CCPA）',
      'en-US': 'I opt out of the sale of my personal information (CCPA)'
    }
  },
  
  // 中国个人信息保护法
  SENSITIVE_DATA_PROCESSING: {
    id: 'sensitive_data_processing',
    category: 'pipl',
    required: false,
    versioned: true,
    description: '敏感个人信息单独同意',
    pipl_article: 'Art. 29',
    sensitive: true,
    data_types: ['face', 'voice', 'health'],
    locales: {
      'zh-CN': '我单独同意处理我的敏感个人信息',
      'en-US': 'I separately consent to processing my sensitive personal information'
    }
  },
  
  // 其他同意
  MARKETING_COMMUNICATIONS: {
    id: 'marketing_communications',
    category: 'optional',
    required: false,
    versioned: false,
    description: '营销通讯同意',
    locales: {
      'zh-CN': '我同意接收营销信息和推广活动通知',
      'en-US': 'I consent to receiving marketing communications'
    }
  },
  
  PUSH_NOTIFICATIONS: {
    id: 'push_notifications',
    category: 'optional',
    required: false,
    versioned: false,
    description: '推送通知同意',
    locales: {
      'zh-CN': '我同意接收游戏推送通知',
      'en-US': 'I consent to receiving push notifications'
    }
  }
};
```

### 4.2 同意收集流程

#### 4.2.1 注册流程同意
```javascript
// user-service/src/routes/auth.js - 注册同意收集
async function registerWithConsent(req, res) {
  const { username, email, password, consents } = req.body;
  
  // 必须同意
  const requiredConsents = ['tos', 'privacy_policy'];
  for (const consentId of requiredConsents) {
    if (!consents[consentId]) {
      return res.status(400).json({
        error: 'MISSING_REQUIRED_CONSENT',
        message: `必须同意 ${consentId}`,
        required: requiredConsents
      });
    }
  }
  
  // 创建用户
  const user = await createUser(username, email, password);
  
  // 记录同意
  for (const [consentId, agreed] of Object.entries(consents)) {
    if (agreed) {
      await recordConsent(user.id, consentId, {
        source: 'registration',
        version: getConsentVersion(consentId),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        locale: user.locale
      });
    }
  }
  
  res.json({ success: true, userId: user.id });
}
```

#### 4.2.2 游戏内同意弹窗
```javascript
// game-client/src/components/ConsentManager.js
class ConsentManager {
  /**
   * 显示同意收集弹窗
   */
  async showConsentDialog(consentType, context = {}) {
    const consentDef = CONSENT_TYPES[consentType];
    
    // 检查是否已同意
    const existing = await this.getConsent(consentType);
    if (existing && existing.agreed && !consentDef.versioned) {
      return { agreed: true, skipped: true };
    }
    
    // 显示弹窗
    const dialog = this.createConsentDialog(consentDef, context);
    const result = await this.showDialog(dialog);
    
    // 记录同意
    if (result.agreed) {
      await this.recordConsent(consentType, {
        source: context.source || 'game_client',
        version: consentDef.versioned ? getConsentVersion(consentType) : null,
        context
      });
    }
    
    return result;
  }
  
  /**
   * 创建同意弹窗
   */
  createConsentDialog(consentDef, context) {
    return {
      title: i18n.t(`consent.${consentDef.id}.title`),
      message: i18n.t(`consent.${consentDef.id}.message`),
      description: consentDef.description,
      required: consentDef.required,
      sensitive: consentDef.sensitive,
      actions: [
        {
          label: i18n.t('consent.agree'),
          primary: true,
          value: true
        },
        ...(consentDef.required ? [] : [
          {
            label: i18n.t('consent.disagree'),
            value: false
          }
        ])
      ],
      learnMore: {
        label: i18n.t('consent.learnMore'),
        url: `/privacy#${consentDef.id}`
      }
    };
  }
}
```

### 4.3 同意管理 API

#### 4.3.1 获取用户同意列表
```
GET /api/v1/users/:userId/consents
Response: {
  consents: [
    {
      consentId: 'tos',
      agreed: true,
      version: '2026-01-01',
      agreedAt: '2026-06-10T10:30:00Z',
      source: 'registration',
      canWithdraw: false
    },
    {
      consentId: 'data_processing',
      agreed: true,
      version: '2026-05-01',
      agreedAt: '2026-06-10T10:30:00Z',
      canWithdraw: true,
      withdrawnAt: null
    },
    {
      consentId: 'do_not_sell',
      agreed: false, // CCPA 选择退出
      optedOutAt: '2026-06-15T14:20:00Z',
      canWithdraw: true
    }
  ],
  pendingConsents: ['location_collection'], // 需要重新同意（版本更新）
  lastUpdated: '2026-07-01T08:00:00Z'
}
```

#### 4.3.2 更新同意
```
PUT /api/v1/users/:userId/consents/:consentId
Body: { agreed: true }
Response: {
  success: true,
  consent: {
    consentId: 'data_processing',
    agreed: true,
    version: '2026-07-01',
    agreedAt: '2026-07-07T08:00:00Z',
    source: 'user_update'
  }
}
```

#### 4.3.3 撤回同意
```
DELETE /api/v1/users/:userId/consents/:consentId
Response: {
  success: true,
  withdrawnAt: '2026-07-07T08:05:00Z',
  effects: ['将停止数据处理', '部分功能可能受限'],
  reconsentUrl: '/settings/consents'
}
```

#### 4.3.4 同意历史
```
GET /api/v1/users/:userId/consents/:consentId/history
Response: {
  history: [
    {
      version: '2026-05-01',
      agreed: true,
      agreedAt: '2026-06-10T10:30:00Z',
      source: 'registration',
      ip: '192.168.1.100',
      userAgent: 'Mozilla/5.0...'
    },
    {
      version: '2026-07-01',
      agreed: true,
      agreedAt: '2026-07-07T08:00:00Z',
      source: 'user_update',
      reason: 'policy_update'
    }
  ]
}
```

### 4.4 数据库表设计

#### 4.4.1 user_consents 表
```sql
CREATE TABLE user_consents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  consent_id VARCHAR(64) NOT NULL,
  consent_type VARCHAR(32) NOT NULL, -- essential | gdpr | gdpr_sensitive | ccpa | pipl | optional
  
  -- 同意状态
  agreed BOOLEAN NOT NULL,
  version VARCHAR(32), -- 同意版本（如隐私政策版本）
  
  -- 元数据
  source VARCHAR(32) NOT NULL, -- registration | game_client | user_update | policy_update
  ip_address VARCHAR(64),
  user_agent TEXT,
  locale VARCHAR(16),
  
  -- 上下文信息
  context JSONB DEFAULT '{}',
  
  -- 时间戳
  agreed_at TIMESTAMPTZ DEFAULT NOW(),
  withdrawn_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ, -- 同意过期时间（可选）
  
  -- 索引
  INDEX idx_user_id (user_id),
  INDEX idx_consent_id (consent_id),
  INDEX idx_agreed_at (agreed_at DESC),
  UNIQUE idx_user_consent_version (user_id, consent_id, version)
);
```

#### 4.4.2 consent_versions 表
```sql
CREATE TABLE consent_versions (
  id SERIAL PRIMARY KEY,
  consent_id VARCHAR(64) NOT NULL,
  version VARCHAR(32) NOT NULL,
  content_url VARCHAR(512), -- 相关文档 URL（如隐私政策）
  
  -- 多语言内容
  content_locales JSONB DEFAULT '{}',
  
  -- 生效时间
  effective_at TIMESTAMPTZ NOT NULL,
  
  -- 变更说明
  changes_summary TEXT,
  requires_reconsent BOOLEAN DEFAULT false, -- 是否需要用户重新同意
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  INDEX idx_consent_id (consent_id),
  INDEX idx_version (version),
  UNIQUE idx_consent_version (consent_id, version)
);
```

### 4.5 合规审计 API

#### 4.5.1 导出同意记录
```
GET /api/v1/admin/compliance/consents/export
Query: { startDate, endDate, consentType, format }
Response: {
  exportId: 'export_abc123',
  downloadUrl: '/api/v1/admin/compliance/exports/abc123',
  expiresAt: '2026-07-14T08:00:00Z'
}
```

#### 4.5.2 合规报告
```
GET /api/v1/admin/compliance/consents/report
Response: {
  summary: {
    totalUsers: 10000,
    consentStats: {
      tos: { agreed: 10000, percentage: 100 },
      privacy_policy: { agreed: 10000, percentage: 100 },
      data_processing: { agreed: 8500, percentage: 85 },
      location_collection: { agreed: 7000, percentage: 70 },
      do_not_sell: { optedOut: 500, percentage: 5 }
    }
  },
  gdpr_compliance: {
    article_7: { compliant: true, notes: '所有数据处理都有明确同意' },
    article_9: { compliant: true, notes: '位置数据收集有单独同意' },
    article_13: { compliant: true, notes: '隐私政策已提供' }
  },
  ccpa_compliance: {
    section_1798_120: { compliant: true, notes: '提供选择退出选项' }
  },
  recommendations: [
    '建议定期提醒用户审查同意设置',
    '建议在隐私政策更新后强制重新同意'
  ]
}
```

### 4.6 同意过期与提醒

```javascript
// backend/jobs/consent-reminder.js
class ConsentReminderJob {
  /**
   * 定期提醒用户审查同意设置
   * GDPR 建议每 12 个月提醒一次
   */
  async run() {
    // 查找超过 12 个月未更新的同意
    const staleConsents = await this.query(`
      SELECT user_id, consent_id, agreed_at
      FROM user_consents
      WHERE agreed = true
        AND withdrawn_at IS NULL
        AND agreed_at < NOW() - INTERVAL '12 months'
        AND consent_type IN ('gdpr', 'gdpr_sensitive', 'ccpa', 'pipl')
    `);
    
    for (const consent of staleConsents) {
      await this.sendReminder(consent.user_id, consent.consent_id);
    }
  }
  
  /**
   * 发送提醒
   */
  async sendReminder(userId, consentId) {
    const user = await getUser(userId);
    const consentDef = CONSENT_TYPES[consentId];
    
    await sendEmail(user.email, {
      subject: i18n.t('consent.reminder.subject', user.locale),
      body: i18n.t('consent.reminder.body', user.locale, {
        consentName: consentDef.description,
        reviewUrl: `${BASE_URL}/settings/consents`
      })
    });
    
    // 记录提醒
    await recordConsentReminder(userId, consentId);
  }
}
```

### 4.7 游戏客户端 UI

#### 4.7.1 同意管理设置页
```javascript
// game-client/src/components/ConsentSettings.js
class ConsentSettings {
  render() {
    return `
      <div class="consent-settings">
        <h2>${i18n.t('settings.consents.title')}</h2>
        <p class="consent-intro">${i18n.t('settings.consents.intro')}</p>
        
        <div class="consent-categories">
          <!-- 必须同意 -->
          <div class="consent-category essential">
            <h3>${i18n.t('consent.category.essential')}</h3>
            <p class="category-note">${i18n.t('consent.category.essential.note')}</p>
            ${this.renderConsentItem('tos')}
            ${this.renderConsentItem('privacy_policy')}
          </div>
          
          <!-- GDPR 同意 -->
          <div class="consent-category gdpr">
            <h3>${i18n.t('consent.category.gdpr')}</h3>
            ${this.renderConsentItem('data_processing')}
            ${this.renderConsentItem('location_collection')}
            ${this.renderConsentItem('analytics_tracking')}
            ${this.renderConsentItem('third_party_sharing')}
          </div>
          
          <!-- CCPA 同意 -->
          <div class="consent-category ccpa">
            <h3>${i18n.t('consent.category.ccpa')}</h3>
            ${this.renderConsentItem('do_not_sell')}
          </div>
          
          <!-- 可选同意 -->
          <div class="consent-category optional">
            <h3>${i18n.t('consent.category.optional')}</h3>
            ${this.renderConsentItem('marketing_communications')}
            ${this.renderConsentItem('push_notifications')}
          </div>
        </div>
        
        <div class="consent-actions">
          <button class="btn-export">${i18n.t('consent.export')}</button>
          <button class="btn-history">${i18n.t('consent.history')}</button>
        </div>
      </div>
    `;
  }
  
  renderConsentItem(consentId) {
    const consent = this.userConsents.find(c => c.consentId === consentId);
    const consentDef = CONSENT_TYPES[consentId];
    
    return `
      <div class="consent-item ${consentDef.required ? 'required' : 'optional'}">
        <div class="consent-header">
          <h4>${i18n.t(`consent.${consentId}.title`)}</h4>
          ${consentDef.required ? '<span class="badge-required">必须</span>' : ''}
        </div>
        <p class="consent-description">${i18n.t(`consent.${consentId}.description`)}</p>
        <div class="consent-status">
          ${consent.agreed 
            ? `<span class="status-agreed">已同意 (${formatDate(consent.agreedAt)})</span>`
            : `<span class="status-disagreed">未同意</span>`
          }
        </div>
        ${!consentDef.required && consent.agreed 
          ? `<button class="btn-withdraw" data-consent="${consentId}">撤回同意</button>`
          : ''
        }
        <a href="/privacy#${consentId}" class="learn-more">${i18n.t('consent.learnMore')}</a>
      </div>
    `;
  }
}
```

### 4.8 性能要求

- 同意查询时间：< 100ms
- 同意更新时间：< 200ms
- 同意历史导出：< 5 秒（10000 条记录）
- 合规报告生成：< 10 秒
- 支持并发请求：≥ 100 QPS

### 4.9 监控指标

- `minego_consent_total{type, status}`：同意总数
- `minego_consent_agreed_rate{type}`：同意率
- `minego_consent_withdrawn_total{type}`：撤回总数
- `minego_consent_reminder_sent_total`：提醒发送数
- `minego_consent_query_duration_seconds`：查询延迟
- `minego_consent_export_duration_seconds`：导出延迟

## 5. 验收标准（可测试）

- [ ] **同意收集**：注册流程收集必须同意，可选同意可在设置页管理
- [ ] **同意管理**：用户可在设置页查看、更新、撤回所有同意项
- [ ] **同意历史**：完整记录每次同意的时间、版本、来源、IP
- [ ] **多平台支持**：游戏客户端和管理后台均支持同意管理
- [ ] **合规审计**：支持导出同意记录和生成合规报告
- [ ] **同意过期提醒**：定期提醒用户审查同意设置
- [ ] **GDPR 合规**：满足 GDPR 第 7、9、13 条要求
- [ ] **CCPA 合规**：提供数据销售选择退出选项
- [ ] **性能要求**：同意查询 < 100ms，导出 < 5 秒
- [ ] **单元测试**：核心模块单元测试覆盖率 ≥ 85%
- [ ] **集成测试**：同意收集-管理-撤回-审计全链路测试通过

## 6. 工作量估算

**L (Large)**

理由：
- 涉及多个同意类型和合规法规（GDPR、CCPA、PIPL）
- 需要设计完整的同意收集、管理、记录系统
- 游戏客户端 UI 开发工作量较大
- 合规审计功能需要数据导出和报告生成
- 需要与现有隐私政策管理、Cookie 同意管理集成
- 预估开发时间：10-15 人天

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **合规风险**：缺少统一同意管理可能违反 GDPR、CCPA、中国个人信息保护法
2. **法律要求**：GDPR 第 7 条明确要求明确、具体的同意
3. **审计需求**：合规审计需要完整的同意记录
4. **用户信任**：透明同意管理可提升用户信任度
5. **基础功能**：为未来扩展其他地区合规提供基础

相比 P0 需求（安全、稳定），此需求属于合规基础，对项目"合规可用"至关重要。

## 8. 风险与依赖

### 风险
- 法律变更：合规法规可能变更，需及时调整同意类型
- 用户抵触：过多同意弹窗可能影响用户体验
- 多地区差异：不同地区合规要求差异需妥善处理

### 依赖
- REQ-00384（GDPR 数据主体权利请求管理）：需要权限管理集成
- REQ-00322（Cookie 同意管理）：需要集成而非重复
- REQ-00341（隐私政策版本管理）：同意版本与隐私政策版本关联
- REQ-00467（第三方数据处理协议管理）：第三方共享同意依赖此需求

## 9. 后续扩展

- **A/B 测试同意界面**：优化同意收集界面以提高同意率
- **智能同意推荐**：根据用户行为推荐同意设置
- **地区自适应**：根据用户地区自动调整同意类型
- **同意分析仪表板**：可视化同意统计数据
- **同意预测模型**：预测用户同意倾向