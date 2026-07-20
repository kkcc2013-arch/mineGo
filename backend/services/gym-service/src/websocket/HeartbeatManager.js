/**
 * 心跳管理器
 * REQ-00262: 实时对战 WebSocket 连接系统
 * 
 * 功能：
 * - 定期发送心跳检测
 * - 检测死亡连接
 * - 清理超时连接
 */

const { logger } = require('../../../../shared');

class HeartbeatManager {
  constructor(wsServer) {
    this.wsServer = wsServer;
    this.interval = parseInt(process.env.HEARTBEAT_INTERVAL_MS) || 30000; // 30秒
    this.timeout = parseInt(process.env.HEARTBEAT_TIMEOUT_MS) || 60000; // 60秒
    this.timer = null;
  }

  start() {
    if (this.timer) {
      return;
    }
    
    this.timer = setInterval(() => {
      this.checkConnections();
    }, this.interval);
    
    logger.info({ 
      interval: this.interval, 
      timeout: this.timeout 
    }, 'Heartbeat manager started');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Heartbeat manager stopped');
    }
  }

  checkConnections() {
    const now = Date.now();
    let alive = 0;
    let dead = 0;
    
    for (const [userId, ws] of this.wsServer.clients) {
      // 检查连接是否活跃
      if (!ws.isAlive || (now - ws.lastPong) > this.timeout) {
        // 连接已死，终止连接
        dead++;
        
        try {
          ws.terminate();
        } catch (error) {
          // 忽略终止错误
        }
        
        this.wsServer.clients.delete(userId);
        
        logger.warn({ 
          userId,
          connectionId: ws.connectionId,
          lastPong: ws.lastPong ? now - ws.lastPong : 'never'
        }, 'Terminated dead connection');
        
      } else {
        // 发送 ping
        alive++;
        ws.isAlive = false;
        
        try {
          ws.ping();
        } catch (error) {
          logger.error({ userId, error: error.message }, 'Failed to send ping');
        }
      }
    }
    
    // 更新连接数指标
    if (this.wsServer.metrics?.connectionsTotal) {
      this.wsServer.metrics.connectionsTotal.set(this.wsServer.clients.size);
    }
    
    // 定期记录心跳状态
    if (dead > 0) {
      logger.info({ 
        alive, 
        dead, 
        total: this.wsServer.clients.size 
      }, 'Heartbeat check completed');
    }
  }

  // 手动检查单个连接
  isConnectionAlive(ws) {
    if (!ws.isAlive) return false;
    
    const now = Date.now();
    return (now - ws.lastPong) <= this.timeout;
  }

  // 获取心跳统计
  getStats() {
    const now = Date.now();
    const connections = [];
    
    for (const [userId, ws] of this.wsServer.clients) {
      connections.push({
        userId,
        connectionId: ws.connectionId,
        isAlive: ws.isAlive,
        lastPong: ws.lastPong,
        pongAge: ws.lastPong ? now - ws.lastPong : null
      });
    }
    
    return {
      interval: this.interval,
      timeout: this.timeout,
      totalConnections: connections.length,
      connections
    };
  }
}

module.exports = { HeartbeatManager };
