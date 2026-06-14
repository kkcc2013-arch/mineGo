// backend/shared/ServiceIsolationManager.js
'use strict';

const { EventEmitter } = require('events');
const { createLogger } = require('./logger');

const logger = createLogger('service-isolation-manager');

/**
 * 服务隔离管理器
 * 
 * 功能：
 * 1. 服务隔离标记（从服务发现中移除）
 * 2. 流量控制（拒绝新请求，处理中请求继续）
 * 3. 隔离通知（发送告警到监控系统）
 * 4. 自动恢复尝试
 */
class ServiceIsolationManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      isolationTimeout: config.isolationTimeout || 600000, // 隔离超时 10分钟
      autoRecoverInterval: config.autoRecoverInterval || 60000, // 自动恢复检查间隔 1分钟
      healthCheckTimeout: config.healthCheckTimeout || 5000, // 健康检查超时 5秒
      maxRecoveryAttempts: config.maxRecoveryAttempts || 3, // 最大恢复尝试次数
      ...config
    };
    
    // 隔离的服务
    this.isolatedServices = new Map();
    
    // 服务注册表（用于服务发现）
    this.serviceRegistry = config.serviceRegistry || null;
    
    // 健康检查器
    this.healthChecker = config.healthChecker || null;
    
    // 自动恢复定时器
    this.recoveryTimers = new Map();
  }
  
  /**
   * 隔离服务
   */
  async isolate(serviceName, reason) {
    const isolationRecord = {
      serviceName,
      isolatedAt: Date.now(),
      reason,
      status: 'isolated',
      recoveryAttempts: 0,
      metadata: {}
    };
    
    this.isolatedServices.set(serviceName, isolationRecord);
    
    logger.error(`Service isolated: ${serviceName}`, {
      reason,
      timestamp: new Date().toISOString()
    });
    
    // 从服务发现中移除
    if (this.serviceRegistry) {
      try {
        await this.serviceRegistry.deregister(serviceName);
        logger.info(`Service deregistered from registry: ${serviceName}`);
      } catch (error) {
        logger.error('Failed to deregister service', {
          serviceName,
          error: error.message
        });
      }
    }
    
    // 发送隔离通知
    await this.notifyIsolation(serviceName, reason);
    
    // 设置自动恢复尝试
    this.scheduleAutoRecover(serviceName);
    
    // 发送事件
    this.emit('service-isolated', {
      serviceName,
      reason,
      timestamp: isolationRecord.isolatedAt
    });
    
    return isolationRecord;
  }
  
  /**
   * 恢复服务
   */
  async recover(serviceName) {
    const isolation = this.isolatedServices.get(serviceName);
    
    if (!isolation) {
      logger.warn(`Service not isolated: ${serviceName}`);
      return { success: false, reason: 'Service not isolated' };
    }
    
    // 执行健康检查
    const health = await this.checkHealth(serviceName);
    
    if (health.status !== 'healthy' && health.status !== 'ready') {
      logger.warn('Service health check failed, cannot recover', {
        serviceName,
        healthStatus: health.status
      });
      
      // 记录恢复尝试
      isolation.recoveryAttempts++;
      
      return {
        success: false,
        reason: 'Health check failed',
        healthStatus: health.status,
        recoveryAttempts: isolation.recoveryAttempts
      };
    }
    
    // 重新注册到服务发现
    if (this.serviceRegistry) {
      try {
        await this.serviceRegistry.register(serviceName);
        logger.info(`Service re-registered: ${serviceName}`);
      } catch (error) {
        logger.error('Failed to re-register service', {
          serviceName,
          error: error.message
        });
        
        return {
          success: false,
          reason: 'Failed to register service'
        };
      }
    }
    
    // 清理隔离记录
    this.isolatedServices.delete(serviceName);
    
    // 清除恢复定时器
    const timer = this.recoveryTimers.get(serviceName);
    if (timer) {
      clearTimeout(timer);
      this.recoveryTimers.delete(serviceName);
    }
    
    const downtime = Date.now() - isolation.isolatedAt;
    
    logger.info(`Service recovered: ${serviceName}`, {
      downtime_ms: downtime,
      recoveryAttempts: isolation.recoveryAttempts
    });
    
    // 发送恢复通知
    await this.notifyRecovery(serviceName, isolation);
    
    // 发送事件
    this.emit('service-recovered', {
      serviceName,
      downtime_ms: downtime,
      recoveryAttempts: isolation.recoveryAttempts
    });
    
    return {
      success: true,
      downtime_ms: downtime,
      recoveryAttempts: isolation.recoveryAttempts
    };
  }
  
  /**
   * 调度自动恢复
   */
  scheduleAutoRecover(serviceName) {
    // 清除现有定时器
    const existingTimer = this.recoveryTimers.get(serviceName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    // 设置新的定时器
    const timer = setTimeout(async () => {
      await this.autoRecover(serviceName);
    }, this.config.autoRecoverInterval);
    
    this.recoveryTimers.set(serviceName, timer);
    
    logger.debug('Auto recovery scheduled', {
      serviceName,
      interval_ms: this.config.autoRecoverInterval
    });
  }
  
  /**
   * 自动恢复尝试
   */
  async autoRecover(serviceName) {
    const isolation = this.isolatedServices.get(serviceName);
    
    if (!isolation || isolation.status !== 'isolated') {
      return;
    }
    
    // 检查恢复尝试次数
    if (isolation.recoveryAttempts >= this.config.maxRecoveryAttempts) {
      logger.warn('Max recovery attempts reached', {
        serviceName,
        attempts: isolation.recoveryAttempts
      });
      
      // 发送告警
      this.emit('max-recovery-attempts', {
        serviceName,
        attempts: isolation.recoveryAttempts
      });
      
      return;
    }
    
    logger.info('Attempting auto recovery', {
      serviceName,
      attempt: isolation.recoveryAttempts + 1
    });
    
    // 尝试恢复
    const result = await this.recover(serviceName);
    
    if (!result.success) {
      // 恢复失败，继续调度
      this.scheduleAutoRecover(serviceName);
    }
  }
  
  /**
   * 检查服务健康状态
   */
  async checkHealth(serviceName) {
    if (this.healthChecker) {
      try {
        const health = await Promise.race([
          this.healthChecker.readinessCheck(),
          this.createTimeout(this.config.healthCheckTimeout)
        ]);
        
        return health;
      } catch (error) {
        logger.error('Health check failed', {
          serviceName,
          error: error.message
        });
        
        return { status: 'unhealthy', error: error.message };
      }
    }
    
    // 默认返回健康
    return { status: 'healthy' };
  }
  
  /**
   * 发送隔离通知
   */
  async notifyIsolation(serviceName, reason) {
    const notification = {
      type: 'service_isolated',
      serviceName,
      reason,
      timestamp: new Date().toISOString(),
      severity: 'critical'
    };
    
    logger.error('Service isolation notification', notification);
    
    this.emit('notification', notification);
    
    // 如果配置了通知服务，发送通知
    if (this.config.notificationService) {
      try {
        await this.config.notificationService.send(notification);
      } catch (error) {
        logger.error('Failed to send isolation notification', {
          error: error.message
        });
      }
    }
  }
  
  /**
   * 发送恢复通知
   */
  async notifyRecovery(serviceName, isolation) {
    const notification = {
      type: 'service_recovered',
      serviceName,
      downtime_ms: Date.now() - isolation.isolatedAt,
      recoveryAttempts: isolation.recoveryAttempts,
      timestamp: new Date().toISOString(),
      severity: 'info'
    };
    
    logger.info('Service recovery notification', notification);
    
    this.emit('notification', notification);
    
    if (this.config.notificationService) {
      try {
        await this.config.notificationService.send(notification);
      } catch (error) {
        logger.error('Failed to send recovery notification', {
          error: error.message
        });
      }
    }
  }
  
  /**
   * 检查服务是否被隔离
   */
  isIsolated(serviceName) {
    return this.isolatedServices.has(serviceName);
  }
  
  /**
   * 获取隔离信息
   */
  getIsolationInfo(serviceName) {
    return this.isolatedServices.get(serviceName);
  }
  
  /**
   * 获取所有隔离的服务
   */
  getAllIsolated() {
    const services = [];
    
    for (const [name, info] of this.isolatedServices) {
      services.push({
        serviceName: name,
        ...info,
        downtime_ms: Date.now() - info.isolatedAt
      });
    }
    
    return services;
  }
  
  /**
   * 手动触发恢复
   */
  async manualRecover(serviceName) {
    logger.info('Manual recovery triggered', { serviceName });
    
    const isolation = this.isolatedServices.get(serviceName);
    if (isolation) {
      isolation.recoveryAttempts = 0; // 重置尝试次数
    }
    
    return await this.recover(serviceName);
  }
  
  /**
   * 创建超时 Promise
   */
  createTimeout(ms) {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Health check timeout')), ms);
    });
  }
  
  /**
   * 获取状态统计
   */
  getStats() {
    const isolated = this.getAllIsolated();
    
    return {
      totalIsolated: isolated.length,
      services: isolated,
      scheduledRecoveries: this.recoveryTimers.size
    };
  }
  
  /**
   * 清理资源
   */
  cleanup() {
    // 清除所有定时器
    for (const timer of this.recoveryTimers.values()) {
      clearTimeout(timer);
    }
    
    this.recoveryTimers.clear();
    this.isolatedServices.clear();
    
    logger.info('Service isolation manager cleaned up');
  }
}

module.exports = ServiceIsolationManager;
