/**
 * 协议路由器
 * 根据场景智能选择协议，支持协议降级和健康监控
 */

const logger = require('./logger');
const metrics = require('./metrics');

/**
 * 默认协议路由规则
 */
const DEFAULT_ROUTING_RULES = {
  // 服务级别协议配置
  services: {
    'gym-service': {
      default: 'websocket',
      fallback: 'http',
      methods: {
        'battle.sync': 'websocket',
        'battle.action': 'websocket',
        'battle.query': 'http',
        'gym.list': 'http'
      }
    },
    'catch-service': {
      default: 'http',
      fallback: 'http',
      methods: {
        'catch.sync': 'websocket',
        'catch.batch': 'http'
      }
    },
    'pokemon-service': {
      default: 'http',
      fallback: 'http',
      methods: {
        'pokemon.batchQuery': 'http',
        'pokemon.query': 'http'
      }
    },
    'user-service': {
      default: 'http',
      fallback: 'http'
    },
    'location-service': {
      default: 'http',
      fallback: 'http'
    },
    'social-service': {
      default: 'http',
      fallback: 'http'
    },
    'reward-service': {
      default: 'http',
      fallback: 'http'
    },
    'payment-service': {
      default: 'http',
      fallback: 'http'
    }
  },
  
  // 场景级别协议配置
  scenarios: {
    'realtime': {
      protocol: 'websocket',
      services: ['gym-service', 'catch-service'],
      patterns: ['*.sync', '*.realtime', '*.action']
    },
    'batch': {
      protocol: 'http',
      patterns: ['*.batch*', '*.bulk*']
    },
    'query': {
      protocol: 'http',
      patterns: ['*.query', '*.list', '*.get']
    }
  },
  
  // 协议降级策略
  fallback: {
    enabled: true,
    order: ['websocket', 'http'], // 降级顺序
    conditions: {
      errorRate: 0.05, // 错误率超过 5% 触发降级
      latency: 2000,  // 延迟超过 2 秒触发降级
      consecutiveErrors: 3 // 连续 3 次错误触发降级
    },
    cooldown: 60000 // 降级后冷却时间 1 分钟
  }
};

class ProtocolRouter {
  constructor(config = {}) {
    this.rules = { ...DEFAULT_ROUTING_RULES, ...config.rules };
    this.adapters = new Map(); // protocol -> adapter
    this.protocolHealth = new Map(); // protocol -> { healthy, latency, errorRate }
    this.stats = new Map(); // protocol -> { requests, errors, totalLatency }
    this.fallbackState = new Map(); // protocol -> { fallbackActive, cooldownEnd }
  }

  /**
   * 注册协议适配器
   */
  registerAdapter(protocol, adapter) {
    this.adapters.set(protocol, adapter);
    this.protocolHealth.set(protocol, { 
      healthy: true, 
      latency: 0, 
      errorRate: 0,
      consecutiveErrors: 0
    });
    this.stats.set(protocol, { 
      requests: 0, 
      errors: 0, 
      totalLatency: 0,
      recentLatencies: [] 
    });
    this.fallbackState.set(protocol, { 
      fallbackActive: false, 
      cooldownEnd: 0 
    });

    logger.info(`Protocol adapter registered: ${protocol}`);
  }

  /**
   * 智能选择协议
   */
  selectProtocol(request) {
    const { service, method, options = {} } = request;

    // 1. 显式指定协议
    if (options.protocol) {
      if (this.isProtocolAvailable(options.protocol)) {
        return options.protocol;
      }
      logger.warn(`Requested protocol ${options.protocol} not available, falling back`);
    }

    // 2. 检查方法级别协议配置
    const serviceConfig = this.rules.services[service];
    if (serviceConfig && serviceConfig.methods && serviceConfig.methods[method]) {
      const preferred = serviceConfig.methods[method];
      if (this.isProtocolAvailable(preferred)) {
        return preferred;
      }
      // 方法降级到服务默认协议
      if (serviceConfig.fallback && this.isProtocolAvailable(serviceConfig.fallback)) {
        logger.debug(`Method protocol ${preferred} unavailable, using fallback ${serviceConfig.fallback}`);
        return serviceConfig.fallback;
      }
    }

    // 3. 服务级别默认协议
    if (serviceConfig) {
      const preferred = serviceConfig.default;
      if (this.isProtocolAvailable(preferred)) {
        return preferred;
      }
      if (serviceConfig.fallback && this.isProtocolAvailable(serviceConfig.fallback)) {
        return serviceConfig.fallback;
      }
    }

    // 4. 场景匹配
    for (const [scenario, config] of Object.entries(this.rules.scenarios)) {
      if (this.matchScenario(request, scenario, config)) {
        if (this.isProtocolAvailable(config.protocol)) {
          return config.protocol;
        }
      }
    }

    // 5. 全局默认 HTTP
    return 'http';
  }

  /**
   * 检查协议是否可用
   */
  isProtocolAvailable(protocol) {
    // 检查适配器是否存在
    if (!this.adapters.has(protocol)) {
      return false;
    }

    // 检查健康状态
    const health = this.protocolHealth.get(protocol);
    if (!health) return false;

    // 检查是否在降级冷却期
    const fallbackState = this.fallbackState.get(protocol);
    if (fallbackState && fallbackState.fallbackActive) {
      if (Date.now() < fallbackState.cooldownEnd) {
        return false;
      }
      // 冷却期结束，恢复正常
      fallbackState.fallbackActive = false;
    }

    return health.healthy && 
           health.errorRate < this.rules.fallback.conditions.errorRate &&
           health.latency < this.rules.fallback.conditions.latency &&
           health.consecutiveErrors < this.rules.fallback.conditions.consecutiveErrors;
  }

  /**
   * 发送请求（自动选择协议）
   */
  async send(request) {
    const protocol = this.selectProtocol(request);
    const adapter = this.adapters.get(protocol);

    if (!adapter) {
      throw new Error(`Protocol adapter not found: ${protocol}`);
    }

    const startTime = Date.now();
    const { service, method } = request;

    try {
      const response = await adapter.send(request);
      const duration = Date.now() - startTime;
      
      this.recordSuccess(protocol, duration);
      
      metrics.timing('protocol_router.request_duration', duration, {
        protocol,
        service,
        method,
        status: 'success'
      });

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.recordError(protocol, duration);

      metrics.increment('protocol_router.request_error', 1, {
        protocol,
        service,
        method,
        error: error.code || 'unknown'
      });

      // 尝试降级
      if (this.rules.fallback.enabled) {
        const fallbackProtocol = this.getFallbackProtocol(protocol);
        if (fallbackProtocol) {
          logger.warn('Protocol fallback triggered', {
            from: protocol,
            to: fallbackProtocol,
            service,
            method,
            error: error.message
          });

          metrics.increment('protocol_router.fallback', 1, {
            from: protocol,
            to: fallbackProtocol
          });

          const fallbackAdapter = this.adapters.get(fallbackProtocol);
          try {
            const fallbackResponse = await fallbackAdapter.send(request);
            
            // 标记原协议为降级状态
            this.activateFallback(protocol);
            
            return fallbackResponse;
          } catch (fallbackError) {
            logger.error('Fallback protocol also failed', {
              protocol: fallbackProtocol,
              error: fallbackError.message
            });
            throw fallbackError;
          }
        }
      }

      throw error;
    }
  }

  /**
   * 批量发送请求
   */
  async sendBatch(requests) {
    const results = [];
    for (const request of requests) {
      try {
        const result = await this.send(request);
        results.push({ success: true, data: result });
      } catch (error) {
        results.push({ success: false, error });
      }
    }
    return results;
  }

  /**
   * 获取降级协议
   */
  getFallbackProtocol(currentProtocol) {
    const order = this.rules.fallback.order;
    const currentIndex = order.indexOf(currentProtocol);

    if (currentIndex === -1) return null;

    for (let i = currentIndex + 1; i < order.length; i++) {
      const protocol = order[i];
      if (this.isProtocolAvailable(protocol)) {
        return protocol;
      }
    }

    return null;
  }

  /**
   * 激活降级状态
   */
  activateFallback(protocol) {
    const fallbackState = this.fallbackState.get(protocol);
    if (fallbackState) {
      fallbackState.fallbackActive = true;
      fallbackState.cooldownEnd = Date.now() + this.rules.fallback.cooldown;
      
      logger.warn(`Protocol ${protocol} deactivated due to errors, cooldown for ${this.rules.fallback.cooldown}ms`);
    }
  }

  /**
   * 场景匹配
   */
  matchScenario(request, scenario, config) {
    // 服务匹配
    if (config.services && !config.services.includes(request.service)) {
      return false;
    }

    // 方法模式匹配
    if (config.patterns) {
      for (const pattern of config.patterns) {
        if (this.matchPattern(request.method, pattern)) {
          return true;
        }
      }
      return false;
    }

    return true;
  }

  /**
   * 简单模式匹配
   */
  matchPattern(str, pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(str);
  }

  /**
   * 记录成功请求
   */
  recordSuccess(protocol, latency) {
    const stats = this.stats.get(protocol);
    if (!stats) return;

    stats.requests++;
    stats.totalLatency += latency;
    stats.errors = 0; // 成功后重置连续错误计数
    stats.recentLatencies.push(latency);
    
    // 保持最近 100 个延迟记录
    if (stats.recentLatencies.length > 100) {
      stats.recentLatencies.shift();
    }

    // 更新健康状态
    const health = this.protocolHealth.get(protocol);
    if (health) {
      health.consecutiveErrors = 0;
      health.healthy = true;
      this.updateHealthMetrics(protocol);
    }
  }

  /**
   * 记录错误请求
   */
  recordError(protocol, latency) {
    const stats = this.stats.get(protocol);
    if (!stats) return;

    stats.requests++;
    stats.errors++;
    stats.totalLatency += latency;

    // 更新健康状态
    const health = this.protocolHealth.get(protocol);
    if (health) {
      health.consecutiveErrors++;
      this.updateHealthMetrics(protocol);

      // 检查是否需要降级
      if (health.consecutiveErrors >= this.rules.fallback.conditions.consecutiveErrors) {
        this.activateFallback(protocol);
      }
    }
  }

  /**
   * 更新健康指标
   */
  updateHealthMetrics(protocol) {
    const stats = this.stats.get(protocol);
    const health = this.protocolHealth.get(protocol);

    if (!stats || !health) return;

    // 计算错误率
    if (stats.requests > 0) {
      health.errorRate = stats.errors / stats.requests;
    }

    // 计算平均延迟（最近 100 个）
    if (stats.recentLatencies.length > 0) {
      health.latency = stats.recentLatencies.reduce((a, b) => a + b, 0) / stats.recentLatencies.length;
    }

    // 更新健康状态
    health.healthy = health.errorRate < this.rules.fallback.conditions.errorRate &&
                     health.latency < this.rules.fallback.conditions.latency;
  }

  /**
   * 获取协议统计
   */
  getStats() {
    const result = {};

    for (const [protocol, stats] of this.stats) {
      const health = this.protocolHealth.get(protocol);
      const fallbackState = this.fallbackState.get(protocol);

      result[protocol] = {
        requests: stats.requests,
        errors: stats.errors,
        errorRate: health ? health.errorRate : 0,
        avgLatency: health ? health.latency : 0,
        healthy: health ? health.healthy : false,
        consecutiveErrors: health ? health.consecutiveErrors : 0,
        fallbackActive: fallbackState ? fallbackState.fallbackActive : false,
        cooldownRemaining: fallbackState && fallbackState.fallbackActive 
          ? Math.max(0, fallbackState.cooldownEnd - Date.now())
          : 0
      };
    }

    return result;
  }

  /**
   * 手动切换协议
   */
  manualSwitch(protocol, activate = true) {
    const fallbackState = this.fallbackState.get(protocol);
    if (fallbackState) {
      if (activate) {
        fallbackState.fallbackActive = true;
        fallbackState.cooldownEnd = Date.now() + this.rules.fallback.cooldown * 2; // 手动切换冷却时间更长
      } else {
        fallbackState.fallbackActive = false;
        fallbackState.cooldownEnd = 0;
        
        // 重置错误计数
        const health = this.protocolHealth.get(protocol);
        if (health) {
          health.consecutiveErrors = 0;
        }
      }
      
      logger.info(`Protocol ${protocol} manually ${activate ? 'deactivated' : 'activated'}`);
    }
  }

  /**
   * 更新路由规则
   */
  updateRules(newRules) {
    this.rules = { ...this.rules, ...newRules };
    logger.info('Protocol routing rules updated');
  }

  /**
   * 健康检查所有协议
   */
  async healthCheckAll() {
    const results = {};

    for (const [protocol, adapter] of this.adapters) {
      try {
        const healthResult = await adapter.healthCheck();
        results[protocol] = healthResult;
        
        // 更新健康状态
        const health = this.protocolHealth.get(protocol);
        if (health && typeof healthResult.healthy === 'boolean') {
          health.healthy = healthResult.healthy;
          if (healthResult.latency) {
            health.latency = healthResult.latency;
          }
        }
      } catch (error) {
        results[protocol] = { healthy: false, error: error.message };
        
        const health = this.protocolHealth.get(protocol);
        if (health) {
          health.healthy = false;
        }
      }
    }

    return results;
  }

  /**
   * 断开所有连接
   */
  async disconnectAll() {
    for (const [protocol, adapter] of this.adapters) {
      try {
        await adapter.disconnect();
      } catch (error) {
        logger.error(`Failed to disconnect ${protocol} adapter`, { error });
      }
    }

    logger.info('All protocol adapters disconnected');
  }
}

// 导出路由器和默认规则
module.exports = {
  ProtocolRouter,
  DEFAULT_ROUTING_RULES
};