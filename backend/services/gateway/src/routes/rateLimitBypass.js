// backend/services/gateway/src/routes/rateLimitBypass.js
// REQ-00147: 限流绕过检测 API 路由

'use strict';

const express = require('express');
const router = express.Router();
const { RateLimitMonitor } = require('../../../../shared/rateLimitMonitor');
const { createLogger } = require('../../../../shared/logger');
const { authenticate, requireAdmin } = require('../../../../shared/middleware/auth');

const logger = createLogger('rate-limit-bypass-routes');

// 初始化监控器
const monitor = new RateLimitMonitor();

/**
 * GET /api/v1/security/rate-limit-bypass/stats
 * 获取限流绕过统计
 */
router.get('/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const stats = await monitor.getStats({
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    });
    
    // 计算总数
    const totalAttempts = Object.values(stats.realtime)
      .reduce((sum, s) => sum + s.total, 0);
    const blockedAttempts = Object.values(stats.realtime)
      .reduce((sum, s) => sum + s.blocked, 0);
    
    // 获取 top offenders
    const topOffendersQuery = `
      SELECT user_id, COUNT(*) as attempts, AVG(risk_score) as avg_risk_score
      FROM rate_limit_bypass_attempts
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY user_id
      ORDER BY attempts DESC
      LIMIT 10
    `;
    
    const topOffenders = await monitor.db.query(topOffendersQuery);
    
    res.json({
      success: true,
      data: {
        totalAttempts,
        blockedAttempts,
        blockRate: totalAttempts > 0 ? (blockedAttempts / totalAttempts * 100).toFixed(2) : 0,
        byType: stats.realtime,
        historical: stats.historical,
        topOffenders: topOffenders.rows,
      },
    });
  } catch (error) {
    logger.error('Failed to get bypass stats', { error: error.message });
    res.status(500).json({
      success: false,
      error: '获取统计信息失败',
      code: 'STATS_ERROR',
    });
  }
});

/**
 * POST /api/v1/security/rate-limit-bypass/block
 * 手动封禁用户
 */
router.post('/block', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId, reason, duration } = req.body;
    
    if (!userId || !reason) {
      return res.status(400).json({
        success: false,
        error: '缺少必要参数',
        code: 'MISSING_PARAMS',
      });
    }
    
    // 默认封禁1小时
    const durationMs = duration || 3600000;
    
    await monitor.bypassHandler.blockUser(userId, reason, 100);
    
    logger.info('User manually blocked', {
      userId,
      reason,
      duration: durationMs,
      blockedBy: req.user.id,
    });
    
    res.json({
      success: true,
      data: {
        userId,
        reason,
        blockedUntil: new Date(Date.now() + durationMs).toISOString(),
      },
    });
  } catch (error) {
    logger.error('Failed to block user', { error: error.message });
    res.status(500).json({
      success: false,
      error: '封禁用户失败',
      code: 'BLOCK_ERROR',
    });
  }
});

/**
 * DELETE /api/v1/security/rate-limit-bypass/block/:userId
 * 解除封禁
 */
router.delete('/block/:userId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // 清除 Redis 封禁状态
    const blockKey = `ratelimit:blocked:${userId}`;
    await monitor.redis.del(blockKey);
    
    // 更新数据库记录
    const query = `
      UPDATE rate_limit_blocks
      SET unblocked_at = NOW(), unblocked_by = $1
      WHERE user_id = $2 AND unblocked_at IS NULL
    `;
    
    await monitor.db.query(query, [req.user.id, userId]);
    
    logger.info('User unblocked', {
      userId,
      unblockedBy: req.user.id,
    });
    
    res.json({
      success: true,
      data: { userId, unblocked: true },
    });
  } catch (error) {
    logger.error('Failed to unblock user', { error: error.message });
    res.status(500).json({
      success: false,
      error: '解除封禁失败',
      code: 'UNBLOCK_ERROR',
    });
  }
});

/**
 * GET /api/v1/security/rate-limit-bypass/report
 * 生成绕过行为报告
 */
router.get('/report', authenticate, requireAdmin, async (req, res) => {
  try {
    const { startDate, endDate, format = 'json' } = req.query;
    
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 7 * 86400000);
    const end = endDate ? new Date(endDate) : new Date();
    
    const query = `
      SELECT 
        DATE(created_at) as date,
        type,
        COUNT(*) as attempts,
        COUNT(*) FILTER (WHERE blocked = true) as blocked,
        AVG(risk_score) as avg_risk_score,
        MAX(risk_score) as max_risk_score
      FROM rate_limit_bypass_attempts
      WHERE created_at >= $1 AND created_at <= $2
      GROUP BY DATE(created_at), type
      ORDER BY date DESC, type
    `;
    
    const result = await monitor.db.query(query, [start, end]);
    
    // 按日期分组
    const report = {};
    for (const row of result.rows) {
      const date = row.date.toISOString().split('T')[0];
      if (!report[date]) {
        report[date] = { date, types: {}, total: 0, blocked: 0 };
      }
      report[date].types[row.type] = {
        attempts: parseInt(row.attempts),
        blocked: parseInt(row.blocked),
        avgRiskScore: parseFloat(row.avg_risk_score).toFixed(2),
        maxRiskScore: parseInt(row.max_risk_score),
      };
      report[date].total += parseInt(row.attempts);
      report[date].blocked += parseInt(row.blocked);
    }
    
    res.json({
      success: true,
      data: {
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        report: Object.values(report),
      },
    });
  } catch (error) {
    logger.error('Failed to generate report', { error: error.message });
    res.status(500).json({
      success: false,
      error: '生成报告失败',
      code: 'REPORT_ERROR',
    });
  }
});

/**
 * GET /api/v1/security/rate-limit-bypass/check/:userId
 * 检查用户绕过状态
 */
router.get('/check/:userId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // 检查封禁状态
    const blocked = await monitor.bypassHandler.checkBlocked(userId);
    
    // 获取最近尝试记录
    const query = `
      SELECT type, risk_score, blocked, created_at
      FROM rate_limit_bypass_attempts
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 10
    `;
    
    const result = await monitor.db.query(query, [userId]);
    
    res.json({
      success: true,
      data: {
        userId,
        blocked: !!blocked,
        blockInfo: blocked,
        recentAttempts: result.rows,
      },
    });
  } catch (error) {
    logger.error('Failed to check user status', { error: error.message });
    res.status(500).json({
      success: false,
      error: '检查用户状态失败',
      code: 'CHECK_ERROR',
    });
  }
});

module.exports = router;
