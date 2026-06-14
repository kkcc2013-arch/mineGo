'use strict';
/**
 * 微服务样板代码统一初始化器
 * REQ-00211: 微服务样板代码统一初始化器
 * 
 * 封装服务启动样板代码，提供声明式配置接口
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createLogger, requestLogger } = require('./logger');
const metrics = require('./metrics');
const { errorHandler } = require('./errorHandler');
const { getPool } = require('./db');
const { getRedis } = require('./redis');
const http = require('http');

/**
 * 默认配置选项
 */
const DEFAULT_OPTIONS = {
  cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
  helmet: {},
  trustProxy: false,
  jsonLimit: '10mb',
  metricsEnabled: true,
  healthCheck: true,
  gracefulShutdown: true,
  shutdownTimeoutMs: 10000,
  checkDb: false,
  checkRedis: false,
  createServer: false // 是否返回 server（用于 WebSocket）
};

/**
 * 服务工厂类
 * 封装微服务启动样板代码
 */
class ServiceFactory {
  /**
   * 创建微服务
   * @param {Object} config - 服务配置
   * @param {string} config.name - 服务名称
   * @param {number} config.port - 服务端口
   * @param {Object} [config.options] - 可选配置
   * @param {Function} [config.preInit] - 预初始化钩子 (app, logger) => Promise
   * @param {Function} [config.postInit] - 后初始化钩子 (app, logger) => Promise
   * @param {Function} [config.onShutdown] - 关闭钩子 () => Promise
   * @returns {Promise<{app: Express, server: Server, logger: Logger, express: Function}>}
   */
  static async createService(config) {
    const { name, port, options = {}, preInit, postInit, onShutdown } = config;
    const opts = { ...DEFAULT_OPTIONS, ...options };

    // 验证必要参数
    if (!name) {
      throw new Error('Service name is required');
    }
    if (port === undefined || port === null) {
      throw new Error('Service port is required');
    }

    const logger = createLogger(name);
    const app = express();

    logger.info(`Initializing ${name}...`, { port, options: opts });

    // ===== 1. 基础中间件 =====
    app.set('trust proxy', opts.trustProxy ? 1 : 0);
    app.use(helmet(opts.helmet));
    app.use(cors(opts.cors));
    app.use(express.json({ limit: opts.jsonLimit }));
    app.use(express.urlencoded({ extended: true }));

    // ===== 2. 请求 ID =====
    app.use((req, res, next) => {
      req.id = req.headers['x-request-id'] || 
                `${name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      res.setHeader('X-Request-Id', req.id);
      next();
    });

    // ===== 3. 日志与监控 =====
    app.use(requestLogger(logger));
    if (opts.metricsEnabled) {
      app.use(metrics.httpMetricsMiddleware(name));
    }

    // ===== 4. 预初始化钩子 =====
    if (preInit) {
      try {
        await preInit(app, logger);
      } catch (err) {
        logger.error('Pre-init hook failed', { error: err.message });
        throw err;
      }
    }

    // ===== 5. 标准健康检查端点 =====
    if (opts.healthCheck) {
      // 健康检查
      app.get('/health', async (req, res) => {
        const health = {
          status: 'ok',
          service: name,
          timestamp: new Date().toISOString(),
          uptime: Math.floor(process.uptime()),
          version: process.env.npm_package_version || '1.0.0',
          nodeEnv: process.env.NODE_ENV || 'development'
        };

        // 数据库健康检查
        if (opts.checkDb) {
          try {
            const pool = getPool();
            const result = await pool.query('SELECT 1 as ok');
            health.database = result.rows[0]?.ok === 1 ? 'connected' : 'error';
            health.dbPoolSize = pool.totalCount;
            health.dbPoolIdle = pool.idleCount;
            health.dbPoolWaiting = pool.waitingCount;
          } catch (e) {
            health.database = 'disconnected';
            health.dbError = e.message;
            health.status = 'degraded';
          }
        }

        // Redis 健康检查
        if (opts.checkRedis) {
          try {
            const redis = getRedis();
            const start = Date.now();
            await redis.ping();
            health.redis = 'connected';
            health.redisLatency = Date.now() - start;
          } catch (e) {
            health.redis = 'disconnected';
            health.redisError = e.message;
            health.status = 'degraded';
          }
        }

        // 内存使用
        const memUsage = process.memoryUsage();
        health.memory = {
          heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
          heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
          rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
          external: Math.round(memUsage.external / 1024 / 1024) + 'MB'
        };

        const statusCode = health.status === 'ok' ? 200 : 503;
        res.status(statusCode).json(health);
      });

      // 就绪检查（K8s readiness probe）
      app.get('/ready', async (req, res) => {
        const checks = [];

        // 数据库就绪检查
        if (opts.checkDb) {
          try {
            const pool = getPool();
            await pool.query('SELECT 1');
            checks.push({ name: 'database', ok: true });
          } catch (e) {
            checks.push({ name: 'database', ok: false, error: e.message });
          }
        }

        // Redis 就绪检查
        if (opts.checkRedis) {
          try {
            const redis = getRedis();
            await redis.ping();
            checks.push({ name: 'redis', ok: true });
          } catch (e) {
            checks.push({ name: 'redis', ok: false, error: e.message });
          }
        }

        const allOk = checks.every(c => c.ok);
        res.status(allOk ? 200 : 503).json({
          service: name,
          ready: allOk,
          checks
        });
      });

      // Prometheus 指标端点
      app.get('/metrics', async (req, res) => {
        try {
          res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
          res.send(await metrics.getMetrics(name));
        } catch (e) {
          logger.error('Failed to generate metrics', { error: e.message });
          res.status(500).send('# Error generating metrics\n');
        }
      });
    }

    // ===== 6. 后初始化钩子（注册路由） =====
    if (postInit) {
      try {
        await postInit(app, logger);
      } catch (err) {
        logger.error('Post-init hook failed', { error: err.message });
        throw err;
      }
    }

    // ===== 7. 统一错误处理 =====
    app.use(errorHandler);

    // ===== 8. 404 处理 =====
    app.use((req, res) => {
      res.status(404).json({
        code: 1001,
        message: `Route ${req.method} ${req.path} not found`,
        error: 'NOT_FOUND'
      });
    });

    // ===== 9. 创建 HTTP 服务器 =====
    const server = opts.createServer 
      ? http.createServer(app) 
      : app.listen(port);

    if (!opts.createServer) {
      server.on('listening', () => {
        logger.info(`${name} listening on port ${port}`, {
          port,
          nodeEnv: process.env.NODE_ENV,
          pid: process.pid
        });
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          logger.error(`Port ${port} is already in use`, { port, error: err.message });
          process.exit(1);
        } else {
          logger.error('Server error', { error: err.message });
          throw err;
        }
      });
    }

    // ===== 10. 优雅关闭 =====
    if (opts.gracefulShutdown) {
      let isShuttingDown = false;

      const shutdown = async (signal) => {
        if (isShuttingDown) {
          logger.warn(`Already shutting down, ignoring ${signal}`);
          return;
        }
        isShuttingDown = true;

        logger.info(`Received ${signal}, shutting down gracefully...`, {
          signal,
          activeConnections: server.connections ? server.connections : 'N/A'
        });

        // 执行自定义关闭逻辑
        if (onShutdown) {
          try {
            await onShutdown();
          } catch (err) {
            logger.error('Shutdown hook failed', { error: err.message });
          }
        }

        // 关闭 HTTP 服务器
        server.close(() => {
          logger.info('HTTP server closed, exiting...', { signal });
          process.exit(0);
        });

        // 强制退出超时
        setTimeout(() => {
          logger.error('Forced shutdown after timeout', { 
            timeoutMs: opts.shutdownTimeoutMs 
          });
          process.exit(1);
        }, opts.shutdownTimeoutMs);
      };

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));

      // 未捕获异常处理
      process.on('uncaughtException', (err) => {
        logger.error('Uncaught exception', { 
          error: err.message, 
          stack: err.stack 
        });
        shutdown('uncaughtException');
      });

      process.on('unhandledRejection', (reason, promise) => {
        logger.error('Unhandled rejection', { 
          reason: String(reason),
          promise: String(promise)
        });
      });
    }

    logger.info(`${name} initialized successfully`);

    return {
      app,
      server,
      logger,
      express
    };
  }
}

/**
 * 创建简单的服务实例（快捷方法）
 * @param {string} name - 服务名称
 * @param {number} port - 端口
 * @param {Function} routeSetup - 路由设置函数 (app, logger) => void
 */
async function createSimpleService(name, port, routeSetup) {
  return ServiceFactory.createService({
    name,
    port,
    postInit: routeSetup
  });
}

module.exports = {
  ServiceFactory,
  DEFAULT_OPTIONS,
  createSimpleService
};
