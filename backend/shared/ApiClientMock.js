// shared/ApiClientMock.js - Mock API 客户端，用于测试
'use strict';

/**
 * Mock API 客户端，用于测试
 */
class ApiClientMock {
  constructor(serviceName = 'mock-service') {
    this.serviceName = serviceName;
    this.responses = new Map();
    this.calls = [];
    this.defaultDelay = 0;
  }
  
  /**
   * 设置 mock 响应
   */
  mockResponse(method, path, response, status = 200) {
    const key = `${method.toUpperCase()}:${path}`;
    this.responses.set(key, { data: response, status });
    return this;
  }
  
  /**
   * 设置错误响应
   */
  mockError(method, path, error, status = 400) {
    const key = `${method.toUpperCase()}:${path}`;
    this.responses.set(key, { error, status });
    return this;
  }
  
  /**
   * 设置网络错误（无响应）
   */
  mockNetworkError(method, path, errorMessage = 'Network Error') {
    const key = `${method.toUpperCase()}:${path}`;
    this.responses.set(key, { networkError: true, message: errorMessage });
    return this;
  }
  
  /**
   * 设置超时错误
   */
  mockTimeout(method, path) {
    const key = `${method.toUpperCase()}:${path}`;
    this.responses.set(key, { timeout: true });
    return this;
  }
  
  /**
   * 设置默认延迟（模拟网络延迟）
   */
  setDefaultDelay(ms) {
    this.defaultDelay = ms;
    return this;
  }
  
  /**
   * 记录调用
   */
  _recordCall(method, path, options) {
    this.calls.push({
      method: method.toUpperCase(),
      path,
      options,
      timestamp: Date.now()
    });
  }
  
  /**
   * 获取调用记录
   */
  getCalls() {
    return [...this.calls];
  }
  
  /**
   * 获取最后一次调用
   */
  getLastCall() {
    return this.calls[this.calls.length - 1];
  }
  
  /**
   * 获取特定路径的调用次数
   */
  getCallCount(path, method = 'GET') {
    return this.calls.filter(
      c => c.path === path && c.method === method.toUpperCase()
    ).length;
  }
  
  /**
   * 清空调用记录
   */
  clearCalls() {
    this.calls = [];
  }
  
  /**
   * 清空所有 mock
   */
  reset() {
    this.responses.clear();
    this.calls = [];
    this.defaultDelay = 0;
  }
  
  /**
   * 延迟
   */
  async _delay() {
    if (this.defaultDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.defaultDelay));
    }
  }
  
  /**
   * GET
   */
  async get(path, params = {}, options = {}) {
    return this._mockRequest('GET', path, { ...options, params });
  }
  
  /**
   * POST
   */
  async post(path, data = {}, options = {}) {
    return this._mockRequest('POST', path, { ...options, data });
  }
  
  /**
   * PUT
   */
  async put(path, data = {}, options = {}) {
    return this._mockRequest('PUT', path, { ...options, data });
  }
  
  /**
   * DELETE
   */
  async delete(path, options = {}) {
    return this._mockRequest('DELETE', path, options);
  }
  
  /**
   * PATCH
   */
  async patch(path, data = {}, options = {}) {
    return this._mockRequest('PATCH', path, { ...options, data });
  }
  
  /**
   * 模拟请求
   */
  async _mockRequest(method, path, options) {
    await this._delay();
    
    this._recordCall(method, path, options);
    
    const key = `${method.toUpperCase()}:${path}`;
    const mock = this.responses.get(key);
    
    if (!mock) {
      const error = new Error(`No mock set for ${key}`);
      error.code = 'NO_MOCK';
      error.service = this.serviceName;
      throw error;
    }
    
    if (mock.networkError) {
      const error = new Error(mock.message);
      error.code = 'NETWORK_ERROR';
      error.service = this.serviceName;
      throw error;
    }
    
    if (mock.timeout) {
      const error = new Error('timeout of 10000ms exceeded');
      error.code = 'ECONNABORTED';
      error.service = this.serviceName;
      throw error;
    }
    
    if (mock.error) {
      const error = new Error(mock.error.message || 'Mock error');
      error.status = mock.status;
      error.data = mock.error;
      error.service = this.serviceName;
      error.isApiClientError = true;
      throw error;
    }
    
    return mock.data;
  }
  
  /**
   * 健康检查
   */
  async healthCheck() {
    const mock = this.responses.get('GET:/health');
    if (mock) {
      return { healthy: true, data: mock.data };
    }
    return { healthy: true, data: { status: 'ok' } };
  }
  
  /**
   * 获取熔断器状态（mock 总是返回 closed）
   */
  getCircuitBreakerState() {
    return 'closed';
  }
}

/**
 * 创建 mock 客户端
 */
function createMockClient(serviceName = 'mock-service') {
  return new ApiClientMock(serviceName);
}

/**
 * 创建预配置的 mock 客户端集合
 */
function createMockServiceClients() {
  return {
    userService: createMockClient('user-service'),
    pokemonService: createMockClient('pokemon-service'),
    catchService: createMockClient('catch-service'),
    locationService: createMockClient('location-service'),
    gymService: createMockClient('gym-service'),
    socialService: createMockClient('social-service'),
    rewardService: createMockClient('reward-service'),
    paymentService: createMockClient('payment-service'),
    gateway: createMockClient('gateway')
  };
}

module.exports = {
  ApiClientMock,
  createMockClient,
  createMockServiceClients
};
