/**
 * SloMiddleware 单元测试
 */

const { SloMiddleware, CIRCUIT_STATES, DEGRADATION_STRATEGIES } = require('../../backend/shared/middleware/sloMiddleware');
const { SloManager } = require('../../backend/shared/SloManager');
const { SloBudgetTracker } = require('../../backend/shared/SloBudgetTracker');

// Mock Express
const mockRequest = (options = {}) => ({
  path: options.path || '/api/v1/test',
  method: options.method || 'GET',
  ip: options.ip || '127.0.0.1',
  service: options.service,
  ...options
});

const mockResponse = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const mockNext = jest.fn();

// Mock dependencies
const mockSloManager = new SloManager({ hotReload: false });
const mockBudgetTracker = {
  getStatus: jest.fn(),
  emit: jest.fn()
};

const mockRedis = {
  incr: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(true),
  publish: jest.fn().mockResolvedValue(1)
};

const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
};

describe('SloMiddleware', () => {
  let middleware;

  beforeEach(() => {
    middleware = new SloMiddleware({
      sloManager: mockSloManager,
      budgetTracker: mockBudgetTracker,
      redis: mockRedis,
      logger: mockLogger
    });
    
    // Reset circuit states
    middleware.circuitStates.clear();
    middleware.serviceConfigs.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should initialize with CLOSED state', () => {
      expect(middleware.circuitStates.size).toBe(0);
    });

    it('should have non-essential features defined', () => {
      expect(middleware.nonEssentialFeatures['pokemon-service']).toBeDefined();
    });

    it('should register Prometheus metrics', () => {
      expect(middleware.metrics.circuitStateGauge).toBeDefined();
      expect(middleware.metrics.degradationLevelGauge).toBeDefined();
    });
  });

  describe('Circuit States', () => {
    it('CIRCUIT_STATES should have expected values', () => {
      expect(CIRCUIT_STATES.CLOSED).toBe('closed');
      expect(CIRCUIT_STATES.OPEN).toBe('open');
      expect(CIRCUIT_STATES.HALF_OPEN).toBe('half_open');
    });
  });

  describe('Degradation Strategies', () => {
    it('DEGRADATION_STRATEGIES should have expected values', () => {
      expect(DEGRADATION_STRATEGIES.NONE).toBe('none');
      expect(DEGRADATION_STRATEGIES.THROTTLE).toBe('throttle');
      expect(DEGRADATION_STRATEGIES.MAINTENANCE).toBe('maintenance');
    });
  });

  describe('shouldTripCircuit', () => {
    it('should return maintenance when budget exhausted', () => {
      const status = {
        remainingRatio: 0.01,
        burnRates: { '1h': 1.0 }
      };
      
      const result = middleware.shouldTripCircuit('gateway', status);
      expect(result).toBeDefined();
      expect(result.reason).toBe('budget_exhausted');
      expect(result.level).toBe(DEGRADATION_STRATEGIES.MAINTENANCE);
    });

    it('should return read_only when budget critical', () => {
      const status = {
        remainingRatio: 0.03,
        burnRates: { '1h': 1.0 }
      };
      
      const result = middleware.shouldTripCircuit('gateway', status);
      expect(result).toBeDefined();
      expect(result.reason).toBe('budget_critical');
      expect(result.level).toBe(DEGRADATION_STRATEGIES.READ_ONLY);
    });

    it('should return throttle when burn rate high', () => {
      const status = {
        remainingRatio: 0.50,
        burnRates: { '1h': 3.0 }
      };
      
      const result = middleware.shouldTripCircuit('gateway', status);
      expect(result).toBeDefined();
      expect(result.reason).toBe('high_burn_rate');
      expect(result.level).toBe(DEGRADATION_STRATEGIES.THROTTLE);
    });

    it('should return null when healthy', () => {
      const status = {
        remainingRatio: 0.80,
        burnRates: { '1h': 0.5 }
      };
      
      const result = middleware.shouldTripCircuit('gateway', status);
      expect(result).toBeNull();
    });
  });

  describe('tripCircuit', () => {
    it('should set circuit state to OPEN', async () => {
      const status = {
        remainingRatio: 0.01,
        burnRates: { '1h': 3.0 }
      };
      
      await middleware.tripCircuit('gateway', 'budget_exhausted', status);
      
      const circuitState = middleware.circuitStates.get('gateway');
      expect(circuitState.state).toBe(CIRCUIT_STATES.OPEN);
      expect(circuitState.reason).toBe('budget_exhausted');
    });

    it('should emit alert', async () => {
      const status = {
        remainingRatio: 0.01,
        burnRates: { '1h': 3.0 }
      };
      
      await middleware.tripCircuit('gateway', 'budget_exhausted', status);
      
      expect(mockBudgetTracker.emit).toHaveBeenCalledWith('alert', expect.any(Object));
    });
  });

  describe('middleware function', () => {
    it('should pass through when circuit is CLOSED', async () => {
      middleware.circuitStates.set('gateway', { state: CIRCUIT_STATES.CLOSED });
      
      const req = mockRequest({ service: 'gateway' });
      const res = mockResponse();
      
      const sloMiddleware = middleware.middleware('gateway');
      await sloMiddleware(req, res, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });

    it('should return 503 when circuit is OPEN', async () => {
      middleware.circuitStates.set('gateway', {
        state: CIRCUIT_STATES.OPEN,
        status: { remainingRatio: 0.01, burnRates: { '1h': 3.0 } },
        reason: 'budget_exhausted'
      });
      
      const req = mockRequest({ service: 'gateway' });
      const res = mockResponse();
      
      const sloMiddleware = middleware.middleware('gateway');
      await sloMiddleware(req, res, mockNext);
      
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'SERVICE_DEGRADED'
      }));
    });

    it('should return 503 when maintenance mode', async () => {
      middleware.serviceConfigs.set('gateway', { maintenance: true });
      
      const req = mockRequest({ service: 'gateway' });
      const res = mockResponse();
      
      const sloMiddleware = middleware.middleware('gateway');
      await sloMiddleware(req, res, mockNext);
      
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'SERVICE_MAINTENANCE'
      }));
    });

    it('should return 403 for write request in read-only mode', async () => {
      middleware.serviceConfigs.set('gateway', { readOnly: true });
      
      const req = mockRequest({ service: 'gateway', method: 'POST' });
      const res = mockResponse();
      
      const sloMiddleware = middleware.middleware('gateway');
      await sloMiddleware(req, res, mockNext);
      
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'READ_ONLY_MODE'
      }));
    });

    it('should allow GET requests in read-only mode', async () => {
      middleware.serviceConfigs.set('gateway', { readOnly: true });
      
      const req = mockRequest({ service: 'gateway', method: 'GET' });
      const res = mockResponse();
      
      const sloMiddleware = middleware.middleware('gateway');
      await sloMiddleware(req, res, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });

    it('should return 503 for disabled feature', async () => {
      const disabledFeatures = new Set(['animation_preview']);
      middleware.serviceConfigs.set('pokemon-service', { disabledFeatures });
      
      const req = mockRequest({ 
        service: 'pokemon-service',
        path: '/api/v1/pokemon/animation_preview'
      });
      const res = mockResponse();
      
      const sloMiddleware = middleware.middleware('pokemon-service');
      await sloMiddleware(req, res, mockNext);
      
      expect(res.status).toHaveBeenCalledWith(503);
    });
  });

  describe('isReadOnlyRequest', () => {
    it('should return true for GET', () => {
      const req = mockRequest({ method: 'GET' });
      expect(middleware.isReadOnlyRequest(req)).toBe(true);
    });

    it('should return true for HEAD', () => {
      const req = mockRequest({ method: 'HEAD' });
      expect(middleware.isReadOnlyRequest(req)).toBe(true);
    });

    it('should return false for POST', () => {
      const req = mockRequest({ method: 'POST' });
      expect(middleware.isReadOnlyRequest(req)).toBe(false);
    });
  });

  describe('manualRecover', () => {
    it('should reset circuit to CLOSED', async () => {
      middleware.circuitStates.set('gateway', { state: CIRCUIT_STATES.OPEN });
      
      await middleware.manualRecover('gateway');
      
      const state = middleware.circuitStates.get('gateway');
      expect(state.state).toBe(CIRCUIT_STATES.CLOSED);
      expect(state.manual).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('should return current state', () => {
      middleware.circuitStates.set('gateway', { state: CIRCUIT_STATES.OPEN });
      
      const status = middleware.getStatus('gateway');
      
      expect(status.circuitState.state).toBe(CIRCUIT_STATES.OPEN);
    });
  });

  describe('generateIncidentId', () => {
    it('should generate unique incident ID', () => {
      const id1 = middleware.generateIncidentId();
      const id2 = middleware.generateIncidentId();
      
      expect(id1).toMatch(/^INC-/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('getCooldownPeriod', () => {
    it('should return 10 minutes for budget_exhausted', () => {
      const period = middleware.getCooldownPeriod('budget_exhausted');
      expect(period).toBe(600000);
    });

    it('should return 5 minutes for budget_critical', () => {
      const period = middleware.getCooldownPeriod('budget_critical');
      expect(period).toBe(300000);
    });

    it('should return 2 minutes for high_burn_rate', () => {
      const period = middleware.getCooldownPeriod('high_burn_rate');
      expect(period).toBe(120000);
    });
  });
});