// backend/tests/unit/DegradationManager.test.js
'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const {
  DegradationManager,
  DEGRADATION_LEVELS,
  DEGRADATION_ACTIONS,
  SERVICE_PRIORITY
} = require('../../shared/DegradationManager');

// Mock Redis
const mockRedis = {
  get: sinon.stub(),
  set: sinon.stub(),
  hget: sinon.stub(),
  hset: sinon.stub(),
  lpush: sinon.stub(),
  lrange: sinon.stub(),
  ltrim: sinon.stub(),
  publish: sinon.stub(),
  on: sinon.stub()
};

describe('DegradationManager', () => {
  let manager;
  
  beforeEach(() => {
    // Reset stubs
    sinon.resetHistory();
    
    manager = new DegradationManager({
      redis: mockRedis
    });
  });
  
  afterEach(() => {
    if (manager) {
      manager.shutdown();
    }
  });
  
  describe('initialization', () => {
    it('should initialize with default config', () => {
      expect(manager.config).to.exist;
      expect(manager.config.services).to.exist;
      expect(manager.config.global).to.exist;
      expect(manager.config.userTiers).to.exist;
    });
    
    it('should have all services configured', () => {
      const services = Object.keys(manager.config.services);
      expect(services).to.include('user-service');
      expect(services).to.include('catch-service');
      expect(services).to.include('payment-service');
      expect(services).to.include('pokemon-service');
      expect(services).to.include('location-service');
      expect(services).to.include('gym-service');
      expect(services).to.include('social-service');
      expect(services).to.include('reward-service');
    });
    
    it('should initialize with empty degradation state', () => {
      expect(manager.currentDegradationState.size).to.equal(0);
    });
  });
  
  describe('getServiceState', () => {
    it('should return normal state for non-degraded service', () => {
      const state = manager.getServiceState('user-service');
      
      expect(state.service).to.equal('user-service');
      expect(state.level).to.equal(DEGRADATION_LEVELS.NORMAL);
      expect(state.priority).to.equal(SERVICE_PRIORITY.CRITICAL);
      expect(state.actions).to.deep.equal([]);
    });
    
    it('should return degraded state when service is degraded', async () => {
      await manager.executeDegradation({
        service: 'social-service',
        level: DEGRADATION_LEVELS.LEVEL_1,
        actions: [DEGRADATION_ACTIONS.CACHE_ONLY],
        metrics: { errorRate: 0.03 }
      });
      
      const state = manager.getServiceState('social-service');
      
      expect(state.level).to.equal(DEGRADATION_LEVELS.LEVEL_1);
      expect(state.actions).to.include(DEGRADATION_ACTIONS.CACHE_ONLY);
    });
  });
  
  describe('getAllServicesStatus', () => {
    it('should return status for all services', () => {
      const status = manager.getAllServicesStatus();
      
      expect(Object.keys(status).length).to.equal(8);
      expect(status['user-service']).to.exist;
      expect(status['catch-service']).to.exist;
    });
  });
  
  describe('shouldTriggerDegradation', () => {
    it('should trigger when error rate exceeds threshold', () => {
      const metrics = { errorRate: 0.06 };
      const triggers = { errorRate: 0.05 };
      
      const result = manager.shouldTriggerDegradation(metrics, triggers);
      expect(result).to.be.true;
    });
    
    it('should not trigger when metrics are below threshold', () => {
      const metrics = { errorRate: 0.03 };
      const triggers = { errorRate: 0.05 };
      
      const result = manager.shouldTriggerDegradation(metrics, triggers);
      expect(result).to.be.false;
    });
    
    it('should trigger when any metric exceeds threshold', () => {
      const metrics = { errorRate: 0.03, latencyP99: 3500 };
      const triggers = { errorRate: 0.05, latencyP99: 3000 };
      
      const result = manager.shouldTriggerDegradation(metrics, triggers);
      expect(result).to.be.true;
    });
  });
  
  describe('executeDegradation', () => {
    it('should update degradation state', async () => {
      const result = await manager.executeDegradation({
        service: 'social-service',
        level: DEGRADATION_LEVELS.LEVEL_1,
        actions: [DEGRADATION_ACTIONS.CACHE_ONLY],
        metrics: { errorRate: 0.03 }
      });
      
      expect(result).to.be.true;
      expect(manager.currentDegradationState.get('social-service')).to.equal(DEGRADATION_LEVELS.LEVEL_1);
    });
    
    it('should record degradation history', async () => {
      await manager.executeDegradation({
        service: 'social-service',
        level: DEGRADATION_LEVELS.LEVEL_1,
        actions: [DEGRADATION_ACTIONS.CACHE_ONLY],
        metrics: { errorRate: 0.03 }
      });
      
      expect(manager.degradationHistory.length).to.equal(1);
      expect(manager.degradationHistory[0].service).to.equal('social-service');
      expect(manager.degradationHistory[0].newLevel).to.equal(DEGRADATION_LEVELS.LEVEL_1);
    });
    
    it('should not degrade to same level twice', async () => {
      await manager.executeDegradation({
        service: 'social-service',
        level: DEGRADATION_LEVELS.LEVEL_1,
        actions: [DEGRADATION_ACTIONS.CACHE_ONLY],
        metrics: { errorRate: 0.03 }
      });
      
      const result = await manager.executeDegradation({
        service: 'social-service',
        level: DEGRADATION_LEVELS.LEVEL_1,
        actions: [DEGRADATION_ACTIONS.CACHE_ONLY],
        metrics: { errorRate: 0.04 }
      });
      
      expect(result).to.be.false;
      expect(manager.degradationHistory.length).to.equal(1);
    });
    
    it('should emit degradation event', async () => {
      const eventHandler = sinon.spy();
      manager.on('degradation', eventHandler);
      
      await manager.executeDegradation({
        service: 'social-service',
        level: DEGRADATION_LEVELS.LEVEL_1,
        actions: [DEGRADATION_ACTIONS.CACHE_ONLY],
        metrics: { errorRate: 0.03 }
      });
      
      expect(eventHandler.calledOnce).to.be.true;
      expect(eventHandler.firstCall.args[0].service).to.equal('social-service');
    });
  });
  
  describe('manualDegradation', () => {
    it('should allow manual degradation', async () => {
      await manager.manualDegradation('social-service', DEGRADATION_LEVELS.LEVEL_1, 'test reason', 'admin');
      
      const state = manager.getServiceState('social-service');
      expect(state.level).to.equal(DEGRADATION_LEVELS.LEVEL_1);
    });
    
    it('should throw for unknown service', async () => {
      try {
        await manager.manualDegradation('unknown-service', DEGRADATION_LEVELS.LEVEL_1, 'test');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Unknown service');
      }
    });
    
    it('should throw for unknown level', async () => {
      try {
        await manager.manualDegradation('social-service', 'unknown-level', 'test');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Unknown degradation level');
      }
    });
  });
  
  describe('forceRecover', () => {
    it('should recover degraded service', async () => {
      await manager.executeDegradation({
        service: 'social-service',
        level: DEGRADATION_LEVELS.LEVEL_1,
        actions: [DEGRADATION_ACTIONS.CACHE_ONLY],
        metrics: { errorRate: 0.03 }
      });
      
      const result = await manager.forceRecover('social-service', 'admin');
      
      expect(result.success).to.be.true;
      const state = manager.getServiceState('social-service');
      expect(state.level).to.equal(DEGRADATION_LEVELS.NORMAL);
    });
    
    it('should emit recovery event', async () => {
      await manager.executeDegradation({
        service: 'social-service',
        level: DEGRADATION_LEVELS.LEVEL_1,
        actions: [DEGRADATION_ACTIONS.CACHE_ONLY],
        metrics: { errorRate: 0.03 }
      });
      
      const eventHandler = sinon.spy();
      manager.on('recovery', eventHandler);
      
      await manager.forceRecover('social-service', 'admin');
      
      expect(eventHandler.calledOnce).to.be.true;
    });
  });
  
  describe('user tier handling', () => {
    it('should exempt VIP users from degradation', () => {
      const exempt = manager.isUserExempt('vip');
      expect(exempt).to.be.true;
    });
    
    it('should not exempt free users from degradation', () => {
      const exempt = manager.isUserExempt('free');
      expect(exempt).to.be.false;
    });
    
    it('should return correct degradation delay for premium users', () => {
      const delay = manager.getUserDegradationDelay('premium');
      expect(delay).to.equal(60);
    });
    
    it('should return zero delay for free users', () => {
      const delay = manager.getUserDegradationDelay('free');
      expect(delay).to.equal(0);
    });
  });
  
  describe('getEndpointConfig', () => {
    it('should return endpoint config if exists', () => {
      const config = manager.getEndpointConfig('/api/social/friends');
      expect(config).to.exist;
      expect(config.degradation.cacheOnly).to.be.true;
    });
    
    it('should return null for non-configured endpoint', () => {
      const config = manager.getEndpointConfig('/api/unknown/path');
      expect(config).to.be.null;
    });
  });
  
  describe('getDegradationHistory', () => {
    it('should return empty array when no history', () => {
      const history = manager.getDegradationHistory();
      expect(history).to.deep.equal([]);
    });
    
    it('should return limited history', async () => {
      // Add multiple degradation events
      for (let i = 0; i < 5; i++) {
        await manager.executeDegradation({
          service: 'social-service',
          level: DEGRADATION_LEVELS.LEVEL_1,
          actions: [DEGRADATION_ACTIONS.CACHE_ONLY],
          metrics: { errorRate: 0.03 }
        });
        
        // Reset for next degradation
        manager.currentDegradationState.set('social-service', DEGRADATION_LEVELS.NORMAL);
      }
      
      const history = manager.getDegradationHistory(3);
      expect(history.length).to.equal(3);
    });
  });
  
  describe('subscribe', () => {
    it('should add subscriber callback', () => {
      const callback = sinon.spy();
      manager.subscribe('social-service', callback);
      
      expect(manager.subscribers.get('social-service')).to.include(callback);
    });
    
    it('should return unsubscribe function', () => {
      const callback = sinon.spy();
      const unsubscribe = manager.subscribe('social-service', callback);
      
      unsubscribe();
      
      expect(manager.subscribers.get('social-service')).to.not.include(callback);
    });
  });
  
  describe('updateConfig', () => {
    it('should merge new config', () => {
      const originalGlobal = { ...manager.config.global };
      
      manager.updateConfig({
        global: {
          enabled: false
        }
      });
      
      expect(manager.config.global.enabled).to.be.false;
    });
  });
  
  describe('shutdown', () => {
    it('should clear intervals', () => {
      manager.shutdown();
      
      expect(manager.healthCheckInterval).to.be.undefined;
      expect(manager.recoveryProbes.size).to.equal(0);
    });
  });
});

describe('DEGRADATION_LEVELS', () => {
  it('should have correct level values', () => {
    expect(DEGRADATION_LEVELS.NORMAL).to.equal('normal');
    expect(DEGRADATION_LEVELS.LEVEL_1).to.equal('level1');
    expect(DEGRADATION_LEVELS.LEVEL_2).to.equal('level2');
    expect(DEGRADATION_LEVELS.LEVEL_3).to.equal('level3');
  });
});

describe('DEGRADATION_ACTIONS', () => {
  it('should have all action types', () => {
    expect(DEGRADATION_ACTIONS.CACHE_ONLY).to.exist;
    expect(DEGRADATION_ACTIONS.READ_ONLY).to.exist;
    expect(DEGRADATION_ACTIONS.DISABLE_FEATURE).to.exist;
    expect(DEGRADATION_ACTIONS.SERVICE_UNAVAILABLE).to.exist;
    expect(DEGRADATION_ACTIONS.FALLBACK_RESPONSE).to.exist;
  });
});

describe('SERVICE_PRIORITY', () => {
  it('should have correct priority values', () => {
    expect(SERVICE_PRIORITY.CRITICAL).to.equal(1);
    expect(SERVICE_PRIORITY.IMPORTANT).to.equal(2);
    expect(SERVICE_PRIORITY.NON_CRITICAL).to.equal(3);
  });
});
