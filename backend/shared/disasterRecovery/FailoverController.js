/**
 * FailoverController - 容灾切换控制器
 * 
 * 功能：
 * - 管理主备区域切换
 * - 执行故障切换流程
 * - 维护切换状态和历史
 * - 支持手动/自动切换
 */

const { EventEmitter } = require('events');

class FailoverController extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      primaryRegion: config.primaryRegion || 'cn-east-1',
      secondaryRegion: config.secondaryRegion || 'cn-north-1',
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
    
    this.redis = null;
    this.lockKey = 'dr:failover:lock';
    this.stateKey = 'dr:failover:state';
    this.metrics = null;
    
    this.initializeRedis();
    this.registerMetrics();
  }
  
  /**
   * 初始化 Redis 连接
   */
  async initializeRedis() {
    try {
      const Redis = require('ioredis');
      if (process.env.REDIS_URL) {
        this.redis = new Redis(process.env.REDIS_URL);
      }
    } catch (e) {
      // Redis may not be available in test environment
    }
  }
  
  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    try {
      const { metrics } = require('../logging');
      this.metrics = metrics;
      
      if (!metrics._registered_dr_active_region) {
        metrics.gauge('dr_active_region', 'Current active region (1=primary, 2=secondary)');
        metrics._registered_dr_active_region = true;
      }
      
      if (!metrics._registered_dr_failover_in_progress) {
        metrics.gauge('dr_failover_in_progress', 'Failover in progress flag');
        metrics._registered_dr_failover_in_progress = true;
      }
      
      if (!metrics._registered_dr_failover_operations_total) {
        metrics.counter('dr_failover_operations_total', 'Failover operations count', 
          ['from_region', 'to_region', 'trigger', 'result']);
        metrics._registered_dr_failover_operations_total = true;
      }
    } catch (e) {
      // metrics may not be available
    }
  }
  
  /**
   * 初始化（从 Redis 恢复状态）
   */
  async initialize() {
    if (this.redis) {
      try {
        const savedState = await this.redis.get(this.stateKey);
        if (savedState) {
          this.state = JSON.parse(savedState);
          console.log('[FailoverController] State restored from Redis');
        }
      } catch (e) {
        console.error('[FailoverController] Failed to restore state:', e.message);
      }
    }
    
    this.updateMetrics();
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
      
      console.log('[FailoverController] Starting failover:', {
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
        { name: 'update-state', fn: () => this.updateActiveRegion(toRegion) }
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
          
          console.log('[FailoverController] Step completed:', step.name);
        } catch (error) {
          results.push({
            step: step.name,
            success: false,
            error: error.message,
            duration: Date.now() - startTime
          });
          
          console.error('[FailoverController] Step failed:', step.name, error.message);
          
          // 回滚
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
      
      this.recordFailoverMetric(fromRegion, toRegion, trigger, 'success');
      
      console.log('[FailoverController] Failover completed:', failoverRecord);
      this.emit('failover-complete', failoverRecord);
      
      return failoverRecord;
      
    } catch (error) {
      this.state.isFailingOver = false;
      this.updateMetrics();
      
      const fromRegion = this.state.activeRegion;
      const toRegion = fromRegion === this.config.primaryRegion 
        ? this.config.secondaryRegion 
        : this.config.primaryRegion;
      
      this.recordFailoverMetric(fromRegion, toRegion, trigger, 'failed');
      
      console.error('[FailoverController] Failover failed:', error.message);
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
    if (!this.redis) {
      // 模拟锁
      return `lock-${Date.now()}`;
    }
    
    const lockValue = `${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
    const acquired = await this.redis.set(
      this.lockKey, 
      lockValue, 
      'PX', 
      this.config.cooldownPeriod, 
      'NX'
    );
    
    return acquired === 'OK' ? lockValue : null;
  }
  
  /**
   * 释放分布式锁
   */
  async releaseLock(lockValue) {
    if (!this.redis) return;
    
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    
    await this.redis.eval(script, 1, this.lockKey, lockValue);
  }
  
  /**
   * 验证目标区域健康状态
   */
  async verifyTargetHealth(region) {
    // 模拟健康检查
    console.log('[FailoverController] Verifying target health:', region);
    
    // 在生产环境中，这里会调用 HealthChecker 检查目标区域的服务
    // 目前模拟成功
    return true;
  }
  
  /**
   * 停止主区域流量
   */
  async stopTraffic(region) {
    console.log('[FailoverController] Stopping traffic to region:', region);
    
    // 在生产环境中，这里会：
    // 1. 更新 Kubernetes Service 注解
    // 2. 修改负载均衡器权重
    // 3. 等待现有连接排空
    
    // 模拟等待流量排空
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    return true;
  }
  
  /**
   * 同步数据
   */
  async syncData(fromRegion, toRegion) {
    console.log('[FailoverController] Syncing data from', fromRegion, 'to', toRegion);
    
    // 在生产环境中，这里会：
    // 1. 检查数据库同步延迟
    // 2. 强制 WAL 切换
    // 3. 等待备库同步完成
    // 4. 同步 Redis 数据
    
    // 模拟数据同步
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return true;
  }
  
  /**
   * 提升备库为主库
   */
  async promoteSecondary(region) {
    console.log('[FailoverController] Promoting secondary to primary:', region);
    
    // 在生产环境中，这里会：
    // 1. 执行 PostgreSQL promote 命令
    // 2. 更新数据库连接配置
    // 3. 验证数据库可写
    
    // 模拟提升
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    return true;
  }
  
  /**
   * 更新 DNS 记录
   */
  async updateDNS(region) {
    console.log('[FailoverController] Updating DNS to region:', region);
    
    // 在生产环境中，这里会：
    // 1. 调用 DNS API 更新 A 记录
    // 2. 降低 TTL 加速传播
    // 3. 等待 DNS 传播
    
    // 模拟 DNS 更新
    await new Promise(resolve => setTimeout(resolve, this.config.dnsTTL * 1000));
    
    return true;
  }
  
  /**
   * 验证服务可用
   */
  async verifyService(region) {
    console.log('[FailoverController] Verifying service in region:', region);
    
    // 在生产环境中，这里会：
    // 1. 调用 API 健康检查
    // 2. 执行冒烟测试
    // 3. 验证关键业务流程
    
    // 模拟验证
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return true;
  }
  
  /**
   * 更新活跃区域状态
   */
  async updateActiveRegion(region) {
    this.state.activeRegion = region;
    await this.saveState();
    
    console.log('[FailoverController] Active region updated:', region);
    return true;
  }
  
  /**
   * 回滚切换
   */
  async rollback(fromRegion, completedSteps) {
    console.log('[FailoverController] Starting rollback to:', fromRegion);
    
    // 按相反顺序执行回滚步骤
    const rollbackSteps = completedSteps
      .filter(r => r.success)
      .reverse()
      .map(r => r.step);
    
    for (const step of rollbackSteps) {
      try {
        await this.executeRollbackStep(step, fromRegion);
        console.log('[FailoverController] Rollback step completed:', step);
      } catch (error) {
        console.error('[FailoverController] Rollback step failed:', step, error.message);
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
        // 恢复流量
        console.log('[FailoverController] Restoring traffic to region:', region);
        break;
      case 'promote-secondary':
        // 降级回备库
        console.log('[FailoverController] Demoting to secondary:', region);
        break;
    }
  }
  
  /**
   * 保存状态到 Redis
   */
  async saveState() {
    if (this.redis) {
      try {
        await this.redis.set(
          this.stateKey, 
          JSON.stringify(this.state),
          'EX',
          86400 // 1 day
        );
      } catch (e) {
        console.error('[FailoverController] Failed to save state:', e.message);
      }
    }
  }
  
  /**
   * 更新 Prometheus 指标
   */
  updateMetrics() {
    if (this.metrics) {
      try {
        this.metrics.gauge('dr_active_region').set(
          this.state.activeRegion === this.config.primaryRegion ? 1 : 2
        );
        this.metrics.gauge('dr_failover_in_progress').set(this.state.isFailingOver ? 1 : 0);
      } catch (e) {
        // Ignore metric errors
      }
    }
  }
  
  /**
   * 记录切换指标
   */
  recordFailoverMetric(fromRegion, toRegion, trigger, result) {
    if (this.metrics) {
      try {
        this.metrics.counter('dr_failover_operations_total').inc(
          { from_region: fromRegion, to_region: toRegion, trigger, result }
        );
      } catch (e) {
        // Ignore metric errors
      }
    }
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
  
  /**
   * 获取切换历史
   */
  getHistory(limit = 10) {
    return this.state.failoverHistory.slice(-limit);
  }
}

module.exports = FailoverController;
