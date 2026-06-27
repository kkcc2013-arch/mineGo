/**
 * backend/shared/sessionAnomalyDetector.js
 * REQ-00219: 会话异常检测与自动防护系统
 * 
 * 会话异常检测引擎
 */

'use strict';

const { query } = require('./db');
const { getRedis, setJSON, getJSON, del } = require('./redis');
const { createLogger } = require('./logger');
const { incrementCounter, recordHistogram } = require('./metrics');
const geoip = require('geoip-lite');

const logger = createLogger('session-anomaly-detector');

// ============================================================
// 配置常量
// ============================================================

const RISK_CONFIG = {
  // 风险阈值
  thresholds: {
    low: 30,        // 0-30: 正常
    medium: 50,     // 31-50: 低风险
    high: 70,       // 51-70: 中风险
    critical: 85    // 71-85: 高风险, 86-100: 极高风险
  },
  
  // 风险权重
  weights: {
    ip_change: 30,
    geo_jump: 40,
    device_switch: 50,
    multi_device: 35,
    abnormal_time: 15,
    high_frequency: 25,
    sensitive_operation: 20,
    brute_force_attempt: 60,
    token_reuse: 45
  },
  
  // 地理位置阈值
  geo: {
    maxDistanceKm: 500,        // 最大允许距离（公里）
    maxTimeWindowMs: 3600000   // 时间窗口（1小时）
  },
  
  // 多设备阈值
  multiDevice: {
    maxConcurrentDevices: 3
  },
  
  // 频率阈值
  frequency: {
    windowMs: 60000,          // 1分钟窗口
    maxOperations: 100        // 最大操作数
  }
};

// 防护动作
const PROTECTION_ACTIONS = {
  LOGGED: 'logged',
  NOTIFIED: 'notified',
  MFA_REQUIRED: 'mfa_required',
  SESSION_TERMINATED: 'session_terminated',
  ACCOUNT_LOCKED: 'account_locked'
};

// ============================================================
// 会话异常检测器类
// ============================================================

class SessionAnomalyDetector {
  constructor(config = {}) {
    this.config = { ...RISK_CONFIG, ...config };
  }

  /**
   * 创建会话绑定
   */
  async createSessionBinding(userId, sessionId, deviceFingerprint, deviceInfo, ip) {
    const geoLocation = this.getGeoFromIp(ip);
    const deviceInfoJson = typeof deviceInfo === 'string' ? JSON.parse(deviceInfo) : deviceInfo;
    
    const result = await query(`
      INSERT INTO session_bindings 
        (user_id, session_id, device_fingerprint, device_info, bind_ip, bind_geo, bind_city, bind_country, created_at, last_active_at)
      VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_MakePoint($6, $7), 4326), $8, $9, NOW(), NOW())
      RETURNING *
    `, [
      userId,
      sessionId,
      deviceFingerprint,
      JSON.stringify(deviceInfoJson),
      ip,
      geoLocation?.longitude || 0,
      geoLocation?.latitude || 0,
      geoLocation?.city || null,
      geoLocation?.country || null
    ]);

    const binding = result.rows[0];
    
    // 缓存到 Redis
    const cacheKey = `session:${sessionId}`;
    await setJSON(cacheKey, binding, 86400); // 24小时过期
    
    logger.info('Session binding created', {
      userId,
      sessionId,
      deviceFingerprint: deviceFingerprint.substring(0, 10) + '...',
      ip,
      city: geoLocation?.city
    });
    
    // 记录指标
    incrementCounter('session_binding_created_total', 1, { user_id: userId });
    
    return binding;
  }

  /**
   * 验证会话并检测异常
   */
  async validateSession(sessionId, context) {
    const startTime = Date.now();
    
    // 从缓存获取会话绑定
    const cacheKey = `session:${sessionId}`;
    let binding = await getJSON(cacheKey);
    
    if (!binding) {
      // 从数据库查询
      const result = await query(
        'SELECT * FROM session_bindings WHERE session_id = $1 AND status = $2',
        [sessionId, 'active']
      );
      
      if (result.rows.length === 0) {
        logger.warn('Session not found or inactive', { sessionId });
        return { valid: false, riskScore: 100, reason: 'session_not_found' };
      }
      
      binding = result.rows[0];
    }
    
    // 计算风险分数
    const riskAssessment = await this.calculateRiskScore(binding, context);
    
    // 记录评估延迟
    const duration = Date.now() - startTime;
    recordHistogram('session_risk_assessment_duration_ms', duration);
    
    // 根据风险分数执行防护动作
    const action = await this.executeProtectionAction(binding, riskAssessment, context);
    
    // 更新最后活跃时间
    await this.updateLastActive(binding.id);
    
    return {
      valid: riskAssessment.riskScore < this.config.thresholds.critical,
      riskScore: riskAssessment.riskScore,
      riskLevel: riskAssessment.riskLevel,
      anomalies: riskAssessment.anomalies,
      action,
      bindingId: binding.id
    };
  }

  /**
   * 计算风险分数
   */
  async calculateRiskScore(binding, context) {
    let riskScore = 0;
    const anomalies = [];
    
    // 1. IP 变化检测
    if (context.ip && context.ip !== binding.bind_ip) {
      const ipRisk = await this.detectIpChange(binding, context);
      if (ipRisk.detected) {
        riskScore += ipRisk.score;
        anomalies.push(ipRisk);
      }
    }
    
    // 2. 地理位置跳变检测
    if (context.geoLocation || context.ip) {
      const geoRisk = await this.detectGeoJump(binding, context);
      if (geoRisk.detected) {
        riskScore += geoRisk.score;
        anomalies.push(geoRisk);
      }
    }
    
    // 3. 设备切换检测
    if (context.deviceFingerprint && context.deviceFingerprint !== binding.device_fingerprint) {
      const deviceRisk = {
        type: 'device_switch',
        detected: true,
        score: this.config.weights.device_switch,
        details: {
          originalDevice: binding.device_fingerprint.substring(0, 10) + '...',
          newDevice: context.deviceFingerprint.substring(0, 10) + '...'
        }
      };
      riskScore += deviceRisk.score;
      anomalies.push(deviceRisk);
    }
    
    // 4. 多设备并发检测
    const multiDeviceRisk = await this.detectMultiDevice(binding.user_id);
    if (multiDeviceRisk.detected) {
      riskScore += multiDeviceRisk.score;
      anomalies.push(multiDeviceRisk);
    }
    
    // 5. 高频操作检测
    if (context.operationType) {
      const frequencyRisk = await this.detectHighFrequency(binding.user_id, context.operationType);
      if (frequencyRisk.detected) {
        riskScore += frequencyRisk.score;
        anomalies.push(frequencyRisk);
      }
    }
    
    // 确定风险等级
    const riskLevel = this.getRiskLevel(riskScore);
    
    // 记录指标
    recordHistogram('session_risk_score', riskScore);
    incrementCounter('session_risk_assessment_total', 1, { risk_level: riskLevel });
    
    return {
      riskScore: Math.min(riskScore, 100),
      riskLevel,
      anomalies
    };
  }

  /**
   * IP 变化检测
   */
  async detectIpChange(binding, context) {
    const newGeo = this.getGeoFromIp(context.ip);
    const oldGeo = this.getGeoFromIp(binding.bind_ip);
    
    // 检查是否跨国家
    if (newGeo?.country && oldGeo?.country && newGeo.country !== oldGeo.country) {
      return {
        type: 'ip_change',
        detected: true,
        score: this.config.weights.ip_change,
        details: {
          oldIp: binding.bind_ip,
          newIp: context.ip,
          oldCountry: oldGeo.country,
          newCountry: newGeo.country,
          crossCountry: true
        }
      };
    }
    
    // 检查是否跨城市
    if (newGeo?.city && oldGeo?.city && newGeo.city !== oldGeo.city) {
      return {
        type: 'ip_change',
        detected: true,
        score: Math.floor(this.config.weights.ip_change * 0.5), // 同国家不同城市，风险减半
        details: {
          oldIp: binding.bind_ip,
          newIp: context.ip,
          oldCity: oldGeo.city,
          newCity: newGeo.city
        }
      };
    }
    
    return { detected: false };
  }

  /**
   * 地理位置跳变检测
   */
  async detectGeoJump(binding, context) {
    const newGeo = context.geoLocation || this.getGeoFromIp(context.ip);
    
    if (!newGeo || !binding.bind_geo) {
      return { detected: false };
    }
    
    // 计算距离
    const distance = this.calculateDistance(
      binding.bind_geo.coordinates[1], // lat
      binding.bind_geo.coordinates[0], // lng
      newGeo.latitude,
      newGeo.longitude
    );
    
    // 计算时间差
    const timeDiff = Date.now() - new Date(binding.last_active_at).getTime();
    
    // 如果距离 > 500km 且时间 < 1小时
    if (distance > this.config.geo.maxDistanceKm && timeDiff < this.config.geo.maxTimeWindowMs) {
      return {
        type: 'geo_jump',
        detected: true,
        score: this.config.weights.geo_jump,
        details: {
          distanceKm: Math.round(distance),
          timeWindowMinutes: Math.round(timeDiff / 60000),
          oldLocation: binding.bind_city || `${binding.bind_geo.coordinates[1]},${binding.bind_geo.coordinates[0]}`,
          newLocation: newGeo.city || `${newGeo.latitude},${newGeo.longitude}`
        }
      };
    }
    
    return { detected: false };
  }

  /**
   * 多设备并发检测
   */
  async detectMultiDevice(userId) {
    const result = await query(`
      SELECT COUNT(DISTINCT device_fingerprint) as device_count
      FROM session_bindings
      WHERE user_id = $1 AND status = 'active'
    `, [userId]);
    
    const deviceCount = parseInt(result.rows[0].device_count);
    
    if (deviceCount > this.config.multiDevice.maxConcurrentDevices) {
      return {
        type: 'multi_device',
        detected: true,
        score: this.config.weights.multi_device,
        details: {
          concurrentDevices: deviceCount,
          threshold: this.config.multiDevice.maxConcurrentDevices
        }
      };
    }
    
    return { detected: false };
  }

  /**
   * 高频操作检测
   */
  async detectHighFrequency(userId, operationType) {
    const redisKey = `frequency:${userId}:${operationType}`;
    const count = await getRedis(redisKey) || 0;
    
    if (count > this.config.frequency.maxOperations) {
      return {
        type: 'high_frequency',
        detected: true,
        score: this.config.weights.high_frequency,
        details: {
          operationType,
          count,
          threshold: this.config.frequency.maxOperations,
          windowMinutes: this.config.frequency.windowMs / 60000
        }
      };
    }
    
    // 增加计数
    const redis = require('./redis').getClient();
    await redis.incr(redisKey);
    await redis.expire(redisKey, Math.ceil(this.config.frequency.windowMs / 1000));
    
    return { detected: false };
  }

  /**
   * 执行防护动作
   */
  async executeProtectionAction(binding, riskAssessment, context) {
    const { riskScore, riskLevel, anomalies } = riskAssessment;
    
    let action = PROTECTION_ACTIONS.LOGGED;
    
    // 根据风险分数决定动作
    if (riskScore <= this.config.thresholds.low) {
      // 正常：仅记录日志
      action = PROTECTION_ACTIONS.LOGGED;
    } else if (riskScore <= this.config.thresholds.medium) {
      // 低风险：发送通知
      action = PROTECTION_ACTIONS.NOTIFIED;
      await this.sendNotification(binding.user_id, 'low_risk', anomalies);
    } else if (riskScore <= this.config.thresholds.high) {
      // 中风险：要求 MFA 重验
      action = PROTECTION_ACTIONS.MFA_REQUIRED;
      await this.requestMfaVerification(binding.user_id, binding.session_id);
      await this.sendNotification(binding.user_id, 'medium_risk', anomalies);
    } else if (riskScore <= this.config.thresholds.critical) {
      // 高风险：终止会话
      action = PROTECTION_ACTIONS.SESSION_TERMINATED;
      await this.terminateSession(binding.session_id, 'high_risk_detected');
      await this.sendNotification(binding.user_id, 'high_risk', anomalies);
    } else {
      // 极高风险：锁定账号
      action = PROTECTION_ACTIONS.ACCOUNT_LOCKED;
      await this.lockAccount(binding.user_id);
      await this.terminateAllUserSessions(binding.user_id);
      await this.sendNotification(binding.user_id, 'critical_risk', anomalies);
    }
    
    // 记录异常事件
    for (const anomaly of anomalies) {
      await this.recordAnomalyEvent(binding, anomaly, action);
    }
    
    // 更新会话风险分数
    await query(
      'UPDATE session_bindings SET risk_score = $1 WHERE id = $2',
      [riskScore, binding.id]
    );
    
    logger.warn('Session protection action executed', {
      sessionId: binding.session_id,
      userId: binding.user_id,
      riskScore,
      riskLevel,
      action,
      anomalyCount: anomalies.length
    });
    
    incrementCounter('session_protection_action_total', 1, { action });
    
    return action;
  }

  /**
   * 记录异常事件
   */
  async recordAnomalyEvent(binding, anomaly, action) {
    await query(`
      INSERT INTO session_anomaly_events 
        (session_id, user_id, event_type, risk_score, details, action_taken, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [
      binding.id,
      binding.user_id,
      anomaly.type,
      anomaly.score,
      JSON.stringify(anomaly.details),
      action
    ]);
  }

  /**
   * 终止会话
   */
  async terminateSession(sessionId, reason) {
    await query(`
      UPDATE session_bindings 
      SET status = 'terminated', terminated_at = NOW(), terminate_reason = $1
      WHERE session_id = $2 AND status = 'active'
    `, [reason, sessionId]);
    
    // 删除缓存
    const cacheKey = `session:${sessionId}`;
    await del(cacheKey);
    
    // 添加到 JWT 黑名单（如果需要）
    const { addToBlacklist } = require('./auth');
    await addToBlacklist(sessionId, 'session_terminated');
    
    logger.info('Session terminated', { sessionId, reason });
    incrementCounter('session_terminated_total', 1, { reason });
  }

  /**
   * 终止用户所有会话
   */
  async terminateAllUserSessions(userId) {
    const result = await query(`
      UPDATE session_bindings 
      SET status = 'terminated', terminated_at = NOW(), terminate_reason = 'account_locked'
      WHERE user_id = $1 AND status = 'active'
      RETURNING session_id
    `, [userId]);
    
    // 删除所有缓存
    for (const row of result.rows) {
      await del(`session:${row.session_id}`);
    }
    
    logger.warn('All user sessions terminated', { userId, count: result.rows.length });
  }

  /**
   * 锁定账号
   */
  async lockAccount(userId) {
    await query(`
      UPDATE users SET status = 'locked', locked_at = NOW(), locked_reason = 'security_anomaly'
      WHERE id = $1
    `, [userId]);
    
    logger.error('Account locked due to security anomaly', { userId });
    incrementCounter('account_locked_total', 1, { reason: 'security_anomaly' });
  }

  /**
   * 请求 MFA 验证
   */
  async requestMfaVerification(userId, sessionId) {
    // 更新会话状态为 MFA 待验证
    await query(`
      UPDATE session_bindings 
      SET status = 'mfa_pending'
      WHERE session_id = $1
    `, [sessionId]);
    
    // 触发 MFA 流程（通过事件或直接调用）
    // 这里假设有一个 MFA 服务
    logger.info('MFA verification requested', { userId, sessionId });
  }

  /**
   * 发送通知
   */
  async sendNotification(userId, riskLevel, anomalies) {
    // 这里应该调用通知服务
    logger.info('Security notification sent', { userId, riskLevel, anomalyCount: anomalies.length });
    incrementCounter('security_notification_sent_total', 1, { risk_level: riskLevel });
  }

  /**
   * 更新最后活跃时间
   */
  async updateLastActive(bindingId) {
    await query(
      'UPDATE session_bindings SET last_active_at = NOW() WHERE id = $1',
      [bindingId]
    );
  }

  /**
   * 获取用户活跃会话列表
   */
  async getActiveSessions(userId) {
    const result = await query(`
      SELECT 
        id, session_id, device_fingerprint, device_info, bind_ip, bind_city, bind_country,
        risk_score, created_at, last_active_at, trusted_device
      FROM session_bindings
      WHERE user_id = $1 AND status = 'active'
      ORDER BY last_active_at DESC
    `, [userId]);
    
    return result.rows;
  }

  /**
   * 信任设备
   */
  async trustDevice(sessionId, userId) {
    await query(`
      UPDATE session_bindings 
      SET trusted_device = true
      WHERE session_id = $1 AND user_id = $2
    `, [sessionId, userId]);
    
    logger.info('Device trusted', { userId, sessionId });
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 从 IP 获取地理位置
   */
  getGeoFromIp(ip) {
    try {
      const geo = geoip.lookup(ip);
      if (geo) {
        return {
          latitude: geo.ll[0],
          longitude: geo.ll[1],
          city: geo.city,
          country: geo.country,
          region: geo.region
        };
      }
    } catch (error) {
      logger.warn('Failed to get geo from IP', { ip, error: error.message });
    }
    return null;
  }

  /**
   * 计算两点间距离（公里）
   */
  calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // 地球半径（公里）
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(deg) {
    return deg * (Math.PI / 180);
  }

  /**
   * 获取风险等级
   */
  getRiskLevel(score) {
    if (score <= this.config.thresholds.low) return 'normal';
    if (score <= this.config.thresholds.medium) return 'low';
    if (score <= this.config.thresholds.high) return 'medium';
    if (score <= this.config.thresholds.critical) return 'high';
    return 'critical';
  }
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  SessionAnomalyDetector,
  RISK_CONFIG,
  PROTECTION_ACTIONS
};
