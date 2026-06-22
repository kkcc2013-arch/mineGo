/**
 * REQ-00259: 数据库读写分离路由器
 * 智能路由数据库查询到主库或从库
 * 
 * 创建时间: 2026-06-22 00:55
 */

'use strict';

const { Pool } = require('pg');
const { createLogger } = require('./logger');
const promClient = require('prom-client');

const logger = createLogger('read-write-router');

// ============================================================
// Prometheus 指标
// ============================================================

const metrics = {
  queriesRoutedTotal: new promClient.Counter({
    name: 'minego_db_queries_routed_total',
    help: 'Total number of queries routed',
    labelNames: ['type', 'target', 'service']
  }),
  
  routingLatencyMs: new promClient.Histogram({
    name: 'minego_db_routing_latency_ms',
    help: 'Query routing latency in milliseconds',
    labelNames: ['type', 'target'],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500]
  }),
  
  replicaHealthGauge: new promClient.Gauge({
    name: 'minego_db_replica_health',
    help: 'Replica health status (1=healthy, 0=unhealthy)',
    labelNames: ['node']
  }),
  
  syncDelayMs: new promClient.Gauge({
    name: 'minego_db_sync_delay_ms',
    help: 'Replication sync delay in milliseconds',
    labelNames: ['node']
  }),
  
  failoverTotal: new promClient.Counter({
    name: 'minego_db_failover_total',
    help: 'Total number of failover events',
    labelNames: ['reason', 'success']
  }),
  
  activeConnectionsGauge: new promClient.Gauge({
    name: 'minego_db_active_connections',
    help: 'Active database connections',
    labelNames: ['node', 'type']
  })
};

// ============================================================
// 配置常量
// ============================================================

const DEFAULT_CONFIG = {
  // 主库配置
  master: {
    connectionString: process.env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
  },
  
  // 从库配置
  replicas: process.env.REPLICA_URLS ? 
    process.env.REPLICA_URLS.split(',').map((url, i) => ({
      name: `replica-${i + 1}`,
      connectionString: url.trim(),
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000
    })) : [],
  
  // 同步延迟阈值（毫秒）
  syncDelayThreshold: parseInt(process.env.SYNC_DELAY_THRESHOLD_MS || '100'),
  
  // 健康检查间隔（毫秒）
  healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '5000'),
  
  // 负载均衡策略: round-robin, least-connections, random
  loadBalanceStrategy: process.env.LOAD_BALANCE_STRATEGY || 'round-robin',
  
  // 从库不可用时是否降级到主库读取
  fallbackToMaster: process.env.FALLBACK_TO_MASTER !== 'false',
  
  // 是否启用路由日志
  enableRoutingLog: process.env.ENABLE_ROUTING_LOG !== 'false'
};

// ============================================================
// 读写分离路由器类
// ============================================================

class ReadWriteRouter {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // 主库连接池
    this.masterPool = null;
    
    // 从库连接池列表
    this.replicaPools = new Map();
    
    // 节点健康状态
    this.nodeHealth = new Map();
    
    // 负载均衡索引
    this.roundRobinIndex = 0;
    
    // 统计信息
    this.stats = {
      readQueries: 0,
      writeQueries: 0,
      replicaHits: 0,
      masterFallbacks: 0
    };
    
    // 初始化标志
    this.initialized = false;
    
    // 健康检查定时器
    this.healthCheckTimer = null;
  }

  /**
   * 初始化路由器
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      // 创建主库连接池
      this.masterPool = new Pool(this.config.master);
      logger.info('Master pool created');
      
      // 创建从库连接池
      for (const replicaConfig of this.config.replicas) {
        const pool = new Pool(replicaConfig);
        this.replicaPools.set(replicaConfig.name, pool);
        this.nodeHealth.set(replicaConfig.name, {
          healthy: false,
          syncDelay: Infinity,
          activeConnections: 0,
          lastCheck: null
        });
        logger.info({ replica: replicaConfig.name }, 'Replica pool created');
      }
      
      // 启动健康检查
      this.startHealthCheck();
      
      this.initialized = true;
      logger.info('Read-write router initialized', {
        replicas: this.config.replicas.length,
        strategy: this.config.loadBalanceStrategy
      });
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to initialize read-write router');
      throw error;
    }
  }

  /**
   * 执行查询（自动路由）
   */
  async query(sql, params = [], options = {}) {
    const startTime = Date.now();
    const queryType = this.getQueryType(sql);
    const service = options.service || 'unknown';
    
    let target = 'master';
    let result;
    
    try {
      // 确定目标节点
      if (queryType === 'read' && !options.forceMaster) {
        const replica = await this.selectReplica();
        if (replica) {
          target = replica;
          result = await this.executeOnReplica(replica, sql, params);
          this.stats.replicaHits++;
        } else if (this.config.fallbackToMaster) {
          target = 'master';
          result = await this.executeOnMaster(sql, params);
          this.stats.masterFallbacks++;
        } else {
          throw new Error('No healthy replica available');
        }
      } else {
        result = await this.executeOnMaster(sql, params);
        this.stats.writeQueries++;
      }
      
      // 更新统计
      if (queryType === 'read') {
        this.stats.readQueries++;
      }
      
      // 记录指标
      const latency = Date.now() - startTime;
      metrics.queriesRoutedTotal.inc({ type: queryType, target, service });
      metrics.routingLatencyMs.observe({ type: queryType, target }, latency);
      
      // 记录路由日志
      if (this.config.enableRoutingLog && process.env.NODE_ENV !== 'test') {
        await this.logRouting(queryType, target, service, latency, true);
      }
      
      return result;
    } catch (error) {
      // 记录失败日志
      const latency = Date.now() - startTime;
      if (this.config.enableRoutingLog && process.env.NODE_ENV !== 'test') {
        await this.logRouting(queryType, target, service, latency, false, error.message);
      }
      
      logger.error({ 
        sql: sql.substring(0, 100), 
        target,
        error: error.message 
      }, 'Query execution failed');
      
      throw error;
    }
  }

  /**
   * 在主库执行
   */
  async executeOnMaster(sql, params) {
    const client = await this.masterPool.connect();
    try {
      const result = await client.query(sql, params);
      return result;
    } finally {
      client.release();
    }
  }

  /**
   * 在从库执行
   */
  async executeOnReplica(replicaName, sql, params) {
    const pool = this.replicaPools.get(replicaName);
    if (!pool) {
      throw new Error(`Replica pool not found: ${replicaName}`);
    }
    
    const client = await pool.connect();
    try {
      const result = await client.query(sql, params);
      return result;
    } finally {
      client.release();
    }
  }

  /**
   * 选择从库
   */
  async selectReplica() {
    // 获取健康的从库
    const healthyReplicas = this.getHealthyReplicas();
    
    if (healthyReplicas.length === 0) {
      logger.warn('No healthy replicas available');
      return null;
    }
    
    // 根据策略选择
    switch (this.config.loadBalanceStrategy) {
      case 'round-robin':
        return this.selectRoundRobin(healthyReplicas);
      case 'least-connections':
        return this.selectLeastConnections(healthyReplicas);
      case 'random':
        return this.selectRandom(healthyReplicas);
      default:
        return this.selectRoundRobin(healthyReplicas);
    }
  }

  /**
   * 获取健康的从库列表
   */
  getHealthyReplicas() {
    const healthy = [];
    
    for (const [name, health] of this.nodeHealth) {
      if (health.healthy && health.syncDelay <= this.config.syncDelayThreshold) {
        healthy.push({ name, ...health });
      }
    }
    
    return healthy;
  }

  /**
   * 轮询选择
   */
  selectRoundRobin(replicas) {
    this.roundRobinIndex = (this.roundRobinIndex + 1) % replicas.length;
    return replicas[this.roundRobinIndex].name;
  }

  /**
   * 最少连接选择
   */
  selectLeastConnections(replicas) {
    replicas.sort((a, b) => a.activeConnections - b.activeConnections);
    return replicas[0].name;
  }

  /**
   * 随机选择
   */
  selectRandom(replicas) {
    const index = Math.floor(Math.random() * replicas.length);
    return replicas[index].name;
  }

  /**
   * 获取查询类型
   */
  getQueryType(sql) {
    const normalizedSql = sql.trim().toUpperCase();
    
    // 事务控制语句始终在主库执行
    if (/^(BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT)/.test(normalizedSql)) {
      return 'write';
    }
    
    // 读操作
    if (/^(SELECT|EXPLAIN|SHOW)/.test(normalizedSql)) {
      // 检查是否包含写操作（如 SELECT ... FOR UPDATE）
      if (/FOR UPDATE|FOR SHARE|LOCK/.test(normalizedSql)) {
        return 'write';
      }
      return 'read';
    }
    
    // 写操作
    if (/^(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)/.test(normalizedSql)) {
      return 'write';
    }
    
    // 默认主库
    return 'write';
  }

  /**
   * 启动健康检查
   */
  startHealthCheck() {
    this.healthCheckTimer = setInterval(async () => {
      await this.checkReplicasHealth();
    }, this.config.healthCheckInterval);
  }

  /**
   * 检查从库健康状态
   */
  async checkReplicasHealth() {
    for (const [name, pool] of this.replicaPools) {
      try {
        const health = await this.checkSingleReplica(name, pool);
        this.nodeHealth.set(name, health);
        
        // 更新指标
        metrics.replicaHealthGauge.set({ node: name }, health.healthy ? 1 : 0);
        metrics.syncDelayMs.set({ node: name }, health.syncDelay);
        metrics.activeConnectionsGauge.set(
          { node: name, type: 'active' }, 
          health.activeConnections
        );
        
        // 更新数据库记录
        await this.updateReplicaStatusInDb(name, health);
      } catch (error) {
        logger.error({ replica: name, error: error.message }, 'Health check failed');
        
        // 标记为不健康
        const health = this.nodeHealth.get(name);
        if (health) {
          health.healthy = false;
          health.lastCheck = new Date();
        }
        
        metrics.replicaHealthGauge.set({ node: name }, 0);
      }
    }
  }

  /**
   * 检查单个从库
   */
  async checkSingleReplica(name, pool) {
    const client = await pool.connect();
    try {
      const startTime = Date.now();
      
      // 简单查询测试
      await client.query('SELECT 1');
      
      // 获取复制延迟
      const lagResult = await client.query(`
        SELECT 
          EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 as sync_delay_ms,
          pg_last_xact_replay_timestamp() as last_replay,
          pg_is_in_recovery() as is_replica
      `);
      
      const syncDelay = lagResult.rows[0].sync_delay_ms || 0;
      const isReplica = lagResult.rows[0].is_replica;
      
      // 获取连接数
      const connResult = await client.query(`
        SELECT COUNT(*) FILTER (WHERE state = 'active') as active,
               COUNT(*) FILTER (WHERE state = 'idle') as idle
        FROM pg_stat_activity
        WHERE datname = current_database()
      `);
      
      return {
        healthy: isReplica && syncDelay <= this.config.syncDelayThreshold,
        syncDelay: Math.round(syncDelay),
        activeConnections: parseInt(connResult.rows[0].active) || 0,
        idleConnections: parseInt(connResult.rows[0].idle) || 0,
        lastCheck: new Date()
      };
    } finally {
      client.release();
    }
  }

  /**
   * 更新数据库中的从库状态
   */
  async updateReplicaStatusInDb(name, health) {
    try {
      await this.masterPool.query(`
        SELECT update_replica_health($1, $2, $3, NULL, $4, NULL)
      `, [name, health.healthy, health.syncDelay, health.activeConnections]);
    } catch (error) {
      // 不抛出错误，避免影响正常查询
      logger.warn({ replica: name, error: error.message }, 'Failed to update replica status in DB');
    }
  }

  /**
   * 记录路由日志
   */
  async logRouting(queryType, target, service, latency, success, error = null) {
    try {
      await this.masterPool.query(`
        SELECT log_routing_decision($1, $2, $3, NULL, NULL, $4, $5, $6)
      `, [queryType, target, service, latency, success, error]);
    } catch (err) {
      logger.warn({ error: err.message }, 'Failed to log routing decision');
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      replicas: Object.fromEntries(this.nodeHealth)
    };
  }

  /**
   * 关闭所有连接池
   */
  async shutdown() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    
    if (this.masterPool) {
      await this.masterPool.end();
    }
    
    for (const pool of this.replicaPools.values()) {
      await pool.end();
    }
    
    logger.info('Read-write router shutdown');
  }
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  ReadWriteRouter,
  metrics,
  DEFAULT_CONFIG
};
