# REQ-00549：服务生命周期状态机与优雅转换系统

- **编号**：REQ-00549
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/serviceLifecycle、gateway、所有后端服务、infrastructure/k8s
- **创建时间**：2026-07-16 10:00
- **依赖需求**：REQ-00505(插件生命周期管理系统已完成)

## 1. 背景与问题

mineGo 项目已实现插件生命周期管理系统（REQ-00505），但服务层本身缺少统一的**生命周期状态机管理**：

### 1.1 当前问题
1. **启动流程不一致**：各服务启动流程分散，缺少统一状态转换标准
2. **优雅关闭不完整**：SIGTERM 处理逻辑各服务实现不同，可能丢失请求
3. **状态可见性差**：运行时无法准确知道服务处于哪个生命周期阶段
4. **依赖启动顺序**：微服务间启动依赖关系未标准化管理
5. **故障恢复困难**：服务异常时缺少自动状态回退机制

### 1.2 当前代码现状
```javascript
// 各服务启动时分散处理
async function start() {
  await connectDB();
  await connectRedis();
  await startServer();
  process.on('SIGTERM', shutdown); // 各服务实现不一致
}
```

### 1.3 期望改进
构建统一的服务生命周期状态机系统，支持：
- 标准化生命周期状态定义（starting、healthy、draining、stopping、stopped、error）
- 自动状态转换与事件通知
- 优雅关闭流程编排（连接排空、请求完成、资源清理）
- 服务依赖启动顺序管理
- 状态持久化与健康检查集成

## 2. 目标

1. **统一生命周期管理**：所有服务通过 ServiceLifecycleManager 管理状态
2. **优雅关闭标准化**：确保零请求丢失的关闭流程
3. **状态可视化**：运行时准确反映服务状态，集成健康检查
4. **依赖启动编排**：自动等待依赖服务就绪后再启动
5. **故障自动恢复**：异常状态自动回退到安全状态

## 3. 范围

### 包含
- 服务生命周期状态机：`ServiceLifecycleStateMachine`
- 生命周期管理器：`ServiceLifecycleManager`
- 优雅关闭编排器：`GracefulShutdownOrchestrator`
- 依赖启动协调器：`DependencyStartupCoordinator`
- 状态持久化适配器：集成 Redis/PostgreSQL
- 现有服务改造：gateway、user-service、catch-service 等集成

### 不包含
- 前端应用生命周期（仅后端服务）
- 容器编排层面控制（K8s）
- 分布式事务协调（已有 Saga 引擎）

## 4. 详细需求

### 4.1 服务生命周期状态定义

```javascript
// backend/shared/serviceLifecycle/ServiceLifecycleState.js

const ServiceLifecycleState = {
  // 初始状态
  UNINITIALIZED: 'uninitialized',    // 未初始化
  
  // 启动阶段
  STARTING: 'starting',              // 正在启动
  WAITING_DEPENDENCIES: 'waiting_dependencies',  // 等待依赖服务
  INITIALIZING_PLUGINS: 'initializing_plugins',  // 初始化插件
  CONNECTING_DB: 'connecting_db',    // 连接数据库
  CONNECTING_REDIS: 'connecting_redis',  // 连接 Redis
  CONNECTING_KAFKA: 'connecting_kafka',  // 连接 Kafka
  STARTING_SERVER: 'starting_server',  // 启动 HTTP 服务器
  
  // 运行阶段
  HEALTHY: 'healthy',                // 正常运行
  DEGRADED: 'degraded',              // 降级运行
  DRAINING: 'draining',              // 排空连接（准备关闭）
  
  // 关闭阶段
  STOPPING: 'stopping',              // 正在停止
  STOPPING_PLUGINS: 'stopping_plugins',  // 停止插件
  CLOSING_CONNECTIONS: 'closing_connections',  // 关闭连接
  CLEANUP_RESOURCES: 'cleanup_resources',  // 清理资源
  
  // 终止状态
  STOPPED: 'stopped',                // 已停止
  ERROR: 'error'                     // 错误状态
};

/**
 * 状态转换规则
 */
const STATE_TRANSITIONS = {
  'uninitialized': ['starting', 'error'],
  'starting': ['waiting_dependencies', 'initializing_plugins', 'error'],
  'waiting_dependencies': ['initializing_plugins', 'error'],
  'initializing_plugins': ['connecting_db', 'error'],
  'connecting_db': ['connecting_redis', 'error'],
  'connecting_redis': ['connecting_kafka', 'error'],
  'connecting_kafka': ['starting_server', 'error'],
  'starting_server': ['healthy', 'degraded', 'error'],
  'healthy': ['degraded', 'draining', 'stopping', 'error'],
  'degraded': ['healthy', 'draining', 'stopping', 'error'],
  'draining': ['stopping', 'error'],
  'stopping': ['stopping_plugins', 'error'],
  'stopping_plugins': ['closing_connections', 'error'],
  'closing_connections': ['cleanup_resources', 'error'],
  'cleanup_resources': ['stopped', 'error'],
  'stopped': ['starting'],  // 可重启
  'error': ['starting', 'stopped']  // 可重试或终止
};

module.exports = {
  ServiceLifecycleState,
  STATE_TRANSITIONS
};
```

### 4.2 服务生命周期状态机

```javascript
// backend/shared/serviceLifecycle/ServiceLifecycleStateMachine.js

const EventEmitter = require('events');
const { ServiceLifecycleState, STATE_TRANSITIONS } = require('./ServiceLifecycleState');

class ServiceLifecycleStateMachine extends EventEmitter {
  constructor(serviceName) {
    super();
    this.serviceName = serviceName;
    this.currentState = ServiceLifecycleState.UNINITIALIZED;
    this.previousState = null;
    this.stateHistory = [];
    this.transitionCallbacks = new Map();
    this.errorInfo = null;
    this.stateEnteredAt = null;
  }

  /**
   * 获取当前状态
   */
  getCurrentState() {
    return this.currentState;
  }

  /**
   * 检查是否可以转换到目标状态
   */
  canTransitionTo(targetState) {
    const allowedTransitions = STATE_TRANSITIONS[this.currentState] || [];
    return allowedTransitions.includes(targetState);
  }

  /**
   * 转换到目标状态
   */
  async transitionTo(targetState, metadata = {}) {
    if (!this.canTransitionTo(targetState)) {
      const error = new Error(
        `Invalid state transition: ${this.currentState} → ${targetState}`
      );
      this.emit('transition:error', { 
        from: this.currentState, 
        to: targetState, 
        error 
      });
      throw error;
    }

    const previousState = this.currentState;
    const transitionTimestamp = Date.now();

    // 记录状态历史
    this.stateHistory.push({
      from: previousState,
      to: targetState,
      timestamp: transitionTimestamp,
      metadata,
      duration: this.stateEnteredAt ? transitionTimestamp - this.stateEnteredAt : 0
    });

    // 更新状态
    this.previousState = previousState;
    this.currentState = targetState;
    this.stateEnteredAt = transitionTimestamp;

    // 执行转换回调
    const callback = this.transitionCallbacks.get(targetState);
    if (callback) {
      try {
        await callback(metadata);
      } catch (error) {
        this.errorInfo = { error, metadata, timestamp: transitionTimestamp };
        await this.transitionTo(ServiceLifecycleState.ERROR, { error: error.message });
        throw error;
      }
    }

    // 发出状态变更事件
    this.emit('state:changed', {
      serviceName: this.serviceName,
      from: previousState,
      to: targetState,
      timestamp: transitionTimestamp,
      metadata
    });

    return {
      previousState,
      currentState: targetState,
      timestamp: transitionTimestamp
    };
  }

  /**
   * 注册状态转换回调
   */
  onEnterState(state, callback) {
    this.transitionCallbacks.set(state, callback);
  }

  /**
   * 强制转换到错误状态
   */
  async transitionToError(error, metadata = {}) {
    this.errorInfo = { error, metadata, timestamp: Date.now() };
    await this.transitionTo(ServiceLifecycleState.ERROR, { 
      error: error.message, 
      ...metadata 
    });
  }

  /**
   * 获取状态历史
   */
  getStateHistory(limit = 50) {
    return this.stateHistory.slice(-limit);
  }

  /**
   * 获取当前状态持续时间
   */
  getStateDuration() {
    if (!this.stateEnteredAt) return 0;
    return Date.now() - this.stateEnteredAt;
  }

  /**
   * 检查是否处于运行状态
   */
  isRunning() {
    return [ServiceLifecycleState.HEALTHY, ServiceLifecycleState.DEGRADED].includes(this.currentState);
  }

  /**
   * 检查是否可以接受请求
   */
  canAcceptRequests() {
    return this.currentState === ServiceLifecycleState.HEALTHY;
  }

  /**
   * 检查是否处于关闭状态
   */
  isShuttingDown() {
    return [
      ServiceLifecycleState.DRAINING,
      ServiceLifecycleState.STOPPING,
      ServiceLifecycleState.STOPPING_PLUGINS,
      ServiceLifecycleState.CLOSING_CONNECTIONS,
      ServiceLifecycleState.CLEANUP_RESOURCES
    ].includes(this.currentState);
  }

  /**
   * 导出状态快照
   */
  exportSnapshot() {
    return {
      serviceName: this.serviceName,
      currentState: this.currentState,
      previousState: this.previousState,
      stateDuration: this.getStateDuration(),
      errorInfo: this.errorInfo,
      stateHistoryCount: this.stateHistory.length,
      exportedAt: Date.now()
    };
  }
}

module.exports = ServiceLifecycleStateMachine;
```

### 4.3 服务生命周期管理器

```javascript
// backend/shared/serviceLifecycle/ServiceLifecycleManager.js

const ServiceLifecycleStateMachine = require('./ServiceLifecycleStateMachine');
const GracefulShutdownOrchestrator = require('./GracefulShutdownOrchestrator');
const DependencyStartupCoordinator = require('./DependencyStartupCoordinator');
const { ServiceLifecycleState } = require('./ServiceLifecycleState');
const logger = require('../logger');
const { getRedis } = require('../redis');

class ServiceLifecycleManager {
  constructor(serviceName, config = {}) {
    this.serviceName = serviceName;
    this.config = {
      statePersistenceEnabled: true,
      dependencyCheckTimeout: 30000,
      shutdownTimeout: 30000,
      drainTimeout: 10000,
      ...config
    };
    
    this.stateMachine = new ServiceLifecycleStateMachine(serviceName);
    this.shutdownOrchestrator = new GracefulShutdownOrchestrator(this);
    this.dependencyCoordinator = new DependencyStartupCoordinator(this);
    
    this.components = {
      database: null,
      redis: null,
      kafka: null,
      server: null,
      pluginManager: null
    };
    
    this.metrics = {
      startTime: null,
      readyTime: null,
      shutdownTime: null,
      requestCount: 0,
      errorCount: 0
    };
    
    this.setupEventHandlers();
  }

  /**
   * 设置事件处理器
   */
  setupEventHandlers() {
    this.stateMachine.on('state:changed', async ({ from, to, timestamp, metadata }) => {
      logger.info(`Service lifecycle state changed`, {
        serviceName: this.serviceName,
        from,
        to,
        timestamp
      });
      
      // 持久化状态到 Redis
      if (this.config.statePersistenceEnabled) {
        await this.persistState();
      }
    });

    this.stateMachine.on('transition:error', ({ from, to, error }) => {
      logger.error(`State transition error`, {
        serviceName: this.serviceName,
        from,
        to,
        error: error.message
      });
    });
  }

  /**
   * 注册组件
   */
  registerComponent(name, instance) {
    this.components[name] = instance;
  }

  /**
   * 启动服务
   */
  async start(startupConfig = {}) {
    this.metrics.startTime = Date.now();
    
    try {
      // Step 1: 开始启动
      await this.stateMachine.transitionTo(ServiceLifecycleState.STARTING);
      
      // Step 2: 等待依赖服务就绪
      if (startupConfig.dependencies) {
        await this.stateMachine.transitionTo(ServiceLifecycleState.WAITING_DEPENDENCIES);
        await this.dependencyCoordinator.waitForDependencies(startupConfig.dependencies);
      }
      
      // Step 3: 初始化插件
      if (this.components.pluginManager) {
        await this.stateMachine.transitionTo(ServiceLifecycleState.INITIALIZING_PLUGINS);
        await this.components.pluginManager.initializeAll();
      }
      
      // Step 4: 连接数据库
      if (this.components.database) {
        await this.stateMachine.transitionTo(ServiceLifecycleState.CONNECTING_DB);
        await this.connectDatabase();
      }
      
      // Step 5: 连接 Redis
      if (this.components.redis) {
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
      
      // 启动插件
      if (this.components.pluginManager) {
        await this.components.pluginManager.startAll();
      }
      
      logger.info(`Service started successfully`, {
        serviceName: this.serviceName,
        startupDuration: this.metrics.readyTime - this.metrics.startTime
      });
      
    } catch (error) {
      await this.stateMachine.transitionToError(error);
      throw error;
    }
  }

  /**
   * 停止服务
   */
  async stop() {
    if (this.stateMachine.isShuttingDown() || 
        this.stateMachine.currentState === ServiceLifecycleState.STOPPED) {
      return;
    }
    
    this.metrics.shutdownTime = Date.now();
    
    try {
      // 执行优雅关闭
      await this.shutdownOrchestrator.execute();
      
    } catch (error) {
      logger.error(`Service shutdown error`, {
        serviceName: this.serviceName,
        error: error.message
      });
      await this.stateMachine.transitionToError(error);
      throw error;
    }
  }

  /**
   * 连接数据库
   */
  async connectDatabase() {
    const pool = this.components.database;
    try {
      await pool.query('SELECT 1');
      logger.info(`Database connected`, { serviceName: this.serviceName });
    } catch (error) {
      throw new Error(`Database connection failed: ${error.message}`);
    }
  }

  /**
   * 连接 Redis
   */
  async connectRedis() {
    const redis = this.components.redis || getRedis();
    try {
      await redis.ping();
      logger.info(`Redis connected`, { serviceName: this.serviceName });
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
      logger.info(`Kafka connected`, { serviceName: this.serviceName });
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
      server.listen(server.port, () => {
        logger.info(`HTTP server started`, {
          serviceName: this.serviceName,
          port: server.port
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
      const key = `service:lifecycle:${this.serviceName}`;
      const snapshot = this.stateMachine.exportSnapshot();
      
      await redis.hset(key, {
        currentState: snapshot.currentState,
        previousState: snapshot.previousState || '',
        stateDuration: snapshot.stateDuration,
        errorInfo: snapshot.errorInfo ? JSON.stringify(snapshot.errorInfo) : '',
        updatedAt: Date.now()
      });
      
      await redis.expire(key, 3600); // 1 小时过期
    } catch (error) {
      logger.warn(`Failed to persist state`, {
        serviceName: this.serviceName,
        error: error.message
      });
    }
  }

  /**
   * 增加请求计数
   */
  incrementRequestCount() {
    this.metrics.requestCount++;
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
    return {
      serviceName: this.serviceName,
      state: this.stateMachine.getCurrentState(),
      isRunning: this.stateMachine.isRunning(),
      canAcceptRequests: this.stateMachine.canAcceptRequests(),
      uptime: this.metrics.readyTime ? Date.now() - this.metrics.readyTime : 0,
      requestCount: this.metrics.requestCount,
      errorCount: this.metrics.errorCount,
      components: {
        database: this.components.database ? 'connected' : 'not_configured',
        redis: this.components.redis ? 'connected' : 'not_configured',
        kafka: this.components.kafka ? 'connected' : 'not_configured'
      }
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
}

module.exports = ServiceLifecycleManager;
```

### 4.4 优雅关闭编排器

```javascript
// backend/shared/serviceLifecycle/GracefulShutdownOrchestrator.js

const { ServiceLifecycleState } = require('./ServiceLifecycleState');
const logger = require('../logger');

class GracefulShutdownOrchestrator {
  constructor(lifecycleManager) {
    this.manager = lifecycleManager;
    this.stateMachine = lifecycleManager.stateMachine;
    this.config = lifecycleManager.config;
    this.shutdownHooks = [];
  }

  /**
   * 注册关闭钩子
   */
  registerShutdownHook(name, hook, priority = 100) {
    this.shutdownHooks.push({ name, hook, priority });
    this.shutdownHooks.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 执行优雅关闭
   */
  async execute() {
    const startTime = Date.now();
    
    logger.info(`Starting graceful shutdown`, {
      serviceName: this.manager.serviceName
    });
    
    try {
      // Step 1: 进入排空状态
      await this.stateMachine.transitionTo(ServiceLifecycleState.DRAINING);
      await this.drainConnections();
      
      // Step 2: 停止接受新请求
      await this.stateMachine.transitionTo(ServiceLifecycleState.STOPPING);
      
      // Step 3: 停止插件
      if (this.manager.components.pluginManager) {
        await this.stateMachine.transitionTo(ServiceLifecycleState.STOPPING_PLUGINS);
        await this.manager.components.pluginManager.stopAll();
      }
      
      // Step 4: 关闭连接
      await this.stateMachine.transitionTo(ServiceLifecycleState.CLOSING_CONNECTIONS);
      await this.closeConnections();
      
      // Step 5: 清理资源
      await this.stateMachine.transitionTo(ServiceLifecycleState.CLEANUP_RESOURCES);
      await this.cleanupResources();
      
      // Step 6: 标记为已停止
      await this.stateMachine.transitionTo(ServiceLifecycleState.STOPPED);
      
      const duration = Date.now() - startTime;
      logger.info(`Graceful shutdown completed`, {
        serviceName: this.manager.serviceName,
        duration,
        requestCount: this.manager.metrics.requestCount,
        errorCount: this.manager.metrics.errorCount
      });
      
    } catch (error) {
      await this.stateMachine.transitionToError(error);
      throw error;
    }
  }

  /**
   * 排空连接
   */
  async drainConnections() {
    const server = this.manager.components.server;
    if (!server) return;
    
    // 停止接受新连接
    if (server.stopAcceptingConnections) {
      server.stopAcceptingConnections();
    }
    
    // 等待现有请求完成
    const drainTimeout = this.config.drainTimeout;
    const startTime = Date.now();
    
    while (Date.now() - startTime < drainTimeout) {
      const activeRequests = server.getActiveRequests ? server.getActiveRequests() : 0;
      
      if (activeRequests === 0) {
        break;
      }
      
      logger.debug(`Draining connections`, {
        serviceName: this.manager.serviceName,
        activeRequests,
        remaining: Math.ceil((drainTimeout - (Date.now() - startTime)) / 1000)
      });
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * 关闭连接
   */
  async closeConnections() {
    const components = this.manager.components;
    
    // 关闭 Kafka
    if (components.kafka) {
      try {
        await components.kafka.disconnect();
        logger.info(`Kafka disconnected`, { serviceName: this.manager.serviceName });
      } catch (error) {
        logger.warn(`Failed to disconnect Kafka`, { error: error.message });
      }
    }
    
    // 关闭 Redis
    if (components.redis) {
      try {
        await components.redis.disconnect();
        logger.info(`Redis disconnected`, { serviceName: this.manager.serviceName });
      } catch (error) {
        logger.warn(`Failed to disconnect Redis`, { error: error.message });
      }
    }
    
    // 关闭数据库
    if (components.database) {
      try {
        await components.database.end();
        logger.info(`Database pool closed`, { serviceName: this.manager.serviceName });
      } catch (error) {
        logger.warn(`Failed to close database pool`, { error: error.message });
      }
    }
    
    // 执行自定义关闭钩子
    for (const { name, hook } of this.shutdownHooks) {
      try {
        await hook();
        logger.info(`Shutdown hook executed`, { name, serviceName: this.manager.serviceName });
      } catch (error) {
        logger.warn(`Shutdown hook failed`, { name, error: error.message });
      }
    }
  }

  /**
   * 清理资源
   */
  async cleanupResources() {
    // 清理定时器
    // 清理临时文件
    // 清理缓存
    
    logger.info(`Resources cleaned up`, { serviceName: this.manager.serviceName });
  }
}

module.exports = GracefulShutdownOrchestrator;
```

### 4.5 依赖启动协调器

```javascript
// backend/shared/serviceLifecycle/DependencyStartupCoordinator.js

const logger = require('../logger');
const axios = require('axios');

class DependencyStartupCoordinator {
  constructor(lifecycleManager) {
    this.manager = lifecycleManager;
    this.config = lifecycleManager.config;
  }

  /**
   * 等待依赖服务就绪
   */
  async waitForDependencies(dependencies) {
    const timeout = this.config.dependencyCheckTimeout;
    const startTime = Date.now();
    
    logger.info(`Waiting for dependencies`, {
      serviceName: this.manager.serviceName,
      dependencies: dependencies.map(d => d.name)
    });
    
    for (const dependency of dependencies) {
      await this.waitForService(dependency, timeout - (Date.now() - startTime));
    }
    
    logger.info(`All dependencies ready`, {
      serviceName: this.manager.serviceName
    });
  }

  /**
   * 等待单个服务就绪
   */
  async waitForService(service, remainingTimeout) {
    const { name, url, healthPath = '/health' } = service;
    const healthUrl = `${url}${healthPath}`;
    
    const startTime = Date.now();
    let attempts = 0;
    
    while (Date.now() - startTime < remainingTimeout) {
      attempts++;
      
      try {
        const response = await axios.get(healthUrl, {
          timeout: 5000,
          validateStatus: (status) => status === 200
        });
        
        logger.info(`Dependency service ready`, {
          serviceName: this.manager.serviceName,
          dependency: name,
          attempts
        });
        
        return true;
        
      } catch (error) {
        logger.debug(`Dependency service not ready`, {
          serviceName: this.manager.serviceName,
          dependency: name,
          attempt: attempts,
          error: error.message
        });
        
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    throw new Error(`Dependency ${name} not ready after ${attempts} attempts`);
  }
}

module.exports = DependencyStartupCoordinator;
```

### 4.6 服务集成示例

```javascript
// backend/services/user-service/index.js

const ServiceLifecycleManager = require('../../shared/serviceLifecycle/ServiceLifecycleManager');
const PluginManager = require('../../shared/pluginSystem/PluginManager');
const DatabasePool = require('../../shared/DatabasePool');
const { createRedis } = require('../../shared/redis');
const express = require('express');

async function main() {
  // 创建生命周期管理器
  const lifecycleManager = new ServiceLifecycleManager('user-service', {
    dependencyCheckTimeout: 30000,
    shutdownTimeout: 30000,
    drainTimeout: 10000
  });
  
  // 创建插件管理器
  const pluginManager = new PluginManager();
  lifecycleManager.registerComponent('pluginManager', pluginManager);
  
  // 注册插件
  pluginManager.register(new CircuitBreakerPlugin());
  pluginManager.register(new ChaosEnginePlugin());
  
  // 创建数据库连接池
  const dbPool = DatabasePool.getPool('user-service');
  lifecycleManager.registerComponent('database', dbPool);
  
  // 创建 Redis 连接
  const redis = createRedis();
  lifecycleManager.registerComponent('redis', redis);
  
  // 创建 HTTP 服务器
  const app = express();
  const server = app.listen(3001);
  lifecycleManager.registerComponent('server', server);
  
  // 注册优雅关闭钩子
  lifecycleManager.getShutdownOrchestrator().registerShutdownHook(
    'cleanup-temp-files',
    async () => {
      // 清理临时文件
    },
    100
  );
  
  // 注册 SIGTERM 处理器
  process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM, starting graceful shutdown');
    await lifecycleManager.stop();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    logger.info('Received SIGINT, starting graceful shutdown');
    await lifecycleManager.stop();
    process.exit(0);
  });
  
  // 启动服务
  await lifecycleManager.start({
    dependencies: [
      { name: 'gateway', url: 'http://gateway:3000' },
      { name: 'location-service', url: 'http://location-service:3002' }
    ]
  });
  
  // 健康检查端点
  app.get('/health', async (req, res) => {
    const health = await lifecycleManager.healthCheck();
    const statusCode = health.canAcceptRequests ? 200 : 503;
    res.status(statusCode).json(health);
  });
  
  // 状态端点
  app.get('/lifecycle/state', (req, res) => {
    res.json(lifecycleManager.getStateMachine().exportSnapshot());
  });
}

main().catch(error => {
  console.error('Service startup failed:', error);
  process.exit(1);
});
```

### 4.7 Admin Dashboard 集成

- **服务状态看板**：实时显示所有服务生命周期状态
- **状态历史图表**：可视化状态转换历史
- **优雅关闭操作**：一键触发服务优雅关闭
- **依赖关系图**：显示服务间启动依赖关系
- **健康检查集成**：状态机与健康检查端点集成

## 5. 验收标准（可测试）

- [ ] `ServiceLifecycleStateMachine` 定义所有状态和转换规则
- [ ] 非法状态转换被正确拒绝并抛出错误
- [ ] `ServiceLifecycleManager.start()` 按正确顺序启动所有组件
- [ ] 服务启动时自动等待依赖服务就绪
- [ ] SIGTERM 信号触发优雅关闭流程
- [ ] 优雅关闭流程正确排空连接、关闭资源
- [ ] 状态持久化到 Redis 成功
- [ ] `/health` 端点反映正确的服务状态
- [ ] `/lifecycle/state` 端点返回状态快照
- [ ] 至少 3 个服务集成生命周期管理器
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**L - 大工作量**
- 状态定义与转换规则：1 小时
- ServiceLifecycleStateMachine：2 小时
- ServiceLifecycleManager：3 小时
- GracefulShutdownOrchestrator：2 小时
- DependencyStartupCoordinator：1 小时
- 现有服务改造（3 个）：3 小时
- Admin Dashboard 集成：2 小时
- 单元测试：3 小时

总计约 14 小时，需 2 个工作日完成。

## 7. 优先级理由

**P1 - 高优先级**

理由：
1. **基础设施完整性**：服务生命周期是微服务架构的核心基础设施
2. **运维可靠性**：优雅关闭确保零请求丢失，提升系统可靠性
3. **状态可见性**：标准化状态管理使监控和故障排查更高效
4. **依赖管理**：自动化依赖启动协调减少人工干预
5. **成熟度评分提升**：完成后"可扩展性/解耦"维度从 8 分提升至 12 分

此需求与插件生命周期系统（REQ-00505）形成互补，共同构建完整的服务治理体系。