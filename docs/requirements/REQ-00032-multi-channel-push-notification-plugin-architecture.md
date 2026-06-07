# REQ-00032：多渠道推送通知插件架构

- **编号**：REQ-00032
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：reward-service、user-service、backend/shared/notification、gateway
- **创建时间**：2026-06-07 00:00
- **依赖需求**：REQ-00026（游戏内实时推送通知系统）

## 1. 背景与问题

当前项目已实现游戏内实时推送通知系统（REQ-00026），通过 WebSocket 实现游戏客户端的实时通知。但在生产环境中，还存在以下缺口：

1. **推送渠道单一**：仅支持游戏内 WebSocket 推送，用户离线时无法触达
2. **硬编码实现**：推送逻辑与业务代码耦合，难以扩展新渠道（如 FCM、APNs、邮件、短信）
3. **缺乏抽象层**：没有统一的推送接口抽象，不同渠道的接入成本高
4. **配置管理缺失**：推送渠道配置分散在代码中，无法动态调整

用户离线时，系统无法通过 FCM/APNs 触达用户，导致道馆邀请、好友请求等重要事件错失，影响用户留存率。

## 2. 目标

建立多渠道推送通知插件架构，实现：

- 统一的推送接口抽象，支持多种推送渠道的插件化扩展
- 首期实现 FCM（Firebase Cloud Messaging）和 APNs（Apple Push Notification service）渠道
- 支持用户推送偏好配置（按通知类型、时间段选择渠道）
- 离线推送与在线推送的智能切换
- 推送失败重试与降级策略
- 预期离线用户触达率提升至 85%+，用户留存率提升 15%

## 3. 范围

- **包含**：
  - 推送插件架构设计（Plugin 接口、适配器模式）
  - FCM 推送适配器实现
  - APNs 推送适配器实现
  - 用户推送偏好管理（数据库表、API）
  - 推送渠道选择策略（在线/离线判断、偏好优先级）
  - 推送失败重试与降级机制
  - 推送日志与追踪
  - 单元测试覆盖

- **不包含**：
  - 短信、邮件等其他推送渠道（留作后续扩展）
  - 推送内容个性化推荐引擎
  - 推送 A/B 测试平台
  - 移动端 SDK 集成（需客户端配合）

## 4. 详细需求

### 4.1 推送插件架构

```javascript
// backend/shared/notification/PluginInterface.js
class NotificationPlugin {
  /**
   * @param {string} userId - 用户ID
   * @param {Object} payload - 推送内容 { title, body, data, type }
   * @param {Object} options - 渠道特定选项 { ttl, priority }
   * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
   */
  async send(userId, payload, options) {
    throw new Error('Plugin must implement send()');
  }

  /**
   * @returns {string[]} 支持的平台列表，如 ['ios', 'android', 'web']
   */
  getSupportedPlatforms() {
    throw new Error('Plugin must implement getSupportedPlatforms()');
  }

  /**
   * @returns {string} 插件名称，如 'fcm', 'apns', 'websocket'
   */
  getName() {
    throw new Error('Plugin must implement getName()');
  }

  /**
   * 检查该用户是否启用此渠道
   * @param {string} userId 
   * @returns {Promise<boolean>}
   */
  async isEnabledForUser(userId) {
    throw new Error('Plugin must implement isEnabledForUser()');
  }
}
```

### 4.2 FCM 适配器

```javascript
// backend/shared/notification/plugins/FCMPlugin.js
const admin = require('firebase-admin');

class FCMPlugin extends NotificationPlugin {
  constructor(config) {
    super();
    this.app = admin.initializeApp({
      credential: admin.credential.cert(config.serviceAccount),
    }, 'mineGo-fcm');
  }

  async send(userId, payload, options = {}) {
    // 1. 查询用户的 FCM device token
    const token = await this.getUserDeviceToken(userId);
    if (!token) return { success: false, error: 'No FCM token' };

    // 2. 构造 FCM 消息
    const message = {
      token,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data || {},
      android: {
        ttl: options.ttl || 86400000, // 1 day
        priority: options.priority || 'high',
      },
      apns: {
        payload: {
          aps: { 'content-available': 1 },
        },
      },
    };

    // 3. 发送推送
    try {
      const response = await this.app.messaging().send(message);
      return { success: true, messageId: response };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  getSupportedPlatforms() {
    return ['android', 'ios', 'web'];
  }

  getName() {
    return 'fcm';
  }
}
```

### 4.3 APNs 适配器

```javascript
// backend/shared/notification/plugins/APNsPlugin.js
const apn = require('apn');

class APNsPlugin extends NotificationPlugin {
  constructor(config) {
    super();
    this.provider = new apn.Provider({
      token: {
        key: config.keyPath,
        keyId: config.keyId,
        teamId: config.teamId,
      },
      production: config.production,
    });
  }

  async send(userId, payload, options = {}) {
    const deviceToken = await this.getUserDeviceToken(userId);
    if (!deviceToken) return { success: false, error: 'No APNs token' };

    const notification = new apn.Notification({
      alert: { title: payload.title, body: payload.body },
      payload: payload.data || {},
      topic: 'com.mineGo.app',
      expiry: options.ttl || Math.floor(Date.now() / 1000) + 86400,
      priority: options.priority === 'high' ? 10 : 5,
    });

    try {
      const result = await this.provider.send(notification, deviceToken);
      return { success: result.sent.length > 0, messageId: result.sent[0] };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  getSupportedPlatforms() {
    return ['ios'];
  }

  getName() {
    return 'apns';
  }
}
```

### 4.4 推送管理器

```javascript
// backend/shared/notification/NotificationManager.js
class NotificationManager {
  constructor() {
    this.plugins = new Map(); // name -> plugin instance
  }

  registerPlugin(plugin) {
    this.plugins.set(plugin.getName(), plugin);
  }

  /**
   * 智能推送：根据用户状态和偏好选择渠道
   */
  async send(userId, payload, options = {}) {
    // 1. 检查用户是否在线（WebSocket 连接）
    const isOnline = await this.checkUserOnline(userId);
    
    if (isOnline && this.plugins.has('websocket')) {
      // 在线用户优先使用 WebSocket
      return await this.plugins.get('websocket').send(userId, payload, options);
    }

    // 2. 离线用户：查询用户推送偏好
    const preferences = await this.getUserPreferences(userId);
    
    // 3. 按优先级尝试推送渠道
    for (const channel of preferences.channels) {
      if (this.plugins.has(channel)) {
        const plugin = this.plugins.get(channel);
        if (await plugin.isEnabledForUser(userId)) {
          const result = await plugin.send(userId, payload, options);
          if (result.success) {
            await this.logPush(userId, channel, payload, result);
            return result;
          }
        }
      }
    }

    // 4. 所有渠道失败，记录失败日志
    await this.logPushFailure(userId, payload);
    return { success: false, error: 'All channels failed' };
  }
}
```

### 4.5 数据库迁移

```sql
-- database/migrations/20260607_000000__add_push_notification_preferences.sql

-- 用户推送偏好表
CREATE TABLE user_push_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token TEXT,
  apns_token TEXT,
  preferred_channels TEXT[] NOT NULL DEFAULT ARRAY['websocket', 'fcm', 'apns'],
  notification_types JSONB NOT NULL DEFAULT '{
    "gym_raid": true,
    "friend_request": true,
    "trade_request": true,
    "reward": true,
    "system": true
  }',
  quiet_hours JSONB DEFAULT '{"enabled": false, "start": "22:00", "end": "08:00"}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

-- 推送日志表
CREATE TABLE push_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  channel VARCHAR(20) NOT NULL,
  notification_type VARCHAR(50) NOT NULL,
  title TEXT,
  body TEXT,
  payload JSONB,
  success BOOLEAN NOT NULL,
  message_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_push_logs_user_created ON push_logs(user_id, created_at DESC);
CREATE INDEX idx_push_logs_channel ON push_logs(channel, created_at);
```

### 4.6 API 接口

```
POST /api/notifications/preferences
  - 更新用户推送偏好
  - Body: { fcmToken?, apnsToken?, preferredChannels?, notificationTypes?, quietHours? }

GET /api/notifications/preferences
  - 获取用户推送偏好

POST /api/notifications/device-token
  - 注册设备推送 Token
  - Body: { platform: 'ios'|'android', token: string }

DELETE /api/notifications/device-token
  - 注销设备推送 Token（用户登出时调用）
```

## 5. 验收标准（可测试）

- [ ] NotificationPlugin 接口定义清晰，包含 send/getSupportedPlatforms/getName/isEnabledForUser 方法
- [ ] FCMPlugin 实现完整，支持 Android/iOS/Web 三个平台推送
- [ ] APNsPlugin 实现完整，支持 iOS 设备推送
- [ ] NotificationManager 支持多插件注册和智能渠道选择
- [ ] 用户在线时优先使用 WebSocket 推送，离线时使用 FCM/APNs
- [ ] 用户推送偏好可在 API 中设置和查询
- [ ] 推送失败时自动降级到下一个可用渠道
- [ ] 推送日志记录完整，包含渠道、状态、消息ID、错误信息
- [ ] 单元测试覆盖率 ≥ 80%，包含插件适配器、管理器、渠道选择策略
- [ ] 静默时段（Quiet Hours）配置生效，该时段暂停推送

## 6. 工作量估算

**L（Large）**

- 插件架构设计与实现：2-3 天
- FCM/APNs 适配器实现：2-3 天
- 数据库迁移与 API 接口：1 天
- 推送管理器与渠道选择策略：2 天
- 测试与集成：2 天
- **总计：9-11 天**

## 7. 优先级理由

**P1（高优先级）**

1. **核心体验影响**：离线推送是移动端应用的核心功能，直接影响用户留存率和活跃度
2. **架构基础**：插件架构为后续扩展（短信、邮件、Web Push）奠定基础
3. **依赖关系**：REQ-00026 已实现游戏内推送，本需求是其自然延伸
4. **生产必需**：FCM/APNs 是移动应用的标配能力，缺失会导致重要通知无法触达
5. **可扩展价值**：插件化设计降低未来渠道接入成本，符合"可扩展性/解耦"目标
