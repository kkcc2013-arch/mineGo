// backend/shared/middleware/retryMiddleware.js
// REQ-00402: API 错误重试中间件

'use strict';

const { RetryManager, RetryBudget, ErrorClassifier } = require('../RetryManager');
const { createLogger } = require('../logger');

const logger = createLogger('retry-middleware');

// 全局重试管理器实例（按服务配置）
const retryManagers = new Map();

/**
 * 创建服务特定的重试管理器
 */
function getOrCreateRetryManager(serviceName, options = {}) {
  if (!retryManagers.has(serviceName)) {
    const manager = new RetryManager({
      maxRetries: options.maxRetries ?? 3,
      initialDelay: options.initialDelay ?? 100,
      maxDelay: options.maxDelay ?? 10000,
      backoffType: options.backoffType ?? 'exponential',
      jitterType: options.jitterType ?? 'full',
      timeout: options.timeout ?? 30000,
      retryBudget: options.enableBudget ? new RetryBudget(options.budgetConfig) : null,
      errorConfig: options.errorConfig
    });

    retryManagers.set(serviceName, manager);
    logger.info({ serviceName }, 'Retry manager created');
  }

  return retryManagers.get(serviceName);
}

/**
 * Express 中间件：为出站请求添加重试能力
 */
function createRetryMiddleware(options = {}) {
  const serviceName = options.serviceName || process.env.SERVICE_NAME || 'gateway';
  const retryManager = getOrCreateRetryManager(serviceName, options);

  // 将 RetryManager 挂载到请求上下文
  return (req, res, next) => {
    req.retryManager = retryManager;
    req.retryableFetch = createRetryableFetch(retryManager);
    next();
  };
}

/**
 * 包装 fetch 函数，添加重试能力
 */
function createRetryableFetch(retryManager) {
  return async (url, options = {}) => {
    const operationName = options.operationName || url;

    return retryManager.execute(async () => {
      const response = await fetch(url, {
        ...options,
        signal: options.signal
      });

      // 检查响应状态
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
        error.status = response.status;
        error.headers = {};
        for (const [key, value] of response.headers.entries()) {
          error.headers[key] = value;
        }
        throw error;
      }

      return response;
    }, {
      operationName,
      metadata: { url, method: options.method || 'GET' },
      signal: options.signal
    });
  };
}

/**
 * 服务间调用重试包装器
 */
function wrapServiceClient(client, retryManager, options = {}) {
  const originalRequest = client.request.bind(client);

  client.request = async function(requestOptions) {
    const operationName = `${requestOptions.service || 'unknown'}.${requestOptions.method || 'unknown'}`;

    return retryManager.execute(
      () => originalRequest(requestOptions),
      {
        operationName,
        metadata: requestOptions,
        signal: requestOptions.signal
      }
    );
  };

  return client;
}

/**
 * Axios 重试拦截器
 */
function createAxiosRetryInterceptor(axiosInstance, retryManager) {
  // 请求拦截器：注入重试信息
  axiosInstance.interceptors.request.use(
    (config) => {
      config.metadata = { startTime: Date.now() };
      return config;
    },
    (error) => Promise.reject(error)
  );

  // 响应拦截器：处理错误重试
  axiosInstance.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config;

      // 检查是否已有重试信息
      if (!config || config.__isRetryRequest) {
        return Promise.reject(error);
      }

      // 分类错误
      const classifier = new ErrorClassifier();
      const classification = classifier.classify(error);

      // 不可重试
      if (!classification.retryable) {
        return Promise.reject(error);
      }

      // 检查重试次数
      config.__retryCount = config.__retryCount || 0;
      const maxRetries = config.maxRetries ?? 3;

      if (config.__retryCount >= maxRetries) {
        return Promise.reject(error);
      }

      // 计算退避时间
      config.__retryCount += 1;
      const delay = retryManager.backoffStrategy.calculateDelay(
        config.__retryCount,
        classification
      );

      logger.info({
        url: config.url,
        retryCount: config.__retryCount,
        delay,
        errorType: classification.type
      }, 'Retrying axios request');

      // 等待
      await new Promise(resolve => setTimeout(resolve, delay));

      // 重新请求
      config.__isRetryRequest = true;
      return axiosInstance(config);
    }
  );

  return axiosInstance;
}

/**
 * HTTP 客户端工厂函数
 */
function createRetryableHttpClient(baseConfig = {}) {
  const retryManager = new RetryManager(baseConfig.retryConfig || {});

  return {
    async get(url, options = {}) {
      return this.request('GET', url, null, options);
    },

    async post(url, data, options = {}) {
      return this.request('POST', url, data, options);
    },

    async put(url, data, options = {}) {
      return this.request('PUT', url, data, options);
    },

    async delete(url, options = {}) {
      return this.request('DELETE', url, null, options);
    },

    async request(method, url, data, options = {}) {
      const fetchOptions = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        },
        ...options
      };

      if (data) {
        fetchOptions.body = JSON.stringify(data);
      }

      return retryManager.execute(async () => {
        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }

        // 根据返回类型解析
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          return response.json();
        }
        return response.text();
      }, {
        operationName: options.operationName || `${method} ${url}`,
        signal: options.signal
      });
    },

    getRetryManager() {
      return retryManager;
    }
  };
}

/**
 * 获取所有活跃的重试管理器
 */
function getActiveRetryManagers() {
  return Array.from(retryManagers.entries()).map(([name, manager]) => ({
    serviceName: name,
    budget: manager.retryBudget?.getBudget() ?? null
  }));
}

/**
 * 清理所有重试管理器
 */
function cleanupRetryManagers() {
  for (const [name, manager] of retryManagers.entries()) {
    if (manager.retryBudget) {
      manager.retryBudget.stopRefillTimer();
    }
    logger.info({ serviceName: name }, 'Retry manager cleaned up');
  }
  retryManagers.clear();
}

module.exports = {
  createRetryMiddleware,
  createRetryableFetch,
  wrapServiceClient,
  createAxiosRetryInterceptor,
  createRetryableHttpClient,
  getOrCreateRetryManager,
  getActiveRetryManagers,
  cleanupRetryManagers
};