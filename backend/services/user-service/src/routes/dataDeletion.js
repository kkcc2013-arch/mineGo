/**
 * REQ-00127: 用户数据删除请求管理系统
 * API 路由
 */

'use strict';

const express = require('express');
const router = express.Router();
const { DataDeletionService } = require('../../../../shared/dataDeletionService');
const { requireAuth, optionalAuth } = require('../../../../shared/auth');
const logger = require('../../../../shared/logger');

let deletionService = null;

/**
 * 初始化路由
 */
function initDataDeletionRoutes(db, eventBus) {
  deletionService = new DataDeletionService(db, eventBus);
  return router;
}

// ==================== 用户端 API ====================

/**
 * POST /api/data-deletion/requests
 * 创建删除请求
 */
router.post('/requests', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { requestType, reason, dataTypes } = req.body;
    
    // 检查是否有未完成的请求
    const existingResult = await req.app.locals.db.query(`
      SELECT id, status FROM data_deletion_requests
      WHERE user_id = $1 AND status IN ('pending', 'verifying', 'approved', 'processing')
      LIMIT 1
    `, [userId]);

    if (existingResult.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'EXISTING_REQUEST',
          message: '您已有进行中的删除请求，请等待处理完成'
        }
      });
    }

    const result = await deletionService.createRequest(userId, {
      requestType: requestType || 'full',
      reason,
      dataTypes: dataTypes || ['all'],
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    logger.info('Data deletion request created via API', {
      requestId: result.requestId,
      userId
    });

    res.status(201).json({
      success: true,
      data: {
        requestId: result.requestId,
        verificationCode: result.verificationCode,
        verificationExpiresAt: result.verificationExpiresAt,
        message: '验证码已发送，请验证以继续'
      }
    });
  } catch (error) {
    logger.error('Failed to create deletion request', {
      error: error.message,
      userId: req.user?.id
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

/**
 * POST /api/data-deletion/requests/:id/verify
 * 验证删除请求
 */
router.post('/requests/:id/verify', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { verificationCode } = req.body;

    if (!verificationCode) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_CODE', message: '请提供验证码' }
      });
    }

    const request = await deletionService.verifyRequest(id, verificationCode);

    res.json({
      success: true,
      data: {
        requestId: request.id,
        status: request.status,
        approvalStatus: request.approval_status,
        message: '请求已验证并提交审批'
      }
    });
  } catch (error) {
    logger.error('Failed to verify deletion request', {
      error: error.message,
      requestId: req.params.id
    });
    res.status(400).json({
      success: false,
      error: { code: 'VERIFICATION_FAILED', message: error.message }
    });
  }
});

/**
 * GET /api/data-deletion/requests
 * 获取用户删除请求列表
 */
router.get('/requests', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const offset = parseInt(req.query.offset) || 0;

    const requests = await deletionService.getUserRequests(userId, { limit, offset });

    res.json({ success: true, data: requests });
  } catch (error) {
    logger.error('Failed to get user requests', {
      error: error.message,
      userId: req.user?.id
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

/**
 * GET /api/data-deletion/requests/:id
 * 获取单个删除请求详情
 */
router.get('/requests/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const request = await deletionService.getRequest(id);
    
    if (!request) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: '请求不存在' }
      });
    }

    // 权限检查
    if (request.user_id !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: '无权访问此请求' }
      });
    }

    // 获取关联任务
    const tasksResult = await req.app.locals.db.query(`
      SELECT * FROM data_deletion_tasks WHERE request_id = $1
      ORDER BY created_at ASC
    `, [request.id]);

    // 获取审批历史
    const historyResult = await req.app.locals.db.query(`
      SELECT * FROM data_deletion_approval_history WHERE request_id = $1
      ORDER BY created_at DESC
    `, [request.id]);

    res.json({
      success: true,
      data: {
        request,
        tasks: tasksResult.rows,
        history: historyResult.rows
      }
    });
  } catch (error) {
    logger.error('Failed to get request details', {
      error: error.message,
      requestId: req.params.id
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

/**
 * POST /api/data-deletion/requests/:id/cancel
 * 取消删除请求
 */
router.post('/requests/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const request = await deletionService.cancelRequest(id, userId);

    res.json({
      success: true,
      data: request,
      message: '删除请求已取消'
    });
  } catch (error) {
    logger.error('Failed to cancel request', {
      error: error.message,
      requestId: req.params.id,
      userId: req.user?.id
    });
    res.status(400).json({
      success: false,
      error: { code: 'CANCEL_FAILED', message: error.message }
    });
  }
});

/**
 * GET /api/data-deletion/certificates/:certificateNumber
 * 获取删除证明（公开接口，需证明编号）
 */
router.get('/certificates/:certificateNumber', optionalAuth, async (req, res) => {
  try {
    const { certificateNumber } = req.params;
    const certificate = await deletionService.getCertificate(certificateNumber);

    if (!certificate) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: '证明不存在' }
      });
    }

    res.json({ success: true, data: certificate });
  } catch (error) {
    logger.error('Failed to get certificate', {
      error: error.message,
      certificateNumber: req.params.certificateNumber
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

// ==================== 管理员 API ====================

/**
 * 管理员权限检查中间件
 */
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: '需要管理员权限' }
    });
  }
  next();
}

/**
 * GET /api/data-deletion/admin/pending
 * 获取待审批请求列表
 */
router.get('/admin/pending', requireAuth, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    const requests = await deletionService.getPendingApprovals({ limit, offset });

    res.json({ success: true, data: requests });
  } catch (error) {
    logger.error('Failed to get pending approvals', {
      error: error.message,
      adminId: req.user?.id
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

/**
 * GET /api/data-deletion/admin/statistics
 * 获取统计数据
 */
router.get('/admin/statistics', requireAuth, requireAdmin, async (req, res) => {
  try {
    const stats = await deletionService.getStatistics();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to get statistics', { error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

/**
 * POST /api/data-deletion/admin/requests/:id/approve
 * 批准删除请求
 */
router.post('/admin/requests/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;

    const request = await deletionService.approveRequest(id, adminId, 'manual');

    logger.info('Deletion request approved by admin', {
      requestId: id,
      adminId
    });

    res.json({
      success: true,
      data: request,
      message: '删除请求已批准'
    });
  } catch (error) {
    logger.error('Failed to approve request', {
      error: error.message,
      requestId: req.params.id,
      adminId: req.user?.id
    });
    res.status(400).json({
      success: false,
      error: { code: 'APPROVE_FAILED', message: error.message }
    });
  }
});

/**
 * POST /api/data-deletion/admin/requests/:id/reject
 * 拒绝删除请求
 */
router.post('/admin/requests/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.user.id;
    
    if (!reason) {
      return res.status(400).json({
        success: false,
        error: { code: 'MISSING_REASON', message: '拒绝原因必填' }
      });
    }

    const request = await deletionService.rejectRequest(id, adminId, reason);

    logger.info('Deletion request rejected by admin', {
      requestId: id,
      adminId,
      reason
    });

    res.json({
      success: true,
      data: request,
      message: '删除请求已拒绝'
    });
  } catch (error) {
    logger.error('Failed to reject request', {
      error: error.message,
      requestId: req.params.id,
      adminId: req.user?.id
    });
    res.status(400).json({
      success: false,
      error: { code: 'REJECT_FAILED', message: error.message }
    });
  }
});

/**
 * POST /api/data-deletion/admin/requests/:id/execute
 * 手动触发删除执行
 */
router.post('/admin/requests/:id/execute', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id;

    const result = await deletionService.executeDeletion(id);

    logger.info('Deletion executed by admin', {
      requestId: id,
      adminId,
      totalDeleted: result.totalDeleted
    });

    res.json({
      success: true,
      data: result,
      message: '删除执行完成'
    });
  } catch (error) {
    logger.error('Failed to execute deletion', {
      error: error.message,
      requestId: req.params.id,
      adminId: req.user?.id
    });
    res.status(400).json({
      success: false,
      error: { code: 'EXECUTE_FAILED', message: error.message }
    });
  }
});

/**
 * GET /api/data-deletion/admin/requests
 * 管理员获取所有请求列表
 */
router.get('/admin/requests', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status, limit = 20, offset = 0 } = req.query;
    
    let query = `
      SELECT r.*, u.email, u.username
      FROM data_deletion_requests r
      JOIN users u ON r.user_id = u.id
    `;
    const params = [];
    
    if (status) {
      query += ` WHERE r.status = $1`;
      params.push(status);
    }
    
    query += ` ORDER BY r.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await req.app.locals.db.query(query, params);

    res.json({ success: true, data: result.rows });
  } catch (error) {
    logger.error('Failed to get admin requests', { error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

module.exports = {
  router,
  initDataDeletionRoutes
};
