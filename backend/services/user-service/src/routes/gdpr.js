/**
 * REQ-00016: GDPR 路由
 * 数据导出、删除等 GDPR 合规 API
 */

const express = require('express');
const router = express.Router();
const GDPRService = require('./gdprService');
const { requireAuth } = require('../../../../shared/auth');
const { auditLog, AuditActions } = require('../../../../shared/auditLog');
const logger = require('../../../../shared/logger');

// 初始化服务
let gdprService = null;

function initGDPRRoutes(db, eventBus) {
  gdprService = new GDPRService(db, eventBus);
  return router;
}

/**
 * GET /api/gdpr/privacy-policy
 * 获取隐私政策
 */
router.get('/privacy-policy', async (req, res) => {
  try {
    const { version } = req.query;
    const policy = await gdprService.getPrivacyPolicy(version);
    
    if (!policy) {
      return res.status(404).json({ error: 'Privacy policy not found' });
    }
    
    res.json(policy);
  } catch (err) {
    logger.error({ err }, 'Failed to get privacy policy');
    res.status(500).json({ error: 'Failed to get privacy policy' });
  }
});

/**
 * GET /api/gdpr/export
 * 导出用户数据（GDPR 第 20 条：数据可携带权）
 */
router.get('/export', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // 记录审计日志
    await auditLog({
      userId,
      action: AuditActions.DATA_EXPORTED,
      details: { format: 'json' },
      req,
      service: 'user-service',
      db: req.app.locals.db
    });
    
    // 导出数据
    const userData = await gdprService.exportUserData(userId);
    
    // 设置下载头
    const filename = `minego-data-${userId}-${Date.now()}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    res.json(userData);
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Data export failed');
    res.status(500).json({ error: 'Failed to export data' });
  }
});

/**
 * DELETE /api/gdpr/delete
 * 删除用户数据（GDPR 第 17 条：被遗忘权）
 */
router.delete('/delete', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { confirmation } = req.body;
    
    // 验证确认
    if (confirmation !== 'DELETE MY ACCOUNT') {
      return res.status(400).json({
        error: 'Please type "DELETE MY ACCOUNT" to confirm'
      });
    }
    
    // 请求删除
    const result = await gdprService.requestDataDeletion(userId, {
      reason: 'user_request',
      req
    });
    
    res.json(result);
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Data deletion request failed');
    res.status(500).json({ error: 'Failed to request data deletion' });
  }
});

/**
 * POST /api/gdpr/delete/confirm
 * 确认数据删除（通过邮件链接）
 */
router.post('/delete/confirm', async (req, res) => {
  try {
    const { token } = req.body;
    
    // 查找删除请求
    const result = await gdprService.db.query(`
      SELECT id, user_id, status
      FROM data_deletion_requests
      WHERE confirmation_token = $1
    `, [token]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid confirmation token' });
    }
    
    const request = result.rows[0];
    
    if (request.status !== 'pending') {
      return res.status(400).json({ 
        error: `Deletion already ${request.status}` 
      });
    }
    
    // 执行删除
    await gdprService.executeDataDeletion(request.user_id, request.id);
    
    res.json({ 
      success: true, 
      message: 'Your data has been deleted.' 
    });
  } catch (err) {
    logger.error({ err }, 'Data deletion confirmation failed');
    res.status(500).json({ error: 'Failed to confirm data deletion' });
  }
});

/**
 * GET /api/gdpr/status
 * 获取删除请求状态
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await gdprService.db.query(`
      SELECT id, status, requested_at, completed_at
      FROM data_deletion_requests
      WHERE user_id = $1
      ORDER BY requested_at DESC
      LIMIT 1
    `, [userId]);
    
    if (result.rows.length === 0) {
      return res.json({ hasRequest: false });
    }
    
    res.json({
      hasRequest: true,
      ...result.rows[0]
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get deletion status');
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * POST /api/gdpr/consent
 * 记录用户同意
 */
router.post('/consent', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { privacyPolicyVersion, termsVersion } = req.body;
    
    await gdprService.recordConsent(userId, {
      privacyPolicyVersion,
      termsVersion,
      req
    });
    
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Failed to record consent');
    res.status(500).json({ error: 'Failed to record consent' });
  }
});

/**
 * POST /api/gdpr/withdraw
 * 撤回同意
 */
router.post('/withdraw', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    await gdprService.withdrawConsent(userId);
    
    res.json({ 
      success: true,
      message: 'Consent withdrawn. Your data will be deleted within 30 days.'
    });
  } catch (err) {
    logger.error({ err }, 'Failed to withdraw consent');
    res.status(500).json({ error: 'Failed to withdraw consent' });
  }
});

/**
 * GET /api/gdpr/audit-logs
 * 获取用户审计日志
 */
router.get('/audit-logs', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 100, action } = req.query;
    
    const { getUserAuditLogs } = require('../../shared/auditLog');
    const logs = await getUserAuditLogs(
      userId,
      { limit: parseInt(limit), action },
      gdprService.db
    );
    
    res.json(logs);
  } catch (err) {
    logger.error({ err }, 'Failed to get audit logs');
    res.status(500).json({ error: 'Failed to get audit logs' });
  }
});

module.exports = { router, initGDPRRoutes };
