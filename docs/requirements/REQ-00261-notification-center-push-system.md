# REQ-00261: 游戏内实时通知中心与消息推送系统

## 元信息

| 字段 | 值 |
|------|-----|
| 编号 | REQ-00261 |
| 标题 | 游戏内实时通知中心与消息推送系统 |
| 类别 | 前端体验 |
| 优先级 | P1 |
| 状态 | implemented |
| 涉及服务 | gateway、user-service、social-service、reward-service、game-client、backend/shared |
| 创建时间 | 2026-06-18 17:00 |

## 需求描述

建立一个统一的游戏内通知中心，实时推送各类游戏事件通知（精灵捕捉成功、道馆战斗结果、好友请求、奖励领取等），提升玩家对游戏状态的感知和互动体验。

### 核心功能

1. **实时通知推送** - 通过 WebSocket 实时推送通知到在线玩家
2. **通知分类管理** - 按类型分类（系统、社交、战斗、奖励、活动）
3. **通知持久化** - 离线通知存储，玩家上线后同步
4. **通知已读状态** - 追踪已读/未读状态，支持批量标记
5. **通知优先级** - 紧急通知置顶，过期通知自动清理
6. **推送渠道适配** - 支持游戏内、邮件、推送通知多渠道

## 技术方案

### 1. 数据库设计

```sql
-- 通知表
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type VARCHAR(50) NOT NULL, -- system, social, battle, reward, event
  priority INT DEFAULT 0, -- 0=normal, 1=high, 2=urgent
  title VARCHAR(200) NOT NULL,
  title_i18n JSONB DEFAULT '{}',
  content TEXT,
  content_i18n JSONB DEFAULT '{}',
  data JSONB DEFAULT '{}', -- 关联数据（如精灵ID、战斗ID等）
  icon_url VARCHAR(500),
  action_url VARCHAR(500), -- 点击跳转链接
  is_read BOOLEAN DEFAULT false,
  read_at TIMESTAMPTZ,
  is_deleted BOOLEAN DEFAULT false,
  deleted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ, -- 过期时间
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  INDEX idx_notifications_user (user_id, is_read, created_at DESC),
  INDEX idx_notifications_type (notification_type),
  INDEX idx_notifications_expires (expires_at) WHERE expires_at IS NOT NULL
);

-- 通知模板表
CREATE TABLE notification_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key VARCHAR(100) UNIQUE NOT NULL,
  notification_type VARCHAR(50) NOT NULL,
  priority INT DEFAULT 0,
  title_template VARCHAR(200) NOT NULL,
  content_template TEXT,
  icon_url VARCHAR(500),
  action_url_template VARCHAR(500),
  default_expiry_hours INT DEFAULT 168, -- 默认7天过期
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 用户通知设置表
CREATE TABLE user_notification_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enable_push BOOLEAN DEFAULT true,
  enable_email BOOLEAN DEFAULT false,
  enable_in_game BOOLEAN DEFAULT true,
  type_settings JSONB DEFAULT '{}', -- {"social": true, "battle": true, ...}
  quiet_hours_start TIME, -- 免打扰时段
  quiet_hours_end TIME,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 2. 通知服务核心

```javascript
// backend/shared/NotificationService.js

const db = require('./db');
const cache = require('./cache');
const logger = require('./logger');
const { getWebSocketServer } = require('./websocket');

class NotificationService {
  constructor() {
    this.templates = new Map();
    this.loadTemplates();
  }

  async loadTemplates() {
    const result = await db.query('SELECT * FROM notification_templates');
    for (const template of result.rows) {
      this.templates.set(template.template_key, template);
    }
  }

  /**
   * 发送通知
   */
  async send(userId, options) {
    const {
      type,
      templateKey,
      title,
      content,
      data = {},
      priority = 0,
      iconUrl,
      actionUrl,
      expiresAt
    } = options;

    let notification;

    if (templateKey && this.templates.has(templateKey)) {
      // 使用模板
      notification = await this.createFromTemplate(
        userId, 
        templateKey, 
        data
      );
    } else {
      // 直接创建
      const expiry = expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      
      const result = await db.query(`
        INSERT INTO notifications 
          (user_id, notification_type, priority, title, content, data, 
           icon_url, action_url, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [userId, type, priority, title, content, JSON.stringify(data),
          iconUrl, actionUrl, expiry]);
      
      notification = result.rows[0];
    }

    // 实时推送
    await this.pushToUser(userId, notification);

    // 记录指标
    this.recordMetric(notification);

    return notification;
  }

  /**
   * 批量发送通知
   */
  async sendBatch(userIds, options) {
    const notifications = [];
    
    for (const userId of userIds) {
      const notification = await this.send(userId, options);
      notifications.push(notification);
    }

    return notifications;
  }

  /**
   * 从模板创建通知
   */
  async createFromTemplate(userId, templateKey, data) {
    const template = this.templates.get(templateKey);
    if (!template) {
      throw new Error(`Template not found: ${templateKey}`);
    }

    // 替换模板变量
    const title = this.renderTemplate(template.title_template, data);
    const content = template.content_template 
      ? this.renderTemplate(template.content_template, data) 
      : null;
    const actionUrl = template.action_url_template
      ? this.renderTemplate(template.action_url_template, data)
      : null;

    const expiresAt = new Date(
      Date.now() + template.default_expiry_hours * 60 * 60 * 1000
    );

    const result = await db.query(`
      INSERT INTO notifications 
        (user_id, notification_type, priority, title, content, data,
         icon_url, action_url, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [userId, template.notification_type, template.priority,
        title, content, JSON.stringify(data),
        template.icon_url, actionUrl, expiresAt]);

    return result.rows[0];
  }

  /**
   * 渲染模板
   */
  renderTemplate(template, data) {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return data[key] !== undefined ? data[key] : match;
    });
  }

  /**
   * 实时推送到用户
   */
  async pushToUser(userId, notification) {
    const ws = getWebSocketServer();
    
    if (ws && ws.isUserConnected(userId)) {
      ws.sendToUser(userId, {
        type: 'notification',
        data: notification
      });

      // 更新推送状态
      await db.query(`
        UPDATE notifications 
        SET pushed_at = NOW()
        WHERE id = $1
      `, [notification.id]);
    }
  }

  /**
   * 获取用户通知列表
   */
  async getUserNotifications(userId, options = {}) {
    const { 
      limit = 50, 
      offset = 0, 
      unreadOnly = false,
      type 
    } = options;

    let query = `
      SELECT * FROM notifications
      WHERE user_id = $1 
        AND is_deleted = false
        AND (expires_at IS NULL OR expires_at > NOW())
    `;
    const params = [userId];
    let paramIndex = 2;

    if (unreadOnly) {
      query += ` AND is_read = false`;
    }

    if (type) {
      query += ` AND notification_type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    query += ` ORDER BY priority DESC, created_at DESC`;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await db.query(query, params);
    return result.rows;
  }

  /**
   * 获取未读数量
   */
  async getUnreadCount(userId) {
    const cacheKey = `notifications:unread:${userId}`;
    
    return await cache.getOrSet(
      cacheKey,
      async () => {
        const result = await db.query(`
          SELECT COUNT(*) as count
          FROM notifications
          WHERE user_id = $1 
            AND is_read = false 
            AND is_deleted = false
            AND (expires_at IS NULL OR expires_at > NOW())
        `, [userId]);
        return parseInt(result.rows[0].count);
      },
      { ttl: 60 }
    );
  }

  /**
   * 标记为已读
   */
  async markAsRead(userId, notificationIds) {
    const result = await db.query(`
      UPDATE notifications
      SET is_read = true, read_at = NOW()
      WHERE id = ANY($1) AND user_id = $2
      RETURNING id
    `, [notificationIds, userId]);

    // 清除缓存
    await cache.del(`notifications:unread:${userId}`);

    return result.rows;
  }

  /**
   * 标记全部已读
   */
  async markAllAsRead(userId) {
    const result = await db.query(`
      UPDATE notifications
      SET is_read = true, read_at = NOW()
      WHERE user_id = $1 AND is_read = false AND is_deleted = false
      RETURNING id
    `, [userId]);

    await cache.del(`notifications:unread:${userId}`);

    return result.rows.length;
  }

  /**
   * 删除通知
   */
  async delete(userId, notificationIds) {
    await db.query(`
      UPDATE notifications
      SET is_deleted = true, deleted_at = NOW()
      WHERE id = ANY($1) AND user_id = $2
    `, [notificationIds, userId]);

    await cache.del(`notifications:unread:${userId}`);
  }

  /**
   * 清理过期通知
   */
  async cleanupExpired() {
    const result = await db.query(`
      DELETE FROM notifications
      WHERE expires_at < NOW()
      RETURNING id
    `);

    logger.info('Cleaned up expired notifications', {
      count: result.rows.length
    });

    return result.rows.length;
  }

  recordMetric(notification) {
    const metrics = require('./metrics');
    metrics.notificationsSent.inc({
      type: notification.notification_type,
      priority: notification.priority
    });
  }
}

module.exports = new NotificationService();
```

### 3. API 路由

```javascript
// backend/services/user-service/src/routes/notifications.js

const express = require('express');
const router = express.Router();
const NotificationService = require('../../../shared/NotificationService');
const { authenticate } = require('../../../shared/authMiddleware');

/**
 * GET /api/user/notifications
 * 获取通知列表
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { limit, offset, unreadOnly, type } = req.query;
    
    const notifications = await NotificationService.getUserNotifications(
      req.user.id,
      { 
        limit: parseInt(limit) || 50,
        offset: parseInt(offset) || 0,
        unreadOnly: unreadOnly === 'true',
        type
      }
    );

    const unreadCount = await NotificationService.getUnreadCount(req.user.id);

    res.json({
      success: true,
      data: {
        notifications,
        unreadCount
      }
    });
  } catch (error) {
    logger.error('Failed to get notifications', { error: error.message });
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/user/notifications/unread-count
 * 获取未读数量
 */
router.get('/unread-count', authenticate, async (req, res) => {
  try {
    const count = await NotificationService.getUnreadCount(req.user.id);
    res.json({ success: true, data: { count } });
  } catch (error) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/user/notifications/:id/read
 * 标记为已读
 */
router.post('/:id/read', authenticate, async (req, res) => {
  try {
    await NotificationService.markAsRead(req.user.id, [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/user/notifications/read-all
 * 标记全部已读
 */
router.post('/read-all', authenticate, async (req, res) => {
  try {
    const count = await NotificationService.markAllAsRead(req.user.id);
    res.json({ success: true, data: { markedCount: count } });
  } catch (error) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * DELETE /api/user/notifications/:id
 * 删除通知
 */
router.delete('/:id', authenticate, async (req, res) => {
  try {
    await NotificationService.delete(req.user.id, [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
```

### 4. 前端组件

```javascript
// frontend/game-client/src/components/NotificationCenter.js

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import { useWebSocket } from '../hooks/useWebSocket';
import './NotificationCenter.css';

export default function NotificationCenter() {
  const { t, i18n } = useTranslation();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  
  const { subscribe } = useWebSocket();

  // WebSocket 实时推送
  useEffect(() => {
    return subscribe('notification', (notification) => {
      setNotifications(prev => [notification, ...prev]);
      setUnreadCount(prev => prev + 1);
      showNotificationToast(notification);
    });
  }, [subscribe]);

  const loadNotifications = useCallback(async () => {
    try {
      setLoading(true);
      const response = await api.get('/user/notifications', {
        params: { limit: 50 }
      });
      setNotifications(response.data.data.notifications);
      setUnreadCount(response.data.data.unreadCount);
    } catch (error) {
      console.error('Failed to load notifications:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  const markAsRead = async (id) => {
    try {
      await api.post(`/user/notifications/${id}/read`);
      setNotifications(prev => 
        prev.map(n => n.id === id ? { ...n, is_read: true } : n)
      );
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (error) {
      console.error('Failed to mark as read:', error);
    }
  };

  const markAllAsRead = async () => {
    try {
      await api.post('/user/notifications/read-all');
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
      setUnreadCount(0);
    } catch (error) {
      console.error('Failed to mark all as read:', error);
    }
  };

  const handleNotificationClick = (notification) => {
    if (!notification.is_read) {
      markAsRead(notification.id);
    }
    if (notification.action_url) {
      window.location.href = notification.action_url;
    }
    setIsOpen(false);
  };

  const getTypeIcon = (type) => {
    const icons = {
      system: '⚙️',
      social: '👥',
      battle: '⚔️',
      reward: '🎁',
      event: '🎉'
    };
    return icons[type] || '📢';
  };

  const getTypeColor = (type) => {
    const colors = {
      system: '#6B7280',
      social: '#10B981',
      battle: '#EF4444',
      reward: '#F59E0B',
      event: '#8B5CF6'
    };
    return colors[type] || '#6B7280';
  };

  const formatTime = (date) => {
    const now = new Date();
    const diff = now - new Date(date);
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return t('notifications.justNow');
    if (minutes < 60) return t('notifications.minutesAgo', { count: minutes });
    if (hours < 24) return t('notifications.hoursAgo', { count: hours });
    return t('notifications.daysAgo', { count: days });
  };

  return (
    <div className="notification-center">
      <button 
        className="notification-bell"
        onClick={() => setIsOpen(!isOpen)}
      >
        🔔
        {unreadCount > 0 && (
          <span className="notification-badge">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="notification-dropdown">
          <div className="notification-header">
            <h3>{t('notifications.title')}</h3>
            {unreadCount > 0 && (
              <button 
                className="mark-all-read"
                onClick={markAllAsRead}
              >
                {t('notifications.markAllRead')}
              </button>
            )}
          </div>

          <div className="notification-list">
            {loading ? (
              <div className="notification-loading">
                {t('loading')}
              </div>
            ) : notifications.length === 0 ? (
              <div className="notification-empty">
                {t('notifications.empty')}
              </div>
            ) : (
              notifications.map(notification => (
                <div
                  key={notification.id}
                  className={`notification-item ${notification.is_read ? 'read' : 'unread'}`}
                  onClick={() => handleNotificationClick(notification)}
                >
                  <div 
                    className="notification-icon"
                    style={{ backgroundColor: getTypeColor(notification.notification_type) }}
                  >
                    {notification.icon_url ? (
                      <img src={notification.icon_url} alt="" />
                    ) : (
                      getTypeIcon(notification.notification_type)
                    )}
                  </div>

                  <div className="notification-content">
                    <div className="notification-title">
                      {notification.title_i18n?.[i18n.language] || notification.title}
                    </div>
                    {notification.content && (
                      <div className="notification-text">
                        {notification.content_i18n?.[i18n.language] || notification.content}
                      </div>
                    )}
                    <div className="notification-time">
                      {formatTime(notification.created_at)}
                    </div>
                  </div>

                  {!notification.is_read && (
                    <div className="notification-unread-dot" />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function showNotificationToast(notification) {
  // 显示浏览器通知
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(notification.title, {
      body: notification.content,
      icon: notification.icon_url
    });
  }
}
```

## 验收标准

- [ ] 通知数据库表已创建并正常工作
- [ ] NotificationService 核心服务实现完整
- [ ] GET /api/user/notifications 接口返回通知列表
- [ ] POST /api/user/notifications/:id/read 标记已读正常
- [ ] POST /api/user/notifications/read-all 全部已读正常
- [ ] WebSocket 实时推送通知到在线用户
- [ ] 离线通知持久化，上线后同步
- [ ] 通知过期自动清理机制
- [ ] 前端通知中心组件显示正常
- [ ] 未读数量徽章显示正确
- [ ] 多语言支持正常
- [ ] 单元测试覆盖率 ≥ 80%

## 影响范围

- **数据库**：新增 3 张表
- **user-service**：新增 /api/user/notifications 路由
- **gateway**：WebSocket 推送集成
- **game-client**：新增 NotificationCenter 组件
- **backend/shared**：新增 NotificationService

## 参考

- WebSocket 实时推送最佳实践
- React 状态管理模式
- PostgreSQL JSONB 查询优化

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
| 通知数据库表已创建并正常工作 | ✅ | `notifications`（分类/优先级/标题/正文/模板键+参数/数据/图标/跳转/去重键/渠道/已读/点击/软删除/过期，插入即 `pg_notify('pmg_notifications')`）；模板沿用已有 `notification_templates` + `notification_template_contents`（补充称号/收藏室/公告等模板，中英日）；用户设置沿用已有 `user_push_preferences`（补充站内/推送/邮件开关、时区、临时静音、每小时推送上限）；另有 `notification_broadcasts`（全服公告/活动开始）、`notification_events`（投递/打开分析） |
| NotificationService 核心服务实现完整 | ✅ | `backend/shared/notificationCenter.js`：`notify()`（按偏好过滤 → 模板渲染 → 去重写入 → 记 sent，可在业务事务内调用）、列表/未读/已读/批量/删除/清空/点击、偏好读写、广播创建与按玩家物化、分析、过期清理 |
| GET /api/user/notifications 接口返回通知列表 | ✅ | 实际路径 `GET /v1/notifications`（与 REQ-00099 同一接口；网关统一 `/v1` 前缀） |
| POST /api/user/notifications/:id/read 标记已读正常 | ✅ | `POST|PATCH /v1/notifications/:id/read`（只能操作自己的消息，非法 ID 400、不存在 404） |
| POST /api/user/notifications/read-all 全部已读正常 | ✅ | `POST /v1/notifications/read-all`（等价 `batch-read {all:true}`） |
| WebSocket 实时推送通知到在线用户 | ✅ | `wss://…/ws/messages?token=…`：网关 `WS_TARGETS` 把升级请求代理到 user-service；握手校验 access token 签名与登出黑名单（失败 401）；连接后下发 `hello`（未读数/分类未读）；新消息由 `pg_notify` → user-service 分发器按投递计划推送（`notification`，含最新未读数；免打扰时 `silent`）；支持 `PING`、`READ {id}`；30 秒心跳清理死连接；>1KB 消息压缩。注：gym-service 的 `/ws/notifications` 是团战通知通道，与此独立 |
| 离线通知持久化，上线后同步 | ✅ | 所有消息先落库；离线玩家上线（WS 连接）时补推未读消息（最多 20 条，支持 `since` 增量）；客户端另有 IndexedDB 缓存与 `lastSyncTime` |
| 通知过期自动清理机制 | ✅ | 默认 30 天过期（可按消息指定 1~365 天），查询只返回未过期；user-service 每小时清理过期消息、软删除超过 7 天的消息、90 天前的投递记录、过期 30 天的广播 |
| 前端通知中心组件显示正常 | ✅ | `src/features/profile-notify/messageCenter.js`（见 REQ-00099），新消息 toast |
| 未读数量徽章显示正确 | ✅ | `GET /v1/notifications/unread-count`（总数/按分类/按类型）+ WS 推送实时更新 |
| 多语言支持正常 | ✅ | 消息落库时存模板键与参数（中文正文），读取时按 `?lang=` / `X-Language` 用对应语言模板重新渲染；参数也可按语言覆盖（如活动英/日文名）；分类标签三语 |
| 单元测试覆盖率 ≥ 80% | ⚠️ | 未测覆盖率。`notificationPolicy.test.js`、`notificationCenter.test.js`（内存替身）共 14 例已通过；WS/分发由冒烟覆盖（未运行） |

- 关键事件生成的消息：升级（`trainer_level_ups` 触发器）、成就解锁、称号解锁、获得装饰、好友请求、收到礼物、交易完成、收藏室被点赞/留言/升级、活动开始（`events` 状态变为 active 时写广播，读取时按玩家物化，关闭活动分类的玩家不会收到）、系统公告（管理员 `POST /v1/notifications/admin/broadcast`，可按等级/队伍定向）、新设备登录（安全类）；原 `handlers/notificationHandler.js` 的 EventBus 事件（稀有精灵、Raid、道馆被攻击等，生产 Kafka 未启用）改为走同一个消息中心
- 入口：user-service `src/routes/messageCenter.js`、`src/index.js`（启动消息分发 `notificationRealtime.startDispatcher()` 与 `attach(server)`）；网关 `/v1/notifications/*`、`/ws/messages`
- 迁移：`database/migrations/20260925_131000__e13_notification_center.sql`
- 测试：见上；冒烟"实时推送"4 项（无效 token 被拒、hello、新消息 < 3 秒到达、投递记录）
- 偏差：未新建 notification-service（部署为 PM2 单机，放在 user-service）；`user_notification_settings` 用已有 `user_push_preferences` 代替
- 待验证：① 经 nginx/网关的 WebSocket 升级（`/ws/messages`）；② 两个玩家在线时好友请求实时到达；③ 过期清理任务
