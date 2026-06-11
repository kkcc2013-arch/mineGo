/**
 * 金丝雀流量路由中间件
 * 
 * 支持多种分流策略：
 * 1. 百分比分流：随机 5% 流量到新版本
 * 2. Header 分流：X-Canary: true 的请求到新版本
 * 3. 用户特征分流：VIP 用户、特定地区等
 * 4. Cookie 分流：特定 Cookie 值的请求
 */

const logger = require('../../../shared/logger');
const { db } = require('../../../shared/db');

class CanaryRouter {
  constructor() {
    /**
     * 金丝雀配置缓存
     * Map<serviceName, config>
     */
    this.canaryConfigs = new Map();
    
    /**
     * 上次刷新时间
     */
    this.lastRefresh = 0;
    
    /**
     * 刷新间隔（毫秒）
     */
    this.refreshInterval = 5000; // 5 秒
    
    /**
     * 路径到服务的映射
     */
    this.pathServiceMap = {
      '/api/catch': 'catch-service',
      '/api/users': 'user-service',
      '/api/pokemon': 'pokemon-service',
      '/api/location': 'location-service',
      '/api/gym': 'gym-service',
      '/api/social': 'social-service',
      '/api/reward': 'reward-service',
      '/api/payment': 'payment-service'
    };
    
    // 初始化
    this.initialize();
  }
  
  /**
   * 初始化金丝雀配置
   */
  async initialize() {
    try {
      await this.refreshConfigs();
      
      // 定期刷新配置
      setInterval(() => {
        this.refreshConfigs().catch(err => {
          logger.error('Failed to refresh canary configs', { error: err.message });
        });
      }, this.refreshInterval);
      
      logger.info('Canary router initialized');
    } catch (error) {
      logger.error('Failed to initialize canary router', { error: error.message });
    }
  }
  
  /**
   * 刷新配置
   */
  async refreshConfigs() {
    const now = Date.now();
    
    // 避免频繁刷新
    if (now - this.lastRefresh < this.refreshInterval) {
      return;
    }
    
    this.lastRefresh = now;
    
    try {
      // 从数据库加载所有活跃的金丝雀发布
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
      }
      
      if (result.rows.length > 0) {
        logger.debug('Refreshed canary configs', { 
          count: result.rows.length,
          services: result.rows.map(r => r.service_name)
        });
      }
    } catch (error) {
      logger.error('Error refreshing canary configs', { error: error.message });
    }
  }
  
  /**
   * 流量路由中间件
   */
  middleware() {
    return async (req, res, next) => {
      try {
        const serviceName = this.getTargetService(req.path);
        
        if (!serviceName) {
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
          res.setHeader('X-Canary-Deployment-Id', config.id.toString());
        } else {
          req.targetVersion = 'stable';
          res.setHeader('X-Canary', 'false');
        }
        
        next();
      } catch (error) {
        logger.error('Canary router error', { 
          error: error.message, 
          path: req.path 
        });
        // 出错时走稳定版本
        req.targetVersion = 'stable';
        next();
      }
    };
  }
  
  /**
   * 判断是否路由到金丝雀版本
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
      const cookieName = config.rules.cookieName || 'canary';
      const cookieValue = config.rules.cookieValue || 'true';
      
      // 解析 Cookie
      const cookies = this.parseCookies(req);
      return cookies[cookieName] === cookieValue;
    }
    
    // 策略 4: 用户特征分流
    if (strategy === 'user-segment') {
      const user = req.user;
      if (!user) return false;
      
      // VIP 用户分流
      if (config.rules.vipOnly && user.isVip) {
        return true;
      }
      
      // 特定用户 ID 分流
      if (config.rules.userIds && Array.isArray(config.rules.userIds)) {
        if (config.rules.userIds.includes(user.id)) {
          return true;
        }
      }
      
      // 特定地区分流
      if (config.rules.regions && Array.isArray(config.rules.regions)) {
        const userRegion = user.region || user.country || 'unknown';
        if (config.rules.regions.includes(userRegion)) {
          return true;
        }
      }
      
      return false;
    }
    
    // 策略 5: 百分比分流（默认）
    if (strategy === 'progressive' || strategy === 'auto' || strategy === 'manual' || !strategy) {
      const percentage = config.trafficSplit;
      
      if (percentage === 0) return false;
      if (percentage === 100) return true;
      
      // 使用用户 ID 或 Session ID 做一致性哈希
      const hashKey = req.user?.id || req.sessionID || req.ip || 'anonymous';
      const hash = this.hashString(String(hashKey));
      
      // 相同用户始终路由到同一版本（一致性）
      return (hash % 100) < percentage;
    }
    
    return false;
  }
  
  /**
   * 字符串哈希
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }
  
  /**
   * 解析 Cookie
   */
  parseCookies(req) {
    const cookies = {};
    const cookieHeader = req.headers.cookie;
    
    if (cookieHeader) {
      cookieHeader.split(';').forEach(cookie => {
        const [name, value] = cookie.trim().split('=');
        if (name && value) {
          cookies[name] = value;
        }
      });
    }
    
    return cookies;
  }
  
  /**
   * 获取目标服务名
   */
  getTargetService(path) {
    for (const [prefix, service] of Object.entries(this.pathServiceMap)) {
      if (path.startsWith(prefix)) {
        return service;
      }
    }
    return null;
  }
  
  /**
   * 获取当前配置
   */
  getConfigs() {
    const configs = {};
    for (const [service, config] of this.canaryConfigs.entries()) {
      configs[service] = config;
    }
    return configs;
  }
  
  /**
   * 手动刷新配置
   */
  async manualRefresh() {
    this.lastRefresh = 0;
    await this.refreshConfigs();
    return this.getConfigs();
  }
}

// 导出单例
const canaryRouter = new CanaryRouter();

module.exports = canaryRouter;
