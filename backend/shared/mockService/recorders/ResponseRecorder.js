// mockService/recorders/ResponseRecorder.js - 响应录制器
'use strict';

/**
 * REQ-00546: API Mock 服务与测试隔离系统
 * 
 * ResponseRecorder - 记录真实服务响应用于回放
 * 
 * 特性：
 * - 请求-响应录制
 * - 智能过滤敏感数据
 * - 自动去重
 * - 压缩存储
 * - 回放支持
 */

const fs = require('fs').promises;
const path = require('path');
const { createLogger } = require('../../logger');
const crypto = require('crypto');

const logger = createLogger('response-recorder');

/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
  enabled: process.env.MOCK_RECORD === 'true',
  outputPath: process.env.MOCK_RECORD_PATH || './mock-recordings',
  maxRecords: parseInt(process.env.MOCK_MAX_RECORDS) || 10000,
  flushInterval: parseInt(process.env.MOCK_FLUSH_INTERVAL) || 60000,
  compress: true,
  filterSensitive: true,
  sensitiveFields: ['password', 'token', 'secret', 'api_key', 'authorization']
};

/**
 * 录制记录结构
 */
class Recording {
  constructor(request, response, duration) {
    this.id = crypto.createHash('sha256')
      .update(`${request.method}:${request.path}:${JSON.stringify(request.query)}`)
      .digest('hex')
      .slice(0, 16);
    
    this.request = {
      method: request.method,
      path: request.path,
      query: request.query || {},
      headers: this._filterHeaders(request.headers),
      body: this._sanitizeBody(request.body)
    };
    
    this.response = {
      status: response.status,
      headers: response.headers || {},
      body: this._sanitizeBody(response.body)
    };
    
    this.duration = duration;
    this.timestamp = new Date().toISOString();
    this.hash = this._calculateHash();
  }

  /**
   * 过滤敏感头部
   */
  _filterHeaders(headers) {
    if (!headers) return {};
    
    const filtered = {};
    const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key'];
    
    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        filtered[key] = '[REDACTED]';
      } else {
        filtered[key] = value;
      }
    }
    
    return filtered;
  }

  /**
   * 清理敏感数据
   */
  _sanitizeBody(body) {
    if (!body) return body;
    
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return body;
      }
    }
    
    if (typeof body === 'object') {
      return this._sanitizeObject(body);
    }
    
    return body;
  }

  /**
   * 递归清理对象
   */
  _sanitizeObject(obj) {
    const sensitiveFields = ['password', 'token', 'secret', 'api_key', 'authorization', 'credit_card'];
    
    const sanitize = (o) => {
      if (Array.isArray(o)) {
        return o.map(item => sanitize(item));
      }
      
      if (o && typeof o === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(o)) {
          if (sensitiveFields.some(field => key.toLowerCase().includes(field))) {
            result[key] = '[REDACTED]';
          } else if (value && typeof value === 'object') {
            result[key] = sanitize(value);
          } else {
            result[key] = value;
          }
        }
        return result;
      }
      
      return o;
    };
    
    return sanitize(obj);
  }

  /**
   * 计算哈希值（用于去重）
   */
  _calculateHash() {
    const content = JSON.stringify({
      method: this.request.method,
      path: this.request.path,
      query: this.request.query,
      body: this.request.body,
      responseStatus: this.response.status
    });
    
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * 匹配请求
   */
  matches(method, path, query = {}) {
    return this.request.method === method &&
           this.request.path === path &&
           this._matchQuery(query);
  }

  /**
   * 匹配查询参数
   */
  _matchQuery(query) {
    const keys1 = Object.keys(this.request.query);
    const keys2 = Object.keys(query);
    
    if (keys1.length !== keys2.length) return false;
    
    for (const key of keys1) {
      if (this.request.query[key] !== query[key]) {
        return false;
      }
    }
    
    return true;
  }
}

/**
 * 响应录制器
 */
class ResponseRecorder {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.recordings = [];
    this.recordingsByHash = new Map();
    this.isFlushing = false;
    this.flushTimer = null;
    this.stats = {
      recorded: 0,
      duplicates: 0,
      filtered: 0,
      flushed: 0,
      errors: 0
    };
    
    if (this.config.enabled) {
      this._startFlushTimer();
    }
    
    logger.info({ config: this.config }, 'ResponseRecorder initialized');
  }

  /**
   * 录制请求-响应对
   */
  record(request, response, duration) {
    if (!this.config.enabled) {
      return null;
    }
    
    try {
      const recording = new Recording(request, response, duration);
      
      // 检查是否已存在
      if (this.recordingsByHash.has(recording.hash)) {
        this.stats.duplicates++;
        logger.debug({ hash: recording.hash }, 'Duplicate recording skipped');
        return null;
      }
      
      // 检查是否达到最大数量
      if (this.recordings.length >= this.config.maxRecords) {
        logger.warn('Maximum recordings reached, skipping');
        return null;
      }
      
      this.recordings.push(recording);
      this.recordingsByHash.set(recording.hash, recording);
      this.stats.recorded++;
      
      logger.debug({
        id: recording.id,
        method: recording.request.method,
        path: recording.request.path
      }, 'Recording added');
      
      return recording;
      
    } catch (error) {
      this.stats.errors++;
      logger.error({ error: error.message }, 'Failed to record response');
      return null;
    }
  }

  /**
   * 查找匹配的录制
   */
  find(method, path, query = {}) {
    return this.recordings.find(r => r.matches(method, path, query));
  }

  /**
   * 查找所有匹配的录制
   */
  findAll(method, path) {
    return this.recordings.filter(r => 
      r.request.method === method && 
      r.request.path === path
    );
  }

  /**
   * 启动定时刷新
   */
  _startFlushTimer() {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.config.flushInterval);
    
    logger.info({ interval: this.config.flushInterval }, 'Flush timer started');
  }

  /**
   * 停止定时刷新
   */
  _stopFlushTimer() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * 刷新录制到磁盘
   */
  async flush() {
    if (this.isFlushing || this.recordings.length === 0) {
      return;
    }
    
    this.isFlushing = true;
    
    try {
      // 创建输出目录
      await fs.mkdir(this.config.outputPath, { recursive: true });
      
      // 生成文件名
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `recordings-${timestamp}.json`;
      const filepath = path.join(this.config.outputPath, filename);
      
      // 准备数据
      const data = {
        version: '1.0',
        timestamp: new Date().toISOString(),
        count: this.recordings.length,
        recordings: this.recordings.map(r => ({
          id: r.id,
          request: r.request,
          response: r.response,
          duration: r.duration,
          timestamp: r.timestamp,
          hash: r.hash
        }))
      };
      
      // 写入文件
      const content = this.config.compress 
        ? JSON.stringify(data) 
        : JSON.stringify(data, null, 2);
      
      await fs.writeFile(filepath, content, 'utf8');
      
      this.stats.flushed++;
      
      logger.info({
        path: filepath,
        count: this.recordings.length
      }, 'Recordings flushed to disk');
      
      // 清空内存中的录制
      this.recordings = [];
      this.recordingsByHash.clear();
      
    } catch (error) {
      this.stats.errors++;
      logger.error({ error: error.message }, 'Failed to flush recordings');
      throw error;
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * 从磁盘加载录制
   */
  async load(filepath) {
    try {
      const content = await fs.readFile(filepath, 'utf8');
      const data = JSON.parse(content);
      
      if (data.version !== '1.0') {
        throw new Error('Unsupported recording version');
      }
      
      const loaded = [];
      
      for (const item of data.recordings) {
        const recording = Object.assign(new Recording({}, {}, 0), {
          id: item.id,
          request: item.request,
          response: item.response,
          duration: item.duration,
          timestamp: item.timestamp,
          hash: item.hash
        });
        
        if (!this.recordingsByHash.has(recording.hash)) {
          this.recordings.push(recording);
          this.recordingsByHash.set(recording.hash, recording);
          loaded.push(recording);
        }
      }
      
      logger.info({
        path: filepath,
        loaded: loaded.length,
        total: this.recordings.length
      }, 'Recordings loaded from disk');
      
      return loaded;
      
    } catch (error) {
      logger.error({ error: error.message, path: filepath }, 'Failed to load recordings');
      throw error;
    }
  }

  /**
   * 导出录制
   */
  export() {
    return {
      version: '1.0',
      exported: new Date().toISOString(),
      count: this.recordings.length,
      recordings: this.recordings.map(r => ({
        id: r.id,
        request: r.request,
        response: r.response,
        duration: r.duration,
        timestamp: r.timestamp
      }))
    };
  }

  /**
   * 清空所有录制
   */
  clear() {
    const count = this.recordings.length;
    this.recordings = [];
    this.recordingsByHash.clear();
    
    logger.info({ cleared: count }, 'All recordings cleared');
    
    return count;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      currentCount: this.recordings.length,
      maxRecords: this.config.maxRecords,
      config: this.config
    };
  }

  /**
   * 关闭录制器
   */
  async close() {
    this._stopFlushTimer();
    
    if (this.recordings.length > 0) {
      await this.flush();
    }
    
    logger.info('ResponseRecorder closed');
  }
}

module.exports = ResponseRecorder;