# 依赖注入容器迁移指南

## 概述

本指南帮助开发者将现有服务迁移到统一的依赖注入容器系统。

## 背景

在 mineGo 项目中，每个服务都需要初始化数据库、Redis、Kafka、日志等共享依赖。这导致：

- **重复代码**：每个服务都有相似的初始化逻辑
- **配置分散**：配置散布在多个文件中
- **测试困难**：难以 mock 依赖进行单元测试
- **启动顺序混乱**：缺乏明确的依赖初始化顺序

## 新架构

使用统一的依赖注入容器后：

```javascript
// 旧方式：每个服务独立初始化
const logger = require('./logger');
const db = new Pool({ ... });
const redis = new Redis({ ... });

// 新方式：统一容器管理
const { container, logger } = await bootstrapService('my-service', {
  config: { /* 服务配置 */ }
});
const db = container.resolve('db');
const redis = container.resolve('redis');
```

## 迁移步骤

### 步骤 1：更新服务入口文件

**之前（gateway/index.js）**：
```javascript
const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');
const pino = require('pino');

const logger = pino({ level: 'info' });
const db = new Pool({ ... });
const redis = new Redis({ ... });

const app = express();
// ... 业务代码 ...

process.on('SIGTERM', async () => {
  await db.end();
  await redis.quit();
});
```

**之后（gateway/index.js）**：
```javascript
const { bootstrapService } = require('../shared/serviceBootstrap');

async function startGateway() {
  const { container, config, logger } = await bootstrapService('gateway', {
    config: { gateway_port: 3000 }
  });
  
  const db = container.resolve('db');
  const redis = container.resolve('redis');
  
  const express = require('express');
  const app = express();
  // ... 业务代码 ...
}

startGateway().catch(console.error);
```

### 步骤 2：更新配置加载

**之前**：
```javascript
const config = {
  dbHost: process.env.DB_HOST || 'localhost',
  dbPort: parseInt(process.env.DB_PORT) || 5432,
  // ... 手动加载每个配置项
};
```

**之后**：
```javascript
const { container } = await bootstrapService('my-service');
const config = container.resolve('config');

// 自动从环境变量加载（MINEGO_ 前缀）
const dbHost = config.get('db_host');  // 从 MINEGO_DB_HOST 读取
const dbPort = config.get('db_port', 5432);  // 带默认值
```

### 步骤 3：更新测试代码

**之前**：
```javascript
// 测试时需要手动 mock 每个依赖
jest.mock('../shared/logger');
jest.mock('pg');
jest.mock('ioredis');

const db = { query: jest.fn() };
const redis = { get: jest.fn() };
```

**之后**：
```javascript
const { createTestContainer } = require('../shared/serviceBootstrap');

// 使用测试容器自动 mock
const container = createTestContainer({
  db: { query: jest.fn() },
  redis: { get: jest.fn() }
});

const db = container.resolve('db');
```

### 步骤 4：更新健康检查

**之前**：
```javascript
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT NOW()');
    await redis.ping();
    res.json({ status: 'healthy' });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy' });
  }
});
```

**之后**：
```javascript
app.get('/health', async (req, res) => {
  const health = await container.healthCheck();
  res.json(health);
  // 自动检查所有已注册依赖的健康状态
});
```

### 步骤 5：移除关闭钩子

**之前**：
```javascript
process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  await db.end();
  await redis.quit();
  await kafka.disconnect();
  process.exit(0);
});
```

**之后**：
```javascript
// bootstrapService 自动注册关闭钩子
// 无需手动处理
```

## API 参考

### DependencyContainer

#### register(name, factory, options)
注册依赖

```javascript
container.register('myDependency', (container) => {
  const config = container.resolve('config');
  return new MyService(config);
}, {
  singleton: true,  // 是否单例（默认 true）
  healthCheck: async () => ({ status: 'healthy' }),  // 健康检查函数
  shutdown: async () => { /* 清理逻辑 */ }  // 关闭函数
});
```

#### resolve(name)
解析依赖

```javascript
const instance = container.resolve('myDependency');
```

#### initialize()
初始化所有单例依赖

```javascript
const results = await container.initialize();
// results: { success: [...], failed: [...], skipped: [...] }
```

#### healthCheck()
执行健康检查

```javascript
const health = await container.healthCheck();
// { status: 'healthy', dependencies: { ... } }
```

#### shutdown()
关闭所有依赖

```javascript
await container.shutdown();
```

### ConfigManager

#### get(key, defaultValue)
获取配置值

```javascript
const host = config.get('db_host', 'localhost');
```

#### set(key, value)
设置运行时配置

```javascript
config.set('runtime_value', 'dynamic');
```

#### getDatabaseConfig()
获取数据库配置

```javascript
const dbConfig = config.getDatabaseConfig();
// { host, port, database, user, password, ... }
```

#### getRedisConfig()
获取 Redis 配置

```javascript
const redisConfig = config.getRedisConfig();
```

### serviceBootstrap

#### bootstrapService(serviceName, options)
引导服务启动

```javascript
const { container, config, logger } = await bootstrapService('gateway', {
  config: { /* 服务配置 */ },
  enableDatabase: true,  // 启用数据库
  enableRedis: true,     // 启用 Redis
  enableKafka: false,    // 禁用 Kafka
  enableCache: true,     // 启用缓存
  enableMetrics: true,   // 启用 Prometheus 指标
  customDependencies: {  // 自定义依赖
    'authMiddleware': (container) => new AuthMiddleware()
  }
});
```

## 最佳实践

### 1. 使用配置管理器而非环境变量

❌ **不推荐**：
```javascript
const host = process.env.DB_HOST || 'localhost';
```

✅ **推荐**：
```javascript
const config = container.resolve('config');
const host = config.get('db_host', 'localhost');
```

### 2. 在构造函数中注入依赖

❌ **不推荐**：
```javascript
class UserService {
  constructor() {
    this.db = require('../shared/db');  // 硬编码依赖
  }
}
```

✅ **推荐**：
```javascript
class UserService {
  constructor(db, logger) {  // 依赖注入
    this.db = db;
    this.logger = logger;
  }
}
```

### 3. 使用容器解析依赖

❌ **不推荐**：
```javascript
const logger = require('../shared/logger');
```

✅ **推荐**：
```javascript
const logger = container.resolve('logger');
```

### 4. 测试时使用测试容器

❌ **不推荐**：
```javascript
jest.mock('../shared/logger');
```

✅ **推荐**：
```javascript
const container = createTestContainer({
  logger: { info: jest.fn() }
});
```

## 常见问题

### Q: 如何添加自定义依赖？

A: 在 `bootstrapService` 的 `customDependencies` 参数中添加：

```javascript
await bootstrapService('my-service', {
  customDependencies: {
    'myService': (container) => {
      const db = container.resolve('db');
      return new MyService(db);
    }
  }
});
```

### Q: 如何在测试中 mock 数据库？

A: 使用 `createTestContainer`：

```javascript
const mockDb = {
  query: jest.fn().mockResolvedValue({ rows: [] })
};

const container = createTestContainer({
  db: mockDb
});
```

### Q: 配置优先级是什么？

A: 配置加载优先级：
1. 环境变量（最高）
2. 配置中心
3. 本地配置文件
4. 默认值（最低）

### Q: 如何查看当前配置？

A: 使用 `export()` 方法：

```javascript
console.log(config.export());
```

## 迁移检查清单

- [ ] 更新服务入口文件，使用 `bootstrapService`
- [ ] 移除手动的依赖初始化代码
- [ ] 移除手动的关闭钩子
- [ ] 更新健康检查端点
- [ ] 更新测试代码，使用 `createTestContainer`
- [ ] 使用 `config.get()` 替代 `process.env`
- [ ] 运行完整测试套件验证迁移正确性
- [ ] 删除旧的依赖初始化代码

## 获取帮助

如遇问题，请：
1. 查看 `backend/shared/dependencyContainer.js` 源码
2. 查看 `backend/services/gateway/index-refactored.js` 示例
3. 运行单元测试：`npm test backend/tests/unit/dependencyContainer.test.js`
