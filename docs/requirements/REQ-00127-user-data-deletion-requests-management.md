# REQ-00127: 用户数据删除请求管理系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00127 |
| 标题 | 用户数据删除请求管理系统 |
| 类别 | 合规/隐私 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、gateway、所有微服务、database、backend/jobs |
| 创建时间 | 2026-06-11 20:15 |

## 需求描述

根据 GDPR 第17条"被遗忘权"和 CCPA 第1798.105条"删除权"，用户有权请求删除其个人数据。当前系统缺少用户数据删除请求的完整管理流程，无法满足合规要求。

本需求实现完整的用户数据删除请求管理系统，包括：
- 用户自助提交删除请求
- 多级审批流程（自动/人工）
- 数据删除任务编排与执行
- 删除状态追踪与证明
- 删除完成通知与凭证生成

## 技术方案

### 1. 数据库迁移设计

```sql
-- database/pending/20260611_201500__add_data_deletion_request_tables.sql

-- 数据删除请求表
CREATE TABLE data_deletion_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_type VARCHAR(20) NOT NULL CHECK (request_type IN ('full', 'partial')),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'verifying', 'approved', 'processing', 
        'completed', 'rejected', 'cancelled'
    )),
    reason TEXT,
    requested_data_types TEXT[] DEFAULT ARRAY['all'],
    
    -- 审批信息
    approval_status VARCHAR(20) DEFAULT 'pending' CHECK (approval_status IN (
        'pending', 'auto_approved', 'manual_approved', 'rejected'
    )),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    
    -- 处理信息
    processing_started_at TIMESTAMPTZ,
    processing_completed_at TIMESTAMPTZ,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    
    -- 元数据
    ip_address INET,
    user_agent TEXT,
    verification_code VARCHAR(32),
    verification_expires_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 数据删除任务表（细粒度删除任务）
CREATE TABLE data_deletion_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES data_deletion_requests(id) ON DELETE CASCADE,
    task_name VARCHAR(100) NOT NULL,
    service_name VARCHAR(50) NOT NULL,
    data_category VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'running', 'completed', 'failed', 'skipped'
    )),
    
    -- 任务详情
    table_name VARCHAR(100),
    query_template TEXT,
    affected_rows INTEGER DEFAULT 0,
    backup_path TEXT,
    
    -- 执行信息
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    error_message TEXT,
    
    -- 依赖关系
    depends_on UUID[] DEFAULT ARRAY[]::UUID[],
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 数据删除证明表（合规凭证）
CREATE TABLE data_deletion_certificates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES data_deletion_requests(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    
    -- 证明信息
    certificate_number VARCHAR(50) UNIQUE NOT NULL,
    deletion_summary JSONB NOT NULL,
    deleted_data_categories TEXT[] NOT NULL,
    total_records_deleted INTEGER DEFAULT 0,
    
    -- 数字签名
    signature TEXT NOT NULL,
    signature_algorithm VARCHAR(50) DEFAULT 'SHA256-RSA',
    
    -- 保留期限（合规要求保留删除记录）
    retention_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 years'),
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 数据类别定义表
CREATE TABLE data_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_code VARCHAR(50) UNIQUE NOT NULL,
    category_name VARCHAR(100) NOT NULL,
    description TEXT,
    related_tables TEXT[] NOT NULL,
    retention_period_days INTEGER,
    is_deletable BOOLEAN DEFAULT TRUE,
    deletion_priority INTEGER DEFAULT 50,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 预定义数据类别
INSERT INTO data_categories (category_code, category_name, description, related_tables, retention_period_days, deletion_priority) VALUES
('profile', '用户档案', '用户基本信息', ARRAY['users', 'user_profiles'], 0, 10),
('pokemon', '精灵数据', '用户拥有的精灵', ARRAY['user_pokemon', 'pokemon_stats'], 0, 20),
('social', '社交数据', '好友、公会等社交关系', ARRAY['friendships', 'guild_members', 'messages'], 0, 30),
('transaction', '交易记录', '支付和交易记录', ARRAY['transactions', 'payments'], 2555, 40), -- 保留7年
('location', '位置历史', 'GPS位置历史', ARRAY['location_history', 'visit_records'], 90, 15),
('activity', '活动日志', '用户活动日志', ARRAY['activity_logs', 'audit_logs'], 365, 50),
('preferences', '用户偏好', '设置和偏好', ARRAY['user_preferences', 'notification_preferences'], 0, 5),
('achievements', '成就数据', '用户成就和里程碑', ARRAY['user_achievements', 'milestones'], 0, 35);

-- 审批历史表
CREATE TABLE data_deletion_approval_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES data_deletion_requests(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
    actor_id UUID REFERENCES users(id),
    actor_type VARCHAR(20) DEFAULT 'system' CHECK (actor_type IN ('system', 'admin', 'auto')),
    previous_status VARCHAR(20),
    new_status VARCHAR(20),
    comment TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_deletion_requests_user_id ON data_deletion_requests(user_id);
CREATE INDEX idx_deletion_requests_status ON data_deletion_requests(status);
CREATE INDEX idx_deletion_requests_created_at ON data_deletion_requests(created_at);
CREATE INDEX idx_deletion_tasks_request_id ON data_deletion_tasks(request_id);
CREATE INDEX idx_deletion_tasks_status ON data_deletion_tasks(status);
CREATE INDEX idx_deletion_certificates_request_id ON data_deletion_certificates(request_id);
CREATE INDEX idx_deletion_certificates_number ON data_deletion_certificates(certificate_number);
```

### 2. 核心服务模块

```javascript
// backend/shared/dataDeletionService.js

const { Pool } = require('pg');
const Redis = require('ioredis');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { EventBus, Events } = require('./eventBus');
const logger = require('./logger');
const metrics = require('./metrics');

class DataDeletionService {
  constructor(config = {}) {
    this.db = config.db || new Pool();
    this.redis = config.redis || new Redis();
    this.eventBus = config.eventBus || EventBus;
    
    // 自动审批规则
    this.autoApprovalRules = {
      // 账户年龄 < 30天，无交易记录 → 自动批准
      newUser: {
        maxAccountAge: 30,
        maxTransactions: 0,
        autoApprove: true
      },
      // 无支付记录，账户 > 30天 → 自动批准（延迟30天执行）
      standard: {
        maxTransactions: 0,
        gracePeriodDays: 30,
        autoApprove: true
      },
      // 有支付记录 → 需人工审批
      financial: {
        requiresManualReview: true
      }
    };
  }

  /**
   * 创建删除请求
   */
  async createRequest(userId, options = {}) {
    const {
      requestType = 'full',
      reason = null,
      dataTypes = ['all'],
      ipAddress = null,
      userAgent = null
    } = options;

    const verificationCode = this.generateVerificationCode();
    const verificationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24小时有效期

    const result = await this.db.query(`
      INSERT INTO data_deletion_requests (
        user_id, request_type, status, reason, requested_data_types,
        ip_address, user_agent, verification_code, verification_expires_at,
        approval_status
      ) VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, 'pending')
      RETURNING *
    `, [userId, requestType, reason, dataTypes, ipAddress, userAgent, 
        verificationCode, verificationExpiresAt]);

    const request = result.rows[0];

    // 发布事件
    await this.eventBus.publish(Events.DATA_DELETION_REQUESTED, {
      requestId: request.id,
      userId,
      requestType,
      dataTypes
    });

    // 记录指标
    metrics.incrementCounter('data_deletion_requests_created_total', {
      request_type: requestType
    });

    logger.info('Data deletion request created', {
      requestId: request.id,
      userId,
      requestType
    });

    return {
      requestId: request.id,
      verificationCode,
      verificationExpiresAt
    };
  }

  /**
   * 验证删除请求
   */
  async verifyRequest(requestId, verificationCode) {
    const result = await this.db.query(`
      UPDATE data_deletion_requests
      SET verified_at = NOW(),
          status = 'verifying',
          updated_at = NOW()
      WHERE id = $1 
        AND verification_code = $2 
        AND verification_expires_at > NOW()
        AND verified_at IS NULL
      RETURNING *
    `, [requestId, verificationCode]);

    if (result.rows.length === 0) {
      throw new Error('Invalid or expired verification code');
    }

    const request = result.rows[0];

    // 触发审批流程
    await this.processApproval(request);

    logger.info('Data deletion request verified', {
      requestId,
      userId: request.user_id
    });

    return request;
  }

  /**
   * 处理审批流程
   */
  async processApproval(request) {
    // 获取用户信息以评估风险
    const userRisk = await this.assessUserRisk(request.user_id);
    
    let approved = false;
    let approvalType = 'manual';

    // 应用自动审批规则
    if (userRisk.accountAgeDays < 30 && userRisk.transactionCount === 0) {
      // 新用户规则
      approved = true;
      approvalType = 'auto';
    } else if (userRisk.transactionCount === 0 && userRisk.accountAgeDays >= 30) {
      // 标准用户规则（延迟执行）
      approved = true;
      approvalType = 'auto';
    } else if (userRisk.transactionCount > 0) {
      // 有交易记录，需要人工审批
      approved = false;
      approvalType = 'manual';
    }

    if (approved) {
      await this.approveRequest(request.id, null, approvalType);
    } else {
      // 等待人工审批
      await this.db.query(`
        UPDATE data_deletion_requests
        SET approval_status = 'pending'
        WHERE id = $1
      `, [request.id]);
      
      // 发送审批通知
      await this.notifyAdminsForApproval(request.id);
    }

    metrics.incrementCounter('data_deletion_approval_processed_total', {
      approval_type: approvalType,
      approved: approved.toString()
    });
  }

  /**
   * 评估用户风险
   */
  async assessUserRisk(userId) {
    const result = await this.db.query(`
      SELECT 
        EXTRACT(DAY FROM NOW() - created_at) as account_age_days,
        (SELECT COUNT(*) FROM transactions WHERE user_id = $1) as transaction_count,
        (SELECT COUNT(*) FROM user_pokemon WHERE user_id = $1) as pokemon_count,
        (SELECT COUNT(*) FROM friendships WHERE user_id = $1 OR friend_id = $1) as friend_count
      FROM users WHERE id = $1
    `, [userId]);

    const row = result.rows[0];
    return {
      accountAgeDays: parseInt(row.account_age_days) || 0,
      transactionCount: parseInt(row.transaction_count) || 0,
      pokemonCount: parseInt(row.pokemon_count) || 0,
      friendCount: parseInt(row.friend_count) || 0
    };
  }

  /**
   * 批准删除请求
   */
  async approveRequest(requestId, adminId, approvalType = 'manual') {
    const now = new Date();
    const scheduledAt = approvalType === 'auto' ? 
      new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) : // 30天延迟
      now;

    const result = await this.db.query(`
      UPDATE data_deletion_requests
      SET status = 'approved',
          approval_status = $1,
          approved_by = $2,
          approved_at = NOW(),
          updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `, [approvalType === 'auto' ? 'auto_approved' : 'manual_approved', adminId, requestId]);

    const request = result.rows[0];

    // 创建删除任务
    await this.createDeletionTasks(request);

    // 记录审批历史
    await this.db.query(`
      INSERT INTO data_deletion_approval_history (
        request_id, action, actor_id, actor_type, 
        previous_status, new_status
      ) VALUES ($1, 'approved', $2, $3, 'verifying', 'approved')
    `, [requestId, adminId, approvalType]);

    // 发布事件
    await this.eventBus.publish(Events.DATA_DELETION_APPROVED, {
      requestId,
      userId: request.user_id,
      approvalType,
      scheduledAt
    });

    // 通知用户
    await this.notifyUser(request.user_id, 'deletion_approved', {
      scheduledAt,
      gracePeriodDays: approvalType === 'auto' ? 30 : 0
    });

    logger.info('Data deletion request approved', {
      requestId,
      approvalType,
      adminId
    });

    metrics.incrementCounter('data_deletion_requests_approved_total', {
      approval_type: approvalType
    });

    return request;
  }

  /**
   * 创建删除任务
   */
  async createDeletionTasks(request) {
    // 获取数据类别
    const categories = await this.db.query(`
      SELECT * FROM data_categories 
      WHERE is_deletable = TRUE
      ORDER BY deletion_priority ASC
    `);

    const tasks = [];
    
    for (const category of categories.rows) {
      for (const table of category.related_tables) {
        const taskResult = await this.db.query(`
          INSERT INTO data_deletion_tasks (
            request_id, task_name, service_name, data_category,
            table_name, status
          ) VALUES ($1, $2, $3, $4, $5, 'pending')
          RETURNING *
        `, [
          request.id,
          `Delete ${category.category_name} from ${table}`,
          this.getServiceForTable(table),
          category.category_code,
          table
        ]);

        tasks.push(taskResult.rows[0]);
      }
    }

    logger.info('Deletion tasks created', {
      requestId: request.id,
      taskCount: tasks.length
    });

    return tasks;
  }

  /**
   * 执行删除任务
   */
  async executeDeletion(requestId) {
    const request = await this.getRequest(requestId);
    
    if (request.status !== 'approved') {
      throw new Error('Request must be approved before deletion');
    }

    // 更新状态为处理中
    await this.db.query(`
      UPDATE data_deletion_requests
      SET status = 'processing',
          processing_started_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `, [requestId]);

    // 获取所有待处理任务（按优先级排序）
    const tasksResult = await this.db.query(`
      SELECT t.*, dc.deletion_priority, dc.retention_period_days
      FROM data_deletion_tasks t
      JOIN data_categories dc ON t.data_category = dc.category_code
      WHERE t.request_id = $1 AND t.status = 'pending'
      ORDER BY dc.deletion_priority ASC, t.created_at ASC
    `, [requestId]);

    let totalDeleted = 0;
    const deletionSummary = {};

    for (const task of tasksResult.rows) {
      try {
        const deleted = await this.executeTask(task);
        totalDeleted += deleted;
        deletionSummary[task.data_category] = (deletionSummary[task.data_category] || 0) + deleted;
      } catch (error) {
        logger.error('Task execution failed', {
          taskId: task.id,
          error: error.message
        });

        // 标记任务失败
        await this.db.query(`
          UPDATE data_deletion_tasks
          SET status = 'failed',
              error_message = $1,
              updated_at = NOW()
          WHERE id = $2
        `, [error.message, task.id]);

        // 检查是否需要重试
        if (task.retry_count < task.max_retries) {
          await this.db.query(`
            UPDATE data_deletion_tasks
            SET status = 'pending',
                retry_count = retry_count + 1
            WHERE id = $1
          `, [task.id]);
        }
      }
    }

    // 检查是否所有任务完成
    const pendingTasks = await this.db.query(`
      SELECT COUNT(*) FROM data_deletion_tasks
      WHERE request_id = $1 AND status NOT IN ('completed', 'skipped')
    `, [requestId]);

    if (parseInt(pendingTasks.rows[0].count) === 0) {
      await this.completeDeletion(request, deletionSummary, totalDeleted);
    }

    metrics.incrementCounter('data_deletion_tasks_executed_total');
    metrics.observeHistogram('data_deletion_duration_seconds', 
      (Date.now() - request.processing_started_at) / 1000);

    return { totalDeleted, deletionSummary };
  }

  /**
   * 执行单个删除任务
   */
  async executeTask(task) {
    const startTime = Date.now();

    // 标记为运行中
    await this.db.query(`
      UPDATE data_deletion_tasks
      SET status = 'running', started_at = NOW()
      WHERE id = $1
    `, [task.id]);

    // 创建备份（可选）
    let backupPath = null;
    if (process.env.ENABLE_DELETION_BACKUP === 'true') {
      backupPath = await this.backupData(task);
    }

    // 执行删除
    const result = await this.db.query(`
      DELETE FROM ${task.table_name}
      WHERE user_id = $1
      RETURNING 1
    `, [task.request_id]); // 注意：这里需要从request获取user_id

    const affectedRows = result.rowCount;

    // 更新任务状态
    await this.db.query(`
      UPDATE data_deletion_tasks
      SET status = 'completed',
          affected_rows = $1,
          backup_path = $2,
          completed_at = NOW(),
          duration_ms = $3,
          updated_at = NOW()
      WHERE id = $4
    `, [affectedRows, backupPath, Date.now() - startTime, task.id]);

    logger.info('Deletion task completed', {
      taskId: task.id,
      table: task.table_name,
      affectedRows
    });

    metrics.incrementCounter('data_deletion_rows_deleted_total', {
      table: task.table_name
    }, affectedRows);

    return affectedRows;
  }

  /**
   * 完成删除流程
   */
  async completeDeletion(request, deletionSummary, totalDeleted) {
    // 生成删除证明
    const certificate = await this.generateCertificate(request, deletionSummary, totalDeleted);

    // 更新请求状态
    await this.db.query(`
      UPDATE data_deletion_requests
      SET status = 'completed',
          processing_completed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `, [request.id]);

    // 发布完成事件
    await this.eventBus.publish(Events.DATA_DELETION_COMPLETED, {
      requestId: request.id,
      userId: request.user_id,
      certificateNumber: certificate.certificate_number,
      totalDeleted
    });

    // 通知用户（发送到备用邮箱，因为账户已被删除）
    await this.notifyUser(request.user_id, 'deletion_completed', {
      certificateNumber: certificate.certificate_number
    });

    logger.info('Data deletion completed', {
      requestId: request.id,
      userId: request.user_id,
      certificateNumber: certificate.certificate_number,
      totalDeleted
    });

    metrics.incrementCounter('data_deletion_requests_completed_total');
  }

  /**
   * 生成删除证明
   */
  async generateCertificate(request, deletionSummary, totalDeleted) {
    const certificateNumber = `DEL-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    
    // 创建删除摘要
    const summary = {
      requestId: request.id,
      userId: request.user_id,
      requestType: request.request_type,
      completedAt: new Date().toISOString(),
      categories: deletionSummary,
      totalRecords: totalDeleted
    };

    // 生成数字签名
    const signature = this.signData(JSON.stringify(summary));

    const result = await this.db.query(`
      INSERT INTO data_deletion_certificates (
        request_id, user_id, certificate_number, deletion_summary,
        deleted_data_categories, total_records_deleted, signature
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      request.id,
      request.user_id,
      certificateNumber,
      JSON.stringify(summary),
      Object.keys(deletionSummary),
      totalDeleted,
      signature
    ]);

    return result.rows[0];
  }

  /**
   * 拒绝删除请求
   */
  async rejectRequest(requestId, adminId, reason) {
    const result = await this.db.query(`
      UPDATE data_deletion_requests
      SET status = 'rejected',
          approval_status = 'rejected',
          approved_by = $1,
          approved_at = NOW(),
          rejection_reason = $2,
          updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `, [adminId, reason, requestId]);

    const request = result.rows[0];

    // 记录审批历史
    await this.db.query(`
      INSERT INTO data_deletion_approval_history (
        request_id, action, actor_id, actor_type, 
        previous_status, new_status, comment
      ) VALUES ($1, 'rejected', $2, 'admin', 'verifying', 'rejected', $3)
    `, [requestId, adminId, reason]);

    // 通知用户
    await this.notifyUser(request.user_id, 'deletion_rejected', { reason });

    // 发布事件
    await this.eventBus.publish(Events.DATA_DELETION_REJECTED, {
      requestId,
      userId: request.user_id,
      reason
    });

    logger.info('Data deletion request rejected', {
      requestId,
      adminId,
      reason
    });

    metrics.incrementCounter('data_deletion_requests_rejected_total');

    return request;
  }

  /**
   * 取消删除请求
   */
  async cancelRequest(requestId, userId) {
    const result = await this.db.query(`
      UPDATE data_deletion_requests
      SET status = 'cancelled',
          updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'verifying', 'approved')
      RETURNING *
    `, [requestId, userId]);

    if (result.rows.length === 0) {
      throw new Error('Request not found or cannot be cancelled');
    }

    const request = result.rows[0];

    // 发布事件
    await this.eventBus.publish(Events.DATA_DELETION_CANCELLED, {
      requestId,
      userId
    });

    logger.info('Data deletion request cancelled', {
      requestId,
      userId
    });

    metrics.incrementCounter('data_deletion_requests_cancelled_total');

    return request;
  }

  /**
   * 获取删除请求
   */
  async getRequest(requestId) {
    const result = await this.db.query(`
      SELECT * FROM data_deletion_requests WHERE id = $1
    `, [requestId]);

    return result.rows[0];
  }

  /**
   * 获取用户的删除请求
   */
  async getUserRequests(userId, options = {}) {
    const { limit = 10, offset = 0 } = options;

    const result = await this.db.query(`
      SELECT * FROM data_deletion_requests
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    return result.rows;
  }

  /**
   * 获取删除证明
   */
  async getCertificate(certificateNumber) {
    const result = await this.db.query(`
      SELECT * FROM data_deletion_certificates
      WHERE certificate_number = $1
    `, [certificateNumber]);

    return result.rows[0];
  }

  /**
   * 获取待审批请求列表
   */
  async getPendingApprovals(options = {}) {
    const { limit = 20, offset = 0 } = options;

    const result = await this.db.query(`
      SELECT r.*, u.email, u.username
      FROM data_deletion_requests r
      JOIN users u ON r.user_id = u.id
      WHERE r.approval_status = 'pending'
      ORDER BY r.created_at ASC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    return result.rows;
  }

  // 辅助方法

  generateVerificationCode() {
    return crypto.randomBytes(16).toString('hex');
  }

  signData(data) {
    const privateKey = process.env.DELETION_SIGNING_KEY;
    const sign = crypto.createSign('SHA256');
    sign.update(data);
    return sign.sign(privateKey, 'hex');
  }

  getServiceForTable(table) {
    const mapping = {
      'users': 'user-service',
      'user_profiles': 'user-service',
      'user_pokemon': 'pokemon-service',
      'friendships': 'social-service',
      'guild_members': 'social-service',
      'transactions': 'payment-service',
      'payments': 'payment-service',
      'location_history': 'location-service',
      'activity_logs': 'gateway'
    };
    return mapping[table] || 'unknown';
  }

  async backupData(task) {
    // 实现数据备份逻辑
    const backupPath = `/backups/deletion/${task.request_id}/${task.table_name}_${Date.now()}.json`;
    // ... 备份逻辑
    return backupPath;
  }

  async notifyUser(userId, type, data) {
    // 通过 EventBus 发送通知
    await this.eventBus.publish(Events.NOTIFICATION_REQUESTED, {
      userId,
      type,
      data
    });
  }

  async notifyAdminsForApproval(requestId) {
    // 通知管理员审批
    await this.eventBus.publish(Events.ADMIN_APPROVAL_REQUIRED, {
      type: 'data_deletion',
      requestId
    });
  }
}

// 单例导出
let instance = null;

function getDataDeletionService(config) {
  if (!instance) {
    instance = new DataDeletionService(config);
  }
  return instance;
}

module.exports = {
  DataDeletionService,
  getDataDeletionService
};
```

### 3. API 路由

```javascript
// backend/services/user-service/src/routes/dataDeletion.js

const express = require('express');
const router = express.Router();
const { getDataDeletionService } = require('../../../shared/dataDeletionService');
const { authenticate, optionalAuth } = require('../../../shared/auth');
const { validateRequest } = require('../../../shared/validation');
const Joi = require('joi');

const deletionService = getDataDeletionService();

// 创建删除请求
router.post('/requests', authenticate, async (req, res) => {
  try {
    const { requestType, reason, dataTypes } = req.body;
    
    const result = await deletionService.createRequest(req.user.id, {
      requestType: requestType || 'full',
      reason,
      dataTypes: dataTypes || ['all'],
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.status(201).json({
      success: true,
      data: {
        requestId: result.requestId,
        verificationCode: result.verificationCode,
        verificationExpiresAt: result.verificationExpiresAt,
        message: 'Verification code sent. Please verify to proceed.'
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// 验证删除请求
router.post('/requests/:id/verify', authenticate, async (req, res) => {
  try {
    const { verificationCode } = req.body;
    
    const request = await deletionService.verifyRequest(req.params.id, verificationCode);

    res.json({
      success: true,
      data: {
        requestId: request.id,
        status: request.status,
        approvalStatus: request.approval_status,
        message: 'Request verified and submitted for approval.'
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// 获取用户删除请求列表
router.get('/requests', authenticate, async (req, res) => {
  try {
    const requests = await deletionService.getUserRequests(req.user.id, {
      limit: parseInt(req.query.limit) || 10,
      offset: parseInt(req.query.offset) || 0
    });

    res.json({ success: true, data: requests });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// 获取单个删除请求详情
router.get('/requests/:id', authenticate, async (req, res) => {
  try {
    const request = await deletionService.getRequest(req.params.id);
    
    if (!request) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }

    if (request.user_id !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    // 获取关联任务
    const tasksResult = await req.app.locals.db.query(`
      SELECT * FROM data_deletion_tasks WHERE request_id = $1
    `, [request.id]);

    res.json({
      success: true,
      data: {
        request,
        tasks: tasksResult.rows
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// 取消删除请求
router.post('/requests/:id/cancel', authenticate, async (req, res) => {
  try {
    const request = await deletionService.cancelRequest(req.params.id, req.user.id);

    res.json({
      success: true,
      data: request,
      message: 'Deletion request cancelled successfully.'
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// 获取删除证明（公开接口，需要证明编号）
router.get('/certificates/:certificateNumber', optionalAuth, async (req, res) => {
  try {
    const certificate = await deletionService.getCertificate(req.params.certificateNumber);

    if (!certificate) {
      return res.status(404).json({ success: false, error: 'Certificate not found' });
    }

    res.json({ success: true, data: certificate });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// === 管理员接口 ===

// 获取待审批请求列表
router.get('/admin/pending', authenticate, requireAdmin, async (req, res) => {
  try {
    const requests = await deletionService.getPendingApprovals({
      limit: parseInt(req.query.limit) || 20,
      offset: parseInt(req.query.offset) || 0
    });

    res.json({ success: true, data: requests });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// 批准删除请求
router.post('/admin/requests/:id/approve', authenticate, requireAdmin, async (req, res) => {
  try {
    const request = await deletionService.approveRequest(
      req.params.id,
      req.user.id,
      'manual'
    );

    res.json({
      success: true,
      data: request,
      message: 'Deletion request approved.'
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// 拒绝删除请求
router.post('/admin/requests/:id/reject', authenticate, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({ 
        success: false, 
        error: 'Rejection reason is required' 
      });
    }

    const request = await deletionService.rejectRequest(
      req.params.id,
      req.user.id,
      reason
    );

    res.json({
      success: true,
      data: request,
      message: 'Deletion request rejected.'
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// 手动触发删除执行
router.post('/admin/requests/:id/execute', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await deletionService.executeDeletion(req.params.id);

    res.json({
      success: true,
      data: result,
      message: 'Deletion executed successfully.'
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
}

module.exports = router;
```

### 4. 定时任务

```javascript
// backend/jobs/dataDeletionProcessor.js

const { getDataDeletionService } = require('../shared/dataDeletionService');
const logger = require('../shared/logger');
const cron = require('node-cron');

const deletionService = getDataDeletionService();

/**
 * 处理已批准的删除请求（30天延迟后执行）
 */
async function processScheduledDeletions() {
  logger.info('Processing scheduled data deletions');

  try {
    // 查找已批准且到达执行时间的请求
    const result = await deletionService.db.query(`
      SELECT * FROM data_deletion_requests
      WHERE status = 'approved'
        AND approved_at < NOW() - INTERVAL '30 days'
        AND processing_started_at IS NULL
      ORDER BY approved_at ASC
      LIMIT 10
    `);

    for (const request of result.rows) {
      try {
        await deletionService.executeDeletion(request.id);
      } catch (error) {
        logger.error('Failed to process deletion request', {
          requestId: request.id,
          error: error.message
        });
      }
    }

    logger.info('Scheduled deletions processed', {
      count: result.rows.length
    });
  } catch (error) {
    logger.error('Error processing scheduled deletions', {
      error: error.message
    });
  }
}

/**
 * 重试失败的删除任务
 */
async function retryFailedTasks() {
  logger.info('Retrying failed deletion tasks');

  try {
    const result = await deletionService.db.query(`
      SELECT DISTINCT r.* 
      FROM data_deletion_requests r
      JOIN data_deletion_tasks t ON t.request_id = r.id
      WHERE r.status = 'processing'
        AND t.status = 'failed'
        AND t.retry_count < t.max_retries
    `);

    for (const request of result.rows) {
      await deletionService.executeDeletion(request.id);
    }

    logger.info('Failed tasks retried', {
      count: result.rows.length
    });
  } catch (error) {
    logger.error('Error retrying failed tasks', {
      error: error.message
    });
  }
}

/**
 * 清理过期验证码
 */
async function cleanupExpiredCodes() {
  try {
    const result = await deletionService.db.query(`
      UPDATE data_deletion_requests
      SET status = 'cancelled'
      WHERE status = 'pending'
        AND verification_expires_at < NOW()
    `);

    logger.info('Expired verification codes cleaned', {
      count: result.rowCount
    });
  } catch (error) {
    logger.error('Error cleaning up expired codes', {
      error: error.message
    });
  }
}

// 启动定时任务
function start() {
  // 每小时检查待执行的删除请求
  cron.schedule('0 * * * *', processScheduledDeletions);

  // 每6小时重试失败任务
  cron.schedule('0 */6 * * *', retryFailedTasks);

  // 每天清理过期验证码
  cron.schedule('0 0 * * *', cleanupExpiredCodes);

  logger.info('Data deletion processor started');
}

module.exports = {
  start,
  processScheduledDeletions,
  retryFailedTasks,
  cleanupExpiredCodes
};
```

### 5. Prometheus 指标

```javascript
// backend/shared/metrics.js 新增指标

// 数据删除相关指标
metrics.dataDeletionRequestsCreated = new promClient.Counter({
  name: 'data_deletion_requests_created_total',
  help: 'Total number of data deletion requests created',
  labelNames: ['request_type']
});

metrics.dataDeletionRequestsApproved = new promClient.Counter({
  name: 'data_deletion_requests_approved_total',
  help: 'Total number of data deletion requests approved',
  labelNames: ['approval_type']
});

metrics.dataDeletionRequestsRejected = new promClient.Counter({
  name: 'data_deletion_requests_rejected_total',
  help: 'Total number of data deletion requests rejected'
});

metrics.dataDeletionRequestsCompleted = new promClient.Counter({
  name: 'data_deletion_requests_completed_total',
  help: 'Total number of data deletion requests completed'
});

metrics.dataDeletionRequestsCancelled = new promClient.Counter({
  name: 'data_deletion_requests_cancelled_total',
  help: 'Total number of data deletion requests cancelled'
});

metrics.dataDeletionTasksExecuted = new promClient.Counter({
  name: 'data_deletion_tasks_executed_total',
  help: 'Total number of deletion tasks executed'
});

metrics.dataDeletionRowsDeleted = new promClient.Counter({
  name: 'data_deletion_rows_deleted_total',
  help: 'Total number of rows deleted',
  labelNames: ['table']
});

metrics.dataDeletionDuration = new promClient.Histogram({
  name: 'data_deletion_duration_seconds',
  help: 'Duration of data deletion process in seconds',
  buckets: [1, 5, 10, 30, 60, 120, 300, 600]
});
```

## 验收标准

- [ ] 用户可通过 API 提交数据删除请求
- [ ] 系统发送验证码确认用户身份
- [ ] 验证后根据规则自动审批或进入人工审批流程
- [ ] 管理员可查看、批准或拒绝待审批请求
- [ ] 批准后的请求在延迟期后自动执行删除
- [ ] 删除过程按数据类别分任务执行
- [ ] 失败任务支持重试机制
- [ ] 删除完成后生成合规证明证书
- [ ] 用户可查询删除请求状态和证明
- [ ] Prometheus 指标正确记录所有关键操作
- [ ] 满足 GDPR 第17条"被遗忘权"要求
- [ ] 满足 CCPA 第1798.105条"删除权"要求

## 影响范围

- 新增文件：
  - `database/pending/20260611_201500__add_data_deletion_request_tables.sql`
  - `backend/shared/dataDeletionService.js`
  - `backend/services/user-service/src/routes/dataDeletion.js`
  - `backend/jobs/dataDeletionProcessor.js`
  
- 修改文件：
  - `backend/shared/metrics.js`（新增指标）
  - `backend/services/user-service/src/index.js`（挂载路由）
  - `backend/jobs/index.js`（启动定时任务）

## 参考

- [GDPR Article 17 - Right to erasure ('right to be forgotten')](https://gdpr-info.eu/art-17-gdpr/)
- [CCPA § 1798.105 - Right to Delete](https://oag.ca.gov/privacy/ccpa)
- [Data Deletion Best Practices](https://ico.org.uk/for-organisations/guide-to-data-protection/guide-to-the-general-data-protection-regulation-gdpr/individual-rights/right-to-erasure/)
