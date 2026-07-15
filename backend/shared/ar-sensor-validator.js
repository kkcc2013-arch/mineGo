// shared/ar-sensor-validator.js - AR 传感器数据验证与风控系统
// REQ-00041: 增强现实(AR)精准匹配与抗作弊(风控)系统
'use strict';

const crypto = require('crypto');
const { createLogger } = require('./logger');
const { getRedis, getJSON, setJSON } = require('./redis');
const { query } = require('./db');
const promClient = require('prom-client');

const logger = createLogger('ar-sensor-validator');

// ============================================================
// 配置常量
// ============================================================

const SENSOR_CONFIG = {
  // 传感器数据有效期（秒）
  DATA_TTL: 30,
  
  // 签名有效期窗口（毫秒）
  SIGNATURE_WINDOW: 60000,
  
  // 异常阈值
  THRESHOLDS: {
    // 加速度变化率异常阈值（m/s²）
    ACCELERATION_RATE: 50,
    // 陀螺仪旋转率异常阈值（rad/s）
    GYRO_RATE: 10,
    // GPS与传感器位置偏差阈值（米）
    POSITION_DEVIATION: 100,
    // 投掷动作最小加速度峰值
    THROW_MIN_ACCEL: 5,
    // 投掷动作最大加速度峰值（超过可能是作弊）
    THROW_MAX_ACCEL: 100,
    // AR场景最小持续时间（秒）
    AR_MIN_DURATION: 2,
    // 设备温度异常阈值（°C）
    TEMPERATURE_MAX: 60,
  },

  // 可信设备指纹特征
  DEVICE_SIGNATURE_FEATURES: [
    'screen_width',
    'screen_height',
    'device_model',
    'os_version',
    'cpu_cores',
    'total_memory',
    'sensor_list',
  ],
};

// ============================================================
// Prometheus 指标
// ============================================================

const metrics = {
  sensorValidationsTotal: new promClient.Counter({
    name: 'minego_ar_sensor_validations_total',
    help: 'Total AR sensor validations',
    labelNames: ['result', 'risk_level'],
  }),

  signatureValidations: new promClient.Counter({
    name: 'minego_ar_signature_validations_total',
    help: 'AR signature validations',
    labelNames: ['valid', 'reason'],
  }),

  arSessionAnomalies: new promClient.Counter({
    name: 'minego_ar_session_anomalies_total',
    help: 'AR session anomalies detected',
    labelNames: ['anomaly_type', 'severity'],
  }),

  forcedRevalidationTotal: new promClient.Counter({
    name: 'minego_ar_forced_revalidation_total',
    help: 'Forced re-validation triggered',
    labelNames: ['trigger_reason'],
  }),

  sensorDataScore: new promClient.Histogram({
    name: 'minego_ar_sensor_data_score',
    help: 'AR sensor data integrity score distribution',
    buckets: [0, 20, 40, 60, 80, 100],
  }),
};

// ============================================================
// 工具函数
// ============================================================

/**
 * 验证传感器数据签名
 */
function verifySensorSignature(payload, signature, secret) {
  try {
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );
  } catch (err) {
    logger.error({ err }, 'Signature verification failed');
    return false;
  }
}

/**
 * 计算加速度向量变化率
 */
function calculateAccelerationRate(accelHistory) {
  if (accelHistory.length < 2) return 0;

  const rates = [];
  for (let i = 1; i < accelHistory.length; i++) {
    const prev = accelHistory[i - 1];
    const curr = accelHistory[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dz = curr.z - prev.z;
    const dt = (curr.timestamp - prev.timestamp) / 1000; // 转为秒
    
    if (dt > 0) {
      const rate = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
      rates.push(rate);
    }
  }

  return rates.length > 0 ? Math.max(...rates) : 0;
}

/**
 * 计算陀螺仪旋转率
 */
function calculateGyroRate(gyroHistory) {
  if (gyroHistory.length < 2) return 0;

  const rates = [];
  for (let i = 1; i < gyroHistory.length; i++) {
    const prev = gyroHistory[i - 1];
    const curr = gyroHistory[i];
    const drx = Math.abs(curr.rotation_x - prev.rotation_x);
    const dry = Math.abs(curr.rotation_y - prev.rotation_y);
    const drz = Math.abs(curr.rotation_z - prev.rotation_z);
    const dt = (curr.timestamp - prev.timestamp) / 1000;

    if (dt > 0) {
      const rate = Math.sqrt(drx * drx + dry * dry + drz * drz) / dt;
      rates.push(rate);
    }
  }

  return rates.length > 0 ? Math.max(...rates) : 0;
}

/**
 * 计算GPS位置与传感器估计位置的偏差
 */
function calculatePositionDeviation(gpsLocation, sensorEstimate) {
  const R = 6371000; // 地球半径（米）
  const lat1 = gpsLocation.lat * Math.PI / 180;
  const lat2 = sensorEstimate.lat * Math.PI / 180;
  const dLat = (sensorEstimate.lat - gpsLocation.lat) * Math.PI / 180;
  const dLng = (sensorEstimate.lng - gpsLocation.lng) * Math.PI / 180;

  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * 检测投掷动作是否合理
 */
function analyzeThrowMotion(accelHistory) {
  if (accelHistory.length < 10) {
    return { valid: false, reason: 'INSUFFICIENT_DATA' };
  }

  // 寻找加速度峰值（投掷动作的特征）
  let peakAccel = 0;
  let peakIndex = -1;

  for (let i = 0; i < accelHistory.length; i++) {
    const a = accelHistory[i];
    const magnitude = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    if (magnitude > peakAccel) {
      peakAccel = magnitude;
      peakIndex = i;
    }
  }

  // 检查峰值是否在合理范围
  if (peakAccel < SENSOR_CONFIG.THRESHOLDS.THROW_MIN_ACCEL) {
    return { valid: false, reason: 'ACCEL_TOO_LOW', peakAccel };
  }

  if (peakAccel > SENSOR_CONFIG.THRESHOLDS.THROW_MAX_ACCEL) {
    return { valid: false, reason: 'ACCEL_TOO_HIGH', peakAccel };
  }

  // 检查投掷曲线是否平滑（作弊的投掷曲线通常不平滑）
  const smoothed = isMotionSmooth(accelHistory, peakIndex);

  return {
    valid: true,
    peakAccel,
    peakIndex,
    smoothed,
    confidence: calculateThrowConfidence(peakAccel, smoothed),
  };
}

/**
 * 检查动作曲线是否平滑
 */
function isMotionSmooth(accelHistory, peakIndex) {
  // 计算加速度变化的方差
  const changes = [];
  for (let i = 1; i < accelHistory.length; i++) {
    const prev = accelHistory[i - 1];
    const curr = accelHistory[i];
    const dx = Math.abs(curr.x - prev.x);
    const dy = Math.abs(curr.y - prev.y);
    const dz = Math.abs(curr.z - prev.z);
    changes.push(dx + dy + dz);
  }

  // 计算方差
  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const variance = changes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / changes.length;

  // 平滑的动作方差较小
  return variance < 100; // 经验阈值
}

/**
 * 计算投掷置信度
 */
function calculateThrowConfidence(peakAccel, smoothed) {
  let confidence = 50; // 基础置信度

  // 峰值在理想范围内增加置信度
  if (peakAccel >= 15 && peakAccel <= 40) {
    confidence += 30;
  } else if (peakAccel >= 10 && peakAccel <= 60) {
    confidence += 15;
  }

  // 平滑增加置信度
  if (smoothed) {
    confidence += 20;
  }

  return Math.min(100, confidence);
}

// ============================================================
// 核心验证类
// ============================================================

class ARSensorValidator {
  constructor(options = {}) {
    this.secret = options.secret || process.env.AR_SENSOR_SECRET || 'default-ar-secret';
    this.redis = getRedis();
  }

  /**
   * 验证传感器数据完整性
   */
  async validateSensorData(userId, sensorData) {
    const result = {
      valid: true,
      integrityScore: 100,
      anomalies: [],
      riskLevel: 'low',
      requiresRevalidation: false,
    };

    try {
      // 1. 验证签名
      const signatureValid = this.validateSignature(sensorData);
      if (!signatureValid) {
        result.valid = false;
        result.integrityScore -= 50;
        result.anomalies.push({ type: 'INVALID_SIGNATURE', severity: 'critical' });
        metrics.signatureValidations.inc({ valid: 'false', reason: 'invalid' });
      } else {
        metrics.signatureValidations.inc({ valid: 'true', reason: 'ok' });
      }

      // 2. 验证时间戳
      const timestampValid = this.validateTimestamp(sensorData.timestamp);
      if (!timestampValid) {
        result.integrityScore -= 30;
        result.anomalies.push({ type: 'STALE_TIMESTAMP', severity: 'high' });
      }

      // 3. 验证加速度数据
      const accelResult = this.validateAcceleration(sensorData.accelerometer);
      if (!accelResult.valid) {
        result.integrityScore -= accelResult.penalty;
        result.anomalies.push(...accelResult.anomalies);
      }

      // 4. 验证陀螺仪数据
      const gyroResult = this.validateGyroscope(sensorData.gyroscope);
      if (!gyroResult.valid) {
        result.integrityScore -= gyroResult.penalty;
        result.anomalies.push(...gyroResult.anomalies);
      }

      // 5. 验证位置一致性
      const locationResult = await this.validateLocationConsistency(userId, sensorData);
      if (!locationResult.valid) {
        result.integrityScore -= locationResult.penalty;
        result.anomalies.push(...locationResult.anomalies);
      }

      // 6. 验证设备指纹
      const deviceResult = await this.validateDeviceFingerprint(userId, sensorData.deviceFingerprint);
      if (!deviceResult.valid) {
        result.integrityScore -= deviceResult.penalty;
        result.anomalies.push(...deviceResult.anomalies);
      }

      // 7. 验证AR会话上下文
      const sessionResult = await this.validateARSession(userId, sensorData);
      if (!sessionResult.valid) {
        result.integrityScore -= sessionResult.penalty;
        result.anomalies.push(...sessionResult.anomalies);
      }

      // 计算最终风险等级
      result.riskLevel = this.calculateRiskLevel(result.integrityScore, result.anomalies);
      result.valid = result.integrityScore >= 60;

      // 确定是否需要重新验证
      if (result.integrityScore < 80 || result.anomalies.some(a => a.severity === 'critical')) {
        result.requiresRevalidation = true;
      }

      // 记录指标
      metrics.sensorValidationsTotal.inc({
        result: result.valid ? 'valid' : 'invalid',
        risk_level: result.riskLevel,
      });
      metrics.sensorDataScore.observe(result.integrityScore);

      // 记录异常
      for (const anomaly of result.anomalies) {
        metrics.arSessionAnomalies.inc({
          anomaly_type: anomaly.type,
          severity: anomaly.severity,
        });
      }

      return result;
    } catch (err) {
      logger.error({ err, userId }, 'Sensor data validation failed');
      return {
        valid: false,
        integrityScore: 0,
        anomalies: [{ type: 'VALIDATION_ERROR', severity: 'critical' }],
        riskLevel: 'critical',
        requiresRevalidation: true,
        error: err.message,
      };
    }
  }

  /**
   * 验证数据签名
   */
  validateSignature(sensorData) {
    const { signature, timestamp, deviceId, nonce } = sensorData;

    if (!signature || !timestamp || !deviceId) {
      return false;
    }

    // 构建签名字符串
    const payload = JSON.stringify({
      timestamp,
      deviceId,
      nonce,
    });

    return verifySensorSignature(payload, signature, this.secret);
  }

  /**
   * 验证时间戳是否在有效窗口内
   */
  validateTimestamp(timestamp) {
    const now = Date.now();
    const diff = Math.abs(now - timestamp);
    return diff < SENSOR_CONFIG.SIGNATURE_WINDOW;
  }

  /**
   * 验证加速度数据
   */
  validateAcceleration(accelData) {
    const result = { valid: true, anomalies: [], penalty: 0 };

    if (!accelData || !Array.isArray(accelData) || accelData.length === 0) {
      result.valid = false;
      result.anomalies.push({ type: 'MISSING_ACCEL_DATA', severity: 'high' });
      result.penalty = 30;
      return result;
    }

    // 计算加速度变化率
    const rate = calculateAccelerationRate(accelData);
    if (rate > SENSOR_CONFIG.THRESHOLDS.ACCELERATION_RATE) {
      result.valid = false;
      result.anomalies.push({
        type: 'ACCELERATION_RATE_ANOMALY',
        severity: 'high',
        value: rate,
        threshold: SENSOR_CONFIG.THRESHOLDS.ACCELERATION_RATE,
      });
      result.penalty += 20;
    }

    // 检查数据连续性（缺失数据可能表示作弊）
    const gaps = this.detectDataGaps(accelData);
    if (gaps.length > 0) {
      result.anomalies.push({
        type: 'ACCEL_DATA_GAPS',
        severity: 'medium',
        count: gaps.length,
      });
      result.penalty += 10;
    }

    return result;
  }

  /**
   * 验证陀螺仪数据
   */
  validateGyroscope(gyroData) {
    const result = { valid: true, anomalies: [], penalty: 0 };

    if (!gyroData || !Array.isArray(gyroData) || gyroData.length === 0) {
      // 陀螺仪数据可选，但如果存在需验证
      return result;
    }

    // 计算旋转率
    const rate = calculateGyroRate(gyroData);
    if (rate > SENSOR_CONFIG.THRESHOLDS.GYRO_RATE) {
      result.valid = false;
      result.anomalies.push({
        type: 'GYRO_RATE_ANOMALY',
        severity: 'medium',
        value: rate,
        threshold: SENSOR_CONFIG.THRESHOLDS.GYRO_RATE,
      });
      result.penalty = 15;
    }

    return result;
  }

  /**
   * 验证位置一致性
   */
  async validateLocationConsistency(userId, sensorData) {
    const result = { valid: true, anomalies: [], penalty: 0 };

    const { gpsLocation, estimatedLocation } = sensorData;

    if (!gpsLocation) {
      result.anomalies.push({ type: 'MISSING_GPS_LOCATION', severity: 'high' });
      result.penalty = 25;
      return result;
    }

    // 如果有传感器估计位置，计算偏差
    if (estimatedLocation) {
      const deviation = calculatePositionDeviation(gpsLocation, estimatedLocation);
      if (deviation > SENSOR_CONFIG.THRESHOLDS.POSITION_DEVIATION) {
        result.valid = false;
        result.anomalies.push({
          type: 'POSITION_DEVIATION_ANOMALY',
          severity: 'critical',
          value: deviation,
          threshold: SENSOR_CONFIG.THRESHOLDS.POSITION_DEVIATION,
        });
        result.penalty = 40;
      }
    }

    // 检查GPS与历史位置的一致性
    const historyKey = `ar:sensor:location:${userId}`;
    const history = await getJSON(historyKey) || [];

    if (history.length > 0) {
      const lastLocation = history[history.length - 1];
      const timeDiff = (Date.now() - lastLocation.timestamp) / 1000;
      const distance = calculatePositionDeviation(gpsLocation, lastLocation);
      const speed = timeDiff > 0 ? distance / timeDiff : 0;

      // 检查速度异常（结合anti-cheat.js的逻辑）
      if (speed > 50) { // 超过50m/s（约180km/h）
        result.anomalies.push({
          type: 'LOCATION_SPEED_ANOMALY',
          severity: 'high',
          speed,
        });
        result.penalty += 20;
      }
    }

    // 更新位置历史
    history.push({ ...gpsLocation, timestamp: Date.now() });
    await setJSON(historyKey, history.slice(-20), 3600);

    return result;
  }

  /**
   * 验证设备指纹
   */
  async validateDeviceFingerprint(userId, fingerprint) {
    const result = { valid: true, anomalies: [], penalty: 0 };

    if (!fingerprint) {
      result.anomalies.push({ type: 'MISSING_DEVICE_FINGERPRINT', severity: 'medium' });
      result.penalty = 15;
      return result;
    }

    // 获取历史设备指纹
    const deviceKey = `ar:sensor:device:${userId}`;
    const knownFingerprint = await getJSON(deviceKey);

    if (knownFingerprint) {
      // 检查设备特征变化
      const changes = this.detectDeviceChanges(knownFingerprint, fingerprint);
      if (changes.length > 0) {
        result.anomalies.push({
          type: 'DEVICE_FINGERPRINT_CHANGED',
          severity: 'medium',
          changes,
        });
        result.penalty += 10;
      }
    }

    // 更新设备指纹
    await setJSON(deviceKey, fingerprint, 86400 * 30); // 30天

    return result;
  }

  /**
   * 验证AR会话上下文
   */
  async validateARSession(userId, sensorData) {
    const result = { valid: true, anomalies: [], penalty: 0 };

    const { arSessionId, arStartTime, arEndTime, pokemonId } = sensorData;

    if (!arSessionId) {
      // 非AR会话，跳过验证
      return result;
    }

    // 验证会话持续时间
    if (arStartTime && arEndTime) {
      const duration = (arEndTime - arStartTime) / 1000;
      if (duration < SENSOR_CONFIG.THRESHOLDS.AR_MIN_DURATION) {
        result.anomalies.push({
          type: 'AR_SESSION_TOO_SHORT',
          severity: 'high',
          duration,
        });
        result.penalty += 20;
      }
    }

    // 获取会话状态
    const sessionKey = `ar:session:${arSessionId}`;
    const session = await getJSON(sessionKey);

    if (session) {
      // 检查会话是否已过期
      if (session.expired) {
        result.anomalies.push({
          type: 'AR_SESSION_EXPIRED',
          severity: 'critical',
        });
        result.penalty += 30;
      }

      // 检查会话是否已被标记异常
      if (session.flagged) {
        result.anomalies.push({
          type: 'AR_SESSION_FLAGGED',
          severity: 'high',
          reason: session.flagReason,
        });
        result.penalty += 25;
      }
    }

    return result;
  }

  /**
   * 检测数据间隙
   */
  detectDataGaps(data) {
    const gaps = [];
    const maxGapMs = 1000; // 最大允许1秒间隙

    for (let i = 1; i < data.length; i++) {
      const diff = data[i].timestamp - data[i - 1].timestamp;
      if (diff > maxGapMs) {
        gaps.push({ index: i, duration: diff });
      }
    }

    return gaps;
  }

  /**
   * 检测设备特征变化
   */
  detectDeviceChanges(oldFingerprint, newFingerprint) {
    const changes = [];

    for (const feature of SENSOR_CONFIG.DEVICE_SIGNATURE_FEATURES) {
      if (oldFingerprint[feature] !== newFingerprint[feature]) {
        changes.push({
          feature,
          oldValue: oldFingerprint[feature],
          newValue: newFingerprint[feature],
        });
      }
    }

    return changes;
  }

  /**
   * 计算风险等级
   */
  calculateRiskLevel(integrityScore, anomalies) {
    const hasCritical = anomalies.some(a => a.severity === 'critical');
    const hasHigh = anomalies.some(a => a.severity === 'high');

    if (integrityScore < 40 || hasCritical) return 'critical';
    if (integrityScore < 60 || hasHigh) return 'high';
    if (integrityScore < 80 || anomalies.length > 2) return 'medium';
    return 'low';
  }

  /**
   * 触发强制重新验证
   */
  async triggerForcedRevalidation(userId, reason) {
    const revalidationKey = `ar:revalidation:${userId}`;
    const token = crypto.randomBytes(32).toString('hex');

    await setJSON(revalidationKey, {
      token,
      reason,
      timestamp: Date.now(),
      attempts: 0,
    }, 300); // 5分钟有效

    metrics.forcedRevalidationTotal.inc({ trigger_reason: reason });

    logger.info({ userId, reason, token }, 'Forced revalidation triggered');

    return {
      required: true,
      token,
      reason,
      expiresIn: 300,
    };
  }

  /**
   * 验证投掷动作
   */
  async validateThrowAction(userId, throwData) {
    const { accelHistory, timestamp, pokemonId } = throwData;

    // 分析投掷动作
    const analysis = analyzeThrowMotion(accelHistory);

    if (!analysis.valid) {
      // 触发重新验证
      const revalidation = await this.triggerForcedRevalidation(
        userId,
        `THROW_ANOMALY:${analysis.reason}`
      );

      return {
        valid: false,
        analysis,
        revalidation,
      };
    }

    // 记录投掷数据用于后续分析
    const throwKey = `ar:throw:${userId}:${timestamp}`;
    await setJSON(throwKey, {
      accelHistory,
      pokemonId,
      analysis,
      timestamp,
    }, 86400); // 1天

    return {
      valid: true,
      analysis,
      confidence: analysis.confidence,
    };
  }
}

// ============================================================
// Express 中间件
// ============================================================

/**
 * AR传感器验证中间件
 */
function validateARSensors(options = {}) {
  const validator = new ARSensorValidator(options);

  return async (req, res, next) => {
    const userId = req.user?.sub;
    if (!userId) {
      return next();
    }

    const sensorData = req.body.sensorData || req.body;
    
    // 如果没有传感器数据，跳过验证
    if (!sensorData.accelerometer && !sensorData.gyroscope) {
      return next();
    }

    try {
      const result = await validator.validateSensorData(userId, sensorData);

      // 将验证结果附加到请求对象
      req.arValidation = result;

      // 如果验证失败，返回错误
      if (!result.valid) {
        return res.status(403).json({
          code: 7001,
          message: 'AR传感器验证失败',
          data: {
            integrityScore: result.integrityScore,
            anomalies: result.anomalies.map(a => a.type),
            requiresRevalidation: result.requiresRevalidation,
          },
        });
      }

      // 如果需要重新验证，返回警告
      if (result.requiresRevalidation) {
        res.setHeader('X-AR-Revalidation-Required', 'true');
      }

      next();
    } catch (err) {
      logger.error({ err, userId }, 'AR sensor validation error');
      next(); // 错误时不阻止请求
    }
  };
}

/**
 * AR投掷验证中间件
 */
function validateARThrow(options = {}) {
  const validator = new ARSensorValidator(options);

  return async (req, res, next) => {
    const userId = req.user?.sub;
    if (!userId) {
      return next();
    }

    const { accelHistory, timestamp, pokemonId } = req.body;

    if (!accelHistory || !Array.isArray(accelHistory)) {
      return res.status(400).json({
        code: 7002,
        message: '缺少投掷加速度数据',
      });
    }

    try {
      const result = await validator.validateThrowAction(userId, {
        accelHistory,
        timestamp: timestamp || Date.now(),
        pokemonId,
      });

      req.throwValidation = result;

      if (!result.valid) {
        return res.status(403).json({
          code: 7003,
          message: '投掷动作验证失败',
          data: {
            reason: result.analysis.reason,
            revalidation: result.revalidation,
          },
        });
      }

      next();
    } catch (err) {
      logger.error({ err, userId }, 'AR throw validation error');
      next();
    }
  };
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  ARSensorValidator,
  validateARSensors,
  validateARThrow,
  verifySensorSignature,
  calculateAccelerationRate,
  calculateGyroRate,
  calculatePositionDeviation,
  analyzeThrowMotion,
  SENSOR_CONFIG,
  metrics,
};