# REQ-00261: 游戏内实时通知中心与消息推送系统

## 元信息

| 字段 | 值 |
|------|-----|
| 编号 | REQ-00261 |
| 标题 | 游戏内实时通知中心与消息推送系统 |
| 类别 | 前端体验 |
| 优先级 | P1 |
| 状态 | new |
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
