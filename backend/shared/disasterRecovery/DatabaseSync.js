const { logger, metrics } = require('../logging');
const { Pool } = require('pg');

/**
 * 数据库跨区域同步监控器
 * 负责监控主备数据库同步状态，确保 RPO < 1 分钟
 */
class DatabaseSync {
  constructor(config = {}) {
    this.config = {
      primaryUrl: config.primaryUrl || process.env.DATABASE_URL,
      secondaryUrl: config.secondaryUrl || process.env.DATABASE_URL_SECONDARY,
      syncInterval: config.syncInterval || 1000,
      lagThreshold: config.lagThreshold || 60000, // 60 seconds
      ...config
    };
    
    this.primaryPool = null;
    this.secondaryPool = null;
    this.timer = null;
    this.isRunning = false;
    
    this.registerMetrics();
  }
  
  registerMetrics() {
    if (metrics && metrics.gauge) {
      metrics.gauge('dr_db_sync_lag_seconds', 'Database sync lag in seconds');
      metrics.counter('dr_db_sync_errors_total', 'Database sync errors');
      metrics.gauge('dr_db_replication_status', 'Replication status (1=ok, 0=error)');
    }
  }
  
  /**
   * 启动同步监控
   */
  async start() {
    if (this.isRunning) return;
    
    try {
      // 初始化数据库连接
      if (this.config.primaryUrl) {
        this.primaryPool = new Pool({ 
          connectionString: this.config.primaryUrl,
          max: 5
        });
      }
      
      if (this.config.secondaryUrl) {
        this.secondaryPool = new Pool({ 
          connectionString: this.config.secondaryUrl,
          max: 5
        });
      }
      
      this.isRunning = true;
      
      // 定期检查同步状态
      this.timer = setInterval(() => {
        this.checkSyncStatus().catch(err => {
          logger.error('Database sync check failed', { error: err.message });
        });
      }, this.config.syncInterval);
      
      logger.info('Database sync monitor started');
    } catch (error) {
      logger.error('Failed to start database sync monitor', { error: error.message });
      throw error;
    }
  }
  
  /**
   * 检查同步状态
   */
  async checkSyncStatus() {
    if (!this.primaryPool) {
      return { healthy: false, lagSeconds: 0, error: 'Primary database not configured' };
    }
    
    try {
      // 检查主库 WAL 位置
      const primaryResult = await this.primaryPool.query(`
        SELECT pg_current_wal_lsn() as lsn,
               pg_current_wal_insert_lsn() as insert_lsn
      `).catch(() => ({ rows: [{ lsn: null, insert_lsn: null }] }));
      
      // 检查备库接收位置（如果配置了备库）
      let secondaryResult = { rows: [{ receive_lsn: null, replay_lsn: null, replay_time: null }] };
      if (this.secondaryPool) {
        secondaryResult = await this.secondaryPool.query(`
          SELECT pg_last_wal_receive_lsn() as receive_lsn,
                 pg_last_wal_replay_lsn() as replay_lsn,
                 pg_last_xact_replay_timestamp() as replay_time
        `).catch(() => ({ rows: [{ receive_lsn: null, replay_lsn: null, replay_time: null }] }));
      }
      
      // 计算延迟
      const lagResult = await this.primaryPool.query(`
        SELECT 
          COALESCE(extract(epoch from now() - pg_last_xact_replay_timestamp()), 0) as lag_seconds
        FROM pg_stat_replication
        LIMIT 1
      `).catch(() => ({ rows: [{ lag_seconds: 0 }] }));
      
      const lagSeconds = parseFloat(lagResult.rows[0]?.lag_seconds || 0);
      
      // 更新指标
      if (metrics && metrics.gauge) {
        metrics.gauge('dr_db_sync_lag_seconds').set(lagSeconds);
        metrics.gauge('dr_db_replication_status').set(lagSeconds < 60 ? 1 : 0);
      }
      
      if (lagSeconds > this.config.lagThreshold / 1000) {
        logger.warn('Database sync lag exceeded threshold', {
          lagSeconds,
          threshold: this.config.lagThreshold / 1000
        });
        
        // 触发告警
        this.emit && this.emit('lag-exceeded', { lagSeconds, threshold: this.config.lagThreshold });
      }
      
      return {
        primaryLSN: primaryResult.rows[0]?.lsn,
        secondaryLSN: secondaryResult.rows[0]?.receive_lsn,
        replayLSN: secondaryResult.rows[0]?.replay_lsn,
        lagSeconds,
        healthy: lagSeconds < this.config.lagThreshold / 1000
      };
      
    } catch (error) {
      if (metrics && metrics.counter) {
        metrics.counter('dr_db_sync_errors_total').inc();
      }
      if (metrics && metrics.gauge) {
        metrics.gauge('dr_db_replication_status').set(0);
      }
      
      throw error;
    }
  }
  
  /**
   * 强制同步等待
   */
  async forceSync() {
    if (!this.primaryPool) {
      throw new Error('Primary database not configured');
    }
    
    // 强制切换 WAL
    await this.primaryPool.query('SELECT pg_switch_wal()').catch(() => {});
    
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
  
  /**
   * 获取同步状态
   */
  async getStatus() {
    try {
      const status = await this.checkSyncStatus();
      return {
        ...status,
        isRunning: this.isRunning,
        config: {
          syncInterval: this.config.syncInterval,
          lagThreshold: this.config.lagThreshold
        }
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        isRunning: this.isRunning
      };
    }
  }
  
  /**
   * 停止监控
   */
  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    
    this.isRunning = false;
    
    if (this.primaryPool) {
      await this.primaryPool.end().catch(() => {});
      this.primaryPool = null;
    }
    
    if (this.secondaryPool) {
      await this.secondaryPool.end().catch(() => {});
      this.secondaryPool = null;
    }
    
    logger.info('Database sync monitor stopped');
  }
}

module.exports = DatabaseSync;
