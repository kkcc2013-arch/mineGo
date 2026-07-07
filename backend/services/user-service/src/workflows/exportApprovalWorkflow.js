/**
 * REQ-00485: 批量导出审批工作流
 * 实现多级审批流程，防止数据滥用
 */

const { v4: uuidv4 } = require('uuid');

class ExportApprovalWorkflow {
  constructor(db, eventBus, notificationService) {
    this.db = db;
    this.eventBus = eventBus;
    this.notificationService = notificationService;
    
    // 审批流程配置
    this.approvalThresholds = {
      small: { min: 1, max: 100, approvers: 1 },      // 小批量：1人审批
      medium: { min: 101, max: 500, approvers: 2 },   // 中批量：2人审批
      large: { min: 501, max: 1000, approvers: 3 }   // 大批量：3人审批
    };
  }

  /**
   * 提交批量导出申请
   * @param {number} adminId - 管理员ID
   * @param {object} request - 申请详情
   */
  async submitExportRequest(adminId, request) {
    const { userIds, reason, filters } = request;
    
    // 确定审批级别
    const size = userIds.length;
    const approvalLevel = this._getApprovalLevel(size);
    
    // 创建审批请求
    const result = await this.db.query(`
      INSERT INTO export_approval_requests
        (admin_id, user_count, user_ids, reason, filters, 
         approval_level, required_approvers, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
      RETURNING id
    `, [
      adminId,
      size,
      JSON.stringify(userIds),
      reason,
      JSON.stringify(filters || {}),
      approvalLevel.level,
      approvalLevel.approvers
    ]);
    
    const requestId = result.rows[0].id;
    
    // 发送审批通知
    await this._sendApprovalNotifications(requestId, adminId, size, reason);
    
    // 发布事件
    if (this.eventBus) {
      await this.eventBus.publish('export.request.submitted', {
        requestId,
        adminId,
        userCount: size,
        approvalLevel: approvalLevel.level
      });
    }
    
    return {
      requestId,
      status: 'pending',
      approvalLevel: approvalLevel.level,
      requiredApprovers: approvalLevel.approvers
    };
  }

  /**
   * 审批导出请求
   */
  async approveExportRequest(requestId, approverId, comment) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 检查请求状态
      const request = await client.query(`
        SELECT * FROM export_approval_requests
        WHERE id = $1 AND status = 'pending'
        FOR UPDATE
      `, [requestId]);
      
      if (request.rows.length === 0) {
        throw new Error('Request not found or already processed');
      }
      
      const requestData = request.rows[0];
      
      // 检查审批人权限（需要不同人员）
      if (requestData.admin_id === approverId) {
        throw new Error('Cannot approve own request');
      }
      
      // 记录审批
      await client.query(`
        INSERT INTO export_approvals
          (request_id, approver_id, action, comment, created_at)
        VALUES ($1, $2, 'approved', $3, NOW())
      `, [requestId, approverId, comment]);
      
      // 更新已审批人数
      const updatedRequest = await client.query(`
        UPDATE export_approval_requests
        SET current_approvers = current_approvers + 1,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [requestId]);
      
      const current = updatedRequest.rows[0];
      
      // 检查是否达到审批人数
      if (current.current_approvers >= current.required_approvers) {
        // 标记为已批准
        await client.query(`
          UPDATE export_approval_requests
          SET status = 'approved', 
              approved_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
        `, [requestId]);
        
        // 触发导出任务
        await this._triggerExportTask(requestId);
        
        await client.query('COMMIT');
        
        return {
          status: 'approved',
          message: 'Export request approved and task triggered',
          requestId
        };
      }
      
      await client.query('COMMIT');
      
      return {
        status: 'pending',
        message: `Approved (${current.current_approvers}/${current.required_approvers})`,
        requestId,
        remaining: current.required_approvers - current.current_approvers
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 拒绝导出请求
   */
  async rejectExportRequest(requestId, approverId, reason) {
    const result = await this.db.query(`
      UPDATE export_approval_requests
      SET status = 'rejected',
          rejected_by = $2,
          reject_reason = $3,
          rejected_at = NOW(),
          updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING admin_id
    `, [requestId, approverId, reason]);
    
    if (result.rows.length === 0) {
      throw new Error('Request not found or already processed');
    }
    
    // 通知申请人
    if (this.notificationService) {
      await this.notificationService.send(
        result.rows[0].admin_id,
        'export_request_rejected',
        { requestId, reason }
      );
    }
    
    // 记录审计日志
    if (this.eventBus) {
      await this.eventBus.publish('export.request.rejected', {
        requestId,
        rejectedBy: approverId,
        reason
      });
    }
    
    return { status: 'rejected', requestId };
  }

  /**
   * 获取待审批请求列表
   */
  async getPendingRequests(limit = 20, offset = 0) {
    const result = await this.db.query(`
      SELECT 
        r.id, r.admin_id, r.user_count, r.reason, 
        r.approval_level, r.required_approvers, r.current_approvers,
        r.created_at, u.username as admin_name
      FROM export_approval_requests r
      LEFT JOIN users u ON r.admin_id = u.id
      WHERE r.status = 'pending'
      ORDER BY r.created_at ASC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    
    return result.rows;
  }

  /**
   * 获取请求详情
   */
  async getRequestDetails(requestId) {
    const result = await this.db.query(`
      SELECT * FROM export_approval_requests WHERE id = $1
    `, [requestId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const request = result.rows[0];
    
    // 获取审批历史
    const approvals = await this.db.query(`
      SELECT a.*, u.username as approver_name
      FROM export_approvals a
      LEFT JOIN users u ON a.approver_id = u.id
      WHERE a.request_id = $1
      ORDER BY a.created_at ASC
    `, [requestId]);
    
    return {
      ...request,
      approvals: approvals.rows
    };
  }

  /**
   * 确定审批级别
   */
  _getApprovalLevel(size) {
    for (const [level, config] of Object.entries(this.approvalThresholds)) {
      if (size >= config.min && size <= config.max) {
        return { level, ...config };
      }
    }
    throw new Error('Export size exceeds maximum allowed');
  }

  /**
   * 发送审批通知
   */
  async _sendApprovalNotifications(requestId, adminId, size, reason) {
    // 获取有审批权限的管理员
    const approvers = await this.db.query(`
      SELECT user_id FROM users
      WHERE role IN ('super_admin', 'data_protection_officer')
      AND id != $1
      AND status = 'active'
    `, [adminId]);
    
    if (!this.notificationService) return;
    
    // 发送通知
    for (const approver of approvers.rows) {
      await this.notificationService.send(
        approver.user_id,
        'export_approval_required',
        { requestId, userCount: size, reason }
      );
    }
  }

  /**
   * 触发导出任务
   */
  async _triggerExportTask(requestId) {
    if (this.eventBus) {
      await this.eventBus.publish('export.task.created', { requestId });
    }
  }

  /**
   * 创建审批相关表
   */
  async ensureTablesExist() {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS export_approval_requests (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER NOT NULL,
        user_count INTEGER NOT NULL,
        user_ids JSONB NOT NULL,
        reason TEXT,
        filters JSONB,
        approval_level VARCHAR(20) NOT NULL,
        required_approvers INTEGER NOT NULL,
        current_approvers INTEGER DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        approved_at TIMESTAMP,
        rejected_by INTEGER,
        reject_reason TEXT,
        rejected_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS export_approvals (
        id SERIAL PRIMARY KEY,
        request_id INTEGER NOT NULL REFERENCES export_approval_requests(id),
        approver_id INTEGER NOT NULL,
        action VARCHAR(20) NOT NULL,
        comment TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  }
}

module.exports = ExportApprovalWorkflow;