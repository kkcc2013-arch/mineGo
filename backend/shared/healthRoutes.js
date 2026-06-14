// backend/shared/healthRoutes.js
'use strict';

const express = require('express');
const { createLogger } = require('./logger');

const logger = createLogger('health-routes');

/**
 * 健康检查路由工厂
 * 
 * 创建标准化的健康检查端点：
 * - GET /health/live - 存活探针（K8s liveness probe）
 * - GET /health/ready - 就绪探针（K8s readiness probe）
 * - GET /health - 详细健康状态
 */
function createHealthRoutes(options = {}) {
  const router = express.Router();
  
  const healthChecker = options.healthChecker;
  const serviceName = options.serviceName || 'unknown-service';
  const version = options.version || '1.0.0';
  
  // 存活探针 - 仅检查服务是否存活
  router.get('/health/live', async (req, res) => {
    try {
      const result = {
        status: 'healthy',
        service: serviceName,
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
      };
      
      res.status(200).json(result);
    } catch (error) {
      logger.error('Liveness check failed', { error: error.message });
      res.status(500).json({
        status: 'unhealthy',
        error: error.message
      });
    }
  });
  
  // 就绪探针 - 检查服务是否准备好接收流量
  router.get('/health/ready', async (req, res) => {
    try {
      if (!healthChecker) {
        // 如果没有健康检查器，返回基本状态
        return res.status(200).json({
          status: 'ready',
          service: serviceName,
          timestamp: new Date().toISOString()
        });
      }
      
      const result = await healthChecker.readinessCheck();
      
      if (result.status === 'ready') {
        res.status(200).json(result);
      } else {
        res.status(503).json(result);
      }
    } catch (error) {
      logger.error('Readiness check failed', { error: error.message });
      res.status(503).json({
        status: 'not_ready',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });
  
  // 详细健康状态 - 返回所有检查项
  router.get('/health', async (req, res) => {
    try {
      const baseResult = {
        service: serviceName,
        version,
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
      };
      
      if (!healthChecker) {
        return res.status(200).json({
          ...baseResult,
          status: 'healthy',
          checks: {}
        });
      }
      
      const result = await healthChecker.runAllChecks();
      
      res.status(result.status === 'unhealthy' ? 503 : 200).json({
        ...baseResult,
        ...result
      });
    } catch (error) {
      logger.error('Health check failed', { error: error.message });
      res.status(503).json({
        service: serviceName,
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });
  
  // 健康检查统计信息
  router.get('/health/stats', (req, res) => {
    try {
      if (!healthChecker) {
        return res.status(200).json({
          service: serviceName,
          message: 'Health checker not configured'
        });
      }
      
      const stats = healthChecker.getStats();
      const lastResults = healthChecker.getLastResults();
      
      res.status(200).json({
        service: serviceName,
        ...stats,
        lastResults
      });
    } catch (error) {
      logger.error('Health stats check failed', { error: error.message });
      res.status(500).json({
        error: error.message
      });
    }
  });
  
  return router;
}

/**
 * 初始化健康检查
 * 
 * @param {Object} app - Express 应用实例
 * @param {Object} healthChecker - 健康检查器实例
 * @param {Object} db - 数据库连接池
 * @param {Object} redis - Redis 客户端
 * @param {Object} kafka - Kafka 生产者（可选）
 */
function initializeHealthChecks(app, options = {}) {
  const {
    serviceName,
    healthChecker,
    db,
    redis,
    kafka,
    customChecks = []
  } = options;
  
  if (!healthChecker) {
    logger.warn('Health checker not provided, using basic health checks');
    return;
  }
  
  // 注册数据库健康检查
  if (db) {
    healthChecker.register('database', async () => {
      const start = Date.now();
      const result = await db.query('SELECT 1');
      const latency = Date.now() - start;
      
      return {
        status: 'healthy',
        latency_ms: latency,
        message: 'Database connection OK'
      };
    }, { critical: true, description: 'PostgreSQL 数据库连接' });
  }
  
  // 注册 Redis 健康检查
  if (redis) {
    healthChecker.register('redis', async () => {
      const start = Date.now();
      await redis.ping();
      const latency = Date.now() - start;
      
      return {
        status: 'healthy',
        latency_ms: latency,
        message: 'Redis connection OK'
      };
    }, { critical: true, description: 'Redis 缓存连接' });
  }
  
  // 注册 Kafka 健康检查
  if (kafka) {
    healthChecker.register('kafka', async () => {
      const start = Date.now();
      // 检查 Kafka 生产者是否连接
      if (kafka.isConnected && kafka.isConnected()) {
        const latency = Date.now() - start;
        return {
          status: 'healthy',
          latency_ms: latency,
          message: 'Kafka connection OK'
        };
      }
      throw new Error('Kafka producer not connected');
    }, { critical: false, description: 'Kafka 消息队列连接' });
  }
  
  // 注册资源健康检查
  healthChecker.register('resources', async () => {
    return await healthChecker.checkResources();
  }, { critical: false, description: '系统资源状态' });
  
  // 注册自定义检查
  for (const check of customChecks) {
    healthChecker.register(check.name, check.checkFn, check.options);
  }
  
  // 启动定期健康检查
  healthChecker.startPeriodicCheck();
  
  logger.info('Health checks initialized', {
    serviceName,
    checks: healthChecker.getStats().totalChecks
  });
}

/**
 * 为 ServiceLauncher 集成健康检查
 */
function setupHealthChecksForService(serviceLauncher, options = {}) {
  const HealthChecker = require('./HealthChecker');
  
  const healthChecker = new HealthChecker({
    serviceName: serviceLauncher.serviceName,
    ...options.healthCheckerConfig
  });
  
  // 初始化健康检查
  initializeHealthChecks(null, {
    serviceName: serviceLauncher.serviceName,
    healthChecker,
    db: options.db,
    redis: options.redis,
    kafka: options.kafka,
    customChecks: options.customChecks
  });
  
  // 挂载健康检查路由
  const healthRoutes = createHealthRoutes({
    serviceName: serviceLauncher.serviceName,
    version: serviceLauncher.version,
    healthChecker
  });
  
  serviceLauncher.app.use(healthRoutes);
  
  return healthChecker;
}

module.exports = {
  createHealthRoutes,
  initializeHealthChecks,
  setupHealthChecksForService
};
