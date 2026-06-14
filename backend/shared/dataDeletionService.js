/**
 * REQ-00127: 用户数据删除请求管理系统
 * 数据删除服务核心模块
 */

'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');

// 数据删除请求状态
const DeletionStatus = {
  PENDING: 'pending',
  VERIFYING: 'verifying',
  APPROVED: 'approved',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled'
};

// 审批状态
const ApprovalStatus = {
  PENDING: 'pending',
  AUTO_APPROVED: 'auto_approved',
  MANUAL_APPROVED: 'manual_approved',
  REJECTED: 'rejected'
};

class DataDeletionService {
  constructor(db, eventBus, redis = null) {
    this.db = db;
    this.eventBus = eventBus;
    this.redis = redis;
    
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

    // 表与服务映射
    this.tableServiceMap = {
      'users': 'user-service',
      'user_profiles': 'user-service',
      'user_pokemon': 'pokemon-service',
      'pokemon_instances': 'pokemon-service',
      'friendships': 'social-service',
      'guild_members': 'social-service',
      'messages': 'social-service',
      'transactions': 'payment-service',
      'payments': 'payment-service',
      'location_history': 'location-service',
      'visit_records': 'location-service',
      'activity_logs': 'gateway',
      'audit_logs': 'gateway',
      'user_preferences': 'user-service',
      'notification_preferences': 'user-service',
      'user_achievements': 'reward-service',
      'milestones': 'reward-service'
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
    if (this.eventBus) {
      await this.eventBus.publish('data_deletion.requested', {
        requestId: request.id,
        userId,
        requestType,
        dataTypes,
        verificationCode
      });
    }

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

    logger.info('Approval processed', {
      requestId: request.id,
      approvalType,
      approved
    });
  }

  /**
   * 评估用户风险
   */
  async assessUserRisk(userId) {
    const result = await this.db.query(`
      SELECT 
        EXTRACT(DAY FROM NOW() - created_at) as account_age_days,
        (SELECT COUNT(*) FROM transactions WHERE user_id = $1 AND status = 'completed') as transaction_count,
        (SELECT COUNT(*) FROM pokemon_instances WHERE trainer_id = $1) as pokemon_count,
        (SELECT COUNT(*) FROM friendships WHERE (user_id = $1 OR friend_id = $1) AND status = 'accepted') as friend_count
      FROM users WHERE id = $1
    `, [userId]);

    const row = result.rows[0] || {};
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

    if (!request) {
      throw new Error('Request not found');
    }

    // 创建删除任务
    await this.createDeletionTasks(request);

    // 记录审批历史
    await this.db.query(`
      INSERT INTO data_deletion_approval_history (
        request_id, action, actor_id, actor_type, 
        previous_status, new_status
      ) VALUES ($1, 'approved', $2, $3, 'verifying', 'approved')
    `, [requestId, adminId, approvalType || 'system']);

    // 发布事件
    if (this.eventBus) {
      await this.eventBus.publish('data_deletion.approved', {
        requestId,
        userId: request.user_id,
        approvalType
      });
    }

    logger.info('Data deletion request approved', {
      requestId,
      approvalType,
      adminId
    });

    return request;
  }

  /**
   * 创建删除任务
   */
  async createDeletionTasks(request) {
    // 获取数据类别
    const categoriesResult = await this.db.query(`
      SELECT * FROM data_categories 
      WHERE is_deletable = TRUE
      ORDER BY deletion_priority ASC
    `);

    const tasks = [];
    
    for (const category of categoriesResult.rows) {
      for (const table of category.related_tables) {
        // 检查表是否存在
        const tableExists = await this.checkTableExists(table);
        if (!tableExists) continue;

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
    
    if (!request) {
      throw new Error('Request not found');
    }

    if (request.status !== 'approved' && request.status !== 'processing') {
      throw new Error('Request must be approved before deletion');
    }

    // 更新状态为处理中
    await this.db.query(`
      UPDATE data_deletion_requests
      SET status = 'processing',
          processing_started_at = COALESCE(processing_started_at, NOW()),
          updated_at = NOW()
      WHERE id = $1
    `, [requestId]);

    // 获取所有待处理任务（按优先级排序）
    const tasksResult = await this.db.query(`
      SELECT t.*, dc.deletion_priority, dc.retention_period_days
      FROM data_deletion_tasks t
      JOIN data_categories dc ON t.data_category = dc.category_code
      WHERE t.request_id = $1 AND t.status IN ('pending', 'failed')
      ORDER BY dc.deletion_priority ASC, t.created_at ASC
    `, [requestId]);

    let totalDeleted = 0;
    const deletionSummary = {};

    for (const task of tasksResult.rows) {
      try {
        const deleted = await this.executeTask(task, request.user_id);
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
              retry_count = retry_count + 1,
              updated_at = NOW()
          WHERE id = $2
        `, [error.message, task.id]);
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

    return { totalDeleted, deletionSummary };
  }

  /**
   * 执行单个删除任务
   */
  async executeTask(task, userId) {
    const startTime = Date.now();

    // 标记为运行中
    await this.db.query(`
      UPDATE data_deletion_tasks
      SET status = 'running', started_at = NOW()
      WHERE id = $1
    `, [task.id]);

    // 获取用户标识字段名
    const userColumn = await this.getUserColumnForTable(task.table_name);

    // 执行删除
    const result = await this.db.query(`
      DELETE FROM ${task.table_name}
      WHERE ${userColumn} = $1
    `, [userId]);

    const affectedRows = result.rowCount || 0;

    // 更新任务状态
    await this.db.query(`
      UPDATE data_deletion_tasks
      SET status = 'completed',
          affected_rows = $1,
          completed_at = NOW(),
          duration_ms = $2,
          updated_at = NOW()
      WHERE id = $3
    `, [affectedRows, Date.now() - startTime, task.id]);

    logger.info('Deletion task completed', {
      taskId: task.id,
      table: task.table_name,
      affectedRows
    });

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
    if (this.eventBus) {
      await this.eventBus.publish('data_deletion.completed', {
        requestId: request.id,
        userId: request.user_id,
        certificateNumber: certificate.certificate_number,
        totalDeleted
      });
    }

    logger.info('Data deletion completed', {
      requestId: request.id,
      userId: request.user_id,
      certificateNumber: certificate.certificate_number,
      totalDeleted
    });

    return certificate;
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

    if (!request) {
      throw new Error('Request not found');
    }

    // 记录审批历史
    await this.db.query(`
      INSERT INTO data_deletion_approval_history (
        request_id, action, actor_id, actor_type, 
        previous_status, new_status, comment
      ) VALUES ($1, 'rejected', $2, 'admin', 'verifying', 'rejected', $3)
    `, [requestId, adminId, reason]);

    // 发布事件
    if (this.eventBus) {
      await this.eventBus.publish('data_deletion.rejected', {
        requestId,
        userId: request.user_id,
        reason
      });
    }

    logger.info('Data deletion request rejected', {
      requestId,
      adminId,
      reason
    });

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
    if (this.eventBus) {
      await this.eventBus.publish('data_deletion.cancelled', {
        requestId,
        userId
      });
    }

    logger.info('Data deletion request cancelled', {
      requestId,
      userId
    });

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

  /**
   * 获取统计数据
   */
  async getStatistics() {
    const result = await this.db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') as pending_count,
        COUNT(*) FILTER (WHERE status = 'verifying') as verifying_count,
        COUNT(*) FILTER (WHERE status = 'approved') as approved_count,
        COUNT(*) FILTER (WHERE status = 'processing') as processing_count,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_count,
        COUNT(*) FILTER (WHERE status = 'rejected') as rejected_count,
        COUNT(*) FILTER (WHERE approval_status = 'pending') as pending_approval_count
      FROM data_deletion_requests
    `);

    return result.rows[0];
  }

  // 辅助方法

  generateVerificationCode() {
    return crypto.randomBytes(16).toString('hex');
  }

  signData(data) {
    const secret = process.env.DELETION_SIGNING_SECRET || 'default-signing-secret';
    return crypto.createHmac('sha256', secret).update(data).digest('hex');
  }

  getServiceForTable(table) {
    return this.tableServiceMap[table] || 'unknown';
  }

  async checkTableExists(tableName) {
    const result = await this.db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = $1
      )
    `, [tableName]);
    return result.rows[0].exists;
  }

  async getUserColumnForTable(tableName) {
    // 大多数表使用 user_id 或 trainer_id
    const specialColumns = {
      'friendships': 'user_id',  // 也检查 friend_id
      'pokemon_instances': 'trainer_id'
    };
    return specialColumns[tableName] || 'user_id';
  }

  async notifyAdminsForApproval(requestId) {
    // 通过 EventBus 发送管理员通知
    if (this.eventBus) {
      await this.eventBus.publish('admin.approval_required', {
        type: 'data_deletion',
        requestId
      });
    }
    logger.info('Admin approval notification sent', { requestId });
  }
}

module.exports = {
  DataDeletionService,
  DeletionStatus,
  ApprovalStatus
};
