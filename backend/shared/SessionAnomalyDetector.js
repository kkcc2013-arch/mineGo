// shared/SessionAnomalyDetector.js - 会话异常检测引擎
'use strict';

const { query } = require('./db');
const { getRedis, setRedis, getJSON, setJSON } = require('./redis');
const { createLogger } = require('./logger');
const SessionAuditLogger = require('./SessionAuditLogger');

const logger = createLogger('session-anomaly-detector');

/**
 * 会话异常检测引擎
 * 检测地理位置跳变、设备切换、可疑位置等异常行为
 */
class SessionAnomalyDetector {
  constructor(config = {}) {
    this.config = {
      geoJumpThresholdKm: config.geoJumpThresholdKm || 500,
      maxDeviceChangesPerHour: config.maxDeviceChangesPerHour || 3,
      maxIpChangesPerHour: config.maxIpChangesPerHour || 5,
      suspiciousCountries: config.suspiciousCountries || [],
      suspiciousRiskThreshold: config.suspiciousRiskThreshold || 70,
      ...config
    };
    
    this.auditLogger = new SessionAuditLogger();
  }

  /**
   * 检测会话异常
   * @param {Object} session - 当前会话信息
   * @param {string} newIp - 新 IP 地址
   * @param {string} newDeviceFingerprint - 新设备指纹
   * @returns {Array} 异常列表
   */
  async detectAnomalies(session, newIp, newDeviceFingerprint) {
    const anomalies = [];

    try {
      // 1. 检测地理位置跳变
      if (session.geo_location) {
        const geoAnomaly = await this.checkGeoJump(session, newIp);
        if (geoAnomaly) {
          anomalies.push(geoAnomaly);
        }
      }

      // 2. 检测设备频繁切换
      const deviceChangeAnomaly = await this.checkFrequentDeviceChange(session.user_id);
      if (deviceChangeAnomaly) {
        anomalies.push(deviceChangeAnomaly);
      }

      // 3. 检测 IP 频繁变更
      const ipChangeAnomaly = await this.checkFrequentIpChange(session.user_id);
      if (ipChangeAnomaly) {
        anomalies.push(ipChangeAnomaly);
      }

      // 4. 检测可疑国家/地区
      const locationAnomaly = await this.checkSuspiciousLocation(newIp);
      if (locationAnomaly) {
        anomalies.push(locationAnomaly);
      }

      // 5. 检测并发会话异常
      const concurrentAnomaly = await this.checkConcurrentSessionLimit(session.user_id);
      if (concurrentAnomaly) {
        anomalies.push(concurrentAnomaly);
      }

      // 记录所有异常
      for (const anomaly of anomalies) {
        await this.recordAnomaly({
          userId: session.user_id,
          sessionId: session.id,
          anomalyType: anomaly.type,
          severity: anomaly.severity,
          details: anomaly.details
        });
      }

      return anomalies;
    } catch (error) {
      logger.error({ error, userId: session.user_id }, '异常检测失败');
      return [];
    }
  }

  /**
   * 检查地理位置跳变
   */
  async checkGeoJump(session, newIp) {
    try {
      // 获取新 IP 的地理位置
      const newGeo = await this.getGeoLocation(newIp);
      
      if (!newGeo || !session.geo_location) {
        return null;
      }

      const distance = this.calculateDistance(
        session.geo_location,
        newGeo
      );

      if (distance > this.config.geoJumpThresholdKm) {
        return {
          type: 'geo_jump',
          severity: distance > 2000 ? 'critical' : 'high',
          details: {
            previousLocation: session.geo_location,
            newLocation: newGeo,
            distanceKm: Math.round(distance),
            thresholdKm: this.config.geoJumpThresholdKm
          }
        };
      }

      return null;
    } catch (error) {
      logger.error({ error, ip: newIp }, '地理位置查询失败');
      return null;
    }
  }

  /**
   * 检查地理位置一致性
   * @returns {Object} { valid: boolean, distance: number }
   */
  async checkGeoConsistency(session, newIp) {
    try {
      const newGeo = await this.getGeoLocation(newIp);
      
      if (!newGeo || !session.geo_location) {
        return { valid: true, distance: 0 };
      }

      const distance = this.calculateDistance(session.geo_location, newGeo);
      
      // 小于阈值视为合理移动（如 WiFi 切换、移动网络漫游）
      return {
        valid: distance <= this.config.geoJumpThresholdKm,
        distance,
        previous: session.geo_location,
        current: newGeo
      };
    } catch (error) {
      logger.error({ error, ip: newIp }, '地理位置一致性检查失败');
      return { valid: true, distance: 0 }; // 失败时默认通过
    }
  }

  /**
   * 检查设备频繁切换
   */
  async checkFrequentDeviceChange(userId) {
    try {
      const cacheKey = `device_changes:${userId}`;
      let count = await getRedis(cacheKey);
      
      if (!count) {
        // 从审计日志统计最近一小时内的设备变更次数
        const result = await query(
          `SELECT COUNT(*) as count
           FROM session_audit_logs
           WHERE user_id = $1 
           AND action = 'device_change'
           AND created_at > NOW() - INTERVAL '1 hour'`,
          [userId]
        );
        count = result.rows[0]?.count || 0;
        await setRedis(cacheKey, count, 3600);
      }

      if (parseInt(count) >= this.config.maxDeviceChangesPerHour) {
        return {
          type: 'frequent_device_change',
          severity: 'medium',
          details: {
            changeCount: parseInt(count),
            threshold: this.config.maxDeviceChangesPerHour,
            timeWindow: '1 hour'
          }
        };
      }

      return null;
    } catch (error) {
      logger.error({ error, userId }, '设备变更检查失败');
      return null;
    }
  }

  /**
   * 检查 IP 频繁变更
   */
  async checkFrequentIpChange(userId) {
    try {
      const cacheKey = `ip_changes:${userId}`;
      let count = await getRedis(cacheKey);
      
      if (!count) {
        const result = await query(
          `SELECT COUNT(*) as count
           FROM session_audit_logs
           WHERE user_id = $1 
           AND action = 'ip_change'
           AND created_at > NOW() - INTERVAL '1 hour'`,
          [userId]
        );
        count = result.rows[0]?.count || 0;
        await setRedis(cacheKey, count, 3600);
      }

      if (parseInt(count) >= this.config.maxIpChangesPerHour) {
        return {
          type: 'frequent_ip_change',
          severity: 'medium',
          details: {
            changeCount: parseInt(count),
            threshold: this.config.maxIpChangesPerHour,
            timeWindow: '1 hour'
          }
        };
      }

      return null;
    } catch (error) {
      logger.error({ error, userId }, 'IP 变更检查失败');
      return null;
    }
  }

  /**
   * 检查可疑国家/地区
   */
  async checkSuspiciousLocation(ip) {
    try {
      const geo = await this.getGeoLocation(ip);
      
      if (!geo || !geo.country) {
        return null;
      }

      if (this.config.suspiciousCountries.includes(geo.country)) {
        return {
          type: 'suspicious_location',
          severity: 'high',
          details: {
            country: geo.country,
            city: geo.city,
            ip
          }
        };
      }

      return null;
    } catch (error) {
      logger.error({ error, ip }, '可疑位置检查失败');
      return null;
    }
  }

  /**
   * 检查并发会话限制
   */
  async checkConcurrentSessionLimit(userId) {
    try {
      const result = await query(
        `SELECT COUNT(*) as count
         FROM user_sessions
         WHERE user_id = $1 
         AND is_active = true
         AND expires_at > NOW()`,
        [userId]
      );

      const count = parseInt(result.rows[0]?.count || 0);
      const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '5');

      if (count >= maxConcurrent) {
        return {
          type: 'concurrent_limit_exceeded',
          severity: 'low',
          details: {
            currentCount: count,
            maxAllowed: maxConcurrent
          }
        };
      }

      return null;
    } catch (error) {
      logger.error({ error, userId }, '并发会话检查失败');
      return null;
    }
  }

  /**
   * 记录异常事件
   */
  async recordAnomaly({ userId, sessionId, anomalyType, severity, details }) {
    try {
      const result = await query(
        `INSERT INTO session_anomaly_events 
         (user_id, session_id, anomaly_type, severity, details, action_taken)
         VALUES ($1, $2, $3, $4, $5, 'logged')
         RETURNING id`,
        [userId, sessionId, anomalyType, severity, JSON.stringify(details)]
      );

      const anomalyId = result.rows[0].id;

      logger.warn({
        anomalyId,
        userId,
        sessionId,
        anomalyType,
        severity,
        details
      }, '会话异常已记录');

      // 更新会话风险评分
      await this.updateSessionRiskScore(sessionId, severity);

      return anomalyId;
    } catch (error) {
      logger.error({ error, userId, anomalyType }, '记录异常失败');
      return null;
    }
  }

  /**
   * 更新会话风险评分
   */
  async updateSessionRiskScore(sessionId, anomalySeverity) {
    try {
      const scoreMap = {
        low: 10,
        medium: 30,
        high: 50,
        critical: 70
      };

      const additionalScore = scoreMap[anomalySeverity] || 10;

      await query(
        `UPDATE user_sessions 
         SET risk_score = MIN(100, risk_score + $1),
             is_suspicious = CASE WHEN risk_score + $1 >= $2 THEN true ELSE is_suspicious END
         WHERE id = $3`,
        [additionalScore, this.config.suspiciousRiskThreshold, sessionId]
      );
    } catch (error) {
      logger.error({ error, sessionId }, '更新风险评分失败');
    }
  }

  /**
   * 获取 IP 的地理位置
   * 使用免费的 GeoIP 服务
   */
  async getGeoLocation(ip) {
    try {
      // 缓存键
      const cacheKey = `geo:${ip}`;
      const cached = await getJSON(cacheKey);
      
      if (cached) {
        return cached;
      }

      // 使用 ip-api.com 免费 API（生产环境应使用专业 GeoIP 服务）
      if (ip === '127.0.0.1' || ip === '0.0.0.0' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
        return null; // 内网 IP 无法定位
      }

      const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,city,lat,lon`);
      const data = await response.json();

      if (data.status === 'success') {
        const geo = {
          country: data.countryCode,
          countryName: data.country,
          city: data.city,
          lat: data.lat,
          lng: data.lon
        };

        // 缓存 24 小时
        await setJSON(cacheKey, geo, 86400);

        return geo;
      }

      return null;
    } catch (error) {
      logger.error({ error, ip }, '获取地理位置失败');
      return null;
    }
  }

  /**
   * 计算两点间距离（Haversine 公式）
   * @returns {number} 距离（公里）
   */
  calculateDistance(loc1, loc2) {
    const R = 6371; // 地球半径（公里）

    const lat1 = parseFloat(loc1.lat) || 0;
    const lng1 = parseFloat(loc1.lng) || 0;
    const lat2 = parseFloat(loc2.lat) || 0;
    const lng2 = parseFloat(loc2.lng) || 0;

    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  /**
   * 角度转弧度
   */
  toRad(deg) {
    return deg * (Math.PI / 180);
  }

  /**
   * 获取用户未处理的异常事件
   */
  async getUnresolvedAnomalies(userId, limit = 10) {
    try {
      const result = await query(
        `SELECT id, anomaly_type, severity, details, detected_at, action_taken
         FROM session_anomaly_events
         WHERE user_id = $1 AND resolved_at IS NULL
         ORDER BY 
           CASE severity 
             WHEN 'critical' THEN 1
             WHEN 'high' THEN 2
             WHEN 'medium' THEN 3
             WHEN 'low' THEN 4
           END,
           detected_at DESC
         LIMIT $2`,
        [userId, limit]
      );

      return result.rows;
    } catch (error) {
      logger.error({ error, userId }, '获取异常事件失败');
      return [];
    }
  }

  /**
   * 解决异常事件
   */
  async resolveAnomaly(anomalyId, notes = '') {
    try {
      await query(
        `UPDATE session_anomaly_events 
         SET resolved_at = NOW(), 
             resolution_notes = $2
         WHERE id = $1`,
        [anomalyId, notes]
      );

      logger.info({ anomalyId, notes }, '异常事件已解决');
    } catch (error) {
      logger.error({ error, anomalyId }, '解决异常事件失败');
    }
  }
}

module.exports = SessionAnomalyDetector;