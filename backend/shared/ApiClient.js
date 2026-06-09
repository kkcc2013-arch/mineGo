// shared/ApiClient.js - 统一 API 客户端 SDK
'use strict';

const axios = require('axios');
const { createLogger } = require('./logger');
const { getTracer } = require('./tracing');
const { context, trace, SpanStatusCode } = require('@opentelemetry/api');
const { CircuitBreaker } = require('./CircuitBreaker');

// Prometheus metrics from shared/metrics.js
const { registerCounter, registerHistogram } = require('./metrics');

/**
 * 默认配置
 */
const DEFAULT_CONFIG = {
  timeout: 10000,
  retries: 3,
  retryDelay: 1000,
  retryBackoff: 2,
  enableTracing: true,
  circuitBreaker: {
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 30000,
    halfOpenMaxCalls: 3
  },
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
};

// 注册 Prometheus 指标
let apiClientRequestsTotal;
let apiClientRequestDuration;
let apiClientRetriesTotal;
let apiClientCircuitBreakerState;

function initMetrics() {
  if (!apiClientRequestsTotal) {
    apiClientRequestsTotal = registerCounter(
      'api_client_requests_total',
      'Total API client requests',
      ['service', 'target_service', 'method', 'status']
    );
  }
  if (!apiClientRequestDuration) {
    apiClientRequestDuration = registerHistogram(
      'api_client_request_duration_seconds',
      'API client request duration in seconds',
      ['service', 'target_service', 'method'],
      [0.001, 0.005, 0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10]
    );
  }
  if (!apiClientRetriesTotal) {
    apiClientRetriesTotal = registerCounter(
      'api_client_retries_total',
      'Total API client retries',
      ['service', 'target_service', 'method']
    );
  }
  if (!apiClientCircuitBreakerState) {
    apiClientCircuitBreakerState = registerCounter(
      'api_client_circuit_breaker_state_changes',
      'Circuit breaker state changes',
      ['service', 'target_service', 'state']
    );
  }
}

/**
 * 生成请求 ID
 */
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 统一 API 客户端类
 */
class ApiClient {
  /**
   * @param {string} serviceName - 目标服务名称
   * @param {string} baseUrl - 基础 URL
   * @param {Object} config - 配置选项
   */
  constructor(serviceName, baseUrl, config = {}) {
    initMetrics();
    
    this.serviceName = serviceName;
    this.baseUrl = baseUrl;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = createLogger(`api-client:${serviceName}`);
    
    // 创建 axios 实例
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: this.config.timeout,
      headers: this.config.headers
    });
    
    // 熔断器
    this.circuitBreaker = new CircuitBreaker(`${serviceName}-api`, {
      failureThreshold: this.config.circuitBreaker.failureThreshold,
      successThreshold: this.config.circuitBreaker.successThreshold,
      timeout: this.config.circuitBreaker.timeout,
      halfOpenMaxCalls: this.config.circuitBreaker.halfOpenMaxCalls
    });
    
    // 请求拦截器
    this.client.interceptors.request.use(
      this._onRequest.bind(this),
      this._onRequestError.bind(this)
    );
    
    // 响应拦截器
    this.client.interceptors.response.use(
      this._onResponse.bind(this),
      this._onResponseError.bind(this)
    );
  }

  /**
   * 请求拦截器
   */
  _onRequest(config) {
    const startTime = Date.now();
    const requestId = config.headers['X-Request-Id'] || generateRequestId();
    
    // 添加元数据
    config.metadata = { startTime, requestId };
    
    // 设置请求 ID
    config.headers['X-Request-Id'] = requestId;
    
    // 链路追踪
    if (this.config.enableTracing) {
      const tracer = getTracer('mineGo-api-client');
      const currentSpan = trace.getSpan(context.active());
      
      if (currentSpan) {
        // 注入 trace context
        const ctx = currentSpan.context();
        config.headers['X-Trace-Id'] = ctx.traceId;
        config.headers['X-Span-Id'] = ctx.spanId;
      }
    }
    
    this.logger.debug('API request', {
      target_service: this.serviceName,
      method: config.method?.toUpperCase(),
      url: config.url,
      requestId
    });
    
    return config;
  }

  /**
   * 请求错误拦截器
   */
  _onRequestError(error) {
    this.logger.error('API request setup error', {
      target_service: this.serviceName,
      error: error.message
    });
    return Promise.reject(error);
  }

  /**
   * 响应拦截器
   */
  _onResponse(response) {
    const { config } = response;
    const duration = (Date.now() - config.metadata.startTime) / 1000;
    const sourceService = process.env.SERVICE_NAME || 'unknown';
    
    // 记录 Prometheus 指标
    if (apiClientRequestsTotal) {
      apiClientRequestsTotal.inc({
        service: sourceService,
        target_service: this.serviceName,
        method: config.method?.toUpperCase(),
        status: response.status
      });
    }
    
    if (apiClientRequestDuration) {
      apiClientRequestDuration.observe(
        {
          service: sourceService,
          target_service: this.serviceName,
          method: config.method?.toUpperCase()
        },
        duration
      );
    }
    
    this.logger.debug('API response', {
      target_service: this.serviceName,
      method: config.method?.toUpperCase(),
      url: config.url,
      status: response.status,
      duration: `${duration.toFixed(3)}s`,
      requestId: config.metadata.requestId
    });
    
    return response;
  }

  /**
   * 响应错误拦截器
   */
  async _onResponseError(error) {
    const { config } = error;
    const duration = (Date.now() - config.metadata?.startTime || Date.now()) / 1000;
    const sourceService = process.env.SERVICE_NAME || 'unknown';
    
    // 记录错误指标
    if (apiClientRequestsTotal) {
      apiClientRequestsTotal.inc({
        service: sourceService,
        target_service: this.serviceName,
        method: config?.method?.toUpperCase() || 'UNKNOWN',
        status: error.response?.status || 'error'
      });
    }
    
    // 判断是否可重试
    const retryCount = config.__retryCount || 0;
    if (this._shouldRetry(error) && retryCount < this.config.retries) {
      config.__retryCount = retryCount + 1;
      
      if (apiClientRetriesTotal) {
        apiClientRetriesTotal.inc({
          service: sourceService,
          target_service: this.serviceName,
          method: config?.method?.toUpperCase() || 'UNKNOWN'
        });
      }
      
      const delay = this.config.retryDelay * Math.pow(this.config.retryBackoff, retryCount);
      
      this.logger.warn('API request retry', {
        target_service: this.serviceName,
        url: config?.url,
        retryCount: config.__retryCount,
        delay,
        error: error.message
      });
      
      await sleep(delay);
      return this.client.request(config);
    }
    
    // 记录错误日志
    this.logger.error('API request failed', {
      target_service: this.serviceName,
      method: config?.method?.toUpperCase(),
      url: config?.url,
      status: error.response?.status,
      error: error.message,
      requestId: config?.metadata?.requestId
    });
    
    return Promise.reject(this._normalizeError(error));
  }

  /**
   * 判断是否应该重试
   */
  _shouldRetry(error) {
    // 网络错误或超时
    if (!error.response) return true;
    
    // 5xx 错误
    const status = error.response.status;
    if (status >= 500 && status < 600) return true;
    
    // 429 Too Many Requests
    if (status === 429) return true;
    
    // 408 Request Timeout
    if (status === 408) return true;
    
    return false;
  }

  /**
   * 规范化错误
   */
  _normalizeError(error) {
    const normalized = new Error(error.message);
    normalized.code = error.code || 'API_ERROR';
    normalized.status = error.response?.status;
    normalized.data = error.response?.data;
    normalized.service = this.serviceName;
    normalized.requestId = error.config?.metadata?.requestId;
    normalized.isApiClientError = true;
    
    return normalized;
  }

  /**
   * 带熔断保护的执行
   */
  async _executeWithCircuitBreaker(method, path, options) {
    return this.circuitBreaker.execute(async () => {
      const response = await this.client.request({
        method,
        url: path,
        ...options
      });
      return response.data;
    });
  }

  /**
   * GET 请求
   */
  async get(path, params = {}, options = {}) {
    return this._executeWithCircuitBreaker('GET', path, { ...options, params });
  }

  /**
   * POST 请求
   */
  async post(path, data = {}, options = {}) {
    return this._executeWithCircuitBreaker('POST', path, { ...options, data });
  }

  /**
   * PUT 请求
   */
  async put(path, data = {}, options = {}) {
    return this._executeWithCircuitBreaker('PUT', path, { ...options, data });
  }

  /**
   * DELETE 请求
   */
  async delete(path, options = {}) {
    return this._executeWithCircuitBreaker('DELETE', path, options);
  }

  /**
   * PATCH 请求
   */
  async patch(path, data = {}, options = {}) {
    return this._executeWithCircuitBreaker('PATCH', path, { ...options, data });
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    try {
      const response = await this.get('/health', {}, { timeout: 5000 });
      return { healthy: true, data: response };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }

  /**
   * 获取熔断器状态
   */
  getCircuitBreakerState() {
    return this.circuitBreaker.getState();
  }
}

/**
 * API 客户端工厂
 */
class ApiClientFactory {
  constructor() {
    this.clients = new Map();
  }
  
  /**
   * 获取或创建客户端
   */
  getClient(serviceName, baseUrl, config = {}) {
    const key = `${serviceName}:${baseUrl}`;
    
    if (!this.clients.has(key)) {
      this.clients.set(key, new ApiClient(serviceName, baseUrl, config));
    }
    
    return this.clients.get(key);
  }
  
  /**
   * 创建服务间调用客户端
   */
  createServiceClient(targetService, config = {}) {
    const envKey = `${targetService.toUpperCase().replace(/-/g, '_')}_URL`;
    const baseUrl = process.env[envKey] || `http://${targetService}`;
    
    return this.getClient(targetService, baseUrl, {
      ...config,
      headers: {
        ...config.headers,
        'X-Source-Service': process.env.SERVICE_NAME || 'unknown'
      }
    });
  }
  
  /**
   * 清除所有客户端
   */
  clearAll() {
    this.clients.clear();
  }
  
  /**
   * 获取所有客户端
   */
  getAllClients() {
    return Array.from(this.clients.entries()).map(([key, client]) => ({
      key,
      serviceName: client.serviceName,
      baseUrl: client.baseUrl,
      circuitBreakerState: client.getCircuitBreakerState()
    }));
  }
}

// 单例工厂
const factory = new ApiClientFactory();

/**
 * 预定义服务客户端
 */
const serviceClients = {
  get userService() {
    return factory.createServiceClient('user-service');
  },
  
  get pokemonService() {
    return factory.createServiceClient('pokemon-service');
  },
  
  get catchService() {
    return factory.createServiceClient('catch-service');
  },
  
  get locationService() {
    return factory.createServiceClient('location-service');
  },
  
  get gymService() {
    return factory.createServiceClient('gym-service');
  },
  
  get socialService() {
    return factory.createServiceClient('social-service');
  },
  
  get rewardService() {
    return factory.createServiceClient('reward-service');
  },
  
  get paymentService() {
    return factory.createServiceClient('payment-service');
  },
  
  get gateway() {
    return factory.createServiceClient('gateway');
  }
};

module.exports = {
  ApiClient,
  ApiClientFactory,
  serviceClients,
  factory,
  DEFAULT_CONFIG
};
