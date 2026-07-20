/**
 * 任务队列与死信队列单元测试
 * REQ-00519: 验证指数退避重试、DLQ 机制、监控告警
 */

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const { EventEmitter } = require('events');

// Mock dependencies
const mockRedis = {
    lpush: sinon.stub().resolves(1),
    rpush: sinon.stub().resolves(1),
    brpop: sinon.stub().resolves(null),
    llen: sinon.stub().resolves(0),
    lrange: sinon.stub().resolves([]),
    lrem: sinon.stub().resolves(1),
    rpop: sinon.stub().resolves(null),
    del: sinon.stub().resolves(1),
    expire: sinon.stub().resolves(1),
    zadd: sinon.stub().resolves(1),
    zrangebyscore: sinon.stub().resolves([]),
    zrem: sinon.stub().resolves(1),
    zcard: sinon.stub().resolves(0),
    keys: sinon.stub().resolves([]),
    get: sinon.stub().resolves(null),
    set: sinon.stub().resolves('OK')
};

// Stub Redis client
sinon.stub(require('ioredis'), 'Redis').callsFake(() => mockRedis);

const {
    TaskQueue,
    DeadLetterQueue,
    calculateRetryDelay,
    DEFAULT_RETRY_CONFIG,
    TASK_TYPE_CONFIGS
} = require('../taskQueue');

describe('TaskQueue - REQ-00519', () => {
    let taskQueue;
    
    beforeEach(() => {
        // Reset all stubs
        Object.values(mockRedis).forEach(stub => {
            if (stub.reset) stub.reset();
        });
        
        taskQueue = new TaskQueue(mockRedis);
    });

    describe('calculateRetryDelay', () => {
        it('should calculate exponential backoff correctly', () => {
            const config = DEFAULT_RETRY_CONFIG;
            
            // Retry 0: base delay + jitter
            const delay0 = calculateRetryDelay(0, config);
            expect(delay0).to.be.at.least(config.initialDelayMs);
            expect(delay0).to.be.at.most(config.initialDelayMs + config.jitterMs);
            
            // Retry 1: 2x base + jitter
            const delay1 = calculateRetryDelay(1, config);
            expect(delay1).to.be.at.least(config.initialDelayMs * 2);
            
            // Retry 2: 4x base + jitter
            const delay2 = calculateRetryDelay(2, config);
            expect(delay2).to.be.at.least(config.initialDelayMs * 4);
        });

        it('should cap at maxDelayMs', () => {
            const config = { ...DEFAULT_RETRY_CONFIG, maxDelayMs: 10000 };
            
            // High retry count should hit the cap
            const delay = calculateRetryDelay(10, config);
            expect(delay).to.be.at.most(config.maxDelayMs + config.jitterMs);
        });

        it('should add random jitter', () => {
            const config = DEFAULT_RETRY_CONFIG;
            const delays = new Set();
            
            // Calculate multiple delays for same retry count
            for (let i = 0; i < 10; i++) {
                delays.add(calculateRetryDelay(1, config));
            }
            
            // Should have variation due to jitter
            expect(delays.size).to.be.greaterThan(1);
        });
    });

    describe('TaskQueue', () => {
        describe('enqueue', () => {
            it('should enqueue task successfully', async () => {
                const taskId = await taskQueue.enqueue('push_notification', {
                    userId: 'test123',
                    message: 'Test notification'
                });
                
                expect(taskId).to.be.a('string');
                expect(mockRedis.lpush.calledOnce).to.be.true;
            });

            it('should enqueue scheduled task', async () => {
                const scheduledAt = new Date(Date.now() + 60000);
                const taskId = await taskQueue.enqueue('push_notification', 
                    { userId: 'test123' },
                    { scheduledAt: scheduledAt.toISOString() }
                );
                
                expect(taskId).to.be.a('string');
                expect(mockRedis.zadd.calledOnce).to.be.true;
            });

            it('should emit task:enqueued event', async () => {
                const eventSpy = sinon.spy();
                taskQueue.on('task:enqueued', eventSpy);
                
                await taskQueue.enqueue('push_notification', { userId: 'test123' });
                
                expect(eventSpy.calledOnce).to.be.true;
            });
        });

        describe('dequeue', () => {
            it('should return null when queue is empty', async () => {
                mockRedis.brpop.resolves(null);
                
                const task = await taskQueue.dequeue('push_notification');
                
                expect(task).to.be.null;
                expect(mockRedis.brpop.calledOnce).to.be.true;
            });

            it('should return task when available', async () => {
                const mockTask = {
                    id: 'test-id',
                    taskType: 'push_notification',
                    taskData: { userId: 'test123' },
                    retryCount: 0
                };
                
                mockRedis.brpop.resolves(['queue', JSON.stringify(mockTask)]);
                
                const task = await taskQueue.dequeue('push_notification');
                
                expect(task).to.deep.equal(mockTask);
            });
        });

        describe('registerProcessor', () => {
            it('should register processor', () => {
                const processor = sinon.stub().resolves({ success: true });
                taskQueue.registerProcessor('test_task', processor);
                
                expect(taskQueue.processors.has('test_task')).to.be.true;
            });
        });

        describe('processTask', () => {
            it('should process task successfully', async () => {
                const processor = sinon.stub().resolves({ success: true });
                taskQueue.registerProcessor('test_task', processor);
                
                const task = {
                    id: 'test-id',
                    taskType: 'test_task',
                    taskData: { data: 'test' },
                    retryCount: 0,
                    maxRetries: 3
                };
                
                const result = await taskQueue.processTask(task);
                
                expect(result.success).to.be.true;
                expect(processor.calledOnce).to.be.true;
                expect(taskQueue.metrics.processed).to.equal(1);
            });

            it('should handle task failure with retry', async () => {
                const processor = sinon.stub().rejects(new Error('Processing failed'));
                taskQueue.registerProcessor('test_task', processor);
                
                const task = {
                    id: 'test-id',
                    taskType: 'test_task',
                    taskData: { data: 'test' },
                    retryCount: 0,
                    maxRetries: 3
                };
                
                const result = await taskQueue.processTask(task);
                
                expect(result.success).to.be.false;
                expect(result.retry).to.be.true;
                expect(taskQueue.metrics.retried).to.equal(1);
                expect(mockRedis.zadd.calledOnce).to.be.true;
            });

            it('should move task to DLQ after max retries', async () => {
                const processor = sinon.stub().rejects(new Error('Processing failed'));
                taskQueue.registerProcessor('test_task', processor);
                
                const task = {
                    id: 'test-id',
                    taskType: 'test_task',
                    taskData: { data: 'test' },
                    retryCount: 3,  // Already at max
                    maxRetries: 3
                };
                
                const result = await taskQueue.processTask(task);
                
                expect(result.success).to.be.false;
                expect(result.dlq).to.be.true;
                expect(taskQueue.metrics.dlqAdded).to.equal(1);
                expect(mockRedis.lpush.calledOnce).to.be.true;
            });

            it('should throw error if no processor registered', async () => {
                const task = {
                    id: 'test-id',
                    taskType: 'unknown_task',
                    taskData: {},
                    retryCount: 0,
                    maxRetries: 3
                };
                
                try {
                    await taskQueue.processTask(task);
                    expect.fail('Should have thrown error');
                } catch (error) {
                    expect(error.message).to.include('No processor registered');
                }
            });
        });

        describe('getQueueStats', () => {
            it('should return queue statistics', async () => {
                mockRedis.llen.resolves(10);
                mockRedis.zcard.resolves(5);
                mockRedis.keys.resolves(['dlq:test_task']);
                mockRedis.llen.onSecondCall().resolves(2);
                
                const stats = await taskQueue.getQueueStats('test_task');
                
                expect(stats.taskType).to.equal('test_task');
                expect(stats.pending).to.equal(10);
                expect(stats.scheduled).to.equal(5);
                expect(stats.metrics).to.exist;
            });
        });
    });

    describe('DeadLetterQueue', () => {
        let dlq;
        
        beforeEach(() => {
            dlq = new DeadLetterQueue(mockRedis);
        });

        describe('addToDLQ', () => {
            it('should add failed task to DLQ', async () => {
                const taskData = { userId: 'test123' };
                const error = new Error('Test error');
                
                const dlqId = await dlq.addToDLQ('push_notification', taskData, error, 3);
                
                expect(dlqId).to.be.a('string');
                expect(mockRedis.lpush.calledOnce).to.be.true;
                expect(mockRedis.expire.calledOnce).to.be.true;
            });

            it('should remove oldest item when DLQ size limit reached', async () => {
                const limitedDLQ = new DeadLetterQueue(mockRedis, { maxDLQSize: 100 });
                mockRedis.llen.resolves(100);
                
                await limitedDLQ.addToDLQ('test_task', {}, new Error('Test'), 1);
                
                expect(mockRedis.rpop.calledOnce).to.be.true;
            });
        });

        describe('getDLQItems', () => {
            it('should return DLQ items with pagination', async () => {
                const mockItems = [
                    JSON.stringify({ id: '1', taskType: 'test' }),
                    JSON.stringify({ id: '2', taskType: 'test' })
                ];
                mockRedis.lrange.resolves(mockItems);
                mockRedis.llen.resolves(2);
                
                const result = await dlq.getDLQItems('test_task', { limit: 10, offset: 0 });
                
                expect(result.items).to.have.lengthOf(2);
                expect(result.total).to.equal(2);
                expect(result.items[0].id).to.equal('1');
            });
        });

        describe('removeFromDLQ', () => {
            it('should remove task from DLQ', async () => {
                const mockItems = [
                    JSON.stringify({ id: 'target-id', taskType: 'test' })
                ];
                mockRedis.lrange.resolves(mockItems);
                
                const removed = await dlq.removeFromDLQ('test_task', 'target-id');
                
                expect(removed).to.be.true;
                expect(mockRedis.lrem.calledOnce).to.be.true;
            });

            it('should return false if task not found', async () => {
                mockRedis.lrange.resolves([]);
                
                const removed = await dlq.removeFromDLQ('test_task', 'nonexistent');
                
                expect(removed).to.be.false;
            });
        });

        describe('clearDLQ', () => {
            it('should clear entire DLQ for task type', async () => {
                mockRedis.llen.resolves(10);
                
                const count = await dlq.clearDLQ('test_task');
                
                expect(count).to.equal(10);
                expect(mockRedis.del.calledOnce).to.be.true;
            });
        });

        describe('getDLQStats', () => {
            it('should return stats for all DLQs', async () => {
                mockRedis.keys.resolves(['dlq:test_task', 'dlq:other_task']);
                mockRedis.llen.onFirstCall().resolves(5);
                mockRedis.llen.onSecondCall().resolves(3);
                mockRedis.lrange.resolves([JSON.stringify({ failedAt: new Date().toISOString() })]);
                
                const stats = await dlq.getDLQStats();
                
                expect(stats).to.have.property('test_task');
                expect(stats).to.have.property('other_task');
            });
        });
    });

    describe('TaskQueueMonitor', () => {
        let monitor;
        
        beforeEach(() => {
            const TaskQueueMonitor = require('../taskQueue').TaskQueueMonitor;
            monitor = new TaskQueueMonitor(taskQueue, {
                alertThresholds: {
                    dlqSize: 100,
                    dlqAge: 3600,
                    queueBacklog: 1000
                }
            });
        });

        describe('checkAlerts', () => {
            it('should alert when DLQ size exceeds threshold', async () => {
                taskQueue.getQueueStats = sinon.stub().resolves({
                    taskType: 'test_task',
                    pending: 0,
                    scheduled: 0,
                    dlq: { size: 150 }
                });
                
                const alerts = await monitor.checkAlerts('test_task');
                
                expect(alerts).to.have.lengthOf.at.least(1);
                expect(alerts[0].type).to.equal('dlq_size_exceeded');
            });

            it('should alert when queue backlog exceeds threshold', async () => {
                taskQueue.getQueueStats = sinon.stub().resolves({
                    taskType: 'test_task',
                    pending: 1500,
                    scheduled: 0,
                    dlq: { size: 0 }
                });
                
                const alerts = await monitor.checkAlerts('test_task');
                
                expect(alerts).to.have.lengthOf.at.least(1);
                expect(alerts[0].type).to.equal('queue_backlog_exceeded');
            });

            it('should not alert when within thresholds', async () => {
                taskQueue.getQueueStats = sinon.stub().resolves({
                    taskType: 'test_task',
                    pending: 10,
                    scheduled: 5,
                    dlq: { size: 5, oldestItemAge: 100 }
                });
                
                const alerts = await monitor.checkAlerts('test_task');
                
                expect(alerts).to.have.lengthOf(0);
            });
        });
    });

    describe('EventEmitter integration', () => {
        it('should emit events for task lifecycle', async () => {
            const events = [];
            
            taskQueue.on('task:enqueued', () => events.push('enqueued'));
            taskQueue.on('task:completed', () => events.push('completed'));
            taskQueue.on('task:retry', () => events.push('retry'));
            taskQueue.on('task:dlq', () => events.push('dlq'));
            
            // Test enqueue
            await taskQueue.enqueue('test', { data: 'test' });
            expect(events).to.include('enqueued');
            
            // Test completed
            taskQueue.registerProcessor('test', async () => ({ success: true }));
            await taskQueue.processTask({
                id: 'test',
                taskType: 'test',
                taskData: {},
                retryCount: 0,
                maxRetries: 3
            });
            expect(events).to.include('completed');
        });
    });
});

describe('TASK_TYPE_CONFIGS', () => {
    it('should have valid configurations for all task types', () => {
        for (const [type, config] of Object.entries(TASK_TYPE_CONFIGS)) {
            expect(config).to.have.property('maxRetries');
            expect(config).to.have.property('initialDelayMs');
            expect(config).to.have.property('maxDelayMs');
            expect(config.maxRetries).to.be.at.least(1);
            expect(config.initialDelayMs).to.be.at.least(100);
            expect(config.maxDelayMs).to.be.at.least(config.initialDelayMs);
        }
    });

    it('should have default configuration', () => {
        expect(TASK_TYPE_CONFIGS).to.have.property('default');
        expect(TASK_TYPE_CONFIGS.default).to.deep.equal(DEFAULT_RETRY_CONFIG);
    });
});
