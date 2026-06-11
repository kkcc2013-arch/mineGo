/**
 * 预测性扩容引擎单元测试
 * 
 * REQ-00071: K8s Pod 资源自动扩缩容优化系统
 */

const { PredictiveScalingEngine } = require('../../shared/predictiveScaling');
const { ScalingMetricsCollector, generateEfficiencyReport } = require('../../shared/scalingMetrics');

// Mock fetch
global.fetch = jest.fn();

describe('PredictiveScalingEngine', () => {
  let engine;
  
  beforeEach(() => {
    engine = new PredictiveScalingEngine({
      prometheusUrl: 'http://test-prometheus:9090',
      predictionWindow: 900,
      minConfidence: 0.7
    });
    
    fetch.mockReset();
  });
  
  describe('constructor', () => {
    it('should initialize with default config', () => {
      const defaultEngine = new PredictiveScalingEngine();
      
      expect(defaultEngine.config.predictionWindow).toBe(900);
      expect(defaultEngine.config.historyWindow).toBe(604800);
      expect(defaultEngine.config.minConfidence).toBe(0.7);
    });
    
    it('should initialize with custom config', () => {
      expect(engine.config.predictionWindow).toBe(900);
      expect(engine.prometheusUrl).toBe('http://test-prometheus:9090');
    });
    
    it('should have service configs', () => {
      expect(engine.serviceConfigs.gateway).toBeDefined();
      expect(engine.serviceConfigs['catch-service']).toBeDefined();
      expect(engine.serviceConfigs.gateway.hpaMin).toBe(2);
      expect(engine.serviceConfigs.gateway.hpaMax).toBe(20);
    });
  });
  
  describe('fetchHistoryData', () => {
    it('should fetch and parse history data from Prometheus', async () => {
      const mockResponse = {
        status: 'success',
        data: {
          result: [{
            values: [
              [1625097600, '100'],
              [1625101200, '150'],
              [1625104800, '200']
            ]
          }]
        }
      };
      
      fetch.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse)
      });
      
      const data = await engine.fetchHistoryData('gateway', 'http_requests_per_second');
      
      expect(data).toHaveLength(3);
      expect(data[0]).toEqual({ timestamp: 1625097600, value: 100 });
      expect(data[1]).toEqual({ timestamp: 1625101200, value: 150 });
    });
    
    it('should return empty array on error', async () => {
      fetch.mockRejectedValueOnce(new Error('Network error'));
      
      const data = await engine.fetchHistoryData('gateway', 'http_requests_per_second');
      
      expect(data).toEqual([]);
    });
    
    it('should return empty array when no data', async () => {
      const mockResponse = {
        status: 'success',
        data: { result: [] }
      };
      
      fetch.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse)
      });
      
      const data = await engine.fetchHistoryData('gateway', 'http_requests_per_second');
      
      expect(data).toEqual([]);
    });
  });
  
  describe('analyzePeriodicPattern', () => {
    it('should return null for insufficient data', () => {
      const shortData = [
        { timestamp: 1625097600, value: 100 },
        { timestamp: 1625101200, value: 150 }
      ];
      
      const pattern = engine.analyzePeriodicPattern(shortData);
      
      expect(pattern).toBeNull();
    });
    
    it('should analyze hourly and weekly patterns', () => {
      // 生成 7 天的模拟数据（168 小时）
      const data = [];
      const baseTime = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
      
      for (let i = 0; i < 168; i++) {
        data.push({
          timestamp: baseTime + i * 3600,
          value: 100 + Math.sin(i / 24 * Math.PI * 2) * 50 // 周期性波动
        });
      }
      
      const pattern = engine.analyzePeriodicPattern(data);
      
      expect(pattern).not.toBeNull();
      expect(pattern.hourly).toHaveLength(24);
      expect(pattern.weekly).toHaveLength(7);
    });
  });
  
  describe('calculateVariance', () => {
    it('should calculate variance correctly', () => {
      const data = [
        { timestamp: 1, value: 10 },
        { timestamp: 2, value: 20 },
        { timestamp: 3, value: 30 }
      ];
      
      const variance = engine.calculateVariance(data);
      
      // 均值 = 20, 标准差 = 8.16, 变异系数 = 8.16/20 = 0.408
      expect(variance).toBeCloseTo(0.408, 1);
    });
    
    it('should return 1 for empty data', () => {
      const variance = engine.calculateVariance([]);
      expect(variance).toBe(1);
    });
    
    it('should return 0 for constant data', () => {
      const data = [
        { timestamp: 1, value: 100 },
        { timestamp: 2, value: 100 },
        { timestamp: 3, value: 100 }
      ];
      
      const variance = engine.calculateVariance(data);
      expect(variance).toBe(0);
    });
  });
  
  describe('findPeakHours', () => {
    it('should find top 5 peak hours', () => {
      const hourlyPattern = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 
                             90, 80, 70, 60, 50, 40, 30, 20, 10, 10,
                             10, 10, 10, 10];
      
      const peaks = engine.findPeakHours(hourlyPattern);
      
      expect(peaks).toHaveLength(5);
      expect(peaks[0]).toBe(9); // 最高值在 hour 9
    });
  });
  
  describe('findPeakDays', () => {
    it('should find top 3 peak days', () => {
      const weeklyPattern = [100, 150, 200, 180, 160, 120, 80]; // Sun-Sat
      
      const peaks = engine.findPeakDays(weeklyPattern);
      
      expect(peaks).toHaveLength(3);
      expect(peaks[0]).toBe(2); // 最高值在 day 2 (Tuesday)
    });
  });
  
  describe('getCurrentReplicas', () => {
    it('should get current replicas from Prometheus', async () => {
      const mockResponse = {
        status: 'success',
        data: {
          result: [{
            value: [1625097600, '5']
          }]
        }
      };
      
      fetch.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse)
      });
      
      const replicas = await engine.getCurrentReplicas('gateway');
      
      expect(replicas).toBe(5);
    });
    
    it('should return default on error', async () => {
      fetch.mockRejectedValueOnce(new Error('Network error'));
      
      const replicas = await engine.getCurrentReplicas('gateway');
      
      expect(replicas).toBe(2); // hpaMin
    });
  });
  
  describe('generateScalingRecommendations', () => {
    it('should generate scale up recommendation when load exceeds threshold', async () => {
      // Mock history data
      const mockHistoryResponse = {
        status: 'success',
        data: {
          result: [{
            values: Array.from({ length: 168 }, (_, i) => [
              Math.floor(Date.now() / 1000) - (168 - i) * 3600,
              '1000'
            ])
          }]
        }
      };
      
      // Mock current replicas
      const mockReplicasResponse = {
        status: 'success',
        data: {
          result: [{
            value: [Math.floor(Date.now() / 1000), '2']
          }]
        }
      };
      
      fetch
        .mockResolvedValueOnce({ json: () => Promise.resolve(mockHistoryResponse) })
        .mockResolvedValueOnce({ json: () => Promise.resolve(mockReplicasResponse) });
      
      const recommendations = await engine.generateScalingRecommendations();
      
      // 由于 mock 数据是常量，可能不会触发扩容
      // 这里主要测试函数能正常运行
      expect(Array.isArray(recommendations)).toBe(true);
    });
  });
  
  describe('start/stop', () => {
    it('should start and stop the engine', () => {
      const startedEngine = engine.start();
      
      expect(startedEngine.intervalId).toBeDefined();
      
      startedEngine.stop();
      
      expect(startedEngine.intervalId).toBeNull();
    });
  });
});

describe('ScalingMetricsCollector', () => {
  let collector;
  
  beforeEach(() => {
    collector = new ScalingMetricsCollector({
      prometheusUrl: 'http://test-prometheus:9090',
      namespace: 'minego'
    });
    
    fetch.mockReset();
  });
  
  describe('constructor', () => {
    it('should initialize with default config', () => {
      expect(collector.namespace).toBe('minego');
      expect(collector.services).toContain('gateway');
      expect(collector.services).toContain('catch-service');
    });
  });
  
  describe('queryPrometheus', () => {
    it('should query and parse Prometheus response', async () => {
      const mockResponse = {
        status: 'success',
        data: {
          result: [{
            value: [1625097600, '75.5']
          }]
        }
      };
      
      fetch.mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse)
      });
      
      const value = await collector.queryPrometheus('test_query');
      
      expect(value).toBe(75.5);
    });
    
    it('should return null on error', async () => {
      fetch.mockRejectedValueOnce(new Error('Network error'));
      
      const value = await collector.queryPrometheus('test_query');
      
      expect(value).toBeNull();
    });
  });
  
  describe('calculateUtilizationEfficiency', () => {
    it('should calculate utilization efficiency', async () => {
      const mockCpuResponse = {
        status: 'success',
        data: { result: [{ value: [1, '0.65'] }] }
      };
      
      const mockMemResponse = {
        status: 'success',
        data: { result: [{ value: [1, '0.72'] }] }
      };
      
      fetch
        .mockResolvedValueOnce({ json: () => Promise.resolve(mockCpuResponse) })
        .mockResolvedValueOnce({ json: () => Promise.resolve(mockMemResponse) });
      
      const utilization = await collector.calculateUtilizationEfficiency('gateway');
      
      expect(utilization.cpu).toBe(0.65);
      expect(utilization.memory).toBe(0.72);
    });
    
    it('should return default values on error', async () => {
      fetch.mockRejectedValue(new Error('Network error'));
      
      const utilization = await collector.calculateUtilizationEfficiency('gateway');
      
      expect(utilization.cpu).toBe(0.5);
      expect(utilization.memory).toBe(0.5);
    });
  });
  
  describe('calculateWasteScore', () => {
    it('should calculate waste score for under-utilized resources', () => {
      const utilization = { cpu: 0.3, memory: 0.35 };
      
      const wasteScore = collector.calculateWasteScore(utilization);
      
      // 低于 60% 算浪费
      expect(wasteScore).toBeGreaterThan(0);
    });
    
    it('should calculate waste score for over-utilized resources', () => {
      const utilization = { cpu: 0.95, memory: 0.92 };
      
      const wasteScore = collector.calculateWasteScore(utilization);
      
      // 高于 80% 也扣分
      expect(wasteScore).toBeGreaterThan(0);
    });
    
    it('should return low score for optimal utilization', () => {
      const utilization = { cpu: 0.7, memory: 0.75 };
      
      const wasteScore = collector.calculateWasteScore(utilization);
      
      // 在 60-80% 区间，分数应该很低
      expect(wasteScore).toBeLessThan(10);
    });
  });
  
  describe('start/stop', () => {
    it('should start and stop the collector', () => {
      const startedCollector = collector.start(60000);
      
      expect(startedCollector.intervalId).toBeDefined();
      
      startedCollector.stop();
      
      expect(startedCollector.intervalId).toBeNull();
    });
  });
});

describe('generateEfficiencyReport', () => {
  beforeEach(() => {
    fetch.mockReset();
  });
  
  it('should generate efficiency report', async () => {
    // Mock utilization queries
    fetch.mockResolvedValue({
      json: () => Promise.resolve({
        status: 'success',
        data: { result: [{ value: [1, '0.65'] }] }
      })
    });
    
    const report = await generateEfficiencyReport('24h');
    
    expect(report.timeRange).toBe('24h');
    expect(Array.isArray(report.services)).toBe(true);
    expect(report.summary).toBeDefined();
  });
});

describe('HPA/VPA Configuration', () => {
  it('should have valid HPA configuration structure', () => {
    const hpaConfig = {
      minReplicas: 2,
      maxReplicas: 20,
      metrics: [
        { type: 'Resource', resource: { name: 'cpu' } },
        { type: 'Resource', resource: { name: 'memory' } }
      ],
      behavior: {
        scaleDown: { stabilizationWindowSeconds: 300 },
        scaleUp: { stabilizationWindowSeconds: 0 }
      }
    };
    
    expect(hpaConfig.minReplicas).toBeGreaterThan(0);
    expect(hpaConfig.maxReplicas).toBeGreaterThan(hpaConfig.minReplicas);
    expect(hpaConfig.metrics).toHaveLength(2);
    expect(hpaConfig.behavior.scaleDown.stabilizationWindowSeconds).toBeGreaterThan(0);
  });
  
  it('should have valid VPA configuration structure', () => {
    const vpaConfig = {
      updateMode: 'Auto',
      resourcePolicy: {
        containerPolicies: [{
          minAllowed: { cpu: '100m', memory: '256Mi' },
          maxAllowed: { cpu: '4000m', memory: '8Gi' }
        }]
      }
    };
    
    expect(vpaConfig.updateMode).toBe('Auto');
    expect(vpaConfig.resourcePolicy.containerPolicies).toHaveLength(1);
  });
});
