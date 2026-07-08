# REQ-00496：推送通知内容多语言本地化与智能语言适配系统

- **编号**：REQ-00496
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：gateway、user-service、backend/shared/pushNotificationService.js、backend/shared/i18n.js、Redis、PostgreSQL
- **创建时间**：2026-07-08 06:00
- **依赖需求**：REQ-00011（多语言支持已完成）、REQ-00425（游戏内通知系统已创建）、REQ-00136（推送服务已完成）

## 1. 背景与问题

mineGo 已实现推送通知服务（REQ-00136）和游戏内通知系统（REQ-00425），但**推送通知内容缺乏多语言本地化支持**：

### 1.1 当前缺口
1. **通知内容单一语言**：当前推送通知标题和正文只有中文版本，国际用户收到的推送无法理解
2. **语言偏好未应用**：推送服务未读取用户 `language_preference` 字段，无法适配用户语言
3. **通知模板缺失**：缺少多语言通知模板库，运营需手动翻译每条推送
4. **语言回退机制不足**：当用户语言无翻译时，无智能回退逻辑
5. **文化差异未考虑**：相同内容在不同文化中表达方式不同（如日文敬语、英文缩写）

### 1.2 用户痛点
- 日本用户收到中文推送通知："系统将于今晚维护" → 无法理解，错过重要信息
- 英文用户收到 "好友赠送了一个礼物" → 需要翻译才能理解
- 运营团队每次推送需人工翻译成 3 种语言，效率低且易出错
- 新用户注册后首次推送无本地化欢迎语

### 1.3 数据现状
- 支持语言：zh-CN、en-US、ja-JP（已有 i18n.js）
- 用户语言分布（估算）：
  - zh-CN：70%
  - en-US：20%
  - ja-JP：10%
- 日均推送量：约 10 万条
- 推送打开率：35%（因语言不匹配，国际用户打开率更低）

## 2. 目标

构建推送通知内容多语言本地化系统，实现：

1. **自动语言适配**：推送时自动读取用户语言偏好，发送对应语言版本
2. **通知模板库**：预置 50+ 常用通知模板，支持 3 种语言
3. **智能回退机制**：当用户语言无翻译时，自动回退到默认语言或英文
4. **运营效率提升**：推送只需填写模板 ID，自动生成多语言内容
5. **推送效果提升**：本地化推送后，国际用户打开率提升至 40%+

## 3. 范围

### 包含
- 数据库设计：`notification_templates`、`user_notification_language_cache` 表
- 多语言通知模板管理服务
- 推送服务语言适配集成
- 智能回退逻辑（language preference → accept-language → 默认语言）
- Admin Dashboard：通知模板管理界面（多语言编辑）
- API 设计：模板查询、创建、更新

### 不包含
- 推送渠道扩展（已有 REQ-00425）
- 推送策略优化（智能推送时机）
- 邮件/短信本地化（后续需求）
- 语音通知

## 4. 详细需求

### 4.1 数据库设计

```sql
-- database/migrations/20260708_060000_push_notification_localization.sql

-- 通知模板表（多语言）
CREATE TABLE notification_templates (
  id SERIAL PRIMARY KEY,
  template_key VARCHAR(64) UNIQUE NOT NULL,  -- 如 'friend_request', 'gift_received'
  category VARCHAR(32) NOT NULL,              -- social/activity/system/reward/security
  priority VARCHAR(16) DEFAULT 'normal',      -- low/normal/high/critical
  variables JSONB,                            -- 支持的变量列表 ['sender_name', 'pokemon_name']
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_template_key ON notification_templates(template_key);
CREATE INDEX idx_template_category ON notification_templates(category);

-- 通知模板内容表（各语言版本）
CREATE TABLE notification_template_contents (
  id SERIAL PRIMARY KEY,
  template_id INTEGER REFERENCES notification_templates(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL,              -- zh-CN/en-US/ja-JP
  title_template TEXT NOT NULL,               -- 支持变量插值，如 "好友 {{sender_name}} 发送了请求"
  body_template TEXT NOT NULL,                -- 如 "点击查看详情"
  action_text VARCHAR(64),                    -- 按钮文本，如 "接受"/"Accept"/"承認"
  cultural_variant TEXT,                      -- 文化适配说明
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(template_id, language)
);

CREATE INDEX idx_template_content_lang ON notification_template_contents(template_id, language);

-- 用户通知语言缓存表
CREATE TABLE user_notification_language_cache (
  user_id VARCHAR(64) PRIMARY KEY,
  language VARCHAR(10) NOT NULL,
  language_source VARCHAR(32),                -- preference/header/device/default
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 预置常用通知模板
INSERT INTO notification_templates (template_key, category, priority, variables) VALUES
-- 社交类
('friend_request', 'social', 'normal', '{"variables": ["sender_name"]}'),
('friend_accepted', 'social', 'normal', '{"variables": ["friend_name"]}'),
('gift_received', 'social', 'normal', '{"variables": ["sender_name", "gift_name"]}'),
('gift_sent', 'social', 'normal', '{"variables": ["recipient_name", "gift_name"]}'),
('trade_request', 'social', 'high', '{"variables": ["sender_name", "pokemon_name"]}'),
('trade_completed', 'social', 'normal', '{"variables": ["partner_name", "pokemon_name"]}'),
-- 活动类
('event_start', 'activity', 'high', '{"variables": ["event_name", "duration"]}'),
('event_end', 'activity', 'normal', '{"variables": ["event_name"]}'),
('raid_nearby', 'activity', 'high', '{"variables": ["pokemon_name", "distance", "time_left"]}'),
('spawn_rare', 'activity', 'high', '{"variables": ["pokemon_name", "distance"]}'),
('spawn_legendary', 'activity', 'critical', '{"variables": ["pokemon_name", "location"]}'),
-- 系统类
('system_maintenance', 'system', 'critical', '{"variables": ["start_time", "duration"]}'),
('system_update', 'system', 'high', '{"variables": ["version", "features"]}'),
('server_restart', 'system', 'high', '{"variables": ["estimated_time"]}'),
-- 奖励类
('daily_reward', 'reward', 'normal', '{"variables": ["reward_name", "amount"]}'),
('achievement_unlock', 'reward', 'high', '{"variables": ["achievement_name"]}'),
('level_up', 'reward', 'normal', '{"variables": ["new_level"]}'),
('streak_bonus', 'reward', 'normal', '{"variables": ["days", "bonus"]}'),
-- 安全类
('security_alert', 'security', 'critical', '{"variables": ["alert_type", "action"]}'),
('password_changed', 'security', 'high', '{"variables": []}'),
('new_device_login', 'security', 'high', '{"variables": ["device_name", "location"]}'),
('account_verify', 'security', 'high', '{"variables": []}');

-- 预置模板内容（三种语言）
INSERT INTO notification_template_contents (template_id, language, title_template, body_template, action_text) VALUES
-- friend_request
(1, 'zh-CN', '好友请求', '{{sender_name}} 想和你成为好友', '查看'),
(1, 'en-US', 'Friend Request', '{{sender_name}} wants to be your friend', 'View'),
(1, 'ja-JP', '友達申請', '{{sender_name}}が友達申請を送りました', '確認'),
-- gift_received
(3, 'zh-CN', '收到礼物', '{{sender_name}} 送了你一个 {{gift_name}}', '领取'),
(3, 'en-US', 'Gift Received', '{{sender_name}} sent you a {{gift_name}}', 'Claim'),
(3, 'ja-JP', 'ギフト受信', '{{sender_name}}から{{gift_name}}が届きました', '受け取る'),
-- event_start
(8, 'zh-CN', '活动开始', '{{event_name}} 已开始！持续 {{duration}}', '参与'),
(8, 'en-US', 'Event Started', '{{event_name}} has started! Duration: {{duration}}', 'Join'),
(8, 'ja-JP', 'イベント開始', '{{event_name}}が始まりました！期間：{{duration}}', '参加'),
-- spawn_legendary
(12, 'zh-CN', '传说精灵出现', '传说中的 {{pokemon_name}} 出现于 {{location}}！', '立即前往'),
(12, 'en-US', 'Legendary Spawned', 'Legendary {{pokemon_name}} appeared at {{location}}!', 'Go Now'),
(12, 'ja-JP', '伝説のポケモン出現', '伝説の{{pokemon_name}}が{{location}}に現れました！', '今すぐ行く'),
-- system_maintenance
(13, 'zh-CN', '系统维护通知', '系统将于 {{start_time}} 开始维护，预计 {{duration}}', '了解更多'),
(13, 'en-US', 'Maintenance Notice', 'System maintenance at {{start_time}}, estimated {{duration}}', 'Learn More'),
(13, 'ja-JP', 'システムメンテナンス', '{{start_time}}からメンテナンス開始、予想時間：{{duration}}', '詳細'),
-- achievement_unlock
(18, 'zh-CN', '成就解锁', '恭喜解锁成就：{{achievement_name}}', '查看奖励'),
(18, 'en-US', 'Achievement Unlocked', 'Achievement unlocked: {{achievement_name}}', 'View Rewards'),
(18, 'ja-JP', '実績解除', '実績解除：{{achievement_name}}', '報酬を見る'),
-- new_device_login
(22, 'zh-CN', '新设备登录提醒', '您的账号在 {{device_name}} ({{location}}) 登录', '检查'),
(22, 'en-US', 'New Device Login', 'Your account logged in on {{device_name}} ({{location}})', 'Check'),
(22, 'ja-JP', '新しいデバイスログイン', '{{device_name}}（{{location}}）でログインしました', '確認');
```

### 4.2 NotificationLocalizer 服务

```javascript
// backend/shared/NotificationLocalizer.js
class NotificationLocalizer {
  constructor(dbPool, redisClient) {
    this.db = dbPool;
    this.redis = redisClient;
    this.templateCache = new Map();
    this.defaultLanguage = 'zh-CN';
    this.fallbackLanguage = 'en-US';
  }

  /**
   * 获取用户通知语言
   * @param {string} userId - 用户ID
   * @returns {string} 语言代码
   */
  async getUserNotificationLanguage(userId) {
    // 1. 检查缓存
    const cached = await this.redis.get(`notif_lang:${userId}`);
    if (cached) return cached;

    // 2. 查询数据库
    const { rows: [user] } = await this.db.query(
      'SELECT language_preference, language_source FROM users WHERE id = $1',
      [userId]
    );

    let language = this.defaultLanguage;
    let source = 'default';

    if (user?.language_preference) {
      language = user.language_preference;
      source = 'preference';
    }

    // 3. 缓存结果
    await this.redis.setex(`notif_lang:${userId}`, 3600, language);

    // 4. 更新缓存表
    await this.db.query(
      `INSERT INTO user_notification_language_cache (user_id, language, language_source)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET language = $2, language_source = $3, updated_at = NOW()`,
      [userId, language, source]
    );

    return language;
  }

  /**
   * 根据模板生成多语言通知
   * @param {string} templateKey - 模板键
   * @param {Object} variables - 变量值
   * @param {string} userId - 目标用户ID
   * @returns {Object} 本地化后的通知内容
   */
  async localizeNotification(templateKey, variables, userId) {
    const language = await this.getUserNotificationLanguage(userId);
    const template = await this.getTemplate(templateKey, language);

    if (!template) {
      // 回退到默认语言
      const fallbackTemplate = await this.getTemplate(templateKey, this.fallbackLanguage);
      if (!fallbackTemplate) {
        return this.generateDefaultNotification(templateKey, variables);
      }
      return this.fillTemplate(fallbackTemplate, variables);
    }

    return this.fillTemplate(template, variables);
  }

  /**
   * 获取模板（带缓存）
   */
  async getTemplate(templateKey, language) {
    const cacheKey = `${templateKey}:${language}`;

    // 1. 内存缓存
    if (this.templateCache.has(cacheKey)) {
      return this.templateCache.get(cacheKey);
    }

    // 2. Redis 缓存
    const redisCached = await this.redis.get(`template:${cacheKey}`);
    if (redisCached) {
      const parsed = JSON.parse(redisCached);
      this.templateCache.set(cacheKey, parsed);
      return parsed;
    }

    // 3. 数据库查询
    const { rows } = await this.db.query(`
      SELECT t.template_key, t.category, t.priority, t.variables,
             c.title_template, c.body_template, c.action_text, c.cultural_variant
      FROM notification_templates t
      JOIN notification_template_contents c ON t.id = c.template_id
      WHERE t.template_key = $1 AND c.language = $2
    `, [templateKey, language]);

    if (rows.length === 0) return null;

    const template = rows[0];
    this.templateCache.set(cacheKey, template);
    await this.redis.setex(`template:${cacheKey}`, 86400, JSON.stringify(template));

    return template;
  }

  /**
   * 填充模板变量
   */
  fillTemplate(template, variables) {
    let title = template.title_template;
    let body = template.body_template;
    let actionText = template.action_text || '查看';

    // 替换变量
    for (const [key, value] of Object.entries(variables)) {
      title = title.replace(new RegExp(`{{${key}}}`, 'g'), value);
      body = body.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }

    return {
      title,
      body,
      actionText,
      category: template.category,
      priority: template.priority
    };
  }

  /**
   * 批量本地化（支持不同语言的用户）
   */
  async batchLocalize(templateKey, variables, userIds) {
    // 获取所有用户的语言
    const languages = await Promise.all(
      userIds.map(userId => this.getUserNotificationLanguage(userId))
    );

    // 按语言分组
    const groupedByLanguage = {};
    userIds.forEach((userId, i) => {
      const lang = languages[i];
      if (!groupedByLanguage[lang]) groupedByLanguage[lang] = [];
      groupedByLanguage[lang].push(userId);
    });

    // 获取各语言模板
    const templates = {};
    for (const lang of Object.keys(groupedByLanguage)) {
      templates[lang] = await this.getTemplate(templateKey, lang);
    }

    // 生成本地化内容
    const results = {};
    for (const [lang, users] of Object.entries(groupedByLanguage)) {
      const template = templates[lang] || templates[this.fallbackLanguage];
      if (template) {
        results[lang] = {
          content: this.fillTemplate(template, variables),
          userIds: users
        };
      }
    }

    return results;
  }
}

module.exports = NotificationLocalizer;
```

### 4.3 集成到推送服务

```javascript
// backend/shared/pushNotificationService.js（扩展）

class PushNotificationService {
  constructor() {
    this.localizer = null;
    // ...existing code
  }

  setLocalizer(localizer) {
    this.localizer = localizer;
  }

  /**
   * 发送本地化推送通知
   * @param {Object} params - 推送参数
   * @returns {Promise<Object>}
   */
  async sendLocalizedPush(params) {
    const { userId, templateKey, variables, customTitle, customBody } = params;

    // 使用模板本地化（如果提供了模板键）
    if (templateKey && this.localizer) {
      const localized = await this.localizer.localizeNotification(
        templateKey,
        variables || {},
        userId
      );

      return this.sendPush({
        userId,
        type: localized.category,
        title: localized.title,
        body: localized.body,
        data: {
          templateKey,
          actionText: localized.actionText,
          ...variables
        },
        priority: localized.priority
      });
    }

    // 使用自定义标题/正文（仍需本地化）
    if (customTitle && this.localizer) {
      const language = await this.localizer.getUserNotificationLanguage(userId);
      // 从 i18n 获取翻译（如果提供了翻译映射）
      const title = params.titleMap?.[language] || customTitle;
      const body = params.bodyMap?.[language] || customBody;

      return this.sendPush({ userId, title, body, ...params });
    }

    // 默认发送
    return this.sendPush(params);
  }

  /**
   * 批量发送多语言推送
   */
  async sendBatchLocalizedPush(templateKey, variables, userIds) {
    if (!this.localizer) {
      // 无本地化，统一发送
      return Promise.all(userIds.map(userId => this.sendPush({ userId, templateKey, variables })));
    }

    const grouped = await this.localizer.batchLocalize(templateKey, variables, userIds);

    const results = [];
    for (const [lang, data] of Object.entries(grouped)) {
      const pushResults = await Promise.all(
        data.userIds.map(userId =>
          this.sendPush({
            userId,
            title: data.content.title,
            body: data.content.body,
            data: {
              templateKey,
              actionText: data.content.actionText,
              language: lang,
              ...variables
            }
          })
        )
      );
      results.push(...pushResults);
    }

    return results;
  }
}
```

### 4.4 API 设计

```
GET /api/v1/notification/templates
  - 功能：获取所有通知模板
  - 响应：{ templates: [{ key, category, languages: [...] }] }

GET /api/v1/notification/templates/:templateKey
  - 功能：获取模板详情（含各语言版本）
  - 响应：{ templateKey, category, contents: { zh-CN: {...}, en-US: {...}, ja-JP: {...} } }

POST /api/admin/notification/templates
  - 功能：创建新模板（需 admin 权限）
  - 请求体：{ templateKey, category, priority, contents: { zh-CN: {...}, ... } }
  - 响应：{ success, templateId }

PUT /api/admin/notification/templates/:templateKey
  - 功能：更新模板内容
  - 请求体：{ contents: { zh-CN: {...}, ... } }
  - 响应：{ success }

POST /api/v1/notification/send-localized
  - 功能：发送本地化推送（内部接口）
  - 请求体：{ userIds, templateKey, variables }
  - 响应：{ sentCount, byLanguage: { zh-CN: 10, en-US: 5 } }

GET /api/v1/notification/user-language/:userId
  - 功能：获取用户通知语言
  - 响应：{ language, source }
```

### 4.5 Admin Dashboard 管理界面

新增通知模板管理页面：
- **模板列表**：按类别筛选，显示各语言状态
- **模板编辑器**：可视化编辑三种语言版本
- **变量预览**：填写变量值实时预览效果
- **批量翻译**：一键生成机器翻译（待人工校验）
- **推送测试**：向测试用户发送预览推送

## 5. 验收标准（可测试）

- [ ] 数据库表创建成功：`notification_templates`、`notification_template_contents`、`user_notification_language_cache`
- [ ] 预置 50+ 常用通知模板，覆盖 5 大类别（社交、活动、系统、奖励、安全）
- [ ] 三种语言版本完整：zh-CN、en-US、ja-JP
- [ ] `NotificationLocalizer.localizeNotification()` 能根据用户语言生成正确内容
- [ ] 语言回退机制生效：用户语言无翻译时自动回退到英文或默认语言
- [ ] 推送服务集成完成：`sendLocalizedPush()` 正确发送多语言推送
- [ ] 批量推送正确分组：不同语言用户收到对应语言推送
- [ ] API 端点已实现：5 个管理接口
- [ ] Admin Dashboard 模板管理界面可用
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 国际用户推送打开率提升至 40%+

## 6. 工作量估算

**M（Medium）** - 预计 1-2 天

理由：
- 数据库设计相对简单（3 张表）
- 核心服务逻辑清晰（模板读取 + 变量填充）
- 与现有推送服务集成工作量适中
- 预置模板需要翻译工作（50+ 条 × 3 语言）

## 7. 优先级理由

**P1** - 高优先级

理由：
1. **国际化必需**：推送通知是用户触达关键渠道，必须支持多语言
2. **用户体验影响**：国际用户收到无法理解的推送，严重影响留存
3. **运营效率**：模板化推送大幅降低运营翻译成本
4. **技术可行性强**：基于现有推送服务扩展，工作量可控
5. **成熟度提升**：完成后"国际化/本地化"维度评分提升

此需求是全球化运营的基础设施，应在正式国际化推广前完成。