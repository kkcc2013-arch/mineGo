// backend/tests/unit/tracing.test.js
// REQ-00148: 分布式追踪与请求链路可视化系统 - 单元测试
'use strict';

const assert = require('assert');
const { startCriticalPath, getCriticalPaths, getPathDefinition } = require('../../shared/criticalPathTracing');

console.log('=== Tracing Module Unit Tests ===\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${error.message}`);
    failed++;
  }
}

// ============ Critical Path Tracing Tests ============

test('getCriticalPaths returns all defined paths', () => {
  const paths = getCriticalPaths();
  assert(paths.CATCH_POKEMON, 'CATCH_POKEMON path should exist');
  assert(paths.GYM_BATTLE, 'GYM_BATTLE path should exist');
  assert(paths.PAYMENT, 'PAYMENT path should exist');
  assert(paths.USER_REGISTER, 'USER_REGISTER path should exist');
  assert(paths.PVP_DUEL, 'PVP_DUEL path should exist');
  assert(paths.TRADE_POKEMON, 'TRADE_POKEMON path should exist');
});

test('getPathDefinition returns correct path', () => {
  const path = getPathDefinition('CATCH_POKEMON');
  assert(path, 'Path should be returned');
  assert.strictEqual(path.name, 'catch_pokemon_flow', 'Path name should match');
  assert(Array.isArray(path.steps), 'Steps should be an array');
  assert(path.steps.length > 0, 'Steps should not be empty');
  assert(path.expectedDurationMs > 0, 'Expected duration should be set');
});

test('getPathDefinition returns null for unknown path', () => {
  const path = getPathDefinition('UNKNOWN_PATH');
  assert.strictEqual(path, null, 'Should return null for unknown path');
});

test('startCriticalPath creates tracker for valid path', () => {
  const tracker = startCriticalPath('CATCH_POKEMON', { userId: 'test-user' });
  assert(tracker, 'Tracker should be created');
  assert(tracker.pathName === 'catch_pokemon_flow' || tracker.pathName === 'CATCH_POKEMON', 'Path name should be set');
  assert(typeof tracker.nextStep === 'function', 'nextStep should be a function');
  assert(typeof tracker.recordError === 'function', 'recordError should be a function');
  assert(typeof tracker.end === 'function', 'end should be a function');
});

test('startCriticalPath returns no-op tracker for unknown path', () => {
  const tracker = startCriticalPath('UNKNOWN_PATH');
  assert(tracker, 'Should return a tracker');
  // No-op tracker should have methods but do nothing
  tracker.nextStep('test').end();
  tracker.recordError(new Error('test'), 'test');
  const result = tracker.end();
  assert.strictEqual(result, null, 'No-op tracker should return null');
});

test('Critical path tracker tracks steps correctly', () => {
  const tracker = startCriticalPath('CATCH_POKEMON');
  
  // Execute steps
  tracker.nextStep('auth_check').end({ userId: 'test' });
  tracker.nextStep('location_verify').end({ lat: 1.0, lng: 2.0 });
  tracker.nextStep('spawn_fetch').end({ spawnId: 'spawn-123' });
  tracker.nextStep('catch_attempt').end({ success: true });
  tracker.nextStep('inventory_update').end({ slot: 1 });
  tracker.nextStep('db_save').end({ rowsAffected: 1 });
  tracker.nextStep('event_publish').end({ eventId: 'evt-123' });
  tracker.nextStep('xp_award').end({ xp: 100 });
  
  const result = tracker.end(true);
  
  assert(result, 'Result should be returned');
  assert.strictEqual(result.success, true, 'Should be successful');
  assert(result.totalDuration >= 0, 'Total duration should be non-negative');
  assert(result.stepTimings.length === 8, 'Should have 8 step timings');
});

test('Critical path tracker handles errors', () => {
  const tracker = startCriticalPath('CATCH_POKEMON');
  
  tracker.nextStep('auth_check').end();
  tracker.nextStep('location_verify').end();
  tracker.recordError(new Error('Spawn not found'), 'spawn_fetch');
  
  const result = tracker.end(false);
  
  assert(result, 'Result should be returned');
  assert.strictEqual(result.success, false, 'Should not be successful');
});

test('Critical path tracker handles early termination', () => {
  const tracker = startCriticalPath('PAYMENT');
  
  tracker.nextStep('auth_check').end();
  tracker.nextStep('order_validate').end();
  // Stop early without completing all steps
  
  const result = tracker.end(true);
  
  assert(result, 'Result should be returned');
  assert(result.completedSteps < result.totalSteps, 'Should have incomplete steps');
});

// ============ Tracing Middleware Tests ============

test('tracingMiddleware is exported', () => {
  const { tracingMiddleware } = require('../../shared/tracingMiddleware');
  assert(typeof tracingMiddleware === 'function', 'tracingMiddleware should be a function');
});

test('traceDbQuery is exported', () => {
  const { traceDbQuery } = require('../../shared/tracingMiddleware');
  assert(typeof traceDbQuery === 'function', 'traceDbQuery should be a function');
});

test('tracedFetch is exported', () => {
  const { tracedFetch } = require('../../shared/tracingMiddleware');
  assert(typeof tracedFetch === 'function', 'tracedFetch should be a function');
});

test('traceRedisOperation is exported', () => {
  const { traceRedisOperation } = require('../../shared/tracingMiddleware');
  assert(typeof traceRedisOperation === 'function', 'traceRedisOperation should be a function');
});

// ============ Tracing Init Tests ============

test('initTracing is exported', () => {
  const { initTracing } = require('../../shared/tracing');
  assert(typeof initTracing === 'function', 'initTracing should be a function');
});

test('shutdownTracing is exported', () => {
  const { shutdownTracing } = require('../../shared/tracing');
  assert(typeof shutdownTracing === 'function', 'shutdownTracing should be a function');
});

test('getTracingStatus is exported', () => {
  const { getTracingStatus } = require('../../shared/tracing');
  assert(typeof getTracingStatus === 'function', 'getTracingStatus should be a function');
  
  const status = getTracingStatus();
  assert(typeof status.initialized === 'boolean', 'initialized should be boolean');
  assert(typeof status.enabled === 'boolean', 'enabled should be boolean');
  assert(typeof status.endpoint === 'string', 'endpoint should be string');
});

// ============ Summary ============

console.log('\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);

if (failed > 0) {
  console.log('\n❌ Some tests failed');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed');
  process.exit(0);
}
