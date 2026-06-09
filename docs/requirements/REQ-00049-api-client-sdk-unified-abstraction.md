# REQ-00049: API 客户端 SDK 统一抽象层

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00049 |
| 标题 | API 客户端 SDK 统一抽象层 |
| 类别 | 技术债/重构 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | backend/shared, gateway, 所有微服务 |
| 创建时间 | 2026-06-09 12:45 |

## 需求描述

当前项目存在大量分散的 HTTP 客户端代码，各微服务独立实现 API 调用逻辑，导致以下问题：

1. **代码重复**：每个服务都有自己的 fetch/axios 封装，缺乏统一标准
2. **错误处理不一致**：重试逻辑、超时设置、错误日志格式各不相同
3. **可观测性缺失**：缺少统一的链路追踪、指标采集
4. **测试困难**：mock 和 stub 实现分散，集成测试复杂
5. **维护成本高**：修改一处需同步多个服务

### 核心目标
构建统一的 API 客户端 SDK，提供：
- 统一的 HTTP 请求/响应处理
- 内置重试、熔断、超时机制
- 自动链路追踪和指标采集
- 统一的错误处理和日志格式
- Mock 支持和测试辅助工具

## 技术方案

### 1. 核心 SDK 设计

```javascript
// backend/shared/ApiClient.js

const axios = require('axios');
const { logger } = require('./logger');
const { metrics } = require('./metrics');
const { CircuitBreaker } = require('./CircuitBreaker');
const { trace, context } = require('@opentelemetry/api');

/**
 * API 客户端配置
 */
const DEFAULT_CONFIG = {
  timeout: 10000,
  retries: 3,
  retryDelay: 1000,
  retryBackoff: 2,
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeout: 30000,
    halfOpenMaxCalls: 3
  },
  headers: {
    'Content-Type': 'application/json'
  }
};

/**
 * 统一 API 客户端类
 */
class ApiClient {
  /**
   * @param {string} serviceName - 服务名称
   * @param {string} baseUrl - 基础 URL
   * @param {Object} config - 配置选项
   */
  constructor(serviceName, baseUrl, config = {}) {
    this.serviceName = serviceName;
    this.baseUrl = baseUrl;
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // 创建 axios 实例
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: this.config.timeout,
      headers: this.config.headers
    });
    
    // 熔断器
    this.circuitBreaker = new CircuitBreaker(serviceName, this.config.circuitBreaker);
    
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
    
    // Prometheus 指标
    this.metrics = {
      requestsTotal: metrics.counter(
        `api_client_requests_total`,
        'Total API client requests',
        ['service', 'target_service', 'method', 'status']
      ),
      requestDuration: metrics.histogram(
        `api_client_request_duration_seconds`,
        'API client request duration',
        ['service', 'target_service', 'method'],
        [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10]
      ),
      retriesTotal: metrics.counter(
        `api_client_retries_total`,
        'Total API client retries',
        ['service', 'target_service', 'method']
      )
    };
  }

  /**
   * 请求拦截器
   */
  _onRequest(config) {
    // 链路追踪
    const span = trace.getSpan(context.active());
    if (span) {
      span.setAttributes({
        'http.target_service': this.serviceName,
        'http.method': config.method?.toUpperCase(),
        'http.url': config.url
      });
      
      // 注入 trace context
      const traceContext = {};
      context.active()?.setValue?.('traceparent', span.context().toString());
      config.headers['X-Trace-Id'] = span.context().traceId;
      config.headers['X-Span-Id'] = span.context().spanId;
    }
    
    // 请求 ID
    const requestId = config.headers['X-Request-Id'] || this._generateRequestId();
    config.headers['X-Request-Id'] = requestId;
    config.metadata = { startTime: Date.now(), requestId };
    
    logger.debug(`API request`, {
      service: this.serviceName,
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
    logger.error('API request setup error', {
      service: this.serviceName,
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
    
    // 记录指标
    this.metrics.requestsTotal.inc({
      service: process.env.SERVICE_NAME || 'unknown',
      target_service: this.serviceName,
      method: config.method?.toUpperCase(),
      status: response.status
    });
    
    this.metrics.requestDuration.observe(
      {
        service: process.env.SERVICE_NAME || 'unknown',
        target_service: this.serviceName,
        method: config.method?.toUpperCase()
      },
      duration
    );
    
    logger.debug('API response', {
      service: this.serviceName,
      method: config.method?.toUpperCase(),
      url: config.url,
      status: response.status,
      duration: `${duration.toFixed(3)}s`,
      requestId: config.metadata.requestId
    });
    
    // 追踪响应时间
    const span = trace.getSpan(context.active());
    if (span) {
      span.setAttributes({
        'http.status_code': response.status,
        'http.response_time': duration
      });
    }
    
    return response;
  }

  /**
   * 响应错误拦截器
   */
  async _onResponseError(error) {
    const { config } = error;
    const duration = (Date.now() - config.metadata.startTime) / 1000;
    
    // 记录错误指标
    this.metrics.requestsTotal.inc({
      service: process.env.SERVICE_NAME || 'unknown',
      target_service: this.serviceName,
      method: config.method?.toUpperCase(),
      status: error.response?.status || 'error'
    });
    
    // 判断是否可重试
    if (this._shouldRetry(error) && config.__retryCount < this.config.retries) {
      config.__retryCount = config.__retryCount || 0;
      config.__retryCount++;
      
      this.metrics.retriesTotal.inc({
        service: process.env.SERVICE_NAME || 'unknown',
        target_service: this.serviceName,
        method: config.method?.toUpperCase()
      });
      
      const delay = this.config.retryDelay * Math.pow(this.config.retryBackoff, config.__retryCount - 1);
      
      logger.warn('API request retry', {
        service: this.serviceName,
        url: config.url,
        retryCount: config.__retryCount,
        delay,
        error: error.message
      });
      
      await this._sleep(delay);
      return this.client.request(config);
    }
    
    // 记录错误
    logger.error('API request failed', {
      service: this.serviceName,
      method: config.method?.toUpperCase(),
      url: config.url,
      status: error.response?.status,
      error: error.message,
      requestId: config.metadata?.requestId
    });
    
    return Promise.reject(this._normalizeError(error));
  }

  /**
   * 判断是否应该重试
   */
  _shouldRetry(error) {
    // 网络错误
    if (!error.response) return true;
    
    // 5xx 错误
    const status = error.response.status;
    if (status >= 500 && status < 600) return true;
    
    // 429 Too Many Requests
    if (status === 429) return true;
    
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
    
    return normalized;
  }

  /**
   * 生成请求 ID
   */
  _generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 延迟函数
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
    const baseUrl = process.env[`${targetService.toUpperCase().replace(/-/g, '_')}_URL`]
      || `http://${targetService}`;
    
    return this.getClient(targetService, baseUrl, {
      ...config,
      headers: {
        ...config.headers,
        'X-Service-Name': process.env.SERVICE_NAME || 'unknown'
      }
    });
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
  factory
};
```

### 2. Mock 客户端（测试用）

```javascript
// backend/shared/ApiClientMock.js

/**
 * Mock API 客户端，用于测试
 */
class ApiClientMock {
  constructor() {
    this.responses = new Map();
    this.calls = [];
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
    return this.calls;
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
    this._recordCall(method, path, options);
    
    const key = `${method}:${path}`;
    const mock = this.responses.get(key);
    
    if (!mock) {
      throw new Error(`No mock set for ${key}`);
    }
    
    if (mock.error) {
      const error = new Error(mock.error.message || 'Mock error');
      error.status = mock.status;
      error.data = mock.error;
      throw error;
    }
    
    return mock.data;
  }
  
  /**
   * 健康检查
   */
  async healthCheck() {
    return { healthy: true, data: { status: 'ok' } };
  }
}

/**
 * 创建 mock 客户端
 */
function createMockClient() {
  return new ApiClientMock();
}

module.exports = {
  ApiClientMock,
  createMockClient
};
```

### 3. 服务集成示例

```javascript
// backend/services/catch-service/src/clients/pokemonClient.js

const { serviceClients } = require('../../../shared/ApiClient');

/**
 * Pokemon 服务客户端
 */
class PokemonClient {
  constructor() {
    this.client = serviceClients.pokemonService;
  }
  
  /**
   * 获取精灵详情
   */
  async getPokemon(pokemonId) {
    return this.client.get(`/pokemon/${pokemonId}`);
  }
  
  /**
   * 更新精灵属性
   */
  async updatePokemon(pokemonId, updates) {
    return this.client.patch(`/pokemon/${pokemonId}`, updates);
  }
  
  /**
   * 添加精灵技能
   */
  async addMove(pokemonId, moveId) {
    return this.client.post(`/pokemon/${pokemonId}/moves`, { moveId });
  }
  
  /**
   * 获取精灵列表
   */
  async listPokemon(userId, options = {}) {
    return this.client.get(`/pokemon/user/${userId}`, options);
  }
}

module.exports = { PokemonClient: new PokemonClient() };
```

### 4. 单元测试

```javascript
// backend/tests/unit/ApiClient.test.js

const { ApiClient } = require('../../shared/ApiClient');
const { ApiClientMock, createMockClient } = require('../../shared/ApiClientMock');
const axios = require('axios');
const nock = require('nock');

describe('ApiClient', () => {
  let client;
  const baseUrl = 'http://test-service';
  
  beforeEach(() => {
    client = new ApiClient('test-service', baseUrl, {
      retries: 2,
      retryDelay: 10
    });
  });
  
  afterEach(() => {
    nock.cleanAll();
  });
  
  describe('GET 请求', () => {
    it('应成功发送 GET 请求', async () => {
      nock(baseUrl)
        .get('/users/123')
        .reply(200, { id: 123, name: 'Test User' });
      
      const result = await client.get('/users/123');
      
      expect(result).toEqual({ id: 123, name: 'Test User' });
    });
    
    it('应支持查询参数', async () => {
      nock(baseUrl)
        .get('/users')
        .query({ page: 1, limit: 10 })
        .reply(200, { users: [] });
      
      const result = await client.get('/users', { page: 1, limit: 10 });
      
      expect(result).toEqual({ users: [] });
    });
  });
  
  describe('POST 请求', () => {
    it('应成功发送 POST 请求', async () => {
      nock(baseUrl)
        .post('/users', { name: 'New User' })
        .reply(201, { id: 456, name: 'New User' });
      
      const result = await client.post('/users', { name: 'New User' });
      
      expect(result).toEqual({ id: 456, name: 'New User' });
    });
  });
  
  describe('重试机制', () => {
    it('应在 5xx 错误时重试', async () => {
      nock(baseUrl)
        .get('/users/123')
        .reply(500)
        .get('/users/123')
        .reply(200, { id: 123 });
      
      const result = await client.get('/users/123');
      
      expect(result).toEqual({ id: 123 });
    });
    
    it('应在达到重试次数后抛出错误', async () => {
      nock(baseUrl)
        .get('/users/123')
        .times(3)
        .reply(500);
      
      await expect(client.get('/users/123')).rejects.toThrow();
    });
  });
  
  describe('熔断器', () => {
    it('应在连续失败后打开熔断器', async () => {
      nock(baseUrl)
        .get('/users/123')
        .times(5)
        .reply(500);
      
      // 触发失败
      for (let i = 0; i < 5; i++) {
        try {
          await client.get('/users/123');
        } catch (e) {
          // 忽略错误
        }
      }
      
      // 熔断器应该打开
      await expect(client.get('/users/123')).rejects.toThrow('Circuit breaker is open');
    });
  });
  
  describe('错误处理', () => {
    it('应规范化错误对象', async () => {
      nock(baseUrl)
        .get('/users/123')
        .reply(404, { error: 'User not found' });
      
      try {
        await client.get('/users/123');
        fail('Should have thrown');
      } catch (error) {
        expect(error.status).toBe(404);
        expect(error.service).toBe('test-service');
        expect(error.requestId).toBeDefined();
      }
    });
  });
  
  describe('健康检查', () => {
    it('应在服务健康时返回 true', async () => {
      nock(baseUrl)
        .get('/health')
        .reply(200, { status: 'ok' });
      
      const result = await client.healthCheck();
      
      expect(result.healthy).toBe(true);
    });
    
    it('应在服务不可用时返回 false', async () => {
      nock(baseUrl)
        .get('/health')
        .reply(500);
      
      const result = await client.healthCheck();
      
      expect(result.healthy).toBe(false);
    });
  });
});

describe('ApiClientMock', () => {
  let mockClient;
  
  beforeEach(() => {
    mockClient = createMockClient();
  });
  
  it('应返回 mock 响应', async () => {
    mockClient.mockResponse('GET', '/users/123', { id: 123 });
    
    const result = await mockClient.get('/users/123');
    
    expect(result).toEqual({ id: 123 });
  });
  
  it('应记录调用', async () => {
    mockClient.mockResponse('GET', '/users/123', {});
    
    await mockClient.get('/users/123', { page: 1 });
    
    const calls = mockClient.getCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].path).toBe('/users/123');
  });
  
  it('应返回 mock 错误', async () => {
    mockClient.mockError('GET', '/users/123', { message: 'Not found' }, 404);
    
    await expect(mockClient.get('/users/123')).rejects.toThrow();
  });
});
```

### 5. 迁移指南

```markdown
# API 客户端迁移指南

## 迁移步骤

### 1. 替换直接 axios 调用

**之前：**
```javascript
const axios = require('axios');
const response = await axios.get('http://user-service/users/123');
```

**之后：**
```javascript
const { serviceClients } = require('../../shared/ApiClient');
const response = await serviceClients.userService.get('/users/123');
```

### 2. 替换自定义 fetch 封装

**之前：**
```javascript
async function fetchUser(id) {
  try {
    const res = await fetch(`http://user-service/users/${id}`);
    return res.json();
  } catch (error) {
    console.error(error);
    throw error;
  }
}
```

**之后：**
```javascript
async function fetchUser(id) {
  const { serviceClients } = require('../../shared/ApiClient');
  return serviceClients.userService.get(`/users/${id}`);
}
```

### 3. 测试中使用 Mock

**之前：**
```javascript
// 手动 mock
jest.mock('axios');
axios.get.mockResolvedValue({ data: { id: 123 } });
```

**之后：**
```javascript
const { createMockClient } = require('../../shared/ApiClientMock');

const mockClient = createMockClient();
mockClient.mockResponse('GET', '/users/123', { id: 123 });
```

## 兼容性

- 保留 6 个月过渡期
- 新代码强制使用 ApiClient
- 旧代码逐步迁移
```

## 验收标准

- [ ] ApiClient 类实现完成，支持 GET/POST/PUT/DELETE/PATCH
- [ ] 自动重试机制（可配置重试次数和延迟）
- [ ] 集成熔断器保护
- [ ] 自动链路追踪注入（trace context）
- [ ] Prometheus 指标采集（请求数、延迟、重试数）
- [ ] 统一的错误处理和日志格式
- [ ] 请求 ID 自动生成和传递
- [ ] ApiClientFactory 支持单例管理
- [ ] 预定义所有微服务客户端（userService, pokemonService 等）
- [ ] ApiClientMock 实现完成，支持测试
- [ ] 单元测试覆盖 90%+（40+ 测试用例）
- [ ] 至少 3 个服务完成迁移（catch-service, social-service, reward-service）
- [ ] 迁移指南文档完成
- [ ] 性能测试：延迟 < 5ms（本地调用）

## 影响范围

- **新增文件**：
  - backend/shared/ApiClient.js（核心 SDK，约 400 行）
  - backend/shared/ApiClientMock.js（测试 Mock，约 150 行）
  - backend/tests/unit/ApiClient.test.js（单元测试，约 300 行）
  - docs/api-client-migration-guide.md（迁移指南）
  
- **修改服务**：
  - backend/services/catch-service（迁移 5+ 处调用）
  - backend/services/social-service（迁移 8+ 处调用）
  - backend/services/reward-service（迁移 6+ 处调用）
  
- **删除冗余**：
  - 移除各服务中的自定义 fetch 封装
  - 统一错误处理逻辑

- **收益**：
  - 减少重复代码约 500+ 行
  - 统一错误处理和日志格式
  - 提升可观测性（链路追踪、指标）
  - 降低测试复杂度
  - 未来新增服务自动获得所有能力

## 工作量估算

**L（Large）** - 约 3-5 天
- Day 1: 核心 ApiClient 类实现和测试
- Day 2: Mock 客户端、工厂类、服务集成
- Day 3: 3 个服务迁移和测试
- Day 4: 文档、性能测试、代码审查
- Day 5: 修复问题和合并

## 优先级理由

P1 - 技术债重构，影响多个服务的开发效率和代码质量。统一 SDK 可：
- 减少未来开发时间 20%+
- 提升错误诊断效率 50%+
- 降低新服务接入成本
- 为后续功能开发打下基础
