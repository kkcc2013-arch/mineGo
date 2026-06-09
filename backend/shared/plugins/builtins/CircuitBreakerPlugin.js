const { IPlugin } = require('../IPlugin');
const CircuitBreaker = require('../../CircuitBreaker');

/**
 * 熔断器插件 - 服务熔断与降级
 */
class CircuitBreakerPlugin extends IPlugin {
  static get meta() {
    return {
      name: 'circuitBreaker',
      version: '1.0.0',
      description: '服务熔断器插件，防止级联故障',
      author: 'mineGo Team',
      dependencies: [],
      priority: 15, // 高优先级（在认证之后）
      category: 'resilience',
    };
  }

  static get configSchema() {
    return {
      type: 'object',
      properties: {
        services: { type: 'array' },
        timeout: { type: 'number' },
        errorThresholdPercentage: { type: 'number' },
        resetTimeout: { type: 'number' },
      },
      required: ['services'],
    };
  }

  static get defaultConfig() {
    return {
      services: ['user-service', 'pokemon-service', 'location-service'],
      timeout: 3000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    };
  }

  async init(config, context) {
    this.config = config;
    this.logger = context.logger.child({ plugin: 'circuitBreaker' });
    this.circuitBreakers = new Map();
    
    this.logger.info({ config }, 'CircuitBreaker plugin initialized');
  }

  async start(context) {
    // 为每个服务创建熔断器
    for (const serviceName of this.config.services) {
      const breaker = new CircuitBreaker(
        async (...args) => args, // 占位函数，实际调用时替换
        {
          timeout: this.config.timeout,
          errorThresholdPercentage: this.config.errorThresholdPercentage,
          resetTimeout: this.config.resetTimeout,
        }
      );

      breaker.on('open', () => {
        this.logger.warn({ service: serviceName }, 'Circuit breaker opened');
      });

      breaker.on('halfOpen', () => {
        this.logger.info({ service: serviceName }, 'Circuit breaker half-open');
      });

      breaker.on('close', () => {
        this.logger.info({ service: serviceName }, 'Circuit breaker closed');
      });

      this.circuitBreakers.set(serviceName, breaker);
    }

    this.logger.info('CircuitBreaker plugin started');
  }

  async stop(context) {
    this.logger.info('CircuitBreaker plugin stopped');
  }

  async healthCheck() {
    const details = {};
    for (const [name, breaker] of this.circuitBreakers) {
      details[name] = {
        state: breaker.status,
        stats: breaker.stats,
      };
    }

    const hasOpenBreaker = [...this.circuitBreakers.values()]
      .some(b => b.status === 'open');

    return {
      status: hasOpenBreaker ? 'degraded' : 'healthy',
      details,
    };
  }

  getMiddleware() {
    return async (req, res, next) => {
      // 从请求路径或 header 中提取目标服务
      const targetService = req.headers['x-target-service'] 
        || req.params?.service 
        || req.body?.service;

      if (!targetService || !this.circuitBreakers.has(targetService)) {
        return next();
      }

      const breaker = this.circuitBreakers.get(targetService);

      try {
        // 检查熔断器状态
        if (breaker.status === 'open') {
          return res.status(503).json({
            error: 'Service unavailable',
            service: targetService,
            retryAfter: Math.ceil(breaker.resetTimeout / 1000),
          });
        }

        next();
      } catch (err) {
        this.logger.error({ err, service: targetService }, 'Circuit breaker error');
        next(err);
      }
    };
  }

  /**
   * 获取服务的熔断器（供外部调用使用）
   */
  getBreaker(serviceName) {
    return this.circuitBreakers.get(serviceName);
  }
}

module.exports = CircuitBreakerPlugin;
