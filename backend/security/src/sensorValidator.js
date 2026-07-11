/**
 * 传感器验证引擎
 * 用于验证 AR 捕获模式下传感器数据的真实性
 * 
 * REQ-00521: 游戏 AR 增强现实捕获模式防作弊与安全防护系统
 */

'use strict';

const { logger, metrics } = require('../../shared/logging');

/**
 * 传感器数据验证器
 */
class SensorValidator {
  constructor(config = {}) {
    this.config = {
      // 平滑度阈值（模拟数据通常 > 0.95）
      smoothnessThreshold: config.smoothnessThreshold || 0.95,
      // 最小噪声阈值
      minNoiseThreshold: config.minNoiseThreshold || 0.001,
      // 最大角速度限制（rad/s）
      maxAngularVelocity: config.maxAngularVelocity || 50,
      // 重力加速度标准值
      gravityStandard: config.gravityStandard || 9.8,
      // 重力加速度允许误差
      gravityTolerance: config.gravityTolerance || 0.5,
      // 静止状态最大方差
      maxStationaryVariance: config.maxStationaryVariance || 0.1,
      ...config
    };
    
    this.registerMetrics();
  }
  
  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    if (metrics && metrics.counter) {
      metrics.counter('sensor_validation_total', 'Total sensor validations', ['result', 'type']);
      metrics.counter('sensor_anomaly_detected_total', 'Sensor anomalies detected', ['anomaly_type']);
    }
  }
  
  /**
   * 验证陀螺仪数据真实性
   * @param {Array} data - 陀螺仪数据数组 [{timestamp, x, y, z, angularVelocity}]
   * @returns {Object} 验证结果
   */
  validateGyroscope(data) {
    const anomalies = [];
    
    if (!data || data.length < 2) {
      return {
        isValid: false,
        anomalies: [{ type: 'insufficient_data', count: data?.length || 0 }],
        confidence: 0
      };
    }
    
    // 1. 检测数据平滑度（模拟数据通常过于平滑）
    const smoothness = this.calculateSmoothness(data);
    if (smoothness > this.config.smoothnessThreshold) {
      anomalies.push({ type: 'too_smooth', value: smoothness });
      this.recordAnomaly('too_smooth');
    }
    
    // 2. 检测噪声特征（真实传感器有自然噪声）
    const noise = this.calculateNoise(data);
    if (noise < this.config.minNoiseThreshold) {
      anomalies.push({ type: 'insufficient_noise', value: noise });
      this.recordAnomaly('insufficient_noise');
    }
    
    // 3. 检测数据连续性
    const gaps = this.detectGaps(data);
    if (gaps.length > 0) {
      anomalies.push({ type: 'data_gaps', count: gaps.length, positions: gaps });
      this.recordAnomaly('data_gaps');
    }
    
    // 4. 物理规律验证（角速度限制）
    const maxAngularVelocity = Math.max(...data.map(d => 
      Math.abs(d.angularVelocity || Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z))
    ));
    if (maxAngularVelocity > this.config.maxAngularVelocity) {
      anomalies.push({ type: 'unrealistic_velocity', value: maxAngularVelocity });
      this.recordAnomaly('unrealistic_velocity');
    }
    
    // 5. 检测零值模式（模拟器特征）
    const zeroCount = data.filter(d => d.x === 0 && d.y === 0 && d.z === 0).length;
    if (zeroCount > data.length * 0.3) {
      anomalies.push({ type: 'excessive_zeros', ratio: zeroCount / data.length });
      this.recordAnomaly('excessive_zeros');
    }
    
    const isValid = anomalies.length === 0;
    const confidence = Math.max(0, 1 - (anomalies.length * 0.2));
    
    this.recordValidation(isValid, 'gyroscope');
    
    return {
      isValid,
      anomalies,
      confidence,
      metrics: {
        smoothness,
        noise,
        maxAngularVelocity,
        dataPoints: data.length
      }
    };
  }
  
  /**
   * 验证加速度计数据
   * @param {Array} data - 加速度计数据数组 [{timestamp, x, y, z, state?}]
   * @returns {Object} 验证结果
   */
  validateAccelerometer(data) {
    const anomalies = [];
    
    if (!data || data.length < 2) {
      return {
        isValid: false,
        anomalies: [{ type: 'insufficient_data', count: data?.length || 0 }],
        confidence: 0
      };
    }
    
    // 1. 重力加速度检测（真实设备应始终有约 9.8 m/s²）
    const avgMagnitude = this.calculateAverageMagnitude(data);
    if (Math.abs(avgMagnitude - this.config.gravityStandard) > this.config.gravityTolerance) {
      anomalies.push({ type: 'invalid_gravity', value: avgMagnitude, expected: this.config.gravityStandard });
      this.recordAnomaly('invalid_gravity');
    }
    
    // 2. 数据一致性（静止状态数据应稳定）
    const stationaryData = data.filter(d => d.state === 'stationary');
    if (stationaryData.length > 10) {
      const variance = this.calculateVariance(stationaryData);
      if (variance > this.config.maxStationaryVariance) {
        anomalies.push({ type: 'unstable_stationary', variance });
        this.recordAnomaly('unstable_stationary');
      }
    }
    
    // 3. 检测数据范围异常
    const maxMagnitude = Math.max(...data.map(d => 
      Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z)
    ));
    if (maxMagnitude > 100) { // 异常大的加速度值
      anomalies.push({ type: 'extreme_acceleration', value: maxMagnitude });
      this.recordAnomaly('extreme_acceleration');
    }
    
    // 4. 检测方向变化合理性
    const directionChanges = this.detectDirectionChanges(data);
    if (directionChanges.rate > 50) { // 每秒超过 50 次方向变化
      anomalies.push({ type: 'excessive_direction_changes', rate: directionChanges.rate });
      this.recordAnomaly('excessive_direction_changes');
    }
    
    const isValid = anomalies.length === 0;
    const confidence = Math.max(0, 1 - (anomalies.length * 0.25));
    
    this.recordValidation(isValid, 'accelerometer');
    
    return {
      isValid,
      anomalies,
      confidence,
      metrics: {
        avgMagnitude,
        maxMagnitude,
        directionChangeRate: directionChanges.rate,
        dataPoints: data.length
      }
    };
  }
  
  /**
   * 验证磁力计数据
   * @param {Array} data - 磁力计数据数组 [{timestamp, x, y, z}]
   * @returns {Object} 验证结果
   */
  validateMagnetometer(data) {
    const anomalies = [];
    
    if (!data || data.length < 2) {
      return {
        isValid: false,
        anomalies: [{ type: 'insufficient_data', count: data?.length || 0 }],
        confidence: 0
      };
    }
    
    // 1. 检测磁场强度合理性（地球磁场约 25-65 μT）
    const magnitudes = data.map(d => Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z));
    const avgMagnitude = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;
    
    if (avgMagnitude < 20 || avgMagnitude > 100) {
      anomalies.push({ type: 'invalid_magnetic_field', value: avgMagnitude });
      this.recordAnomaly('invalid_magnetic_field');
    }
    
    // 2. 检测磁场稳定性（正常环境下磁场应相对稳定）
    const variance = this.calculateMagnitudeVariance(magnitudes);
    if (variance > 100) { // 异常波动
      anomalies.push({ type: 'unstable_magnetic_field', variance });
      this.recordAnomaly('unstable_magnetic_field');
    }
    
    const isValid = anomalies.length === 0;
    const confidence = Math.max(0, 1 - (anomalies.length * 0.3));
    
    this.recordValidation(isValid, 'magnetometer');
    
    return {
      isValid,
      anomalies,
      confidence,
      metrics: {
        avgMagnitude,
        variance,
        dataPoints: data.length
      }
    };
  }
  
  /**
   * 综合验证所有传感器数据
   * @param {Object} sensorData - {gyroscope, accelerometer, magnetometer}
   * @returns {Object} 综合验证结果
   */
  validateAll(sensorData) {
    const results = {
      gyroscope: null,
      accelerometer: null,
      magnetometer: null
    };
    
    if (sensorData.gyroscope) {
      results.gyroscope = this.validateGyroscope(sensorData.gyroscope);
    }
    
    if (sensorData.accelerometer) {
      results.accelerometer = this.validateAccelerometer(sensorData.accelerometer);
    }
    
    if (sensorData.magnetometer) {
      results.magnetometer = this.validateMagnetometer(sensorData.magnetometer);
    }
    
    // 计算综合置信度
    const validCount = Object.values(results).filter(r => r?.isValid).length;
    const totalCount = Object.values(results).filter(r => r !== null).length;
    
    // 综合评分
    let overallScore = 0;
    const weights = {
      gyroscope: 0.4,
      accelerometer: 0.4,
      magnetometer: 0.2
    };
    
    for (const [type, result] of Object.entries(results)) {
      if (result) {
        overallScore += (result.isValid ? 1 : 0) * weights[type];
      }
    }
    
    return {
      results,
      overallValid: validCount === totalCount,
      overallScore,
      riskLevel: this.calculateRiskLevel(overallScore),
      summary: {
        validCount,
        totalCount,
        anomalyCount: Object.values(results).reduce((sum, r) => sum + (r?.anomalies?.length || 0), 0)
      }
    };
  }
  
  /**
   * 计算数据平滑度
   */
  calculateSmoothness(data) {
    if (data.length < 3) return 0;
    
    let sumSlopeChanges = 0;
    for (let i = 2; i < data.length; i++) {
      const slope1 = this.calculateSlope(data[i - 2], data[i - 1]);
      const slope2 = this.calculateSlope(data[i - 1], data[i]);
      sumSlopeChanges += Math.abs(slope2 - slope1);
    }
    
    // 归一化到 0-1 范围，值越大越平滑
    return 1 / (1 + sumSlopeChanges / data.length);
  }
  
  /**
   * 计算噪声水平
   */
  calculateNoise(data) {
    if (data.length < 2) return 0;
    
    const magnitudes = data.map(d => Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z));
    const mean = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;
    const variance = magnitudes.reduce((sum, m) => sum + Math.pow(m - mean, 2), 0) / magnitudes.length;
    
    return Math.sqrt(variance);
  }
  
  /**
   * 检测数据间隙
   */
  detectGaps(data) {
    const gaps = [];
    const expectedInterval = this.calculateExpectedInterval(data);
    
    for (let i = 1; i < data.length; i++) {
      const interval = data[i].timestamp - data[i - 1].timestamp;
      if (interval > expectedInterval * 3) {
        gaps.push({
          position: i,
          gapMs: interval,
          expectedMs: expectedInterval
        });
      }
    }
    
    return gaps;
  }
  
  /**
   * 计算平均幅值
   */
  calculateAverageMagnitude(data) {
    const magnitudes = data.map(d => Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z));
    return magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;
  }
  
  /**
   * 计算方差
   */
  calculateVariance(data) {
    const magnitudes = data.map(d => Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z));
    const mean = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;
    return magnitudes.reduce((sum, m) => sum + Math.pow(m - mean, 2), 0) / magnitudes.length;
  }
  
  /**
   * 计算幅值方差
   */
  calculateMagnitudeVariance(magnitudes) {
    const mean = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;
    return magnitudes.reduce((sum, m) => sum + Math.pow(m - mean, 2), 0) / magnitudes.length;
  }
  
  /**
   * 检测方向变化
   */
  detectDirectionChanges(data) {
    if (data.length < 2) return { count: 0, rate: 0 };
    
    let changes = 0;
    for (let i = 1; i < data.length; i++) {
      const dot = data[i - 1].x * data[i].x + data[i - 1].y * data[i].y + data[i - 1].z * data[i].z;
      const mag1 = Math.sqrt(data[i - 1].x ** 2 + data[i - 1].y ** 2 + data[i - 1].z ** 2);
      const mag2 = Math.sqrt(data[i].x ** 2 + data[i].y ** 2 + data[i].z ** 2);
      
      if (mag1 > 0 && mag2 > 0) {
        const cosAngle = dot / (mag1 * mag2);
        // 方向反转（角度 > 90°）
        if (cosAngle < 0) {
          changes++;
        }
      }
    }
    
    const duration = (data[data.length - 1].timestamp - data[0].timestamp) / 1000;
    const rate = duration > 0 ? changes / duration : 0;
    
    return { count: changes, rate };
  }
  
  /**
   * 计算斜率
   */
  calculateSlope(p1, p2) {
    const dt = (p2.timestamp - p1.timestamp) / 1000;
    if (dt === 0) return 0;
    
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dz = p2.z - p1.z;
    
    return Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
  }
  
  /**
   * 计算期望间隔
   */
  calculateExpectedInterval(data) {
    if (data.length < 2) return 100;
    
    const intervals = [];
    for (let i = 1; i < data.length; i++) {
      intervals.push(data[i].timestamp - data[i - 1].timestamp);
    }
    
    intervals.sort((a, b) => a - b);
    return intervals[Math.floor(intervals.length / 2)];
  }
  
  /**
   * 计算风险等级
   */
  calculateRiskLevel(score) {
    if (score >= 0.8) return 'low';
    if (score >= 0.6) return 'medium';
    if (score >= 0.4) return 'high';
    return 'critical';
  }
  
  /**
   * 记录验证结果
   */
  recordValidation(isValid, type) {
    if (metrics && metrics.inc) {
      metrics.inc('sensor_validation_total', { result: isValid ? 'valid' : 'invalid', type });
    }
  }
  
  /**
   * 记录异常
   */
  recordAnomaly(type) {
    if (metrics && metrics.inc) {
      metrics.inc('sensor_anomaly_detected_total', { anomaly_type: type });
    }
    logger.warn('Sensor anomaly detected', { anomalyType: type });
  }
}

module.exports = SensorValidator;
