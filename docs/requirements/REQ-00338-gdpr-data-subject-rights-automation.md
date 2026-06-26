# REQ-00338: GDPR 数据主体权利请求自动化管理系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00338 |
| 标题 | GDPR 数据主体权利请求自动化管理系统 |
| 类别 | 合规/隐私 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、gateway、admin-dashboard、backend/jobs、backend/shared/gdpr、database/migrations |
| 创建时间 | 2026-06-26 09:00 UTC |

## 需求描述

### 背景
GDPR（通用数据保护条例）赋予用户多项数据权利，包括访问权、更正权、删除权、可携带权、限制处理权、反对权等。当前系统需要人工处理这些请求，效率低下且容易遗漏合规期限（GDPR 要求 30 天内响应）。

### 目标
构建一个自动化的 GDPR 数据主体权利请求管理系统，实现：
1. **多渠道请求接入**：用户可通过游戏内、Web、邮件、API 提交请求
2. **身份验证与确认**：自动验证请求者身份，防止冒名请求
3. **请求类型识别**：自动识别请求类型（访问/删除/更正/可携带等）
4. **自动化处理流程**：根据请求类型触发相应的数据处理流水线
5. **合规期限追踪**：监控 30 天合规期限，自动提醒和升级
6. **证据链记录**：完整记录请求处理过程，满足审计要求
7. **数据可携带性**：支持导出用户数据为标准格式（JSON、CSV）

### 用户权利类型
- **访问权（Art. 15）**：用户有权获取其个人数据的副本
- **更正权（Art. 16）**：用户有权更正不准确的数据
- **删除权（Art. 17）**：用户有权要求删除其数据（"被遗忘权"）
- **限制处理权（Art. 18）**：用户有权限制对其数据的处理
- **可携带权（Art. 20）**：用户有权以结构化格式接收其数据
- **反对权（Art. 21）**：用户有权反对特定数据处理活动

## 技术方案

### 1. 数据模型设计

#### gdpr_requests 表
```sql
CREATE TABLE gdpr_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    request_type VARCHAR(50) NOT NULL, -- access, rectification, erasure, restriction, portability, objection
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, verified, processing, completed, rejected
    submission_channel VARCHAR(50) NOT NULL, -- in_game, web, email, api
    
    -- 身份验证信息
    identity_verified BOOLEAN DEFAULT FALSE,
    verification_method VARCHAR(50), -- email, phone, id_document
    verified_at TIMESTAMP,
    
    -- 请求详情
    request_details JSONB, -- 具体请求内容
    affected_data_types TEXT[], -- 涉及的数据类型
    
    -- 处理信息
    assigned_to UUID REFERENCES admin_users(id),
    processing_notes TEXT,
    rejection_reason TEXT,
    
    -- 合规期限
    deadline TIMESTAMP NOT NULL, -- 提交后 30 天
    escalation_sent BOOLEAN DEFAULT FALSE,
    
    -- 响应数据
    response_data JSONB, -- 处理结果
    export_file_url TEXT, -- 可携带权导出文件
    
    -- 审计字段
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP,
    
    CONSTRAINT valid_request_type CHECK (request_type IN ('access', 'rectification', 'erasure', 'restriction', 'portability', 'objection')),
    CONSTRAINT valid_status CHECK (status IN ('pending', 'verified', 'processing', 'completed', 'rejected'))
);

CREATE INDEX idx_gdpr_requests_user ON gdpr_requests(user_id);
CREATE INDEX idx_gdpr_requests_status ON gdpr_requests(status);
CREATE INDEX idx_gdpr_requests_deadline ON gdpr_requests(deadline);
CREATE INDEX idx_gdpr_requests_created ON gdpr_requests(created_at DESC);
```

#### gdpr_request_logs 表（审计日志）
```sql
CREATE TABLE gdpr_request_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES gdpr_requests(id),
    action VARCHAR(100) NOT NULL,
    actor_type VARCHAR(50) NOT NULL, -- system, admin, user
    actor_id UUID,
    details JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gdpr_logs_request ON gdpr_request_logs(request_id);
CREATE INDEX idx_gdpr_logs_created ON gdpr_request_logs(created_at DESC);
```

### 2. 核心服务模块

#### backend/shared/gdpr/GDPRRequestManager.js
```javascript
const { v4: uuidv4 } = require('uuid');
const knex = require('knex');
const crypto = require('crypto');

class GDPRRequestManager {
  constructor(config) {
    this.db = knex(config.database);
    this.requestTypes = {
      access: { priority: 1, autoProcess: true },
      rectification: { priority: 2, autoProcess: true },
      erasure: { priority: 1, autoProcess: false }, // 需要人工审核
      restriction: { priority: 2, autoProcess: true },
      portability: { priority: 1, autoProcess: true },
      objection: { priority: 3, autoProcess: false }
    };
  }

  /**
   * 创建 GDPR 请求
   */
  async createRequest(userId, requestType, details, channel = 'api') {
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 30); // GDPR 要求 30 天内响应

    const request = await this.db('gdpr_requests').insert({
      id: uuidv4(),
      user_id: userId,
      request_type: requestType,
      status: 'pending',
      submission_channel: channel,
      request_details: details,
      affected_data_types: this.identifyDataTypes(requestType),
      deadline,
      created_at: new Date(),
      updated_at: new Date()
    }).returning('*');

    // 记录审计日志
    await this.logAction(request[0].id, 'created', 'user', userId, {
      request_type: requestType,
      channel
    });

    // 触发身份验证流程
    await this.initiateVerification(request[0]);

    return request[0];
  }

  /**
   * 发起身份验证
   */
  async initiateVerification(request) {
    const user = await this.db('users').where('id', request.user_id).first();
    
    // 根据用户可用验证方式选择
    const method = user.phone_verified ? 'phone' : 'email';
    
    // 生成验证码
    const code = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 小时有效期

    await this.db('verification_codes').insert({
      id: uuidv4(),
      user_id: request.user_id,
      code,
      type: 'gdpr_verification',
      expires_at: expiresAt
    });

    // 发送验证码（邮件/短信）
    if (method === 'email') {
      await this.sendEmailVerification(user.email, code, request.request_type);
    } else {
      await this.sendSMSVerification(user.phone, code, request.request_type);
    }

    await this.logAction(request.id, 'verification_initiated', 'system', null, {
      method
    });
  }

  /**
   * 验证身份
   */
  async verifyIdentity(requestId, code, ipAddress, userAgent) {
    const request = await this.db('gdpr_requests').where('id', requestId).first();
    if (!request) throw new Error('Request not found');
    if (request.status !== 'pending') throw new Error('Invalid request status');

    // 验证验证码
    const verification = await this.db('verification_codes')
      .where('user_id', request.user_id)
      .where('code', code)
      .where('type', 'gdpr_verification')
      .where('expires_at', '>', new Date())
      .first();

    if (!verification) {
      await this.logAction(requestId, 'verification_failed', 'user', request.user_id, {
        ip_address: ipAddress
      });
      throw new Error('Invalid or expired verification code');
    }

    // 标记验证通过
    await this.db('gdpr_requests')
      .where('id', requestId)
      .update({
        identity_verified: true,
        verification_method: 'email',
        verified_at: new Date(),
        status: 'verified',
        updated_at: new Date()
      });

    // 删除验证码
    await this.db('verification_codes').where('id', verification.id).del();

    await this.logAction(requestId, 'verified', 'user', request.user_id, {
      ip_address: ipAddress,
      user_agent: userAgent
    });

    // 自动处理请求
    if (this.requestTypes[request.request_type].autoProcess) {
      await this.processRequest(requestId);
    }

    return { verified: true };
  }

  /**
   * 处理请求
   */
  async processRequest(requestId) {
    const request = await this.db('gdpr_requests').where('id', requestId).first();
    if (!request || request.status !== 'verified') {
      throw new Error('Request not ready for processing');
    }

    await this.db('gdpr_requests')
      .where('id', requestId)
      .update({ status: 'processing', updated_at: new Date() });

    await this.logAction(requestId, 'processing_started', 'system', null);

    try {
      let result;
      switch (request.request_type) {
        case 'access':
          result = await this.processAccessRequest(request);
          break;
        case 'portability':
          result = await this.processPortabilityRequest(request);
          break;
        case 'rectification':
          result = await this.processRectificationRequest(request);
          break;
        case 'restriction':
          result = await this.processRestrictionRequest(request);
          break;
        case 'erasure':
          // 删除请求需要人工审核
          await this.logAction(requestId, 'pending_review', 'system', null);
          return;
        case 'objection':
          // 反对请求需要人工审核
          await this.logAction(requestId, 'pending_review', 'system', null);
          return;
      }

      // 标记完成
      await this.db('gdpr_requests')
        .where('id', requestId)
        .update({
          status: 'completed',
          response_data: result,
          completed_at: new Date(),
          updated_at: new Date()
        });

      await this.logAction(requestId, 'completed', 'system', null, {
        response_summary: result?.summary
      });

      // 通知用户
      await this.notifyUser(request.user_id, 'completed', request.request_type, result);

    } catch (error) {
      await this.logAction(requestId, 'processing_failed', 'system', null, {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 处理访问请求
   */
  async processAccessRequest(request) {
    const userId = request.user_id;
    
    // 收集所有用户数据
    const userData = {
      user: await this.db('users').where('id', userId).first(),
      pokemon: await this.db('pokemon').where('user_id', userId),
      transactions: await this.db('transactions').where('user_id', userId),
      sessions: await this.db('sessions').where('user_id', userId),
      friends: await this.db('friendships')
        .where('user_id', userId)
        .orWhere('friend_id', userId),
      activities: await this.db('user_activities')
        .where('user_id', userId)
        .limit(1000)
    };

    return {
      summary: 'All personal data collected',
      data_types: Object.keys(userData),
      total_records: Object.values(userData).reduce((sum, arr) => 
        sum + (Array.isArray(arr) ? arr.length : 1), 0
      ),
      exported_at: new Date(),
      data: userData
    };
  }

  /**
   * 处理可携带权请求
   */
  async processPortabilityRequest(request) {
    const userId = request.user_id;
    
    // 收集用户数据
    const userData = await this.processAccessRequest(request);
    
    // 生成 JSON 导出文件
    const fileName = `user_data_${userId}_${Date.now()}.json`;
    const filePath = await this.generateExportFile(userData.data, fileName, 'json');
    
    // 同时生成 CSV 格式
    const csvFileName = `user_data_${userId}_${Date.now()}.csv`;
    const csvFilePath = await this.generateCSVExport(userData.data, csvFileName);

    await this.db('gdpr_requests')
      .where('id', request.id)
      .update({
        export_file_url: filePath,
        response_data: { ...userData.response_data, csv_file: csvFilePath }
      });

    return {
      summary: 'Data exported successfully',
      json_file: filePath,
      csv_file: csvFilePath,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 天有效期
    };
  }

  /**
   * 处理更正请求
   */
  async processRectificationRequest(request) {
    const corrections = request.request_details.corrections;
    const userId = request.user_id;
    
    const updates = {};
    for (const [field, value] of Object.entries(corrections)) {
      if (this.isEditableField(field)) {
        updates[field] = value;
      }
    }

    if (Object.keys(updates).length > 0) {
      await this.db('users').where('id', userId).update(updates);
    }

    return {
      summary: 'Data rectified successfully',
      updated_fields: Object.keys(updates)
    };
  }

  /**
   * 处理限制处理请求
   */
  async processRestrictionRequest(request) {
    const userId = request.user_id;
    
    // 标记用户为限制处理状态
    await this.db('users').where('id', userId).update({
      processing_restricted: true,
      restriction_reason: request.request_details.reason
    });

    return {
      summary: 'Processing restricted',
      restricted_at: new Date()
    };
  }

  /**
   * 管理员审核删除请求
   */
  async reviewErasureRequest(requestId, adminId, approved, reason) {
    const request = await this.db('gdpr_requests').where('id', requestId).first();
    if (!request || request.request_type !== 'erasure') {
      throw new Error('Invalid request');
    }

    if (approved) {
      // 执行数据删除
      await this.executeErasure(request.user_id, request.request_details);
      
      await this.db('gdpr_requests')
        .where('id', requestId)
        .update({
          status: 'completed',
          completed_at: new Date(),
          updated_at: new Date()
        });

      await this.logAction(requestId, 'approved_and_executed', 'admin', adminId, {
        reason
      });

      await this.notifyUser(request.user_id, 'completed', 'erasure');
    } else {
      await this.db('gdpr_requests')
        .where('id', requestId)
        .update({
          status: 'rejected',
          rejection_reason: reason,
          updated_at: new Date()
        });

      await this.logAction(requestId, 'rejected', 'admin', adminId, {
        reason
      });

      await this.notifyUser(request.user_id, 'rejected', 'erasure', { reason });
    }
  }

  /**
   * 执行数据删除
   */
  async executeErasure(userId, details) {
    // 检查是否有法定保留义务（如交易记录）
    const retainTransactions = details.retain_legal_records !== false;
    
    await this.db.transaction(async (trx) => {
      // 删除精灵数据
      await trx('pokemon').where('user_id', userId).del();
      
      // 删除社交数据
      await trx('friendships')
        .where('user_id', userId)
        .orWhere('friend_id', userId)
        .del();
      
      // 删除会话数据
      await trx('sessions').where('user_id', userId).del();
      
      // 处理交易记录（根据法律要求）
      if (!retainTransactions) {
        await trx('transactions').where('user_id', userId).del();
      } else {
        // 匿名化处理
        await trx('transactions')
          .where('user_id', userId)
          .update({
            user_id: null,
            anonymized: true
          });
      }
      
      // 匿名化用户账户
      await trx('users').where('id', userId).update({
        email: `deleted_${userId}@deleted.invalid`,
        username: `deleted_user_${userId}`,
        phone: null,
        deleted_at: new Date(),
        is_deleted: true
      });
    });
  }

  /**
   * 记录审计日志
   */
  async logAction(requestId, action, actorType, actorId, details = {}) {
    await this.db('gdpr_request_logs').insert({
      id: uuidv4(),
      request_id: requestId,
      action,
      actor_type: actorType,
      actor_id: actorId,
      details,
      created_at: new Date()
    });
  }

  /**
   * 监控合规期限
   */
  async checkDeadlines() {
    const now = new Date();
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    // 查找即将超期的请求
    const urgentRequests = await this.db('gdpr_requests')
      .where('status', 'in', ['pending', 'verified', 'processing'])
      .where('deadline', '<=', threeDaysFromNow)
      .where('deadline', '>', now)
      .where('escalation_sent', false);

    for (const request of urgentRequests) {
      await this.sendDeadlineAlert(request);
      await this.db('gdpr_requests')
        .where('id', request.id)
        .update({ escalation_sent: true });
    }

    // 查找已超期的请求
    const overdueRequests = await this.db('gdpr_requests')
      .where('status', 'in', ['pending', 'verified', 'processing'])
      .where('deadline', '<', now);

    for (const request of overdueRequests) {
      await this.sendOverdueAlert(request);
    }

    return {
      urgent: urgentRequests.length,
      overdue: overdueRequests.length
    };
  }

  /**
   * 获取请求统计
   */
  async getStatistics(period = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - period);

    const stats = await this.db('gdpr_requests')
      .where('created_at', '>=', startDate)
      .select(
        this.db.raw('COUNT(*) as total_requests'),
        this.db.raw('COUNT(*) FILTER (WHERE status = ?) as pending', ['pending']),
        this.db.raw('COUNT(*) FILTER (WHERE status = ?) as completed', ['completed']),
        this.db.raw('COUNT(*) FILTER (WHERE status = ?) as rejected', ['rejected']),
        this.db.raw('AVG(EXTRACT(EPOCH FROM (completed_at - created_at))/86400) FILTER (WHERE status = ?) as avg_completion_days', ['completed'])
      )
      .first();

    const byType = await this.db('gdpr_requests')
      .where('created_at', '>=', startDate)
      .groupBy('request_type')
      .select('request_type', this.db.raw('COUNT(*) as count'));

    return {
      ...stats,
      by_type: byType,
      period_days: period
    };
  }

  // 辅助方法
  identifyDataTypes(requestType) {
    const typeMap = {
      access: ['all'],
      portability: ['all'],
      erasure: ['all'],
      rectification: ['personal'],
      restriction: ['all'],
      objection: ['processing']
    };
    return typeMap[requestType] || ['unknown'];
  }

  isEditableField(field) {
    const editableFields = ['username', 'email', 'phone', 'timezone', 'language'];
    return editableFields.includes(field);
  }

  async generateExportFile(data, fileName, format) {
    // 实现文件生成和上传逻辑
    // 返回文件 URL
    return `https://exports.minego.game/${fileName}`;
  }

  async generateCSVExport(data, fileName) {
    // 实现 CSV 导出
    return `https://exports.minego.game/${fileName}`;
  }

  async sendEmailVerification(email, code, requestType) {
    // 发送验证邮件
  }

  async sendSMSVerification(phone, code, requestType) {
    // 发送验证短信
  }

  async notifyUser(userId, status, requestType, details = {}) {
    // 通知用户处理结果
  }

  async sendDeadlineAlert(request) {
    // 发送期限警告
  }

  async sendOverdueAlert(request) {
    // 发送超期警告
  }
}

module.exports = GDPRRequestManager;
```

### 3. API 路由

#### backend/services/user-service/src/routes/gdpr.js
```javascript
const express = require('express');
const router = express.Router();
const GDPRRequestManager = require('../../../shared/gdpr/GDPRRequestManager');
const { authenticate, requireAdmin } = require('../../../shared/middleware/auth');
const config = require('../config');

const gdprManager = new GDPRRequestManager(config);

/**
 * @route   POST /api/user/gdpr/request
 * @desc    提交 GDPR 请求
 * @access  Private
 */
router.post('/request', authenticate, async (req, res) => {
  try {
    const { request_type, details } = req.body;
    const userId = req.user.id;
    const channel = req.headers['x-client-type'] || 'api';

    const request = await gdprManager.createRequest(
      userId,
      request_type,
      details,
      channel
    );

    res.status(201).json({
      success: true,
      request_id: request.id,
      message: 'Request submitted. Please verify your identity.',
      verification_required: true
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @route   POST /api/user/gdpr/verify
 * @desc    验证身份
 * @access  Private
 */
router.post('/verify', authenticate, async (req, res) => {
  try {
    const { request_id, code } = req.body;
    
    const result = await gdprManager.verifyIdentity(
      request_id,
      code,
      req.ip,
      req.headers['user-agent']
    );

    res.json({
      success: true,
      message: 'Identity verified successfully',
      auto_processing: result.autoProcessing
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @route   GET /api/user/gdpr/requests
 * @desc    获取用户的 GDPR 请求列表
 * @access  Private
 */
router.get('/requests', authenticate, async (req, res) => {
  try {
    const requests = await gdprManager.getUserRequests(req.user.id);
    res.json({ requests });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   GET /api/user/gdpr/request/:id
 * @desc    获取请求详情
 * @access  Private
 */
router.get('/request/:id', authenticate, async (req, res) => {
  try {
    const request = await gdprManager.getRequest(req.params.id, req.user.id);
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    res.json({ request });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   GET /api/user/gdpr/download/:id
 * @desc    下载数据导出文件
 * @access  Private
 */
router.get('/download/:id', authenticate, async (req, res) => {
  try {
    const request = await gdprManager.getRequest(req.params.id, req.user.id);
    if (!request || request.request_type !== 'portability') {
      return res.status(404).json({ error: 'Export not found' });
    }

    // 重定向到文件下载链接
    res.redirect(request.export_file_url);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   GET /api/admin/gdpr/requests
 * @desc    获取所有 GDPR 请求（管理员）
 * @access  Admin
 */
router.get('/admin/requests', authenticate, requireAdmin, async (req, res) => {
  try {
    const { status, type, page = 1, limit = 20 } = req.query;
    
    const result = await gdprManager.getAllRequests({
      status,
      type,
      page: parseInt(page),
      limit: parseInt(limit)
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   POST /api/admin/gdpr/review/:id
 * @desc    审核删除请求（管理员）
 * @access  Admin
 */
router.post('/admin/review/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { approved, reason } = req.body;
    
    await gdprManager.reviewErasureRequest(
      req.params.id,
      req.user.id,
      approved,
      reason
    );

    res.json({
      success: true,
      message: approved ? 'Request approved and executed' : 'Request rejected'
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/**
 * @route   GET /api/admin/gdpr/statistics
 * @desc    获取 GDPR 统计数据（管理员）
 * @access  Admin
 */
router.get('/admin/statistics', authenticate, requireAdmin, async (req, res) => {
  try {
    const { period = 30 } = req.query;
    const stats = await gdprManager.getStatistics(parseInt(period));
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
```

### 4. 定时任务

#### backend/jobs/gdpr-monitor.js
```javascript
const cron = require('node-cron');
const GDPRRequestManager = require('../shared/gdpr/GDPRRequestManager');
const config = require('../config');

const gdprManager = new GDPRRequestManager(config);

/**
 * 每小时检查 GDPR 请求期限
 */
cron.schedule('0 * * * *', async () => {
  console.log('[GDPR Monitor] Checking request deadlines...');
  
  try {
    const result = await gdprManager.checkDeadlines();
    console.log(`[GDPR Monitor] Urgent: ${result.urgent}, Overdue: ${result.overdue}`);
  } catch (error) {
    console.error('[GDPR Monitor] Error:', error);
  }
});

/**
 * 每天清理过期的导出文件
 */
cron.schedule('0 2 * * *', async () => {
  console.log('[GDPR Monitor] Cleaning up expired export files...');
  // 实现文件清理逻辑
});

console.log('[GDPR Monitor] Started');
```

### 5. 管理后台界面

#### admin-dashboard/src/pages/GDPRRequests.jsx
```jsx
import React, { useState, useEffect } from 'react';
import { Table, Tag, Button, Modal, Input, message, Statistic, Card } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';

const GDPRRequests = () => {
  const [requests, setRequests] = useState([]);
  const [statistics, setStatistics] = useState({});
  const [loading, setLoading] = useState(false);
  const [reviewModal, setReviewModal] = useState({ visible: false, request: null });

  useEffect(() => {
    fetchRequests();
    fetchStatistics();
  }, []);

  const fetchRequests = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/gdpr/requests');
      const data = await res.json();
      setRequests(data.requests);
    } catch (error) {
      message.error('Failed to fetch requests');
    }
    setLoading(false);
  };

  const fetchStatistics = async () => {
    try {
      const res = await fetch('/api/admin/gdpr/statistics');
      const data = await res.json();
      setStatistics(data);
    } catch (error) {
      console.error('Failed to fetch statistics');
    }
  };

  const handleReview = async (approved, reason) => {
    try {
      const res = await fetch(`/api/admin/gdpr/review/${reviewModal.request.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved, reason })
      });

      if (res.ok) {
        message.success(approved ? 'Request approved' : 'Request rejected');
        fetchRequests();
        setReviewModal({ visible: false, request: null });
      }
    } catch (error) {
      message.error('Failed to process request');
    }
  };

  const columns = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      render: (id) => id.substring(0, 8)
    },
    {
      title: 'User',
      dataIndex: 'user_id',
      key: 'user_id',
      render: (id) => id.substring(0, 8)
    },
    {
      title: 'Type',
      dataIndex: 'request_type',
      key: 'type',
      render: (type) => (
        <Tag color={type === 'erasure' ? 'red' : 'blue'}>
          {type.toUpperCase()}
        </Tag>
      )
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status) => {
        const colors = {
          pending: 'orange',
          verified: 'cyan',
          processing: 'blue',
          completed: 'green',
          rejected: 'red'
        };
        return <Tag color={colors[status]}>{status.toUpperCase()}</Tag>;
      }
    },
    {
      title: 'Deadline',
      dataIndex: 'deadline',
      key: 'deadline',
      render: (date) => new Date(date).toLocaleDateString()
    },
    {
      title: 'Days Left',
      key: 'days_left',
      render: (_, record) => {
        const days = Math.ceil(
          (new Date(record.deadline) - new Date()) / (1000 * 60 * 60 * 24)
        );
        const color = days <= 3 ? 'red' : days <= 7 ? 'orange' : 'green';
        return <Tag color={color}>{days} days</Tag>;
      }
    },
    {
      title: 'Action',
      key: 'action',
      render: (_, record) => {
        if (record.request_type === 'erasure' && record.status === 'verified') {
          return (
            <Button
              type="primary"
              onClick={() => setReviewModal({ visible: true, request: record })}
            >
              Review
            </Button>
          );
        }
        return null;
      }
    }
  ];

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <Statistic.Group>
          <Statistic
            title="Total Requests (30 days)"
            value={statistics.total_requests || 0}
          />
          <Statistic
            title="Pending"
            value={statistics.pending || 0}
            valueStyle={{ color: '#faad14' }}
          />
          <Statistic
            title="Completed"
            value={statistics.completed || 0}
            valueStyle={{ color: '#52c41a' }}
          />
          <Statistic
            title="Avg Completion Time"
            value={statistics.avg_completion_days?.toFixed(1) || 0}
            suffix="days"
          />
        </Statistic.Group>
      </Card>

      <Table
        columns={columns}
        dataSource={requests}
        loading={loading}
        rowKey="id"
      />

      <Modal
        title="Review Deletion Request"
        visible={reviewModal.visible}
        onCancel={() => setReviewModal({ visible: false, request: null })}
        footer={null}
      >
        <p>
          User <strong>{reviewModal.request?.user_id?.substring(0, 8)}</strong> 
          requests deletion of all personal data.
        </p>
        <Input.TextArea
          id="rejection-reason"
          placeholder="Reason for rejection (if applicable)"
          rows={3}
        />
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <Button
            icon={<CloseCircleOutlined />}
            onClick={() => handleReview(false, document.getElementById('rejection-reason').value)}
            style={{ marginRight: 8 }}
          >
            Reject
          </Button>
          <Button
            type="primary"
            icon={<CheckCircleOutlined />}
            onClick={() => handleReview(true)}
          >
            Approve & Delete Data
          </Button>
        </div>
      </Modal>
    </div>
  );
};

export default GDPRRequests;
```

### 6. 游戏内集成

#### frontend/game-client/src/components/GDPRPanel.js
```javascript
import React, { useState } from 'react';
import { Button, Modal, Form, Select, Input, message } from 'antd';

const GDPRPanel = ({ visible, onClose }) => {
  const [form] = Form.useForm();
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (values) => {
    try {
      const res = await fetch('/api/user/gdpr/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify(values)
      });

      const data = await res.json();

      if (res.ok) {
        message.success('Request submitted! Check your email for verification.');
        setSubmitted(true);
        form.resetFields();
      } else {
        message.error(data.error);
      }
    } catch (error) {
      message.error('Failed to submit request');
    }
  };

  return (
    <Modal
      title="Data Rights Request"
      visible={visible}
      onCancel={onClose}
      footer={null}
    >
      {submitted ? (
        <div style={{ textAlign: 'center', padding: '20px' }}>
          <p>Your request has been submitted.</p>
          <p>Please check your email to verify your identity.</p>
          <Button onClick={() => { setSubmitted(false); onClose(); }}>
            Close
          </Button>
        </div>
      ) : (
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item
            name="request_type"
            label="Request Type"
            rules={[{ required: true }]}
          >
            <Select placeholder="Select request type">
              <Select.Option value="access">
                Access my data (View what we have)
              </Select.Option>
              <Select.Option value="portability">
                Export my data (Download a copy)
              </Select.Option>
              <Select.Option value="rectification">
                Correct my data (Fix errors)
              </Select.Option>
              <Select.Option value="restriction">
                Restrict processing (Limit how we use it)
              </Select.Option>
              <Select.Option value="erasure">
                Delete my data (Account deletion)
              </Select.Option>
              <Select.Option value="objection">
                Object to processing (Stop specific uses)
              </Select.Option>
            </Select>
          </Form.Item>

          <Form.Item name="details" label="Additional Details">
            <Input.TextArea
              rows={4}
              placeholder="Provide any additional information..."
            />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" block>
              Submit Request
            </Button>
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
};

export default GDPRPanel;
```

## 验收标准

- [ ] 用户可通过游戏内、Web、API 提交 GDPR 请求
- [ ] 系统自动发送验证码并验证用户身份
- [ ] 访问请求可在 24 小时内自动完成并返回数据
- [ ] 可携带请求自动生成 JSON/CSV 导出文件
- [ ] 删除请求需管理员审核后才执行
- [ ] 系统自动监控 30 天合规期限并提前警告
- [ ] 所有请求处理过程完整记录在审计日志中
- [ ] 管理后台可查看所有请求并进行审核
- [ ] 提供 GDPR 请求统计数据和报表
- [ ] 导出文件在 7 天后自动过期删除
- [ ] 支持多语言请求提交流程

## 影响范围

### 新增文件
- `backend/shared/gdpr/GDPRRequestManager.js` - 核心管理器
- `backend/services/user-service/src/routes/gdpr.js` - API 路由
- `backend/jobs/gdpr-monitor.js` - 定时监控任务
- `admin-dashboard/src/pages/GDPRRequests.jsx` - 管理后台界面
- `frontend/game-client/src/components/GDPRPanel.js` - 游戏内界面

### 数据库迁移
- `database/migrations/xxx_create_gdpr_tables.sql` - 创建 GDPR 相关表

### 影响服务
- `user-service` - 新增 GDPR API 路由
- `gateway` - 路由配置
- `admin-dashboard` - 新增管理页面
- `backend/jobs` - 新增监控任务

## 参考

- [GDPR 官方文本](https://gdpr-info.eu/)
- [GDPR 数据主体权利指南](https://ico.org.uk/for-organisations/guide-to-data-protection/guide-to-the-general-data-protection-regulation-gdpr/individual-rights/)
- [GDPR 合规检查清单](https://gdpr.eu/checklist/)
- [WCAG 2.1 可访问性标准](https://www.w3.org/WAI/WCAG21/quickref/)
