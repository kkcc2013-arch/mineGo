/**
 * sloMiddleware - SLO 预算耗尽自动熔断中间件
 * 
 * 功能：
 * - 监控 SLO 预算状态
 * - 预算耗尽时自动触发降级
 * - 支持服务级和全局熔断
 * - 渐进式熔断策略
 */

const { SloManager, BUDGET_EXHAUSTION_THRESHOLD, AUTO_DEGRADATION_THRESHOLD, BURN_RATE_THRESHOLDS } = require('../SloManager');

// 熔断状态
const CIRCUIT_STATES = {
  CLOSED: 'closed',      // 正常状态
  OPEN: 'open',          // 熔断状态
  HALF_OPEN: 'half_open' // 半开状态（测试恢复）
};

// 降级策略
const DEGRADATION_STRATEGIES = {
  NONE: 'none',
  THROTTLE: 'throttle',
  DISABLE_FEATURES: 'disable_features',
  READ_ONLY: 'read_only',
  MAINTENANCE: 'maintenance'
};

class SloMiddleware {
  constructor(options = {}) {
    this.sloManager = options.sloManager;
    this.budgetTracker = options.budgetTracker;
    this.logger = options.logger || console;
    this.redis = options.redis;
    
    // 熔断状态存储
    this.circuitStates = new Map(); // service -> { state, openedAt, failureCount }
    
    // 服务配置
    this.serviceConfigs = new Map();
    
    // 非核心功能列表
    this.nonEssentialFeatures = {
      'pokemon-service': ['animation_preview', 'detail_3d_view', 'sound_effects', 'cosmetic_preview'],
      'social-service': ['leaderboard_realtime', 'friend_activity_feed', 'guild_chat_history'],
      'gym-service': ['battle_replay', 'spectator_mode'],
      'reward-service': ['daily_bonus_animation', 'achievement_popup'],
      'user-service': ['profile_customization', 'avatar_animation']
    };
    
    // 只读模式适用服务
    this.readOnlyServices = ['pokemon-service', 'social-service', 'reward-service'];
    
    // Prometheus 指标
    this.registerMetrics();
    
    // 启动状态检查
    this.startHealthCheck();
  }

  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    const promClient = require('prom-client');
    
    this.metrics = {
      circuitStateGauge: new promClient.Gauge({
        name: 'minego_slo_circuit_state',
        help: 'Circuit breaker state (0=closed, 1=half_open, 2=open)',
        labelNames: ['service']
      }),
      
      degradationLevelGauge: new promClient.Gauge({
        name: 'minego_slo_degradation_level',
        help: 'Current degradation level (0=none, 1=throttle, 2=features_disabled, 3=read_only, 4=maintenance)',
        labelNames: ['service']
      }),
      
      circuitOpenCounter: new promClient.Counter({
        name: 'minego_slo_circuit_open_events_total',
        help: 'Number of circuit breaker open events',
        labelNames: ['service', 'reason']
      }),
      
      requestThrottledCounter: new promClient.Counter({
        name: 'minego_slo_requests_throttled_total',
        help: 'Number of requests throttled due to SLO budget exhaustion',
        labelNames: ['service', 'endpoint']
      }),
      
      featureDisabledCounter: new promClient.Counter({
        name: 'minego_slo_features_disabled_total',
        help: 'Number of times features were disabled due to SLO',
        labelNames: ['service', 'feature']
      })
    };
  }

  /**
   * 启动健康检查
   */
  startHealthCheck() {
    setInterval(async () => {
      await this.checkAllServicesHealth();
    }, 30 * 1000); // 每 30 秒检查一次
  }

  /**
   * 检查所有服务健康状态
   */
  async checkAllServicesHealth() {
    const services = Object.keys(this.sloManager.getAllSlos());
    
    for (const service of services) {
      await this.checkServiceHealth(service);
    }
  }

  /**
   * 检查单个服务健康状态
   */
  async checkServiceHealth(service) {
    if (!this.budgetTracker) return;
    
    const status = await this.budgetTracker.getStatus(service);
    if (!status) return;
    
    const currentState = this.circuitStates.get(service) || { state: CIRCUIT_STATES.CLOSED };
    
    // 检查是否需要熔断
    const shouldTrip = this.shouldTripCircuit(service, status);
    
    if (shouldTrip && currentState.state === CIRCUIT_STATES.CLOSED) {
      await this.tripCircuit(service, shouldTrip.reason, status);
    } else if (!shouldTrip && currentState.state === CIRCUIT_STATES.OPEN) {
      // 尝试恢复
      await this.attemptRecovery(service, status);
    }
  }

  /**
   * 判断是否需要熔断
   */
  shouldTripCircuit(service, status) {
    // 预算耗尽
    if (status.remainingRatio < AUTO_DEGRADATION_THRESHOLD) {
      return { reason: 'budget_exhausted', level: DEGRADATION_STRATEGIES.MAINTENANCE };
    }
    
    // 预算接近耗尽
    if (status.remainingRatio < BUDGET_EXHAUSTION_THRESHOLD) {
      return { reason: 'budget_critical', level: DEGRADATION_STRATEGIES.READ_ONLY };
    }
    
    // 燃尽率过高
    if (status.burnRates['1h'] && status.burnRates['1h'] > BURN_RATE_THRESHOLDS.fast.rate) {
      return { reason: 'high_burn_rate', level: DEGRADATION_STRATEGIES.THROTTLE };
    }
    
    return null;
  }

  /**
   * 触发熔断
   */
  async tripCircuit(service, reason, status) {
    const previousState = this.circuitStates.get(service);
    
    this.circuitStates.set(service, {
      state: CIRCUIT_STATES.OPEN,
      openedAt: Date.now(),
      reason,
      status
    });
    
    this.metrics.circuitStateGauge.set({ service }, 2);
    this.metrics.circuitOpenCounter.inc({ service, reason });
    
    // 触发降级策略
    const strategy = this.getDegradationStrategy(service, reason, status);
    await this.executeDegradation(service, strategy);
    
    // 发送告警
    await this.sendAlert(service, reason, status);
    
    this.logger.warn(`Circuit tripped for ${service}:`, { reason, strategy, remainingRatio: status.remainingRatio });
  }

  /**
   * 获取降级策略
   */
  getDegradationStrategy(service, reason, status) {
    const strategies = [];
    
    if (status.remainingRatio < AUTO_DEGRADATION_THRESHOLD) {
      strategies.push({
        type: DEGRADATION_STRATEGIES.MAINTENANCE,
        priority: 1,
        actions: ['return_503', 'queue_requests']
      });
    }
    
    if (status.remainingRatio < BUDGET_EXHAUSTION_THRESHOLD) {
      strategies.push({
        type: DEGRADATION_STRATEGIES.READ_ONLY,
        priority: 2,
        actions: ['disable_writes', 'allow_reads']
      });
    }
    
    if (status.burnRates['1h'] && status.burnRates['1h'] > BURN_RATE_THRESHOLDS.fast.rate) {
      strategies.push({
        type: DEGRADATION_STRATEGIES.THROTTLE,
        priority: 3,
        actions: ['reduce_rate_limit', 'queue_non_essential']
      });
    }
    
    // 始终禁用非核心功能
    if (this.nonEssentialFeatures[service]) {
      strategies.push({
        type: DEGRADATION_STRATEGIES.DISABLE_FEATURES,
        priority: 4,
        features: this.nonEssentialFeatures[service],
        actions: ['disable_feature']
      });
    }
    
    return strategies.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 执行降级策略
   */
  async executeDegradation(service, strategies) {
    for (const strategy of strategies) {
      switch (strategy.type) {
        case DEGRADATION_STRATEGIES.MAINTENANCE:
          this.serviceConfigs.set(service, { maintenance: true });
          this.metrics.degradationLevelGauge.set({ service }, 4);
          break;
          
        case DEGRADATION_STRATEGIES.READ_ONLY:
          this.serviceConfigs.set(service, { readOnly: true });
          this.metrics.degradationLevelGauge.set({ service }, 3);
          break;
          
        case DEGRADATION_STRATEGIES.THROTTLE:
          this.serviceConfigs.set(service, { throttle: true, rateLimit: 100 });
          this.metrics.degradationLevelGauge.set({ service }, 1);
          break;
          
        case DEGRADATION_STRATEGIES.DISABLE_FEATURES:
          const disabledFeatures = this.serviceConfigs.get(service)?.disabledFeatures || new Set();
          for (const feature of strategy.features || []) {
            disabledFeatures.add(feature);
            this.metrics.featureDisabledCounter.inc({ service, feature });
          }
          this.serviceConfigs.set(service, { 
            ...this.serviceConfigs.get(service),
            disabledFeatures 
          });
          this.metrics.degradationLevelGauge.set({ service }, 2);
          break;
      }
    }
  }

  /**
   * 尝试恢复
   */
  async attemptRecovery(service, status) {
    const state = this.circuitStates.get(service);
    if (!state) return;
    
    // 检查是否超过冷却时间
    const cooldownPeriod = this.getCooldownPeriod(state.reason);
    if (Date.now() - state.openedAt < cooldownPeriod) {
      return;
    }
    
    // 检查预算是否恢复
    if (status.remainingRatio > BUDGET_EXHAUSTION_THRESHOLD && 
        status.burnRates['1h'] < BURN_RATE_THRESHOLDS.medium.rate) {
      
      // 恢复正常
      this.circuitStates.set(service, {
        state: CIRCUIT_STATES.CLOSED,
        recoveredAt: Date.now()
      });
      
      this.serviceConfigs.set(service, {});
      
      this.metrics.circuitStateGauge.set({ service }, 0);
      this.metrics.degradationLevelGauge.set({ service }, 0);
      
      this.logger.info(`Circuit recovered for ${service}`);
    } else {
      // 进入半开状态
      this.circuitStates.set(service, {
        ...state,
        state: CIRCUIT_STATES.HALF_OPEN
      });
      
      this.metrics.circuitStateGauge.set({ service }, 1);
    }
  }

  /**
   * 获取冷却时间
   */
  getCooldownPeriod(reason) {
    switch (reason) {
      case 'budget_exhausted':
        return 10 * 60 * 1000; // 10 分钟
      case 'budget_critical':
        return 5 * 60 * 1000; // 5 分钟
      case 'high_burn_rate':
        return 2 * 60 * 1000; // 2 分钟
      default:
        return 5 * 60 * 1000;
    }
  }

  /**
   * 中间件主函数
   */
  middleware(serviceName) {
    return async (req, res, next) => {
      const service = serviceName || req.service || this.detectService(req);
      if (!service) return next();
      
      const state = this.circuitStates.get(service);
      const config = this.serviceConfigs.get(service) || {};
      
      // 检查熔断状态
      if (state?.state === CIRCUIT_STATES.OPEN) {
        return this.handleOpenCircuit(service, req, res, state);
      }
      
      if (state?.state === CIRCUIT_STATES.HALF_OPEN) {
        // 半开状态：允许部分请求通过
        if (Math.random() > 0.1) {
          return this.handleOpenCircuit(service, req, res, state);
        }
      }
      
      // 检查维护模式
      if (config.maintenance) {
        return res.status(503).json({
          error: 'SERVICE_MAINTENANCE',
          reason: 'SLO budget exhausted, service in maintenance mode',
          retryAfter: 300,
          incidentId: this.generateIncidentId()
        });
      }
      
      // 检查只读模式
      if (config.readOnly && !this.isReadOnlyRequest(req)) {
        return res.status(403).json({
          error: 'READ_ONLY_MODE',
          reason: 'SLO budget critical, write operations disabled',
          retryAfter: 60
        });
      }
      
      // 检查功能禁用
      if (config.disabledFeatures?.size > 0) {
        const endpoint = req.path.split('/').pop();
        if (config.disabledFeatures.has(endpoint)) {
          this.metrics.requestThrottledCounter.inc({ service, endpoint });
          return res.status(503).json({
            error: 'FEATURE_DISABLED',
            reason: 'Non-essential feature disabled due to SLO budget exhaustion',
            feature: endpoint
          });
        }
      }
      
      // 限流检查
      if (config.throttle) {
        const allowed = await this.checkRateLimit(service, req);
        if (!allowed) {
          this.metrics.requestThrottledCounter.inc({ service, endpoint: req.path });
          return res.status(429).json({
            error: 'RATE_LIMITED',
            reason: 'SLO budget protection mode active',
            retryAfter: 1
          });
        }
      }
      
      next();
    };
  }

  /**
   * 处理熔断状态
   */
  handleOpenCircuit(service, req, res, state) {
    this.metrics.requestThrottledCounter.inc({ service, endpoint: req.path });
    
    return res.status(503).json({
      error: 'SERVICE_DEGRADED',
      reason: 'SLO budget exhausted',
      details: {
        remainingRatio: state.status?.remainingRatio,
        burnRate: state.status?.burnRates?.['1h'],
        reason: state.reason
      },
      retryAfter: 60,
      incidentId: this.generateIncidentId()
    });
  }

  /**
   * 检查是否为只读请求
   */
  isReadOnlyRequest(req) {
    return ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  }

  /**
   * 检测服务名
   */
  detectService(req) {
    const path = req.path || req.url;
    const match = path.match(/^\/api\/v\d+\/(\w+)/);
    return match ? match[1].replace('-', '-') : null;
  }

  /**
   * 限流检查
   */
  async checkRateLimit(service, req) {
    if (!this.redis) return true;
    
    const key = `slo:ratelimit:${service}:${req.ip || 'anonymous'}`;
    const current = await this.redis.incr(key);
    
    if (current === 1) {
      await this.redis.expire(key, 1);
    }
    
    return current <= 10; // 每秒 10 个请求
  }

  /**
   * 发送告警
   */
  async sendAlert(service, reason, status) {
    const alert = {
      alertname: 'SloBudgetExhaustion',
      service,
      severity: reason === 'budget_exhausted' ? 'critical' : 'warning',
      priority: reason === 'budget_exhausted' ? 'P0' : 'P1',
      summary: `${service} SLO 预算耗尽`,
      description: `服务 ${service} 的错误预算已${reason === 'budget_exhausted' ? '完全耗尽' : '接近耗尽'}，自动触发熔断`,
      details: {
        remainingRatio: status.remainingRatio,
        burnRate: status.burnRates?.['1h'],
        exhaustionPrediction: status.exhaustionPrediction?.humanReadable
      },
      timestamp: new Date().toISOString()
    };
    
    // 发送到 Redis 告警频道
    if (this.redis) {
      await this.redis.publish('alerts:slo', JSON.stringify(alert));
    }
    
    // 发送事件
    this.budgetTracker?.emit('alert', alert);
  }

  /**
   * 生成事件 ID
   */
  generateIncidentId() {
    return `INC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 获取当前状态
   */
  getStatus(service) {
    return {
      circuitState: this.circuitStates.get(service) || { state: CIRCUIT_STATES.CLOSED },
      config: this.serviceConfigs.get(service) || {}
    };
  }

  /**
   * 手动恢复
   */
  async manualRecover(service) {
    this.circuitStates.set(service, {
      state: CIRCUIT_STATES.CLOSED,
      recoveredAt: Date.now(),
      manual: true
    });
    
    this.serviceConfigs.set(service, {});
    
    this.metrics.circuitStateGauge.set({ service }, 0);
    this.metrics.degradationLevelGauge.set({ service }, 0);
    
    this.logger.info(`Manual recovery triggered for ${service}`);
  }
}

module.exports = { 
  SloMiddleware, 
  CIRCUIT_STATES, 
  DEGRADATION_STRATEGIES 
};
