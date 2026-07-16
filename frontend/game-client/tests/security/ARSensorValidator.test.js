/**
 * ARSensorValidator 单元测试
 */

const { ARSensorValidator, MotionBehaviorAnalyzer } = require('../ARSensorValidator');

describe('ARSensorValidator', () => {
  let validator;

  beforeEach(() => {
    validator = new ARSensorValidator({
      sensorSampleRate: 60,
      sensorWindowSize: 300,
      gyroMaxVariance: 2.0,
      accelMaxVariance: 5.0
    });
  });

  afterEach(() => {
    validator.cleanup();
  });

  describe('Sensor Buffer Management', () => {
    test('should store gyroscope data in buffer', () => {
      const mockData = { x: 0.1, y: 0.2, z: 0.3, timestamp: Date.now() };
      
      validator.onGyroscopeData(mockData);
      
      expect(validator.sensorBuffer.gyroscope.length).toBe(1);
      expect(validator.sensorBuffer.gyroscope[0]).toEqual(mockData);
    });

    test('should store accelerometer data in buffer', () => {
      const mockData = { x: 0.1, y: 0.2, z: 9.8, timestamp: Date.now() };
      
      validator.onAccelerometerData(mockData);
      
      expect(validator.sensorBuffer.accelerometer.length).toBe(1);
      expect(validator.sensorBuffer.accelerometer[0]).toEqual(mockData);
    });

    test('should limit buffer size to window size', () => {
      validator.config.sensorWindowSize = 10;
      
      for (let i = 0; i < 15; i++) {
        validator.onGyroscopeData({ x: i, y: i, z: i, timestamp: Date.now() });
      }
      
      expect(validator.sensorBuffer.gyroscope.length).toBe(10);
    });
  });

  describe('Gyroscope Validation', () => {
    test('should detect low variance as potential simulator', async () => {
      // 模拟恒定数据（模拟器特征）
      for (let i = 0; i < 50; i++) {
        validator.onGyroscopeData({ x: 0.001, y: 0.001, z: 0.001, timestamp: Date.now() });
      }
      
      const result = validator.validateGyroscopeData();
      
      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Gyroscope variance too low - possible simulator');
      expect(result.riskLevel).toBe('HIGH');
    });

    test('should pass normal variance data', async () => {
      // 模拟真实传感器数据（有自然抖动）
      for (let i = 0; i < 50; i++) {
        const noise = (Math.random() - 0.5) * 0.1;
        validator.onGyroscopeData({ 
          x: 0.5 + noise, 
          y: 0.3 + noise, 
          z: 0.2 + noise, 
          timestamp: Date.now() 
        });
      }
      
      const result = validator.validateGyroscopeData();
      
      expect(result.valid).toBe(true);
      expect(result.score).toBeGreaterThan(50);
    });

    test('should detect abnormally high variance', async () => {
      // 模拟异常抖动（可能是数据注入）
      for (let i = 0; i < 50; i++) {
        validator.onGyroscopeData({ 
          x: Math.random() * 10, 
          y: Math.random() * 10, 
          z: Math.random() * 10, 
          timestamp: Date.now() 
        });
      }
      
      const result = validator.validateGyroscopeData();
      
      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Gyroscope variance abnormally high');
    });
  });

  describe('Accelerometer Validation', () => {
    test('should detect gravity deviation', async () => {
      // 模拟重力异常数据
      for (let i = 0; i < 50; i++) {
        validator.onAccelerometerData({ 
          x: 0, 
          y: 0, 
          z: 5.0, // 异常重力值
          timestamp: Date.now() 
        });
      }
      
      const result = validator.validateAccelerometerData();
      
      expect(result.valid).toBe(false);
      expect(result.issues.some(issue => issue.includes('Gravity magnitude deviation'))).toBe(true);
    });

    test('should detect simulator pattern', async () => {
      // 模拟完美恒定数据（模拟器特征）
      for (let i = 0; i < 50; i++) {
        validator.onAccelerometerData({ 
          x: 0.001, 
          y: 0.001, 
          z: 9.81, 
          timestamp: Date.now() 
        });
      }
      
      const result = validator.validateAccelerometerData();
      
      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Accelerometer variance too low - possible simulator');
    });

    test('should pass normal human motion data', async () => {
      // 模拟真实手持设备数据
      for (let i = 0; i < 50; i++) {
        const jitter = Math.sin(i * 0.1) * 0.1 + (Math.random() - 0.5) * 0.05;
        validator.onAccelerometerData({ 
          x: 0.2 + jitter, 
          y: 0.1 + jitter, 
          z: 9.81 + jitter, 
          timestamp: Date.now() 
        });
      }
      
      const result = validator.validateAccelerometerData();
      
      expect(result.valid).toBe(true);
      expect(result.score).toBeGreaterThan(60);
    });
  });

  describe('GPS Validation', () => {
    test('should detect speed anomaly', () => {
      // 添加正常的 GPS 历史
      validator.updateGpsData({
        coords: { latitude: 31.2304, longitude: 121.4737, accuracy: 10 },
        timestamp: Date.now() - 2000
      });
      
      // 添加异常移动的 GPS（瞬间跳跃）
      validator.updateGpsData({
        coords: { latitude: 31.2504, longitude: 121.4737, accuracy: 10 }, // 2.2km 跳跃
        timestamp: Date.now()
      });
      
      const result = validator.validateGpsConsistency();
      
      expect(result.valid).toBe(false);
      expect(result.issues.some(issue => issue.includes('GPS speed anomaly'))).toBe(true);
    });

    test('should pass normal GPS movement', () => {
      // 模拟正常步行速度
      for (let i = 0; i < 5; i++) {
        validator.updateGpsData({
          coords: { 
            latitude: 31.2304 + i * 0.0001, // 约10米/秒
            longitude: 121.4737, 
            accuracy: 10 
          },
          timestamp: Date.now() + i * 1000
        });
      }
      
      const result = validator.validateGpsConsistency();
      
      expect(result.valid).toBe(true);
    });
  });

  describe('AR Environment Validation', () => {
    test('should detect AR tracking not active', () => {
      validator.updateAREnvironment({
        trackingState: 'NOT_TRACKING',
        cameraAvailable: true,
        surfaceDetected: false
      });
      
      const result = validator.validateAREnvironment();
      
      expect(result.issues).toContain('AR tracking not active');
    });

    test('should detect camera not available', () => {
      validator.updateAREnvironment({
        trackingState: 'TRACKING',
        cameraAvailable: false,
        surfaceDetected: true
      });
      
      const result = validator.validateAREnvironment();
      
      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Camera not available in AR mode');
    });

    test('should detect stalled AR frames', () => {
      validator.updateAREnvironment({
        trackingState: 'TRACKING',
        cameraAvailable: true,
        surfaceDetected: true
      });
      
      // 模拟帧停止更新
      validator.arEnvironment.lastFrameTime = Date.now() - 10000;
      
      const result = validator.validateAREnvironment();
      
      expect(result.issues).toContain('AR frame update stalled');
    });
  });

  describe('Integrated Validation', () => {
    test('should return comprehensive validation results', async () => {
      // 准备真实传感器数据
      for (let i = 0; i < 30; i++) {
        const jitter = Math.sin(i * 0.1) * 0.1;
        validator.onGyroscopeData({ 
          x: 0.5 + jitter, 
          y: 0.3 + jitter, 
          z: 0.2 + jitter, 
          timestamp: Date.now() 
        });
        validator.onAccelerometerData({ 
          x: 0.2 + jitter, 
          y: 0.1 + jitter, 
          z: 9.81 + jitter, 
          timestamp: Date.now() 
        });
      }
      
      validator.updateGpsData({
        coords: { latitude: 31.2304, longitude: 121.4737, accuracy: 10 },
        timestamp: Date.now()
      });
      
      validator.updateAREnvironment({
        trackingState: 'TRACKING',
        cameraAvailable: true,
        surfaceDetected: true
      });
      
      const result = await validator.validateSensorIntegrity();
      
      expect(result).toHaveProperty('isValid');
      expect(result).toHaveProperty('riskLevel');
      expect(result).toHaveProperty('scores');
      expect(result.scores).toHaveProperty('gyroscope');
      expect(result.scores).toHaveProperty('accelerometer');
      expect(result.scores).toHaveProperty('gps');
      expect(result.scores).toHaveProperty('behavior');
      expect(result.scores).toHaveProperty('arEnvironment');
    });

    test('should update statistics correctly', async () => {
      const initialTotal = validator.state.totalValidations;
      const initialFailed = validator.state.failedValidations;
      
      // 触发验证
      await validator.validateSensorIntegrity();
      
      expect(validator.state.totalValidations).toBe(initialTotal + 1);
    });
  });

  describe('Report Generation', () => {
    test('should generate valid validation report', () => {
      const report = validator.generateValidationReport();
      
      expect(report).toHaveProperty('timestamp');
      expect(report).toHaveProperty('state');
      expect(report).toHaveProperty('calibration');
      expect(report).toHaveProperty('sensorBufferSizes');
      expect(report).toHaveProperty('failureRate');
    });
  });
});

describe('MotionBehaviorAnalyzer', () => {
  let analyzer;

  beforeEach(() => {
    analyzer = new MotionBehaviorAnalyzer({
      sensorSampleRate: 60
    });
  });

  describe('FFT Analysis', () => {
    test('should perform frequency analysis', () => {
      const mockData = [];
      for (let i = 0; i < 60; i++) {
        mockData.push({
          x: Math.sin(i * 0.1),
          y: Math.cos(i * 0.1),
          z: 0.5,
          timestamp: Date.now() + i * 16
        });
      }
      
      const frequencies = analyzer.performFFT(mockData);
      
      expect(frequencies).toBeInstanceOf(Array);
      expect(frequencies.length).toBe(mockData.length / 2);
      expect(frequencies[0]).toHaveProperty('freq');
      expect(frequencies[0]).toHaveProperty('magnitude');
    });

    test('should identify dominant frequency', () => {
      const frequencies = [
        { freq: 0.5, magnitude: 0.3 },
        { freq: 1.0, magnitude: 0.8 },
        { freq: 1.5, magnitude: 0.2 }
      ];
      
      const dominant = analyzer.getDominantFrequency(frequencies);
      
      expect(dominant).toBe(1.0);
    });
  });

  describe('Motion Smoothness', () => {
    test('should detect overly smooth motion', () => {
      const smoothData = [];
      for (let i = 0; i < 100; i++) {
        // 完美平滑的数据
        smoothData.push({
          x: Math.sin(i * 0.1),
          y: Math.cos(i * 0.1),
          z: 9.81
        });
      }
      
      const smoothness = analyzer.calculateMotionSmoothness(smoothData);
      
      // 过于平滑的数据会有较低的平滑度评分
      expect(smoothness).toBeLessThan(0.5);
    });

    test('should pass natural motion data', () => {
      const naturalData = [];
      for (let i = 0; i < 100; i++) {
        // 有自然抖动的数据
        const jitter = (Math.random() - 0.5) * 0.2;
        naturalData.push({
          x: Math.sin(i * 0.1) + jitter,
          y: Math.cos(i * 0.1) + jitter,
          z: 9.81 + jitter
        });
      }
      
      const smoothness = analyzer.calculateMotionSmoothness(naturalData);
      
      expect(smoothness).toBeGreaterThan(0.3);
    });
  });

  describe('Direction Change Analysis', () => {
    test('should calculate direction change rate', () => {
      const changingData = [];
      for (let i = 0; i < 50; i++) {
        // 随机方向变化
        const angle = Math.random() * Math.PI * 2;
        changingData.push({
          x: Math.cos(angle),
          y: Math.sin(angle),
          z: 9.81
        });
      }
      
      const rate = analyzer.calculateDirectionChangeRate(changingData);
      
      expect(rate).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Integrated Behavior Analysis', () => {
    test('should detect automated motion patterns', () => {
      const sensorBuffer = {
        accelerometer: []
      };
      
      // 模拟自动化脚本产生的完美周期数据
      for (let i = 0; i < 100; i++) {
        sensorBuffer.accelerometer.push({
          x: Math.sin(i * 0.05), // 固定频率
          y: Math.cos(i * 0.05),
          z: 9.81
        });
      }
      
      const result = analyzer.analyze(sensorBuffer);
      
      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('issues');
    });
  });
});
