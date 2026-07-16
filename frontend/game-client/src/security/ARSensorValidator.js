/**
 * ARSensorValidator - AR 传感器数据验证器
 * 
 * 验证 AR 模式下传感器数据的真实性，检测模拟器和虚拟传感器注入
 * 
 * 功能：
 * - 陀螺仪/加速度计数据一致性校验
 * - 摄像头流完整性验证
 * - GPS 坐标与 AR 环境一致性检测
 * - 传感器行为特征建模
 * 
 * @module frontend/game-client/src/security/ARSensorValidator
 */

class ARSensorValidator {
  constructor(config = {}) {
    this.config = {
      // 传感器采样配置
      sensorSampleRate: config.sensorSampleRate || 60, // Hz
      sensorWindowSize: config.sensorSampleRate || 300, // 5秒窗口
      
      // 阈值配置
      gyroMaxVariance: config.gyroMaxVariance || 2.0, // rad/s
      accelMaxVariance: config.accelMaxVariance || 5.0, // m/s²
      gravityTolerance: config.gravityTolerance || 0.3, // m/s²
      
      // GPS 配置
      gpsMaxSpeed: config.gpsMaxSpeed || 50, // m/s (合理的人类移动速度)
      gpsMaxDrift: config.gpsMaxDrift || 100, // meters
      
      // 行为模型
      humanMotionMinFreq: config.humanMotionMinFreq || 0.5, // Hz
      humanMotionMaxFreq: config.humanMotionMaxFreq || 10, // Hz
      
      ...config
    };

    // 传感器数据缓冲区
    this.sensorBuffer = {
      gyroscope: [],
      accelerometer: [],
      magnetometer: [],
      timestamps: []
    };

    // 状态
    this.state = {
      initialized: false,
      calibrationComplete: false,
      lastValidationTime: 0,
      totalValidations: 0,
      failedValidations: 0
    };

    // 校准数据
    this.calibration = {
      gyroBias: { x: 0, y: 0, z: 0 },
      accelBias: { x: 0, y: 0, z: 0 },
      gravityMagnitude: 9.81
    };

    // GPS 历史
    this.gpsHistory = [];
    this.maxGpsHistory = 20;

    // AR 环境状态
    this.arEnvironment = {
      trackingState: 'NOT_TRACKING',
      cameraAvailable: false,
      surfaceDetected: false,
      lastFrameTime: 0
    };

    // 行为特征分析器
    this.behaviorAnalyzer = new MotionBehaviorAnalyzer(this.config);
  }

  /**
   * 初始化传感器验证器
   */
  async init() {
    if (this.state.initialized) {
      return { success: true };
    }

    try {
      // 检测传感器可用性
      const sensorsAvailable = await this.checkSensorsAvailable();
      if (!sensorsAvailable) {
        throw new Error('Required sensors not available');
      }

      // 启动传感器监听
      await this.startSensorListeners();

      // 执行校准
      await this.performCalibration();

      this.state.initialized = true;

      return {
        success: true,
        sensors: sensorsAvailable,
        calibration: this.calibration
      };
    } catch (error) {
      console.error('[ARSensorValidator] Init failed:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 检测传感器可用性
   */
  async checkSensorsAvailable() {
    const sensors = {
      gyroscope: false,
      accelerometer: false,
      magnetometer: false,
      camera: false,
      geolocation: false
    };

    // 检测陀螺仪
    if ('Gyroscope' in window) {
      try {
        const gyro = new Gyroscope({ frequency: 60 });
        await new Promise((resolve, reject) => {
          gyro.addEventListener('reading', () => {
            sensors.gyroscope = true;
            gyro.stop();
            resolve();
          });
          gyro.addEventListener('error', reject);
          gyro.start();
          setTimeout(() => reject(new Error('Timeout')), 2000);
        });
      } catch (e) {
        sensors.gyroscope = false;
      }
    }

    // 检测加速度计
    if ('Accelerometer' in window) {
      try {
        const accel = new Accelerometer({ frequency: 60 });
        await new Promise((resolve, reject) => {
          accel.addEventListener('reading', () => {
            sensors.accelerometer = true;
            accel.stop();
            resolve();
          });
          accel.addEventListener('error', reject);
          accel.start();
          setTimeout(() => reject(new Error('Timeout')), 2000);
        });
      } catch (e) {
        sensors.accelerometer = false;
      }
    }

    // 检测磁力计
    if ('Magnetometer' in window) {
      try {
        const mag = new Magnetometer({ frequency: 60 });
        await new Promise((resolve, reject) => {
          mag.addEventListener('reading', () => {
            sensors.magnetometer = true;
            mag.stop();
            resolve();
          });
          mag.addEventListener('error', reject);
          mag.start();
          setTimeout(() => reject(new Error('Timeout')), 2000);
        });
      } catch (e) {
        sensors.magnetometer = false;
      }
    }

    // 检测摄像头
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      sensors.camera = true;
      stream.getTracks().forEach(track => track.stop());
    } catch (e) {
      sensors.camera = false;
    }

    // 检测地理位置
    if ('geolocation' in navigator) {
      sensors.geolocation = true;
    }

    return sensors;
  }

  /**
   * 启动传感器监听
   */
  async startSensorListeners() {
    // 陀螺仪
    if ('Gyroscope' in window) {
      this.gyroscope = new Gyroscope({ frequency: this.config.sensorSampleRate });
      this.gyroscope.addEventListener('reading', () => {
        this.onGyroscopeData({
          x: this.gyroscope.x,
          y: this.gyroscope.y,
          z: this.gyroscope.z,
          timestamp: Date.now()
        });
      });
      this.gyroscope.start();
    }

    // 加速度计
    if ('Accelerometer' in window) {
      this.accelerometer = new Accelerometer({ frequency: this.config.sensorSampleRate });
      this.accelerometer.addEventListener('reading', () => {
        this.onAccelerometerData({
          x: this.accelerometer.x,
          y: this.accelerometer.y,
          z: this.accelerometer.z,
          timestamp: Date.now()
        });
      });
      this.accelerometer.start();
    }

    // 磁力计
    if ('Magnetometer' in window) {
      this.magnetometer = new Magnetometer({ frequency: this.config.sensorSampleRate });
      this.magnetometer.addEventListener('reading', () => {
        this.onMagnetometerData({
          x: this.magnetometer.x,
          y: this.magnetometer.y,
          z: this.magnetometer.z,
          timestamp: Date.now()
        });
      });
      this.magnetometer.start();
    }
  }

  /**
   * 执行传感器校准
   */
  async performCalibration() {
    console.log('[ARSensorValidator] Starting calibration...');

    const calibrationSamples = 100;
    const gyroSamples = [];
    const accelSamples = [];

    return new Promise((resolve) => {
      const checkComplete = () => {
        if (gyroSamples.length >= calibrationSamples && 
            accelSamples.length >= calibrationSamples) {
          // 计算陀螺仪偏置
          this.calibration.gyroBias = {
            x: average(gyroSamples.map(s => s.x)),
            y: average(gyroSamples.map(s => s.y)),
            z: average(gyroSamples.map(s => s.z))
          };

          // 计算加速度计偏置和重力
          this.calibration.accelBias = {
            x: average(accelSamples.map(s => s.x)),
            y: average(accelSamples.map(s => s.y)),
            z: average(accelSamples.map(s => s.z)) - this.calibration.gravityMagnitude
          };

          this.state.calibrationComplete = true;
          console.log('[ARSensorValidator] Calibration complete:', this.calibration);
          resolve();
        }
      };

      // 临时监听器收集校准数据
      this.calibrationGyroListener = (data) => {
        if (gyroSamples.length < calibrationSamples) {
          gyroSamples.push(data);
          checkComplete();
        }
      };

      this.calibrationAccelListener = (data) => {
        if (accelSamples.length < calibrationSamples) {
          accelSamples.push(data);
          checkComplete();
        }
      };
    });
  }

  /**
   * 处理陀螺仪数据
   */
  onGyroscopeData(data) {
    this.sensorBuffer.gyroscope.push(data);
    this.sensorBuffer.timestamps.push(data.timestamp);

    // 限制缓冲区大小
    if (this.sensorBuffer.gyroscope.length > this.config.sensorWindowSize) {
      this.sensorBuffer.gyroscope.shift();
      this.sensorBuffer.timestamps.shift();
    }

    // 调用校准监听器
    if (this.calibrationGyroListener) {
      this.calibrationGyroListener(data);
    }
  }

  /**
   * 处理加速度计数据
   */
  onAccelerometerData(data) {
    this.sensorBuffer.accelerometer.push(data);

    if (this.sensorBuffer.accelerometer.length > this.config.sensorWindowSize) {
      this.sensorBuffer.accelerometer.shift();
    }

    if (this.calibrationAccelListener) {
      this.calibrationAccelListener(data);
    }
  }

  /**
   * 处理磁力计数据
   */
  onMagnetometerData(data) {
    this.sensorBuffer.magnetometer.push(data);

    if (this.sensorBuffer.magnetometer.length > this.config.sensorWindowSize) {
      this.sensorBuffer.magnetometer.shift();
    }
  }

  /**
   * 更新 GPS 数据
   */
  updateGpsData(position) {
    const gpsData = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      altitude: position.coords.altitude,
      accuracy: position.coords.accuracy,
      speed: position.coords.speed || 0,
      timestamp: position.timestamp
    };

    this.gpsHistory.push(gpsData);
    if (this.gpsHistory.length > this.maxGpsHistory) {
      this.gpsHistory.shift();
    }
  }

  /**
   * 更新 AR 环境状态
   */
  updateAREnvironment(state) {
    this.arEnvironment = {
      ...this.arEnvironment,
      ...state,
      lastFrameTime: Date.now()
    };
  }

  /**
   * 验证传感器数据完整性
   */
  async validateSensorIntegrity() {
    const result = {
      isValid: true,
      riskLevel: 'LOW',
      issues: [],
      scores: {}
    };

    // 1. 验证陀螺仪数据
    const gyroResult = this.validateGyroscopeData();
    result.scores.gyroscope = gyroResult.score;
    if (!gyroResult.valid) {
      result.isValid = false;
      result.issues.push(...gyroResult.issues);
      if (gyroResult.riskLevel === 'HIGH') {
        result.riskLevel = 'HIGH';
      } else if (result.riskLevel !== 'HIGH') {
        result.riskLevel = 'MEDIUM';
      }
    }

    // 2. 验证加速度计数据
    const accelResult = this.validateAccelerometerData();
    result.scores.accelerometer = accelResult.score;
    if (!accelResult.valid) {
      result.isValid = false;
      result.issues.push(...accelResult.issues);
      if (accelResult.riskLevel === 'HIGH') {
        result.riskLevel = 'HIGH';
      } else if (result.riskLevel !== 'HIGH') {
        result.riskLevel = 'MEDIUM';
      }
    }

    // 3. 验证 GPS 一致性
    const gpsResult = this.validateGpsConsistency();
    result.scores.gps = gpsResult.score;
    if (!gpsResult.valid) {
      result.isValid = false;
      result.issues.push(...gpsResult.issues);
    }

    // 4. 行为特征分析
    const behaviorResult = this.behaviorAnalyzer.analyze(this.sensorBuffer);
    result.scores.behavior = behaviorResult.score;
    if (!behaviorResult.valid) {
      result.issues.push(...behaviorResult.issues);
      if (behaviorResult.riskLevel === 'HIGH') {
        result.riskLevel = 'HIGH';
      }
    }

    // 5. AR 环境验证
    const arResult = this.validateAREnvironment();
    result.scores.arEnvironment = arResult.score;
    if (!arResult.valid) {
      result.isValid = false;
      result.issues.push(...arResult.issues);
    }

    // 更新统计
    this.state.totalValidations++;
    if (!result.isValid) {
      this.state.failedValidations++;
    }
    this.state.lastValidationTime = Date.now();

    return result;
  }

  /**
   * 验证陀螺仪数据
   */
  validateGyroscopeData() {
    const result = { valid: true, score: 100, issues: [], riskLevel: 'LOW' };

    if (this.sensorBuffer.gyroscope.length < 10) {
      return result; // 数据不足，跳过验证
    }

    const gyroData = this.sensorBuffer.gyroscope;
    
    // 计算方差
    const variance = {
      x: variance(gyroData.map(d => d.x - this.calibration.gyroBias.x)),
      y: variance(gyroData.map(d => d.y - this.calibration.gyroBias.y)),
      z: variance(gyroData.map(d => d.z - this.calibration.gyroBias.z))
    };

    const totalVariance = variance.x + variance.y + variance.z;

    // 检查异常低的方差（可能是模拟器）
    if (totalVariance < 0.001) {
      result.valid = false;
      result.score = 30;
      result.issues.push('Gyroscope variance too low - possible simulator');
      result.riskLevel = 'HIGH';
    }
    // 检查异常高的方差（可能是数据注入）
    else if (totalVariance > this.config.gyroMaxVariance ** 2 * 3) {
      result.valid = false;
      result.score = 50;
      result.issues.push('Gyroscope variance abnormally high');
      result.riskLevel = 'MEDIUM';
    }

    // 检查数据规律性（模拟器通常产生完美的周期数据）
    const entropy = this.calculateDataEntropy(gyroData);
    if (entropy < 0.5) {
      result.valid = false;
      result.score = Math.min(result.score, 40);
      result.issues.push('Gyroscope data too regular - possible injection');
      result.riskLevel = 'HIGH';
    }

    return result;
  }

  /**
   * 验证加速度计数据
   */
  validateAccelerometerData() {
    const result = { valid: true, score: 100, issues: [], riskLevel: 'LOW' };

    if (this.sensorBuffer.accelerometer.length < 10) {
      return result;
    }

    const accelData = this.sensorBuffer.accelerometer;

    // 检查重力分量
    const gravityMagnitude = Math.sqrt(
      average(accelData.map(d => d.x ** 2)) +
      average(accelData.map(d => d.y ** 2)) +
      average(accelData.map(d => d.z ** 2))
    );

    const gravityDeviation = Math.abs(gravityMagnitude - 9.81);
    if (gravityDeviation > this.config.gravityTolerance) {
      result.valid = false;
      result.score = 60;
      result.issues.push(`Gravity magnitude deviation: ${gravityDeviation.toFixed(3)}`);
      result.riskLevel = 'MEDIUM';
    }

    // 检查方差
    const variance = {
      x: variance(accelData.map(d => d.x)),
      y: variance(accelData.map(d => d.y)),
      z: variance(accelData.map(d => d.z))
    };

    const totalVariance = variance.x + variance.y + variance.z;

    // 模拟器检测：方差过低
    if (totalVariance < 0.01) {
      result.valid = false;
      result.score = 30;
      result.issues.push('Accelerometer variance too low - possible simulator');
      result.riskLevel = 'HIGH';
    }

    // 数据注入检测：方差异常高
    if (totalVariance > this.config.accelMaxVariance ** 2 * 3) {
      result.valid = false;
      result.score = 50;
      result.issues.push('Accelerometer variance abnormally high');
      result.riskLevel = 'MEDIUM';
    }

    return result;
  }

  /**
   * 验证 GPS 一致性
   */
  validateGpsConsistency() {
    const result = { valid: true, score: 100, issues: [] };

    if (this.gpsHistory.length < 2) {
      return result;
    }

    const recent = this.gpsHistory.slice(-5);

    // 检查速度异常
    for (let i = 1; i < recent.length; i++) {
      const distance = this.calculateDistance(
        recent[i - 1].latitude, recent[i - 1].longitude,
        recent[i].latitude, recent[i].longitude
      );
      const timeDiff = (recent[i].timestamp - recent[i - 1].timestamp) / 1000;
      const speed = distance / timeDiff;

      if (speed > this.config.gpsMaxSpeed) {
        result.valid = false;
        result.score = 30;
        result.issues.push(`GPS speed anomaly: ${speed.toFixed(2)} m/s`);
      }
    }

    // 检查精度异常
    const avgAccuracy = average(recent.map(g => g.accuracy));
    if (avgAccuracy > 200) {
      result.score = 70;
      result.issues.push('GPS accuracy is poor');
    }

    return result;
  }

  /**
   * 验证 AR 环境
   */
  validateAREnvironment() {
    const result = { valid: true, score: 100, issues: [] };

    // 检查 AR 追踪状态
    if (this.arEnvironment.trackingState === 'NOT_TRACKING') {
      result.score = 50;
      result.issues.push('AR tracking not active');
    }

    // 检查摄像头可用性
    if (!this.arEnvironment.cameraAvailable) {
      result.valid = false;
      result.score = 20;
      result.issues.push('Camera not available in AR mode');
    }

    // 检查帧更新频率
    const frameInterval = Date.now() - this.arEnvironment.lastFrameTime;
    if (frameInterval > 5000 && this.arEnvironment.lastFrameTime > 0) {
      result.valid = false;
      result.score = 40;
      result.issues.push('AR frame update stalled');
    }

    return result;
  }

  /**
   * 计算数据熵值（用于检测规律性）
   */
  calculateDataEntropy(data) {
    if (data.length < 10) return 1;

    const values = data.map(d => d.x + d.y + d.z);
    const mean = average(values);
    const stdDev = Math.sqrt(variance(values));
    
    if (stdDev === 0) return 0;

    // 使用近似熵计算
    let sum = 0;
    for (let i = 0; i < values.length - 1; i++) {
      const diff = Math.abs(values[i] - values[i + 1]);
      const normalized = diff / stdDev;
      sum += Math.log(normalized + 1);
    }
    
    return sum / (values.length - 1);
  }

  /**
   * 计算两点间距离（Haversine 公式）
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // 地球半径（米）
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  /**
   * 生成验证报告
   */
  generateValidationReport() {
    return {
      timestamp: Date.now(),
      state: this.state,
      calibration: this.calibration,
      sensorBufferSizes: {
        gyroscope: this.sensorBuffer.gyroscope.length,
        accelerometer: this.sensorBuffer.accelerometer.length,
        magnetometer: this.sensorBuffer.magnetometer.length
      },
      gpsHistorySize: this.gpsHistory.length,
      arEnvironment: this.arEnvironment,
      failureRate: this.state.totalValidations > 0 
        ? this.state.failedValidations / this.state.totalValidations 
        : 0
    };
  }

  /**
   * 清理资源
   */
  cleanup() {
    if (this.gyroscope) {
      this.gyroscope.stop();
    }
    if (this.accelerometer) {
      this.accelerometer.stop();
    }
    if (this.magnetometer) {
      this.magnetometer.stop();
    }
    
    this.sensorBuffer = {
      gyroscope: [],
      accelerometer: [],
      magnetometer: [],
      timestamps: []
    };
  }
}

/**
 * 运动行为分析器
 */
class MotionBehaviorAnalyzer {
  constructor(config) {
    this.config = config;
    
    // 正常人类运动特征
    this.humanMotionProfile = {
      // 频率范围（手持设备自然抖动）
      frequencyRange: [0.5, 10], // Hz
      // 典型加速度范围
      accelRange: [0.1, 2.0], // m/s²
      // 方向变化率
      directionChangeRate: [0.01, 0.5] // rad/s
    };
  }

  /**
   * 分析运动行为特征
   */
  analyze(sensorBuffer) {
    const result = { valid: true, score: 100, issues: [], riskLevel: 'LOW' };

    if (sensorBuffer.accelerometer.length < 30) {
      return result;
    }

    const accelData = sensorBuffer.accelerometer;

    // 1. 频率分析（FFT）
    const frequencies = this.performFFT(accelData);
    const dominantFreq = this.getDominantFrequency(frequencies);

    if (dominantFreq < this.humanMotionProfile.frequencyRange[0] ||
        dominantFreq > this.humanMotionProfile.frequencyRange[1]) {
      result.valid = false;
      result.score = 50;
      result.issues.push(`Motion frequency ${dominantFreq.toFixed(2)}Hz outside human range`);
      result.riskLevel = 'MEDIUM';
    }

    // 2. 运动平滑度检查
    const smoothness = this.calculateMotionSmoothness(accelData);
    if (smoothness < 0.3) {
      result.valid = false;
      result.score = 40;
      result.issues.push('Motion too smooth - possible automated input');
      result.riskLevel = 'HIGH';
    }

    // 3. 方向变化分析
    const directionChangeRate = this.calculateDirectionChangeRate(accelData);
    if (directionChangeRate < this.humanMotionProfile.directionChangeRate[0]) {
      result.valid = false;
      result.score = 45;
      result.issues.push('Direction changes too infrequent - possible spoofing');
      result.riskLevel = 'MEDIUM';
    }

    return result;
  }

  /**
   * 简化的 FFT 实现
   */
  performFFT(data) {
    const n = data.length;
    const frequencies = [];

    // 使用 DFT 简化实现
    for (let k = 0; k < n / 2; k++) {
      let real = 0, imag = 0;
      for (let t = 0; t < n; t++) {
        const angle = 2 * Math.PI * t * k / n;
        const magnitude = Math.sqrt(data[t].x ** 2 + data[t].y ** 2 + data[t].z ** 2);
        real += magnitude * Math.cos(angle);
        imag -= magnitude * Math.sin(angle);
      }
      frequencies.push({
        freq: k * this.config.sensorSampleRate / n,
        magnitude: Math.sqrt(real ** 2 + imag ** 2) / n
      });
    }

    return frequencies;
  }

  /**
   * 获取主频率
   */
  getDominantFrequency(frequencies) {
    let maxMag = 0;
    let dominantFreq = 0;

    for (const f of frequencies) {
      if (f.magnitude > maxMag && f.freq > 0.1) {
        maxMag = f.magnitude;
        dominantFreq = f.freq;
      }
    }

    return dominantFreq;
  }

  /**
   * 计算运动平滑度
   */
  calculateMotionSmoothness(data) {
    if (data.length < 3) return 0.5;

    let jerkSum = 0;
    for (let i = 2; i < data.length; i++) {
      const accel1 = Math.sqrt(data[i - 2].x ** 2 + data[i - 2].y ** 2 + data[i - 2].z ** 2);
      const accel2 = Math.sqrt(data[i - 1].x ** 2 + data[i - 1].y ** 2 + data[i - 1].z ** 2);
      const accel3 = Math.sqrt(data[i].x ** 2 + data[i].y ** 2 + data[i].z ** 2);

      const jerk = Math.abs(accel3 - 2 * accel2 + accel1);
      jerkSum += jerk;
    }

    // 归一化
    const avgJerk = jerkSum / (data.length - 2);
    
    // 人类运动通常有微小的抖动，jerk 不会为 0
    // 模拟器/脚本产生的数据 jerk 会非常小或完全平滑
    return Math.min(1, avgJerk * 10);
  }

  /**
   * 计算方向变化率
   */
  calculateDirectionChangeRate(data) {
    if (data.length < 10) return 0.5;

    let totalChange = 0;
    for (let i = 1; i < data.length; i++) {
      const angle1 = Math.atan2(data[i - 1].y, data[i - 1].x);
      const angle2 = Math.atan2(data[i].y, data[i].x);
      const change = Math.abs(angle2 - angle1);
      totalChange += Math.min(change, 2 * Math.PI - change); // 处理角度环绕
    }

    return totalChange / (data.length - 1);
  }
}

// 辅助函数
function average(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function variance(arr) {
  if (arr.length === 0) return 0;
  const avg = average(arr);
  return arr.reduce((sum, val) => sum + (val - avg) ** 2, 0) / arr.length;
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ARSensorValidator, MotionBehaviorAnalyzer };
} else if (typeof window !== 'undefined') {
  window.ARSensorValidator = ARSensorValidator;
  window.MotionBehaviorAnalyzer = MotionBehaviorAnalyzer;
}
