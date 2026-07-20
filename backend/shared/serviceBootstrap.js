/**
 * 服务启动引导模块 - 统一的服务初始化入口
 * 
 * 功能：
 * - 统一初始化所有共享依赖
 * - 自动健康检查
 * - 优雅关闭钩子
 * - 错误处理
 * 
 * @module serviceBootstrap
 */

const { getContainer, resetContainer } = require('./dependencyContainer');
const { getConfigManager } = require('./configManager');

/**
 * 创建日志器工厂
 */
function createLoggerFactory(config) {
  const pino = require('pino');
  
  return () => pino({
    level: config.get('log_level', 'info'),
    prettyPrint: process.env.NODE_ENV !== 'production',
    base: {
      service: config.get('service_name', 'unknown')
    }
  });
}

/**
 * 创建数据库工厂
 */
function createDatabaseFactory(config) {
  const { Pool } = require('pg');
  
  return () => {
    const dbConfig = config.getDatabaseConfig();
    return new Pool(dbConfig);
  };
}

/**
 * 创建 Redis 工厂
 */
function createRedisFactory(config) {
  const Redis = require('ioredis');
  
  return () => {
    const redisConfig = config.getRedisConfig();
    return new Redis(redisConfig);
  };
}

/**
 * 创建 Kafka 工厂
 */
function createKafkaFactory(config) {
  const { Kafka } = require('kafkajs');
  
  return () => {
    const kafkaConfig = config.getKafkaConfig();
    return new Kafka(kafkaConfig);
  };
}

/**
 * 创建缓存服务工厂
 */
function createCacheFactory(config) {
  const Redis = require('ioredis');
  
  return () => {
    const redisConfig = config.getRedisConfig();
    const client = new Redis({ ...redisConfig, db: redisConfig.db + 1 });
    
    return {
      async get(key) {
        const data = await client.get(key);
        return data ? JSON.parse(data) : null;
      },
      async set(key, value, ttl = 3600) {
        await client.setex(key, ttl, JSON.stringify(value));
      },
      async del(key) {
        await client.del(key);
      },
      async healthCheck() {
        await client.ping();
        return { status: 'healthy' };
      },
      async shutdown() {
        await client.quit();
      }
    };
  };
}

/**
 * 创建 Prometheus 指标注册表工厂
 */
function createMetricsFactory() {
  const { Registry } = require('prom-client');
  
  return () => {
    const registry = new Registry();
    return registry;
  };
}

/**
 * 引导服务启动
 * @param {string} serviceName - 服务名称
 * @param {Object} options - 启动选项
 * @returns {Promise<Object>} 依赖容器
 */
async function bootstrapService(serviceName, options = {}) {
  const {
    config = {},
    customDependencies = {},
    healthCheckEndpoint = true,
    shutdownTimeout = 30000
  } = options;

  console.log(`[Bootstrap] Starting ${serviceName}...`);

  // 1. 获取容器
  const container = getContainer();

  // 2. 初始化配置管理器
  const configManager = getConfigManager();
  await configManager.load({
    service_name: serviceName,
    ...config
  });

  // 3. 注册核心依赖
  container.register('config', () => configManager, {
    singleton: true
  });

  container.register('logger', createLoggerFactory(configManager), {
    singleton: true,
    healthCheck: async () => ({ status: 'healthy', type: 'logger' }),
    shutdown: () => {
      const logger = container.resolve('logger');
      if (logger && typeof logger.flush === 'function') {
        return logger.flush();
      }
    }
  });

  // 数据库（如果启用）
  if (options.enableDatabase !== false) {
    container.register('db', createDatabaseFactory(configManager), {
      singleton: true,
      healthCheck: async () => {
        const db = container.resolve('db');
        const result = await db.query('SELECT NOW()');
        return {
          status: 'healthy',
          type: 'postgresql',
          time: result.rows[0].now
        };
      },
      shutdown: async () => {
        const db = container.resolve('db');
        await db.end();
      }
    });
  }

  // Redis（如果启用）
  if (options.enableRedis !== false) {
    container.register('redis', createRedisFactory(configManager), {
      singleton: true,
      healthCheck: async () => {
        const redis = container.resolve('redis');
        const pong = await redis.ping();
        return {
          status: pong === 'PONG' ? 'healthy' : 'unhealthy',
          type: 'redis'
        };
      },
      shutdown: async () => {
        const redis = container.resolve('redis');
        await redis.quit();
      }
    });
  }

  // Kafka（如果启用）
  if (options.enableKafka === true) {
    container.register('kafka', createKafkaFactory(configManager), {
      singleton: true
    });
  }

  // 缓存服务（如果启用）
  if (options.enableCache !== false) {
    container.register('cache', createCacheFactory(configManager), {
      singleton: true,
      healthCheck: async () => {
        const cache = container.resolve('cache');
        return await cache.healthCheck();
      },
      shutdown: async () => {
        const cache = container.resolve('cache');
        await cache.shutdown();
      }
    });
  }

  // Prometheus 指标（如果启用）
  if (options.enableMetrics !== false) {
    container.register('metrics', createMetricsFactory(), {
      singleton: true
    });
  }

  // 4. 注册自定义依赖
  for (const [name, factory] of Object.entries(customDependencies)) {
    if (!container.has(name)) {
      container.register(name, factory, { singleton: true });
    }
  }

  // 5. 初始化所有依赖
  console.log(`[Bootstrap] Initializing dependencies...`);
  const initResults = await container.initialize();

  if (initResults.failed.length > 0) {
    console.error(`[Bootstrap] Failed to initialize:`, initResults.failed);
    throw new Error(`Failed to initialize dependencies: ${initResults.failed.map(f => f.name).join(', ')}`);
  }

  console.log(`[Bootstrap] Dependencies initialized: ${initResults.success.length} success, ${initResults.skipped.length} skipped`);

  // 6. 执行健康检查
  console.log(`[Bootstrap] Running health checks...`);
  const healthResults = await container.healthCheck();

  console.log(`[Bootstrap] Health status: ${healthResults.status}`);
  if (healthResults.status !== 'healthy') {
    console.warn(`[Bootstrap] Health check warnings:`, healthResults.dependencies);
  }

  // 7. 注册关闭钩子
  const shutdownHandler = async (signal) => {
    console.log(`[Bootstrap] Received ${signal}, shutting down...`);
    
    const timeout = setTimeout(() => {
      console.error(`[Bootstrap] Shutdown timeout, forcing exit`);
      process.exit(1);
    }, shutdownTimeout);

    try {
      const shutdownResults = await container.shutdown();
      clearTimeout(timeout);
      
      console.log(`[Bootstrap] Shutdown complete:`, shutdownResults);
      process.exit(0);
    } catch (error) {
      console.error(`[Bootstrap] Shutdown error:`, error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
  process.on('SIGINT', () => shutdownHandler('SIGINT'));

  // 8. 返回容器
  console.log(`[Bootstrap] ${serviceName} started successfully`);
  
  return {
    container,
    config: configManager,
    logger: container.resolve('logger'),
    healthCheck: () => container.healthCheck()
  };
}

/**
 * 快速启动服务（简化版）
 */
async function quickStart(serviceName, config = {}) {
  return bootstrapService(serviceName, {
    config,
    enableKafka: false // 默认不启用 Kafka
  });
}

/**
 * 创建测试容器
 */
function createTestContainer(overrides = {}) {
  const { DependencyContainer } = require('./dependencyContainer');
  const container = new DependencyContainer();

  // 注册测试依赖
  container.register('config', () => {
    const { ConfigManager } = require('./configManager');
    const manager = new ConfigManager();
    manager._applyConfig({ ...overrides.config, service_name: 'test' }, 'test');
    return manager;
  }, { singleton: true });

  container.register('logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }), { singleton: true });

  // Mock 数据库
  if (overrides.db) {
    container.register('db', () => overrides.db, { singleton: true });
  }

  // Mock Redis
  if (overrides.redis) {
    container.register('redis', () => overrides.redis, { singleton: true });
  }

  return container;
}

module.exports = {
  bootstrapService,
  quickStart,
  createTestContainer
};
