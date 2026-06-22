/**
 * REQ-00259: 数据库复制健康监控服务
 * 监控主从同步状态，自动故障切换
 * 
 * 创建时间: 2026-06-22 01:00
 */

'use strict';

const { createLogger } = require('./logger');
const promClient = require('prom-client');
const { Pool } = require('pg');

const logger = createLogger('replication-monitor');

// ============================================================
// Prometheus 指标
// ============================================================

const metrics = {
  replicationLagBytes: new promClient.Gauge({
    name: 'minego_replication_lag_bytes',
    help: 'Replication lag in bytes',
    labelNames: ['replica']
  }),
  
  replicationStatus: new promClient.Gauge({
    name: 'minego_replication_status',
    help: 'Replication status (1=streaming, 0=not streaming)',
    labelNames: ['replica']
  }),
  
  walPosition: new promClient.Gauge({
    name: 'minego_wal_position',
    help: 'Current WAL position',
    labelNames: ['node', 'type'] // type: sent, write, flush, replay
  })
};

// ============================================================
// 配置
// ============================================================

const DEFAULT_CONFIG = {
  // 主库连接
  masterUrl: process.env.DATABASE_URL,
  
  // 监控间隔（毫秒）
  monitorInterval: parseInt(process.env.REPLICATION_MONITOR_INTERVAL_MS || '10000'),
  
  // 告警阈值
  alertThresholds: {
    syncDelayMs: parseInt(process.env.ALERT_SYNC_DELAY_MS || '1000'),
    lagBytes: parseInt(process.env.ALERT_LAG_BYTES || '10485760'), // 10MB
    inactiveSeconds: parseInt(process.env.ALERT_INACTIVE_SECONDS || '30')
  },
  
  // 故障切换配置
  failover: {
    enabled: process.env.FAILOVER_ENABLED === 'true',
    autoPromote: process.env.AUTO_PROMOTE_REPLICA === 'true',
    minReplicasForFailover: parseInt(process.env.MIN_REPLICAS_FOR_FAILOVER || '1'),
    cooldownMs: parseInt(process.env.FAILOVER_COOLDOWN_MS || '60000')
  }
};

// ============================================================
// 复制监控类
// ============================================================

class ReplicationMonitor {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // 主库连接池
    this.masterPool = null;
    
    // 监控定时器
    this.monitorTimer = null;
    
    // 从库状态
    this.replicaStates = new Map();
    
    // 上次故障切换时间
    this.lastFailoverTime = 0;
    
    // 初始化标志
    this.initialized = false;
  }

  /**
   * 初始化监控
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      this.masterPool = new Pool({
        connectionString: this.config.masterUrl,
        max: 5
      });
      
      // 启动监控
      this.startMonitoring();
      
      this.initialized = true;
      logger.info('Replication monitor initialized');
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to initialize replication monitor');
      throw error;
    }
  }

  /**
   * 启动监控
   */
  startMonitoring() {
    // 立即执行一次
    this.checkReplication();
    
    // 定时执行
    this.monitorTimer = setInterval(() => {
      this.checkReplication().catch(err => {
        logger.error({ error: err.message }, 'Replication check failed');
      });
    }, this.config.monitorInterval);
  }

  /**
   * 检查复制状态
   */
  async checkReplication() {
    try {
      // 获取主库 WAL 位置
      const masterWal = await this.getMasterWalPosition();
      
      // 获取从库状态
      const replicas = await this.getReplicaStatus();
      
      for (const replica of replicas) {
        const state = {
          name: replica.client_addr || replica.application_name,
          state: replica.state,
          syncState: replica.sync_state,
          sentLsn: replica.sent_lsn,
          writeLsn: replica.write_lsn,
          flushLsn: replica.flush_lsn,
          replayLsn: replica.replay_lsn,
          lagBytes: replica.replay_lsn ? this.calculateLagBytes(masterWal.currentLsn, replica.replay_lsn) : 0,
          lastUpdate: new Date()
        };
        
        this.replicaStates.set(state.name, state);
        
        // 更新指标
        metrics.replicationLagBytes.set({ replica: state.name }, state.lagBytes);
        metrics.replicationStatus.set({ replica: state.name }, state.state === 'streaming' ? 1 : 0);
        
        // 检查告警条件
        this.checkAlertConditions(state);
        
        logger.debug({ replica: state.name, state: state.state, lag: state.lagBytes }, 'Replica status checked');
      }
      
      // 更新数据库记录
      await this.updateReplicationStatus();
      
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to check replication status');
    }
  }

  /**
   * 获取主库 WAL 位置
   */
  async getMasterWalPosition() {
    const result = await this.masterPool.query(`
      SELECT pg_current_wal_lsn() as current_lsn,
             pg_walfile_name(pg_current_wal_lsn()) as wal_file
    `);
    
    return {
      currentLsn: result.rows[0].current_lsn,
      walFile: result.rows[0].wal_file
    };
  }

  /**
   * 获取从库状态
   */
  async getReplicaStatus() {
    const result = await this.masterPool.query(`
      SELECT 
        client_addr,
        application_name,
        state,
        sync_state,
        sent_lsn,
        write_lsn,
        flush_lsn,
        replay_lsn,
        EXTRACT(EPOCH FROM (now() - reply_time)) as seconds_since_reply
      FROM pg_stat_replication
      ORDER BY sync_state, application_name
    `);
    
    return result.rows;
  }

  /**
   * 计算 WAL 延迟字节数
   */
  calculateLagBytes(masterLsn, replicaLsn) {
    // 将 LSN 转换为字节数进行比较
    const masterBytes = this.lsnToBytes(masterLsn);
    const replicaBytes = this.lsnToBytes(replicaLsn);
    
    return Math.max(0, masterBytes - replicaBytes);
  }

  /**
   * LSN 转字节数
   */
  lsnToBytes(lsn) {
    if (!lsn) return 0;
    
    const parts = lsn.split('/');
    if (parts.length !== 2) return 0;
    
    const segment = parseInt(parts[0], 16);
    const offset = parseInt(parts[1], 16);
    
    return segment * 16 * 1024 * 1024 + offset; // 16MB segments
  }

  /**
   * 检查告警条件
   */
  checkAlertConditions(state) {
    const thresholds = this.config.alertThresholds;
    
    // 检查同步延迟
    if (state.lagBytes > thresholds.lagBytes) {
      logger.warn({ 
        replica: state.name, 
        lagBytes: state.lagBytes,
        threshold: thresholds.lagBytes
      }, 'Replication lag exceeds threshold');
    }
    
    // 检查复制状态
    if (state.state !== 'streaming') {
      logger.warn({ 
        replica: state.name, 
        state: state.state 
      }, 'Replica not streaming');
    }
  }

  /**
   * 更新数据库中的复制状态
   */
  async updateReplicationStatus() {
    for (const [name, state] of this.replicaStates) {
      try {
        await this.masterPool.query(`
          SELECT update_replica_health($1, $2, $3, $4, NULL, NULL)
        `, [
          name, 
          state.state === 'streaming',
          Math.round(state.lagBytes / 1024), // 转换为毫秒估算
          state.lagBytes
        ]);
      } catch (error) {
        logger.warn({ replica: name, error: error.message }, 'Failed to update replica status');
      }
    }
  }

  /**
   * 获取复制状态概览
   */
  getOverview() {
    return {
      replicas: Array.from(this.replicaStates.entries()).map(([name, state]) => ({
        name,
        ...state
      })),
      healthyCount: Array.from(this.replicaStates.values()).filter(s => s.state === 'streaming').length,
      unhealthyCount: Array.from(this.replicaStates.values()).filter(s => s.state !== 'streaming').length
    };
  }

  /**
   * 关闭监控
   */
  async shutdown() {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
    }
    
    if (this.masterPool) {
      await this.masterPool.end();
    }
    
    logger.info('Replication monitor shutdown');
  }
}

// ============================================================
// 故障切换管理器
// ============================================================

class FailoverManager {
  constructor(router, config = {}) {
    this.router = router;
    this.config = { ...DEFAULT_CONFIG.failover, ...config };
    this.inFailover = false;
  }

  /**
   * 执行故障切换
   */
  async executeFailover(reason) {
    if (this.inFailover) {
      logger.warn('Failover already in progress');
      return false;
    }
    
    if (!this.config.enabled) {
      logger.warn('Failover is disabled');
      return false;
    }
    
    // 检查冷却时间
    const now = Date.now();
    if (now - this.router.lastFailoverTime < this.config.cooldownMs) {
      logger.warn('Failover cooldown period not elapsed');
      return false;
    }
    
    this.inFailover = true;
    const startTime = Date.now();
    
    try {
      logger.info({ reason }, 'Starting failover');
      
      // 记录故障切换事件
      await this.logFailoverEvent('start', null, null, reason, null, true, 'auto');
      
      // 找出最佳从库提升为主库
      const candidate = await this.selectPromotionCandidate();
      
      if (!candidate) {
        logger.error('No suitable replica found for promotion');
        await this.logFailoverEvent('failed', null, null, 'No suitable replica', null, false, 'auto');
        return false;
      }
      
      // 提升从库为主库
      const success = await this.promoteReplica(candidate);
      
      const duration = Date.now() - startTime;
      
      if (success) {
        logger.info({ replica: candidate, duration }, 'Failover completed');
        await this.logFailoverEvent('completed', 'master', candidate, reason, duration, true, 'auto');
        
        // 更新路由器配置
        this.router.lastFailoverTime = now;
      }
      
      return success;
    } catch (error) {
      logger.error({ error: error.message }, 'Failover failed');
      await this.logFailoverEvent('failed', null, null, error.message, null, false, 'auto');
      return false;
    } finally {
      this.inFailover = false;
    }
  }

  /**
   * 选择提升候选
   */
  async selectPromotionCandidate() {
    const healthyReplicas = this.router.getHealthyReplicas();
    
    if (healthyReplicas.length < this.config.minReplicasForFailover) {
      return null;
    }
    
    // 选择同步延迟最小的
    healthyReplicas.sort((a, b) => a.syncDelay - b.syncDelay);
    
    return healthyReplicas[0].name;
  }

  /**
   * 提升从库为主库
   */
  async promoteReplica(replicaName) {
    // 这里需要调用实际的提升逻辑
    // 通常涉及：
    // 1. 停止原主库
    // 2. 在从库执行 pg_promote()
    // 3. 更新应用配置
    // 4. 重启服务
    
    logger.info({ replica: replicaName }, 'Promoting replica to master');
    
    // TODO: 实际的提升逻辑需要根据部署环境定制
    // 这里只记录事件
    
    return true;
  }

  /**
   * 记录故障切换事件
   */
  async logFailoverEvent(eventType, oldMaster, newMaster, reason, duration, success, triggeredBy) {
    try {
      await this.router.masterPool.query(`
        SELECT log_failover_event($1, $2, $3, $4, $5, $6, $7)
      `, [eventType, oldMaster, newMaster, reason, duration, success, triggeredBy]);
    } catch (error) {
      logger.warn({ error: error.message }, 'Failed to log failover event');
    }
  }
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  ReplicationMonitor,
  FailoverManager,
  metrics,
  DEFAULT_CONFIG
};
