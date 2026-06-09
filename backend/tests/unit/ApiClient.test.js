// tests/unit/ApiClient.test.js - API 客户端 SDK 单元测试
'use strict';

const { ApiClient, ApiClientFactory, serviceClients, factory } = require('../../shared/ApiClient');
const { ApiClientMock, createMockClient, createMockServiceClients } = require('../../shared/ApiClientMock');

// Mock axios for ApiClient tests
jest.mock('axios', () => {
  const axiosMock = {
    create: jest.fn(() => ({
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() }
      },
      request: jest.fn(),
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      patch: jest.fn()
    }))
  };
  return axiosMock;
});

// Mock CircuitBreaker
jest.mock('../../shared/CircuitBreaker', () => ({
  CircuitBreaker: jest.fn().mockImplementation(() => ({
    execute: jest.fn(fn => fn()),
    getState: jest.fn(() => 'closed')
  }))
}));

// Mock logger
jest.mock('../../shared/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }))
}));

// Mock tracing
jest.mock('../../shared/tracing', () => ({
  getTracer: jest.fn(() => ({
    startSpan: jest.fn()
  }))
}));

// Mock metrics
jest.mock('../../shared/metrics', () => ({
  registerCounter: jest.fn(() => ({
    inc: jest.fn(),
    add: jest.fn()
  })),
  registerHistogram: jest.fn(() => ({
    observe: jest.fn()
  }))
}));

describe('ApiClient', () => {
  let client;
  const baseUrl = 'http://test-service:8080';
  
  beforeEach(() => {
    client = new ApiClient('test-service', baseUrl, {
      retries: 2,
      retryDelay: 10,
      circuitBreaker: {
        failureThreshold: 5,
        successThreshold: 2,
        timeout: 5000,
        halfOpenMaxCalls: 3
      }
    });
  });
  
  describe('构造函数', () => {
    test('应正确初始化客户端', () => {
      expect(client.serviceName).toBe('test-service');
      expect(client.baseUrl).toBe(baseUrl);
      expect(client.config.timeout).toBe(10000);
      expect(client.config.retries).toBe(2);
    });
    
    test('应使用默认配置', () => {
      const defaultClient = new ApiClient('default-service', 'http://localhost');
      expect(defaultClient.config.timeout).toBe(10000);
      expect(defaultClient.config.retries).toBe(3);
      expect(defaultClient.config.retryDelay).toBe(1000);
      expect(defaultClient.config.retryBackoff).toBe(2);
    });
    
    test('应允许覆盖配置', () => {
      const customClient = new ApiClient('custom-service', 'http://localhost', {
        timeout: 5000,
        retries: 5
      });
      expect(customClient.config.timeout).toBe(5000);
      expect(customClient.config.retries).toBe(5);
    });
  });
  
  describe('请求方法', () => {
    test('GET 请求应通过熔断器执行', async () => {
      const mockData = { id: 1, name: 'Test' };
      client.circuitBreaker.execute = jest.fn(async (fn) => {
        // 模拟 axios response
        client.client.request = jest.fn().mockResolvedValue({ data: mockData });
        return fn();
      });
      
      // 直接测试 _executeWithCircuitBreaker
      client.client.request = jest.fn().mockResolvedValue({ data: mockData });
      const result = await client.get('/users/1');
      expect(result).toEqual(mockData);
    });
    
    test('POST 请求应发送数据', async () => {
      const responseData = { id: 2, name: 'New User' };
      client.circuitBreaker.execute = jest.fn(async (fn) => {
        client.client.request = jest.fn().mockResolvedValue({ data: responseData });
        const result = await client.client.request({
          method: 'POST',
          url: '/users',
          data: { name: 'New User' }
        });
        return result.data;
      });
      
      const result = await client.post('/users', { name: 'New User' });
      expect(result).toEqual(responseData);
    });
    
    test('PUT 请求应发送数据', async () => {
      const responseData = { id: 1, name: 'Updated' };
      client.circuitBreaker.execute = jest.fn(async (fn) => {
        client.client.request = jest.fn().mockResolvedValue({ data: responseData });
        return fn();
      });
      
      const result = await client.put('/users/1', { name: 'Updated' });
      expect(result).toEqual(responseData);
    });
    
    test('DELETE 请求应正确执行', async () => {
      client.circuitBreaker.execute = jest.fn(async (fn) => {
        client.client.request = jest.fn().mockResolvedValue({ data: { success: true } });
        return fn();
      });
      
      const result = await client.delete('/users/1');
      expect(result).toEqual({ success: true });
    });
    
    test('PATCH 请求应发送数据', async () => {
      const responseData = { id: 1, name: 'Patched' };
      client.circuitBreaker.execute = jest.fn(async (fn) => {
        client.client.request = jest.fn().mockResolvedValue({ data: responseData });
        return fn();
      });
      
      const result = await client.patch('/users/1', { name: 'Patched' });
      expect(result).toEqual(responseData);
    });
  });
  
  describe('重试机制', () => {
    test('应在 5xx 错误时重试', () => {
      const error = { response: { status: 500 }, config: {} };
      expect(client._shouldRetry(error)).toBe(true);
    });
    
    test('应在 429 错误时重试', () => {
      const error = { response: { status: 429 }, config: {} };
      expect(client._shouldRetry(error)).toBe(true);
    });
    
    test('应在网络错误时重试', () => {
      const error = { code: 'ECONNREFUSED', config: {} };
      expect(client._shouldRetry(error)).toBe(true);
    });
    
    test('不应在 4xx 错误时重试（除 429 和 408）', () => {
      const error400 = { response: { status: 400 }, config: {} };
      const error401 = { response: { status: 401 }, config: {} };
      const error403 = { response: { status: 403 }, config: {} };
      const error404 = { response: { status: 404 }, config: {} };
      
      expect(client._shouldRetry(error400)).toBe(false);
      expect(client._shouldRetry(error401)).toBe(false);
      expect(client._shouldRetry(error403)).toBe(false);
      expect(client._shouldRetry(error404)).toBe(false);
    });
    
    test('应在 408 错误时重试', () => {
      const error = { response: { status: 408 }, config: {} };
      expect(client._shouldRetry(error)).toBe(true);
    });
  });
  
  describe('错误处理', () => {
    test('应规范化错误对象', () => {
      const originalError = new Error('Server Error');
      originalError.code = 'ECONNREFUSED';
      originalError.response = { status: 500, data: { message: 'Internal Error' } };
      originalError.config = { metadata: { requestId: 'req_123' } };
      
      const normalized = client._normalizeError(originalError);
      
      expect(normalized.message).toBe('Server Error');
      expect(normalized.code).toBe('ECONNREFUSED');
      expect(normalized.status).toBe(500);
      expect(normalized.data).toEqual({ message: 'Internal Error' });
      expect(normalized.service).toBe('test-service');
      expect(normalized.requestId).toBe('req_123');
      expect(normalized.isApiClientError).toBe(true);
    });
    
    test('应处理无响应的错误', () => {
      const originalError = new Error('Network Error');
      originalError.code = 'NETWORK_ERROR';
      
      const normalized = client._normalizeError(originalError);
      
      expect(normalized.message).toBe('Network Error');
      expect(normalized.code).toBe('NETWORK_ERROR');
      expect(normalized.status).toBeUndefined();
      expect(normalized.data).toBeUndefined();
    });
    
    test('应使用默认错误码', () => {
      const originalError = new Error('Unknown error');
      
      const normalized = client._normalizeError(originalError);
      
      expect(normalized.code).toBe('API_ERROR');
    });
  });
  
  describe('健康检查', () => {
    test('应在服务健康时返回 true', async () => {
      client.get = jest.fn().mockResolvedValue({ status: 'ok' });
      
      const result = await client.healthCheck();
      
      expect(result.healthy).toBe(true);
      expect(result.data).toEqual({ status: 'ok' });
    });
    
    test('应在服务不可用时返回 false', async () => {
      client.get = jest.fn().mockRejectedValue(new Error('Connection refused'));
      
      const result = await client.healthCheck();
      
      expect(result.healthy).toBe(false);
      expect(result.error).toBe('Connection refused');
    });
  });
  
  describe('熔断器状态', () => {
    test('应返回熔断器状态', () => {
      const state = client.getCircuitBreakerState();
      expect(state).toBe('closed');
    });
  });
  
  describe('请求拦截器', () => {
    test('应添加请求 ID', () => {
      const config = { headers: {}, method: 'get', url: '/test' };
      const result = client._onRequest(config);
      
      expect(result.headers['X-Request-Id']).toMatch(/^req_\d+_/);
      expect(result.metadata).toBeDefined();
      expect(result.metadata.startTime).toBeDefined();
      expect(result.metadata.requestId).toBeDefined();
    });
    
    test('应保留已有的请求 ID', () => {
      const config = { headers: { 'X-Request-Id': 'existing-id' }, method: 'get', url: '/test' };
      const result = client._onRequest(config);
      
      expect(result.headers['X-Request-Id']).toBe('existing-id');
    });
  });
  
  describe('响应拦截器', () => {
    test('应记录响应信息', () => {
      const response = {
        config: { metadata: { startTime: Date.now() - 100, requestId: 'req_123' }, method: 'get', url: '/test' },
        status: 200,
        data: { id: 1 }
      };
      
      const result = client._onResponse(response);
      expect(result).toBe(response);
    });
  });
});

describe('ApiClientFactory', () => {
  let testFactory;
  
  beforeEach(() => {
    testFactory = new ApiClientFactory();
  });
  
  test('应创建客户端', () => {
    const client = testFactory.getClient('test-service', 'http://localhost:8080');
    expect(client).toBeInstanceOf(ApiClient);
    expect(client.serviceName).toBe('test-service');
  });
  
  test('应复用同一客户端', () => {
    const client1 = testFactory.getClient('test-service', 'http://localhost:8080');
    const client2 = testFactory.getClient('test-service', 'http://localhost:8080');
    expect(client1).toBe(client2);
  });
  
  test('应为不同 URL 创建不同客户端', () => {
    const client1 = testFactory.getClient('service-a', 'http://localhost:8080');
    const client2 = testFactory.getClient('service-b', 'http://localhost:8081');
    expect(client1).not.toBe(client2);
  });
  
  test('createServiceClient 应从环境变量获取 URL', () => {
    process.env.USER_SERVICE_URL = 'http://custom-host:9090';
    const client = testFactory.createServiceClient('user-service');
    expect(client.baseUrl).toBe('http://custom-host:9090');
    delete process.env.USER_SERVICE_URL;
  });
  
  test('createServiceClient 应使用默认 URL', () => {
    const client = testFactory.createServiceClient('pokemon-service');
    expect(client.baseUrl).toBe('http://pokemon-service');
  });
  
  test('clearAll 应清除所有客户端', () => {
    testFactory.getClient('service-a', 'http://localhost:8080');
    testFactory.getClient('service-b', 'http://localhost:8081');
    testFactory.clearAll();
    expect(testFactory.clients.size).toBe(0);
  });
  
  test('getAllClients 应返回所有客户端信息', () => {
    testFactory.getClient('service-a', 'http://localhost:8080');
    testFactory.getClient('service-b', 'http://localhost:8081');
    const clients = testFactory.getAllClients();
    expect(clients).toHaveLength(2);
    expect(clients[0].serviceName).toBe('service-a');
  });
});

describe('serviceClients', () => {
  test('应有所有预定义服务客户端', () => {
    // Test lazy getters
    expect(typeof serviceClients.userService.get).toBe('function');
    expect(typeof serviceClients.pokemonService.get).toBe('function');
    expect(typeof serviceClients.catchService.get).toBe('function');
    expect(typeof serviceClients.locationService.get).toBe('function');
    expect(typeof serviceClients.gymService.get).toBe('function');
    expect(typeof serviceClients.socialService.get).toBe('function');
    expect(typeof serviceClients.rewardService.get).toBe('function');
    expect(typeof serviceClients.paymentService.get).toBe('function');
    expect(typeof serviceClients.gateway.get).toBe('function');
  });
});

describe('ApiClientMock', () => {
  let mockClient;
  
  beforeEach(() => {
    mockClient = createMockClient('mock-test-service');
  });
  
  describe('基础功能', () => {
    test('应返回 mock 响应', async () => {
      mockClient.mockResponse('GET', '/users/123', { id: 123, name: 'Test' });
      
      const result = await mockClient.get('/users/123');
      expect(result).toEqual({ id: 123, name: 'Test' });
    });
    
    test('POST 应返回 mock 响应', async () => {
      mockClient.mockResponse('POST', '/users', { id: 456 }, 201);
      
      const result = await mockClient.post('/users', { name: 'New' });
      expect(result).toEqual({ id: 456 });
    });
    
    test('PUT 应返回 mock 响应', async () => {
      mockClient.mockResponse('PUT', '/users/123', { updated: true });
      
      const result = await mockClient.put('/users/123', { name: 'Updated' });
      expect(result).toEqual({ updated: true });
    });
    
    test('DELETE 应返回 mock 响应', async () => {
      mockClient.mockResponse('DELETE', '/users/123', { deleted: true });
      
      const result = await mockClient.delete('/users/123');
      expect(result).toEqual({ deleted: true });
    });
    
    test('PATCH 应返回 mock 响应', async () => {
      mockClient.mockResponse('PATCH', '/users/123', { patched: true });
      
      const result = await mockClient.patch('/users/123', { name: 'Patched' });
      expect(result).toEqual({ patched: true });
    });
  });
  
  describe('调用记录', () => {
    test('应记录调用', async () => {
      mockClient.mockResponse('GET', '/users/123', {});
      
      await mockClient.get('/users/123');
      
      const calls = mockClient.getCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('GET');
      expect(calls[0].path).toBe('/users/123');
    });
    
    test('getLastCall 应返回最后一次调用', async () => {
      mockClient.mockResponse('GET', '/users/1', {});
      mockClient.mockResponse('GET', '/users/2', {});
      
      await mockClient.get('/users/1');
      await mockClient.get('/users/2');
      
      const lastCall = mockClient.getLastCall();
      expect(lastCall.path).toBe('/users/2');
    });
    
    test('getCallCount 应返回特定路径调用次数', async () => {
      mockClient.mockResponse('GET', '/users', {});
      
      await mockClient.get('/users');
      await mockClient.get('/users');
      await mockClient.get('/users');
      
      expect(mockClient.getCallCount('/users', 'GET')).toBe(3);
    });
    
    test('clearCalls 应清空调用记录', async () => {
      mockClient.mockResponse('GET', '/users', {});
      await mockClient.get('/users');
      
      mockClient.clearCalls();
      
      expect(mockClient.getCalls()).toHaveLength(0);
    });
  });
  
  describe('错误模拟', () => {
    test('应返回 mock 错误', async () => {
      mockClient.mockError('GET', '/users/999', { message: 'Not found' }, 404);
      
      try {
        await mockClient.get('/users/999');
        fail('Should have thrown');
      } catch (error) {
        expect(error.status).toBe(404);
        expect(error.data.message).toBe('Not found');
        expect(error.isApiClientError).toBe(true);
      }
    });
    
    test('应模拟网络错误', async () => {
      mockClient.mockNetworkError('GET', '/users/123', 'Connection refused');
      
      try {
        await mockClient.get('/users/123');
        fail('Should have thrown');
      } catch (error) {
        expect(error.code).toBe('NETWORK_ERROR');
        expect(error.message).toBe('Connection refused');
      }
    });
    
    test('应模拟超时错误', async () => {
      mockClient.mockTimeout('GET', '/users/123');
      
      try {
        await mockClient.get('/users/123');
        fail('Should have thrown');
      } catch (error) {
        expect(error.code).toBe('ECONNABORTED');
      }
    });
    
    test('未设置 mock 时应抛出错误', async () => {
      try {
        await mockClient.get('/not-mocked');
        fail('Should have thrown');
      } catch (error) {
        expect(error.code).toBe('NO_MOCK');
        expect(error.message).toContain('No mock set');
      }
    });
  });
  
  describe('重置', () => {
    test('reset 应清空所有 mock 和调用记录', async () => {
      mockClient.mockResponse('GET', '/users', {});
      await mockClient.get('/users');
      
      mockClient.reset();
      
      expect(mockClient.getCalls()).toHaveLength(0);
      try {
        await mockClient.get('/users');
        fail('Should have thrown');
      } catch (error) {
        expect(error.code).toBe('NO_MOCK');
      }
    });
  });
  
  describe('健康检查', () => {
    test('应返回健康的默认响应', async () => {
      const result = await mockClient.healthCheck();
      expect(result.healthy).toBe(true);
    });
    
    test('应使用 mock 设置的响应', async () => {
      mockClient.mockResponse('GET', '/health', { status: 'degraded' });
      const result = await mockClient.healthCheck();
      expect(result.healthy).toBe(true);
      expect(result.data).toEqual({ status: 'degraded' });
    });
  });
  
  describe('延迟模拟', () => {
    test('setDefaultDelay 应设置延迟', async () => {
      mockClient.setDefaultDelay(50);
      mockClient.mockResponse('GET', '/users', {});
      
      const start = Date.now();
      await mockClient.get('/users');
      const duration = Date.now() - start;
      
      expect(duration).toBeGreaterThanOrEqual(45); // 允许一些误差
    });
  });
  
  describe('熔断器状态', () => {
    test('应返回 closed 状态', () => {
      expect(mockClient.getCircuitBreakerState()).toBe('closed');
    });
  });
});

describe('createMockServiceClients', () => {
  test('应创建所有服务的 mock 客户端', () => {
    const mocks = createMockServiceClients();
    
    expect(mocks.userService).toBeInstanceOf(ApiClientMock);
    expect(mocks.pokemonService).toBeInstanceOf(ApiClientMock);
    expect(mocks.catchService).toBeInstanceOf(ApiClientMock);
    expect(mocks.locationService).toBeInstanceOf(ApiClientMock);
    expect(mocks.gymService).toBeInstanceOf(ApiClientMock);
    expect(mocks.socialService).toBeInstanceOf(ApiClientMock);
    expect(mocks.rewardService).toBeInstanceOf(ApiClientMock);
    expect(mocks.paymentService).toBeInstanceOf(ApiClientMock);
    expect(mocks.gateway).toBeInstanceOf(ApiClientMock);
  });
  
  test('每个 mock 客户端应有正确的服务名', () => {
    const mocks = createMockServiceClients();
    
    expect(mocks.userService.serviceName).toBe('user-service');
    expect(mocks.pokemonService.serviceName).toBe('pokemon-service');
    expect(mocks.paymentService.serviceName).toBe('payment-service');
  });
});
