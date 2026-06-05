// backend/tests/unit/event-bus.test.js
'use strict';

const assert = require('assert');
const { EventBus, getEventBus } = require('../../shared/EventBus');
const { EventTypes, createEvent, EventBuilders, Topics } = require('../../shared/events');

// Mock Kafka for testing
class MockKafka {
  constructor(config) {
    this.config = config;
  }
  
  producer() {
    return new MockProducer();
  }
  
  consumer(config) {
    return new MockConsumer(config);
  }
  
  admin() {
    return new MockAdmin();
  }
}

class MockProducer {
  async connect() {
    this.connected = true;
  }
  
  async send({ topic, messages }) {
    return messages.map((msg, idx) => ({
      partition: 0,
      baseOffset: idx.toString(),
    }));
  }
  
  async disconnect() {
    this.connected = false;
  }
}

class MockConsumer {
  constructor(config) {
    this.config = config;
    this.handlers = [];
  }
  
  async connect() {
    this.connected = true;
  }
  
  async subscribe({ topic }) {
    this.topic = topic;
  }
  
  async run({ eachMessage }) {
    this.eachMessage = eachMessage;
  }
  
  async disconnect() {
    this.connected = false;
  }
  
  // Test helper to simulate message
  async simulateMessage(topic, message) {
    if (this.eachMessage) {
      await this.eachMessage({
        topic,
        partition: 0,
        message: {
          offset: '0',
          value: Buffer.from(JSON.stringify(message)),
        },
      });
    }
  }
}

class MockAdmin {
  async connect() {}
  async listTopics() { return ['test-topic']; }
  async disconnect() {}
}

// Tests
console.log('Running EventBus unit tests...\n');

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    testsFailed++;
  }
}

// Test 1: EventBus creation
test('EventBus should be created with default config', () => {
  const eventBus = new EventBus();
  assert.ok(eventBus);
  assert.strictEqual(eventBus.clientId, 'minego-service');
  assert.deepStrictEqual(eventBus.brokers, ['localhost:9092']);
});

// Test 2: EventBus creation with custom config
test('EventBus should accept custom config', () => {
  const eventBus = new EventBus({
    clientId: 'test-service',
    brokers: ['kafka1:9092', 'kafka2:9092'],
  });
  assert.strictEqual(eventBus.clientId, 'test-service');
  assert.deepStrictEqual(eventBus.brokers, ['kafka1:9092', 'kafka2:9092']);
});

// Test 3: createEvent function
test('createEvent should create valid event', () => {
  const event = createEvent('test.event', { foo: 'bar' }, { userId: '123' });
  
  assert.ok(event.id);
  assert.strictEqual(event.type, 'test.event');
  assert.deepStrictEqual(event.data, { foo: 'bar' });
  assert.deepStrictEqual(event.metadata, { userId: '123' });
  assert.ok(event.timestamp);
  assert.strictEqual(event.version, '1.0');
});

// Test 4: EventBuilders.catchSuccess
test('EventBuilders.catchSuccess should create valid catch event', () => {
  const pokemon = { speciesId: 25, name: 'Pikachu', cp: 500 };
  const rewards = { xp: 100, stardust: 100, candy: 3 };
  const event = EventBuilders.catchSuccess('user-123', pokemon, rewards, 'session-456');
  
  assert.ok(event.id);
  assert.strictEqual(event.type, EventTypes.CATCH_SUCCESS);
  assert.strictEqual(event.data.userId, 'user-123');
  assert.deepStrictEqual(event.data.pokemon, pokemon);
  assert.deepStrictEqual(event.data.rewards, rewards);
  assert.strictEqual(event.data.sessionId, 'session-456');
});

// Test 5: EventTypes constants
test('EventTypes should have all required event types', () => {
  assert.ok(EventTypes.CATCH_SUCCESS);
  assert.ok(EventTypes.CATCH_FAILED);
  assert.ok(EventTypes.USER_LEVEL_UP);
  assert.ok(EventTypes.USER_ACHIEVEMENT);
  assert.ok(EventTypes.REWARD_GRANT);
  assert.ok(EventTypes.PAYMENT_SUCCESS);
});

// Test 6: Topics constants
test('Topics should have all required topics', () => {
  assert.ok(Topics.CATCH);
  assert.ok(Topics.USER);
  assert.ok(Topics.SOCIAL);
  assert.ok(Topics.REWARD);
  assert.ok(Topics.PAYMENT);
});

// Test 7: EventBus metrics
test('EventBus should track metrics', () => {
  const eventBus = new EventBus();
  const metrics = eventBus.getMetrics();
  
  assert.strictEqual(metrics.eventsPublished, 0);
  assert.strictEqual(metrics.eventsProcessed, 0);
  assert.strictEqual(metrics.eventsFailed, 0);
  assert.strictEqual(metrics.connected, false);
});

// Test 8: getEventBus singleton
test('getEventBus should return singleton instance', () => {
  const eventBus1 = getEventBus({ clientId: 'test1' });
  const eventBus2 = getEventBus({ clientId: 'test2' });
  
  assert.strictEqual(eventBus1, eventBus2);
  assert.strictEqual(eventBus1.clientId, 'test1'); // First config wins
});

// Test 9: Event ID uniqueness
test('Event IDs should be unique', () => {
  const event1 = createEvent('test', {});
  const event2 = createEvent('test', {});
  
  assert.notStrictEqual(event1.id, event2.id);
});

// Test 10: Event timestamp
test('Event should have valid timestamp', () => {
  const before = new Date().toISOString();
  const event = createEvent('test', {});
  const after = new Date().toISOString();
  
  assert.ok(event.timestamp >= before);
  assert.ok(event.timestamp <= after);
});

// Summary
console.log('\n---');
console.log(`Tests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);
console.log(`Total: ${testsPassed + testsFailed}`);

if (testsFailed > 0) {
  process.exit(1);
}

console.log('\n✓ All EventBus unit tests passed!');
