// backend/gateway/src/circuitBreakers.js
'use strict';
const { CircuitBreaker, CircuitBreakerManager } = require('@pmg/shared/CircuitBreaker');
const { ServiceFallbackStrategies } = require('@pmg/shared/FallbackStrategy');
const { createLogger } = require('@pmg/shared/logger');
const metrics = require('@pmg/shared/metrics');

const logger = createLogger('gateway:circuit-breakers');

/**
 * Circuit Breaker Manager Instance
 */
const manager = new CircuitBreakerManager();

/**
 * Service Circuit Breaker Configurations
 * 
 * Each service has tuned thresholds based on:
 * - Criticality: Core services have lower thresholds
 * - Recovery time: Services that recover quickly have shorter timeouts
 * - Call frequency: Frequently called services need higher thresholds
 */
const serviceConfigs = {
  'user-service': {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 30000,      // 30s
    halfOpenMaxCalls: 3
  },
  
  'location-service': {
    failureThreshold: 10,  // Higher threshold (frequently called)
    successThreshold: 3,
    timeout: 20000,        // 20s (recovers quickly)
    halfOpenMaxCalls: 5
  },
  
  'pokemon-service': {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 30000,
    halfOpenMaxCalls: 3
  },
  
  'catch-service': {
    failureThreshold: 3,   // Lower threshold (core gameplay)
    successThreshold: 2,
    timeout: 15000,        // 15s
    halfOpenMaxCalls: 2
  },
  
  'gym-service': {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 30000,
    halfOpenMaxCalls: 3
  },
  
  'social-service': {
    failureThreshold: 8,   // Higher threshold (non-critical)
    successThreshold: 2,
    timeout: 60000,        // 60s
    halfOpenMaxCalls: 3
  },
  
  'reward-service': {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 60000,        // 60s (may take time to recover)
    halfOpenMaxCalls: 3
  }
  
  // Note: payment-service is NOT included - payments should never be circuit broken
  // If payment service fails, the request should fail explicitly
};

/**
 * Initialize Circuit Breakers for all services
 */
function initializeCircuitBreakers() {
  for (const [serviceName, config] of Object.entries(serviceConfigs)) {
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
      
      // TODO: Send alert to monitoring system
      // alertManager.send({ service: name, event: 'circuit-open', data });
    });
    
    cb.on('half-open', (name) => {
      logger.info({ service: name }, 'Circuit breaker HALF-OPEN - testing recovery');
      
      if (metrics.circuitBreakerStatus) {
        metrics.circuitBreakerStatus.set({ service: name, state: 'half_open' }, 0.5);
      }
      if (metrics.circuitBreakerEvents) {
        metrics.circuitBreakerEvents.inc({ service: name, event: 'half-open' });
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
