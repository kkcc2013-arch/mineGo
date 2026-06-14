// backend/shared/ChaosExperiment.js
'use strict';
const { createLogger } = require('./logger');
const crypto = require('crypto');

const logger = createLogger('chaos-experiment');

/**
 * Chaos Experiment
 * 
 * Represents a single chaos engineering experiment with
 * defined faults, steady state checks, and hypotheses.
 */
class ChaosExperiment {
  constructor(config) {
    // Identity
    this.id = config.id || this._generateId();
    this.name = config.name;
    this.description = config.description || '';
    
    // Faults to inject
    this.faults = config.faults || [];
    
    // Steady state definition
    this.steadyState = config.steadyState || null;
    
    // Hypothesis
    this.hypothesis = config.hypothesis || 'System should maintain steady state under fault conditions';
    
    // Configuration
    this.timeout = config.timeout || 300000; // 5 minutes
    this.parallelFaults = config.parallelFaults || false;
    this.abortOnViolation = config.abortOnViolation !== false;
    
    // Components (injected)
    this.engine = config.engine || null;
    this.faultInjector = config.faultInjector || null;
    this.validator = config.validator || null;
    
    // Metadata
    this.tags = config.tags || [];
    this.author = config.author || 'system';
    this.createdAt = Date.now();
    
    // State
    this.status = 'planned';
    this.results = null;
    
    logger.info('ChaosExperiment created', { 
      id: this.id, 
      name: this.name,
      faultCount: this.faults.length 
    });
  }

  /**
   * Generate unique experiment ID
   */
  _generateId() {
    return `exp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Validate experiment configuration
   */
  validate() {
    const errors = [];

    if (!this.name || this.name.length < 3) {
      errors.push('Experiment name must be at least 3 characters');
    }

    if (this.faults.length === 0) {
      errors.push('At least one fault must be defined');
    }

    for (let i = 0; i < this.faults.length; i++) {
      const fault = this.faults[i];
      if (!fault.type) {
        errors.push(`Fault ${i + 1}: type is required`);
      }
      if (!fault.target) {
        errors.push(`Fault ${i + 1}: target is required`);
      }
      if (!fault.duration || fault.duration < 1000) {
        errors.push(`Fault ${i + 1}: duration must be at least 1000ms`);
      }
    }

    if (this.timeout < 10000) {
      errors.push('Experiment timeout must be at least 10 seconds');
    }

    const totalFaultDuration = this.faults.reduce((sum, f) => sum + f.duration, 0);
    if (totalFaultDuration > this.timeout) {
      errors.push('Total fault duration exceeds experiment timeout');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Get experiment summary
   */
  getSummary() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      status: this.status,
      faultCount: this.faults.length,
      faultTypes: [...new Set(this.faults.map(f => f.type))],
      targets: [...new Set(this.faults.map(f => f.target))],
      totalDuration: this.faults.reduce((sum, f) => sum + f.duration, 0),
      timeout: this.timeout,
      hasSteadyState: !!this.steadyState,
      hypothesis: this.hypothesis,
      tags: this.tags,
      createdAt: this.createdAt
    };
  }

  /**
   * Get detailed configuration
   */
  getConfig() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      faults: this.faults,
      steadyState: this.steadyState,
      hypothesis: this.hypothesis,
      timeout: this.timeout,
      parallelFaults: this.parallelFaults,
      abortOnViolation: this.abortOnViolation,
      tags: this.tags,
      author: this.author
    };
  }

  /**
   * Export to JSON
   */
  toJSON() {
    return {
      ...this.getConfig(),
      status: this.status,
      results: this.results,
      createdAt: this.createdAt
    };
  }

  /**
   * Export to YAML (for K8s Chaos Mesh)
   */
  toYaml() {
    let yaml = `# Chaos Experiment: ${this.name}\n`;
    yaml += `# Generated: ${new Date(this.createdAt).toISOString()}\n\n`;
    yaml += `name: ${this.name}\n`;
    yaml += `description: ${this.description}\n`;
    yaml += `hypothesis: ${this.hypothesis}\n`;
    yaml += `timeout: ${this.timeout}ms\n\n`;
    yaml += `faults:\n`;

    for (const fault of this.faults) {
      yaml += `  - type: ${fault.type}\n`;
      yaml += `    target: ${fault.target}\n`;
      yaml += `    duration: ${fault.duration}ms\n`;
      if (fault.params) {
        for (const [key, value] of Object.entries(fault.params)) {
          yaml += `    ${key}: ${value}\n`;
        }
      }
    }

    if (this.steadyState) {
      yaml += `\nsteadyState:\n`;
      if (this.steadyState.healthChecks) {
        yaml += `  healthChecks:\n`;
        for (const check of this.steadyState.healthChecks) {
          yaml += `    - service: ${check.service || 'unknown'}\n`;
          yaml += `      endpoint: ${check.endpoint}\n`;
        }
      }
      if (this.steadyState.metrics) {
        yaml += `  metrics:\n`;
        for (const [name, config] of Object.entries(this.steadyState.metrics)) {
          yaml += `    ${name}: ${typeof config === 'object' ? JSON.stringify(config) : config}\n`;
        }
      }
    }

    return yaml;
  }

  /**
   * Clone experiment with modifications
   */
  clone(modifications = {}) {
    return new ChaosExperiment({
      ...this.getConfig(),
      ...modifications,
      id: undefined // Generate new ID
    });
  }

  /**
   * Add a fault
   */
  addFault(fault) {
    this.faults.push(fault);
    logger.info('Fault added to experiment', { 
      experimentId: this.id, 
      faultType: fault.type 
    });
    return this;
  }

  /**
   * Remove a fault
   */
  removeFault(index) {
    if (index >= 0 && index < this.faults.length) {
      this.faults.splice(index, 1);
      logger.info('Fault removed from experiment', { experimentId: this.id, index });
    }
    return this;
  }

  /**
   * Set steady state
   */
  setSteadyState(steadyState) {
    this.steadyState = steadyState;
    return this;
  }

  /**
   * Add tag
   */
  addTag(tag) {
    if (!this.tags.includes(tag)) {
      this.tags.push(tag);
    }
    return this;
  }
}

/**
 * Predefined experiment templates
 */
ChaosExperiment.TEMPLATES = {
  // Single service failure
  serviceFailure: (serviceName, duration = 60000) => new ChaosExperiment({
    name: `${serviceName}-failure-test`,
    description: `Test system resilience when ${serviceName} fails`,
    faults: [{
      type: 'service-down',
      target: serviceName,
      duration
    }],
    hypothesis: `System should degrade gracefully when ${serviceName} is unavailable`,
    tags: ['service-failure', serviceName]
  }),

  // Network latency
  networkLatency: (target, latency = '500ms', duration = 60000) => new ChaosExperiment({
    name: `${target}-network-latency-test`,
    description: `Test system behavior under network latency for ${target}`,
    faults: [{
      type: 'network-delay',
      target,
      duration,
      latency,
      jitter: '100ms'
    }],
    hypothesis: 'System should handle increased latency with timeouts and retries',
    tags: ['network', 'latency', target]
  }),

  // Database failure
  databaseFailure: (duration = 60000) => new ChaosExperiment({
    name: 'database-failure-test',
    description: 'Test system resilience when database is unavailable',
    faults: [{
      type: 'database-failure',
      target: 'postgres',
      duration,
      failureType: 'unavailable'
    }],
    hypothesis: 'System should fail gracefully and recover when database returns',
    tags: ['database', 'failure']
  }),

  // Cascade failure (multiple services)
  cascadeFailure: (services, duration = 60000) => new ChaosExperiment({
    name: 'cascade-failure-test',
    description: `Test system resilience when multiple services fail: ${services.join(', ')}`,
    faults: services.map(service => ({
      type: 'service-down',
      target: service,
      duration
    })),
    hypothesis: 'System should maintain core functionality even with multiple service failures',
    tags: ['cascade', 'multi-service'],
    parallelFaults: true
  }),

  // Resource exhaustion
  resourceExhaustion: (target, cpu = 80, duration = 60000) => new ChaosExperiment({
    name: `${target}-resource-exhaustion-test`,
    description: `Test system behavior under resource pressure on ${target}`,
    faults: [{
      type: 'cpu-stress',
      target,
      duration,
      cpu
    }],
    hypothesis: 'System should maintain stability under resource pressure',
    tags: ['resource', 'stress', target]
  })
};

module.exports = ChaosExperiment;
