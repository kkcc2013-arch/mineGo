/**
 * WebSocket 安全系统索引文件
 * REQ-00434: WebSocket 消息完整性与防重放攻击保护系统
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
  Metrics: require('./Metrics')
};