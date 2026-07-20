// backend/shared/ServiceClient.js
// REQ-00607: 统一服务间调用客户端

const logger = require('./logger');
const { metrics } = require('./metrics');
const axios = require('axios');
const { getRedis } = require('./redis');
const { ServiceDiscoveryClient } = require('./serviceDiscovery/ServiceDiscoveryClient');
const { getServiceMockRegistry } = require('./mock/ServiceMockRegistry');

/**
 * 服务调用客户端配置
 */
const DEFAULT_CONFIG = {
  timeout: 5000, // 默认超时 5 秒
  maxRetries: 3,
  retryDelay: 1000,
  retryBackoff: 'exponential', // linear, exponential
  enableCircuitBreaker: true,
  enableTracing: true,
  enableAuth: true,
  serviceToken: process.env.SERVICE_TOKEN || null
};

/**
 * 服务调用客户端
 */
class ServiceClient {
  constructor(options = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options };
    this.serviceName = options.serviceName || process.env.SERVICE_NAME || 'unknown';
    this.discoveryClient = options.discoveryClient || new ServiceDiscoveryClient();
    this.redisClient = options.redisClient || getRedis();
    this.mockRegistry = options.mockRegistry || getServiceMockRegistry();
    this.enableMock = options.enableMock !== false && process.env.ENABLE_SERVICE_MOCK === 'true';
    
    // HTTP 客户端
    this.httpClient = axios.create({
      timeout: this.config.timeout,
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    // 请求追踪
    this.traceIdHeader = 'x-trace-id';
    this.spanIdHeader = 'x-span-id';
    
    // 指标
    this.initMetrics();
  }
  
  /**
   * 初始化 Prometheus 指标
   */
  initMetrics() {
    this.metrics = {
      serviceCallsTotal: new metrics.Counter({
        name: 'minego_service_client_calls_total',
        help: 'Total service-to-service calls',
        labelNames: ['from_service', 'to_service', 'method', 'status']
      }),
      
      serviceCallDuration: new metrics.Histogram({
        name: 'minego_service_call_duration_seconds',
        help: 'Service call duration',
        labelNames: ['from_service', 'to_service', 'method'],
        buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10]
      }),
      
      serviceCallRetries: new metrics.Counter({
        name: 'minego_service_call_retries_total',
        help: 'Service call retries',
        labelNames: ['from_service', 'to_service', 'method']
      }),
      
      serviceCallErrors: new metrics.Counter({
        name: 'minego_service_call_errors_total',
        help: 'Service call errors',
        labelNames: ['from_service', 'to_service', 'method', 'error_type']
      })
    };
  }
  
  /**
   * 调用远程服务
   */
  async call(serviceName, method, path, data = null, options = {}) {
    const start = Date.now();
    const timeout = options.timeout || this.config.timeout;
    const maxRetries = options.maxRetries || this.config.maxRetries;
    
    // 检查是否启用 Mock
    if (this.enableMock && this.mockRegistry.isEnabled(serviceName, path)) {
      logger.debug({ serviceName, path }, 'Using mock response');
      
      try {
        const mockResponse = await this.mockRegistry.getMock(serviceName, path, { data, options });
        this.recordMetrics(serviceName, method, 'success', start);
        return mockResponse.data;
      } catch (error) {
        this.recordMetrics(serviceName, method, 'error', start);
        throw error;
      }
    }
    
    let attempt = 0;
    let lastError = null;
    
    while (attempt <= maxRetries) {
      attempt++;
      
      try {
        // 发现服务实例
        const { selected, instances } = await this.discoveryClient.discover(serviceName, {
          strategy: options.loadBalanceStrategy
        });
        
        if (!selected) {
          throw new Error(`No available instances for service: ${serviceName}`);
        }
        
        // 构建请求 URL
        const url = `http://${selected.host}:${selected.port}${path}`;
        
        // 构建请求头
        const headers = this.buildHeaders(options);
        
        // 熔断器检查
        if (this.config.enableCircuitBreaker) {
          const breaker = this.discoveryClient.getCircuitBreaker(selected.instanceId);
          if (!breaker.canRequest()) {
            throw new Error(`Circuit breaker open for instance: ${selected.instanceId}`);
          }
        }
        
        // 发送请求
        const response = await this.httpClient.request({
          method,
          url,
          data,
          headers,
          timeout,
          validateStatus: (status) => status < 500 // 4xx 不重试
        });
        
        // 标记成功
        this.discoveryClient.markSuccess(selected.instanceId);
        
        if (this.config.enableCircuitBreaker) {
          const breaker = this.discoveryClient.getCircuitBreaker(selected.instanceId);
          breaker.recordSuccess();
        }
        
        // 记录指标
        this.recordMetrics(serviceName, method, 'success', start);
        
        logger.debug({
          from: this.serviceName,
          to: serviceName,
          method,
          path,
          instanceId: selected.instanceId,
          status: response.status,
          duration: Date.now() - start
        }, 'Service call successful');
        
        return response.data;
        
      } catch (error) {
        lastError = error;
        
        // 标记失败
        if (error.selected) {
          this.discoveryClient.markFailure(error.selected.instanceId);
          
          if (this.config.enableCircuitBreaker) {
            const breaker = this.discoveryClient.getCircuitBreaker(error.selected.instanceId);
            breaker.recordFailure();
          }
        }
        
        // 判断是否重试
        if (attempt <= maxRetries && this.shouldRetry(error)) {
          const delay = this.getRetryDelay(attempt);
          
          logger.warn({
            from: this.serviceName,
            to: serviceName,
            method,
            path,
            attempt,
            error: error.message,
            retryIn: delay
          }, 'Service call failed, retrying');
          
          this.metrics.serviceCallRetries.inc({
            from_service: this.serviceName,
            to_service: serviceName,
            method
          });
          
          await this.sleep(delay);
          continue;
        }
        
        // 不重试或重试耗尽
        this.recordMetrics(serviceName, method, 'error', start);
        
        logger.error({
          from: this.serviceName,
          to: serviceName,
          method,
          path,
          attempt,
          error: error.message
        }, 'Service call failed');
        
        throw error;
      }
    }
    
    throw lastError;
  }
  
  /**
   * 流式调用（用于大文件下载）
   */
  async stream(serviceName, path, options = {}) {
    try {
      const { selected } = await this.discoveryClient.discover(serviceName);
      
      if (!selected) {
        throw new Error(`No available instances for service: ${serviceName}`);
      }
      
      const url = `http://${selected.host}:${selected.port}${path}`;
      const headers = this.buildHeaders(options);
      
      const response = await this.httpClient.request({
        method: 'GET',
        url,
        headers,
        responseType: 'stream',
        timeout: options.timeout || 30000
      });
      
      return response.data;
      
    } catch (error) {
      logger.error({
        from: this.serviceName,
        to: serviceName,
        path,
        error: error.message
      }, 'Stream call failed');
      
      throw error;
    }
  }
  
  /**
   * 构建请求头
   */
  buildHeaders(options = {}) {
    const headers = { ...options.headers };
    
    // 追踪信息
    if (this.config.enableTracing) {
      headers[this.traceIdHeader] = options.traceId || this.generateTraceId();
      headers[this.spanIdHeader] = this.generateSpanId();
    }
    
    // 服务认证
    if (this.config.enableAuth && this.config.serviceToken) {
      headers['Authorization'] = `Bearer ${this.config.serviceToken}`;
    }
    
    // 服务名标识
    headers['X-From-Service'] = this.serviceName;
    
    return headers;
  }
  
  /**
   * 判断是否重试
   */
  shouldRetry(error) {
    // 网络错误重试
    if (error.code === 'ECONNREFUSED' || 
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT') {
      return true;
    }
    
    // 5xx 错误重试
    if (error.response && error.response.status >= 500) {
      return true;
    }
    
    // 熔断器打开不重试
    if (error.message && error.message.includes('Circuit breaker open')) {
      return false;
    }
    
    return false;
  }
  
  /**
   * 计算重试延迟
   */
  getRetryDelay(attempt) {
    const baseDelay = this.config.retryDelay;
    
    if (this.config.retryBackoff === 'exponential') {
      return baseDelay * Math.pow(2, attempt - 1);
    }
    
    return baseDelay * attempt;
  }
  
  /**
   * 生成 Trace ID
   */
  generateTraceId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 16)}`;
  }
  
  /**
   * 生成 Span ID
   */
  generateSpanId() {
    return Math.random().toString(36).substr(2, 8);
  }
  
  /**
   * 记录指标
   */
  recordMetrics(serviceName, method, status, startTime) {
    const duration = (Date.now() - startTime) / 1000;
    
    this.metrics.serviceCallsTotal.inc({
      from_service: this.serviceName,
      to_service: serviceName,
      method,
      status
    });
    
    this.metrics.serviceCallDuration.observe({
      from_service: this.serviceName,
      to_service: serviceName,
      method
    }, duration);
    
    if (status === 'error') {
      this.metrics.serviceCallErrors.inc({
        from_service: this.serviceName,
        to_service: serviceName,
        method,
        error_type: 'call_failed'
      });
    }
  }
  
  /**
   * Sleep 辅助函数
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * 便捷方法：GET
   */
  async get(serviceName, path, options = {}) {
    return this.call(serviceName, 'GET', path, null, options);
  }
  
  /**
   * 便捷方法：POST
   */
  async post(serviceName, path, data, options = {}) {
    return this.call(serviceName, 'POST', path, data, options);
  }
  
  /**
   * 便捷方法：PUT
   */
  async put(serviceName, path, data, options = {}) {
    return this.call(serviceName, 'PUT', path, data, options);
  }
  
  /**
   * 便捷方法：PATCH
   */
  async patch(serviceName, path, data, options = {}) {
    return this.call(serviceName, 'PATCH', path, data, options);
  }
  
  /**
   * 便捷方法：DELETE
   */
  async delete(serviceName, path, options = {}) {
    return this.call(serviceName, 'DELETE', path, null, options);
  }
}

module.exports = ServiceClient;
