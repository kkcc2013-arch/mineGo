/**
 * REQ-00514: 多区域服务状态同步与智能仲裁系统
 * 单元测试
 * 
 * 创建时间: 2026-07-08 22:00 UTC
 */

'use strict';

const assert = require('assert');
const {
  MultiRegionStateCollector,
  ServiceDependencyAnalyzer,
  ArbitrationEngine,
  DegradationFirstPolicy,
  SplitBrainPrevention
} = require('../shared/multiRegionArbitration');

// ============================================================
// Test: MultiRegionStateCollector
// ============================================================

describe('MultiRegionStateCollector', function() {
  this.timeout(10000);
  
  let collector;
  
  before(async function() {
    collector = new MultiRegionStateCollector({
      regions: ['primary', 'secondary', 'backup'],
      currentRegion: 'primary',
      syncIntervalMs: 1000
    });
  });
  
  after(async function() {
    if (collector) {
      await collector.stop();
    }
  });
  
  it('should initialize correctly', async function() {
    // 初始化状态快照
    const snapshot = collector.getStateSnapshot();
    
    assert(snapshot);
    assert.strictEqual(snapshot.currentRegion, 'primary');
    assert.deepStrictEqual(snapshot.regions, {
      primary: { healthy: false, services: {}, latency: 0, lastUpdate: null },
      secondary: { healthy: false, services: {}, latency: 0, lastUpdate: null },
      backup: { healthy: false, services: {}, latency: 0, lastUpdate: null }
    });
  });
  
  it('should update arbitration lock state', function() {
    collector.setArbitrationLocked(true);
    const snapshot = collector.getStateSnapshot();
    assert.strictEqual(snapshot.arbitrationLocked, true);
    
    collector.setArbitrationLocked(false);
    const snapshot2 = collector.getStateSnapshot();
    assert.strictEqual(snapshot2.arbitrationLocked, false);
  });
  
  it('should set active region', function() {
    collector.setActiveRegion('secondary');
    const snapshot = collector.getStateSnapshot();
    assert.strictEqual(snapshot.activeRegion, 'secondary');
    
    // 无效区域不应更新
    collector.setActiveRegion('invalid_region');
    const snapshot2 = collector.getStateSnapshot();
    assert.strictEqual(snapshot2.activeRegion, 'secondary');
  });
  
  it('should get healthy and unhealthy regions', function() {
    // 初始状态：所有区域不健康
    const unhealthy = collector.getUnhealthyRegions();
    assert.deepStrictEqual(unhealthy, ['primary', 'secondary', 'backup']);
    
    const healthy = collector.getHealthyRegions();
    assert.deepStrictEqual(healthy, []);
  });
  
  it('should get collector status', function() {
    const status = collector.getStatus();
    
    assert(status);
    assert.strictEqual(typeof status.running, 'boolean');
    assert.strictEqual(status.currentRegion, 'primary');
    assert.deepStrictEqual(status.regions, ['primary', 'secondary', 'backup']);
  });
});

// ============================================================
// Test: ServiceDependencyAnalyzer
// ============================================================

describe('ServiceDependencyAnalyzer', function() {
  let analyzer;
  
  before(function() {
    analyzer = new ServiceDependencyAnalyzer();
  });
  
  it('should initialize with default topology', function() {
    const info = analyzer.getTopologyInfo();
    
    assert(info);
    assert(info.services.length > 0);
    assert(info.criticalServices.length > 0);
  });
  
  it('should analyze impact chain correctly', function() {
    // location 服务故障应该影响所有依赖它的服务
    const impact = analyzer.analyzeImpactChain('location');
    
    assert(impact);
    assert.strictEqual(impact.root, 'location');
    assert(impact.affected.includes('gateway'));
    assert(impact.affected.includes('pokemon'));
    assert(impact.affected.includes('catch'));
    assert(impact.totalAffected > 0);
  });
  
  it('should calculate severity correctly', function() {
    // gateway 故障应该是高严重度
    const severity = analyzer.calculateSeverity('primary', 'gateway', {
      services: {
        gateway: { healthy: false },
        user: { healthy: true },
        pokemon: { healthy: true }
      }
    });
    
    assert(severity);
    assert(severity.score > 0);
    assert(severity.score <= 100);
    assert(['local', 'regional', 'global'].includes(severity.faultType));
  });
  
  it('should identify critical services', function() {
    assert(analyzer.isServiceCritical('gateway') === true);
    assert(analyzer.isServiceCritical('user') === true);
    assert(analyzer.isServiceCritical('social') === false);
  });
  
  it('should get service dependencies', function() {
    const deps = analyzer.getServiceDependencies('gateway');
    
    assert(deps);
    assert(deps.length > 0);
    assert(deps.includes('user'));
    assert(deps.includes('pokemon'));
    assert(deps.includes('catch'));
  });
  
  it('should get reverse dependencies', function() {
    const reverseDeps = analyzer.getServiceReverseDependencies('user');
    
    assert(reverseDeps);
    assert(reverseDeps.includes('gateway'));
    assert(reverseDeps.includes('catch'));
    assert(reverseDeps.includes('gym'));
  });
  
  it('should get service tier', function() {
    assert.strictEqual(analyzer.getServiceTier('gateway'), 1);
    assert.strictEqual(analyzer.getServiceTier('user'), 2);
    assert.strictEqual(analyzer.getServiceTier('location'), 3);
  });
  
  it('should calculate region health score', function() {
    const score = analyzer.calculateRegionHealthScore({
      services: {
        gateway: { healthy: true },
        user: { healthy: true },
        pokemon: { healthy: false },
        catch: { healthy: true },
        gym: { healthy: true },
        social: { healthy: true },
        reward: { healthy: true },
        payment: { healthy: true },
        location: { healthy: true }
      }
    });
    
    assert(score);
    assert(score.score > 0);
    assert(score.score <= 100);
    assert.strictEqual(score.totalServices, 9);
    assert.strictEqual(score.healthyServices, 8);
  });
  
  it('should detect circular dependencies', function() {
    const cycles = analyzer.detectCircularDependency();
    
    // 默认拓扑不应该有循环依赖
    assert.strictEqual(cycles.length, 0);
  });
});

// ============================================================
// Test: ArbitrationEngine
// ============================================================

describe('ArbitrationEngine', function() {
  let engine;
  let stateCollector;
  let dependencyAnalyzer;
  
  before(function() {
    engine = new ArbitrationEngine();
    
    // Mock state collector
    stateCollector = {
      getStateSnapshot: () => ({
        timestamp: new Date().toISOString(),
        regions: {
          primary: {
            healthy: true,
            services: {
              gateway: { healthy: true },
              user: { healthy: true },
              pokemon: { healthy: true }
            },
            latency: 50
          },
          secondary: {
            healthy: false,
            services: {
              gateway: { healthy: false },
              user: { healthy: true },
              pokemon: { healthy: false }
            },
            latency: 100
          }
        },
        arbitrationLocked: false,
        activeRegion: 'primary'
      }),
      setArbitrationLocked: () => {},
      setActiveRegion: () => {}
    };
    
    dependencyAnalyzer = new ServiceDependencyAnalyzer();
  });
  
  it('should initialize correctly', async function() {
    await engine.initialize({
      stateCollector,
      dependencyAnalyzer
    });
    
    const state = engine.getArbitrationState();
    assert(state);
    assert.strictEqual(state.inProgress, false);
  });
  
  it('should classify fault by severity', function() {
    assert.strictEqual(engine.classifyFaultBySeverity(20), 'local');
    assert.strictEqual(engine.classifyFaultBySeverity(50), 'regional');
    assert.strictEqual(engine.classifyFaultBySeverity(90), 'global');
  });
  
  it('should analyze regions', function() {
    const snapshot = stateCollector.getStateSnapshot();
    const analysis = engine.analyzeRegions(snapshot);
    
    assert(analysis);
    assert(analysis.primary);
    assert(analysis.secondary);
    
    assert.strictEqual(analysis.primary.healthy, true);
    assert.strictEqual(analysis.secondary.healthy, false);
  });
  
  it('should find worst fault', function() {
    const snapshot = stateCollector.getStateSnapshot();
    const analysis = engine.analyzeRegions(snapshot);
    const worst = engine.findWorstFault(analysis);
    
    // secondary 区域有故障
    assert(worst);
    assert.strictEqual(worst.region, 'secondary');
  });
  
  it('should generate decision for local fault', function() {
    const decision = engine.generateDecision(
      {
        type: 'local',
        severity: 25,
        region: 'secondary',
        service: 'gateway',
        impactChain: {}
      },
      { secondary: { healthy: false } },
      {}
    );
    
    assert(decision);
    assert.strictEqual(decision.type, 'degradation');
    assert.strictEqual(decision.priority, 1);
    assert(decision.recoveryPlan.length > 0);
  });
  
  it('should generate decision for regional fault', function() {
    const decision = engine.generateDecision(
      {
        type: 'regional',
        severity: 55,
        region: 'secondary',
        service: 'gateway',
        impactChain: {}
      },
      {
        primary: { healthy: true },
        secondary: { healthy: false }
      },
      {}
    );
    
    assert(decision);
    assert.strictEqual(decision.type, 'regional_switch');
    assert.strictEqual(decision.priority, 2);
    assert.strictEqual(decision.details.targetRegion, 'primary');
  });
  
  it('should generate decision for global fault', function() {
    const decision = engine.generateDecision(
      {
        type: 'global',
        severity: 85,
        region: 'primary',
        service: 'gateway',
        impactChain: {}
      },
      {
        primary: { healthy: false },
        secondary: { healthy: false },
        backup: { healthy: true }
      },
      {}
    );
    
    assert(decision);
    assert.strictEqual(decision.type, 'failover');
    assert.strictEqual(decision.priority, 4);
    assert.strictEqual(decision.details.requireQuorum, true);
  });
  
  it('should record and retrieve decisions', function() {
    const decision = {
      id: 'test-decision-1',
      timestamp: new Date().toISOString(),
      type: 'degradation',
      faultType: 'local'
    };
    
    engine.recordDecision(decision);
    
    const last = engine.getLastDecision();
    assert.strictEqual(last.id, 'test-decision-1');
    
    const history = engine.getDecisionHistory(5);
    assert(history.length > 0);
  });
});

// ============================================================
// Test: DegradationFirstPolicy
// ============================================================

describe('DegradationFirstPolicy', function() {
  let policy;
  
  before(async function() {
    policy = new DegradationFirstPolicy();
    await policy.initialize();
  });
  
  after(async function() {
    await policy.stop();
  });
  
  it('should initialize with default strategies', function() {
    const strategies = policy.getStrategies();
    
    assert(strategies);
    assert(strategies.redis_single_node);
    assert(strategies.database_connection_pool);
    assert(strategies.kafka_partition);
  });
  
  it('should identify fault types correctly', function() {
    assert.strictEqual(
      policy.identifyFaultType({ error: 'Redis connection refused to master' }),
      'redis_single_node'
    );
    
    assert.strictEqual(
      policy.identifyFaultType({ error: 'Too many connections in pool' }),
      'database_connection_pool'
    );
    
    assert.strictEqual(
      policy.identifyFaultType({ error: 'Kafka partition unavailable' }),
      'kafka_partition'
    );
    
    assert.strictEqual(
      policy.identifyFaultType({ error: 'Pod crashed' }),
      'service_instance'
    );
    
    assert.strictEqual(
      policy.identifyFaultType({ error: 'Network timeout' }),
      'network_flapping'
    );
    
    assert.strictEqual(
      policy.identifyFaultType({ error: 'OOM killed' }),
      'memory_pressure'
    );
    
    assert.strictEqual(
      policy.identifyFaultType({ error: 'CPU load too high' }),
      'cpu_overload'
    );
  });
  
  it('should get active degradations', function() {
    const active = policy.getActiveDegradations();
    
    assert(Array.isArray(active));
  });
  
  it('should get degradation history', function() {
    const history = policy.getHistory(10);
    
    assert(Array.isArray(history));
  });
  
  it('should update strategy', function() {
    policy.updateStrategy('redis_single_node', {
      timeoutMs: 60000,
      retryCount: 5
    });
    
    const strategies = policy.getStrategies();
    assert.strictEqual(strategies.redis_single_node.timeoutMs, 60000);
    assert.strictEqual(strategies.redis_single_node.retryCount, 5);
  });
});

// ============================================================
// Test: SplitBrainPrevention
// ============================================================

describe('SplitBrainPrevention', function() {
  let prevention;
  
  before(async function() {
    prevention = new SplitBrainPrevention({
      quorum: 2,
      regions: ['primary', 'secondary', 'backup'],
      currentRegion: 'primary'
    });
  });
  
  after(async function() {
    await prevention.stop();
  });
  
  it('should initialize correctly', function() {
    assert.strictEqual(prevention.config.quorum, 2);
    assert.strictEqual(prevention.config.currentRegion, 'primary');
  });
  
  it('should check quorum correctly', async function() {
    const votes = new Map();
    votes.set('primary', { vote: 'yes', region: 'primary' });
    votes.set('secondary', { vote: 'yes', region: 'secondary' });
    votes.set('backup', { vote: 'no', region: 'backup' });
    
    const result = await prevention.checkQuorum(votes);
    
    assert(result);
    assert.strictEqual(result.quorumReached, true);
    assert.strictEqual(result.yesVotes, 2);
    assert.strictEqual(result.noVotes, 1);
    assert.strictEqual(result.totalVotes, 3);
  });
  
  it('should detect quorum not reached', async function() {
    const votes = new Map();
    votes.set('primary', { vote: 'yes', region: 'primary' });
    votes.set('secondary', { vote: 'no', region: 'secondary' });
    votes.set('backup', { vote: 'no', region: 'backup' });
    
    const result = await prevention.checkQuorum(votes);
    
    assert.strictEqual(result.quorumReached, false);
    assert.strictEqual(result.yesVotes, 1);
  });
  
  it('should get lock status', function() {
    const status = prevention.getLockStatus();
    
    assert(status);
    assert.strictEqual(typeof status.hasLock, 'boolean');
    assert.strictEqual(status.lockValue, null);
  });
  
  it('should get voting status', function() {
    const status = prevention.getVotingStatus();
    
    assert(status);
    assert.strictEqual(typeof status.hasSession, 'boolean');
  });
});

// ============================================================
// Test: Integration - Arbitration Flow
// ============================================================

describe('Integration: Arbitration Flow', function() {
  this.timeout(15000);
  
  it('should complete full arbitration cycle', async function() {
    // 创建组件
    const stateCollector = new MultiRegionStateCollector({
      regions: ['primary', 'secondary'],
      currentRegion: 'primary'
    });
    
    const dependencyAnalyzer = new ServiceDependencyAnalyzer();
    const engine = new ArbitrationEngine();
    
    // 初始化仲裁引擎
    await engine.initialize({
      stateCollector,
      dependencyAnalyzer
    });
    
    // 模拟状态快照
    const snapshot = {
      timestamp: new Date().toISOString(),
      regions: {
        primary: {
          healthy: true,
          services: {
            gateway: { healthy: true },
            user: { healthy: true },
            pokemon: { healthy: true },
            catch: { healthy: true },
            gym: { healthy: true }
          },
          latency: 50,
          lastUpdate: new Date().toISOString()
        },
        secondary: {
          healthy: false,
          services: {
            gateway: { healthy: false, error: 'Connection refused' },
            user: { healthy: true },
            pokemon: { healthy: false, error: 'Timeout' }
          },
          latency: 150,
          lastUpdate: new Date().toISOString()
        }
      },
      arbitrationLocked: false,
      activeRegion: 'primary'
    };
    
    // 执行仲裁
    const decision = await engine.arbitrate(snapshot);
    
    assert(decision);
    assert(decision.id);
    assert(['degradation', 'regional_switch', 'failover', 'monitor'].includes(decision.type));
    
    // 清理
    await stateCollector.stop();
  });
});

// ============================================================
// Run Tests
// ============================================================

if (require.main === module) {
  const Mocha = require('mocha');
  const mocha = new Mocha({ timeout: 10000 });
  
  // 添加当前文件
  mocha.addFile(__filename);
  
  // 运行测试
  mocha.run(failures => {
    process.exitCode = failures ? 1 : 0;
  });
}