// backend/gateway/src/circuitBreakers.js
'use strict';
const { CircuitBreaker, CircuitBreakerManager } = require('@pmg/shared/CircuitBreaker');
const { ServiceFallbackStrategies } = require('@pmg/shared/FallbackStrategy');
const { createLogger } = require('@pmg/shared/logger');
const metrics = require('@pmg/shared/metrics');
const { getAlertManager } = require('@pmg/shared/alerting');

// REQ-00584: 从 TimeoutPolicyManager 获取超时配置
const { timeoutPolicyManager, TIMEOUT_LEVELS } = require('@pmg/shared/TimeoutPolicyManager');

const logger = createLogger('gateway:circuit-breakers');

/**
 * Circuit Breaker Manager Instance
 */
const manager = new CircuitBreakerManager();

/**
 * Service Circuit Breaker Configurations
 * 
 * REQ-00584: 超时值现在从 TimeoutPolicyManager 获取
 * 每个服务使用分级超时策略（L1~L4）
 * 
 * 熔断阈值基于：
 * - 关键性：核心服务有更低的阈值
 * - 恢复时间：恢复快的服务有更短的超时
 * - 调用频率：频繁调用的服务需要更高的阈值
 */
const serviceConfigs = {
  'user-service': {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: TIMEOUT_LEVELS.L2_STANDARD_WRITE.defaultMs,  // L2: 10s
    timeoutLevel: 'L2',
    halfOpenMaxCalls: 3
  },
  
  'location-service': {
    failureThreshold: 10,  // Higher threshold (frequently called)
    successThreshold: 3,
    timeout: TIMEOUT_LEVELS.L1_FAST_READ.defaultMs,        // L1: 3s
    timeoutLevel: 'L1',
    halfOpenMaxCalls: 5
  },
  
  'pokemon-service': {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: TIMEOUT_LEVELS.L2_STANDARD_WRITE.defaultMs,  // L2: 10s
    timeoutLevel: 'L2',
    halfOpenMaxCalls: 3
  },
  
  'catch-service': {
    failureThreshold: 3,   // Lower threshold (core gameplay)
    successThreshold: 2,
    timeout: TIMEOUT_LEVELS.L2_STANDARD_WRITE.defaultMs,   // L2: 10s
    timeoutLevel: 'L2',
    halfOpenMaxCalls: 2
  },
  
  'gym-service': {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: TIMEOUT_LEVELS.L3_BATCH_OPERATION.defaultMs,  // L3: 30s
    timeoutLevel: 'L3',
    halfOpenMaxCalls: 3
  },
  
  'social-service': {
    failureThreshold: 8,   // Higher threshold (non-critical)
    successThreshold: 2,
    timeout: TIMEOUT_LEVELS.L3_BATCH_OPERATION.defaultMs,  // L3: 30s
    timeoutLevel: 'L3',
    halfOpenMaxCalls: 3
  },
  
  'reward-service': {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: TIMEOUT_LEVELS.L3_BATCH_OPERATION.defaultMs,  // L3: 30s
    timeoutLevel: 'L3',
    halfOpenMaxCalls: 3
  }
  
  // Note: payment-service is NOT included - payments should never be circuit broken
  // If payment service fails, the request should fail explicitly
};

/**
 * Initialize Circuit Breakers for all services
 * REQ-00584: 支持从 TimeoutPolicyManager 动态获取超时值
 */
async function initializeCircuitBreakers() {
  // 确保 TimeoutPolicyManager 已初始化
  await timeoutPolicyManager.initialize();
  
  for (const [serviceName, config] of Object.entries(serviceConfigs)) {
    // 从 TimeoutPolicyManager 获取最新超时配置
    const dynamicTimeout = timeoutPolicyManager.getTimeout(
      `/api/v2/${serviceName.replace('-service', '')}`,
      'POST'
    );
    const effectiveTimeout = dynamicTimeout?.defaultMs || config.timeout;
    const cb = manager.getOrCreate(serviceName, config);
    
    // Set up event listeners
    cb.on('open', (name, data) => {
      logger.error({
        service: name,
        failures: data.failures,
        config: serviceConfigs[name]
      }, 'Circuit breaker OPENED - service isolated');
      
      // Update Prometheus metrics
      if (metrics.circuitBreakerStatus) {
        metrics.circuitBreakerStatus.set({ service: name, state: 'open' }, 1);
      }
      if (metrics.circuitBreakerEvents) {
        metrics.circuitBreakerEvents.inc({ service: name, event: 'open' });
      }
      
      // REQ-00439: Send alert to monitoring system
      const alertManager = getAlertManager();
      if (alertManager) {
        alertManager.send({
          level: 'critical',
          service: name,
          event: 'circuit-breaker-open',
          message: `熔断器打开: ${name} 服务不可用`,
          data: {
            failures: data.failures,
            threshold: serviceConfigs[name]?.failureThreshold,
            config: serviceConfigs[name],
            timestamp: new Date().toISOString()
          }
        });
      }
    });
    
    cb.on('half-open', (name) => {
      logger.info({ service: name }, 'Circuit breaker HALF-OPEN - testing recovery');
      
      if (metrics.circuitBreakerStatus) {
        metrics.circuitBreakerStatus.set({ service: name, state: 'half_open' }, 0.5);
      }
      if (metrics.circuitBreakerEvents) {
        metrics.circuitBreakerEvents.inc({ service: name, event: 'half-open' });
      }
      
      // REQ-00439: Send alert for half-open state
      const alertManager = getAlertManager();
      if (alertManager) {
        alertManager.send({
          level: 'warning',
          service: name,
          event: 'circuit-breaker-half-open',
          message: `熔断器半开: ${name} 恢复测试中`,
          data: {
            timestamp: new Date().toISOString()
          }
        });
      }
    });
    
    cb.on('close', (name) => {
      logger.info({ service: name }, 'Circuit breaker CLOSED - service recovered');
      
      if (metrics.circuitBreakerStatus) {
        metrics.circuitBreakerStatus.set({ service: name, state: 'closed' }, 0);
      }
      if (metrics.circuitBreakerEvents) {
        metrics.circuitBreakerEvents.inc({ service: name, event: 'close' });
      }
      
      // REQ-00439: Send alert for service recovery
      const alertManager = getAlertManager();
      if (alertManager) {
        alertManager.send({
          level: 'info',
          service: name,
          event: 'circuit-breaker-close',
          message: `熔断器关闭: ${name} 已恢复`,
          data: {
            timestamp: new Date().toISOString()
          }
        });
      }
    });
  }
  
  logger.info({
    services: Object.keys(serviceConfigs),
    count: manager.breakers.size
  }, 'Circuit breakers initialized');
}

/**
 * Get Circuit Breaker for a service
 * @param {string} serviceName - Service name
 * @returns {CircuitBreaker|undefined}
 */
function getCircuitBreaker(serviceName) {
  return manager.get(serviceName);
}

/**
 * Get Fallback Strategy for a service
 * @param {string} serviceName - Service name
 * @param {string} operation - Operation name (optional)
 * @returns {FallbackStrategy}
 */
function getFallbackStrategy(serviceName, operation) {
  const serviceStrategies = ServiceFallbackStrategies[serviceName];
  
  if (!serviceStrategies) {
    return ServiceFallbackStrategies.default || 
           require('@pmg/shared/FallbackStrategy').FallbackStrategies.defaultValue;
  }
  
  // If service has operation-specific strategies
  if (typeof serviceStrategies === 'object' && !serviceStrategies.handler) {
    return serviceStrategies[operation] || serviceStrategies.default ||
           require('@pmg/shared/FallbackStrategy').FallbackStrategies.defaultValue;
  }
  
  return serviceStrategies;
}

/**
 * Get all circuit breakers status
 * @returns {Object}
 */
function getAllStatus() {
  return manager.getAllStatus();
}

/**
 * Reset a specific circuit breaker
 * @param {string} serviceName - Service name
 * @returns {boolean}
 */
function resetCircuitBreaker(serviceName) {
  const cb = manager.get(serviceName);
  if (cb) {
    cb.reset();
    return true;
  }
  return false;
}

/**
 * Reset all circuit breakers
 */
function resetAllCircuitBreakers() {
  manager.resetAll();
  logger.info('All circuit breakers reset');
}

// Initialize on module load
initializeCircuitBreakers();

module.exports = {
  manager,
  serviceConfigs,
  getCircuitBreaker,
  getFallbackStrategy,
  getAllStatus,
  resetCircuitBreaker,
  resetAllCircuitBreakers,
  initializeCircuitBreakers
};
