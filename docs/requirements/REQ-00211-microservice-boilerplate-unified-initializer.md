# REQ-00211: 微服务样板代码统一初始化器

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00211 |
| 标题 | 微服务样板代码统一初始化器 |
| 类别 | 技术债/重构 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | 所有微服务（gateway, user, location, pokemon, catch, gym, social, reward, payment）、backend/shared |
| 创建时间 | 2026-06-14 21:00 |

## 需求描述

当前 9 个微服务的启动代码存在大量重复样板代码：

```javascript
// 每个服务都重复以下模式
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));
app.get('/health', ...);
// ...更多重复代码
```

**问题**：
1. 代码重复率高（每个服务约 30-50 行重复代码）
2. 配置分散，难以统一修改（如添加新中间件需要改 9 个文件）
3. 安全策略不一致风险
4. 新增微服务成本高

**目标**：创建统一的 `ServiceFactory` 模块，封装服务启动样板代码，提供声明式配置接口。

## 技术方案

### 1. ServiceFactory 核心模块

```javascript
// backend/shared/ServiceFactory.js
'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createLogger, requestLogger } = require('./logger');
const metrics = require('./metrics');
const { errorHandler } = require('./auth');
const { getPool } = require('./db');
const { getRedis } = require('./redis');

const DEFAULT_OPTIONS = {
  cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
  helmet: {},
  trustProxy: false,
  jsonLimit: '10mb',
  metricsEnabled: true,
  healthCheck: true,
  gracefulShutdown: true
};

class ServiceFactory {
  /**
   * @param {Object} config 服务配置
   * @param {string} config.name 服务名称
   * @param {number} config.port 服务端口
   * @param {Object} [config.options] 可选配置
   * @param {Function} [config.preInit] 预初始化钩子
   * @param {Function} [config.postInit] 后初始化钩子
   * @param {Function} [config.onShutdown] 关闭钩子
   */
  static async createService(config) {
    const { name, port, options = {}, preInit, postInit, onShutdown } = config;
    const opts = { ...DEFAULT_OPTIONS, ...options };

    const logger = createLogger(name);
    const app = express();

    // 1. 基础中间件
    app.set('trust proxy', opts.trustProxy);
    app.use(helmet(opts.helmet));
    app.use(cors(opts.cors));
    app.use(express.json({ limit: opts.jsonLimit }));

    // 2. 日志与监控
    app.use(requestLogger(logger));
    if (opts.metricsEnabled) {
      app.use(metrics.httpMetricsMiddleware(name));
    }

    // 3. 预初始化钩子（注册自定义中间件）
    if (preInit) {
      await preInit(app, logger);
    }

    // 4. 标准健康检查端点
    if (opts.healthCheck) {
      app.get('/health', async (req, res) => {
        const health = { 
          status: 'ok', 
          service: name,
          timestamp: new Date().toISOString(),
          uptime: process.uptime()
        };

        // 可选依赖检查
        try {
          if (opts.checkDb) {
            const pool = getPool();
            await pool.query('SELECT 1');
            health.database = 'connected';
          }
        } catch (e) {
          health.database = 'disconnected';
          health.status = 'degraded';
        }

        try {
          if (opts.checkRedis) {
            const redis = getRedis();
            await redis.ping();
            health.redis = 'connected';
          }
        } catch (e) {
          health.redis = 'disconnected';
          health.status = 'degraded';
        }

        res.status(health.status === 'ok' ? 200 : 503).json(health);
      });

      // Prometheus 指标端点
      app.get('/metrics', async (req, res) => {
        res.set('Content-Type', 'text/plain');
        res.send(await metrics.getMetrics(name));
      });
    }

    // 5. 后初始化钩子（注册路由）
    if (postInit) {
      await postInit(app, logger);
    }

    // 6. 统一错误处理
    app.use(errorHandler);

    // 7. 创建 HTTP 服务器
    const server = app.listen(port, () => {
      logger.info(`${name} listening on port ${port}`, { 
        port, 
        nodeEnv: process.env.NODE_ENV 
      });
    });

    // 8. 优雅关闭
    if (opts.gracefulShutdown) {
      const shutdown = async (signal) => {
        logger.info(`Received ${signal}, shutting down gracefully...`);
        
        if (onShutdown) {
          await onShutdown();
        }

        server.close(() => {
          logger.info('HTTP server closed');
          process.exit(0);
        });

        // 强制退出超时
        setTimeout(() => {
          logger.error('Forced shutdown after timeout');
          process.exit(1);
        }, 10000);
      };

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    }

    return { app, server, logger, express };
  }
}

module.exports = { ServiceFactory, DEFAULT_OPTIONS };
```

### 2. 服务启动重构示例

**重构前（pokemon-service/src/index.js）**：
```javascript
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { query, transaction } = require('../../../shared/db');
const { requireAuth, AppError, successResp, errorHandler } = require('../../../shared/auth');
const { createLogger, requestLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');

const logger = createLogger('pokemon-service');
const SERVICE_NAME = 'pokemon-service';
const app = express();
const PORT = process.env.PORT || 8083;

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(requestLogger(logger));
app.use(metrics.httpMetricsMiddleware(SERVICE_NAME));

// ...50+ 行样板代码

app.use(errorHandler);
app.listen(PORT, () => logger.info(`pokemon-service listening on port ${PORT}`));
```

**重构后**：
```javascript
// pokemon-service/src/index.js
'use strict';

const { ServiceFactory } = require('../../../shared/ServiceFactory');
const pokemonRoutes = require('./routes');
const evolutionRoutes = require('./routes/evolution');
const showcaseRoutes = require('./routes/showcase');
const inventoryRoutes = require('./routes/inventory');
const pokedexRoutes = require('./routes/pokedex');

async function main() {
  const { app, logger } = await ServiceFactory.createService({
    name: 'pokemon-service',
    port: process.env.PORT || 8083,
    options: {
      checkDb: true,
      checkRedis: true
    },
    postInit: async (app) => {
      // 注册路由
      app.use('/pokemon', pokemonRoutes);
      app.use('/pokemon', evolutionRoutes);
      app.use('/pokemon', showcaseRoutes);
      app.use('/pokemon', inventoryRoutes);
      app.use('/pokemon', pokedexRoutes);
      logger.info('Routes registered');
    },
    onShutdown: async () => {
      logger.info('Cleaning up resources...');
    }
  });
}

main().catch(err => {
  console.error('Failed to start pokemon-service:', err);
  process.exit(1);
});
```

### 3. 特殊服务配置（支持 WebSocket）

```javascript
// gym-service/src/index.js
'use strict';

const { ServiceFactory } = require('../../../shared/ServiceFactory');
const WebSocket = require('ws');
const battleRoutes = require('./routes/battle');

async function main() {
  const { app, server, logger } = await ServiceFactory.createService({
    name: 'gym-service',
    port: process.env.PORT || 8085,
    options: {
      createServer: true,  // 返回 http.Server 而非直接监听
      checkDb: true,
      checkRedis: true
    },
    postInit: async (app) => {
      app.use('/gym', battleRoutes);
      
      // WebSocket 服务器
      const wss = new WebSocket.Server({ server, path: '/gym/ws' });
      require('./ws/battleRoom')(wss, logger);
      
      logger.info('WebSocket server initialized');
    }
  });
}

main().catch(err => {
  console.error('Failed to start gym-service:', err);
  process.exit(1);
});
```

### 4. Gateway 特殊配置

```javascript
// gateway/src/index.js
'use strict';

const { ServiceFactory } = require('../../shared/ServiceFactory');
const proxy = require('express-http-proxy');
const rateLimiter = require('./middleware/rateLimiter');

async function main() {
  const { app, logger } = await ServiceFactory.createService({
    name: 'gateway',
    port: process.env.PORT || 8080,
    options: {
      helmet: {
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'", 'wss:']
          }
        }
      },
      trustProxy: true,
      jsonLimit: '1mb',
      checkRedis: true
    },
    preInit: async (app) => {
      // Gateway 特有中间件
      app.use(rateLimiter);
      app.use(require('./middleware/auth'));
    },
    postInit: async (app) => {
      // 服务代理路由
      app.use('/api/user', proxy('http://user-service:8081'));
      app.use('/api/location', proxy('http://location-service:8082'));
      app.use('/api/pokemon', proxy('http://pokemon-service:8083'));
      app.use('/api/catch', proxy('http://catch-service:8084'));
      app.use('/api/gym', proxy('http://gym-service:8085'));
      app.use('/api/social', proxy('http://social-service:8086'));
      app.use('/api/reward', proxy('http://reward-service:8087'));
      app.use('/api/payment', proxy('http://payment-service:8088'));
      
      logger.info('Gateway routes configured');
    }
  });
}

main().catch(err => {
  console.error('Failed to start gateway:', err);
  process.exit(1);
});
```

### 5. 渐进式迁移策略

**阶段 1**：创建 ServiceFactory 模块，保持现有服务不变
**阶段 2**：选择 1 个服务试点迁移（pokemon-service）
**阶段 3**：验证稳定性后迁移其余服务
**阶段 4**：删除各服务中的重复样板代码

### 6. 单元测试

```javascript
// backend/tests/unit/ServiceFactory.test.js
'use strict';

const { ServiceFactory } = require('../../shared/ServiceFactory');
const request = require('supertest');

describe('ServiceFactory', () => {
  test('should create service with default options', async () => {
    const { app, server } = await ServiceFactory.createService({
      name: 'test-service',
      port: 0  // 随机端口
    });

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('test-service');
    expect(res.body.status).toBe('ok');

    server.close();
  });

  test('should apply custom middleware', async () => {
    const { app, server } = await ServiceFactory.createService({
      name: 'test-service',
      port: 0,
      postInit: async (app) => {
        app.get('/test', (req, res) => res.json({ ok: true }));
      }
    });

    const res = await request(app).get('/test');
    expect(res.body.ok).toBe(true);

    server.close();
  });

  test('should handle graceful shutdown', async () => {
    const shutdownMock = jest.fn();
    const { server } = await ServiceFactory.createService({
      name: 'test-service',
      port: 0,
      onShutdown: shutdownMock
    });

    // 模拟 SIGTERM
    process.emit('SIGTERM');
    
    // 等待关闭
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(shutdownMock).toHaveBeenCalled();

    server.close();
  });

  test('should include dependency health checks', async () => {
    const { app, server } = await ServiceFactory.createService({
      name: 'test-service',
      port: 0,
      options: { checkDb: true, checkRedis: true }
    });

    const res = await request(app).get('/health');
    expect(res.body).toHaveProperty('database');
    expect(res.body).toHaveProperty('redis');

    server.close();
  });
});
```

## 验收标准

- [ ] 创建 `backend/shared/ServiceFactory.js` 模块
- [ ] ServiceFactory 支持声明式服务配置（name, port, options, hooks）
- [ ] 自动挂载标准中间件（helmet, cors, json, logger, metrics）
- [ ] 内置 `/health` 和 `/metrics` 端点
- [ ] 支持优雅关闭（SIGTERM/SIGINT 处理）
- [ ] 支持依赖健康检查（database, redis）
- [ ] pokemon-service 成功迁移到 ServiceFactory
- [ ] 启动代码行数减少 50% 以上
- [ ] 单元测试覆盖率 > 90%
- [ ] 文档说明迁移步骤和配置选项

## 影响范围

- `backend/shared/ServiceFactory.js` - 新增
- `backend/services/pokemon-service/src/index.js` - 重构
- `backend/services/*/src/index.js` - 后续迁移
- `backend/tests/unit/ServiceFactory.test.js` - 新增测试

## 优先级理由

P1 - 技术债影响所有微服务的可维护性和一致性。统一初始化器后：
1. 减少 ~300 行重复代码（9 服务 × 40 行）
2. 降低新增微服务成本
3. 确保安全策略一致性
4. 简化未来全局中间件升级

## 参考

- REQ-00012: 微服务启动样板代码重构与统一（已完成的初步重构）
- REQ-00169: 微服务启动器统一化与服务样板代码消除（待实现）
- Express.js 最佳实践
- Node.js 优雅关闭模式
