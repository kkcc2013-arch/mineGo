/**
 * SensorValidator 单元测试
 * REQ-00521: 游戏 AR 增强现实捕获模式防作弊与安全防护系统
 */

const assert = require('assert');
const SensorValidator = require('../src/sensorValidator');

describe('SensorValidator', () => {
  let validator;

  beforeEach(() => {
    validator = new SensorValidator();
  });

  describe('validateGyroscope', () => {
    it('should validate realistic gyroscope data', () => {
      const data = {
        readings: generateRealisticGyroscopeData(100)
      };

      const result = validator.validateGyroscope(data);

      assert.ok(result.isValid);
      assert.strictEqual(result.anomalies.length, 0);
      assert.ok(result.confidence > 0.9);
    });

    it('should detect too smooth data (simulated)', () => {
      const data = {
        readings: generateSmoothGyroscopeData(100)
      };

      const result = validator.validateGyroscope(data);

      assert.ok(!result.isValid);
      assert.ok(result.anomalies.some(a => a.type === 'too_smooth'));
    });

    it('should detect insufficient noise', () => {
      const data = {
        readings: generateNoNoiseData(100)
      };

      const result = validator.validateGyroscope(data);

      assert.ok(result.anomalies.some(a => a.type === 'insufficient_noise'));
    });

    it('should detect unrealistic velocity', () => {
      const data = {
        readings: generateHighVelocityData(100)
      };

      const result = validator.validateGyroscope(data);

      assert.ok(result.anomalies.some(a => a.type === 'unrealistic_velocity'));
    });

    it('should detect data gaps', () => {
      const data = {
        readings: generateDataWithGaps(100)
      };

      const result = validator.validateGyroscope(data);

      assert.ok(result.anomalies.some(a => a.type === 'data_gaps'));
    });

    it('should reject insufficient data', () => {
      const data = {
        readings: generateGyroscopeData(5)
      };

      const result = validator.validateGyroscope(data);

      assert.ok(!result.isValid);
      assert.ok(result.anomalies.some(a => a.type === 'insufficient_data'));
    });
  });

  describe('validateAccelerometer', () => {
    it('should validate realistic accelerometer data', () => {
      const data = {
        readings: generateRealisticAccelerometerData(100)
      };

      const result = validator.validateAccelerometer(data);

      assert.ok(result.isValid);
      assert.strictEqual(result.anomalies.length, 0);
    });

    it('should detect invalid gravity', () => {
      const data = {
        readings: generateInvalidGravityData(100)
      };

      const result = validator.validateAccelerometer(data);

      assert.ok(result.anomalies.some(a => a.type === 'invalid_gravity'));
    });

    it('should detect excessive zeros', () => {
      const data = {
        readings: generateZeroData(100)
      };

      const result = validator.validateAccelerometer(data);

      assert.ok(result.anomalies.some(a => a.type === 'excessive_zeros'));
    });

    it('should detect sudden jumps', () => {
      const data = {
        readings: generateJumpData(100)
      };

      const result = validator.validateAccelerometer(data);

      assert.ok(result.anomalies.some(a => a.type === 'sudden_jumps'));
    });

    it('should detect unstable stationary state', () => {
      const data = {
        readings: generateUnstableStationaryData(100),
        state: 'stationary'
      };

      const result = validator.validateAccelerometer(data);

      assert.ok(result.anomalies.some(a => a.type === 'unstable_stationary'));
    });
  });

  describe('validateMagnetometer', () => {
    it('should validate normal magnetometer data', () => {
      const data = {
        readings: generateNormalMagnetometerData(20)
      };

      const result = validator.validateMagnetometer(data);

      assert.ok(result.isValid);
    });

    it('should detect abnormal magnetic field', () => {
      const data = {
        readings: generateAbnormalMagnetometerData(20)
      };

      const result = validator.validateMagnetometer(data);

      assert.ok(result.anomalies.some(a => a.type === 'abnormal_magnetic_field'));
    });

    it('should detect sudden changes', () => {
      const data = {
        readings: generateSuddenChangeMagnetometerData(20)
      };

      const result = validator.validateMagnetometer(data);

      assert.ok(result.anomalies.some(a => a.type === 'sudden_change'));
    });
  });

  describe('validate', () => {
    it('should validate all sensor types', async () => {
      const sensorData = {
        gyroscope: { readings: generateRealisticGyroscopeData(100) },
        accelerometer: { readings: generateRealisticAccelerometerData(100) },
        magnetometer: { readings: generateNormalMagnetometerData(20) }
      };

      const result = await validator.validate(sensorData);

      assert.ok(result.overall.valid);
      assert.ok(result.gyroscope.isValid);
      assert.ok(result.accelerometer.isValid);
      assert.ok(result.magnetometer.isValid);
    });

    it('should detect anomalies in any sensor type', async () => {
      const sensorData = {
        gyroscope: { readings: generateSmoothGyroscopeData(100) },
        accelerometer: { readings: generateRealisticAccelerometerData(100) },
        magnetometer: { readings: generateNormalMagnetometerData(20) }
      };

      const result = await validator.validate(sensorData);

      assert.ok(!result.overall.valid);
      assert.ok(!result.gyroscope.isValid);
    });
  });

  describe('helper functions', () => {
    it('should calculate smoothness correctly', () => {
      const smoothData = [1, 1, 1, 1, 1];
      const noisyData = [1, 2, 3, 2, 1];

      const smoothSmoothness = validator._calculateSmoothness(smoothData);
      const noisySmoothness = validator._calculateSmoothness(noisyData);

      assert.ok(smoothSmoothness > noisySmoothness);
      assert.ok(smoothSmoothness > 0.9);
    });

    it('should calculate noise correctly', () => {
      const noisyData = [1, 2, 3, 2, 1];
      const noise = validator._calculateNoise(noisyData);

      assert.ok(noise > 0);
    });

    it('should detect gaps correctly', () => {
      const readings = [
        { timestamp: 1000 },
        { timestamp: 1100 },
        { timestamp: 1200 },
        { timestamp: 1500 }, // 300ms gap
        { timestamp: 1600 }
      ];

      const gaps = validator._detectGaps(readings, 100);

      assert.strictEqual(gaps.length, 1);
      assert.strictEqual(gaps[0].index, 3);
      assert.strictEqual(gaps[0].gap, 300);
    });

    it('should calculate variance correctly', () => {
      const values = [10, 10, 10, 10];
      const variance = validator._calculateVariance(values);

      assert.strictEqual(variance, 0);
    });
  });
});

// ========== 数据生成辅助函数 ==========

function generateRealisticGyroscopeData(count) {
  const readings = [];
  const baseTime = Date.now();
  
  for (let i = 0; i < count; i++) {
    readings.push({
      x: (Math.random() - 0.5) * 2 + (Math.sin(i * 0.1) * 0.5),
      y: (Math.random() - 0.5) * 2 + (Math.cos(i * 0.1) * 0.3),
      z: (Math.random() - 0.5) * 1 + (Math.sin(i * 0.15) * 0.2),
      timestamp: baseTime + i * 50
    });
  }
  
  return readings;
}

function generateSmoothGyroscopeData(count) {
  const readings = [];
  const baseTime = Date.now();
  
  for (let i = 0; i < count; i++) {
    // 非常平滑的数据（模拟）
    readings.push({
      x: Math.sin(i * 0.01) * 0.1,
      y: Math.cos(i * 0.01) * 0.1,
      z: Math.sin(i * 0.005) * 0.05,
      timestamp: baseTime + i * 50
    });
  }
  
  return readings;
}

function generateNoNoiseData(count) {
  const readings = [];
  const baseTime = Date.now();
  
  for (let i = 0; i < count; i++) {
    // 完全无噪声的数据
    readings.push({
      x: 0.00001,
      y: 0.00001,
      z: 0.00001,
      timestamp: baseTime + i * 50
    });
  }
  
  return readings;
}

function generateHighVelocityData(count) {
  const readings = [];
  const baseTime = Date.now();
  
  for (let i = 0; i < count; i++) {
    readings.push({
      x: 60, // 超过人类极限
      y: 60,
      z: 60,
      timestamp: baseTime + i * 50
    });
  }
  
  return readings;
}

function generateDataWithGaps(count) {
  const readings = [];
  const baseTime = Date.now();
  
  for (let i = 0; i < count; i++) {
    // 每 10 个插入一个大间隙
    const gapMultiplier = i % 10 === 0 && i > 0 ? 10 : 1;
    
    readings.push({
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      z: (Math.random() - 0.5) * 1,
      timestamp: baseTime + i * 50 * gapMultiplier
    });
  }
  
  return readings;
}

function generateGyroscopeData(count) {
  return generateRealisticGyroscopeData(count);
}

function generateRealisticAccelerometerData(count) {
  const readings = [];
  const baseTime = Date.now();
  
  for (let i = 0; i < count; i++) {
    // 真实设备应保持约 9.8 m/s² 的重力加速度
    const gravityX = Math.sin(Math.PI / 4) * 9.8 + (Math.random() - 0.5) * 0.2;
    const gravityY = Math.sin(Math.PI / 4) * 9.8 + (Math.random() - 0.5) * 0.2;
    const gravityZ = Math.cos(Math.PI / 4) * 9.8 + (Math.random() - 0.5) * 0.2;
    
    readings.push({
      x: gravityX,
      y: gravityY,
      z: gravityZ,
      timestamp: baseTime + i * 50
    });
  }
  
  return readings;
}

function generateInvalidGravityData(count) {
  const readings = [];
  const baseTime = Date.now();
  
  for (let i = 0; i < count; i++) {
    // 异常的重力加速度
    readings.push({
      x: 5,
      y: 5,
      z: 5,
      timestamp: baseTime + i * 50
    });
  }
  
  return readings;
}

function generateZeroData(count) {
  const readings = [];
  const baseTime = Date.now();
  
  for (let i = 0; i < count; i++) {
    // 大量零值
    const isZero = Math.random() < 0.3;
    
    readings.push({
      x: isZero ? 0 : (Math.random() - 0.5) * 2,
      y: isZero ? 0 : (Math.random() - 0.5) * 2,
      z: isZero ? 0 : (Math.random() - 0.5) * 1,
      timestamp: baseTime + i * 50
    });
  }
  
  return readings;
}

function generateJumpData(count) {
  const readings = [];
  const baseTime = Date.now();
  
  for (let i = 0; i < count; i++) {
    // 突然跳跃
    const jumpFactor = i % 20 === 0 ? 30 : 1;
    
    readings.push({
      x: (Math.random() - 0.5) * jumpFactor,
      y: (Math.random() - 0.5) * jumpFactor,
      z: (Math.random() - 0.5) * jumpFactor,
      timestamp: baseTime + i * 50
    });
  }
  
  return readings;
}

function generateUnstableStationaryData(count) {
  const readings = [];
  const baseTime = Date.now();
  
  for (let i = 0; i < count; i++) {
    // 静止状态下的不稳定数据
    readings.push({
      x: 9.8 + Math.random() * 2,
      y: 0 + Math.random() * 2,
      z: 0 + Math.random() * 2,
      timestamp: baseTime + i * 50
    });
  }
  
  return readings;
}

function generateNormalMagnetometerData(count) {
  const readings = [];
  const baseTime = Date.now();
  
  for (let i = 0; i < count; i++) {
    // 正常磁场强度（25-65 μT）
    const magnitude = 30 + Math.random() * 20;
    const angle = Math.random() * 2 * Math.PI;
    
    readings.push({
      x: magnitude * Math.cos(angle),
      y: magnitude * Math.sin(angle),
      z: magnitude * 0.5,
      timestamp: baseTime + i * 100
    });
  }
  
  return readings;
}

function generateAbnormalMagnetometerData(count) {
  const readings = [];
  const baseTime = Date.now();
  
  for (let i = 0; i < count; i++) {
    // 异常磁场强度（过低）
    readings.push({
      x: 5,
      y: 5,
      z: 5,
      timestamp: baseTime + i * 100
    });
  }
  
  return readings;
}

function generateSuddenChangeMagnetometerData(count) {
  const readings = [];
  const baseTime = Date.now();
  
  for (let i = 0; i < count; i++) {
    // 突然变化
    const changeFactor = i % 10 === 0 ? 100 : 1;
    
    readings.push({
      x: 30 * changeFactor,
      y: 30 * changeFactor,
      z: 30 * changeFactor,
      timestamp: baseTime + i * 100
    });
  }
  
  return readings;
}