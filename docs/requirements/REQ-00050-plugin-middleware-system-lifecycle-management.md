# REQ-00050: 插件化中间件系统与生命周期管理

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00050 |
| 标题 | 插件化中间件系统与生命周期管理 |
| 类别 | 可扩展性/解耦 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、infrastructure/k8s |
| 创建时间 | 2026-06-09 13:00 |
| 依赖需求 | REQ-00013（事件驱动架构）、REQ-00014（熔断降级） |

## 1. 背景与问题

当前 mineGo 项目的中间件实现存在以下问题：

### 1.1 中间件分散且耦合度高
- 每个微服务独立配置中间件（JWT、限流、日志、追踪等）
- 中间件注册顺序硬编码在 `index.js` 中，修改需要改动多处
- 缺少统一的中间件生命周期管理（初始化、启动、停止、健康检查）

### 1.2 缺乏插件化能力
- 无法动态启用/禁用中间件
- 无法根据环境或配置自动加载不同中间件组合
- 第三方中间件集成困难，缺少标准接口

### 1.3 运维困难
- 中间件状态监控分散
- 无法在运行时调整中间件参数
- 故障排查需要逐个服务检查

## 2. 目标

构建统一的插件化中间件系统，实现：

1. **统一中间件注册中心**：所有中间件通过 PluginManager 统一管理
2. **生命周期管理**：支持 init、start、stop、healthCheck 钩子
3. **依赖解析**：自动处理中间件之间的依赖关系和加载顺序
4. **动态配置**：支持运行时通过 API 或配置文件调整中间件行为
5. **可观测性**：统一的中间件状态监控和指标采集

**预期收益：**
- 新服务接入时间减少 60%
- 中间件配置错误减少 80%
- 故障定位时间减少 50%

## 3. 范围

### 包含
- 插件接口定义（IPlugin）
- PluginManager 核心实现
- 内置中间件插件化改造（auth、rateLimit、logging、tracing、circuitBreaker）
- 中间件配置 Schema 和验证
- 管理 API（列表、状态、启用/禁用、配置更新）
- Prometheus 指标集成
- 单元测试和集成测试

### 不包含
- 前端插件系统（不在本需求范围）
- 数据库插件（已有独立的迁移系统）
- 第三方插件市场（后续需求）

## 4. 详细需求

### 4.1 插件接口定义

```javascript
// backend/shared/plugins/IPlugin.js

/**
 * 插件接口 - 所有中间件插件必须实现
 */
class IPlugin {
  /**
   * 插件元信息
   */
  static get meta() {
    return {
      name: '',           // 插件名称（唯一标识）
      version: '',        // 版本号
      description: '',    // 描述
      author: '',         // 作者
      dependencies: [],   // 依赖的其他插件
      priority: 100,      // 加载优先级（数字越小越先加载）
      category: 'middleware', // 分类：middleware, auth, monitoring, etc.
    };
  }

  /**
   * 配置 Schema（JSON Schema 格式）
   */
  static get configSchema() {
    return {};
  }

  /**
   * 默认配置
   */
  static get defaultConfig() {
    return {};
  }

  /**
   * 生命周期钩子
   */
  
  // 初始化 - 加载配置、建立连接
  async init(config, context) {
    throw new Error('Not implemented');
  }

  // 启动 - 开始处理请求
  async start(context) {
    throw new Error('Not implemented');
  }

  // 停止 - 清理资源
  async stop(context) {
    throw new Error('Not implemented');
  }

  // 健康检查
  async healthCheck() {
    return { status: 'healthy', details: {} };
  }

  // 获取 Express 中间件
  getMiddleware() {
    return null;
  }

  // 处理事件（可选）
  async handleEvent(eventName, payload) {
    // 默认忽略事件
  }
}

module.exports = { IPlugin };
```

### 4.2 PluginManager 核心实现

```javascript
// backend/shared/plugins/PluginManager.js

class PluginManager {
  constructor() {
    this.plugins = new Map();        // 已注册插件
    this.loadedPlugins = new Map();  // 已加载插件实例
    this.config = {};                // 全局配置
    this.logger = null;
    this.metrics = null;
  }

  // 注册插件
  register(PluginClass) {
    const meta = PluginClass.meta;
    if (this.plugins.has(meta.name)) {
      throw new Error(`Plugin ${meta.name} already registered`);
    }
    this.plugins.set(meta.name, PluginClass);
  }

  // 批量注册
  registerAll(plugins) {
    for (const Plugin of plugins) {
      this.register(Plugin);
    }
  }

  // 解析依赖并排序
  resolveDependencies(enabledPlugins) {
    // 拓扑排序，确保依赖先加载
    // 返回排序后的插件列表
  }

  // 加载插件
  async loadPlugin(name, config = {}) {
    const PluginClass = this.plugins.get(name);
    if (!PluginClass) {
      throw new Error(`Plugin ${name} not found`);
    }

    const instance = new PluginClass();
    const mergedConfig = { ...PluginClass.defaultConfig, ...config };
    
    // 验证配置
    this.validateConfig(PluginClass, mergedConfig);
    
    // 初始化
    await instance.init(mergedConfig, this.getContext());
    
    this.loadedPlugins.set(name, {
      instance,
      config: mergedConfig,
      status: 'initialized',
    });

    this.logger.info({ plugin: name }, 'Plugin loaded');
  }

  // 启动所有插件
  async startAll() {
    const order = this.resolveDependencies([...this.loadedPlugins.keys()]);
    for (const name of order) {
      const { instance } = this.loadedPlugins.get(name);
      await instance.start(this.getContext());
      this.loadedPlugins.get(name).status = 'running';
    }
  }

  // 停止所有插件（逆序）
  async stopAll() {
    const order = this.resolveDependencies([...this.loadedPlugins.keys()]).reverse();
    for (const name of order) {
      try {
        const { instance } = this.loadedPlugins.get(name);
        await instance.stop(this.getContext());
        this.loadedPlugins.get(name).status = 'stopped';
      } catch (err) {
        this.logger.error({ err, plugin: name }, 'Plugin stop failed');
      }
    }
  }

  // 获取所有中间件（按优先级排序）
  getMiddlewares() {
    return [...this.loadedPlugins.values()]
      .filter(p => p.instance.getMiddleware())
      .sort((a, b) => a.instance.constructor.meta.priority - b.instance.constructor.meta.priority)
      .map(p => p.instance.getMiddleware());
  }

  // 管理 API
  async enable(name, config) { /* ... */ }
  async disable(name) { /* ... */ }
  async updateConfig(name, config) { /* ... */ }
  async getStatus() { /* ... */ }
}
```

### 4.3 内置插件改造示例

```javascript
// backend/shared/plugins/builtins/AuthPlugin.js

const { IPlugin } = require('../IPlugin');
const { authWithBlacklistMiddleware } = require('../../middleware/jwtBlacklist');

class AuthPlugin extends IPlugin {
  static get meta() {
    return {
      name: 'auth',
      version: '1.0.0',
      description: 'JWT 认证中间件',
      dependencies: [],
      priority: 10, // 高优先级
      category: 'auth',
    };
  }

  static get configSchema() {
    return {
      type: 'object',
      properties: {
        jwtSecret: { type: 'string' },
        tokenExpiry: { type: 'number' },
        blacklistEnabled: { type: 'boolean' },
      },
      required: ['jwtSecret'],
    };
  }

  async init(config, context) {
    this.config = config;
    this.logger = context.logger.child({ plugin: 'auth' });
    // 初始化 JWT 黑名单等
  }

  getMiddleware() {
    return authWithBlacklistMiddleware;
  }

  async healthCheck() {
    // 检查 Redis 连接等
    return { status: 'healthy', details: { blacklistEnabled: this.config.blacklistEnabled } };
  }
}

module.exports = AuthPlugin;
```

### 4.4 管理 API

```javascript
// backend/shared/plugins/routes/pluginAdmin.js

// GET /admin/plugins - 列出所有插件
// GET /admin/plugins/:name - 获取插件详情
// POST /admin/plugins/:name/enable - 启用插件
// POST /admin/plugins/:name/disable - 禁用插件
// PUT /admin/plugins/:name/config - 更新配置
// GET /admin/plugins/:name/health - 健康检查
```

### 4.5 Prometheus 指标

```javascript
// 新增指标
plugin_load_count{status="success|failure"}
plugin_request_count{plugin, status}
plugin_latency_seconds{plugin}
plugin_health_status{plugin}
```

## 5. 验收标准（可测试）

- [ ] IPlugin 接口定义完整，包含所有生命周期钩子
- [ ] PluginManager 实现依赖解析和拓拓扑排序
- [ ] 至少 5 个内置中间件改造为插件形式
- [ ] 新服务可通过 PluginManager 一行代码加载所有中间件
- [ ] 管理 API 支持列出、启用、禁用、配置更新
- [ ] Prometheus 指标正确采集插件状态
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试验证插件加载顺序和依赖解析

## 6. 工作量估算

**L（Large）**

理由：
- 需要设计完整的插件系统架构
- 改造 5+ 个现有中间件
- 实现依赖解析算法
- 编写管理 API 和指标
- 大量测试用例

预计工时：16-20 小时

## 7. 优先级理由

**P1 理由：**

1. **基础设施改进**：影响所有微服务的开发效率
2. **降低维护成本**：统一中间件管理减少重复代码
3. **提升可扩展性**：为后续第三方插件集成奠定基础
4. **依赖关系**：其他需求（如 REQ-00049 SDK 抽象）可复用此插件系统
5. **运维价值**：动态配置和监控提升运维效率

不设 P0 是因为当前系统可正常工作，此为优化改进而非紧急需求。
