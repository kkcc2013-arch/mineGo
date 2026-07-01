// frontend/game-client/src/api/RetryableClient.js
// REQ-00402: 客户端重试 SDK

'use strict';

/**
 * 可重试的 API 客户端
 */
class RetryableClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl;
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelay = options.initialDelay ?? 100;
    this.maxDelay = options.maxDelay ?? 10000;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.timeout = options.timeout ?? 30000;

    this.pendingRequests = new Map();
    this.eventListeners = new Map();
  }

  /**
   * 发送带重试的请求
   */
  async request(method, path, data = null, options = {}) {
    const requestId = `${method}:${path}:${Date.now()}`;
    const controller = new AbortController();

    this.pendingRequests.set(requestId, controller);

    try {
      const result = await this.executeWithRetry(
        () => this.doRequest(method, path, data, controller.signal, options),
        { ...options, requestId }
      );

      return result;
    } finally {
      this.pendingRequests.delete(requestId);
    }
  }

  /**
   * 执行带重试的操作
   */
  async executeWithRetry(operation, context) {
    let attempt = 0;
    let lastError = null;
    let totalDuration = 0;

    while (attempt <= this.maxRetries) {
      attempt++;
      const startTime = Date.now();

      try {
        const result = await operation();

        totalDuration += Date.now() - startTime;

        // 发送成功事件
        this.emit('success', {
          attempt,
          totalDuration
        });

        return result;

      } catch (error) {
        lastError = error;
        totalDuration += Date.now() - startTime;

        // 发送错误事件
        this.emit('error', {
          attempt,
          error,
          totalDuration
        });

        // 检查是否可重试
        if (!this.isRetryable(error)) {
          throw error;
        }

        // 检查是否达到最大重试次数
        if (attempt > this.maxRetries) {
          this.emit('maxRetriesExceeded', {
            attempts: attempt,
            error,
            totalDuration
          });
          throw error;
        }

        // 计算延迟
        const delay = this.calculateDelay(attempt, error);

        // 发送重试事件
        this.emit('retry', {
          attempt,
          delay,
          error,
          totalDuration
        });

        // 等待
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * 执行 HTTP 请求
   */
  async doRequest(method, path, data, signal, options = {}) {
    const url = `${this.baseUrl}${path}`;

    const fetchOptions = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...options.headers
      },
      signal
    };

    if (data && method !== 'GET') {
      fetchOptions.body = JSON.stringify(data);
    }

    // 添加认证头
    const token = this.getAuthToken();
    if (token) {
      fetchOptions.headers['Authorization'] = `Bearer ${token}`;
    }

    // 添加请求 ID
    fetchOptions.headers['X-Request-ID'] = this.generateRequestId();

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
      error.status = response.status;
      error.headers = {};
      for (const [key, value] of response.headers.entries()) {
        error.headers[key] = value;
      }
      throw error;
    }

    // 解析响应
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return response.json();
    }
    return response.text();
  }

  /**
   * 检查错误是否可重试
   */
  isRetryable(error) {
    // 网络错误（TypeError）
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      return true;
    }

    // 网络错误代码
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error.code)) {
      return true;
    }

    // HTTP 状态码
    if (error.status) {
      const retryableCodes = [408, 429, 500, 502, 503, 504];
      return retryableCodes.includes(error.status);
    }

    return false;
  }

  /**
   * 计算退避延迟
   */
  calculateDelay(attempt, error) {
    // 使用 Retry-After 头
    if (error.status === 429 && error.headers?.['retry-after']) {
      const retryAfter = parseInt(error.headers['retry-after'], 10);
      if (!isNaN(retryAfter)) {
        return retryAfter * 1000;
      }
    }

    // 指数退避 + 抖动
    const baseDelay = this.initialDelay * Math.pow(this.backoffFactor, attempt - 1);
    const cappedDelay = Math.min(baseDelay, this.maxDelay);

    // 添加随机抖动（50% - 100%）
    const jitter = cappedDelay * (0.5 + Math.random() * 0.5);

    return jitter;
  }

  /**
   * 休眠指定时间
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取认证令牌
   */
  getAuthToken() {
    return localStorage.getItem('auth_token');
  }

  /**
   * 生成请求 ID
   */
  generateRequestId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 快捷方法
   */
  async get(path, options = {}) {
    return this.request('GET', path, null, options);
  }

  async post(path, data, options = {}) {
    return this.request('POST', path, data, options);
  }

  async put(path, data, options = {}) {
    return this.request('PUT', path, data, options);
  }

  async delete(path, options = {}) {
    return this.request('DELETE', path, null, options);
  }

  /**
   * 取消所有进行中的请求
   */
  cancelAll() {
    this.pendingRequests.forEach((controller, requestId) => {
      controller.abort();
      this.emit('cancelled', { requestId });
    });
    this.pendingRequests.clear();
  }

  /**
   * 事件监听
   */
  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(callback);
  }

  off(event, callback) {
    if (!this.eventListeners.has(event)) return;

    const listeners = this.eventListeners.get(event);
    const index = listeners.indexOf(callback);
    if (index > -1) {
      listeners.splice(index, 1);
    }
  }

  emit(event, data) {
    if (!this.eventListeners.has(event)) return;

    for (const callback of this.eventListeners.get(event)) {
      try {
        callback(data);
      } catch (err) {
        console.error('Event listener error:', err);
      }
    }
  }
}

/**
 * 创建默认客户端实例
 */
function createDefaultClient(baseUrl) {
  const client = new RetryableClient(baseUrl, {
    maxRetries: 3,
    initialDelay: 100,
    maxDelay: 10000,
    backoffFactor: 2,
    timeout: 30000
  });

  // 添加默认事件监听器
  client.on('retry', (data) => {
    console.log(`[Retry] Attempt ${data.attempt} after ${data.delay}ms`);
  });

  client.on('maxRetriesExceeded', (data) => {
    console.error(`[Retry] Max retries exceeded after ${data.attempts} attempts`);
  });

  return client;
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RetryableClient, createDefaultClient };
} else {
  window.RetryableClient = RetryableClient;
  window.createDefaultClient = createDefaultClient;
}
