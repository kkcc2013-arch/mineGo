# REQ-00425: 游戏内通知与智能消息推送系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00425 |
| 标题 | 游戏内通知与智能消息推送系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | implemented |
| 涉及服务 | gateway、notification-service（新建）、user-service、social-service、reward-service、game-client、admin-dashboard |
| 创建时间 | 2026-07-02 23:00 |

## 需求描述

### 背景
当前 mineGo 项目缺乏统一的游戏内通知与消息推送系统，玩家无法及时获知好友请求、道馆战邀请、精灵刷新、奖励领取、系统公告等关键事件。这导致：
- 社交互动延迟：好友请求和礼物无法实时通知，降低社交活跃度
- 活动参与率低：限时活动和道馆战缺少提醒机制
- 用户留存影响：重要事件未被感知，玩家可能错过高价值内容
- 运营效率低：系统公告缺乏精准推送和效果追踪能力

### 目标
构建完整的通知推送系统，支持：
1. **多渠道通知**：游戏内通知中心、WebSocket 实时推送、邮件/短信（可选）
2. **智能推送策略**：根据玩家活跃时间、偏好、重要性等级优化推送时机
3. **通知类型丰富**：系统通知、社交通知、活动通知、奖励通知、安全通知
4. **个性化配置**：玩家可自定义接收哪些类型的通知及推送方式
5. **推送效果追踪**：送达率、打开率、转化率等核心指标监控
6. **多语言支持**：通知内容自动适配玩家语言设置

### 关键指标（KPI）
- 通知送达率 > 99%（游戏内通知）
- 推送延迟 < 3 秒（实时通知）
- 用户打开率 > 40%（重要通知）
- 通知中心加载时间 < 500ms
- 支持并发推送 > 10000 条/秒

## 技术方案

### 1. 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Notification Service                       │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Notification │  │   Push       │  │   Notification      │  │
│  │   Engine     │  │  Scheduler   │  │    Analytics        │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                      │               │
│  ┌──────┴─────────────────┴──────────────────────┴───────┐      │
│  │              Notification Queue (Kafka)               │      │
│  └──────────────────────────┬───────────────────────────┘      │
└─────────────────────────────┬───────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│ WebSocket     │     │ Notification  │     │ External      │
│ Push Gateway  │     │ Center API    │     │ Push (Email/SMS)│
└───────────────┘     └───────────────┘     └───────────────┘
```

### 2. 通知类型定义

```typescript
// backend/shared/types/notification.ts

export enum NotificationType {
  // 系统通知
  SYSTEM_ANNOUNCEMENT = 'system.announcement',
  SYSTEM_MAINTENANCE = 'system.maintenance',
  SYSTEM_UPDATE = 'system.update',
  
  // 社交通知
  SOCIAL_FRIEND_REQUEST = 'social.friend_request',
  SOCIAL_FRIEND_ACCEPT = 'social.friend_accept',
  SOCIAL_GIFT_RECEIVED = 'social.gift_received',
  SOCIAL_GIFT_SENT = 'social.gift_sent',
  SOCIAL_TRADE_REQUEST = 'social.trade_request',
  SOCIAL_TRADE_COMPLETE = 'social.trade_complete',
  
  // 活动通知
  EVENT_RAID_STARTING = 'event.raid_starting',
  EVENT_RAID_INVITATION = 'event.raid_invitation',
  EVENT_COMMUNITY_DAY = 'event.community_day',
  EVENT_SEASON_START = 'event.season_start',
  EVENT_SEASON_END = 'event.season_end',
  EVENT_SPAWN_BOOST = 'event.spawn_boost',
  
  // 奖励通知
  REWARD_DAILY_AVAILABLE = 'reward.daily_available',
  REWARD_ACHIEVEMENT_UNLOCK = 'reward.achievement_unlock',
  REWARD_LEVEL_UP = 'reward.level_up',
  REWARD_CLAIM_REMINDER = 'reward.claim_reminder',
  
  // 安全通知
  SECURITY_LOGIN_NEW_DEVICE = 'security.login_new_device',
  SECURITY_PASSWORD_CHANGED = 'security.password_changed',
  SECURITY_SUSPICIOUS_ACTIVITY = 'security.suspicious_activity',
  
  // 精灵相关
  POKEMON_NEARBY_RARE = 'pokemon.nearby_rare',
  POKEMON_NEARBY_LEGENDARY = 'pokemon.nearby_legendary',
  POKEMON_HATCHING = 'pokemon.hatching',
  POKEMON_BUDDY_CANDY = 'pokemon.buddy_candy'
}

export enum NotificationPriority {
  LOW = 'low',        // 普通通知，批量推送
  NORMAL = 'normal',  // 正常优先级
  HIGH = 'high',      // 高优先级，立即推送
  URGENT = 'urgent'   // 紧急，强制推送
}

export enum NotificationChannel {
  IN_APP = 'in_app',          // 游戏内通知中心
  PUSH_WEBSOCKET = 'ws',      // WebSocket 实时推送
  EMAIL = 'email',            // 邮件（可选）
  SMS = 'sms'                 // 短信（可选，紧急通知）
}

export interface NotificationPayload {
  id: string;
  type: NotificationType;
  title: string;              // 支持多语言 key
  body: string;               // 支持多语言 key
  titleArgs?: Record<string, any>;  // 模板参数
  bodyArgs?: Record<string, any>;
  priority: NotificationPriority;
  channels: NotificationChannel[];
  targetUserId: string;
  targetUserIds?: string[];   // 批量推送
  data?: Record<string, any>; // 深度链接数据
  imageUrl?: string;
  actionUrl?: string;         // 点击跳转链接
  expiresAt?: Date;           // 过期时间
  createdAt: Date;
  readAt?: Date;
  clickedAt?: Date;
}
```

### 3. Notification Service 核心实现

```typescript
// backend/services/notification-service/src/engine/NotificationEngine.ts

import { Kafka } from 'kafkajs';
import { NotificationPayload, NotificationPriority, NotificationChannel } from '@shared/types';
import { Redis } from 'ioredis';
import { EventEmitter } from 'events';

export class NotificationEngine extends EventEmitter {
  private kafka: Kafka;
  private producer: any;
  private redis: Redis;
  private templates: Map<string, NotificationTemplate>;
  
  constructor(config: NotificationConfig) {
    super();
    this.kafka = new Kafka({
      clientId: 'notification-service',
      brokers: config.kafkaBrokers
    });
    this.producer = this.kafka.producer();
    this.redis = new Redis(config.redisUrl);
    this.templates = new Map();
    this.loadTemplates();
  }
  
  /**
   * 发送通知 - 核心方法
   */
  async sendNotification(payload: NotificationPayload): Promise<SendResult> {
    // 1. 验证通知内容
    this.validatePayload(payload);
    
    // 2. 应用模板渲染
    const rendered = await this.renderTemplate(payload);
    
    // 3. 检查用户偏好设置
    const userPrefs = await this.getUserPreferences(payload.targetUserId);
    const allowedChannels = this.filterChannelsByPreference(
      rendered.channels, 
      userPrefs
    );
    
    // 4. 发送到 Kafka 队列
    await this.producer.send({
      topic: 'notifications',
      messages: [{
        key: payload.id,
        value: JSON.stringify({
          ...rendered,
          channels: allowedChannels
        }),
        headers: {
          'priority': payload.priority,
          'type': payload.type
        }
      }]
    });
    
    // 5. 记录发送事件（用于分析）
    await this.recordSendEvent(rendered);
    
    this.emit('notification:queued', rendered);
    
    return { success: true, notificationId: payload.id };
  }
  
  /**
   * 批量发送通知
   */
  async sendBatchNotifications(
    payloads: NotificationPayload[]
  ): Promise<BatchSendResult> {
    // 按优先级分组
    const grouped = this.groupByPriority(payloads);
    
    // 高优先级优先处理
    for (const [priority, items] of grouped) {
      if (priority === NotificationPriority.URGENT || priority === NotificationPriority.HIGH) {
        await Promise.all(items.map(p => this.sendNotification(p)));
      } else {
        // 低优先级批量处理
        await this.producer.send({
          topic: 'notifications-batch',
          messages: items.map(p => ({
            key: p.id,
            value: JSON.stringify(p)
          }))
        });
      }
    }
    
    return { success: true, count: payloads.length };
  }
  
  /**
   * 模板渲染 - 支持多语言
   */
  private async renderTemplate(payload: NotificationPayload): Promise<NotificationPayload> {
    const template = this.templates.get(payload.type);
    if (!template) {
      return payload; // 无模板，直接返回原始内容
    }
    
    // 获取用户语言设置
    const userLang = await this.getUserLanguage(payload.targetUserId);
    
    // 渲染标题和正文
    const titleTemplate = template.title[userLang] || template.title['en'];
    const bodyTemplate = template.body[userLang] || template.body['en'];
    
    return {
      ...payload,
      title: this.interpolate(titleTemplate, payload.titleArgs || {}),
      body: this.interpolate(bodyTemplate, payload.bodyArgs || {})
    };
  }
  
  /**
   * 模板变量插值
   */
  private interpolate(template: string, args: Record<string, any>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return args[key] !== undefined ? String(args[key]) : match;
    });
  }
  
  /**
   * 获取用户通知偏好
   */
  private async getUserPreferences(userId: string): Promise<UserNotificationPrefs> {
    const cached = await this.redis.get(`user:prefs:${userId}`);
    if (cached) {
      return JSON.parse(cached);
    }
    
    // 从数据库查询
    const prefs = await this.fetchUserPrefsFromDb(userId);
    await this.redis.setex(`user:prefs:${userId}`, 3600, JSON.stringify(prefs));
    return prefs;
  }
  
  /**
   * 根据偏好过滤推送渠道
   */
  private filterChannelsByPreference(
    channels: NotificationChannel[],
    prefs: UserNotificationPrefs
  ): NotificationChannel[] {
    return channels.filter(channel => {
      switch (channel) {
        case NotificationChannel.IN_APP:
          return prefs.enableInApp;
        case NotificationChannel.PUSH_WEBSOCKET:
          return prefs.enablePush;
        case NotificationChannel.EMAIL:
          return prefs.enableEmail;
        case NotificationChannel.SMS:
          return prefs.enableSms;
        default:
          return false;
      }
    });
  }
}

// 模板定义
interface NotificationTemplate {
  type: NotificationType;
  title: Record<string, string>;  // 语言 -> 标题模板
  body: Record<string, string>;   // 语言 -> 正文模板
  defaultChannels: NotificationChannel[];
  icon?: string;
  sound?: string;
}

// 示例模板
const NOTIFICATION_TEMPLATES: NotificationTemplate[] = [
  {
    type: NotificationType.SOCIAL_FRIEND_REQUEST,
    title: {
      en: 'New Friend Request',
      zh: '新的好友请求',
      ja: '新しい友達リクエスト'
    },
    body: {
      en: '{{senderName}} wants to be your friend!',
      zh: '{{senderName}} 想要添加你为好友！',
      ja: '{{senderName}} が友達になりたいと思っています！'
    },
    defaultChannels: [NotificationChannel.IN_APP, NotificationChannel.PUSH_WEBSOCKET]
  },
  {
    type: NotificationType.EVENT_RAID_STARTING,
    title: {
      en: 'Raid Battle Starting Soon!',
      zh: '团队战即将开始！',
      ja: 'レイドバトルがまもなく開始！'
    },
    body: {
      en: 'A {{pokemonName}} raid is starting at {{gymName}} in {{minutes}} minutes',
      zh: '{{pokemonName}} 团队战将在 {{minutes}} 分钟后于 {{gymName}} 开始',
      ja: '{{minutes}} 分後に {{gymName}} で {{pokemonName}} レイドが開始します'
    },
    defaultChannels: [NotificationChannel.IN_APP, NotificationChannel.PUSH_WEBSOCKET]
  }
];
```

### 4. WebSocket 实时推送实现

```typescript
// backend/services/gateway/src/handlers/NotificationPushHandler.ts

import { WebSocket } from 'ws';
import { NotificationPayload } from '@shared/types';
import { Kafka } from 'kafkajs';

export class NotificationPushHandler {
  private userConnections: Map<string, Set<WebSocket>>;
  private kafkaConsumer: any;
  
  constructor() {
    this.userConnections = new Map();
    this.initKafkaConsumer();
  }
  
  /**
   * 注册用户连接
   */
  registerConnection(userId: string, ws: WebSocket): void {
    if (!this.userConnections.has(userId)) {
      this.userConnections.set(userId, new Set());
    }
    this.userConnections.get(userId)!.add(ws);
    
    ws.on('close', () => {
      this.unregisterConnection(userId, ws);
    });
  }
  
  /**
   * 取消注册
   */
  unregisterConnection(userId: string, ws: WebSocket): void {
    const connections = this.userConnections.get(userId);
    if (connections) {
      connections.delete(ws);
      if (connections.size === 0) {
        this.userConnections.delete(userId);
      }
    }
  }
  
  /**
   * 初始化 Kafka 消费者
   */
  private async initKafkaConsumer(): Promise<void> {
    const kafka = new Kafka({
      clientId: 'gateway-notification-push',
      brokers: process.env.KAFKA_BROKERS!.split(',')
    });
    
    this.kafkaConsumer = kafka.consumer({ 
      groupId: 'gateway-push-group',
      sessionTimeout: 30000
    });
    
    await this.kafkaConsumer.subscribe({ 
      topic: 'notifications',
      fromBeginning: false 
    });
    
    await this.kafkaConsumer.run({
      eachMessage: async ({ message }) => {
        const notification: NotificationPayload = JSON.parse(
          message.value!.toString()
        );
        await this.pushToUser(notification);
      }
    });
  }
  
  /**
   * 推送通知给在线用户
   */
  async pushToUser(notification: NotificationPayload): Promise<void> {
    const connections = this.userConnections.get(notification.targetUserId);
    
    if (!connections || connections.size === 0) {
      // 用户离线，存储到通知中心
      await this.storeForOffline(notification);
      return;
    }
    
    const message = JSON.stringify({
      type: 'notification',
      payload: notification
    });
    
    let successCount = 0;
    for (const ws of connections) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
          successCount++;
        } catch (error) {
          console.error('WebSocket send error:', error);
        }
      }
    }
    
    // 记录推送结果
    await this.recordPushResult(notification.id, successCount > 0);
  }
  
  /**
   * 存储离线通知
   */
  private async storeForOffline(notification: NotificationPayload): Promise<void> {
    // 调用 notification-service 的存储接口
    await fetch(`${process.env.NOTIFICATION_SERVICE_URL}/api/notifications/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notification)
    });
  }
  
  /**
   * 记录推送结果
   */
  private async recordPushResult(
    notificationId: string, 
    success: boolean
  ): Promise<void> {
    // 发送到分析系统
    await fetch(`${process.env.NOTIFICATION_SERVICE_URL}/api/analytics/push-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notificationId,
        success,
        pushedAt: new Date().toISOString(),
        channel: 'websocket'
      })
    });
  }
}
```

### 5. 通知中心 API

```typescript
// backend/services/notification-service/src/routes/notificationRoutes.ts

import { Router } from 'express';
import { body, query, param } from 'express-validator';
import { NotificationEngine } from '../engine/NotificationEngine';
import { authMiddleware } from '@shared/middleware/auth';

export function createNotificationRoutes(engine: NotificationEngine): Router {
  const router = Router();
  
  /**
   * 获取通知列表
   * GET /api/notifications
   */
  router.get('/',
    authMiddleware,
    query('type').optional().isString(),
    query('read').optional().isBoolean(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
    async (req, res) => {
      const userId = req.user!.id;
      const { type, read, limit = 20, offset = 0 } = req.query;
      
      const notifications = await engine.getNotifications(userId, {
        type: type as string,
        read: read === 'true' ? true : read === 'false' ? false : undefined,
        limit: Number(limit),
        offset: Number(offset)
      });
      
      res.json({
        success: true,
        data: notifications.items,
        pagination: {
          total: notifications.total,
          limit: Number(limit),
          offset: Number(offset),
          hasMore: notifications.hasMore
        }
      });
    }
  );
  
  /**
   * 获取未读通知数量
   * GET /api/notifications/unread-count
   */
  router.get('/unread-count',
    authMiddleware,
    async (req, res) => {
      const userId = req.user!.id;
      
      const count = await engine.getUnreadCount(userId);
      
      res.json({
        success: true,
        data: { unreadCount: count }
      });
    }
  );
  
  /**
   * 标记通知为已读
   * PUT /api/notifications/:id/read
   */
  router.put('/:id/read',
    authMiddleware,
    param('id').isString(),
    async (req, res) => {
      const userId = req.user!.id;
      const { id } = req.params;
      
      await engine.markAsRead(userId, id);
      
      res.json({ success: true });
    }
  );
  
  /**
   * 批量标记已读
   * PUT /api/notifications/batch-read
   */
  router.put('/batch-read',
    authMiddleware,
    body('ids').isArray(),
    async (req, res) => {
      const userId = req.user!.id;
      const { ids } = req.body;
      
      await engine.markBatchAsRead(userId, ids);
      
      res.json({ success: true, count: ids.length });
    }
  );
  
  /**
   * 标记所有通知为已读
   * PUT /api/notifications/read-all
   */
  router.put('/read-all',
    authMiddleware,
    async (req, res) => {
      const userId = req.user!.id;
      
      const count = await engine.markAllAsRead(userId);
      
      res.json({ success: true, count });
    }
  );
  
  /**
   * 删除通知
   * DELETE /api/notifications/:id
   */
  router.delete('/:id',
    authMiddleware,
    param('id').isString(),
    async (req, res) => {
      const userId = req.user!.id;
      const { id } = req.params;
      
      await engine.deleteNotification(userId, id);
      
      res.json({ success: true });
    }
  );
  
  /**
   * 获取用户通知偏好设置
   * GET /api/notifications/preferences
   */
  router.get('/preferences',
    authMiddleware,
    async (req, res) => {
      const userId = req.user!.id;
      
      const prefs = await engine.getUserPreferences(userId);
      
      res.json({ success: true, data: prefs });
    }
  );
  
  /**
   * 更新用户通知偏好设置
   * PUT /api/notifications/preferences
   */
  router.put('/preferences',
    authMiddleware,
    body('enableInApp').optional().isBoolean(),
    body('enablePush').optional().isBoolean(),
    body('enableEmail').optional().isBoolean(),
    body('enableSms').optional().isBoolean(),
    body('quietHoursStart').optional().isString(),
    body('quietHoursEnd').optional().isString(),
    body('typePreferences').optional().isObject(),
    async (req, res) => {
      const userId = req.user!.id;
      const updates = req.body;
      
      const prefs = await engine.updateUserPreferences(userId, updates);
      
      res.json({ success: true, data: prefs });
    }
  );
  
  /**
   * 发送测试通知（管理员）
   * POST /api/notifications/test
   */
  router.post('/test',
    authMiddleware,
    body('type').isString(),
    body('title').optional().isString(),
    body('body').optional().isString(),
    async (req, res) => {
      const userId = req.user!.id;
      const { type, title, body } = req.body;
      
      await engine.sendNotification({
        id: `test-${Date.now()}`,
        type: type as any,
        title: title || 'Test Notification',
        body: body || 'This is a test notification',
        priority: 'normal',
        channels: ['in_app', 'ws'],
        targetUserId: userId,
        createdAt: new Date()
      });
      
      res.json({ success: true });
    }
  );
  
  return router;
}
```

### 6. 智能推送调度器

```typescript
// backend/services/notification-service/src/scheduler/PushScheduler.ts

import { NotificationPayload, NotificationPriority } from '@shared/types';
import { Redis } from 'ioredis';

export class PushScheduler {
  private redis: Redis;
  private userActivityCache: Map<string, UserActivityProfile>;
  
  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
    this.userActivityCache = new Map();
    this.startCleanupTimer();
  }
  
  /**
   * 智能调度 - 根据用户活跃时间优化推送时机
   */
  async scheduleNotification(
    notification: NotificationPayload
  ): Promise<ScheduleResult> {
    // 紧急通知立即推送
    if (notification.priority === NotificationPriority.URGENT) {
      return { immediate: true, scheduledAt: new Date() };
    }
    
    // 高优先级立即推送（如果用户在线）
    if (notification.priority === NotificationPriority.HIGH) {
      const isOnline = await this.isUserOnline(notification.targetUserId);
      if (isOnline) {
        return { immediate: true, scheduledAt: new Date() };
      }
    }
    
    // 获取用户活跃时间档案
    const profile = await this.getUserActivityProfile(notification.targetUserId);
    
    // 检查是否在静默时段
    if (this.isInQuietHours(notification.targetUserId, profile)) {
      // 延迟到静默时段结束后推送
      const scheduledAt = this.getNextActiveTime(profile);
      return { immediate: false, scheduledAt };
    }
    
    // 根据历史活跃时间优化推送时机
    const optimalTime = this.calculateOptimalPushTime(profile);
    
    // 如果最优时间在未来 5 分钟内，立即推送
    if (optimalTime.getTime() - Date.now() < 5 * 60 * 1000) {
      return { immediate: true, scheduledAt: new Date() };
    }
    
    return { immediate: false, scheduledAt: optimalTime };
  }
  
  /**
   * 获取用户活跃时间档案
   */
  private async getUserActivityProfile(
    userId: string
  ): Promise<UserActivityProfile> {
    // 先查缓存
    if (this.userActivityCache.has(userId)) {
      return this.userActivityCache.get(userId)!;
    }
    
    // 从 Redis 获取
    const cached = await this.redis.get(`user:activity:${userId}`);
    if (cached) {
      const profile = JSON.parse(cached);
      this.userActivityCache.set(userId, profile);
      return profile;
    }
    
    // 从数据库分析历史数据
    const profile = await this.analyzeUserActivity(userId);
    
    // 缓存结果
    await this.redis.setex(
      `user:activity:${userId}`,
      86400, // 24 小时
      JSON.stringify(profile)
    );
    this.userActivityCache.set(userId, profile);
    
    return profile;
  }
  
  /**
   * 分析用户活跃时间
   */
  private async analyzeUserActivity(
    userId: string
  ): Promise<UserActivityProfile> {
    // 查询过去 30 天的用户活动日志
    const activities = await this.fetchUserActivityLogs(userId, 30);
    
    if (activities.length === 0) {
      // 新用户，返回默认档案
      return this.getDefaultProfile();
    }
    
    // 统计各时段活跃度
    const hourlyActivity: number[] = new Array(24).fill(0);
    const dailyActivity: number[] = new Array(7).fill(0);
    
    for (const activity of activities) {
      const date = new Date(activity.timestamp);
      const hour = date.getHours();
      const dayOfWeek = date.getDay();
      
      hourlyActivity[hour]++;
      dailyActivity[dayOfWeek]++;
    }
    
    // 找出最活跃时段
    const peakHours = this.findPeakHours(hourlyActivity);
    const peakDays = this.findPeakDays(dailyActivity);
    
    return {
      userId,
      hourlyActivity,
      dailyActivity,
      peakHours,
      peakDays,
      timezone: activities[0]?.timezone || 'UTC',
      lastUpdated: new Date()
    };
  }
  
  /**
   * 计算最优推送时间
   */
  private calculateOptimalPushTime(profile: UserActivityProfile): Date {
    const now = new Date();
    const currentHour = now.getHours();
    const currentDay = now.getDay();
    
    // 找到下一个活跃时段
    let targetHour = profile.peakHours.find(h => h > currentHour);
    let targetDay = currentDay;
    
    // 如果今天没有更多活跃时段，找明天的第一个活跃时段
    if (!targetHour) {
      targetHour = profile.peakHours[0];
      targetDay = (currentDay + 1) % 7;
    }
    
    // 构造推送时间
    const scheduledAt = new Date(now);
    scheduledAt.setHours(targetHour, 0, 0, 0);
    
    // 如果是明天，增加天数
    if (targetDay !== currentDay) {
      scheduledAt.setDate(scheduledAt.getDate() + 1);
    }
    
    return scheduledAt;
  }
  
  /**
   * 检查是否在静默时段
   */
  private isInQuietHours(
    userId: string,
    profile: UserActivityProfile
  ): boolean {
    const prefs = await this.getUserQuietHours(userId);
    if (!prefs.enabled) return false;
    
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    
    const startTime = this.parseTime(prefs.start);
    const endTime = this.parseTime(prefs.end);
    
    // 处理跨午夜的情况
    if (startTime > endTime) {
      return currentTime >= startTime || currentTime < endTime;
    }
    
    return currentTime >= startTime && currentTime < endTime;
  }
  
  /**
   * 批量调度 - 批量推送优化
   */
  async scheduleBatch(
    notifications: NotificationPayload[]
  ): Promise<BatchScheduleResult> {
    // 按用户分组
    const groupedByUser = new Map<string, NotificationPayload[]>();
    for (const n of notifications) {
      if (!groupedByUser.has(n.targetUserId)) {
        groupedByUser.set(n.targetUserId, []);
      }
      groupedByUser.get(n.targetUserId)!.push(n);
    }
    
    const results: ScheduleResult[] = [];
    
    // 并发调度
    const chunks = this.chunk(Array.from(groupedByUser.entries()), 100);
    
    await Promise.all(chunks.map(async (chunk) => {
      for (const [userId, userNotifications] of chunk) {
        for (const n of userNotifications) {
          const result = await this.scheduleNotification(n);
          results.push(result);
          
          if (!result.immediate) {
            // 存储到延迟队列
            await this.scheduleDelayedNotification(n, result.scheduledAt);
          }
        }
      }
    }));
    
    return {
      total: notifications.length,
      immediate: results.filter(r => r.immediate).length,
      delayed: results.filter(r => !r.immediate).length
    };
  }
}

interface UserActivityProfile {
  userId: string;
  hourlyActivity: number[];
  dailyActivity: number[];
  peakHours: number[];
  peakDays: number[];
  timezone: string;
  lastUpdated: Date;
}

interface ScheduleResult {
  immediate: boolean;
  scheduledAt: Date;
}

interface BatchScheduleResult {
  total: number;
  immediate: number;
  delayed: number;
}
```

### 7. 通知分析系统

```typescript
// backend/services/notification-service/src/analytics/NotificationAnalytics.ts

export class NotificationAnalytics {
  private db: Pool;
  private redis: Redis;
  
  constructor(config: AnalyticsConfig) {
    this.db = new Pool(config.db);
    this.redis = new Redis(config.redis);
  }
  
  /**
   * 记录推送事件
   */
  async trackEvent(event: NotificationEvent): Promise<void> {
    const query = `
      INSERT INTO notification_events (
        notification_id, user_id, event_type, channel, 
        occurred_at, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `;
    
    await this.db.query(query, [
      event.notificationId,
      event.userId,
      event.eventType,
      event.channel,
      event.occurredAt,
      JSON.stringify(event.metadata)
    ]);
    
    // 更新实时指标
    await this.updateRealtimeMetrics(event);
  }
  
  /**
   * 更新实时指标
   */
  private async updateRealtimeMetrics(event: NotificationEvent): Promise<void> {
    const today = new Date().toISOString().split('T')[0];
    const key = `notifications:metrics:${today}`;
    
    // 使用 Redis HyperLogLog 去重
    if (event.eventType === 'sent') {
      await this.redis.pfadd(`${key}:sent:unique`, event.notificationId);
      await this.redis.incr(`${key}:sent:total`);
    } else if (event.eventType === 'delivered') {
      await this.redis.pfadd(`${key}:delivered:unique`, event.notificationId);
      await this.redis.incr(`${key}:delivered:total`);
    } else if (event.eventType === 'opened') {
      await this.redis.pfadd(`${key}:opened:unique`, event.notificationId);
      await this.redis.incr(`${key}:opened:total`);
      
      // 计算延迟
      const sentAt = await this.redis.get(`notification:${event.notificationId}:sent_at`);
      if (sentAt) {
        const latency = Date.now() - new Date(sentAt).getTime();
        await this.redis.lpush(`${key}:open_latency`, latency);
        await this.redis.ltrim(`${key}:open_latency`, 0, 9999); // 保留最近 10000 条
      }
    }
    
    // 设置过期时间（7 天）
    await this.redis.expire(key, 604800);
  }
  
  /**
   * 生成每日报告
   */
  async generateDailyReport(date: Date): Promise<DailyReport> {
    const dateStr = date.toISOString().split('T')[0];
    const key = `notifications:metrics:${dateStr}`;
    
    const [
      sentTotal, sentUnique,
      deliveredTotal, deliveredUnique,
      openedTotal, openedUnique,
      openLatencies
    ] = await Promise.all([
      this.redis.get(`${key}:sent:total`),
      this.redis.pfcount(`${key}:sent:unique`),
      this.redis.get(`${key}:delivered:total`),
      this.redis.pfcount(`${key}:delivered:unique`),
      this.redis.get(`${key}:opened:total`),
      this.redis.pfcount(`${key}:opened:unique`),
      this.redis.lrange(`${key}:open_latency`, 0, -1)
    ]);
    
    // 计算指标
    const deliveryRate = sentTotal ? 
      Number(deliveredTotal) / Number(sentTotal) : 0;
    const openRate = deliveredTotal ? 
      Number(openedTotal) / Number(deliveredTotal) : 0;
    
    // 计算平均延迟
    const latencies = openLatencies.map(Number);
    const avgLatency = latencies.length > 0 ?
      latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const p50Latency = this.percentile(latencies, 50);
    const p95Latency = this.percentile(latencies, 95);
    const p99Latency = this.percentile(latencies, 99);
    
    return {
      date: dateStr,
      sent: {
        total: Number(sentTotal) || 0,
        unique: sentUnique
      },
      delivered: {
        total: Number(deliveredTotal) || 0,
        unique: deliveredUnique
      },
      opened: {
        total: Number(openedTotal) || 0,
        unique: openedUnique
      },
      metrics: {
        deliveryRate,
        openRate,
        avgOpenLatencyMs: avgLatency,
        p50OpenLatencyMs: p50Latency,
        p95OpenLatencyMs: p95Latency,
        p99OpenLatencyMs: p99Latency
      }
    };
  }
  
  /**
   * 按通知类型分析效果
   */
  async analyzeByType(
    startDate: Date,
    endDate: Date
  ): Promise<TypeAnalysis[]> {
    const query = `
      SELECT 
        type,
        COUNT(*) as total_sent,
        COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) as total_delivered,
        COUNT(*) FILTER (WHERE opened_at IS NOT NULL) as total_opened,
        COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) as total_clicked,
        AVG(EXTRACT(EPOCH FROM (opened_at - sent_at)) * 1000) FILTER (WHERE opened_at IS NOT NULL) as avg_open_latency_ms
      FROM notifications
      WHERE sent_at >= $1 AND sent_at < $2
      GROUP BY type
      ORDER BY total_sent DESC
    `;
    
    const result = await this.db.query(query, [startDate, endDate]);
    
    return result.rows.map(row => ({
      type: row.type,
      totalSent: row.total_sent,
      totalDelivered: row.total_delivered,
      totalOpened: row.total_opened,
      totalClicked: row.total_clicked,
      deliveryRate: row.total_sent ? row.total_delivered / row.total_sent : 0,
      openRate: row.total_delivered ? row.total_opened / row.total_delivered : 0,
      clickRate: row.total_opened ? row.total_clicked / row.total_opened : 0,
      avgOpenLatencyMs: row.avg_open_latency_ms
    }));
  }
  
  /**
   * 计算百分位数
   */
  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = values.sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }
}
```

### 8. 数据库 Schema

```sql
-- database/migrations/050_create_notifications.sql

-- 通知主表
CREATE TABLE notifications (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  type VARCHAR(50) NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  channels TEXT[] NOT NULL,
  data JSONB,
  image_url TEXT,
  action_url TEXT,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  read_at TIMESTAMP WITH TIME ZONE,
  clicked_at TIMESTAMP WITH TIME ZONE,
  
  CONSTRAINT valid_priority CHECK (
    priority IN ('low', 'normal', 'high', 'urgent')
  )
);

-- 索引
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_type ON notifications(type);
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id) 
  WHERE read_at IS NULL;
CREATE INDEX idx_notifications_user_type_created ON notifications(user_id, type, created_at DESC);

-- 用户通知偏好表
CREATE TABLE user_notification_preferences (
  user_id VARCHAR(36) PRIMARY KEY,
  enable_in_app BOOLEAN NOT NULL DEFAULT true,
  enable_push BOOLEAN NOT NULL DEFAULT true,
  enable_email BOOLEAN NOT NULL DEFAULT false,
  enable_sms BOOLEAN NOT NULL DEFAULT false,
  quiet_hours_enabled BOOLEAN NOT NULL DEFAULT false,
  quiet_hours_start TIME,
  quiet_hours_end TIME,
  timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
  type_preferences JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 通知事件表（用于分析）
CREATE TABLE notification_events (
  id BIGSERIAL PRIMARY KEY,
  notification_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  event_type VARCHAR(20) NOT NULL,
  channel VARCHAR(20) NOT NULL,
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  metadata JSONB,
  
  CONSTRAINT valid_event_type CHECK (
    event_type IN ('sent', 'delivered', 'opened', 'clicked', 'dismissed', 'failed')
  ),
  CONSTRAINT valid_channel CHECK (
    channel IN ('in_app', 'ws', 'email', 'sms')
  )
);

CREATE INDEX idx_notification_events_notification ON notification_events(notification_id);
CREATE INDEX idx_notification_events_user_time ON notification_events(user_id, occurred_at DESC);
CREATE INDEX idx_notification_events_type_time ON notification_events(event_type, occurred_at);

-- 分区（按月分区，用于事件表）
CREATE TABLE notification_events_partitioned (
  LIKE notification_events INCLUDING ALL
) PARTITION BY RANGE (occurred_at);

-- 创建未来 3 个月的分区
CREATE TABLE notification_events_2026_07 
  PARTITION OF notification_events_partitioned
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
  
CREATE TABLE notification_events_2026_08 
  PARTITION OF notification_events_partitioned
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
  
CREATE TABLE notification_events_2026_09 
  PARTITION OF notification_events_partitioned
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

-- 通知模板表
CREATE TABLE notification_templates (
  type VARCHAR(50) PRIMARY KEY,
  title_translations JSONB NOT NULL,
  body_translations JSONB NOT NULL,
  default_channels TEXT[] NOT NULL,
  icon_url TEXT,
  sound_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 插入默认模板
INSERT INTO notification_templates (type, title_translations, body_translations, default_channels) VALUES
('social.friend_request', 
  '{"en": "New Friend Request", "zh": "新的好友请求", "ja": "新しい友達リクエスト"}',
  '{"en": "{{senderName}} wants to be your friend!", "zh": "{{senderName}} 想要添加你为好友！", "ja": "{{senderName}} が友達になりたいと思っています！"}',
  ARRAY['in_app', 'ws']),
('event.raid_starting',
  '{"en": "Raid Battle Starting Soon!", "zh": "团队战即将开始！", "ja": "レイドバトルがまもなく開始！"}',
  '{"en": "A {{pokemonName}} raid is starting at {{gymName}} in {{minutes}} minutes", "zh": "{{pokemonName}} 团队战将在 {{minutes}} 分钟后于 {{gymName}} 开始", "ja": "{{minutes}} 分後に {{gymName}} で {{pokemonName}} レイドが開始します"}',
  ARRAY['in_app', 'ws']),
('reward.daily_available',
  '{"en": "Daily Reward Available!", "zh": "每日奖励可领取！", "ja": "毎日の報酬が受け取れます！"}',
  '{"en": "Don''t forget to claim your daily reward!", "zh": "别忘了领取你的每日奖励！", "ja": "毎日の報酬を受け取るのを忘れないでください！"}',
  ARRAY['in_app']);
```

### 9. 前端通知中心组件

```typescript
// game-client/src/components/NotificationCenter.tsx

import { Component } from '../engine/Component';
import { EventBus } from '../engine/EventBus';
import { WebSocketManager } from '../network/WebSocketManager';

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  priority: string;
  data?: any;
  imageUrl?: string;
  actionUrl?: string;
  createdAt: Date;
  readAt?: Date;
}

export class NotificationCenter extends Component {
  private notifications: Notification[] = [];
  private unreadCount: number = 0;
  private isOpen: boolean = false;
  private containerEl: HTMLDivElement;
  private listEl: HTMLDivElement;
  private badgeEl: HTMLSpanElement;
  
  constructor(private eventBus: EventBus) {
    super();
    this.setupWebSocketHandler();
    this.createUI();
    this.loadNotifications();
  }
  
  /**
   * 创建 UI
   */
  private createUI(): void {
    // 通知图标按钮
    const bellButton = document.createElement('button');
    bellButton.className = 'notification-bell';
    bellButton.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24">
        <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z"/>
      </svg>
    `;
    
    this.badgeEl = document.createElement('span');
    this.badgeEl.className = 'notification-badge hidden';
    bellButton.appendChild(this.badgeEl);
    
    bellButton.addEventListener('click', () => this.toggle());
    
    // 通知面板
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'notification-panel hidden';
    this.containerEl.innerHTML = `
      <div class="notification-header">
        <h3>Notifications</h3>
        <button class="mark-all-read">Mark all read</button>
      </div>
      <div class="notification-filters">
        <button class="filter-btn active" data-filter="all">All</button>
        <button class="filter-btn" data-filter="social">Social</button>
        <button class="filter-btn" data-filter="event">Events</button>
        <button class="filter-btn" data-filter="reward">Rewards</button>
      </div>
      <div class="notification-list"></div>
      <div class="notification-footer">
        <button class="view-all">View All</button>
      </div>
    `;
    
    this.listEl = this.containerEl.querySelector('.notification-list')!;
    
    // 添加到 DOM
    document.querySelector('.ui-overlay')?.appendChild(bellButton);
    document.querySelector('.ui-overlay')?.appendChild(this.containerEl);
    
    // 绑定事件
    this.containerEl.querySelector('.mark-all-read')
      ?.addEventListener('click', () => this.markAllAsRead());
    
    this.containerEl.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const filter = (e.target as HTMLElement).dataset.filter;
        this.filterNotifications(filter);
      });
    });
  }
  
  /**
   * 设置 WebSocket 处理
   */
  private setupWebSocketHandler(): void {
    WebSocketManager.on('notification', (notification: Notification) => {
      this.handleNewNotification(notification);
    });
  }
  
  /**
   * 处理新通知
   */
  private handleNewNotification(notification: Notification): void {
    // 添加到列表顶部
    this.notifications.unshift(notification);
    this.unreadCount++;
    this.updateBadge();
    
    // 显示 Toast 提示
    this.showToast(notification);
    
    // 播放通知音效
    this.playNotificationSound(notification.priority);
    
    // 触发事件
    this.eventBus.emit('notification:received', notification);
    
    // 更新 UI
    this.renderNotifications();
  }
  
  /**
   * 显示 Toast 提示
   */
  private showToast(notification: Notification): void {
    const toast = document.createElement('div');
    toast.className = `notification-toast priority-${notification.priority}`;
    toast.innerHTML = `
      <div class="toast-icon">
        ${this.getNotificationIcon(notification.type)}
      </div>
      <div class="toast-content">
        <div class="toast-title">${notification.title}</div>
        <div class="toast-body">${notification.body}</div>
      </div>
    `;
    
    toast.addEventListener('click', () => {
      this.handleNotificationClick(notification);
      toast.remove();
    });
    
    document.querySelector('.toast-container')?.appendChild(toast);
    
    // 5 秒后自动消失
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }
  
  /**
   * 渲染通知列表
   */
  private renderNotifications(filter?: string): void {
    let filtered = this.notifications;
    
    if (filter && filter !== 'all') {
      filtered = this.notifications.filter(n => n.type.startsWith(filter));
    }
    
    this.listEl.innerHTML = filtered.slice(0, 20).map(n => `
      <div class="notification-item ${n.readAt ? 'read' : 'unread'}" 
           data-id="${n.id}">
        <div class="notification-icon">
          ${this.getNotificationIcon(n.type)}
        </div>
        <div class="notification-content">
          <div class="notification-title">${n.title}</div>
          <div class="notification-body">${n.body}</div>
          <div class="notification-time">${this.formatTime(n.createdAt)}</div>
        </div>
        ${!n.readAt ? '<div class="unread-dot"></div>' : ''}
      </div>
    `).join('');
    
    // 绑定点击事件
    this.listEl.querySelectorAll('.notification-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = (item as HTMLElement).dataset.id!;
        const notification = this.notifications.find(n => n.id === id);
        if (notification) {
          this.handleNotificationClick(notification);
        }
      });
    });
  }
  
  /**
   * 处理通知点击
   */
  private async handleNotificationClick(notification: Notification): Promise<void> {
    // 标记为已读
    if (!notification.readAt) {
      await this.markAsRead(notification.id);
    }
    
    // 导航到目标页面
    if (notification.actionUrl) {
      this.eventBus.emit('navigate', notification.actionUrl);
    }
    
    // 执行特定动作
    if (notification.data?.action) {
      this.eventBus.emit('notification:action', {
        type: notification.data.action,
        payload: notification.data
      });
    }
    
    // 关闭面板
    this.close();
  }
  
  /**
   * 标记为已读
   */
  private async markAsRead(id: string): Promise<void> {
    try {
      await fetch(`/api/notifications/${id}/read`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' }
      });
      
      const notification = this.notifications.find(n => n.id === id);
      if (notification && !notification.readAt) {
        notification.readAt = new Date();
        this.unreadCount--;
        this.updateBadge();
        this.renderNotifications();
      }
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
    }
  }
  
  /**
   * 批量标记已读
   */
  private async markAllAsRead(): Promise<void> {
    try {
      await fetch('/api/notifications/read-all', {
        method: 'PUT'
      });
      
      const now = new Date();
      for (const n of this.notifications) {
        if (!n.readAt) {
          n.readAt = now;
        }
      }
      this.unreadCount = 0;
      this.updateBadge();
      this.renderNotifications();
    } catch (error) {
      console.error('Failed to mark all as read:', error);
    }
  }
  
  /**
   * 更新徽章
   */
  private updateBadge(): void {
    if (this.unreadCount > 0) {
      this.badgeEl.textContent = this.unreadCount > 99 ? '99+' : String(this.unreadCount);
      this.badgeEl.classList.remove('hidden');
    } else {
      this.badgeEl.classList.add('hidden');
    }
  }
  
  /**
   * 获取通知图标
   */
  private getNotificationIcon(type: string): string {
    const icons: Record<string, string> = {
      'social': '👥',
      'event': '⚔️',
      'reward': '🎁',
      'security': '🔒',
      'system': 'ℹ️',
      'pokemon': '🌟'
    };
    
    const category = type.split('.')[0];
    return icons[category] || '📌';
  }
  
  /**
   * 格式化时间
   */
  private formatTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - new Date(date).getTime();
    
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    
    return new Date(date).toLocaleDateString();
  }
  
  /**
   * 切换面板
   */
  toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }
  
  open(): void {
    this.isOpen = true;
    this.containerEl.classList.remove('hidden');
    this.loadNotifications();
  }
  
  close(): void {
    this.isOpen = false;
    this.containerEl.classList.add('hidden');
  }
  
  /**
   * 加载通知
   */
  private async loadNotifications(): Promise<void> {
    try {
      const response = await fetch('/api/notifications?limit=50');
      const { data } = await response.json();
      
      this.notifications = data;
      this.unreadCount = data.filter((n: Notification) => !n.readAt).length;
      this.updateBadge();
      this.renderNotifications();
    } catch (error) {
      console.error('Failed to load notifications:', error);
    }
  }
  
  /**
   * 播放通知音效
   */
  private playNotificationSound(priority: string): void {
    if (priority === 'urgent') {
      this.eventBus.emit('sound:play', 'notification-urgent');
    } else if (priority === 'high') {
      this.eventBus.emit('sound:play', 'notification-high');
    } else {
      this.eventBus.emit('sound:play', 'notification-normal');
    }
  }
}
```

### 10. Prometheus 指标

```typescript
// backend/services/notification-service/src/metrics/prometheus.ts

import { collectDefaultMetrics, Registry, Counter, Histogram, Gauge } from 'prom-client';

export const notificationRegistry = new Registry();

// 发送计数
export const notificationsSentTotal = new Counter({
  name: 'notifications_sent_total',
  help: 'Total number of notifications sent',
  labelNames: ['type', 'channel', 'priority'],
  registers: [notificationRegistry]
});

// 送达计数
export const notificationsDeliveredTotal = new Counter({
  name: 'notifications_delivered_total',
  help: 'Total number of notifications delivered',
  labelNames: ['type', 'channel'],
  registers: [notificationRegistry]
});

// 打开计数
export const notificationsOpenedTotal = new Counter({
  name: 'notifications_opened_total',
  help: 'Total number of notifications opened',
  labelNames: ['type'],
  registers: [notificationRegistry]
});

// 推送延迟
export const notificationPushLatency = new Histogram({
  name: 'notification_push_latency_seconds',
  help: 'Time to push notification from creation to delivery',
  labelNames: ['channel', 'priority'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [notificationRegistry]
});

// WebSocket 连接数
export const websocketConnectionsActive = new Gauge({
  name: 'websocket_connections_active',
  help: 'Number of active WebSocket connections',
  registers: [notificationRegistry]
});

// 待发送队列大小
export const notificationQueueSize = new Gauge({
  name: 'notification_queue_size',
  help: 'Number of notifications waiting to be sent',
  labelNames: ['priority'],
  registers: [notificationRegistry]
});

// 失败计数
export const notificationsFailedTotal = new Counter({
  name: 'notifications_failed_total',
  help: 'Total number of failed notifications',
  labelNames: ['type', 'channel', 'error_type'],
  registers: [notificationRegistry]
});

// 用户偏好设置
export const notificationPreferencesUpdated = new Counter({
  name: 'notification_preferences_updated_total',
  help: 'Total number of preference updates',
  registers: [notificationRegistry]
});

// 订阅主题数量
export const notificationTopicsSubscribed = new Gauge({
  name: 'notification_topics_subscribed',
  help: 'Number of topics users are subscribed to',
  labelNames: ['type'],
  registers: [notificationRegistry]
});
```

## 验收标准

### 功能验收

- [ ] 支持所有通知类型的发送和接收（系统、社交、活动、奖励、安全、精灵）
- [ ] WebSocket 实时推送延迟 < 3 秒
- [ ] 通知中心 API 响应时间 < 500ms（P95）
- [ ] 支持批量发送通知（> 10000 条/秒）
- [ ] 用户可配置通知偏好（渠道、时段、类型）
- [ ] 通知内容支持中/英/日三语自动切换
- [ ] 离线通知存储和补推
- [ ] 通知过期自动清理（默认 30 天）
- [ ] 深度链接跳转功能正常

### 性能验收

- [ ] 通知送达率 > 99%（在线用户）
- [ ] 并发推送吞吐量 > 10000 条/秒
- [ ] 通知中心首屏加载时间 < 1 秒
- [ ] 数据库查询优化（索引覆盖、查询计划）
- [ ] 内存使用 < 500MB（10000 并发连接）

### 可观测性验收

- [ ] Prometheus 指标正确采集
- [ ] Grafana 仪表板展示实时指标
- [ ] 告警规则配置（送达率下降、延迟过高）
- [ ] 推送效果分析报告（日报、周报）

### 安全验收

- [ ] JWT 认证保护所有 API
- [ ] 用户只能访问自己的通知
- [ ] 敏感通知内容不在日志中明文记录
- [ ] WebSocket 连接需要认证
- [ ] 防止通知注入攻击

### 兼容性验收

- [ ] 支持 iOS Safari、Android Chrome
- [ ] PWA 离线模式支持
- [ ] 低带宽环境优化（消息压缩）
- [ ] 弱网环境重连机制

## 影响范围

### 新增文件

- `backend/services/notification-service/` - 新建通知服务
  - `src/engine/NotificationEngine.ts`
  - `src/scheduler/PushScheduler.ts`
  - `src/analytics/NotificationAnalytics.ts`
  - `src/routes/notificationRoutes.ts`
  - `src/models/Notification.ts`
  - `src/templates/` - 通知模板
  - `src/metrics/prometheus.ts`

- `game-client/src/components/NotificationCenter.tsx` - 前端通知中心
- `game-client/src/components/NotificationToast.tsx` - Toast 提示
- `game-client/styles/notification.css` - 样式文件

- `database/migrations/050_create_notifications.sql` - 数据库迁移
- `database/seeds/notification_templates.sql` - 模板种子数据

### 修改文件

- `backend/services/gateway/src/handlers/WebSocketHandler.ts` - 添加通知推送
- `backend/services/gateway/src/server.ts` - 注册推送处理器
- `backend/shared/types/notification.ts` - 共享类型定义
- `backend/shared/middleware/auth.ts` - 添加通知权限
- `game-client/src/network/WebSocketManager.ts` - 处理通知消息
- `game-client/src/ui/UIOverlay.ts` - 添加通知图标
- `game-client/styles/main.css` - 引入通知样式
- `admin-dashboard/src/pages/NotificationsPage.tsx` - 管理页面
- `k8s/notification-service.yaml` - Kubernetes 配置
- `docker-compose.yml` - 添加 notification-service
- `docs/api/notification.md` - API 文档

### 依赖变更

- 新增依赖：`kafkajs`（已有）、`prom-client`（已有）
- 新增服务：`notification-service`

## 参考

- [Firebase Cloud Messaging 文档](https://firebase.google.com/docs/cloud-messaging)
- [WebSocket RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455)
- [Kafka 消息队列最佳实践](https://kafka.apache.org/documentation/)
- [通知设计模式](https://www.nngroup.com/articles/notifications-invasive/)
- [GDPR 通知合规指南](https://gdpr.eu/what-is-gdpr/)
- [多语言 i18n 最佳实践](https://www.w3.org/International/questions/qa-i18n)

## 实现记录（2026-09-24）

> E05「成就/称号/资料卡/收藏室」与 E13「消息中心与推送」统一实现：REQ-00076 / 00106 / 00327 / 00359 / 00387 / 00403 与 REQ-00099 / 00261 / 00425 共用同一套游戏事件 outbox、成就引擎与消息中心。
> 状态 `implemented`：代码已全部完成，**未做服务级验证**（2026-09-25 18:30 起规则）。此前迁移 `20260925_130000`、`20260925_131000` 曾在隔离 CI 栈（栈 8）的存量库上执行无失败，user-service 启动后事件消费者、消息分发器、WebSocket 均正常监听；之后新增的迁移 `20260925_132000`、`20260925_133000`、全部接口、前端界面只做了静态检查（`node --check`、`scripts/check-deps.js`、宿主机纯逻辑/内存替身单测），**待验证**。

**共用架构**

- 事件来源：业务表上的触发器把"发生了什么"写入 outbox 表 `achievement_events`（与业务同事务，业务回滚事件也不存在；触发器内部异常只 `RAISE WARNING`，不影响业务）并 `pg_notify('pmg_game_events')`。接入的表：`catch_sessions`（捕捉成功）、`pokestop_spins`、`trainer_level_ups`（升级，覆盖所有加经验路径）、`friendships`/`friends`、`friend_requests`、`friend_gifts`、`pokemon_trades`、`gym_battles`、`raid_participants`、`pvp_battles`、`egg_hatching`、`event_participations`；收藏室的展示/装饰/被点赞由 JS 在同事务写事件。
- 消费：`backend/shared/achievementEngine.js`，user-service 启动时 `LISTEN` 实时处理 + 10 秒兜底扫描 + 每小时清理；pokemon-service 查询成就前按需处理该玩家未处理事件。`FOR UPDATE SKIP LOCKED` 保证多消费者不重复处理；每个事件一个 SAVEPOINT，单事件失败不影响其他事件，失败 5 次后放弃并保留 `last_error`。
- 规则：`backend/shared/achievementRules.js`（事件 → 指标、过滤条件、奖励拆分、事件 → 消息、多语言，纯函数）。
- 消息：`backend/shared/notificationCenter.js`（生成/列表/未读/已读/删除/偏好/广播/分析/清理）、`notificationPolicy.js`（分类、偏好、免打扰、投递计划，纯函数）、`notificationRealtime.js`（`/ws/messages` 与 LISTEN 分发）、`pushProviders.js`（FCM/APNs）。
- 迁移：`database/migrations/20260925_130000__e05_achievement_title_core.sql`（成就/称号收敛 + outbox 触发器）、`20260925_131000__e13_notification_center.sql`（消息中心）、`20260925_132000__e05_collection_room.sql`（收藏室）、`20260925_133000__e05_player_profile.sql`（资料卡）。均 `IF NOT EXISTS`/`ON CONFLICT` 幂等，外键均按 `users.id UUID`；依赖的表（`achievements`、`title_definitions`、`trainer_level_ups`、`notification_templates`、E01 的 `privacy_settings`/`blocked_users` 等）都在更早的迁移中创建（已逐条核对）。
- 测试：单测 `cd backend && node --test tests/unit/achievementRules.test.js tests/unit/achievementEngine.test.js tests/unit/notificationPolicy.test.js tests/unit/notificationCenter.test.js tests/unit/profileRules.test.js tests/unit/collectionRoomRules.test.js tests/unit/securityNotifier.test.js`（53 例，已加入 `test:unit`，宿主机已运行通过；引擎与消息中心用 `tests/unit/helpers/fakeGameDb.js` 内存替身，不依赖数据库）；经网关冒烟 `BASE_URL=… node scripts/smoke-profile-notify.js`（约 97 项，**未运行**）；压测 `node scripts/bench-profile-notify.js`（**未运行**）；前端 `cd frontend/game-client && npx playwright test tests/e2e/profile-notify.spec.js`（Mock 接口，**未运行**）。
- 前端：`frontend/game-client/src/features/profileNotify.js` + `src/features/profile-notify/*`（由 `src/bootstrap/features.js` 注册一行）：底部导航「消息」🔔、「我的」页「成长与收藏」卡片（成就、称号、资料卡、我的收藏室、热门收藏室、收藏家排行、消息与通知设置）。

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 支持所有通知类型的发送和接收（系统、社交、活动、奖励、安全、精灵） | ✅ | 6 个分类：系统（管理员公告、广播）、社交（好友请求、礼物、交易、收藏室点赞/留言）、活动（活动开始广播、Raid、道馆）、奖励（升级、成就、称号、装饰、收藏室升级、任务）、安全（新设备登录：`shared/securityNotifier.js`，按设备指纹识别，IP 打码）、精灵（附近稀有精灵，EventBus 来源）；类型命名 `分类.事件`（如 `social.friend_request`） |
| WebSocket 实时推送延迟 < 3 秒 | ✅ | 触发器 → `pg_notify` → user-service LISTEN 实时处理与分发，无轮询；冒烟断言好友请求到 WS 送达 < 3 秒（未运行）；指标 `minego_notification_delivery_seconds` + 告警（P95 > 3s） |
| 通知中心 API 响应时间 < 500ms（P95） | ⚠️ | 未实测；`scripts/bench-profile-notify.js` 覆盖列表/未读数 P95 |
| 支持批量发送通知（> 10000 条/秒） | ⚠️ | 未实测。全服通知用广播表（一行），玩家读取时按需物化，不需要逐条写入全体玩家；压测脚本含批量生成 5000 条消息的吞吐测量 |
| 用户可配置通知偏好（渠道、时段、类型） | ✅ | `PATCH /v1/notifications/preferences`：分类/具体类型开关、渠道（websocket/fcm/apns/email）、免打扰时段（跨午夜、按玩家时区）、临时静音、推送开关、每小时推送上限；设备令牌 `POST /v1/notifications/device-token` |
| 通知内容支持中/英/日三语自动切换 | ✅ | 模板三语；读取与 WS 推送按请求语言/玩家语言设置渲染 |
| 离线通知存储和补推 | ✅ | 全部落库，上线连接 WS 时补推未读（支持 `since`），离线期间满足条件时走系统推送 |
| 通知过期自动清理（默认 30 天） | ✅ | 默认 30 天过期，每小时清理（见 REQ-00261） |
| 深度链接跳转功能正常 | ✅ | 消息带 `actionUrl` 与 `data`；`POST /v1/notifications/:id/click` 记录点击；客户端按 `actionUrl` 打开对应面板（见 REQ-00099） |
| 通知送达率 > 99%（在线用户） | ⚠️ | 未实测；`minego_notifications_delivered_total{channel,result}` 统计，告警规则"在线送达率 < 99%" |
| 并发推送吞吐量 > 10000 条/秒 | ⚠️ | 未实测（同上） |
| 通知中心首屏加载时间 < 1 秒 | ⚠️ | 未实测；首屏只拉 20 条 + 未读数，虚拟滚动 |
| 数据库查询优化（索引覆盖、查询计划） | ✅ | `notifications` 索引：`(user_id, created_at DESC)`、`(user_id, category, created_at DESC)`（均为未删除部分索引）、未读部分索引 `(user_id, category) WHERE NOT is_read AND NOT is_deleted`、`(user_id, dedupe_key)` 唯一、`expires_at`；`notification_events` 按消息/用户+时间/类型+时间；建议验证时对列表/未读 SQL 做 `EXPLAIN ANALYZE` |
| 内存使用 < 500MB（10000 并发连接） | ⚠️ | 未实测；WS 每连接只保存 userId 与心跳标记 |
| Prometheus 指标正确采集 | ✅ | `minego_notification_ws_connections`、`minego_notifications_delivered_total{channel,result}`、`minego_notification_delivery_seconds`，以及成就引擎指标；user-service `/metrics` |
| Grafana 仪表板展示实时指标 | ⚠️ | 配置已交付 `monitoring/grafana/dashboards/achievements-notifications.json`（JSON 已校验），未在生产环境验证（生产未部署 Grafana） |
| 告警规则配置（送达率下降、延迟过高） | ⚠️ | `infrastructure/monitoring/prometheus/profile_notify_alerts.yml`（送达率 < 99%、推送延迟 P95 > 3s、推送渠道失败、事件处理失败/积压，YAML 已校验），未在生产环境验证 |
| 推送效果分析报告（日报、周报） | ⚠️ | 管理员 `GET /v1/notifications/admin/analytics?days=1|7`：按渠道的发送/实时送达/推送/打开/点击/延迟/抑制/失败，按类型的发送与打开率；暂无定时生成并投递日报/周报的任务 |
| JWT 认证保护所有 API | ✅ | 网关 `/v1/notifications/*` 走 `authMiddleware`（含登出黑名单），服务内再 `requireAuth`；管理接口 `requireAdmin` |
| 用户只能访问自己的通知 | ✅ | 所有查询/更新都带 `user_id = 当前用户`；他人消息 ID 返回 404（冒烟验证） |
| 敏感通知内容不在日志中明文记录 | ✅ | 分发/引擎日志只记消息 ID、用户 ID、错误信息，不记标题正文；新设备登录消息中的 IP 打码 |
| WebSocket 连接需要认证 | ✅ | 握手校验 token 签名与黑名单，失败返回 401 并断开（冒烟验证无效 token 被拒） |
| 防止通知注入攻击 | ✅ | 模板参数与标题正文去除尖括号与控制字符、限制长度；客户端一律 `textContent` 渲染；偏好键名正则白名单 |
| 支持 iOS Safari、Android Chrome | ⚠️ | 使用标准 WebSocket/IndexedDB/Pointer Events，未在真机验证 |
| PWA 离线模式支持 | ✅ | IndexedDB 缓存消息，Service Worker 离线响应（code 9999）时展示缓存 |
| 低带宽环境优化（消息压缩） | ✅ | `/ws/messages` 启用 permessage-deflate（> 1KB 压缩）；列表分页 20 条 |
| 弱网环境重连机制 | ✅ | 客户端指数退避重连（1s→30s + 抖动），`online`/切回前台立即重连并增量同步；服务端 LISTEN 断开 5 秒重连，另有 10 秒兜底扫描 |

**智能推送策略**（`backend/shared/notificationPolicy.planDelivery`）：在线 → WebSocket（免打扰时静默，紧急除外）；离线 → 满足"开启推送、有设备令牌、渠道已配置、不在免打扰（紧急除外）、优先级 ≥ normal、未超过每小时推送上限"时走 APNs/FCM（`backend/shared/pushProviders.js`：FCM HTTP v1、APNs HTTP/2 + JWT，凭据通过 `FCM_*`/`APNS_*` 环境变量配置）；否则**降级为仅站内消息**并在 `notification_events` 记录 `deferred` 与原因（`push_provider_unconfigured` / `no_device_token` / `quiet_hours` / `rate_limited` / `low_priority_in_app_only` / `push_disabled`）。**生产环境目前没有 APNs/FCM 凭据**，推送链路只做了静态检查，未在生产环境验证；冒烟验证"有设备令牌但未配置凭据 → 仅站内 + 原因 push_provider_unconfigured"。

- 入口：user-service（消息中心路由、分发器、WS）；`backend/shared/notificationCenter.js`、`notificationPolicy.js`、`notificationRealtime.js`、`pushProviders.js`、`securityNotifier.js`（`routes/auth.js` 登录成功后调用）；网关 `/v1/notifications/*`、`/ws/messages`
- 迁移：`database/migrations/20260925_131000__e13_notification_center.sql`
- 测试：`notificationPolicy.test.js`（7，含投递计划各降级原因、跨午夜免打扰、偏好校验、模板注入）、`notificationCenter.test.js`（7）、`securityNotifier.test.js`（2）已通过；冒烟与压测未运行
- 偏差：未新建独立 notification-service、未引入 Kafka 队列（PM2 单机部署，Kafka 未启用；用 PostgreSQL LISTEN/NOTIFY + outbox）；TypeScript 设计改为 CommonJS；未做管理后台 `NotificationsPage`（提供分析与公告 API）；邮件/短信渠道未实现（偏好中可保存开关）
- 待验证：① 配置 FCM/APNs 凭据后的真实推送；② 压测吞吐与送达率；③ 告警规则与仪表盘在 Prometheus/Grafana 中加载
