'use strict';

const { logger, metrics } = require('../index');

/**
 * 连接对象池 - 复用 ConnectionInfo 对象
 * 
 * 通过对象池机制减少 GC 压力，降低内存占用
 */
class ConnectionObjectPool {
  constructor(options = {}) {
    this.config = {
      initialSize: options.initialSize || 100,
      maxSize: options.maxSize || 10000,
      growthFactor: options.growthFactor || 2,
      shrinkThreshold: options.shrinkThreshold || 0.2,
      cleanupInterval: options.cleanupInterval || 300000 // 5分钟
    };
    
    // 对象池
    this.pool = [];
    this.inUse = new Set();
    
    // 统计
    this.stats = {
      created: 0,
      reused: 0,
      returned: 0,
      dropped: 0,
      peakUsage: 0
    };
    
    // 初始化对象池
    this._initializePool();
    this._setupMetrics();
    this._startCleanup();
  }

  /**
   * 设置 Prometheus 指标
   */
  _setupMetrics() {
    this.metrics = {
      poolSize: metrics.gauge('ws_objpool_size', 'Object pool total size'),
      poolInUse: metrics.gauge('ws_objpool_in_use', 'Objects in use'),
      objectsCreated: metrics.counter('ws_objpool_created_total', 'Objects created'),
      objectsReused: metrics.counter('ws_objpool_reused_total', 'Objects reused')
    };
  }

  /**
   * 初始化对象池
   */
  _initializePool() {
    for (let i = 0; i < this.config.initialSize; i++) {
      this.pool.push(this._createObject());
      this.stats.created++;
    }
    
    logger.info('Connection object pool initialized', { size: this.pool.length });
  }

  /**
   * 创建新的连接对象
   */
  _createObject() {
    return {
      connectionId: null,
      ws: null,
      userId: null,
      deviceId: null,
      metadata: {},
      connectedAt: null,
      lastActivityAt: null,
      lastHeartbeatAt: null,
      bytesReceived: 0,
      bytesSent: 0,
      messagesReceived: 0,
      messagesSent: 0,
      state: 'idle'
    };
  }

  /**
   * 重置连接对象
   */
  _resetObject(obj) {
    obj.connectionId = null;
    obj.ws = null;
    obj.userId = null;
    obj.deviceId = null;
    obj.metadata = {};
    obj.connectedAt = null;
    obj.lastActivityAt = null;
    obj.lastHeartbeatAt = null;
    obj.bytesReceived = 0;
    obj.bytesSent = 0;
    obj.messagesReceived = 0;
    obj.messagesSent = 0;
    obj.state = 'idle';
    return obj;
  }

  /**
   * 获取连接对象
   */
  acquire() {
    let obj;
    
    if (this.pool.length > 0) {
      obj = this.pool.pop();
      this.stats.reused++;
      this.metrics.objectsReused.inc();
    } else {
      // 池为空，创建新对象
      obj = this._createObject();
      this.stats.created++;
      this.metrics.objectsCreated.inc();
    }
    
    this.inUse.add(obj);
    obj.state = 'active';
    
    // 更新峰值使用量
    if (this.inUse.size > this.stats.peakUsage) {
      this.stats.peakUsage = this.inUse.size;
    }
    
    this._updateMetrics();
    
    return obj;
  }

  /**
   * 归还连接对象
   */
  release(obj) {
    if (!this.inUse.has(obj)) {
      return;
    }
    
    this.inUse.delete(obj);
    this._resetObject(obj);
    
    // 检查是否需要丢弃（池已满）
    if (this.pool.length < this.config.maxSize) {
      this.pool.push(obj);
    } else {
      this.stats.dropped++;
    }
    
    this.stats.returned++;
    this._updateMetrics();
  }

  /**
   * 更新指标
   */
  _updateMetrics() {
    this.metrics.poolSize.set(this.pool.length + this.inUse.size);
    this.metrics.poolInUse.set(this.inUse.size);
  }

  /**
   * 启动清理任务
   */
  _startCleanup() {
    this._cleanupTask = setInterval(() => {
      this._shrinkIfNeeded();
    }, this.config.cleanupInterval);
  }

  /**
   * 按需收缩对象池
   */
  _shrinkIfNeeded() {
    const totalSize = this.pool.length + this.inUse.size;
    if (totalSize === 0) return;
    
    const usageRatio = this.inUse.size / totalSize;
    
    if (usageRatio < this.config.shrinkThreshold && this.pool.length > this.config.initialSize) {
      const shrinkCount = Math.floor(this.pool.length * 0.3);
      this.pool.splice(0, shrinkCount);
      logger.debug('Object pool shrunk', { removed: shrinkCount, remaining: this.pool.length });
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      poolSize: this.pool.length,
      inUse: this.inUse.size,
      ...this.stats
    };
  }

  /**
   * 关闭对象池
   */
  close() {
    if (this._cleanupTask) {
      clearInterval(this._cleanupTask);
      this._cleanupTask = null;
    }
    this.pool = [];
    this.inUse.clear();
    logger.info('Connection object pool closed');
  }
}

module.exports = ConnectionObjectPool;
