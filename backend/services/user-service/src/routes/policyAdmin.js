/**
 * REQ-00497: 管理员隐私政策管理 API
 * 
 * 功能：
 * - 创建/编辑/发布政策版本
 * - 查看确认统计
 * - 调度变更通知
 * - 管理政策列表
 * 
 * @module backend/services/user-service/src/routes/policyAdmin
 */

'use strict';

const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { createLogger } = require('../../../../shared/logger');
const { auditLog, AuditActions } = require('../../../../shared/auditLog');
const {
  getPrivacyPolicyService,
  POLICY_TYPES,
  POLICY_STATUS
} = require('../../../../shared/privacyPolicyService');
const {
  getPolicyNotificationService,
  NOTIFICATION_TYPES
} = require('../../../../shared/policyNotificationService');
const { AppError, successResp, errorResp } = require('../../../../shared/errors');

const logger = createLogger('policy-admin');

/**
 * 管理员权限检查
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json(errorResp(1001, '未授权'));
  }
  if (req.user.role !== 'admin' && !req.user.isAdmin) {
    return res.status(403).json(errorResp(1002, '需要管理员权限'));
  }
  next();
}

/**
 * 管理员路由初始化
 */
function initPolicyAdminRoutes() {
  // 所有路由需要管理员权限
  router.use(requireAdmin);

  const policyService = getPrivacyPolicyService();
  const notificationService = getPolicyNotificationService();

  // ── Schemas ───────────────────────────────────────────────────

  const CreatePolicySchema = z.object({
    policyType: z.enum(['privacy_policy', 'terms_of_service', 'cookie_policy', 'marketing_consent']).default('privacy_policy'),
    title: z.string().min(5).max(200),
    contentUrl: z.string().url(),
    summary: z.string().min(10).max(500).optional(),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
    mandatoryConfirm: z.boolean().default(true)
  });

  const PublishPolicySchema = z.object({
    policyId: z.number().int().positive(),
    notifyUsers: z.boolean().default(true),
    notificationChannels: z.array(z.enum(['email', 'push', 'in_app', 'sms'])).optional()
  });

  const ScheduleNotificationsSchema = z.object({
    policyId: z.number().int().positive(),
    channels: z.array(z.enum(['email', 'push', 'in_app', 'sms'])).default(['email', 'in_app']),
    scheduledAt: z.string().optional()
  });

  // ── GET /admin/policies - 获取政策列表 ──────────────────────────────────

  router.get('/policies', async (req, res, next) => {
    try {
      const { type, status, limit = 20, offset = 0 } = req.query;

      let query = 'SELECT * FROM privacy_policies';
      const conditions = [];
      const params = [];

      if (type) {
        conditions.push(`policy_type = $${params.length + 1}`);
        params.push(type);
      }

      if (status) {
        conditions.push(`status = $${params.length + 1}`);
        params.push(status);
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      query += ` ORDER BY effective_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(parseInt(limit), parseInt(offset));

      const result = await executeQuery(query, params);

      res.json(successResp({
        policies: result.rows,
        total: result.rows.length,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }));

    } catch (err) {
      next(err);
    }
  });

  // ── GET /admin/policies/:id - 获取政策详情 ──────────────────────────────────

  router.get('/policies/:id', async (req, res, next) => {
    try {
      const { id } = req.params;

      const result = await executeQuery(
        'SELECT * FROM privacy_policies WHERE id = $1',
        [parseInt(id)]
      );

      if (result.rows.length === 0) {
        throw new AppError(2008, '政策不存在', 404);
      }

      // 获取确认统计
      const stats = await policyService.getPolicyConfirmationStats(parseInt(id));

      res.json(successResp({
        policy: result.rows[0],
        confirmationStats: stats
      }));

    } catch (err) {
      next(err);
    }
  });

  // ── POST /admin/policies - 创建新政策 ──────────────────────────────────

  router.post('/policies', async (req, res, next) => {
    try {
      const data = CreatePolicySchema.parse(req.body);
      const adminId = req.user.sub;

      const policy = await policyService.createPolicy({
        policyType: data.policyType,
        title: data.title,
        contentUrl: data.contentUrl,
        summary: data.summary,
        effectiveDate: new Date(data.effectiveDate),
        mandatoryConfirm: data.mandatoryConfirm,
        createdBy: adminId
      });

      await auditLog(AuditActions.POLICY_CREATED, adminId, {
        policyId: policy.id,
        policyType: policy.policy_type,
        title: policy.title
      });

      logger.info('Policy created by admin', {
        adminId,
        policyId: policy.id,
        policyType: policy.policy_type
      });

      res.json(successResp({
        policy,
        message: '政策已创建，状态为草稿'
      }));

    } catch (err) {
      next(err);
    }
  });

  // ── PUT /admin/policies/:id - 更新政策 ──────────────────────────────────

  router.put('/policies/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const adminId = req.user.sub;

      // 只允许更新草稿状态的政策
      const existing = await executeQuery(
        'SELECT * FROM privacy_policies WHERE id = $1',
        [parseInt(id)]
      );

      if (existing.rows.length === 0) {
        throw new AppError(2008, '政策不存在', 404);
      }

      if (existing.rows[0].status !== POLICY_STATUS.DRAFT) {
        throw new AppError(1003, '只能修改草稿状态的政策', 400);
      }

      const allowedFields = ['title', 'contentUrl', 'summary', 'mandatoryConfirm'];
      const updateFields = [];
      const params = [parseInt(id)];

      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          updateFields.push(`${field.toLowerCase()} = $${params.length + 1}`);
          params.push(updates[field]);
        }
      }

      if (updateFields.length === 0) {
        return res.json(successResp({ message: '无更新内容' }));
      }

      const result = await executeQuery(
        `UPDATE privacy_policies SET ${updateFields.join(', ')} WHERE id = $1 RETURNING *`,
        params
      );

      await auditLog(AuditActions.POLICY_UPDATED, adminId, {
        policyId: parseInt(id),
        updates
      });

      res.json(successResp({
        policy: result.rows[0],
        message: '政策已更新'
      }));

    } catch (err) {
      next(err);
    }
  });

  // ── POST /admin/policies/publish - 发布政策 ──────────────────────────────────

  router.post('/policies/publish', async (req, res, next) => {
    try {
      const { policyId, notifyUsers, notificationChannels } = PublishPolicySchema.parse(req.body);
      const adminId = req.user.sub;

      // 检查政策状态
      const existing = await executeQuery(
        'SELECT * FROM privacy_policies WHERE id = $1',
        [policyId]
      );

      if (existing.rows.length === 0) {
        throw new AppError(2008, '政策不存在', 404);
      }

      if (existing.rows[0].status !== POLICY_STATUS.DRAFT) {
        throw new AppError(1003, '只能发布草稿状态的政策', 400);
      }

      // 发布政策
      await policyService.publishPolicy(policyId, adminId);

      // 调度通知
      if (notifyUsers) {
        const channels = notificationChannels || [NOTIFICATION_TYPES.EMAIL, NOTIFICATION_TYPES.IN_APP];
        await notificationService.schedulePolicyUpdateNotifications(policyId, { channels });
      }

      await auditLog(AuditActions.POLICY_PUBLISHED, adminId, {
        policyId,
        notifyUsers,
        notificationChannels
      });

      logger.info('Policy published by admin', {
        adminId,
        policyId,
        notifyUsers
      });

      res.json(successResp({
        policyId,
        message: '政策已发布',
        notificationScheduled: notifyUsers
      }));

    } catch (err) {
      next(err);
    }
  });

  // ── GET /admin/policies/:id/stats - 获取确认统计 ──────────────────────────────────

  router.get('/policies/:id/stats', async (req, res, next) => {
    try {
      const { id } = req.params;

      const stats = await policyService.getPolicyConfirmationStats(parseInt(id));
      const notificationStats = await notificationService.getNotificationStats(parseInt(id));

      res.json(successResp({
        confirmationStats: stats,
        notificationStats
      }));

    } catch (err) {
      next(err);
    }
  });

  // ── POST /admin/policies/:id/notifications - 调度通知 ──────────────────────────────────

  router.post('/policies/:id/notifications', async (req, res, next) => {
    try {
      const { id } = req.params;
      const { channels, scheduledAt } = ScheduleNotificationsSchema.parse({
        policyId: parseInt(id),
        ...req.body
      });

      const result = await notificationService.schedulePolicyUpdateNotifications(parseInt(id), {
        channels,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : new Date()
      });

      await auditLog(AuditActions.POLICY_NOTIFICATION_SCHEDULED, req.user.sub, {
        policyId: parseInt(id),
        channels,
        scheduledCount: result.scheduledCount
      });

      res.json(successResp({
        policyId: parseInt(id),
        scheduledCount: result.scheduledCount,
        channels
      }));

    } catch (err) {
      next(err);
    }
  });

  // ── POST /admin/policies/:id/notifications/retry - 重试失败通知 ──────────────────────────────────

  router.post('/policies/:id/notifications/retry', async (req, res, next) => {
    try {
      const { id } = req.params;

      const result = await notificationService.retryFailedNotifications(parseInt(id));

      res.json(successResp({
        policyId: parseInt(id),
        retriedCount: result.retriedCount,
        message: `已重新调度 ${result.retriedCount} 个失败通知`
      }));

    } catch (err) {
      next(err);
    }
  });

  // ── GET /admin/policies/users/:userId - 获取用户确认状态 ──────────────────────────────────

  router.get('/users/:userId', async (req, res, next) => {
    try {
      const { userId } = req.params;

      const status = await policyService.checkUserConfirmationStatus(parseInt(userId));
      const history = await policyService.getUserConfirmationHistory(parseInt(userId));

      res.json(successResp({
        userId: parseInt(userId),
        confirmationStatus: status,
        history
      }));

    } catch (err) {
      next(err);
    }
  });

  return router;
}

// 简化的查询函数（避免依赖外部db模块）
async function executeQuery(query, params) {
  const { query: dbQuery } = require('../../../../shared/db');
  return dbQuery(query, params);
}

module.exports = {
  initPolicyAdminRoutes,
  router
};