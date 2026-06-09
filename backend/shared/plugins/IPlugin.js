/**
 * 插件接口 - 所有中间件插件必须实现
 * 
 * @abstract
 * @class IPlugin
 */
class IPlugin {
  /**
   * 插件元信息（子类必须实现）
   * 
   * @static
   * @returns {Object} 插件元信息
   * @property {string} name - 插件名称（唯一标识）
   * @property {string} version - 版本号
   * @property {string} description - 描述
   * @property {string} author - 作者
   * @property {string[]} dependencies - 依赖的其他插件
   * @property {number} priority - 加载优先级（数字越小越先加载）
   * @property {string} category - 分类：middleware, auth, monitoring, etc.
   */
  static get meta() {
    return {
      name: '',
      version: '1.0.0',
      description: 'Base plugin',
      author: 'mineGo Team',
      dependencies: [],
      priority: 100,
      category: 'middleware',
    };
  }

  /**
   * 配置 Schema（JSON Schema 格式）
   * 
   * @static
   * @returns {Object} JSON Schema
   */
  static get configSchema() {
    return {
      type: 'object',
      properties: {},
    };
  }

  /**
   * 默认配置
   * 
   * @static
   * @returns {Object} 默认配置对象
   */
  static get defaultConfig() {
    return {};
  }

  /**
   * 初始化插件 - 加载配置、建立连接
   * 
   * @async
   * @param {Object} config - 插件配置
   * @param {Object} context - 插件上下文（logger, metrics, redis, db 等）
   * @throws {Error} 初始化失败时抛出错误
   */
  async init(config, context) {
    throw new Error('Plugin init() must be implemented');
  }

  /**
   * 启动插件 - 开始处理请求
   * 
   * @async
   * @param {Object} context - 插件上下文
   * @throws {Error} 启动失败时抛出错误
   */
  async start(context) {
    // 默认空实现，子类可覆盖
  }

  /**
   * 停止插件 - 清理资源
   * 
   * @async
   * @param {Object} context - 插件上下文
   */
  async stop(context) {
    // 默认空实现，子类可覆盖
  }

  /**
   * 健康检查
   * 
   * @async
   * @returns {Object} 健康状态
   * @property {string} status - 'healthy' | 'unhealthy' | 'degraded'
   * @property {Object} details - 详细信息
   */
  async healthCheck() {
    return {
      status: 'healthy',
      details: {},
    };
  }

  /**
   * 获取 Express 中间件
   * 
   * @returns {Function|null} Express 中间件函数，或 null（非中间件插件）
   */
  getMiddleware() {
    return null;
  }

  /**
   * 处理事件（可选）
   * 
   * @async
   * @param {string} eventName - 事件名称
   * @param {*} payload - 事件负载
   */
  async handleEvent(eventName, payload) {
    // 默认忽略事件，子类可覆盖
  }

  /**
   * 验证配置（内部方法）
   * 
   * @param {Object} config - 待验证的配置
   * @returns {boolean} 验证结果
   */
  validateConfig(config) {
    // 简单的 schema 验证（生产环境建议使用 ajv）
    const schema = this.constructor.configSchema;
    if (!schema || schema.type !== 'object') return true;

    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (config[field] === undefined) {
          throw new Error(`Missing required config field: ${field}`);
        }
      }
    }

    return true;
  }
}

module.exports = { IPlugin };
