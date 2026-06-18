/**
 * 限流管理接口
 * 管理员可查看配额状态、授予临时提升、调整信誉度
 */

const express = require('express');
const router = express.Router();
const rateLimiter = require('../../../shared/IntelligentRateLimiter');
const userReputation = require('../../../shared/UserReputationScore');
const { logger } = require('../../../shared/logger');

/**
 * 简单管理员认证中间件
 */
function requireAdmin(req, res, next) {
  // 实际项目中应使用更严格的认证
  if (req.user && req.user.role === 'admin') {
    return next();
  }
  
  // 开发环境允许通过
  if (process.env.NODE_ENV === 'development') {
    return next();
  }
  
  return res.status(403).json({ error: 'Admin access required' });
}

/**
 * 获取用户配额状态
 * GET /admin/rate-limit/quota/:userId
 */
router.get('/quota/:userId', requireAdmin, async (req, res) => {
  try {
    const status = await rateLimiter.getQuotaStatus(req.params.userId);
    res.json(status);
  } catch (error) {
    logger.error('Failed to get quota status', { 
      userId: req.params.userId, 
      error: error.message 
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 授予临时配额提升
 * POST /admin/rate-limit/boost/:userId
 * Body: { multiplier, durationSeconds, reason }
 */
router.post('/boost/:userId', requireAdmin, async (req, res) => {
  try {
    const { multiplier, durationSeconds, reason } = req.body;
    
    if (!multiplier || multiplier < 1 || multiplier > 10) {
      return res.status(400).json({ error: 'multiplier must be between 1 and 10' });
    }
    
    if (!durationSeconds || durationSeconds < 60 || durationSeconds > 86400) {
      return res.status(400).json({ error: 'durationSeconds must be between 60 and 86400' });
    }
    
    await rateLimiter.grantTemporaryBoost(
      req.params.userId,
      multiplier,
      durationSeconds,
      reason || 'Admin granted'
    );
    
    res.json({
      success: true,
      message: 'Temporary boost granted',
      multiplier,
      durationSeconds,
      reason
    });
  } catch (error) {
    logger.error('Failed to grant boost', { 
      userId: req.params.userId, 
      error: error.message 
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 重置用户限流计数
 * POST /admin/rate-limit/reset/:userId
 * Body: { endpoint }
 */
router.post('/reset/:userId', requireAdmin, async (req, res) => {
  try {
    const { endpoint } = req.body;
    
    if (endpoint) {
      const key = `ratelimit:${req.params.userId}:${endpoint}`;
      await rateLimiter.redis.del(key);
    } else {
      // 重置所有接口
      const keys = await rateLimiter.redis.keys(`ratelimit:${req.params.userId}:*`);
      if (keys.length > 0) {
        await rateLimiter.redis.del(...keys);
      }
    }
    
    res.json({ success: true, message: 'Rate limit counters reset' });
  } catch (error) {
    logger.error('Failed to reset rate limit', { 
      userId: req.params.userId, 
      error: error.message 
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取信誉度详情
 * GET /admin/rate-limit/reputation/:userId
 */
router.get('/reputation/:userId', requireAdmin, async (req, res) => {
  try {
    const reputation = await userReputation.calculateReputation(req.params.userId);
    res.json(reputation);
  } catch (error) {
    logger.error('Failed to get reputation', { 
      userId: req.params.userId, 
      error: error.message 
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 手动调整信誉度
 * POST /admin/rate-limit/reputation/:userId/adjust
 * Body: { delta, reason }
 */
router.post('/reputation/:userId/adjust', requireAdmin, async (req, res) => {
  try {
    const { delta, reason } = req.body;
    
    if (typeof delta !== 'number' || delta < -100 || delta > 100) {
      return res.status(400).json({ error: 'delta must be between -100 and 100' });
    }
    
    await userReputation.adjustReputationScore(req.params.userId, delta);
    
    // 记录审计日志
    logger.info('Reputation manually adjusted', {
      adminId: req.user?.id || 'system',
      targetUserId: req.params.userId,
      delta,
      reason
    });
    
    res.json({ success: true, delta, reason });
  } catch (error) {
    logger.error('Failed to adjust reputation', { 
      userId: req.params.userId, 
      error: error.message 
    });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取系统限流统计
 * GET /admin/rate-limit/stats
 */
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const systemLoad = await rateLimiter.getSystemLoad();
    
    // 获取限流事件统计
    const keys = await rateLimiter.redis.keys('ratelimit:events:*');
    let totalEvents = 0;
    const topUsers = [];
    
    for (const key of keys.slice(0, 100)) {
      const count = await rateLimiter.redis.llen(key);
      totalEvents += count;
      const userId = key.replace('ratelimit:events:', '');
      topUsers.push({ userId, eventCount: count });
    }
    
    topUsers.sort((a, b) => b.eventCount - a.eventCount);
    
    res.json({
      systemLoad,
      totalRateLimitedUsers: keys.length,
      totalLimitEvents: totalEvents,
      topRateLimitedUsers: topUsers.slice(0, 10)
    });
  } catch (error) {
    logger.error('Failed to get stats', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取基础限流配置
 * GET /admin/rate-limit/config
 */
router.get('/config', requireAdmin, async (req, res) => {
  try {
    res.json({
      baseLimits: rateLimiter.BASE_LIMITS,
      systemLoadThresholds: rateLimiter.SYSTEM_LOAD,
      reputationLevels: userReputation.LEVELS,
      reputationFactors: userReputation.FACTORS
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
