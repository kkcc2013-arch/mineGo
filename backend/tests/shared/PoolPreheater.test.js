// backend/tests/shared/PoolPreheater.test.js - REQ-00581: 数据库连接池智能预热与动态自适应管理系统测试
'use strict';

const { PoolPreheater, AdaptivePoolAdjuster, PREHEAT_CONFIG } = require('../../shared/PoolPreheater');
const { createLogger } = require('../../shared/logger');

// Mock dependencies
jest.mock('../../shared/logger');
jest.mock('../../shared/redis', () => ({
  getRedis: jest.fn(() => ({
    lpush: jest.fn().mockResolvedValue(),
    lrange: jest.fn().mockResolvedValue([]),
    ltrim: jest.fn().mockResolvedValue(),
  })),
}));

const mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

createLogger.mockReturnValue(mockLogger);

describe('PoolPreheater', () => {
  let preheater;
  let mockPoolManager;

  beforeEach(() => {
    jest.useFakeTimers();

    mockPoolManager = {
      pools: new Map(),
      getStats: jest.fn(),
      config: { maxPoolLimit: 20 },
    };

    preheater = new PoolPreheater(mockPoolManager);
  });

  afterEach(() => {
    preheater?.stop();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with default config', () => {
      expect(preheater.config).toMatchObject({
        defaultPreheatTime: 5,
        cooldownPeriod: 10,
        analysisWindowDays: 7,
      });
    });

    it('should accept custom config', () => {
      const customPreheater = new PoolPreheater(mockPoolManager, {
        defaultPreheatTime: 10,
        customOption: 'test',
      });

      expect(customPreheater.config.defaultPreheatTime).toBe(10);
      expect(customPreheater.config.customOption).toBe('test');
    });
  });

  describe('start/stop', () => {
    it('should start preheater successfully', () => {
      preheater.start();

      expect(preheater.isRunning).toBe(true);
      expect(preheater.scheduledJobs.length).toBeGreaterThan(0);
      expect(mockLogger.info).toHaveBeenCalledWith('Starting pool preheater system');
    });

    it('should not start twice', () => {
      preheater.start();
      preheater.start();

      expect(mockLogger.warn).toHaveBeenCalledWith('Pool preheater already running');
    });

    it('should stop preheater successfully', () => {
      preheater.start();
      preheater.stop();

      expect(preheater.isRunning).toBe(false);
      expect(preheater.scheduledJobs.length).toBe(0);
    });
  });

  describe('predictTrafficTrend', () => {
    it('should predict increasing trend', () => {
      const history = [
        { qps: 10 },
        { qps: 20 },
        { qps: 30 },
        { qps: 40 },
        { qps: 50 },
      ];

      const result = preheater.predictTrafficTrend(history);

      expect(result.trend).toBe('increasing');
      expect(result.slope).toBeGreaterThan(0);
    });

    it('should predict decreasing trend', () => {
      const history = [
        { qps: 50 },
        { qps: 40 },
        { qps: 30 },
        { qps: 20 },
        { qps: 10 },
      ];

      const result = preheater.predictTrafficTrend(history);

      expect(result.trend).toBe('decreasing');
      expect(result.slope).toBeLessThan(0);
    });

    it('should predict stable trend', () => {
      const history = [
        { qps: 30 },
        { qps: 30 },
        { qps: 30 },
        { qps: 30 },
        { qps: 30 },
      ];

      const result = preheater.predictTrafficTrend(history);

      expect(result.trend).toBe('stable');
    });

    it('should return stable for insufficient data', () => {
      const result = preheater.predictTrafficTrend([]);

      expect(result.trend).toBe('stable');
      expect(result.confidence).toBe(0);
    });
  });

  describe('warmupConnections', () => {
    it('should create needed connections', async () => {
      const mockPool = {
        idleCount: 2,
        connect: jest.fn().mockResolvedValue({
          release: jest.fn(),
        }),
      };

      await preheater.warmupConnections(mockPool, 5);

      expect(mockPool.connect).toHaveBeenCalledTimes(3); // 5 - 2 = 3
    });

    it('should not create connections if already enough', async () => {
      const mockPool = {
        idleCount: 10,
        connect: jest.fn(),
      };

      await preheater.warmupConnections(mockPool, 5);

      expect(mockPool.connect).not.toHaveBeenCalled();
    });
  });

  describe('executePreheat', () => {
    it('should preheat all pools', async () => {
      mockPoolManager.getStats.mockReturnValue({
        'pool-user': { idle: 3, total: 5, waiting: 0, usage: 50 },
        'pool-catch': { idle: 2, total: 4, waiting: 0, usage: 40 },
      });

      mockPoolManager.pools.set('pool-user', {
        pool: {
          idleCount: 3,
          connect: jest.fn().mockResolvedValue({ release: jest.fn() }),
        },
      });
      mockPoolManager.pools.set('pool-catch', {
        pool: {
          idleCount: 2,
          connect: jest.fn().mockResolvedValue({ release: jest.fn() }),
        },
      });

      const schedule = {
        time: '07:55',
        targetMinMultiplier: 2.0,
        reason: '早高峰前预热',
      };

      await preheater.executePreheat(schedule);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ reason: '早高峰前预热' }),
        'Pool preheated successfully'
      );
    });
  });

  describe('recordPreheatEvent', () => {
    it('should record event to Redis', async () => {
      await preheater.recordPreheatEvent('pool-user', {
        type: 'scheduled',
        reason: 'test',
      });

      expect(preheater.redis.lpush).toHaveBeenCalled();
      expect(preheater.redis.ltrim).toHaveBeenCalled();
    });
  });

  describe('recordTrafficMetric', () => {
    it('should record metric to Redis', async () => {
      await preheater.recordTrafficMetric('pool-user', {
        total: 10,
        idle: 5,
        usage: 50,
      });

      expect(preheater.redis.lpush).toHaveBeenCalled();
      expect(preheater.redis.ltrim).toHaveBeenCalledWith('minego:traffic:pool-user', 0, 167);
    });
  });

  describe('emergencyScaleUp', () => {
    it('should scale up when triggered', async () => {
      mockPoolManager.pools.set('pool-user', {
        pool: {
          options: { max: 10 },
          connect: jest.fn().mockResolvedValue({ release: jest.fn() }),
        },
      });

      await preheater.emergencyScaleUp('pool-user', {
        usage: 90,
        waiting: 5,
      });

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(preheater.redis.lpush).toHaveBeenCalled();
    });
  });

  describe('getPreheatStats', () => {
    it('should return stats from Redis', async () => {
      const stats = await preheater.getPreheatStats('pool-user');

      expect(stats).toHaveProperty('recentEvents');
      expect(stats).toHaveProperty('recentTraffic');
    });
  });
});

describe('AdaptivePoolAdjuster', () => {
  let adjuster;
  let mockPoolManager;
  let mockPreheater;

  beforeEach(() => {
    mockPoolManager = {
      pools: new Map(),
      getStats: jest.fn(),
    };

    mockPreheater = {};

    adjuster = new AdaptivePoolAdjuster(mockPoolManager, mockPreheater);
  });

  describe('adjust', () => {
    it('should increase min connections on high load', async () => {
      mockPoolManager.pools.set('pool-user', {
        pool: {
          options: { min: 3, max: 10 },
        },
      });

      mockPoolManager.getStats.mockReturnValue({
        'pool-user': { usage: 80, waiting: 2, idle: 2, total: 8 },
      });

      const result = await adjuster.adjust('pool-user');

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('increase_min');
    });

    it('should decrease min connections on low load', async () => {
      mockPoolManager.pools.set('pool-user', {
        pool: {
          options: { min: 5, max: 10 },
        },
      });

      mockPoolManager.getStats.mockReturnValue({
        'pool-user': { usage: 20, waiting: 0, idle: 8, total: 8 },
      });

      const result = await adjuster.adjust('pool-user');

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('decrease_min');
    });

    it('should not adjust when load is normal', async () => {
      mockPoolManager.pools.set('pool-user', {
        pool: {
          options: { min: 3, max: 10 },
        },
      });

      mockPoolManager.getStats.mockReturnValue({
        'pool-user': { usage: 50, waiting: 0, idle: 5, total: 8 },
      });

      const result = await adjuster.adjust('pool-user');

      expect(result).toHaveLength(0);
    });
  });

  describe('getAdjustmentHistory', () => {
    it('should return history for pool', () => {
      adjuster.adjustmentHistory.set('pool-user', { test: 'data' });

      const history = adjuster.getAdjustmentHistory('pool-user');

      expect(history).toEqual({ test: 'data' });
    });

    it('should return undefined for unknown pool', () => {
      const history = adjuster.getAdjustmentHistory('unknown');

      expect(history).toBeUndefined();
    });
  });
});

describe('PREHEAT_CONFIG', () => {
  it('should have required schedule entries', () => {
    expect(PREHEAT_CONFIG.schedule).toHaveLength(4);
    expect(PREHEAT_CONFIG.schedule.map(s => s.time)).toContain('07:55');
    expect(PREHEAT_CONFIG.schedule.map(s => s.time)).toContain('17:55');
  });

  it('should have valid thresholds', () => {
    expect(PREHEAT_CONFIG.minUtilizationThreshold).toBeLessThan(PREHEAT_CONFIG.maxUtilizationThreshold);
    expect(PREHEAT_CONFIG.analysisWindowDays).toBeGreaterThanOrEqual(1);
  });
});