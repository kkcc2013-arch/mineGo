/**
 * WebSocket Prometheus 指标
 * REQ-00329: WebSocket 连接池与消息批处理性能优化
 * 
 * 指标列表：
 * - 活跃连接数
 * - 消息发送量
 * - 批处理大小分布
 * - 队列延迟
 * - 背压事件
 * - 连接池负载
 * - 队列大小
 */

'use strict';

const prometheus = require('prom-client');

// WebSocket 指标
const websocketMetrics = {
  // 活跃连接数
  activeConnections: new prometheus.Gauge({
    name: 'websocket_active_connections',
    help: 'Number of active WebSocket connections',
    labelNames: ['service']
  }),

  // 消息发送总量
  messagesSent: new prometheus.Counter({
    name: 'websocket_messages_sent_total',
    help: 'Total number of messages sent through WebSocket',
    labelNames: ['service', 'message_type', 'batch', 'priority']
  }),

  // 消息接收总量
  messagesReceived: new prometheus.Counter({
    name: 'websocket_messages_received_total',
    help: 'Total number of messages received from WebSocket',
    labelNames: ['service', 'message_type']
  }),

  // 批处理大小分布
  batchSize: new prometheus.Histogram({
    name: 'websocket_batch_size',
    help: 'Distribution of message batch sizes',
    buckets: [1, 5, 10, 20, 30, 50, 75, 100],
    labelNames: ['service']
  }),

  // 队列延迟（秒）
  queueDelay: new prometheus.Histogram({
    name: 'websocket_queue_delay_seconds',
    help: 'Time messages spend in queue before being sent',
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    labelNames: ['service']
  }),

  // 背压事件总数
  backpressureEvents: new prometheus.Counter({
    name: 'websocket_backpressure_events_total',
    help: 'Total number of backpressure events',
    labelNames: ['service', 'user_id']
  }),

  // 连接池负载（0-1）
  poolLoad: new prometheus.Gauge({
    name: 'websocket_pool_load',
    help: 'Load of WebSocket connection pools (0-1 scale)',
    labelNames: ['service', 'worker_id']
  }),

  // 队列大小
  queueSizeGauge: new prometheus.Gauge({
    name: 'websocket_queue_size',
    help: 'Current size of message queue',
    labelNames: ['service', 'user_id']
  }),

  // 连接持续时间（秒）
  connectionDuration: new prometheus.Histogram({
    name: 'websocket_connection_duration_seconds',
    help: 'Duration of WebSocket connections',
    buckets: [60, 300, 600, 1800, 3600, 7200, 14400, 28800, 86400], // 1m, 5m, 10m, 30m, 1h, 2h, 4h, 8h, 24h
    labelNames: ['service', 'platform']
  }),

  // 消息发送延迟（秒）
  messageSendLatency: new prometheus.Histogram({
    name: 'websocket_message_send_latency_seconds',
    help: 'Latency of sending messages through WebSocket',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5],
    labelNames: ['service', 'batch']
  }),

  // 连接错误总数
  connectionErrors: new prometheus.Counter({
    name: 'websocket_connection_errors_total',
    help: 'Total number of WebSocket connection errors',
    labelNames: ['service', 'error_type']
  }),

  // 消息丢弃总数
  messagesDropped: new prometheus.Counter({
    name: 'websocket_messages_dropped_total',
    help: 'Total number of messages dropped due to backpressure',
    labelNames: ['service', 'reason']
  }),

  // 频道订阅数
  channelSubscriptions: new prometheus.Gauge({
    name: 'websocket_channel_subscriptions',
    help: 'Number of active channel subscriptions',
    labelNames: ['service', 'channel']
  }),

  // 批处理效率（消息数/批次数）
  batchEfficiency: new prometheus.Gauge({
    name: 'websocket_batch_efficiency',
    help: 'Efficiency of message batching (messages per batch)',
    labelNames: ['service']
  }),

  // Worker 健康状态
  workerHealth: new prometheus.Gauge({
    name: 'websocket_worker_health',
    help: 'Health status of WebSocket workers (1=healthy, 0=unhealthy)',
    labelNames: ['service', 'worker_id']
  })
};

/**
 * 指标记录辅助类
 */
class WebSocketMetricsRecorder {
  constructor(serviceName = 'gateway') {
    this.serviceName = serviceName;
  }

  /**
   * 记录连接建立
   */
  recordConnection() {
    websocketMetrics.activeConnections.inc({ service: this.serviceName });
  }

  /**
   * 记录连接断开
   */
  recordDisconnection(platform = 'unknown', duration = 0) {
    websocketMetrics.activeConnections.dec({ service: this.serviceName });
    if (duration > 0) {
      websocketMetrics.connectionDuration.observe(
        { service: this.serviceName, platform },
        duration / 1000
      );
    }
  }

  /**
   * 记录消息发送
   */
  recordMessageSent(count = 1, type = 'unknown', batch = true, priority = 'normal') {
    websocketMetrics.messagesSent.inc(
      { 
        service: this.serviceName, 
        message_type: type, 
        batch: batch.toString(),
        priority 
      },
      count
    );
  }

  /**
   * 记录消息接收
   */
  recordMessageReceived(type = 'unknown') {
    websocketMetrics.messagesReceived.inc(
      { service: this.serviceName, message_type: type }
    );
  }

  /**
   * 记录批处理
   */
  recordBatch(batchSize) {
    websocketMetrics.batchSize.observe(
      { service: this.serviceName },
      batchSize
    );
  }

  /**
   * 记录队列延迟
   */
  recordQueueDelay(delayMs) {
    websocketMetrics.queueDelay.observe(
      { service: this.serviceName },
      delayMs / 1000
    );
  }

  /**
   * 记录背压事件
   */
  recordBackpressure(userId = 'unknown') {
    websocketMetrics.backpressureEvents.inc(
      { service: this.serviceName, user_id: userId }
    );
  }

  /**
   * 记录消息丢弃
   */
  recordMessageDropped(count = 1, reason = 'backpressure') {
    websocketMetrics.messagesDropped.inc(
      { service: this.serviceName, reason },
      count
    );
  }

  /**
   * 记录连接错误
   */
  recordConnectionError(errorType = 'unknown') {
    websocketMetrics.connectionErrors.inc(
      { service: this.serviceName, error_type: errorType }
    );
  }

  /**
   * 记录消息发送延迟
   */
  recordMessageSendLatency(latencyMs, batch = true) {
    websocketMetrics.messageSendLatency.observe(
      { service: this.serviceName, batch: batch.toString() },
      latencyMs / 1000
    );
  }

  /**
   * 更新队列大小
   */
  updateQueueSize(userId, size) {
    websocketMetrics.queueSizeGauge.set(
      { service: this.serviceName, user_id: userId },
      size
    );
  }

  /**
   * 更新连接池负载
   */
  updatePoolLoad(workerId, load) {
    websocketMetrics.poolLoad.set(
      { service: this.serviceName, worker_id: workerId },
      load
    );
  }

  /**
   * 更新频道订阅数
   */
  updateChannelSubscriptions(channel, count) {
    websocketMetrics.channelSubscriptions.set(
      { service: this.serviceName, channel },
      count
    );
  }

  /**
   * 更新批处理效率
   */
  updateBatchEfficiency(efficiency) {
    websocketMetrics.batchEfficiency.set(
      { service: this.serviceName },
      efficiency
    );
  }

  /**
   * 更新 Worker 健康状态
   */
  updateWorkerHealth(workerId, healthy) {
    websocketMetrics.workerHealth.set(
      { service: this.serviceName, worker_id: workerId },
      healthy ? 1 : 0
    );
  }

  /**
   * 获取所有指标
   */
  async getMetrics() {
    return prometheus.register.metrics();
  }

  /**
   * 获取指标内容类型
   */
  getContentType() {
    return prometheus.register.contentType;
  }
}

module.exports = websocketMetrics;
module.exports.WebSocketMetricsRecorder = WebSocketMetricsRecorder;
