/**
 * 捕获请求验证服务
 * 验证 AR 捕获请求的合法性
 * 
 * REQ-00521: 游戏 AR 增强现实捕获模式防作弊与安全防护系统
 */

'use strict';

const { logger, metrics } = require('../../shared/logging');
const SensorValidator = require('./sensorValidator');
const CaptureBehaviorAnalyzer = require('../../analysis/src/captureBehaviorAnalyzer');

/**
 * 捕获验证器
 */
class CaptureValidator {
  constructor(db, redis, config = {}) {
    this.db = db;
    this.redis = redis;
    
    this.sensorValidator = new SensorValidator(config.sensor);
    this.behaviorAnalyzer = new CaptureBehaviorAnalyzer(db, redis, config.behavior);
    
    this.config = {
      // 捕获会话有效期（秒）
      sessionTimeout: config.sessionTimeout || 300,
      // 最大并发捕获数
      maxConcurrentCaptures: config.maxConcurrentCaptures || 3,
      // 位置验证半径（米）
      locationRadius: config.locationRadius || 100,
      // 是否启用传感器验证
      enableSensorValidation: config.enableSensorValidation !== false,
      // 是否启用行为分析
      enableBehaviorAnalysis: config.enableBehaviorAnalysis !== false,
      ...config
    };
    
    this.registerMetrics();
  }
  
  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    if (metrics && metrics.counter) {
      metrics.counter('capture_request_validation_total', 'Total capture request validations', ['result']);
      metrics.counter('capture_request_blocked_total', 'Blocked capture requests', ['reason']);
      metrics.histogram('capture_validation_duration_seconds', 'Capture validation duration');
    }
  }
  
  /**
   * 验证捕获请求
   * @param {number} userId - 用户 ID
   * @param {Object} requestData - 请求数据
   * @returns {Object} 验证结果
   */
  async validateCaptureRequest(userId, requestData) {
    const startTime = Date.now();
    const validations = [];
    
    try {
      // 1. 位置合理性验证
      const locationValid = await this.validateLocation(userId, requestData.location, requestData.timestamp);
      validations.push(locationValid);
      
      // 2. 设备指纹验证
      const deviceValid = await this.validateDevice(userId, requestData.deviceFingerprint);
      validations.push(deviceValid);
      
      // 3. 传感器数据验证（如果启用）
      if (this.config.enableSensorValidation && requestData.sensorData) {
        const sensorValid = await this.validateSensors(requestData.sensorData);
        validations.push(sensorValid);
      }
      
      // 4. 捕获窗口验证
      const windowValid = await this.validateCaptureWindow(
        userId, 
        requestData.pokemonId, 
        requestData.captureSessionId
      );
      validations.push(windowValid);
      
      // 5. 客户端安全检测结果验证
      const clientChecksValid = await this.validateClientChecks(requestData.clientSecurityChecks);
      validations.push(clientChecksValid);
      
      // 6. 行为分析（如果启用）
      if (this.config.enableBehaviorAnalysis) {
        const behaviorValid = await this.analyzeBehavior(userId, requestData);
        validations.push(behaviorValid);
      }
      
      // 计算总体有效性
      const overallValid = validations.every(v => v.valid !== false);
      const riskLevel = this.calculateOverallRisk(validations);
      const action = this.determineAction(riskLevel);
      
      // 记录验证结果
      await this.recordValidation(userId, requestData, {
        valid: overallValid,
        riskLevel,
        validations,
        action
      });
      
      const duration = (Date.now() - startTime) / 1000;
      this.recordMetrics(overallValid, action, duration);
      
      return {
        valid: overallValid,
        riskLevel,
        validations,
        action,
        duration
      };
      
    } catch (error) {
      logger.error('Capture validation failed', {
        userId,
        error: error.message,
        stack: error.stack
      });
      
      return {
        valid: false,
        riskLevel: 'unknown',
        validations,
        action: { type: 'reject', reason: 'validation_error' },
        error: error.message
      };
    }
  }
  
  /**
   * 验证位置合理性
   */
  async validateLocation(userId, location, timestamp) {
    if (!location || !location.latitude || !location.longitude) {
      return {
        type: 'location',
        valid: false,
        reason: 'invalid_location_data'
      };
    }
    
    // 检查位置是否在合理范围内
    const boundsCheck = this.checkLocationBounds(location);
    if (!boundsCheck.valid) {
      return {
        type: 'location',
        valid: false,
        reason: boundsCheck.reason
      };
    }
    
    // 检查位置是否与上一次位置合理
    const previousLocation = await this.getLastLocation(userId);
    if (previousLocation) {
      const travelCheck = this.checkTravelFeasibility(
        previousLocation,
        location,
        previousLocation.timestamp,
        timestamp
      );
      
      if (!travelCheck.valid) {
        return {
          type: 'location',
          valid: false,
          reason: travelCheck.reason,
          details: travelCheck.details
        };
      }
    }
    
    return {
      type: 'location',
      valid: true,
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy
      }
    };
  }
  
  /**
   * 验证设备指纹
   */
  async validateDevice(userId, fingerprint) {
    if (!fingerprint) {
      return {
        type: 'device',
        valid: false,
        reason: 'missing_fingerprint'
      };
    }
    
    // 检查设备是否被信任
    const trustedDevice = await this.isTrustedDevice(userId, fingerprint.deviceId);
    
    // 检查设备状态
    const deviceStatus = await this.getDeviceStatus(fingerprint.deviceId);
    
    if (deviceStatus.banned) {
      return {
        type: 'device',
        valid: false,
        reason: 'device_banned',
        deviceId: fingerprint.deviceId
      };
    }
    
    // 检查指纹完整性
    const requiredFields = ['deviceId', 'osVersion', 'appVersion'];
    const missingFields = requiredFields.filter(f => !fingerprint[f]);
    
    if (missingFields.length > 0) {
      return {
        type: 'device',
        valid: false,
        reason: 'incomplete_fingerprint',
        missingFields
      };
    }
    
    return {
      type: 'device',
      valid: true,
      trusted: trustedDevice,
      deviceId: fingerprint.deviceId
    };
  }
  
  /**
   * 验证传感器数据
   */
  async validateSensors(sensorData) {
    const result = this.sensorValidator.validateAll(sensorData);
    
    return {
      type: 'sensor',
      valid: result.overallValid,
      confidence: result.overallScore,
      riskLevel: result.riskLevel,
      anomalies: Object.values(result.results)
        .filter(r => r && r.anomalies)
        .flatMap(r => r.anomalies)
    };
  }
  
  /**
   * 验证捕获窗口
   */
  async validateCaptureWindow(userId, pokemonId, sessionId) {
    if (!sessionId) {
      return {
        type: 'window',
        valid: false,
        reason: 'missing_session_id'
      };
    }
    
    // 检查会话是否有效
    const session = await this.redis.get(`capture_session:${sessionId}`);
    
    if (!session) {
      return {
        type: 'window',
        valid: false,
        reason: 'invalid_session'
      };
    }
    
    const sessionData = JSON.parse(session);
    
    // 检查会话是否过期
    if (Date.now() - sessionData.createdAt > this.config.sessionTimeout * 1000) {
      return {
        type: 'window',
        valid: false,
        reason: 'session_expired'
      };
    }
    
    // 检查精灵是否匹配
    if (sessionData.pokemonId !== pokemonId) {
      return {
        type: 'window',
        valid: false,
        reason: 'pokemon_mismatch'
      };
    }
    
    // 检查用户是否匹配
    if (sessionData.userId !== userId) {
      return {
        type: 'window',
        valid: false,
        reason: 'user_mismatch'
      };
    }
    
    return {
      type: 'window',
      valid: true,
      sessionId
    };
  }
  
  /**
   * 验证客户端安全检测结果
   */
  async validateClientChecks(securityChecks) {
    if (!securityChecks) {
      return {
        type: 'client_checks',
        valid: true, // 不强制要求客户端检测结果
        warnings: ['missing_client_checks']
      };
    }
    
    const violations = [];
    
    // 检测 Root/Jailbreak
    if (securityChecks.rootDetected || securityChecks.jailbreakDetected) {
      violations.push({
        type: 'root_detected',
        severity: 'high'
      });
    }
    
    // 检测模拟器
    if (securityChecks.emulatorDetected) {
      violations.push({
        type: 'emulator_detected',
        severity: 'medium'
      });
    }
    
    // 检测 Mock Location
    if (securityChecks.mockLocationDetected) {
      violations.push({
        type: 'mock_location_detected',
        severity: 'critical'
      });
    }
    
    // 检测调试器
    if (securityChecks.debuggerDetected) {
      violations.push({
        type: 'debugger_detected',
        severity: 'high'
      });
    }
    
    // 检测注入框架
    if (securityChecks.hookFrameworkDetected) {
      violations.push({
        type: 'hook_framework_detected',
        severity: 'critical'
      });
    }
    
    const valid = !violations.some(v => v.severity === 'critical');
    
    return {
      type: 'client_checks',
      valid,
      violations,
      rawChecks: securityChecks
    };
  }
  
  /**
   * 分析行为
   */
  async analyzeBehavior(userId, captureData) {
    try {
      const result = await this.behaviorAnalyzer.analyzeCapture(userId, captureData);
      
      return {
        type: 'behavior',
        valid: result.riskLevel !== 'critical',
        riskScore: result.riskScore,
        riskLevel: result.riskLevel,
        flags: result.flags
      };
    } catch (error) {
      logger.error('Behavior analysis failed', { userId, error: error.message });
      
      return {
        type: 'behavior',
        valid: true,
        warning: 'behavior_analysis_failed'
      };
    }
  }
  
  /**
   * 计算总体风险
   */
  calculateOverallRisk(validations) {
    const riskScores = validations.map(v => {
      if (!v) return 0;
      if (v.valid === false) return 100;
      if (v.riskLevel === 'critical') return 100;
      if (v.riskLevel === 'high') return 75;
      if (v.riskLevel === 'medium') return 50;
      if (v.riskLevel === 'low') return 25;
      return 0;
    });
    
    return Math.max(...riskScores);
  }
  
  /**
   * 确定行动
   */
  determineAction(riskLevel) {
    switch (riskLevel) {
      case 'critical':
      case 100:
        return {
          type: 'reject',
          reason: 'security_violation',
          log: true,
          alert: true
        };
        
      case 'high':
      case 75:
        return {
          type: 'flag',
          reason: 'suspicious_activity',
          review: true,
          log: true
        };
        
      case 'medium':
      case 50:
        return {
          type: 'monitor',
          reason: 'anomaly_detected',
          track: true,
          log: true
        };
        
      case 'low':
      case 25:
        return {
          type: 'log',
          reason: 'minor_concern'
        };
        
      default:
        return {
          type: 'allow',
          reason: 'normal'
        };
    }
  }
  
  /**
   * 检查位置边界
   */
  checkLocationBounds(location) {
    // 纬度范围：-90 到 90
    if (location.latitude < -90 || location.latitude > 90) {
      return { valid: false, reason: 'invalid_latitude' };
    }
    
    // 经度范围：-180 到 180
    if (location.longitude < -180 || location.longitude > 180) {
      return { valid: false, reason: 'invalid_longitude' };
    }
    
    // 检查精度是否合理（米）
    if (location.accuracy !== undefined && location.accuracy < 0) {
      return { valid: false, reason: 'invalid_accuracy' };
    }
    
    return { valid: true };
  }
  
  /**
   * 检查移动可行性
   */
  checkTravelFeasibility(from, to, fromTime, toTime) {
    const distance = this.calculateDistance(from.latitude, from.longitude, to.latitude, to.longitude);
    const timeDiff = Math.abs(new Date(toTime) - new Date(fromTime)) / 1000;
    
    // 避免除零
    if (timeDiff === 0) {
      return { valid: distance < 10, reason: 'same_timestamp' };
    }
    
    const speed = distance / timeDiff; // m/s
    const speedKmh = speed * 3.6;
    
    // 超过 200 km/h 认为不可行
    if (speedKmh > 200) {
      return {
        valid: false,
        reason: 'impossible_speed',
        details: {
          distance,
          timeDiff,
          speed: speedKmh
        }
      };
    }
    
    return { valid: true, speed: speedKmh };
  }
  
  /**
   * 计算两点距离
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // 地球半径（米）
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
  
  toRad(deg) {
    return deg * Math.PI / 180;
  }
  
  /**
   * 获取上次位置
   */
  async getLastLocation(userId) {
    try {
      const cached = await this.redis.get(`user_location:${userId}:last`);
      if (cached) {
        return JSON.parse(cached);
      }
      
      const result = await this.db.query(`
        SELECT latitude, longitude, created_at as timestamp
        FROM capture_logs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `, [userId]);
      
      if (result.rows.length > 0) {
        return result.rows[0];
      }
      
      return null;
    } catch (error) {
      logger.error('Failed to get last location', { userId, error: error.message });
      return null;
    }
  }
  
  /**
   * 检查设备是否被信任
   */
  async isTrustedDevice(userId, deviceId) {
    try {
      const result = await this.db.query(`
        SELECT is_trusted
        FROM device_fingerprints
        WHERE user_id = $1 AND device_id = $2 AND is_trusted = true
        LIMIT 1
      `, [userId, deviceId]);
      
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }
  
  /**
   * 获取设备状态
   */
  async getDeviceStatus(deviceId) {
    try {
      const banned = await this.redis.sismember('banned_devices', deviceId);
      return { banned: banned === 1 };
    } catch {
      return { banned: false };
    }
  }
  
  /**
   * 记录验证结果
   */
  async recordValidation(userId, requestData, result) {
    try {
      await this.db.query(`
        INSERT INTO capture_validations (
          user_id, pokemon_id, capture_session_id,
          validation_result, risk_level, action_taken, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [
        userId,
        requestData.pokemonId,
        requestData.captureSessionId,
        JSON.stringify(result),
        result.riskLevel,
        result.action?.type
      ]);
    } catch (error) {
      logger.error('Failed to record validation', { userId, error: error.message });
    }
  }
  
  /**
   * 记录指标
   */
  recordMetrics(valid, action, duration) {
    if (metrics) {
      metrics.inc('capture_request_validation_total', { result: valid ? 'valid' : 'invalid' });
      
      if (!valid || action.type !== 'allow') {
        metrics.inc('capture_request_blocked_total', { reason: action?.reason || 'unknown' });
      }
      
      metrics.observe('capture_validation_duration_seconds', duration);
    }
  }
}

module.exports = CaptureValidator;
