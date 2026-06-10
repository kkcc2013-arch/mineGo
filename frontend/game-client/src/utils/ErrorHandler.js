// frontend/game-client/src/utils/ErrorHandler.js - 前端统一错误处理工具
'use strict';

/**
 * 前端错误处理工具类
 * 统一处理 API 错误响应，提供本地化错误信息和友好的用户提示
 */

// 错误配置（从后端同步的关键错误码）
const ERROR_CONFIGS = {
  // 认证错误
  'G1-001-001': { retryable: false, severity: 'warning', toast: true },
  'G1-001-002': { retryable: false, severity: 'warning', toast: true, redirect: '/login' },
  'G1-001-003': { retryable: false, severity: 'warning', toast: true, redirect: '/login' },
  'G1-001-004': { retryable: false, severity: 'warning', toast: true },
  
  // 限流错误
  'G1-002-001': { retryable: true, severity: 'warning', toast: true, retryAfter: true },
  'G1-002-002': { retryable: true, severity: 'critical', toast: true },
  
  // 用户错误
  'U2-001-001': { retryable: false, severity: 'warning', toast: true },
  'U2-001-004': { retryable: false, severity: 'warning', toast: true },
  'U2-001-005': { retryable: false, severity: 'critical', toast: true, redirect: '/banned' },
  'U2-001-006': { retryable: false, severity: 'warning', toast: true },
  
  // 捕捉错误
  'C5-001-001': { retryable: true, severity: 'info', toast: true },
  'C5-001-002': { retryable: false, severity: 'warning', toast: true },
  'C5-001-004': { retryable: false, severity: 'critical', toast: true },
  
  // 支付错误
  'P9-001-001': { retryable: false, severity: 'warning', toast: true },
  'P9-001-005': { retryable: true, severity: 'warning', toast: true },
};

class ErrorHandler {
  constructor() {
    this.i18n = null;
    this.toastManager = null;
    this.router = null;
  }
  
  /**
   * 初始化错误处理器
   */
  init(options = {}) {
    this.i18n = options.i18n;
    this.toastManager = options.toastManager;
    this.router = options.router;
  }
  
  /**
   * 处理 API 错误响应
   */
  handle(error, options = {}) {
    // 解析错误
    const errorInfo = this.parseError(error);
    
    // 获取错误配置
    const config = ERROR_CONFIGS[errorInfo.code] || { 
      retryable: false, 
      severity: 'warning', 
      toast: true 
    };
    
    // 获取本地化消息
    const message = this.getLocalizedMessage(errorInfo, options.locale);
    
    // 显示提示
    if (config.toast && !options.silent) {
      this.showNotification(message, config.severity, errorInfo.code);
    }
    
    // 处理重定向
    if (config.redirect && !options.noRedirect) {
      this.redirectTo(config.redirect);
    }
    
    // 返回错误信息
    return {
      handled: true,
      code: errorInfo.code,
      message,
      retryable: config.retryable,
      severity: config.severity,
      details: errorInfo.details,
      requestId: errorInfo.requestId,
    };
  }
  
  /**
   * 解析错误响应
   */
  parseError(error) {
    // 标准错误格式
    if (error?.error?.code) {
      return {
        code: error.error.code,
        message: error.error.message,
        messageKey: error.error.messageKey,
        details: error.error.details || {},
        requestId: error.error.requestId,
        docUrl: error.error.docUrl,
        retryable: error.error.retryable,
        severity: error.error.severity,
      };
    }
    
    // Axios 错误
    if (error?.response?.data?.error) {
      return this.parseError(error.response.data);
    }
    
    // Fetch 错误
    if (error?.status && error?.json) {
      return {
        code: 'G1-003-999',
        message: error.statusText || 'Network error',
        messageKey: 'error.network.error',
        details: { status: error.status },
        requestId: null,
        severity: 'critical',
        retryable: true,
      };
    }
    
    // 未知错误格式
    return {
      code: 'G1-003-999',
      message: error?.message || 'Unknown error',
      messageKey: 'error.system.internal_error',
      details: {},
      requestId: null,
      severity: 'critical',
      retryable: false,
    };
  }
  
  /**
   * 获取本地化错误消息
   */
  getLocalizedMessage(errorInfo, locale) {
    if (!this.i18n) {
      return errorInfo.message;
    }
    
    // 尝试从 messageKey 获取翻译
    if (errorInfo.messageKey) {
      const translated = this.i18n.t(errorInfo.messageKey, { 
        defaultValue: errorInfo.message,
        ...errorInfo.details,
      });
      return translated;
    }
    
    return errorInfo.message;
  }
  
  /**
   * 显示通知
   */
  showNotification(message, severity, code) {
    if (!this.toastManager) {
      // 降级到 alert
      alert(message);
      return;
    }
    
    const notificationType = this.severityToNotificationType(severity);
    
    this.toastManager.show({
      type: notificationType,
      message,
      duration: severity === 'critical' ? 10000 : 5000,
      code,
    });
  }
  
  /**
   * 严重程度转通知类型
   */
  severityToNotificationType(severity) {
    switch (severity) {
      case 'critical':
        return 'error';
      case 'warning':
        return 'warning';
      case 'info':
        return 'info';
      default:
        return 'warning';
    }
  }
  
  /**
   * 重定向到指定页面
   */
  redirectTo(path) {
    if (this.router) {
      this.router.push(path);
    } else if (typeof window !== 'undefined') {
      window.location.href = path;
    }
  }
  
  /**
   * 是否可重试
   */
  isRetryable(error) {
    const errorInfo = this.parseError(error);
    const config = ERROR_CONFIGS[errorInfo.code];
    return config?.retryable || errorInfo.retryable || false;
  }
  
  /**
   * 获取重试等待时间（秒）
   */
  getRetryAfter(error) {
    const errorInfo = this.parseError(error);
    return errorInfo.details?.retryAfter || 60;
  }
  
  /**
   * 创建错误对象
   */
  createError(code, details = {}) {
    return {
      error: {
        code,
        message: this.i18n?.t(`error.${code.replace(/-/g, '_')}`) || code,
        details,
      },
    };
  }
  
  /**
   * 异步操作包装器
   */
  async wrapAsync(promise, options = {}) {
    try {
      const result = await promise;
      return { success: true, data: result };
    } catch (error) {
      const handled = this.handle(error, options);
      return { success: false, error: handled };
    }
  }
  
  /**
   * 显示重试对话框
   */
  showRetryDialog(error, onRetry, onCancel) {
    const message = this.getLocalizedMessage(this.parseError(error));
    const retryAfter = this.getRetryAfter(error);
    
    const result = confirm(`${message}\n\n点击"确定"重试，点击"取消"放弃。`);
    
    if (result) {
      setTimeout(onRetry, retryAfter * 1000);
    } else if (onCancel) {
      onCancel();
    }
  }
  
  /**
   * 格式化错误用于日志
   */
  formatForLog(error) {
    const errorInfo = this.parseError(error);
    return JSON.stringify({
      code: errorInfo.code,
      message: errorInfo.message,
      requestId: errorInfo.requestId,
      timestamp: new Date().toISOString(),
    }, null, 2);
  }
}

// 导出单例
const errorHandler = new ErrorHandler();

// 便捷函数
function handleError(error, options) {
  return errorHandler.handle(error, options);
}

function isRetryable(error) {
  return errorHandler.isRetryable(error);
}

function getLocalizedMessage(error, locale) {
  return errorHandler.getLocalizedMessage(errorHandler.parseError(error), locale);
}

// 兼容旧的错误格式
function legacyErrorAdapter(error) {
  // 将旧的错误格式转换为新格式
  if (error?.response?.status === 401) {
    return {
      error: {
        code: 'G1-001-001',
        message: 'Unauthorized',
        messageKey: 'error.auth.invalid_token',
      },
    };
  }
  
  if (error?.response?.status === 403) {
    return {
      error: {
        code: 'G1-001-004',
        message: 'Forbidden',
        messageKey: 'error.auth.insufficient_permissions',
      },
    };
  }
  
  if (error?.response?.status === 404) {
    return {
      error: {
        code: 'G1-003-001',
        message: 'Not found',
        messageKey: 'error.resource.not_found',
      },
    };
  }
  
  if (error?.response?.status === 429) {
    return {
      error: {
        code: 'G1-002-001',
        message: 'Rate limit exceeded',
        messageKey: 'error.rate_limit.exceeded',
        details: {
          retryAfter: error.response.headers['retry-after'] || 60,
        },
      },
    };
  }
  
  return error;
}

// 错误码常量（方便前端使用）
const ERROR_CODES = {
  // 认证
  INVALID_TOKEN: 'G1-001-001',
  TOKEN_EXPIRED: 'G1-001-002',
  MISSING_AUTH_HEADER: 'G1-001-003',
  INSUFFICIENT_PERMISSIONS: 'G1-001-004',
  
  // 限流
  RATE_LIMIT_EXCEEDED: 'G1-002-001',
  SERVICE_UNAVAILABLE: 'G1-002-002',
  
  // 用户
  EMAIL_EXISTS: 'U2-001-001',
  INVALID_CREDENTIALS: 'U2-001-004',
  ACCOUNT_BANNED: 'U2-001-005',
  ACCOUNT_SUSPENDED: 'U2-001-006',
  USER_NOT_FOUND: 'U2-002-001',
  
  // 精灵
  POKEMON_NOT_FOUND: 'P4-001-001',
  POKEMON_STORAGE_FULL: 'P4-001-005',
  
  // 捕捉
  POKEMON_ESCAPED: 'C5-001-001',
  NO_POKEBALLS: 'C5-001-002',
  CATCH_BLOCKED: 'C5-001-004',
  
  // 支付
  ORDER_NOT_FOUND: 'P9-001-001',
  PAYMENT_FAILED: 'P9-001-005',
};

module.exports = {
  ErrorHandler,
  errorHandler,
  handleError,
  isRetryable,
  getLocalizedMessage,
  legacyErrorAdapter,
  ERROR_CODES,
  ERROR_CONFIGS,
};
