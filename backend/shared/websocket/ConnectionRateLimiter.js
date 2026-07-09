/**
 * WebSocket 连接限流器
 * REQ-00511: WebSocket 长连接连接池管理与高性能消息批处理系统
 * 
 * 功能：
 * - 连接速率限制（防止连接风暴）
 * - IP 级别限流
 * - 用户级别限流
 * - 全局连接数控制
 * - 自动熔断保护
 */

'use strict';

const { logger, metrics } = require('../index');

class ConnectionRateLimiter {
  constructor(options = {}) {
    this.redis = options.redis;
    
    // 限流配置
    this.config = {
      // 全局配置
      globalMaxConnections: options.globalMaxConnections || 100000,
      globalConnectionsPerSecond: options.globalConnectionsPerSecond || 500,
      
      // IP 级别配置
      ipMaxConnections: options.ipMaxConnections || 100,
      ipConnectionsPerSecond: options.ipConnectionsPerSecond || 10,
      ipBanDuration: options.ipBanDuration || 3600000, // 1 小时
      
      // 用户级别配置
      userMaxConnections: options.userMaxConnections || 10,
      userConnectionsPerSecond: options.userConnectionsPerSecond || 5,
      
      // 熔断配置
      circuitBreakerThreshold: options.circuitBreakerThreshold || 0.8, // 80% 容量触发熔断
      circuitBreakerCooldown: options.circuitBreakerCooldown || 30000, // 30 秒冷却
      
      // Redis 键前缀
      redisKeyPrefix: options.redisKeyPrefix || 'minego:ws:limit:'
    };
    
    // 本地状态
    this.state = {
      currentConnections: 0,
      circuitBreakerActive: false,
      circuitBreakerTriggeredAt: null,
      totalAllowed: 0,
      totalRejected: 0,
      ipBans: new Map() // IP -> banExpiry
    };
    
    // 本地计数器（滑动窗口）
    this.counters = {
      global: { connections: [], lastCleanup: Date.now() },
      ips: new Map(), // IP -> { connections: [], lastCleanup: Date.now() }
      users: new Map() // userId -> { connections: [], lastCleanup: Date.now() }
    };
    
    // 启动清理任务
    this._startCleanupTask();
    
    this._setupMetrics();
    
    logger.info('WebSocket connection rate limiter initialized');
  }

  /**
   * 设置 Prometheus 指标
   */
  _setupMetrics() {
    this.metrics = {
      connectionsAllowed: metrics.counter('ws_limit_allowed_total', 'Connections allowed'),
      connectionsRejected: metrics.counter('ws_limit_rejected_total', 'Connections rejected', ['reason']),
      currentConnections: metrics.gauge('ws_limit_current_connections', 'Current connections'),
      circuitBreakerStatus: metrics.gauge('ws_limit_circuit_breaker', 'Circuit breaker status (0/1)'),
      activeIpBans: metrics.gauge('ws_limit_active_ip_bans', 'Active IP bans'),
      utilization: metrics.gauge('ws_limit_utilization', 'Connection pool utilization')
    };
  }

  /**
   * 检查连接是否允许
   * @param {Object} options 检查选项
   * @returns {Object} { allowed: boolean, reason?: string }
   */
  async check(options = {}) {
    const { ip, userId, serviceId } = options;
    const now = Date.now();
    
    // 检查熔断状态
    if (this.state.circuitBreakerActive) {
      const elapsed = now - this.state.circuitBreakerTriggeredAt;
      if (elapsed < this.config.circuitBreakerCooldown) {
        this.state.totalRejected++;
        this.metrics.connectionsRejected.inc({ reason: 'circuit_breaker' });
        return { allowed: false, reason: 'CIRCUIT_BREAKER_ACTIVE' };
      } else {
        // 重置熔断
        this.state.circuitBreakerActive = false;
        this.state.circuitBreakerTriggeredAt = null;
        this.metrics.circuitBreakerStatus.set(0);
      }
    }
    
    // 检查 IP 黑名单
    if (this._isIpBanned(ip)) {
      this.state.totalRejected++;
      this.metrics.connectionsRejected.inc({ reason: 'ip_banned' });
      return { allowed: false, reason: 'IP_BANNED' };
    }
    
    // 检查全局连接数
    if (this.state.currentConnections >= this.config.globalMaxConnections) {
      this.state.totalRejected++;
      this.metrics.connectionsRejected.inc({ reason: 'global_limit' });
      return { allowed: false, reason: 'GLOBAL_CONNECTION_LIMIT' };
    }
    
    // 检查全局连接速率
    const globalRate = this._getRate('global');
    if (globalRate >= this.config.globalConnectionsPerSecond) {
      this.state.totalRejected++;
      this.metrics.connectionsRejected.inc({ reason: 'global_rate' });
      return { allowed: false, reason: 'GLOBAL_RATE_LIMIT' };
    }
    
    // 检查 IP 连接数
    if (ip) {
      const ipCount = this._getConnectionCount('ip', ip);
      if (ipCount >= this.config.ipMaxConnections) {
        this.state.totalRejected++;
        this.metrics.connectionsRejected.inc({ reason: 'ip_limit' });
        return { allowed: false, reason: 'IP_CONNECTION_LIMIT' };
      }
      
      // 检查 IP 连接速率
      const ipRate = this._getRate('ip', ip);
      if (ipRate >= this.config.ipConnectionsPerSecond) {
        // 触发 IP 封禁
        this._banIp(ip);
        this.state.totalRejected++;
        this.metrics.connectionsRejected.inc({ reason: 'ip_rate' });
        return { allowed: false, reason: 'IP_RATE_LIMIT' };
      }
    }
    
    // 检查用户连接数
    if (userId) {
      const userCount = this._getConnectionCount('user', userId);
      if (userCount >= this.config.userMaxConnections) {
        this.state.totalRejected++;
        this.metrics.connectionsRejected.inc({ reason: 'user_limit' });
        return { allowed: false, reason: 'USER_CONNECTION_LIMIT' };
      }
      
      // 检查用户连接速率
      const userRate = this._getRate('user', userId);
      if (userRate >= this.config.userConnectionsPerSecond) {
        this.state.totalRejected++;
        this.metrics.connectionsRejected.inc({ reason: 'user_rate' });
        return { allowed: false, reason: 'USER_RATE_LIMIT' };
      }
    }
    
    // 所有检查通过，允许连接
    this._recordConnection('global');
    if (ip) this._recordConnection('ip', ip);
    if (userId) this._recordConnection('user', userId);
    
    this.state.currentConnections++;
    this.state.totalAllowed++;
    
    this.metrics.connectionsAllowed.inc();
    this.metrics.currentConnections.set(this.state.currentConnections);
    this.metrics.utilization.set(this.state.currentConnections / this.config.globalMaxConnections);
    
    // 检查是否需要触发熔断
    this._checkCircuitBreaker();
    
    return { allowed: true };
  }

  /**
   * 记录连接关闭
   */
  recordDisconnect(ip, userId) {
    this.state.currentConnections = Math.max(0, this.state.currentConnections - 1);
    
    this.metrics.currentConnections.set(this.state.currentConnections);
    this.metrics.utilization.set(this.state.currentConnections / this.config.globalMaxConnections);
  }

  /**
   * 获取连接计数
   */
  _getConnectionCount(scope, key = null) {
    if (scope === 'global') {
      return this.state.currentConnections;
    }
    
    const counter = this._getCounter(scope, key);
    return counter.connections.length;
  }

  /**
   * 获取连接速率（连接数/秒）
   */
  _getRate(scope, key = null) {
    const counter = this._getCounter(scope, key);
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    
    // 过滤最近一秒内的连接
    const recentConnections = counter.connections.filter(t => t > oneSecondAgo);
    return recentConnections.length;
  }

  /**
   * 获取计数器
   */
  _getCounter(scope, key = null) {
    if (scope === 'global') {
      return this.counters.global;
    }
    
    const map = scope === 'ip' ? this.counters.ips : this.counters.users;
    
    if (!map.has(key)) {
      map.set(key, { connections: [], lastCleanup: Date.now() });
    }
    
    return map.get(key);
  }

  /**
   * 记录连接
   */
  _recordConnection(scope, key = null) {
    const counter = this._getCounter(scope, key);
    counter.connections.push(Date.now());
  }

  /**
   * 检查 IP 是否被封禁
   */
  _isIpBanned(ip) {
    if (!ip) return false;
    
    const banExpiry = this.state.ipBans.get(ip);
    if (!banExpiry) return false;
    
    if (Date.now() < banExpiry) {
      return true;
    }
    
    // 封禁已过期
    this.state.ipBans.delete(ip);
    return false;
  }

  /**
   * 封禁 IP
   */
  _banIp(ip) {
    if (!ip) return;
    
    const banExpiry = Date.now() + this.config.ipBanDuration;
    this.state.ipBans.set(ip, banExpiry);
    
    this.metrics.activeIpBans.set(this.state.ipBans.size);
    
    logger.warn({ ip, duration: `${this.config.ipBanDuration}ms` }, 'IP banned due to rate limit violation');
  }

  /**
   * 检查熔断器
   */
  _checkCircuitBreaker() {
    const utilization = this.state.currentConnections / this.config.globalMaxConnections;
    
    if (utilization >= this.config.circuitBreakerThreshold) {
      this.state.circuitBreakerActive = true;
      this.state.circuitBreakerTriggeredAt = Date.now();
      
      this.metrics.circuitBreakerStatus.set(1);
      
      logger.warn({ 
        utilization: `${(utilization * 100).toFixed(1)}%`,
        threshold: `${(this.config.circuitBreakerThreshold * 100).toFixed(1)}%`
      }, 'Circuit breaker activated');
    }
  }

  /**
   * 启动清理任务
   */
  _startCleanupTask() {
    this._cleanupInterval = setInterval(() => {
      this._cleanupOldRecords();
    }, 10000); // 10 秒清理一次
  }

  /**
   * 清理过期记录
   */
  _cleanupOldRecords() {
    const now = Date.now();
    const maxAge = 60000; // 保留 1 分钟内的记录
    
    // 清理全局计数器
    this.counters.global.connections = this.counters.global.connections
      .filter(t => now - t < maxAge);
    
    // 清理 IP 计数器
    for (const [ip, counter] of this.counters.ips) {
      counter.connections = counter.connections.filter(t => now - t < maxAge);
      if (counter.connections.length === 0) {
        this.counters.ips.delete(ip);
      }
    }
    
    // 清理用户计数器
    for (const [userId, counter] of this.counters.users) {
      counter.connections = counter.connections.filter(t => now - t < maxAge);
      if (counter.connections.length === 0) {
        this.counters.users.delete(userId);
      }
    }
    
    // 清理过期封禁
    for (const [ip, banExpiry] of this.state.ipBans) {
      if (now >= banExpiry) {
        this.state.ipBans.delete(ip);
      }
    }
    this.metrics.activeIpBans.set(this.state.ipBans.size);
  }

  /**
   * 获取状态信息
   */
  getStatus() {
    return {
      currentConnections: this.state.currentConnections,
      globalMaxConnections: this.config.globalMaxConnections,
      utilization: this.state.currentConnections / this.config.globalMaxConnections,
      circuitBreakerActive: this.state.circuitBreakerActive,
      activeIpBans: this.state.ipBans.size,
      stats: {
        allowed: this.state.totalAllowed,
        rejected: this.state.totalRejected
      }
    };
  }

  /**
   * 重置限流器
   */
  reset() {
    this.state.currentConnections = 0;
    this.state.circuitBreakerActive = false;
    this.state.circuitBreakerTriggeredAt = null;
    this.state.ipBans.clear();
    
    this.counters.global.connections = [];
    this.counters.ips.clear();
    this.counters.users.clear();
    
    this.metrics.currentConnections.set(0);
    this.metrics.circuitBreakerStatus.set(0);
    this.metrics.activeIpBans.set(0);
    this.metrics.utilization.set(0);
    
    logger.info('Connection rate limiter reset');
  }

  /**
   * 关闭限流器
   */
  close() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
    }
    
    logger.info('Connection rate limiter closed');
  }
}

module.exports = ConnectionRateLimiter;
