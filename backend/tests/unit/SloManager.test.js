/**
 * SloManager 单元测试
 */

const { SloManager, DEFAULT_SLOS, BURN_RATE_THRESHOLDS, BUDGET_EXHAUSTION_THRESHOLD, AUTO_DEGRADATION_THRESHOLD } = require('../../backend/shared/SloManager');

// Mock dependencies
const mockRedis = {
  hset: jest.fn().mockResolvedValue(true),
  hgetall: jest.fn().mockResolvedValue({})
};

const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
};

describe('SloManager', () => {
  let sloManager;

  beforeEach(() => {
    sloManager = new SloManager({
      redis: mockRedis,
      logger: mockLogger,
      hotReload: false
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should initialize with default SLOs', () => {
      expect(sloManager.slos).toEqual(DEFAULT_SLOS);
    });

    it('should have 9 service SLOs defined', () => {
      expect(Object.keys(sloManager.slos).length).toBe(9);
    });

    it('should register Prometheus metrics', () => {
      expect(sloManager.metrics.sloTargetGauge).toBeDefined();
      expect(sloManager.metrics.sloWindowGauge).toBeDefined();
    });
  });

  describe('getSlo', () => {
    it('should return SLO config for valid service', () => {
      const slo = sloManager.getSlo('gateway');
      expect(slo).toBeDefined();
      expect(slo.target).toBe(0.999);
      expect(slo.window).toBe('30d');
    });

    it('should return null for invalid service', () => {
      const slo = sloManager.getSlo('unknown-service');
      expect(slo).toBeNull();
    });
  });

  describe('getAllSlos', () => {
    it('should return all SLO configurations', () => {
      const slos = sloManager.getAllSlos();
      expect(Object.keys(slos)).toContain('gateway');
      expect(Object.keys(slos)).toContain('payment-service');
    });
  });

  describe('calculateBudget', () => {
    it('should calculate correct error budget', () => {
      const budget = sloManager.calculateBudget('gateway', 1000000);
      expect(budget.total).toBe(1000); // (1 - 0.999) * 1000000
      expect(budget.target).toBe(0.999);
    });

    it('should return null for invalid service', () => {
      const budget = sloManager.calculateBudget('unknown', 1000000);
      expect(budget).toBeNull();
    });

    it('should handle payment service strict SLO', () => {
      const budget = sloManager.calculateBudget('payment-service', 100000);
      expect(budget.total).toBe(10); // (1 - 0.9999) * 100000
    });
  });

  describe('getBurnRateThresholds', () => {
    it('should return burn rate thresholds', () => {
      const thresholds = sloManager.getBurnRateThresholds();
      expect(thresholds.fast.rate).toBe(2.0);
      expect(thresholds.medium.rate).toBe(1.0);
      expect(thresholds.slow.rate).toBe(0.5);
    });
  });

  describe('getExhaustionThresholds', () => {
    it('should return exhaustion thresholds', () => {
      const thresholds = sloManager.getExhaustionThresholds();
      expect(thresholds.warning).toBe(0.05);
      expect(thresholds.critical).toBe(0.02);
    });
  });

  describe('calculateHealth', () => {
    it('should return critical status when budget exhausted', () => {
      const health = sloManager.calculateHealth(0.01, 3.0);
      expect(health.status).toBe('critical');
      expect(health.action).toBe('auto_degradation');
      expect(health.color).toBe('red');
    });

    it('should return warning status when budget critical', () => {
      const health = sloManager.calculateHealth(0.03, 1.5);
      expect(health.status).toBe('warning');
      expect(health.action).toBe('throttle');
      expect(health.color).toBe('yellow');
    });

    it('should return healthy status when budget充足', () => {
      const health = sloManager.calculateHealth(0.7, 0.3);
      expect(health.status).toBe('healthy');
      expect(health.action).toBe('none');
      expect(health.color).toBe('green');
    });

    it('should return normal status for moderate usage', () => {
      const health = sloManager.calculateHealth(0.35, 0.8);
      expect(health.status).toBe('normal');
      expect(health.action).toBe('monitor');
    });
  });

  describe('updateSlo', () => {
    it('should update SLO configuration', async () => {
      await sloManager.updateSlo('gateway', { target: 0.995 });
      expect(sloManager.slos['gateway'].target).toBe(0.995);
      expect(mockRedis.hset).toHaveBeenCalled();
    });

    it('should throw error for unknown service', async () => {
      await expect(sloManager.updateSlo('unknown', { target: 0.99 }))
        .rejects.toThrow('Unknown service');
    });

    it('should throw error for invalid target', async () => {
      await expect(sloManager.updateSlo('gateway', { target: 1.5 }))
        .rejects.toThrow('SLO target must be between 0 and 1');
    });
  });

  describe('validateConfig', () => {
    it('should validate correct config', () => {
      const result = sloManager.validateConfig('gateway', { target: 0.995 });
      expect(result.valid).toBe(true);
    });

    it('should return errors for invalid target', () => {
      const result = sloManager.validateConfig('gateway', { target: 1.5 });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('target must be a number between 0 and 1');
    });

    it('should return errors for invalid window format', () => {
      const result = sloManager.validateConfig('gateway', { window: 'invalid' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('window must be in format like "30d"');
    });
  });

  describe('getAllSloStatuses', () => {
    it('should return status for all services', async () => {
      const statuses = await sloManager.getAllSloStatuses();
      expect(Object.keys(statuses).length).toBe(9);
      expect(statuses['gateway'].target).toBeDefined();
    });
  });
});

describe('Constants', () => {
  it('BUDGET_EXHAUSTION_THRESHOLD should be 0.05', () => {
    expect(BUDGET_EXHAUSTION_THRESHOLD).toBe(0.05);
  });

  it('AUTO_DEGRADATION_THRESHOLD should be 0.02', () => {
    expect(AUTO_DEGRADATION_THRESHOLD).toBe(0.02);
  });

  it('Payment service should have strictest SLO', () => {
    expect(DEFAULT_SLOS['payment-service'].target).toBe(0.9999);
  });
});