# REQ-00012：微服务启动样板代码重构与统一

- **编号**：REQ-00012
- **类别**：技术债/重构
- **优先级**：P2
- **状态**：done
- **涉及服务/模块**：所有微服务、backend/shared
- **创建时间**：2026-06-05 09:20
- **依赖需求**：REQ-00002（结构化日志）、REQ-00005（Prometheus 指标）

## 1. 背景与问题

当前 mineGo 后端 8 个微服务存在严重的代码重复问题：

### 1.1 重复的启动样板代码

每个服务的 `src/index.js` 都包含几乎相同的初始化逻辑：

```javascript
// 重复出现在所有 8 个服务中
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { errorHandler } = require('../../../shared/auth');
const { createLogger, requestLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');
const { i18nMiddleware } = require('../../../shared/i18n');

const app = express();
const PORT = process.env.PORT || 808x;

app.use(helmet());
app.use(cors({ ... }));
app.use(express.json({ limit: '1mb' }));
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));
app.use(i18nMiddleware);
// ... 更多重复配置
```

### 1.2 问题影响

1. **维护成本高**：修改一个中间件配置需要修改 8 个文件
2. **不一致风险**：容易遗漏某个服务，导致配置不一致
3. **代码膨胀**：每个服务文件 200-400 行，大部分是样板代码
4. **新人困惑**：难以快速理解服务架构，淹没在重复代码中
5. **测试困难**：每个服务都需要重复测试相同的初始化逻辑

### 1.3 当前代码统计

| 服务 | 主文件行数 | 样板代码占比 |
|------|-----------|-------------|
| user-service | 2403 | ~60% |
| location-service | 13454 | ~40% |
| catch-service | 13141 | ~40% |
| gym-service | 13467 | ~40% |
| pokemon-service | 13701 | ~40% |
| social-service | 13785 | ~40% |
| reward-service | 11726 | ~40% |
| payment-service | 14193 | ~40% |

**总计**：约 8000 行代码，其中 3000+ 行是重复的样板代码。

## 2. 目标

通过提取共享的服务启动框架，实现：

1. **消除重复**：样板代码集中到 `backend/shared/ServiceLauncher.js`
2. **简化服务**：每个服务只需声明路由和业务逻辑
3. **统一配置**：中间件、日志、指标、限流等配置统一管理
4. **易于扩展**：新增服务只需几行代码即可启动
5. **提高可维护性**：修改一处，所有服务受益

## 3. 范围

### 包含
- 创建 `ServiceLauncher` 基础框架
- 重构所有 8 个微服务使用新框架
- 统一中间件配置（helmet、cors、rateLimit、logger、metrics、i18n）
- 环境变量配置统一管理
- 服务启动测试覆盖

### 不包含
- 业务逻辑重构（仅重构启动和中间件部分）
- API 路由重构
- 数据库连接池重构（可在后续需求处理）

## 4. 详细需求

### 4.1 ServiceLauncher 框架设计

#### 4.1.1 核心类
```javascript
// backend/shared/ServiceLauncher.js
class ServiceLauncher {
  constructor(options) {
    this.serviceName = options.serviceName;
    this.version = options.version || '1.0.0';
    this.port = options.port || process.env.PORT || 8080;
    this.routes = options.routes || [];
    this.middleware = options.middleware || [];
    this.healthCheck = options.healthCheck || this.defaultHealthCheck;
    this.onReady = options.onReady || (() => {});
  }

  // 默认健康检查
  defaultHealthCheck(_, res) {
    res.json({ status: 'ok', service: this.serviceName, version: this.version });
  }

  // 创建 Express 应用
  createApp() {
    const app = express();
    
    // 安全中间件
    app.use(helmet(this.getHelmetConfig()));
    app.use(cors(this.getCorsConfig()));
    app.use(express.json({ limit: '1mb' }));
    
    // 可观测性中间件
    app.use(requestLogger(this.logger));
    app.use(metrics.httpMetricsMiddleware(this.serviceName));
    app.use(i18nMiddleware);
    
    // 自定义中间件
    this.middleware.forEach(mw => app.use(mw));
    
    // 标准端点
    app.get('/health', this.healthCheck);
    app.get('/metrics', this.metricsEndpoint.bind(this));
    
    // 业务路由
    this.routes.forEach(route => {
      app.use(route.path, rateLimit(route.rateLimit || this.defaultRateLimit), route.router);
    });
    
    // 错误处理
    app.use(errorHandler);
    
    return app;
  }

  // 启动服务
  async start() {
    const app = this.createApp();
    
    await new Promise((resolve) => {
      app.listen(this.port, () => {
        this.logger.info({ port: this.port }, `${this.serviceName} started`);
        resolve();
      });
    });
    
    await this.onReady(app);
    return app;
  }

  // 配置方法（可被子类覆盖）
  getHelmetConfig() { return {}; }
  getCorsConfig() {
    return { origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' };
  }
  get defaultRateLimit() {
    return { windowMs: 60_000, max: 100 };
  }
}
```

#### 4.1.2 服务配置对象
```javascript
// backend/shared/ServiceConfig.js
const SERVICE_CONFIGS = {
  'user-service': {
    port: 8081,
    routes: [
      { path: '/auth', router: require('./routes/auth'), rateLimit: { windowMs: 60_000, max: 20 } },
      { path: '/users', router: require('./routes/user') },
      { path: '/friends', router: require('./routes/friend') }
    ]
  },
  'location-service': {
    port: 8082,
    routes: [
      { path: '/location', router: require('./routes/location') },
      { path: '/nearby', router: require('./routes/nearby') }
    ]
  },
  // ... 其他服务配置
};

module.exports = { ServiceLauncher, SERVICE_CONFIGS };
```

### 4.2 重构后的服务代码

#### 4.2.1 user-service 重构示例
```javascript
// backend/services/user-service/src/index.js (重构后)
'use strict';

const { ServiceLauncher } = require('../../../shared/ServiceLauncher');
const authRouter = require('./routes/auth');
const userRouter = require('./routes/user');
const friendRouter = require('./routes/friend');

const service = new ServiceLauncher({
  serviceName: 'user-service',
  port: 8081,
  routes: [
    { path: '/auth', router: authRouter, rateLimit: { windowMs: 60_000, max: 20 } },
    { path: '/users', router: userRouter },
    { path: '/friends', router: friendRouter }
  ],
  onReady: async (app) => {
    // 服务特定初始化逻辑
    console.log('User service ready');
  }
});

service.start().catch(err => {
  console.error('Failed to start user-service:', err);
  process.exit(1);
});
```

**代码行数对比**：
- 重构前：~60 行样板代码 + 业务逻辑
- 重构后：~20 行配置 + 业务逻辑
- **减少 67% 样板代码**

### 4.3 环境变量统一管理

#### 4.3.1 配置文件
```javascript
// backend/shared/config.js
const config = {
  // 服务发现
  serviceRegistry: {
    'user-service': { port: 8081, host: 'localhost' },
    'location-service': { port: 8082, host: 'localhost' },
    'pokemon-service': { port: 8083, host: 'localhost' },
    'catch-service': { port: 8084, host: 'localhost' },
    'gym-service': { port: 8085, host: 'localhost' },
    'social-service': { port: 8086, host: 'localhost' },
    'reward-service': { port: 8087, host: 'localhost' },
    'payment-service': { port: 8088, host: 'localhost' }
  },
  
  // 中间件默认配置
  middleware: {
    cors: {
      origins: process.env.ALLOWED_ORIGINS?.split(',') || ['*'],
      credentials: true
    },
    rateLimit: {
      windowMs: 60_000,
      max: 100
    },
    helmet: {
      contentSecurityPolicy: false // 根据需要调整
    }
  },
  
  // 日志配置
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'json'
  }
};

module.exports = config;
```

### 4.4 服务启动测试

#### 4.4.1 单元测试
```javascript
// backend/tests/unit/ServiceLauncher.test.js
const { ServiceLauncher } = require('../../shared/ServiceLauncher');

describe('ServiceLauncher', () => {
  test('should create app with default middleware', () => {
    const launcher = new ServiceLauncher({ serviceName: 'test-service' });
    const app = launcher.createApp();
    
    expect(app).toBeDefined();
    // 验证中间件已挂载
  });

  test('should apply custom middleware', () => {
    const customMiddleware = jest.fn();
    const launcher = new ServiceLauncher({
      serviceName: 'test-service',
      middleware: [customMiddleware]
    });
    
    launcher.createApp();
    // 验证自定义中间件被调用
  });

  test('should mount routes correctly', () => {
    const router = express.Router();
    router.get('/test', (req, res) => res.json({ ok: true }));
    
    const launcher = new ServiceLauncher({
      serviceName: 'test-service',
      routes: [{ path: '/api', router }]
    });
    
    const app = launcher.createApp();
    // 验证路由已挂载
  });
});
```

### 4.5 重构执行计划

#### 4.5.1 分阶段重构
```
阶段 1：创建框架（1 天）
- 实现 ServiceLauncher 类
- 编写单元测试
- 文档和示例

阶段 2：重构服务（2 天）
- user-service（试点）
- location-service
- pokemon-service
- catch-service
- gym-service
- social-service
- reward-service
- payment-service

阶段 3：验证和清理（1 天）
- 集成测试
- 性能回归测试
- 删除旧代码
- 更新文档
```

## 5. 验收标准（可测试）

- [ ] `backend/shared/ServiceLauncher.js` 已创建并包含完整功能
- [ ] 所有 8 个微服务已重构使用 ServiceLauncher
- [ ] 每个服务主文件行数减少 ≥ 50%
- [ ] 所有服务启动成功，健康检查端点正常
- [ ] 中间件配置统一，无遗漏（helmet、cors、rateLimit、logger、metrics、i18n）
- [ ] 单元测试覆盖率 ≥ 90%（ServiceLauncher）
- [ ] 集成测试验证所有服务功能正常
- [ ] 环境变量配置集中在 `backend/shared/config.js`
- [ ] 服务注册表配置正确，端口无冲突
- [ ] 文档已更新，包含新服务创建指南
- [ ] 性能无回归：启动时间 ≤ 重构前

## 6. 工作量估算

**L (Large)**

- 框架设计和实现：1 天
- 单元测试编写：0.5 天
- 8 个服务重构：2 天
- 集成测试和验证：0.5 天
- 文档更新：0.5 天

**总计：4-5 天**

## 7. 优先级理由

**P2** 理由：

1. **技术债积累**：8 个服务重复代码已达 3000+ 行，维护成本持续上升
2. **影响开发效率**：每次新增中间件或修改配置需要修改 8 个文件
3. **降低出错风险**：统一配置避免遗漏和不一致
4. **提升代码质量**：消除重复是代码质量的基本要求
5. **为未来铺路**：新增服务将更加简单，降低新人上手成本

虽然不影响核心功能，但这是提升代码可维护性的重要重构，应尽快实施。
