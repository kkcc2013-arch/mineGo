// tests/unit/logger-metrics.test.js
// Unit tests for structured logging and Prometheus metrics
'use strict';

const assert = require('assert');

// Mock environment
process.env.LOG_LEVEL = 'debug';
process.env.NODE_ENV = 'test';

async function runTests() {
  console.log('=== Testing Logger Module ===\n');

  // Test 1: Create logger
  try {
    const { createLogger, requestLogger } = require('../../shared/logger');
    
    const logger = createLogger('test-service');
    assert(logger, 'Logger should be created');
    assert(typeof logger.info === 'function', 'Logger should have info method');
    assert(typeof logger.error === 'function', 'Logger should have error method');
    assert(typeof logger.warn === 'function', 'Logger should have warn method');
    assert(typeof logger.debug === 'function', 'Logger should have debug method');
    
    console.log('✓ Test 1: Logger creation - PASSED');
    
    // Test logging
    logger.info({ test: 'value' }, 'Test log message');
    console.log('✓ Test 2: Logger output - PASSED');
    
    // Test request logger middleware
    const reqLogger = requestLogger(logger);
    assert(typeof reqLogger === 'function', 'requestLogger should return a middleware function');
    console.log('✓ Test 3: Request logger middleware - PASSED');
    
  } catch (err) {
    console.error('✗ Logger tests FAILED:', err.message);
    process.exit(1);
  }

  console.log('\n=== Testing Metrics Module ===\n');

  // Test 2: Metrics module
  try {
    const metrics = require('../../shared/metrics');
    
    // Check all required metrics exist
    assert(metrics.register, 'Should have Prometheus register');
    assert(metrics.httpRequestsTotal, 'Should have httpRequestsTotal counter');
    assert(metrics.httpRequestDuration, 'Should have httpRequestDuration histogram');
    assert(metrics.httpRequestsInProgress, 'Should have httpRequestsInProgress gauge');
    assert(metrics.dbQueryDuration, 'Should have dbQueryDuration histogram');
    assert(metrics.dbConnectionsActive, 'Should have dbConnectionsActive gauge');
    assert(metrics.cacheHitsTotal, 'Should have cacheHitsTotal counter');
    assert(metrics.websocketConnectionsActive, 'Should have websocketConnectionsActive gauge');
    assert(metrics.catchAttemptsTotal, 'Should have catchAttemptsTotal counter');
    
    console.log('✓ Test 4: Metrics module exports - PASSED');
    
    // Test HTTP metrics middleware
    const middleware = metrics.httpMetricsMiddleware('test-service');
    assert(typeof middleware === 'function', 'httpMetricsMiddleware should return a function');
    console.log('✓ Test 5: HTTP metrics middleware - PASSED');
    
    // Test counter increment
    metrics.httpRequestsTotal.inc({ service: 'test', method: 'GET', path: '/test', status: 200 });
    console.log('✓ Test 6: Counter increment - PASSED');
    
    // Test histogram observe
    metrics.httpRequestDuration.observe({ service: 'test', method: 'GET', path: '/test' }, 50);
    console.log('✓ Test 7: Histogram observe - PASSED');
    
    // Test cache helpers
    metrics.recordCacheHit('test-service', 'test-cache');
    metrics.recordCacheMiss('test-service', 'test-cache');
    console.log('✓ Test 8: Cache helper functions - PASSED');
    
    // Test metrics output
    const metricsOutput = await metrics.register.metrics();
    assert(typeof metricsOutput === 'string', 'Metrics output should be a string');
    assert(metricsOutput.includes('minego_http_requests_total'), 'Should include HTTP requests metric');
    assert(metricsOutput.includes('minego_http_request_duration_ms'), 'Should include HTTP duration metric');
    assert(metricsOutput.includes('minego_cache_hits_total'), 'Should include cache hits metric');
    console.log('✓ Test 9: Metrics output format - PASSED');
    
  } catch (err) {
    console.error('✗ Metrics tests FAILED:', err.message);
    process.exit(1);
  }

  console.log('\n=== All Tests PASSED ===');
  console.log('Total: 9 tests passed');
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
