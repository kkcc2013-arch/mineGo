/**
 * REQ-00497: 隐私政策确认检查中间件
 * 
 * 功能：
 * - 检查用户是否已确认最新隐私政策
 * - 未确认时返回 403 PrivacyAgreementUpdateRequired
 * - 提供需要确认的政策列表
 * 
 * @module backend/gateway/src/middleware/privacyCheck
 */

'use strict';

const { getPrivacyPolicyService, POLICY_STATUS } = require('../../../shared/privacyPolicyService');
const { createLogger } = require('../../../shared/logger');
const { getRedisClient } = require('../../../shared/cache');

const logger = createLogger('privacy-check-middleware');

/**
 * 需要检查隐私政策确认的路径
 * 这些路径会在用户确认隐私政策后才能访问
 */
const PROTECTED_PATHS = [
  '/api/v1/catch',
  '/api/v1/battle',
  '/api/v1/gym',
  '/api/v1/pokemon/',
  '/api/v1/social/',
  '/api/v1/reward/claim',
  '/api/v1/payment',
  '/api/v1/user/profile'
];

/**
 * 排除路径（不需要检查）
 */
const EXCLUDED_PATHS = [
  '/api/v1/auth/',
  '/api/v1/privacy/',
  '/api/v1/admin/',
  '/health',
  '/metrics'
];

/**
 * 检查路径是否需要隐私政策确认
 */
function isProtectedPath(path) {
  // 检查是否在排除列表中
  for (const excluded of EXCLUDED_PATHS) {
    if (path.startsWith(excluded)) {
      return false;
    }
  }

  // 检查是否在保护列表中
  for (const protected of PROTECTED_PATHS) {
    if (path.startsWith(protected)) {
      return true;
    }
  }

  return false;
}

/**
 * 创建隐私政策检查中间件
 * @param {Object} options 配置选项
 * @returns {Function} 中间件函数
 */
function createPrivacyCheckMiddleware(options = {}) {
  const {
    skipCheck = false,
    gracePeriodMs = 0,
    redirectToLogin = false
  } = options;

  return async function privacyCheckMiddleware(req, res, next) {
    // 跳过检查
    if (skipCheck) {
      return next();
    }

    // 未登录用户跳过
    if (!req.user || !req.user.sub) {
      return next();
    }

    const path = req.path;

    // 非保护路径跳过
    if (!isProtectedPath(path)) {
      return next();
    }

    const userId = req.user.sub;

    try {
      const privacyService = getPrivacyPolicyService();
      const redis = getRedisClient();

      // 尝试从缓存获取状态
      const cacheKey = `privacy:status:${userId}`;
      const cachedStatus = await redis.get(cacheKey);

      if (cachedStatus !== null) {
        const status = JSON.parse(cachedStatus);
        
        if (status.isUpToDate) {
          return next();
        }

        // 未确认，返回需要更新
        return sendPolicyUpdateRequired(res, status);
      }

      // 从数据库检查
      const status = await privacyService.checkUserConfirmationStatus(userId);

      // 缓存状态（5分钟）
      await redis.setex(cacheKey, 300, JSON.stringify(status));

      if (status.isUpToDate) {
        return next();
      }

      return sendPolicyUpdateRequired(res, status);

    } catch (error) {
      logger.error('Privacy check failed', {
        error: error.message,
        userId,
        path
      });

      // 错误时不阻止用户，继续请求
      return next();
    }
  };
}

/**
 * 返回政策更新需要确认的响应
 */
function sendPolicyUpdateRequired(res, status) {
  const code = 'PRIVACY_POLICY_UPDATE_REQUIRED';
  
  res.status(403).json({
    success: false,
    error: '隐私政策已更新，请先确认新政策',
    code,
    data: {
      confirmationStatus: status,
      message: '请前往隐私政策页面确认最新的服务条款和隐私政策',
      action: 'CONFIRM_PRIVACY_POLICY',
      pendingPolicies: status.pendingPolicies,
      outdatedPolicies: status.outdatedPolicies
    }
  });
}

/**
 * 清除用户隐私政策状态缓存
 * 在用户确认政策后调用
 */
async function clearPrivacyStatusCache(userId) {
  try {
    const redis = getRedisClient();
    await redis.del(`privacy:status:${userId}`);
    logger.debug('Privacy status cache cleared', { userId });
  } catch (error) {
    logger.warn('Failed to clear privacy status cache', {
      userId,
      error: error.message
    });
  }
}

/**
 * 隐私政策确认页面路由
 */
function setupPrivacyRoutes(app) {
  const privacyService = getPrivacyPolicyService();

  /**
   * GET /api/v1/privacy/pending
   * 获取待确认的政策列表
   */
  app.get('/api/v1/privacy/pending', async (req, res) => {
    try {
      const userId = req.user?.sub;
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          error: '未授权'
        });
      }

      const pendingPolicies = await privacyService.getPendingPolicies(userId);

      res.json({
        success: true,
        data: {
          pendingPolicies,
          count: pendingPolicies.length
        }
      });
    } catch (error) {
      logger.error('Failed to get pending policies', {
        error: error.message
      });
      res.status(500).json({
        success: false,
        error: '获取待确认政策失败'
      });
    }
  });

  /**
   * POST /api/v1/privacy/confirm
   * 确认政策
   */
  app.post('/api/v1/privacy/confirm', async (req, res) => {
    try {
      const userId = req.user?.sub;
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          error: '未授权'
        });
      }

      const { policyIds, deviceId } = req.body;

      if (!policyIds || !Array.isArray(policyIds) || policyIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: '请提供要确认的政策ID列表'
        });
      }

      const metadata = {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        deviceId,
        confirmationType: 'explicit'
      };

      await privacyService.confirmMultiplePolicies(userId, policyIds, metadata);

      // 清除缓存
      await clearPrivacyStatusCache(userId);

      logger.info('Privacy policies confirmed', {
        userId,
        policyIds,
        deviceId
      });

      res.json({
        success: true,
        data: {
          confirmedPolicies: policyIds,
          message: '政策确认成功'
        }
      });
    } catch (error) {
      logger.error('Failed to confirm policies', {
        error: error.message
      });
      res.status(500).json({
        success: false,
        error: '政策确认失败'
      });
    }
  });

  /**
   * GET /api/v1/privacy/current
   * 获取当前生效的政策
   */
  app.get('/api/v1/privacy/current', async (req, res) => {
    try {
      const privacyPolicy = await privacyService.getCurrentPolicy('privacy_policy');
      const termsOfService = await privacyService.getCurrentPolicy('terms_of_service');

      res.json({
        success: true,
        data: {
          privacyPolicy,
          termsOfService
        }
      });
    } catch (error) {
      logger.error('Failed to get current policies', {
        error: error.message
      });
      res.status(500).json({
        success: false,
        error: '获取当前政策失败'
      });
    }
  });

  /**
   * GET /api/v1/privacy/history
   * 获取用户确认历史
   */
  app.get('/api/v1/privacy/history', async (req, res) => {
    try {
      const userId = req.user?.sub;
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          error: '未授权'
        });
      }

      const history = await privacyService.getUserConfirmationHistory(userId);

      res.json({
        success: true,
        data: {
          history,
          count: history.length
        }
      });
    } catch (error) {
      logger.error('Failed to get confirmation history', {
        error: error.message
      });
      res.status(500).json({
        success: false,
        error: '获取确认历史失败'
      });
    }
  });
}

module.exports = {
  createPrivacyCheckMiddleware,
  setupPrivacyRoutes,
  clearPrivacyStatusCache,
  isProtectedPath,
  PROTECTED_PATHS,
  EXCLUDED_PATHS
};