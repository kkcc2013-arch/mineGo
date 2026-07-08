'use strict';

/**
 * ProcessOrchestrator 单元测试
 * REQ-00499: 事件驱动服务编排与分布式状态机引擎
 */

const { expect } = require('chai');
const sinon = require('sinon');
const { 
  ProcessOrchestrator, 
  ProcessInstance, 
  ProcessDefinition,
  ProcessStatus,
  getProcessOrchestrator 
} = require('../ProcessOrchestrator');

describe('ProcessOrchestrator', () => {
  let orchestrator;
  let mockRedis;
  let mockEventBus;
  
  beforeEach(() => {
    // Mock Redis
    mockRedis = {
      get: sinon.stub(),
      set: sinon.stub().resolves('OK'),
      del: sinon.stub().resolves(1),
      rpush: sinon.stub().resolves(1),
      lrange: sinon.stub().resolves([]),
      multi: sinon.stub().returns({
        set: sinon.stub().returnsThis(),
        rpush: sinon.stub().returnsThis(),
        ltrim: sinon.stub().returnsThis(),
        exec: sinon.stub().resolves([])
      }),
      keys: sinon.stub().resolves([]),
      ping: sinon.stub().resolves('PONG')
    };
    
    // Mock EventBus
    mockEventBus = {
      connect: sinon.stub().resolves(),
      disconnect: sinon.stub().resolves(),
      subscribe: sinon.stub().resolves(),
      publish: sinon.stub().resolves(),
      healthCheck: sinon.stub().resolves({ healthy: true })
    };
    
    orchestrator = new ProcessOrchestrator({
      redisClient: mockRedis,
      definitionsPath: '/tmp/test-processes'
    });
    
    // 替换 eventBus
    orchestrator.eventBus = mockEventBus;
    orchestrator.stateMachine.redis = mockRedis;
    orchestrator.compensationManager.redis = mockRedis;
  });
  
  afterEach(() => {
    sinon.restore();
  });
  
  describe('ProcessDefinition', () => {
    it('should create a valid process definition', () => {
      const definition = new ProcessDefinition({
        processType: 'test-flow',
        version: '1.0.0',
        states: [
          { name: 'start', transitions: [{ to: 'end', event: 'start.complete' }] },
          { name: 'end', final: true }
        ]
      });
      
      expect(definition.processType).to.equal('test-flow');
      expect(definition.version).to.equal('1.0.0');
      expect(definition.states).to.have.length(2);
      expect(definition.initialState).to.equal('start');
      expect(definition.finalStates).to.deep.equal(['end']);
    });
    
    it('should validate required fields', () => {
      expect(() => new ProcessDefinition({})).to.throw('processType is required');
      expect(() => new ProcessDefinition({ processType: 'test' })).to.throw('states are required');
    });
    
    it('should get state by name', () => {
      const definition = new ProcessDefinition({
        processType: 'test-flow',
        version: '1.0.0',
        states: [
          { name: 'start', step: { service: 'test', action: 'test' } },
          { name: 'end', final: true }
        ]
      });
      
      const state = definition.getState('start');
      expect(state).to.exist;
      expect(state.name).to.equal('start');
      expect(state.step.service).to.equal('test');
    });
    
    it('should get transition by event', () => {
      const definition = new ProcessDefinition({
        processType: 'test-flow',
        version: '1.0.0',
        states: [
          { 
            name: 'start', 
            transitions: [{ to: 'end', event: 'start.complete' }] 
          },
          { name: 'end', final: true }
        ]
      });
      
      const transition = definition.getTransition('start', 'start.complete');
      expect(transition).to.exist;
      expect(transition.to).to.equal('end');
    });
  });
  
  describe('ProcessInstance', () => {
    it('should create a process instance', () => {
      const instance = new ProcessInstance({
        instanceId: 'test-123',
        processType: 'test-flow',
        version: '1.0.0',
        input: { userId: 'user1' }
      });
      
      expect(instance.instanceId).to.equal('test-123');
      expect(instance.processType).to.equal('test-flow');
      expect(instance.status).to.equal(ProcessStatus.PENDING);
      expect(instance.input).to.deep.equal({ userId: 'user1' });
    });
    
    it('should serialize to JSON', () => {
      const instance = new ProcessInstance({
        instanceId: 'test-123',
        processType: 'test-flow',
        version: '1.0.0',
        status: ProcessStatus.RUNNING
      });
      
      const json = instance.toJSON();
      
      expect(json.instanceId).to.equal('test-123');
      expect(json.processType).to.equal('test-flow');
      expect(json.status).to.equal('running');
    });
    
    it('should deserialize from JSON', () => {
      const json = {
        instanceId: 'test-123',
        processType: 'test-flow',
        version: '1.0.0',
        status: 'completed'
      };
      
      const instance = ProcessInstance.fromJSON(json);
      
      expect(instance.instanceId).to.equal('test-123');
      expect(instance.status).to.equal('completed');
    });
  });
  
  describe('registerProcessDefinition', () => {
    it('should register a process definition', async () => {
      const definition = await orchestrator.registerProcessDefinition({
        processType: 'test-flow',
        version: '1.0.0',
        states: [
          { name: 'start', transitions: [{ to: 'end', event: 'complete' }] },
          { name: 'end', final: true }
        ]
      });
      
      expect(definition.processType).to.equal('test-flow');
      expect(orchestrator.definitions.has('test-flow:1.0.0')).to.be.true;
      expect(orchestrator.definitionVersions.has('test-flow')).to.be.true;
    });
    
    it('should track multiple versions', async () => {
      await orchestrator.registerProcessDefinition({
        processType: 'test-flow',
        version: '1.0.0',
        states: [{ name: 'start', final: true }]
      });
      
      await orchestrator.registerProcessDefinition({
        processType: 'test-flow',
        version: '1.1.0',
        states: [{ name: 'start', final: true }]
      });
      
      const versions = orchestrator.definitionVersions.get('test-flow');
      expect(versions).to.deep.equal(['1.0.0', '1.1.0']);
    });
  });
  
  describe('getDefinition', () => {
    it('should return definition by type and version', async () => {
      await orchestrator.registerProcessDefinition({
        processType: 'test-flow',
        version: '1.0.0',
        states: [{ name: 'start', final: true }]
      });
      
      const definition = orchestrator.getDefinition('test-flow', '1.0.0');
      expect(definition).to.exist;
      expect(definition.version).to.equal('1.0.0');
    });
    
    it('should return latest version when version not specified', async () => {
      await orchestrator.registerProcessDefinition({
        processType: 'test-flow',
        version: '1.0.0',
        states: [{ name: 'start', final: true }]
      });
      
      await orchestrator.registerProcessDefinition({
        processType: 'test-flow',
        version: '2.0.0',
        states: [{ name: 'start', final: true }]
      });
      
      const definition = orchestrator.getDefinition('test-flow');
      expect(definition.version).to.equal('2.0.0');
    });
    
    it('should return null for unknown definition', () => {
      const definition = orchestrator.getDefinition('unknown-flow');
      expect(definition).to.be.null;
    });
  });
  
  describe('startProcess', () => {
    it('should start a process instance', async () => {
      await orchestrator.registerProcessDefinition({
        processType: 'test-flow',
        version: '1.0.0',
        states: [
          { 
            name: 'start',
            step: { service: 'test-service', action: 'testAction' },
            transitions: [{ to: 'end', event: 'complete' }] 
          },
          { name: 'end', final: true }
        ],
        timeout: 30000
      });
      
      const instance = await orchestrator.startProcess('test-flow', { userId: 'user1' });
      
      expect(instance).to.exist;
      expect(instance.instanceId).to.match(/^test-flow-/);
      expect(instance.processType).to.equal('test-flow');
      expect(instance.status).to.equal(ProcessStatus.RUNNING);
      expect(mockEventBus.publish.called).to.be.true;
    });
    
    it('should throw error for unknown process type', async () => {
      try {
        await orchestrator.startProcess('unknown-flow', {});
        expect.fail('Should have thrown error');
      } catch (err) {
        expect(err.message).to.include('not found');
      }
    });
    
    it('should generate unique instance IDs', async () => {
      await orchestrator.registerProcessDefinition({
        processType: 'test-flow',
        version: '1.0.0',
        states: [{ name: 'start', final: true }]
      });
      
      const instance1 = await orchestrator.startProcess('test-flow', {});
      const instance2 = await orchestrator.startProcess('test-flow', {});
      
      expect(instance1.instanceId).to.not.equal(instance2.instanceId);
    });
  });
  
  describe('getProcessInstance', () => {
    it('should return instance from cache', async () => {
      const cachedInstance = new ProcessInstance({
        instanceId: 'test-123',
        processType: 'test-flow',
        version: '1.0.0'
      });
      
      orchestrator.activeInstances.set('test-123', cachedInstance);
      
      const instance = await orchestrator.getProcessInstance('test-123');
      
      expect(instance).to.equal(cachedInstance);
      expect(mockRedis.get.called).to.be.false;
    });
    
    it('should return instance from Redis when not cached', async () => {
      const redisData = JSON.stringify({
        instanceId: 'test-456',
        processType: 'test-flow',
        version: '1.0.0',
        status: 'running'
      });
      
      mockRedis.get.resolves(redisData);
      
      const instance = await orchestrator.getProcessInstance('test-456');
      
      expect(instance).to.exist;
      expect(instance.instanceId).to.equal('test-456');
    });
    
    it('should return null for non-existent instance', async () => {
      mockRedis.get.resolves(null);
      
      const instance = await orchestrator.getProcessInstance('nonexistent');
      
      expect(instance).to.be.null;
    });
  });
  
  describe('_buildStepInput', () => {
    it('should build step input from instance data', () => {
      const instance = new ProcessInstance({
        instanceId: 'test-123',
        processType: 'test-flow',
        input: { userId: 'user1', pokemonId: 'pkm1' },
        context: { validated: true },
        output: { caught: true }
      });
      
      const stepInput = orchestrator._buildStepInput(instance, ['userId', 'validated', 'caught']);
      
      expect(stepInput).to.deep.equal({
        userId: 'user1',
        validated: true,
        caught: true
      });
    });
    
    it('should return empty object for no input fields', () => {
      const instance = new ProcessInstance({ instanceId: 'test-123' });
      const stepInput = orchestrator._buildStepInput(instance, []);
      
      expect(stepInput).to.deep.equal({});
    });
  });
  
  describe('_evaluateCondition', () => {
    it('should evaluate equality condition', () => {
      const instance = new ProcessInstance({
        instanceId: 'test-123',
        output: { caught: true }
      });
      
      const result = orchestrator._evaluateCondition(instance, 'output.caught == true');
      expect(result).to.be.true;
      
      const result2 = orchestrator._evaluateCondition(instance, 'output.caught == false');
      expect(result2).to.be.false;
    });
    
    it('should return true for unrecognized conditions', () => {
      const instance = new ProcessInstance({ instanceId: 'test-123' });
      const result = orchestrator._evaluateCondition(instance, 'complex condition');
      expect(result).to.be.true;
    });
  });
  
  describe('getMetrics', () => {
    it('should return metrics', () => {
      orchestrator.metrics.processesStarted = 10;
      orchestrator.metrics.processesCompleted = 8;
      
      const metrics = orchestrator.getMetrics();
      
      expect(metrics.processesStarted).to.equal(10);
      expect(metrics.processesCompleted).to.equal(8);
      expect(metrics).to.have.property('definitionsCount');
      expect(metrics).to.have.property('processTypes');
    });
  });
  
  describe('healthCheck', () => {
    it('should return healthy status', async () => {
      await orchestrator.registerProcessDefinition({
        processType: 'test-flow',
        version: '1.0.0',
        states: [{ name: 'start', final: true }]
      });
      
      const health = await orchestrator.healthCheck();
      
      expect(health.healthy).to.be.true;
      expect(health.definitions).to.equal(1);
      expect(health.eventBus.healthy).to.be.true;
    });
    
    it('should return unhealthy when no definitions', async () => {
      const health = await orchestrator.healthCheck();
      
      expect(health.healthy).to.be.false;
    });
  });
  
  describe('upgradeProcessVersion', () => {
    it('should upgrade process version', async () => {
      await orchestrator.registerProcessDefinition({
        processType: 'test-flow',
        version: '1.0.0',
        states: [{ name: 'start', final: true }]
      });
      
      await orchestrator.upgradeProcessVersion('test-flow', '2.0.0', {
        states: [
          { name: 'start', transitions: [{ to: 'middle', event: 'next' }] },
          { name: 'middle', transitions: [{ to: 'end', event: 'done' }] },
          { name: 'end', final: true }
        ]
      });
      
      const versions = orchestrator.definitionVersions.get('test-flow');
      expect(versions).to.deep.equal(['1.0.0', '2.0.0']);
      
      const latest = orchestrator.getDefinition('test-flow');
      expect(latest.version).to.equal('2.0.0');
      expect(latest.states).to.have.length(3);
    });
  });
});

describe('ProcessStatus', () => {
  it('should define all status values', () => {
    expect(ProcessStatus.PENDING).to.equal('pending');
    expect(ProcessStatus.RUNNING).to.equal('running');
    expect(ProcessStatus.COMPLETED).to.equal('completed');
    expect(ProcessStatus.FAILED).to.equal('failed');
    expect(ProcessStatus.CANCELLED).to.equal('cancelled');
    expect(ProcessStatus.COMPENSATING).to.equal('compensating');
  });
});

describe('getProcessOrchestrator singleton', () => {
  it('should return same instance', () => {
    const instance1 = getProcessOrchestrator();
    const instance2 = getProcessOrchestrator();
    
    expect(instance1).to.equal(instance2);
  });
});