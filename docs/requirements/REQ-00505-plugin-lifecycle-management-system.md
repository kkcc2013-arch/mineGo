# REQ-00505：插件生命周期管理与热插拔系统

- **编号**：REQ-00505
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：backend/shared/pluginSystem、gateway、所有后端服务
- **创建时间**：2026-07-08 14:00
- **依赖需求**：REQ-00122(配置中心热重载已完成)

## 1. 背景与问题

mineGo 项目已实现多个可插拔功能模块（CircuitBreaker、ChaosEngine、DegradationManager 等），但这些模块缺少统一的**插件生命周期管理系统**：

### 1.1 当前问题
1. **初始化顺序混乱**：各模块在服务启动时分散初始化，依赖关系不明确
2. **无法动态加载/卸载**：功能模块必须重启服务才能生效
3. **配置管理分散**：每个模块独立读取配置，缺少统一配置注入机制
4. **依赖关系不透明**：模块间依赖通过隐式引用，难以追踪和测试
5. **生命周期钩子缺失**：缺少 beforeStart、afterStart、beforeStop、afterStop 等标准钩子

### 1.2 当前代码现状
```javascript
// 各服务启动时分散初始化
const circuitBreaker = new CircuitBreaker(config.circuitBreaker);
const chaosEngine = new ChaosEngine(config.chaos);
const degradationManager = new DegradationManager(config.degradation);
// 依赖关系不明确，初始化顺序随意
```

### 1.3 期望改进
构建统一的插件生命周期管理系统，支持：
- 插件声明式注册与依赖声明
- 按依赖拓扑排序自动初始化
- 运行时热加载/卸载插件
- 统一配置注入与热更新
- 标准化生命周期钩子

## 2. 目标

1. **统一插件注册**：所有可插拔模块通过 PluginManager 注册
2. **依赖自动解析**：根据依赖声明自动计算初始化顺序
3. **热插拔支持**：无需重启服务即可加载/卸载/更新插件
4. **配置统一管理**：通过配置中心动态注入插件配置
5. **生命周期标准化**：提供完整的生命周期钩子机制

## 3. 范围

### 包含
- 插件抽象基类：`BasePlugin`
- 插件管理器：`PluginManager`
- 依赖解析器：`DependencyResolver`
- 热加载器：`PluginHotLoader`
- 插件配置注入器
- 现有模块适配：CircuitBreaker、ChaosEngine、DegradationManager 等改造为插件

### 不包含
- 前端插件系统
- 第三方插件市场
- 插件权限控制（安全沙箱）
- 插件间通信总线（已有 EventBus）

## 4. 详细需求

### 4.1 插件抽象基类

```javascript
// backend/shared/pluginSystem/BasePlugin.js

/**
 * 插件基类，所有插件必须继承此类
 */
class BasePlugin {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this.state = 'uninitialized'; // uninitialized | initializing | running | stopping | stopped | error
    this.config = {};
    this.dependencies = [];
  }

  /**
   * 声明插件依赖
   * @returns {string[]} 依赖的插件名称列表
   */
  getDependencies() {
    return this.dependencies;
  }

  /**
   * 设置插件配置
   * @param {Object} config 配置对象
   */
  setConfig(config) {
    this.config = config;
  }

  /**
   * 初始化插件（子类实现）
   * 在所有依赖插件初始化完成后调用
   */
  async initialize() {
    throw new Error(`${this.name} must implement initialize()`);
  }

  /**
   * 启动插件（子类实现）
   */
  async start() {
    throw new Error(`${this.name} must implement start()`);
  }

  /**
   * 停止插件（子类实现）
   */
  async stop() {
    throw new Error(`${this.name} must implement stop()`);
  }

  /**
   * 清理插件资源（子类实现）
   */
  async cleanup() {
    throw new Error(`${this.name} must implement cleanup()`);
  }

  /**
   * 健康检查（子类可选实现）
   * @returns {Promise<{healthy: boolean, details?: Object}>}
   */
  async healthCheck() {
    return { healthy: this.state === 'running' };
  }

  /**
   * 配置热更新回调（子类可选实现）
   * @param {Object} newConfig 新配置
   */
  async onConfigUpdate(newConfig) {
    this.config = newConfig;
  }

  /**
   * 获取插件状态
   */
  getState() {
    return {
      name: this.name,
      version: this.version,
      state: this.state,
      dependencies: this.dependencies,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0
    };
  }
}

module.exports = BasePlugin;
```

### 4.2 插件管理器

```javascript
// backend/shared/pluginSystem/PluginManager.js

const DependencyResolver = require('./DependencyResolver');
const PluginHotLoader = require('./PluginHotLoader');
const EventEmitter = require('events');

class PluginManager extends EventEmitter {
  constructor() {
    super();
    this.plugins = new Map();           // 插件实例映射
    this.pluginConfigs = new Map();     // 插件配置映射
    this.resolver = new DependencyResolver();
    this.hotLoader = new PluginHotLoader(this);
    this.initializationOrder = [];      // 初始化顺序
    this.configCenter = null;           // 配置中心引用
  }

  /**
   * 注册插件
   * @param {BasePlugin} plugin 插件实例
   * @param {Object} config 插件配置（可选）
   */
  register(plugin, config = {}) {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin ${plugin.name} already registered`);
    }

    this.plugins.set(plugin.name, plugin);
    this.pluginConfigs.set(plugin.name, config);
    
    // 注册依赖关系到解析器
    this.resolver.addNode(plugin.name, plugin.getDependencies());

    this.emit('plugin:registered', { name: plugin.name, version: plugin.version });
  }

  /**
   * 注销插件
   * @param {string} pluginName 插件名称
   */
  async unregister(pluginName) {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    // 检查是否有其他插件依赖此插件
    const dependents = this.resolver.getDependents(pluginName);
    if (dependents.length > 0) {
      throw new Error(`Cannot unregister ${pluginName}: dependents [${dependents.join(', ')}] must be unregistered first`);
    }

    // 停止并清理插件
    await this.stopPlugin(pluginName);
    await plugin.cleanup();

    this.plugins.delete(pluginName);
    this.pluginConfigs.delete(pluginName);
    this.resolver.removeNode(pluginName);

    this.emit('plugin:unregistered', { name: pluginName });
  }

  /**
   * 初始化所有插件（按依赖拓扑排序）
   */
  async initializeAll() {
    // 解析依赖，获取初始化顺序
    this.initializationOrder = this.resolver.resolve();
    
    console.log(`[PluginManager] Initialization order: ${this.initializationOrder.join(' → ')}`);

    for (const pluginName of this.initializationOrder) {
      await this.initializePlugin(pluginName);
    }
  }

  /**
   * 初始化单个插件
   */
  async initializePlugin(pluginName) {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    if (plugin.state !== 'uninitialized') {
      return; // 已初始化
    }

    try {
      plugin.state = 'initializing';
      
      // 注入配置
      const config = this.pluginConfigs.get(pluginName);
      plugin.setConfig(config);

      // 调用初始化
      await plugin.initialize();

      plugin.state = 'initialized';
      this.emit('plugin:initialized', { name: pluginName });
    } catch (error) {
      plugin.state = 'error';
      this.emit('plugin:error', { name: pluginName, error, phase: 'initialize' });
      throw error;
    }
  }

  /**
   * 启动所有插件
   */
  async startAll() {
    for (const pluginName of this.initializationOrder) {
      await this.startPlugin(pluginName);
    }
  }

  /**
   * 启动单个插件
   */
  async startPlugin(pluginName) {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    try {
      await plugin.start();
      plugin.state = 'running';
      plugin.startedAt = Date.now();
      
      this.emit('plugin:started', { name: pluginName });
    } catch (error) {
      plugin.state = 'error';
      this.emit('plugin:error', { name: pluginName, error, phase: 'start' });
      throw error;
    }
  }

  /**
   * 停止所有插件（逆序停止）
   */
  async stopAll() {
    const stopOrder = [...this.initializationOrder].reverse();
    
    for (const pluginName of stopOrder) {
      await this.stopPlugin(pluginName);
    }
  }

  /**
   * 停止单个插件
   */
  async stopPlugin(pluginName) {
    const plugin = this.plugins.get(pluginName);
    if (!plugin || plugin.state !== 'running') {
      return;
    }

    try {
      plugin.state = 'stopping';
      await plugin.stop();
      plugin.state = 'stopped';
      
      this.emit('plugin:stopped', { name: pluginName });
    } catch (error) {
      plugin.state = 'error';
      this.emit('plugin:error', { name: pluginName, error, phase: 'stop' });
      throw error;
    }
  }

  /**
   * 热加载插件
   * @param {string} pluginPath 插件模块路径
   * @param {Object} config 插件配置
   */
  async hotLoad(pluginPath, config = {}) {
    const plugin = await this.hotLoader.load(pluginPath);
    this.register(plugin, config);
    await this.initializePlugin(plugin.name);
    await this.startPlugin(plugin.name);
    
    this.emit('plugin:hot-loaded', { name: plugin.name, path: pluginPath });
  }

  /**
   * 热卸载插件
   */
  async hotUnload(pluginName) {
    await this.unregister(pluginName);
    this.emit('plugin:hot-unloaded', { name: pluginName });
  }

  /**
   * 热更新插件配置
   */
  async hotUpdateConfig(pluginName, newConfig) {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    this.pluginConfigs.set(pluginName, newConfig);
    await plugin.onConfigUpdate(newConfig);
    
    this.emit('plugin:config-updated', { name: pluginName });
  }

  /**
   * 获取插件实例
   */
  getPlugin(pluginName) {
    return this.plugins.get(pluginName);
  }

  /**
   * 获取所有插件状态
   */
  getAllPluginStates() {
    const states = {};
    for (const [name, plugin] of this.plugins) {
      states[name] = plugin.getState();
    }
    return states;
  }

  /**
   * 健康检查所有插件
   */
  async healthCheckAll() {
    const results = {};
    for (const [name, plugin] of this.plugins) {
      try {
        results[name] = await plugin.healthCheck();
      } catch (error) {
        results[name] = { healthy: false, error: error.message };
      }
    }
    return results;
  }

  /**
   * 设置配置中心（用于配置热更新）
   */
  setConfigCenter(configCenter) {
    this.configCenter = configCenter;
    
    // 监听配置变更
    configCenter.on('config:updated', async ({ key, value }) => {
      const pluginName = key.replace('plugin.', '');
      if (this.plugins.has(pluginName)) {
        await this.hotUpdateConfig(pluginName, value);
      }
    });
  }
}

module.exports = PluginManager;
```

### 4.3 依赖解析器

```javascript
// backend/shared/pluginSystem/DependencyResolver.js

class DependencyResolver {
  constructor() {
    this.graph = new Map(); // 邻接表：节点 → 依赖列表
  }

  /**
   * 添加节点及其依赖
   */
  addNode(node, dependencies = []) {
    if (!this.graph.has(node)) {
      this.graph.set(node, []);
    }
    this.graph.set(node, dependencies);
  }

  /**
   * 移除节点
   */
  removeNode(node) {
    this.graph.delete(node);
  }

  /**
   * 拓扑排序解析初始化顺序
   * @returns {string[]} 初始化顺序
   */
  resolve() {
    const visited = new Set();
    const visiting = new Set();
    const result = [];

    const visit = (node) => {
      if (visited.has(node)) return;
      if (visiting.has(node)) {
        throw new Error(`Circular dependency detected: ${node}`);
      }

      visiting.add(node);

      const dependencies = this.graph.get(node) || [];
      for (const dep of dependencies) {
        if (!this.graph.has(dep)) {
          throw new Error(`Dependency not found: ${node} depends on ${dep}`);
        }
        visit(dep);
      }

      visiting.delete(node);
      visited.add(node);
      result.push(node);
    };

    for (const node of this.graph.keys()) {
      visit(node);
    }

    return result;
  }

  /**
   * 获取依赖指定节点的所有节点
   */
  getDependents(node) {
    const dependents = [];
    for (const [name, deps] of this.graph) {
      if (deps.includes(node)) {
        dependents.push(name);
      }
    }
    return dependents;
  }

  /**
   * 检测循环依赖
   */
  detectCycle() {
    try {
      this.resolve();
      return null;
    } catch (error) {
      return error.message;
    }
  }
}

module.exports = DependencyResolver;
```

### 4.4 热加载器

```javascript
// backend/shared/pluginSystem/PluginHotLoader.js

const path = require('path');
const fs = require('fs').promises;

class PluginHotLoader {
  constructor(pluginManager) {
    this.manager = pluginManager;
    this.pluginPaths = new Map(); // 插件名 → 文件路径
    this.watchers = new Map();    // 文件监听器
  }

  /**
   * 加载插件模块
   * @param {string} pluginPath 插件文件路径
   * @returns {BasePlugin} 插件实例
   */
  async load(pluginPath) {
    const absolutePath = path.resolve(pluginPath);
    
    // 清除 require 缓存以支持重新加载
    delete require.cache[require.resolve(absolutePath)];
    
    const PluginClass = require(absolutePath);
    const plugin = new PluginClass();
    
    this.pluginPaths.set(plugin.name, absolutePath);
    
    return plugin;
  }

  /**
   * 启用文件监听（开发模式）
   */
  async enableWatch(pluginName) {
    const pluginPath = this.pluginPaths.get(pluginName);
    if (!pluginPath) {
      throw new Error(`Plugin ${pluginName} path not found`);
    }

    if (this.watchers.has(pluginName)) {
      return; // 已在监听
    }

    const fsWatch = require('fs').watch;
    const watcher = fsWatch(pluginPath, async (eventType) => {
      if (eventType === 'change') {
        console.log(`[PluginHotLoader] Detected change in ${pluginName}, reloading...`);
        
        try {
          // 热重载
          await this.manager.hotUnload(pluginName);
          const plugin = await this.load(pluginPath);
          this.manager.register(plugin, this.manager.pluginConfigs.get(pluginName));
          await this.manager.initializePlugin(pluginName);
          await this.manager.startPlugin(pluginName);
          
          console.log(`[PluginHotLoader] Plugin ${pluginName} reloaded successfully`);
        } catch (error) {
          console.error(`[PluginHotLoader] Failed to reload ${pluginName}:`, error);
        }
      }
    });

    this.watchers.set(pluginName, watcher);
  }

  /**
   * 禁用文件监听
   */
  disableWatch(pluginName) {
    const watcher = this.watchers.get(pluginName);
    if (watcher) {
      watcher.close();
      this.watchers.delete(pluginName);
    }
  }

  /**
   * 扫描插件目录
   */
  async scanDirectory(dirPath) {
    const plugins = [];
    const files = await fs.readdir(dirPath);

    for (const file of files) {
      if (file.endsWith('.plugin.js') || file.endsWith('Plugin.js')) {
        const pluginPath = path.join(dirPath, file);
        plugins.push(pluginPath);
      }
    }

    return plugins;
  }
}

module.exports = PluginHotLoader;
```

### 4.5 现有模块改造示例

```javascript
// backend/shared/plugins/CircuitBreakerPlugin.js

const BasePlugin = require('./BasePlugin');
const CircuitBreaker = require('../CircuitBreaker');

class CircuitBreakerPlugin extends BasePlugin {
  constructor() {
    super('circuitBreaker', '1.0.0');
    this.dependencies = ['configCenter']; // 依赖配置中心
    this.breaker = null;
  }

  async initialize() {
    console.log('[CircuitBreakerPlugin] Initializing...');
    
    // 从配置中心获取配置
    const configCenter = this.manager.getPlugin('configCenter');
    this.config = configCenter?.get('circuitBreaker') || this.config;
    
    this.breaker = new CircuitBreaker(this.config);
  }

  async start() {
    console.log('[CircuitBreakerPlugin] Starting...');
    // 熔断器无需启动操作
  }

  async stop() {
    console.log('[CircuitBreakerPlugin] Stopping...');
    // 清理资源
    this.breaker = null;
  }

  async cleanup() {
    this.breaker = null;
  }

  async onConfigUpdate(newConfig) {
    await super.onConfigUpdate(newConfig);
    if (this.breaker) {
      this.breaker.updateConfig(newConfig);
    }
  }

  // 提供给外部使用
  getBreaker() {
    return this.breaker;
  }
}

module.exports = CircuitBreakerPlugin;
```

### 4.6 服务启动集成

```javascript
// backend/services/user-service/index.js

const PluginManager = require('../../shared/pluginSystem/PluginManager');
const CircuitBreakerPlugin = require('../../shared/plugins/CircuitBreakerPlugin');
const ChaosEnginePlugin = require('../../shared/plugins/ChaosEnginePlugin');
const DegradationManagerPlugin = require('../../shared/plugins/DegradationManagerPlugin');

async function startService() {
  const pluginManager = new PluginManager();
  
  // 注册插件
  pluginManager.register(new CircuitBreakerPlugin(), config.circuitBreaker);
  pluginManager.register(new ChaosEnginePlugin(), config.chaos);
  pluginManager.register(new DegradationManagerPlugin(), config.degradation);
  
  // 初始化并启动
  await pluginManager.initializeAll();
  await pluginManager.startAll();
  
  // 优雅关闭
  process.on('SIGTERM', async () => {
    await pluginManager.stopAll();
    process.exit(0);
  });
  
  return pluginManager;
}
```

### 4.7 Admin Dashboard 集成

- **插件列表页面**：显示所有插件状态、版本、依赖关系
- **插件配置页面**：动态修改插件配置并热更新
- **插件拓扑图**：可视化插件依赖关系
- **热加载操作**：上传新插件、卸载插件

## 5. 验收标准（可测试）

- [ ] `BasePlugin` 基类定义完成，包含所有生命周期钩子
- [ ] `PluginManager.register()` 成功注册插件
- [ ] `PluginManager.initializeAll()` 按依赖拓扑排序正确初始化
- [ ] 插件 A 依赖插件 B 时，B 先于 A 初始化
- [ ] 循环依赖被正确检测并抛出错误
- [ ] `PluginManager.hotLoad()` 无需重启服务加载新插件
- [ ] `PluginManager.hotUnload()` 正确卸载插件并清理资源
- [ ] 配置更新通过 `onConfigUpdate()` 回调传递给插件
- [ ] `healthCheckAll()` 返回所有插件健康状态
- [ ] 至少 3 个现有模块改造为插件并集成
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**M - 中等工作量**
- BasePlugin 基类：1 小时
- PluginManager 管理器：3 小时
- DependencyResolver 解析器：1 小时
- PluginHotLoader 热加载器：2 小时
- 现有模块改造（3 个）：2 小时
- 服务集成：1 小时
- 单元测试：2 小时

总计约 12 小时，需 1.5 个工作日完成。

## 7. 优先级理由

**P1 - 高优先级**

理由：
1. **架构基础**：插件系统是微服务架构的重要基础设施，影响所有可扩展模块
2. **解耦需求**：当前模块初始化混乱，急需统一管理机制
3. **运维效率**：热插拔能力可显著提升部署效率，减少服务重启
4. **依赖管理**：显式依赖声明使系统更易理解和测试
5. **成熟度评分提升**：完成后"可扩展性/解耦"维度从 11 分提升至 14 分

此需求是项目架构演进的必要步骤，为后续功能扩展奠定基础。
