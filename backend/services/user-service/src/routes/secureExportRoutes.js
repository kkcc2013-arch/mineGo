/**
 * REQ-00485: 安全导出 API 路由
 * 提供安全导出相关的 REST API
 */

const express = require('express');
const router = express.Router();
const SecureExportService = require('../services/secureExportService');
const authMiddleware = require('../../../shared/authMiddleware');

// 初始化服务（延迟初始化，需要依赖注入）
let secureExportService = null;

function initServices(db, redis, eventBus, notificationService) {
  secureExportService = new SecureExportService(db, redis, eventBus, notificationService);
  return secureExportService;
}

/**
 * GET /api/export/user
 * 用户导出自己的数据
 */
router.get('/user', async (req, res) => {
  try {
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const result = await secureExportService.secureExportUserData(userId, 'user');
    
    if (!result.success) {
      return res.status(429).json(result);
    }
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/export/batch-request
 * 管理员申请批量导出
 */
router.post('/batch-request', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const adminId = req.user.id;
    const { userIds, reason, filters } = req.body;
    
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'userIds is required and must be a non-empty array' });
    }
    
    const result = await secureExportService.submitBatchExportRequest(adminId, {
      userIds,
      reason,
      filters
    });
    
    if (!result.success) {
      return res.status(429).json(result);
    }
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/export/history
 * 获取用户导出历史
 */
router.get('/history', async (req, res) => {
  try {
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const history = await secureExportService.getUserExportHistory(userId);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/export/pending-requests
 * 获取待审批列表（管理员）
 */
router.get('/pending-requests', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    
    const requests = await secureExportService.getPendingRequests(
      parseInt(limit),
      parseInt(offset)
    );
    
    res.json(requests);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/export/approve/:requestId
 * 审批导出请求（管理员）
 */
router.post('/approve/:requestId', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const approverId = req.user.id;
    const { requestId } = req.params;
    const { comment } = req.body;
    
    const result = await secureExportService.approveExportRequest(
      requestId,
      approverId,
      comment || ''
    );
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/export/reject/:requestId
 * 拒绝导出请求（管理员）
 */
router.post('/reject/:requestId', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const approverId = req.user.id;
    const { requestId } = req.params;
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({ error: 'reason is required' });
    }
    
    const result = await secureExportService.rejectExportRequest(requestId, approverId, reason);
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/export/execute/:requestId
 * 执行已批准的批量导出（管理员）
 */
router.post('/execute/:requestId', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const { requestId } = req.params;
    
    const result = await secureExportService.executeBatchExport(requestId);
    
    if (!result.success) {
      return res.status(400).json(result);
    }
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/export/anomalies
 * 获取最近异常（管理员）
 */
router.get('/anomalies', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    
    const anomalies = await secureExportService.getRecentAnomalies(parseInt(limit));
    res.json(anomalies);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/export/high-risk-users
 * 获取高风险用户列表（管理员）
 */
router.get('/high-risk-users', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    
    const users = await secureExportService.getHighRiskUsers(parseInt(limit));
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/export/limit-status
 * 获取用户当前导出限制状态
 */
router.get('/limit-status', async (req, res) => {
  try {
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const result = await secureExportService.rateLimiter.checkUserExportLimit(userId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/export/init-tables
 * 初始化数据库表（管理员）
 */
router.post('/init-tables', authMiddleware.requireAdmin, async (req, res) => {
  try {
    await secureExportService.initializeTables();
    res.json({ success: true, message: 'Tables initialized successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
module.exports.initServices = initServices;