/**
 * 协议适配器抽象基类
 * 用于统一不同通信协议（HTTP、gRPC、WebSocket、GraphQL）的调用接口
 */

const logger = require('./logger');
const metrics = require('./metrics');

/**
 * 协议适配器抽象接口
 */
class ProtocolAdapter {
  constructor(config) {
    this.protocol = config.protocol; // 'http' | 'grpc' | 'graphql' | 'websocket'
    this.config = config;
    this.isConnected = false;
  }

  /**
   * 初始化连接
   */
  async connect() {
    throw new Error('Method not implemented: connect()');
  }

  /**
   * 发送请求
   * @param {Object} request - 请求对象
   * @param {string} request.service - 服务名称
   * @param {string} request.method - 方法名称
   * @param {Object} request.data - 请求数据
   * @param {Object} request.options - 协议特定选项
   */
  async send(request) {
    throw new Error('Method not implemented: send()');
  }

  /**
   * 批量发送请求
   */
  async sendBatch(requests) {
    throw new Error('Method not implemented: sendBatch()');
  }

  /**
   * 订阅事件流（仅 WebSocket 支持）
   */
  async subscribe(event, handler) {
    throw new Error('Method not implemented: subscribe()');
  }

  /**
   * 取消订阅
   */
  async unsubscribe(event) {
    throw new Error('Method not implemented: unsubscribe()');
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    throw new Error('Method not implemented: healthCheck()');
  }

  /**
   * 关闭连接
   */
  async disconnect() {
    throw new Error('Method not implemented: disconnect()');
  }

  /**
   * 获取协议类型
   */
  getProtocol() {
    return this.protocol;
  }

  /**
   * 获取连接状态
   */
  isConnected() {
    return this.isConnected;
  }

  /**
   * 记录请求指标
   */
  recordMetrics(service, method, duration, success) {
    metrics.timing(`protocol.${this.protocol}.request_duration`, duration, {
      service,
      method,
      status: success ? 'success' : 'error'
    });

    if (!success) {
      metrics.increment(`protocol.${this.protocol}.request_error`, 1, {
        service,
        method
      });
    }

    metrics.increment(`protocol.${this.protocol}.requests_total`, 1, {
      service,
      method,
      status: success ? 'success' : 'error'
    });
  }
}

module.exports = ProtocolAdapter;