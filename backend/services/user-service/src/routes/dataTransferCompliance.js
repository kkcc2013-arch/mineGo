/**
 * REQ-00089: 数据跨境传输合规路由
 * API 端点：用户数据区域管理、跨境传输请求、传输日志查询
 */

const express = require('express');
const router = express.Router();
const { DataTransferComplianceService, LegalBasis, TransferStatus } = require('../services/dataTransferComplianceService');
const { requireAuth, requireAdmin } = require('../../../../shared/auth');
const { auditLog, AuditActions } = require('../../../../shared/auditLog');
const logger = require('../../../../shared/logger');

let complianceService = null;

/**
 * 初始化路由
 */
function initDataTransferRoutes(db) {
  complianceService = new DataTransferComplianceService(db);
  return router;
}

// ============================================
// 用户端 API
// ============================================

/**
 * GET /api/compliance/data-region
 * 获取当前用户数据存储区域
 */
router.get('/data-region', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // 获取用户区域
    let userRegion = await complianceService.getUserRegion(userId);
    
    // 如果没有分配区域，自动检测
    if (!userRegion) {
      const detected = await complianceService.detectUserRegion(req.ip, req.user.country_code);
      userRegion = await complianceService.assignUserRegion(userId, detected.region, {
        reason: 'ip_detection',
        ipAddress: req.ip
      });
    }
    
    res.json({
      region: userRegion.region_code,
      storage: userRegion.storage_location,
      laws: userRegion.applicable_laws,
      assignedAt: userRegion.assigned_at
    });
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Failed to get user data region');
    res.status(500).json({ error: 'Failed to get data region' });
  }
});

/**
 * POST /api/compliance/data-region/select
 * 用户选择数据存储区域
 */
router.post('/data-region/select', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { region, consent } = req.body;
    
    if (!region) {
      return res.status(400).json({ error: 'Region is required' });
    }
    
    if (!consent) {
      return res.status(400).json({ error: 'Consent is required for region selection' });
    }
    
    const result = await complianceService.assignUserRegion(userId, region, {
      reason: 'user_selection',
      ipAddress: req.ip
    });
    
    // 记录审计日志
    await auditLog({
      userId,
      action: AuditActions.DATA_REGION_CHANGED,
      details: { region, reason: 'user_selection' },
      req,
      service: 'user-service',
      db: req.app.locals.db
    });
    
    res.json({
      success: true,
      region: result.region_code,
      message: 'Data region updated successfully'
    });
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Failed to select data region');
    res.status(500).json({ error: 'Failed to select data region' });
  }
});

/**
 * GET /api/compliance/regions
 * 获取所有可用数据区域列表
 */
router.get('/regions', async (req, res) => {
  try {
    const result = await complianceService.db.query(
      'SELECT region_code, region_name, applicable_laws FROM data_regions WHERE is_active = true ORDER BY region_code'
    );
    
    res.json({
      regions: result.rows.map(r => ({
        code: r.region_code,
        name: r.region_name,
        laws: r.applicable_laws
      }))
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get regions');
    res.status(500).json({ error: 'Failed to get regions' });
  }
});

/**
 * GET /api/compliance/transfer-logs
 * 获取用户自己的数据传输日志
 */
router.get('/transfer-logs', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { startDate, endDate, limit = 50 } = req.query;
    
    const logs = await complianceService.getTransferLogs({
      userId,
      startDate,
      endDate,
      limit: parseInt(limit)
    });
    
    res.json({ logs });
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Failed to get transfer logs');
    res.status(500).json({ error: 'Failed to get transfer logs' });
  }
});

// ============================================
// 管理端 API
// ============================================

/**
 * POST /api/compliance/transfer-request
 * 创建跨境传输请求（管理员）
 */
router.post('/transfer-request', requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      sourceRegion,
      targetRegion,
      dataTypes,
      legalBasis,
      purpose,
      recipientInfo,
      dataSubjectsAffected
    } = req.body;
    
    // 验证必填字段
    if (!sourceRegion || !targetRegion || !dataTypes || !legalBasis || !purpose) {
      return res.status(400).json({
        error: 'Missing required fields: sourceRegion, targetRegion, dataTypes, legalBasis, purpose'
      });
    }
    
    const request = await complianceService.createTransferRequest({
      requesterId: req.user.id,
      sourceRegion,
      targetRegion,
      dataTypes,
      legalBasis,
      purpose,
      recipientInfo,
      dataSubjectsAffected
    });
    
    res.status(201).json({
      success: true,
      requestId: request.request_id,
      status: request.status,
      sccReference: request.scc_reference,
      message: 'Transfer request created successfully'
    });
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Failed to create transfer request');
    res.status(500).json({ error: err.message || 'Failed to create transfer request' });
  }
});

/**
 * GET /api/compliance/transfer-requests
 * 列出传输请求（管理员）
 */
router.get('/transfer-requests', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    
    let sql = 'SELECT * FROM data_transfer_requests WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (status) {
      sql += ` AND status = $${paramIndex++}`;
      params.push(status);
    }
    
    sql += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await complianceService.db.query(sql, params);
    
    res.json({ requests: result.rows });
  } catch (err) {
    logger.error({ err }, 'Failed to list transfer requests');
    res.status(500).json({ error: 'Failed to list transfer requests' });
  }
});

/**
 * POST /api/compliance/transfer-requests/:id/approve
 * 审批传输请求（管理员）
 */
router.post('/transfer-requests/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const requestId = parseInt(req.params.id);
    const approverId = req.user.id;
    const { decision, reason } = req.body;
    
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'Decision must be "approved" or "rejected"' });
    }
    
    if (decision === 'rejected' && !reason) {
      return res.status(400).json({ error: 'Reason is required for rejection' });
    }
    
    const result = await complianceService.approveTransferRequest(requestId, approverId, decision, reason);
    
    // 记录审计日志
    await auditLog({
      userId: approverId,
      action: decision === 'approved' ? AuditActions.TRANSFER_APPROVED : AuditActions.TRANSFER_REJECTED,
      details: { requestId, decision, reason },
      req,
      service: 'user-service',
      db: req.app.locals.db
    });
    
    res.json({
      success: true,
      requestId: result.request_id,
      status: result.status,
      message: `Transfer request ${decision}`
    });
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Failed to approve transfer request');
    res.status(500).json({ error: err.message || 'Failed to approve transfer request' });
  }
});

/**
 * POST /api/compliance/impact-assessment
 * 生成数据传输影响评估报告
 */
router.post('/impact-assessment', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { transferRequestId } = req.body;
    
    if (!transferRequestId) {
      return res.status(400).json({ error: 'transferRequestId is required' });
    }
    
    const assessment = await complianceService.generateImpactAssessment(transferRequestId);
    
    res.status(201).json({
      success: true,
      assessmentId: assessment.assessment_id,
      riskLevel: assessment.risk_level,
      recommendation: assessment.recommendation,
      legalGaps: assessment.legal_gaps
    });
  } catch (err) {
    logger.error({ err }, 'Failed to generate impact assessment');
    res.status(500).json({ error: err.message || 'Failed to generate impact assessment' });
  }
});

/**
 * GET /api/compliance/scc
 * 获取标准合同条款列表
 */
router.get('/scc', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await complianceService.db.query(
      `SELECT scc_code, scc_name, version, issuer, applicable_transfers, effective_date 
       FROM standard_contractual_clauses 
       WHERE is_active = true 
       ORDER BY scc_code`
    );
    
    res.json({ sccs: result.rows });
  } catch (err) {
    logger.error({ err }, 'Failed to get SCC list');
    res.status(500).json({ error: 'Failed to get SCC list' });
  }
});

/**
 * GET /api/compliance/stats
 * 获取合规统计信息（管理员）
 */
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const stats = await complianceService.getComplianceStats();
    
    res.json(stats);
  } catch (err) {
    logger.error({ err }, 'Failed to get compliance stats');
    res.status(500).json({ error: 'Failed to get compliance stats' });
  }
});

/**
 * POST /api/compliance/log-transfer
 * 记录数据传输（内部服务调用）
 */
router.post('/log-transfer', requireAuth, async (req, res) => {
  try {
    const {
      userId,
      sourceRegion,
      targetRegion,
      dataType,
      dataCategory,
      legalBasis,
      purpose,
      dataVolumeKb,
      metadata
    } = req.body;
    
    const log = await complianceService.logTransfer({
      userId,
      sourceRegion,
      targetRegion,
      dataType,
      dataCategory,
      legalBasis,
      purpose,
      dataVolumeKb,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      metadata
    });
    
    res.status(201).json({
      success: true,
      logId: log.id
    });
  } catch (err) {
    logger.error({ err }, 'Failed to log transfer');
    res.status(500).json({ error: 'Failed to log transfer' });
  }
});

module.exports = {
  router,
  initDataTransferRoutes
};
