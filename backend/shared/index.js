/**
 * backend/shared/index.js
 * 共享模块统一导出入口
 * 
 * 使用方式：
 * const { db, redis, logger } = require('@shared');
 * 或
 * const db = require('@shared/db');
 */

'use strict';

// ============================================================
// 核心基础设施
// ============================================================
const db = require('./db');
const redis = require('./redis');
const logger = require('./logger');
const metrics = require('./metrics');
const { getTracer, initTracing } = require('./tracing');
const HealthChecker = require('./HealthChecker');
const { SloManager } = require('./SloManager');
const { AlertManager } = require('./AlertManager');

// ============================================================
// 数据库相关
// ============================================================
const { 
  getPoolManager, 
  initializePools, 
  shutdownPools,
  getPoolHealth,
  metrics: poolMetrics 
} = require('./DatabasePool');

const {
  query,
  queryOne,
  transaction,
  transactionSerializable
} = require('./db');

const { query: queryWithRetry } = require('./queryWithRetry');

// ============================================================
// 认证与鉴权
// ============================================================
const { 
  generateToken, 
  verifyToken, 
  requireAuth, 
  optionalAuth,
  AppError,
  successResp,
  errorResp 
} = require('./auth');

const { 
  hashPassword, 
  comparePassword, 
  generateApiKey 
} = require('./crypto');

// ============================================================
// 反作弊系统
// ============================================================
const {
  validateLocation,
  checkRateLimit,
  requireTrustScore,
  TRUST_SCORE,
  detectSpeedHack,
  checkGeoFence
} = require('./anti-cheat');

const {
  validateCatchRequest,
  validateBattleRequest
} = require('./anticheat-validator');

const { CaptchaValidator } = require('./CaptchaValidator');
const { CaptchaTrigger } = require('./CaptchaTrigger');
const { CaptchaChallengeGenerator } = require('./CaptchaChallengeGenerator');

// ============================================================
// 容错与降级
// ============================================================
const CircuitBreaker = require('./CircuitBreaker');
const { 
  DegradationManager, 
  degrade, 
  isDegraded 
} = require('./DegradationManager');
const { 
  FailoverController, 
  failover 
} = require('./FailoverController');

// ============================================================
// 服务发现与通信
// ============================================================
const ApiClient = require('./ApiClient');
const { 
  ServiceRegistry, 
  getServiceUrl, 
  registerService 
} = require('./ServiceRegistry');

// ============================================================
// 消息队列
// ============================================================
const { 
  getProducer, 
  publish, 
  publishBatch 
} = require('./kafka');

const BusinessEventProducer = require('./BusinessEventProducer');

// ============================================================
// 缓存与性能
// ============================================================
const {
  getJSON,
  setJSON,
  del,
  getOrSet,
  invalidatePattern
} = require('./redis');

const { 
  CacheWarmer, 
  warmCache 
} = require('./cacheWarmer');

// ============================================================
// 配置中心
// ============================================================
const ConfigCenter = require('./ConfigCenter');

// ============================================================
// 游戏业务服务
// ============================================================
const { habitatService } = require('./habitatService');
const { weatherService } = require('./weatherService');
const { SeasonService } = require('./SeasonService');
const { DayNightService } = require('./DayNightService');

// ============================================================
// 支付相关
// ============================================================
const {
  createOrder,
  verifySignature,
  processPayment
} = require('./payment');

// ============================================================
// 国际化
// ============================================================
const i18n = require('./i18n');

// ============================================================
// 工具类
// ============================================================
const { 
  generateId, 
  sleep, 
  retry, 
  debounce, 
  throttle 
} = require('./utils');

const { 
  haversineDistance, 
  calculateBearing, 
  isWithinRadius 
} = require('./geo');

// ============================================================
// 中间件
// ============================================================
const { requestIdMiddleware } = require('./middleware/requestId');
const { errorHandler, notFoundHandler, asyncHandler } = require('./middleware/errorHandler');

// ============================================================
// 服务工厂（微服务启动器）
// ============================================================
const { ServiceFactory } = require('./ServiceFactory');

// ============================================================
// 测试覆盖率系统
// ============================================================
const testCoverage = require('./testCoverage');

// ============================================================
// 统一导出
// ============================================================
module.exports = {
  // 核心基础设施
  db,
  redis,
  logger,
  metrics,
  tracing: { getTracer, initTracing },
  
  // 数据库
  database: {
    getPoolManager,
    initializePools,
    shutdownPools,
    getPoolHealth,
    poolMetrics,
    query,
    queryOne,
    transaction,
    transactionSerializable,
    queryWithRetry
  },
  
  // 认证鉴权
  auth: {
    generateToken,
    verifyToken,
    requireAuth,
    optionalAuth,
    AppError,
    successResp,
    errorResp,
    hashPassword,
    comparePassword,
    generateApiKey
  },
  
  // 反作弊
  antiCheat: {
    validateLocation,
    checkRateLimit,
    requireTrustScore,
    TRUST_SCORE,
    detectSpeedHack,
    checkGeoFence,
    validateCatchRequest,
    validateBattleRequest,
    CaptchaValidator,
    CaptchaTrigger,
    CaptchaChallengeGenerator
  },
  
  // 容错降级
  resilience: {
    CircuitBreaker,
    DegradationManager,
    degrade,
    isDegraded,
    FailoverController,
    failover
  },
  
  // 服务通信
  communication: {
    ApiClient,
    ServiceRegistry,
    getServiceUrl,
    registerService,
    kafka: { getProducer, publish, publishBatch },
    BusinessEventProducer
  },
  
  // 缓存
  cache: {
    getJSON,
    setJSON,
    del,
    getOrSet,
    invalidatePattern,
    CacheWarmer,
    warmCache
  },
  
  // 配置
  config: {
    ConfigCenter
  },
  
  // 游戏服务
  game: {
    habitatService,
    weatherService,
    SeasonService,
    DayNightService
  },
  
  // 支付
  payment: {
    createOrder,
    verifySignature,
    processPayment
  },
  
  // 国际化
  i18n,
  
  // 工具
  utils: {
    generateId,
    sleep,
    retry,
    debounce,
    throttle,
    geo: { haversineDistance, calculateBearing, isWithinRadius }
  },
  
  // 中间件
  middleware: {
    requestId: requestIdMiddleware,
    errorHandler,
    notFoundHandler,
    asyncHandler
  },
  
  // 服务工厂
  ServiceFactory,
  
  // 监控
  monitoring: {
    HealthChecker,
    SloManager,
    AlertManager
  },
  
  // 测试覆盖率
  testCoverage
};

// ============================================================
// 兼容性导出（逐步迁移后可移除）
// ============================================================
// 这些导出是为了兼容现有的 require('.//xxx') 引用
// 迁移完成后可以删除这部分

// 直接导出常用模块，保持向后兼容
module.exports.DatabasePool = require('./DatabasePool');
module.exports.ServiceFactory = require('./ServiceFactory');
module.exports.CircuitBreaker = require('./CircuitBreaker');
module.exports.ApiClient = require('./ApiClient');
module.exports.ConfigCenter = require('./ConfigCenter');
module.exports.HealthChecker = require('./HealthChecker');
module.exports.BusinessEventProducer = require('./BusinessEventProducer');
module.exports.habitatService = habitatService;
module.exports.weatherService = weatherService;
