/**
 * SensorValidator - AR 捕获模式传感器数据验证引擎
 * REQ-00521: 游戏 AR 增强现实捕获模式防作弊与安全防护系统
 * 
 * 功能：
 * - 陀螺仪数据真实性验证
 * - 加速度计数据验证
 * - 磁力计数据验证
 * - 传感器数据时序分析
 * - 物理规律验证
 */

const logger = require('../logger');
const metrics = require('../metrics');

class SensorValidator {
  constructor() {
    this.metrics = this._initMetrics();
  }

  /**
   * 初始化 Prometheus 指标
   */
  _initMetrics() {
    return {
      validationsTotal: metrics.registerCounter(
        'sensor_validation_total',
        'Total sensor validations',
        ['sensor_type', 'result']
      ),
      anomaliesDetected: metrics.registerCounter(
        'sensor_anomaly_detected_total',
        'Total sensor anomalies detected',
        ['sensor_type', 'anomaly_type']
      ),
      validationDuration: metrics.registerHistogram(
        'sensor_validation_duration_seconds',
        'Sensor validation duration',
        ['sensor_type']
      )
    };
  }

  /**
   * 验证传感器数据
   * @param {Object} sensorData - 传感器数据包
   * @returns {Object} 验证结果
   */
  async validate(sensorData) {
    const startTime = Date.now();
    const results = {
      overall: { valid: true, score: 100 },
      gyroscope: null,
      accelerometer: null,
      magnetometer: null,
      timing: null
    };

    try {
      // 验证陀螺仪数据
      if (sensorData.gyroscope) {
        results.gyroscope = this.validateGyroscope(sensorData.gyroscope);
        if (!results.gyroscope.isValid) {
          results.overall.valid = false;
          results.overall.score -= 30;
        }
      }

      // 验证加速度计数据
      if (sensorData.accelerometer) {
        results.accelerometer = this.validateAccelerometer(sensorData.accelerometer);
        if (!results.accelerometer.isValid) {
          results.overall.valid = false;
          results.overall.score -= 25;
        }
      }

      // 验证磁力计数据
      if (sensorData.magnetometer) {
        results.magnetometer = this.validateMagnetometer(sensorData.magnetometer);
        if (!results.magnetometer.isValid) {
          results.overall.valid = false;
          results.overall.score -= 15;
        }
      }

      // 验证时序关系
      if (sensorData.timing) {
        results.timing = this.validateTiming(sensorData.timing);
        if (!results.timing.isValid) {
          results.overall.valid = false;
          results.overall.score -= 20;
        }
      }

      results.overall.score = Math.max(0, results.overall.score);

      // 记录指标
      this.metrics.validationsTotal.inc({
        sensor_type: 'all',
        result: results.overall.valid ? 'valid' : 'invalid'
      });

      return results;
    } finally {
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.validationDuration.observe({ sensor_type: 'all' }, duration);
    }
  }

  /**
   * 验证陀螺仪数据真实性
   */
  validateGyroscope(data) {
    const anomalies = [];
    const readings = Array.isArray(data.readings) ? data.readings : [data];

    if (readings.length < 10) {
      anomalies.push({ type: 'insufficient_data', count: readings.length });
      return { isValid: false, anomalies, confidence: 0.5 };
    }

    // 1. 检测数据平滑度（模拟数据通常过于平滑）
    const smoothness = this._calculateSmoothness(readings.map(r => Math.sqrt(
      Math.pow(r.x || 0, 2) + Math.pow(r.y || 0, 2) + Math.pow(r.z || 0, 2)
    )));
    if (smoothness > 0.95) {
      anomalies.push({ type: 'too_smooth', value: smoothness, threshold: 0.95 });
      this.metrics.anomaliesDetected.inc({ sensor_type: 'gyroscope', anomaly_type: 'too_smooth' });
    }

    // 2. 检测噪声特征（真实传感器有自然噪声）
    const noise = this._calculateNoise(readings.map(r => r.x || 0));
    if (noise < 0.0001) {
      anomalies.push({ type: 'insufficient_noise', value: noise, threshold: 0.0001 });
      this.metrics.anomaliesDetected.inc({ sensor_type: 'gyroscope', anomaly_type: 'insufficient_noise' });
    }

    // 3. 检测数据连续性
    const gaps = this._detectGaps(readings);
    if (gaps.length > 0) {
      anomalies.push({ type: 'data_gaps', count: gaps.length, gaps });
      this.metrics.anomaliesDetected.inc({ sensor_type: 'gyroscope', anomaly_type: 'data_gaps' });
    }

    // 4. 物理规律验证（角速度限制）
    const maxAngularVelocity = Math.max(...readings.map(r => 
      Math.abs(r.x || 0) + Math.abs(r.y || 0) + Math.abs(r.z || 0)
    ));
    if (maxAngularVelocity > 50) { // 人类操作极限约 10-20 rad/s
      anomalies.push({ type: 'unrealistic_velocity', value: maxAngularVelocity, threshold: 50 });
      this.metrics.anomaliesDetected.inc({ sensor_type: 'gyroscope', anomaly_type: 'unrealistic_velocity' });
    }

    // 5. 检测静止状态下的异常波动
    if (data.state === 'stationary') {
      const variance = this._calculateVariance(readings.map(r => r.x || 0));
      if (variance > 0.1) {
        anomalies.push({ type: 'unstable_stationary', variance, threshold: 0.1 });
        this.metrics.anomaliesDetected.inc({ sensor_type: 'gyroscope', anomaly_type: 'unstable_stationary' });
      }
    }

    const isValid = anomalies.length === 0;
    const confidence = Math.max(0, 1 - anomalies.length * 0.15);

    this.metrics.validationsTotal.inc({
      sensor_type: 'gyroscope',
      result: isValid ? 'valid' : 'invalid'
    });

    return { isValid, anomalies, confidence };
  }

  /**
   * 验证加速度计数据
   */
  validateAccelerometer(data) {
    const anomalies = [];
    const readings = Array.isArray(data.readings) ? data.readings : [data];

    if (readings.length < 10) {
      anomalies.push({ type: 'insufficient_data', count: readings.length });
      return { isValid: false, anomalies, confidence: 0.5 };
    }

    // 1. 重力加速度检测（真实设备应始终有约 9.8 m/s²）
    const avgMagnitude = this._calculateAverageMagnitude(readings);
    if (Math.abs(avgMagnitude - 9.8) > 0.8) { // 允许 0.8 的误差范围
      anomalies.push({ type: 'invalid_gravity', value: avgMagnitude, expected: 9.8 });
      this.metrics.anomaliesDetected.inc({ sensor_type: 'accelerometer', anomaly_type: 'invalid_gravity' });
    }

    // 2. 数据一致性验证（静止状态数据应稳定）
    if (data.state === 'stationary') {
      const variance = this._calculateVariance(readings.map(r => 
        Math.sqrt(Math.pow(r.x || 0, 2) + Math.pow(r.y || 0, 2) + Math.pow(r.z || 0, 2))
      ));
      if (variance > 0.5) {
        anomalies.push({ type: 'unstable_stationary', variance, threshold: 0.5 });
        this.metrics.anomaliesDetected.inc({ sensor_type: 'accelerometer', anomaly_type: 'unstable_stationary' });
      }
    }

    // 3. 检测零值异常
    const zeroCount = readings.filter(r => 
      (r.x === 0 && r.y === 0 && r.z === 0)
    ).length;
    if (zeroCount > readings.length * 0.1) {
      anomalies.push({ type: 'excessive_zeros', count: zeroCount, ratio: zeroCount / readings.length });
      this.metrics.anomaliesDetected.inc({ sensor_type: 'accelerometer', anomaly_type: 'excessive_zeros' });
    }

    // 4. 检测突变
    const jumps = this._detectJumps(readings, 15); // 15 m/s² 的突变阈值
    if (jumps.length > 0) {
      anomalies.push({ type: 'sudden_jumps', count: jumps.length, jumps: jumps.slice(0, 3) });
      this.metrics.anomaliesDetected.inc({ sensor_type: 'accelerometer', anomaly_type: 'sudden_jumps' });
    }

    // 5. 检测数据频率稳定性
    const timestamps = readings.map(r => r.timestamp).filter(Boolean);
    if (timestamps.length > 1) {
      const frequencyVariance = this._calculateFrequencyVariance(timestamps);
      if (frequencyVariance > 0.5) {
        anomalies.push({ type: 'unstable_frequency', variance: frequencyVariance });
        this.metrics.anomaliesDetected.inc({ sensor_type: 'accelerometer', anomaly_type: 'unstable_frequency' });
      }
    }

    const isValid = anomalies.length === 0;
    const confidence = Math.max(0, 1 - anomalies.length * 0.15);

    this.metrics.validationsTotal.inc({
      sensor_type: 'accelerometer',
      result: isValid ? 'valid' : 'invalid'
    });

    return { isValid, anomalies, confidence };
  }

  /**
   * 验证磁力计数据
   */
  validateMagnetometer(data) {
    const anomalies = [];
    const readings = Array.isArray(data.readings) ? data.readings : [data];

    if (readings.length < 5) {
      // 磁力计数据较少，跳过
      return { isValid: true, anomalies: [], confidence: 1.0 };
    }

    // 1. 检测磁场强度范围（地球磁场约 25-65 μT）
    const magnitudes = readings.map(r => 
      Math.sqrt(Math.pow(r.x || 0, 2) + Math.pow(r.y || 0, 2) + Math.pow(r.z || 0, 2))
    );
    const avgMagnitude = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;
    
    if (avgMagnitude < 20 || avgMagnitude > 100) {
      anomalies.push({ type: 'abnormal_magnetic_field', value: avgMagnitude, range: '20-100' });
      this.metrics.anomaliesDetected.inc({ sensor_type: 'magnetometer', anomaly_type: 'abnormal_magnetic_field' });
    }

    // 2. 检测数据突变（磁场不应剧烈变化）
    const maxJump = Math.max(...this._calculateDeltas(magnitudes));
    if (maxJump > 50) {
      anomalies.push({ type: 'sudden_change', value: maxJump, threshold: 50 });
      this.metrics.anomaliesDetected.inc({ sensor_type: 'magnetometer', anomaly_type: 'sudden_change' });
    }

    const isValid = anomalies.length === 0;
    const confidence = Math.max(0, 1 - anomalies.length * 0.2);

    this.metrics.validationsTotal.inc({
      sensor_type: 'magnetometer',
      result: isValid ? 'valid' : 'invalid'
    });

    return { isValid, anomalies, confidence };
  }

  /**
   * 验证传感器数据时序关系
   */
  validateTiming(timing) {
    const anomalies = [];

    // 1. 检测时间戳合理性
    if (timing.startTimestamp && timing.endTimestamp) {
      const duration = timing.endTimestamp - timing.startTimestamp;
      if (duration < 0) {
        anomalies.push({ type: 'invalid_duration', value: duration });
      }
      if (duration > 300000) { // 超过 5 分钟
        anomalies.push({ type: 'excessive_duration', value: duration, threshold: 300000 });
      }
    }

    // 2. 检测时钟回拨
    if (timing.clockSkew && timing.clockSkew < 0) {
      anomalies.push({ type: 'clock_skew', value: timing.clockSkew });
    }

    // 3. 检测与服务器时间差异
    if (timing.serverTimeDiff) {
      const diff = Math.abs(timing.serverTimeDiff);
      if (diff > 60000) { // 超过 1 分钟
        anomalies.push({ type: 'time_sync_issue', value: diff, threshold: 60000 });
      }
    }

    const isValid = anomalies.length === 0;
    const confidence = Math.max(0, 1 - anomalies.length * 0.2);

    this.metrics.validationsTotal.inc({
      sensor_type: 'timing',
      result: isValid ? 'valid' : 'invalid'
    });

    return { isValid, anomalies, confidence };
  }

  // ========== 辅助计算函数 ==========

  /**
   * 计算数据平滑度
   */
  _calculateSmoothness(values) {
    if (values.length < 2) return 0;
    
    let totalDiff = 0;
    let totalValue = 0;
    
    for (let i = 1; i < values.length; i++) {
      totalDiff += Math.abs(values[i] - values[i-1]);
      totalValue += Math.abs(values[i]);
    }
    
    const avgDiff = totalDiff / (values.length - 1);
    const avgValue = totalValue / (values.length - 1);
    
    if (avgValue === 0) return 0;
    return 1 - (avgDiff / (avgValue * 2));
  }

  /**
   * 计算噪声水平
   */
  _calculateNoise(values) {
    if (values.length < 2) return 0;
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    
    return Math.sqrt(variance);
  }

  /**
   * 检测数据间隙
   */
  _detectGaps(readings, thresholdMs = 100) {
    const gaps = [];
    for (let i = 1; i < readings.length; i++) {
      const prev = readings[i-1].timestamp || readings[i-1].ts;
      const curr = readings[i].timestamp || readings[i].ts;
      if (prev && curr) {
        const diff = curr - prev;
        if (diff > thresholdMs) {
          gaps.push({ index: i, gap: diff });
        }
      }
    }
    return gaps;
  }

  /**
   * 计算方差
   */
  _calculateVariance(values) {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  }

  /**
   * 计算平均幅值
   */
  _calculateAverageMagnitude(readings) {
    const magnitudes = readings.map(r => 
      Math.sqrt(Math.pow(r.x || 0, 2) + Math.pow(r.y || 0, 2) + Math.pow(r.z || 0, 2))
    );
    return magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;
  }

  /**
   * 检测突变
   */
  _detectJumps(readings, threshold) {
    const jumps = [];
    for (let i = 1; i < readings.length; i++) {
      const prevMag = Math.sqrt(
        Math.pow(readings[i-1].x || 0, 2) + 
        Math.pow(readings[i-1].y || 0, 2) + 
        Math.pow(readings[i-1].z || 0, 2)
      );
      const currMag = Math.sqrt(
        Math.pow(readings[i].x || 0, 2) + 
        Math.pow(readings[i].y || 0, 2) + 
        Math.pow(readings[i].z || 0, 2)
      );
      if (Math.abs(currMag - prevMag) > threshold) {
        jumps.push({ index: i, change: Math.abs(currMag - prevMag) });
      }
    }
    return jumps;
  }

  /**
   * 计算时间戳频率方差
   */
  _calculateFrequencyVariance(timestamps) {
    if (timestamps.length < 2) return 0;
    
    const intervals = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i] - timestamps[i-1]);
    }
    
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / intervals.length;
    
    // 归一化
    return Math.sqrt(variance) / mean;
  }

  /**
   * 计算差值序列
   */
  _calculateDeltas(values) {
    const deltas = [];
    for (let i = 1; i < values.length; i++) {
      deltas.push(Math.abs(values[i] - values[i-1]));
    }
    return deltas;
  }
}

module.exports = SensorValidator;
