/**
 * SloBudgetTracker 单元测试
 */

const { SloBudgetTracker, TIME_WINDOWS } = require('../../backend/shared/SloBudgetTracker');
const { SloManager } = require('../../backend/shared/SloManager');

// Mock dependencies
const mockSloManager = new SloManager({ hotReload: false });
const mockRedis = {
  hincrby: jest.fn().mockResolvedValue(1),
  hgetall: jest.fn().mockResolvedValue({ total_requests: '100000', error_count: '50' }),
  zadd: jest.fn().mockResolvedValue(1),
  zremrangebyscore: jest.fn().mockResolvedValue(10),
  incr: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(true),
  publish: jest.fn().mockResolvedValue(1)
};

const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
};

describe('SloBudgetTracker', () => {
  let budgetTracker;

  beforeEach(() => {
    budgetTracker = new SloBudgetTracker({
      sloManager: mockSloManager,
      redis: mockRedis,
      logger: mockLogger
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    budgetTracker.errorWindows.clear();
    budgetTracker.budgetCache.clear();
  });

  describe('Constructor', () => {
    it('should initialize with correct time windows', () => {
      expect(TIME_WINDOWS['1h']).toBe(3600000);
      expect(TIME_WINDOWS['24h']).toBe(86400000);
      expect(TIME_WINDOWS['30d']).toBe(2592000000);
    });

    it('should register Prometheus metrics', () => {
      expect(budgetTracker.metrics.budgetTotalGauge).toBeDefined();
      expect(budgetTracker.metrics.budgetRemainingGauge).toBeDefined();
      expect(budgetTracker.metrics.burnRateGauge).toBeDefined();
    });
  });

  describe('recordRequest', () => {
    it('should record successful request', async () => {
      await budgetTracker.recordRequest('gateway', '/api/v1/health', true);
      expect(mockRedis.hincrby).toHaveBeenCalledWith(
        'slo:budget:gateway:30d',
        'total_requests',
        1
      );
    });

    it('should record failed request', async () => {
      await budgetTracker.recordRequest('gateway', '/api/v1/login', false, '500');
      expect(mockRedis.hincrby).toHaveBeenCalledWith(
        'slo:budget:gateway:30d',
        'error_count',
        1
      );
    });

    it('should track error timestamps', async () => {
      await budgetTracker.recordRequest('gateway', '/test', false);
      const errors = budgetTracker.errorWindows.get('gateway');
      expect(errors).toBeDefined();
      expect(errors.length).toBe(1);
    });
  });

  describe('getErrorCount', () => {
    it('should count errors in time window', () => {
      const now = Date.now();
      budgetTracker.errorWindows.set('gateway', [
        now - 1000,
        now - 2000,
        now - 4000000 // outside 1h window
      ]);
      
      const count = budgetTracker.getErrorCount('gateway', '1h');
      expect(count).toBe(2);
    });

    it('should return 0 for no errors', () => {
      const count = budgetTracker.getErrorCount('gateway', '1h');
      expect(count).toBe(0);
    });
  });

  describe('calculateBurnRate', () => {
    it('should calculate burn rate correctly', async () => {
      // Setup error windows
      const now = Date.now();
      budgetTracker.errorWindows.set('gateway', [
        now - 1000,
        now - 2000,
        now - 3000
      ]);
      
      // Mock budget status
      budgetTracker.budgetCache.set('gateway', {
        totalBudget: 1000,
        remainingBudget: 500,
        burnRates: {}
      });
      
      const rate = await budgetTracker.calculateBurnRate('gateway', '1h');
      expect(rate).toBeGreaterThan(0);
    });

    it('should return null for invalid service', async () => {
      const rate = await budgetTracker.calculateBurnRate('unknown', '1h');
      expect(rate).toBeNull();
    });
  });

  describe('getStatus', () => {
    it('should return complete status object', async () => {
      const status = await budgetTracker.getStatus('gateway');
      
      expect(status).toBeDefined();
      expect(status.service).toBe('gateway');
      expect(status.target).toBeDefined();
      expect(status.totalBudget).toBeDefined();
      expect(status.remainingBudget).toBeDefined();
      expect(status.remainingRatio).toBeDefined();
      expect(status.burnRates).toBeDefined();
      expect(status.health).toBeDefined();
    });

    it('should calculate remaining ratio', async () => {
      const status = await budgetTracker.getStatus('gateway');
      expect(status.remainingRatio).toBeGreaterThanOrEqual(0);
      expect(status.remainingRatio).toBeLessThanOrEqual(1);
    });

    it('should include health status', async () => {
      const status = await budgetTracker.getStatus('gateway');
      expect(status.health.status).toBeDefined();
      expect(['healthy', 'normal', 'warning', 'critical']).toContain(status.health.status);
    });

    it('should return null for unknown service', async () => {
      const status = await budgetTracker.getStatus('unknown-service');
      expect(status).toBeNull();
    });
  });

  describe('predictExhaustion', () => {
    it('should predict exhaustion time', () => {
      const prediction = budgetTracker.predictExhaustion('gateway', 100, 1.0);
      
      expect(prediction).toBeDefined();
      expect(prediction.seconds).toBeGreaterThan(0);
      expect(prediction.timestamp).toBeGreaterThan(Date.now());
      expect(prediction.humanReadable).toBeDefined();
    });

    it('should return null when budget exhausted', () => {
      const prediction = budgetTracker.predictExhaustion('gateway', 0, 1.0);
      expect(prediction).toBeNull();
    });

    it('should return null when burn rate is zero', () => {
      const prediction = budgetTracker.predictExhaustion('gateway', 100, 0);
      expect(prediction).toBeNull();
    });
  });

  describe('formatTime', () => {
    it('should format seconds', () => {
      const formatted = budgetTracker.formatTime(30);
      expect(formatted).toBe('30秒');
    });

    it('should format minutes', () => {
      const formatted = budgetTracker.formatTime(120);
      expect(formatted).toContain('分钟');
    });

    it('should format hours', () => {
      const formatted = budgetTracker.formatTime(3600);
      expect(formatted).toContain('小时');
    });

    it('should format days', () => {
      const formatted = budgetTracker.formatTime(86400);
      expect(formatted).toContain('天');
    });
  });

  describe('checkBudgetStatus', () => {
    it('should generate alerts for exhausted budget', async () => {
      // Setup exhausted budget
      budgetTracker.budgetCache.set('gateway', {
        service: 'gateway',
        remainingRatio: 0.01,
        remainingBudget: 10,
        totalBudget: 1000,
        burnRates: { '1h': 3.0, '24h': 2.0 }
      });
      
      const alerts = await budgetTracker.checkBudgetStatus();
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0].type).toBe('budget_exhaustion');
    });
  });

  describe('recalculate', () => {
    it('should clear cache and recalculate', async () => {
      budgetTracker.budgetCache.set('gateway', { old: 'data' });
      
      const status = await budgetTracker.recalculate('gateway');
      
      expect(budgetTracker.budgetCache.has('gateway')).toBe(true);
      expect(status).toBeDefined();
    });
  });

  describe('EventEmitter', () => {
    it('should emit budgetExhaustion event', (done) => {
      budgetTracker.on('budgetExhaustion', (data) => {
        expect(data.service).toBe('gateway');
        done();
      });
      
      budgetTracker.emit('budgetExhaustion', { service: 'gateway', status: {} });
    });

    it('should emit highBurnRate event', (done) => {
      budgetTracker.on('highBurnRate', (data) => {
        expect(data.service).toBe('gateway');
        expect(data.period).toBe('1h');
        done();
      });
      
      budgetTracker.emit('highBurnRate', { service: 'gateway', status: {}, period: '1h' });
    });
  });
});