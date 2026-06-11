/**
 * 死锁检测器
 * 
 * 通过等待图检测分布式锁死锁
 * 
 * @module deadlockDetector
 */

const { getDistributedLock } = require('./distributedLock');
const { createLogger } = require('./logger');

const logger = createLogger('deadlock-detector');

/**
 * 死锁检测器类
 */
class DeadlockDetector {
  constructor() {
    this.lock = null;
    this.lockWaitGraph = new Map(); // 等待图: waiter -> Set<holder>
    this.lockHolders = new Map(); // 锁持有者: resource -> holder
    this.checkInterval = null;
    this.alertHandler = null;
    this.detectionCount = 0;
  }

  /**
   * 初始化检测器
   */
  init() {
    this.lock = getDistributedLock();
  }

  /**
   * 启动死锁检测
   * @param {number} intervalMs - 检测间隔（毫秒）
   */
  start(intervalMs = 60000) {
    if (this.checkInterval) {
      logger.warn('Deadlock detector already running');
      return;
    }
    
    if (!this.lock) {
      this.init();
    }
    
    this.checkInterval = setInterval(() => {
      this.detectDeadlocks();
    }, intervalMs);
    
    // 防止阻止进程退出
    this.checkInterval.unref();
    
    logger.info({ intervalMs }, 'Deadlock detector started');
  }

  /**
   * 停止死锁检测
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    logger.info('Deadlock detector stopped');
  }

  /**
   * 记录锁获取
   * @param {string} resource - 资源标识
   * @param {string} holder - 持有者标识
   */
  recordAcquire(resource, holder) {
    this.lockHolders.set(resource, holder);
    
    // 移除等待关系
    this.removeWait(holder, resource);
    
    logger.debug({
      resource,
      holder
    }, 'Lock acquire recorded');
  }

  /**
   * 记录锁释放
   * @param {string} resource - 资源标识
   * @param {string} holder - 持有者标识
   */
  recordRelease(resource, holder) {
    if (this.lockHolders.get(resource) === holder) {
      this.lockHolders.delete(resource);
    }
    
    logger.debug({
      resource,
      holder
    }, 'Lock release recorded');
  }

  /**
   * 记录锁等待关系
   * @param {string} waiter - 等待者标识
   * @param {string} resource - 资源标识
   */
  recordWait(waiter, resource) {
    const holder = this.lockHolders.get(resource);
    
    if (holder && holder !== waiter) {
      if (!this.lockWaitGraph.has(waiter)) {
        this.lockWaitGraph.set(waiter, new Set());
      }
      this.lockWaitGraph.get(waiter).add(holder);
      
      logger.debug({
        waiter,
        holder,
        resource
      }, 'Lock wait recorded');
    }
  }

  /**
   * 移除锁等待关系
   * @param {string} waiter - 等待者标识
   * @param {string} resource - 资源标识
   */
  removeWait(waiter, resource) {
    const holder = this.lockHolders.get(resource);
    
    if (holder && this.lockWaitGraph.has(waiter)) {
      this.lockWaitGraph.get(waiter).delete(holder);
      
      // 如果等待集合为空，删除等待者
      if (this.lockWaitGraph.get(waiter).size === 0) {
        this.lockWaitGraph.delete(waiter);
      }
    }
  }

  /**
   * 检测死锁（通过有向图环路检测）
   * @returns {boolean} 是否检测到死锁
   */
  detectDeadlocks() {
    if (this.lockWaitGraph.size === 0) {
      return false;
    }
    
    const visited = new Set();
    const recursionStack = new Set();
    const deadlocks = [];
    
    for (const node of this.lockWaitGraph.keys()) {
      const cycle = this._findCycle(node, visited, recursionStack, []);
      
      if (cycle) {
        deadlocks.push(cycle);
      }
    }
    
    if (deadlocks.length > 0) {
      this.detectionCount += deadlocks.length;
      
      logger.error({
        deadlocks,
        waitGraph: this._serializeWaitGraph()
      }, 'Deadlock detected!');
      
      // 更新指标
      try {
        const { metrics } = require('./distributedLock');
        if (metrics.deadlocksDetected) {
          metrics.deadlocksDetected.inc(deadlocks.length);
        }
      } catch (err) {
        // 忽略指标错误
      }
      
      // 发送告警
      this._sendDeadlockAlert(deadlocks);
      
      return true;
    }
    
    return false;
  }

  /**
   * DFS 检测环路
   * @private
   */
  _findCycle(node, visited, recursionStack, path) {
    if (!visited.has(node)) {
      visited.add(node);
      recursionStack.add(node);
      path.push(node);
      
      const neighbors = this.lockWaitGraph.get(node) || new Set();
      
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          const cycle = this._findCycle(neighbor, visited, recursionStack, [...path]);
          if (cycle) {
            return cycle;
          }
        } else if (recursionStack.has(neighbor)) {
          // 找到环路
          const cycleStart = path.indexOf(neighbor);
          return path.slice(cycleStart);
        }
      }
    }
    
    recursionStack.delete(node);
    return null;
  }

  /**
   * 序列化等待图
   * @private
   */
  _serializeWaitGraph() {
    const result = {};
    for (const [waiter, holders] of this.lockWaitGraph) {
      result[waiter] = Array.from(holders);
    }
    return result;
  }

  /**
   * 发送死锁告警
   * @private
   */
  async _sendDeadlockAlert(deadlocks) {
    const alertData = {
      severity: 'critical',
      type: 'deadlock',
      message: 'Deadlock detected in distributed lock system',
      details: {
        deadlocks,
        waitGraph: this._serializeWaitGraph(),
        detectionCount: this.detectionCount,
        timestamp: new Date().toISOString()
      }
    };
    
    // 调用自定义告警处理器
    if (this.alertHandler) {
      try {
        await this.alertHandler(alertData);
      } catch (err) {
        logger.error({ err }, 'Failed to send deadlock alert');
      }
    }
    
    // 尝试使用全局告警管理器
    try {
      const { sendAlert } = require('./alertManager');
      await sendAlert(alertData);
    } catch (err) {
      // alertManager 不存在，忽略
    }
  }

  /**
   * 设置告警处理器
   * @param {Function} handler - 告警处理函数
   */
  setAlertHandler(handler) {
    this.alertHandler = handler;
  }

  /**
   * 获取等待图统计
   */
  getStats() {
    return {
      totalWaits: this.lockWaitGraph.size,
      totalHolders: this.lockHolders.size,
      detectionCount: this.detectionCount,
      waitGraph: this._serializeWaitGraph()
    };
  }

  /**
   * 清理过期的等待关系
   * @param {number} maxAgeMs - 最大年龄（毫秒）
   */
  cleanup(maxAgeMs = 300000) {
    // 简单实现：清空所有等待关系
    // 实际实现应该跟踪时间戳
    const beforeSize = this.lockWaitGraph.size;
    this.lockWaitGraph.clear();
    
    logger.info({
      removed: beforeSize
    }, 'Cleaned up wait graph');
  }

  /**
   * 重置检测器状态
   */
  reset() {
    this.lockWaitGraph.clear();
    this.lockHolders.clear();
    this.detectionCount = 0;
    
    logger.info('Deadlock detector reset');
  }
}

// 单例实例
let detectorInstance = null;

/**
 * 获取死锁检测器单例
 */
function getDeadlockDetector() {
  if (!detectorInstance) {
    detectorInstance = new DeadlockDetector();
  }
  return detectorInstance;
}

/**
 * 重置死锁检测器（用于测试）
 */
function resetDeadlockDetector() {
  if (detectorInstance) {
    detectorInstance.stop();
    detectorInstance.reset();
    detectorInstance = null;
  }
}

module.exports = {
  DeadlockDetector,
  getDeadlockDetector,
  resetDeadlockDetector
};
