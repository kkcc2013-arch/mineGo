// backend/shared/disasterRecovery/PostgreSQLReplicationManager.js
// PostgreSQL 跨区域流复制管理器
'use strict';

const { Pool } = require('pg');
const logger = require('../logger');
const { metrics } = require('../metrics');

class PostgreSQLReplicationManager {
  constructor(options = {}) {
    this.primaryConfig = options.primary || {
      host: process.env.PG_PRIMARY_HOST || 'postgres-primary.beijing.svc.cluster.local',
      port: process.env.PG_PRIMARY_PORT || 5432,
      database: process.env.PG_DATABASE || 'minego',
      user: process.env.PG_REPLICATION_USER || 'replicator',
      password: process.env.PG_REPLICATION_PASSWORD,
      max: 5,
      idleTimeoutMillis: 30000
    };
    
    this.standbyConfig = options.standby || {
      host: process.env.PG_STANDBY_HOST || 'postgres-standby.shanghai.svc.cluster.local',
      port: process.env.PG_STANDBY_PORT || 5432
    };
    
    this.adminConfig = {
      user: process.env.PG_ADMIN_USER || 'postgres',
      password: process.env.PG_ADMIN_PASSWORD
    };
    
    this.replicationLagThreshold = options.replicationLagThreshold || 1000; // 1 秒
    this.checkInterval = options.checkInterval || 5000; // 5 秒
    this.monitoringInterval = null;
    
    this.primaryPool = new Pool(this.primaryConfig);
    this.standbyPool = null;
    
    this._isInitialized = false;
  }

  /**
   * 初始化复制管理器
   */
  async initialize() {
    if (this._isInitialized) return;
    
    try {
      // 测试主库连接
      await this._testConnection(this.primaryPool);
      logger.info('PostgreSQL 主库连接成功');
      
      // 初始化备库连接池
      this.standbyPool = new Pool({
        ...this.standbyConfig,
        database: this.primaryConfig.database,
        user: this.adminConfig.user,
        password: this.adminConfig.password,
        max: 5
      });
      
      this._isInitialized = true;
      logger.info('PostgreSQLReplicationManager 初始化完成');
    } catch (error) {
      logger.error({ error: error.message }, 'PostgreSQLReplicationManager 初始化失败');
      throw error;
    }
  }

  /**
   * 启动复制监控
   */
  startMonitoring() {
    if (this.monitoringInterval) {
      logger.warn('PostgreSQL 复制监控已在运行');
      return;
    }
    
    this.monitoringInterval = setInterval(
      () => this.checkReplicationStatus().catch(err => 
        logger.error({ error: err.message }, '复制状态检查失败')
      ),
      this.checkInterval
    );
    
    logger.info({
      interval: this.checkInterval,
      lagThreshold: this.replicationLagThreshold
    }, 'PostgreSQL 复制监控已启动');
  }

  /**
   * 停止监控
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      logger.info('PostgreSQL 复制监控已停止');
    }
  }

  /**
   * 测试数据库连接
   */
  async _testConnection(pool) {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  }

  /**
   * 检查复制状态
   */
  async checkReplicationStatus() {
    if (!this._isInitialized) {
      await this.initialize();
    }
    
    const client = await this.primaryPool.connect();
    
    try {
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
          COALESCE(EXTRACT(EPOCH FROM (now() - replay_timestamp)) * 1000, 0) as replication_lag_ms
        FROM pg_stat_replication
      `);
      
      const statuses = [];
      
      for (const row of result.rows) {
        const lagMs = parseFloat(row.replication_lag_ms) || 0;
        
        const status = {
          standbyAddr: row.client_addr,
          state: row.state,
          syncState: row.sync_state,
          sentLsn: row.sent_lsn,
          replayLsn: row.replay_lsn,
          replicationLagMs: lagMs,
          healthy: lagMs <= this.replicationLagThreshold
        };
        
        statuses.push(status);
        
        // 记录指标
        metrics.gauge('postgres_replication_lag_ms', lagMs, {
          standby: row.client_addr || 'unknown',
          state: row.state
        });
        
        metrics.gauge('postgres_replication_sent_lsn', this._lsnToBytes(row.sent_lsn), {
          standby: row.client_addr || 'unknown'
        });
        
        // 告警检查
        if (lagMs > this.replicationLagThreshold) {
          logger.error({
            standby: row.client_addr,
            lagMs,
            threshold: this.replicationLagThreshold
          }, 'PostgreSQL 复制延迟超过阈值');
          
          await this._sendReplicationLagAlert(row.client_addr, lagMs);
        }
      }
      
      // 如果没有复制连接，记录警告
      if (result.rows.length === 0) {
        logger.warn('没有检测到活跃的 PostgreSQL 复制连接');
        metrics.gauge('postgres_replication_active', 0);
      } else {
        metrics.gauge('postgres_replication_active', result.rows.length);
      }
      
      return statuses;
    } finally {
      client.release();
    }
  }

  /**
   * 执行主从切换
   */
  async promoteStandby() {
    logger.info('开始 PostgreSQL 主从切换...');
    
    const standbyClient = await this.standbyPool.connect();
    
    try {
      // 检查当前状态
      const isRecoveryResult = await standbyClient.query('SELECT pg_is_in_recovery()');
      const isInRecovery = isRecoveryResult.rows[0].pg_is_in_recovery;
      
      if (!isInRecovery) {
        logger.warn('Standby 已经是主库，无需切换');
        return { success: true, alreadyPrimary: true };
      }
      
      // 检查复制延迟
      const lagResult = await standbyClient.query(`
        SELECT 
          CASE WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()
            THEN 0
            ELSE EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000
          END as lag_ms
      `);
      const lagMs = parseFloat(lagResult.rows[0].lag_ms) || 0;
      
      logger.info({ lagMs }, '当前复制延迟');
      
      // 执行提升
      await standbyClient.query('SELECT pg_promote()');
      
      // 等待切换完成
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 验证新主库状态
      const newStatusResult = await standbyClient.query('SELECT pg_is_in_recovery()');
      
      if (newStatusResult.rows[0].pg_is_in_recovery) {
        throw new Error('主从切换失败，Standby 仍处于恢复模式');
      }
      
      logger.info('PostgreSQL 主从切换成功');
      
      metrics.increment('postgres_failover_total', 1, { result: 'success' });
      metrics.histogram('postgres_failover_lag_ms', lagMs);
      
      return { 
        success: true, 
        promotedAt: new Date().toISOString(),
        replicationLagMs: lagMs
      };
    } catch (error) {
      logger.error({ error: error.message }, 'PostgreSQL 主从切换失败');
      metrics.increment('postgres_failover_total', 1, { result: 'failure' });
      throw error;
    } finally {
      standbyClient.release();
    }
  }

  /**
   * 获取 RPO（恢复点目标）
   */
  async getRPO() {
    try {
      const statuses = await this.checkReplicationStatus();
      
      if (statuses.length === 0) {
        return { rpoMs: null, withinTarget: false, message: '无活跃复制连接' };
      }
      
      const maxLag = Math.max(...statuses.map(s => s.replicationLagMs));
      
      return {
        rpoMs: maxLag,
        withinTarget: maxLag <= 60000, // RPO < 1 分钟
        targetMs: 60000,
        timestamp: new Date().toISOString(),
        standbyCount: statuses.length
      };
    } catch (error) {
      return { rpoMs: null, error: error.message };
    }
  }

  /**
   * 获取主库状态
   */
  async getPrimaryStatus() {
    const client = await this.primaryPool.connect();
    
    try {
      const result = await client.query(`
        SELECT 
          version() as version,
          pg_current_wal_lsn() as current_lsn,
          (SELECT count(*) FROM pg_stat_replication) as replica_count
      `);
      
      return {
        version: result.rows[0].version,
        currentLsn: result.rows[0].current_lsn,
        replicaCount: parseInt(result.rows[0].replica_count, 10),
        healthy: true
      };
    } finally {
      client.release();
    }
  }

  /**
   * LSN 转换为字节数
   */
  _lsnToBytes(lsn) {
    if (!lsn) return 0;
    const parts = lsn.split('/');
    if (parts.length !== 2) return 0;
    return (parseInt(parts[0], 16) * 255 * 16 * 1024 * 1024) + parseInt(parts[1], 16);
  }

  /**
   * 发送复制延迟告警
   */
  async _sendReplicationLagAlert(standby, lagMs) {
    try {
      const { sendAlert } = require('../alerting');
      await sendAlert({
        severity: 'critical',
        type: 'postgres_replication_lag',
        message: `PostgreSQL 复制延迟 ${lagMs}ms 超过阈值`,
        details: { standby, lagMs, threshold: this.replicationLagThreshold }
      });
    } catch (error) {
      logger.warn({ error: error.message }, '发送告警失败');
    }
  }

  /**
   * 关闭连接池
   */
  async close() {
    this.stopMonitoring();
    await this.primaryPool.end();
    if (this.standbyPool) {
      await this.standbyPool.end();
    }
    logger.info('PostgreSQLReplicationManager 已关闭');
  }
}

module.exports = PostgreSQLReplicationManager;
