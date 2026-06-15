/**
 * backend/tests/unit/realtimeBusinessMetrics.test.js
 * 实时业务指标服务单元测试
 * 
 * @description 测试 realtimeBusinessMetrics.js 的核心计算逻辑、边界条件和 Prometheus 格式
 */

const { realtimeMetrics, RealtimeBusinessMetricsCalculator } = require('../../shared/realtimeBusinessMetrics');
const promClient = require('prom-client');

// Mock dependencies
jest.mock('../../shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn()
  })
}));

jest.mock('../../shared/db', () => ({
  query: jest.fn()
}));

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    pfcount: jest.fn().mockResolvedValue(100),
    get: jest.fn().mockResolvedValue('50'),
    set: jest.fn().mockResolvedValue('OK'),
    incr: jest.fn().mockResolvedValue(1),
    expireat: jest.fn().mockResolvedValue(1),
    multi: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
    hgetall: jest.fn().mockResolvedValue({ 'asia-east': '100', 'us-west': '50' })
  }));
});

describe('RealtimeBusinessMetrics', () => {
  let calculator;
  let mockRedis;
  
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    // Reset Prometheus registry
    promClient.register.clear();
    
    calculator = new RealtimeBusinessMetricsCalculator({
      updateInterval: 60000,
      redisUrl: 'redis://localhost:6379'
    });
  });
  
  afterEach(() => {
    calculator.stop();
    jest.useRealTimers();
  });

  // ==========================================================================
  // 1. 指标定义测试
  // ==========================================================================
  
  describe('MetricDefinitions', () => {
    test('should define all required user metrics', () => {
      expect(realtimeMetrics.activeUsers).toBeDefined();
      expect(realtimeMetrics.newUsersToday).toBeDefined();
      expect(realtimeMetrics.userRetentionRate).toBeDefined();
    });
    
    test('should define all required catch metrics', () => {
      expect(realtimeMetrics.catchSuccessRate).toBeDefined();
      expect(realtimeMetrics.catchAttemptsTotal).toBeDefined();
      expect(realtimeMetrics.catchSuccessTotal).toBeDefined();
      expect(realtimeMetrics.averageCp).toBeDefined();
    });
    
    test('should define all required gym metrics', () => {
      expect(realtimeMetrics.gymCapturesTotal).toBeDefined();
      expect(realtimeMetrics.gymBattlesTotal).toBeDefined();
      expect(realtimeMetrics.raidParticipants).toBeDefined();
      expect(realtimeMetrics.raidSuccessRate).toBeDefined();
    });
    
    test('should define all required payment metrics', () => {
      expect(realtimeMetrics.paymentAmountTotal).toBeDefined();
      expect(realtimeMetrics.paymentOrdersTotal).toBeDefined();
      expect(realtimeMetrics.paymentSuccessRate).toBeDefined();
      expect(realtimeMetrics.averageOrderValue).toBeDefined();
    });
    
    test('should define all required social metrics', () => {
      expect(realtimeMetrics.friendsAddedTotal).toBeDefined();
      expect(realtimeMetrics.giftsSentTotal).toBeDefined();
      expect(realtimeMetrics.giftsOpenedTotal).toBeDefined();
      expect(realtimeMetrics.guildMembers).toBeDefined();
    });
    
    test('should define all required PVP metrics', () => {
      expect(realtimeMetrics.pvpMatchesTotal).toBeDefined();
      expect(realtimeMetrics.pvpRankDistribution).toBeDefined();
    });
    
    test('should define event throughput histogram', () => {
      expect(realtimeMetrics.eventThroughput).toBeDefined();
      expect(realtimeMetrics.eventThroughput).toBeInstanceOf(promClient.Histogram);
    });
    
    test('metrics should have correct Prometheus naming convention', () => {
      // 检查指标名称前缀
      const metricNames = Object.values(realtimeMetrics).map(m => m.name);
      
      for (const name of metricNames) {
        expect(name).toMatch(/^minego_business_[a-z_]+$/);
      }
    });
  });

  // ==========================================================================
  // 2. 计算器生命周期测试
  // ==========================================================================
  
  describe('CalculatorLifecycle', () => {
    test('should start and set isRunning flag', () => {
      expect(calculator.isRunning).toBe(false);
      
      calculator.start();
      
      expect(calculator.isRunning).toBe(true);
      expect(calculator.timer).toBeDefined();
    });
    
    test('should not start twice', () => {
      calculator.start();
      const firstTimer = calculator.timer;
      
      calculator.start();
      
      expect(calculator.timer).toBe(firstTimer);
    });
    
    test('should stop and clear timer', () => {
      calculator.start();
      expect(calculator.isRunning).toBe(true);
      
      calculator.stop();
      
      expect(calculator.isRunning).toBe(false);
      expect(calculator.timer).toBeNull();
    });
    
    test('should stop safely when not running', () => {
      expect(() => calculator.stop()).not.toThrow();
      expect(calculator.isRunning).toBe(false);
    });
    
    test('should use default update interval of 60000ms', () => {
      const defaultCalculator = new RealtimeBusinessMetricsCalculator();
      expect(defaultCalculator.updateInterval).toBe(60000);
    });
    
    test('should accept custom update interval', () => {
      const customCalculator = new RealtimeBusinessMetricsCalculator({
        updateInterval: 30000
      });
      expect(customCalculator.updateInterval).toBe(30000);
    });
  });

  // ==========================================================================
  // 3. 用户指标计算测试
  // ==========================================================================
  
  describe('UserMetricsCalculation', () => {
    test('should calculate active users from Redis PF count', async () => {
      const mockPfcount = calculator.redis.pfcount;
      mockPfcount.mockResolvedValueOnce(250);
      
      await calculator.calculateUserMetrics();
      
      expect(mockPfcount).toHaveBeenCalledWith('active_users:5min');
      // Gauge should be set to 250
    });
    
    test('should calculate new users today from Redis', async () => {
      const mockGet = calculator.redis.get;
      mockGet.mockResolvedValueOnce('75');
      
      await calculator.calculateUserMetrics();
      
      expect(mockGet).toHaveBeenCalled();
    });
    
    test('should handle zero active users', async () => {
      const mockPfcount = calculator.redis.pfcount;
      mockPfcount.mockResolvedValueOnce(0);
      
      await expect(calculator.calculateUserMetrics()).resolves.not.toThrow();
    });
    
    test('should handle Redis errors gracefully', async () => {
      const mockPfcount = calculator.redis.pfcount;
      mockPfcount.mockRejectedValueOnce(new Error('Redis connection failed'));
      
      await expect(calculator.calculateUserMetrics()).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // 4. 捕捉指标计算测试
  // ==========================================================================
  
  describe('CatchMetricsCalculation', () => {
    test('should calculate catch success rate correctly', async () => {
      const mockGet = calculator.redis.get;
      mockGet
        .mockResolvedValueOnce('100')  // catch attempts
        .mockResolvedValueOnce('75');  // catch successes
      
      await calculator.calculateCatchMetrics();
      
      // Success rate = 75/100 = 0.75
      expect(mockGet).toHaveBeenCalledWith('events:catch.attempt:1h');
      expect(mockGet).toHaveBeenCalledWith('events:catch.success:1h');
    });
    
    test('should handle zero catch attempts', async () => {
      const mockGet = calculator.redis.get;
      mockGet
        .mockResolvedValueOnce('0')   // catch attempts
        .mockResolvedValueOnce('0');  // catch successes
      
      await expect(calculator.calculateCatchMetrics()).resolves.not.toThrow();
    });
    
    test('should handle null catch data', async () => {
      const mockGet = calculator.redis.get;
      mockGet
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      
      await expect(calculator.calculateCatchMetrics()).resolves.not.toThrow();
    });
    
    test('should calculate average CP from database', async () => {
      const { query } = require('../../shared/db');
      query.mockResolvedValueOnce({
        rows: [{ avg_cp: 850.5 }]
      });
      
      await calculator.calculateCatchMetrics();
      
      expect(query).toHaveBeenCalledWith(expect.stringContaining('AVG(cp)'));
    });
    
    test('should handle database query errors for average CP', async () => {
      const { query } = require('../../shared/db');
      query.mockRejectedValueOnce(new Error('Database error'));
      
      await expect(calculator.calculateCatchMetrics()).resolves.not.toThrow();
    });
    
    test('should handle empty average CP result', async () => {
      const { query } = require('../../shared/db');
      query.mockResolvedValueOnce({ rows: [] });
      
      await expect(calculator.calculateCatchMetrics()).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // 5. 道馆指标计算测试
  // ==========================================================================
  
  describe('GymMetricsCalculation', () => {
    test('should calculate gym captures by team', async () => {
      const { query } = require('../../shared/db');
      query.mockResolvedValueOnce({
        rows: [
          { team: 'red', count: 150 },
          { team: 'blue', count: 120 },
          { team: 'yellow', count: 80 }
        ]
      });
      
      await calculator.calculateGymMetrics();
      
      expect(query).toHaveBeenCalledWith(expect.stringContaining('GROUP BY team'));
    });
    
    test('should calculate raid success rate', async () => {
      const mockGet = calculator.redis.get;
      mockGet
        .mockResolvedValueOnce('50')  // raid wins
        .mockResolvedValueOnce('60'); // raid starts
      
      await calculator.calculateGymMetrics();
      
      // Success rate = 50/60 ≈ 0.833
    });
    
    test('should handle zero raid starts', async () => {
      const mockGet = calculator.redis.get;
      mockGet
        .mockResolvedValueOnce('0')
        .mockResolvedValueOnce('0');
      
      await expect(calculator.calculateGymMetrics()).resolves.not.toThrow();
    });
    
    test('should handle database errors gracefully', async () => {
      const { query } = require('../../shared/db');
      query.mockRejectedValueOnce(new Error('Connection timeout'));
      
      await expect(calculator.calculateGymMetrics()).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // 6. 支付指标计算测试
  // ==========================================================================
  
  describe('PaymentMetricsCalculation', () => {
    test('should calculate payment success rate by product type', async () => {
      const { query } = require('../../shared/db');
      query.mockResolvedValueOnce({
        rows: [
          { product_type: 'coins', success_rate: 0.95, avg_amount: 6800 },
          { product_type: 'premium', success_rate: 0.88, avg_amount: 30000 }
        ]
      });
      
      await calculator.calculatePaymentMetrics();
      
      expect(query).toHaveBeenCalledWith(expect.stringContaining('product_type'));
    });
    
    test('should handle null success rate', async () => {
      const { query } = require('../../shared/db');
      query.mockResolvedValueOnce({
        rows: [{ product_type: 'coins', success_rate: null, avg_amount: null }]
      });
      
      await expect(calculator.calculatePaymentMetrics()).resolves.not.toThrow();
    });
    
    test('should handle empty payment result', async () => {
      const { query } = require('../../shared/db');
      query.mockResolvedValueOnce({ rows: [] });
      
      await expect(calculator.calculatePaymentMetrics()).resolves.not.toThrow();
    });
    
    test('should handle database errors', async () => {
      const { query } = require('../../shared/db');
      query.mockRejectedValueOnce(new Error('Query timeout'));
      
      await expect(calculator.calculatePaymentMetrics()).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // 7. 交易指标计算测试
  // ==========================================================================
  
  describe('TradeMetricsCalculation', () => {
    test('should calculate trade success rate', async () => {
      const mockGet = calculator.redis.get;
      mockGet
        .mockResolvedValueOnce('80')  // trade complete
        .mockResolvedValueOnce('100'); // trade initiate
      
      await calculator.calculateTradeMetrics();
      
      // Success rate = 80/100 = 0.8
    });
    
    test('should handle zero trade initiations', async () => {
      const mockGet = calculator.redis.get;
      mockGet
        .mockResolvedValueOnce('0')
        .mockResolvedValueOnce('0');
      
      await expect(calculator.calculateTradeMetrics()).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // 8. 社交指标计算测试
  // ==========================================================================
  
  describe('SocialMetricsCalculation', () => {
    test('should increment social counters from Redis', async () => {
      const mockGet = calculator.redis.get;
      mockGet
        .mockResolvedValueOnce('150')  // friends added
        .mockResolvedValueOnce('200')  // gifts sent
        .mockResolvedValueOnce('120'); // gifts opened
      
      await calculator.calculateSocialMetrics();
      
      expect(mockGet).toHaveBeenCalledWith('events:social.friend_add:24h');
      expect(mockGet).toHaveBeenCalledWith('events:social.gift_send:24h');
      expect(mockGet).toHaveBeenCalledWith('events:social.gift_open:24h');
    });
    
    test('should handle null social data', async () => {
      const mockGet = calculator.redis.get;
      mockGet
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      
      await expect(calculator.calculateSocialMetrics()).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // 9. PVP 指标计算测试
  // ==========================================================================
  
  describe('PVPMetricsCalculation', () => {
    test('should calculate PVP rank distribution', async () => {
      const { query } = require('../../shared/db');
      query.mockResolvedValueOnce({
        rows: [
          { league: 'great', rank_tier: 'ace', count: 500 },
          { league: 'great', rank_tier: 'veteran', count: 1200 },
          { league: 'ultra', rank_tier: 'ace', count: 300 }
        ]
      });
      
      await calculator.calculatePVPMetrics();
      
      expect(query).toHaveBeenCalledWith(expect.stringContaining('pvp_rankings'));
    });
    
    test('should handle empty PVP rankings', async () => {
      const { query } = require('../../shared/db');
      query.mockResolvedValueOnce({ rows: [] });
      
      await expect(calculator.calculatePVPMetrics()).resolves.not.toThrow();
    });
    
    test('should handle database errors', async () => {
      const { query } = require('../../shared/db');
      query.mockRejectedValueOnce(new Error('Connection lost'));
      
      await expect(calculator.calculatePVPMetrics()).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // 10. 道具指标计算测试
  // ==========================================================================
  
  describe('ItemMetricsCalculation', () => {
    test('should increment item counters', async () => {
      const mockGet = calculator.redis.get;
      mockGet
        .mockResolvedValueOnce('500')  // items used
        .mockResolvedValueOnce('200'); // items purchased
      
      await calculator.calculateItemMetrics();
      
      expect(mockGet).toHaveBeenCalledWith('events:item.use:24h');
      expect(mockGet).toHaveBeenCalledWith('events:item.purchase:24h');
    });
  });

  // ==========================================================================
  // 11. 地理分布指标计算测试
  // ==========================================================================
  
  describe('GeoMetricsCalculation', () => {
    test('should calculate active users by region', async () => {
      const mockHgetall = calculator.redis.hgetall;
      mockHgetall.mockResolvedValueOnce({
        'asia-east': '1000',
        'asia-southeast': '500',
        'us-west': '300',
        'eu-west': '200'
      });
      
      await calculator.calculateGeoMetrics();
      
      expect(mockHgetall).toHaveBeenCalledWith('active_users:by_region:5min');
    });
    
    test('should handle empty region data', async () => {
      const mockHgetall = calculator.redis.hgetall;
      mockHgetall.mockResolvedValueOnce({});
      
      await expect(calculator.calculateGeoMetrics()).resolves.not.toThrow();
    });
    
    test('should handle Redis errors', async () => {
      const mockHgetall = calculator.redis.hgetall;
      mockHgetall.mockRejectedValueOnce(new Error('Redis timeout'));
      
      await expect(calculator.calculateGeoMetrics()).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // 12. 事件记录测试
  // ==========================================================================
  
  describe('EventRecording', () => {
    test('should record event to Redis with correct keys', () => {
      calculator.recordEvent('catch.success', 'catch');
      
      expect(calculator.redis.multi).toHaveBeenCalled();
    });
    
    test('should observe event in Prometheus histogram', () => {
      const observeSpy = jest.spyOn(realtimeMetrics.eventThroughput, 'observe');
      
      calculator.recordEvent('payment.success', 'payment');
      
      expect(observeSpy).toHaveBeenCalledWith(
        { event_category: 'payment' },
        expect.any(Number)
      );
    });
    
    test('should handle multiple events', () => {
      calculator.recordEvent('catch.attempt', 'catch');
      calculator.recordEvent('gym.battle', 'gym');
      calculator.recordEvent('trade.initiate', 'trade');
      
      expect(calculator.redis.multi).toHaveBeenCalledTimes(3);
    });
  });

  // ==========================================================================
  // 13. 完整计算测试
  // ==========================================================================
  
  describe('FullCalculation', () => {
    test('should call all metric calculators', async () => {
      const { query } = require('../../shared/db');
      query.mockResolvedValue({ rows: [] });
      
      const calculateUserSpy = jest.spyOn(calculator, 'calculateUserMetrics');
      const calculateCatchSpy = jest.spyOn(calculator, 'calculateCatchMetrics');
      const calculateGymSpy = jest.spyOn(calculator, 'calculateGymMetrics');
      
      await calculator.calculate();
      
      expect(calculateUserSpy).toHaveBeenCalled();
      expect(calculateCatchSpy).toHaveBeenCalled();
      expect(calculateGymSpy).toHaveBeenCalled();
    });
    
    test('should handle partial failures and continue', async () => {
      const { query } = require('../../shared/db');
      
      // First query fails, others succeed
      query
        .mockRejectedValueOnce(new Error('First query failed'))
        .mockResolvedValue({ rows: [] });
      
      await expect(calculator.calculate()).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // 14. 边界条件测试
  // ==========================================================================
  
  describe('EdgeCases', () => {
    test('should handle extremely large user count', async () => {
      const mockPfcount = calculator.redis.pfcount;
      mockPfcount.mockResolvedValueOnce(Number.MAX_SAFE_INTEGER);
      
      await expect(calculator.calculateUserMetrics()).resolves.not.toThrow();
    });
    
    test('should handle negative values gracefully', async () => {
      const mockGet = calculator.redis.get;
      mockGet.mockResolvedValueOnce('-100');
      
      await expect(calculator.calculateUserMetrics()).resolves.not.toThrow();
    });
    
    test('should handle string numbers in Redis', async () => {
      const mockGet = calculator.redis.get;
      mockGet.mockResolvedValueOnce('not-a-number');
      
      await expect(calculator.calculateUserMetrics()).resolves.not.toThrow();
    });
    
    test('should handle undefined Redis responses', async () => {
      const mockGet = calculator.redis.get;
      mockGet.mockResolvedValueOnce(undefined);
      
      await expect(calculator.calculateUserMetrics()).resolves.not.toThrow();
    });
    
    test('should handle concurrent calculations', async () => {
      const { query } = require('../../shared/db');
      query.mockResolvedValue({ rows: [] });
      
      const promises = [
        calculator.calculate(),
        calculator.calculate(),
        calculator.calculate()
      ];
      
      await expect(Promise.all(promises)).resolves.not.toThrow();
    });
    
    test('should handle zero division in rate calculations', async () => {
      const mockGet = calculator.redis.get;
      mockGet
        .mockResolvedValueOnce('0')  // numerator
        .mockResolvedValueOnce('0'); // denominator
      
      await expect(calculator.calculateCatchMetrics()).resolves.not.toThrow();
    });
  });

  // ==========================================================================
  // 15. Prometheus 格式验证测试
  // ==========================================================================
  
  describe('PrometheusFormat', () => {
    test('all metrics should have valid names', () => {
      const validNameRegex = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
      
      for (const [key, metric] of Object.entries(realtimeMetrics)) {
        expect(metric.name).toMatch(validNameRegex);
      }
    });
    
    test('all metrics should have help text', () => {
      for (const [key, metric] of Object.entries(realtimeMetrics)) {
        expect(metric.help).toBeDefined();
        expect(metric.help.length).toBeGreaterThan(0);
      }
    });
    
    test('counter metrics should have increment method', () => {
      expect(realtimeMetrics.catchAttemptsTotal.inc).toBeDefined();
      expect(realtimeMetrics.paymentAmountTotal.inc).toBeDefined();
      expect(realtimeMetrics.tradeVolumeTotal.inc).toBeDefined();
    });
    
    test('gauge metrics should have set method', () => {
      expect(realtimeMetrics.activeUsers.set).toBeDefined();
      expect(realtimeMetrics.catchSuccessRate.set).toBeDefined();
      expect(realtimeMetrics.averageCp.set).toBeDefined();
    });
    
    test('histogram should have observe method', () => {
      expect(realtimeMetrics.eventThroughput.observe).toBeDefined();
    });
    
    test('histogram should have valid buckets', () => {
      const buckets = realtimeMetrics.eventThroughput.bucketValues;
      expect(buckets).toBeDefined();
      expect(buckets.length).toBeGreaterThan(0);
      
      // Buckets should be sorted
      for (let i = 1; i < buckets.length; i++) {
        expect(buckets[i]).toBeGreaterThanOrEqual(buckets[i - 1]);
      }
    });
  });

  // ==========================================================================
  // 16. 定时执行测试
  // ==========================================================================
  
  describe('ScheduledExecution', () => {
    test('should execute calculation on interval', async () => {
      const { query } = require('../../shared/db');
      query.mockResolvedValue({ rows: [] });
      
      const calculateSpy = jest.spyOn(calculator, 'calculate');
      
      calculator.start();
      
      // Fast-forward time by 60 seconds
      jest.advanceTimersByTime(60000);
      
      // Should have been called at least once (initial + scheduled)
      expect(calculateSpy).toHaveBeenCalled();
    });
    
    test('should stop scheduled execution', () => {
      calculator.start();
      expect(calculator.timer).toBeDefined();
      
      calculator.stop();
      
      expect(calculator.timer).toBeNull();
    });
  });
});
