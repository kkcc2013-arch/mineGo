/**
 * HTTP 协议适配器
 * 基于 axios 实现的 HTTP/REST 协议适配器
 */

const ProtocolAdapter = require('../ProtocolAdapter');
const axios = require('axios');
const logger = require('../logger');

class HttpAdapter extends ProtocolAdapter {
  constructor(config) {
    super({ protocol: 'http', ...config });
    this.httpClient = null;
    this.defaultTimeout = config.timeout || 10000;
    this.retryCount = config.retryCount || 3;
    this.retryDelay = config.retryDelay || 1000;
  }

  /**
   * 初始化 HTTP 客户端
   */
  async connect() {
    this.httpClient = axios.create({
      timeout: this.defaultTimeout,
      maxRedirects: 3,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'mineGo-Service/1.0'
      }
    });

    // 请求拦截器
    this.httpClient.interceptors.request.use(
      (config) => {
        config.metadata = { startTime: Date.now() };
        return config;
      },
      (error) => Promise.reject(error)
    );

    // 响应拦截器
    this.httpClient.interceptors.response.use(
      (response) => {
        const duration = Date.now() - response.config.metadata.startTime;
        logger.debug('HTTP request completed', {
          url: response.config.url,
          method: response.config.method,
          status: response.status,
          duration
        });
        return response;
      },
      (error) => {
        if (error.config?.metadata) {
          const duration = Date.now() - error.config.metadata.startTime;
          logger.error('HTTP request failed', {
            url: error.config?.url,
            method: error.config?.method,
            message: error.message,
            duration
          });
        }
        return Promise.reject(error);
      }
    );

    this.isConnected = true;
    logger.info('HTTP adapter connected', { 
      timeout: this.defaultTimeout,
      retryCount: this.retryCount 
    });
  }

  /**
   * 发送 HTTP 请求
   */
  async send(request) {
    const startTime = Date.now();
    const { service, method, data, options = {} } = request;

    let lastError;
    const maxRetries = options.retryCount ?? this.retryCount;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const baseUrl = options.baseUrl || this.config.baseUrl || 'http://localhost';
        const url = `${baseUrl}/${service}/${method}`;

        const response = await this.httpClient.request({
          method: options.httpMethod || 'POST',
          url,
          data,
          headers: options.headers,
          params: options.query,
          timeout: options.timeout || this.defaultTimeout
        });

        const duration = Date.now() - startTime;
        this.recordMetrics(service, method, duration, true);

        return response.data;
      } catch (error) {
        lastError = error;
        
        // 可重试的错误
        if (this.isRetryableError(error) && attempt < maxRetries) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          logger.warn(`HTTP request failed, retrying (${attempt}/${maxRetries})`, {
            service,
            method,
            error: error.message,
            retryDelay: delay
          });
          await this.sleep(delay);
          continue;
        }

        const duration = Date.now() - startTime;
        this.recordMetrics(service, method, duration, false);

        logger.error('HTTP request failed', {
          service,
          method,
          error: error.message,
          code: error.code,
          status: error.response?.status,
          attempts: attempt
        });

        throw this.normalizeError(error, service, method);
      }
    }

    throw lastError;
  }

  /**
   * 批量发送请求
   */
  async sendBatch(requests) {
    const results = await Promise.allSettled(
      requests.map(req => this.send(req))
    );

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return { success: true, data: result.value, index };
      }
      return { success: false, error: result.reason, index };
    });
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    try {
      const healthUrl = this.config.healthUrl || `${this.config.baseUrl}/health`;
      const response = await this.httpClient.get(healthUrl, { timeout: 5000 });
      return { 
        healthy: response.status === 200,
        latency: response.config?.metadata?.startTime 
          ? Date.now() - response.config.metadata.startTime 
          : 0
      };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }

  /**
   * 断开连接
   */
  async disconnect() {
    this.isConnected = false;
    logger.info('HTTP adapter disconnected');
  }

  /**
   * 判断是否可重试错误
   */
  isRetryableError(error) {
    // 网络错误、超时、5xx 错误可重试
    if (error.code === 'ECONNRESET' || 
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND') {
      return true;
    }
    
    if (error.response) {
      const status = error.response.status;
      return status >= 500 || status === 429;
    }
    
    return false;
  }

  /**
   * 标准化错误
   */
  normalizeError(error, service, method) {
    const normalized = new Error(error.message);
    normalized.code = error.code || 'HTTP_ERROR';
    normalized.service = service;
    normalized.method = method;
    normalized.status = error.response?.status;
    normalized.data = error.response?.data;
    return normalized;
  }

  /**
   * 辅助：睡眠
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = HttpAdapter;