/**
 * REQ-00016: GDPR 路由
 * 数据导出、删除等 GDPR 合规 API
 */

const express = require('express');
const router = express.Router();
const GDPRService = require('./gdprService');
const { requireAuth, requireAdmin } = require('../../../../shared/auth');
const accountData = require('../gdpr/accountData');
const { auditLog, AuditActions } = require('../../../../shared/auditLog');
const { logger } = require('../../../../shared/logger');

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
 * GET /gdpr/export
 * 导出用户数据（GDPR 第 20 条：数据可携带权）—— REQ-00044
 * 覆盖所有引用 users 的业务表（运行时从外键元数据发现），JSON 附件下载
 */
router.get('/export', requireAuth, async (req, res) => {
  const userId = req.user.sub;
  try {
    const userData = await accountData.exportUserData(userId);
    if (!userData) return res.status(404).json({ error: 'User not found' });

    // 记录审计日志（失败不影响导出）
    auditLog({
      userId,
      action: AuditActions.DATA_EXPORTED,
      details: { format: 'json', tables: Object.keys(userData.data).length },
      req,
      service: 'user-service',
      db: req.app.locals.db
    }).catch(() => {});

    const filename = `minego-data-${userId}-${Date.now()}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(userData);
  } catch (err) {
    logger.error({ err, userId }, 'Data export failed');
    res.status(500).json({ error: 'Failed to export data' });
  }
});

/**
 * DELETE /gdpr/delete
 * 申请删除账号（GDPR 第 17 条：被遗忘权）—— REQ-00044
 * 进入冷却期（默认 30 天，GDPR_DELETION_COOLDOWN_DAYS），期间可撤销；到期后自动清理所有关联数据
 */
router.delete('/delete', requireAuth, async (req, res) => {
  const userId = req.user.sub;
  try {
    const { confirmation, reason } = req.body || {};
    if (confirmation !== 'DELETE MY ACCOUNT') {
      return res.status(400).json({ error: 'Please type "DELETE MY ACCOUNT" to confirm' });
    }
    const { request, created } = await accountData.requestDeletion(userId, reason);
    auditLog({
      userId, action: AuditActions.DATA_DELETION_REQUESTED || 'DATA_DELETION_REQUESTED',
      details: { requestId: request.id, scheduledFor: request.scheduled_for }, req, service: 'user-service',
      db: req.app.locals.db
    }).catch(() => {});
    res.status(created ? 202 : 200).json({
      success: true,
      requestId: request.id,
      status: request.status,
      scheduledFor: request.scheduled_for,
      cooldownDays: accountData.COOLDOWN_DAYS,
      message: `账号将在 ${accountData.COOLDOWN_DAYS} 天冷却期后删除，期间可随时撤销`,
    });
  } catch (err) {
    logger.error({ err, userId }, 'Data deletion request failed');
    res.status(500).json({ error: 'Failed to request data deletion' });
  }
});

/**
 * POST /gdpr/delete/cancel
 * 冷却期内撤销删除申请
 */
router.post('/delete/cancel', requireAuth, async (req, res) => {
  const userId = req.user.sub;
  try {
    const cancelled = await accountData.cancelDeletion(userId);
    if (!cancelled) return res.status(404).json({ error: 'No pending deletion request' });
    res.json({ success: true, requestId: cancelled.id, status: cancelled.status });
  } catch (err) {
    logger.error({ err, userId }, 'Cancel deletion failed');
    res.status(500).json({ error: 'Failed to cancel deletion' });
  }
});

/**
 * GET /gdpr/status
 * 删除申请状态
 */
router.get('/status', requireAuth, async (req, res) => {
  try {
    const requests = await accountData.getDeletionStatus(req.user.sub);
    res.json({ hasRequest: requests.length > 0, latest: requests[0] || null, history: requests });
  } catch (err) {
    logger.error({ err }, 'Failed to get deletion status');
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * POST /gdpr/admin/deletions/:id/execute
 * 管理员立即执行删除（如监管/法务要求跳过冷却期）
 */
router.post('/admin/deletions/:id/execute', requireAuth, requireAdmin, async (req, res) => {
  try {
    const results = await accountData.processDueDeletions({ requestId: req.params.id });
    if (!results.length) return res.status(404).json({ error: 'No pending request with this id' });
    res.json({ success: true, result: results[0] });
  } catch (err) {
    logger.error({ err }, 'Admin deletion execute failed');
    res.status(500).json({ error: 'Failed to execute deletion' });
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
