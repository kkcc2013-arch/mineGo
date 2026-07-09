// backend/shared/testUtils/jestSetup.js
'use strict';

const { mockRepo } = require('./mockRepository');
const { factory } = require('./MockDataFactory');
const { mockServices } = require('./ExternalMockServices');
const { DatabaseSnapshotManager } = require('./DatabaseSnapshotManager');
const { createLogger } = require('../logger');

const logger = createLogger('jest-setup');

/**
 * Jest 测试集成工具
 * 
 * 提供：
 * - setup：初始化 Mock 系统
 * - teardown：清理资源
 * - snapshot：数据库快照管理
 * - global mocks：全局 Mock 配置
 */

// 全局测试状态
let testSnapshotManager = null;
let currentSnapshotId = null;

/**
 * 全局 setup（在所有测试前运行）
 */
async function globalSetup() {
  logger.info('Setting up test environment');
  
  // 初始化 Mock Repository
  mockRepo.loadAllFixtures();
  
  // 设置外部服务 Mock
  mockServices.setFailureRate(0);
  mockServices.setDelay(0);
  
  // Mock 环境变量（测试环境）
  process.env.NODE_ENV = 'test';
  process.env.TEST_MODE = 'true';
  
  // Mock 时间（可选）
  // jest.useFakeTimers();
  
  logger.info('Test environment setup complete');
}

/**
 * 全局 teardown（在所有测试后运行）
 */
async function globalTeardown() {
  logger.info('Tearing down test environment');
  
  // 清理数据库快照
  if (testSnapshotManager) {
    await testSnapshotManager.cleanupAllSnapshots();
    await testSnapshotManager.close();
    testSnapshotManager = null;
  }
  
  // 重置 Mock Services
  mockServices.clear();
  mockServices.setFailureRate(0);
  
  // 清理 mockRepo 缓存
  mockRepo.reload();
  
  logger.info('Test environment teardown complete');
}

/**
 * 单个测试 setup（在每个测试前运行）
 */
async function beforeEachTest(testName = 'unknown') {
  logger.debug({ testName }, 'Before each test');
  
  // 创建数据库快照（可选）
  if (testSnapshotManager && process.env.USE_DB_SNAPSHOT === 'true') {
    currentSnapshotId = `test_${testName}_${Date.now()}`;
    await testSnapshotManager.createSnapshot(currentSnapshotId);
    logger.debug({ snapshotId: currentSnapshotId }, 'Database snapshot created');
  }
  
  // 重置 Mock Services 状态
  mockServices.setFailureRate(0);
  mockServices.setDelay(0);
}

/**
 * 单个测试 teardown（在每个测试后运行）
 */
async function afterEachTest(testName = 'unknown') {
  logger.debug({ testName }, 'After each test');
  
  // 恢复数据库快照（可选）
  if (testSnapshotManager && currentSnapshotId && process.env.USE_DB_SNAPSHOT === 'true') {
    await testSnapshotManager.restoreSnapshot(currentSnapshotId);
    currentSnapshotId = null;
    logger.debug('Database snapshot restored');
  }
  
  // 清除所有 timers
  // jest.clearAllTimers();
  
  // 清除所有 mock
  jest.clearAllMocks();
}

/**
 * 初始化数据库快照管理器
 */
function initDatabaseSnapshotManager(config = {}) {
  if (!testSnapshotManager) {
    testSnapshotManager = new DatabaseSnapshotManager(config);
  }
  return testSnapshotManager;
}

/**
 * 获取当前数据库快照管理器
 */
function getDatabaseSnapshotManager() {
  return testSnapshotManager;
}

/**
 * Mock Fetch API
 */
function mockFetch(mockResponses = {}) {
  global.fetch = jest.fn((url, options) => {
    const key = url;
    const response = mockResponses[key];
    
    if (response) {
      return Promise.resolve({
        ok: response.ok !== false,
        status: response.status || 200,
        json: () => Promise.resolve(response.data || response),
        text: () => Promise.resolve(response.text || JSON.stringify(response))
      });
    }
    
    // 默认成功响应
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('')
    });
  });
}

/**
 * Mock Axios
 */
function mockAxios(mockResponses = {}) {
  const axios = require('axios');
  
  axios.get = jest.fn((url, config) => {
    const response = mockResponses[url];
    return Promise.resolve({
      status: response?.status || 200,
      data: response?.data || response || {}
    });
  });
  
  axios.post = jest.fn((url, data, config) => {
    const response = mockResponses[url];
    return Promise.resolve({
      status: response?.status || 200,
      data: response?.data || response || {}
    });
  });
}

/**
 * Mock Redis
 */
function mockRedis() {
  const redisMock = {
    get: jest.fn(() => Promise.resolve(null)),
    set: jest.fn(() => Promise.resolve('OK')),
    del: jest.fn(() => Promise.resolve(1)),
    hget: jest.fn(() => Promise.resolve(null)),
    hset: jest.fn(() => Promise.resolve(1)),
    hgetall: jest.fn(() => Promise.resolve({})),
    expire: jest.fn(() => Promise.resolve(1)),
    ttl: jest.fn(() => Promise.resolve(-1)),
    incr: jest.fn(() => Promise.resolve(1)),
    decr: jest.fn(() => Promise.resolve(-1)),
    publish: jest.fn(() => Promise.resolve(1)),
    subscribe: jest.fn(() => Promise.resolve(1)),
    on: jest.fn(),
    quit: jest.fn(() => Promise.resolve('OK'))
  };
  
  return redisMock;
}

/**
 * Mock Kafka
 */
function mockKafka() {
  const kafkaMock = {
    producer: jest.fn(() => ({
      connect: jest.fn(() => Promise.resolve()),
      send: jest.fn(() => Promise.resolve()),
      disconnect: jest.fn(() => Promise.resolve())
    })),
    consumer: jest.fn(() => ({
      connect: jest.fn(() => Promise.resolve()),
      subscribe: jest.fn(() => Promise.resolve()),
      run: jest.fn(() => Promise.resolve()),
      disconnect: jest.fn(() => Promise.resolve())
    })),
    admin: jest.fn(() => ({
      connect: jest.fn(() => Promise.resolve()),
      createTopics: jest.fn(() => Promise.resolve(true)),
      deleteTopics: jest.fn(() => Promise.resolve()),
      disconnect: jest.fn(() => Promise.resolve())
    }))
  };
  
  return kafkaMock;
}

/**
 * Mock WebSocket
 */
function mockWebSocket() {
  const wsMock = {
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
    readyState: 1 // OPEN
  };
  
  return wsMock;
}

/**
 * 创建 Mock 请求对象
 */
function createMockRequest(overrides = {}) {
  return {
    method: 'GET',
    url: '/test',
    headers: {},
    body: {},
    params: {},
    query: {},
    user: factory.createUser(),
    ip: '127.0.0.1',
    ...overrides
  };
}

/**
 * 创建 Mock 响应对象
 */
function createMockResponse(overrides = {}) {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    
    status: jest.fn((code) => {
      res.statusCode = code;
      return res;
    }),
    
    json: jest.fn((data) => {
      res.body = data;
      return res;
    }),
    
    send: jest.fn((data) => {
      res.body = data;
      return res;
    }),
    
    setHeader: jest.fn((key, value) => {
      res.headers[key] = value;
      return res;
    }),
    
    end: jest.fn(() => res),
    
    ...overrides
  };
  
  return res;
}

/**
 * 等待条件满足（辅助测试异步代码）
 */
async function waitFor(condition, timeout = 5000, interval = 100) {
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

/**
 * 测试辅助函数集合
 */
const testHelpers = {
  // Mock 数据生成
  createUser: factory.createUser.bind(factory),
  createPokemon: factory.createPokemon.bind(factory),
  createGym: factory.createGym.bind(factory),
  createQuest: factory.createQuest.bind(factory),
  createGift: factory.createGift.bind(factory),
  createPaymentOrder: factory.createPaymentOrder.bind(factory),
  
  // Mock 服务
  mockServices,
  mockRepo,
  
  // Mock 外部依赖
  mockFetch,
  mockAxios,
  mockRedis,
  mockKafka,
  mockWebSocket,
  
  // Mock 请求/响应
  createMockRequest,
  createMockResponse,
  
  // 异步辅助
  waitFor,
  
  // 数据库快照
  initDatabaseSnapshotManager,
  getDatabaseSnapshotManager
};

// Jest hooks
beforeAll(async () => {
  await globalSetup();
});

afterAll(async () => {
  await globalTeardown();
});

beforeEach(async () => {
  const testName = expect.getState().currentTestName || 'unknown';
  await beforeEachTest(testName);
});

afterEach(async () => {
  const testName = expect.getState().currentTestName || 'unknown';
  await afterEachTest(testName);
});

// 导出
module.exports = {
  globalSetup,
  globalTeardown,
  beforeEachTest,
  afterEachTest,
  initDatabaseSnapshotManager,
  getDatabaseSnapshotManager,
  mockFetch,
  mockAxios,
  mockRedis,
  mockKafka,
  mockWebSocket,
  createMockRequest,
  createMockResponse,
  waitFor,
  testHelpers
};