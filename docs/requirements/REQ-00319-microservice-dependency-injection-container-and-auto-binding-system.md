# REQ-00319：微服务依赖注入容器与自动服务发现绑定系统

- **编号**：REQ-00319
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/DependencyContainer.js、backend/shared/ServiceBinder.js、gateway、所有微服务、backend/shared/ServiceRegistry.js
- **创建时间**：2026-06-24 09:00 UTC
- **依赖需求**：REQ-00300

## 1. 背景与问题

当前 mineGo 项目已有 ServiceRegistry 实现服务注册发现，LoadBalancer 提供负载均衡，EventBusAdapter 实现事件总线适配器模式。但服务间的依赖关系管理仍存在以下问题：

1. **硬编码依赖**：每个微服务在启动时需要手动导入依赖模块（如 `require('../../../shared/db')`），缺乏声明式依赖声明和自动注入机制。

2. **缺乏依赖健康感知**：当依赖服务（如数据库、Redis、其他微服务）出现故障时，调用方无法自动感知并切换到备用实例或降级处理。

3. **依赖关系难以追踪**：没有统一的依赖图可视化工具，运维人员难以快速了解服务间的依赖拓扑。

4. **热插拔能力不足**：无法在不重启服务的情况下动态替换依赖实现（如从 Kafka 切换到 Redis Streams 作为事件总线）。

## 2. 目标

构建一个统一的依赖注入容器与服务绑定系统，实现：

- 声明式依赖配置，服务启动时自动注入所需依赖
- 依赖健康感知，自动监测依赖状态并触发告警/降级
- 动态依赖替换，支持运行时切换依赖实现
- 依赖拓扑可视化，生成服务依赖图供运维参考
- 与现有 ServiceRegistry 和 LoadBalancer 无缝集成

## 3. 范围

- **包含**：
  - DependencyContainer 类：核心依赖注入容器
  - ServiceBinder 类：自动服务发现与绑定器
  - 依赖健康监测器：实时监测依赖状态
  - 依赖拓扑生成器：生成 Mermaid/JSON 格式依赖图
  - 声明式配置加载器：从配置文件或环境变量加载依赖声明
  - 集成 ServiceFactory：改造 ServiceFactory 支持依赖注入

- **不包含**：
  - 服务网格实现（如 Istio 集成）
  - 分布式事务协调器
  - 配置中心（已有 ConfigCenter.js）

## 4. 详细需求

### 4.1 DependencyContainer 核心接口

```javascript
// backend/shared/DependencyContainer.js

/**
 * 依赖注入容器
 */
class DependencyContainer {
  /**
   * 注册依赖
   * @param {string} name - 依赖名称（如 'db', 'redis', 'eventBus'）
   * @param {Function|Object} factory - 工厂函数或实例
   * @param {Object} options - 配置选项
   */
  register(name, factory, options = {});

  /**
   * 解析依赖
   * @param {string} name - 依赖名称
   * @returns {Promise<any>} - 依赖实例
   */
  resolve(name);

  /**
   * 批量解析依赖
   * @param {string[]} names - 依赖名称列表
   * @returns {Promise<Object>} - 依赖映射对象
   */
  resolveAll(names);

  /**
   * 检查依赖是否已注册
   */
  has(name);

  /**
   * 替换依赖实现（热插拔）
   */
  replace(name, newFactory, options = {});

  /**
   * 获取所有已注册依赖列表
   */
  list();
}
```

### 4.2 ServiceBinder 自动绑定

```javascript
// backend/shared/ServiceBinder.js

/**
 * 服务绑定器 - 自动发现并绑定微服务依赖
 */
class ServiceBinder {
  /**
   * 绑定远程服务
   * @param {string} serviceName - 目标服务名称
   * @param {Object} options - 绑定选项
   * @returns {Promise<ServiceProxy>} - 服务代理对象
   */
  async bindService(serviceName, options = {});

  /**
   * 创建服务代理
   * - 自动路由到健康实例
   * - 支持负载均衡
   * - 支持降级处理
   */
  createProxy(serviceName, instances);
}

/**
 * 服务代理 - 透明调用远程服务
 */
class ServiceProxy {
  /**
   * 调用服务方法
   * @param {string} method - 方法名（路由路径）
   * @param {Object} data - 请求数据
   * @param {Object} options - 调用选项
   */
  async call(method, data, options = {});

  /**
   * 获取当前绑定的实例信息
   */
  getBoundInstance();
}
```

### 4.3 声明式依赖配置

```yaml
# config/dependencies.yaml
service: user-service
dependencies:
  # 基础设施依赖
  infrastructure:
    db:
      type: pool
      factory: getPool
      healthCheck: query('SELECT 1')
      required: true
    redis:
      type: singleton
      factory: getRedis
      healthCheck: ping()
      required: true
    eventBus:
      type: singleton
      factory: createEventBus
      config:
        adapter: kafka
      required: true

  # 微服务依赖
  services:
    pokemon-service:
      required: false  # 可选依赖
      fallback: localCache  # 降级策略
      routes:
        - /pokemon/details
        - /pokemon/list
    location-service:
      required: true
      routes:
        - /location/nearby
        - /location/spawn
```

### 4.4 依赖健康监测

```javascript
// backend/shared/DependencyHealthMonitor.js

/**
 * 依赖健康监测器
 */
class DependencyHealthMonitor {
  /**
   * 启动监测
   */
  async start();

  /**
   * 监测单个依赖
   */
  async checkDependency(name);

  /**
   * 获取依赖状态
   */
  getDependencyStatus(name);

  /**
   * 注册状态变更回调
   */
  onStatusChange(name, callback);
}
```

状态变更事件：
- `healthy` → `degraded`：触发告警，尝试切换备用
- `degraded` → `unhealthy`：触发降级，使用 fallback
- `unhealthy` → `healthy`：恢复主依赖

### 4.5 依赖拓扑生成

```javascript
// backend/shared/DependencyTopology.js

/**
 * 依赖拓扑生成器
 */
class DependencyTopology {
  /**
   * 从容器构建依赖图
   */
  buildFromContainer(container);

  /**
   * 生成 Mermaid 图
   */
  generateMermaid();

  /**
   * 生成 JSON 格式
   */
  toJSON();

  /**
   * 检测循环依赖
   */
  detectCircularDependencies();
}
```

### 4.6 与 ServiceFactory 集成

改造 ServiceFactory 支持依赖注入：

```javascript
// 使用示例
const container = new DependencyContainer();

// 从配置加载依赖
await container.loadFromConfig('config/dependencies.yaml');

// 创建服务时自动注入
const { app, logger } = await ServiceFactory.createService({
  name: 'user-service',
  port: 8081,
  dependencies: ['db', 'redis', 'eventBus', 'pokemon-service'], // 声明依赖
  container, // 提供容器
  init: async (deps) => {
    // deps.db, deps.redis, deps.eventBus, deps.pokemonService 自动注入
    const { db, redis, eventBus, pokemonService } = deps;
    // 使用注入的依赖...
  }
});
```

## 5. 验收标准（可测试）

- [ ] DependencyContainer 支持注册、解析、替换依赖，单元测试覆盖率 ≥ 90%
- [ ] ServiceBinder 能自动发现服务实例并创建透明代理
- [ ] 声明式 YAML 配置能正确加载并注入依赖
- [ ] 依赖健康监测能在依赖状态变化时触发正确的事件和回调
- [ ] 依赖拓扑生成器能输出正确的 Mermaid 图和 JSON 格式
- [ ] 循环依赖检测能正确识别并报告循环依赖
- [ ] 与 ServiceFactory 集成后，服务启动时依赖自动注入
- [ ] 热插拔测试：运行时替换 EventBus 适配器，服务无需重启
- [ ] 降级测试：pokemon-service 不可用时，user-service 使用 fallback 缓存

## 6. 工作量估算

**L**（Large）

理由：
- 需要设计并实现 5 个核心模块
- 与现有 ServiceRegistry、LoadBalancer、ServiceFactory 集成
- 需要改造所有微服务的启动代码
- 需要完整的测试覆盖

## 7. 优先级理由

**P1** - 高优先级

1. **解耦核心基础设施**：当前服务间依赖硬编码，这是架构灵活性的关键障碍
2. **提升运维效率**：依赖拓扑可视化帮助运维快速定位问题
3. **支持未来扩展**：热插拔能力为后续添加新消息系统、新存储提供便利
4. **增强容灾能力**：依赖健康感知和自动降级提升系统稳定性
5. **与 REQ-00300 配合**：ServiceRegistry 已实现，此需求在其基础上构建依赖管理层

---

**创建人**：mineGo 开发循环自动化系统
**创建时间**：2026-06-24 09:00 UTC