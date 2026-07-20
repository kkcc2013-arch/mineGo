/**
 * REQ-00053: 用户隐私偏好管理中心 API 路由
 */

const express = require('express');
const router = express.Router();
const logger = require('../../../../shared/logger');
const { auditLog, AuditActions } = require('../../../../shared/auditLog');
const { 
  PrivacyPreferencesService, 
  PrivacyPolicyService,
  DATA_CATEGORIES 
} = require('../../../../shared/privacyPreferences');

let privacyService;
let policyService;
let db;

/**
 * 初始化路由
 */
function initPrivacyRoutes(database) {
  db = database;
  privacyService = new PrivacyPreferencesService(db);
  policyService = new PrivacyPolicyService(db);
}

/**
 * 管理员权限检查中间件
 * 兼容 req.user.role === 'admin'（deviceIntegrity 风格）与 req.user.isAdmin（tutorial/captcha 风格）
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: '未授权'
    });
  }
  if (req.user.role !== 'admin' && !req.user.isAdmin) {
    return res.status(403).json({
      success: false,
      error: '需要管理员权限'
    });
  }
  next();
}

/**
 * 获取数据类别列表
 * GET /api/v1/privacy/categories
 */
router.get('/categories', async (req, res) => {
  try {
    const language = req.headers['accept-language'] || 'zh-CN';
    const categories = privacyService.getDataCategories(language);
    
    res.json({
      success: true,
      data: categories
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get data categories');
    res.status(500).json({
      success: false,
      error: '获取数据类别失败'
    });
  }
});

/**
 * 获取用户隐私偏好
 * GET /api/v1/privacy/preferences
 */
router.get('/preferences', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: '未授权'
      });
    }
    
    const preferences = await privacyService.getUserPreferences(userId);
    
    // 获取当前政策版本和接受状态
    const currentPolicy = await policyService.getCurrentPolicy();
    const hasAccepted = await policyService.hasAcceptedLatestPolicy(userId);
    
    res.json({
      success: true,
      data: {
        userId,
        preferences,
        currentPolicyVersion: currentPolicy?.version || null,
        policyAccepted: hasAccepted,
        categories: privacyService.getDataCategories(req.headers['accept-language'] || 'zh-CN')
      }
    });
  } catch (error) {
    logger.error({ error: error.message, userId: req.user?.id }, 'Failed to get privacy preferences');
    res.status(500).json({
      success: false,
      error: '获取隐私偏好失败'
    });
  }
});

/**
 * 更新用户隐私偏好
 * PATCH /api/v1/privacy/preferences
 */
router.patch('/preferences', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: '未授权'
      });
    }
    
    const updates = req.body;
    
    // 验证输入
    const validCategories = Object.values(DATA_CATEGORIES).map(c => c.id);
    for (const [category, collectable] of Object.entries(updates)) {
      if (!validCategories.includes(category)) {
        return res.status(400).json({
          success: false,
          error: `无效的数据类别: ${category}`
        });
      }
      if (typeof collectable !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: `无效的值: ${category}`
        });
      }
    }
    
    const result = await privacyService.updateUserPreferences(userId, updates);
    
    // 记录审计日志
    await auditLog(userId, AuditActions.PRIVACY_PREFERENCE_CHANGE, 'privacy', 'preferences', {
      updates,
      timestamp: new Date().toISOString()
    });
    
    res.json({
      success: result.success,
      data: {
        updated: result.updated,
        errors: result.errors
      }
    });
  } catch (error) {
    logger.error({ error: error.message, userId: req.user?.id }, 'Failed to update privacy preferences');
    res.status(500).json({
      success: false,
      error: '更新隐私偏好失败'
    });
  }
});

/**
 * 获取当前隐私政策
 * GET /api/v1/privacy/policy
 */
router.get('/policy', async (req, res) => {
  try {
    const language = req.headers['accept-language'] || 'zh-CN';
    const policy = await policyService.getCurrentPolicy(language);
    
    if (!policy) {
      return res.status(404).json({
        success: false,
        error: '隐私政策不存在'
      });
    }
    
    // 获取历史版本列表
    const history = await policyService.getVersionHistory(10);
    
    res.json({
      success: true,
      data: {
        current: policy,
        previousVersions: history.slice(1) // 排除当前版本
      }
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get privacy policy');
    res.status(500).json({
      success: false,
      error: '获取隐私政策失败'
    });
  }
});

/**
 * 检查是否需要接受新政策
 * GET /api/v1/privacy/policy/check
 * 注意：必须注册在 /policy/:version 之前，否则会被参数路由遮蔽
 */
router.get('/policy/check', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: '未授权'
      });
    }

    const currentPolicy = await policyService.getCurrentPolicy();
    if (!currentPolicy) {
      return res.json({
        success: true,
        data: {
          needsAccept: false,
          version: null
        }
      });
    }

    const hasAccepted = await policyService.hasAcceptedLatestPolicy(userId);

    res.json({
      success: true,
      data: {
        needsAccept: !hasAccepted,
        version: currentPolicy.version,
        effectiveDate: currentPolicy.effectiveDate,
        changes: currentPolicy.changes
      }
    });
  } catch (error) {
    logger.error({ error: error.message, userId: req.user?.id }, 'Failed to check policy acceptance');
    res.status(500).json({
      success: false,
      error: '检查政策状态失败'
    });
  }
});

/**
 * 获取特定版本隐私政策
 * GET /api/v1/privacy/policy/:version
 */
router.get('/policy/:version', async (req, res) => {
  try {
    const { version } = req.params;
    const language = req.headers['accept-language'] || 'zh-CN';
    
    const policy = await policyService.getPolicyByVersion(version, language);
    
    if (!policy) {
      return res.status(404).json({
        success: false,
        error: '隐私政策版本不存在'
      });
    }
    
    res.json({
      success: true,
      data: policy
    });
  } catch (error) {
    logger.error({ error: error.message, version: req.params.version }, 'Failed to get privacy policy version');
    res.status(500).json({
      success: false,
      error: '获取隐私政策版本失败'
    });
  }
});

/**
 * 接受隐私政策
 * POST /api/v1/privacy/policy/accept
 */
router.post('/policy/accept', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: '未授权'
      });
    }
    
    const { version } = req.body;
    const currentPolicy = await policyService.getCurrentPolicy();
    
    if (!currentPolicy) {
      return res.status(404).json({
        success: false,
        error: '隐私政策不存在'
      });
    }
    
    // 如果未指定版本，使用当前版本
    const acceptVersion = version || currentPolicy.version;
    
    await policyService.recordAcceptance(userId, acceptVersion);
    
    // 初始化用户隐私偏好（如果是首次接受）
    await privacyService.initializeUserPreferences(userId);
    
    // 记录审计日志
    await auditLog(userId, AuditActions.PRIVACY_POLICY_ACCEPT, 'privacy', 'policy', {
      version: acceptVersion,
      timestamp: new Date().toISOString()
    });
    
    res.json({
      success: true,
      data: {
        version: acceptVersion,
        acceptedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error({ error: error.message, userId: req.user?.id }, 'Failed to accept privacy policy');
    res.status(500).json({
      success: false,
      error: '接受隐私政策失败'
    });
  }
});

/**
 * 获取数据透明度报告
 * GET /api/v1/privacy/report
 */
router.get('/report', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: '未授权'
      });
    }
    
    const { month } = req.query;
    
    // 如果没有指定月份，获取上个月
    let reportMonth = month;
    if (!reportMonth) {
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      reportMonth = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;
    }
    
    const report = await privacyService.getFullReport(userId, reportMonth);
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    logger.error({ error: error.message, userId: req.user?.id }, 'Failed to get transparency report');
    res.status(500).json({
      success: false,
      error: '获取透明度报告失败'
    });
  }
});

/**
 * 获取报告历史
 * GET /api/v1/privacy/report/history
 */
router.get('/report/history', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: '未授权'
      });
    }
    
    const { limit = 12 } = req.query;
    const history = await privacyService.getReportHistory(userId, parseInt(limit));
    
    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    logger.error({ error: error.message, userId: req.user?.id }, 'Failed to get report history');
    res.status(500).json({
      success: false,
      error: '获取报告历史失败'
    });
  }
});

/**
 * 生成报告（手动触发）
 * POST /api/v1/privacy/report/generate
 */
router.post('/report/generate', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: '未授权'
      });
    }
    
    const { month } = req.body;
    
    // 如果没有指定月份，获取上个月
    let reportMonth = month;
    if (!reportMonth) {
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      reportMonth = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;
    }
    
    const report = await privacyService.generateMonthlyReport(userId, reportMonth);
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    logger.error({ error: error.message, userId: req.user?.id }, 'Failed to generate report');
    res.status(500).json({
      success: false,
      error: '生成报告失败'
    });
  }
});

/**
 * 管理员：创建新隐私政策版本
 * POST /api/v1/privacy/admin/policy
 */
router.post('/admin/policy', requireAdmin, async (req, res) => {
  try {
    const { version, effectiveDate, changes, contentZh, contentEn, contentJa } = req.body;
    
    if (!version || !effectiveDate || !contentZh || !contentEn || !contentJa) {
      return res.status(400).json({
        success: false,
        error: '缺少必要字段'
      });
    }
    
    const policy = await policyService.createPolicyVersion(
      version, 
      effectiveDate, 
      changes || [], 
      contentZh, 
      contentEn, 
      contentJa
    );
    
    res.json({
      success: true,
      data: policy
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to create policy version');
    res.status(500).json({
      success: false,
      error: '创建隐私政策版本失败'
    });
  }
});

/**
 * 管理员：获取未接受最新政策的用户
 * GET /api/v1/privacy/admin/pending-users
 */
router.get('/admin/pending-users', requireAdmin, async (req, res) => {
  try {
    const { limit = 1000 } = req.query;
    const users = await policyService.getUsersNotAcceptedLatestPolicy(parseInt(limit));
    
    res.json({
      success: true,
      data: users
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get pending users');
    res.status(500).json({
      success: false,
      error: '获取待通知用户失败'
    });
  }
});

module.exports = {
  router,
  initPrivacyRoutes
};
