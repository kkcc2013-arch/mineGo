/**
 * backend/services/user-service/src/routes/sessionManagement.js
 * REQ-00219: 会话异常检测与自动防护系统
 * 
 * 会话管理 API 路由
 */

'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../../../shared/db');
const { authMiddleware, requireAuth } = require('../../../../shared/auth');
const { SessionAnomalyDetector } = require('../../../../shared/sessionAnomalyDetector');
const { createLogger } = require('../../../../shared/logger');
const { incrementCounter } = require('../../../../shared/metrics');

const logger = createLogger('session-management');
const detector = new SessionAnomalyDetector();

/**
 * POST /api/v1/sessions/validate
 * 验证会话有效性与风险评分
 */
router.post('/validate', authMiddleware, async (req, res) => {
  try {
    const sessionId = req.sessionId || req.headers['x-session-id'];
    const userId = req.user.id;
    
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Session ID required'
      });
    }
    
    // 构建上下文
    const context = {
      ip: req.ip || req.connection.remoteAddress,
      deviceFingerprint: req.headers['x-device-fingerprint'],
      userAgent: req.headers['user-agent'],
      geoLocation: null // 可从前端传递
    };
    
    // 验证会话
    const result = await detector.validateSession(sessionId, context);
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    logger.error('Session validation failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/sessions/active
 * 获取用户所有活跃会话
 */
router.get('/active', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const sessions = await detector.getActiveSessions(userId);
    
    // 脱敏处理
    const sanitizedSessions = sessions.map(session => ({
      id: session.id,
      sessionId: session.session_id.substring(0, 12) + '...', // 部分隐藏
      deviceInfo: {
        deviceName: session.device_info?.deviceName || 'Unknown',
        platform: session.device_info?.platform || 'Unknown',
        browser: session.device_info?.browser || 'Unknown'
      },
      location: {
        city: session.bind_city,
        country: session.bind_country,
        ip: session.bind_ip
      },
      riskScore: session.risk_score,
      trusted: session.trusted_device,
      createdAt: session.created_at,
      lastActiveAt: session.last_active_at
    }));
    
    res.json({
      success: true,
      data: {
        total: sessions.length,
        sessions: sanitizedSessions
      }
    });
    
  } catch (error) {
    logger.error('Get active sessions failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/v1/sessions/:sessionId
 * 终止指定会话
 */
router.delete('/:sessionId', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;
    
    // 验证会话属于当前用户
    const result = await query(
      'SELECT user_id FROM session_bindings WHERE session_id = $1',
      [sessionId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }
    
    if (result.rows[0].user_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to terminate this session'
      });
    }
    
    // 终止会话
    await detector.terminateSession(sessionId, 'user_terminated');
    
    incrementCounter('session_user_terminated_total', 1);
    
    res.json({
      success: true,
      message: 'Session terminated successfully'
    });
    
  } catch (error) {
    logger.error('Terminate session failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/v1/sessions/all
 * 终止所有其他会话（保留当前）
 */
router.delete('/all', authMiddleware, async (req, res) => {
  try {
    const currentSessionId = req.sessionId || req.headers['x-session-id'];
    const userId = req.user.id;
    
    // 终止除当前会话外的所有活跃会话
    const result = await query(`
      UPDATE session_bindings 
      SET status = 'terminated', terminated_at = NOW(), terminate_reason = 'user_terminated_all'
      WHERE user_id = $1 AND session_id != $2 AND status = 'active'
      RETURNING session_id
    `, [userId, currentSessionId]);
    
    incrementCounter('session_user_terminated_all_total', result.rows.length);
    
    res.json({
      success: true,
      message: `Terminated ${result.rows.length} sessions`,
      terminatedCount: result.rows.length
    });
    
  } catch (error) {
    logger.error('Terminate all sessions failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/v1/sessions/:sessionId/trust-device
 * 信任设备（需要 MFA 验证）
 */
router.post('/:sessionId/trust-device', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;
    const { mfaCode } = req.body;
    
    // 验证 MFA 代码
    if (!mfaCode) {
      return res.status(400).json({
        success: false,
        error: 'MFA code required'
      });
    }
    
    // 这里应该调用 MFA 验证服务
    // const mfaValid = await verifyMfaCode(userId, mfaCode);
    // if (!mfaValid) return res.status(401).json({ error: 'Invalid MFA code' });
    
    // 信任设备
    await detector.trustDevice(sessionId, userId);
    
    res.json({
      success: true,
      message: 'Device trusted successfully'
    });
    
  } catch (error) {
    logger.error('Trust device failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/sessions/anomaly-history
 * 获取会话异常历史
 */
router.get('/anomaly-history', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50, offset = 0 } = req.query;
    
    const result = await query(`
      SELECT 
        sae.id,
        sae.event_type,
        sae.risk_score,
        sae.details,
        sae.action_taken,
        sae.created_at,
        sb.session_id
      FROM session_anomaly_events sae
      JOIN session_bindings sb ON sae.session_id = sb.id
      WHERE sae.user_id = $1
      ORDER BY sae.created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, parseInt(limit), parseInt(offset)]);
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    logger.error('Get anomaly history failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/admin/sessions/anomalies
 * 管理后台：查询异常会话统计
 */
router.get('/admin/anomalies', requireAuth, async (req, res) => {
  try {
    // 检查管理员权限
    if (!req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }
    
    const { startDate, endDate, riskLevel } = req.query;
    
    let whereClause = 'WHERE 1=1';
    const params = [];
    
    if (startDate) {
      params.push(startDate);
      whereClause += ` AND sae.created_at >= $${params.length}`;
    }
    
    if (endDate) {
      params.push(endDate);
      whereClause += ` AND sae.created_at <= $${params.length}`;
    }
    
    if (riskLevel) {
      const scoreRanges = {
        low: 'sae.risk_score BETWEEN 31 AND 50',
        medium: 'sae.risk_score BETWEEN 51 AND 70',
        high: 'sae.risk_score BETWEEN 71 AND 85',
        critical: 'sae.risk_score > 85'
      };
      if (scoreRanges[riskLevel]) {
        whereClause += ` AND ${scoreRanges[riskLevel]}`;
      }
    }
    
    // 统计查询
    const statsResult = await query(`
      SELECT 
        COUNT(*) as total_anomalies,
        COUNT(DISTINCT user_id) as affected_users,
        AVG(risk_score) as avg_risk_score,
        MAX(risk_score) as max_risk_score
      FROM session_anomaly_events sae
      ${whereClause}
    `, params);
    
    // 按类型统计
    const typeStatsResult = await query(`
      SELECT 
        event_type,
        COUNT(*) as count,
        AVG(risk_score) as avg_score
      FROM session_anomaly_events sae
      ${whereClause}
      GROUP BY event_type
      ORDER BY count DESC
    `, params);
    
    // 按动作统计
    const actionStatsResult = await query(`
      SELECT 
        action_taken,
        COUNT(*) as count
      FROM session_anomaly_events sae
      ${whereClause}
      GROUP BY action_taken
      ORDER BY count DESC
    `, params);
    
    res.json({
      success: true,
      data: {
        summary: statsResult.rows[0],
        byType: typeStatsResult.rows,
        byAction: actionStatsResult.rows
      }
    });
    
  } catch (error) {
    logger.error('Get admin anomaly stats failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/admin/sessions/high-risk
 * 管理后台：获取高风险会话列表
 */
router.get('/admin/high-risk', requireAuth, async (req, res) => {
  try {
    // 检查管理员权限
    if (!req.user.isAdmin) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }
    
    const { limit = 100 } = req.query;
    
    const result = await query(`
      SELECT 
        sb.id,
        sb.session_id,
        sb.user_id,
        u.username,
        sb.device_fingerprint,
        sb.bind_ip,
        sb.bind_city,
        sb.bind_country,
        sb.risk_score,
        sb.status,
        sb.created_at,
        sb.last_active_at,
        sb.trusted_device
      FROM session_bindings sb
      JOIN users u ON sb.user_id = u.id
      WHERE sb.risk_score >= 71
      ORDER BY sb.risk_score DESC, sb.last_active_at DESC
      LIMIT $1
    `, [parseInt(limit)]);
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    logger.error('Get high-risk sessions failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
