// backend/shared/tests/intelligentPoolManager.test.js
// REQ-00559: Tests for Intelligent Pool Manager
'use strict';

const { PoolPreheater, PoolHealthChecker, IntelligentPoolManager } = require('../IntelligentPoolManager');

// Mock pool
class MockPool {
  constructor() {
    this.totalCount = 0;
    this.idleCount = 0;
    this.waitingCount = 0;
    this.options = { max: 10 };
    this._clients = [];
  }
  
  async connect() {
    this.totalCount++;
    this._clients.push({ processID: Math.random() });
    return {
      query: async () => ({ rows: [] }),
      release: () => {
        this.idleCount++;
      }
    };
  }
  
  async query(sql) {
    return { rows: [] };
  }
}

// ============================================================
// PoolPreheater Tests
// ============================================================

async function testPoolPreheaterStartup() {
  console.log('Testing PoolPreheater startup...');
  
  const pool = new MockPool();
  const preheater = new PoolPreheater(pool, {
    serviceName: 'test-service',
    minConnections: 3,
    warmupQueries: ['SELECT 1', 'SELECT NOW()']
  });
  
  const result = await preheater.preheatOnStartup();
  
  console.assert(result.success === true, 'Preheat should succeed');
  console.assert(result.connections === 3, 'Should create 3 connections');
  console.assert(preheater.isPreheated === true, 'Should be marked as preheated');
  
  const status = preheater.getStatus();
  console.assert(status.minConnections === 3, 'Min connections should be 3');
  
  preheater.destroy();
  console.log('✓ PoolPreheater startup test passed');
}

async function testPoolPreheaterManual() {
  console.log('Testing PoolPreheater manual preheat...');
  
  const pool = new MockPool();
  const preheater = new PoolPreheater(pool, {
    serviceName: 'test-service',
    minConnections: 2
  });
  
  const result = await preheater.manualPreheat(5);
  
  console.assert(result.success === true, 'Manual preheat should succeed');
  console.assert(result.connections === 5, 'Should create 5 connections');
  
  preheater.destroy();
  console.log('✓ PoolPreheater manual test passed');
}

async function testPoolPreheaterEvent() {
  console.log('Testing PoolPreheater event preheat...');
  
  const pool = new MockPool();
  const preheater = new PoolPreheater(pool, {
    serviceName: 'test-service',
    minConnections: 2
  });
  
  const result = await preheater.preheatForEvent({
    name: 'Raid Event',
    connections: 10
  });
  
  console.assert(result.success === true, 'Event preheat should succeed');
  console.assert(result.connections === 10, 'Should create 10 connections');
  
  preheater.destroy();
  console.log('✓ PoolPreheater event test passed');
}

// ============================================================
// PoolHealthChecker Tests
// ============================================================

async function testPoolHealthCheckerStart() {
  console.log('Testing PoolHealthChecker start...');
  
  const pool = new MockPool();
  const healthChecker = new PoolHealthChecker(pool, {
    serviceName: 'test-service',
    checkIntervalMs: 5000
  });
  
  healthChecker.start();
  
  // Wait for initial check
  await new Promise(resolve => setTimeout(resolve, 100));
  
  console.assert(healthChecker.checkInterval !== null, 'Check interval should be set');
  
  const status = healthChecker.getStatus();
  console.assert('serviceName' in status, 'Status should have serviceName');
  console.assert('isHealthy' in status, 'Status should have isHealthy');
  
  healthChecker.destroy();
  console.log('✓ PoolHealthChecker start test passed');
}

async function testPoolHealthCheckerCheck() {
  console.log('Testing PoolHealthChecker check...');
  
  const pool = new MockPool();
  const healthChecker = new PoolHealthChecker(pool, {
    serviceName: 'test-service'
  });
  
  const result = await healthChecker.forceCheck();
  
  console.assert('healthy' in result, 'Result should have healthy field');
  console.assert('duration' in result, 'Result should have duration');
  
  healthChecker.destroy();
  console.log('✓ PoolHealthChecker check test passed');
}

// ============================================================
// IntelligentPoolManager Tests
// ============================================================

async function testIntelligentPoolManagerInit() {
  console.log('Testing IntelligentPoolManager initialization...');
  
  const pool = new MockPool();
  const manager = new IntelligentPoolManager(pool, 'test-service', {
    minConnections: 3,
    minPoolSize: 5,
    maxPoolSize: 20
  });
  
  const result = await manager.initialize();
  
  console.assert(result.success === true, 'Initialization should succeed');
  console.assert(manager.initialized === true, 'Should be marked as initialized');
  
  const status = manager.getStatus();
  console.assert(status.initialized === true, 'Status should show initialized');
  console.assert(status.preheater.isPreheated === true, 'Pool should be preheated');
  
  await manager.shutdown();
  console.log('✓ IntelligentPoolManager init test passed');
}

async function testIntelligentPoolManagerStatus() {
  console.log('Testing IntelligentPoolManager status...');
  
  const pool = new MockPool();
  const manager = new IntelligentPoolManager(pool, 'test-service', {
    minConnections: 2,
    minPoolSize: 5,
    maxPoolSize: 15,
    peakHours: [
      { start: '09:00', end: '11:00' },
      { start: '19:00', end: '21:00' }
    ]
  });
  
  await manager.initialize();
  
  const status = manager.getStatus();
  
  console.assert('pool' in status, 'Status should have pool');
  console.assert('preheater' in status, 'Status should have preheater');
  console.assert('health' in status, 'Status should have health');
  console.assert('adaptive' in status, 'Status should have adaptive');
  console.assert('config' in status, 'Status should have config');
  
  console.assert(status.config.peakHours.length === 2, 'Should have 2 peak hours');
  
  await manager.shutdown();
  console.log('✓ IntelligentPoolManager status test passed');
}

async function testIntelligentPoolManagerManualOps() {
  console.log('Testing IntelligentPoolManager manual operations...');
  
  const pool = new MockPool();
  const manager = new IntelligentPoolManager(pool, 'test-service', {
    minConnections: 2,
    minPoolSize: 5,
    maxPoolSize: 15
  });
  
  await manager.initialize();
  
  // Test manual preheat
  const preheatResult = await manager.manualPreheat(5);
  console.assert(preheatResult.success === true, 'Manual preheat should succeed');
  
  // Test force health check
  const healthResult = await manager.forceHealthCheck();
  console.assert('healthy' in healthResult, 'Health check should return healthy status');
  
  // Test resize
  const resizeResult = await manager.resizePool(12);
  console.assert(resizeResult.success === true, 'Resize should succeed');
  console.assert(resizeResult.to === 12, 'New size should be 12');
  
  await manager.shutdown();
  console.log('✓ IntelligentPoolManager manual ops test passed');
}

async function testIntelligentPoolManagerMetrics() {
  console.log('Testing IntelligentPoolManager Prometheus metrics...');
  
  const pool = new MockPool();
  const manager = new IntelligentPoolManager(pool, 'test-service', {
    minConnections: 2
  });
  
  await manager.initialize();
  
  const metrics = manager.getPrometheusMetrics();
  
  console.assert(typeof metrics === 'string', 'Metrics should be string');
  console.assert(metrics.includes('db_pool_healthy'), 'Should include db_pool_healthy');
  console.assert(metrics.includes('db_pool_total_connections'), 'Should include db_pool_total_connections');
  console.assert(metrics.includes('db_pool_utilization'), 'Should include db_pool_utilization');
  
  await manager.shutdown();
  console.log('✓ IntelligentPoolManager metrics test passed');
}

// ============================================================
// Run all tests
// ============================================================

async function runAllTests() {
  console.log('\n' + '='.repeat(60));
  console.log('Running IntelligentPoolManager Tests');
  console.log('='.repeat(60) + '\n');
  
  try {
    await testPoolPreheaterStartup();
    await testPoolPreheaterManual();
    await testPoolPreheaterEvent();
    
    await testPoolHealthCheckerStart();
    await testPoolHealthCheckerCheck();
    
    await testIntelligentPoolManagerInit();
    await testIntelligentPoolManagerStatus();
    await testIntelligentPoolManagerManualOps();
    await testIntelligentPoolManagerMetrics();
    
    console.log('\n' + '='.repeat(60));
    console.log('✓ All tests passed!');
    console.log('='.repeat(60) + '\n');
    
  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run tests
runAllTests();