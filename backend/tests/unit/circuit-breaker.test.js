// backend/tests/unit/circuit-breaker.test.js
'use strict';
const assert = require('assert');
const { CircuitBreaker, CircuitBreakerManager, STATES } = require('../../shared/CircuitBreaker');
const { FallbackStrategy, FallbackStrategies } = require('../../shared/FallbackStrategy');

console.log('=== Circuit Breaker Unit Tests ===\n');

let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    testsPassed++;
  } catch (err) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${err.message}`);
    testsFailed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    testsPassed++;
  } catch (err) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${err.message}`);
    testsFailed++;
  }
}

// ============================================================
// CircuitBreaker Tests
// ============================================================

console.log('\n--- CircuitBreaker Basic Tests ---\n');

test('should initialize with CLOSED state', () => {
  const cb = new CircuitBreaker({ name: 'test' });
  assert.strictEqual(cb.state, STATES.CLOSED);
  assert.strictEqual(cb.failures, 0);
  assert.strictEqual(cb.successes, 0);
});

test('should initialize with custom config', () => {
  const cb = new CircuitBreaker({
    name: 'test',
    failureThreshold: 10,
    successThreshold: 3,
    timeout: 30000
  });
  assert.strictEqual(cb.failureThreshold, 10);
  assert.strictEqual(cb.successThreshold, 3);
  assert.strictEqual(cb.timeout, 30000);
});

console.log('\n--- CircuitBreaker Execution Tests ---\n');

(async () => {
  await asyncTest('should execute function when CLOSED', async () => {
    const cb = new CircuitBreaker({ name: 'test' });
    const result = await cb.execute(() => Promise.resolve('success'));
    assert.strictEqual(result, 'success');
    assert.strictEqual(cb.state, STATES.CLOSED);
  });

  await asyncTest('should count failures', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
    
    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch (err) {
      // Expected
    }
    
    assert.strictEqual(cb.failures, 1);
    assert.strictEqual(cb.state, STATES.CLOSED);
  });

  await asyncTest('should open after reaching failure threshold', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
    
    for (let i = 0; i < 3; i++) {
      try {
        await cb.execute(() => Promise.reject(new Error('fail')));
      } catch (err) {
        // Expected
      }
    }
    
    assert.strictEqual(cb.state, STATES.OPEN);
    assert.ok(cb.nextAttempt > Date.now());
  });

  await asyncTest('should reject calls when OPEN', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, timeout: 60000 });
    
    // Trip the circuit
    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch (err) {
      // Expected
    }
    
    // Should reject
    try {
      await cb.execute(() => Promise.resolve('success'));
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.code, 'CIRCUIT_OPEN');
    }
  });

  await asyncTest('should transition to HALF_OPEN after timeout', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, timeout: 100 });
    
    // Trip the circuit
    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch (err) {
      // Expected
    }
    
    assert.strictEqual(cb.state, STATES.OPEN);
    
    // Wait for timeout
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Next call should transition to HALF_OPEN
    try {
      await cb.execute(() => Promise.resolve('success'));
    } catch (err) {
      // Might fail in half-open, that's ok
    }
    
    assert.ok(cb.state === STATES.HALF_OPEN || cb.state === STATES.CLOSED);
  });

  await asyncTest('should close after success threshold in HALF_OPEN', async () => {
    const cb = new CircuitBreaker({ 
      name: 'test', 
      failureThreshold: 1, 
      successThreshold: 2,
      timeout: 100 
    });
    
    // Trip the circuit
    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch (err) {
      // Expected
    }
    
    // Wait for timeout
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Succeed twice
    await cb.execute(() => Promise.resolve('success'));
    await cb.execute(() => Promise.resolve('success'));
    
    assert.strictEqual(cb.state, STATES.CLOSED);
    assert.strictEqual(cb.failures, 0);
    assert.strictEqual(cb.successes, 0);
  });

  await asyncTest('should reopen on failure in HALF_OPEN', async () => {
    const cb = new CircuitBreaker({ 
      name: 'test', 
      failureThreshold: 1, 
      successThreshold: 2,
      timeout: 100 
    });
    
    // Trip the circuit
    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch (err) {
      // Expected
    }
    
    // Wait for timeout
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // First call transitions to HALF_OPEN
    try {
      await cb.execute(() => Promise.resolve('success'));
    } catch (err) {
      // Expected
    }
    
    // Failure in HALF_OPEN should immediately trip
    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch (err) {
      // Expected
    }
    
    assert.strictEqual(cb.state, STATES.OPEN);
  });
})();

console.log('\n--- CircuitBreaker Stats Tests ---\n');

test('should track stats correctly', () => {
  const cb = new CircuitBreaker({ name: 'test' });
  const status = cb.getStatus();
  
  assert.ok(status.name);
  assert.ok(status.state);
  assert.ok(typeof status.failures === 'number');
  assert.ok(typeof status.stats.totalCalls === 'number');
});

test('should reset correctly', () => {
  const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1 });
  
  // Manually trip
  cb.onFailure(new Error('test'));
  
  assert.strictEqual(cb.state, STATES.OPEN);
  
  // Reset
  cb.reset();
  
  assert.strictEqual(cb.state, STATES.CLOSED);
  assert.strictEqual(cb.failures, 0);
  assert.strictEqual(cb.successes, 0);
});

console.log('\n--- CircuitBreakerManager Tests ---\n');

test('should create and retrieve circuit breakers', () => {
  const manager = new CircuitBreakerManager();
  
  const cb1 = manager.getOrCreate('service1', { failureThreshold: 5 });
  const cb2 = manager.getOrCreate('service1'); // Should return existing
  const cb3 = manager.getOrCreate('service2');
  
  assert.strictEqual(cb1, cb2);
  assert.notStrictEqual(cb1, cb3);
  assert.strictEqual(manager.breakers.size, 2);
});

test('should get all status', () => {
  const manager = new CircuitBreakerManager();
  
  manager.getOrCreate('service1');
  manager.getOrCreate('service2');
  
  const status = manager.getAllStatus();
  
  assert.ok(status.service1);
  assert.ok(status.service2);
});

console.log('\n--- FallbackStrategy Tests ---\n');

(async () => {
  await asyncTest('emptyData strategy should return empty array', async () => {
    const result = await FallbackStrategies.emptyData.execute({}, new Error('test'));
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, []);
    assert.strictEqual(result.fallback, true);
  });

  await asyncTest('defaultValue strategy should return default value', async () => {
    const ctx = { defaultValue: { value: 42 } };
    const result = await FallbackStrategies.defaultValue.execute(ctx, new Error('test'));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.value, 42);
  });

  await asyncTest('skip strategy should return skipped status', async () => {
    const result = await FallbackStrategies.skip.execute({}, new Error('test'));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.skipped, true);
  });

  await asyncTest('silent strategy should return null', async () => {
    const result = await FallbackStrategies.silent.execute({}, new Error('test'));
    assert.strictEqual(result, null);
  });

  await asyncTest('propagate strategy should throw', async () => {
    try {
      await FallbackStrategies.propagate.execute({}, new Error('test'));
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'test');
    }
  });

  await asyncTest('custom strategy should work', async () => {
    const custom = new FallbackStrategy({
      name: 'custom',
      handler: async (ctx) => ({ custom: true, value: ctx.value })
    });
    
    const result = await custom.execute({ value: 123 }, new Error('test'));
    assert.strictEqual(result.custom, true);
    assert.strictEqual(result.value, 123);
  });
})();

console.log('\n--- Event Emission Tests ---\n');

(async () => {
  await asyncTest('should emit "open" event', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1 });
    
    let eventFired = false;
    cb.on('open', () => { eventFired = true; });
    
    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch (err) {
      // Expected
    }
    
    assert.ok(eventFired);
  });

  await asyncTest('should emit "close" event', async () => {
    const cb = new CircuitBreaker({ 
      name: 'test', 
      failureThreshold: 1, 
      successThreshold: 1,
      timeout: 100 
    });
    
    let closeFired = false;
    cb.on('close', () => { closeFired = true; });
    
    // Trip
    try {
      await cb.execute(() => Promise.reject(new Error('fail')));
    } catch (err) {}
    
    // Wait for timeout
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Succeed
    await cb.execute(() => Promise.resolve('success'));
    
    assert.ok(closeFired);
  });
})();

// Wait for async tests to complete
setTimeout(() => {
  console.log('\n=== Test Results ===');
  console.log(`Passed: ${testsPassed}`);
  console.log(`Failed: ${testsFailed}`);
  console.log(`Total: ${testsPassed + testsFailed}`);
  
  if (testsFailed > 0) {
    console.log('\n❌ Some tests failed!');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  }
}, 500);
