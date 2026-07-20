/**
 * Gateway 服务启动示例 - 使用统一的引导模块
 * 
 * 对比旧方式和新方式的差异
 */

// ===== 旧方式（已废弃）=====
/*
const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');
const pino = require('pino');

// 每个服务都要重复这些初始化代码
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const db = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'minego',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || ''
});
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
});

const app = express();

// 健康检查
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT NOW()');
    await redis.ping();
    res.json({ status: 'healthy' });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

// 关闭钩子
process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  await db.end();
  await redis.quit();
  process.exit(0);
});

app.listen(3000, () => {
  logger.info('Gateway started on port 3000');
});
*/

// ===== 新方式（推荐）=====

const { bootstrapService } = require('../shared/serviceBootstrap');
const express = require('express');

async function startGateway() {
  // 1. 引导服务启动，自动初始化所有依赖
  const { container, config, logger } = await bootstrapService('gateway', {
    config: {
      gateway_port: 3000,
      log_level: 'info'
    },
    enableDatabase: true,
    enableRedis: true,
    enableKafka: false,
    enableCache: true,
    enableMetrics: true,
    customDependencies: {
      // 注册服务特有依赖
      'authMiddleware': (c) => {
        const jwt = require('jsonwebtoken');
        return {
          verify: (token) => jwt.verify(token, config.get('jwt_secret'))
        };
      }
    }
  });

  // 2. 解析依赖
  const db = container.resolve('db');
  const redis = container.resolve('redis');
  const cache = container.resolve('cache');

  // 3. 创建 Express 应用
  const app = express();
  app.use(express.json());

  // 4. 健康检查端点
  app.get('/health', async (req, res) => {
    const health = await container.healthCheck();
    res.json(health);
  });

  // 5. 业务路由
  app.get('/api/status', async (req, res) => {
    logger.info({ requestId: req.id }, 'Status check');
    res.json({
      service: 'gateway',
      status: 'running',
      timestamp: new Date().toISOString()
    });
  });

  // 6. 启动服务器
  const port = config.get('gateway_port', 3000);
  app.listen(port, () => {
    logger.info(`Gateway started on port ${port}`);
  });

  // 关闭钩子已由 bootstrapService 自动注册
}

// 启动服务
startGateway().catch(error => {
  console.error('Failed to start gateway:', error);
  process.exit(1);
});
