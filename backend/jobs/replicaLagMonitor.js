// backend/jobs/replicaLagMonitor.js - 副本延迟监控任务
'use strict';

const { getReadWriteSplitManager } = require('../shared/dbReadWriteSplit/ReadWriteSplitManager');
const { createLogger } = require('../shared/logger');
const { query: dbQuery } = require('../shared/db');
const { getRedis, setRedis } = require('../shared/redis');
const promClient = require('prom-client');

const logger = createLogger('replica-lag-monitor');

// Prometheus 指标
const lagGauge = new promClient.Gauge({
  name: 'replica_lag_monitor_seconds',
  help: 'Replica lag measured by monitor job',
  labelNames: ['replica_id', 'method']
});

const checkCounter = new promClient.Counter({
  name: 'replica_lag_check_total',
  help: 'Total replica lag checks',
  labelNames: ['replica_id', 'result']
});

class ReplicaLagMonitor {
  constructor(config = {}) {
    this.config = {
      // 监控间隔（毫秒）
      checkInterval: config.checkInterval || parseInt(process.env.REPLICA_LAG_CHECK_INTERVAL_MS || '5000'),
      
      // 心跳表名
      heartbeatTable: config.heartbeatTable || 'replica_lag_heartbeat',
      
      // Redis 缓存键
      cacheKey: config.cacheKey || 'replica:lag:latest',
      
      // 告警阈值
      alertThresholds: {
        warning: parseInt(process.env.REPLICA_LAG_WARNING_MS || '500'),
        critical: parseInt(process.env.REPLICA_LAG_CRITICAL_MS || '2000')
      },
      
      // 监控模式
      mode: config.mode || 'heartbeat' // heartbeat | pg_stat_replication
    };
    
    this.manager = null;
    this.interval = null;
    this.running = false;
  }
  
  /**
   * 启动监控
   */
  async start() {
    if (this.running) {
      logger.warn('Replica lag monitor already running');
      return;
    }
    
    try {
      this.manager = getReadWriteSplitManager();
      await this.manager.initialize();
      
      // 创建心跳表
      await this.createHeartbeatTable();
      
      // 启动定时检查
      this.interval = setInterval(async () => {
        await this.checkAllReplicas();
      }, this.config.checkInterval);
      
      this.running = true;
      logger.info({ interval: this.config.checkInterval }, 'Replica lag monitor started');
      
    } catch (err) {
      logger.error({ err }, 'Failed to start replica lag monitor');
      throw err;
    }
  }
  
  /**
   * 创建心跳表
   */
  async createHeartbeatTable() {
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${this.config.heartbeatTable} (
        id SERIAL PRIMARY KEY,
        heartbeat_time BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_${this.config.heartbeatTable}_time 
      ON ${this.config.heartbeatTable}(heartbeat_time);
    `;
    
    await dbQuery(createTableSQL);
    logger.info('Heartbeat table created');
  }
  
  /**
   * 检查所有副本延迟
   */
  async checkAllReplicas() {
    const startTime = Date.now();
    
    try {
      // 1. 在主库写入心跳时间戳
      const heartbeatTime = Date.now();
      await this.writeHeartbeat(heartbeatTime);
      
      // 2. 从副本读取时间戳并计算延迟
      const replicaPools = this.manager.replicaPools;
      
      const lagPromises = replicaPools.map(async (replica) => {
        try {
          const lag = await this.measureReplicaLag(replica, heartbeatTime);
          
          // 更新管理器的延迟数据
          this.manager.updateLagData(replica.id, lag);
          
          // 记录 Prometheus 指标
          lagGauge.set({ replica_id: replica.id, method: this.config.mode }, lag / 1000);
          checkCounter.inc({ replica_id: replica.id, result: 'success' });
          
          // 缓存到 Redis
          await this.cacheLag(replica.id, lag);
          
          // 检查告警
          this.checkAlerts(replica.id, lag);
          
          return { replicaId: replica.id, lag, status: 'ok' };
          
        } catch (err) {
          logger.error({ err, replicaId: replica.id }, 'Failed to measure replica lag');
          checkCounter.inc({ replica_id: replica.id, result: 'error' });
          
          // 标记副本不健康
          this.manager.markReplicaUnhealthy(replica.id);
          
          return { replicaId: replica.id, lag: null, status: 'error', error: err.message };
        }
      });
      
      const results = await Promise.all(lagPromises);
      
      const duration = Date.now() - startTime;
      logger.debug({ duration, results }, 'Replica lag check completed');
      
      return results;
      
    } catch (err) {
      logger.error({ err }, 'Failed to check replica lag');
      throw err;
    }
  }
  
  /**
   * 写入心跳时间戳到主库
   */
  async writeHeartbeat(timestamp) {
    await dbQuery(
      `INSERT INTO ${this.config.heartbeatTable} (heartbeat_time, created_at) VALUES ($1, NOW())`,
      [timestamp]
    );
    
    logger.debug({ timestamp }, 'Heartbeat written');
  }
  
  /**
   * 测量单个副本延迟
   */
  async measureReplicaLag(replica, expectedTimestamp) {
    if (this.config.mode === 'pg_stat_replication') {
      return await this.measureLagFromPgStat(replica);
    } else {
      return await this.measureLagFromHeartbeat(replica, expectedTimestamp);
    }
  }
  
  /**
   * 通过心跳表测量延迟
   */
  async measureLagFromHeartbeat(replica, expectedTimestamp) {
    const startTime = Date.now();
    
    try {
      // 从副本读取最新的心跳时间戳
      const result = await replica.pool.query(
        `SELECT heartbeat_time FROM ${this.config.heartbeatTable} ORDER BY heartbeat_time DESC LIMIT 1`
      );
      
      const endTime = Date.now();
      const queryTime = endTime - startTime;
      
      if (result.rows.length === 0) {
        logger.warn({ replicaId: replica.id }, 'No heartbeat found on replica');
        return 999999; // 无数据，返回极大值
      }
      
      const replicaTimestamp = result.rows[0].heartbeat_time;
      
      // 延迟 = 当前时间 - 副本时间戳 - 查询耗时
      const lag = endTime - replicaTimestamp - queryTime;
      
      logger.debug({
        replicaId: replica.id,
        expectedTimestamp,
        replicaTimestamp,
        queryTime,
        lag
      }, 'Lag measured from heartbeat');
      
      return Math.max(0, lag);
      
    } catch (err) {
      logger.error({ err, replicaId: replica.id }, 'Failed to measure lag from heartbeat');
      throw err;
    }
  }
  
  /**
   * 从 pg_stat_replication 测量延迟
   */
  async measureLagFromPgStat(replica) {
    try {
      const result = await this.manager.primaryPool.query(`
        SELECT 
          client_addr,
          state,
          sync_state,
          replay_lag,
          EXTRACT(EPOCH FROM replay_lag) * 1000 as lag_ms
        FROM pg_stat_replication
        WHERE state = 'streaming'
      `);
      
      const replicaStats = result.rows.find(r => 
        r.client_addr === replica.config.host
      );
      
      if (!replicaStats) {
        logger.warn({ replicaId: replica.id }, 'Replica not found in pg_stat_replication');
        return 999999;
      }
      
      const lag = parseFloat(replicaStats.lag_ms) || 0;
      
      logger.debug({
        replicaId: replica.id,
        state: replicaStats.state,
        syncState: replicaStats.sync_state,
        lag
      }, 'Lag measured from pg_stat_replication');
      
      return lag;
      
    } catch (err) {
      logger.error({ err }, 'Failed to query pg_stat_replication');
      throw err;
    }
  }
  
  /**
   * 缓存延迟数据到 Redis
   */
  async cacheLag(replicaId, lag) {
    const key = `${this.config.cacheKey}:${replicaId}`;
    const data = {
      lag,
      timestamp: Date.now(),
      replicaId
    };
    
    await setRedis(key, JSON.stringify(data), 'EX', 60);
  }
  
  /**
   * 检查告警
   */
  checkAlerts(replicaId, lag) {
    if (lag >= this.config.alertThresholds.critical) {
      logger.error({ replicaId, lag }, 'CRITICAL: Replica lag exceeds threshold');
      
      // 这里可以集成告警系统（邮件、Slack、钉钉等）
      this.sendAlert(replicaId, lag, 'critical');
      
    } else if (lag >= this.config.alertThresholds.warning) {
      logger.warn({ replicaId, lag }, 'WARNING: Replica lag exceeds threshold');
      
      this.sendAlert(replicaId, lag, 'warning');
    }
  }
  
  /**
   * 发送告警
   */
  async sendAlert(replicaId, lag, level) {
    // TODO: 集成实际告警系统
    logger.info({ replicaId, lag, level }, 'Alert sent (placeholder)');
    
    // 示例：写入告警队列
    // await kafkaProducer.send({
    //   topic: 'alerts',
    //   messages: [{
    //     key: 'replica-lag',
    //     value: JSON.stringify({
    //       type: 'replica_lag',
    //       replicaId,
    //       lag,
    //       level,
    //       timestamp: new Date().toISOString()
    //     })
    //   }]
    // });
  }
  
  /**
   * 获取延迟数据
   */
  async getLagData() {
    const data = {
      timestamp: new Date().toISOString(),
      replicas: []
    };
    
    for (const replica of this.manager.replicaPools) {
      const lag = this.manager.lagData[replica.id] || 0;
      const health = this.manager.replicaHealth[replica.id];
      
      data.replicas.push({
        id: replica.id,
        lag,
        healthy: health.healthy,
        lastCheck: health.lastCheck
      });
    }
    
    return data;
  }
  
  /**
   * 停止监控
   */
  async stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    this.running = false;
    logger.info('Replica lag monitor stopped');
  }
}

// 单例实例
let monitorInstance = null;

function getReplicaLagMonitor(config) {
  if (!monitorInstance) {
    monitorInstance = new ReplicaLagMonitor(config);
  }
  return monitorInstance;
}

// CLI 启动
if (require.main === module) {
  const monitor = getReplicaLagMonitor();
  
  monitor.start().catch(err => {
    logger.error({ err }, 'Monitor failed to start');
    process.exit(1);
  });
  
  // 优雅关闭
  process.on('SIGTERM', async () => {
    await monitor.stop();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    await monitor.stop();
    process.exit(0);
  });
}

module.exports = {
  ReplicaLagMonitor,
  getReplicaLagMonitor
};
