// backend/shared/ConfigCenter.js
'use strict';

const { getRedis } = require('./redis');
const { query } = require('./db');
const { createLogger } = require('./logger');

const logger = createLogger('ConfigCenter');

/**
 * 配置中心 - 统一配置管理与热更新系统
 * 
 * 功能：
 * - 配置集中存储（Redis + PostgreSQL）
 * - 配置热更新（无需重启服务）
 * - 配置版本控制与回滚
 * - 配置变更审计日志
 * - 配置订阅与变更通知
 */
class ConfigCenter {
  constructor(options = {}) {
    this.serviceName = options.serviceName || process.env.SERVICE_NAME || 'unknown';
    this.environment = process.env.NODE_ENV || 'development';
    this.localConfig = {};
    this.configVersion = 0;
    this.watchers = new Map();
    this.initialized = false;
    this.redis = null;
    
    // 默认配置
    this.defaultConfigs = {
      rateLimit: { windowMs: 60000, max: 200 },
      circuitBreaker: { failureThreshold: 5, timeout: 60000, resetTimeout: 30000 },
      cache: { defaultTTL: 300, maxSize: 10000 },
      degradation: { cpuThreshold: 85, memoryThreshold: 90 },
      logging: { level: 'info', format: 'json' },
      performance: { slowQueryThreshold: 1000, maxConnections: 100 }
    };
    
    // 初始化
    this.initialize().catch(err => {
      logger.error({ err }, 'ConfigCenter initialization failed');
    });
  }
  
  /**
   * 初始化配置中心
   */
  async initialize() {
    try {
      this.redis = getRedis();
      
      // 加载当前服务的配置
      await this.loadConfig();
      
      // 订阅配置变更通知
      await this.subscribeToChanges();
      
      this.initialized = true;
      logger.info({ 
        service: this.serviceName, 
        env: this.environment,
        version: this.configVersion 
      }, 'ConfigCenter initialized');
      
    } catch (err) {
      logger.error({ err }, 'ConfigCenter initialization error');
      // 使用默认配置继续运行
      this.localConfig = { ...this.defaultConfigs };
      this.initialized = true;
    }
  }
  
  /**
   * 从 Redis 加载配置
   */
  async loadConfig() {
    const redisKey = `config:${this.environment}:${this.serviceName}`;
    
    try {
      const configData = await this.redis.hgetall(redisKey);
      
      if (configData && Object.keys(configData).length > 0) {
        // 解析配置值
        for (const [key, value] of Object.entries(configData)) {
          try {
            this.localConfig[key] = JSON.parse(value);
          } catch {
            this.localConfig[key] = value;
          }
        }
        
        logger.info({ configKeys: Object.keys(this.localConfig) }, 'Config loaded from Redis');
      } else {
        // 使用默认配置
        this.localConfig = { ...this.defaultConfigs };
        logger.info('Using default config');
      }
      
      // 获取当前版本
      const versionKey = `config:version:${this.serviceName}`;
      const version = await this.redis.get(versionKey);
      this.configVersion = version ? parseInt(version, 10) : 0;
      
    } catch (err) {
      logger.error({ err }, 'Failed to load config from Redis');
      this.localConfig = { ...this.defaultConfigs };
    }
  }
  
  /**
   * 订阅配置变更通知
   */
  async subscribeToChanges() {
    const channel = `config:update:${this.serviceName}`;
    
    try {
      // 使用 Redis Pub/Sub 订阅配置变更
      const subscriber = this.redis.duplicate();
      await subscriber.subscribe(channel);
      
      subscriber.on('message', async (ch, message) => {
        if (ch === channel) {
          try {
            const update = JSON.parse(message);
            await this.handleConfigUpdate(update);
          } catch (err) {
            logger.error({ err, message }, 'Failed to handle config update');
          }
        }
      });
      
      logger.info({ channel }, 'Subscribed to config updates');
      
    } catch (err) {
      logger.error({ err }, 'Failed to subscribe to config changes');
    }
  }
  
  /**
   * 获取配置项
   */
  async get(key, defaultValue = null) {
    // 等待初始化完成
    if (!this.initialized) {
      await this.waitForInitialization();
    }
    
    // 先检查本地缓存
    if (this.localConfig[key] !== undefined) {
      return this.localConfig[key];
    }
    
    // 检查默认配置
    if (this.defaultConfigs[key] !== undefined) {
      return this.defaultConfigs[key];
    }
    
    return defaultValue;
  }
  
  /**
   * 同步获取配置（仅本地缓存）
   */
  getSync(key, defaultValue = null) {
    return this.localConfig[key] ?? this.defaultConfigs[key] ?? defaultValue;
  }
  
  /**
   * 获取所有配置
   */
  async getAll() {
    if (!this.initialized) {
      await this.waitForInitialization();
    }
    
    return { ...this.defaultConfigs, ...this.localConfig };
  }
  
  /**
   * 设置配置项（单服务内部）
   */
  async set(key, value, changedBy = 'system') {
    if (!this.redis) {
      throw new Error('Redis not initialized');
    }
    
    const redisKey = `config:${this.environment}:${this.serviceName}`;
    const oldValue = this.localConfig[key];
    
    try {
      // 保存新配置到 Redis
      await this.redis.hset(redisKey, key, JSON.stringify(value));
      
      // 更新版本
      const versionKey = `config:version:${this.serviceName}`;
      const newVersion = await this.redis.incr(versionKey);
      this.configVersion = newVersion;
      
      // 记录变更历史
      await this.recordConfigChange(key, oldValue, value, changedBy, newVersion);
      
      // 发布变更通知
      await this.publishConfigUpdate(key, value, newVersion);
      
      // 更新本地缓存
      this.localConfig[key] = value;
      
      logger.info({ 
        key, 
        oldValue, 
        newValue: value, 
        version: newVersion,
        changedBy 
      }, 'Config updated');
      
      return { success: true, version: newVersion };
      
    } catch (err) {
      logger.error({ err, key }, 'Failed to set config');
      throw err;
    }
  }
  
  /**
   * 批量更新配置
   */
  async updateConfig(newConfig, changedBy = 'system', reason = '') {
    if (!this.redis) {
      throw new Error('Redis not initialized');
    }
    
    const redisKey = `config:${this.environment}:${this.serviceName}`;
    const oldConfig = { ...this.localConfig };
    
    try {
      const pipeline = this.redis.pipeline();
      
      // 批量设置配置
      for (const [key, value] of Object.entries(newConfig)) {
        pipeline.hset(redisKey, key, JSON.stringify(value));
      }
      
      await pipeline.exec();
      
      // 更新版本
      const versionKey = `config:version:${this.serviceName}`;
      const newVersion = await this.redis.incr(versionKey);
      this.configVersion = newVersion;
      
      // 记录批量变更
      await this.recordBatchChange(oldConfig, newConfig, changedBy, newVersion, reason);
      
      // 发布变更通知
      await this.publishConfigUpdate(null, newConfig, newVersion);
      
      // 更新本地缓存
      Object.assign(this.localConfig, newConfig);
      
      logger.info({ 
        keys: Object.keys(newConfig), 
        version: newVersion,
        changedBy,
        reason
      }, 'Config batch updated');
      
      return { success: true, version: newVersion };
      
    } catch (err) {
      logger.error({ err }, 'Failed to batch update config');
      throw err;
    }
  }
  
  /**
   * 删除配置项
   */
  async delete(key, changedBy = 'system') {
    if (!this.redis) {
      throw new Error('Redis not initialized');
    }
    
    const redisKey = `config:${this.environment}:${this.serviceName}`;
    const oldValue = this.localConfig[key];
    
    try {
      await this.redis.hdel(redisKey, key);
      
      // 更新版本
      const versionKey = `config:version:${this.serviceName}`;
      const newVersion = await this.redis.incr(versionKey);
      
      // 记录变更
      await this.recordConfigChange(key, oldValue, null, changedBy, newVersion, 'delete');
      
      // 删除本地缓存
      delete this.localConfig[key];
      
      logger.info({ key, oldValue, version: newVersion, changedBy }, 'Config deleted');
      
      return { success: true, version: newVersion };
      
    } catch (err) {
      logger.error({ err, key }, 'Failed to delete config');
      throw err;
    }
  }
  
  /**
   * 订阅配置变更
   */
  subscribe(key, callback) {
    if (!this.watchers.has(key)) {
      this.watchers.set(key, new Set());
    }
    this.watchers.get(key).add(callback);
    
    // 返回取消订阅函数
    return () => {
      this.watchers.get(key)?.delete(callback);
    };
  }
  
  /**
   * 处理配置变更通知
   */
  async handleConfigUpdate(update) {
    const { key, value, version, type = 'set' } = update;
    
    logger.info({ key, version, type }, 'Received config update');
    
    // 更新本地版本
    this.configVersion = version;
    
    // 更新本地配置
    if (type === 'delete') {
      delete this.localConfig[key];
    } else {
      this.localConfig[key] = value;
    }
    
    // 触发订阅回调
    const callbacks = this.watchers.get(key) || new Set();
    const globalCallbacks = this.watchers.get('*') || new Set();
    
    for (const callback of [...callbacks, ...globalCallbacks]) {
      try {
        await callback(key, value, type);
      } catch (err) {
        logger.error({ err, key }, 'Config callback error');
      }
    }
  }
  
  /**
   * 发布配置变更通知
   */
  async publishConfigUpdate(key, value, version) {
    const channel = `config:update:${this.serviceName}`;
    const message = JSON.stringify({
      key,
      value,
      version,
      type: key ? 'set' : 'batch',
      timestamp: new Date().toISOString()
    });
    
    try {
      await this.redis.publish(channel, message);
      logger.debug({ channel, key, version }, 'Config update published');
    } catch (err) {
      logger.error({ err, channel }, 'Failed to publish config update');
    }
  }
  
  /**
   * 记录配置变更历史
   */
  async recordConfigChange(key, oldValue, newValue, changedBy, version, type = 'set') {
    try {
      const historyKey = `config:history:${this.environment}:${this.serviceName}`;
      const entry = {
        version,
        type,
        key,
        oldValue,
        newValue,
        changedBy,
        changedAt: new Date().toISOString()
      };
      
      // 添加到列表头部
      await this.redis.lpush(historyKey, JSON.stringify(entry));
      
      // 保留最近 100 个版本
      await this.redis.ltrim(historyKey, 0, 99);
      
    } catch (err) {
      logger.error({ err, key }, 'Failed to record config change');
    }
  }
  
  /**
   * 记录批量变更
   */
  async recordBatchChange(oldConfig, newConfig, changedBy, version, reason) {
    try {
      const historyKey = `config:history:${this.environment}:${this.serviceName}`;
      const entry = {
        version,
        type: 'batch',
        oldConfig,
        newConfig,
        changedBy,
        reason,
        changedAt: new Date().toISOString()
      };
      
      await this.redis.lpush(historyKey, JSON.stringify(entry));
      await this.redis.ltrim(historyKey, 0, 99);
      
    } catch (err) {
      logger.error({ err }, 'Failed to record batch change');
    }
  }
  
  /**
   * 获取配置历史
   */
  async getHistory(limit = 20) {
    if (!this.redis) {
      return [];
    }
    
    try {
      const historyKey = `config:history:${this.environment}:${this.serviceName}`;
      const history = await this.redis.lrange(historyKey, 0, limit - 1);
      
      return history.map(h => JSON.parse(h));
      
    } catch (err) {
      logger.error({ err }, 'Failed to get config history');
      return [];
    }
  }
  
  /**
   * 回滚到指定版本
   */
  async rollback(targetVersion, changedBy = 'system') {
    if (!this.redis) {
      throw new Error('Redis not initialized');
    }
    
    try {
      const history = await this.getHistory(100);
      const targetEntry = history.find(h => h.version === targetVersion);
      
      if (!targetEntry) {
        throw new Error(`Config version ${targetVersion} not found`);
      }
      
      // 恢复配置
      const configToRestore = targetEntry.type === 'batch' 
        ? targetEntry.newConfig 
        : { [targetEntry.key]: targetEntry.newValue };
      
      await this.updateConfig(configToRestore, changedBy, `Rollback to version ${targetVersion}`);
      
      logger.info({ targetVersion, changedBy }, 'Config rolled back');
      
      return { success: true, version: this.configVersion };
      
    } catch (err) {
      logger.error({ err, targetVersion }, 'Failed to rollback config');
      throw err;
    }
  }
  
  /**
   * 等待初始化完成
   */
  async waitForInitialization(timeout = 5000) {
    const start = Date.now();
    
    while (!this.initialized && (Date.now() - start) < timeout) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    if (!this.initialized) {
      logger.warn('ConfigCenter initialization timeout, using defaults');
      this.localConfig = { ...this.defaultConfigs };
      this.initialized = true;
    }
  }
  
  /**
   * 获取当前版本
   */
  getVersion() {
    return this.configVersion;
  }
  
  /**
   * 健康检查
   */
  async healthCheck() {
    try {
      if (!this.redis) {
        return { status: 'degraded', reason: 'Redis not available' };
      }
      
      await this.redis.ping();
      
      return {
        status: 'healthy',
        service: this.serviceName,
        environment: this.environment,
        version: this.configVersion,
        configKeys: Object.keys(this.localConfig).length
      };
      
    } catch (err) {
      return { status: 'unhealthy', error: err.message };
    }
  }
}

// 单例模式
let configCenterInstance = null;

/**
 * 获取配置中心单例
 */
function getConfigCenter(options = {}) {
  if (!configCenterInstance) {
    configCenterInstance = new ConfigCenter(options);
  }
  return configCenterInstance;
}

/**
 * 配置中间件 - 自动注入配置到请求
 */
function configMiddleware(configCenter) {
  return async (req, res, next) => {
    req.config = configCenter;
    next();
  };
}

module.exports = {
  ConfigCenter,
  getConfigCenter,
  configMiddleware
};
