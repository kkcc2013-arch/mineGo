/**
 * Security Routes - 安全会话管理路由
 * 
 * 功能：
 * - 初始化安全会话
 * - 刷新会话密钥
 * - 上报篡改事件
 * - 上报扫描结果
 * - 查询会话状态
 * 
 * @module backend/gateway/src/routes/security
 */

const express = require('express');
const crypto = require('crypto');
const { getRedisClient } = require('@pmg/shared/cache');
const { executeQuery } = require('@pmg/shared/db');
const logger = require('@pmg/shared/logger');
const { authenticate } = require('../middleware/auth');
const { recordTamperEvent, incrementTamperCount, banSession, getSession } = require('../middleware/requestSignature');

const router = express.Router();

// 配置
const CONFIG = {
  sessionDuration: 3600, // 会话有效期 1 小时
  keyRefreshInterval: 600000, // 密钥刷新间隔 10 分钟
  maxSessionsPerDevice: 5,
  maxTamperCount: 3
};

// Prometheus 指标
let prometheusMetrics = null;

try {
  const { Counter, Gauge } = require('prom-client');
  
  prometheusMetrics = {
    sessionsCreated: new Counter({
      name: 'minego_security_sessions_created_total',
      help: 'Total security sessions created',
      labelNames: ['device_type']
    }),
    
    sessionsActive: new Gauge({
      name: 'minego_security_sessions_active_count',
      help: 'Current active security sessions'
    }),
    
    tamperReports: new Counter({
      name: 'minego_security_tamper_reports_total',
      help: 'Total tamper reports received',
      labelNames: ['data_key']
    }),
    
    scanReports: new Counter({
      name: 'minego_security_scan_reports_total',
      help: 'Total scan reports received',
      labelNames: ['detection_name']
    }),
    
    keyRefreshes: new Counter({
      name: 'minego_security_key_refreshes_total',
      help: 'Total key refreshes'
    })
  };
} catch (e) {
  console.warn('Prometheus metrics not available for security routes');
}

/**
 * POST /api/v1/security/init-session
 * 初始化安全会话
 */
router.post('/init-session', async (req, res) => {
  try {
    const { deviceId, timestamp, timezone, language, userAgent } = req.body;
    
    // 验证必需参数
    if (!deviceId) {
      return res.status(400).json({
        error: 'Device ID is required',
        code: 'MISSING_DEVICE_ID'
      });
    }
    
    // 获取用户 ID（如果已登录）
    const userId = req.user?.id || null;
    
    // 检查设备的会话数量限制
    const existingSessions = await executeQuery(
      `SELECT COUNT(*) as count FROM security_sessions
       WHERE device_id = $1 AND expires_at > NOW() AND is_banned = FALSE`,
      [deviceId]
    );
    
    if (existingSessions.rows[0].count >= CONFIG.maxSessionsPerDevice) {
      // 清理最旧的会话
      await executeQuery(
        `DELETE FROM security_sessions
         WHERE device_id = $1 AND id IN (
           SELECT id FROM security_sessions
           WHERE device_id = $1
           ORDER BY created_at ASC
           LIMIT 1
         )`,
        [deviceId]
      );
    }
    
    // 生成会话 ID 和密钥
    const sessionId = generateSessionId();
    const secretKey = generateSecretKey();
    
    // 加密密钥（简单 XOR，实际应使用更安全的方式）
    const encryptedKey = encryptKey(secretKey, sessionId);
    
    // 创建会话记录
    await executeQuery(
      `INSERT INTO security_sessions
       (session_id, user_id, device_id, secret_key, expires_at, metadata)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 hour', $5)`,
      [
        sessionId,
        userId,
        deviceId,
        secretKey,
        JSON.stringify({
          timezone,
          language,
          userAgent,
          clientTimestamp: timestamp,
          ip: req.ip
        })
      ]
    );
    
    // 缓存会话到 Redis
    const redis = getRedisClient();
    await redis.setex(
      `session:${sessionId}`,
      CONFIG.sessionDuration,
      JSON.stringify({
        userId,
        deviceId,
        secretKey,
        createdAt: Date.now()
      })
    );
    
    // 更新活跃会话指标
    prometheusMetrics?.sessionsCreated.inc({
      device_type: detectDeviceType(userAgent)
    });
    
    logger.info('Security session created', {
      sessionId,
      userId,
      deviceId,
      ip: req.ip
    });
    
    res.json({
      sessionId,
      encryptedKey,
      expiresIn: CONFIG.sessionDuration,
      refreshInterval: CONFIG.keyRefreshInterval
    });
    
  } catch (error) {
    logger.error('Failed to init session', {
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json({
      error: 'Failed to initialize session',
      code: 'INIT_FAILED'
    });
  }
});

/**
 * POST /api/v1/security/refresh-key
 * 刷新会话密钥
 */
router.post('/refresh-key', async (req, res) => {
  try {
    const { sessionId, timestamp } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({
        error: 'Session ID is required',
        code: 'MISSING_SESSION_ID'
      });
    }
    
    // 获取会话
    const session = await getSession(sessionId);
    
    if (!session) {
      return res.status(401).json({
        error: 'Invalid session',
        code: 'INVALID_SESSION'
      });
    }
    
    if (session.is_banned) {
      return res.status(403).json({
        error: 'Session banned',
        code: 'SESSION_BANNED'
      });
    }
    
    // 生成新密钥
    const newSecretKey = generateSecretKey();
    const encryptedKey = encryptKey(newSecretKey, sessionId);
    
    // 更新会话
    await executeQuery(
      `UPDATE security_sessions
       SET secret_key = $1, last_key_refresh = NOW()
       WHERE session_id = $2`,
      [newSecretKey, sessionId]
    );
    
    // 更新 Redis 缓存
    const redis = getRedisClient();
    const cached = await redis.get(`session:${sessionId}`);
    
    if (cached) {
      const sessionData = JSON.parse(cached);
      sessionData.secretKey = newSecretKey;
      await redis.setex(
        `session:${sessionId}`,
        CONFIG.sessionDuration,
        JSON.stringify(sessionData)
      );
    }
    
    prometheusMetrics?.keyRefreshes.inc();
    
    logger.info('Session key refreshed', { sessionId });
    
    res.json({
      encryptedKey,
      expiresIn: CONFIG.sessionDuration
    });
    
  } catch (error) {
    logger.error('Failed to refresh key', {
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json({
      error: 'Failed to refresh key',
      code: 'REFRESH_FAILED'
    });
  }
});

/**
 * POST /api/v1/security/report-tamper
 * 上报篡改事件
 */
router.post('/report-tamper', async (req, res) => {
  try {
    const {
      sessionId,
      dataKey,
      expectedHmac,
      actualHmac,
      originalHash,
      tamperCount,
      timestamp,
      stackTrace,
      url
    } = req.body;
    
    if (!sessionId || !dataKey) {
      return res.status(400).json({
        error: 'Session ID and data key are required',
        code: 'MISSING_PARAMS'
      });
    }
    
    // 记录篡改事件
    await recordTamperEvent(sessionId, 'checksum_mismatch', {
      dataKey,
      expectedHmac,
      actualHmac,
      originalHash,
      tamperCount,
      clientTimestamp: timestamp,
      stackTrace: stackTrace?.substring(0, 1000),
      url,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });
    
    // 增加篡改计数
    const currentTamperCount = await incrementTamperCount(sessionId);
    
    prometheusMetrics?.tamperReports.inc({ data_key: dataKey });
    
    // 判断是否需要封禁
    let action = 'warn';
    let reason = null;
    
    if (currentTamperCount >= CONFIG.maxTamperCount) {
      reason = 'Exceeded maximum tamper count';
      await banSession(sessionId, reason);
      action = 'ban';
      
      logger.warn('Session banned due to tampering', {
        sessionId,
        tamperCount: currentTamperCount,
        dataKey
      });
    }
    
    logger.warn('Tamper event reported', {
      sessionId,
      dataKey,
      tamperCount: currentTamperCount,
      action
    });
    
    res.json({
      action,
      reason,
      tamperCount: currentTamperCount
    });
    
  } catch (error) {
    logger.error('Failed to report tamper', {
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json({
      error: 'Failed to report tamper',
      code: 'REPORT_FAILED'
    });
  }
});

/**
 * POST /api/v1/security/report-scan
 * 上报内存扫描结果
 */
router.post('/report-scan', async (req, res) => {
  try {
    const { sessionId, scanCount, detections, timestamp, url } = req.body;
    
    if (!sessionId || !detections || !Array.isArray(detections)) {
      return res.status(400).json({
        error: 'Session ID and detections array are required',
        code: 'MISSING_PARAMS'
      });
    }
    
    // 只处理严重和高级别检测
    const criticalDetections = detections.filter(
      d => d.severity === 'critical' || d.severity === 'high'
    );
    
    let action = 'ok';
    
    if (criticalDetections.length > 0) {
      // 记录检测事件
      for (const detection of criticalDetections) {
        await recordTamperEvent(sessionId, 'scan_detection', {
          name: detection.name,
          type: detection.type,
          severity: detection.severity,
          details: detection.details,
          scanCount,
          clientTimestamp: timestamp,
          url,
          ip: req.ip
        });
        
        prometheusMetrics?.scanReports.inc({
          detection_name: detection.name
        });
      }
      
      // 关键检测触发调查
      if (criticalDetections.some(d => d.severity === 'critical')) {
        const tamperCount = await incrementTamperCount(sessionId);
        
        if (tamperCount >= CONFIG.maxTamperCount) {
          await banSession(sessionId, 'Critical security threat detected');
          action = 'ban';
        } else {
          action = 'investigate';
        }
      }
      
      logger.warn('Critical scan detections reported', {
        sessionId,
        detections: criticalDetections.map(d => d.name),
        action
      });
    }
    
    res.json({
      action,
      detectionsCount: criticalDetections.length
    });
    
  } catch (error) {
    logger.error('Failed to report scan', {
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json({
      error: 'Failed to report scan',
      code: 'REPORT_FAILED'
    });
  }
});

/**
 * GET /api/v1/security/status
 * 查询会话安全状态
 */
router.get('/status', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    
    if (!sessionId) {
      return res.status(400).json({
        error: 'Session ID is required',
        code: 'MISSING_SESSION_ID'
      });
    }
    
    const session = await getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND'
      });
    }
    
    // 获取最近的扫描记录
    const recentScans = await executeQuery(
      `SELECT COUNT(*) as count, MAX(reported_at) as last_scan
       FROM tamper_events
       WHERE session_id = $1 AND event_type = 'scan_detection'
       AND reported_at > NOW() - INTERVAL '1 hour'`,
      [sessionId]
    );
    
    res.json({
      sessionId: session.session_id,
      tamperCount: session.tamper_count,
      isBanned: session.is_banned,
      banReason: session.ban_reason,
      lastScanTime: recentScans.rows[0].last_scan,
      recentScanCount: parseInt(recentScans.rows[0].count) || 0,
      expiresAt: session.expires_at
    });
    
  } catch (error) {
    logger.error('Failed to get status', {
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json({
      error: 'Failed to get status',
      code: 'STATUS_FAILED'
    });
  }
});

/**
 * DELETE /api/v1/security/session
 * 销毁会话
 */
router.delete('/session', async (req, res) => {
  try {
    const sessionId = req.headers['x-session-id'];
    
    if (!sessionId) {
      return res.status(400).json({
        error: 'Session ID is required',
        code: 'MISSING_SESSION_ID'
      });
    }
    
    // 删除会话
    await executeQuery(
      'DELETE FROM security_sessions WHERE session_id = $1',
      [sessionId]
    );
    
    // 清除 Redis 缓存
    const redis = getRedisClient();
    await redis.del(`session:${sessionId}`);
    
    logger.info('Security session destroyed', { sessionId });
    
    res.json({ success: true });
    
  } catch (error) {
    logger.error('Failed to destroy session', {
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json({
      error: 'Failed to destroy session',
      code: 'DESTROY_FAILED'
    });
  }
});

/**
 * 生成会话 ID
 * @returns {string}
 */
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 生成密钥
 * @returns {string}
 */
function generateSecretKey() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 加密密钥
 * @param {string} key 
 * @param {string} sessionId 
 * @returns {string}
 */
function encryptKey(key, sessionId) {
  // 简单 XOR 加密（实际应使用更安全的方式）
  const keyBytes = Buffer.from(key, 'hex');
  const sessionBytes = Buffer.from(sessionId, 'hex');
  
  for (let i = 0; i < keyBytes.length; i++) {
    keyBytes[i] ^= sessionBytes[i % sessionBytes.length];
  }
  
  return keyBytes.toString('base64');
}

/**
 * 检测设备类型
 * @param {string} userAgent 
 * @returns {string}
 */
function detectDeviceType(userAgent) {
  if (!userAgent) return 'unknown';
  
  const ua = userAgent.toLowerCase();
  
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
    return 'mobile';
  }
  if (ua.includes('tablet') || ua.includes('ipad')) {
    return 'tablet';
  }
  return 'desktop';
}

module.exports = router;
