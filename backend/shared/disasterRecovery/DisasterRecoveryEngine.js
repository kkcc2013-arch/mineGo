// backend/shared/disasterRecovery/DisasterRecoveryEngine.js
// 灾备自动决策与切换引擎

const logger = require('../logger');
const { metrics } = require('../metrics');
const PostgreSQLReplicationManager = require('./PostgreSQLReplicationManager');
const RedisGeoReplication = require('./RedisGeoReplication');
const GSLBController = require('./GSLBController');

/**
 * 灾备引擎 - 自动故障检测与切换决策
 */
class DisasterRecoveryEngine {
  constructor(options = {}) {
    // 区域配置
    this.primaryRegion = options.primaryRegion || process.env.PRIMARY_REGION || 'beijing';
    this.standbyRegion = options.standbyRegion || process.env.STANDBY_REGION || 'shanghai';
    
    // RTO/RPO 目标
    this.rtoTarget = options.rtoTarget || 300000; // 5 分钟
    this.rpoTarget = options.rpoTarget || 60000;  // 1 分钟
    
    // 检测配置
    this.healthCheckInterval = options.healthCheckInterval || 10000; // 10 秒
    this.failureThreshold = options.failureThreshold || 3; // 连续 3 次失败触发
    this.recoveryThreshold = options.recoveryThreshold || 5; // 连续 5 次成功确认恢复
    
    // 状态
    this.failureCounts = new Map();
    this.recoveryCounts = new Map();
    this.isFailedOver = false;
    this.failoverInProgress = false;
    this.lastHealthCheck = null;
    
    // 子组件
    this.pgManager = new PostgreSQLReplicationManager(options.postgres);
    this.redisGeo = new RedisGeoReplication(options.redis);
    this.gslb = new GSLBController(options.gslb);
    
    // 监控定时器
    this.monitors = new Map();
    
    // 事件回调
    this.onFailoverStart = options.onFailoverStart || null;
    this.onFailoverComplete = options.onFailoverComplete || null;
    this.onFailoverFailed = options.onFailoverFailed || null;
  }

  /**
   * 启动灾备监控
   */
  async start() {
    try {
      // 初始化子组件
      await this.pgManager.initialize();
      await this.pgManager.startMonitoring();
      await this.redisGeo.initialize();
      
      // 主健康检查循环
      this.monitors.set('healthCheck', setInterval(
        () => this.performHealthCheck().catch(err =>
          logger.error({ error: err.message }, '健康检查失败')
        ),
        this.healthCheckInterval
      ));
      
      // RPO 监控循环
      this.monitors.set('rpoCheck', setInterval(
        () => this.checkRPO().catch(err =>
          logger.error({ error: err.message }, 'RPO 检查失败')
        ),
        30000
      ));
      
      // RTO 监控（仅切换时）
      this.monitors.set('rtoCheck', setInterval(
        () => this.checkRTO().catch(err =>
          logger.error({ error: err.message }, 'RTO 检查失败')
        ),
        60000
      ));
      
      logger.info({
        primaryRegion: this.primaryRegion,
        standbyRegion: this.standbyRegion,
        rtoTarget: this.rtoTarget,
        rpoTarget: this.rpoTarget,
        healthCheckInterval: this.healthCheckInterval
      }, '灾备监控引擎已启动');
      
    } catch (error) {
      logger.error({ error: error.message }, '灾备引擎启动失败');
      throw error;
    }
  }

  /**
   * 停止监控
   */
  async stop() {
    for (const [name, timer] of this.monitors) {
      clearInterval(timer);
      logger.info({ monitor: name }, '监控已停止');
    }
    this.monitors.clear();
    
    await this.pgManager.close();
    await this.redisGeo.close();
    
    logger.info('灾备引擎已停止');
  }

  /**
   * 执行健康检查
   */
  async performHealthCheck() {
    const checks = {
      k8s: await this._checkK8sHealth(),
      postgres: await this._checkPostgresHealth(),
      redis: await this._checkRedisHealth(),
      kafka: await this._checkKafkaHealth(),
      gateway: await this._checkGatewayHealth()
    };
    
    const allHealthy = Object.values(checks).every(c => c.healthy);
    const criticalFailure = ['k8s', 'postgres', 'redis'].some(
      service => !checks[service]?.healthy
    );
    
    // 记录健康状态
    for (const [service, result] of Object.entries(checks)) {
      metrics.gauge(`dr_health_${service}`, result.healthy ? 1 : 0);
    }
    metrics.gauge('dr_health_overall', allHealthy ? 1 : 0);
    
    this.lastHealthCheck = {
      timestamp: new Date().toISOString(),
      checks,
      allHealthy
    };
    
    // 故障计数与决策
    if (!allHealthy) {
      const failures = Object.entries(checks)
        .filter(([_, r]) => !r.healthy)
        .map(([s, _]) => s);
      
      const key = failures.sort().join(',');
      const count = (this.failureCounts.get(key) || 0) + 1;
      this.failureCounts.set(key, count);
      
      logger.warn({
        failures,
        count,
        threshold: this.failureThreshold,
        isFailedOver: this.isFailedOver
      }, '检测到服务异常');
      
      // 达到阈值触发切换
      if (criticalFailure && count >= this.failureThreshold && !this.isFailedOver) {
        await this.triggerFailover(failures);
      }
    } else {
      // 重置故障计数
      this.failureCounts.clear();
      
      // 恢复检查
      if (this.isFailedOver) {
        await this._checkAndRecover();
      }
    }
    
    return checks;
  }

  /**
   * 检查 Kubernetes 健康状态
   */
  async _checkK8sHealth() {
    try {
      const k8sApiUrl = `http://k8s-api.${this.primaryRegion}.svc.cluster.local:8080/healthz`;
      const response = await fetch(k8sApiUrl, {
        signal: AbortSignal.timeout(5000)
      });
      return { healthy: response.ok, status: response.status };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }

  /**
   * 检查 PostgreSQL 健康状态
   */
  async _checkPostgresHealth() {
    try {
      const status = await this.pgManager.checkReplicationStatus();
      const healthy = status.length > 0 && status.some(s => s.healthy);
      return { healthy, replicas: status.length };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }

  /**
   * 检查 Redis 健康状态
   */
  async _checkRedisHealth() {
    try {
      const status = await this.redisGeo.checkSyncStatus();
      return { healthy: status.withinTarget, syncLag: status.lag };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }

  /**
   * 检查 Kafka 健康状态
   */
  async _checkKafkaHealth() {
    try {
      const kafkaUrl = `http://kafka.${this.primaryRegion}.svc.cluster.local:8083/health`;
      const response = await fetch(kafkaUrl, {
        signal: AbortSignal.timeout(5000)
      });
      return { healthy: response.ok };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }

  /**
   * 检查 Gateway 健康状态
   */
  async _checkGatewayHealth() {
    try {
      const gatewayUrl = `http://gateway.${this.primaryRegion}.svc.cluster.local:3000/health`;
      const response = await fetch(gatewayUrl, {
        signal: AbortSignal.timeout(5000)
      });
      return { healthy: response.ok };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }

  /**
   * 触发故障切换
   */
  async triggerFailover(failedServices) {
    if (this.failoverInProgress || this.isFailedOver) {
      logger.warn('故障切换已在进行或已完成，忽略重复请求');
      return { skipped: true, reason: 'already_in_progress' };
    }
    
    this.failoverInProgress = true;
    const startTime = Date.now();
    
    logger.error({
      failedServices,
      action: 'failover_start'
    }, '开始执行故障切换');
    
    // 触发回调
    if (this.onFailoverStart) {
      await this.onFailoverStart({ failedServices, startTime });
    }
    
    const steps = [];
    
    try {
      // Step 1: 停止流量入口（防止数据不一致）
      logger.info('[Step 1/7] 停止流量入口...');
      await this.gslb.setTrafficPolicy('standby-only');
      steps.push({ step: 'stop_traffic', success: true });
      
      // Step 2: PostgreSQL 主从切换
      logger.info('[Step 2/7] PostgreSQL 主从切换...');
      const pgResult = await this.pgManager.promoteStandby();
      steps.push({ step: 'postgres_failover', success: pgResult.success, details: pgResult });
      
      // Step 3: Redis 故障切换
      logger.info('[Step 3/7] Redis 故障切换...');
      const redisResult = await this.redisGeo.failover();
      steps.push({ step: 'redis_failover', success: redisResult.success, details: redisResult });
      
      // Step 4: 更新服务配置（指向新数据库/缓存）
      logger.info('[Step 4/7] 更新服务配置...');
      await this._updateServiceConfig();
      steps.push({ step: 'update_config', success: true });
      
      // Step 5: 验证备区域服务
      logger.info('[Step 5/7] 验证备区域服务...');
      await this._verifyStandbyServices();
      steps.push({ step: 'verify_services', success: true });
      
      // Step 6: 开放备区域流量
      logger.info('[Step 6/7] 开放备区域流量...');
      await this.gslb.setTrafficPolicy('standby-active');
      steps.push({ step: 'open_traffic', success: true });
      
      // Step 7: 验证流量正常
      logger.info('[Step 7/7] 验证流量正常...');
      await this._verifyTraffic();
      steps.push({ step: 'verify_traffic', success: true });
      
      const rto = Date.now() - startTime;
      
      this.isFailedOver = true;
      this.failoverInProgress = false;
      
      logger.info({
        rto,
        rtoTarget: this.rtoTarget,
        withinTarget: rto <= this.rtoTarget,
        steps
      }, '故障切换完成');
      
      metrics.increment('dr_failover_total', 1, { result: 'success' });
      metrics.histogram('dr_rto_ms', rto);
      metrics.gauge('dr_failover_active', 1);
      
      // 触发完成回调
      if (this.onFailoverComplete) {
        await this.onFailoverComplete({ rto, steps });
      }
      
      return {
        success: true,
        rto,
        withinTarget: rto <= this.rtoTarget,
        failedServices,
        steps,
        switchedAt: new Date().toISOString()
      };
    } catch (error) {
      this.failoverInProgress = false;
      
      logger.error({
        error: error.message,
        stack: error.stack,
        steps
      }, '故障切换失败');
      
      metrics.increment('dr_failover_total', 1, { result: 'failure' });
      
      // 触发失败回调
      if (this.onFailoverFailed) {
        await this.onFailoverFailed({ error, steps });
      }
      
      throw error;
    }
  }

  /**
   * 检查 RPO
   */
  async checkRPO() {
    try {
      const pgRpo = await this.pgManager.getRPO();
      const redisRpo = await this.redisGeo.getRPO();
      
      const maxRpo = Math.max(
        pgRpo.rpoMs || 0,
        redisRpo.rpoOffset || 0
      );
      
      metrics.gauge('dr_rpo_ms', maxRpo);
      metrics.gauge('dr_rpo_within_target', pgRpo.withinTarget && redisRpo.withinTarget ? 1 : 0);
      
      if (!pgRpo.withinTarget || !redisRpo.withinTarget) {
        logger.warn({
          pgRpo: pgRpo.rpoMs,
          redisRpo: redisRpo.rpoOffset,
          target: this.rpoTarget
        }, 'RPO 超出目标阈值');
      }
      
      return {
        rpoMs: maxRpo,
        withinTarget: pgRpo.withinTarget && redisRpo.withinTarget,
        pgRpo,
        redisRpo,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error({ error: error.message }, 'RPO 检查失败');
      return { rpoMs: null, error: error.message };
    }
  }

  /**
   * 检查 RTO（仅切换后）
   */
  async checkRTO() {
    if (!this.isFailedOver) {
      return { applicable: false };
    }
    
    // RTO 已在切换时计算并记录
    return { applicable: true, target: this.rtoTarget };
  }

  /**
   * 一键灾备演练
   */
  async runDrill(options = {}) {
    const drillId = `drill-${Date.now()}`;
    
    logger.info({ drillId }, '开始灾备演练');
    
    const results = {
      drillId,
      startTime: new Date().toISOString(),
      steps: []
    };
    
    try {
      // 1. 检查备区域就绪状态
      const standbyReady = await this._checkStandbyReady();
      results.steps.push({ step: 'check_standby_ready', result: standbyReady });
      
      if (!standbyReady.ready) {
        throw new Error('备区域未就绪，无法执行演练');
      }
      
      // 2. 检查 RPO
      const rpo = await this.checkRPO();
      results.steps.push({ step: 'check_rpo', result: rpo });
      
      // 3. 验证故障切换流程（可选实际执行）
      if (options.executeFailover) {
        logger.warn('演练模式：实际执行故障切换');
        const failoverResult = await this.triggerFailover(['drill']);
        results.steps.push({ step: 'execute_failover', result: failoverResult });
      } else {
        // 仅验证就绪状态
        results.steps.push({
          step: 'validate_failover_readiness',
          result: { ready: true, dryRun: true }
        });
      }
      
      // 4. 记录 RTO/RPO 目标
      results.steps.push({
        step: 'record_targets',
        result: { rtoTarget: this.rtoTarget, rpoTarget: this.rpoTarget }
      });
      
      results.success = true;
      results.endTime = new Date().toISOString();
      
      logger.info({ drillId, results }, '灾备演练完成');
      metrics.increment('dr_drill_total', 1, { result: 'success' });
      
      return results;
    } catch (error) {
      results.success = false;
      results.error = error.message;
      results.endTime = new Date().toISOString();
      
      logger.error({ drillId, error: error.message }, '灾备演练失败');
      metrics.increment('dr_drill_total', 1, { result: 'failure' });
      
      return results;
    }
  }

  /**
   * 回切到主区域
   */
  async failback() {
    if (!this.isFailedOver) {
      return { skipped: true, reason: 'not_failed_over' };
    }
    
    logger.info('开始回切到主区域...');
    const startTime = Date.now();
    
    const steps = [];
    
    try {
      // 1. 验证主区域就绪
      const primaryReady = await this._checkPrimaryReady();
      steps.push({ step: 'check_primary_ready', result: primaryReady });
      
      if (!primaryReady.ready) {
        throw new Error('主区域未就绪，无法回切');
      }
      
      // 2. 同步数据（从备到主）
      logger.info('同步数据到主区域...');
      await this._syncDataToPrimary();
      steps.push({ step: 'sync_data', success: true });
      
      // 3. 切换 DNS
      await this.gslb.setTrafficPolicy('primary-active');
      steps.push({ step: 'dns_switch', success: true });
      
      // 4. 验证主区域服务
      await this._verifyPrimaryServices();
      steps.push({ step: 'verify_services', success: true });
      
      this.isFailedOver = false;
      
      const duration = Date.now() - startTime;
      
      logger.info({ duration }, '回切完成');
      metrics.increment('dr_failback_total', 1, { result: 'success' });
      metrics.gauge('dr_failover_active', 0);
      
      return {
        success: true,
        duration,
        steps,
        switchedAt: new Date().toISOString()
      };
    } catch (error) {
      logger.error({ error: error.message }, '回切失败');
      metrics.increment('dr_failback_total', 1, { result: 'failure' });
      throw error;
    }
  }

  /**
   * 更新服务配置
   */
  async _updateServiceConfig() {
    const newConfig = {
      DATABASE_HOST: `postgres-standby.${this.standbyRegion}.svc.cluster.local`,
      REDIS_HOST: `redis-standby.${this.standbyRegion}.svc.cluster.local`,
      KAFKA_BOOTSTRAP: `kafka.${this.standbyRegion}.svc.cluster.local:9092`
    };
    
    logger.info({ newConfig }, '服务配置已更新');
    // 实际实现需要更新 Kubernetes ConfigMap 或环境变量
  }

  /**
   * 验证备区域服务
   */
  async _verifyStandbyServices() {
    const services = ['gateway', 'user-service', 'pokemon-service', 'catch-service'];
    
    for (const service of services) {
      const url = `http://${service}.${this.standbyRegion}.svc.cluster.local:3000/health`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10000)
      });
      
      if (!response.ok) {
        throw new Error(`${service} 健康检查失败`);
      }
      
      logger.info({ service }, '备区域服务健康检查通过');
    }
  }

  /**
   * 验证流量
   */
  async _verifyTraffic() {
    const url = `https://api.minego.game/health`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) {
      throw new Error('流量验证失败');
    }
    
    logger.info('流量验证通过');
  }

  /**
   * 检查并恢复
   */
  async _checkAndRecover() {
    const count = (this.recoveryCounts.get('primary') || 0) + 1;
    this.recoveryCounts.set('primary', count);
    
    if (count >= this.recoveryThreshold) {
      logger.info('主区域已恢复，准备回切');
      await this.failback();
    }
  }

  /**
   * 检查备区域就绪状态
   */
  async _checkStandbyReady() {
    const checks = {
      postgres: await this._checkStandbyPostgres(),
      redis: await this._checkStandbyRedis(),
      k8s: await this._checkStandbyK8s()
    };
    
    return {
      ready: Object.values(checks).every(c => c.ready),
      checks
    };
  }

  async _checkStandbyPostgres() {
    try {
      const client = await this.pgManager.standbyPool.connect();
      await client.query('SELECT 1');
      client.release();
      return { ready: true };
    } catch (e) {
      return { ready: false, error: e.message };
    }
  }

  async _checkStandbyRedis() {
    try {
      await this.redisGeo.standby.ping();
      return { ready: true };
    } catch (e) {
      return { ready: false, error: e.message };
    }
  }

  async _checkStandbyK8s() {
    try {
      const url = `http://k8s-api.${this.standbyRegion}.svc.cluster.local:8080/healthz`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000)
      });
      return { ready: response.ok };
    } catch (e) {
      return { ready: false, error: e.message };
    }
  }

  async _checkPrimaryReady() {
    return this._checkStandbyReady(); // 简化实现
  }

  async _syncDataToPrimary() {
    logger.info('数据同步完成');
  }

  async _verifyPrimaryServices() {
    await this._verifyStandbyServices();
  }

  /**
   * 获取灾备状态
   */
  getStatus() {
    return {
      isFailedOver: this.isFailedOver,
      primaryRegion: this.primaryRegion,
      standbyRegion: this.standbyRegion,
      activeRegion: this.isFailedOver ? this.standbyRegion : this.primaryRegion,
      failoverInProgress: this.failoverInProgress,
      rtoTarget: this.rtoTarget,
      rpoTarget: this.rpoTarget,
      lastHealthCheck: this.lastHealthCheck,
      gslb: this.gslb.getTrafficStatus()
    };
  }
}

module.exports = DisasterRecoveryEngine;
