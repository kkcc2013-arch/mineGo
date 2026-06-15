# REQ-00235: 用户反馈与 Bug 报告收集系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00235 |
| 标题 | 用户反馈与 Bug 报告收集系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、gateway、game-client、admin-dashboard、backend/shared |
| 创建时间 | 2026-06-15 22:30 |

## 需求描述

建立完整的用户反馈与 Bug 报告收集系统，支持用户在游戏内直接提交反馈、Bug 报告和功能建议，包含自动截图、设备信息收集、问题分类、优先级排序和状态追踪功能，提升用户满意度并加速问题修复流程。

### 核心功能
1. **多渠道反馈入口** - 游戏内反馈、邮件反馈、应用商店评论抓取
2. **自动信息收集** - 设备信息、操作系统版本、游戏版本、最近操作日志
3. **智能分类** - 自动识别 Bug、功能请求、投诉、建议等类型
4. **优先级排序** - 基于影响范围、用户等级、问题紧急程度自动排序
5. **状态追踪** - 用户可查看反馈处理进度，收到状态变更通知
6. **数据分析** - 反馈趋势分析、热点问题识别、满意度统计

## 技术方案

### 1. 数据库设计

```sql
-- 反馈表
CREATE TABLE feedbacks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type VARCHAR(20) NOT NULL, -- bug, feature, complaint, suggestion, other
  category VARCHAR(50), -- gameplay, payment, social, performance, ui, other
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  priority VARCHAR(10) DEFAULT 'normal', -- critical, high, normal, low
  status VARCHAR(20) DEFAULT 'pending', -- pending, triaged, in_progress, resolved, closed, duplicate
  severity INTEGER DEFAULT 3, -- 1-5, 1为最严重
  
  -- 自动收集的设备信息
  device_info JSONB DEFAULT '{}', -- {os, osVersion, device, screenWidth, screenHeight, language, timezone}
  app_version VARCHAR(20),
  build_number INTEGER,
  
  -- 附件
  screenshots TEXT[], -- 截图URL数组
  logs TEXT[], -- 日志文件URL数组
  attachments TEXT[], -- 其他附件URL数组
  
  -- 分类与处理
  assigned_to INTEGER REFERENCES users(id), -- 指派给的处理人员
  tags TEXT[], -- 标签：['crash', 'payment', 'network', etc.]
  related_issue_id INTEGER, -- 关联的GitHub Issue
  duplicate_of INTEGER REFERENCES feedbacks(id), -- 如果是重复反馈
  
  -- 状态历史
  status_history JSONB DEFAULT '[]',
  
  -- 用户满意度
  satisfaction_rating INTEGER, -- 1-5
  satisfaction_comment TEXT,
  
  -- 时间戳
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  closed_at TIMESTAMP
);

-- 反馈评论表
CREATE TABLE feedback_comments (
  id SERIAL PRIMARY KEY,
  feedback_id INTEGER NOT NULL REFERENCES feedbacks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id), -- 可能是用户或管理员
  is_internal BOOLEAN DEFAULT FALSE, -- 内部评论，用户不可见
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 反馈标签表
CREATE TABLE feedback_tags (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  color VARCHAR(7), -- 十六进制颜色
  description TEXT,
  usage_count INTEGER DEFAULT 0
);

-- 反馈模板表
CREATE TABLE feedback_templates (
  id SERIAL PRIMARY KEY,
  type VARCHAR(20) NOT NULL,
  category VARCHAR(50),
  title_template VARCHAR(200),
  description_template TEXT,
  required_fields JSONB DEFAULT '[]',
  suggested_tags TEXT[],
  is_active BOOLEAN DEFAULT TRUE
);

-- 索引
CREATE INDEX idx_feedbacks_user_id ON feedbacks(user_id);
CREATE INDEX idx_feedbacks_status ON feedbacks(status);
CREATE INDEX idx_feedbacks_type_category ON feedbacks(type, category);
CREATE INDEX idx_feedbacks_priority ON feedbacks(priority);
CREATE INDEX idx_feedbacks_created_at ON feedbacks(created_at DESC);
CREATE INDEX idx_feedbacks_assigned_to ON feedbacks(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX idx_feedbacks_tags ON feedbacks USING GIN(tags);
```

### 2. Gateway 反馈路由

```javascript
// backend/services/gateway/src/routes/feedback.js
const express = require('express');
const router = express.Router();
const { body, query, param, validationResult } = require('express-validator');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const feedbackService = require('../services/feedbackService');

/**
 * @api {post} /api/feedback 提交用户反馈
 */
router.post('/',
  auth,
  rateLimit({ windowMs: 60 * 60 * 1000, max: 10 }), // 每小时最多10条
  [
    body('type').isIn(['bug', 'feature', 'complaint', 'suggestion', 'other']),
    body('category').optional().isIn(['gameplay', 'payment', 'social', 'performance', 'ui', 'other']),
    body('title').trim().isLength({ min: 5, max: 200 }),
    body('description').trim().isLength({ min: 20, max: 5000 }),
    body('deviceInfo').optional().isObject(),
    body('screenshots').optional().isArray({ max: 5 }),
    body('logs').optional().isArray({ max: 3 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', details: errors.array() });
      }

      const feedback = await feedbackService.createFeedback({
        userId: req.user.id,
        ...req.body,
        appVersion: req.headers['x-app-version'],
        buildNumber: parseInt(req.headers['x-build-number'] || '0'),
      });

      res.status(201).json({
        success: true,
        feedbackId: feedback.id,
        message: '反馈提交成功，感谢您的反馈！'
      });
    } catch (error) {
      logger.error('创建反馈失败', { error: error.message, userId: req.user.id });
      res.status(500).json({ error: '提交失败，请稍后重试' });
    }
  }
);

/**
 * @api {get} /api/feedback 获取用户反馈列表
 */
router.get('/',
  auth,
  [
    query('status').optional().isIn(['pending', 'triaged', 'in_progress', 'resolved', 'closed']),
    query('type').optional().isIn(['bug', 'feature', 'complaint', 'suggestion', 'other']),
    query('limit').optional().isInt({ min: 1, max: 50 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    try {
      const { feedbacks, total } = await feedbackService.getUserFeedbacks(
        req.user.id,
        req.query
      );

      res.json({
        feedbacks,
        pagination: {
          total,
          limit: parseInt(req.query.limit || 20),
          offset: parseInt(req.query.offset || 0),
        }
      });
    } catch (error) {
      logger.error('获取反馈列表失败', { error: error.message });
      res.status(500).json({ error: '获取失败' });
    }
  }
);

/**
 * @api {get} /api/feedback/:id 获取反馈详情
 */
router.get('/:id',
  auth,
  async (req, res) => {
    try {
      const feedback = await feedbackService.getFeedbackById(req.params.id, req.user.id);

      if (!feedback) {
        return res.status(404).json({ error: '反馈不存在' });
      }

      res.json(feedback);
    } catch (error) {
      logger.error('获取反馈详情失败', { error: error.message });
      res.status(500).json({ error: '获取失败' });
    }
  }
);

/**
 * @api {post} /api/feedback/:id/comment 添加评论
 */
router.post('/:id/comment',
  auth,
  [
    body('content').trim().isLength({ min: 1, max: 2000 }),
  ],
  async (req, res) => {
    try {
      const comment = await feedbackService.addComment({
        feedbackId: req.params.id,
        userId: req.user.id,
        content: req.body.content,
      });

      res.status(201).json(comment);
    } catch (error) {
      logger.error('添加评论失败', { error: error.message });
      res.status(500).json({ error: '添加失败' });
    }
  }
);

/**
 * @api {post} /api/feedback/:id/rate 评价反馈处理
 */
router.post('/:id/rate',
  auth,
  [
    body('rating').isInt({ min: 1, max: 5 }),
    body('comment').optional().trim().isLength({ max: 500 }),
  ],
  async (req, res) => {
    try {
      await feedbackService.rateFeedback({
        feedbackId: req.params.id,
        userId: req.user.id,
        rating: req.body.rating,
        comment: req.body.comment,
      });

      res.json({ success: true });
    } catch (error) {
      logger.error('评价失败', { error: error.message });
      res.status(500).json({ error: '评价失败' });
    }
  }
);

module.exports = router;
```

### 3. 反馈服务核心逻辑

```javascript
// backend/services/gateway/src/services/feedbackService.js
const db = require('../../../shared/db');
const logger = require('../../../shared/logger');
const s3 = require('../../../shared/s3');
const { nanoid } = require('nanoid');

class FeedbackService {
  /**
   * 创建反馈
   */
  async createFeedback(data) {
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // 处理截图上传
      const screenshotUrls = await this._uploadAttachments(data.screenshots || [], 'screenshots');
      const logUrls = await this._uploadAttachments(data.logs || [], 'logs');

      // 智能分类
      const { type, category, tags, priority, severity } = await this._autoClassify(data);

      // 创建反馈
      const result = await client.query(`
        INSERT INTO feedbacks (
          user_id, type, category, title, description,
          priority, severity, device_info, app_version, build_number,
          screenshots, logs, tags, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending')
        RETURNING *
      `, [
        data.userId,
        type,
        category,
        data.title,
        data.description,
        priority,
        severity,
        JSON.stringify(data.deviceInfo || {}),
        data.appVersion,
        data.buildNumber,
        screenshotUrls,
        logUrls,
        tags,
      ]);

      const feedback = result.rows[0];

      // 记录状态历史
      await this._addStatusHistory(client, feedback.id, null, 'pending', null, '反馈创建');

      await client.query('COMMIT');

      // 异步处理
      this._asyncProcess(feedback.id).catch(err => {
        logger.error('异步处理反馈失败', { feedbackId: feedback.id, error: err.message });
      });

      return feedback;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 智能分类
   */
  async _autoClassify(data) {
    let { type, category } = data;
    const tags = [];
    let priority = 'normal';
    let severity = 3;

    const title = data.title.toLowerCase();
    const desc = data.description.toLowerCase();
    const content = `${title} ${desc}`;

    // 关键词匹配
    const crashKeywords = ['崩溃', '闪退', 'crash', '闪退', '异常退出', '无响应'];
    const paymentKeywords = ['支付', '充值', '付款', 'payment', '无法购买', '扣款'];
    const loginKeywords = ['登录', '登陆', 'login', '无法登录', '账号'];
    const networkKeywords = ['网络', '连接', 'network', '断线', '超时', 'timeout'];
    const performanceKeywords = ['卡顿', '慢', 'lag', '性能', 'performance', '发热'];

    // 检测崩溃
    if (crashKeywords.some(k => content.includes(k))) {
      tags.push('crash');
      severity = 1;
      priority = 'critical';
      if (!category) category = 'performance';
    }

    // 检测支付问题
    if (paymentKeywords.some(k => content.includes(k))) {
      tags.push('payment');
      severity = Math.min(severity, 2);
      priority = priority === 'critical' ? 'critical' : 'high';
      category = 'payment';
    }

    // 检测登录问题
    if (loginKeywords.some(k => content.includes(k))) {
      tags.push('login');
      severity = Math.min(severity, 2);
      category = 'account';
    }

    // 检测网络问题
    if (networkKeywords.some(k => content.includes(k))) {
      tags.push('network');
      category = 'network';
    }

    // 检测性能问题
    if (performanceKeywords.some(k => content.includes(k))) {
      tags.push('performance');
      category = 'performance';
    }

    // 用户等级影响优先级
    const userResult = await db.query('SELECT level, vip_status FROM users WHERE id = $1', [data.userId]);
    if (userResult.rows[0]) {
      const user = userResult.rows[0];
      if (user.vip_status) {
        priority = this._upgradePriority(priority);
        tags.push('vip');
      }
      if (user.level >= 50) {
        priority = this._upgradePriority(priority);
      }
    }

    return { type: type || 'other', category: category || 'other', tags, priority, severity };
  }

  /**
   * 提升优先级
   */
  _upgradePriority(priority) {
    const levels = { low: 'normal', normal: 'high', high: 'critical', critical: 'critical' };
    return levels[priority] || priority;
  }

  /**
   * 异步处理
   */
  async _asyncProcess(feedbackId) {
    // 检查重复反馈
    const duplicate = await this._findDuplicate(feedbackId);
    if (duplicate) {
      await this._markAsDuplicate(feedbackId, duplicate.id);
      return;
    }

    // 自动分派
    await this._autoAssign(feedbackId);

    // 发送通知
    await this._notifyTeam(feedbackId);
  }

  /**
   * 查找重复反馈
   */
  async _findDuplicate(feedbackId) {
    const feedback = await db.query('SELECT * FROM feedbacks WHERE id = $1', [feedbackId]);
    const { title, description, type, category } = feedback.rows[0];

    // 在最近30天内查找相似反馈
    const result = await db.query(`
      SELECT id, title, created_at
      FROM feedbacks
      WHERE id != $1
        AND type = $2
        AND category = $3
        AND created_at > NOW() - INTERVAL '30 days'
        AND status NOT IN ('closed', 'duplicate')
        AND (
          title ILIKE '%' || $4 || '%'
          OR $5::text <% plainto_tsquery('english', description)
        )
      ORDER BY created_at DESC
      LIMIT 1
    `, [feedbackId, type, category, title.substring(0, 20), description]);

    return result.rows[0];
  }

  /**
   * 标记为重复
   */
  async _markAsDuplicate(feedbackId, originalId) {
    await db.query(`
      UPDATE feedbacks
      SET status = 'duplicate',
          duplicate_of = $1,
          status_history = status_history || $2::jsonb
      WHERE id = $3
    `, [
      originalId,
      JSON.stringify({
        from: 'pending',
        to: 'duplicate',
        at: new Date().toISOString(),
        by: 'system',
        note: `自动检测为重复反馈，原反馈 #${originalId}`
      }),
      feedbackId
    ]);
  }

  /**
   * 自动分派
   */
  async _autoAssign(feedbackId) {
    const feedback = await db.query(`
      SELECT category, tags FROM feedbacks WHERE id = $1
    `, [feedbackId]);

    if (!feedback.rows[0]) return;

    const { category, tags } = feedback.rows[0];

    // 根据类别和标签查找合适的处理人员
    let assigneeId = null;

    if (tags.includes('payment')) {
      const result = await db.query(`
        SELECT id FROM users
        WHERE role = 'support' AND team = 'payment'
        ORDER BY RANDOM()
        LIMIT 1
      `);
      assigneeId = result.rows[0]?.id;
    } else if (tags.includes('crash')) {
      const result = await db.query(`
        SELECT id FROM users
        WHERE role = 'developer' AND team = 'backend'
        ORDER BY RANDOM()
        LIMIT 1
      `);
      assigneeId = result.rows[0]?.id;
    }

    if (assigneeId) {
      await db.query(`
        UPDATE feedbacks SET assigned_to = $1 WHERE id = $2
      `, [assigneeId, feedbackId]);
    }
  }

  /**
   * 获取用户反馈列表
   */
  async getUserFeedbacks(userId, { status, type, limit = 20, offset = 0 }) {
    let query = `
      SELECT f.*, 
             COUNT(*) OVER() as total,
             (SELECT COUNT(*) FROM feedback_comments WHERE feedback_id = f.id AND is_internal = FALSE) as comment_count
      FROM feedbacks f
      WHERE f.user_id = $1
    `;
    const params = [userId];
    let paramIndex = 2;

    if (status) {
      query += ` AND f.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (type) {
      query += ` AND f.type = $${paramIndex}`;
      params.push(type);
      paramIndex++;
    }

    query += ` ORDER BY f.created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await db.query(query, params);

    return {
      feedbacks: result.rows,
      total: result.rows[0]?.total || 0,
    };
  }

  /**
   * 添加评论
   */
  async addComment({ feedbackId, userId, content }) {
    const result = await db.query(`
      INSERT INTO feedback_comments (feedback_id, user_id, content)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [feedbackId, userId, content]);

    // 通知相关方
    this._notifyNewComment(feedbackId, userId).catch(err => {
      logger.error('通知评论失败', { error: err.message });
    });

    return result.rows[0];
  }

  /**
   * 上传附件
   */
  async _uploadAttachments(files, type) {
    if (!files || files.length === 0) return [];

    const urls = [];
    for (const file of files) {
      if (file.startsWith('data:')) {
        // Base64 数据
        const key = `feedbacks/${type}/${nanoid()}`;
        const buffer = Buffer.from(file.split(',')[1], 'base64');
        const url = await s3.upload(key, buffer);
        urls.push(url);
      } else {
        urls.push(file);
      }
    }
    return urls;
  }

  /**
   * 添加状态历史
   */
  async _addStatusHistory(client, feedbackId, fromStatus, toStatus, userId, note) {
    await client.query(`
      UPDATE feedbacks
      SET status_history = status_history || $1::jsonb,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [
      JSON.stringify([{
        from: fromStatus,
        to: toStatus,
        at: new Date().toISOString(),
        by: userId || 'system',
        note,
      }]),
      feedbackId
    ]);
  }
}

module.exports = new FeedbackService();
```

### 4. 游戏客户端反馈组件

```javascript
// frontend/game-client/src/components/FeedbackForm.js
import React, { useState, useEffect } from 'react';
import { submitFeedback, uploadScreenshot } from '../api/feedback';
import { captureScreenshot, getDeviceInfo } from '../utils/device';
import { useTranslation } from 'react-i18next';
import './FeedbackForm.css';

const FEEDBACK_TYPES = [
  { value: 'bug', icon: '🐛', label: '反馈类型.bug' },
  { value: 'feature', icon: '💡', label: '反馈类型.feature' },
  { value: 'complaint', icon: '😤', label: '反馈类型.complaint' },
  { value: 'suggestion', icon: '📝', label: '反馈类型.suggestion' },
  { value: 'other', icon: '💬', label: '反馈类型.other' },
];

const CATEGORIES = [
  { value: 'gameplay', label: '反馈类别.gameplay' },
  { value: 'payment', label: '反馈类别.payment' },
  { value: 'social', label: '反馈类别.social' },
  { value: 'performance', label: '反馈类别.performance' },
  { value: 'ui', label: '反馈类别.ui' },
  { value: 'other', label: '反馈类别.other' },
];

export default function FeedbackForm({ onClose, initialType = 'bug' }) {
  const { t } = useTranslation();
  const [formData, setFormData] = useState({
    type: initialType,
    category: '',
    title: '',
    description: '',
    screenshots: [],
    includeDeviceInfo: true,
    includeLogs: true,
  });
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(1);
  const [screenshotPreviews, setScreenshotPreviews] = useState([]);

  // 自动收集设备信息
  const deviceInfo = getDeviceInfo();

  const handleCaptureScreen = async () => {
    try {
      const screenshot = await captureScreenshot();
      const preview = URL.createObjectURL(screenshot);
      setScreenshotPreviews([...screenshotPreviews, preview]);
      setFormData({
        ...formData,
        screenshots: [...formData.screenshots, screenshot],
      });
    } catch (error) {
      console.error('截图失败', error);
    }
  };

  const handleRemoveScreenshot = (index) => {
    const newPreviews = screenshotPreviews.filter((_, i) => i !== index);
    const newScreenshots = formData.screenshots.filter((_, i) => i !== index);
    setScreenshotPreviews(newPreviews);
    setFormData({ ...formData, screenshots: newScreenshots });
  };

  const handleSubmit = async () => {
    if (!formData.title.trim() || !formData.description.trim()) {
      return;
    }

    setLoading(true);
    try {
      // 上传截图
      const uploadedUrls = [];
      for (const screenshot of formData.screenshots) {
        const url = await uploadScreenshot(screenshot);
        uploadedUrls.push(url);
      }

      // 提交反馈
      await submitFeedback({
        type: formData.type,
        category: formData.category || undefined,
        title: formData.title,
        description: formData.description,
        screenshots: uploadedUrls,
        deviceInfo: formData.includeDeviceInfo ? deviceInfo : undefined,
        logs: formData.includeLogs ? await collectRecentLogs() : undefined,
      });

      setStep(3); // 成功页面
    } catch (error) {
      console.error('提交失败', error);
      alert(t('反馈.提交失败'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="feedback-modal-overlay">
      <div className="feedback-modal">
        <button className="close-btn" onClick={onClose}>×</button>

        {step === 1 && (
          <>
            <h2>{t('反馈.标题')}</h2>
            <p className="subtitle">{t('反馈.选择类型')}</p>

            <div className="type-selector">
              {FEEDBACK_TYPES.map(({ value, icon, label }) => (
                <button
                  key={value}
                  className={`type-btn ${formData.type === value ? 'active' : ''}`}
                  onClick={() => setFormData({ ...formData, type: value })}
                >
                  <span className="icon">{icon}</span>
                  <span>{t(label)}</span>
                </button>
              ))}
            </div>

            <select
              value={formData.category}
              onChange={(e) => setFormData({ ...formData, category: e.target.value })}
              className="category-select"
            >
              <option value="">{t('反馈.选择类别')}</option>
              {CATEGORIES.map(({ value, label }) => (
                <option key={value} value={value}>{t(label)}</option>
              ))}
            </select>

            <button
              className="next-btn"
              onClick={() => setStep(2)}
              disabled={!formData.type}
            >
              {t('通用.下一步')}
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <h2>{t('反馈.描述问题')}</h2>

            <input
              type="text"
              placeholder={t('反馈.标题占位')}
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              maxLength={200}
              className="title-input"
            />

            <textarea
              placeholder={t('反馈.描述占位')}
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              maxLength={5000}
              className="description-input"
            />

            <div className="screenshot-section">
              <div className="screenshot-header">
                <span>{t('反馈.截图')} ({screenshotPreviews.length}/5)</span>
                <button
                  onClick={handleCaptureScreen}
                  disabled={screenshotPreviews.length >= 5}
                  className="capture-btn"
                >
                  📷 {t('反馈.截图')}
                </button>
              </div>
              <div className="screenshot-preview">
                {screenshotPreviews.map((preview, index) => (
                  <div key={index} className="screenshot-item">
                    <img src={preview} alt={`Screenshot ${index + 1}`} />
                    <button onClick={() => handleRemoveScreenshot(index)}>×</button>
                  </div>
                ))}
              </div>
            </div>

            <div className="options">
              <label>
                <input
                  type="checkbox"
                  checked={formData.includeDeviceInfo}
                  onChange={(e) => setFormData({ ...formData, includeDeviceInfo: e.target.checked })}
                />
                {t('反馈.包含设备信息')}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={formData.includeLogs}
                  onChange={(e) => setFormData({ ...formData, includeLogs: e.target.checked })}
                />
                {t('反馈.包含日志')}
              </label>
            </div>

            <div className="action-buttons">
              <button onClick={() => setStep(1)} className="back-btn">
                {t('通用.返回')}
              </button>
              <button
                onClick={handleSubmit}
                disabled={!formData.title.trim() || !formData.description.trim() || loading}
                className="submit-btn"
              >
                {loading ? t('反馈.提交中') : t('反馈.提交')}
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <div className="success-page">
            <div className="success-icon">✓</div>
            <h2>{t('反馈.提交成功')}</h2>
            <p>{t('反馈.感谢')}</p>
            <button onClick={onClose} className="close-success-btn">
              {t('通用.关闭')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

### 5. 管理后台反馈管理界面

```javascript
// admin-dashboard/src/pages/FeedbackManagement.jsx
import React, { useState, useEffect } from 'react';
import { getFeedbacks, updateFeedbackStatus, assignFeedback, addComment } from '../api/feedback';
import './FeedbackManagement.css';

export default function FeedbackManagement() {
  const [feedbacks, setFeedbacks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    status: '',
    type: '',
    category: '',
    priority: '',
    assigned: '',
    search: '',
  });
  const [selectedFeedback, setSelectedFeedback] = useState(null);
  const [stats, setStats] = useState({
    total: 0,
    pending: 0,
    inProgress: 0,
    resolved: 0,
    avgResponseTime: 0,
  });

  useEffect(() => {
    loadFeedbacks();
    loadStats();
  }, [filters]);

  const loadFeedbacks = async () => {
    setLoading(true);
    try {
      const data = await getFeedbacks(filters);
      setFeedbacks(data.feedbacks);
    } catch (error) {
      console.error('加载失败', error);
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const data = await getFeedbackStats();
      setStats(data);
    } catch (error) {
      console.error('加载统计失败', error);
    }
  };

  const handleStatusChange = async (feedbackId, newStatus) => {
    try {
      await updateFeedbackStatus(feedbackId, newStatus);
      loadFeedbacks();
      loadStats();
    } catch (error) {
      console.error('更新状态失败', error);
    }
  };

  const handleAssign = async (feedbackId, userId) => {
    try {
      await assignFeedback(feedbackId, userId);
      loadFeedbacks();
    } catch (error) {
      console.error('分派失败', error);
    }
  };

  return (
    <div className="feedback-management">
      <div className="stats-cards">
        <div className="stat-card total">
          <h3>总反馈</h3>
          <span className="value">{stats.total}</span>
        </div>
        <div className="stat-card pending">
          <h3>待处理</h3>
          <span className="value">{stats.pending}</span>
        </div>
        <div className="stat-card progress">
          <h3>处理中</h3>
          <span className="value">{stats.inProgress}</span>
        </div>
        <div className="stat-card resolved">
          <h3>已解决</h3>
          <span className="value">{stats.resolved}</span>
        </div>
        <div className="stat-card avg-time">
          <h3>平均响应时间</h3>
          <span className="value">{stats.avgResponseTime}h</span>
        </div>
      </div>

      <div className="filters">
        <select
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value })}
        >
          <option value="">所有状态</option>
          <option value="pending">待处理</option>
          <option value="triaged">已分类</option>
          <option value="in_progress">处理中</option>
          <option value="resolved">已解决</option>
          <option value="closed">已关闭</option>
        </select>

        <select
          value={filters.priority}
          onChange={(e) => setFilters({ ...filters, priority: e.target.value })}
        >
          <option value="">所有优先级</option>
          <option value="critical">紧急</option>
          <option value="high">高</option>
          <option value="normal">普通</option>
          <option value="low">低</option>
        </select>

        <input
          type="text"
          placeholder="搜索..."
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
        />
      </div>

      <div className="feedback-list">
        {feedbacks.map((feedback) => (
          <div
            key={feedback.id}
            className={`feedback-item priority-${feedback.priority}`}
            onClick={() => setSelectedFeedback(feedback)}
          >
            <div className="feedback-header">
              <span className="id">#{feedback.id}</span>
              <span className={`status ${feedback.status}`}>{feedback.status}</span>
              <span className={`priority ${feedback.priority}`}>{feedback.priority}</span>
            </div>
            <h4>{feedback.title}</h4>
            <div className="feedback-meta">
              <span>用户: {feedback.user_id}</span>
              <span>类型: {feedback.type}</span>
              <span>{new Date(feedback.created_at).toLocaleString()}</span>
            </div>
            <div className="tags">
              {feedback.tags.map((tag) => (
                <span key={tag} className="tag">{tag}</span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {selectedFeedback && (
        <FeedbackDetailModal
          feedback={selectedFeedback}
          onClose={() => setSelectedFeedback(null)}
          onStatusChange={handleStatusChange}
          onAssign={handleAssign}
        />
      )}
    </div>
  );
}
```

### 6. 反馈趋势分析任务

```javascript
// backend/jobs/feedbackAnalysis.js
const db = require('../shared/db');
const logger = require('../shared/logger');

/**
 * 分析反馈趋势
 */
async function analyzeFeedbackTrends() {
  logger.info('开始分析反馈趋势');

  // 最近7天的反馈趋势
  const weeklyTrend = await db.query(`
    SELECT
      DATE(created_at) as date,
      type,
      COUNT(*) as count
    FROM feedbacks
    WHERE created_at > NOW() - INTERVAL '7 days'
    GROUP BY DATE(created_at), type
    ORDER BY date DESC, type
  `);

  // 热点问题（高频出现的关键词）
  const hotIssues = await db.query(`
    SELECT
      unnest(tags) as tag,
      COUNT(*) as count,
      AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/3600) as avg_resolve_hours
    FROM feedbacks
    WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY tag
    HAVING COUNT(*) >= 5
    ORDER BY count DESC
    LIMIT 20
  `);

  // 类别分布
  const categoryDistribution = await db.query(`
    SELECT
      category,
      COUNT(*) as count,
      AVG(satisfaction_rating) as avg_satisfaction
    FROM feedbacks
    WHERE created_at > NOW() - INTERVAL '30 days'
    GROUP BY category
    ORDER BY count DESC
  `);

  // 响应时间统计
  const responseTimeStats = await db.query(`
    SELECT
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY first_response_minutes) as median_minutes,
      PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY first_response_minutes) as p90_minutes,
      AVG(first_response_minutes) as avg_minutes
    FROM (
      SELECT
        f.id,
        EXTRACT(EPOCH FROM (MIN(fc.created_at) - f.created_at))/60 as first_response_minutes
      FROM feedbacks f
      LEFT JOIN feedback_comments fc ON f.id = fc.feedback_id AND fc.is_internal = FALSE
      WHERE f.created_at > NOW() - INTERVAL '30 days'
      GROUP BY f.id, f.created_at
    ) subq
  `);

  // 存储分析结果
  await db.query(`
    INSERT INTO feedback_analytics (
      analyzed_at, weekly_trend, hot_issues, category_distribution, response_time_stats
    ) VALUES (NOW(), $1, $2, $3, $4)
  `, [
    JSON.stringify(weeklyTrend.rows),
    JSON.stringify(hotIssues.rows),
    JSON.stringify(categoryDistribution.rows),
    JSON.stringify(responseTimeStats.rows[0]),
  ]);

  // 检测异常趋势
  await detectAnomalies(weeklyTrend.rows);

  logger.info('反馈趋势分析完成');
}

/**
 * 检测异常趋势
 */
async function detectAnomalies(weeklyTrend) {
  // 如果某类反馈突然增加，发送告警
  const previousWeek = weeklyTrend.filter(row => {
    const date = new Date(row.date);
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    return date < weekAgo;
  });

  const currentWeek = weeklyTrend.filter(row => {
    const date = new Date(row.date);
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    return date >= weekAgo;
  });

  // 按类型聚合
  const previousByType = {};
  previousWeek.forEach(row => {
    previousByType[row.type] = (previousByType[row.type] || 0) + row.count;
  });

  const currentByType = {};
  currentWeek.forEach(row => {
    currentByType[row.type] = (currentByType[row.type] || 0) + row.count;
  });

  // 检测增幅超过50%的类型
  for (const type of Object.keys(currentByType)) {
    const current = currentByType[type];
    const previous = previousByType[type] || 0;

    if (previous > 0 && current > previous * 1.5) {
      await sendAnomalyAlert({
        type,
        previousCount: previous,
        currentCount: current,
        increase: ((current - previous) / previous * 100).toFixed(1),
      });
    }
  }
}

// 定时执行
module.exports = {
  run: analyzeFeedbackTrends,
  schedule: '0 */6 * * *', // 每6小时执行一次
};
```

## 验收标准

- [ ] 用户可在游戏内提交反馈，包含标题、描述、类型、类别
- [ ] 自动收集设备信息（OS、版本、屏幕尺寸等）
- [ ] 支持上传最多5张截图和3个日志文件
- [ ] 智能分类系统自动识别反馈类型和优先级
- [ ] 重复反馈检测准确率 >= 80%
- [ ] 用户可查看自己提交的反馈列表和状态
- [ ] 用户可对反馈处理结果进行满意度评价
- [ ] 管理后台支持按状态、优先级、类型筛选反馈
- [ ] 管理员可分派反馈、添加内部评论、更新状态
- [ ] 反馈趋势分析任务每6小时运行一次
- [ ] 异常趋势自动告警
- [ ] API 接口有完整的单元测试覆盖
- [ ] 前端组件有完整的 E2E 测试覆盖

## 影响范围

- `backend/services/gateway/src/routes/feedback.js` - 新增反馈路由
- `backend/services/gateway/src/services/feedbackService.js` - 新增反馈服务
- `frontend/game-client/src/components/FeedbackForm.js` - 新增反馈表单组件
- `frontend/game-client/src/api/feedback.js` - 新增反馈 API
- `admin-dashboard/src/pages/FeedbackManagement.jsx` - 新增管理页面
- `backend/jobs/feedbackAnalysis.js` - 新增分析任务
- `database/migrations/` - 新增数据库迁移脚本

## 参考

- [UserVoice API](https://developer.uservoice.com/docs/api/)
- [Zendesk Support API](https://developer.zendesk.com/api-reference/)
- [ICU MessageFormat](https://unicode-org.github.io/icu/userguide/format_parse/messages/)
