/**
 * REQ-00375: PostgreSQL 跨区域流复制管理器
 * 管理 PostgreSQL 主从复制、监控延迟、执行主从切换
 */

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
    this.isMonitoring = false;
  }

  /**
   * 启动复制监控
   */
  startMonitoring() {
    if (this.isMonitoring) {
      logger.warn('PostgreSQL 复制监控已在运行');
      return;
    }
    
    this.monitoringInterval = setInterval(
      () => this.checkReplicationStatus().catch(err => 
        logger.error({ error: err.message }, '复制状态检查失败')
      ),
      this.checkInterval
    );
    
    this.isMonitoring = true;
    logger.info('PostgreSQL 复制监控已启动', {
      primaryHost: this.primaryConfig.host,
      standbyHost: this.standbyConfig.host,
      checkInterval: this.checkInterval
    });
  }

  /**
   * 停止复制监控
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoring = false;
    logger.info('PostgreSQL 复制监控已停止');
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
      
      const status = {
        timestamp: new Date().toISOString(),
        replicas: result.rows.map(row => ({
          clientAddr: row.client_addr,
          state: row.state,
          syncState: row.sync_state,
          sentLsn: row.sent_lsn,
          writeLsn: row.write_lsn,
          flushLsn: row.flush_lsn,
          replayLsn: row.replay_lsn,
          lagMs: parseFloat(row.replication_lag_ms) || 0
        }))
      };
      
      // 更新指标和告警检查
      for (const replica of status.replicas) {
        if (metrics && metrics.gauge) {
          metrics.gauge('postgres_replication_lag_ms', replica.lagMs, {
            standby: replica.clientAddr,
            state: replica.state
          });
        }
        
        // 告警检查
        if (replica.lagMs > this.replicationLagThreshold) {
          logger.error({
            standby: replica.clientAddr,
            lagMs: replica.lagMs,
            threshold: this.replicationLagThreshold
          }, 'PostgreSQL 复制延迟超过阈值');
          
          await this._sendReplicationLagAlert(replica.clientAddr, replica.lagMs);
        }
      }
      
      return status;
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
      host: this.standbyConfig.host,
      port: this.standbyConfig.port,
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
      
      if (metrics && metrics.increment) {
        metrics.increment('postgres_failover_total', 1, { result: 'success' });
      }
      
      return { 
        success: true, 
        promotedAt: new Date().toISOString(),
        newPrimary: this.standbyConfig.host
      };
    } catch (error) {
      logger.error({ error: error.message }, 'PostgreSQL 主从切换失败');
      if (metrics && metrics.increment) {
        metrics.increment('postgres_failover_total', 1, { result: 'failure' });
      }
      throw error;
    } finally {
      await standbyClient.end();
    }
  }

  /**
   * 获取 RPO（恢复点目标）
   */
  async getRPO() {
    try {
      const status = await this.checkReplicationStatus();
      
      if (status.replicas.length === 0) {
        return { rpoMs: null, message: '无活跃复制连接' };
      }
      
      const maxLag = Math.max(...status.replicas.map(r => r.lagMs));
      
      return {
        rpoMs: maxLag,
        withinTarget: maxLag <= 60000, // RPO < 1 分钟
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return { rpoMs: null, error: error.message };
    }
  }

  /**
   * 检查主库健康状态
   */
  async checkPrimaryHealth() {
    const client = new Client(this.primaryConfig);
    
    try {
      await client.connect();
      
      // 检查连接和基本状态
      const result = await client.query('SELECT 1 as health_check');
      
      // 检查是否为主库
      const roleResult = await client.query(`
        SELECT pg_is_in_recovery() as is_standby
      `);
      
      const isPrimary = !roleResult.rows[0].is_standby;
      
      return {
        healthy: true,
        isPrimary,
        host: this.primaryConfig.host
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        host: this.primaryConfig.host
      };
    } finally {
      await client.end();
    }
  }

  /**
   * 检查备库健康状态
   */
  async checkStandbyHealth() {
    const client = new Client({
      host: this.standbyConfig.host,
      port: this.standbyConfig.port,
      database: 'minego',
      user: process.env.PG_ADMIN_USER || 'postgres',
      password: process.env.PG_ADMIN_PASSWORD
    });
    
    try {
      await client.connect();
      
      // 检查连接和基本状态
      const result = await client.query('SELECT 1 as health_check');
      
      // 检查是否为备库
      const roleResult = await client.query(`
        SELECT pg_is_in_recovery() as is_standby
      `);
      
      const isStandby = roleResult.rows[0].is_standby;
      
      // 获取接收延迟
      const lagResult = await client.query(`
        SELECT 
          CASE WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() 
          THEN 0 
          ELSE EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 
          END as replay_lag_ms
      `);
      
      return {
        healthy: true,
        isStandby,
        replayLagMs: parseFloat(lagResult.rows[0].replay_lag_ms) || 0,
        host: this.standbyConfig.host
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        host: this.standbyConfig.host
      };
    } finally {
      await client.end();
    }
  }

  /**
   * 发送复制延迟告警
   */
  async _sendReplicationLagAlert(standby, lagMs) {
    try {
      const { sendAlert } = require('../alerting');
      if (sendAlert) {
        await sendAlert({
          severity: 'critical',
          type: 'postgres_replication_lag',
          message: `PostgreSQL 复制延迟 ${lagMs}ms 超过阈值`,
          details: { standby, lagMs, threshold: this.replicationLagThreshold }
        });
      }
    } catch (error) {
      logger.warn({ error: error.message }, '发送复制延迟告警失败');
    }
  }

  /**
   * 获取复制状态摘要
   */
  getStatusSummary() {
    return {
      primary: {
        host: this.primaryConfig.host,
        port: this.primaryConfig.port
      },
      standby: {
        host: this.standbyConfig.host,
        port: this.standbyConfig.port
      },
      monitoring: this.isMonitoring,
      lagThreshold: this.replicationLagThreshold,
      checkInterval: this.checkInterval
    };
  }
}

module.exports = PostgreSQLReplicationManager;