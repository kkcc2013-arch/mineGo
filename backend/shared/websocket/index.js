/**
 * WebSocket 安全系统索引文件
 * REQ-00434: WebSocket 消息完整性与防重放攻击保护系统
 * REQ-00552: WebSocket 连接池自适应伸缩与资源优化系统
 */

module.exports = {
  WebSocketMessageSecurity: require('./WebSocketMessageSecurity'),
  WebSocketChallengeAuth: require('./WebSocketChallengeAuth'),
  WebSocketAnomalyDetector: require('./WebSocketAnomalyDetector'),
  WebSocketSecurityMiddleware: require('./WebSocketSecurityMiddleware'),
  
  // 已有模块
  ConnectionPool: require('./ConnectionPool'),
  ConnectionLoadBalancer: require('./ConnectionLoadBalancer'),
  MessageBatchQueue: require('./MessageBatchQueue'),
  Metrics: require('./Metrics'),
  
  // REQ-00552 新增优化模块
  AdaptiveConnectionPool: require('./AdaptiveConnectionPool'),
  ConnectionObjectPool: require('./ConnectionObjectPool'),
  PriorityTaskScheduler: require('./PriorityTaskScheduler'),
  BandwidthAdaptiveQueue: require('./BandwidthAdaptiveQueue'),
  OptimizedManager: require('./OptimizedManager')
};