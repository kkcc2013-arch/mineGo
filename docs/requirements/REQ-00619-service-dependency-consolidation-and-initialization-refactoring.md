# REQ-00619: 服务依赖配置统一与初始化模块重构

- **编号**：REQ-00619
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/config、backend/shared/dependencies、所有后端服务、gateway
- **创建时间**：2026-07-20 20:05
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 项目存在以下技术债问题：

1. **重复的依赖初始化代码**：在 backend/shared/ 目录下，超过 200 处重复的 `require('./logger')`、69 处 `require('./db')`、55 处 `require('./redis')` 调用，每个服务启动时都要重新初始化这些共享依赖。

2. **配置分散**：每个服务独立管理数据库连接、Redis 客户端、Kafka producer、日志实例等，配置分散在多个文件中，缺乏统一的生命周期管理。

3. **启动顺序混乱**：服务启动时缺乏明确的依赖初始化顺序，可能导致某些模块在依赖尚未就绪时就被调用。

4. **测试困难**：由于依赖初始化散布在各处，单元测试时难以 mock 和替换依赖。

这些问题会导致：
- 代码重复率高，维护成本增加
- 服务启动时间延长
- 内存泄漏风险（未正确关闭的连接）
- 新服务创建时需要复制大量样板代码

## 2. 目标

创建统一的依赖注入容器和配置管理模块，实现：

1. **单一初始化入口**：所有共享依赖通过统一模块初始化
2. **依赖生命周期管理**：自动处理启动、健康检查、优雅关闭
3. **配置集中化**：所有服务配置从统一配置中心加载
4. **测试友好**：支持依赖替换和 mock
5. **减少重复代码**：减少至少 60% 的依赖初始化样板代码

## 3. 范围

- **包含**：
  - 创建 `backend/shared/dependencyContainer.js` 统一依赖容器
  - 创建 `backend/shared/serviceBootstrap.js` 服务启动引导模块
  - 创建 `backend/shared/configManager.js` 配置管理器
  - 重构现有服务的启动代码
  - 添加依赖健康检查机制
  - 单元测试覆盖

- **不包含**：
  - 改变现有业务逻辑
  - 修改前端代码
  - 更改数据库 Schema
  - 重写所有服务（仅重构初始化部分）

## 4. 详细需求

### 4.1 依赖容器设计

```javascript
// backend/shared/dependencyContainer.js
class DependencyContainer {
  // 注册单例依赖
  register(name, factory, options = { singleton: true })
  
  // 解析依赖
  resolve(name)
  
  // 批量初始化所有依赖
  async initialize()
  
  // 健康检查
  async healthCheck()
  
  // 优雅关闭
  async shutdown()
  
  // 重置容器（测试用）
  reset()
}
```

### 4.2 必须注册的核心依赖

- `logger` - 日志实例
- `db` - PostgreSQL 连接池
- `redis` - Redis 客户端
- `kafka` - Kafka producer
- `cache` - 缓存服务
- `metrics` - Prometheus 指标注册表
- `config` - 配置管理器

### 4.3 服务启动引导

```javascript
// backend/shared/serviceBootstrap.js
async function bootstrapService(serviceName, options = {}) {
  const container = new DependencyContainer();
  
  // 1. 加载配置
  await container.resolve('config').load();
  
  // 2. 初始化核心依赖
  await container.initialize();
  
  // 3. 执行健康检查
  const health = await container.healthCheck();
  
  // 4. 注册关闭钩子
  process.on('SIGTERM', () => container.shutdown());
  process.on('SIGINT', () => container.shutdown());
  
  return container;
}
```

### 4.4 配置优先级

1. 环境变量（最高优先级）
2. 配置中心（如果启用）
3. 本地配置文件
4. 默认值（最低优先级）

### 4.5 向后兼容

- 保留现有 `require('./logger')` 等调用方式，内部委托给容器
- 添加 deprecation 警告，引导开发者使用新方式

## 5. 验收标准（可测试）

- [ ] 创建 DependencyContainer 类，支持单例和工厂模式依赖注册
- [ ] 实现至少 7 种核心依赖的统一初始化（logger/db/redis/kafka/cache/metrics/config）
- [ ] 重构至少 3 个服务（gateway/user-service/pokemon-service）使用新启动方式
- [ ] 添加 `npm run health:check` 命令，验证所有依赖就绪
- [ ] 单元测试覆盖率 >= 85%
- [ ] 服务启动时间减少 20% 以上（通过性能测试验证）
- [ ] 代码重复行数减少至少 200 行（通过代码统计验证）
- [ ] 支持测试环境下依赖 mock 和替换

## 6. 工作量估算

**L** - 需要创建核心基础设施模块，重构多个服务的启动代码，并确保向后兼容性。预计 3-5 天完成。

## 7. 优先级理由

P1 优先级，理由如下：

1. **影响范围广**：涉及所有后端服务的基础架构
2. **技术债积累**：重复代码已超过 200 处，维护成本持续增加
3. **性能优化基础**：统一初始化为后续启动优化奠定基础
4. **测试改进前提**：改善测试可测试性的关键步骤
5. **新服务开发效率**：新服务创建时减少样板代码编写时间
