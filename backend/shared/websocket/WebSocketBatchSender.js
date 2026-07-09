/**
 * WebSocket 消息批处理器
 * REQ-00511: WebSocket 长连接连接池管理与高性能消息批处理系统
 * 
 * 功能：
 * - 消息缓冲队列（Buffer Queue）
 * - 动态发送窗口控制
 * - 消息合并与压缩
 * - 批量发送优化
 * - TCP 拥塞控制适配
 * - 优先级队列支持
 */

'use strict';

const { logger, metrics } = require('../index');
const { v4: uuidv4 } = require('uuid');

class WebSocketBatchSender {
  constructor(options = {}) {
    // 配置
    this.config = {
      // 批处理配置
      batchSize: options.batchSize || 10, // 单批次最大消息数
      batchTimeout: options.batchTimeout || 50, // 批次等待超时（ms）
      maxBufferSize: options.maxBufferSize || 1000, // 最大缓冲队列大小
      
      // 发送窗口配置
      windowSize: options.windowSize || 100, // 初始窗口大小
      minWindowSize: options.minWindowSize || 10, // 最小窗口
      maxWindowSize: options.maxWindowSize || 500, // 最大窗口
      windowAdjustInterval: options.windowAdjustInterval || 5000, // 窗口调整周期
      
      // 消息合并配置
      enableMerge: options.enableMerge !== false, // 默认启用
      mergeSimilarTypes: options.mergeSimilarTypes || ['battle_update', 'location_update', 'pokemon_spawn'],
      mergeThreshold: options.mergeThreshold || 3, // 相同类型消息超过此数量才合并
      
      // 压缩配置
      enableCompress: options.enableCompress !== false, // 默认启用
      compressThreshold: options.compressThreshold || 1024, // 批次大小超过此值才压缩
      
      // 优先级配置
      priorityLevels: options.priorityLevels || ['high', 'normal', 'low'],
      highPriorityTimeout: options.highPriorityTimeout || 10 // 高优先级消息立即发送超时
      
    };
    
    // 消息缓冲队列（按优先级分组）
    this.buffers = {
      high: [],
      normal: [],
      low: []
    };
    
    // 发送窗口状态
    this.windowState = {
      currentSize: this.config.windowSize,
      pendingAcks: 0,
      congestionLevel: 0, // 0-100 拥塞级别
      lastAdjustTime: Date.now()
    };
    
    // 统计信息
    this.stats = {
      totalMessagesQueued: 0,
      totalMessagesSent: 0,
      totalBatchesSent: 0,
      totalBytesSent: 0,
      totalMergedMessages: 0,
      averageBatchSize: 0,
      averageLatency: 0
    };
    
    // 发送任务
    this._sendTask = null;
    this._windowTask = null;
    
    // 启动处理任务
    this._startProcessing();
    this._startWindowAdjustment();
    
    this._setupMetrics();
    
    logger.info('WebSocket batch sender initialized');
  }

  /**
   * 设置 Prometheus 指标
   */
  _setupMetrics() {
    this.metrics = {
      messagesQueued: metrics.counter('ws_batch_messages_queued_total', 'Messages queued for batch', ['priority']),
      batchesSent: metrics.counter('ws_batch_batches_sent_total', 'Batches sent', ['type']),
      messagesSent: metrics.counter('ws_batch_messages_sent_total', 'Messages sent via batch'),
      bytesSent: metrics.counter('ws_batch_bytes_sent_total', 'Bytes sent via batch'),
      mergedMessages: metrics.counter('ws_batch_merged_messages_total', 'Messages merged'),
      bufferSize: metrics.gauge('ws_batch_buffer_size', 'Current buffer size', ['priority']),
      windowSize: metrics.gauge('ws_batch_window_size', 'Current send window size'),
      congestionLevel: metrics.gauge('ws_batch_congestion_level', 'Current congestion level (0-100)'),
      batchLatency: metrics.histogram('ws_batch_latency_ms', 'Message batch latency', [], [1, 5, 10, 25, 50, 100, 200]),
      throughput: metrics.gauge('ws_batch_throughput_msg_per_sec', 'Batch throughput (messages/sec)')
    };
  }

  /**
   * 入队消息
   * @param {WebSocket} ws WebSocket 连接
   * @param {Object} message 消息对象
   * @param {string} priority 优先级（high/normal/low）
   * @returns {boolean} 是否成功入队
   */
  enqueue(ws, message, priority = 'normal') {
    if (!ws || ws.readyState !== 1) { // WebSocket.OPEN
      logger.warn('WebSocket not open, message dropped');
      return false;
    }
    
    const buffer = this.buffers[priority];
    if (!buffer) {
      logger.warn({ priority }, 'Invalid priority level');
      return false;
    }
    
    // 检查缓冲区容量
    const totalBufferSize = this._getTotalBufferSize();
    if (totalBufferSize >= this.config.maxBufferSize) {
      logger.warn({ size: totalBufferSize }, 'Buffer full, message dropped');
      this.metrics.bufferSize.set(totalBufferSize);
      return false;
    }
    
    // 创建消息条目
    const entry = {
      ws,
      message,
      priority,
      queuedAt: Date.now(),
      connectionId: message.connectionId || uuidv4()
    };
    
    buffer.push(entry);
    
    // 更新统计
    this.stats.totalMessagesQueued++;
    
    // 更新指标
    this.metrics.messagesQueued.inc({ priority });
    this.metrics.bufferSize.set(this._getTotalBufferSize());
    
    // 高优先级消息触发立即处理
    if (priority === 'high') {
      this._triggerHighPrioritySend();
    }
    
    return true;
  }

  /**
   * 批量入队消息
   * @param {WebSocket} ws WebSocket 连接
   * @param {Array} messages 消息数组
   * @param {string} priority 优先级
   * @returns {number} 成功入队的消息数
   */
  enqueueBatch(ws, messages, priority = 'normal') {
    let successCount = 0;
    
    for (const message of messages) {
      if (this.enqueue(ws, message, priority)) {
        successCount++;
      }
    }
    
    return successCount;
  }

  /**
   * 发送消息（绕过批处理，立即发送）
   * @param {WebSocket} ws WebSocket 连接
   * @param {Object} message 消息对象
   */
  sendImmediate(ws, message) {
    if (!ws || ws.readyState !== 1) {
      return false;
    }
    
    try {
      const data = JSON.stringify(message);
      ws.send(data);
      
      this.stats.totalMessagesSent++;
      this.stats.totalBytesSent += data.length;
      
      this.metrics.messagesSent.inc();
      this.metrics.bytesSent.inc(data.length);
      
      return true;
    } catch (error) {
      logger.warn({ error: error.message }, 'Failed to send immediate message');
      return false;
    }
  }

  /**
   * 获取缓冲区总大小
   */
  _getTotalBufferSize() {
    return this.buffers.high.length + this.buffers.normal.length + this.buffers.low.length;
  }

  /**
   * 启动批处理任务
   */
  _startProcessing() {
    this._sendTask = setInterval(() => {
      this._processBuffer();
    }, this.config.batchTimeout);
  }

  /**
   * 处理缓冲区
   */
  _processBuffer() {
    // 优先处理高优先级消息
    if (this.buffers.high.length > 0) {
      this._processPriorityBuffer('high');
    }
    
    // 处理普通优先级消息
    if (this.buffers.normal.length > 0) {
      this._processPriorityBuffer('normal');
    }
    
    // 最后处理低优先级消息
    if (this.buffers.low.length > 0 && this._getTotalBufferSize() < this.config.maxBufferSize * 0.5) {
      this._processPriorityBuffer('low');
    }
  }

  /**
   * 处理指定优先级的缓冲区
   */
  _processPriorityBuffer(priority) {
    const buffer = this.buffers[priority];
    if (buffer.length === 0) return;
    
    // 检查发送窗口
    if (this.windowState.pendingAcks >= this.windowState.currentSize) {
      // 窗口已满，等待
      return;
    }
    
    // 取出消息
    const batch = buffer.splice(0, Math.min(buffer.length, this.config.batchSize));
    
    // 消息合并处理
    if (this.config.enableMerge && batch.length >= this.config.mergeThreshold) {
      batch = this._mergeMessages(batch);
    }
    
    // 按连接分组发送
    this._sendBatch(batch);
  }

  /**
   * 合并相同类型的消息
   */
  _mergeMessages(batch) {
    const merged = [];
    const typeGroups = {};
    
    // 按类型分组
    for (const entry of batch) {
      const type = entry.message.type || 'unknown';
      
      if (this.config.mergeSimilarTypes.includes(type)) {
        if (!typeGroups[type]) {
          typeGroups[type] = [];
        }
        typeGroups[type].push(entry);
      } else {
        // 不合并的消息直接保留
        merged.push(entry);
      }
    }
    
    // 合并同类型消息
    for (const [type, entries] of Object.entries(typeGroups)) {
      if (entries.length >= this.config.mergeThreshold) {
        // 创建合并消息
        const mergedMessage = {
          type: `${type}_batch`,
          items: entries.map(e => e.message.data || e.message),
          timestamp: Date.now(),
          count: entries.length
        };
        
        // 使用第一个连接发送
        merged.push({
          ws: entries[0].ws,
          message: mergedMessage,
          priority: entries[0].priority,
          queuedAt: entries[0].queuedAt,
          connectionId: entries[0].connectionId,
          mergedCount: entries.length
        });
        
        this.stats.totalMergedMessages += entries.length - 1;
        this.metrics.mergedMessages.inc(entries.length - 1);
      } else {
        // 数量不足，保留原消息
        merged.push(...entries);
      }
    }
    
    return merged;
  }

  /**
   * 发送批次
   */
  _sendBatch(batch) {
    // 按连接分组
    const connectionGroups = {};
    
    for (const entry of batch) {
      const connId = entry.connectionId;
      if (!connectionGroups[connId]) {
        connectionGroups[connId] = {
          ws: entry.ws,
          messages: []
        };
      }
      connectionGroups[connId].messages.push(entry.message);
    }
    
    // 发送每个连接的批次
    for (const [connId, group] of Object.entries(connectionGroups)) {
      const { ws, messages } = group;
      
      if (!ws || ws.readyState !== 1) continue;
      
      // 构建发送数据
      const sendData = messages.length === 1 
        ? messages[0]
        : { type: 'batch', messages, timestamp: Date.now() };
      
      let dataStr = JSON.stringify(sendData);
      
      // 压缩处理（如果启用且数据足够大）
      if (this.config.enableCompress && dataStr.length > this.config.compressThreshold) {
        // 压缩标记（实际压缩由 WebSocket 的 perMessageDeflate 处理）
        sendData.compressed = true;
      }
      
      try {
        ws.send(dataStr);
        
        // 更新统计
        const latency = Date.now() - batch[0]?.queuedAt || 0;
        this.stats.totalMessagesSent += messages.length;
        this.stats.totalBytesSent += dataStr.length;
        this.stats.totalBatchesSent++;
        this.stats.averageLatency = (this.stats.averageLatency * 0.9 + latency * 0.1);
        
        // 更新窗口状态
        this.windowState.pendingAcks++;
        
        // 更新指标
        this.metrics.messagesSent.inc(messages.length);
        this.metrics.bytesSent.inc(dataStr.length);
        this.metrics.batchesSent.inc({ type: messages.length === 1 ? 'single' : 'batch' });
        this.metrics.batchLatency.observe(latency);
        this.metrics.bufferSize.set(this._getTotalBufferSize());
        
      } catch (error) {
        logger.warn({ connId, error: error.message }, 'Failed to send batch');
      }
    }
  }

  /**
   * 触发高优先级消息发送
   */
  _triggerHighPrioritySend() {
    // 使用较短的超时触发立即处理
    setTimeout(() => {
      this._processPriorityBuffer('high');
    }, this.config.highPriorityTimeout);
  }

  /**
   * 启动窗口调整任务
   */
  _startWindowAdjustment() {
    this._windowTask = setInterval(() => {
      this._adjustWindow();
    }, this.config.windowAdjustInterval);
  }

  /**
   * 动态调整发送窗口
   */
  _adjustWindow() {
    const { currentSize, pendingAcks, congestionLevel } = this.windowState;
    const bufferFullRatio = this._getTotalBufferSize() / this.config.maxBufferSize;
    
    // 计算拥塞级别（基于缓冲区填充率和未确认消息）
    const newCongestionLevel = Math.min(100, 
      congestionLevel * 0.7 + 
      bufferFullRatio * 30 + 
      (pendingAcks / currentSize) * 30
    );
    
    this.windowState.congestionLevel = newCongestionLevel;
    this.metrics.congestionLevel.set(newCongestionLevel);
    
    // 根据拥塞级别调整窗口
    let newWindowSize = currentSize;
    
    if (newCongestionLevel < 20) {
      // 低拥塞，增大窗口
      newWindowSize = Math.min(this.config.maxWindowSize, currentSize + 20);
    } else if (newCongestionLevel > 60) {
      // 高拥塞，减小窗口
      newWindowSize = Math.max(this.config.minWindowSize, currentSize - 20);
    }
    
    this.windowState.currentSize = newWindowSize;
    this.windowState.lastAdjustTime = Date.now();
    
    this.metrics.windowSize.set(newWindowSize);
    
    // 计算吞吐量
    const throughput = this.stats.totalMessagesSent / 
      ((Date.now() - this._startTime || Date.now()) / 1000);
    this.metrics.throughput.set(throughput);
    
    logger.debug({ 
      congestionLevel: newCongestionLevel, 
      windowSize: newWindowSize, 
      pendingAcks 
    }, 'Window adjusted');
  }

  /**
   * 处理 ACK（减少 pending 计数）
   */
  handleAck(connectionId) {
    if (this.windowState.pendingAcks > 0) {
      this.windowState.pendingAcks--;
    }
  }

  /**
   * 获取状态信息
   */
  getStatus() {
    return {
      bufferSize: this._getTotalBufferSize(),
      bufferBreakdown: {
        high: this.buffers.high.length,
        normal: this.buffers.normal.length,
        low: this.buffers.low.length
      },
      windowState: { ...this.windowState },
      stats: { ...this.stats },
      config: { ...this.config }
    };
  }

  /**
   * 清空缓冲区
   */
  flush() {
    // 处理所有缓冲区
    while (this._getTotalBufferSize() > 0) {
      this._processBuffer();
    }
  }

  /**
   * 关闭批处理器
   */
  close() {
    // 清空缓冲区
    this.flush();
    
    // 停止任务
    if (this._sendTask) {
      clearInterval(this._sendTask);
    }
    if (this._windowTask) {
      clearInterval(this._windowTask);
    }
    
    logger.info('WebSocket batch sender closed');
  }
}

module.exports = WebSocketBatchSender;