/**
 * WebSocket 连接池管理器
 * REQ-00511: WebSocket 长连接连接池管理与高性能消息批处理系统
 * 
 * 功能：
 * - 连接池管理（连接生命周期）
 * - 分布式连接状态存储（Redis）
 * - 连接限流与保护
 * - 自动健康检查与清理
 * - 跨节点连接查询
 */

'use strict';

const { logger, metrics } = require('../index');
const { v4: uuidv4 } = require('uuid');

class WebSocketConnectionPool {
  constructor(options = {}) {
    this.redis = options.redis;
    this.serviceId = options.serviceId || process.env.SERVICE_ID || uuidv4();
    
    // 连接池配置
    this.config = {
      maxConnections: options.maxConnections || parseInt(process.env.WS_MAX_CONNECTIONS) || 10000,
      maxConnectionsPerUser: options.maxConnectionsPerUser || 5,
      connectionTimeout: options.connectionTimeout || 300000, // 5 分钟
      heartbeatInterval: options.heartbeatInterval || 30000, // 30 秒
      cleanupInterval: options.cleanupInterval || 60000, // 1 分钟
      redisKeyPrefix: options.redisKeyPrefix || 'minego:ws:'
    };
    
    // 本地连接池
    this.connections = new Map(); // connectionId -> ConnectionInfo
    this.userConnections = new Map(); // userId -> Set<connectionId>
    
    // 统计信息
    this.stats = {
      totalConnections: 0,
      totalDisconnections: 0,
      totalRejected: 0,
      currentConnections: 0
    };
    
    // 启动后台任务
    this._startCleanupTask();
    this._startHeartbeatTask();
    
    this._setupMetrics();
    
    logger.info({ serviceId: this.serviceId }, 'WebSocket connection pool initialized');
  }

  /**
   * 设置 Prometheus 指标
   */
  _setupMetrics() {
    this.metrics = {
      connectionsTotal: metrics.gauge('ws_pool_connections_total', 'Current active connections in pool'),
      userConnectionsTotal: metrics.gauge('ws_pool_user_connections_total', 'Total users with connections'),
      rejectedConnections: metrics.counter('ws_pool_rejected_total', 'Rejected connections', ['reason']),
      connectionDuration: metrics.histogram('ws_pool_connection_duration_seconds', 'Connection duration', [], [10, 60, 300, 600, 1800, 3600]),
      poolUtilization: metrics.gauge('ws_pool_utilization_ratio', 'Pool utilization (0-1)')
    };
  }

  /**
   * 注册连接
   * @param {WebSocket} ws WebSocket 连接对象
   * @param {Object} options 连接选项
   * @returns {Object} 连接信息
   */
  async register(ws, options = {}) {
    const { userId, deviceId, metadata = {} } = options;
    const connectionId = uuidv4();
    const now = Date.now();
    
    // 检查连接池容量
    if (this.connections.size >= this.config.maxConnections) {
      this.stats.totalRejected++;
      this.metrics.rejectedConnections.inc({ reason: 'pool_full' });
      logger.warn({ userId, poolSize: this.connections.size }, 'Connection pool full');
      throw new Error('CONNECTION_POOL_FULL');
    }
    
    // 检查用户连接数限制
    if (userId) {
      const userConnCount = this.userConnections.get(userId)?.size || 0;
      if (userConnCount >= this.config.maxConnectionsPerUser) {
        this.stats.totalRejected++;
        this.metrics.rejectedConnections.inc({ reason: 'user_limit' });
        logger.warn({ userId, userConnCount }, 'User connection limit reached');
        throw new Error('USER_CONNECTION_LIMIT_EXCEEDED');
      }
    }
    
    // 创建连接信息
    const connectionInfo = {
      connectionId,
      ws,
      userId,
      deviceId,
      metadata,
      connectedAt: now,
      lastActivityAt: now,
      lastHeartbeatAt: now,
      bytesReceived: 0,
      bytesSent: 0,
      messagesReceived: 0,
      messagesSent: 0,
      state: 'active'
    };
    
    // 添加到本地池
    this.connections.set(connectionId, connectionInfo);
    
    // 添加到用户连接映射
    if (userId) {
      if (!this.userConnections.has(userId)) {
        this.userConnections.set(userId, new Set());
      }
      this.userConnections.get(userId).add(connectionId);
    }
    
    // 存储到 Redis（分布式状态）
    if (this.redis) {
      await this._storeConnectionToRedis(connectionInfo);
    }
    
    // 更新统计
    this.stats.totalConnections++;
    this.stats.currentConnections = this.connections.size;
    
    // 更新指标
    this.metrics.connectionsTotal.set(this.connections.size);
    this.metrics.userConnectionsTotal.set(this.userConnections.size);
    this.metrics.poolUtilization.set(this.connections.size / this.config.maxConnections);
    
    // 绑定 WebSocket 事件
    this._bindWebSocketEvents(ws, connectionInfo);
    
    logger.info({ connectionId, userId, deviceId }, 'WebSocket connection registered');
    
    return {
      connectionId,
      success: true
    };
  }

  /**
   * 注销连接
   * @param {string} connectionId 连接 ID
   * @param {string} reason 断开原因
   */
  async unregister(connectionId, reason = 'client_close') {
    const connectionInfo = this.connections.get(connectionId);
    if (!connectionInfo) {
      return;
    }
    
    const { userId, connectedAt } = connectionInfo;
    const duration = (Date.now() - connectedAt) / 1000;
    
    // 从本地池移除
    this.connections.delete(connectionId);
    
    // 从用户连接映射移除
    if (userId && this.userConnections.has(userId)) {
      this.userConnections.get(userId).delete(connectionId);
      if (this.userConnections.get(userId).size === 0) {
        this.userConnections.delete(userId);
      }
    }
    
    // 从 Redis 移除
    if (this.redis) {
      await this._removeConnectionFromRedis(connectionId);
    }
    
    // 更新统计
    this.stats.totalDisconnections++;
    this.stats.currentConnections = this.connections.size;
    
    // 更新指标
    this.metrics.connectionsTotal.set(this.connections.size);
    this.metrics.userConnectionsTotal.set(this.userConnections.size);
    this.metrics.connectionDuration.observe(duration);
    
    connectionInfo.state = 'disconnected';
    
    logger.info({ connectionId, userId, reason, duration: `${duration}s` }, 'WebSocket connection unregistered');
  }

  /**
   * 获取连接信息
   * @param {string} connectionId 连接 ID
   * @returns {Object|null} 连接信息
   */
  get(connectionId) {
    return this.connections.get(connectionId);
  }

  /**
   * 获取用户的所有连接
   * @param {string} userId 用户 ID
   * @returns {Array} 连接信息数组
   */
  getUserConnections(userId) {
    const connectionIds = this.userConnections.get(userId);
    if (!connectionIds || connectionIds.size === 0) {
      return [];
    }
    
    return Array.from(connectionIds)
      .map(id => this.connections.get(id))
      .filter(conn => conn && conn.state === 'active');
  }

  /**
   * 更新连接活动时间
   * @param {string} connectionId 连接 ID
   */
  updateActivity(connectionId) {
    const conn = this.connections.get(connectionId);
    if (conn) {
      conn.lastActivityAt = Date.now();
    }
  }

  /**
   * 获取连接池状态
   * @returns {Object} 状态信息
   */
  getStatus() {
    return {
      serviceId: this.serviceId,
      currentConnections: this.connections.size,
      maxConnections: this.config.maxConnections,
      utilization: this.connections.size / this.config.maxConnections,
      uniqueUsers: this.userConnections.size,
      stats: { ...this.stats },
      uptime: Date.now() - this.stats.startTime
    };
  }

  /**
   * 查询跨节点用户连接（Redis）
   * @param {string} userId 用户 ID
   * @returns {Array} 分布式连接列表
   */
  async getDistributedUserConnections(userId) {
    if (!this.redis) {
      return this.getUserConnections(userId).map(conn => ({
        connectionId: conn.connectionId,
        serviceId: this.serviceId,
        userId: conn.userId,
        deviceId: conn.deviceId,
        connectedAt: conn.connectedAt
      }));
    }
    
    const pattern = `${this.config.redisKeyPrefix}user:${userId}:conn:*`;
    const keys = await this.redis.keys(pattern);
    
    if (keys.length === 0) {
      return [];
    }
    
    const connections = [];
    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        try {
          connections.push(JSON.parse(data));
        } catch (e) {
          // 忽略解析错误
        }
      }
    }
    
    return connections;
  }

  /**
   * 存储连接到 Redis
   */
  async _storeConnectionToRedis(connectionInfo) {
    if (!this.redis) return;
    
    const { connectionId, userId, deviceId, connectedAt, metadata } = connectionInfo;
    const key = `${this.config.redisKeyPrefix}conn:${connectionId}`;
    const userKey = `${this.config.redisKeyPrefix}user:${userId}:conn:${connectionId}`;
    
    const data = {
      connectionId,
      userId,
      deviceId,
      serviceId: this.serviceId,
      connectedAt,
      metadata
    };
    
    const ttl = Math.ceil(this.config.connectionTimeout / 1000);
    
    await Promise.all([
      this.redis.setex(key, ttl, JSON.stringify(data)),
      this.redis.setex(userKey, ttl, JSON.stringify(data))
    ]);
  }

  /**
   * 从 Redis 移除连接
   */
  async _removeConnectionFromRedis(connectionId) {
    if (!this.redis) return;
    
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    
    const key = `${this.config.redisKeyPrefix}conn:${connectionId}`;
    const userKey = `${this.config.redisKeyPrefix}user:${conn.userId}:conn:${connectionId}`;
    
    await Promise.all([
      this.redis.del(key),
      this.redis.del(userKey)
    ]);
  }

  /**
   * 绑定 WebSocket 事件
   */
  _bindWebSocketEvents(ws, connectionInfo) {
    const { connectionId } = connectionInfo;
    
    ws.on('message', (data) => {
      connectionInfo.messagesReceived++;
      connectionInfo.bytesReceived += data.length;
      connectionInfo.lastActivityAt = Date.now();
    });
    
    ws.on('close', () => {
      this.unregister(connectionId, 'client_close');
    });
    
    ws.on('error', (error) => {
      logger.warn({ connectionId, error: error.message }, 'WebSocket error');
      this.unregister(connectionId, 'error');
    });
    
    // 心跳响应处理
    ws.on('pong', () => {
      connectionInfo.lastHeartbeatAt = Date.now();
      connectionInfo.ws.isAlive = true;
    });
  }

  /**
   * 启动清理任务
   */
  _startCleanupTask() {
    this._cleanupInterval = setInterval(() => {
      this._cleanupStaleConnections();
    }, this.config.cleanupInterval);
  }

  /**
   * 清理过期连接
   */
  _cleanupStaleConnections() {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [connectionId, conn] of this.connections) {
      const inactiveTime = now - conn.lastActivityAt;
      
      if (inactiveTime > this.config.connectionTimeout) {
        // 连接过期
        try {
          conn.ws?.terminate();
        } catch (e) {
          // 忽略
        }
        this.unregister(connectionId, 'timeout');
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      logger.info({ count: cleanedCount }, 'Cleaned up stale WebSocket connections');
    }
  }

  /**
   * 启动心跳任务
   */
  _startHeartbeatTask() {
    this._heartbeatInterval = setInterval(() => {
      this._sendHeartbeats();
    }, this.config.heartbeatInterval);
  }

  /**
   * 发送心跳检测
   */
  _sendHeartbeats() {
    const now = Date.now();
    
    for (const [connectionId, conn] of this.connections) {
      if (conn.ws && conn.ws.readyState === 1) { // WebSocket.OPEN
        if (conn.ws.isAlive === false) {
          // 上次心跳未响应，断开连接
          conn.ws.terminate();
          this.unregister(connectionId, 'heartbeat_timeout');
          continue;
        }
        
        conn.ws.isAlive = false;
        conn.ws.ping();
        conn.lastHeartbeatAt = now;
      }
    }
  }

  /**
   * 关闭连接池
   */
  async close() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
    }
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
    }
    
    // 关闭所有连接
    for (const [connectionId, conn] of this.connections) {
      try {
        conn.ws?.close(1001, 'Server shutdown');
      } catch (e) {
        // 忽略
      }
    }
    
    this.connections.clear();
    this.userConnections.clear();
    
    logger.info('WebSocket connection pool closed');
  }
}

module.exports = WebSocketConnectionPool;
