// backend/shared/SteadyStateValidator.js
'use strict';
const { createLogger } = require('./logger');
const http = require('http');
const https = require('https');

const logger = createLogger('steady-state-validator');

/**
 * Steady State Validator
 * 
 * Validates that the system remains in a steady state during chaos experiments.
 * Monitors metrics, health checks, and business invariants.
 */
class SteadyStateValidator {
  constructor(options = {}) {
    // Configuration
    this.checkInterval = options.checkInterval || 5000;
    this.timeout = options.timeout || 30000;
    this.anomalyThreshold = options.anomalyThreshold || 0.05; // 5% deviation
    
    // Metrics endpoints
    this.metricsEndpoints = options.metricsEndpoints || {
      prometheus: 'http://localhost:9090',
      health: 'http://localhost:3000/health'
    };
    
    // Baseline metrics
    this.baselines = new Map();
    
    // Anomaly detectors
    this.detectors = new Map();
    this._registerDefaultDetectors();
    
    logger.info('SteadyStateValidator initialized');
  }

  /**
   * Register default anomaly detectors
   */
  _registerDefaultDetectors() {
    // Success rate detector
    this.detectors.set('successRate', {
      validate: (current, baseline, context) => {
        const minRate = context.allowDegradation ? 0.95 : 0.99;
        if (current < minRate) {
          return {
            passed: false,
            anomaly: {
              type: 'success-rate-degraded',
              current,
              expected: minRate,
              severity: current < 0.9 ? 'critical' : 'warning'
            }
          };
        }
        return { passed: true };
      }
    });

    // Response time detector
    this.detectors.set('responseTime', {
      validate: (current, baseline, context) => {
        const maxP99 = context.allowDegradation ? 2000 : 500;
        if (current.p99 > maxP99) {
          return {
            passed: false,
            anomaly: {
              type: 'response-time-exceeded',
              current: current.p99,
              expected: maxP99,
              severity: current.p99 > maxP99 * 2 ? 'critical' : 'warning'
            }
          };
        }
        return { passed: true };
      }
    });

    // Error rate detector
    this.detectors.set('errorRate', {
      validate: (current, baseline, context) => {
        const maxRate = context.allowDegradation ? 0.1 : 0.01;
        if (current > maxRate) {
          return {
            passed: false,
            anomaly: {
              type: 'error-rate-exceeded',
              current,
              expected: maxRate,
              severity: current > 0.2 ? 'critical' : 'warning'
            }
          };
        }
        return { passed: true };
      }
    });

    // Circuit breaker detector
    this.detectors.set('circuitBreaker', {
      validate: (current, baseline, context) => {
        // In fault context, circuit breaker should be open
        if (context.faultContext && current.state === 'closed') {
          return {
            passed: false,
            anomaly: {
              type: 'circuit-breaker-not-triggered',
              current: current.state,
              expected: 'open',
              severity: 'warning'
            }
          };
        }
        return { passed: true };
      }
    });
  }

  /**
   * Validate baseline metrics exist
   */
  async validateBaseline(steadyState) {
    if (!steadyState || !steadyState.metrics) {
      return { valid: true };
    }

    for (const [name, config] of Object.entries(steadyState.metrics)) {
      const value = await this._fetchMetric(config);
      this.baselines.set(name, {
        value,
        timestamp: Date.now()
      });
    }

    logger.info('Baseline validated', { 
      metrics: Array.from(this.baselines.keys()) 
    });

    return { valid: true, baselines: Object.fromEntries(this.baselines) };
  }

  /**
   * Check steady state
   */
  async check(steadyState, context = {}) {
    const result = {
      passed: true,
      timestamp: Date.now(),
      checks: [],
      anomalies: []
    };

    if (!steadyState) {
      return result;
    }

    // Health checks
    if (steadyState.healthChecks) {
      for (const check of steadyState.healthChecks) {
        const checkResult = await this._checkHealth(check, context);
        result.checks.push(checkResult);
        if (!checkResult.passed) {
          result.passed = false;
          if (checkResult.anomaly) {
            result.anomalies.push(checkResult.anomaly);
          }
        }
      }
    }

    // Metric checks
    if (steadyState.metrics) {
      for (const [name, config] of Object.entries(steadyState.metrics)) {
        const currentValue = await this._fetchMetric(config);
        const baseline = this.baselines.get(name);
        const detector = this.detectors.get(name);

        if (detector) {
          const validationResult = detector.validate(currentValue, baseline?.value, context);
          result.checks.push({
            name,
            type: 'metric',
            current: currentValue,
            baseline: baseline?.value,
            ...validationResult
          });

          if (!validationResult.passed && validationResult.anomaly) {
            result.passed = false;
            result.anomalies.push({
              metric: name,
              ...validationResult.anomaly,
              timestamp: Date.now()
            });
          }
        }
      }
    }

    // Invariant checks
    if (steadyState.invariants) {
      for (const invariant of steadyState.invariants) {
        const invariantResult = await this._checkInvariant(invariant, context);
        result.checks.push(invariantResult);
        if (!invariantResult.passed) {
          result.passed = false;
          if (invariantResult.anomaly) {
            result.anomalies.push(invariantResult.anomaly);
          }
        }
      }
    }

    logger.info('Steady state check completed', {
      passed: result.passed,
      anomalyCount: result.anomalies.length
    });

    return result;
  }

  /**
   * Monitor steady state continuously
   */
  async monitor(baseline, duration = 60000) {
    const results = [];
    const startTime = Date.now();

    while (Date.now() - startTime < duration) {
      const check = await this.check(baseline);
      results.push(check);

      if (!check.passed) {
        logger.warn('Steady state violation detected', { 
          anomalies: check.anomalies 
        });
      }

      await this._sleep(this.checkInterval);
    }

    return {
      totalChecks: results.length,
      passedChecks: results.filter(r => r.passed).length,
      failedChecks: results.filter(r => !r.passed).length,
      results
    };
  }

  /**
   * Detect anomalies from metrics
   */
  async detectAnomalies(metrics) {
    const anomalies = [];

    for (const [name, value] of Object.entries(metrics)) {
      const baseline = this.baselines.get(name);
      if (!baseline) continue;

      const detector = this.detectors.get(name);
      if (detector) {
        const result = detector.validate(value, baseline.value, {});
        if (!result.passed && result.anomaly) {
          anomalies.push({
            metric: name,
            ...result.anomaly,
            timestamp: Date.now()
          });
        }
      }
    }

    return anomalies;
  }

  // ==================== Private Methods ====================

  async _checkHealth(checkConfig, context) {
    const { endpoint, service, expectedStatus = 200 } = checkConfig;

    try {
      const url = endpoint || `${this.metricsEndpoints.health.replace(':3000', `:${checkConfig.port || 3000}`)}`;
      const response = await this._httpRequest(url);
      
      const passed = response.statusCode === expectedStatus || 
                     (context.allowDegradation && response.statusCode < 500);

      return {
        type: 'health',
        service: service || 'unknown',
        endpoint: url,
        status: response.statusCode,
        passed,
        anomaly: passed ? null : {
          type: 'health-check-failed',
          current: response.statusCode,
          expected: expectedStatus,
          severity: response.statusCode >= 500 ? 'critical' : 'warning'
        }
      };
    } catch (error) {
      return {
        type: 'health',
        service: service || 'unknown',
        endpoint: checkConfig.endpoint,
        passed: false,
        error: error.message,
        anomaly: {
          type: 'health-check-unreachable',
          severity: 'critical'
        }
      };
    }
  }

  async _fetchMetric(config) {
    if (typeof config === 'number') {
      return config;
    }

    if (typeof config === 'function') {
      return config();
    }

    if (config.endpoint) {
      try {
        const response = await this._httpRequest(config.endpoint);
        const data = JSON.parse(response.body);
        return config.extract ? config.extract(data) : data;
      } catch (error) {
        logger.error('Failed to fetch metric', { 
          endpoint: config.endpoint, 
          error: error.message 
        });
        return null;
      }
    }

    return config.value || config;
  }

  async _checkInvariant(invariant, context) {
    try {
      const result = await invariant.check(context);
      return {
        type: 'invariant',
        name: invariant.name || 'custom',
        passed: result === true,
        result,
        anomaly: result === true ? null : {
          type: 'invariant-violated',
          invariant: invariant.name,
          result,
          severity: 'warning'
        }
      };
    } catch (error) {
      return {
        type: 'invariant',
        name: invariant.name || 'custom',
        passed: false,
        error: error.message,
        anomaly: {
          type: 'invariant-check-error',
          error: error.message,
          severity: 'warning'
        }
      };
    }
  }

  _httpRequest(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      const timeout = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, this.timeout);

      client.get(url, (res) => {
        clearTimeout(timeout);
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }).on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Register custom detector
   */
  registerDetector(name, detector) {
    this.detectors.set(name, detector);
    logger.info('Registered detector', { name });
  }

  /**
   * Set baseline manually
   */
  setBaseline(name, value) {
    this.baselines.set(name, {
      value,
      timestamp: Date.now()
    });
  }
}

module.exports = SteadyStateValidator;
