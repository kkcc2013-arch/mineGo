// backend/shared/CircuitBreaker.js
'use strict';
const { EventEmitter } = require('events');
const { createLogger } = require('./logger');

const logger = createLogger('circuit-breaker');

/**
 * Circuit Breaker States
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Circuit tripped, requests fail fast
 * - HALF_OPEN: Testing if service recovered
 */
const STATES = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

/**
 * Circuit Breaker Pattern Implementation
 * 
 * Prevents cascading failures by failing fast when a service is unhealthy.
 * Automatically recovers when the service becomes healthy again.
 */
class CircuitBreaker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.name = options.name || 'circuit-breaker';
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 2;
    this.timeout = options.timeout || 60000; // Time before attempting recovery
    this.halfOpenMaxCalls = options.halfOpenMaxCalls || 3;
    
    // State
    this.state = STATES.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.nextAttempt = Date.now();
    this.halfOpenCalls = 0;
    
    // Stats
    this.stats = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      rejectedCalls: 0,
      lastFailure: null,
      lastSuccess: null,
      stateChanges: []
    };
    
    logger.info({
      name: this.name,
      failureThreshold: this.failureThreshold,
      successThreshold: this.successThreshold,
      timeout: this.timeout
    }, 'Circuit breaker initialized');
  }

  /**
   * Execute a function through the circuit breaker
   * @param {Function} fn - Async function to execute
   * @returns {Promise} - Result or error
   */
  async execute(fn) {
    this.stats.totalCalls++;
    
    // Check if circuit is OPEN
    if (this.state === STATES.OPEN) {
      if (Date.now() < this.nextAttempt) {
        this.stats.rejectedCalls++;
        const err = new Error(`Circuit breaker [${this.name}] is OPEN`);
        err.code = 'CIRCUIT_OPEN';
        err.circuitBreaker = this.name;
        throw err;
      }
      
      // Timeout reached, transition to HALF_OPEN
      this.transitionTo(STATES.HALF_OPEN);
    }
    
    // Limit calls in HALF_OPEN state
    if (this.state === STATES.HALF_OPEN && this.halfOpenCalls >= this.halfOpenMaxCalls) {
      this.stats.rejectedCalls++;
      const err = new Error(`Circuit breaker [${this.name}] is HALF_OPEN and max calls reached`);
      err.code = 'CIRCUIT_HALF_OPEN';
      err.circuitBreaker = this.name;
      throw err;
    }
    
    try {
      if (this.state === STATES.HALF_OPEN) {
        this.halfOpenCalls++;
      }
      
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  /**
   * Handle successful execution
   */
  onSuccess() {
    this.stats.successfulCalls++;
    this.stats.lastSuccess = new Date().toISOString();
    this.failures = 0;
    
    if (this.state === STATES.HALF_OPEN) {
      this.successes++;
      
      if (this.successes >= this.successThreshold) {
        this.transitionTo(STATES.CLOSED);
      }
    }
    
    logger.debug({
      name: this.name,
      state: this.state,
      successes: this.successes,
      failures: this.failures
    }, 'Circuit breaker success');
  }

  /**
   * Handle failed execution
   * @param {Error} err - The error that occurred
   */
  onFailure(err) {
    this.stats.failedCalls++;
    this.stats.lastFailure = {
      time: new Date().toISOString(),
      error: err.message
    };
    this.successes = 0;
    this.failures++;
    
    logger.warn({
      name: this.name,
      state: this.state,
      successes: this.successes,
      failures: this.failures,
      error: err.message
    }, 'Circuit breaker failure');
    
    if (this.state === STATES.HALF_OPEN) {
      // Failure in HALF_OPEN immediately trips the circuit
      this.transitionTo(STATES.OPEN);
    } else if (this.failures >= this.failureThreshold) {
      this.transitionTo(STATES.OPEN);
    }
  }

  /**
   * Transition to a new state
   * @param {string} newState - The new state
   */
  transitionTo(newState) {
    const oldState = this.state;
    this.state = newState;
    
    const changeTime = new Date().toISOString();
    this.stats.stateChanges.push({
      from: oldState,
      to: newState,
      time: changeTime
    });
    
    // Keep only last 10 state changes
    if (this.stats.stateChanges.length > 10) {
      this.stats.stateChanges = this.stats.stateChanges.slice(-10);
    }
    
    if (newState === STATES.OPEN) {
      this.nextAttempt = Date.now() + this.timeout;
      this.halfOpenCalls = 0;
      this.emit('open', this.name, { failures: this.failures });
      logger.error({
        name: this.name,
        failures: this.failures,
        nextAttempt: new Date(this.nextAttempt).toISOString()
      }, 'Circuit breaker OPENED');
    } else if (newState === STATES.HALF_OPEN) {
      this.halfOpenCalls = 0;
      this.emit('half-open', this.name);
      logger.info({ name: this.name }, 'Circuit breaker entered HALF_OPEN');
    } else if (newState === STATES.CLOSED) {
      this.failures = 0;
      this.successes = 0;
      this.halfOpenCalls = 0;
      this.emit('close', this.name);
      logger.info({ name: this.name }, 'Circuit breaker CLOSED');
    }
  }

  /**
   * Get current circuit breaker status
   * @returns {Object} Status object
   */
  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      failureThreshold: this.failureThreshold,
      successThreshold: this.successThreshold,
      timeout: this.timeout,
      nextAttempt: this.nextAttempt,
      nextAttemptIn: Math.max(0, this.nextAttempt - Date.now()),
      stats: {
        ...this.stats,
        uptime: Date.now() - (this.stats.stateChanges[0]?.time 
          ? new Date(this.stats.stateChanges[0].time).getTime() 
          : Date.now())
      }
    };
  }

  /**
   * Manually reset the circuit breaker
   */
  reset() {
    this.transitionTo(STATES.CLOSED);
    logger.info({ name: this.name }, 'Circuit breaker manually reset');
  }

  /**
   * Manually trip the circuit breaker
   */
  trip() {
    this.transitionTo(STATES.OPEN);
    logger.warn({ name: this.name }, 'Circuit breaker manually tripped');
  }

  /**
   * Check if circuit is open
   * @returns {boolean}
   */
  isOpen() {
    return this.state === STATES.OPEN && Date.now() < this.nextAttempt;
  }

  /**
   * Check if circuit is closed
   * @returns {boolean}
   */
  isClosed() {
    return this.state === STATES.CLOSED;
  }

  /**
   * Check if circuit is half-open
   * @returns {boolean}
   */
  isHalfOpen() {
    return this.state === STATES.HALF_OPEN;
  }
}

/**
 * Circuit Breaker Manager - Manages multiple circuit breakers
 */
class CircuitBreakerManager {
  constructor() {
    this.breakers = new Map();
  }

  /**
   * Create or get a circuit breaker
   * @param {string} name - Circuit breaker name
   * @param {Object} options - Circuit breaker options
   * @returns {CircuitBreaker}
   */
  getOrCreate(name, options = {}) {
    if (!this.breakers.has(name)) {
      const cb = new CircuitBreaker({ name, ...options });
      this.breakers.set(name, cb);
    }
    return this.breakers.get(name);
  }

  /**
   * Get a circuit breaker by name
   * @param {string} name - Circuit breaker name
   * @returns {CircuitBreaker|undefined}
   */
  get(name) {
    return this.breakers.get(name);
  }

  /**
   * Get all circuit breakers status
   * @returns {Object}
   */
  getAllStatus() {
    const status = {};
    for (const [name, cb] of this.breakers) {
      status[name] = cb.getStatus();
    }
    return status;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll() {
    for (const cb of this.breakers.values()) {
      cb.reset();
    }
  }

  /**
   * Add event listener to all circuit breakers
   * @param {string} event - Event name
   * @param {Function} listener - Event listener
   */
  onAll(event, listener) {
    for (const cb of this.breakers.values()) {
      cb.on(event, listener);
    }
  }
}

module.exports = {
  CircuitBreaker,
  CircuitBreakerManager,
  STATES
};
