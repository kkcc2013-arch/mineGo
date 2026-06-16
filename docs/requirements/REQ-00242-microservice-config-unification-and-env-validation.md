# REQ-00242：微服务启动配置统一化与环境变量校验系统

- **编号**：REQ-00242
- **类别**：技术债/重构
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：所有微服务、backend/shared/configValidator.js、backend/shared/ServiceBootstrap.js
- **创建时间**：2026-06-16 03:00
- **依赖需求**：REQ-00122

## 1. 背景与问题

当前各微服务启动配置存在以下技术债问题：

1. **环境变量分散**：每个微服务独立读取环境变量，缺乏统一校验和默认值管理
2. **配置重复**：数据库、Redis、Kafka 连接配置在每个服务中重复定义
3. **启动失败不明确**：缺少配置项时启动失败，错误信息不清晰
4. **配置文档缺失**：环境变量文档分散在各处，难以维护
5. **开发环境不一致**：开发者本地配置不统一，导致调试困难

## 2. 目标

- 建立统一的微服务启动配置校验系统
- 实现环境变量自动校验与类型转换
- 提供清晰的配置错误提示和文档生成
- 简化微服务启动代码，减少样板代码

## 3. 范围

- **包含**：
  - 统一配置校验器（ConfigValidator）
  - 服务启动引导器（ServiceBootstrap）
  - 配置 Schema 定义规范
  - 自动生成配置文档脚本
  - 开发环境配置模板

- **不包含**：
  - 配置中心动态配置（已在 REQ-00122 实现）
  - 敏感配置加密存储

## 4. 详细需求

### 4.1 ConfigValidator 模块

```javascript
// backend/shared/configValidator.js
class ConfigValidator {
  constructor(schema) {
    this.schema = schema;
    this.errors = [];
  }

  // 校验所有配置项
  validate() { }

  // 获取校验后的配置对象
  getConfig() { }

  // 生成配置文档
  generateDocs() { }
}

// Schema 定义示例
const serviceSchema = {
  PORT: {
    type: 'number',
    required: true,
    default: 3000,
    description: '服务监听端口',
    min: 1024,
    max: 65535
  },
  DATABASE_URL: {
    type: 'string',
    required: true,
    description: 'PostgreSQL 连接字符串',
    pattern: /^postgresql:\/\//
  },
  REDIS_URL: {
    type: 'string',
    required: false,
    default: 'redis://localhost:6379',
    description: 'Redis 连接字符串'
  },
  LOG_LEVEL: {
    type: 'enum',
    values: ['debug', 'info', 'warn', 'error'],
    default: 'info',
    description: '日志级别'
  }
};
```

### 4.2 ServiceBootstrap 模块

```javascript
// backend/shared/ServiceBootstrap.js
class ServiceBootstrap {
  constructor(options) {
    this.serviceName = options.serviceName;
    this.schema = options.schema;
    this.routes = options.routes;
    this.middlewares = options.middlewares;
  }

  // 初始化配置
  async initConfig() { }

  // 初始化数据库连接
  async initDatabase() { }

  // 初始化 Redis 连接
  async initRedis() { }

  // 初始化 Kafka
  async initKafka() { }

  // 启动服务
  async start() { }

  // 优雅关闭
  async shutdown() { }
}
```

### 4.3 微服务启动简化

改造前（每个服务需要 100+ 行样板代码）：
```javascript
// 旧方式
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}
// ... 大量配置和初始化代码
app.listen(PORT);
```

改造后（统一启动）：
```javascript
// 新方式
const { ServiceBootstrap, commonSchema } = require('../shared');
const routes = require('./routes');

const bootstrap = new ServiceBootstrap({
  serviceName: 'pokemon-service',
  schema: { ...commonSchema, ...require('./configSchema') },
  routes
});

bootstrap.start();
```

### 4.4 配置文档自动生成

```bash
# 生成所有服务的配置文档
node scripts/generate-config-docs.js

# 输出：docs/configuration/SERVICE_NAME.md
```

## 5. 验收标准（可测试）

- [ ] ConfigValidator 能正确校验所有类型的环境变量（string、number、boolean、enum）
- [ ] 缺少必填配置项时，输出清晰的错误提示（包含配置名、描述、示例）
- [ ] 所有 9 个微服务使用 ServiceBootstrap 启动
- [ ] 启动代码减少 50% 以上
- [ ] 配置文档自动生成并保持最新
- [ ] 单元测试覆盖率 ≥ 90%

## 6. 工作量估算

**M（中等）**：需要改造 9 个微服务的启动代码，创建 2 个共享模块，编写配置 Schema 定义。

## 7. 优先级理由

P1 级别：这是技术债清理的关键需求，直接影响开发效率和代码可维护性。统一配置管理后，新增微服务或修改配置将更加简单安全。
