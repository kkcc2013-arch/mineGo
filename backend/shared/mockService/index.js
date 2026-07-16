// mockService/index.js - API Mock 服务与测试隔离系统入口
'use strict';

/**
 * REQ-00546: API Mock 服务与测试隔离系统
 * 
 * 特性：
 * - Mock 服务引擎：轻量级 HTTP/WebSocket Mock 服务器
 * - 服务虚拟化：为 9 个微服务提供虚拟化版本
 * - 测试数据工厂：统一的测试数据生成器
 * - 响应录制器：记录真实服务响应用于回放
 * - CI/CD 集成：GitHub Actions 中启用 Mock 模式
 * - 开发工具：本地 Mock 服务管理 CLI
 */

const MockServer = require('./core/MockServer');
const VirtualServiceManager = require('./managers/VirtualServiceManager');
const DataFactory = require('./factories/DataFactory');
const ResponseRecorder = require('./recorders/ResponseRecorder');
const MockConfig = require('./core/MockConfig');

// 单例实例
let mockServerInstance = null;
let virtualServiceManagerInstance = null;
let dataFactoryInstance = null;
let responseRecorderInstance = null;

/**
 * 初始化 Mock 服务系统
 * @param {Object} config - 配置选项
 * @returns {Object} Mock 服务实例集合
 */
function initialize(config = {}) {
  const defaultConfig = {
    port: process.env.MOCK_PORT || 9000,
    mode: process.env.MOCK_MODE || 'replay', // 'replay' | 'record' | 'passthrough'
    enableRecording: process.env.MOCK_RECORD === 'true',
    dataSeed: process.env.MOCK_DATA_SEED || Date.now(),
    ...config
  };

  // 初始化各个组件
  mockServerInstance = new MockServer(defaultConfig);
  virtualServiceManagerInstance = new VirtualServiceManager(defaultConfig);
  dataFactoryInstance = new DataFactory(defaultConfig);
  responseRecorderInstance = new ResponseRecorder(defaultConfig);

  return {
    mockServer: mockServerInstance,
    virtualServiceManager: virtualServiceManagerInstance,
    dataFactory: dataFactoryInstance,
    responseRecorder: responseRecorderInstance,
    config: new MockConfig(defaultConfig)
  };
}

/**
 * 获取 Mock 服务器实例
 */
function getMockServer() {
  if (!mockServerInstance) {
    throw new Error('Mock service not initialized. Call initialize() first.');
  }
  return mockServerInstance;
}

/**
 * 获取虚拟服务管理器实例
 */
function getVirtualServiceManager() {
  if (!virtualServiceManagerInstance) {
    throw new Error('Mock service not initialized. Call initialize() first.');
  }
  return virtualServiceManagerInstance;
}

/**
 * 获取数据工厂实例
 */
function getDataFactory() {
  if (!dataFactoryInstance) {
    throw new Error('Mock service not initialized. Call initialize() first.');
  }
  return dataFactoryInstance;
}

/**
 * 获取响应录制器实例
 */
function getResponseRecorder() {
  if (!responseRecorderInstance) {
    throw new Error('Mock service not initialized. Call initialize() first.');
  }
  return responseRecorderInstance;
}

/**
 * 启动 Mock 服务
 */
async function startMockServices(config = {}) {
  const instances = initialize(config);
  
  // 启动 Mock 服务器
  await instances.mockServer.start();
  
  // 初始化虚拟服务
  await instances.virtualServiceManager.initialize();
  
  return instances;
}

/**
 * 停止 Mock 服务
 */
async function stopMockServices() {
  if (mockServerInstance) {
    await mockServerInstance.stop();
  }
  
  if (virtualServiceManagerInstance) {
    await virtualServiceManagerInstance.shutdown();
  }
  
  if (responseRecorderInstance) {
    await responseRecorderInstance.flush();
  }
}

module.exports = {
  initialize,
  getMockServer,
  getVirtualServiceManager,
  getDataFactory,
  getResponseRecorder,
  startMockServices,
  stopMockServices,
  
  // 导出类供直接使用
  MockServer,
  VirtualServiceManager,
  DataFactory,
  ResponseRecorder,
  MockConfig
};