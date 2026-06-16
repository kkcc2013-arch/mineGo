// tests/unit/PriorityConnectionPool.test.js
'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { 
  PriorityConnectionPool, 
  PriorityQueue,
  PRIORITY_LEVELS 
} = require('../../backend/shared/PriorityConnectionPool');

describe('PriorityConnectionPool', () => {
  describe('PriorityQueue', () => {
    let queue;

    beforeEach(() => {
      queue = new PriorityQueue(100);
    });

    it('should enqueue items with different priorities', () => {
      queue.enqueue({ priority: 'LOW', data: 'low1' });
      queue.enqueue({ priority: 'CRITICAL', data: 'critical1' });
      queue.enqueue({ priority: 'NORMAL', data: 'normal1' });
      queue.enqueue({ priority: 'HIGH', data: 'high1' });

      expect(queue.getTotalSize()).to.equal(4);
      expect(queue.getQueueLength('CRITICAL')).to.equal(1);
      expect(queue.getQueueLength('HIGH')).to.equal(1);
      expect(queue.getQueueLength('NORMAL')).to.equal(1);
      expect(queue.getQueueLength('LOW')).to.equal(1);
    });

    it('should dequeue in priority order', () => {
      queue.enqueue({ priority: 'LOW', data: 'low' });
      queue.enqueue({ priority: 'CRITICAL', data: 'critical' });
      queue.enqueue({ priority: 'NORMAL', data: 'normal' });

      const first = queue.dequeue();
      expect(first.priority).to.equal('CRITICAL');

      const second = queue.dequeue();
      expect(second.priority).to.equal('NORMAL');

      const third = queue.dequeue();
      expect(third.priority).to.equal('LOW');
    });

    it('should respect max queue size', () => {
      const smallQueue = new PriorityQueue(3);
      
      smallQueue.enqueue({ priority: 'NORMAL', data: '1' });
      smallQueue.enqueue({ priority: 'NORMAL', data: '2' });
      smallQueue.enqueue({ priority: 'NORMAL', data: '3' });

      expect(() => smallQueue.enqueue({ priority: 'NORMAL', data: '4' }))
        .to.throw('Priority queue is full');
    });

    it('should return null when dequeuing empty queue', () => {
      expect(queue.dequeue()).to.be.null;
    });
  });

  describe('PRIORITY_LEVELS', () => {
    it('should have correct priority order', () => {
      expect(PRIORITY_LEVELS.CRITICAL.level).to.equal(1);
      expect(PRIORITY_LEVELS.HIGH.level).to.equal(2);
      expect(PRIORITY_LEVELS.NORMAL.level).to.equal(3);
      expect(PRIORITY_LEVELS.LOW.level).to.equal(4);
    });

    it('should have weights for each priority', () => {
      expect(PRIORITY_LEVELS.CRITICAL.weight).to.be.greaterThan(PRIORITY_LEVELS.HIGH.weight);
      expect(PRIORITY_LEVELS.HIGH.weight).to.be.greaterThan(PRIORITY_LEVELS.NORMAL.weight);
      expect(PRIORITY_LEVELS.NORMAL.weight).to.be.greaterThan(PRIORITY_LEVELS.LOW.weight);
    });
  });
});

describe('LoadAwareScheduler', () => {
  const { LoadAwareScheduler, SCHEDULER_CONFIG } = require('../../backend/shared/LoadAwareScheduler');
  
  let scheduler;
  let mockDb;

  beforeEach(() => {
    mockDb = {
      query: sinon.stub().resolves({
        rows: [{
          active: '5',
          idle: '10',
          waiting: '2',
          avg_query_time: '0.05',
          max_query_time: '0.2'
        }]
      })
    };

    scheduler = new LoadAwareScheduler(mockDb, {
      enableAutoScaling: false // Disable for tests
    });
  });

  afterEach(() => {
    scheduler.stop();
  });

  describe('calculateLoadScore', () => {
    it('should calculate load score from metrics', () => {
      scheduler.metrics = {
        activeConnections: 50,
        totalConnections: 100,
        waitingQueries: 5,
        avgQueryTime: 0.1,
        errorRate: 0.01
      };

      const { loadScore, breakdown } = scheduler.calculateLoadScore();

      expect(loadScore).to.be.at.least(0);
      expect(loadScore).to.be.at.most(100);
      expect(breakdown).to.have.property('connectionUsage');
      expect(breakdown).to.have.property('waitingQueries');
      expect(breakdown).to.have.property('queryLatency');
      expect(breakdown).to.have.property('errorRate');
    });

    it('should return 0 for idle system', () => {
      scheduler.metrics = {
        activeConnections: 0,
        totalConnections: 0,
        waitingQueries: 0,
        avgQueryTime: 0,
        errorRate: 0
      };

      const { loadScore } = scheduler.calculateLoadScore();
      expect(loadScore).to.equal(0);
    });
  });

  describe('getLoadLevel', () => {
    it('should return CRITICAL for high load', () => {
      scheduler.currentLoadScore = 95;
      expect(scheduler.getLoadLevel()).to.equal('CRITICAL');
    });

    it('should return HIGH for elevated load', () => {
      scheduler.currentLoadScore = 75;
      expect(scheduler.getLoadLevel()).to.equal('HIGH');
    });

    it('should return MEDIUM for moderate load', () => {
      scheduler.currentLoadScore = 50;
      expect(scheduler.getLoadLevel()).to.equal('MEDIUM');
    });

    it('should return LOW for light load', () => {
      scheduler.currentLoadScore = 25;
      expect(scheduler.getLoadLevel()).to.equal('LOW');
    });

    it('should return IDLE for minimal load', () => {
      scheduler.currentLoadScore = 10;
      expect(scheduler.getLoadLevel()).to.equal('IDLE');
    });
  });

  describe('getRecommendedConnections', () => {
    it('should recommend more connections for higher load', () => {
      scheduler.currentLoadScore = 85;
      const criticalRec = scheduler.getRecommendedConnections('CRITICAL');
      const lowRec = scheduler.getRecommendedConnections('LOW');

      expect(criticalRec).to.be.greaterThan(lowRec);
    });

    it('should scale recommendations based on load level', () => {
      scheduler.currentLoadScore = 10;
      const idleRec = scheduler.getRecommendedConnections('NORMAL');

      scheduler.currentLoadScore = 90;
      const highRec = scheduler.getRecommendedConnections('NORMAL');

      expect(highRec).to.be.greaterThan(idleRec);
    });
  });

  describe('predictLoad', () => {
    it('should return null with insufficient history', () => {
      scheduler.history = [];
      const prediction = scheduler.predictLoad(15);
      expect(prediction).to.be.null;
    });

    it('should predict load with sufficient history', () => {
      // Add enough history
      for (let i = 0; i < 20; i++) {
        scheduler.history.push({
          timestamp: Date.now() - i * 10000,
          loadScore: 50 + Math.random() * 10
        });
      }

      const prediction = scheduler.predictLoad(15);
      
      expect(prediction).to.not.be.null;
      expect(prediction).to.have.property('currentLoad');
      expect(prediction).to.have.property('predictedLoad');
      expect(prediction).to.have.property('trend');
      expect(prediction.predictedLoad).to.be.at.least(0);
      expect(prediction.predictedLoad).to.be.at.most(100);
    });
  });
});

describe('ConnectionWarmer', () => {
  const { ConnectionWarmer } = require('../../backend/shared/ConnectionWarmer');
  
  let warmer;
  let mockPoolManager;
  let mockDb;

  beforeEach(() => {
    mockPoolManager = {
      getStats: sinon.stub().returns({
        pool1: { total: 10, idle: 5 },
        pool2: { total: 8, idle: 4 }
      })
    };

    mockDb = {
      query: sinon.stub().resolves({
        rows: [{
          hour: '10',
          avg_connections: '15',
          max_connections: '20',
          avg_utilization: '0.75',
          sample_count: '100'
        }]
      })
    };

    warmer = new ConnectionWarmer(mockPoolManager, mockDb, {
      enableScheduledWarmup: false // Disable for tests
    });
  });

  afterEach(() => {
    warmer.stop();
  });

  describe('learnFromHistory', () => {
    it('should identify peak hours from historical data', async () => {
      mockDb.query.resolves({
        rows: [
          { hour: '9', avg_connections: '10', max_connections: '15', avg_utilization: '0.5', sample_count: '100' },
          { hour: '10', avg_connections: '20', max_connections: '30', avg_utilization: '0.8', sample_count: '100' },
          { hour: '11', avg_connections: '25', max_connections: '35', avg_utilization: '0.85', sample_count: '100' },
          { hour: '12', avg_connections: '15', max_connections: '20', avg_utilization: '0.6', sample_count: '100' }
        ]
      });

      await warmer.learnFromHistory();

      // Hours 10 and 11 should be identified as peaks
      expect(warmer.peakSchedule.has(10)).to.be.true;
      expect(warmer.peakSchedule.has(11)).to.be.true;
    });
  });

  describe('getPeakSchedule', () => {
    it('should return peak schedule information', () => {
      warmer.peakSchedule.set(10, { avgConnections: 20, isPeak: true });
      warmer.warmupSchedule.set(9, { targetConnections: 25, peakHour: 10 });

      const schedule = warmer.getPeakSchedule();

      expect(schedule).to.have.property('peaks');
      expect(schedule).to.have.property('warmups');
      expect(schedule).to.have.property('stats');
    });
  });
});

describe('ConnectionHealthChecker', () => {
  const { ConnectionHealthChecker } = require('../../backend/shared/ConnectionHealthChecker');
  
  let healthChecker;
  let mockPoolManager;

  beforeEach(() => {
    mockPoolManager = {
      pools: new Map([
        ['pool1', {
          pool: {
            _clients: [],
            query: sinon.stub().resolves({ rows: [{ result: 1 }] })
          }
        }]
      ])
    };

    healthChecker = new ConnectionHealthChecker(mockPoolManager, {
      enableAutoRecovery: false
    });
  });

  afterEach(() => {
    healthChecker.stop();
  });

  describe('checkClientHealth', () => {
    it('should return healthy for responsive connection', async () => {
      const mockClient = {
        connection: { stream: { destroyed: false } },
        query: sinon.stub().resolves({ rows: [{ result: 1 }] }),
        lastError: null
      };

      const health = await healthChecker.checkClientHealth('pool1', mockClient);

      expect(health.healthy).to.be.true;
      expect(health.reason).to.be.null;
    });

    it('should detect disconnected connection', async () => {
      const mockClient = {
        connection: { stream: { destroyed: true } },
        query: sinon.stub()
      };

      const health = await healthChecker.checkClientHealth('pool1', mockClient);

      expect(health.healthy).to.be.false;
      expect(health.reason).to.equal('disconnected');
    });

    it('should detect high latency', async () => {
      const mockClient = {
        connection: { stream: { destroyed: false } },
        query: sinon.stub().callsFake(async () => {
          await new Promise(resolve => setTimeout(resolve, 150));
          return { rows: [{ result: 1 }] };
        }),
        lastError: null
      };

      const health = await healthChecker.checkClientHealth('pool1', mockClient);

      expect(health.healthy).to.be.false;
      expect(health.reason).to.equal('high_latency');
    });

    it('should detect recent errors', async () => {
      const mockClient = {
        connection: { stream: { destroyed: false } },
        query: sinon.stub().resolves({ rows: [{ result: 1 }] }),
        lastError: {
          timestamp: Date.now() - 30000, // 30 seconds ago
          message: 'Connection error'
        }
      };

      const health = await healthChecker.checkClientHealth('pool1', mockClient);

      expect(health.healthy).to.be.false;
      expect(health.reason).to.equal('recent_error');
    });
  });

  describe('getHealthStatus', () => {
    it('should return health statistics', () => {
      healthChecker.unhealthyConnections.set('client1', { reason: 'high_latency' });
      healthChecker.unhealthyConnections.set('client2', { reason: 'query_failed' });

      const status = healthChecker.getHealthStatus();

      expect(status).to.have.property('stats');
      expect(status).to.have.property('unhealthyCount', 2);
      expect(status).to.have.property('unhealthyByReason');
      expect(status.unhealthyByReason['high_latency']).to.equal(1);
      expect(status.unhealthyByReason['query_failed']).to.equal(1);
    });
  });
});
