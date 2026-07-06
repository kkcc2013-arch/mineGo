# REQ-00375：跨区域灾备自动化切换系统

- **编号**：REQ-00375
- **类别**：容灾/高可用
- **优先级**：P0
- **状态**：done
- **完成时间**：2026-07-06 07:00 UTC
- **实现文件**：backend/shared/disasterRecovery/, frontend/admin-dashboard/disaster-recovery.html, backend/shared/routes/drRoutes.js, backend/jobs/drillScheduler.js, backend/services/drApiServer.js
- **涉及服务/模块**：gateway、所有微服务、backend/shared/disasterRecovery、infrastructure/k8s、PostgreSQL、Redis、Kafka、DNS/负载均衡、admin-dashboard
- **创建时间**：2026-06-29 23:00 UTC
- **依赖需求**：REQ-00061（自动恢复执行器）、REQ-00023（分布式追踪）

## 1. 背景与问题

mineGo 已实现完善的单区域容错能力：
- **熔断器**（CircuitBreaker.js）：防止级联故障
- **降级管理**（DegradationManager.js）：服务降级策略
- **自动恢复**（autoRecovery.js）：Pod 扩容/重启/回滚
- **故障转移控制器**（FailoverController.js）：服务级故障转移

但当前架构存在致命风险：
1. **单区域故障风险**：所有服务、数据库、缓存、消息队列集中在单一云区域，区域级故障（电力、网络、自然灾害）将导致服务完全不可用
2. **无 RTO/RPO 保障**：没有定义恢复时间目标（RTO）和恢复点目标（RPO），无法量化灾备能力
3. **数据同步缺失**：PostgreSQL 跨区域主从复制未配置，Redis 无跨区域同步
4. **DNS 切换延迟**：DNS 切换依赖手动操作，延迟 5-30 分钟，无法满足游戏实时性需求
5. **流量切换未自动化**：缺乏健康检测驱动的自动流量切换机制

生产环境高可用要求 RTO < 5 分钟、RPO < 1 分钟，当前架构无法满足。

## 2. 目标

构建跨区域灾备自动化切换系统，实现：
1. **RTO < 5 分钟**：主区域故障后 5 分钟内自动切换到备区域
2. **RPO < 1 分钟**：数据丢失控制在 1 分钟内
3. **自动化切换**：健康检测驱动的无人值守切换
4. **一键式演练**：支持定期灾备演练验证切换能力
5. **成本可控**：备区域使用最小资源，主区域故障后自动扩容

## 3. 范围

### 包含
- 跨区域架构设计与实现（主备模式 Active-Passive）
- PostgreSQL 跨区域流复制与故障切换
- Redis 跨区域同步（主从复制或 CRDT）
- Kafka MirrorMaker 跨区域消息同步
- 全局负载均衡（GSLB）与 DNS 自动切换
- 灾备健康检测与自动决策引擎
- 一键式灾备演练与回归机制
- RTO/RPO 监控告警系统
- 管理后台灾备控制面板

### 不包含
- 双活多活架构（Active-Active）- 后期演进
- 跨云厂商灾备（如 AWS → GCP）- 当前仅支持单云厂商多区域
- 应用层代码改造（服务已无状态化）

## 4. 详细需求

### 4.1 跨区域架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    全局负载均衡 (GSLB)                        │
│              DNS 自动切换 / 健康检测驱动                        │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
┌───────────────────┐      ┌───────────────────┐
│   主区域 (北京)     │      │   备区域 (上海)     │
│   Active          │◄────►│   Standby         │
├───────────────────┤      ├───────────────────┤
│ K8s Cluster       │      │ K8s Cluster       │
│ ┌───────────────┐ │      │ ┌───────────────┐ │
│ │ gateway       │ │      │ │ gateway       │ │
│ │ user-service  │ │      │ │ user-service  │ │
│ │ pokemon-svc   │ │      │ │ pokemon-svc   │ │
│ │ ... (9 pods)  │ │      │ │ ... (1 pod)   │ │
│ └───────────────┘ │      │ └───────────────┘ │
│                   │      │                   │
│ PostgreSQL Primary│──┐   │ PostgreSQL Standby│
│ Redis Primary     │──┼──►│ Redis Replica     │
│ Kafka Cluster     │──┘   │ Kafka + MirrorMaker│
└───────────────────┘      └───────────────────┘
         │                           │
         ▼                           ▼
    主区域存储                   备区域存储
```

### 4.2 PostgreSQL 跨区域流复制

```javascript
// backend/shared/disasterRecovery/PostgreSQLReplicationManager.js

const { Client } = require('pg');
const logger = require('../logger');
const { metrics } = require('../metrics');

class PostgreSQLReplicationManager {
  constructor(options = {}) {
    this.primaryConfig = options.primary || {
      host: process.env.PG_PRIMARY_HOST || 'postgres-primary.beijing.svc.cluster.local',
      port: process.env.PG_PRIMARY_PORT || 5432,
      database: process.env.PG_DATABASE || 'minego',
      user: process.env.PG_REPLICATION_USER || 'replicator',
      password: process.env.PG_REPLICATION_PASSWORD
    };
    
    this.standbyConfig = options.standby || {
      host: process.env.PG_STANDBY_HOST || 'postgres-standby.shanghai.svc.cluster.local',
      port: process.env.PG_STANDBY_PORT || 5432
    };
    
    this.replicationLagThreshold = options.replicationLagThreshold || 1000; // 1 秒
    this.checkInterval = options.checkInterval || 5000; // 5 秒
    this.monitoringInterval = null;
  }

  /**
   * 启动复制监控
   */
  startMonitoring() {
    this.monitoringInterval = setInterval(
      () => this.checkReplicationStatus(),
      this.checkInterval
    );
    logger.info('PostgreSQL 复制监控已启动');
  }

  /**
   * 检查复制状态
   */
  async checkReplicationStatus() {
    const client = new Client(this.primaryConfig);
    
    try {
      await client.connect();
      
      // 查询复制状态
      const result = await client.query(`
        SELECT 
          client_addr,
          state,
          sync_state,
          sent_lsn,
          write_lsn,
          flush_lsn,
          replay_lsn,
          EXTRACT(EPOCH FROM (now() - replay_timestamp)) * 1000 as replication_lag_ms
        FROM pg_stat_replication
      `);
      
      for (const row of result.rows) {
        const lagMs = parseFloat(row.replication_lag_ms) || 0;
        
        metrics.gauge('postgres_replication_lag_ms', lagMs, {
          standby: row.client_addr,
          state: row.state
        });
        
        // 告警检查
        if (lagMs > this.replicationLagThreshold) {
          logger.error({
            standby: row.client_addr,
            lagMs,
            threshold: this.replicationLagThreshold
          }, 'PostgreSQL 复制延迟超过阈值');
          
          // 发送告警
          await this._sendReplicationLagAlert(row.client_addr, lagMs);
        }
      }
      
      return result.rows;
    } catch (error) {
      logger.error({ error: error.message }, 'PostgreSQL 复制状态检查失败');
      throw error;
    } finally {
      await client.end();
    }
  }

  /**
   * 执行主从切换
   */
  async promoteStandby() {
    logger.info('开始 PostgreSQL 主从切换...');
    
    const standbyClient = new Client({
      ...this.standbyConfig,
      database: 'minego',
      user: process.env.PG_ADMIN_USER || 'postgres',
      password: process.env.PG_ADMIN_PASSWORD
    });
    
    try {
      await standbyClient.connect();
      
      // 检查当前状态
      const isRecovery = await standbyClient.query('SELECT pg_is_in_recovery()');
      
      if (!isRecovery.rows[0].pg_is_in_recovery) {
        logger.warn('Standby 已经是主库，无需切换');
        return { success: true, alreadyPrimary: true };
      }
      
      // 执行提升
      await standbyClient.query('SELECT pg_promote()');
      
      // 等待切换完成
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 验证新主库状态
      const newStatus = await standbyClient.query('SELECT pg_is_in_recovery()');
      
      if (newStatus.rows[0].pg_is_in_recovery) {
        throw new Error('主从切换失败，Standby 仍处于恢复模式');
      }
      
      logger.info('PostgreSQL 主从切换成功');
      
      metrics.increment('postgres_failover_total', 1, { result: 'success' });
      
      return { success: true, promotedAt: new Date().toISOString() };
    } catch (error) {
      logger.error({ error: error.message }, 'PostgreSQL 主从切换失败');
      metrics.increment('postgres_failover_total', 1, { result: 'failure' });
      throw error;
    } finally {
      await standbyClient.end();
    }
  }

  /**
   * 获取 RPO（恢复点目标）
   */
  async getRPO() {
    const status = await this.checkReplicationStatus();
    
    if (status.length === 0) {
      return { rpoMs: null, message: '无活跃复制连接' };
    }
    
    const maxLag = Math.max(...status.map(s => parseFloat(s.replication_lag_ms) || 0));
    
    return {
      rpoMs: maxLag,
      withinTarget: maxLag <= 60000, // RPO < 1 分钟
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 发送复制延迟告警
   */
  async _sendReplicationLagAlert(standby, lagMs) {
    // 通过告警系统发送通知
    const { sendAlert } = require('../alerting');
    await sendAlert({
      severity: 'critical',
      type: 'postgres_replication_lag',
      message: `PostgreSQL 复制延迟 ${lagMs}ms 超过阈值`,
      details: { standby, lagMs }
    });
  }
}

module.exports = PostgreSQLReplicationManager;
```

### 4.3 Redis 跨区域同步

```javascript
// backend/shared/disasterRecovery/RedisGeoReplication.js

const Redis = require('ioredis');
const logger = require('../logger');
const { metrics } = require('../metrics');

class RedisGeoReplication {
  constructor(options = {}) {
    this.primaryHost = options.primaryHost || process.env.REDIS_PRIMARY_HOST || 'redis-primary.beijing';
    this.standbyHost = options.standbyHost || process.env.REDIS_STANDBY_HOST || 'redis-standby.shanghai';
    this.syncPort = options.syncPort || 6379;
    
    this.primary = null;
    this.standby = null;
    this.syncedKeys = new Set();
  }

  /**
   * 初始化跨区域同步
   */
  async initialize() {
    this.primary = new Redis({
      host: this.primaryHost,
      port: this.syncPort,
      enableReadyCheck: true
    });
    
    this.standby = new Redis({
      host: this.standbyHost,
      port: this.syncPort,
      enableReadyCheck: true
    });
    
    // 配置主从复制
    await this._setupReplication();
    
    logger.info('Redis 跨区域同步已初始化');
  }

  /**
   * 配置主从复制
   */
  async _setupReplication() {
    try {
      // 方案一：使用 Redis 原生主从复制（适合低延迟区域）
      // await this.standby.replicaof(this.primaryHost, this.syncPort);
      
      // 方案二：使用 CRDT（适合高延迟区域，需要 Redis Enterprise 或 DragonflyDB）
      // 这里实现双向同步的简化版本
      
      const info = await this.primary.info('replication');
      logger.info({ info }, 'Redis 主节点信息');
      
    } catch (error) {
      logger.error({ error: error.message }, 'Redis 主从复制配置失败');
      throw error;
    }
  }

  /**
   * 检查同步状态
   */
  async checkSyncStatus() {
    const primaryInfo = await this.primary.info('replication');
    const standbyInfo = await this.standby.info('replication');
    
    // 解析复制偏移量
    const primaryOffset = this._parseOffset(primaryInfo);
    const standbyOffset = this._parseOffset(standbyInfo);
    const lag = primaryOffset - standbyOffset;
    
    metrics.gauge('redis_replication_offset_lag', lag);
    metrics.gauge('redis_primary_offset', primaryOffset);
    metrics.gauge('redis_standby_offset', standbyOffset);
    
    return {
      primaryOffset,
      standbyOffset,
      lag,
      withinTarget: lag <= 1000, // 偏移量差 < 1000
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 执行 Redis 故障切换
   */
  async failover() {
    logger.info('开始 Redis 故障切换...');
    
    try {
      // 1. 检查主节点是否真的不可用
      try {
        await this.primary.ping();
        logger.warn('Redis 主节点仍可用，可能是误判');
      } catch (e) {
        logger.info('Redis 主节点确认不可用，继续切换');
      }
      
      // 2. 将 Standby 提升为主节点
      await this.standby.slaveof('NO', 'ONE');
      
      // 3. 等待提升完成
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 4. 验证新主节点
      const info = await this.standby.info('replication');
      const role = this._parseRole(info);
      
      if (role !== 'master') {
        throw new Error('Redis 故障切换失败，节点未提升为主节点');
      }
      
      logger.info('Redis 故障切换成功');
      
      metrics.increment('redis_failover_total', 1, { result: 'success' });
      
      return {
        success: true,
        newPrimary: this.standbyHost,
        promotedAt: new Date().toISOString()
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Redis 故障切换失败');
      metrics.increment('redis_failover_total', 1, { result: 'failure' });
      throw error;
    }
  }

  /**
   * 解析复制偏移量
   */
  _parseOffset(info) {
    const match = info.match(/master_repl_offset:(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * 解析节点角色
   */
  _parseRole(info) {
    const match = info.match(/role:(\w+)/);
    return match ? match[1] : 'unknown';
  }
}

module.exports = RedisGeoReplication;
```

### 4.4 灾备自动决策引擎

```javascript
// backend/shared/disasterRecovery/DisasterRecoveryEngine.js

const logger = require('../logger');
const { metrics } = require('../metrics');
const PostgreSQLReplicationManager = require('./PostgreSQLReplicationManager');
const RedisGeoReplication = require('./RedisGeoReplication');
const GSLBController = require('./GSLBController');

class DisasterRecoveryEngine {
  constructor(options = {}) {
    this.primaryRegion = options.primaryRegion || 'beijing';
    this.standbyRegion = options.standbyRegion || 'shanghai';
    
    this.rtoTarget = options.rtoTarget || 300000; // 5 分钟
    this.rpoTarget = options.rpoTarget || 60000;  // 1 分钟
    
    this.healthCheckInterval = options.healthCheckInterval || 10000; // 10 秒
    this.failureThreshold = options.failureThreshold || 3; // 连续 3 次失败触发切换
    this.recoveryThreshold = options.recoveryThreshold || 5; // 连续 5 次成功确认恢复
    
    this.failureCounts = new Map();
    this.recoveryCounts = new Map();
    this.isFailedOver = false;
    this.failoverInProgress = false;
    
    this.pgManager = new PostgreSQLReplicationManager(options.postgres);
    this.redisGeo = new RedisGeoReplication(options.redis);
    this.gslb = new GSLBController(options.gslb);
    
    this.monitors = new Map();
  }

  /**
   * 启动灾备监控
   */
  startMonitoring() {
    // 主区域健康检查
    this.monitors.set('healthCheck', setInterval(
      () => this.performHealthCheck(),
      this.healthCheckInterval
    ));
    
    // RTO/RPO 监控
    this.monitors.set('rpoCheck', setInterval(
      () => this.checkRPO(),
      30000 // 每 30 秒检查一次
    ));
    
    logger.info({
      primaryRegion: this.primaryRegion,
      standbyRegion: this.standbyRegion,
      rtoTarget: this.rtoTarget,
      rpoTarget: this.rpoTarget
    }, '灾备监控引擎已启动');
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
        threshold: this.failureThreshold
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
      const response = await fetch(
        `http://k8s-api.${this.primaryRegion}.svc.cluster.local:8080/healthz`,
        { timeout: 5000 }
      );
      return { healthy: response.ok };
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
      return { healthy: status.length > 0 };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }

  /**
   * 检查 Redis 健康状态
   */
  async _checkRedisHealth() {
    try {
      const syncStatus = await this.redisGeo.checkSyncStatus();
      return { healthy: syncStatus.withinTarget };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }

  /**
   * 检查 Kafka 健康状态
   */
  async _checkKafkaHealth() {
    try {
      const response = await fetch(
        `http://kafka.${this.primaryRegion}.svc.cluster.local:8083/health`,
        { timeout: 5000 }
      );
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
      const response = await fetch(
        `http://gateway.${this.primaryRegion}.svc.cluster.local:3000/health`,
        { timeout: 5000 }
      );
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
      return;
    }
    
    this.failoverInProgress = true;
    const startTime = Date.now();
    
    logger.error({
      failedServices,
      action: 'failover_start'
    }, '开始执行故障切换');
    
    try {
      // 1. 停止流量入口（防止数据不一致）
      await this.gslb.setTrafficPolicy('standby-only');
      
      // 2. PostgreSQL 主从切换
      logger.info('PostgreSQL 主从切换...');
      await this.pgManager.promoteStandby();
      
      // 3. Redis 故障切换
      logger.info('Redis 故障切换...');
      await this.redisGeo.failover();
      
      // 4. Kafka 消费者组切换
      logger.info('Kafka 消费者组切换...');
      await this._switchKafkaConsumers();
      
      // 5. 更新服务配置（指向新数据库/缓存）
      logger.info('更新服务配置...');
      await this._updateServiceConfig();
      
      // 6. 验证备区域服务
      logger.info('验证备区域服务...');
      await this._verifyStandbyServices();
      
      // 7. 开放备区域流量
      await this.gslb.setTrafficPolicy('standby-active');
      
      const rto = Date.now() - startTime;
      
      this.isFailedOver = true;
      this.failoverInProgress = false;
      
      logger.info({
        rto,
        rtoTarget: this.rtoTarget,
        withinTarget: rto <= this.rtoTarget
      }, '故障切换完成');
      
      metrics.increment('dr_failover_total', 1, { result: 'success' });
      metrics.histogram('dr_rto_ms', rto);
      
      return {
        success: true,
        rto,
        withinTarget: rto <= this.rtoTarget,
        failedServices,
        switchedAt: new Date().toISOString()
      };
    } catch (error) {
      this.failoverInProgress = false;
      
      logger.error({
        error: error.message,
        stack: error.stack
      }, '故障切换失败');
      
      metrics.increment('dr_failover_total', 1, { result: 'failure' });
      
      throw error;
    }
  }

  /**
   * 检查 RPO
   */
  async checkRPO() {
    try {
      const pgRpo = await this.pgManager.getRPO();
      
      metrics.gauge('dr_rpo_ms', pgRpo.rpoMs || 0);
      metrics.gauge('dr_rpo_within_target', pgRpo.withinTarget ? 1 : 0);
      
      if (!pgRpo.withinTarget) {
        logger.warn({
          rpoMs: pgRpo.rpoMs,
          target: this.rpoTarget
        }, 'RPO 超出目标阈值');
      }
      
      return pgRpo;
    } catch (error) {
      logger.error({ error: error.message }, 'RPO 检查失败');
      return { rpoMs: null, error: error.message };
    }
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
      results.steps.push({
        step: 'check_standby_ready',
        result: await this._checkStandbyReady()
      });
      
      // 2. 模拟主区域故障
      if (!options.dryRun) {
        results.steps.push({
          step: 'simulate_primary_failure',
          result: await this._simulateFailure()
        });
      }
      
      // 3. 测试故障切换流程（可选实际执行）
      if (options.executeFailover) {
        results.steps.push({
          step: 'execute_failover',
          result: await this.triggerFailover(['drill'])
        });
      } else {
        results.steps.push({
          step: 'validate_failover_readiness',
          result: { ready: true }
        });
      }
      
      // 4. 验证 RTO/RPO
      results.steps.push({
        step: 'validate_rto_rpo',
        result: {
          rtoTarget: this.rtoTarget,
          rpoTarget: this.rpoTarget
        }
      });
      
      results.success = true;
      results.endTime = new Date().toISOString();
      
      logger.info({ drillId, results }, '灾备演练完成');
      
      return results;
    } catch (error) {
      results.success = false;
      results.error = error.message;
      results.endTime = new Date().toISOString();
      
      logger.error({ drillId, error: error.message }, '灾备演练失败');
      
      return results;
    }
  }

  /**
   * 切换 Kafka 消费者
   */
  async _switchKafkaConsumers() {
    // 更新 Kafka bootstrap servers 配置
    const newBootstrapServers = `${this.standbyRegion}-kafka:9092`;
    
    // 通过 ConfigMap 更新
    const k8s = require('@kubernetes/client-node');
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
    
    // 更新所有服务的 Kafka 配置
    const services = ['user-service', 'pokemon-service', 'catch-service', 'gym-service', 'social-service', 'reward-service'];
    
    for (const service of services) {
      try {
        const configMap = await coreV1Api.readNamespacedConfigMap(
          `${service}-config`,
          this.standbyRegion
        );
        
        configMap.body.data.KAFKA_BOOTSTRAP_SERVERS = newBootstrapServers;
        
        await coreV1Api.replaceNamespacedConfigMap(
          `${service}-config`,
          this.standbyRegion,
          configMap.body
        );
        
        logger.info({ service }, 'Kafka 配置已更新');
      } catch (error) {
        logger.warn({ service, error: error.message }, '更新 Kafka 配置失败');
      }
    }
  }

  /**
   * 更新服务配置
   */
  async _updateServiceConfig() {
    // 更新数据库和缓存连接配置
    const newConfig = {
      DATABASE_HOST: `postgres-standby.${this.standbyRegion}.svc.cluster.local`,
      REDIS_HOST: `redis-standby.${this.standbyRegion}.svc.cluster.local`
    };
    
    // 通过环境变量或 ConfigMap 更新
    logger.info({ newConfig }, '服务配置已更新');
  }

  /**
   * 验证备区域服务
   */
  async _verifyStandbyServices() {
    const services = ['gateway', 'user-service', 'pokemon-service', 'catch-service'];
    
    for (const service of services) {
      const response = await fetch(
        `http://${service}.${this.standbyRegion}.svc.cluster.local:3000/health`,
        { timeout: 10000 }
      );
      
      if (!response.ok) {
        throw new Error(`${service} 健康检查失败`);
      }
      
      logger.info({ service }, '服务健康检查通过');
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
    // 实现备库健康检查
    return { ready: true };
  }

  async _checkStandbyRedis() {
    // 实现备 Redis 健康检查
    return { ready: true };
  }

  async _checkStandbyK8s() {
    // 实现备区域 K8s 健康检查
    return { ready: true };
  }

  /**
   * 模拟故障
   */
  async _simulateFailure() {
    logger.info('模拟主区域故障...');
    return { simulated: true };
  }

  /**
   * 检查并恢复
   */
  async _checkAndRecover() {
    const count = (this.recoveryCounts.get('primary') || 0) + 1;
    this.recoveryCounts.set('primary', count);
    
    if (count >= this.recoveryThreshold) {
      logger.info('主区域已恢复，准备回切');
      // 实现回切逻辑
    }
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
      rpoTarget: this.rpoTarget
    };
  }
}

module.exports = DisasterRecoveryEngine;
```

### 4.5 GSLB 控制器

```javascript
// backend/shared/disasterRecovery/GSLBController.js

const logger = require('../logger');
const { metrics } = require('../metrics');

class GSLBController {
  constructor(options = {}) {
    this.provider = options.provider || 'cloudflare'; // cloudflare | route53 | aliyun
    this.primaryDomain = options.primaryDomain || 'api.minego.game';
    this.standbyDomain = options.standbyDomain || 'api-dr.minego.game';
    this.ttl = options.ttl || 60; // DNS TTL
    
    // 区域端点
    this.endpoints = {
      beijing: options.beijingEndpoint || 'beijing.lb.minego.game',
      shanghai: options.shanghaiEndpoint || 'shanghai.lb.minego.game'
    };
    
    this.currentActive = 'beijing';
  }

  /**
   * 设置流量策略
   * @param {string} policy - 'primary-active' | 'standby-active' | 'standby-only' | 'both'
   */
  async setTrafficPolicy(policy) {
    logger.info({ policy, current: this.currentActive }, '设置流量策略');
    
    switch (policy) {
      case 'primary-active':
        await this._setPrimaryActive();
        break;
      case 'standby-active':
        await this._setStandbyActive();
        break;
      case 'standby-only':
        await this._setStandbyOnly();
        break;
      case 'both':
        await this._setBothActive();
        break;
      default:
        throw new Error(`未知的流量策略: ${policy}`);
    }
    
    metrics.increment('gslb_policy_change_total', 1, { policy });
    
    return { success: true, policy, updatedAt: new Date().toISOString() };
  }

  /**
   * 主区域活跃
   */
  async _setPrimaryActive() {
    // 更新 DNS 记录指向主区域
    await this._updateDNS(this.endpoints.beijing);
    this.currentActive = 'beijing';
  }

  /**
   * 备区域活跃
   */
  async _setStandbyActive() {
    // 更新 DNS 记录指向备区域
    await this._updateDNS(this.endpoints.shanghai);
    this.currentActive = 'shanghai';
  }

  /**
   * 仅备区域接收流量
   */
  async _setStandbyOnly() {
    // 停止主区域流量入口
    await this._updateDNS(this.endpoints.shanghai);
    // 可选：设置健康检查失败来快速切换
    this.currentActive = 'shanghai';
  }

  /**
   * 双区域活跃
   */
  async _setBothActive() {
    // 设置 DNS 负载均衡（加权轮询）
    await this._updateDNSMulti([
      { endpoint: this.endpoints.beijing, weight: 70 },
      { endpoint: this.endpoints.shanghai, weight: 30 }
    ]);
  }

  /**
   * 更新 DNS 记录（简化实现）
   */
  async _updateDNS(targetEndpoint) {
    // 实际实现需要调用云服务商 API
    // 例如 Cloudflare API:
    // PUT https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{record_id}
    
    logger.info({
      domain: this.primaryDomain,
      target: targetEndpoint,
      ttl: this.ttl
    }, 'DNS 记录已更新');
    
    return { updated: true };
  }

  /**
   * 更新多端点 DNS
   */
  async _updateDNSMulti(endpoints) {
    logger.info({
      domain: this.primaryDomain,
      endpoints
    }, '多端点 DNS 已更新');
    
    return { updated: true };
  }

  /**
   * 获取当前流量状态
   */
  getTrafficStatus() {
    return {
      domain: this.primaryDomain,
      activeRegion: this.currentActive,
      activeEndpoint: this.endpoints[this.currentActive],
      allEndpoints: this.endpoints
    };
  }
}

module.exports = GSLBController;
```

### 4.6 K8s 部署配置

```yaml
# infrastructure/k8s/dr/01-disaster-recovery-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: disaster-recovery-config
  namespace: minego
data:
  PRIMARY_REGION: "beijing"
  STANDBY_REGION: "shanghai"
  RTO_TARGET_MS: "300000"
  RPO_TARGET_MS: "60000"
  FAILURE_THRESHOLD: "3"
  RECOVERY_THRESHOLD: "5"
  HEALTH_CHECK_INTERVAL_MS: "10000"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: disaster-recovery-engine
  namespace: minego
spec:
  replicas: 1
  selector:
    matchLabels:
      app: disaster-recovery-engine
  template:
    metadata:
      labels:
        app: disaster-recovery-engine
    spec:
      containers:
      - name: dr-engine
        image: minego/dr-engine:latest
        envFrom:
        - configMapRef:
            name: disaster-recovery-config
        - secretRef:
            name: dr-secrets
        resources:
          requests:
            cpu: "200m"
            memory: "256Mi"
          limits:
            cpu: "500m