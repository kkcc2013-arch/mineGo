// shared/ServiceLauncher.js - 统一服务启动框架
'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createLogger, requestLogger } = require('./logger');
const metrics = require('./metrics');
const { i18nMiddleware } = require('./i18n');
const { errorHandler } = require('./auth');

/**
 * ServiceLauncher - 微服务统一启动框架
 * 
 * 消除各服务重复的样板代码，统一中间件配置，简化服务开发
 */
class ServiceLauncher {
  /**
   * @param {Object} options - 服务配置
   * @param {string} options.serviceName - 服务名称（如 'user-service'）
   * @param {number} [options.port] - 服务端口（默认从环境变量或服务注册表获取）
   * @param {string} [options.version] - 服务版本（默认 '1.0.0'）
   * @param {Array} [options.routes] - 路由配置数组
   * @param {Array} [options.middleware] - 自定义中间件数组
   * @param {Function} [options.healthCheck] - 自定义健康检查函数
   * @param {Function} [options.onReady] - 服务启动后的回调函数
   * @param {Object} [options.helmetConfig] - Helmet 自定义配置
   * @param {Object} [options.corsConfig] - CORS 自定义配置
   */
  constructor(options) {
    this.serviceName = options.serviceName;
    this.version = options.version || '1.0.0';
    this.port = options.port || process.env.PORT || this.getDefaultPort(options.serviceName);
    this.routes = options.routes || [];
    this.customMiddleware = options.middleware || [];
    this.healthCheck = options.healthCheck || this.defaultHealthCheck.bind(this);
    this.onReady = options.onReady || (() => {});
    this.helmetConfig = options.helmetConfig || this.getDefaultHelmetConfig();
    this.corsConfig = options.corsConfig || this.getDefaultCorsConfig();
    
    this.logger = createLogger(this.serviceName);
    this.app = null;
    this.server = null;
  }

  /**
   * 获取服务默认端口
   */
  getDefaultPort(serviceName) {
    const ports = {
      'user-service': 8081,
      'location-service': 8082,
      'pokemon-service': 8083,
      'catch-service': 8084,
      'gym-service': 8085,
      'social-service': 8086,
      'reward-service': 8087,
      'payment-service': 8088,
      'gateway': 8080
    };
    return ports[serviceName] || 8080;
  }

  /**
   * 获取默认 Helmet 配置
   */
  getDefaultHelmetConfig() {
    return {
      contentSecurityPolicy: false // 允许 API 服务灵活配置
    };
  }

  /**
   * 获取默认 CORS 配置
   */
  getDefaultCorsConfig() {
    return {
      origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
      credentials: true
    };
  }

  /**
   * 默认健康检查端点
   */
  defaultHealthCheck(req, res) {
    res.json({
      status: 'ok',
      service: this.serviceName,
      version: this.version,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * 创建 Express 应用
   */
  createApp() {
    const app = express();

    // ── 安全中间件 ─────────────────────────────────────────────
    app.use(helmet(this.helmetConfig));
    app.use(cors(this.corsConfig));
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true }));

    // ── 可观测性中间件 ─────────────────────────────────────────
    app.use(requestLogger(this.logger));
    app.use(metrics.httpMetricsMiddleware(this.serviceName));
    app.use(i18nMiddleware);

    // ── 自定义中间件 ───────────────────────────────────────────
    this.customMiddleware.forEach(mw => {
      app.use(mw);
    });

    // ── 标准端点 ───────────────────────────────────────────────
    app.get('/health', this.healthCheck);
    app.get('/metrics', this.metricsEndpoint.bind(this));

    // ── 业务路由 ───────────────────────────────────────────────
    this.routes.forEach(route => {
      if (route.rateLimit) {
        const limiter = rateLimit({
          windowMs: route.rateLimit.windowMs || 60_000,
          max: route.rateLimit.max || 100,
          message: route.rateLimit.message || { code: 1007, message: '请求太频繁' }
        });
        app.use(route.path, limiter, route.router);
      } else {
        app.use(route.path, route.router);
      }
    });

    // ── 错误处理 ───────────────────────────────────────────────
    app.use(errorHandler);

    // ── 404 处理 ───────────────────────────────────────────────
    app.use((req, res) => {
      res.status(404).json({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Endpoint not found'
        }
      });
    });

    return app;
  }

  /**
   * Prometheus 指标端点
   */
  async metricsEndpoint(req, res) {
    try {
      res.set('Content-Type', metrics.register.contentType);
      res.send(await metrics.register.metrics());
    } catch (err) {
      this.logger.error({ err }, 'Failed to generate metrics');
      res.status(500).json({ error: 'Metrics generation failed' });
    }
  }

  /**
   * 启动服务
   */
  async start() {
    this.app = this.createApp();

    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, async () => {
        this.logger.info({
          port: this.port,
          version: this.version,
          pid: process.pid
        }, `${this.serviceName} started`);

        try {
          await this.onReady(this.app);
          resolve(this.app);
        } catch (err) {
          this.logger.error({ err }, 'onReady callback failed');
          reject(err);
        }
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          this.logger.error({ port: this.port }, `Port ${this.port} is already in use`);
        }
        reject(err);
      });

      // 优雅关闭
      process.on('SIGTERM', () => this.shutdown());
      process.on('SIGINT', () => this.shutdown());
    });
  }

  /**
   * 优雅关闭
   */
  async shutdown() {
    this.logger.info({ service: this.serviceName }, 'Shutting down gracefully...');
    
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          this.logger.info({ service: this.serviceName }, 'Server closed');
          resolve();
        });
        
        // 强制关闭超时
        setTimeout(() => {
          this.logger.warn({ service: this.serviceName }, 'Forced shutdown after timeout');
          process.exit(1);
        }, 10000);
      });
    }
  }

  /**
   * 获取 Express app 实例（用于测试）
   */
  getApp() {
    if (!this.app) {
      this.app = this.createApp();
    }
    return this.app;
  }
}

/**
 * 快速启动辅助函数
 */
function createService(options) {
  const launcher = new ServiceLauncher(options);
  
  launcher.start().catch(err => {
    console.error(`Failed to start ${options.serviceName}:`, err);
    process.exit(1);
  });

  return launcher;
}

/**
 * 服务配置注册表
 */
const SERVICE_REGISTRY = {
  'user-service': { port: 8081, description: 'User authentication and profile management' },
  'location-service': { port: 8082, description: 'GPS location and nearby Pokemon queries' },
  'pokemon-service': { port: 8083, description: 'Pokemon data and inventory management' },
  'catch-service': { port: 8084, description: 'Pokemon catching mechanics' },
  'gym-service': { port: 8085, description: 'Gym battles and team management' },
  'social-service': { port: 8086, description: 'Friends, trading, and social features' },
  'reward-service': { port: 8087, description: 'Daily rewards and achievements' },
  'payment-service': { port: 8088, description: 'In-app purchases and payment processing' },
  'gateway': { port: 8080, description: 'API Gateway and request routing' }
};

/**
 * 获取服务配置
 */
function getServiceConfig(serviceName) {
  return SERVICE_REGISTRY[serviceName] || null;
}

/**
 * 获取所有服务列表
 */
function getAllServices() {
  return Object.entries(SERVICE_REGISTRY).map(([name, config]) => ({
    name,
    ...config
  }));
}

module.exports = {
  ServiceLauncher,
  createService,
  SERVICE_REGISTRY,
  getServiceConfig,
  getAllServices
};
