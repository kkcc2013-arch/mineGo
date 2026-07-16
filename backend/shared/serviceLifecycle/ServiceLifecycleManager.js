// backend/shared/serviceLifecycle/ServiceLifecycleManager.js
// 服务生命周期管理器 - 统一管理服务启动、运行、关闭
'use strict';

const ServiceLifecycleStateMachine = require('./ServiceLifecycleStateMachine');
const GracefulShutdownOrchestrator = require('./GracefulShutdownOrchestrator');
const DependencyStartupCoordinator = require('./DependencyStartupCoordinator');
const { ServiceLifecycleState } = require('./ServiceLifecycleState');
const logger = require('../logger');
const { getRedis } = require('../redis');
const metrics = require('../metrics');

/**
 * 服务生命周期管理器
 * 提供统一的服务生命周期管理接口
 */
class ServiceLifecycleManager {
  constructor(serviceName, config = {}) {
    this.serviceName = serviceName;
    this.config = {
      statePersistenceEnabled: true,
      dependencyCheckTimeout: 30000,
      shutdownTimeout: 30000,
      drainTimeout: 10000,
      statePersistenceKey: `service:lifecycle:${serviceName}`,
      ...config
    };
    
    // 状态机
    this.stateMachine = new ServiceLifecycleStateMachine(serviceName);
    
    // 关闭编排器
    this.shutdownOrchestrator = new GracefulShutdownOrchestrator(this);
    
    // 依赖协调器
    this.dependencyCoordinator = new DependencyStartupCoordinator(this);
    
    // 注册组件容器
    this.components = {
      database: null,
      redis: null,
      kafka: null,
      server: null,
      pluginManager: null,
      healthChecker: null
    };
    
    // 定时器引用（用于清理）
    this.timers = [];
    
    // 指标
    this.metrics = {
      startTime: null,
      readyTime: null,
      shutdownTime: null,
      requestCount: 0,
      errorCount: 0,
      lastRequestTime: null
    };
    
    // 设置事件处理
    this.setupEventHandlers();
  }

  /**
   * 设置事件处理器
   */
  setupEventHandlers() {
    // 状态变更事件
    this.stateMachine.on('state:changed', async ({ from, to, timestamp, metadata }) => {
      logger.info('Service lifecycle state changed', {
        serviceName: this.serviceName,
        from,
        to,
        timestamp,
        duration: this.stateMachine.getStateDuration()
      });
      
      // 更新 Prometheus 指标
      metrics.gauge('service_lifecycle_state', {
        service: this.serviceName,
        state: to
      }, 1);
      
      // 持久化状态
      if (this.config.statePersistenceEnabled) {
        await this.persistState();
      }
    });

    // 转换错误事件
    this.stateMachine.on('transition:error', ({ from, to, error }) => {
      logger.error('State transition error', {
        serviceName: this.serviceName,
        from,
        to,
        error: error.message
      });
      
      metrics.increment('service_lifecycle_error', {
        service: this.serviceName,
        from,
        to
      });
    });
  }

  /**
   * 注册组件
   */
  registerComponent(name, instance) {
    if (!this.components.hasOwnProperty(name)) {
      logger.warn(`Unknown component: ${name}`, { serviceName: this.serviceName });
    }
    this.components[name] = instance;
    
    logger.debug(`Component registered: ${name}`, {
      serviceName: this.serviceName
    });
  }

  /**
   * 启动服务
   */
  async start(startupConfig = {}) {
    if (this.metrics.startTime) {
      throw new Error('Service already started');
    }
    
    this.metrics.startTime = Date.now();
    
    logger.info('Starting service', {
      serviceName: this.serviceName,
      config: startupConfig
    });
    
    try {
      // Step 1: 开始启动
      await this.stateMachine.transitionTo(ServiceLifecycleState.STARTING);
      
      // Step 2: 等待依赖服务就绪
      if (startupConfig.dependencies && startupConfig.dependencies.length > 0) {
        await this.stateMachine.transitionTo(ServiceLifecycleState.WAITING_DEPENDENCIES);
        await this.dependencyCoordinator.waitForDependencies(startupConfig.dependencies);
      }
      
      // Step 3: 初始化插件
      if (this.components.pluginManager) {
        await this.stateMachine.transitionTo(ServiceLifecycleState.INITIALIZING_PLUGINS);
        await this.initializePlugins();
      }
      
      // Step 4: 连接数据库
      if (this.components.database) {
        await this.stateMachine.transitionTo(ServiceLifecycleState.CONNECTING_DB);
        await this.connectDatabase();
      }
      
      // Step 5: 连接 Redis
      if (this.components.redis !== false) {
        await this.stateMachine.transitionTo(ServiceLifecycleState.CONNECTING_REDIS);
        await this.connectRedis();
      }
      
      // Step 6: 连接 Kafka
      if (this.components.kafka) {
        await this.stateMachine.transitionTo(ServiceLifecycleState.CONNECTING_KAFKA);
        await this.connectKafka();
      }
      
      // Step 7: 启动 HTTP 服务器
      if (this.components.server) {
        await this.stateMachine.transitionTo(ServiceLifecycleState.STARTING_SERVER);
        await this.startServer();
      }
      
      // Step 8: 标记为健康
      await this.stateMachine.transitionTo(ServiceLifecycleState.HEALTHY);
      this.metrics.readyTime = Date.now();
      
      // 启动完成后的插件启动
      if (this.components.pluginManager) {
        await this.startPlugins();
      }
      
      const startupDuration = this.metrics.readyTime - this.metrics.startTime;
      
      logger.info('Service started successfully', {
        serviceName: this.serviceName,
        startupDuration,
        stateHistory: this.stateMachine.getStateHistory(5).map(h => `${h.from}→${h.to}`)
      });
      
      // 设置进程信号处理
      this.setupSignalHandlers();
      
      return {
        success: true,
        startupDuration,
        state: this.stateMachine.getCurrentState()
      };
      
    } catch (error) {
      await this.stateMachine.transitionToError(error);
      
      logger.error('Service startup failed', {
        serviceName: this.serviceName,
        error: error.message,
        stack: error.stack
      });
      
      throw error;
    }
  }

  /**
   * 停止服务
   */
  async stop() {
    if (this.stateMachine.isShuttingDown() || 
        this.stateMachine.getCurrentState() === ServiceLifecycleState.STOPPED) {
      logger.warn('Service already stopping or stopped', {
        serviceName: this.serviceName,
        currentState: this.stateMachine.getCurrentState()
      });
      return;
    }
    
    this.metrics.shutdownTime = Date.now();
    
    logger.info('Stopping service', {
      serviceName: this.serviceName,
      currentState: this.stateMachine.getCurrentState()
    });
    
    try {
      await this.shutdownOrchestrator.execute();
    } catch (error) {
      logger.error('Service stop failed', {
        serviceName: this.serviceName,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * 初始化插件
   */
  async initializePlugins() {
    const pluginManager = this.components.pluginManager;
    if (!pluginManager) return;
    
    try {
      if (typeof pluginManager.initializeAll === 'function') {
        await pluginManager.initializeAll();
      }
      logger.info('Plugins initialized', { serviceName: this.serviceName });
    } catch (error) {
      throw new Error(`Plugin initialization failed: ${error.message}`);
    }
  }

  /**
   * 启动插件
   */
  async startPlugins() {
    const pluginManager = this.components.pluginManager;
    if (!pluginManager) return;
    
    try {
      if (typeof pluginManager.startAll === 'function') {
        await pluginManager.startAll();
      }
      logger.info('Plugins started', { serviceName: this.serviceName });
    } catch (error) {
      logger.warn('Some plugins failed to start', {
        serviceName: this.serviceName,
        error: error.message
      });
    }
  }

  /**
   * 连接数据库
   */
  async connectDatabase() {
    const pool = this.components.database;
    if (!pool) return;
    
    try {
      await pool.query('SELECT 1');
      logger.info('Database connected', { serviceName: this.serviceName });
    } catch (error) {
      throw new Error(`Database connection failed: ${error.message}`);
    }
  }

  /**
   * 连接 Redis
   */
  async connectRedis() {
    try {
      const redis = this.components.redis || getRedis();
      await redis.ping();
      logger.info('Redis connected', { serviceName: this.serviceName });
    } catch (error) {
      throw new Error(`Redis connection failed: ${error.message}`);
    }
  }

  /**
   * 连接 Kafka
   */
  async connectKafka() {
    const kafka = this.components.kafka;
    if (!kafka) return;
    
    try {
      const admin = kafka.admin();
      await admin.connect();
      await admin.disconnect();
      logger.info('Kafka connected', { serviceName: this.serviceName });
    } catch (error) {
      throw new Error(`Kafka connection failed: ${error.message}`);
    }
  }

  /**
   * 启动 HTTP 服务器
   */
  async startServer() {
    const server = this.components.server;
    if (!server) return;
    
    return new Promise((resolve, reject) => {
      const port = server.port || process.env.PORT || 3000;
      
      server.listen(port, () => {
        logger.info(`HTTP server started`, {
          serviceName: this.serviceName,
          port
        });
        resolve();
      });
      
      server.on('error', reject);
    });
  }

  /**
   * 持久化状态到 Redis
   */
  async persistState() {
    try {
      const redis = getRedis();
      if (!redis) return;
      
      const key = this.config.statePersistenceKey;
      const snapshot = this.stateMachine.exportSnapshot();
      
      await redis.hset(key, {
        serviceName: snapshot.serviceName,
        currentState: snapshot.currentState,
        previousState: snapshot.previousState || '',
        stateDuration: snapshot.stateDuration,
        errorInfo: snapshot.errorInfo ? JSON.stringify(snapshot.errorInfo) : '',
        updatedAt: Date.now()
      });
      
      await redis.expire(key, 3600); // 1 小时过期
    } catch (error) {
      logger.warn('Failed to persist state', {
        serviceName: this.serviceName,
        error: error.message
      });
    }
  }

  /**
   * 从 Redis 恢复状态
   */
  async restoreState() {
    try {
      const redis = getRedis();
      if (!redis) return null;
      
      const key = this.config.statePersistenceKey;
      const data = await redis.hgetall(key);
      
      if (!data || !data.currentState) return null;
      
      return {
        serviceName: data.serviceName,
        currentState: data.currentState,
        previousState: data.previousState || null,
        stateDuration: parseInt(data.stateDuration) || 0,
        errorInfo: data.errorInfo ? JSON.parse(data.errorInfo) : null
      };
    } catch (error) {
      logger.warn('Failed to restore state', {
        serviceName: this.serviceName,
        error: error.message
      });
      return null;
    }
  }

  /**
   * 设置进程信号处理
   */
  setupSignalHandlers() {
    // SIGTERM - Kubernetes 发送的终止信号
    process.on('SIGTERM', async () => {
      logger.info('Received SIGTERM, starting graceful shutdown');
      await this.stop();
      process.exit(0);
    });
    
    // SIGINT - Ctrl+C
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, starting graceful shutdown');
      await this.stop();
      process.exit(0);
    });
    
    // 未捕获的异常
    process.on('uncaughtException', async (error) => {
      logger.error('Uncaught exception', {
        serviceName: this.serviceName,
        error: error.message,
        stack: error.stack
      });
      
      await this.stop();
      process.exit(1);
    });
    
    // 未处理的 Promise 拒绝
    process.on('unhandledRejection', async (reason, promise) => {
      logger.error('Unhandled rejection', {
        serviceName: this.serviceName,
        reason: reason?.message || String(reason)
      });
    });
  }

  /**
   * 增加请求计数
   */
  incrementRequestCount() {
    this.metrics.requestCount++;
    this.metrics.lastRequestTime = Date.now();
  }

  /**
   * 增加错误计数
   */
  incrementErrorCount() {
    this.metrics.errorCount++;
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    const state = this.stateMachine.getCurrentState();
    
    return {
      serviceName: this.serviceName,
      state: state,
      stateDescription: this.stateMachine.getCurrentStateDescription(),
      isRunning: this.stateMachine.isRunning(),
      canAcceptRequests: this.stateMachine.canAcceptRequests(),
      uptime: this.metrics.readyTime ? Date.now() - this.metrics.readyTime : 0,
      stateDuration: this.stateMachine.getStateDuration(),
      requestCount: this.metrics.requestCount,
      errorCount: this.metrics.errorCount,
      lastRequestTime: this.metrics.lastRequestTime,
      dependencies: this.dependencyCoordinator.getAllDependencyStatus(),
      components: {
        database: this.components.database ? 'connected' : 'not_configured',
        redis: this.components.redis !== false ? 'connected' : 'not_configured',
        kafka: this.components.kafka ? 'connected' : 'not_configured',
        server: this.components.server ? 'running' : 'not_configured',
        pluginManager: this.components.pluginManager ? 'active' : 'not_configured'
      },
      timestamp: Date.now()
    };
  }

  /**
   * 获取状态机实例
   */
  getStateMachine() {
    return this.stateMachine;
  }

  /**
   * 获取关闭编排器
   */
  getShutdownOrchestrator() {
    return this.shutdownOrchestrator;
  }

  /**
   * 获取依赖协调器
   */
  getDependencyCoordinator() {
    return this.dependencyCoordinator;
  }

  /**
   * 注册关闭钩子
   */
  registerShutdownHook(name, hook, priority = 100) {
    this.shutdownOrchestrator.registerShutdownHook(name, hook, priority);
  }
}

/**
 * 创建服务生命周期管理器的工厂函数
 */
async function createServiceLifecycleManager(serviceName, config = {}) {
  const manager = new ServiceLifecycleManager(serviceName, config);
  
  // 尝试从 Redis 恢复之前的状态
  const previousState = await manager.restoreState();
  if (previousState && 
      (previousState.currentState === ServiceLifecycleState.STOPPED ||
       previousState.currentState === ServiceLifecycleState.ERROR)) {
    logger.info('Restored previous state', {
      serviceName,
      previousState: previousState.currentState
    });
  }
  
  return manager;
}

module.exports = {
  ServiceLifecycleManager,
  createServiceLifecycleManager
};
