# REQ-00041: 多区域容灾切换与灾备恢复系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00041 |
| 标题 | 多区域容灾切换与灾备恢复系统 |
| 类别 | 容灾/高可用 |
| 优先级 | P0 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、infrastructure/k8s、database、Redis |
| 创建时间 | 2026-06-09 01:00 |

## 需求描述

构建完整的多区域容灾切换系统，实现主备数据中心自动故障切换，保障 RTO < 5 分钟，RPO < 1 分钟，支持灾难恢复演练和一键回切。

### 核心目标

1. **多区域部署**：支持主备双活或多活数据中心架构
2. **自动故障检测**：秒级健康检测，自动触发容灾切换
3. **数据同步**：数据库跨区域实时同步，保障数据一致性
4. **一键切换**：支持手动/自动切换，切换过程可观测
5. **演练机制**：定期容灾演练，验证系统可靠性

### 业务价值

- 将系统可用性从 99.9% 提升至 99.99%
- 减少灾难恢复时间从小时级降至分钟级
- 降低数据丢失风险至近零
- 满足金融级高可用要求

## 技术方案

### 1. 多区域架构设计

```yaml
# infrastructure/k8s/multi-region/disaster-recovery.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: disaster-recovery-config
  namespace: minego-production
data:
  # 区域配置
  PRIMARY_REGION: "cn-east-1"
  SECONDARY_REGION: "cn-north-1"
  
  # 故障检测阈值
  HEALTH_CHECK_INTERVAL: "5s"
  HEALTH_CHECK_TIMEOUT: "3s"
  FAILURE_THRESHOLD: "3"
  RECOVERY_THRESHOLD: "2"
  
  # 切换配置
  AUTO_FAILOVER_ENABLED: "true"
  FAILOVER_COOLDOWN: "300s"
  DNS_TTL: "30s"
  
  # 数据同步配置
  DB_SYNC_MODE: "async"
  DB_SYNC_LAG_THRESHOLD: "60s"
  REDIS_SYNC_MODE: "async"
  
  # RTO/RPO 目标
  TARGET_RTO: "300s"
  TARGET_RPO: "60s"
```

### 2. 健康检测服务

```javascript
// backend/shared/disasterRecovery/HealthChecker.js

const { EventEmitter } = require('events');
const axios = require('axios');
const { logger, metrics } = require('../logging');
const Redis = require('ioredis');

class HealthChecker extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      checkInterval: config.checkInterval || 5000,
      timeout: config.timeout || 3000,
      failureThreshold: config.failureThreshold || 3,
      recoveryThreshold: config.recoveryThreshold || 2,
      services: config.services || [],
      ...config
    };
    
    this.region = process.env.REGION || 'primary';
    this.healthStatus = new Map();
    this.failureCounts = new Map();
    this.recoveryCounts = new Map();
    this.isRunning = false;
    
    this.registerMetrics();
  }
  
  registerMetrics() {
    // 健康检查指标
    metrics.gauge('dr_health_check_status', 'Health check status (1=healthy, 0=unhealthy)', 
      ['service', 'region']);
    metrics.gauge('dr_failure_count', 'Consecutive failure count', 
      ['service', 'region']);
    metrics.histogram('dr_health_check_latency_seconds', 'Health check latency', 
      ['service', 'region']);
    metrics.counter('dr_failover_events_total', 'Failover events count', 
      ['from_region', 'to_region', 'trigger']);
  }
  
  async start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    logger.info('Health checker started', { region: this.region });
    
    // 初始检查
    await this.runHealthChecks();
    
    // 定时检查
    this.timer = setInterval(() => {
      this.runHealthChecks().catch(err => {
        logger.error('Health check error', { error: err.message });
      });
    }, this.config.checkInterval);
  }
  
  async runHealthChecks() {
    const results = await Promise.allSettled(
      this.config.services.map(service => this.checkService(service))
    );
    
    // 分析结果，判断是否需要触发故障切换
    const unhealthyServices = [];
    const healthyServices = [];
    
    results.forEach((result, index) => {
      const service = this.config.services[index];
      const key = `${service.name}:${service.region || this.region}`;
      
      if (result.status === 'fulfilled' && result.value.healthy) {
        healthyServices.push(service);
        this.handleHealthy(service, result.value);
      } else {
        unhealthyServices.push(service);
        this.handleUnhealthy(service, result.reason || result.value);
      }
    });
    
    // 触发健康状态变更事件
    const overallHealth = unhealthyServices.length === 0;
    this.emit('health-status-change', {
      region: this.region,
      healthy: overallHealth,
      healthyCount: healthyServices.length,
      unhealthyCount: unhealthyServices.length,
      timestamp: new Date().toISOString()
    });
    
    return {
      healthy: overallHealth,
      healthyServices,
      unhealthyServices
    };
  }
  
  async checkService(service) {
    const startTime = Date.now();
    const key = `${service.name}:${service.region || this.region}`;
    
    try {
      const response = await axios.get(`${service.url}/health`, {
        timeout: this.config.timeout,
        validateStatus: (status) => status < 500
      });
      
      const latency = (Date.now() - startTime) / 1000;
      
      metrics.histogram('dr_health_check_latency_seconds').observe(
        { service: service.name, region: service.region || this.region },
        latency
      );
      
      if (response.status === 200 && response.data?.status === 'healthy') {
        return {
          healthy: true,
          latency,
          checks: response.data.checks || {}
        };
      }
      
      return {
        healthy: false,
        latency,
        status: response.status,
        error: 'Unhealthy response'
      };
    } catch (error) {
      const latency = (Date.now() - startTime) / 1000;
      
      return {
        healthy: false,
        latency,
        error: error.message
      };
    }
  }
  
  handleHealthy(service, result) {
    const key = `${service.name}:${service.region || this.region}`;
    
    // 重置失败计数
    this.failureCounts.set(key, 0);
    
    // 增加恢复计数
    const recoveryCount = (this.recoveryCounts.get(key) || 0) + 1;
    this.recoveryCounts.set(key, recoveryCount);
    
    // 更新健康状态
    if (recoveryCount >= this.config.recoveryThreshold) {
      const wasUnhealthy = this.healthStatus.get(key) === false;
      this.healthStatus.set(key, true);
      
      if (wasUnhealthy) {
        logger.info('Service recovered', { 
          service: service.name, 
          region: service.region || this.region,
          recoveryCount 
        });
        this.emit('service-recovered', { service, result });
      }
    }
    
    // 更新指标
    metrics.gauge('dr_health_check_status').set(
      { service: service.name, region: service.region || this.region },
      1
    );
    metrics.gauge('dr_failure_count').set(
      { service: service.name, region: service.region || this.region },
      0
    );
  }
  
  handleUnhealthy(service, reason) {
    const key = `${service.name}:${service.region || this.region}`;
    
    // 重置恢复计数
    this.recoveryCounts.set(key, 0);
    
    // 增加失败计数
    const failureCount = (this.failureCounts.get(key) || 0) + 1;
    this.failureCounts.set(key, failureCount);
    
    logger.warn('Service health check failed', {
      service: service.name,
      region: service.region || this.region,
      failureCount,
      threshold: this.config.failureThreshold,
      reason: reason?.message || reason?.error || 'Unknown'
    });
    
    // 更新健康状态
    if (failureCount >= this.config.failureThreshold) {
      const wasHealthy = this.healthStatus.get(key) !== false;
      this.healthStatus.set(key, false);
      
      if (wasHealthy) {
        logger.error('Service marked unhealthy', {
          service: service.name,
          region: service.region || this.region,
          failureCount
        });
        this.emit('service-unhealthy', { service, reason, failureCount });
      }
    }
    
    // 更新指标
    metrics.gauge('dr_health_check_status').set(
      { service: service.name, region: service.region || this.region },
      0
    );
    metrics.gauge('dr_failure_count').set(
      { service: service.name, region: service.region || this.region },
      failureCount
    );
  }
  
  getHealthStatus() {
    const status = {
      region: this.region,
      overall: true,
      services: {},
      timestamp: new Date().toISOString()
    };
    
    this.healthStatus.forEach((healthy, key) => {
      const [serviceName, serviceRegion] = key.split(':');
      
      if (!status.services[serviceName]) {
        status.services[serviceName] = {};
      }
      
      status.services[serviceName][serviceRegion] = {
        healthy,
        failureCount: this.failureCounts.get(key) || 0,
        recoveryCount: this.recoveryCounts.get(key) || 0
      };
      
      if (!healthy) {
        status.overall = false;
      }
    });
    
    return status;
  }
  
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    logger.info('Health checker stopped', { region: this.region });
  }
}

module.exports = HealthChecker;
```

### 3. 容灾切换控制器

```javascript
// backend/shared/disasterRecovery/FailoverController.js

const { EventEmitter } = require('events');
const { logger, metrics } = require('../logging');
const Redis = require('ioredis');
const axios = require('axios');

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
    
    this.redis = new Redis(process.env.REDIS_URL);
    this.lockKey = 'dr:failover:lock';
    this.stateKey = 'dr:failover:state';
    
    this.registerMetrics();
  }
  
  registerMetrics() {
    metrics.gauge('dr_active_region', 'Current active region (1=primary, 2=secondary)');
    metrics.gauge('dr_failover_in_progress', 'Failover in progress flag');
    metrics.counter('dr_failover_operations_total', 'Failover operations count', 
      ['from_region', 'to_region', 'trigger', 'result']);
  }
  
  async initialize() {
    // 从 Redis 恢复状态
    const savedState = await this.redis.get(this.stateKey);
    if (savedState) {
      this.state = JSON.parse(savedState);
      logger.info('Failover state restored from Redis', { state: this.state });
    }
    
    // 更新指标
    this.updateMetrics();
  }
  
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
      
      metrics.counter('dr_failover_operations_total').inc(
        { from_region: fromRegion, to_region: toRegion, trigger, result: 'success' }
      );
      
      logger.info('Failover completed successfully', { failoverRecord });
      this.emit('failover-complete', failoverRecord);
      
      return failoverRecord;
      
    } catch (error) {
      this.state.isFailingOver = false;
      this.updateMetrics();
      
      metrics.counter('dr_failover_operations_total').inc(
        { from_region: fromRegion, to_region: toRegion, trigger, result: 'failed' }
      );
      
      logger.error('Failover failed', { error: error.message });
      this.emit('failover-failed', { error: error.message });
      
      throw error;
    } finally {
      if (lock) {
        await this.releaseLock(lock);
      }
    }
  }
  
  async acquireLock() {
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
  
  async releaseLock(lockValue) {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    
    await this.redis.eval(script, 1, this.lockKey, lockValue);
  }
  
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
  
  async stopTraffic(region) {
    // 通过 Kubernetes 注解停止流量
    const k8sApi = this.getK8sApi();
    
    await k8sApi.patchNamespacedService(
      'minego-gateway',
      'minego-production',
      {
        metadata: {
          annotations: {
            'traffic-stop': 'true',
            'traffic-stop-reason': 'failover',
            'traffic-stop-time': new Date().toISOString()
          }
        }
      }
    );
    
    // 等待流量排空
    await this.waitForTrafficDrain(region);
    
    logger.info('Traffic stopped', { region });
  }
  
  async waitForTrafficDrain(region) {
    const maxWait = 30000;
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWait) {
      const connections = await this.getActiveConnections(region);
      
      if (connections < 10) {
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    logger.warn('Traffic drain timeout, proceeding with failover');
  }
  
  async syncData(fromRegion, toRegion) {
    // 数据库同步状态检查
    const dbLag = await this.getDatabaseSyncLag();
    
    if (dbLag > 60000) { // 60秒
      throw new Error(`Database sync lag too high: ${dbLag}ms`);
    }
    
    // Redis 数据同步
    await this.syncRedisData(fromRegion, toRegion);
    
    logger.info('Data synced', { fromRegion, toRegion, dbLag });
  }
  
  async promoteSecondary(region) {
    // 提升备库为主库
    const dbApi = this.getDatabaseApi(region);
    
    await dbApi.promoteToPrimary();
    
    // 等待数据库就绪
    await this.waitForDatabaseReady(region);
    
    logger.info('Secondary promoted to primary', { region });
  }
  
  async updateDNS(region) {
    const dnsApi = this.getDNSApi();
    const endpoint = this.getRegionEndpoint(region);
    
    // 更新 DNS 记录
    await dnsApi.updateRecord({
      name: 'api.minego.com',
      type: 'A',
      value: endpoint.ip,
      ttl: this.config.dnsTTL
    });
    
    // 等待 DNS 传播
    await new Promise(resolve => setTimeout(resolve, this.config.dnsTTL * 1000));
    
    logger.info('DNS updated', { region, endpoint: endpoint.ip });
  }
  
  async verifyService(region) {
    const endpoint = `https://api.minego.com/health`;
    
    const maxRetries = 10;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await axios.get(endpoint, { timeout: 5000 });
        
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
  
  async updateState(region) {
    this.state.activeRegion = region;
    await this.saveState();
    
    logger.info('State updated', { activeRegion: region });
  }
  
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
  
  async executeRollbackStep(step, region) {
    switch (step) {
      case 'update-dns':
        await this.updateDNS(region);
        break;
      case 'stop-traffic-primary':
        // 恢复流量
        await this.restoreTraffic(region);
        break;
      // 其他步骤...
    }
  }
  
  async saveState() {
    await this.redis.set(
      this.stateKey, 
      JSON.stringify(this.state),
      'EX',
      86400 // 1 day
    );
  }
  
  updateMetrics() {
    metrics.gauge('dr_active_region').set(
      this.state.activeRegion === this.config.primaryRegion ? 1 : 2
    );
    metrics.gauge('dr_failover_in_progress').set(this.state.isFailingOver ? 1 : 0);
  }
  
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
  
  // 辅助方法（需要根据实际环境实现）
  getRegionEndpoints(region) { /* ... */ }
  getRegionEndpoint(region) { /* ... */ }
  getK8sApi() { /* ... */ }
  getDatabaseApi(region) { /* ... */ }
  getDNSApi() { /* ... */ }
  getActiveConnections(region) { /* ... */ }
  getDatabaseSyncLag() { /* ... */ }
  syncRedisData(fromRegion, toRegion) { /* ... */ }
  waitForDatabaseReady(region) { /* ... */ }
  restoreTraffic(region) { /* ... */ }
}

module.exports = FailoverController;
```

### 4. 数据库跨区域同步

```javascript
// backend/shared/disasterRecovery/DatabaseSync.js

const { logger, metrics } = require('../logging');
const { Pool } = require('pg');

class DatabaseSync {
  constructor(config = {}) {
    this.config = {
      primaryUrl: config.primaryUrl || process.env.DATABASE_URL,
      secondaryUrl: config.secondaryUrl || process.env.DATABASE_URL_SECONDARY,
      syncInterval: config.syncInterval || 1000,
      lagThreshold: config.lagThreshold || 60000, // 60 seconds
      ...config
    };
    
    this.primaryPool = new Pool({ connectionString: this.config.primaryUrl });
    this.secondaryPool = new Pool({ connectionString: this.config.secondaryUrl });
    
    this.registerMetrics();
  }
  
  registerMetrics() {
    metrics.gauge('dr_db_sync_lag_seconds', 'Database sync lag in seconds');
    metrics.counter('dr_db_sync_errors_total', 'Database sync errors');
    metrics.gauge('dr_db_replication_status', 'Replication status (1=ok, 0=error)');
  }
  
  async start() {
    // 定期检查同步状态
    this.timer = setInterval(() => {
      this.checkSyncStatus().catch(err => {
        logger.error('Database sync check failed', { error: err.message });
      });
    }, this.config.syncInterval);
    
    logger.info('Database sync monitor started');
  }
  
  async checkSyncStatus() {
    try {
      // 检查主库 WAL 位置
      const primaryResult = await this.primaryPool.query(`
        SELECT pg_current_wal_lsn() as lsn,
               pg_current_wal_insert_lsn() as insert_lsn
      `);
      
      // 检查备库接收位置
      const secondaryResult = await this.secondaryPool.query(`
        SELECT pg_last_wal_receive_lsn() as receive_lsn,
               pg_last_wal_replay_lsn() as replay_lsn,
               pg_last_xact_replay_timestamp() as replay_time
      `);
      
      // 计算延迟
      const lagResult = await this.primaryPool.query(`
        SELECT 
          extract(epoch from now() - pg_last_xact_replay_timestamp()) as lag_seconds
        FROM pg_stat_replication
      `);
      
      const lagSeconds = lagResult.rows[0]?.lag_seconds || 0;
      
      metrics.gauge('dr_db_sync_lag_seconds').set(lagSeconds);
      metrics.gauge('dr_db_replication_status').set(lagSeconds < 60 ? 1 : 0);
      
      if (lagSeconds > this.config.lagThreshold / 1000) {
        logger.warn('Database sync lag exceeded threshold', {
          lagSeconds,
          threshold: this.config.lagThreshold / 1000
        });
        
        // 触发告警
        this.emit('lag-exceeded', { lagSeconds, threshold: this.config.lagThreshold });
      }
      
      return {
        primaryLSN: primaryResult.rows[0].lsn,
        secondaryLSN: secondaryResult.rows[0].receive_lsn,
        replayLSN: secondaryResult.rows[0].replay_lsn,
        lagSeconds,
        healthy: lagSeconds < this.config.lagThreshold / 1000
      };
      
    } catch (error) {
      metrics.counter('dr_db_sync_errors_total').inc();
      metrics.gauge('dr_db_replication_status').set(0);
      
      throw error;
    }
  }
  
  async forceSync() {
    // 强制同步等待
    await this.primaryPool.query('SELECT pg_switch_wal()');
    
    // 等待备库同步
    const maxWait = 30000;
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWait) {
      const status = await this.checkSyncStatus();
      
      if (status.lagSeconds < 1) {
        logger.info('Force sync completed');
        return true;
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    throw new Error('Force sync timeout');
  }
  
  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    
    await this.primaryPool.end();
    await this.secondaryPool.end();
  }
}

module.exports = DatabaseSync;
```

### 5. 容灾演练系统

```javascript
// backend/shared/disasterRecovery/DrillManager.js

const { logger, metrics } = require('../logging');
const { v4: uuidv4 } = require('uuid');

class DrillManager {
  constructor(failoverController, config = {}) {
    this.failoverController = failoverController;
    
    this.config = {
      scheduleInterval: config.scheduleInterval || 7 * 24 * 60 * 60 * 1000, // 7 days
      maxDrillDuration: config.maxDrillDuration || 1800000, // 30 minutes
      autoRollback: config.autoRollback !== false,
      notifyChannels: config.notifyChannels || ['slack', 'email'],
      ...config
    };
    
    this.activeDrill = null;
    this.drillHistory = [];
    
    this.registerMetrics();
  }
  
  registerMetrics() {
    metrics.gauge('dr_drill_in_progress', 'Drill in progress flag');
    metrics.counter('dr_drill_total', 'Total drills', ['result']);
    metrics.histogram('dr_drill_duration_seconds', 'Drill duration');
    metrics.histogram('dr_drill_rto_seconds', 'Actual RTO achieved');
  }
  
  async scheduleDrill(options = {}) {
    const drillId = uuidv4();
    
    const drill = {
      id: drillId,
      scheduledTime: options.scheduledTime || new Date(Date.now() + 60000),
      type: options.type || 'planned',
      duration: options.duration || this.config.maxDrillDuration,
      autoRollback: options.autoRollback !== false,
      status: 'scheduled',
      notifyChannels: options.notifyChannels || this.config.notifyChannels,
      createdBy: options.createdBy || 'system'
    };
    
    // 发送通知
    await this.sendNotification('drill-scheduled', drill);
    
    logger.info('Drill scheduled', { drillId, scheduledTime: drill.scheduledTime });
    
    return drill;
  }
  
  async startDrill(drillId) {
    if (this.activeDrill) {
      throw new Error('Another drill is already in progress');
    }
    
    this.activeDrill = {
      id: drillId,
      startTime: Date.now(),
      status: 'running',
      steps: []
    };
    
    metrics.gauge('dr_drill_in_progress').set(1);
    
    logger.info('Drill started', { drillId });
    
    // 发送通知
    await this.sendNotification('drill-started', this.activeDrill);
    
    try {
      // 执行故障切换
      const failoverResult = await this.failoverController.failover({
        trigger: 'drill',
        reason: `Disaster recovery drill: ${drillId}`
      });
      
      this.activeDrill.steps.push({
        name: 'failover',
        success: true,
        duration: failoverResult.duration
      });
      
      const rto = (Date.now() - this.activeDrill.startTime) / 1000;
      metrics.histogram('dr_drill_rto_seconds').observe(rto);
      
      this.activeDrill.rto = rto;
      
      logger.info('Drill failover completed', { drillId, rto });
      
      // 自动回切
      if (this.config.autoRollback) {
        setTimeout(() => {
          this.rollbackDrill(drillId).catch(err => {
            logger.error('Drill auto-rollback failed', { drillId, error: err.message });
          });
        }, this.config.maxDrillDuration);
      }
      
      return {
        ...this.activeDrill,
        failoverResult
      };
      
    } catch (error) {
      this.activeDrill.status = 'failed';
      this.activeDrill.error = error.message;
      
      metrics.counter('dr_drill_total').inc({ result: 'failed' });
      
      logger.error('Drill failed', { drillId, error: error.message });
      
      throw error;
    }
  }
  
  async rollbackDrill(drillId) {
    if (!this.activeDrill || this.activeDrill.id !== drillId) {
      throw new Error('No active drill with the specified ID');
    }
    
    const rollbackStartTime = Date.now();
    
    logger.info('Drill rollback started', { drillId });
    
    try {
      // 执行回切
      const rollbackResult = await this.failoverController.failover({
        trigger: 'drill-rollback',
        reason: `Disaster recovery drill rollback: ${drillId}`
      });
      
      this.activeDrill.steps.push({
        name: 'rollback',
        success: true,
        duration: rollbackResult.duration,
        startTime: rollbackStartTime
      });
      
      this.activeDrill.status = 'completed';
      this.activeDrill.endTime = Date.now();
      this.activeDrill.totalDuration = this.activeDrill.endTime - this.activeDrill.startTime;
      
      metrics.counter('dr_drill_total').inc({ result: 'success' });
      metrics.histogram('dr_drill_duration_seconds').observe(this.activeDrill.totalDuration / 1000);
      metrics.gauge('dr_drill_in_progress').set(0);
      
      // 保存历史
      this.drillHistory.push(this.activeDrill);
      
      // 发送通知
      await this.sendNotification('drill-completed', this.activeDrill);
      
      logger.info('Drill completed', { 
        drillId, 
        totalDuration: this.activeDrill.totalDuration,
        rto: this.activeDrill.rto
      });
      
      const completed = this.activeDrill;
      this.activeDrill = null;
      
      return completed;
      
    } catch (error) {
      this.activeDrill.status = 'rollback-failed';
      this.activeDrill.error = error.message;
      
      metrics.counter('dr_drill_total').inc({ result: 'rollback-failed' });
      metrics.gauge('dr_drill_in_progress').set(0);
      
      logger.error('Drill rollback failed', { drillId, error: error.message });
      
      throw error;
    }
  }
  
  async sendNotification(event, data) {
    // 实现通知逻辑
    logger.info('Sending notification', { event, data });
    
    // Slack, Email, SMS 等通知渠道
  }
  
  getDrillStatus(drillId) {
    if (this.activeDrill?.id === drillId) {
      return this.activeDrill;
    }
    
    return this.drillHistory.find(d => d.id === drillId);
  }
  
  getDrillHistory(limit = 10) {
    return this.drillHistory.slice(-limit);
  }
}

module.exports = DrillManager;
```

### 6. 容灾 API 路由

```javascript
// backend/gateway/src/routes/disasterRecovery.js

const express = require('express');
const router = express.Router();
const { logger } = require('../../shared/logging');
const HealthChecker = require('../../shared/disasterRecovery/HealthChecker');
const FailoverController = require('../../shared/disasterRecovery/FailoverController');
const DrillManager = require('../../shared/disasterRecovery/DrillManager');

// 初始化组件
const healthChecker = new HealthChecker({
  services: [
    { name: 'user-service', url: process.env.USER_SERVICE_URL },
    { name: 'pokemon-service', url: process.env.POKEMON_SERVICE_URL },
    { name: 'catch-service', url: process.env.CATCH_SERVICE_URL },
    { name: 'gym-service', url: process.env.GYM_SERVICE_URL },
    { name: 'social-service', url: process.env.SOCIAL_SERVICE_URL },
    { name: 'payment-service', url: process.env.PAYMENT_SERVICE_URL },
    { name: 'location-service', url: process.env.LOCATION_SERVICE_URL },
    { name: 'reward-service', url: process.env.REWARD_SERVICE_URL }
  ]
});

const failoverController = new FailoverController();
const drillManager = new DrillManager(failoverController);

// 启动健康检查
healthChecker.start();
failoverController.initialize();

/**
 * GET /api/dr/status
 * 获取容灾状态
 */
router.get('/status', async (req, res) => {
  try {
    const healthStatus = healthChecker.getHealthStatus();
    const failoverState = failoverController.getState();
    const activeDrill = drillManager.activeDrill;
    
    res.json({
      success: true,
      data: {
        health: healthStatus,
        failover: failoverState,
        drill: activeDrill ? { id: activeDrill.id, status: activeDrill.status } : null,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Failed to get DR status', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dr/health
 * 获取详细健康检查结果
 */
router.get('/health', async (req, res) => {
  try {
    const status = healthChecker.getHealthStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('Failed to get health status', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/failover
 * 手动触发故障切换
 */
router.post('/failover', async (req, res) => {
  try {
    const { reason, force = false } = req.body;
    
    // 权限检查
    if (!req.user?.roles?.includes('admin')) {
      return res.status(403).json({ 
        success: false, 
        error: 'Insufficient permissions' 
      });
    }
    
    logger.info('Manual failover triggered', { 
      user: req.user.id, 
      reason 
    });
    
    const result = await failoverController.failover({
      trigger: 'manual',
      reason: reason || 'Manual failover by admin',
      force
    });
    
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Failover failed', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dr/failover/history
 * 获取故障切换历史
 */
router.get('/failover/history', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const history = failoverController.state.failoverHistory.slice(-parseInt(limit));
    
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Failed to get failover history', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/drill
 * 调度容灾演练
 */
router.post('/drill', async (req, res) => {
  try {
    // 权限检查
    if (!req.user?.roles?.includes('admin')) {
      return res.status(403).json({ 
        success: false, 
        error: 'Insufficient permissions' 
      });
    }
    
    const { scheduledTime, duration, autoRollback } = req.body;
    
    const drill = await drillManager.scheduleDrill({
      scheduledTime: scheduledTime ? new Date(scheduledTime) : undefined,
      duration,
      autoRollback,
      createdBy: req.user.id
    });
    
    res.json({ success: true, data: drill });
  } catch (error) {
    logger.error('Failed to schedule drill', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/drill/:drillId/start
 * 开始演练
 */
router.post('/drill/:drillId/start', async (req, res) => {
  try {
    const { drillId } = req.params;
    
    const result = await drillManager.startDrill(drillId);
    
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Failed to start drill', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/drill/:drillId/rollback
 * 回切演练
 */
router.post('/drill/:drillId/rollback', async (req, res) => {
  try {
    const { drillId } = req.params;
    
    const result = await drillManager.rollbackDrill(drillId);
    
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Failed to rollback drill', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dr/drill/history
 * 获取演练历史
 */
router.get('/drill/history', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const history = drillManager.getDrillHistory(parseInt(limit));
    
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Failed to get drill history', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

### 7. 数据库迁移

```sql
-- database/pending/20260609_010000__add_disaster_recovery_tables.sql

-- 容灾状态表
CREATE TABLE IF NOT EXISTS dr_failover_events (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(36) UNIQUE NOT NULL,
    from_region VARCHAR(50) NOT NULL,
    to_region VARCHAR(50) NOT NULL,
    trigger_type VARCHAR(20) NOT NULL CHECK (trigger_type IN ('manual', 'automatic', 'drill')),
    reason TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'rolled_back')),
    steps JSONB DEFAULT '[]',
    rto_seconds INTEGER,
    rpo_seconds INTEGER,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    created_by VARCHAR(36),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dr_failover_events_status ON dr_failover_events(status);
CREATE INDEX idx_dr_failover_events_started_at ON dr_failover_events(started_at DESC);

-- 容灾演练表
CREATE TABLE IF NOT EXISTS dr_drills (
    id SERIAL PRIMARY KEY,
    drill_id VARCHAR(36) UNIQUE NOT NULL,
    scheduled_time TIMESTAMP WITH TIME ZONE NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_seconds INTEGER,
    rto_seconds INTEGER,
    status VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'running', 'completed', 'failed', 'cancelled')),
    auto_rollback BOOLEAN DEFAULT true,
    failover_event_id VARCHAR(36),
    rollback_event_id VARCHAR(36),
    created_by VARCHAR(36),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    FOREIGN KEY (failover_event_id) REFERENCES dr_failover_events(event_id),
    FOREIGN KEY (rollback_event_id) REFERENCES dr_failover_events(event_id)
);

CREATE INDEX idx_dr_drills_status ON dr_drills(status);
CREATE INDEX idx_dr_drills_scheduled_time ON dr_drills(scheduled_time DESC);

-- 健康检查历史表
CREATE TABLE IF NOT EXISTS dr_health_check_history (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL,
    region VARCHAR(50) NOT NULL,
    healthy BOOLEAN NOT NULL,
    latency_ms INTEGER,
    error_message TEXT,
    checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dr_health_check_history_checked_at ON dr_health_check_history(checked_at DESC);
CREATE INDEX idx_dr_health_check_history_service ON dr_health_check_history(service_name, region);

-- 数据库同步状态表
CREATE TABLE IF NOT EXISTS dr_db_sync_status (
    id SERIAL PRIMARY KEY,
    primary_region VARCHAR(50) NOT NULL,
    secondary_region VARCHAR(50) NOT NULL,
    primary_lsn VARCHAR(100),
    secondary_lsn VARCHAR(100),
    lag_seconds DECIMAL(10, 3),
    healthy BOOLEAN NOT NULL,
    checked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dr_db_sync_status_checked_at ON dr_db_sync_status(checked_at DESC);

-- 容灾配置表
CREATE TABLE IF NOT EXISTS dr_config (
    id SERIAL PRIMARY KEY,
    config_key VARCHAR(100) UNIQUE NOT NULL,
    config_value TEXT NOT NULL,
    description TEXT,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_by VARCHAR(36)
);

-- 插入默认配置
INSERT INTO dr_config (config_key, config_value, description) VALUES
('primary_region', 'cn-east-1', 'Primary region identifier'),
('secondary_region', 'cn-north-1', 'Secondary region identifier'),
('auto_failover_enabled', 'true', 'Enable automatic failover'),
('health_check_interval_seconds', '5', 'Health check interval in seconds'),
('failure_threshold', '3', 'Number of failures before triggering failover'),
('cooldown_period_seconds', '300', 'Cooldown period between failovers'),
('target_rto_seconds', '300', 'Target RTO in seconds'),
('target_rpo_seconds', '60', 'Target RPO in seconds')
ON CONFLICT (config_key) DO NOTHING;

COMMENT ON TABLE dr_failover_events IS '容灾故障切换事件记录';
COMMENT ON TABLE dr_drills IS '容灾演练记录';
COMMENT ON TABLE dr_health_check_history IS '服务健康检查历史';
COMMENT ON TABLE dr_db_sync_status IS '数据库同步状态';
COMMENT ON TABLE dr_config IS '容灾系统配置';
```

### 8. Kubernetes 多区域部署配置

```yaml
# infrastructure/k8s/multi-region/primary-region.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minego-gateway
  namespace: minego-production
  labels:
    app: minego-gateway
    region: primary
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: minego-gateway
  template:
    metadata:
      labels:
        app: minego-gateway
        region: primary
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      containers:
      - name: gateway
        image: minego/gateway:latest
        ports:
        - containerPort: 8080
        env:
        - name: REGION
          value: "cn-east-1"
        - name: PRIMARY_REGION
          value: "cn-east-1"
        - name: SECONDARY_REGION
          value: "cn-north-1"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-credentials-primary
              key: url
        - name: DATABASE_URL_SECONDARY
          valueFrom:
            secretKeyRef:
              name: db-credentials-secondary
              key: url
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
---
# infrastructure/k8s/multi-region/secondary-region.yaml
# 类似配置，指向 cn-north-1
```

## 验收标准

- [ ] 健康检查器每 5 秒检测所有服务健康状态
- [ ] 连续 3 次失败触发服务标记为不健康
- [ ] 故障切换时获取分布式锁防止并发切换
- [ ] 数据库同步延迟超过 60 秒时发出告警
- [ ] 故障切换过程包含 7 个步骤：验证目标健康、停止流量、数据同步、提升备库、更新 DNS、验证服务、更新状态
- [ ] 故障切换 RTO < 5 分钟
- [ ] 数据库 RPO < 1 分钟
- [ ] 容灾演练支持调度、执行、自动回切
- [ ] 所有操作记录到数据库
- [ ] 10 个 API 端点可访问
- [ ] 12 个 Prometheus 指标暴露
- [ ] 单元测试覆盖核心逻辑

## 影响范围

- backend/shared/disasterRecovery/HealthChecker.js (新增)
- backend/shared/disasterRecovery/FailoverController.js (新增)
- backend/shared/disasterRecovery/DatabaseSync.js (新增)
- backend/shared/disasterRecovery/DrillManager.js (新增)
- backend/gateway/src/routes/disasterRecovery.js (新增)
- backend/shared/metrics.js (扩展指标)
- database/pending/20260609_010000__add_disaster_recovery_tables.sql (新增)
- infrastructure/k8s/multi-region/ (新增)

## 参考

- [PostgreSQL 流复制](https://www.postgresql.org/docs/current/warm-standby.html)
- [Kubernetes 多集群管理](https://kubernetes.io/docs/concepts/cluster-administration/federation/)
- [DNS 故障切换策略](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover.html)
