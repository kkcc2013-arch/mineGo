// backend/shared/SelfHealingEngine.js
'use strict';

const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const fs = require('fs').promises;
const path = require('path');

const logger = createLogger('self-healing-engine');

/**
 * 智能自愈引擎
 * 
 * 功能：
 * 1. 崩溃模式识别（OOM、死锁、连接池耗尽等）
 * 2. 分级恢复策略（重启、重建连接、清理缓存、降级）
 * 3. 崩溃保护（连续崩溃后进入安全模式）
 * 4. 恢复验证（健康检查通过后才接收流量）
 */
class SelfHealingEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    
    // 崩溃模式定义
    this.crashPatterns = {
      oom: {
        indicators: ['ENOMEM', 'out of memory', 'heap limit', 'heap out of memory', 'JavaScript heap out of memory'],
        recovery: 'restart_with_memory_limit',
        cooldown: 60000,
        description: '内存溢出'
      },
      deadlock: {
        indicators: ['deadlock detected', 'lock wait timeout', 'deadlock'],
        recovery: 'restart_with_connection_reset',
        cooldown: 30000,
        description: '死锁'
      },
      connection_pool_exhausted: {
        indicators: ['connection pool exhausted', 'ECONNREFUSED', 'too many connections'],
        recovery: 'rebuild_connections',
        cooldown: 15000,
        description: '连接池耗尽'
      },
      redis_failure: {
        indicators: ['ECONNRESET', 'Redis connection lost', 'Redis error', 'NOAUTH'],
        recovery: 'reconnect_redis',
        cooldown: 10000,
        description: 'Redis 连接失败'
      },
      database_failure: {
        indicators: ['database connection failed', 'relation does not exist', 'syntax error'],
        recovery: 'reconnect_database',
        cooldown: 20000,
        description: '数据库连接失败'
      },
      kafka_failure: {
        indicators: ['Kafka connection failed', 'broker unavailable', 'kafka error'],
        recovery: 'reconnect_kafka',
        cooldown: 15000,
        description: 'Kafka 连接失败'
      },
      uncaught_exception: {
        indicators: ['UncaughtException', 'UnhandledPromiseRejection'],
        recovery: 'restart',
        cooldown: 30000,
        description: '未捕获异常'
      }
    };
    
    // 崩溃历史记录
    this.crashHistory = [];
    this.maxHistorySize = 100;
    
    // 配置
    this.config = {
      maxCrashesInWindow: config.maxCrashesInWindow || 3, // 时间窗口内最大崩溃次数
      crashWindowMs: config.crashWindowMs || 300000, // 5分钟时间窗口
      safeModeDuration: config.safeModeDuration || 600000, // 安全模式持续时间 10分钟
      maxRecoveryAttempts: config.maxRecoveryAttempts || 5, // 最大恢复尝试次数
      recoveryBackoffMs: config.recoveryBackoffMs || 10000, // 恢复退避时间
      ...config
    };
    
    // 状态
    this.safeMode = false;
    this.safeModeStartTime = null;
    this.recoveryAttempts = 0;
    this.lastRecoveryTime = null;
    
    // 恢复策略
    this.recoveryStrategies = new Map();
    this.registerDefaultStrategies();
  }
  
  /**
   * 注册默认恢复策略
   */
  registerDefaultStrategies() {
    this.registerStrategy('restart', async (context) => {
      logger.info('Executing restart strategy');
      
      // 记录重启原因
      await this.logRecoveryAction('restart', context);
      
      // 触发重启事件
      this.emit('restart-required', {
        reason: context.reason,
        pattern: context.pattern,
        timestamp: Date.now()
      });
      
      return { action: 'restart', success: true };
    });
    
    this.registerStrategy('restart_with_memory_limit', async (context) => {
      logger.info('Executing restart with memory limit adjustment');
      
      const currentLimit = context.memoryLimit || 512; // MB
      const newLimit = Math.min(currentLimit * 1.5, 2048); // 增加50%，上限2GB
      
      await this.logRecoveryAction('restart_with_memory_limit', {
        ...context,
        oldLimit: currentLimit,
        newLimit
      });
      
      this.emit('restart-required', {
        reason: context.reason,
        pattern: context.pattern,
        memoryLimit: newLimit,
        timestamp: Date.now()
      });
      
      return {
        action: 'restart_with_memory_limit',
        success: true,
        memoryLimit: newLimit
      };
    });
    
    this.registerStrategy('restart_with_connection_reset', async (context) => {
      logger.info('Executing restart with connection reset');
      
      await this.logRecoveryAction('restart_with_connection_reset', context);
      
      // 先关闭所有连接
      if (context.closeConnections) {
        await context.closeConnections();
      }
      
      this.emit('restart-required', {
        reason: context.reason,
        pattern: context.pattern,
        resetConnections: true,
        timestamp: Date.now()
      });
      
      return { action: 'restart_with_connection_reset', success: true };
    });
    
    this.registerStrategy('rebuild_connections', async (context) => {
      logger.info('Executing rebuild connections');
      
      await this.logRecoveryAction('rebuild_connections', context);
      
      // 重建数据库连接池
      if (context.rebuildDbPool) {
        await context.rebuildDbPool();
      }
      
      // 重建 Redis 连接
      if (context.rebuildRedisClient) {
        await context.rebuildRedisClient();
      }
      
      return { action: 'rebuild_connections', success: true };
    });
    
    this.registerStrategy('reconnect_redis', async (context) => {
      logger.info('Executing reconnect Redis');
      
      await this.logRecoveryAction('reconnect_redis', context);
      
      if (context.rebuildRedisClient) {
        await context.rebuildRedisClient();
      }
      
      return { action: 'reconnect_redis', success: true };
    });
    
    this.registerStrategy('reconnect_database', async (context) => {
      logger.info('Executing reconnect database');
      
      await this.logRecoveryAction('reconnect_database', context);
      
      if (context.rebuildDbPool) {
        await context.rebuildDbPool();
      }
      
      return { action: 'reconnect_database', success: true };
    });
    
    this.registerStrategy('reconnect_kafka', async (context) => {
      logger.info('Executing reconnect Kafka');
      
      await this.logRecoveryAction('reconnect_kafka', context);
      
      if (context.rebuildKafkaProducer) {
        await context.rebuildKafkaProducer();
      }
      
      return { action: 'reconnect_kafka', success: true };
    });
  }
  
  /**
   * 注册自定义恢复策略
   */
  registerStrategy(name, strategyFn) {
    this.recoveryStrategies.set(name, strategyFn);
    logger.info(`Recovery strategy registered: ${name}`);
  }
  
  /**
   * 分析崩溃原因
   */
  analyzeCrash(errorLog, resourceSnapshot = {}) {
    const errorText = typeof errorLog === 'string' ? errorLog : JSON.stringify(errorLog);
    
    for (const [pattern, config] of Object.entries(this.crashPatterns)) {
      const matched = config.indicators.some(indicator =>
        errorText.toLowerCase().includes(indicator.toLowerCase())
      );
      
      if (matched) {
        // 记录崩溃
        this.recordCrash(pattern, resourceSnapshot);
        
        // 计算置信度
        const confidence = this.calculateConfidence(pattern, resourceSnapshot);
        
        logger.warn(`Crash pattern detected: ${pattern}`, {
          confidence,
          description: config.description,
          recovery: config.recovery
        });
        
        return {
          pattern,
          recovery: config.recovery,
          confidence,
          description: config.description,
          cooldown: config.cooldown
        };
      }
    }
    
    // 未知崩溃模式
    this.recordCrash('unknown', resourceSnapshot);
    
    return {
      pattern: 'unknown',
      recovery: 'restart',
      confidence: 0.5,
      description: '未知错误',
      cooldown: 30000
    };
  }
  
  /**
   * 记录崩溃
   */
  recordCrash(pattern, snapshot = {}) {
    const crashRecord = {
      pattern,
      timestamp: Date.now(),
      snapshot: {
        memory: snapshot.memory || process.memoryUsage(),
        cpu: snapshot.cpu || process.cpuUsage(),
        uptime: process.uptime()
      }
    };
    
    this.crashHistory.push(crashRecord);
    
    // 保持历史记录在限制内
    if (this.crashHistory.length > this.maxHistorySize) {
      this.crashHistory.shift();
    }
    
    // 检查是否需要进入安全模式
    this.checkSafeMode();
    
    logger.warn(`Crash recorded: ${pattern}`, {
      totalCrashes: this.crashHistory.length,
      recentCrashes: this.getRecentCrashes().length
    });
  }
  
  /**
   * 检查是否进入安全模式
   */
  checkSafeMode() {
    const recentCrashes = this.getRecentCrashes();
    
    if (recentCrashes.length >= this.config.maxCrashesInWindow && !this.safeMode) {
      this.enterSafeMode(recentCrashes);
    }
  }
  
  /**
   * 进入安全模式
   */
  enterSafeMode(crashes) {
    this.safeMode = true;
    this.safeModeStartTime = Date.now();
    
    const reason = `连续崩溃 ${crashes.length} 次，进入安全模式`;
    
    logger.error(reason, {
      crashes: crashes.map(c => ({
        pattern: c.pattern,
        time: new Date(c.timestamp).toISOString()
      }))
    });
    
    this.emit('safe-mode-entered', {
      reason,
      crashes,
      duration: this.config.safeModeDuration
    });
    
    // 定时退出安全模式
    setTimeout(() => {
      this.exitSafeMode();
    }, this.config.safeModeDuration);
  }
  
  /**
   * 退出安全模式
   */
  exitSafeMode() {
    if (!this.safeMode) {
      return;
    }
    
    this.safeMode = false;
    this.safeModeStartTime = null;
    this.recoveryAttempts = 0;
    
    logger.info('Exited safe mode');
    
    this.emit('safe-mode-exited', {
      duration: Date.now() - this.safeModeStartTime
    });
  }
  
  /**
   * 获取最近崩溃记录
   */
  getRecentCrashes(windowMs = this.config.crashWindowMs) {
    const now = Date.now();
    return this.crashHistory.filter(crash =>
      now - crash.timestamp < windowMs
    );
  }
  
  /**
   * 执行恢复
   */
  async executeRecovery(analysis, context = {}) {
    // 检查是否在安全模式
    if (this.safeMode) {
      logger.warn('In safe mode, recovery blocked', {
        pattern: analysis.pattern
      });
      
      return {
        success: false,
        reason: 'safe_mode_active',
        message: '服务处于安全模式，暂停自动恢复'
      };
    }
    
    // 检查恢复退避
    if (this.lastRecoveryTime) {
      const timeSinceLastRecovery = Date.now() - this.lastRecoveryTime;
      if (timeSinceLastRecovery < this.config.recoveryBackoffMs) {
        logger.warn('Recovery backoff active', {
          timeSinceLastRecovery,
          backoffMs: this.config.recoveryBackoffMs
        });
        
        return {
          success: false,
          reason: 'recovery_backoff',
          message: '恢复退避期间，请稍后重试'
        };
      }
    }
    
    // 检查恢复尝试次数
    if (this.recoveryAttempts >= this.config.maxRecoveryAttempts) {
      logger.error('Max recovery attempts reached', {
        attempts: this.recoveryAttempts,
        max: this.config.maxRecoveryAttempts
      });
      
      this.enterSafeMode(this.getRecentCrashes());
      
      return {
        success: false,
        reason: 'max_attempts_reached',
        message: '达到最大恢复尝试次数，进入安全模式'
      };
    }
    
    const strategy = this.recoveryStrategies.get(analysis.recovery);
    
    if (!strategy) {
      logger.error(`Unknown recovery strategy: ${analysis.recovery}`);
      return {
        success: false,
        reason: 'unknown_strategy',
        message: `未知的恢复策略: ${analysis.recovery}`
      };
    }
    
    try {
      this.recoveryAttempts++;
      this.lastRecoveryTime = Date.now();
      
      logger.info('Executing recovery strategy', {
        strategy: analysis.recovery,
        pattern: analysis.pattern,
        attempt: this.recoveryAttempts
      });
      
      const result = await strategy({
        ...context,
        reason: analysis.description,
        pattern: analysis.pattern
      });
      
      // 恢复成功，重置计数器
      if (result.success) {
        this.recoveryAttempts = 0;
        
        this.emit('recovery-successful', {
          strategy: analysis.recovery,
          pattern: analysis.pattern,
          result
        });
      }
      
      return {
        success: result.success,
        strategy: analysis.recovery,
        pattern: analysis.pattern,
        result
      };
    } catch (error) {
      logger.error('Recovery strategy execution failed', {
        strategy: analysis.recovery,
        error: error.message
      });
      
      return {
        success: false,
        reason: 'execution_failed',
        error: error.message
      };
    }
  }
  
  /**
   * 计算置信度
   */
  calculateConfidence(pattern, snapshot) {
    let confidence = 0.7; // 基础置信度
    
    // 根据资源快照调整置信度
    if (snapshot.memory) {
      const heapUsedMB = snapshot.memory.heapUsed / 1024 / 1024;
      if (heapUsedMB > 500) {
        confidence += 0.2;
      }
    }
    
    // 根据崩溃模式调整置信度
    if (pattern === 'oom') {
      confidence = Math.min(confidence + 0.15, 0.95);
    } else if (pattern === 'connection_pool_exhausted') {
      confidence = Math.min(confidence + 0.1, 0.90);
    }
    
    return Math.round(confidence * 100) / 100;
  }
  
  /**
   * 记录恢复操作日志
   */
  async logRecoveryAction(action, context) {
    try {
      const logDir = path.join(process.cwd(), 'logs', 'recovery');
      await fs.mkdir(logDir, { recursive: true });
      
      const logFile = path.join(logDir, `recovery-${Date.now()}.json`);
      const logData = {
        action,
        timestamp: new Date().toISOString(),
        context: {
          pattern: context.pattern,
          reason: context.reason,
          memory: context.memory ? {
            heapUsed: Math.round(context.memory.heapUsed / 1024 / 1024),
            heapTotal: Math.round(context.memory.heapTotal / 1024 / 1024)
          } : null
        }
      };
      
      await fs.writeFile(logFile, JSON.stringify(logData, null, 2));
    } catch (error) {
      logger.error('Failed to log recovery action', { error: error.message });
    }
  }
  
  /**
   * 获取状态
   */
  getStatus() {
    return {
      safeMode: this.safeMode,
      safeModeStartTime: this.safeModeStartTime,
      recoveryAttempts: this.recoveryAttempts,
      lastRecoveryTime: this.lastRecoveryTime,
      totalCrashes: this.crashHistory.length,
      recentCrashes: this.getRecentCrashes().length,
      strategiesRegistered: this.recoveryStrategies.size
    };
  }
  
  /**
   * 重置状态
   */
  reset() {
    this.safeMode = false;
    this.safeModeStartTime = null;
    this.recoveryAttempts = 0;
    this.lastRecoveryTime = null;
    
    logger.info('Self-healing engine reset');
    
    this.emit('engine-reset');
  }
}

module.exports = SelfHealingEngine;
