const MemoryAdapter = require('../../backend/shared/adapters/MemoryAdapter');
const { createEventBus } = require('../../backend/shared/EventBusAdapter');

describe('MemoryAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.disconnect();
    }
  });

  describe('connect()', () => {
    it('should connect successfully', async () => {
      await adapter.connect();
      expect(adapter.isConnected).toBe(true);
    });

    it('should be idempotent', async () => {
      await adapter.connect();
      await adapter.connect();
      expect(adapter.isConnected).toBe(true);
    });
  });

  describe('publish()', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should publish event to queue', async () => {
      const event = { eventType: 'test', data: { foo: 'bar' } };
      await adapter.publish('test-topic', event);
      
      expect(adapter.metrics.published).toBe(1);
      expect(adapter.getQueueSize('test-topic')).toBe(1);
    });

    it('should reject when queue is full', async () => {
      adapter.maxQueueSize = 2;
      
      await adapter.publish('test-topic', { eventType: 'test1' });
      await adapter.publish('test-topic', { eventType: 'test2' });
      
      await expect(adapter.publish('test-topic', { eventType: 'test3' }))
        .rejects.toThrow('Queue test-topic is full');
    });
  });

  describe('subscribe()', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should receive published events', async () => {
      const receivedEvents = [];
      
      await adapter.subscribe('test-topic', async (event) => {
        receivedEvents.push(event);
      });

      const event = { eventType: 'test', data: { foo: 'bar' } };
      await adapter.publish('test-topic', event);

      // 等待消息投递
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(receivedEvents.length).toBe(1);
      expect(receivedEvents[0].eventType).toBe('test');
      expect(adapter.metrics.consumed).toBe(1);
    });

    it('should retry on handler error', async () => {
      adapter.retryAttempts = 3;
      adapter.retryDelay = 10;
      
      let attempts = 0;
      
      await adapter.subscribe('test-topic', async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Simulated error');
        }
      });

      await adapter.publish('test-topic', { eventType: 'test' });

      // 等待重试完成
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(attempts).toBe(3);
      expect(adapter.metrics.retries).toBe(2);
      expect(adapter.metrics.consumed).toBe(1);
    });

    it('should remove failed message after max retries', async () => {
      adapter.retryAttempts = 2;
      adapter.retryDelay = 10;
      
      await adapter.subscribe('test-topic', async () => {
        throw new Error('Always fails');
      });

      await adapter.publish('test-topic', { eventType: 'test' });

      // 等待重试完成
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(adapter.metrics.errors).toBeGreaterThan(0);
      expect(adapter.getQueueSize('test-topic')).toBe(0);
    });
  });

  describe('unsubscribe()', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should unsubscribe from topic', async () => {
      await adapter.subscribe('test-topic', () => {});
      expect(adapter.subscriptions.has('test-topic')).toBe(true);
      
      await adapter.unsubscribe('test-topic');
      expect(adapter.subscriptions.has('test-topic')).toBe(false);
    });

    it('should not receive events after unsubscribe', async () => {
      const receivedEvents = [];
      
      await adapter.subscribe('test-topic', (event) => {
        receivedEvents.push(event);
      });
      
      await adapter.unsubscribe('test-topic');
      
      await adapter.publish('test-topic', { eventType: 'test' });
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(receivedEvents.length).toBe(0);
    });
  });

  describe('healthCheck()', () => {
    it('should return healthy when connected', async () => {
      await adapter.connect();
      
      const health = await adapter.healthCheck();
      
      expect(health.healthy).toBe(true);
      expect(health.mode).toBe('memory');
    });

    it('should return unhealthy when disconnected', async () => {
      const health = await adapter.healthCheck();
      
      expect(health.healthy).toBe(false);
    });
  });

  describe('metrics', () => {
    beforeEach(async () => {
      await adapter.connect();
    });

    it('should track published events', async () => {
      await adapter.publish('topic1', { eventType: 'test1' });
      await adapter.publish('topic2', { eventType: 'test2' });
      
      expect(adapter.metrics.published).toBe(2);
    });

    it('should track consumed events', async () => {
      await adapter.subscribe('test-topic', () => {});
      await adapter.publish('test-topic', { eventType: 'test' });
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(adapter.metrics.consumed).toBe(1);
    });

    it('should reset metrics', async () => {
      await adapter.publish('test-topic', { eventType: 'test' });
      
      adapter.resetMetrics();
      
      expect(adapter.metrics.published).toBe(0);
    });
  });
});

describe('createEventBus', () => {
  it('should create EventBus with MemoryAdapter', async () => {
    const eventBus = createEventBus({ adapter: 'memory' });
    
    expect(eventBus.adapter).toBeInstanceOf(MemoryAdapter);
    expect(eventBus.adapter.constructor.name).toBe('MemoryAdapter');
    
    await eventBus.disconnect();
  });

  it('should throw error for unknown adapter', () => {
    expect(() => createEventBus({ adapter: 'unknown' }))
      .toThrow('Unknown adapter type: unknown');
  });

  it('should use EVENT_BUS_ADAPTER env variable', async () => {
    process.env.EVENT_BUS_ADAPTER = 'memory';
    
    const eventBus = createEventBus();
    
    expect(eventBus.adapter).toBeInstanceOf(MemoryAdapter);
    
    await eventBus.disconnect();
    delete process.env.EVENT_BUS_ADAPTER;
  });
});
