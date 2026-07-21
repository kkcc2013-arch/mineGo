/**
 * 智能调度器单元测试
 */

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const TrafficAnalyzer = require('../trafficAnalyzer');
const PredictiveScheduler = require('../predictiveScheduler');
const CostPerformanceBalancer = require('../costPerformanceBalancer');

describe('TrafficAnalyzer', function() {
  let analyzer;
  let mockRedisClient;
  let mockDbPool;

  beforeEach(function() {
    mockRedisClient = {
      hgetall: sinon.stub().resolves({
        request_count: '1000',
        avg_response_time: '50',
        active_users: '100',
        error_rate: '0.01'
      }),
      hset: sinon.stub().resolves(),
      quit: sinon.stub().resolves()
    };

    mockDbPool = {
      query: sinon.stub().resolves({ rows: [] }),
      end: sinon.stub().resolves()
    };

    analyzer = new TrafficAnalyzer({
      historyWindow: 3600000,  // 1小时
      predictionWindow: 3600000,
      sampleInterval: 60000
    });
  });

  afterEach(function() {
    sinon.restore();
  });

  describe('initialize', function() {
    it('should initialize successfully', async function() {
      // Mock dependencies
      sinon.stub(analyzer, 'loadHistoricalData').resolves();

      const result = await analyzer.initialize();

      expect(result).to.be.true;
    });

    it('should fail if dependencies unavailable', async function() {
      sinon.stub(analyzer, 'loadHistoricalData').rejects(new Error('DB connection failed'));

      try {
        await analyzer.initialize();
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.equal('DB connection failed');
      }
    });
  });

  describe('collectCurrentTraffic', function() {
    it('should collect current traffic data', async function() {
      analyzer.redisClient = mockRedisClient;

      const traffic = await analyzer.collectCurrentTraffic();

      expect(traffic).to.have.property('timestamp');
      expect(traffic.requestCount).to.equal(1000);
      expect(traffic.responseTime).to.equal(50);
      expect(traffic.activeUsers).to.equal(100);
      expect(traffic.errorRate).to.equal(0.01);
    });

    it('should handle missing data', async function() {
      analyzer.redisClient = {
        hgetall: sinon.stub().resolves({})
      };

      const traffic = await analyzer.collectCurrentTraffic();

      expect(traffic.requestCount).to.equal(0);
      expect(traffic.responseTime).to.equal(0);
    });
  });

  describe('detectHourlyPattern', function() {
    it('should detect hourly traffic pattern', function() {
      // Add mock historical data
      analyzer.historicalData = [
        { timestamp: new Date('2026-07-21T10:00:00Z'), requestCount: 1000 },
        { timestamp: new Date('2026-07-21T10:01:00Z'), requestCount: 1100 },
        { timestamp: new Date('2026-07-21T11:00:00Z'), requestCount: 1200 },
        { timestamp: new Date('2026-07-21T11:01:00Z'), requestCount: 1300 }
      ];

      const pattern = analyzer.detectHourlyPattern();

      expect(pattern).to.be.an('array');
      expect(pattern.length).to.equal(24);
      expect(pattern[10].avgRequests).to.be.greaterThan(0);
      expect(pattern[11].avgRequests).to.be.greaterThan(0);
    });
  });

  describe('calculateConfidence', function() {
    it('should calculate confidence with decay', function() {
      const confidence1 = analyzer.calculateConfidence(0, 10);
      const confidence2 = analyzer.calculateConfidence(5, 10);
      const confidence3 = analyzer.calculateConfidence(10, 10);

      expect(confidence1).to.be.greaterThan(confidence2);
      expect(confidence2).to.be.greaterThan(confidence3);
      expect(confidence3).to.be.at.least(0.5);
    });
  });
});

describe('PredictiveScheduler', function() {
  let scheduler;
  let mockTrafficAnalyzer;

  beforeEach(function() {
    mockTrafficAnalyzer = {
      initialize: sinon.stub().resolves(),
      predictTrafficTrend: sinon.stub().resolves({
        predictions: [
          { timestamp: new Date(Date.now() + 60000), predictedRequests: 1100, confidence: 0.85 },
          { timestamp: new Date(Date.now() + 120000), predictedRequests: 1200, confidence: 0.80 }
        ],
        summary: {
          avgPredictedRequests: 1150,
          maxPredictedRequests: 1200,
          confidence: 0.82
        }
      }),
      collectCurrentTraffic: sinon.stub().resolves({ requestCount: 1000 }),
      getPredictionAccuracy: sinon.stub().resolves(0.87),
      healthCheck: sinon.stub().resolves({ status: 'healthy' }),
      shutdown: sinon.stub().resolves()
    };

    scheduler = new PredictiveScheduler({
      minReplicas: 2,
      maxReplicas: 50,
      scalingCooldown: 300000
    });
    scheduler.trafficAnalyzer = mockTrafficAnalyzer;
  });

  afterEach(function() {
    sinon.restore();
  });

  describe('calculateFutureNeeds', function() {
    it('should calculate future resource needs', function() {
      const prediction = {
        predictions: [
          { timestamp: new Date(Date.now() + 60000), predictedRequests: 2000 },
          { timestamp: new Date(Date.now() + 120000), predictedRequests: 2500 }
        ]
      };

      const needs = scheduler.calculateFutureNeeds(prediction);

      expect(needs).to.have.property('avgReplicas');
      expect(needs).to.have.property('maxReplicas');
      expect(needs.maxReplicas).to.be.at.least(2);  // 至少需要2个副本
    });

    it('should return null for no predictions', function() {
      const needs = scheduler.calculateFutureNeeds({ predictions: [] });
      expect(needs).to.be.null;
    });
  });

  describe('makeScalingDecision', function() {
    it('should decide to scale up when future needs exceed current', function() {
      scheduler.currentReplicas.set('gateway', 2);

      const decision = scheduler.makeScalingDecision({
        maxReplicas: 5,
        avgRequests: 2500,
        maxRequests: 3000,
        confidence: 0.85
      });

      expect(decision.action).to.equal('scale_up');
      expect(decision.targetReplicas).to.be.greaterThan(2);
    });

    it('should decide to scale down when load decreases', function() {
      scheduler.currentReplicas.set('gateway', 10);
      scheduler.trafficAnalyzer.historicalData = [
        { requestCount: 500, timestamp: new Date() }
      ];

      const decision = scheduler.makeScalingDecision({
        maxReplicas: 2,
        avgReplicas: 2,
        avgRequests: 1000,
        maxRequests: 1500,
        confidence: 0.90
      });

      expect(decision.action).to.equal('scale_down');
      expect(decision.targetReplicas).to.be.lessThan(10);
    });

    it('should not scale during cooldown period', function() {
      scheduler.lastScalingAction = {
        action: 'scale_up',
        timestamp: Date.now() - 60000  // 1分钟前
      };

      const decision = scheduler.makeScalingDecision({
        maxReplicas: 10,
        avgRequests: 5000,
        confidence: 0.85
      });

      expect(decision.action).to.equal('none');
      expect(decision.reason).to.equal('cooldown_period');
    });

    it('should not scale with low confidence', function() {
      scheduler.currentReplicas.set('gateway', 2);

      const decision = scheduler.makeScalingDecision({
        maxReplicas: 10,
        avgRequests: 5000,
        confidence: 0.60  // 低置信度
      });

      expect(decision.action).to.equal('none');
      expect(decision.reason).to.include('low_confidence');
    });
  });

  describe('executeScheduling', function() {
    it('should execute scheduling successfully', async function() {
      scheduler.currentReplicas.set('gateway', 2);
      sinon.stub(scheduler, 'executeScalingAction').resolves(true);
      sinon.stub(scheduler, 'recordPrediction').resolves();

      const result = await scheduler.executeScheduling();

      expect(result).to.have.property('action');
      expect(mockTrafficAnalyzer.predictTrafficTrend.called).to.be.true;
    });

    it('should fallback to reactive scaling on prediction failure', async function() {
      mockTrafficAnalyzer.predictTrafficTrend.resolves(null);
      sinon.stub(scheduler, 'reactiveScaling').resolves({ action: 'reactive_scaling' });

      const result = await scheduler.executeScheduling();

      expect(result.action).to.equal('reactive_scaling');
    });
  });
});

describe('CostPerformanceBalancer', function() {
  let balancer;

  beforeEach(function() {
    balancer = new CostPerformanceBalancer({
      instanceTypes: {
        onDemand: { costMultiplier: 1.0, reliability: 0.9999 },
        spot: { costMultiplier: 0.3, reliability: 0.95 },
        reserved: { costMultiplier: 0.6, reliability: 0.9999 }
      }
    });
  });

  describe('calculateOptimalInstanceMix', function() {
    it('should calculate instance mix for critical service', function() {
      const tierConfig = balancer.config.serviceTiers.critical;
      const mix = balancer.calculateOptimalInstanceMix(5000, tierConfig);

      expect(mix.totalInstances).to.be.at.least(5);
      expect(mix.spot).to.equal(0);  // 关键服务不允许Spot
      expect(mix.onDemand + mix.reserved).to.equal(mix.totalInstances);
    });

    it('should calculate instance mix for normal service', function() {
      const tierConfig = balancer.config.serviceTiers.normal;
      const mix = balancer.calculateOptimalInstanceMix(3000, tierConfig);

      expect(mix.totalInstances).to.be.at.least(3);
      expect(mix.spot).to.be.at.most(Math.floor(mix.totalInstances * 0.7));
    });

    it('should adjust spot ratio based on time', function() {
      const tierConfig = balancer.config.serviceTiers.normal;
      
      // Mock current hour
      const originalDate = Date;
      global.Date = class extends Date {
        getHours() { return 14; }  // 14:00 业务高峰期
      };

      const mixPeak = balancer.calculateOptimalInstanceMix(2000, tierConfig);

      global.Date = class extends Date {
        getHours() { return 2; }  // 02:00 非高峰期
      };

      const mixOffPeak = balancer.calculateOptimalInstanceMix(2000, tierConfig);

      // 恢复原始Date
      global.Date = originalDate;

      expect(mixOffPeak.spot).to.be.greaterThan(mixPeak.spot);
    });
  });

  describe('estimateCost', function() {
    it('should estimate total cost correctly', function() {
      const instanceMix = {
        onDemand: 3,
        spot: 2,
        reserved: 1,
        totalInstances: 6
      };

      const cost = balancer.estimateCost(instanceMix);

      expect(cost).to.equal(
        3 * 100 * 1.0 +  // onDemand
        2 * 100 * 0.3 +  // spot
        1 * 100 * 0.6    // reserved
      );
    });
  });

  describe('assessRisk', function() {
    it('should assess high risk for excessive spot ratio', function() {
      const tierConfig = balancer.config.serviceTiers.important;
      const instanceMix = {
        spot: 8,
        totalInstances: 10
      };

      const risk = balancer.assessRisk(instanceMix, tierConfig);

      expect(risk).to.equal('high');
    });

    it('should assess low risk for appropriate spot ratio', function() {
      const tierConfig = balancer.config.serviceTiers.normal;
      const instanceMix = {
        spot: 3,
        totalInstances: 10
      };

      const risk = balancer.assessRisk(instanceMix, tierConfig);

      expect(risk).to.equal('low');
    });
  });

  describe('analyzeTradeoff', function() {
    it('should generate comprehensive analysis', async function() {
      const analysis = await balancer.analyzeTradeoff('gateway', 5000);

      expect(analysis).to.have.property('service');
      expect(analysis).to.have.property('tier');
      expect(analysis).to.have.property('estimatedCost');
      expect(analysis).to.have.property('estimatedPerformance');
      expect(analysis).to.have.property('riskLevel');
      expect(analysis.recommendations).to.be.an('array');
    });

    it('should classify services correctly', async function() {
      const gatewayAnalysis = await balancer.analyzeTradeoff('gateway', 3000);
      const socialAnalysis = await balancer.analyzeTradeoff('social-service', 3000);

      expect(gatewayAnalysis.tier).to.equal('critical');
      expect(socialAnalysis.tier).to.equal('normal');
    });
  });
});

describe('Integration Tests', function() {
  this.timeout(10000);

  it('should complete full scheduling workflow', async function() {
    const IntelligentScheduler = require('../index');
    const scheduler = new IntelligentScheduler({
      enabled: true,
      schedulingInterval: 60000,
      autoScalingEnabled: true,
      costOptimizationEnabled: true
    });

    // Mock all dependencies
    sinon.stub(scheduler.trafficAnalyzer, 'initialize').resolves();
    sinon.stub(scheduler.trafficAnalyzer, 'predictTrafficTrend').resolves({
      predictions: [
        { timestamp: new Date(Date.now() + 60000), predictedRequests: 2000, confidence: 0.85 }
      ],
      summary: { avgPredictedRequests: 2000, confidence: 0.85 }
    });
    sinon.stub(scheduler.trafficAnalyzer, 'getPredictionAccuracy').resolves(0.87);
    sinon.stub(scheduler.predictiveScheduler, 'initialize').resolves();
    sinon.stub(scheduler.predictiveScheduler, 'executeScheduling').resolves({
      action: 'scale_up',
      targetReplicas: 5
    });

    // Run one cycle
    const result = await scheduler.runSchedulingCycle();

    expect(result).to.have.property('prediction');
    expect(result).to.have.property('scalingDecision');
    expect(scheduler.stats.totalSchedulingCycles).to.equal(1);
  });
});
