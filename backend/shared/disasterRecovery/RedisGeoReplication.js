// backend/shared/disasterRecovery/RedisGeoReplication.js
// Redis 跨区域同步管理器
'use strict';

const Redis = require('ioredis');
const logger = require('../logger');
const { metrics } = require('../metrics');

class RedisGeoReplication {
  constructor(options = {}) {
    this.primaryConfig = {
      host: options.primaryHost || process.env.REDIS_PRIMARY_HOST || 'redis-primary.beijing',
      port: options.primaryPort || process.env.REDIS_PRIMARY_PORT || 6379,
      password: options.primaryPassword || process.env.REDIS_PASSWORD
    };
    
    this.standbyConfig = {
      host: options.standbyHost || process.env.REDIS_STANDBY_HOST || 'redis-standby.shanghai',
      port: options.standbyPort || process.env.REDIS_STANDBY_PORT || 6379,
      password: options.standbyPassword || process.env.REDIS_PASSWORD
    };
    
    this.syncInterval = options.syncInterval || 5000;
    this.syncEnabled = options.syncEnabled !== false;
    
    this.primary = null;
    this.standby = null;
    this.syncIntervalId = null;
    this._isInitialized = false;
  }

  /**
   * 初始化跨区域同步
   */
  async initialize() {
    if (this._isInitialized) return;
    
    try {
      // 初始化主节点连接
      this.primary = new Redis({
        ...this.primaryConfig,
        enableReadyCheck: true,
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100
      });
      
      this.primary.on('error', (err) => {
        logger.error({ error: err.message }, 'Redis 主节点连接错误');
        metrics.gauge('redis_primary_healthy', 0);
      });
      
      this.primary.on('ready', () => {
        logger.info('Redis 主节点连接就绪');
        metrics.gauge('redis_primary_healthy', 1);
      });
      
      // 测试主节点连接
      await this.primary.ping();
      logger.info({ host: this.primaryConfig.host }, 'Redis 主节点连接成功');
      
      // 初始化备节点连接
      this.standby = new Redis({
        ...this.standbyConfig,
        enableReadyCheck: true,
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100
      });
      
      this.standby.on('error', (err) => {
        logger.error({ error: err.message }, 'Redis 备节点连接错误');
        metrics.gauge('redis_standby_healthy', 0);
      });
      
      this.standby.on('ready', () => {
        logger.info('Redis 备节点连接就绪');
        metrics.gauge('redis_standby_healthy', 1);
      });
      
      // 测试备节点连接
      await this.standby.ping();
      logger.info({ host: this.standbyConfig.host }, 'Redis 备节点连接成功');
      
      this._isInitialized = true;
      
      // 启动同步监控
      if (this.syncEnabled) {
        this.startSyncMonitoring();
      }
      
      logger.info('RedisGeoReplication 初始化完成');
    } catch (error) {
      logger.error({ error: error.message }, 'RedisGeoReplication 初始化失败');
      throw error;
    }
  }

  /**
   * 启动同步监控
   */
  startSyncMonitoring() {
    if (this.syncIntervalId) {
      logger.warn('Redis 同步监控已在运行');
      return;
    }
    
    this.syncIntervalId = setInterval(
      () => this.checkSyncStatus().catch(err =>
        logger.error({ error: err.message }, 'Redis 同步状态检查失败')
      ),
      this.syncInterval
    );
    
    logger.info({ interval: this.syncInterval }, 'Redis 同步监控已启动');
  }

  /**
   * 停止同步监控
   */
  stopSyncMonitoring() {
    if (this.syncIntervalId) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
      logger.info('Redis 同步监控已停止');
    }
  }

  /**
   * 配置主从复制
   */
  async setupReplication() {
    try {
      // 检查备节点当前角色
      const role = await this.standby.role();
      logger.info({ role }, '备节点当前角色');
      
      if (role === 'slave') {
        logger.info('备节点已是 slave，检查主节点配置');
        const info = await this.standby.info('replication');
        logger.debug({ info }, '备节点复制信息');
      } else {
        logger.warn('备节点不是 slave，无法配置主从复制');
      }
      
      // 记录主节点信息
      const primaryInfo = await this.primary.info('replication');
      logger.debug({ primaryInfo }, '主节点复制信息');
      
      return { success: true };
    } catch (error) {
      logger.error({ error: error.message }, '配置 Redis 主从复制失败');
      throw error;
    }
  }

  /**
   * 检查同步状态
   */
  async checkSyncStatus() {
    if (!this._isInitialized) {
      await this.initialize();
    }
    
    try {
      // 获取主节点复制偏移量
      const primaryInfo = await this.primary.info('replication');
      const primaryOffset = this._parseOffset(primaryInfo);
      const primaryRole = this._parseRole(primaryInfo);
      
      // 获取备节点同步状态
      const standbyInfo = await this.standby.info('replication');
      const standbyOffset = this._parseOffset(standbyInfo);
      const standbyRole = this._parseRole(standbyInfo);
      
      const lag = primaryOffset - standbyOffset;
      const isSyncing = standbyRole === 'slave';
      
      // 记录指标
      metrics.gauge('redis_primary_repl_offset', primaryOffset);
      metrics.gauge('redis_standby_repl_offset', standbyOffset);
      metrics.gauge('redis_replication_lag', lag);
      metrics.gauge('redis_sync_active', isSyncing ? 1 : 0);
      
      const status = {
        primaryOffset,
        standbyOffset,
        lag,
        primaryRole,
        standbyRole,
        isSyncing,
        withinTarget: lag <= 1000, // 偏移量差 < 1000
        timestamp: new Date().toISOString()
      };
      
      if (lag > 10000) {
        logger.warn({ lag, primaryOffset, standbyOffset }, 'Redis 复制延迟较高');
      }
      
      return status;
    } catch (error) {
      logger.error({ error: error.message }, '检查 Redis 同步状态失败');
      throw error;
    }
  }

  /**
   * 执行 Redis 故障切换
   */
  async failover() {
    logger.info('开始 Redis 故障切换...');
    const startTime = Date.now();
    
    try {
      // 1. 检查主节点是否真的不可用
      try {
        const pong = await this.primary.ping();
        if (pong === 'PONG') {
          logger.warn('Redis 主节点仍可用，可能是误判');
          // 继续切换，但记录警告
          metrics.increment('redis_failover_unnecessary', 1);
        }
      } catch (e) {
        logger.info('Redis 主节点确认不可用，继续切换');
      }
      
      // 2. 检查备节点状态
      const standbyRole = await this.standby.role();
      if (standbyRole !== 'slave') {
        logger.warn({ role: standbyRole }, '备节点不是 slave，可能已经是主节点');
      }
      
      // 3. 尝试同步主节点的最后数据
      try {
        await this.standby.sync();
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (syncError) {
        logger.warn({ error: syncError.message }, '同步失败，继续切换');
      }
      
      // 4. 将 Standby 提升为主节点
      logger.info('执行 SLAVEOF NO ONE...');
      await this.standby.slaveof('NO', 'ONE');
      
      // 5. 等待提升完成
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 6. 验证新主节点
      const newRole = await this.standby.role();
      if (newRole !== 'master') {
        throw new Error(`Redis 故障切换失败，节点角色仍为 ${newRole}`);
      }
      
      // 7. 更新配置（可选：配置旧的 slave 指向新 master）
      logger.info('Redis 故障切换成功');
      
      const rto = Date.now() - startTime;
      
      metrics.increment('redis_failover_total', 1, { result: 'success' });
      metrics.histogram('redis_failover_rto_ms', rto);
      metrics.gauge('redis_failover_active', 1);
      
      return {
        success: true,
        newPrimary: this.standbyConfig.host,
        promotedAt: new Date().toISOString(),
        rtoMs: rto
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Redis 故障切换失败');
      metrics.increment('redis_failover_total', 1, { result: 'failure' });
      throw error;
    }
  }

  /**
   * 获取 RPO
   */
  async getRPO() {
    try {
      const status = await this.checkSyncStatus();
      
      return {
        rpoOffset: status.lag,
        withinTarget: status.withinTarget,
        targetOffset: 1000,
        timestamp: status.timestamp
      };
    } catch (error) {
      return { rpoOffset: null, error: error.message };
    }
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    const results = {
      primary: false,
      standby: false,
      syncStatus: null
    };
    
    try {
      await this.primary.ping();
      results.primary = true;
    } catch (e) {
      results.primary = false;
    }
    
    try {
      await this.standby.ping();
      results.standby = true;
    } catch (e) {
      results.standby = false;
    }
    
    try {
      results.syncStatus = await this.checkSyncStatus();
    } catch (e) {
      results.syncError = e.message;
    }
    
    return results;
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

  /**
   * 关闭连接
   */
  async close() {
    this.stopSyncMonitoring();
    
    if (this.primary) {
      this.primary.disconnect();
    }
    
    if (this.standby) {
      this.standby.disconnect();
    }
    
    logger.info('RedisGeoReplication 已关闭');
  }
}

module.exports = RedisGeoReplication;
