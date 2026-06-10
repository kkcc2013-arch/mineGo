// backend/shared/DegradationManager.js
'use strict';

const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const { getRedis } = require('./redis');

const logger = createLogger('degradation-manager');

/**
 * 降级级别
 */
const DEGRADATION_LEVELS = {
  NORMAL: 'normal',
  LEVEL_1: 'level1',  // 轻度降级
  LEVEL_2: 'level2',  // 中度降级
  LEVEL_3: 'level3'   // 重度降级
};

/**
 * 降级动作类型
 */
const DEGRADATION_ACTIONS = {
  CACHE_ONLY: 'cache_only',
  READ_ONLY: 'read_only',
  DISABLE_FEATURE: 'disable_feature',
  RATE_LIMIT_STRICT: 'rate_limit_strict',
  SERVICE_UNAVAILABLE: 'service_unavailable',
  FALLBACK_RESPONSE: 'fallback_response',
  DISABLE_NOTIFICATIONS: 'disable_notifications',
  ESSENTIAL_ONLY: 'essential_only',
  BATCH_PROCESSING: 'batch_processing',
  DELAYED_PROCESSING: 'delayed_processing'
};

/**
 * 服务优先级
 */
const SERVICE_PRIORITY = {
  CRITICAL: 1,   // 核心服务（user, catch, payment）
  IMPORTANT: 2,  // 重要服务（pokemon, gym, location）
  NON_CRITICAL: 3 // 非核心服务（social, reward）
};

/**
 * 默认降级配置
 */
const DEFAULT_CONFIG = {
  global: {
    enabled: true,
    triggerConditions: {
      cpuUsage: 85,
      memoryUsage: 90,
      errorRate: 0.05,
      latencyP99: 3000,
      activeConnections: 10000
    },
    actions: [DEGRADATION_ACTIONS.RATE_LIMIT_STRICT]
  },
  
  services: {
    'user-service': {
      priority: SERVICE_PRIORITY.CRITICAL,
      degradationLevels: {
        level1: {
          trigger: { errorRate: 0.02 },
          actions: [DEGRADATION_ACTIONS.CACHE_ONLY]
        },
        level2: {
          trigger: { errorRate: 0.05, latencyP99: 2000 },
          actions: [DEGRADATION_ACTIONS.READ_ONLY]
        },
        level3: {
          trigger: { errorRate: 0.1 },
          actions: [DEGRADATION_ACTIONS.ESSENTIAL_ONLY]
        }
      }
    },
    'catch-service': {
      priority: SERVICE_PRIORITY.CRITICAL,
      degradationLevels: {
        level1: {
          trigger: { errorRate: 0.02, latencyP99: 1500 },
          actions: [DEGRADATION_ACTIONS.CACHE_ONLY]
        },
        level2: {
          trigger: { errorRate: 0.05 },
          actions: [DEGRADATION_ACTIONS.RATE_LIMIT_STRICT]
        },
        level3: {
          trigger: { errorRate: 0.1 },
          actions: [DEGRADATION_ACTIONS.ESSENTIAL_ONLY]
        }
      }
    },
    'payment-service': {
      priority: SERVICE_PRIORITY.CRITICAL,
      degradationLevels: {
        level1: {
          trigger: { errorRate: 0.01 },
          actions: [DEGRADATION_ACTIONS.CACHE_ONLY]
        },
        level2: {
          trigger: { errorRate: 0.03 },
          actions: [DEGRADATION_ACTIONS.RATE_LIMIT_STRICT]
        },
        level3: {
          trigger: { errorRate: 0.05 },
          actions: [DEGRADATION_ACTIONS.ESSENTIAL_ONLY]
        }
      }
    },
    'pokemon-service': {
      priority: SERVICE_PRIORITY.IMPORTANT,
      degradationLevels: {
        level1: {
          trigger: { errorRate: 0.03, latencyP99: 1500 },
          actions: [DEGRADATION_ACTIONS.CACHE_ONLY, DEGRADATION_ACTIONS.DISABLE_NOTIFICATIONS]
        },
        level2: {
          trigger: { errorRate: 0.07 },
          actions: [DEGRADATION_ACTIONS.READ_ONLY]
        },
        level3: {
          trigger: { errorRate: 0.15 },
          actions: [DEGRADATION_ACTIONS.FALLBACK_RESPONSE]
        }
      }
    },
    'location-service': {
      priority: SERVICE_PRIORITY.IMPORTANT,
      degradationLevels: {
        level1: {
          trigger: { latencyP99: 1500 },
          actions: [DEGRADATION_ACTIONS.CACHE_ONLY]
        },
        level2: {
          trigger: { errorRate: 0.05, latencyP99: 2500 },
          actions: [DEGRADATION_ACTIONS.READ_ONLY]
        },
        level3: {
          trigger: { errorRate: 0.1 },
          actions: [DEGRADATION_ACTIONS.SERVICE_UNAVAILABLE]
        }
      }
    },
    'gym-service': {
      priority: SERVICE_PRIORITY.IMPORTANT,
      degradationLevels: {
        level1: {
          trigger: { errorRate: 0.03 },
          actions: [DEGRADATION_ACTIONS.CACHE_ONLY, DEGRADATION_ACTIONS.DISABLE_NOTIFICATIONS]
        },
        level2: {
          trigger: { errorRate: 0.07, latencyP99: 2000 },
          actions: [DEGRADATION_ACTIONS.READ_ONLY]
        },
        level3: {
          trigger: { errorRate: 0.12 },
          actions: [DEGRADATION_ACTIONS.SERVICE_UNAVAILABLE]
        }
      }
    },
    'social-service': {
      priority: SERVICE_PRIORITY.NON_CRITICAL,
      degradationLevels: {
        level1: {
          trigger: { errorRate: 0.02 },
          actions: [DEGRADATION_ACTIONS.CACHE_ONLY, DEGRADATION_ACTIONS.DISABLE_NOTIFICATIONS]
        },
        level2: {
          trigger: { errorRate: 0.05, latencyP99: 2000 },
          actions: [DEGRADATION_ACTIONS.READ_ONLY]
        },
        level3: {
          trigger: { errorRate: 0.1 },
          actions: [DEGRADATION_ACTIONS.SERVICE_UNAVAILABLE]
        }
      }
    },
    'reward-service': {
      priority: SERVICE_PRIORITY.NON_CRITICAL,
      degradationLevels: {
        level1: {
          trigger: { latencyP99: 1500 },
          actions: [DEGRADATION_ACTIONS.CACHE_ONLY, DEGRADATION_ACTIONS.BATCH_PROCESSING]
        },
        level2: {
          trigger: { errorRate: 0.03 },
          actions: [DEGRADATION_ACTIONS.ESSENTIAL_ONLY, DEGRADATION_ACTIONS.DELAYED_PROCESSING]
        },
        level3: {
          trigger: { errorRate: 0.08 },
          actions: [DEGRADATION_ACTIONS.FALLBACK_RESPONSE]
        }
      }
    }
  },
  
  // 用户等级降级策略
  userTiers: {
    vip: { priority: 1, exemptFromDegradation: true },
    premium: { priority: 2, degradationDelay: 60 },
    free: { priority: 3, degradationDelay: 0 }
  },
  
  // 接口级降级策略
  endpoints: {
    '/api/social/friends': {
      degradation: {
        cacheOnly: true,
        fallbackData: 'cached_friends_list',
        ttl: 300
      }
    },
    '/api/social/notifications': {
      degradation: {
        disable: true,
        fallbackResponse: { message: '通知服务暂时不可用' }
      }
    },
    '/api/reward/leaderboard': {
      degradation: {
        disable: true,
        fallbackResponse: { message: '排行榜暂时不可用' }
      }
    },
    '/api/pokemon/collection': {
      degradation: {
        cacheOnly: true,
        fallbackData: 'cached_pokemon_collection',
        ttl: 180
      }
    }
  }
};

/**
 * 降级管理器
 */
class DegradationManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = options.config || DEFAULT_CONFIG;
    this.redis = options.redis || getRedis();
    this.db = options.db;
    
    // 当前降级状态：服务 -> 降级级别
    this.currentDegradationState = new Map();
    
    // 降级历史记录
    this.degradationHistory = [];
    
    // 恢复探测定时器
    this.recoveryProbes = new Map();
    
    // 指标采集器
    this.metricsCollectors = new Map();
    
    // 降级事件订阅者
    this.subscribers = new Map();
    
    // Prometheus 指标
    this.initPrometheusMetrics();
    
    // 启动健康监控
    this.startHealthMonitoring();
    
    logger.info({
      services: Object.keys(this.config.services)
    }, 'Degradation manager initialized');
  }

  /**
   * 初始化 Prometheus 指标
   */
  initPrometheusMetrics() {
    const { register, Counter, Gauge } = require('prom-client');
    
    this.metrics = {
      degradationEventsTotal: new Counter({
        name: 'degradation_events_total',
        help: 'Total number of degradation events',
        labelNames: ['service', 'level', 'action']
      }),
      currentDegradationLevel: new Gauge({
        name: 'current_degradation_level',
        help: 'Current degradation level for each service',
        labelNames: ['service']
      }),
      recoveryAttemptsTotal: new Counter({
        name: 'recovery_attempts_total',
        help: 'Total number of recovery attempts',
        labelNames: ['service', 'success']
      })
    };
  }

  /**
   * 启动健康监控
   */
  startHealthMonitoring() {
    // 每 10 秒检查一次降级条件
    this.healthCheckInterval = setInterval(() => {
      this.checkAllServicesHealth();
    }, 10000);
  }

  /**
   * 检查所有服务的健康状态
   */
  async checkAllServicesHealth() {
    for (const serviceName of Object.keys(this.config.services)) {
      try {
        const degradationNeeded = await this.checkDegradationNeeded(serviceName);
        
        if (degradationNeeded) {
          await this.executeDegradation(degradationNeeded);
        }
      } catch (err) {
        logger.error({
          service: serviceName,
          error: err.message
        }, 'Health check failed');
      }
    }
  }

  /**
   * 检查服务是否需要降级
   */
  async checkDegradationNeeded(serviceName) {
    const serviceConfig = this.config.services[serviceName];
    if (!serviceConfig) return null;
    
    // 获取服务健康指标
    const metrics = await this.getServiceMetrics(serviceName);
    
    // 检查各级降级条件
    const levels = ['level3', 'level2', 'level1']; // 从高到低检查
    
    for (const level of levels) {
      const levelConfig = serviceConfig.degradationLevels[level];
      if (!levelConfig) continue;
      
      if (this.shouldTriggerDegradation(metrics, levelConfig.trigger)) {
        return {
          service: serviceName,
          level,
          metrics,
          actions: levelConfig.actions
        };
      }
    }
    
    return null;
  }

  /**
   * 获取服务健康指标
   */
  async getServiceMetrics(serviceName) {
    // 从 Redis 获取实时指标
    const redis = this.redis;
    const metricsKey = `metrics:${serviceName}:latest`;
    
    try {
      const metricsStr = await redis.get(metricsKey);
      if (metricsStr) {
        return JSON.parse(metricsStr);
      }
    } catch (err) {
      logger.warn({ service: serviceName }, 'Failed to get metrics from Redis');
    }
    
    // 返回默认值
    return {
      errorRate: 0,
      latencyP99: 0,
      cpuUsage: 0,
      memoryUsage: 0,
      activeConnections: 0
    };
  }

  /**
   * 判断是否应该触发降级
   */
  shouldTriggerDegradation(metrics, triggers) {
    for (const [key, threshold] of Object.entries(triggers)) {
      const value = metrics[key];
      
      if (value === undefined || value === null) continue;
      
      // 错误率、延迟、资源使用率等，超过阈值即触发
      if (value >= threshold) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * 执行降级
   */
  async executeDegradation(degradationInfo) {
    const { service, level, actions, metrics } = degradationInfo;
    const currentLevel = this.currentDegradationState.get(service);
    
    // 避免重复降级到同一级别
    if (currentLevel === level) {
      logger.debug({ service, level }, 'Already at target degradation level');
      return false;
    }
    
    // 记录降级历史
    const historyEntry = {
      service,
      previousLevel: currentLevel || DEGRADATION_LEVELS.NORMAL,
      newLevel: level,
      actions,
      metrics,
      timestamp: new Date().toISOString()
    };
    
    this.degradationHistory.push(historyEntry);
    
    // 保留最近 1000 条历史
    if (this.degradationHistory.length > 1000) {
      this.degradationHistory = this.degradationHistory.slice(-1000);
    }
    
    // 更新状态
    this.currentDegradationState.set(service, level);
    
    // 广播降级事件
    await this.broadcastDegradationEvent(service, level, actions, metrics);
    
    // 启动恢复探测（如果不是最高级降级）
    if (level !== DEGRADATION_LEVELS.LEVEL_3) {
      this.startRecoveryProbe(service);
    }
    
    // 记录审计日志
    await this.logDegradationAction(service, level, actions, metrics);
    
    // 更新 Prometheus 指标
    this.metrics.degradationEventsTotal.inc({ service, level, action: actions.join(',') });
    this.metrics.currentDegradationLevel.set({ service }, this.getLevelNumber(level));
    
    logger.warn({
      service,
      previousLevel: currentLevel || 'normal',
      newLevel: level,
      actions
    }, 'Service degraded');
    
    this.emit('degradation', historyEntry);
    
    return true;
  }

  /**
   * 获取级别数字（用于指标）
   */
  getLevelNumber(level) {
    switch (level) {
      case DEGRADATION_LEVELS.NORMAL: return 0;
      case DEGRADATION_LEVELS.LEVEL_1: return 1;
      case DEGRADATION_LEVELS.LEVEL_2: return 2;
      case DEGRADATION_LEVELS.LEVEL_3: return 3;
      default: return 0;
    }
  }

  /**
   * 广播降级事件
   */
  async broadcastDegradationEvent(service, level, actions, metrics) {
    const event = {
      type: 'degradation',
      service,
      level,
      actions,
      metrics,
      timestamp: new Date().toISOString()
    };
    
    // 发布到 Redis 频道
    await this.redis.publish('degradation:events', JSON.stringify(event));
    
    // 通知订阅者
    const subscribers = this.subscribers.get(service) || [];
    for (const callback of subscribers) {
      try {
        await callback(event);
      } catch (err) {
        logger.error({ err: err.message }, 'Subscriber callback failed');
      }
    }
  }

  /**
   * 启动恢复探测
   */
  startRecoveryProbe(serviceName) {
    // 避免重复启动
    if (this.recoveryProbes.has(serviceName)) {
      return;
    }
    
    logger.info({ service: serviceName }, 'Starting recovery probe');
    
    const probeInterval = setInterval(async () => {
      try {
        const degradationNeeded = await this.checkDegradationNeeded(serviceName);
        
        if (!degradationNeeded) {
          await this.attemptRecovery(serviceName);
        }
      } catch (err) {
        logger.error({
          service: serviceName,
          error: err.message
        }, 'Recovery probe failed');
      }
    }, 30000); // 每 30 秒探测一次
    
    this.recoveryProbes.set(serviceName, probeInterval);
  }

  /**
   * 尝试恢复
   */
  async attemptRecovery(serviceName) {
    const currentLevel = this.currentDegradationState.get(serviceName);
    
    if (!currentLevel || currentLevel === DEGRADATION_LEVELS.NORMAL) {
      this.stopRecoveryProbe(serviceName);
      return;
    }
    
    logger.info({
      service: serviceName,
      currentLevel
    }, 'Attempting recovery');
    
    // 渐进式恢复：先恢复到上一级
    const serviceConfig = this.config.services[serviceName];
    const levels = Object.keys(serviceConfig.degradationLevels);
    
    const levelIndex = levels.indexOf(currentLevel);
    
    if (levelIndex > 0) {
      // 恢复到更低的降级级别
      const previousLevel = levels[levelIndex - 1];
      await this.executeDegradation({
        service: serviceName,
        level: previousLevel,
        actions: serviceConfig.degradationLevels[previousLevel].actions,
        metrics: {}
      });
      
      this.metrics.recoveryAttemptsTotal.inc({ service: serviceName, success: 'true' });
    } else {
      // 完全恢复
      this.currentDegradationState.set(serviceName, DEGRADATION_LEVELS.NORMAL);
      
      await this.broadcastRecoveryEvent(serviceName);
      
      this.stopRecoveryProbe(serviceName);
      
      this.metrics.recoveryAttemptsTotal.inc({ service: serviceName, success: 'true' });
      this.metrics.currentDegradationLevel.set({ service: serviceName }, 0);
      
      logger.info({ service: serviceName }, 'Service fully recovered');
      
      this.emit('recovery', {
        service: serviceName,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * 广播恢复事件
   */
  async broadcastRecoveryEvent(serviceName) {
    const event = {
      type: 'recovery',
      service: serviceName,
      level: DEGRADATION_LEVELS.NORMAL,
      timestamp: new Date().toISOString()
    };
    
    await this.redis.publish('degradation:events', JSON.stringify(event));
  }

  /**
   * 停止恢复探测
   */
  stopRecoveryProbe(serviceName) {
    const interval = this.recoveryProbes.get(serviceName);
    if (interval) {
      clearInterval(interval);
      this.recoveryProbes.delete(serviceName);
      logger.debug({ service: serviceName }, 'Recovery probe stopped');
    }
  }

  /**
   * 记录降级审计日志
   */
  async logDegradationAction(service, level, actions, metrics) {
    const logEntry = {
      service,
      level,
      actions,
      metrics,
      timestamp: new Date().toISOString()
    };
    
    // 存储到 Redis
    await this.redis.lpush(
      `degradation:audit:${service}`,
      JSON.stringify(logEntry)
    );
    
    // 保留最近 100 条
    await this.redis.ltrim(`degradation:audit:${service}`, 0, 99);
    
    // 如果有数据库连接，也存储到数据库
    if (this.db) {
      try {
        await this.db.query(`
          INSERT INTO degradation_audit_log 
          (service_name, level, actions, metrics, created_at)
          VALUES ($1, $2, $3, $4, NOW())
        `, [service, level, JSON.stringify(actions), JSON.stringify(metrics)]);
      } catch (err) {
        logger.error({ err: err.message }, 'Failed to save audit log to database');
      }
    }
  }

  /**
   * 获取服务当前状态
   */
  getServiceState(serviceName) {
    const level = this.currentDegradationState.get(serviceName) || DEGRADATION_LEVELS.NORMAL;
    const config = this.config.services[serviceName];
    
    return {
      service: serviceName,
      level,
      priority: config?.priority || SERVICE_PRIORITY.NON_CRITICAL,
      actions: level !== DEGRADATION_LEVELS.NORMAL 
        ? config?.degradationLevels[level]?.actions || [] 
        : []
    };
  }

  /**
   * 获取所有服务状态
   */
  getAllServicesStatus() {
    const status = {};
    
    for (const serviceName of Object.keys(this.config.services)) {
      status[serviceName] = this.getServiceState(serviceName);
    }
    
    return status;
  }

  /**
   * 获取接口降级配置
   */
  getEndpointConfig(path) {
    return this.config.endpoints[path] || null;
  }

  /**
   * 检查用户是否豁免降级
   */
  isUserExempt(userTier) {
    const tierConfig = this.config.userTiers[userTier];
    return tierConfig?.exemptFromDegradation || false;
  }

  /**
   * 获取用户降级延迟
   */
  getUserDegradationDelay(userTier) {
    const tierConfig = this.config.userTiers[userTier];
    return tierConfig?.degradationDelay || 0;
  }

  /**
   * 手动降级
   */
  async manualDegradation(serviceName, level, reason, changedBy = 'admin') {
    const serviceConfig = this.config.services[serviceName];
    if (!serviceConfig) {
      throw new Error(`Unknown service: ${serviceName}`);
    }
    
    const levelConfig = serviceConfig.degradationLevels[level];
    if (!levelConfig) {
      throw new Error(`Unknown degradation level: ${level}`);
    }
    
    logger.info({
      service: serviceName,
      level,
      reason,
      changedBy
    }, 'Manual degradation triggered');
    
    return this.executeDegradation({
      service: serviceName,
      level,
      actions: levelConfig.actions,
      metrics: { manual: true, reason, changedBy }
    });
  }

  /**
   * 强制恢复
   */
  async forceRecover(serviceName, changedBy = 'admin') {
    const currentLevel = this.currentDegradationState.get(serviceName);
    
    if (!currentLevel || currentLevel === DEGRADATION_LEVELS.NORMAL) {
      return { success: true, message: 'Service already in normal state' };
    }
    
    logger.info({
      service: serviceName,
      previousLevel: currentLevel,
      changedBy
    }, 'Manual recovery triggered');
    
    this.currentDegradationState.set(serviceName, DEGRADATION_LEVELS.NORMAL);
    
    await this.broadcastRecoveryEvent(serviceName);
    this.stopRecoveryProbe(serviceName);
    
    this.metrics.currentDegradationLevel.set({ service: serviceName }, 0);
    
    this.emit('recovery', {
      service: serviceName,
      manual: true,
      changedBy,
      timestamp: new Date().toISOString()
    });
    
    return { success: true, previousLevel: currentLevel };
  }

  /**
   * 获取降级历史
   */
  getDegradationHistory(limit = 100) {
    return this.degradationHistory.slice(-limit);
  }

  /**
   * 获取服务降级历史
   */
  async getServiceAuditLog(serviceName, limit = 50) {
    const logs = await this.redis.lrange(
      `degradation:audit:${serviceName}`,
      0,
      limit - 1
    );
    
    return logs.map(log => JSON.parse(log));
  }

  /**
   * 订阅降级事件
   */
  subscribe(serviceName, callback) {
    if (!this.subscribers.has(serviceName)) {
      this.subscribers.set(serviceName, []);
    }
    
    this.subscribers.get(serviceName).push(callback);
    
    return () => {
      const callbacks = this.subscribers.get(serviceName);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    };
  }

  /**
   * 获取缓存数据
   */
  async getFallbackData(cacheKey, userId) {
    try {
      const data = await this.redis.get(`${cacheKey}:${userId}`);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to get fallback data');
      return null;
    }
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig) {
    this.config = {
      ...this.config,
      ...newConfig
    };
    
    logger.info('Degradation config updated');
    
    this.emit('configUpdate', this.config);
  }

  /**
   * 关闭降级管理器
   */
  shutdown() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    for (const [service, interval] of this.recoveryProbes) {
      clearInterval(interval);
    }
    
    this.recoveryProbes.clear();
    
    logger.info('Degradation manager shutdown');
  }
}

// 单例实例
let defaultManager = null;

/**
 * 获取默认降级管理器实例
 */
function getDegradationManager(options = {}) {
  if (!defaultManager) {
    defaultManager = new DegradationManager(options);
  }
  return defaultManager;
}

module.exports = {
  DegradationManager,
  getDegradationManager,
  DEGRADATION_LEVELS,
  DEGRADATION_ACTIONS,
  SERVICE_PRIORITY,
  DEFAULT_CONFIG
};
