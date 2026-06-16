/**
 * 事件总线适配器接口
 * 定义统一的事件总线操作接口，支持多种消息系统实现
 * 
 * @interface IEventBusAdapter
 */
class IEventBusAdapter {
  constructor(config = {}) {
    this.config = config;
    this.isConnected = false;
    this.metrics = {
      published: 0,
      consumed: 0,
      errors: 0,
      retries: 0
    };
  }

  /**
   * 连接到消息系统
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error('Method connect() must be implemented');
  }

  /**
   * 断开连接
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('Method disconnect() must be implemented');
  }

  /**
   * 发布事件到指定主题
   * @param {string} topic - 主题名称
   * @param {Object} event - 事件对象
   * @param {Object} options - 发布选项（key、partition、headers等）
   * @returns {Promise<void>}
   */
  async publish(topic, event, options = {}) {
    throw new Error('Method publish() must be implemented');
  }

  /**
   * 订阅主题
   * @param {string} topic - 主题名称
   * @param {Function} handler - 事件处理函数
   * @param {Object} options - 订阅选项（groupId、fromBeginning等）
   * @returns {Promise<void>}
   */
  async subscribe(topic, handler, options = {}) {
    throw new Error('Method subscribe() must be implemented');
  }

  /**
   * 取消订阅主题
   * @param {string} topic - 主题名称
   * @returns {Promise<void>}
   */
  async unsubscribe(topic) {
    throw new Error('Method unsubscribe() must be implemented');
  }

  /**
   * 健康检查
   * @returns {Promise<Object>} 健康状态对象
   */
  async healthCheck() {
    throw new Error('Method healthCheck() must be implemented');
  }

  /**
   * 获取指标数据
   * @returns {Object} 指标对象
   */
  getMetrics() {
    return {
      ...this.metrics,
      isConnected: this.isConnected,
      adapterType: this.constructor.name
    };
  }

  /**
   * 重置指标
   */
  resetMetrics() {
    this.metrics = {
      published: 0,
      consumed: 0,
      errors: 0,
      retries: 0
    };
  }

  /**
   * 更新指标
   * @param {string} metric - 指标名称
   * @param {number} value - 增量值
   */
  updateMetric(metric, value = 1) {
    if (this.metrics.hasOwnProperty(metric)) {
      this.metrics[metric] += value;
    }
  }
}

module.exports = IEventBusAdapter;
