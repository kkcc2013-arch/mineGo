'use strict';

/**
 * WebSocket 优化模块集成入口
 * 
 * 整合所有 WebSocket 资源优化组件
 */

const WebSocketConnectionPool = require('./WebSocketConnectionPool');
const WebSocketBatchSender = require('./WebSocketBatchSender');
const AdaptiveConnectionPool = require('./AdaptiveConnectionPool');
const ConnectionObjectPool = require('./ConnectionObjectPool');
const PriorityTaskScheduler = require('./PriorityTaskScheduler');
const BandwidthAdaptiveQueue = require('./BandwidthAdaptiveQueue');

/**
 * 创建优化后的 WebSocket 管理器
 */
function createOptimizedWebSocketManager(options = {}) {
  // 创建自适应连接池控制器
  const adaptivePool = new AdaptiveConnectionPool(options.adaptive);
  
  // 创建连接对象池
  const objectPool = new ConnectionObjectPool(options.objectPool);
  
  // 创建优先级调度器
  const scheduler = new PriorityTaskScheduler(options.scheduler);
  
  // 创建带宽自适应队列
  const bandwidthQueue = new BandwidthAdaptiveQueue(options.bandwidth);
  
  // 扩展连接池（集成优化组件）
  const extendedPool = {
    ...WebSocketConnectionPool,
    
    // 集成优化方法
    canAcceptConnection() {
      return adaptivePool.canAcceptConnection();
    },
    
    getCurrentMaxConnections() {
      return adaptivePool.getCurrentMax();
    },
    
    acquireConnectionObject() {
      return objectPool.acquire();
    },
    
    releaseConnectionObject(obj) {
      return objectPool.release(obj);
    },
    
    scheduleTask(task, priority) {
      return scheduler.schedule(task, priority);
    },
    
    enqueueMessage(msg) {
      return bandwidthQueue.enqueue(msg);
    },
    
    getMessageBatch() {
      return bandwidthQueue.getBatch();
    },
    
    recordBytesSent(bytes) {
      bandwidthQueue.recordBytesSent(bytes);
    }
  };
  
  return {
    connectionPool: extendedPool,
    batchSender: new WebSocketBatchSender(options.batch),
    adaptivePool,
    objectPool,
    scheduler,
    bandwidthQueue,
    
    /**
     * 获取聚合状态
     */
    getStatus() {
      return {
        connectionPool: {
          maxConnections: adaptivePool.getCurrentMax(),
          canAccept: adaptivePool.canAcceptConnection()
        },
        objectPool: objectPool.getStats(),
        scheduler: scheduler.getStatus(),
        bandwidthQueue: bandwidthQueue.getStats(),
        adaptivePool: adaptivePool.getStatus()
      };
    },
    
    /**
     * 关闭所有组件
     */
    async close() {
      bandwidthQueue.close();
      await scheduler.close();
      objectPool.close();
      adaptivePool.close();
      logger.info('Optimized WebSocket manager closed');
    }
  };
}

module.exports = {
  WebSocketConnectionPool,
  WebSocketBatchSender,
  AdaptiveConnectionPool,
  ConnectionObjectPool,
  PriorityTaskScheduler,
  BandwidthAdaptiveQueue,
  createOptimizedWebSocketManager
};
