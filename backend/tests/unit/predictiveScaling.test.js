// backend/tests/unit/predictiveScaling.test.js
// 预测性扩容引擎单元测试
'use strict';

const { PredictiveScalingEngine } = require('../../shared/predictiveScaling');

describe('PredictiveScalingEngine', () => {
  let engine;
  
  beforeEach(() => {
    engine = new PredictiveScalingEngine({
      enabled: true,
      predictionWindow: 15 * 60,
      minConfidence: 0.7
    });
  });
  
  describe('constructor', () => {
    test('should initialize with default config', () => {
      expect(engine.config.enabled).toBe(true);
      expect(engine.config.predictionWindow).toBe(15 * 60);
      expect(engine.config.minConfidence).toBe(0.7);
    });
    
    test('should have service configs', () => {
      const configs = engine.getServiceConfigs();
      expect(configs).toHaveProperty('gateway');
      expect(configs).toHaveProperty('catch-service');
      expect(configs).toHaveProperty('location-service');
      expect(configs.gateway.targetPerPod).toBe(1000);
    });
  });
  
  describe('fetchHistoryData', () => {
    test('should generate simulated history data', async () => {
      const data = await engine.fetchHistoryData('gateway', 'http_requests_per_second');
      
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(168); // 7天 * 24小时
      expect(data[0]).toHaveProperty('timestamp');
      expect(data[0]).toHaveProperty('value');
    });
    
    test('should show daily pattern in simulated data', async () => {
      const data = await engine.fetchHistoryData('gateway', 'http_requests_per_second');
      
      // 检查高峰时段（12-14点，18-22点）负载较高
      const peakHours = data.filter(d => {
        const hour = new Date(d.timestamp * 1000).getHours();
        return hour >= 12 && hour <= 14;
      });
      
      const lowHours = data.filter(d => {
        const hour = new Date(d.timestamp * 1000).getHours();
        return hour >= 0 && hour <= 6;
      });
      
      const avgPeak = peakHours.reduce((sum, d) => sum + d.value, 0) / peakHours.length;
      const avgLow = lowHours.reduce((sum, d) => sum + d.value, 0) / lowHours.length;
      
      expect(avgPeak).toBeGreaterThan(avgLow);
    });
  });
  
  describe('analyzePeriodicPattern', () => {
    test('should return null for insufficient data', () => {
      const pattern = engine.analyzePeriodicPattern([]);
      expect(pattern).toBeNull();
    });
    
    test('should analyze pattern from enough data', async () => {
      const data = await engine.fetchHistoryData('gateway', 'http_requests_per_second');
      const pattern = engine.analyzePeriodicPattern(data);
      
      expect(pattern).not.toBeNull();
      expect(pattern).toHaveProperty('hourly');
      expect(pattern).toHaveProperty('weekly');
      expect(pattern.hourly.length).toBe(24);
      expect(pattern.weekly.length).toBe(7);
    });
  });
  
  describe('predictFutureLoad', () => {
    test('should return null for unknown service', async () => {
      const prediction = await engine.predictFutureLoad('unknown-service', 900);
      expect(prediction).toBeNull();
    });
    
    test('should generate prediction for known service', async () => {
      const prediction = await engine.predictFutureLoad('gateway', 900);
      
      expect(prediction).not.toBeNull();
      expect(prediction).toHaveProperty('service', 'gateway');
      expect(prediction).toHaveProperty('predictions');
      expect(prediction).toHaveProperty('confidence');
      expect(prediction).toHaveProperty('pattern');
      expect(Array.isArray(prediction.predictions)).toBe(true);
      expect(prediction.confidence).toBeGreaterThanOrEqual(0);
      expect(prediction.confidence).toBeLessThanOrEqual(1);
    });
    
    test('should predict for specified window', async () => {
      const prediction = await engine.predictFutureLoad('gateway', 900); // 15分钟
      
      // 15分钟 / 60秒 = 约15个数据点
      expect(prediction.predictions.length).toBeGreaterThan(10);
      expect(prediction.predictions.length).toBeLessThanOrEqual(20);
    });
  });
  
  describe('generateScalingRecommendations', () => {
    test('should generate recommendations', async () => {
      const recommendations = await engine.generateScalingRecommendations();
      
      expect(Array.isArray(recommendations)).toBe(true);
    });
    
    test('should include required fields in recommendations', async () => {
      const recommendations = await engine.generateScalingRecommendations();
      
      if (recommendations.length > 0) {
        const rec = recommendations[0];
        expect(rec).toHaveProperty('service');
        expect(rec).toHaveProperty('action');
        expect(rec).toHaveProperty('currentReplicas');
        expect(rec).toHaveProperty('recommendedReplicas');
        expect(rec).toHaveProperty('predictedLoad');
        expect(rec).toHaveProperty('confidence');
        expect(rec).toHaveProperty('reason');
        expect(['scale_up', 'scale_down']).toContain(rec.action);
      }
    });
  });
  
  describe('executePredictiveScaling', () => {
    test('should execute without errors', async () => {
      const results = await engine.executePredictiveScaling(false);
      
      expect(Array.isArray(results)).toBe(true);
    });
    
    test('should return results with status', async () => {
      const results = await engine.executePredictiveScaling(false);
      
      if (results.length > 0) {
        const result = results[0];
        expect(result).toHaveProperty('status');
        expect(['pending_approval', 'executed']).toContain(result.status);
      }
    });
  });
  
  describe('calculateVariance', () => {
    test('should calculate variance correctly', () => {
      const data = [
        { value: 100 },
        { value: 110 },
        { value: 90 },
        { value: 105 },
        { value: 95 }
      ];
      
      const variance = engine.calculateVariance(data);
      expect(variance).toBeGreaterThan(0);
      expect(variance).toBeLessThan(1);
    });
    
    test('should return 1 for empty data', () => {
      const variance = engine.calculateVariance([]);
      expect(variance).toBe(1);
    });
  });
  
  describe('findPeakHours', () => {
    test('should find peak hours', async () => {
      const data = await engine.fetchHistoryData('gateway', 'http_requests_per_second');
      const pattern = engine.analyzePeriodicPattern(data);
      const peakHours = engine.findPeakHours(pattern.hourly);
      
      expect(Array.isArray(peakHours)).toBe(true);
      expect(peakHours.length).toBe(5);
      peakHours.forEach(hour => {
        expect(hour).toBeGreaterThanOrEqual(0);
        expect(hour).toBeLessThan(24);
      });
    });
  });
  
  describe('getStatus', () => {
    test('should return engine status', () => {
      const status = engine.getStatus();
      
      expect(status).toHaveProperty('enabled', true);
      expect(status).toHaveProperty('predictionWindow');
      expect(status).toHaveProperty('minConfidence');
      expect(status).toHaveProperty('servicesCount');
    });
  });
  
  describe('configuration', () => {
    test('should respect disabled flag', async () => {
      const disabledEngine = new PredictiveScalingEngine({ enabled: false });
      
      const recommendations = await disabledEngine.generateScalingRecommendations();
      expect(recommendations).toEqual([]);
    });
    
    test('should use custom config', () => {
      const customEngine = new PredictiveScalingEngine({
        predictionWindow: 30 * 60,
        minConfidence: 0.8
      });
      
      expect(customEngine.config.predictionWindow).toBe(30 * 60);
      expect(customEngine.config.minConfidence).toBe(0.8);
    });
  });
});

describe('Pattern Analysis', () => {
  let engine;
  
  beforeEach(() => {
    engine = new PredictiveScalingEngine();
  });
  
  test('should detect weekend pattern', async () => {
    const data = await engine.fetchHistoryData('gateway', 'http_requests_per_second');
    const pattern = engine.analyzePeriodicPattern(data);
    const peakDays = engine.findPeakDays(pattern.weekly);
    
    // 周末（0=周日，6=周六）应该在高峰日
    expect(peakDays).toBeDefined();
  });
  
  test('should detect hourly pattern', async () => {
    const data = await engine.fetchHistoryData('gateway', 'http_requests_per_second');
    const pattern = engine.analyzePeriodicPattern(data);
    
    // 高峰时段（12-14, 18-22）的负载应该高于其他时段
    const peakHours = [12, 13, 18, 19, 20, 21];
    const offHours = [0, 1, 2, 3, 4, 5];
    
    const avgPeak = peakHours.reduce((sum, h) => sum + pattern.hourly[h], 0) / peakHours.length;
    const avgOff = offHours.reduce((sum, h) => sum + pattern.hourly[h], 0) / offHours.length;
    
    expect(avgPeak).toBeGreaterThan(avgOff);
  });
});

describe('Service Configurations', () => {
  let engine;
  
  beforeEach(() => {
    engine = new PredictiveScalingEngine();
  });
  
  test('should have correct gateway config', () => {
    const config = engine.getServiceConfigs().gateway;
    
    expect(config.hpaMin).toBe(2);
    expect(config.hpaMax).toBe(20);
    expect(config.targetPerPod).toBe(1000);
    expect(config.scaleThreshold).toBe(0.8);
  });
  
  test('should have correct catch-service config', () => {
    const config = engine.getServiceConfigs()['catch-service'];
    
    expect(config.hpaMin).toBe(3);
    expect(config.hpaMax).toBe(30);
    expect(config.targetPerPod).toBe(500);
  });
  
  test('should have all required services', () => {
    const services = Object.keys(engine.getServiceConfigs());
    
    expect(services).toContain('gateway');
    expect(services).toContain('catch-service');
    expect(services).toContain('location-service');
    expect(services).toContain('pokemon-service');
    expect(services).toContain('user-service');
    expect(services).toContain('gym-service');
  });
});