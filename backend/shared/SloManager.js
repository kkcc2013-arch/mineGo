/**
 * SloManager - SLO 配置管理与状态追踪
 * 
 * 功能：
 * - 定义和管理各服务的 SLO 目标
 * - 提供 SLO 状态查询 API
 * - 支持 SLO 配置热更新
 * - 与 Prometheus 集成导出指标
 */

const promClient = require('prom-client');
const fs = require('fs').promises;
const path = require('path');

// SLO 目标配置（默认值）
const DEFAULT_SLOS = {
  'gateway': { target: 0.999, window: '30d', description: 'API 网关 - 99.9% 可用性' },
  'user-service': { target: 0.999, window: '30d', description: '用户服务 - 99.9% 可用性' },
  'pokemon-service': { target: 0.995, window: '30d', description: '精灵服务 - 99.5% 可用性' },
  'catch-service': { target: 0.995, window: '30d', description: '捕捉服务 - 99.5% 可用性' },
  'gym-service': { target: 0.99, window: '30d', description: '道馆服务 - 99% 可用性（实时战斗）' },
  'payment-service': { target: 0.9999, window: '30d', description: '支付服务 - 99.99% 可用性（最严格）' },
  'location-service': { target: 0.995, window: '30d', description: '位置服务 - 99.5% 可用性' },
  'social-service': { target: 0.99, window: '30d', description: '社交服务 - 99% 可用性' },
  'reward-service': { target: 0.99, window: '30d', description: '奖励服务 - 99% 可用性' }
};

// 燃尽率阈值配置
const BURN_RATE_THRESHOLDS = {
  fast: { rate: 2.0, severity: 'critical', alertPriority: 'P0', message: '预算快速耗尽' },
  medium: { rate: 1.0, severity: 'warning', alertPriority: 'P1', message: '预算正常消耗' },
  slow: { rate: 0.5, severity: 'info', alertPriority: 'P2', message: '预算消耗低于预期' }
};

// 预算耗尽阈值
const BUDGET_EXHAUSTION_THRESHOLD = 0.05; // 5%
const AUTO_DEGRADATION_THRESHOLD = 0.02; // 2%

class SloManager {
  constructor(options = {}) {
    this.slos = { ...DEFAULT_SLOS };
    this.configPath = options.configPath || path.join(process.cwd(), 'config/slos.json');
    this.logger = options.logger || console;
    this.redis = options.redis;
    
    // Prometheus 指标
    this.registerMetrics();
    
    // 启动配置热加载
    if (options.hotReload !== false) {
      this.startHotReload();
    }
  }

  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    this.metrics = {
      sloTargetGauge: new promClient.Gauge({
        name: 'minego_slo_target',
        help: 'SLO target for service',
        labelNames: ['service']
      }),
      sloWindowGauge: new promClient.Gauge({
        name: 'minego_slo_window_days',
        help: 'SLO time window in days',
        labelNames: ['service']
      }),
      sloConfigReloadCounter: new promClient.Counter({
        name: 'minego_slo_config_reloads_total',
        help: 'Number of SLO configuration reloads',
        labelNames: ['service']
      }),
      sloConfigErrorCounter: new promClient.Counter({
        name: 'minego_slo_config_errors_total',
        help: 'Number of SLO configuration errors',
        labelNames: ['service', 'error_type']
      })
    };
  }

  /**
   * 启动配置热加载
   */
  startHotReload() {
    // 每 5 分钟检查配置文件
    setInterval(async () => {
      try {
        await this.loadConfig();
      } catch (error) {
        this.logger.error('SLO config reload failed:', error);
      }
    }, 5 * 60 * 1000);
  }

  /**
   * 从文件加载配置
   */
  async loadConfig() {
    try {
      const data = await fs.readFile(this.configPath, 'utf8');
      const config = JSON.parse(data);
      
      if (config.slos && Object.keys(config.slos).length > 0) {
        this.slos = { ...DEFAULT_SLOS, ...config.slos };
        this.metrics.sloConfigReloadCounter.inc();
        this.logger.info('SLO config reloaded successfully');
        this.updateMetrics();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.metrics.sloConfigErrorCounter.inc({ error_type: 'load_error' });
        this.logger.error('Failed to load SLO config:', error);
      }
    }
  }

  /**
   * 更新 Prometheus 指标
   */
  updateMetrics() {
    for (const [service, slo] of Object.entries(this.slos)) {
      this.metrics.sloTargetGauge.set({ service }, slo.target);
      const windowDays = parseInt(slo.window);
      this.metrics.sloWindowGauge.set({ service }, windowDays);
    }
  }

  /**
   * 获取服务 SLO 配置
   */
  getSlo(service) {
    return this.slos[service] || null;
  }

  /**
   * 获取所有 SLO 配置
   */
  getAllSlos() {
    return { ...this.slos };
  }

  /**
   * 更新服务 SLO 配置
   */
  async updateSlo(service, config) {
    if (!this.slos[service]) {
      throw new Error(`Unknown service: ${service}`);
    }

    if (config.target && (config.target <= 0 || config.target > 1)) {
      throw new Error('SLO target must be between 0 and 1');
    }

    this.slos[service] = {
      ...this.slos[service],
      ...config
    };

    // 缓存到 Redis
    if (this.redis) {
      await this.redis.hset('slo:configs', service, JSON.stringify(this.slos[service]));
    }

    this.updateMetrics();
    this.logger.info(`SLO updated for ${service}:`, config);
  }

  /**
   * 计算错误预算
   * @param {string} service 服务名
   * @param {number} totalRequests 时间窗口内总请求数
   */
  calculateBudget(service, totalRequests) {
    const slo = this.getSlo(service);
    if (!slo) return null;

    const errorBudget = Math.floor((1 - slo.target) * totalRequests);
    return {
      total: errorBudget,
      window: slo.window,
      target: slo.target
    };
  }

  /**
   * 获取燃尽率阈值
   */
  getBurnRateThresholds() {
    return { ...BURN_RATE_THRESHOLDS };
  }

  /**
   * 获取预算耗尽阈值
   */
  getExhaustionThresholds() {
    return {
      warning: BUDGET_EXHAUSTION_THRESHOLD,
      critical: AUTO_DEGRADATION_THRESHOLD
    };
  }

  /**
   * 计算 SLO 健康状态
   */
  calculateHealth(remainingRatio, burnRate) {
    if (remainingRatio < AUTO_DEGRADATION_THRESHOLD || burnRate > BURN_RATE_THRESHOLDS.fast.rate) {
      return { status: 'critical', action: 'auto_degradation', color: 'red' };
    }
    if (remainingRatio < BUDGET_EXHAUSTION_THRESHOLD || burnRate > BURN_RATE_THRESHOLDS.medium.rate) {
      return { status: 'warning', action: 'throttle', color: 'yellow' };
    }
    if (remainingRatio > 0.5 && burnRate < BURN_RATE_THRESHOLDS.slow.rate) {
      return { status: 'healthy', action: 'none', color: 'green' };
    }
    return { status: 'normal', action: 'monitor', color: 'blue' };
  }

  /**
   * 获取所有服务 SLO 状态摘要
   */
  async getAllSloStatuses() {
    const statuses = {};
    
    for (const service of Object.keys(this.slos)) {
      const slo = this.slos[service];
      statuses[service] = {
        target: slo.target,
        window: slo.window,
        description: slo.description
      };
    }

    return statuses;
  }

  /**
   * 验证 SLO 配置
   */
  validateConfig(service, config) {
    const errors = [];

    if (config.target !== undefined) {
      if (typeof config.target !== 'number' || config.target <= 0 || config.target > 1) {
        errors.push('target must be a number between 0 and 1');
      }
    }

    if (config.window !== undefined) {
      const windowMatch = config.window.match(/^(\d+)d$/);
      if (!windowMatch) {
        errors.push('window must be in format like "30d"');
      } else {
        const days = parseInt(windowMatch[1]);
        if (days < 1 || days > 365) {
          errors.push('window must be between 1 and 365 days');
        }
      }
    }

    return errors.length === 0 ? { valid: true } : { valid: false, errors };
  }

  /**
   * 导出配置（用于保存到文件）
   */
  async exportConfig() {
    return JSON.stringify({ slos: this.slos }, null, 2);
  }

  /**
   * 保存配置到文件
   */
  async saveConfig() {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true });
    await fs.writeFile(this.configPath, await this.exportConfig(), 'utf8');
    this.logger.info('SLO config saved to:', this.configPath);
  }
}

module.exports = { SloManager, DEFAULT_SLOS, BURN_RATE_THRESHOLDS, BUDGET_EXHAUSTION_THRESHOLD, AUTO_DEGRADATION_THRESHOLD };
