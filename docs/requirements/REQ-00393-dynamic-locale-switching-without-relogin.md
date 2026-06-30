# REQ-00393：动态语言切换无需重新登录系统

- **编号**：REQ-00393
- **类别**：国际化/本地化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、game-client、shared/i18n
- **创建时间**：2026-06-30 19:00 UTC
- **依赖需求**：REQ-00101（后端 API 错误消息国际化）、REQ-00294（动态本地化系统）

## 1. 背景与问题

mineGo 当前支持中/英/日三种语言，但语言切换存在以下问题：

### 1.1 切换需要重新登录
- 用户更改语言设置后，必须重新登录才能生效
- 重新登录导致会话丢失，游戏状态中断
- 影响用户体验，特别是在游戏中途切换场景

### 1.2 部分内容未实时更新
- 错误消息、提示文本仍显示旧语言
- 服务端推送的通知未按新语言发送
- WebSocket 实时消息未同步语言切换

### 1.3 语言偏好存储分散
- 用户语言偏好存储在多个位置（user-service、session、客户端 localStorage）
- 缺乏统一的语言偏好管理机制
- 语言一致性难以保证

### 1.4 缺乏语言切换事件通知
- 微服务间无法感知用户语言变更
- 实时推送服务（gym-service、social-service）无法及时调整语言
- 导致多语言场景下消息错乱

## 2. 目标

实现动态语言切换系统，允许用户在游戏运行中切换语言，无需重新登录：

1. **实时切换生效**：切换后立即生效，所有 UI、消息、推送同步更新
2. **会话持续**：保持登录状态和游戏进度不受影响
3. **统一语言管理**：集中管理用户语言偏好，确保一致性
4. **跨服务同步**：通过 Kafka 事件通知所有服务语言变更
5. **WebSocket 语言同步**：实时推送消息按新语言发送

**预期收益：**
- 用户切换语言体验提升，无需中断游戏
- 多语言用户体验满意度提升 25%
- 减少因语言问题导致的用户流失

## 3. 背景与范围

- **包含**：
  - 语言切换 API（无需重新登录）
  - 语言偏好集中管理
  - Kafka 语言变更事件
  - WebSocket 语言同步机制
  - 前端实时 UI 更新
  - 服务端推送语言适配

- **不包含**：
  - 新语言添加（见 REQ-00294）
  - 翻译内容管理（见 REQ-00294）
  - 翻译缺失检测（见 REQ-00370）

## 4. 详细需求

### 4.1 语言切换 API

**端点**：`PUT /api/user/language`

```javascript
// gateway/src/routes/language.js
router.put('/language', authMiddleware, async (req, res) => {
  const { language } = req.body; // 'zh' | 'en' | 'ja'
  const userId = req.user.id;
  
  // 验证语言有效性
  const validLanguages = ['zh', 'en', 'ja'];
  if (!validLanguages.includes(language)) {
    return res.status(400).json({ 
      error: 'Invalid language',
      code: 'INVALID_LANGUAGE'
    });
  }
  
  // 更新用户语言偏好
  await userService.updateLanguage(userId, language);
  
  // 发布语言变更事件
  await kafkaProducer.send({
    topic: 'user-language-changed',
    messages: [{
      key: userId,
      value: JSON.stringify({ userId, language, timestamp: Date.now() })
    }]
  });
  
  // 返回新语言的欢迎消息
  const welcomeMessages = {
    zh: '语言已切换为中文',
    en: 'Language switched to English',
    ja: '言語が日本語に切り替わりました'
  };
  
  res.json({
    success: true,
    language,
    message: welcomeMessages[language]
  });
});
```

### 4.2 语言偏好集中管理

**user-service 语言管理服务**：

```javascript
// user-service/src/languageService.js
class LanguageService {
  constructor() {
    this.cachePrefix = 'user:lang:';
    this.cacheTTL = 3600; // 1小时
  }
  
  /**
   * 更新用户语言偏好
   */
  async updateLanguage(userId, language) {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 更新数据库
      await client.query(
        `UPDATE users SET language = $1, language_updated_at = NOW() WHERE id = $2`,
        [language, userId]
      );
      
      // 更新 Redis 缓存
      await redis.set(`${this.cachePrefix}${userId}`, language, 'EX', this.cacheTTL);
      
      // 更新会话中的语言
      await this.updateSessionLanguage(userId, language);
      
      await client.query('COMMIT');
      
      logger.info('用户语言已更新', { userId, language });
      
      return { success: true, language };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  /**
   * 获取用户当前语言（优先从缓存）
   */
  async getLanguage(userId) {
    // 先查缓存
    const cached = await redis.get(`${this.cachePrefix}${userId}`);
    if (cached) return cached;
    
    // 查数据库
    const result = await db.query(
      `SELECT language FROM users WHERE id = $1`,
      [userId]
    );
    
    const language = result.rows[0]?.language || 'en'; // 默认英文
    
    // 写入缓存
    await redis.set(`${this.cachePrefix}${userId}`, language, 'EX', this.cacheTTL);
    
    return language;
  }
  
  /**
   * 更新会话语言
   */
  async updateSessionLanguage(userId, language) {
    // 通过 Redis 更新所有活跃会话
    const sessions = await redis.keys(`session:*:${userId}`);
    
    for (const sessionKey of sessions) {
      const sessionData = await redis.get(sessionKey);
      if (sessionData) {
        const session = JSON.parse(sessionData);
        session.language = language;
        await redis.set(sessionKey, JSON.stringify(session), 'EX', session.ttl);
      }
    }
  }
}

module.exports = new LanguageService();
```

### 4.3 Kafka 语言变更事件

**事件结构**：

```json
{
  "eventType": "user-language-changed",
  "userId": "uuid",
  "language": "zh",
  "timestamp": 1719788400000,
  "previousLanguage": "en"
}
```

**消费者订阅**（各服务）：

```javascript
// shared/src/languageChangeListener.js
async function subscribeLanguageChange(serviceName) {
  await kafkaConsumer.subscribe({
    topic: 'user-language-changed',
    fromBeginning: false
  });
  
  await kafkaConsumer.run({
    eachMessage: async ({ message }) => {
      const event = JSON.parse(message.value);
      
      logger.info(`[${serviceName}] 收到语言变更事件`, event);
      
      // 更新本地缓存
      await redis.set(`user:lang:${event.userId}`, event.language, 'EX', 3600);
      
      // 服务特定处理
      await handleLanguageChange(serviceName, event);
    }
  });
}

async function handleLanguageChange(serviceName, event) {
  switch (serviceName) {
    case 'gym-service':
      // 更新 WebSocket 连接语言
      await gymService.updateConnectionLanguage(event.userId, event.language);
      break;
    case 'social-service':
      // 更新聊天消息语言
      await socialService.updateChatLanguage(event.userId, event.language);
      break;
    case 'reward-service':
      // 更新推送通知语言
      await rewardService.updateNotificationLanguage(event.userId, event.language);
      break;
  }
}
```

### 4.4 WebSocket 语言同步

**gym-service 实时战斗语言适配**：

```javascript
// gym-service/src/websocketLanguageHandler.js
class WebSocketLanguageHandler {
  constructor() {
    this.connections = new Map(); // userId -> { ws, language }
  }
  
  /**
   * 更新连接语言
   */
  async updateConnectionLanguage(userId, language) {
    const connection = this.connections.get(userId);
    if (connection) {
      connection.language = language;
      
      // 发送语言确认消息
      connection.ws.send(JSON.stringify({
        type: 'language-updated',
        language,
        message: this.getLocalizedMessage(language, 'language_switched')
      }));
      
      logger.info('WebSocket 语言已更新', { userId, language });
    }
  }
  
  /**
   * 发送本地化消息
   */
  sendLocalizedMessage(userId, messageType, data) {
    const connection = this.connections.get(userId);
    if (!connection) return;
    
    const language = connection.language || 'en';
    const localizedData = this.localizeData(data, language);
    
    connection.ws.send(JSON.stringify({
      type: messageType,
      ...localizedData,
      language
    }));
  }
  
  /**
   * 本地化数据
   */
  localizeData(data, language) {
    if (data.message) {
      data.message = i18n.translate(data.message, language);
    }
    if (data.description) {
      data.description = i18n.translate(data.description, language);
    }
    return data;
  }
}

module.exports = new WebSocketLanguageHandler();
```

### 4.5 前端实时 UI 更新

**game-client 语言切换组件**：

```javascript
// game-client/src/language/LanguageSwitcher.js
class LanguageSwitcher {
  constructor(apiClient) {
    this.api = apiClient;
    this.currentLanguage = 'en';
    this.listeners = [];
  }
  
  /**
   * 切换语言
   */
  async switchLanguage(language) {
    try {
      const response = await this.api.put('/user/language', { language });
      
      if (response.success) {
        this.currentLanguage = language;
        
        // 更新 localStorage
        localStorage.setItem('language', language);
        
        // 更新 i18n 配置
        i18n.setLocale(language);
        
        // 触发 UI 更新
        this.notifyListeners(language);
        
        // 刷新页面内容
        await this.refreshUIContent();
        
        // 显示切换成功通知
        this.showNotification(response.message);
      }
      
      return response;
      
    } catch (error) {
      console.error('切换语言失败', error);
      this.showError('语言切换失败，请稍后重试');
    }
  }
  
  /**
   * 注册语言变更监听器
   */
  addListener(callback) {
    this.listeners.push(callback);
  }
  
  /**
   * 通知所有监听器
   */
  notifyListeners(language) {
    for (const callback of this.listeners) {
      callback(language);
    }
  }
  
  /**
   * 刷新 UI 内容
   */
  async refreshUIContent() {
    // 更新所有带有 data-i18n 属性的元素
    const elements = document.querySelectorAll('[data-i18n]');
    
    for (const element of elements) {
      const key = element.getAttribute('data-i18n');
      element.textContent = i18n.translate(key);
    }
    
    // 更新所有带有 data-i18n-placeholder 属性的元素
    const placeholders = document.querySelectorAll('[data-i18n-placeholder]');
    
    for (const element of placeholders) {
      const key = element.getAttribute('data-i18n-placeholder');
      element.placeholder = i18n.translate(key);
    }
    
    // 更新页面标题
    document.title = i18n.translate('page_title');
  }
  
  /**
   * WebSocket 语言同步监听
   */
  setupWebSocketLanguageSync(ws) {
    ws.on('language-updated', (data) => {
      this.currentLanguage = data.language;
      i18n.setLocale(data.language);
      this.refreshUIContent();
    });
  }
}

module.exports = LanguageSwitcher;
```

## 5. 验收标准（可测试）

- [ ] `PUT /api/user/language` API 可用，返回成功响应
- [ ] 切换语言后，用户会话保持有效，无需重新登录
- [ ] 用户语言偏好存储在数据库 users.language 字段
- [ ] 语言偏好缓存在 Redis，缓存键格式为 `user:lang:{userId}`
- [ ] Kafka 事件 `user-language-changed` 正常发布
- [ ] gym-service WebSocket 连接能收到语言变更通知
- [ ] social-service 聊天消息按新语言发送
- [ ] reward-service 推送通知按新语言显示
- [ ] 前端 UI 所有 `data-i18n` 元素实时更新
- [ ] localStorage 存储新语言值
- [ ] 单元测试覆盖率 > 80%
- [ ] API 文档完整更新

## 6. 工作量估算

**M**（中等）：约 3-4 天

- 语言切换 API：1 天
- 语言服务 + Kafka 事件：1 天
- WebSocket 同步：1 天
- 前端 UI 更新：1 天

## 7. 优先级理由

P1 优先级理由：
- 直接影响用户体验，是国际化功能的关键补充
- 解决当前切换语言需重新登录的核心痛点
- 与 REQ-00294（动态本地化系统）配合，完善国际化能力
- 实现难度适中，收益明确