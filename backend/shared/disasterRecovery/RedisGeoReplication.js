/**
 * REQ-00375: Redis 跨区域同步管理器
 * 管理 Redis 主从复制、跨区域同步、故障切换
 */

const Redis = require('ioredis');
const logger = require('../logger');
const { metrics } = require('../metrics');

class RedisGeoReplication {
  constructor(options = {}) {
    this.primaryHost = options.primaryHost || process.env.REDIS_PRIMARY_HOST || 'redis-primary.beijing';
    this.standbyHost = options.standbyHost || process.env.REDIS_STANDBY_HOST || 'redis-standby.shanghai';
    this.syncPort = options.syncPort || 6379;
    this.primaryPort = options.primaryPort || 6379;
    this.standbyPort = options.standbyPort || 6379;
    
    this.primary = null;
    this.standby = null;
    this.isMonitoring = false;
    this.monitoringInterval = null;
    this.checkInterval = options.checkInterval || 5000;
    
    // 同步状态
    this.syncStatus = {
      lastCheck: null,
      primaryOffset: 0,
      standbyOffset: 0,
      lag: 0
    };
  }

  /**
   * 初始化跨区域同步
   */
  async initialize() {
    try {
      // 连接主节点
      this.primary = new Redis({
        host: this.primaryHost,
        port: this.primaryPort,
        enableReadyCheck: true,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 3) {
            logger.error('Redis 主节点连接失败');
            return null;
          }
          return Math.min(times * 100, 2000);
        }
      });
      
      // 连接备节点
      this.standby = new Redis({
        host: this.standbyHost,
        port: this.standbyPort,
        enableReadyCheck: true,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 3) {
            logger.error('Redis 备节点连接失败');
            return null;
          }
          return Math.min(times * 100, 2000);
        }
      });
      
      // 等待连接就绪
      await Promise.all([
        this.primary.ready ? Promise.resolve() : new Promise(r => this.primary.once('ready', r)),
        this.standby.ready ? Promise.resolve() : new Promise(r => this.standby.once('ready', r))
      ]);
      
      // 配置主从复制
      await this._setupReplication();
      
      logger.info('Redis 跨区域同步已初始化', {
        primaryHost: this.primaryHost,
        standbyHost: this.standbyHost
      });
      
      return { success: true };
    } catch (error) {
      logger.error({ error: error.message }, 'Redis 跨区域同步初始化失败');
      throw error;
    }
  }

  /**
   * 配置主从复制
   */
  async _setupReplication() {
    try {
      // 检查主节点状态
      const primaryInfo = await this.primary.info('replication');
      const primaryRole = this._parseRole(primaryInfo);
      
      if (primaryRole !== 'master') {
        logger.warn('Redis 主节点当前不是 master，尝试设置');
        await this.primary.slaveof('NO', 'ONE');
      }
      
      // 检查备节点状态
      const standbyInfo = await this.standby.info('replication');
      const standbyRole = this._parseRole(standbyInfo);
      
      // 配置备节点复制主节点
      if (standbyRole !== 'slave') {
        logger.info('配置备节点为主节点的副本');
        await this.standby.slaveof(this.primaryHost, this.primaryPort);
      }
      
      logger.info({
        primaryRole,
        standbyRole,
        primaryHost: this.primaryHost,
        standbyHost: this.standbyHost
      }, 'Redis 主从复制配置完成');
      
    } catch (error) {
      logger.error({ error: error.message }, 'Redis 主从复制配置失败');
      throw error;
    }
  }

  /**
   * 启动同步监控
   */
  startMonitoring() {
    if (this.isMonitoring) {
      logger.warn('Redis 同步监控已在运行');
      return;
    }
    
    this.monitoringInterval = setInterval(
      () => this.checkSyncStatus().catch(err =>
        logger.error({ error: err.message }, 'Redis 同步状态检查失败')
      ),
      this.checkInterval
    );
    
    this.isMonitoring = true;
    logger.info('Redis 同步监控已启动');
  }

  /**
   * 停止同步监控
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoring = false;
    logger.info('Redis 同步监控已停止');
  }

  /**
   * 检查同步状态
   */
  async checkSyncStatus() {
    try {
      const primaryInfo = await this.primary.info('replication');
      const standbyInfo = await this.standby.info('replication');
      
      // 解析复制偏移量
      const primaryOffset = this._parseMasterOffset(primaryInfo);
      const standbyOffset = this._parseSlaveOffset(standbyInfo);
      const lag = Math.abs(primaryOffset - standbyOffset);
      
      this.syncStatus = {
        lastCheck: new Date().toISOString(),
        primaryOffset,
        standbyOffset,
        lag,
        primaryRole: this._parseRole(primaryInfo),
        standbyRole: this._parseRole(standbyInfo)
      };
      
      // 更新指标
      if (metrics && metrics.gauge) {
        metrics.gauge('redis_replication_offset_lag', lag);
        metrics.gauge('redis_primary_offset', primaryOffset);
        metrics.gauge('redis_standby_offset', standbyOffset);
      }
      
      // 检查是否在目标范围内
      const withinTarget = lag <= 1000; // 偏移量差 < 1000
      
      if (!withinTarget) {
        logger.warn({
          lag,
          primaryOffset,
          standbyOffset
        }, 'Redis 复制偏移量差异过大');
      }
      
      return {
        ...this.syncStatus,
        withinTarget
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Redis 同步状态检查失败');
      return {
        error: error.message,
        lastCheck: new Date().toISOString()
      };
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
        await this.primary.ping();
        logger.warn('Redis 主节点仍可用，可能是误判');
        // 可以选择继续或中止
      } catch (e) {
        logger.info('Redis 主节点确认不可用，继续切换');
      }
      
      // 2. 确保备节点数据尽可能同步
      await this.standby.wait(1, 0, 5000); // 等待 1 个副本同步，最多 5 秒
      
      // 3. 将 Standby 提升为主节点
      await this.standby.slaveof('NO', 'ONE');
      
      // 4. 等待提升完成
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 5. 验证新主节点
      const info = await this.standby.info('replication');
      const role = this._parseRole(info);
      
      if (role !== 'master') {
        throw new Error('Redis 故障切换失败，节点未提升为主节点');
      }
      
      const duration = Date.now() - startTime;
      
      logger.info({
        duration,
        newPrimary: this.standbyHost
      }, 'Redis 故障切换成功');
      
      if (metrics && metrics.increment) {
        metrics.increment('redis_failover_total', 1, { result: 'success' });
        metrics.histogram('redis_failover_duration_ms', duration);
      }
      
      return {
        success: true,
        newPrimary: this.standbyHost,
        promotedAt: new Date().toISOString(),
        duration
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Redis 故障切换失败');
      if (metrics && metrics.increment) {
        metrics.increment('redis_failover_total', 1, { result: 'failure' });
      }
      throw error;
    }
  }

  /**
   * 检查主节点健康状态
   */
  async checkPrimaryHealth() {
    try {
      const start = Date.now();
      const pingResult = await this.primary.ping();
      const latency = Date.now() - start;
      
      const info = await this.primary.info('replication');
      const role = this._parseRole(info);
      const connectedSlaves = this._parseConnectedSlaves(info);
      
      return {
        healthy: pingResult === 'PONG',
        latency,
        role,
        connectedSlaves,
        host: this.primaryHost
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        host: this.primaryHost
      };
    }
  }

  /**
   * 检查备节点健康状态
   */
  async checkStandbyHealth() {
    try {
      const start = Date.now();
      const pingResult = await this.standby.ping();
      const latency = Date.now() - start;
      
      const info = await this.standby.info('replication');
      const role = this._parseRole(info);
      const masterHost = this._parseMasterHost(info);
      const masterLinkStatus = this._parseMasterLinkStatus(info);
      
      return {
        healthy: pingResult === 'PONG' && masterLinkStatus === 'up',
        latency,
        role,
        masterHost,
        masterLinkStatus,
        host: this.standbyHost
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        host: this.standbyHost
      };
    }
  }

  /**
   * 解析节点角色
   */
  _parseRole(info) {
    const match = info.match(/role:(\w+)/);
    return match ? match[1] : 'unknown';
  }

  /**
   * 解析主节点复制偏移量
   */
  _parseMasterOffset(info) {
    const match = info.match(/master_repl_offset:(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * 解析从节点复制偏移量
   */
  _parseSlaveOffset(info) {
    const match = info.match(/slave_repl_offset:(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * 解析连接的从节点数量
   */
  _parseConnectedSlaves(info) {
    const match = info.match(/connected_slaves:(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * 解析从节点的主节点地址
   */
  _parseMasterHost(info) {
    const match = info.match(/master_host:(\S+)/);
    return match ? match[1] : 'unknown';
  }

  /**
   * 解析主从链路状态
   */
  _parseMasterLinkStatus(info) {
    const match = info.match(/master_link_status:(\w+)/);
    return match ? match[1] : 'unknown';
  }

  /**
   * 获取同步状态摘要
   */
  getStatusSummary() {
    return {
      primary: {
        host: this.primaryHost,
        port: this.primaryPort
      },
      standby: {
        host: this.standbyHost,
        port: this.standbyPort
      },
      monitoring: this.isMonitoring,
      syncStatus: this.syncStatus
    };
  }

  /**
   * 关闭连接
   */
  async shutdown() {
    this.stopMonitoring();
    
    if (this.primary) {
      await this.primary.quit();
    }
    
    if (this.standby) {
      await this.standby.quit();
    }
    
    logger.info('Redis 跨区域同步已关闭');
  }
}

module.exports = RedisGeoReplication;