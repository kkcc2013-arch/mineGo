'use strict';

/**
 * Unit tests for DelayQueue
 * REQ-00043: 延迟任务队列与可靠重试机制
 */

const { describe, it, beforeEach, afterEach, expect } = require('@jest/globals');
const { DelayQueue, getDelayQueue, resetDelayQueue } = require('../../shared/DelayQueue');

// Mock Kafka
jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    producer: jest.fn().mockReturnValue({
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
    }),
    consumer: jest.fn().mockReturnValue({
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
      run: jest.fn().mockResolvedValue(undefined),
    }),
  })),
}));

// Mock metrics
jest.mock('../../shared/metrics', () => ({
  incrementCounter: jest.fn(),
  observeHistogram: jest.fn(),
  gauge: jest.fn(),
}));

describe('DelayQueue', () => {
  let delayQueue;

  beforeEach(() => {
    resetDelayQueue();
    delayQueue = new DelayQueue({ clientId: 'test' });
  });

  afterEach(async () => {
    if (delayQueue && delayQueue.isConnected) {
      await delayQueue.disconnect();
    }
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      const dq = new DelayQueue();
      expect(dq.clientId).toBe('minego-delay-queue');
      expect(dq.maxRetries).toBe(5);
      expect(dq.delayTopicPrefix).toBe('delay-queue');
      expect(dq.dlqTopic).toBe('delay-queue-dlq');
    });

    it('should accept custom config', () => {
      const dq = new DelayQueue({
        clientId: 'custom-client',
        maxRetries: 10,
        delayTopicPrefix: 'custom-prefix',
      });
      expect(dq.clientId).toBe('custom-client');
      expect(dq.maxRetries).toBe(10);
      expect(dq.delayTopicPrefix).toBe('custom-prefix');
    });

    it('should initialize priority levels', () => {
      expect(delayQueue.priorityLevels.critical).toBe(0);
      expect(delayQueue.priorityLevels.high).toBe(1);
      expect(delayQueue.priorityLevels.normal).toBe(2);
      expect(delayQueue.priorityLevels.low).toBe(3);
    });

    it('should initialize metrics', () => {
      expect(delayQueue.metrics.tasksScheduled).toBe(0);
      expect(delayQueue.metrics.tasksCompleted).toBe(0);
      expect(delayQueue.metrics.tasksFailed).toBe(0);
      expect(delayQueue.metrics.tasksRetried).toBe(0);
      expect(delayQueue.metrics.tasksDeadLetter).toBe(0);
    });
  });

  describe('connect', () => {
    it('should connect producer', async () => {
      await delayQueue.connect();
      expect(delayQueue.isConnected).toBe(true);
    });

    it('should not reconnect if already connected', async () => {
      await delayQueue.connect();
      await delayQueue.connect();
      expect(delayQueue.isConnected).toBe(true);
    });
  });

  describe('schedule', () => {
    it('should schedule a task with default options', async () => {
      await delayQueue.connect();
      
      const result = await delayQueue.schedule('test.task', { data: 'test' });
      
      expect(result.taskId).toBeDefined();
      expect(result.executeAt).toBeDefined();
      expect(delayQueue.metrics.tasksScheduled).toBe(1);
    });

    it('should schedule a task with delay', async () => {
      await delayQueue.connect();
      
      const delayMs = 60000; // 1 minute
      const result = await delayQueue.schedule('test.task', { data: 'test' }, { delay: delayMs });
      
      expect(result.taskId).toBeDefined();
      const executeAt = new Date(result.executeAt);
      const expectedTime = new Date(Date.now() + delayMs);
      const diff = Math.abs(executeAt - expectedTime);
      expect(diff).toBeLessThan(1000); // Within 1 second
    });

    it('should schedule a task with specific execution time', async () => {
      await delayQueue.connect();
      
      const executeTime = new Date(Date.now() + 3600000); // 1 hour from now
      const result = await delayQueue.schedule('test.task', { data: 'test' }, { delayUntil: executeTime });
      
      expect(result.taskId).toBeDefined();
      const actualExecuteAt = new Date(result.executeAt);
      const diff = Math.abs(actualExecuteAt - executeTime);
      expect(diff).toBeLessThan(1000);
    });

    it('should schedule a task with priority', async () => {
      await delayQueue.connect();
      
      const result = await delayQueue.schedule('test.task', { data: 'test' }, { priority: 'critical' });
      
      expect(result.taskId).toBeDefined();
    });

    it('should schedule a task with custom max retries', async () => {
      await delayQueue.connect();
      
      const result = await delayQueue.schedule('test.task', { data: 'test' }, { maxRetries: 10 });
      
      expect(result.taskId).toBeDefined();
    });

    it('should auto-connect if not connected', async () => {
      const result = await delayQueue.schedule('test.task', { data: 'test' });
      
      expect(delayQueue.isConnected).toBe(true);
      expect(result.taskId).toBeDefined();
    });
  });

  describe('_getDelayBucket', () => {
    it('should return immediate for no delay', () => {
      expect(delayQueue._getDelayBucket(0)).toBe('immediate');
      expect(delayQueue._getDelayBucket(-100)).toBe('immediate');
    });

    it('should return 1m for delays under 1 minute', () => {
      expect(delayQueue._getDelayBucket(1000)).toBe('1m');
      expect(delayQueue._getDelayBucket(30000)).toBe('1m');
      expect(delayQueue._getDelayBucket(59999)).toBe('1m');
    });

    it('should return 5m for delays under 5 minutes', () => {
      expect(delayQueue._getDelayBucket(60000)).toBe('5m');
      expect(delayQueue._getDelayBucket(180000)).toBe('5m');
      expect(delayQueue._getDelayBucket(299999)).toBe('5m');
    });

    it('should return 15m for delays under 15 minutes', () => {
      expect(delayQueue._getDelayBucket(300000)).toBe('15m');
      expect(delayQueue._getDelayBucket(600000)).toBe('15m');
      expect(delayQueue._getDelayBucket(899999)).toBe('15m');
    });

    it('should return 1h for delays under 1 hour', () => {
      expect(delayQueue._getDelayBucket(900000)).toBe('1h');
      expect(delayQueue._getDelayBucket(1800000)).toBe('1h');
      expect(delayQueue._getDelayBucket(3599999)).toBe('1h');
    });

    it('should return 6h for delays under 6 hours', () => {
      expect(delayQueue._getDelayBucket(3600000)).toBe('6h');
      expect(delayQueue._getDelayBucket(10800000)).toBe('6h');
      expect(delayQueue._getDelayBucket(21599999)).toBe('6h');
    });

    it('should return 24h for longer delays', () => {
      expect(delayQueue._getDelayBucket(21600000)).toBe('24h');
      expect(delayQueue._getDelayBucket(86400000)).toBe('24h');
      expect(delayQueue._getDelayBucket(604800000)).toBe('24h');
    });
  });

  describe('_calculateBackoffDelay', () => {
    it('should calculate exponential backoff', () => {
      const delay1 = delayQueue._calculateBackoffDelay(1);
      const delay2 = delayQueue._calculateBackoffDelay(2);
      const delay3 = delayQueue._calculateBackoffDelay(3);
      
      // Base delays: 1s, 2s, 4s (with jitter)
      expect(delay1).toBeGreaterThanOrEqual(900);
      expect(delay1).toBeLessThanOrEqual(1100);
      
      expect(delay2).toBeGreaterThanOrEqual(1800);
      expect(delay2).toBeLessThanOrEqual(2200);
      
      expect(delay3).toBeGreaterThanOrEqual(3600);
      expect(delay3).toBeLessThanOrEqual(4400);
    });

    it('should cap at max delay', () => {
      const delay = delayQueue._calculateBackoffDelay(20);
      expect(delay).toBeLessThanOrEqual(330000); // 5 minutes + 10% jitter
    });

    it('should add jitter', () => {
      // Run multiple times to verify jitter variation
      const delays = [];
      for (let i = 0; i < 10; i++) {
        delays.push(delayQueue._calculateBackoffDelay(1));
      }
      
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1); // Should have variation
    });
  });

  describe('scheduleRecurring', () => {
    it('should schedule a recurring task', async () => {
      await delayQueue.connect();
      
      const result = await delayQueue.scheduleRecurring('test.recurring', { data: 'test' }, '0 3 * * *');
      
      expect(result.taskId).toBeDefined();
      expect(result.nextRun).toBeDefined();
      expect(delayQueue.recurringTasks.size).toBe(1);
    });

    it('should throw error for invalid cron expression', async () => {
      await delayQueue.connect();
      
      await expect(
        delayQueue.scheduleRecurring('test.recurring', {}, 'invalid')
      ).rejects.toThrow();
    });
  });

  describe('cancelRecurring', () => {
    it('should cancel a recurring task', async () => {
      await delayQueue.connect();
      
      const result = await delayQueue.scheduleRecurring('test.recurring', {}, '0 3 * * *');
      const cancelled = delayQueue.cancelRecurring(result.taskId);
      
      expect(cancelled).toBe(true);
      expect(delayQueue.recurringTasks.size).toBe(0);
    });

    it('should return false for non-existent task', () => {
      const cancelled = delayQueue.cancelRecurring('non-existent');
      expect(cancelled).toBe(false);
    });
  });

  describe('registerHandler', () => {
    it('should register a task handler', async () => {
      await delayQueue.connect();
      
      const handler = jest.fn();
      await delayQueue.registerHandler('test.task', handler);
      
      expect(delayQueue.taskHandlers.has('test.task')).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return queue statistics', async () => {
      const stats = await delayQueue.getStats();
      
      expect(stats).toHaveProperty('scheduled');
      expect(stats).toHaveProperty('completed');
      expect(stats).toHaveProperty('failed');
      expect(stats).toHaveProperty('retried');
      expect(stats).toHaveProperty('deadLetter');
      expect(stats).toHaveProperty('activeHandlers');
      expect(stats).toHaveProperty('recurringTasks');
    });
  });

  describe('disconnect', () => {
    it('should disconnect gracefully', async () => {
      await delayQueue.connect();
      await delayQueue.disconnect();
      
      expect(delayQueue.isConnected).toBe(false);
    });

    it('should clear recurring tasks', async () => {
      await delayQueue.connect();
      await delayQueue.scheduleRecurring('test.recurring', {}, '0 3 * * *');
      
      await delayQueue.disconnect();
      
      expect(delayQueue.recurringTasks.size).toBe(0);
    });
  });
});

describe('getDelayQueue singleton', () => {
  beforeEach(() => {
    resetDelayQueue();
  });

  it('should return the same instance', () => {
    const instance1 = getDelayQueue();
    const instance2 = getDelayQueue();
    
    expect(instance1).toBe(instance2);
  });

  it('should create new instance after reset', () => {
    const instance1 = getDelayQueue();
    resetDelayQueue();
    const instance2 = getDelayQueue();
    
    expect(instance1).not.toBe(instance2);
  });
});
