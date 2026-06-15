/**
 * REQ-00107: 数据生命周期管理 API 路由
 * 
 * 提供数据生命周期管理的 API 接口
 */

'use strict';

const express = require('express');
const router = express.Router();
const DataLifecycleManager = require('../../../shared/DataLifecycleManager');
const { requireAuth } = require('../../../shared/auth');
const logger = require('../../../shared/logger');

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

// ==================== 用户端 API ====================

/**
 * POST /api/users/:userId/request-data-deletion
 * 用户请求数据删除（GDPR Right to Erasure）
 */
router.post('/users/:userId/request-data-deletion', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // 权限检查
    if (req.user.id !== userId && !req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: '无权操作' }
      });
    }

    const { deletionType = 'scheduled' } = req.body; // 'immediate' or 'scheduled'
    
    let result;
    if (deletionType === 'immediate') {
      // 立即删除（需要二次验证）
      result = await DataLifecycleManager.deleteUserData(userId, {
        immediate: true,
        reason: 'User requested immediate deletion',
        performedBy: req.user.id
      });
    } else {
      // 计划删除（30 天后执行）
      result = await DataLifecycleManager.scheduleUserDeletion(userId, {
        delayDays: 30
      });
    }

    logger.info('User data deletion requested', {
      userId,
      deletionType,
      requestId: result.id || 'immediate'
    });

    res.json({
      success: true,
      data: {
        deletionType,
        requestId: result.id,
        scheduledAt: result.scheduled_deletion_at,
        message: deletionType === 'immediate' 
          ? '数据已删除' 
          : '删除请求已创建，将在 30 天后执行'
      }
    });
  } catch (error) {
    logger.error('Failed to request data deletion', {
      error: error.message,
      userId: req.params.userId
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

/**
 * GET /api/users/:userId/data-deletion-status
 * 查询数据删除状态
 */
router.get('/users/:userId/data-deletion-status', requireAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // 权限检查
    if (req.user.id !== userId && !req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: '无权访问' }
      });
    }

    const status = await DataLifecycleManager.getDeletionStatus(userId);

    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('Failed to get deletion status', {
      error: error.message,
      userId: req.params.userId
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

// ==================== 管理员 API ====================

/**
 * GET /api/admin/data-lifecycle/categories
 * 获取所有数据类别配置
 */
router.get('/admin/data-lifecycle/categories', requireAuth, requireAdmin, async (req, res) => {
  try {
    const categories = DataLifecycleManager.getAllCategories();
    res.json({ success: true, data: categories });
  } catch (error) {
    logger.error('Failed to get categories', { error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

/**
 * GET /api/admin/data-lifecycle/stats
 * 获取数据生命周期统计
 */
router.get('/admin/data-lifecycle/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const stats = await DataLifecycleManager.getDataLifecycleStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    logger.error('Failed to get lifecycle stats', { error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

/**
 * GET /api/admin/data-lifecycle/expired/:category
 * 获取指定类别的过期数据
 */
router.get('/admin/data-lifecycle/expired/:category', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { category } = req.params;
    const expired = await DataLifecycleManager.identifyExpiredData(category);
    res.json({ success: true, data: expired });
  } catch (error) {
    logger.error('Failed to identify expired data', {
      error: error.message,
      category: req.params.category
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

/**
 * POST /api/admin/data-lifecycle/cleanup/:category
 * 手动触发数据清理
 */
router.post('/admin/data-lifecycle/cleanup/:category', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { category } = req.params;
    const { reason } = req.body;

    const result = await DataLifecycleManager.cleanupData(category, {
      reason: reason || 'Manual cleanup by admin',
      performedBy: req.user.id
    });

    logger.info('Manual cleanup triggered', {
      category,
      adminId: req.user.id,
      result
    });

    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Failed to trigger cleanup', {
      error: error.message,
      category: req.params.category
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

/**
 * GET /api/admin/data-lifecycle/audit-logs
 * 获取清理审计日志
 */
router.get('/admin/data-lifecycle/audit-logs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;

    const logs = await DataLifecycleManager.getAuditLogs({ limit, offset });
    res.json({ success: true, data: logs });
  } catch (error) {
    logger.error('Failed to get audit logs', { error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

/**
 * GET /api/admin/data-lifecycle/jobs/status
 * 获取清理任务状态
 */
router.get('/admin/data-lifecycle/jobs/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    // 动态导入避免循环依赖
    const { getJobsStatus } = require('../../../jobs/cleanupJobs');
    const status = getJobsStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('Failed to get jobs status', { error: error.message });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: error.message }
    });
  }
});

module.exports = router;
