/**
 * 灾难演练系统单元测试
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { DrillScenario, DrillExecutor, DrillReportGenerator, DrillScenarioLibrary } = require('../../shared/drillEngine');

describe('DrillScenario', () => {
  describe('constructor', () => {
    it('should create scenario with default values', () => {
      const scenario = new DrillScenario({
        name: 'Test Scenario',
        description: 'Test description'
      });

      expect(scenario.name).to.equal('Test Scenario');
      expect(scenario.type).to.equal('full');
      expect(scenario.duration).to.equal(1800000);
      expect(scenario.rtoTarget).to.equal(300000);
      expect(scenario.rpoTarget).to.equal(60000);
      expect(scenario.autoRollback).to.be.true;
    });

    it('should create scenario with custom values', () => {
      const scenario = new DrillScenario({
        id: 'test-001',
        name: 'Custom Scenario',
        type: 'partial',
        duration: 600000,
        rtoTarget: 120000,
        rpoTarget: 30000,
        autoRollback: false
      });

      expect(scenario.id).to.equal('test-001');
      expect(scenario.type).to.equal('partial');
      expect(scenario.duration).to.equal(600000);
      expect(scenario.rtoTarget).to.equal(120000);
      expect(scenario.rpoTarget).to.equal(30000);
      expect(scenario.autoRollback).to.be.false;
    });

    it('should convert to JSON correctly', () => {
      const scenario = new DrillScenario({
        id: 'test-002',
        name: 'JSON Test',
        description: 'Test JSON conversion'
      });

      const json = scenario.toJSON();

      expect(json.id).to.equal('test-002');
      expect(json.name).to.equal('JSON Test');
      expect(json.type).to.equal('full');
      expect(json).to.have.property('chaosExperiments');
    });
  });
});

describe('DrillExecutor', () => {
  let executor;
  let k8sClientMock;
  let prometheusClientMock;

  beforeEach(() => {
    k8sClientMock = {
      createCustomResource: sinon.stub().resolves({ metadata: { name: 'test-chaos' } }),
      deleteCustomResource: sinon.stub().resolves()
    };

    prometheusClientMock = {
      query: sinon.stub().resolves(0.95)
    };

    executor = new DrillExecutor(k8sClientMock, prometheusClientMock);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('injectChaos', () => {
    it('should inject chaos experiment successfully', async () => {
      const experiment = {
        kind: 'NetworkChaos',
        spec: {
          action: 'delay',
          mode: 'all',
          delay: { latency: '500ms' }
        }
      };

      const result = await executor.injectChaos(experiment);

      expect(result.status).to.equal('injected');
      expect(result.kind).to.equal('NetworkChaos');
      expect(k8sClientMock.createCustomResource.calledOnce).to.be.true;
    });

    it('should handle injection failure', async () => {
      k8sClientMock.createCustomResource.rejects(new Error('K8s error'));

      const experiment = {
        kind: 'PodChaos',
        spec: { action: 'pod-kill' }
      };

      try {
        await executor.injectChaos(experiment);
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.equal('K8s error');
      }
    });
  });

  describe('rollbackExperiment', () => {
    it('should rollback chaos experiment successfully', async () => {
      // First inject
      await executor.activeExperiments.set('test-id', { kind: 'NetworkChaos' });

      const result = await executor.rollbackExperiment('test-id', 'NetworkChaos');

      expect(result.status).to.equal('rolled-back');
      expect(k8sClientMock.deleteCustomResource.calledOnce).to.be.true;
    });

    it('should handle rollback failure', async () => {
      k8sClientMock.deleteCustomResource.rejects(new Error('Delete failed'));

      try {
        await executor.rollbackExperiment('test-id', 'NetworkChaos');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error.message).to.equal('Delete failed');
      }
    });
  });

  describe('rollbackAll', () => {
    it('should rollback all active experiments', async () => {
      executor.activeExperiments.set('exp-1', { kind: 'NetworkChaos' });
      executor.activeExperiments.set('exp-2', { kind: 'PodChaos' });

      await executor.rollbackAll();

      expect(executor.activeExperiments.size).to.equal(0);
      expect(k8sClientMock.deleteCustomResource.calledTwice).to.be.true;
    });
  });

  describe('collectBaselineMetrics', () => {
    it('should collect baseline metrics successfully', async () => {
      const metrics = await executor.collectBaselineMetrics();

      expect(metrics).to.have.property('availability');
      expect(metrics).to.have.property('latency');
      expect(metrics).to.have.property('errorRate');
      expect(metrics).to.have.property('throughput');
      expect(prometheusClientMock.query.callCount).to.equal(4);
    });

    it('should handle metrics collection failure', async () => {
      prometheusClientMock.query.rejects(new Error('Prometheus error'));

      const metrics = await executor.collectBaselineMetrics();

      expect(metrics).to.deep.equal({});
    });
  });

  describe('calculateResults', () => {
    it('should calculate SLO compliance correctly', () => {
      const execution = {
        experiments: [],
        metrics: {
          baseline: {
            availability: 0.99,
            latency: 0.1,
            errorRate: 0.01
          },
          during: {
            availability: 0.95,
            latency: 0.15,
            errorRate: 0.02
          },
          after: {
            availability: 0.98,
            latency: 0.11,
            errorRate: 0.01
          }
        },
        chaosExperiments: [],
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 1800000).toISOString()
      };

      const results = executor.calculateResults(execution);

      expect(results).to.have.property('sloCompliance');
      expect(results).to.have.property('rto');
      expect(results).to.have.property('rpo');
      expect(results.sloCompliance.availability.passed).to.be.true;
    });

    it('should detect SLO violations', () => {
      const execution = {
        experiments: [],
        metrics: {
          baseline: {
            availability: 0.99,
            latency: 0.1,
            errorRate: 0.01
          },
          during: {
            availability: 0.85, // 大幅下降
            latency: 0.3, // 增加 3 倍
            errorRate: 0.1 // 增加 10 倍
          },
          after: {
            availability: 0.98,
            latency: 0.11,
            errorRate: 0.01
          }
        },
        chaosExperiments: [],
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 1800000).toISOString()
      };

      const results = executor.calculateResults(execution);

      expect(results.sloCompliance.availability.passed).to.be.false;
      expect(results.sloCompliance.latency.passed).to.be.false;
    });
  });

  describe('calculateOverallImpact', () => {
    it('should return low impact for high scores', () => {
      const sloCompliance = {
        availability: { passed: true },
        latency: { passed: true },
        errorRate: { passed: true }
      };

      const impact = executor.calculateOverallImpact(sloCompliance);
      expect(impact).to.equal('low');
    });

    it('should return high impact for low scores', () => {
      const sloCompliance = {
        availability: { passed: false },
        latency: { passed: false },
        errorRate: { passed: false }
      };

      const impact = executor.calculateOverallImpact(sloCompliance);
      expect(impact).to.equal('high');
    });

    it('should return medium impact for mixed scores', () => {
      const sloCompliance = {
        availability: { passed: true },
        latency: { passed: false },
        errorRate: { passed: true }
      };

      const impact = executor.calculateOverallImpact(sloCompliance);
      expect(impact).to.equal('medium');
    });
  });
});

describe('DrillReportGenerator', () => {
  let generator;

  beforeEach(() => {
    generator = new DrillReportGenerator();
  });

  describe('generateStandardReport', () => {
    it('should generate standard report successfully', async () => {
      const execution = {
        id: 'exec-001',
        scenarioId: 'region-outage',
        status: 'completed',
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 1800000).toISOString(),
        duration: 1800000,
        experiments: [],
        metrics: {
          baseline: { availability: 0.99 },
          during: { availability: 0.95 },
          after: { availability: 0.98 }
        },
        results: {
          sloCompliance: {
            availability: { passed: true }
          },
          rto: 300000,
          rpo: 60000,
          impactAnalysis: {
            overallImpact: 'low'
          },
          recoveryAnalysis: {
            recoveryTime: 300000
          }
        }
      };

      const report = await generator.generateReport(execution, 'standard');

      expect(report.metadata.executionId).to.equal('exec-001');
      expect(report.summary.status).to.equal('completed');
      expect(report).to.have.property('recommendations');
    });
  });

  describe('generateDetailedReport', () => {
    it('should generate detailed report with metrics', async () => {
      const execution = {
        id: 'exec-002',
        scenarioId: 'db-failure',
        status: 'completed',
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 600000).toISOString(),
        duration: 600000,
        experiments: [
          {
            experimentId: 'chaos-001',
            kind: 'PodChaos',
            status: 'injected',
            createdAt: new Date().toISOString()
          }
        ],
        metrics: {
          baseline: { availability: 0.99 },
          during: { availability: 0.90 },
          after: { availability: 0.98 }
        },
        results: {
          sloCompliance: {},
          impactAnalysis: {},
          recoveryAnalysis: {}
        }
      };

      const report = await generator.generateReport(execution, 'detailed');

      expect(report).to.have.property('detailedMetrics');
      expect(report).to.have.property('experiments');
      expect(report).to.have.property('timeline');
      expect(report.experiments).to.have.lengthOf(1);
    });
  });

  describe('generateSummaryReport', () => {
    it('should generate summary report', async () => {
      const execution = {
        id: 'exec-003',
        scenarioId: 'network-latency',
        status: 'completed',
        duration: 900000,
        results: {
          impactAnalysis: { overallImpact: 'medium' },
          rto: 180000,
          rpo: 30000
        }
      };

      const report = await generator.generateReport(execution, 'summary');

      expect(report.executionId).to.equal('exec-003');
      expect(report.overallImpact).to.equal('medium');
      expect(report.passed).to.be.a('boolean');
    });
  });

  describe('generateRecommendations', () => {
    it('should generate recommendations for RTO violation', () => {
      const execution = {
        results: {
          rto: 400000, // 超过 5 分钟
          sloCompliance: {
            availability: { passed: true },
            latency: { passed: true }
          }
        }
      };

      const recommendations = generator.generateRecommendations(execution);

      expect(recommendations).to.have.length.greaterThan(0);
      expect(recommendations[0].category).to.equal('performance');
      expect(recommendations[0].severity).to.equal('high');
    });

    it('should generate recommendations for availability drop', () => {
      const execution = {
        results: {
          rto: 200000,
          sloCompliance: {
            availability: {
              passed: false,
              drop: 0.1 // 下降 10%
            },
            latency: { passed: true }
          }
        }
      };

      const recommendations = generator.generateRecommendations(execution);

      const availabilityRec = recommendations.find(r => r.category === 'availability');
      expect(availabilityRec).to.exist;
      expect(availabilityRec.severity).to.equal('high');
    });
  });

  describe('evaluateDrillPass', () => {
    it('should pass when all criteria met', () => {
      const execution = {
        status: 'completed',
        results: {
          rto: 200000,
          rpo: 30000,
          sloCompliance: {
            availability: { passed: true },
            latency: { passed: true },
            errorRate: { passed: true }
          }
        }
      };

      const passed = generator.evaluateDrillPass(execution);
      expect(passed).to.be.true;
    });

    it('should fail when status is not completed', () => {
      const execution = {
        status: 'failed',
        results: {}
      };

      const passed = generator.evaluateDrillPass(execution);
      expect(passed).to.be.false;
    });

    it('should fail when RTO exceeds target', () => {
      const execution = {
        status: 'completed',
        results: {
          rto: 400000, // 超过 5 分钟
          rpo: 30000,
          sloCompliance: {
            availability: { passed: true }
          }
        }
      };

      const passed = generator.evaluateDrillPass(execution);
      expect(passed).to.be.false;
    });

    it('should fail when SLO not met', () => {
      const execution = {
        status: 'completed',
        results: {
          rto: 200000,
          rpo: 30000,
          sloCompliance: {
            availability: { passed: false }
          }
        }
      };

      const passed = generator.evaluateDrillPass(execution);
      expect(passed).to.be.false;
    });
  });
});

describe('DrillScenarioLibrary', () => {
  describe('createDefaultScenarios', () => {
    it('should create default scenarios', () => {
      const library = new DrillScenarioLibrary('./nonexistent-dir');

      const scenarios = library.getAllScenarios();
      expect(scenarios.length).to.be.greaterThan(0);
    });

    it('should get specific scenario', () => {
      const library = new DrillScenarioLibrary('./nonexistent-dir');

      const scenario = library.getScenario('region-outage');
      expect(scenario).to.exist;
      expect(scenario.name).to.include('区域服务下线');
    });

    it('should return undefined for non-existent scenario', () => {
      const library = new DrillScenarioLibrary('./nonexistent-dir');

      const scenario = library.getScenario('nonexistent');
      expect(scenario).to.be.undefined;
    });
  });
});

// 集成测试
describe('DrillExecutor Integration Tests', () => {
  it('should execute complete drill scenario', async function() {
    this.timeout(5000);

    const k8sClientMock = {
      createCustomResource: sinon.stub().resolves({ metadata: { name: 'test' } }),
      deleteCustomResource: sinon.stub().resolves()
    };

    const prometheusClientMock = {
      query: sinon.stub().resolves(0.95)
    };

    const executor = new DrillExecutor(k8sClientMock, prometheusClientMock);

    const scenario = new DrillScenario({
      id: 'integration-test',
      name: 'Integration Test',
      type: 'dry-run',
      duration: 1000, // 1 秒，用于快速测试
      chaosExperiments: [
        {
          kind: 'NetworkChaos',
          spec: { action: 'delay', delay: { latency: '100ms' } }
        }
      ],
      autoRollback: true
    });

    const execution = await executor.executeScenario(scenario);

    expect(execution.status).to.equal('completed');
    expect(execution).to.have.property('experiments');
    expect(execution).to.have.property('results');
    expect(k8sClientMock.createCustomResource.called).to.be.true;
    expect(k8sClientMock.deleteCustomResource.called).to.be.true; // 自动回滚
  });
});
