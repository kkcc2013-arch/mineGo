// backend/shared/tests/serviceLifecycle.test.js
// 服务生命周期管理器单元测试
'use strict';

const assert = require('assert');
const {
  ServiceLifecycleStateMachine,
  ServiceLifecycleManager,
  ServiceLifecycleState,
  STATE_TRANSITIONS,
  canAcceptRequests,
  isRunning,
  isShuttingDown
} = require('../serviceLifecycle');

console.log('Starting ServiceLifecycle tests...\n');

let passedTests = 0;
let failedTests = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passedTests++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  Error: ${error.message}`);
    failedTests++;
  }
}

// ==================== 状态定义测试 ====================

test('ServiceLifecycleState contains all required states', () => {
  const requiredStates = [
    'UNINITIALIZED', 'STARTING', 'WAITING_DEPENDENCIES', 'INITIALIZING_PLUGINS',
    'CONNECTING_DB', 'CONNECTING_REDIS', 'CONNECTING_KAFKA', 'STARTING_SERVER',
    'HEALTHY', 'DEGRADED', 'DRAINING', 'STOPPING', 'STOPPING_PLUGINS',
    'CLOSING_CONNECTIONS', 'CLEANUP_RESOURCES', 'STOPPED', 'ERROR'
  ];
  
  requiredStates.forEach(state => {
    assert(ServiceLifecycleState[state], `Missing state: ${state}`);
  });
});

test('STATE_TRANSITIONS defines valid transitions', () => {
  assert(Array.isArray(STATE_TRANSITIONS['uninitialized']));
  assert(STATE_TRANSITIONS['uninitialized'].includes('starting'));
  assert(STATE_TRANSITIONS['uninitialized'].includes('error'));
  
  assert(Array.isArray(STATE_TRANSITIONS['healthy']));
  assert(STATE_TRANSITIONS['healthy'].includes('draining'));
  assert(STATE_TRANSITIONS['healthy'].includes('stopping'));
});

test('canAcceptRequests returns correct values', () => {
  assert.strictEqual(canAcceptRequests('healthy'), true);
  assert.strictEqual(canAcceptRequests('degraded'), false);
  assert.strictEqual(canAcceptRequests('stopped'), false);
});

test('isRunning returns correct values', () => {
  assert.strictEqual(isRunning('healthy'), true);
  assert.strictEqual(isRunning('degraded'), true);
  assert.strictEqual(isRunning('stopped'), false);
  assert.strictEqual(isRunning('starting'), false);
});

test('isShuttingDown returns correct values', () => {
  assert.strictEqual(isShuttingDown('draining'), true);
  assert.strictEqual(isShuttingDown('stopping'), true);
  assert.strictEqual(isShuttingDown('healthy'), false);
  assert.strictEqual(isShuttingDown('stopped'), false);
});

// ==================== 状态机测试 ====================

test('ServiceLifecycleStateMachine initializes correctly', () => {
  const sm = new ServiceLifecycleStateMachine('test-service');
  
  assert.strictEqual(sm.serviceName, 'test-service');
  assert.strictEqual(sm.getCurrentState(), 'uninitialized');
  assert.strictEqual(sm.previousState, null);
  assert.strictEqual(sm.errorInfo, null);
});

test('ServiceLifecycleStateMachine canTransitionTo validates transitions', () => {
  const sm = new ServiceLifecycleStateMachine('test-service');
  
  // 从 uninitialized 可以转换到 starting
  assert.strictEqual(sm.canTransitionTo('starting'), true);
  assert.strictEqual(sm.canTransitionTo('error'), true);
  
  // 不能直接转换到 healthy
  assert.strictEqual(sm.canTransitionTo('healthy'), false);
});

test('ServiceLifecycleStateMachine transitionTo changes state', async () => {
  const sm = new ServiceLifecycleStateMachine('test-service');
  
  const result = await sm.transitionTo('starting');
  
  assert.strictEqual(result.previousState, 'uninitialized');
  assert.strictEqual(result.currentState, 'starting');
  assert.strictEqual(sm.getCurrentState(), 'starting');
});

test('ServiceLifecycleStateMachine rejects invalid transition', async () => {
  const sm = new ServiceLifecycleStateMachine('test-service');
  
  try {
    await sm.transitionTo('healthy');
    assert.fail('Should have thrown error');
  } catch (error) {
    assert(error.message.includes('Invalid state transition'));
  }
});

test('ServiceLifecycleStateMachine emits state:changed event', async () => {
  const sm = new ServiceLifecycleStateMachine('test-service');
  
  let eventFired = false;
  let eventData = null;
  
  sm.on('state:changed', (data) => {
    eventFired = true;
    eventData = data;
  });
  
  await sm.transitionTo('starting');
  
  assert(eventFired);
  assert.strictEqual(eventData.from, 'uninitialized');
  assert.strictEqual(eventData.to, 'starting');
  assert.strictEqual(eventData.serviceName, 'test-service');
});

test('ServiceLifecycleStateMachine transitionToError works correctly', async () => {
  const sm = new ServiceLifecycleStateMachine('test-service');
  
  await sm.transitionTo('starting');
  
  const error = new Error('Test error');
  await sm.transitionToError(error);
  
  assert.strictEqual(sm.getCurrentState(), 'error');
  assert(sm.errorInfo);
  assert.strictEqual(sm.errorInfo.error.message, 'Test error');
});

test('ServiceLifecycleStateMachine tracks state history', async () => {
  const sm = new ServiceLifecycleStateMachine('test-service');
  
  await sm.transitionTo('starting');
  await sm.transitionToError(new Error('Test'));
  
  const history = sm.getStateHistory();
  
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].from, 'uninitialized');
  assert.strictEqual(history[0].to, 'starting');
  assert.strictEqual(history[1].from, 'starting');
  assert.strictEqual(history[1].to, 'error');
});

test('ServiceLifecycleStateMachine onEnterState callback works', async () => {
  const sm = new ServiceLifecycleStateMachine('test-service');
  
  let callbackExecuted = false;
  
  sm.onEnterState('starting', () => {
    callbackExecuted = true;
  });
  
  await sm.transitionTo('starting');
  
  assert(callbackExecuted);
});

test('ServiceLifecycleStateMachine exportSnapshot returns correct data', () => {
  const sm = new ServiceLifecycleStateMachine('test-service');
  
  const snapshot = sm.exportSnapshot();
  
  assert.strictEqual(snapshot.serviceName, 'test-service');
  assert.strictEqual(snapshot.currentState, 'uninitialized');
  assert.strictEqual(snapshot.previousState, null);
  assert.strictEqual(typeof snapshot.exportedAt, 'number');
});

test('ServiceLifecycleStateMachine isRunning and canAcceptRequests work', async () => {
  const sm = new ServiceLifecycleStateMachine('test-service');
  
  assert.strictEqual(sm.isRunning(), false);
  assert.strictEqual(sm.canAcceptRequests(), false);
  
  // 模拟到达 healthy 状态
  sm.currentState = 'healthy';
  
  assert.strictEqual(sm.isRunning(), true);
  assert.strictEqual(sm.canAcceptRequests(), true);
  
  // 模拟 degraded 状态
  sm.currentState = 'degraded';
  
  assert.strictEqual(sm.isRunning(), true);
  assert.strictEqual(sm.canAcceptRequests(), false);
});

// ==================== 状态机完整流程测试 ====================

test('ServiceLifecycleStateMachine full startup flow', async () => {
  const sm = new ServiceLifecycleStateMachine('test-service');
  
  // 启动流程
  await sm.transitionTo('starting');
  assert.strictEqual(sm.getCurrentState(), 'starting');
  
  await sm.transitionTo('waiting_dependencies');
  assert.strictEqual(sm.getCurrentState(), 'waiting_dependencies');
  
  await sm.transitionTo('initializing_plugins');
  assert.strictEqual(sm.getCurrentState(), 'initializing_plugins');
  
  await sm.transitionTo('connecting_db');
  assert.strictEqual(sm.getCurrentState(), 'connecting_db');
  
  await sm.transitionTo('connecting_redis');
  assert.strictEqual(sm.getCurrentState(), 'connecting_redis');
  
  await sm.transitionTo('starting_server');
  assert.strictEqual(sm.getCurrentState(), 'starting_server');
  
  await sm.transitionTo('healthy');
  assert.strictEqual(sm.getCurrentState(), 'healthy');
  
  assert(sm.isRunning());
  assert(sm.canAcceptRequests());
});

test('ServiceLifecycleStateMachine full shutdown flow', async () => {
  const sm = new ServiceLifecycleStateMachine('test-service');
  
  // 先到达 healthy 状态
  sm.currentState = 'healthy';
  
  // 关闭流程
  await sm.transitionTo('draining');
  assert(sm.isShuttingDown());
  
  await sm.transitionTo('stopping');
  await sm.transitionTo('stopping_plugins');
  await sm.transitionTo('closing_connections');
  await sm.transitionTo('cleanup_resources');
  await sm.transitionTo('stopped');
  
  assert.strictEqual(sm.getCurrentState(), 'stopped');
  assert(!sm.isRunning());
  assert(!sm.canAcceptRequests());
});

// ==================== ServiceLifecycleManager 测试 ====================

test('ServiceLifecycleManager initializes with default config', () => {
  const manager = new ServiceLifecycleManager('test-service');
  
  assert.strictEqual(manager.serviceName, 'test-service');
  assert(manager.stateMachine);
  assert(manager.shutdownOrchestrator);
  assert(manager.dependencyCoordinator);
  assert.strictEqual(manager.config.statePersistenceEnabled, true);
});

test('ServiceLifecycleManager initializes with custom config', () => {
  const manager = new ServiceLifecycleManager('test-service', {
    statePersistenceEnabled: false,
    shutdownTimeout: 60000
  });
  
  assert.strictEqual(manager.config.statePersistenceEnabled, false);
  assert.strictEqual(manager.config.shutdownTimeout, 60000);
});

test('ServiceLifecycleManager registerComponent works', () => {
  const manager = new ServiceLifecycleManager('test-service');
  
  manager.registerComponent('database', { query: () => {} });
  manager.registerComponent('redis', { ping: () => {} });
  
  assert(manager.components.database);
  assert(manager.components.redis);
});

test('ServiceLifecycleManager incrementRequestCount works', () => {
  const manager = new ServiceLifecycleManager('test-service');
  
  assert.strictEqual(manager.metrics.requestCount, 0);
  
  manager.incrementRequestCount();
  manager.incrementRequestCount();
  manager.incrementRequestCount();
  
  assert.strictEqual(manager.metrics.requestCount, 3);
  assert(manager.metrics.lastRequestTime > 0);
});

test('ServiceLifecycleManager healthCheck returns correct structure', async () => {
  const manager = new ServiceLifecycleManager('test-service');
  
  const health = await manager.healthCheck();
  
  assert.strictEqual(health.serviceName, 'test-service');
  assert.strictEqual(health.state, 'uninitialized');
  assert.strictEqual(typeof health.isRunning, 'boolean');
  assert.strictEqual(typeof health.canAcceptRequests, 'boolean');
  assert.strictEqual(typeof health.uptime, 'number');
  assert(health.components);
  assert(health.timestamp);
});

test('ServiceLifecycleManager registerShutdownHook works', () => {
  const manager = new ServiceLifecycleManager('test-service');
  
  manager.registerShutdownHook('test-hook', async () => {
    console.log('Cleanup hook executed');
  }, 50);
  
  const hooks = manager.getShutdownOrchestrator().getShutdownHooks();
  assert.strictEqual(hooks[0].name, 'test-hook');
  assert.strictEqual(hooks[0].priority, 50);
});

// ==================== 总结 ====================

console.log('\n========================================');
console.log(`Tests passed: ${passedTests}`);
console.log(`Tests failed: ${failedTests}`);
console.log('========================================\n');

if (failedTests > 0) {
  console.error('Some tests failed!');
  process.exit(1);
} else {
  console.log('All tests passed! ✓');
  process.exit(0);
}
