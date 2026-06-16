/**
 * RequestSignature Middleware - 请求签名验证中间件
 * 
 * 功能：
 * - 验证请求签名（HMAC-SHA256）
 * - 防重放攻击（Nonce + 时间戳）
 * - 记录异常请求
 * 
 * @module backend/gateway/src/middleware/requestSignature
 */

const crypto = require('crypto');
const { getRedisClient } = require('../../shared/cache');
const { executeQuery } = require('../../shared/db');
const logger = require('../../shared/logger');

// 配置
const CONFIG = {
  timestampWindow: 5 * 60 * 1000, // 5 分钟时间窗口
  nonceTTL: 300, // Nonce 缓存 5 分钟
  maxTamperCount: 3, // 最大篡改次数
  protectedPaths: [
    '/api/v1/catch',
    '/api/v1/battle',
    '/api/v1/payment',
    '/api/v1/pokemon/trade',
    '/api/v1/pokemon/transfer',
    '/api/v1/reward/claim',
    '/api/v1/gym',
    '/api/v1/user/profile'
  ]
};

// Prometheus 指标
let prometheusMetrics = null;

try {
  const { Counter, Gauge } = require('prom-client');
  
  prometheusMetrics = {
    tamperDetectedTotal: new Counter({
      name: 'minego_security_tamper_detected_total',
      help: 'Total number of tamper detections',
      labelNames: ['event_type', 'data_key']
    }),
    
    securitySessionsActive: new Gauge({
      name: 'minego_security_sessions_active',
      help: 'Number of active security sessions'
    }),
    
    replayAttackBlocked: new Counter({
      name: 'minego_security_replay_attack_blocked_total',
      help: 'Number of replay attacks blocked'
    }),
    
    signatureValidationTotal: new Counter({
      name: 'minego_security_signature_validation_total',
      help: 'Total signature validations',
      labelNames: ['result']
    }),
    
    nonceCacheSize: new Gauge({
      name: 'minego_security_nonce_cache_size',
      help: 'Size of nonce cache'
    })
  };
} catch (e) {
  console.warn('Prometheus metrics not available for requestSignature middleware');
}

/**
 * 检查路径是否需要签名验证
 * @param {string} path 
 * @returns {boolean}
 */
function isProtectedPath(path) {
  return CONFIG.protectedPaths.some(protectedPath => 
    path.startsWith(protectedPath)
  );
}

/**
 * 验证请求签名
 */
async function verifyRequestSignature(req, res, next) {
  const startTime = Date.now();
  
  try {
    // 检查是否需要验证
    if (!isProtectedPath(req.path)) {
      return next();
    }
    
    // 获取签名信息
    const timestamp = parseInt(req.headers['x-request-timestamp']);
    const nonce = req.headers['x-request-nonce'];
    const signature = req.headers['x-request-signature'];
    const sessionId = req.headers['x-session-id'];
    
    // 必需字段检查
    if (!timestamp || !nonce || !signature || !sessionId) {
      logger.warn('Missing signature headers', {
        path: req.path,
        hasTimestamp: !!timestamp,
        hasNonce: !!nonce,
        hasSignature: !!signature,
        hasSessionId: !!sessionId
      });
      
      return res.status(401).json({
        error: 'Missing signature headers',
        code: 'MISSING_SIGNATURE'
      });
    }
    
    // 1. 时间戳验证
    const now = Date.now();
    const timeDiff = Math.abs(now - timestamp);
    
    if (timeDiff > CONFIG.timestampWindow) {
      logger.warn('Request timestamp expired', {
        path: req.path,
        timestamp,
        now,
        diff: timeDiff
      });
      
      prometheusMetrics?.signatureValidationTotal.inc({ result: 'expired' });
      
      return res.status(401).json({
        error: 'Request expired',
        code: 'TIMESTAMP_EXPIRED',
        timeDiff
      });
    }
    
    // 2. Nonce 验证（防重放）
    const redis = getRedisClient();
    const nonceKey = `nonce:${sessionId}:${nonce}`;
    
    const exists = await redis.exists(nonceKey);
    
    if (exists) {
      logger.warn('Replay attack detected', {
        path: req.path,
        sessionId,
        nonce
      });
      
      prometheusMetrics?.replayAttackBlocked.inc();
      prometheusMetrics?.signatureValidationTotal.inc({ result: 'replay' });
      
      // 记录事件
      await recordTamperEvent(sessionId, 'replay_attack', {
        nonce,
        path: req.path,
        ip: req.ip
      });
      
      return res.status(401).json({
        error: 'Replay attack detected',
        code: 'REPLAY_ATTACK'
      });
    }
    
    // 缓存 Nonce
    await redis.setex(nonceKey, CONFIG.nonceTTL, '1');
    
    // 3. 获取会话密钥
    const session = await getSession(sessionId);
    
    if (!session) {
      logger.warn('Invalid session', { sessionId });
      
      return res.status(401).json({
        error: 'Invalid session',
        code: 'INVALID_SESSION'
      });
    }
    
    // 检查是否被封禁
    if (session.is_banned) {
      return res.status(403).json({
        error: 'Session banned',
        code: 'SESSION_BANNED',
        reason: session.ban_reason
      });
    }
    
    // 4. 签名验证
    const bodyStr = JSON.stringify(sortObject(req.body));
    const signStr = [
      req.method.toUpperCase(),
      req.path,
      timestamp.toString(),
      nonce,
      bodyStr
    ].join('\n');
    
    const expectedSig = crypto
      .createHmac('sha256', session.secret_key)
      .update(signStr)
      .digest('hex');
    
    if (signature !== expectedSig) {
      logger.warn('Invalid signature', {
        path: req.path,
        sessionId,
        expected: expectedSig.substring(0, 8) + '...',
        actual: signature.substring(0, 8) + '...'
      });
      
      prometheusMetrics?.signatureValidationTotal.inc({ result: 'invalid' });
      
      // 记录篡改事件
      await recordTamperEvent(sessionId, 'signature_mismatch', {
        expected: expectedSig,
        actual: signature,
        path: req.path,
        ip: req.ip
      });
      
      // 增加篡改计数
      const tamperCount = await incrementTamperCount(sessionId);
      
      if (tamperCount >= CONFIG.maxTamperCount) {
        await banSession(sessionId, 'Exceeded maximum tamper count');
        
        return res.status(403).json({
          error: 'Session banned',
          code: 'SESSION_BANNED',
          reason: 'Too many security violations'
        });
      }
      
      return res.status(401).json({
        error: 'Invalid signature',
        code: 'INVALID_SIGNATURE'
      });
    }
    
    // 验证成功
    prometheusMetrics?.signatureValidationTotal.inc({ result: 'success' });
    
    // 更新 Nonce 缓存大小指标
    const cacheSize = await redis.keys('nonce:*').then(keys => keys.length);
    prometheusMetrics?.nonceCacheSize.set(cacheSize);
    
    // 附加会话信息到请求
    req.securitySession = {
      sessionId,
      userId: session.user_id,
      deviceId: session.device_id,
      tamperCount: session.tamper_count
    };
    
    // 记录验证时间
    const duration = Date.now() - startTime;
    logger.debug('Signature verification completed', {
      path: req.path,
      sessionId,
      duration
    });
    
    next();
    
  } catch (error) {
    logger.error('Signature verification error', {
      error: error.message,
      stack: error.stack,
      path: req.path
    });
    
    return res.status(500).json({
      error: 'Signature verification failed',
      code: 'VERIFICATION_ERROR'
    });
  }
}

/**
 * 获取会话信息
 * @param {string} sessionId 
 * @returns {Object|null}
 */
async function getSession(sessionId) {
  try {
    const result = await executeQuery(
      `SELECT session_id, user_id, device_id, secret_key, 
              tamper_count, is_banned, ban_reason, expires_at
       FROM security_sessions
       WHERE session_id = $1 AND expires_at > NOW()`,
      [sessionId]
    );
    
    return result.rows[0] || null;
  } catch (error) {
    logger.error('Failed to get session', { sessionId, error: error.message });
    return null;
  }
}

/**
 * 记录篡改事件
 * @param {string} sessionId 
 * @param {string} eventType 
 * @param {Object} details 
 */
async function recordTamperEvent(sessionId, eventType, details = {}) {
  try {
    await executeQuery(
      `INSERT INTO tamper_events 
       (session_id, event_type, details, client_ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        sessionId,
        eventType,
        JSON.stringify(details),
        details.ip || null,
        details.userAgent || null
      ]
    );
    
    prometheusMetrics?.tamperDetectedTotal.inc({
      event_type: eventType,
      data_key: details.dataKey || 'unknown'
    });
    
  } catch (error) {
    logger.error('Failed to record tamper event', {
      sessionId,
      eventType,
      error: error.message
    });
  }
}

/**
 * 增加篡改计数
 * @param {string} sessionId 
 * @returns {number}
 */
async function incrementTamperCount(sessionId) {
  try {
    const result = await executeQuery(
      `UPDATE security_sessions
       SET tamper_count = tamper_count + 1
       WHERE session_id = $1
       RETURNING tamper_count`,
      [sessionId]
    );
    
    return result.rows[0]?.tamper_count || 0;
  } catch (error) {
    logger.error('Failed to increment tamper count', {
      sessionId,
      error: error.message
    });
    return 0;
  }
}

/**
 * 封禁会话
 * @param {string} sessionId 
 * @param {string} reason 
 */
async function banSession(sessionId, reason) {
  try {
    await executeQuery(
      `UPDATE security_sessions
       SET is_banned = TRUE, ban_reason = $1, banned_at = NOW()
       WHERE session_id = $2`,
      [reason, sessionId]
    );
    
    logger.warn('Session banned', { sessionId, reason });
    
  } catch (error) {
    logger.error('Failed to ban session', {
      sessionId,
      error: error.message
    });
  }
}

/**
 * 排序对象属性（确保签名一致性）
 * @param {*} obj 
 * @returns {*}
 */
function sortObject(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => sortObject(item));
  }
  
  const sorted = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    sorted[key] = sortObject(obj[key]);
  }
  return sorted;
}

/**
 * 可选的签名验证中间件（仅记录，不拦截）
 */
async function optionalSignatureVerification(req, res, next) {
  const sessionId = req.headers['x-session-id'];
  
  if (!sessionId || !isProtectedPath(req.path)) {
    return next();
  }
  
  try {
    // 执行验证但不拦截
    const result = await verifySignatureOnly(req);
    
    if (!result.valid) {
      logger.warn('Optional signature check failed', {
        path: req.path,
        sessionId,
        reason: result.reason
      });
      
      // 记录但不阻止
      req.signatureWarning = result;
    }
    
    next();
  } catch (error) {
    next();
  }
}

/**
 * 仅验证签名（不拦截）
 * @param {Object} req 
 * @returns {Object}
 */
async function verifySignatureOnly(req) {
  const timestamp = parseInt(req.headers['x-request-timestamp']);
  const nonce = req.headers['x-request-nonce'];
  const signature = req.headers['x-request-signature'];
  const sessionId = req.headers['x-session-id'];
  
  if (!timestamp || !nonce || !signature || !sessionId) {
    return { valid: false, reason: 'missing_headers' };
  }
  
  const now = Date.now();
  if (Math.abs(now - timestamp) > CONFIG.timestampWindow) {
    return { valid: false, reason: 'timestamp_expired' };
  }
  
  const redis = getRedisClient();
  const nonceKey = `nonce:${sessionId}:${nonce}`;
  const exists = await redis.exists(nonceKey);
  
  if (exists) {
    return { valid: false, reason: 'replay_attack' };
  }
  
  const session = await getSession(sessionId);
  if (!session) {
    return { valid: false, reason: 'invalid_session' };
  }
  
  const bodyStr = JSON.stringify(sortObject(req.body));
  const signStr = [
    req.method.toUpperCase(),
    req.path,
    timestamp.toString(),
    nonce,
    bodyStr
  ].join('\n');
  
  const expectedSig = crypto
    .createHmac('sha256', session.secret_key)
    .update(signStr)
    .digest('hex');
  
  if (signature !== expectedSig) {
    return { valid: false, reason: 'invalid_signature' };
  }
  
  return { valid: true };
}

module.exports = {
  verifyRequestSignature,
  optionalSignatureVerification,
  isProtectedPath,
  getSession,
  recordTamperEvent,
  incrementTamperCount,
  banSession,
  CONFIG
};
