// backend/shared/ChaosEngine.js
'use strict';
const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const FaultInjector = require('./FaultInjector');
const SteadyStateValidator = require('./SteadyStateValidator');
const ChaosExperiment = require('./ChaosExperiment');

const logger = createLogger('chaos-engine');

/**
 * Chaos Engineering Engine
 * 
 * Orchestrates fault injection experiments to validate system resilience.
 * Supports controlled fault injection, steady state monitoring, and automated recovery.
 * 
 * @example
 * const engine = new ChaosEngine();
 * const experiment = await engine.planExperiment({
 *   name: 'gateway-failure',
 *   faults: [{ type: 'service-down', target: 'gateway', duration: 60000 }]
 * });
 * const result = await engine.executeExperiment(experiment);
 */
class ChaosEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.maxConcurrentExperiments = options.maxConcurrentExperiments || 3;
    this.defaultTimeout = options.defaultTimeout || 300000; // 5 minutes
    this.safetyMargin = options.safetyMargin || 0.1; // 10% safety buffer
    this.enabledEnvironments = options.enabledEnvironments || ['test', 'staging'];
    
    // Components
    this.faultInjector = new FaultInjector(options.faultInjector || {});
    this.validator = new SteadyStateValidator(options.validator || {});
    
    // State
    this.experiments = new Map();
    this.activeExperiments = new Set();
    this.injectionHistory = [];
    
    // Metrics
    this.metrics = {
      totalExperiments: 0,
      successfulExperiments: 0,
      failedExperiments: 0,
      abortedExperiments: 0,
      totalFaultsInjected: 0,
      totalRecoveryTime: 0
    };
    
    // Safety check
    this._validateEnvironment();
    
    logger.info('ChaosEngine initialized', {
      maxConcurrent: this.maxConcurrentExperiments,
      enabledEnvs: this.enabledEnvironments
    });
  }

  /**
   * Validate that chaos engineering is allowed in current environment
   */
  _validateEnvironment() {
    const env = process.env.NODE_ENV || 'development';
    if (!this.enabledEnvironments.includes(env)) {
      logger.warn(`Chaos engineering disabled in environment: ${env}`);
      this.disabled = true;
    }
  }

  /**
   * Plan a chaos experiment
   * @param {Object} config - Experiment configuration
   * @returns {Promise<ChaosExperiment>}
   */
  async planExperiment(config) {
    if (this.disabled) {
      throw new Error('Chaos engineering is disabled in this environment');
    }

    this._validateConfig(config);

    const experiment = new ChaosExperiment({
      ...config,
      engine: this,
      faultInjector: this.faultInjector,
      validator: this.validator
    });

    // Validate experiment safety
    await this._validateSafety(experiment);

    this.experiments.set(experiment.id, experiment);
    
    logger.info('Experiment planned', {
      id: experiment.id,
      name: experiment.name,
      faults: experiment.faults.length
    });

    this.emit('experiment:planned', experiment);
    return experiment;
  }

  /**
   * Validate experiment configuration
   */
  _validateConfig(config) {
    if (!config.name || typeof config.name !== 'string') {
      throw new Error('Experiment name is required');
    }

    if (!Array.isArray(config.faults) || config.faults.length === 0) {
      throw new Error('At least one fault must be specified');
    }

    for (const fault of config.faults) {
      if (!fault.type) {
        throw new Error('Fault type is required');
      }
      if (!fault.target) {
        throw new Error('Fault target is required');
      }
      if (!fault.duration || fault.duration < 1000) {
        throw new Error('Fault duration must be at least 1000ms');
      }
    }
  }

  /**
   * Validate experiment safety constraints
   */
  async _validateSafety(experiment) {
    // Check concurrent experiment limit
    if (this.activeExperiments.size >= this.maxConcurrentExperiments) {
      throw new Error(`Maximum concurrent experiments (${this.maxConcurrentExperiments}) reached`);
    }

    // Check for overlapping targets
    const activeTargets = new Set();
    for (const activeId of this.activeExperiments) {
      const active = this.experiments.get(activeId);
      if (active) {
        active.faults.forEach(f => activeTargets.add(f.target));
      }
    }

    for (const fault of experiment.faults) {
      if (activeTargets.has(fault.target)) {
        throw new Error(`Target ${fault.target} is already under active experiment`);
      }
    }

    // Validate steady state baseline exists
    if (experiment.steadyState) {
      await this.validator.validateBaseline(experiment.steadyState);
    }
  }

  /**
   * Execute a chaos experiment
   * @param {ChaosExperiment|string} experiment - Experiment or experiment ID
   * @returns {Promise<Object>}
   */
  async executeExperiment(experiment) {
    if (this.disabled) {
      throw new Error('Chaos engineering is disabled in this environment');
    }

    const exp = typeof experiment === 'string' 
      ? this.experiments.get(experiment) 
      : experiment;

    if (!exp) {
      throw new Error('Experiment not found');
    }

    if (this.activeExperiments.has(exp.id)) {
      throw new Error('Experiment is already running');
    }

    this.activeExperiments.add(exp.id);
    this.metrics.totalExperiments++;

    const startTime = Date.now();
    const result = {
      id: exp.id,
      name: exp.name,
      status: 'running',
      startTime,
      faults: [],
      steadyStateChecks: [],
      anomalies: [],
      recoveryTime: 0
    };

    try {
      // Phase 1: Pre-experiment steady state check
      logger.info('Starting experiment', { id: exp.id, name: exp.name });
      this.emit('experiment:started', exp);

      if (exp.steadyState) {
        const preCheck = await this.validator.check(exp.steadyState);
        result.steadyStateChecks.push({ phase: 'pre', ...preCheck });
        
        if (!preCheck.passed) {
          throw new Error(`Pre-experiment steady state check failed: ${preCheck.message}`);
        }
      }

      // Phase 2: Inject faults
      for (const fault of exp.faults) {
        logger.info('Injecting fault', { type: fault.type, target: fault.target });
        
        const injection = await this.faultInjector.inject(fault);
        result.faults.push({
          ...fault,
          injectionId: injection.id,
          status: 'injected',
          timestamp: Date.now()
        });
        
        this.metrics.totalFaultsInjected++;
        this.injectionHistory.push(injection);
        this.emit('fault:injected', injection);

        // Wait for fault duration
        await this._sleep(fault.duration);

        // Phase 3: Monitor during fault
        if (exp.steadyState) {
          const duringCheck = await this.validator.check(exp.steadyState, { 
            allowDegradation: true,
            faultContext: fault 
          });
          result.steadyStateChecks.push({ phase: 'during', fault: fault.type, ...duringCheck });
          
          // Record anomalies
          if (duringCheck.anomalies) {
            result.anomalies.push(...duringCheck.anomalies);
          }
        }
      }

      // Phase 4: Recover faults
      const recoveryStart = Date.now();
      for (const faultResult of result.faults) {
        await this.faultInjector.recover(faultResult.injectionId);
        faultResult.status = 'recovered';
        this.emit('fault:recovered', faultResult);
      }
      
      result.recoveryTime = Date.now() - recoveryStart;
      this.metrics.totalRecoveryTime += result.recoveryTime;

      // Phase 5: Post-experiment steady state check
      await this._sleep(5000); // Wait for system to stabilize

      if (exp.steadyState) {
        const postCheck = await this.validator.check(exp.steadyState);
        result.steadyStateChecks.push({ phase: 'post', ...postCheck });
        
        if (!postCheck.passed) {
          result.status = 'degraded';
          result.message = 'System did not fully recover to steady state';
        } else {
          result.status = 'success';
        }
      } else {
        result.status = 'success';
      }

      this.metrics.successfulExperiments++;
      logger.info('Experiment completed', { id: exp.id, status: result.status });

    } catch (error) {
      result.status = 'failed';
      result.error = error.message;
      this.metrics.failedExperiments++;
      
      logger.error('Experiment failed', { id: exp.id, error: error.message });
      
      // Attempt recovery
      try {
        for (const faultResult of result.faults) {
          if (faultResult.status === 'injected') {
            await this.faultInjector.recover(faultResult.injectionId);
            faultResult.status = 'recovered';
          }
        }
      } catch (recoveryError) {
        logger.error('Recovery failed', { error: recoveryError.message });
      }
    } finally {
      result.endTime = Date.now();
      result.duration = result.endTime - startTime;
      
      this.activeExperiments.delete(exp.id);
      this.emit('experiment:completed', result);
    }

    return result;
  }

  /**
   * Abort a running experiment
   * @param {string} experimentId - Experiment ID
   */
  async abortExperiment(experimentId) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error('Experiment not found');
    }

    if (!this.activeExperiments.has(experimentId)) {
      throw new Error('Experiment is not running');
    }

    logger.info('Aborting experiment', { id: experimentId });
    
    // Recover all injected faults
    for (const injection of this.injectionHistory) {
      if (injection.experimentId === experimentId && injection.status === 'active') {
        await this.faultInjector.recover(injection.id);
      }
    }

    this.activeExperiments.delete(experimentId);
    this.metrics.abortedExperiments++;
    
    this.emit('experiment:aborted', { id: experimentId });
  }

  /**
   * Get experiment status
   * @param {string} experimentId - Experiment ID
   */
  getExperimentStatus(experimentId) {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      return null;
    }

    return {
      id: experiment.id,
      name: experiment.name,
      isActive: this.activeExperiments.has(experimentId),
      faults: experiment.faults,
      createdAt: experiment.createdAt
    };
  }

  /**
   * List all experiments
   */
  listExperiments() {
    return Array.from(this.experiments.values()).map(exp => ({
      id: exp.id,
      name: exp.name,
      isActive: this.activeExperiments.has(exp.id),
      faults: exp.faults.length
    }));
  }

  /**
   * Get engine metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeExperiments: this.activeExperiments.size,
      totalExperiments: this.experiments.size,
      averageRecoveryTime: this.metrics.totalExperiments > 0
        ? this.metrics.totalRecoveryTime / this.metrics.totalExperiments
        : 0
    };
  }

  /**
   * Inject a single fault (standalone, not part of experiment)
   */
  async injectFault(type, target, params = {}) {
    if (this.disabled) {
      throw new Error('Chaos engineering is disabled in this environment');
    }

    const fault = {
      type,
      target,
      duration: params.duration || 60000,
      ...params
    };

    const injection = await this.faultInjector.inject(fault);
    this.metrics.totalFaultsInjected++;
    this.injectionHistory.push(injection);
    
    this.emit('fault:injected', injection);
    return injection;
  }

  /**
   * Recover a fault injection
   */
  async recoverFault(injectionId) {
    await this.faultInjector.recover(injectionId);
    this.emit('fault:recovered', { id: injectionId });
  }

  /**
   * Monitor steady state
   */
  async monitorSteadyState(baseline) {
    return this.validator.monitor(baseline);
  }

  /**
   * Detect anomalies
   */
  async detectAnomaly(metrics) {
    return this.validator.detectAnomalies(metrics);
  }

  /**
   * Helper: sleep
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Cleanup and shutdown
   */
  async shutdown() {
    // Recover all active faults
    for (const injection of this.injectionHistory) {
      if (injection.status === 'active') {
        try {
          await this.faultInjector.recover(injection.id);
        } catch (error) {
          logger.error('Failed to recover fault during shutdown', { 
            id: injection.id, 
            error: error.message 
          });
        }
      }
    }

    // Abort all active experiments
    for (const experimentId of this.activeExperiments) {
      try {
        await this.abortExperiment(experimentId);
      } catch (error) {
        logger.error('Failed to abort experiment during shutdown', { 
          id: experimentId, 
          error: error.message 
        });
      }
    }

    logger.info('ChaosEngine shutdown complete');
  }
}

module.exports = ChaosEngine;
