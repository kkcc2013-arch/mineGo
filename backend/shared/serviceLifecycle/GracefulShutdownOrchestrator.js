// backend/shared/serviceLifecycle/GracefulShutdownOrchestrator.js
// 优雅关闭编排器
'use strict';

const { ServiceLifecycleState } = require('./ServiceLifecycleState');
const logger = require('../logger');

/**
 * 优雅关闭编排器
 * 协调服务的优雅关闭流程
 */
class GracefulShutdownOrchestrator {
  constructor(lifecycleManager) {
    this.manager = lifecycleManager;
    this.stateMachine = lifecycleManager.stateMachine;
    this.config = lifecycleManager.config;
    this.shutdownHooks = [];
    this.isShuttingDown = false;
  }

  /**
   * 注册关闭钩子
   * @param {string} name 钩子名称
   * @param {Function} hook 钩子函数
   * @param {number} priority 优先级（数字越小越先执行）
   */
  registerShutdownHook(name, hook, priority = 100) {
    if (typeof hook !== 'function') {
      throw new Error('Hook must be a function');
    }
    
    this.shutdownHooks.push({ name, hook, priority });
    this.shutdownHooks.sort((a, b) => a.priority - b.priority);
    
    logger.info(`Shutdown hook registered: ${name}`, {
      serviceName: this.manager.serviceName,
      priority
    });
  }

  /**
   * 移除关闭钩子
   */
  removeShutdownHook(name) {
    const index = this.shutdownHooks.findIndex(h => h.name === name);
    if (index !== -1) {
      this.shutdownHooks.splice(index, 1);
      logger.info(`Shutdown hook removed: ${name}`, {
        serviceName: this.manager.serviceName
      });
    }
  }

  /**
   * 执行优雅关闭
   */
  async execute() {
    if (this.isShuttingDown) {
      logger.warn('Shutdown already in progress', {
        serviceName: this.manager.serviceName
      });
      return;
    }
    
    this.isShuttingDown = true;
    const startTime = Date.now();
    
    logger.info('Starting graceful shutdown', {
      serviceName: this.manager.serviceName,
      currentState: this.stateMachine.getCurrentState()
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
        await this.stopPlugins();
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
      
      logger.info('Graceful shutdown completed', {
        serviceName: this.manager.serviceName,
        duration,
        requestCount: this.manager.metrics?.requestCount || 0,
        errorCount: this.manager.metrics?.errorCount || 0
      });
      
    } catch (error) {
      logger.error('Graceful shutdown failed', {
        serviceName: this.manager.serviceName,
        error: error.message,
        stack: error.stack
      });
      
      await this.stateMachine.transitionToError(error);
      throw error;
    } finally {
      this.isShuttingDown = false;
    }
  }

  /**
   * 排空连接
   * 停止接受新连接，等待现有请求完成
   */
  async drainConnections() {
    const server = this.manager.components.server;
    if (!server) return;
    
    // 停止接受新连接
    if (typeof server.stopAcceptingConnections === 'function') {
      server.stopAcceptingConnections();
      logger.info('Stopped accepting new connections', {
        serviceName: this.manager.serviceName
      });
    }
    
    // 等待现有请求完成
    const drainTimeout = this.config.drainTimeout || 10000;
    const startTime = Date.now();
    const checkInterval = 1000;
    
    while (Date.now() - startTime < drainTimeout) {
      const activeRequests = typeof server.getActiveRequests === 'function' 
        ? server.getActiveRequests() 
        : 0;
      
      if (activeRequests === 0) {
        logger.info('All connections drained', {
          serviceName: this.manager.serviceName
        });
        break;
      }
      
      logger.debug('Draining connections', {
        serviceName: this.manager.serviceName,
        activeRequests,
        remainingMs: drainTimeout - (Date.now() - startTime)
      });
      
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    // 超时后强制关闭
    const finalActiveRequests = typeof server.getActiveRequests === 'function'
      ? server.getActiveRequests()
      : 0;
    
    if (finalActiveRequests > 0) {
      logger.warn('Drain timeout, forcing shutdown', {
        serviceName: this.manager.serviceName,
        remainingRequests: finalActiveRequests
      });
    }
  }

  /**
   * 停止插件
   */
  async stopPlugins() {
    const pluginManager = this.manager.components.pluginManager;
    if (!pluginManager) return;
    
    try {
      if (typeof pluginManager.stopAll === 'function') {
        await pluginManager.stopAll();
        logger.info('All plugins stopped', {
          serviceName: this.manager.serviceName
        });
      }
    } catch (error) {
      logger.warn('Failed to stop plugins', {
        serviceName: this.manager.serviceName,
        error: error.message
      });
    }
  }

  /**
   * 关闭连接
   */
  async closeConnections() {
    const components = this.manager.components;
    const closePromises = [];
    
    // 关闭 Kafka
    if (components.kafka) {
      closePromises.push(
        this.closeComponent('kafka', async () => {
          if (typeof components.kafka.disconnect === 'function') {
            await components.kafka.disconnect();
          }
        })
      );
    }
    
    // 关闭 Redis
    if (components.redis) {
      closePromises.push(
        this.closeComponent('redis', async () => {
          if (typeof components.redis.disconnect === 'function') {
            await components.redis.disconnect();
          } else if (typeof components.redis.quit === 'function') {
            await components.redis.quit();
          }
        })
      );
    }
    
    // 关闭数据库
    if (components.database) {
      closePromises.push(
        this.closeComponent('database', async () => {
          if (typeof components.database.end === 'function') {
            await components.database.end();
          }
        })
      );
    }
    
    // 关闭 HTTP 服务器
    if (components.server) {
      closePromises.push(
        this.closeComponent('server', async () => {
          if (typeof components.server.close === 'function') {
            await new Promise((resolve, reject) => {
              components.server.close((err) => {
                if (err) reject(err);
                else resolve();
              });
            });
          }
        })
      );
    }
    
    // 执行自定义关闭钩子
    for (const { name, hook } of this.shutdownHooks) {
      closePromises.push(
        this.closeComponent(`hook:${name}`, hook)
      );
    }
    
    // 并行执行所有关闭操作
    await Promise.allSettled(closePromises);
    
    logger.info('All connections closed', {
      serviceName: this.manager.serviceName
    });
  }

  /**
   * 关闭单个组件
   */
  async closeComponent(name, closeFn) {
    const timeout = this.config.shutdownTimeout || 30000;
    
    try {
      await Promise.race([
        closeFn(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Timeout closing ${name}`)), timeout)
        )
      ]);
      
      logger.debug(`Component closed: ${name}`, {
        serviceName: this.manager.serviceName
      });
    } catch (error) {
      logger.warn(`Failed to close component: ${name}`, {
        serviceName: this.manager.serviceName,
        error: error.message
      });
    }
  }

  /**
   * 清理资源
   */
  async cleanupResources() {
    // 清理定时器
    if (this.manager.timers) {
      for (const timer of this.manager.timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      this.manager.timers = [];
    }
    
    // 清理临时文件（如果有）
    // 这里可以扩展添加具体的资源清理逻辑
    
    logger.info('Resources cleaned up', {
      serviceName: this.manager.serviceName
    });
  }

  /**
   * 获取关闭钩子列表
   */
  getShutdownHooks() {
    return this.shutdownHooks.map(h => ({ name: h.name, priority: h.priority }));
  }
}

module.exports = GracefulShutdownOrchestrator;