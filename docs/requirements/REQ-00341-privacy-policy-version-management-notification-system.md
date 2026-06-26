# REQ-00341：隐私政策版本管理与变更通知系统

- **编号**：REQ-00341
- **类别**：合规/隐私
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：user-service、gateway、game-client、admin-dashboard、backend/shared、database/migrations
- **创建时间**：2026-06-26 10:00 UTC
- **依赖需求**：REQ-00016（GDPR 合规与用户数据隐私保护）

## 1. 背景与问题

根据 GDPR 第 7 条和第 13 条要求，数据控制者必须在收集个人数据时提供清晰透明的隐私政策，并在政策发生重大变更时及时通知用户。当前 mineGo 项目虽然已实现 Cookie 同意管理（REQ-00322）和数据主体权利请求管理（REQ-00338），但缺少系统化的隐私政策版本管理机制，存在以下问题：

1. **版本管理缺失**：隐私政策文件以静态形式存储，缺少版本号、生效日期、变更历史等元数据管理
2. **变更通知不完善**：政策更新时无法自动推送给所有受影响用户，缺少强制阅读确认机制
3. **同意记录不完整**：用户对隐私政策的同意记录未与具体版本绑定，无法追溯用户同意的是哪个版本
4. **多语言版本同步困难**：中/英/日三语隐私政策版本更新不同步，可能导致合规风险
5. **审计追溯能力弱**：缺少完整的政策变更日志和用户同意历史，难以应对监管审查

## 2. 目标

建立完整的隐私政策版本管理与变更通知系统，实现：

1. **全生命周期管理**：隐私政策的起草、审核、发布、归档全流程管理
2. **版本追溯**：每个版本独立编号、时间戳、变更摘要，支持历史版本查询
3. **智能通知**：政策更新时自动识别受影响用户，通过多渠道推送变更通知
4. **强制确认机制**：重大变更时强制用户阅读新版本并重新获得明确同意
5. **合规审计**：完整的同意记录、变更日志、用户通知记录，满足 GDPR 透明度要求

预期收益：
- 满足 GDPR 第 7 条明确同意要求和第 13 条透明度义务
- 降低监管合规风险，避免因隐私政策管理不当导致的罚款
- 提升用户信任度，增强隐私保护形象
- 简化合规审计流程，支持快速响应监管查询

## 3. 范围

### 包含：
- 隐私政策版本数据模型与数据库表设计
- 隐私政策 CRUD API（创建、查询、更新、归档）
- 版本对比与变更摘要自动生成
- 多语言版本关联与同步状态管理
- 用户同意记录与版本绑定机制
- 政策变更通知推送系统（游戏内通知、邮件、推送）
- 强制阅读确认流程与弹窗 UI
- 管理后台政策管理界面
- 变更历史审计日志

### 不包含：
- 隐私政策法律文本起草（由法务团队负责）
- 第三方隐私政策合规性评估
- 跨司法管辖区的法律差异分析
- 自动化法律合规检查工具

## 4. 详细需求

### 4.1 数据模型设计

#### 表：privacy_policies
```sql
CREATE TABLE privacy_policies (
  id SERIAL PRIMARY KEY,
  version VARCHAR(20) NOT NULL UNIQUE, -- 版本号如 "2.1.0"
  language VARCHAR(10) NOT NULL, -- zh-CN, en-US, ja-JP
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL, -- Markdown 格式
  content_html TEXT, -- 渲染后的 HTML
  summary TEXT, -- 政策摘要
  change_summary TEXT, -- 相对上一版本的变更说明
  change_type VARCHAR(20) NOT NULL, -- major/minor/patch
  effective_date TIMESTAMP WITH TIME ZONE NOT NULL,
  publish_date TIMESTAMP WITH TIME ZONE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft', -- draft/published/archived
  require_re_consent BOOLEAN NOT NULL DEFAULT false, -- 是否需要重新获取同意
  created_by INTEGER NOT NULL, -- 管理员 ID
  reviewed_by INTEGER, -- 审核人 ID
  reviewed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT valid_change_type CHECK (change_type IN ('major', 'minor', 'patch')),
  CONSTRAINT valid_status CHECK (status IN ('draft', 'published', 'archived'))
);

CREATE INDEX idx_privacy_policies_version ON privacy_policies(version);
CREATE INDEX idx_privacy_policies_language ON privacy_policies(language);
CREATE INDEX idx_privacy_policies_status ON privacy_policies(status);
CREATE INDEX idx_privacy_policies_effective_date ON privacy_policies(effective_date);
```

#### 表：user_privacy_consents
```sql
CREATE TABLE user_privacy_consents (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  policy_id INTEGER NOT NULL REFERENCES privacy_policies(id),
  consent_type VARCHAR(50) NOT NULL, -- 'explicit', 'implicit', 'forced_update'
  consent_method VARCHAR(50) NOT NULL, -- 'web', 'mobile_app', 'admin_dashboard'
  ip_address INET,
  user_agent TEXT,
  consented_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT unique_user_policy_consent UNIQUE(user_id, policy_id)
);

CREATE INDEX idx_user_privacy_consents_user ON user_privacy_consents(user_id);
CREATE INDEX idx_user_privacy_consents_policy ON user_privacy_consents(policy_id);
CREATE INDEX idx_user_privacy_consents_date ON user_privacy_consents(consented_at);
```

#### 表：privacy_policy_change_notifications
```sql
CREATE TABLE privacy_policy_change_notifications (
  id BIGSERIAL PRIMARY KEY,
  policy_id INTEGER NOT NULL REFERENCES privacy_policies(id),
  user_id INTEGER NOT NULL,
  notification_channel VARCHAR(50) NOT NULL, -- 'in_app', 'email', 'push'
  notification_status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending/sent/delivered/read
  sent_at TIMESTAMP WITH TIME ZONE,
  delivered_at TIMESTAMP WITH TIME ZONE,
  read_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT valid_notification_status CHECK (notification_status IN ('pending', 'sent', 'delivered', 'read'))
);

CREATE INDEX idx_ppc_notifications_policy ON privacy_policy_change_notifications(policy_id);
CREATE INDEX idx_ppc_notifications_user ON privacy_policy_change_notifications(user_id);
CREATE INDEX idx_ppc_notifications_status ON privacy_policy_change_notifications(notification_status);
```

### 4.2 API 接口设计

#### 用户端 API（gateway）

**GET /api/v1/privacy-policy/current**
- 获取当前生效的隐私政策
- 返回：版本号、内容、摘要、生效日期
- 支持语言参数：`?lang=zh-CN`

**GET /api/v1/privacy-policy/history**
- 获取隐私政策历史版本列表
- 分页、支持语言过滤

**GET /api/v1/privacy-policy/:version/changes**
- 获取指定版本的变更详情
- 返回：变更摘要、对比上一版本的 diff

**POST /api/v1/privacy-policy/:version/consent**
- 用户同意隐私政策
- 记录：用户 ID、政策版本、IP、User-Agent、时间戳
- 返回：同意记录 ID

**GET /api/v1/privacy-policy/consent-status**
- 获取当前用户的隐私政策同意状态
- 返回：是否已同意最新版本、同意时间、版本号

#### 管理端 API（admin-dashboard）

**POST /api/admin/privacy-policy**
- 创建新隐私政策草稿
- 参数：版本号、语言、标题、内容、生效日期、变更类型

**PUT /api/admin/privacy-policy/:id**
- 更新隐私政策草稿

**POST /api/admin/privacy-policy/:id/publish**
- 发布隐私政策
- 自动触发通知推送流程
- 参数：是否强制用户重新同意

**POST /api/admin/privacy-policy/:id/review**
- 审核隐私政策
- 记录审核人和审核时间

**GET /api/admin/privacy-policy/statistics**
- 获取隐私政策统计信息
- 返回：各版本同意用户数、未同意用户数、通知送达率

### 4.3 变更检测与摘要生成

实现智能变更检测：

```javascript
// backend/shared/privacyPolicy/diffGenerator.js
class PrivacyPolicyDiffGenerator {
  /**
   * 比较两个版本的隐私政策，生成变更摘要
   */
  generateChangeSummary(oldContent, newContent) {
    const diff = this.computeDiff(oldContent, newContent);
    const changes = {
      additions: [],
      deletions: [],
      modifications: [],
      changeType: this.determineChangeType(diff)
    };
    
    // 提取关键条款变更（如数据收集范围、共享第三方、用户权利等）
    const keyClauses = this.extractKeyClauses(diff);
    
    // 生成人类可读的变更摘要
    changes.summary = this.generateHumanReadableSummary(keyClauses);
    
    return changes;
  }
  
  /**
   * 判断变更类型：major（重大变更）, minor（次要变更）, patch（修正）
   */
  determineChangeType(diff) {
    // 检测重大条款变更：数据收集范围、共享对象、用户权利、存储期限等
    const majorKeywords = ['数据收集', '第三方共享', '存储期限', '用户权利', '删除权'];
    // ...
  }
}
```

### 4.4 通知推送机制

政策发布后自动推送通知：

```javascript
// backend/jobs/privacyPolicyNotificationJob.js
class PrivacyPolicyNotificationJob {
  async execute(policyId) {
    // 1. 获取需要通知的用户列表
    const affectedUsers = await this.getAffectedUsers(policyId);
    
    // 2. 分批创建通知记录
    await this.createNotificationRecords(policyId, affectedUsers);
    
    // 3. 多渠道推送
    for (const batch of this.chunk(affectedUsers, 100)) {
      await Promise.all([
        this.sendInAppNotifications(batch, policyId),
        this.sendEmailNotifications(batch, policyId),
        this.sendPushNotifications(batch, policyId)
      ]);
    }
    
    // 4. 更新通知状态
    await this.updateNotificationStatus(policyId);
  }
  
  async getAffectedUsers(policyId) {
    // 获取未同意最新版本政策的活跃用户
    const query = `
      SELECT u.id, u.email, u.language_preference
      FROM users u
      WHERE u.status = 'active'
        AND u.id NOT IN (
          SELECT user_id FROM user_privacy_consents
          WHERE policy_id = $1
        )
    `;
    // ...
  }
}
```

### 4.5 强制阅读确认流程

重大变更时，用户登录后必须确认新政策：

```javascript
// gateway/middleware/privacyPolicyCheck.js
async function checkPrivacyPolicyConsent(req, res, next) {
  const userId = req.user.id;
  const latestPolicy = await privacyPolicyService.getLatestPolicy();
  
  // 检查用户是否已同意最新版本
  const hasConsented = await privacyPolicyService.hasUserConsented(userId, latestPolicy.id);
  
  if (!hasConsented && latestPolicy.require_re_consent) {
    // 返回特殊响应，要求前端展示政策确认弹窗
    return res.status(451).json({
      error: 'Privacy policy update required',
      policyVersion: latestPolicy.version,
      policyUrl: `/privacy-policy/${latestPolicy.version}`,
      requireConsent: true
    });
  }
  
  next();
}
```

前端游戏客户端实现：

```javascript
// game-client/src/privacy/PrivacyPolicyManager.js
class PrivacyPolicyManager {
  async checkPolicyUpdate() {
    try {
      const response = await fetch('/api/v1/privacy-policy/current');
      const policy = await response.json();
      
      if (policy.requireConsent) {
        this.showPolicyUpdateDialog(policy);
      }
    } catch (error) {
      if (error.status === 451) {
        // 强制更新隐私政策
        this.showForceUpdateDialog(error.data);
      }
    }
  }
  
  showForceUpdateDialog(policy) {
    // 全屏弹窗，阻止用户继续操作
    const dialog = new PrivacyPolicyDialog({
      title: policy.title,
      content: policy.content_html,
      summary: policy.change_summary,
      onAccept: () => this.acceptPolicy(policy.version)
    });
    
    dialog.showModal(); // 无法关闭，必须同意
  }
}
```

### 4.6 管理后台界面

管理后台新增隐私政策管理页面：

1. **政策列表页**：显示所有版本，支持筛选（草稿/已发布/已归档）、搜索
2. **编辑器页**：Markdown 编辑器，支持预览、版本对比
3. **发布流程**：发布前审核、选择是否强制重新同意、设置生效日期
4. **统计看板**：同意用户数、未同意用户列表、通知送达率、阅读率
5. **通知管理**：重新发送通知、查看通知状态

### 4.7 多语言版本同步

确保中/英/日三语版本同步更新：

```javascript
// backend/shared/privacyPolicy/multilingualSync.js
class MultilingualSyncManager {
  async syncVersions(baseVersion, translations) {
    // 1. 创建主语言版本（如中文）
    const basePolicy = await this.createPolicy({
      version: baseVersion,
      language: 'zh-CN',
      ...translations['zh-CN']
    });
    
    // 2. 关联其他语言版本
    for (const lang of ['en-US', 'ja-JP']) {
      await this.createPolicy({
        version: baseVersion,
        language: lang,
        parent_id: basePolicy.id, // 关联主版本
        ...translations[lang]
      });
    }
    
    // 3. 检查翻译完整性
    await this.validateTranslationCompleteness(baseVersion);
  }
  
  async validateTranslationCompleteness(version) {
    const languages = ['zh-CN', 'en-US', 'ja-JP'];
    const policies = await this.getPoliciesByVersion(version);
    
    const missingLanguages = languages.filter(
      lang => !policies.find(p => p.language === lang)
    );
    
    if (missingLanguages.length > 0) {
      // 警告：某些语言版本缺失
      logger.warn(`Missing translations for version ${version}: ${missingLanguages.join(', ')}`);
    }
  }
}
```

## 5. 验收标准（可测试）

- [ ] **数据库迁移**：成功创建 privacy_policies、user_privacy_consents、privacy_policy_change_notifications 三张表
- [ ] **版本管理**：能够创建、查询、更新、归档隐私政策，版本号唯一且递增
- [ ] **变更检测**：系统能够自动检测两个版本间的差异并生成变更摘要
- [ ] **多语言支持**：中/英/日三语版本能够正确关联，翻译完整性检查正常工作
- [ ] **用户同意记录**：用户同意隐私政策后，记录正确保存，包含版本号、时间戳、IP、User-Agent
- [ ] **同意状态查询**：能够查询用户对最新政策的同意状态，返回是否需要重新同意
- [ ] **通知推送**：政策发布后，能够在 1 小时内向所有未同意用户发送通知（游戏内、邮件、推送）
- [ ] **强制确认**：重大变更发布后，用户下次登录时看到强制确认弹窗，无法跳过
- [ ] **管理后台**：管理员能够创建、编辑、审核、发布隐私政策，查看统计信息
- [ ] **审计日志**：所有政策变更、用户同意操作都有完整的审计日志，可追溯
- [ ] **性能要求**：查询当前政策响应时间 < 100ms，批量发送通知支持至少 10 万用户
- [ ] **合规测试**：通过 GDPR 合规性检查，满足第 7 条明确同意和第 13 条透明度要求

## 6. 工作量估算

**L（Large）**

理由：
- 涉及 3 张新数据库表设计与迁移
- 需要实现完整的 CRUD API、通知系统、多语言同步机制
- 前端需要实现游戏客户端和管理后台两个界面
- 强制确认流程涉及认证中间件改造
- 变更检测与摘要生成需要算法实现
- 需要充分的测试覆盖和性能优化

预计工作量：3-5 人天

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **合规刚性要求**：GDPR 第 7 条明确要求必须获得用户的明确同意，且必须能够证明用户同意的是哪个版本的隐私政策，缺少此功能将面临重大合规风险
2. **用户权益保护**：隐私政策变更通知是用户的基本权利，也是建立用户信任的关键
3. **监管审查必备**：数据保护监管机构审查时必查项目，缺少将导致合规性不合格
4. **基础设施依赖**：其他合规功能（如数据主体权利请求）依赖于准确的隐私政策版本记录
5. **风险评估**：项目成熟度评分 92 分，安全与合规维度已达满分，但隐私政策管理是明显的缺失环节，补齐后可进一步提升整体合规水平

此需求完成后，mineGo 项目的合规体系将更加完善，为全球化运营提供坚实的法律合规基础。
