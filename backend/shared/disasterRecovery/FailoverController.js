const { EventEmitter } = require('events');
const { logger, metrics } = require('../logging');
const Redis = require('ioredis');
const axios = require('axios');

/**
 * 故障切换控制器 - 多区域容灾切换系统核心组件
 * 负责执行故障切换、回切、状态管理
 */
class FailoverController extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      primaryRegion: config.primaryRegion || process.env.PRIMARY_REGION || 'cn-east-1',
      secondaryRegion: config.secondaryRegion || process.env.SECONDARY_REGION || 'cn-north-1',
      currentRegion: config.currentRegion || process.env.REGION || 'cn-east-1',
      autoFailover: config.autoFailover !== false,
      cooldownPeriod: config.cooldownPeriod || 300000, // 5 minutes
      dnsTTL: config.dnsTTL || 30,
      ...config
    };
    
    this.state = {
      activeRegion: this.config.currentRegion,
      isFailingOver: false,
      lastFailover: null,
      failoverHistory: []
    };
    
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    this.lockKey = 'dr:failover:lock';
    this.stateKey = 'dr:failover:state';
    
    this.registerMetrics();
  }
  
  registerMetrics() {
    if (metrics && metrics.gauge) {
      metrics.gauge('dr_active_region', 'Current active region (1=primary, 2=secondary)');
      metrics.gauge('dr_failover_in_progress', 'Failover in progress flag');
      metrics.counter('dr_failover_operations_total', 'Failover operations count', 
        ['from_region', 'to_region', 'trigger', 'result']);
    }
  }
  
  /**
   * 初始化控制器
   */
  async initialize() {
    try {
      // 从 Redis 恢复状态
      const savedState = await this.redis.get(this.stateKey);
      if (savedState) {
        this.state = JSON.parse(savedState);
        logger.info('Failover state restored from Redis', { state: this.state });
      }
      
      // 更新指标
      this.updateMetrics();
    } catch (error) {
      logger.warn('Failed to restore failover state from Redis', { error: error.message });
    }
  }
  
  /**
   * 执行故障切换
   */
  async failover(options = {}) {
    const { trigger = 'manual', force = false, reason = '' } = options;
    
    // 获取分布式锁
    const lock = await this.acquireLock();
    if (!lock && !force) {
      throw new Error('Failover already in progress or within cooldown period');
    }
    
    try {
      this.state.isFailingOver = true;
      this.updateMetrics();
      
      const fromRegion = this.state.activeRegion;
      const toRegion = fromRegion === this.config.primaryRegion 
        ? this.config.secondaryRegion 
        : this.config.primaryRegion;
      
      logger.info('Starting failover', {
        fromRegion,
        toRegion,
        trigger,
        reason,
        force
      });
      
      // 执行故障切换步骤
      const steps = [
        { name: 'verify-target-health', fn: () => this.verifyTargetHealth(toRegion) },
        { name: 'stop-traffic-primary', fn: () => this.stopTraffic(fromRegion) },
        { name: 'sync-data', fn: () => this.syncData(fromRegion, toRegion) },
        { name: 'promote-secondary', fn: () => this.promoteSecondary(toRegion) },
        { name: 'update-dns', fn: () => this.updateDNS(toRegion) },
        { name: 'verify-service', fn: () => this.verifyService(toRegion) },
        { name: 'update-state', fn: () => this.updateState(toRegion) }
      ];
      
      const results = [];
      
      for (const step of steps) {
        const startTime = Date.now();
        
        try {
          await step.fn();
          results.push({
            step: step.name,
            success: true,
            duration: Date.now() - startTime
          });
          
          this.emit('failover-step', { step: step.name, success: true });
        } catch (error) {
          results.push({
            step: step.name,
            success: false,
            error: error.message,
            duration: Date.now() - startTime
          });
          
          // 回滚
          logger.error('Failover step failed, initiating rollback', {
            step: step.name,
            error: error.message
          });
          
          await this.rollback(fromRegion, results);
          throw error;
        }
      }
      
      // 记录成功
      const failoverRecord = {
        timestamp: new Date().toISOString(),
        fromRegion,
        toRegion,
        trigger,
        reason,
        duration: results.reduce((sum, r) => sum + r.duration, 0),
        steps: results
      };
      
      this.state.failoverHistory.push(failoverRecord);
      this.state.lastFailover = failoverRecord;
      this.state.activeRegion = toRegion;
      this.state.isFailingOver = false;
      
      await this.saveState();
      this.updateMetrics();
      
      if (metrics && metrics.counter) {
        metrics.counter('dr_failover_operations_total').inc(
          { from_region: fromRegion, to_region: toRegion, trigger, result: 'success' }
        );
      }
      
      logger.info('Failover completed successfully', { failoverRecord });
      this.emit('failover-complete', failoverRecord);
      
      return failoverRecord;
      
    } catch (error) {
      this.state.isFailingOver = false;
      this.updateMetrics();
      
      if (metrics && metrics.counter) {
        metrics.counter('dr_failover_operations_total').inc(
          { from_region: fromRegion, to_region: toRegion, trigger, result: 'failed' }
        );
      }
      
      logger.error('Failover failed', { error: error.message });
      this.emit('failover-failed', { error: error.message });
      
      throw error;
    } finally {
      if (lock) {
        await this.releaseLock(lock);
      }
    }
  }
  
  /**
   * 获取分布式锁
   */
  async acquireLock() {
    try {
      const lockValue = `${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
      const acquired = await this.redis.set(
        this.lockKey, 
        lockValue, 
        'PX', 
        this.config.cooldownPeriod, 
        'NX'
      );
      
      return acquired === 'OK' ? lockValue : null;
    } catch (error) {
      logger.warn('Failed to acquire lock', { error: error.message });
      return null;
    }
  }
  
  /**
   * 释放分布式锁
   */
  async releaseLock(lockValue) {
    try {
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      
      await this.redis.eval(script, 1, this.lockKey, lockValue);
    } catch (error) {
      logger.warn('Failed to release lock', { error: error.message });
    }
  }
  
  /**
   * 验证目标区域健康状态
   */
  async verifyTargetHealth(region) {
    const endpoints = this.getRegionEndpoints(region);
    
    for (const endpoint of endpoints) {
      try {
        const response = await axios.get(`${endpoint}/health`, { timeout: 5000 });
        
        if (response.data?.status !== 'healthy') {
          throw new Error(`Unhealthy endpoint: ${endpoint}`);
        }
      } catch (error) {
        throw new Error(`Target region health check failed: ${error.message}`);
      }
    }
    
    logger.info('Target region health verified', { region });
  }
  
  /**
   * 停止流量
   */
  async stopTraffic(region) {
    logger.info('Stopping traffic', { region });
    
    // 模拟停止流量操作
    // 实际实现需要调用 Kubernetes API 或负载均衡器 API
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    logger.info('Traffic stopped', { region });
  }
  
  /**
   * 同步数据
   */
  async syncData(fromRegion, toRegion) {
    logger.info('Syncing data', { fromRegion, toRegion });
    
    // 检查数据库同步延迟
    const dbLag = await this.getDatabaseSyncLag();
    
    if (dbLag > 60000) { // 60秒
      throw new Error(`Database sync lag too high: ${dbLag}ms`);
    }
    
    logger.info('Data synced', { fromRegion, toRegion, dbLag });
  }
  
  /**
   * 提升备库为主库
   */
  async promoteSecondary(region) {
    logger.info('Promoting secondary to primary', { region });
    
    // 模拟提升操作
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    logger.info('Secondary promoted to primary', { region });
  }
  
  /**
   * 更新 DNS
   */
  async updateDNS(region) {
    logger.info('Updating DNS', { region });
    
    // 模拟 DNS 更新
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    logger.info('DNS updated', { region });
  }
  
  /**
   * 验证服务
   */
  async verifyService(region) {
    const endpoint = process.env.API_ENDPOINT || 'https://api.minego.com';
    
    const maxRetries = 10;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await axios.get(`${endpoint}/health`, { timeout: 5000 });
        
        if (response.data?.status === 'healthy') {
          logger.info('Service verified', { region, endpoint });
          return;
        }
      } catch (error) {
        // 继续重试
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    throw new Error('Service verification failed');
  }
  
  /**
   * 更新状态
   */
  async updateState(region) {
    this.state.activeRegion = region;
    await this.saveState();
    
    logger.info('State updated', { activeRegion: region });
  }
  
  /**
   * 回滚
   */
  async rollback(fromRegion, completedSteps) {
    logger.info('Starting rollback', { targetRegion: fromRegion });
    
    // 按相反顺序执行回滚步骤
    const rollbackSteps = completedSteps
      .filter(r => r.success)
      .reverse()
      .map(r => r.step);
    
    for (const step of rollbackSteps) {
      try {
        await this.executeRollbackStep(step, fromRegion);
        logger.info('Rollback step completed', { step });
      } catch (error) {
        logger.error('Rollback step failed', { step, error: error.message });
      }
    }
    
    this.state.activeRegion = fromRegion;
    await this.saveState();
  }
  
  /**
   * 执行回滚步骤
   */
  async executeRollbackStep(step, region) {
    switch (step) {
      case 'update-dns':
        await this.updateDNS(region);
        break;
      case 'stop-traffic-primary':
        await this.restoreTraffic(region);
        break;
      default:
        logger.info('No rollback action for step', { step });
    }
  }
  
  /**
   * 恢复流量
   */
  async restoreTraffic(region) {
    logger.info('Restoring traffic', { region });
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  /**
   * 保存状态到 Redis
   */
  async saveState() {
    try {
      await this.redis.set(
        this.stateKey, 
        JSON.stringify(this.state),
        'EX',
        86400 // 1 day
      );
    } catch (error) {
      logger.warn('Failed to save state to Redis', { error: error.message });
    }
  }
  
  /**
   * 更新指标
   */
  updateMetrics() {
    if (metrics && metrics.gauge) {
      metrics.gauge('dr_active_region').set(
        this.state.activeRegion === this.config.primaryRegion ? 1 : 2
      );
      metrics.gauge('dr_failover_in_progress').set(this.state.isFailingOver ? 1 : 0);
    }
  }
  
  /**
   * 获取区域端点
   */
  getRegionEndpoints(region) {
    const endpoints = {
      'cn-east-1': [
        process.env.USER_SERVICE_URL || 'http://user-service:8080',
        process.env.POKEMON_SERVICE_URL || 'http://pokemon-service:8080',
        process.env.CATCH_SERVICE_URL || 'http://catch-service:8080'
      ],
      'cn-north-1': [
        process.env.USER_SERVICE_URL_SECONDARY || 'http://user-service-secondary:8080',
        process.env.POKEMON_SERVICE_URL_SECONDARY || 'http://pokemon-service-secondary:8080',
        process.env.CATCH_SERVICE_URL_SECONDARY || 'http://catch-service-secondary:8080'
      ]
    };
    
    return endpoints[region] || [];
  }
  
  /**
   * 获取数据库同步延迟
   */
  async getDatabaseSyncLag() {
    // 模拟返回同步延迟
    // 实际实现需要查询 PostgreSQL 复制状态
    return 1000; // 1秒
  }
  
  /**
   * 获取当前状态
   */
  getState() {
    return {
      ...this.state,
      config: {
        primaryRegion: this.config.primaryRegion,
        secondaryRegion: this.config.secondaryRegion,
        autoFailover: this.config.autoFailover
      }
    };
  }
}

module.exports = FailoverController;
