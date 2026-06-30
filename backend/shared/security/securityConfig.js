// backend/shared/security/securityConfig.js
// REQ-00394: 安全配置集成

'use strict';

const { SensitiveDataMasker } = require('../SensitiveDataMasker');
const { LogSecurityMiddleware } = require('../middleware/logSecurityMiddleware');
const { sensitiveDataFilter } = require('../middleware/sensitiveDataFilter');
const { createLogger } = require('../logger');

const logger = createLogger('security-config');

/**
 * 安全配置管理器
 */
class SecurityConfig {
  constructor() {
    this.masker = null;
    this.logSecurity = null;
    this.initialized = false;
  }

  /**
   * 初始化安全组件
   */
  initialize(options = {}) {
    if (this.initialized) {
      logger.warn('SecurityConfig already initialized');
      return this;
    }

    const config = {
      enableMasking: options.enableMasking !== false,
      enableLogSecurity: options.enableLogSecurity !== false,
      enableRequestFilter: options.enableRequestFilter !== false,
      auditEnabled: options.auditEnabled !== false,
      mode: options.mode || process.env.NODE_ENV || 'production',
      ...options
    };

    // 初始化敏感数据脱敏器
    this.masker = new SensitiveDataMasker({
      auditEnabled: config.auditEnabled,
      mode: config.mode
    });

    // 初始化日志安全中间件
    if (config.enableLogSecurity) {
      this.logSecurity = new LogSecurityMiddleware({
        enabled: config.enableMasking,
        mode: config.mode,
        auditEnabled: config.auditEnabled
      });
    }

    this.initialized = true;

    logger.info('SecurityConfig initialized', {
      enableMasking: config.enableMasking,
      enableLogSecurity: config.enableLogSecurity,
      enableRequestFilter: config.enableRequestFilter,
      auditEnabled: config.auditEnabled,
      mode: config.mode
    });

    return this;
  }

  /**
   * 获取请求过滤中间件
   */
  getRequestFilterMiddleware(options = {}) {
    if (!this.initialized) {
      this.initialize();
    }

    return sensitiveDataFilter({
      masker: this.masker,
      ...options
    });
  }

  /**
   * 获取日志安全中间件
   */
  getLogSecurityMiddleware() {
    if (!this.initialized) {
      this.initialize();
    }

    return this.logSecurity;
  }

  /**
   * 获取脱敏器实例
   */
  getMasker() {
    if (!this.initialized) {
      this.initialize();
    }

    return this.masker;
  }

  /**
   * 拦截 Logger
   */
  interceptLogger(targetLogger) {
    if (!this.initialized) {
      this.initialize();
    }

    if (this.logSecurity) {
      this.logSecurity.interceptLogger(targetLogger);
    }

    return this;
  }

  /**
   * 获取安全统计信息
   */
  getStats() {
    if (!this.initialized) {
      return { initialized: false };
    }

    return {
      initialized: true,
      masker: this.masker.getStats(),
      logSecurity: this.logSecurity ? this.logSecurity.getInterceptStats() : null
    };
  }
}

// 单例实例
const securityConfig = new SecurityConfig();

/**
 * 初始化安全配置
 */
function initializeSecurity(options = {}) {
  return securityConfig.initialize(options);
}

/**
 * 获取安全中间件
 */
function getSecurityMiddleware(options = {}) {
  return securityConfig.getRequestFilterMiddleware(options);
}

/**
 * 拦截 Logger
 */
function interceptLogger(logger) {
  return securityConfig.interceptLogger(logger);
}

/**
 * 获取脱敏器
 */
function getMasker() {
  return securityConfig.getMasker();
}

/**
 * 获取安全统计
 */
function getSecurityStats() {
  return securityConfig.getStats();
}

/**
 * 为 Express 应用配置安全中间件
 */
function setupSecurityMiddleware(app, options = {}) {
  // 初始化安全配置
  initializeSecurity(options);

  // 应用请求过滤中间件
  app.use(getSecurityMiddleware(options));

  // 拦截 logger
  const appLogger = options.logger || require('../logger').createLogger(options.serviceName || 'app');
  interceptLogger(appLogger);

  logger.info('Security middleware setup complete', {
    serviceName: options.serviceName
  });

  return securityConfig;
}

/**
 * 为 ServiceLauncher 配置安全中间件
 */
function setupSecurityForServiceLauncher(serviceLauncher, options = {}) {
  const serviceName = serviceLauncher.config.serviceName || 'unknown';

  return setupSecurityMiddleware(serviceLauncher.app, {
    serviceName,
    ...options
  });
}

module.exports = {
  SecurityConfig,
  securityConfig,
  initializeSecurity,
  getSecurityMiddleware,
  interceptLogger,
  getMasker,
  getSecurityStats,
  setupSecurityMiddleware,
  setupSecurityForServiceLauncher
};