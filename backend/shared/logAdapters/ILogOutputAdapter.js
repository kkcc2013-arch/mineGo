/**
 * 日志输出适配器抽象接口
 * 所有日志输出适配器必须实现此接口
 */
'use strict';

class ILogOutputAdapter {
  constructor(name) {
    if (this.constructor === ILogOutputAdapter) {
      throw new Error('ILogOutputAdapter is an abstract class and cannot be instantiated directly');
    }
    this.name = name;
    this.initialized = false;
    this.config = {};
    this.buffer = [];
    this.flushTimer = null;
    this.healthStatus = 'unknown';
  }

  /**
   * 初始化适配器
   * @param {Object} config - 适配器配置
   * @returns {Promise<void>}
   */
  async initialize(config) {
    this.config = config;
    this.initialized = true;
    
    // 初始化缓冲区定时刷新
    if (config.buffer?.enabled) {
      this.flushTimer = setInterval(
        () => this.flush().catch(err => console.error(`[${this.name}] Flush error:`, err)),
        config.buffer.flushInterval || 5000
      );
    }
  }

  /**
   * 写入单条日志
   * @param {Object} logEntry - 日志条目
   * @returns {Promise<void>}
   */
  async write(logEntry) {
    throw new Error(`${this.name} must implement write()`);
  }

  /**
   * 批量写入日志
   * @param {Array} logEntries - 日志条目数组
   * @returns {Promise<void>}
   */
  async writeBatch(logEntries) {
    throw new Error(`${this.name} must implement writeBatch()`);
  }

  /**
   * 刷新缓冲区
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.buffer.length === 0) return;
    
    const entries = [...this.buffer];
    this.buffer = [];
    
    try {
      await this.writeBatch(entries);
    } catch (error) {
      // 刷新失败，重新加入缓冲区
      this.buffer.unshift(...entries);
      throw error;
    }
  }

  /**
   * 关闭适配器
   * @returns {Promise<void>}
   */
  async close() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    
    // 刷新剩余日志
    await this.flush();
    this.initialized = false;
  }

  /**
   * 健康检查
   * @returns {Promise<Object>}
   */
  async healthCheck() {
    return {
      name: this.name,
      status: this.healthStatus,
      initialized: this.initialized,
      buffered: this.buffer.length
    };
  }

  /**
   * 支持的日志级别
   * @returns {string[]}
   */
  getSupportedLevels() {
    return ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  }

  /**
   * 检查日志级别是否支持
   * @param {string} level - 日志级别
   * @returns {boolean}
   */
  isLevelSupported(level) {
    return this.getSupportedLevels().includes(level);
  }

  /**
   * 添加到缓冲区
   * @param {Object} entry - 日志条目
   */
  addToBuffer(entry) {
    if (!this.config.buffer?.enabled) {
      return false;
    }
    
    this.buffer.push(entry);
    
    // 检查是否达到缓冲区上限
    if (this.buffer.length >= (this.config.buffer.maxSize || 1000)) {
      this.flush().catch(err => console.error(`[${this.name}] Buffer overflow flush error:`, err));
    }
    
    return true;
  }

  /**
   * 格式化日志条目为标准格式
   * @param {Object} logEntry - 原始日志条目
   * @returns {Object} - 标准化日志条目
   */
  formatEntry(logEntry) {
    return {
      timestamp: logEntry.time || new Date().toISOString(),
      level: logEntry.level,
      message: logEntry.msg || logEntry.message || '',
      service: logEntry.service || logEntry.bindings?.service || 'unknown',
      context: logEntry.context || {},
      traceId: logEntry.traceId || null,
      spanId: logEntry.spanId || null,
      reqId: logEntry.reqId || null,
      ...logEntry
    };
  }
}

module.exports = ILogOutputAdapter;
