// backend/tests/chaos/chaos-engine.test.js
'use strict';
const assert = require('assert');
const ChaosEngine = require('../../shared/ChaosEngine');
const FaultInjector = require('../../shared/FaultInjector');
const SteadyStateValidator = require('../../shared/SteadyStateValidator');
const ChaosExperiment = require('../../shared/ChaosExperiment');

// Mock environment
process.env.NODE_ENV = 'test';

describe('ChaosEngine', function() {
  this.timeout(30000);

  let engine;

  beforeEach(() => {
    engine = new ChaosEngine({
      enabledEnvironments: ['test'],
      maxConcurrentExperiments: 2
    });
  });

  afterEach(async () => {
    if (engine) {
      await engine.shutdown();
    }
  });

  describe('initialization', () => {
    it('should initialize with default configuration', () => {
      assert.ok(engine);
      assert.strictEqual(engine.maxConcurrentExperiments, 2);
      assert.ok(engine.faultInjector instanceof FaultInjector);
      assert.ok(engine.validator instanceof SteadyStateValidator);
    });

    it('should have correct initial metrics', () => {
      const metrics = engine.getMetrics();
      assert.strictEqual(metrics.totalExperiments, 0);
      assert.strictEqual(metrics.successfulExperiments, 0);
      assert.strictEqual(metrics.activeExperiments, 0);
    });
  });

  describe('planExperiment', () => {
    it('should create a valid experiment plan', async () => {
      const experiment = await engine.planExperiment({
        name: 'test-experiment',
        faults: [{
          type: 'network-delay',
          target: 'gateway',
          duration: 5000,
          latency: '100ms'
        }]
      });

      assert.ok(experiment);
      assert.ok(experiment.id);
      assert.strictEqual(experiment.name, 'test-experiment');
      assert.strictEqual(experiment.faults.length, 1);
    });

    it('should reject invalid experiment config', async () => {
      await assert.rejects(
        async () => await engine.planExperiment({ name: '' }),
        /Experiment name is required/
      );

      await assert.rejects(
        async () => await engine.planExperiment({ name: 'test', faults: [] }),
        /At least one fault must be specified/
      );
    });

    it('should reject fault with missing required fields', async () => {
      await assert.rejects(
        async () => await engine.planExperiment({
          name: 'test',
          faults: [{ type: 'network-delay' }] // missing target and duration
        }),
        /Fault target is required/
      );
    });
  });

  describe('executeExperiment', () => {
    it('should execute a simple experiment', async () => {
      const experiment = await engine.planExperiment({
        name: 'simple-test',
        faults: [{
          type: 'network-delay',
          target: 'test-service',
          duration: 2000
        }]
      });

      const result = await engine.executeExperiment(experiment);

      assert.ok(result);
      assert.strictEqual(result.name, 'simple-test');
      assert.ok(['success', 'degraded', 'failed'].includes(result.status));
      assert.ok(result.duration >= 2000);
    });

    it('should track experiment metrics', async () => {
      const experiment = await engine.planExperiment({
        name: 'metrics-test',
        faults: [{
          type: 'network-delay',
          target: 'test-service',
          duration: 1000
        }]
      });

      await engine.executeExperiment(experiment);

      const metrics = engine.getMetrics();
      assert.strictEqual(metrics.totalExperiments, 1);
      assert.strictEqual(metrics.totalFaultsInjected, 1);
    });
  });

  describe('concurrent experiments', () => {
    it('should limit concurrent experiments', async () => {
      const exp1 = await engine.planExperiment({
        name: 'concurrent-1',
        faults: [{ type: 'network-delay', target: 'service-1', duration: 5000 }]
      });

      const exp2 = await engine.planExperiment({
        name: 'concurrent-2',
        faults: [{ type: 'network-delay', target: 'service-2', duration: 5000 }]
      });

      // Start first experiment
      const promise1 = engine.executeExperiment(exp1);

      // Second should be able to run (limit is 2)
      const promise2 = engine.executeExperiment(exp2);

      const [result1, result2] = await Promise.all([promise1, promise2]);
      assert.ok(result1);
      assert.ok(result2);
    });
  });

  describe('abortExperiment', () => {
    it('should abort a running experiment', async () => {
      const experiment = await engine.planExperiment({
        name: 'abort-test',
        faults: [{
          type: 'network-delay',
          target: 'test-service',
          duration: 10000
        }]
      });

      // Start experiment
      const executePromise = engine.executeExperiment(experiment);

      // Wait a bit then abort
      await new Promise(r => setTimeout(r, 500));
      await engine.abortExperiment(experiment.id);

      const result = await executePromise;
      assert.ok(result);
    });
  });
});

describe('FaultInjector', function() {
  let injector;

  beforeEach(() => {
    injector = new FaultInjector({
      k8sEnabled: false,
      dockerEnabled: false
    });
  });

  describe('initialization', () => {
    it('should initialize correctly', () => {
      assert.ok(injector);
      assert.ok(injector.getSupportedFaultTypes().length > 0);
    });

    it('should list supported fault types', () => {
      const types = injector.getSupportedFaultTypes();
      assert.ok(types.includes('network-delay'));
      assert.ok(types.includes('network-loss'));
      assert.ok(types.includes('process-kill'));
      assert.ok(types.includes('service-down'));
      assert.ok(types.includes('database-failure'));
      assert.ok(types.includes('cache-failure'));
    });
  });

  describe('inject', () => {
    it('should inject network delay fault', async () => {
      const injection = await injector.inject({
        type: 'network-delay',
        target: 'test-service',
        duration: 5000,
        latency: '100ms'
      });

      assert.ok(injection);
      assert.ok(injection.id);
      assert.strictEqual(injection.type, 'network-delay');
      assert.strictEqual(injection.status, 'active');
    });

    it('should inject network loss fault', async () => {
      const injection = await injector.inject({
        type: 'network-loss',
        target: 'test-service',
        duration: 5000,
        loss: '10%'
      });

      assert.ok(injection);
      assert.strictEqual(injection.type, 'network-loss');
    });

    it('should inject process stress fault', async () => {
      const injection = await injector.inject({
        type: 'cpu-stress',
        target: 'test-service',
        duration: 5000,
        cpu: 50
      });

      assert.ok(injection);
      assert.strictEqual(injection.type, 'cpu-stress');
    });

    it('should reject unknown fault type', async () => {
      await assert.rejects(
        async () => await injector.inject({
          type: 'unknown-fault',
          target: 'test'
        }),
        /Unknown fault type/
      );
    });
  });

  describe('recover', () => {
    it('should recover an injected fault', async () => {
      const injection = await injector.inject({
        type: 'network-delay',
        target: 'test-service',
        duration: 5000
      });

      await injector.recover(injection.id);

      const recovered = injector.injections.get(injection.id);
      assert.strictEqual(recovered.status, 'recovered');
    });

    it('should reject recovery of unknown injection', async () => {
      await assert.rejects(
        async () => await injector.recover('unknown-id'),
        /Injection not found/
      );
    });
  });
});

describe('SteadyStateValidator', function() {
  let validator;

  beforeEach(() => {
    validator = new SteadyStateValidator();
  });

  describe('initialization', () => {
    it('should initialize with default detectors', () => {
      assert.ok(validator);
      assert.ok(validator.detectors.has('successRate'));
      assert.ok(validator.detectors.has('responseTime'));
      assert.ok(validator.detectors.has('errorRate'));
    });
  });

  describe('check', () => {
    it('should pass when no steady state defined', async () => {
      const result = await validator.check(null);
      assert.ok(result.passed);
    });

    it('should check success rate', async () => {
      validator.setBaseline('successRate', 0.99);

      const result = await validator.check({
        metrics: {
          successRate: 0.995
        }
      });

      assert.ok(result.passed);
    });

    it('should detect success rate anomaly', async () => {
      validator.setBaseline('successRate', 0.99);

      const result = await validator.check({
        metrics: {
          successRate: 0.90
        }
      });

      assert.ok(!result.passed);
      assert.ok(result.anomalies.length > 0);
      assert.strictEqual(result.anomalies[0].type, 'success-rate-degraded');
    });

    it('should allow degradation in fault context', async () => {
      validator.setBaseline('successRate', 0.99);

      const result = await validator.check({
        metrics: {
          successRate: 0.96
        }
      }, { allowDegradation: true });

      assert.ok(result.passed);
    });
  });

  describe('detectAnomalies', () => {
    it('should detect anomalies in metrics', async () => {
      validator.setBaseline('successRate', 0.99);
      validator.setBaseline('errorRate', 0.01);

      const anomalies = await validator.detectAnomalies({
        successRate: 0.85,
        errorRate: 0.15
      });

      assert.ok(anomalies.length >= 1);
    });
  });

  describe('registerDetector', () => {
    it('should register custom detector', () => {
      validator.registerDetector('custom', {
        validate: (current, baseline, context) => {
          return { passed: current > 0.5 };
        }
      });

      assert.ok(validator.detectors.has('custom'));
    });
  });
});

describe('ChaosExperiment', function() {
  describe('creation', () => {
    it('should create experiment with defaults', () => {
      const exp = new ChaosExperiment({
        name: 'test',
        faults: [{ type: 'network-delay', target: 'test', duration: 5000 }]
      });

      assert.ok(exp.id);
      assert.strictEqual(exp.name, 'test');
      assert.strictEqual(exp.status, 'planned');
    });

    it('should generate unique IDs', () => {
      const exp1 = new ChaosExperiment({ name: 'test1', faults: [] });
      const exp2 = new ChaosExperiment({ name: 'test2', faults: [] });

      assert.notStrictEqual(exp1.id, exp2.id);
    });
  });

  describe('validation', () => {
    it('should validate correct experiment', () => {
      const exp = new ChaosExperiment({
        name: 'valid-test',
        faults: [{ type: 'network-delay', target: 'test', duration: 5000 }],
        timeout: 30000
      });

      const result = exp.validate();
      assert.ok(result.valid);
      assert.strictEqual(result.errors.length, 0);
    });

    it('should detect invalid experiment', () => {
      const exp = new ChaosExperiment({
        name: 'ab',
        faults: [],
        timeout: 5000
      });

      const result = exp.validate();
      assert.ok(!result.valid);
      assert.ok(result.errors.length > 0);
    });
  });

  describe('templates', () => {
    it('should create service failure experiment', () => {
      const exp = ChaosExperiment.TEMPLATES.serviceFailure('gateway', 60000);

      assert.ok(exp);
      assert.strictEqual(exp.faults.length, 1);
      assert.strictEqual(exp.faults[0].type, 'service-down');
      assert.strictEqual(exp.faults[0].target, 'gateway');
    });

    it('should create network latency experiment', () => {
      const exp = ChaosExperiment.TEMPLATES.networkLatency('api', '200ms', 30000);

      assert.ok(exp);
      assert.strictEqual(exp.faults[0].type, 'network-delay');
      assert.strictEqual(exp.faults[0].latency, '200ms');
    });

    it('should create cascade failure experiment', () => {
      const exp = ChaosExperiment.TEMPLATES.cascadeFailure(['gateway', 'user-service'], 60000);

      assert.ok(exp);
      assert.strictEqual(exp.faults.length, 2);
      assert.ok(exp.parallelFaults);
    });
  });

  describe('export', () => {
    it('should export to JSON', () => {
      const exp = new ChaosExperiment({
        name: 'test',
        faults: [{ type: 'network-delay', target: 'test', duration: 5000 }]
      });

      const json = exp.toJSON();
      assert.ok(json);
      assert.strictEqual(json.name, 'test');
    });

    it('should export to YAML', () => {
      const exp = new ChaosExperiment({
        name: 'test',
        faults: [{ type: 'network-delay', target: 'test', duration: 5000 }]
      });

      const yaml = exp.toYaml();
      assert.ok(yaml);
      assert.ok(yaml.includes('name: test'));
      assert.ok(yaml.includes('network-delay'));
    });
  });

  describe('modification', () => {
    it('should add fault', () => {
      const exp = new ChaosExperiment({
        name: 'test',
        faults: []
      });

      exp.addFault({ type: 'network-delay', target: 'test', duration: 5000 });
      assert.strictEqual(exp.faults.length, 1);
    });

    it('should remove fault', () => {
      const exp = new ChaosExperiment({
        name: 'test',
        faults: [
          { type: 'network-delay', target: 'test', duration: 5000 },
          { type: 'network-loss', target: 'test', duration: 5000 }
        ]
      });

      exp.removeFault(0);
      assert.strictEqual(exp.faults.length, 1);
      assert.strictEqual(exp.faults[0].type, 'network-loss');
    });

    it('should clone experiment', () => {
      const exp1 = new ChaosExperiment({
        name: 'original',
        faults: [{ type: 'network-delay', target: 'test', duration: 5000 }]
      });

      const exp2 = exp1.clone({ name: 'cloned' });

      assert.notStrictEqual(exp1.id, exp2.id);
      assert.strictEqual(exp2.name, 'cloned');
      assert.strictEqual(exp2.faults.length, 1);
    });
  });
});
