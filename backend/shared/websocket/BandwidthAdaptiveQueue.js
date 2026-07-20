'use strict';

const { logger, metrics } = require('../index');

/**
 * 带宽自适应消息队列
 * 
 * 根据网络带宽动态调整消息聚合策略，提升带宽利用率
 */
class BandwidthAdaptiveQueue {
  constructor(options = {}) {
    this.config = {
      // 队列配置
      maxQueueSize: options.maxQueueSize || 10000,
      
      // 带宽检测
      bandwidthSampleWindow: options.bandwidthSampleWindow || 60000, // 1分钟
      lowBandwidthThreshold: options.lowBandwidthThreshold || 100000, // 100KB/s
      highBandwidthThreshold: options.highBandwidthThreshold || 1000000, // 1MB/s
      
      // 聚合配置
      minBatchSize: options.minBatchSize || 1,
      maxBatchSize: options.maxBatchSize || 50,
      minBatchTimeout: options.minBatchTimeout || 10, // 高带宽：10ms
      maxBatchTimeout: options.maxBatchTimeout || 100, // 低带宽：100ms
      
      // 压缩阈值
      compressThreshold: options.compressThreshold || 512
    };
    
    // 消息队列
    this.queue = [];
    
    // 带宽状态
    this.bandwidth = {
      current: 0,
      samples: [],
      lastSampleTime: Date.now(),
      lastBytesSent: 0
    };
    
    // 聚合策略
    this.strategy = {
      batchSize: this.config.minBatchSize,
      batchTimeout: this.config.minBatchTimeout,
      compressionEnabled: false
    };
    
    // 统计
    this.stats = {
      totalQueued: 0,
      totalSent: 0,
      totalBytes: 0,
      totalBatches: 0,
      avgBatchSize: 0
    };
    
    this._monitorTask = null;
    this._setupMetrics();
    this._startBandwidthMonitor();
  }

  /**
   * 设置 Prometheus 指标
   */
  _setupMetrics() {
    this.metrics = {
      bandwidth: metrics.gauge('ws_bandwidth_bytes_per_sec', 'Current bandwidth'),
      batchSize: metrics.gauge('ws_adaptive_batch_size', 'Current batch size'),
      queueLength: metrics.gauge('ws_adaptive_queue_length', 'Queue length'),
      batchTimeout: metrics.gauge('ws_adaptive_batch_timeout_ms', 'Batch timeout'),
      messagesSent: metrics.counter('ws_adaptive_messages_sent_total', 'Messages sent')
    };
  }

  /**
   * 入队消息
   */
  enqueue(message) {
    if (this.queue.length >= this.config.maxQueueSize) {
      logger.warn('Bandwidth adaptive queue full');
      return false;
    }
    
    this.queue.push({
      ...message,
      queuedAt: Date.now()
    });
    
    this.stats.totalQueued++;
    this.metrics.queueLength.set(this.queue.length);
    
    return true;
  }

  /**
   * 获取批次（根据带宽自适应）
   */
  getBatch() {
    if (this.queue.length === 0) {
      return null;
    }
    
    // 更新聚合策略
    this._updateStrategy();
    
    // 取出消息
    const batchSize = Math.min(this.queue.length, this.strategy.batchSize);
    const batch = this.queue.splice(0, batchSize);
    
    this.stats.totalSent += batch.length;
    this.stats.totalBatches++;
    this.stats.avgBatchSize = (this.stats.avgBatchSize * 0.9 + batch.length * 0.1);
    
    this.metrics.messagesSent.inc(batch.length);
    this.metrics.queueLength.set(this.queue.length);
    
    return {
      messages: batch,
      compressed: this.strategy.compressionEnabled,
      timestamp: Date.now()
    };
  }

  /**
   * 更新聚合策略
   */
  _updateStrategy() {
    const bandwidth = this.bandwidth.current;
    
    // 根据带宽调整批量大小
    if (bandwidth < this.config.lowBandwidthThreshold) {
      // 低带宽：大批量，长等待
      this.strategy.batchSize = this.config.maxBatchSize;
      this.strategy.batchTimeout = this.config.maxBatchTimeout;
      this.strategy.compressionEnabled = true;
    } else if (bandwidth > this.config.highBandwidthThreshold) {
      // 高带宽：小批量，短等待
      this.strategy.batchSize = this.config.minBatchSize;
      this.strategy.batchTimeout = this.config.minBatchTimeout;
      this.strategy.compressionEnabled = false;
    } else {
      // 中等带宽：线性插值
      const ratio = (bandwidth - this.config.lowBandwidthThreshold) / 
        (this.config.highBandwidthThreshold - this.config.lowBandwidthThreshold);
      
      this.strategy.batchSize = Math.round(
        this.config.maxBatchSize - ratio * (this.config.maxBatchSize - this.config.minBatchSize)
      );
      this.strategy.batchTimeout = Math.round(
        this.config.maxBatchTimeout - ratio * (this.config.maxBatchTimeout - this.config.minBatchTimeout)
      );
      this.strategy.compressionEnabled = ratio < 0.5;
    }
    
    this.metrics.batchSize.set(this.strategy.batchSize);
    this.metrics.batchTimeout.set(this.strategy.batchTimeout);
  }

  /**
   * 启动带宽监控
   */
  _startBandwidthMonitor() {
    this._monitorTask = setInterval(() => {
      this._monitorBandwidth();
    }, this.config.bandwidthSampleWindow);
  }

  /**
   * 监控带宽
   */
  _monitorBandwidth() {
    const now = Date.now();
    const elapsed = (now - this.bandwidth.lastSampleTime) / 1000; // 秒
    
    if (elapsed > 0) {
      // 计算带宽（简化：使用消息发送量估算）
      const bytesPerSec = this.stats.totalBytes / elapsed;
      
      this.bandwidth.samples.push(bytesPerSec);
      
      // 保留最近10个样本
      if (this.bandwidth.samples.length > 10) {
        this.bandwidth.samples.shift();
      }
      
      // 计算平均带宽
      this.bandwidth.current = this.bandwidth.samples.reduce((a, b) => a + b, 0) / this.bandwidth.samples.length;
      
      this.metrics.bandwidth.set(this.bandwidth.current);
      
      this.bandwidth.lastSampleTime = now;
    }
  }

  /**
   * 记录发送字节数
   */
  recordBytesSent(bytes) {
    this.stats.totalBytes += bytes;
  }

  /**
   * 获取当前策略
   */
  getCurrentStrategy() {
    return {
      ...this.strategy,
      bandwidth: this.bandwidth.current,
      queueLength: this.queue.length
    };
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      bandwidth: this.bandwidth.current,
      strategy: this.strategy
    };
  }

  /**
   * 关闭队列
   */
  close() {
    if (this._monitorTask) {
      clearInterval(this._monitorTask);
      this._monitorTask = null;
    }
    logger.info('Bandwidth adaptive queue closed');
  }
}

module.exports = BandwidthAdaptiveQueue;
