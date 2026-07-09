// backend/shared/testUtils/index.js
'use strict';

/**
 * 测试工具模块统一导出
 */

const {
  MockRepository,
  createMockRepository,
  defaultRepository,
  mockRepo
} = require('./mockRepository');

const {
  MockDataFactory,
  factory,
  createFactory
} = require('./MockDataFactory');

const {
  ExternalMockServices,
  mockServices,
  createMockServices
} = require('./ExternalMockServices');

const {
  DatabaseSnapshotManager,
  createSnapshotManager
} = require('./DatabaseSnapshotManager');

const {
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
} = require('./jestSetup');

module.exports = {
  // Mock Repository
  MockRepository,
  createMockRepository,
  defaultRepository,
  mockRepo,
  
  // Mock Data Factory
  MockDataFactory,
  factory,
  createFactory,
  
  // External Mock Services
  ExternalMockServices,
  mockServices,
  createMockServices,
  
  // Database Snapshot Manager
  DatabaseSnapshotManager,
  createSnapshotManager,
  
  // Jest Integration
  globalSetup,
  globalTeardown,
  beforeEachTest,
  afterEachTest,
  initDatabaseSnapshotManager,
  getDatabaseSnapshotManager,
  
  // Mock utilities
  mockFetch,
  mockAxios,
  mockRedis,
  mockKafka,
  mockWebSocket,
  createMockRequest,
  createMockResponse,
  
  // Async helpers
  waitFor,
  
  // Test helpers (convenience object)
  testHelpers
};