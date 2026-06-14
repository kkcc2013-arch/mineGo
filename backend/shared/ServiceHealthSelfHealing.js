// backend/shared/ServiceHealthSelfHealing.js
'use strict';

const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const HealthChecker = require('./HealthChecker');
const SelfHealingEngine = require('./SelfHealingEngine');
const ServiceIsolationManager = require('./ServiceIsolationManager');
const TrafficGradualRecovery = require('./TrafficGradualRecovery');
const RootCauseAnalyzer = require('./RootCauseAnalyzer');

const logger = createLogger('service-health-self-healing');

/**
 * 服务健康自愈与自动恢复系统
 * 
 * REQ-00159: 统一管理所有自愈组件
 * 
 * 功能：
 * 1. 多层级健康检查
 * 2. 智能自愈引擎
 * 3. 服务隔离管理
 * 4. 渐进式恢复
 * 5. 自动化根因分析
 */
class ServiceHealthSelfHealing extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.serviceName = config.serviceName || 'unknown-service';
    this.config = {
      enableHealthCheck: config.enableHealthCheck !== false,
      enableSelfHealing: config.enableSelfHealing !== false,
      enableIsolation: config.enableIsolation !== false,
      enableGradualRecovery: config.enableGradualRecovery !== false,
      enableRootCauseAnalysis: config.enableRootCauseAnalysis !== false,
      ...config
    };
    
    // 初始化组件
    this.healthChecker = null;
    this.selfHealingEngine = null;
    this.isolationManager = null;
    this.gradualRecovery = null;
    this.rootCauseAnalyzer = null;
    
    // 状态
    this.isInitialized = false;
    this.crashCount = 0;
    this.lastCrashTime = null;
    
    // 初始化
    this.initialize();
  }
  
  /**
   * 初始化所有组件
   */
  initialize() {
    logger.info('Initializing service health self-healing system', {
      serviceName: this.serviceName
    });
    
    // 1. 初始化健康检查器
    if (this.config.enableHealthCheck) {
      this.healthChecker = new HealthChecker({
        serviceName: this.serviceName,
        ...this.config.healthChecker
      });
      
      // 监听健康检查事件
      this.healthChecker.on('health-degraded', (results) => {
        this.handleHealthDegraded(results);
      });
      
      logger.info('Health checker initialized');
    }
    
    // 2. 初始化自愈引擎
    if (this.config.enableSelfHealing) {
      this.selfHealingEngine = new SelfHealingEngine({
        ...this.config.selfHealingEngine
      });
      
      // 监听自愈事件
      this.selfHealingEngine.on('safe-mode-entered', (data) => {
        this.handleSafeModeEntered(data);
      });
      
      this.selfHealingEngine.on('recovery-successful', (data) => {
        this.handleRecoverySuccessful(data);
      });
      
      this.selfHealingEngine.on('restart-required', async (data) => {
        await this.handleRestartRequired(data);
      });
      
      logger.info('Self-healing engine initialized');
    }
    
    // 3. 初始化服务隔离管理器
    if (this.config.enableIsolation) {
      this.isolationManager = new ServiceIsolationManager({
        healthChecker: this.healthChecker,
        ...this.config.isolationManager
      });
      
      // 监听隔离事件
      this.isolationManager.on('service-isolated', (data) => {
        this.handleServiceIsolated(data);
      });
      
      this.isolationManager.on('service-recovered', (data) => {
        this.handleServiceRecovered(data);
      });
      
      logger.info('Service isolation manager initialized');
    }
    
    // 4. 初始化渐进式恢复系统
    if (this.config.enableGradualRecovery) {
      this.gradualRecovery = new TrafficGradualRecovery({
        healthChecker: this.healthChecker,
        ...this.config.gradualRecovery
      });
      
      // 监听恢复事件
      this.gradualRecovery.on('recovery-completed', (data) => {
        this.handleRecoveryCompleted(data);
      });
      
      this.gradualRecovery.on('recovery-aborted', (data) => {
        this.handleRecoveryAborted(data);
      });
      
      logger.info('Gradual recovery system initialized');
    }
    
    // 5. 初始化根因分析器
    if (this.config.enableRootCauseAnalysis) {
      this.rootCauseAnalyzer = new RootCauseAnalyzer({
        ...this.config.rootCauseAnalyzer
      });
      
      logger.info('Root cause analyzer initialized');
    }
    
    // 设置全局错误处理
    this.setupGlobalErrorHandlers();
    
    this.isInitialized = true;
    
    logger.info('Service health self-healing system initialized successfully');
  }
  
  /**
   * 设置全局错误处理器
   */
  setupGlobalErrorHandlers() {
    // 未捕获异常处理
    process.on('uncaughtException', async (error) => {
      logger.error('Uncaught exception detected', {
        error: error.message,
        stack: error.stack
      });
      
      await this.handleCrash(error, 'uncaught_exception');
    });
    
    // 未处理的 Promise 拒绝
    process.on('unhandledRejection', async (reason, promise) => {
      logger.error('Unhandled promise rejection', {
        reason: reason?.message || reason
      });
      
      await this.handleCrash(reason, 'unhandled_promise_rejection');
    });
    
    // SIGTERM 信号处理
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down gracefully');
      await this.shutdown();
    });
    
    // SIGINT 信号处理
    process.on('SIGINT', async () => {
      logger.info('SIGINT received, shutting down gracefully');
      await this.shutdown();
    });
  }
  
  /**
   * 注册健康检查项
   */
  registerHealthCheck(name, checkFn, options = {}) {
    if (!this.healthChecker) {
      logger.warn('Health checker not enabled');
      return;
    }
    
    this.healthChecker.register(name, checkFn, options);
  }
  
  /**
   * 启动定期健康检查
   */
  startHealthChecks() {
    if (!this.healthChecker) {
      return;
    }
    
    this.healthChecker.startPeriodicCheck();
    logger.info('Health checks started');
  }
  
  /**
   * 停止定期健康检查
   */
  stopHealthChecks() {
    if (!this.healthChecker) {
      return;
    }
    
    this.healthChecker.stopPeriodicCheck();
    logger.info('Health checks stopped');
  }
  
  /**
   * 处理崩溃
   */
  async handleCrash(error, type = 'unknown') {
    this.crashCount++;
    this.lastCrashTime = Date.now();
    
    logger.error('Service crash detected', {
      type,
      error: error?.message,
      crashCount: this.crashCount
    });
    
    // 分析崩溃
    if (this.selfHealingEngine) {
      const analysis = this.selfHealingEngine.analyzeCrash(
        error?.message || String(error),
        {
          memory: process.memoryUsage(),
          cpu: process.cpuUsage(),
          type
        }
      );
      
      // 执行恢复
      const recoveryResult = await this.selfHealingEngine.executeRecovery(analysis, {
        memoryLimit: process.env.MEMORY_LIMIT || 512,
        closeConnections: () => this.closeConnections(),
        rebuildDbPool: () => this.rebuildDbPool(),
        rebuildRedisClient: () => this.rebuildRedisClient()
      });
      
      if (!recoveryResult.success) {
        logger.error('Recovery failed', { result: recoveryResult });
        
        // 如果恢复失败，考虑隔离服务
        if (this.isolationManager) {
          await this.isolationManager.isolate(this.serviceName, recoveryResult.message || 'Recovery failed');
        }
      }
    }
    
    // 生成根因分析报告
    if (this.rootCauseAnalyzer) {
      await this.rootCauseAnalyzer.generateReport(
        this.serviceName,
        Date.now(),
        { notify: true }
      );
    }
    
    this.emit('crash-handled', {
      type,
      crashCount: this.crashCount,
      timestamp: Date.now()
    });
  }
  
  /**
   * 处理健康状态降级
   */
  handleHealthDegraded(results) {
    logger.warn('Service health degraded', {
      status: results.status,
      degradedServices: results.degradedServices
    });
    
    this.emit('health-degraded', results);
  }
  
  /**
   * 处理安全模式进入
   */
  handleSafeModeEntered(data) {
    logger.error('Service entered safe mode', data);
    
    // 在安全模式下，暂停接受新流量
    if (this.isolationManager) {
      this.isolationManager.isolate(this.serviceName, data.reason);
    }
    
    this.emit('safe-mode-entered', data);
  }
  
  /**
   * 处理恢复成功
   */
  handleRecoverySuccessful(data) {
    logger.info('Recovery successful', data);
    
    // 启动渐进式恢复
    if (this.gradualRecovery) {
      const health = this.healthChecker ? 
        this.healthChecker.getLastResults() : 
        { score: 0.8 };
      
      this.gradualRecovery.startRecovery(this.serviceName, health);
    }
    
    this.emit('recovery-successful', data);
  }
  
  /**
   * 处理重启请求
   */
  async handleRestartRequired(data) {
    logger.warn('Restart required', data);
    
    // 记录重启原因
    this.emit('restart-required', data);
    
    // 在实际生产环境中，这里应该通知 K8s 或进程管理器进行重启
    // 这里仅记录日志
    logger.info('Restart requested - in production, this would trigger a service restart');
  }
  
  /**
   * 处理服务隔离
   */
  handleServiceIsolated(data) {
    logger.error('Service isolated', data);
    
    this.emit('service-isolated', data);
  }
  
  /**
   * 处理服务恢复
   */
  handleServiceRecovered(data) {
    logger.info('Service recovered from isolation', data);
    
    this.emit('service-recovered', data);
  }
  
  /**
   * 处理恢复完成
   */
  handleRecoveryCompleted(data) {
    logger.info('Gradual recovery completed', data);
    
    // 重置崩溃计数
    this.crashCount = 0;
    
    this.emit('recovery-completed', data);
  }
  
  /**
   * 处理恢复中止
   */
  handleRecoveryAborted(data) {
    logger.error('Gradual recovery aborted', data);
    
    this.emit('recovery-aborted', data);
  }
  
  /**
   * 关闭所有连接（恢复策略使用）
   */
  async closeConnections() {
    logger.info('Closing all connections');
    
    // 子类应该重写此方法以关闭实际连接
    return true;
  }
  
  /**
   * 重建数据库连接池（恢复策略使用）
   */
  async rebuildDbPool() {
    logger.info('Rebuilding database connection pool');
    
    // 子类应该重写此方法以重建连接池
    return true;
  }
  
  /**
   * 重建 Redis 客户端（恢复策略使用）
   */
  async rebuildRedisClient() {
    logger.info('Rebuilding Redis client');
    
    // 子类应该重写此方法以重建 Redis 连接
    return true;
  }
  
  /**
   * 获取系统状态
   */
  getStatus() {
    const status = {
      serviceName: this.serviceName,
      isInitialized: this.isInitialized,
      crashCount: this.crashCount,
      lastCrashTime: this.lastCrashTime,
      timestamp: new Date().toISOString()
    };
    
    if (this.healthChecker) {
      status.health = this.healthChecker.getLastResults();
      status.healthStats = this.healthChecker.getStats();
    }
    
    if (this.selfHealingEngine) {
      status.selfHealing = this.selfHealingEngine.getStatus();
    }
    
    if (this.isolationManager) {
      status.isolation = this.isolationManager.getStats();
    }
    
    if (this.gradualRecovery) {
      status.recovery = this.gradualRecovery.getRecoveryStatus(this.serviceName);
    }
    
    return status;
  }
  
  /**
   * 手动触发健康检查
   */
  async triggerHealthCheck() {
    if (!this.healthChecker) {
      return null;
    }
    
    return await this.healthChecker.runAllChecks();
  }
  
  /**
   * 手动触发恢复
   */
  async triggerRecovery() {
    if (!this.gradualRecovery) {
      return { success: false, reason: 'Gradual recovery not enabled' };
    }
    
    const health = await this.triggerHealthCheck();
    return await this.gradualRecovery.startRecovery(this.serviceName, health);
  }
  
  /**
   * 关闭系统
   */
  async shutdown() {
    logger.info('Shutting down service health self-healing system');
    
    // 停止健康检查
    this.stopHealthChecks();
    
    // 清理资源
    if (this.isolationManager) {
      this.isolationManager.cleanup();
    }
    
    if (this.gradualRecovery) {
      this.gradualRecovery.cleanup();
    }
    
    this.emit('shutdown', {
      serviceName: this.serviceName,
      timestamp: Date.now()
    });
    
    logger.info('Service health self-healing system shutdown complete');
  }
}

module.exports = ServiceHealthSelfHealing;
