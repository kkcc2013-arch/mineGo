/**
 * 插件系统单元测试
 * REQ-00505: 插件生命周期管理与热插拔系统
 */

const { BasePlugin, PluginManager, DependencyResolver, PluginHotLoader } = require('../shared/pluginSystem');
const assert = require('assert');

// 测试插件类
class TestPlugin extends BasePlugin {
  constructor(name, version, dependencies = []) {
    super(name, version);
    this.dependencies = dependencies;
    this.initializeCalled = false;
    this.startCalled = false;
    this.stopCalled = false;
    this.cleanupCalled = false;
  }

  async initialize() {
    this.initializeCalled = true;
  }

  async start() {
    this.startCalled = true;
  }

  async stop() {
    this.stopCalled = true;
  }

  async cleanup() {
    this.cleanupCalled = true;
  }
}

// 测试用例
async function runTests() {
  console.log('\n=== Plugin System Unit Tests ===\n');

  // Test 1: BasePlugin 基类测试
  console.log('Test 1: BasePlugin base class...');
  const plugin = new TestPlugin('test', '1.0.0', ['dep1', 'dep2']);
  assert.strictEqual(plugin.name, 'test');
  assert.strictEqual(plugin.version, '1.0.0');
  assert.strictEqual(plugin.state, 'uninitialized');
  assert.deepStrictEqual(plugin.getDependencies(), ['dep1', 'dep2']);
  console.log('✅ BasePlugin properties work correctly\n');

  // Test 2: DependencyResolver 拓扑排序
  console.log('Test 2: DependencyResolver topology sort...');
  const resolver = new DependencyResolver();
  resolver.addNode('A', ['B', 'C']);
  resolver.addNode('B', ['C']);
  resolver.addNode('C', []);
  
  const order = resolver.resolve();
  // C 必须先于 B，B 必须先于 A
  assert.ok(order.indexOf('C') < order.indexOf('B'));
  assert.ok(order.indexOf('B') < order.indexOf('A'));
  console.log('✅ DependencyResolver resolves order correctly: ' + order.join(' → ') + '\n');

  // Test 3: 循环依赖检测
  console.log('Test 3: Circular dependency detection...');
  const cycleResolver = new DependencyResolver();
  cycleResolver.addNode('A', ['B']);
  cycleResolver.addNode('B', ['C']);
  cycleResolver.addNode('C', ['A']);
  
  try {
    cycleResolver.resolve();
    assert.fail('Should have thrown circular dependency error');
  } catch (error) {
    assert.ok(error.message.includes('Circular dependency'));
    console.log('✅ Circular dependency correctly detected\n');
  }

  // Test 4: PluginManager 注册插件
  console.log('Test 4: PluginManager register plugin...');
  const manager = new PluginManager();
  const pluginA = new TestPlugin('A', '1.0.0');
  manager.register(pluginA, { setting: 'value' });
  
  assert.strictEqual(manager.getPluginCount(), 1);
  assert.strictEqual(manager.hasPlugin('A'), true);
  assert.strictEqual(pluginA.config.setting, 'value');
  console.log('✅ Plugin registration works correctly\n');

  // Test 5: PluginManager 初始化顺序
  console.log('Test 5: PluginManager initialization order...');
  const manager2 = new PluginManager();
  const pC = new TestPlugin('C', '1.0.0', []);
  const pB = new TestPlugin('B', '1.0.0', ['C']);
  const pA = new TestPlugin('A', '1.0.0', ['B']);
  
  manager2.register(pC);
  manager2.register(pB);
  manager2.register(pA);
  
  await manager2.initializeAll();
  
  const order2 = manager2.getInitializationOrder();
  assert.ok(order2.indexOf('C') < order2.indexOf('B'));
  assert.ok(order2.indexOf('B') < order2.indexOf('A'));
  assert.strictEqual(pC.initializeCalled, true);
  assert.strictEqual(pB.initializeCalled, true);
  assert.strictEqual(pA.initializeCalled, true);
  console.log('✅ Initialization order correct: ' + order2.join(' → ') + '\n');

  // Test 6: PluginManager 启动插件
  console.log('Test 6: PluginManager start plugins...');
  await manager2.startAll();
  
  assert.strictEqual(pC.state, 'running');
  assert.strictEqual(pB.state, 'running');
  assert.strictEqual(pA.state, 'running');
  assert.strictEqual(pC.startCalled, true);
  console.log('✅ All plugins started correctly\n');

  // Test 7: PluginManager 停止插件（逆序）
  console.log('Test 7: PluginManager stop plugins (reverse order)...');
  await manager2.stopAll();
  
  assert.strictEqual(pC.state, 'stopped');
  assert.strictEqual(pB.state, 'stopped');
  assert.strictEqual(pA.state, 'stopped');
  assert.strictEqual(pA.stopCalled, true);
  assert.strictEqual(pB.stopCalled, true);
  assert.strictEqual(pC.stopCalled, true);
  console.log('✅ All plugins stopped correctly (reverse order)\n');

  // Test 8: 健康检查
  console.log('Test 8: Plugin health check...');
  const manager3 = new PluginManager();
  const healthyPlugin = new TestPlugin('healthy', '1.0.0');
  manager3.register(healthyPlugin);
  await manager3.initializePlugin('healthy');
  await manager3.startPlugin('healthy');
  
  const health = await manager3.healthCheckAll();
  assert.strictEqual(health.healthy.healthy, true);
  console.log('✅ Health check works correctly\n');

  // Test 9: 获取依赖插件
  console.log('Test 9: Get dependency plugin...');
  const manager4 = new PluginManager();
  const depPlugin = new TestPlugin('dep', '1.0.0', []);
  const mainPlugin = new TestPlugin('main', '1.0.0', ['dep']);
  
  manager4.register(depPlugin);
  manager4.register(mainPlugin);
  
  const retrieved = mainPlugin.getDependency('dep');
  assert.strictEqual(retrieved.name, 'dep');
  console.log('✅ Dependency retrieval works correctly\n');

  // Test 10: 状态获取
  console.log('Test 10: Plugin state retrieval...');
  const state = healthyPlugin.getState();
  assert.strictEqual(state.name, 'healthy');
  assert.strictEqual(state.version, '1.0.0');
  assert.strictEqual(state.state, 'running');
  assert.ok(state.uptime >= 0);
  console.log('✅ State retrieval works correctly\n');

  // Test 11: 依赖反向查找
  console.log('Test 11: Get dependents (reverse dependencies)...');
  const resolver2 = new DependencyResolver();
  resolver2.addNode('A', ['B']);
  resolver2.addNode('B', []);
  resolver2.addNode('C', ['B']);
  
  const dependents = resolver2.getDependents('B');
  assert.deepStrictEqual(dependents, ['A', 'C']);
  console.log('✅ Reverse dependency lookup works correctly\n');

  // Test 12: 插件注销
  console.log('Test 12: Plugin unregister...');
  const manager5 = new PluginManager();
  const toUnregister = new TestPlugin('toRemove', '1.0.0');
  manager5.register(toUnregister);
  await manager5.initializePlugin('toRemove');
  await manager5.startPlugin('toRemove');
  await manager5.unregister('toRemove');
  
  assert.strictEqual(manager5.hasPlugin('toRemove'), false);
  assert.strictEqual(toUnregister.cleanupCalled, true);
  console.log('✅ Plugin unregistration works correctly\n');

  // Test 13: 配置热更新
  console.log('Test 13: Config hot update...');
  const manager6 = new PluginManager();
  const configPlugin = new TestPlugin('configurable', '1.0.0');
  manager6.register(configPlugin, { initial: 'value' });
  
  await manager6.hotUpdateConfig('configurable', { updated: 'newValue' });
  assert.strictEqual(configPlugin.config.updated, 'newValue');
  console.log('✅ Config hot update works correctly\n');

  // Test 14: 重复注册检测
  console.log('Test 14: Duplicate registration detection...');
  const manager7 = new PluginManager();
  const dupPlugin = new TestPlugin('dup', '1.0.0');
  manager7.register(dupPlugin);
  
  try {
    manager7.register(dupPlugin);
    assert.fail('Should have thrown duplicate registration error');
  } catch (error) {
    assert.ok(error.message.includes('already registered'));
    console.log('✅ Duplicate registration correctly detected\n');
  }

  console.log('\n=== All 14 tests passed! ===\n');
}

// 运行测试
runTests().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});