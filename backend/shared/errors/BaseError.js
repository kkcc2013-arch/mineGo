/**
 * BaseError - 所有应用错误的基类
 * 提供统一的错误结构、序列化和追踪能力
 */
class BaseError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    
    this.code = code;                              // 错误码
    this.statusCode = options.statusCode || 500;   // HTTP 状态码
    this.details = options.details || {};          // 错误详情
    this.isOperational = options.isOperational !== false; // 是否为可预期的错误
    this.timestamp = new Date().toISOString();
    
    // 捕获堆栈信息
    Error.captureStackTrace(this, this.constructor);
    
    // 设置错误名称为类名
    this.name = this.constructor.name;
  }

  /**
   * 转换为 JSON 格式（用于 API 响应）
   */
  toJSON() {
    const json = {
      success: false,
      code: this.code,
      message: this.message,
      details: this.details,
      timestamp: this.timestamp
    };

    // 非生产环境包含堆栈信息
    if (process.env.NODE_ENV !== 'production' && this.stack) {
      json.stack = this.stack;
    }

    return json;
  }

  /**
   * 转换为日志格式
   */
  toLog() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
      isOperational: this.isOperational,
      timestamp: this.timestamp,
      stack: this.stack
    };
  }
}

module.exports = BaseError;
