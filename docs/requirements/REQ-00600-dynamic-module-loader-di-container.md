# REQ-00600：动态模块加载器与依赖注入容器系统

- **编号**：REQ-00600
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/moduleLoader、backend/shared/diContainer、gateway、所有后端服务
- **创建时间**：2026-07-20 01:00
- **依赖需求**：REQ-00501（日志适配器抽象层）

## 1. 背景与问题

当前 mineGo 微服务架构中，模块初始化和依赖管理存在以下痛点：

1. **硬编码依赖**：各服务的初始化代码中大量 `require` 硬编码依赖，导致：
   - 单元测试时难以 mock 替换真实依赖
   - 模块间耦合度高，重构成本大
   
2. **初始化顺序混乱**：服务启动时，模块初始化顺序依赖手动控制，容易出现：
   - 依赖未就绪就调用导致运行时错误
   - 循环依赖检测困难
   
3. **环境适配不灵活**：不同环境（开发/测试/生产）需要不同模块实现，当前通过 if-else 判断，代码可读性差。

4. **热重载缺失**：生产环境无法在不重启服务的情况下更新特定模块（如配置中心客户端）。

## 2. 目标

构建统一的模块加载器和依赖注入容器：

1. **声明式依赖**：通过配置声明模块依赖关系，自动解析初始化顺序
2. **生命周期管理**：支持模块的 init/start/stop 生命周期钩子
3. **环境适配**：根据环境变量自动选择合适的模块实现
4. **热重载支持**：支持运行时替换特定模块实例
5. **循环依赖检测**：启动时自动检测循环依赖并报错

## 3. 范围

- **包含**：
  - `ModuleLoader` 类：模块注册、依赖解析、按序初始化
  - `DIContainer` 类：依赖注入容器，支持构造器注入和属性注入
  - `ModuleRegistry` 类：模块注册表，支持按名称/类型查找
  - `HotReloader` 类：热重载管理器（可选，需要文件监听）
  - 单元测试覆盖所有核心功能
  
- **不包含**：
  - 前端模块加载（属于 game-client 范畴）
  - 服务间 RPC 调用（属于 gateway/API 层）
  - 配置文件格式约定（已有 ConfigCenter 处理）

## 4. 详细需求

### 4.1 DIContainer 类

```javascript
// backend/shared/diContainer.js
class DIContainer {
  // 注册模块
  register(name, moduleClass, options = {})
  // options: { lifecycle: 'singleton'|'transient', deps: ['logger', 'db'], env: { dev: MockLogger, prod: Logger } }
  
  // 获取模块实例
  get(name)
  
  // 检查模块是否已注册
  has(name)
  
  // 批量获取
  getAll(names)
  
  // 替换模块实现（热重载用）
  replace(name, newModuleClass)
  
  // 清空容器（测试用）
  clear()
}
```

### 4.2 ModuleLoader 类

```javascript
// backend/shared/moduleLoader.js
class ModuleLoader {
  constructor(container)
  
  // 加载模块目录
  loadDirectory(dir, pattern = '**/*.module.js')
  
  // 加载单个模块文件
  loadFile(filePath)
  
  // 解析依赖图
  resolveDependencies()
  
  // 按依赖顺序初始化所有模块
  async initializeAll()
  
  // 优雅关闭所有模块
  async shutdownAll()
  
  // 检测循环依赖
  detectCircularDependencies()
}
```

### 4.3 模块定义格式

```javascript
// 示例：catch-service.module.js
module.exports = {
  name: 'catch-service',
  version: '1.0.0',
  
  // 依赖声明
  dependencies: ['logger', 'db', 'redis', 'kafka'],
  
  // 工厂函数
  factory: (deps) => {
    return new CatchService(deps.logger, deps.db, deps.redis, deps.kafka);
  },
  
  // 生命周期钩子
  lifecycle: {
    async init(instance) { await instance.connect(); },
    async start(instance) { await instance.startListening(); },
    async stop(instance) { await instance.disconnect(); }
  },
  
  // 环境适配
  environments: {
    test: {
      dependencies: ['mockLogger', 'mockDb']
    }
  }
};
```

### 4.4 使用示例

```javascript
// gateway/src/index.js
const { DIContainer, ModuleLoader } = require('../../shared');

async function bootstrap() {
  const container = new DIContainer();
  const loader = new ModuleLoader(container);
  
  // 加载所有模块
  loader.loadDirectory('./modules');
  
  // 解析依赖
  const cycle = loader.detectCircularDependencies();
  if (cycle.length > 0) {
    throw new Error(`Circular dependency detected: ${cycle.join(' -> ')}`);
  }
  
  // 按序初始化
  await loader.initializeAll();
  
  // 获取服务实例
  const gateway = container.get('gateway');
  await gateway.start();
}

bootstrap().catch(console.error);
```

### 4.5 热重载（可选）

```javascript
const hotReloader = new HotReloader(container, {
  watchDir: './modules',
  debounce: 1000
});

hotReloader.on('reload', (moduleName) => {
  console.log(`Module ${moduleName} reloaded`);
});
```

## 5. 验收标准（可测试）

- [ ] DIContainer 支持注册 singleton 和 transient 两种生命周期
- [ ] DIContainer 支持构造器注入和属性注入
- [ ] ModuleLoader 能正确解析依赖图并按拓扑顺序初始化
- [ ] 检测到循环依赖时抛出明确错误信息
- [ ] 模块初始化失败时，已初始化模块能正确回滚关闭
- [ ] 支持根据 NODE_ENV 环境变量选择不同模块实现
- [ ] 单元测试覆盖率 ≥ 90%
- [ ] 性能：100 个模块初始化耗时 < 500ms

## 6. 工作量估算

**L（Large）**：约 800-1000 行代码 + 500 行测试

- DIContainer 核心：150 行
- ModuleLoader 核心：200 行
- 依赖图解析算法：100 行
- 热重载（可选）：100 行
- 单元测试：500 行
- 集成到各服务：150 行

## 7. 优先级理由

**P1**：可扩展性/解耦是微服务架构的核心能力，直接影响：
- 代码可维护性和重构成本
- 单元测试覆盖率（mock 依赖更容易）
- 服务启动稳定性（依赖顺序自动保证）

该需求是 REQ-00505（插件系统）的基础设施，两者配合实现完整的模块化架构。
