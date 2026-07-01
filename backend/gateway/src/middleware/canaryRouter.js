/**
 * 金丝雀流量路由中间件
 * 
 * 支持多种分流策略：
 * 1. 百分比分流：随机 x% 流量到新版本
 * 2. Header 分流：X-Canary: true 的请求到新版本
 * 3. 用户特征分流：VIP 用户、特定地区等
 * 4. Cookie 分流：特定 Cookie 值的请求
 * 
 * @module canaryRouter
 */

const { db } = require('../../../shared/db');
const { logger } = require('../../../shared/logger');
const {
  canaryTrafficGauge,
  canaryRequestsTotal,
  canaryDeploymentStatus
} = require('../../../shared/canaryMetrics');

class CanaryRouter {
  constructor() {
    /** 金丝雀配置缓存 service -> config */
    this.canaryConfigs = new Map();
    /** 配置刷新间隔 ms */
    this.refreshInterval = 5000;
    /** 服务路径映射 */
    this.pathMap = {
      '/api/catch': 'catch-service',
      '/api/users': 'user-service',
      '/api/pokemon': 'pokemon-service',
      '/api/location': 'location-service',
      '/api/gym': 'gym-service',
      '/api/social': 'social-service',
      '/api/reward': 'reward-service',
      '/api/payment': 'payment-service'
    };
    /** 初始化状态 */
    this.initialized = false;
  }

  /**
   * 初始化金丝雀配置
   */
  async initialize() {
    try {
      await this.loadConfigs();
      this.startRefreshLoop();
      this.initialized = true;
      logger.info('[CanaryRouter] Initialized successfully');
    } catch (error) {
      logger.error('[CanaryRouter] Initialization failed:', error);
    }
  }

  /**
   * 加载所有活跃的金丝雀发布配置
   */
  async loadConfigs() {
    const result = await db.query(`
      SELECT * FROM canary_deployments 
      WHERE status IN ('active', 'promoting')
      ORDER BY created_at DESC
    `);

    // 清空旧配置
    this.canaryConfigs.clear();

    for (const row of result.rows) {
      this.canaryConfigs.set(row.service_name, {
        id: row.id,
        canaryVersion: row.canary_version,
        stableVersion: row.stable_version,
        trafficSplit: row.traffic_split,
        strategy: row.strategy,
        rules: row.rules || {},
        startTime: row.started_at,
        metricsBaseline: row.metrics_baseline || {}
      });

      // 更新 Prometheus 指标
      canaryTrafficGauge.set(
        { service: row.service_name, canary_version: row.canary_version },
        row.traffic_split
      );
      canaryDeploymentStatus.set({ service: row.service_name }, 1);
    }

    logger.debug(`[CanaryRouter] Loaded ${result.rows.length} active canary deployments`);
  }

  /**
   * 启动配置刷新循环
   */
  startRefreshLoop() {
    setInterval(async () => {
      try {
        await this.refreshConfigs();
      } catch (error) {
        logger.error('[CanaryRouter] Config refresh failed:', error);
      }
    }, this.refreshInterval);
  }

  /**
   * 刷新配置（增量更新）
   */
  async refreshConfigs() {
    const result = await db.query(`
      SELECT * FROM canary_deployments 
      WHERE status IN ('active', 'promoting', 'rolled_back', 'completed')
        AND updated_at > NOW() - INTERVAL '10 seconds'
    `);

    for (const row of result.rows) {
      if (row.status === 'rolled_back' || row.status === 'completed') {
        // 移除已结束的金丝雀发布
        this.canaryConfigs.delete(row.service_name);
        canaryDeploymentStatus.set({ service: row.service_name }, 
          row.status === 'rolled_back' ? 4 : 3);
        logger.info(`[CanaryRouter] Removed canary for ${row.service_name}: ${row.status}`);
      } else {
        // 更新活跃配置
        this.canaryConfigs.set(row.service_name, {
          id: row.id,
          canaryVersion: row.canary_version,
          stableVersion: row.stable_version,
          trafficSplit: row.traffic_split,
          strategy: row.strategy,
          rules: row.rules || {},
          startTime: row.started_at,
          metricsBaseline: row.metrics_baseline || {}
        });

        canaryTrafficGauge.set(
          { service: row.service_name, canary_version: row.canary_version },
          row.traffic_split
        );
      }
    }
  }

  /**
   * 流量路由中间件
   */
  middleware() {
    return async (req, res, next) => {
      if (!this.initialized) {
        req.targetVersion = 'stable';
        return next();
      }

      const serviceName = this.getTargetService(req.path);

      if (!serviceName) {
        req.targetVersion = 'stable';
        return next();
      }

      const config = this.canaryConfigs.get(serviceName);

      if (!config) {
        // 没有金丝雀发布，走稳定版本
        req.targetVersion = 'stable';
        return next();
      }

      // 决定是否路由到金丝雀版本
      const shouldRouteToCanary = this.shouldRouteToCanary(req, config);

      if (shouldRouteToCanary) {
        req.targetVersion = 'canary';
        req.canaryVersion = config.canaryVersion;
        req.canaryDeploymentId = config.id;

        // 添加金丝雀追踪 Header
        res.setHeader('X-Canary', 'true');
        res.setHeader('X-Canary-Version', config.canaryVersion);
        res.setHeader('X-Canary-Deployment', config.id);

        // 记录请求
        canaryRequestsTotal.increment({ 
          service: serviceName, 
          canary_version: config.canaryVersion, 
          status: 'started' 
        });
      } else {
        req.targetVersion = 'stable';
      }

      // 保存金丝雀信息供后续使用
      req.canaryContext = {
        service: serviceName,
        deploymentId: config.id,
        targetVersion: req.targetVersion
      };

      next();
    };
  }

  /**
   * 判断是否路由到金丝雀版本
   * @param {Request} req Express 请求对象
   * @param {Object} config 金丝雀配置
   * @returns {boolean} 是否路由到金丝雀
   */
  shouldRouteToCanary(req, config) {
    const strategy = config.strategy;

    // 策略 1: 强制金丝雀（测试用）
    if (strategy === 'force-canary') {
      return true;
    }

    // 策略 2: Header 分流
    if (strategy === 'header') {
      return req.headers['x-canary'] === 'true';
    }

    // 策略 3: Cookie 分流
    if (strategy === 'cookie') {
      const cookieValue = req.cookies?.[config.rules.cookieName];
      return cookieValue === config.rules.cookieValue;
    }

    // 策略 4: 用户特征分流
    if (strategy === 'user-segment') {
      return this.matchUserSegment(req, config.rules);
    }

    // 策略 5: 百分比分流（默认）
    const percentage = config.trafficSplit;
    if (percentage <= 0) return false;
    if (percentage >= 100) return true;

    // 使用用户 ID 或 Session ID 做一致性哈希
    const hashKey = req.user?.id || req.sessionID || req.ip || req.headers['x-request-id'] || 'unknown';
    const hash = this.hashString(hashKey);

    // 相同用户始终路由到同一版本（一致性）
    return (hash % 100) < percentage;
  }

  /**
   * 匹配用户特征规则
   */
  matchUserSegment(req, rules) {
    const user = req.user;
    if (!user) return false;

    // VIP 用户分流
    if (rules.vipOnly && user.isVip) {
      return true;
    }

    // 特定用户 ID 分流
    if (rules.userIds?.length > 0) {
      return rules.userIds.includes(user.id);
    }

    // 特定地区分流
    if (rules.regions?.length > 0) {
      const userRegion = user.region || req.headers['x-user-region'] || 'unknown';
      return rules.regions.includes(userRegion);
    }

    // 特定等级分流
    if (rules.minLevel !== undefined) {
      return user.level >= rules.minLevel;
    }

    // Beta 用户分流
    if (rules.betaUsers && user.isBetaTester) {
      return true;
    }

    return false;
  }

  /**
   * 字符串哈希（简单一致性哈希）
   */
  hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) + hash) + char; // hash * 33 + char
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * 获取目标服务名
   */
  getTargetService(path) {
    for (const [prefix, service] of Object.entries(this.pathMap)) {
      if (path.startsWith(prefix)) {
        return service;
      }
    }
    return null;
  }

  /**
   * 获取所有活跃金丝雀配置
   */
  getActiveConfigs() {
    const configs = [];
    for (const [service, config] of this.canaryConfigs) {
      configs.push({ service, ...config });
    }
    return configs;
  }

  /**
   * 检查服务是否有活跃金丝雀
   */
  hasActiveCanary(serviceName) {
    return this.canaryConfigs.has(serviceName);
  }
}

// 单例导出
const canaryRouter = new CanaryRouter();

module.exports = canaryRouter;