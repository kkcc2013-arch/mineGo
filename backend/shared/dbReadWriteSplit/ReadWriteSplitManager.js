// backend/shared/dbReadWriteSplit/ReadWriteSplitManager.js
'use strict';

const { Pool } = require('pg');
const { createLogger } = require('../logger');
const promClient = require('prom-client');

const logger = createLogger('read-write-split-manager');

// Prometheus 指标
const metrics = {
  readQueryTotal: new promClient.Counter({
    name: 'db_read_query_total',
    help: 'Total read queries executed',
    labelNames: ['pool', 'table']
  }),
  
  writeQueryTotal: new promClient.Counter({
    name: 'db_write_query_total',
    help: 'Total write queries executed',
    labelNames: ['table']
  }),
  
  replicaLag: new promClient.Gauge({
    name: 'db_replica_lag_seconds',
    help: 'Current replica lag in seconds',
    labelNames: ['replica_id']
  }),
  
  failoverTotal: new promClient.Counter({
    name: 'db_failover_total',
    help: 'Total failover events',
    labelNames: ['reason']
  }),
  
  poolHealth: new promClient.Gauge({
    name: 'db_pool_health',
    help: 'Database pool health status (1=healthy, 0=unhealthy)',
    labelNames: ['pool_type', 'pool_id']
  })
};

class ReadWriteSplitManager {
  constructor(config = {}) {
    this.config = {
      // 主库配置
      primary: config.primary || {
        host: process.env.DB_PRIMARY_HOST || 'localhost',
        port: parseInt(process.env.DB_PRIMARY_PORT || '5432'),
        database: process.env.DB_NAME || 'minego',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'password',
        max: parseInt(process.env.DB_PRIMARY_POOL_SIZE || '20'),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000
      },
      
      // 副本库配置
      replicas: config.replicas || [
        {
          id: 'replica-1',
          host: process.env.DB_REPLICA1_HOST || 'localhost',
          port: parseInt(process.env.DB_REPLICA1_PORT || '5433'),
          database: process.env.DB_NAME || 'minego',
          user: process.env.DB_USER || 'postgres',
          password: process.env.DB_PASSWORD || 'password',
          max: parseInt(process.env.DB_REPLICA_POOL_SIZE || '15'),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
          weight: 1 // 负载均衡权重
        }
      ],
      
      // 延迟阈值配置
      lagThresholds: {
        warning: parseInt(process.env.REPLICA_LAG_WARNING_MS || '500'),    // 500ms 警告
        critical: parseInt(process.env.REPLICA_LAG_CRITICAL_MS || '2000'), // 2s 切换到主库
        max: parseInt(process.env.REPLICA_LAG_MAX_MS || '5000')            // 5s 副本下线
      },
      
      // 负载均衡策略
      loadBalanceStrategy: config.loadBalanceStrategy || 'round-robin', // round-robin | weighted | least-connections
      
      // 强一致性读取 Header
      consistencyHeader: config.consistencyHeader || 'x-consistency-level',
      
      // 需要强一致性的路径
      strongConsistencyPaths: config.strongConsistencyPaths || [
        '/api/payment',
        '/api/users/balance',
        '/api/trade',
        '/api/gym/battle'
      ]
    };
    
    // 连接池
    this.primaryPool = null;
    this.replicaPools = [];
    
    // 负载均衡状态
    this.currentReplicaIndex = 0;
    this.replicaConnections = {};
    
    // 副本健康状态
    this.replicaHealth = {};
    
    // 延迟监控数据
    this.lagData = {};
    
    // 初始化标志
    this.initialized = false;
  }
  
  /**
   * 初始化连接池
   */
  async initialize() {
    if (this.initialized) {
      return;
    }
    
    try {
      // 创建主库连接池
      this.primaryPool = new Pool(this.config.primary);
      
      this.primaryPool.on('error', (err) => {
        logger.error({ err }, 'Primary pool error');
        metrics.poolHealth.set({ pool_type: 'primary', pool_id: 'primary' }, 0);
      });
      
      this.primaryPool.on('connect', () => {
        metrics.poolHealth.set({ pool_type: 'primary', pool_id: 'primary' }, 1);
      });
      
      logger.info('Primary pool created');
      
      // 创建副本库连接池
      for (const replicaConfig of this.config.replicas) {
        const pool = new Pool(replicaConfig);
        
        pool.on('error', (err) => {
          logger.error({ err, replicaId: replicaConfig.id }, 'Replica pool error');
          this.markReplicaUnhealthy(replicaConfig.id);
          metrics.poolHealth.set({ pool_type: 'replica', pool_id: replicaConfig.id }, 0);
        });
        
        pool.on('connect', () => {
          metrics.poolHealth.set({ pool_type: 'replica', pool_id: replicaConfig.id }, 1);
        });
        
        this.replicaPools.push({
          id: replicaConfig.id,
          pool,
          weight: replicaConfig.weight,
          config: replicaConfig
        });
        
        this.replicaHealth[replicaConfig.id] = {
          healthy: true,
          lag: 0,
          lastCheck: null,
          connectionCount: 0
        };
        
        logger.info({ replicaId: replicaConfig.id }, 'Replica pool created');
      }
      
      this.initialized = true;
      logger.info('Read-write split manager initialized');
      
    } catch (err) {
      logger.error({ err }, 'Failed to initialize read-write split manager');
      throw err;
    }
  }
  
  /**
   * 执行查询（自动路由）
   * @param {string} sql - SQL 查询
   * @param {Array} params - 查询参数
   * @param {object} options - 选项 { consistency, table, requestId }
   */
  async query(sql, params = [], options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const isWrite = this.isWriteQuery(sql);
    const consistency = this.determineConsistency(sql, options);
    
    if (isWrite || consistency === 'strong') {
      // 写操作或强一致性读取 -> 主库
      return await this.executeQuery('primary', sql, params, options);
    } else {
      // 读操作 -> 副本库
      return await this.executeReadQuery(sql, params, options);
    }
  }
  
  /**
   * 判断是否为写操作
   */
  isWriteQuery(sql) {
    const writeKeywords = ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE'];
    const upperSQL = sql.trim().toUpperCase();
    return writeKeywords.some(keyword => upperSQL.startsWith(keyword));
  }
  
  /**
   * 确定一致性级别
   */
  determineConsistency(sql, options) {
    // 1. 显式指定一致性级别
    if (options.consistency) {
      return options.consistency;
    }
    
    // 2. 事务中的查询使用强一致性
    if (options.inTransaction) {
      return 'strong';
    }
    
    // 3. 根据路径判断
    if (options.path && this.config.strongConsistencyPaths.some(p => options.path.startsWith(p))) {
      return 'strong';
    }
    
    // 4. 默认使用 eventual 一致性
    return 'eventual';
  }
  
  /**
   * 执行读查询（负载均衡）
   */
  async executeReadQuery(sql, params, options) {
    const selectedReplica = this.selectReplica();
    
    if (!selectedReplica) {
      // 所有副本不可用，fallback 到主库
      logger.warn('All replicas unavailable, falling back to primary');
      metrics.failoverTotal.inc({ reason: 'replica_unavailable' });
      return await this.executeQuery('primary', sql, params, options);
    }
    
    try {
      const result = await selectedReplica.pool.query(sql, params);
      
      metrics.readQueryTotal.inc({ pool: selectedReplica.id, table: options.table || 'unknown' });
      
      return result;
      
    } catch (err) {
      logger.error({ err, replicaId: selectedReplica.id, sql: sql.substring(0, 100) }, 'Replica query failed');
      
      // 标记副本不健康
      this.markReplicaUnhealthy(selectedReplica.id);
      
      // Fallback 到主库
      logger.info({ replicaId: selectedReplica.id }, 'Falling back to primary for query');
      metrics.failoverTotal.inc({ reason: 'query_error' });
      
      return await this.executeQuery('primary', sql, params, options);
    }
  }
  
  /**
   * 选择副本（负载均衡）
   */
  selectReplica() {
    const healthyReplicas = this.replicaPools.filter(r => 
      this.replicaHealth[r.id].healthy && 
      this.lagData[r.id] < this.config.lagThresholds.critical
    );
    
    if (healthyReplicas.length === 0) {
      return null;
    }
    
    switch (this.config.loadBalanceStrategy) {
      case 'round-robin':
        return this.selectRoundRobin(healthyReplicas);
      
      case 'weighted':
        return this.selectWeighted(healthyReplicas);
      
      case 'least-connections':
        return this.selectLeastConnections(healthyReplicas);
      
      default:
        return healthyReplicas[0];
    }
  }
  
  /**
   * 轮询选择
   */
  selectRoundRobin(replicas) {
    const replica = replicas[this.currentReplicaIndex % replicas.length];
    this.currentReplicaIndex++;
    return replica;
  }
  
  /**
   * 加权选择
   */
  selectWeighted(replicas) {
    const totalWeight = replicas.reduce((sum, r) => sum + r.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const replica of replicas) {
      random -= replica.weight;
      if (random <= 0) {
        return replica;
      }
    }
    
    return replicas[0];
  }
  
  /**
   * 最少连接选择
   */
  selectLeastConnections(replicas) {
    let minConnections = Infinity;
    let selected = replicas[0];
    
    for (const replica of replicas) {
      const connections = this.replicaHealth[replica.id].connectionCount;
      if (connections < minConnections) {
        minConnections = connections;
        selected = replica;
      }
    }
    
    return selected;
  }
  
  /**
   * 执行查询（指定池）
   */
  async executeQuery(poolType, sql, params, options) {
    const pool = poolType === 'primary' ? this.primaryPool : this.selectReplica()?.pool;
    
    if (!pool) {
      throw new Error(`Pool ${poolType} not available`);
    }
    
    const startTime = Date.now();
    
    try {
      const result = await pool.query(sql, params);
      
      const duration = Date.now() - startTime;
      logger.debug({ poolType, duration, rows: result.rowCount }, 'Query executed');
      
      if (poolType === 'primary') {
        metrics.writeQueryTotal.inc({ table: options.table || 'unknown' });
      }
      
      return result;
      
    } catch (err) {
      logger.error({ err, poolType, sql: sql.substring(0, 100) }, 'Query execution failed');
      throw err;
    }
  }
  
  /**
   * 标记副本不健康
   */
  markReplicaUnhealthy(replicaId) {
    if (this.replicaHealth[replicaId]) {
      this.replicaHealth[replicaId].healthy = false;
      this.replicaHealth[replicaId].lastFailure = new Date();
      
      logger.warn({ replicaId }, 'Replica marked as unhealthy');
      metrics.poolHealth.set({ pool_type: 'replica', pool_id: replicaId }, 0);
      
      // 30秒后自动重试
      setTimeout(() => {
        this.checkReplicaHealth(replicaId);
      }, 30000);
    }
  }
  
  /**
   * 检查副本健康状态
   */
  async checkReplicaHealth(replicaId) {
    const replica = this.replicaPools.find(r => r.id === replicaId);
    
    if (!replica) {
      return;
    }
    
    try {
      const result = await replica.pool.query('SELECT 1 as health_check');
      
      if (result.rows[0].health_check === 1) {
        this.replicaHealth[replicaId].healthy = true;
        this.replicaHealth[replicaId].lastCheck = new Date();
        
        logger.info({ replicaId }, 'Replica health check passed');
        metrics.poolHealth.set({ pool_type: 'replica', pool_id: replicaId }, 1);
      }
      
    } catch (err) {
      logger.error({ err, replicaId }, 'Replica health check failed');
      this.markReplicaUnhealthy(replicaId);
    }
  }
  
  /**
   * 更新副本延迟数据
   */
  updateLagData(replicaId, lagMs) {
    this.lagData[replicaId] = lagMs;
    this.replicaHealth[replicaId].lag = lagMs;
    this.replicaHealth[replicaId].lastCheck = new Date();
    
    metrics.replicaLag.set({ replica_id: replicaId }, lagMs / 1000);
    
    // 检查延迟阈值
    if (lagMs >= this.config.lagThresholds.max) {
      logger.error({ replicaId, lagMs }, 'Replica lag exceeded max threshold, marking unhealthy');
      this.markReplicaUnhealthy(replicaId);
    } else if (lagMs >= this.config.lagThresholds.critical) {
      logger.warn({ replicaId, lagMs }, 'Replica lag exceeded critical threshold');
    } else if (lagMs >= this.config.lagThresholds.warning) {
      logger.info({ replicaId, lagMs }, 'Replica lag exceeded warning threshold');
    }
  }
  
  /**
   * 获取健康状态摘要
   */
  getHealthSummary() {
    return {
      primary: {
        healthy: true,
        totalConnections: this.primaryPool?.totalCount || 0,
        idleConnections: this.primaryPool?.idleCount || 0,
        waitingCount: this.primaryPool?.waitingCount || 0
      },
      replicas: this.replicaPools.map(r => ({
        id: r.id,
        healthy: this.replicaHealth[r.id].healthy,
        lag: this.lagData[r.id] || 0,
        totalConnections: r.pool?.totalCount || 0,
        idleConnections: r.pool?.idleCount || 0,
        waitingCount: r.pool?.waitingCount || 0
      }))
    };
  }
  
  /**
   * 关闭所有连接池
   */
  async shutdown() {
    logger.info('Shutting down read-write split manager');
    
    if (this.primaryPool) {
      await this.primaryPool.end();
      logger.info('Primary pool closed');
    }
    
    for (const replica of this.replicaPools) {
      await replica.pool.end();
      logger.info({ replicaId: replica.id }, 'Replica pool closed');
    }
    
    this.initialized = false;
  }
}

// 单例实例
let instance = null;

function getReadWriteSplitManager(config) {
  if (!instance) {
    instance = new ReadWriteSplitManager(config);
  }
  return instance;
}

module.exports = {
  ReadWriteSplitManager,
  getReadWriteSplitManager,
  metrics
};
