// backend/gateway/src/routes/quota.js
// REQ-00098: 用户配额管理 API

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, verifyAccess, AppError, successResp } = require('../../../shared/auth');
const { userQuotaManager, adaptiveRateLimiter } = require('../../../shared/AdaptiveRateLimiter');
const { query } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('quota-routes');

/**
 * GET /api/v2/user/quota
 * 查询用户剩余配额
 */
router.get('/api/v2/user/quota', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const status = await userQuotaManager.getQuotaStatus(userId);

    res.json(successResp(status));
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Failed to get quota status');
    next(err);
  }
});

/**
 * GET /api/v2/user/quota/history
 * 查询配额使用历史（最近 24 小时）
 */
router.get('/api/v2/user/quota/history', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { limit = 100 } = req.query;

    const result = await query(`
      SELECT 
        api_pattern, tier, request_count, was_blocked, created_at
      FROM quota_usage_logs
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC
      LIMIT $2
    `, [userId, parseInt(limit)]);

    res.json(successResp({
      userId,
      history: result.rows,
      count: result.rows.length
    }));
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Failed to get quota history');
    next(err);
  }
});

/**
 * GET /api/admin/quota/config
 * 查询配额配置（管理员）
 */
router.get('/api/admin/quota/config', requireAuth, async (req, res, next) => {
  try {
    // 验证管理员权限
    if (!req.user.isAdmin) {
      throw new AppError(1004, '需要管理员权限', 403);
    }

    const result = await query(`
      SELECT quota_level, daily_limit, hourly_limit, minute_limit
      FROM (
        SELECT 'free' as quota_level, 1000 as daily_limit, 100 as hourly_limit, 20 as minute_limit
        UNION SELECT 'vip', 3000, 300, 60
        UNION SELECT 'svip', 10000, 1000, 200
      ) configs
      ORDER BY daily_limit
    `);

    res.json(successResp({
      configs: result.rows
    }));
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Failed to get quota config');
    next(err);
  }
});

/**
 * POST /api/admin/quota/config
 * 更新配额配置（管理员）
 */
router.post('/api/admin/quota/config', requireAuth, async (req, res, next) => {
  try {
    // 验证管理员权限
    if (!req.user.isAdmin) {
      throw new AppError(1004, '需要管理员权限', 403);
    }

    const { quotaLevel, dailyLimit, hourlyLimit, minuteLimit } = req.body;

    if (!quotaLevel || !['free', 'vip', 'svip'].includes(quotaLevel)) {
      throw new AppError(1001, '无效的配额等级', 400);
    }

    // 更新该等级所有用户的配额
    const result = await query(`
      UPDATE user_quotas SET
        daily_limit = $2,
        hourly_limit = $3,
        minute_limit = $4
      WHERE quota_level = $1
      RETURNING user_id
    `, [quotaLevel, dailyLimit, hourlyLimit, minuteLimit]);

    // 记录配置变更历史
    await query(`
      INSERT INTO quota_config_history (quota_level, old_config, new_config, changed_by, reason)
      SELECT 
        $1,
        jsonb_build_object('daily', daily_limit, 'hourly', hourly_limit, 'minute', minute_limit),
        jsonb_build_object('daily', $2, 'hourly', $3, 'minute', $4),
        $5,
        '管理员更新'
      FROM user_quotas
      WHERE quota_level = $1
      LIMIT 1
    `, [quotaLevel, dailyLimit, hourlyLimit, minuteLimit, req.user.id]);

    logger.info({
      event: 'QUOTA_CONFIG_UPDATED',
      quotaLevel,
      dailyLimit,
      hourlyLimit,
      minuteLimit,
      affectedUsers: result.rows.length,
      adminId: req.user.id
    }, 'Quota config updated');

    res.json(successResp({
      quotaLevel,
      dailyLimit,
      hourlyLimit,
      minuteLimit,
      affectedUsers: result.rows.length
    }));
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Failed to update quota config');
    next(err);
  }
});

/**
 * POST /api/admin/quota/user/:userId/adjust
 * 调整用户配额系数（管理员）
 */
router.post('/api/admin/quota/user/:userId/adjust', requireAuth, async (req, res, next) => {
  try {
    // 验证管理员权限
    if (!req.user.isAdmin) {
      throw new AppError(1004, '需要管理员权限', 403);
    }

    const { userId } = req.params;
    const { quotaMultiplier, reason, duration } = req.body;

    if (!quotaMultiplier || quotaMultiplier < 0.1 || quotaMultiplier > 5.0) {
      throw new AppError(1001, '配额系数必须在 0.1-5.0 之间', 400);
    }

    if (!reason) {
      throw new AppError(1001, '必须提供调整原因', 400);
    }

    const result = await userQuotaManager.adjustUserQuota(userId, {
      quotaMultiplier,
      reason,
      duration
    });

    logger.info({
      event: 'USER_QUOTA_ADJUSTED',
      targetUserId: userId,
      quotaMultiplier,
      reason,
      duration,
      adminId: req.user.id
    }, 'User quota adjusted by admin');

    res.json(successResp(result));
  } catch (err) {
    logger.error({ err, userId: req.user?.id, targetUserId: req.params.userId }, 'Failed to adjust user quota');
    next(err);
  }
});

/**
 * GET /api/admin/quota/stats
 * 查询配额使用统计（管理员）
 */
router.get('/api/admin/quota/stats', requireAuth, async (req, res, next) => {
  try {
    // 验证管理员权限
    if (!req.user.isAdmin) {
      throw new AppError(1004, '需要管理员权限', 403);
    }

    // 各等级用户数统计
    const levelStats = await query(`
      SELECT 
        quota_level,
        COUNT(*) as user_count,
        AVG(used_today) as avg_daily_usage,
        AVG(quota_multiplier) as avg_multiplier
      FROM user_quotas
      GROUP BY quota_level
      ORDER BY quota_level
    `);

    // 限流触发统计（最近 24 小时）
    const blockStats = await query(`
      SELECT 
        tier,
        COUNT(*) as block_count,
        COUNT(DISTINCT user_id) as affected_users
      FROM quota_usage_logs
      WHERE was_blocked = true AND created_at > NOW() - INTERVAL '24 hours'
      GROUP BY tier
      ORDER BY tier
    `);

    // 高使用量用户（日使用量 > 80%）
    const highUsageUsers = await query(`
      SELECT 
        uq.user_id,
        uq.quota_level,
        uq.used_today,
        uq.daily_limit,
        ROUND(uq.used_today::DECIMAL / uq.daily_limit * 100, 2) as usage_percent
      FROM user_quotas uq
      WHERE uq.used_today::DECIMAL / uq.daily_limit > 0.8
      ORDER BY usage_percent DESC
      LIMIT 20
    `);

    res.json(successResp({
      levelStats: levelStats.rows,
      blockStats: blockStats.rows,
      highUsageUsers: highUsageUsers.rows
    }));
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Failed to get quota stats');
    next(err);
  }
});

/**
 * POST /api/admin/rate-limit/adjust
 * 手动调整自适应限流参数（管理员）
 */
router.post('/api/admin/rate-limit/adjust', requireAuth, async (req, res, next) => {
  try {
    // 验证管理员权限
    if (!req.user.isAdmin) {
      throw new AppError(1004, '需要管理员权限', 403);
    }

    const { loadFactor, reason } = req.body;

    if (!loadFactor || loadFactor < 0.3 || loadFactor > 1.5) {
      throw new AppError(1001, '负载因子必须在 0.3-1.5 之间', 400);
    }

    const result = adaptiveRateLimiter.setLoadFactor(loadFactor, reason || '手动调整');

    logger.info({
      event: 'RATE_LIMIT_MANUAL_ADJUST',
      loadFactor,
      reason,
      adminId: req.user.id
    }, 'Rate limit manually adjusted');

    res.json(successResp(result));
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Failed to adjust rate limit');
    next(err);
  }
});

/**
 * GET /api/admin/rate-limit/status
 * 查询当前限流状态（管理员）
 */
router.get('/api/admin/rate-limit/status', requireAuth, async (req, res, next) => {
  try {
    // 验证管理员权限
    if (!req.user.isAdmin) {
      throw new AppError(1004, '需要管理员权限', 403);
    }

    const status = adaptiveRateLimiter.getStatus();

    res.json(successResp(status));
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, 'Failed to get rate limit status');
    next(err);
  }
});

module.exports = router;
