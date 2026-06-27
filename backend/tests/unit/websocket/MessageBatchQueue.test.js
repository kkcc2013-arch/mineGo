/**
 * MessageBatchQueue 单元测试
 * REQ-00329: WebSocket 连接池与消息批处理性能优化
 */

'use strict';

const { MessageBatchQueue } = require('../../../shared/websocket/MessageBatchQueue');

// Mock Connection Pool
class MockConnectionPool {
  constructor() {
    this.sentMessages = [];
  }

  async sendToUser(userId, messages, options) {
    this.sentMessages.push({
      userId,
      messages,
      options
    });
    return { sent: messages.length };
  }
}

describe('MessageBatchQueue', () => {
  let queue;
  let mockPool;

  beforeEach(() => {
    mockPool = new MockConnectionPool();
    queue = new MessageBatchQueue({
      maxBatchSize: 10,
      maxBatchDelay: 100,
      maxQueueSize: 100,
      enableBackpressure: true
    }, mockPool);
  });

  afterEach(() => {
    // 清理所有定时器
    queue.flushTimers.forEach(timer => clearTimeout(timer));
  });

  describe('enqueue', () => {
    test('should enqueue message successfully', () => {
      const result = queue.enqueue('user123', { type: 'test', data: 'hello' });

      expect(result.queued).toBe(true);
      expect(result.queueSize).toBe(1);
    });

    test('should queue multiple messages', () => {
      queue.enqueue('user123', { type: 'test1' });
      queue.enqueue('user123', { type: 'test2' });
      queue.enqueue('user123', { type: 'test3' });

      const status = queue.getQueueStatus('user123');
      expect(status.size).toBe(3);
    });

    test('should send immediately with immediate option', () => {
      queue.enqueue('user123', { type: 'test' }, { immediate: true });

      expect(mockPool.sentMessages.length).toBe(1);
      expect(mockPool.sentMessages[0].userId).toBe('user123');
    });

    test('should flush immediately on high priority', () => {
      queue.enqueue('user123', { type: 'test' }, { priority: 'high' });

      expect(mockPool.sentMessages.length).toBe(1);
    });

    test('should auto-flush when reaching max batch size', async () => {
      for (let i = 0; i < 10; i++) {
        queue.enqueue('user123', { type: `test${i}` });
      }

      // 等待异步刷新
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockPool.sentMessages.length).toBe(1);
      expect(mockPool.sentMessages[0].messages.length).toBe(10);
    });
  });

  describe('enqueueBatch', () => {
    test('should enqueue batch of messages', () => {
      const messages = [
        { type: 'test1' },
        { type: 'test2' },
        { type: 'test3' }
      ];

      const result = queue.enqueueBatch('user123', messages);

      expect(result.total).toBe(3);
      expect(result.queued).toBe(3);
    });
  });

  describe('flushQueue', () => {
    test('should flush queue manually', async () => {
      queue.enqueue('user123', { type: 'test1' });
      queue.enqueue('user123', { type: 'test2' });

      await queue.flushQueue('user123');

      expect(mockPool.sentMessages.length).toBe(1);
      expect(mockPool.sentMessages[0].messages.length).toBe(2);
    });

    test('should clear timer after flush', async () => {
      queue.enqueue('user123', { type: 'test' });

      await queue.flushQueue('user123');

      expect(queue.flushTimers.has('user123')).toBe(false);
    });

    test('should do nothing for empty queue', async () => {
      await queue.flushQueue('unknown_user');

      expect(mockPool.sentMessages.length).toBe(0);
    });
  });

  describe('backpressure', () => {
    test('should apply backpressure when queue is full', () => {
      // 填满队列
      for (let i = 0; i < 100; i++) {
        queue.enqueue('user123', { type: 'test' });
      }

      // 再添加一条消息
      const result = queue.enqueue('user123', { type: 'overflow' });

      expect(result.queued).toBe(false);
      expect(result.reason).toBe('queue_full');
      expect(queue.metrics.backpressureEvents).toBe(1);
    });

    test('should drop low priority messages on backpressure', () => {
      // 填满队列
      for (let i = 0; i < 100; i++) {
        queue.enqueue('user123', { type: 'test' }, { priority: 'normal' });
      }

      // 触发背压
      queue.enqueue('user123', { type: 'overflow' });

      // 队列应该只保留非低优先级消息
      const status = queue.getQueueStatus('user123');
      expect(status.size).toBeLessThan(100);
    });
  });

  describe('priority sorting', () => {
    test('should prioritize messages by priority', async () => {
      queue.enqueue('user123', { type: 'low' }, { priority: 'low' });
      queue.enqueue('user123', { type: 'high' }, { priority: 'high' });
      queue.enqueue('user123', { type: 'normal' }, { priority: 'normal' });

      await queue.flushQueue('user123');

      const messages = mockPool.sentMessages[0].messages;
      expect(messages[0].priority).toBe('high');
      expect(messages[1].priority).toBe('normal');
      expect(messages[2].priority).toBe('low');
    });
  });

  describe('getQueueStatus', () => {
    test('should return status for specific user', () => {
      queue.enqueue('user123', { type: 'test' });

      const status = queue.getQueueStatus('user123');

      expect(status.exists).toBe(true);
      expect(status.userId).toBe('user123');
      expect(status.size).toBe(1);
    });

    test('should return all queues status', () => {
      queue.enqueue('user1', { type: 'test' });
      queue.enqueue('user2', { type: 'test' });

      const status = queue.getQueueStatus();

      expect(status.totalQueues).toBe(2);
      expect(status.queues.length).toBe(2);
    });
  });

  describe('clearQueue', () => {
    test('should clear queue for user', () => {
      queue.enqueue('user123', { type: 'test1' });
      queue.enqueue('user123', { type: 'test2' });

      queue.clearQueue('user123');

      const status = queue.getQueueStatus('user123');
      expect(status.exists).toBe(false);
      expect(queue.metrics.totalDropped).toBe(2);
    });
  });

  describe('flushAll', () => {
    test('should flush all queues', async () => {
      queue.enqueue('user1', { type: 'test' });
      queue.enqueue('user2', { type: 'test' });
      queue.enqueue('user3', { type: 'test' });

      await queue.flushAll();

      expect(mockPool.sentMessages.length).toBe(3);
    });
  });

  describe('getStats', () => {
    test('should return statistics', () => {
      queue.enqueue('user123', { type: 'test' });

      const stats = queue.getStats();

      expect(stats.totalEnqueued).toBe(1);
      expect(stats.activeQueues).toBe(1);
    });
  });
});

// 运行测试
if (typeof describe !== 'undefined') {
  // Jest/Mocha 环境
} else {
  console.log('Run this test file with Jest or Mocha');
}