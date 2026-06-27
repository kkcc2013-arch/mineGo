// shared/SessionSecurityMiddleware.js - 会话安全中间件
'use strict';

const crypto = require('crypto');
const { query } = require('./db');
const { getRedis, setRedis, getJSON, setJSON, delRedis } = require('./redis');
const { createLogger } = require('./logger');
const { verifyToken } = require('./auth');
const DeviceFingerprint = require('./DeviceFingerprint');
const SessionAnomalyDetector = require('./SessionAnomalyDetector');
const SessionAuditLogger = require('./SessionAuditLogger');
const ConcurrentSessionManager = require('./ConcurrentSessionManager');

const logger = createLogger('session-security-middleware');

/**
 * 会话安全中间件
 * 验证会话有效性、设备绑定、异常检测
 */
class SessionSecurityMiddleware {
  constructor(config = {}) {
    this.config = {
      strictIpCheck: config.strictIpCheck || false,
      strictDeviceCheck: config.strictDeviceCheck !== false, // 默认启用
      activityUpdateInterval: config.activityUpdateInterval || 60, // 秒
      ...config
    };
    
    this.anomalyDetector = new SessionAnomalyDetector(config);
    this.auditLogger = new SessionAuditLogger();
    this.concurrentManager = new ConcurrentSessionManager(config);
  }

  /**
   * Express 中间件：验证会话安全
   */
  validateSession() {
    return async (req, res, next) => {
      try {
        const token = this.extractToken(req);
        const deviceFingerprint = req.headers['x-device-fingerprint'] || req.body.deviceFingerprint;
        const ipAddress = this.getClientIp(req);
        const userAgent = req.headers['user-agent'];

        if (!token) {
          return res.status(401).json({
            success: false,
            error: {
              code: 1001,
              message: '未提供认证令牌'
            }
          });
        }

        // 1. 验证 JWT 令牌
        let decoded;
        try {
          decoded = await verifyToken(token);
        } catch (err) {
          logger.warn({ err, ip: ipAddress }, '令牌验证失败');
          return res.status(401).json({
            success: false,
            error: {
              code: 1002,
              message: '无效的认证令牌'
            }
          });
        }

        // 2. 检查会话是否存在且活跃
        const session = await this.getSession(decoded.sessionId);
        if (!session) {
          logger.warn({ sessionId: decoded.sessionId, userId: decoded.userId }, '会话不存在');
          return res.status(401).json({
            success: false,
            error: {
              code: 1003,
              message: '会话不存在或已过期'
            }
          });
        }

        if (!session.is_active) {
          logger.warn({ sessionId: session.id, userId: session.user_id }, '会话已失效');
          return res.status(401).json({
            success: false,
            error: {
              code: 1004,
              message: '会话已失效，请重新登录'
            }
          });
        }

        // 3. 验证设备指纹
        if (this.config.strictDeviceCheck && deviceFingerprint) {
          if (session.device_fingerprint !== deviceFingerprint) {
            logger.warn({ 
              sessionId: session.id, 
              userId: session.user_id,
              expected: session.device_fingerprint,
              actual: deviceFingerprint
            }, '设备指纹不匹配');

            // 记录异常事件
            await this.anomalyDetector.recordAnomaly({
              userId: session.user_id,
              sessionId: session.id,
              anomalyType: 'device_change',
              severity: 'high',
              details: {
                expectedFingerprint: session.device_fingerprint,
                actualFingerprint: deviceFingerprint,
                ipAddress,
                userAgent
              }
            });

            // 终止会话
            await this.terminateSession(session.id, 'device_fingerprint_mismatch');

            return res.status(401).json({
              success: false,
              error: {
                code: 1005,
                message: '检测到设备变化，出于安全考虑已登出'
              }
            });
          }
        }

        // 4. 验证 IP 地址（可选）
        if (this.config.strictIpCheck) {
          const ipChanged = session.ip_address !== ipAddress;
          
          if (ipChanged) {
            // 检查地理位置一致性（允许小范围移动）
            const geoValid = await this.anomalyDetector.checkGeoConsistency(session, ipAddress);
            
            if (!geoValid.valid) {
              logger.warn({
                sessionId: session.id,
                userId: session.user_id,
                oldIp: session.ip_address,
                newIp: ipAddress,
                distance: geoValid.distance
              }, 'IP 地址异常变化');

              // 记录异常
              await this.anomalyDetector.recordAnomaly({
                userId: session.user_id,
                sessionId: session.id,
                anomalyType: 'ip_change',
                severity: 'medium',
                details: {
                  oldIp: session.ip_address,
                  newIp: ipAddress,
                  distance: geoValid.distance
                }
              });

              // 根据距离决定是否终止会话
              if (geoValid.distance > 1000) { // 超过 1000km
                await this.terminateSession(session.id, 'suspicious_ip_change');
                
                return res.status(401).json({
                  success: false,
                  error: {
                    code: 1006,
                    message: '检测到异常登录位置，出于安全考虑已登出'
                  }
                });
              }
            }
          }
        }

        // 5. 检查会话是否被标记为可疑
        if (session.is_suspicious) {
          logger.warn({
            sessionId: session.id,
            userId: session.user_id,
            riskScore: session.risk_score
          }, '可疑会话尝试访问');

          // 可以选择要求重新验证或直接拒绝
          return res.status(401).json({
            success: false,
            error: {
              code: 1007,
              message: '账户存在安全风险，请重新登录'
            }
          });
        }

        // 6. 更新最后活动时间（节流）
        const now = Date.now();
        const lastUpdate = session.last_activity_at.getTime();
        if ((now - lastUpdate) / 1000 > this.config.activityUpdateInterval) {
          await this.updateLastActivity(session.id);
        }

        // 将会话信息附加到请求对象
        req.session = session;
        req.userId = session.user_id;
        req.sessionId = session.id;

        next();
      } catch (error) {
        logger.error({ error }, '会话验证中间件错误');
        res.status(500).json({
          success: false,
          error: {
            code: 1099,
            message: '会话验证失败'
          }
        });
      }
    };
  }

  /**
   * 获取会话信息
   */
  async getSession(sessionId) {
    // 先查 Redis 缓存
    const cacheKey = `session:${sessionId}`;
    const cached = await getJSON(cacheKey);
    
    if (cached) {
      return cached;
    }

    // 查数据库
    const result = await query(
      `SELECT 
        id, user_id, session_token_hash, refresh_token_hash,
        device_fingerprint, device_name, device_type,
        ip_address, user_agent, geo_location,
        created_at, last_activity_at, expires_at,
        is_active, is_suspicious, risk_score
       FROM user_sessions 
       WHERE id = $1`,
      [sessionId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const session = result.rows[0];

    // 缓存 5 分钟
    await setJSON(cacheKey, session, 300);

    return session;
  }

  /**
   * 更新最后活动时间
   */
  async updateLastActivity(sessionId) {
    await query(
      'UPDATE user_sessions SET last_activity_at = CURRENT_TIMESTAMP WHERE id = $1',
      [sessionId]
    );

    // 更新缓存
    const cacheKey = `session:${sessionId}`;
    await delRedis(cacheKey);
  }

  /**
   * 终止会话
   */
  async terminateSession(sessionId, reason = 'manual') {
    await query(
      'UPDATE user_sessions SET is_active = false WHERE id = $1',
      [sessionId]
    );

    // 清除缓存
    const cacheKey = `session:${sessionId}`;
    await delRedis(cacheKey);

    // 记录审计日志
    await this.auditLogger.log({
      sessionId,
      action: 'terminated',
      metadata: { reason }
    });

    logger.info({ sessionId, reason }, '会话已终止');
  }

  /**
   * 从请求中提取令牌
   */
  extractToken(req) {
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      return req.headers.authorization.substring(7);
    }
    if (req.query.token) {
      return req.query.token;
    }
    if (req.cookies && req.cookies.accessToken) {
      return req.cookies.accessToken;
    }
    return null;
  }

  /**
   * 获取客户端真实 IP
   */
  getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           '0.0.0.0';
  }
}

module.exports = SessionSecurityMiddleware;
