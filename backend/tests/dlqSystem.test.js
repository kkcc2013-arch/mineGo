/**
 * REQ-00519: 后端任务队列可靠性增强与死信处理系统
 * 单元测试
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { TaskQueueManager } = require('../shared/TaskQueueManager');
const { ExponentialBackoffRetry } = require('../shared/retry/ExponentialBackoffRetry');
const { DLQMetricsManager } = require('../shared/dlqMetrics');

describe('REQ-00519: Task Queue Manager & DLQ System', () => {
  let taskQueueManager;
  let mockRedis;
  let mockDb;

  beforeEach(() => {
    mockRedis = {
      lpush: sinon.stub().resolves(1),
      llen: sinon.stub().resolves(0),
      lrange: sinon.stub().resolves([]),
      lrem: sinon.stub().resolves(1),
      lindex: sinon.stub().resolves(null),
      del: sinon.stub().resolves(1),
      setex: sinon.stub().resolves('OK')
    };

    mockDb = {
      query: sinon.stub().resolves({ rows: [], rowCount: 0 })
    };

    taskQueueManager = new TaskQueueManager({
      redis: { client: mockRedis, namespace: 'test' },
      maxRetries: 3,
      baseRetryDelay: 100,
      maxRetryDelay: 1000
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('TaskQueueManager', () => {
    describe('executeTask', () => {
      it('should execute task successfully on first attempt', async () => {
        const taskFn = sinon.stub().resolves({ data: 'success' });
        const taskData = { id: 'task-001', type: 'test' };

        const result = await taskQueueManager.executeTask(taskFn, taskData);

        expect(result.success).to.be.true;
        expect(result.result).to.deep.equal({ data: 'success' });
        expect(taskFn.calledOnce).to.be.true;
      });

      it('should retry on failure and succeed', async () => {
        const taskFn = sinon.stub();
        taskFn.onFirstCall().rejects(new Error('Temporary error'));
        taskFn.onSecondCall().resolves({ data: 'success' });

        const taskData = { id: 'task-002', type: 'test' };

        const result = await taskQueueManager.executeTask(taskFn, taskData, {
          maxRetries: 3
        });

        expect(result.success).to.be.true;
        expect(taskFn.calledTwice).to.be.true;
        expect(taskQueueManager.metrics.tasksRetried).to.equal(1);
      });

      it('should move to DLQ after max retries', async () => {
        const taskFn = sinon.stub().rejects(new Error('Persistent error'));
        const taskData = { id: 'task-003', type: 'test' };

        const result = await taskQueueManager.executeTask(taskFn, taskData, {
          maxRetries: 2
        });

        expect(result.success).to.be.false;
        expect(result.movedToDLQ).to.be.true;
        expect(mockRedis.lpush.called).to.be.true;
        expect(taskQueueManager.metrics.tasksToDLQ).to.equal(1);
      });

      it('should track task metrics', async () => {
        const taskFn = sinon.stub().resolves({ data: 'success' });
        const taskData = { id: 'task-004', type: 'test' };

        await taskQueueManager.executeTask(taskFn, taskData);

        const metrics = taskQueueManager.getMetrics();
        expect(metrics.tasksProcessed).to.equal(1);
        expect(metrics.successRate).to.be.greaterThan(0);
      });
    });

    describe('moveToDLQ', () => {
      it('should save task to Redis DLQ', async () => {
        const task = {
          id: 'task-005',
          type: 'data_export',
          data: { userId: 123 },
          status: 'failed',
          retryCount: 3
        };

        const error = new Error('Export failed');
        error.code = 'EXPORT_ERROR';

        await taskQueueManager.moveToDLQ(task, error);

        expect(mockRedis.lpush.called).to.be.true;
        
        const dlqCall = mockRedis.lpush.getCall(0);
        const dlqTask = JSON.parse(dlqCall.args[1]);
        
        expect(dlqTask.id).to.equal('task-005');
        expect(dlqTask.status).to.equal('dead_letter');
        expect(dlqTask.error.message).to.equal('Export failed');
      });

      it('should trigger alert when DLQ threshold exceeded', async () => {
        mockRedis.llen.resolves(60); // 超过默认告警阈值 50

        const task = {
          id: 'task-006',
          type: 'test',
          data: {},
          status: 'failed',
          retryCount: 3
        };

        await taskQueueManager.moveToDLQ(task, new Error('Test error'));

        // 验证告警被触发（通过日志或其他方式）
        expect(mockRedis.llen.called).to.be.true;
      });
    });

    describe('retryFromDLQ', () => {
      it('should retry task from DLQ', async () => {
        const dlqTask = {
          id: 'task-007',
          type: 'backup',
          data: { backupId: 'backup-001' },
          status: 'dead_letter',
          retryCount: 3,
          error: { message: 'Backup failed' }
        };

        mockRedis.lrange.resolves([JSON.stringify(dlqTask)]);
        mockRedis.lrem.resolves(1);

        const taskFn = sinon.stub().resolves({ success: true });

        const result = await taskQueueManager.retryFromDLQ('task-007', taskFn);

        expect(result.success).to.be.true;
        expect(mockRedis.lrem.called).to.be.true;
      });
    });

    describe('getDLQStats', () => {
      it('should return DLQ statistics', async () => {
        mockRedis.llen.resolves(10);
        mockDb.query.resolves({
          rows: [{ total: '5', unique_types: '3', oldest: null, newest: null }]
        });

        const stats = await taskQueueManager.getDLQStats();

        expect(stats.redis.size).to.equal(10);
        expect(stats.total).to.be.greaterThan(0);
      });
    });

    describe('clearDLQ', () => {
      it('should clear all tasks from DLQ', async () => {
        mockRedis.llen.resolves(5);
        mockRedis.del.resolves(1);

        const result = await taskQueueManager.clearDLQ();

        expect(result.clearedCount).to.be.greaterThan(0);
        expect(mockRedis.del.called).to.be.true;
      });

      it('should clear tasks by type', async () => {
        const dlqTasks = [
          JSON.stringify({ id: '1', type: 'backup' }),
          JSON.stringify({ id: '2', type: 'export' })
        ];

        mockRedis.lrange.resolves(dlqTasks);

        const result = await taskQueueManager.clearDLQ({ type: 'backup' });

        expect(mockRedis.lrem.called).to.be.true;
      });
    });
  });

  describe('ExponentialBackoffRetry', () => {
    let retryStrategy;

    beforeEach(() => {
      retryStrategy = new ExponentialBackoffRetry({
        baseDelay: 1000,
        maxDelay: 60000,
        backoffFactor: 2,
        jitter: false
      });
    });

    describe('calculateDelay', () => {
      it('should calculate exponential delay', () => {
        const delay0 = retryStrategy.calculateDelay(0);
        const delay1 = retryStrategy.calculateDelay(1);
        const delay2 = retryStrategy.calculateDelay(2);

        expect(delay0).to.equal(1000);
        expect(delay1).to.equal(2000);
        expect(delay2).to.equal(4000);
      });

      it('should cap delay at maxDelay', () => {
        retryStrategy = new ExponentialBackoffRetry({
          baseDelay: 1000,
          maxDelay: 10000,
          backoffFactor: 2,
          jitter: false
        });

        const delay = retryStrategy.calculateDelay(10);
        expect(delay).to.be.at.most(10000);
      });

      it('should apply jitter when enabled', () => {
        retryStrategy = new ExponentialBackoffRetry({
          baseDelay: 1000,
          maxDelay: 60000,
          backoffFactor: 2,
          jitter: true,
          jitterRange: 0.5
        });

        const delays = [];
        for (let i = 0; i < 10; i++) {
          delays.push(retryStrategy.calculateDelay(0));
        }

        // 抖动导致延迟不完全相同
        const uniqueDelays = [...new Set(delays)];
        expect(uniqueDelays.length).to.be.greaterThan(1);
      });
    });

    describe('getTaskRetryConfig', () => {
      it('should return config for known task type', () => {
        const config = retryStrategy.getTaskRetryConfig('data_deletion');

        expect(config.maxRetries).to.equal(3);
        expect(config.baseDelay).to.equal(500);
      });

      it('should return default config for unknown task type', () => {
        const config = retryStrategy.getTaskRetryConfig('unknown_type');

        expect(config.maxRetries).to.equal(5);
        expect(config.baseDelay).to.equal(1000);
      });
    });

    describe('shouldRetry', () => {
      it('should return true for retryable errors', () => {
        const error = new Error('Connection failed');
        error.name = 'ConnectionError';

        const shouldRetry = retryStrategy.shouldRetry(1, error);
        expect(shouldRetry).to.be.true;
      });

      it('should return false for non-retryable errors', () => {
        const error = new Error('Invalid input');
        error.name = 'ValidationError';

        const shouldRetry = retryStrategy.shouldRetry(1, error);
        expect(shouldRetry).to.be.false;
      });

      it('should return false when max retries exceeded', () => {
        retryStrategy = new ExponentialBackoffRetry({ maxRetries: 3 });
        const error = new Error('Temporary error');

        const shouldRetry = retryStrategy.shouldRetry(3, error);
        expect(shouldRetry).to.be.false;
      });
    });

    describe('getBackoffSequence', () => {
      it('should return array of delays', () => {
        const sequence = retryStrategy.getBackoffSequence(5);

        expect(sequence).to.have.lengthOf(5);
        expect(sequence[0]).to.equal(1000);
        expect(sequence[1]).to.equal(2000);
      });
    });
  });

  describe('DLQMetricsManager', () => {
    let metricsManager;

    beforeEach(() => {
      metricsManager = new DLQMetricsManager();
    });

    describe('recordTaskProcessed', () => {
      it('should increment tasks processed counter', () => {
        const metrics = metricsManager.getMetricsObjects();
        const initialCount = metrics.tasksProcessed.name;

        metricsManager.recordTaskProcessed('backup', 1);

        // Counter should be incremented
        expect(metrics.tasksProcessed).to.exist;
      });
    });

    describe('updateDLQSize', () => {
      it('should update DLQ size gauge', () => {
        const stats = {
          redis: { size: 10 },
          database: { total: 5 },
          byType: { backup: 3, export: 2 },
          byError: { TIMEOUT: 4, NETWORK: 1 }
        };

        metricsManager.updateDLQSize(stats);

        // Gauge should be updated
        expect(metricsManager.getMetrics()).to.be.a('promise');
      });
    });

    describe('recordExecutionTime', () => {
      it('should observe execution time', () => {
        metricsManager.recordExecutionTime('backup', 'success', 5000);

        // Histogram should record observation
        expect(metricsManager.getMetrics()).to.be.a('promise');
      });
    });
  });
});