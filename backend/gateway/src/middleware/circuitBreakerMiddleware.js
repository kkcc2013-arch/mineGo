// backend/gateway/src/middleware/circuitBreakerMiddleware.js
'use strict';
const { getCircuitBreaker, getFallbackStrategy } = require('../circuitBreakers');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('gateway:circuit-breaker-middleware');

/**
 * Circuit Breaker Middleware
 * 
 * Wraps service calls with circuit breaker protection and fallback strategies.
 * 
 * Usage:
 *   router.post('/catch', circuitBreakerMiddleware('catch-service'), handler);
 * 
 * @param {string} serviceName - Target service name
 * @param {Object} options - Middleware options
 * @returns {Function} Express middleware
 */
function circuitBreakerMiddleware(serviceName, options = {}) {
  const cb = getCircuitBreaker(serviceName);
  const operation = options.operation || 'default';
  
  // If no circuit breaker for this service, pass through
  if (!cb) {
    logger.debug({ service: serviceName }, 'No circuit breaker for service, passing through');
    return (req, res, next) => next();
  }
  
  return async (req, res, next) => {
    // Store circuit breaker info in request for later use
    req.circuitBreaker = {
      service: serviceName,
      operation,
      breaker: cb
    };
    
    // Check if circuit is open before proceeding
    if (cb.isOpen()) {
      const fallback = getFallbackStrategy(serviceName, operation);
      
      logger.warn({
        service: serviceName,
        operation,
        state: cb.state,
        strategy: fallback.name
      }, 'Circuit breaker OPEN, executing fallback');
      
      try {
        const fallbackResult = await fallback.execute(req.fallbackContext || {}, 
          new Error(`Circuit breaker [${serviceName}] is OPEN`));
        
        // Attach fallback result to response locals
        res.locals.fallback = fallbackResult;
        res.locals.fallbackService = serviceName;
        
        // If fallback handled the response, return it
        if (options.respondOnFallback !== false) {
          return res.json(fallbackResult);
        }
        
        // Otherwise, continue with fallback data attached
        return next();
      } catch (fallbackErr) {
        logger.error({
          service: serviceName,
          error: fallbackErr.message
        }, 'Fallback strategy failed');
        
        return res.status(503).json({
          success: false,
          error: 'Service temporarily unavailable',
          service: serviceName,
          retryAfter: Math.ceil((cb.nextAttempt - Date.now()) / 1000)
        });
      }
    }
    
    // Circuit is closed or half-open, proceed with request
    next();
  };
}

/**
 * Circuit Breaker Wrapper for Service Calls
 * 
 * Use this to wrap individual service calls within a handler.
 * 
 * @param {string} serviceName - Target service name
 * @param {Function} fn - Async function to execute
 * @param {Object} context - Context for fallback
 * @returns {Promise}
 */
async function withCircuitBreaker(serviceName, fn, context = {}) {
  const cb = getCircuitBreaker(serviceName);
  
  if (!cb) {
    return fn();
  }
  
  try {
    return await cb.execute(fn);
  } catch (err) {
    if (err.code === 'CIRCUIT_OPEN' || err.code === 'CIRCUIT_HALF_OPEN') {
      const fallback = getFallbackStrategy(serviceName, context.operation || 'default');
      return fallback.execute(context, err);
    }
    throw err;
  }
}

/**
 * Circuit Breaker Decorator for Service Methods
 * 
 * Decorates a service method with circuit breaker protection.
 * 
 * @param {string} serviceName - Service name
 * @param {Object} options - Options
 * @returns {Function} Decorator function
 */
function withCircuitBreakerDecorator(serviceName, options = {}) {
  return (target, propertyKey, descriptor) => {
    const originalMethod = descriptor.value;
    const cb = getCircuitBreaker(serviceName);
    
    if (!cb) {
      return descriptor;
    }
    
    descriptor.value = async function (...args) {
      try {
        return await cb.execute(() => originalMethod.apply(this, args));
      } catch (err) {
        if (err.code === 'CIRCUIT_OPEN' || err.code === 'CIRCUIT_HALF_OPEN') {
          const fallback = getFallbackStrategy(serviceName, options.operation || 'default');
          return fallback.execute(options.context || {}, err);
        }
        throw err;
      }
    };
    
    return descriptor;
  };
}

/**
 * Create a circuit-breaker-protected proxy for a service
 * 
 * @param {string} serviceName - Service name
 * @param {Object} service - Service object
 * @returns {Object} Proxied service
 */
function createCircuitBreakerProxy(serviceName, service) {
  const cb = getCircuitBreaker(serviceName);
  
  if (!cb) {
    return service;
  }
  
  return new Proxy(service, {
    get(target, prop) {
      const original = target[prop];
      
      if (typeof original !== 'function') {
        return original;
      }
      
      return async function (...args) {
        try {
          return await cb.execute(() => original.apply(target, args));
        } catch (err) {
          if (err.code === 'CIRCUIT_OPEN' || err.code === 'CIRCUIT_HALF_OPEN') {
            const fallback = getFallbackStrategy(serviceName, prop);
            return fallback.execute(args[0] || {}, err);
          }
          throw err;
        }
      };
    }
  });
}

module.exports = {
  circuitBreakerMiddleware,
  withCircuitBreaker,
  withCircuitBreakerDecorator,
  createCircuitBreakerProxy
};
