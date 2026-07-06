# API 错误处理最佳实践

## 错误分类

### 1. 认证错误 (401)

```javascript
const handleAuthError = (error) => {
  const authHandlers = {
    'TOKEN_EXPIRED': async () => {
      // 自动刷新 Token
      await refreshToken();
      // 重试原始请求
      return retryOriginalRequest();
    },
    'TOKEN_INVALID': () => {
      // 清除本地存储，重新登录
      clearStorage();
      redirectToLogin();
    },
    'REFRESH_TOKEN_EXPIRED': () => {
      // Refresh Token 过期，重新登录
      clearStorage();
      redirectToLogin();
    },
    'DEVICE_NOT_TRUSTED': () => {
      // 设备验证流程
      showDeviceVerificationUI();
    },
    'MFA_REQUIRED': () => {
      // 多因素认证流程
      showMFAChallenge();
    }
  };

  const handler = authHandlers[error.code];
  return handler ? handler() : redirectToLogin();
};
```

### 2. 权限错误 (403)

```javascript
const handleForbiddenError = (error) => {
  const forbiddenHandlers = {
    'INSUFFICIENT_PERMISSIONS': () => {
      showPermissionDeniedMessage(error.message);
    },
    'ACCOUNT_BANNED': () => {
      showBannedMessage(error.details.reason, error.details.expiresAt);
    },
    'REGION_RESTRICTED': () => {
      showRegionRestrictionMessage(error.details.region);
    },
    'AGE_RESTRICTED': () => {
      showAgeVerificationPrompt();
    }
  };

  const handler = forbiddenHandlers[error.code];
  return handler ? handler() : showGenericForbiddenError();
};
```

### 3. 业务逻辑错误 (400)

```javascript
const handleBusinessError = (error) => {
  const businessHandlers = {
    'POKEMON_NOT_FOUND': () => showPokemonNotFound(),
    'INSUFFICIENT_BALANCE': () => showPurchaseFailed(error.details),
    'LOCATION_TOO_FAR': () => showLocationWarning(),
    'CATCH_COOLDOWN': () => showCooldownTimer(error.details.remainingTime),
    'FRIEND_LIMIT_REACHED': () => showFriendLimitMessage(),
    'TRADE_NOT_ALLOWED': () => showTradeNotAllowedReason(error.details),
    'GYM_BATTLE_IN_PROGRESS': () => showBattleInProgress(),
    'RAID_ALREADY_JOINED': () => showRaidAlreadyJoined()
  };

  const handler = businessHandlers[error.code];
  if (handler) {
    handler();
  } else {
    showGenericError(error.message);
  }
};
```

### 4. 验证错误 (400)

```javascript
const handleValidationError = (error) => {
  // 显示字段级错误
  if (error.details && error.details.fields) {
    for (const [field, message] of Object.entries(error.details.fields)) {
      highlightFieldError(field, message);
    }
  } else {
    showValidationError(error.message);
  }
};
```

### 5. 网络错误

```javascript
const handleNetworkError = (error) => {
  const networkHandlers = {
    'TIMEOUT': () => {
      showTimeoutMessage();
      // 指数退避重试
      retryWithBackoff();
    },
    'NETWORK_ERROR': () => {
      showOfflineMessage();
      // 启用离线模式
      enableOfflineMode();
    },
    'RATE_LIMITED': () => {
      showRateLimitMessage(error.details.retryAfter);
    },
    'SERVICE_UNAVAILABLE': () => {
      showServiceUnavailableMessage(error.details.service);
    }
  };

  const handler = networkHandlers[error.type] || networkHandlers[error.code];
  return handler ? handler() : showGenericNetworkError();
};
```

## 统一错误处理器

```javascript
// frontend/game-client/src/utils/UnifiedErrorHandler.js

class UnifiedErrorHandler {
  constructor(i18n, analytics) {
    this.i18n = i18n;
    this.analytics = analytics;
    this.errorLog = [];
  }

  handle(error) {
    // 1. 记录错误
    this.logError(error);

    // 2. 优先使用 i18nKey 显示本地化错误
    const displayMessage = error.i18nKey 
      ? this.i18n.t(error.i18nKey, error.details)
      : error.message;

    // 3. 根据错误码分类处理
    if (error.code?.startsWith('AUTH_') || error.status === 401) {
      return this.handleAuthError(error, displayMessage);
    } else if (error.code?.startsWith('FORBIDDEN_') || error.status === 403) {
      return this.handleForbiddenError(error, displayMessage);
    } else if (error.code?.startsWith('VALIDATION_')) {
      return this.handleValidationError(error, displayMessage);
    } else if (error.code?.startsWith('NETWORK_') || error.type) {
      return this.handleNetworkError(error, displayMessage);
    } else {
      return this.handleGenericError(error, displayMessage);
    }
  }

  logError(error) {
    // 添加到本地错误日志
    this.errorLog.push({
      code: error.code,
      message: error.message,
      requestId: error.requestId,
      timestamp: Date.now()
    });

    // 发送到监控系统
    if (this.analytics) {
      this.analytics.track('api_error', {
        code: error.code,
        message: error.message,
        requestId: error.requestId,
        timestamp: Date.now(),
        userAgent: navigator.userAgent
      });
    }
  }

  handleAuthError(error, displayMessage) {
    if (error.code === 'TOKEN_EXPIRED') {
      // 自动刷新并重试
      return refreshTokenAndRetry();
    }
    
    // 其他认证错误需要重新登录
    clearStorage();
    showErrorToast(displayMessage);
    setTimeout(() => redirectToLogin(), 2000);
  }

  handleValidationError(error, displayMessage) {
    // 字段级验证错误
    if (error.details?.fields) {
      for (const [field, fieldError] of Object.entries(error.details.fields)) {
        const fieldMessage = error.i18nKey 
          ? this.i18n.t(`${error.i18nKey}.${field}`, fieldError)
          : fieldError;
        highlightFieldError(field, fieldMessage);
      }
    } else {
      showErrorToast(displayMessage);
    }
  }

  handleNetworkError(error, displayMessage) {
    if (error.type === 'TIMEOUT' || error.code === 'TIMEOUT') {
      showTimeoutMessage();
      // 提供重试选项
      showRetryPrompt(() => retryOriginalRequest());
    } else if (!navigator.onLine) {
      showOfflineMessage();
      enableOfflineMode();
    } else if (error.code === 'RATE_LIMITED') {
      const retryAfter = error.details?.retryAfter || 60;
      showRateLimitMessage(retryAfter);
      scheduleRetry(retryAfter * 1000);
    } else {
      showErrorToast(displayMessage);
    }
  }

  handleGenericError(error, displayMessage) {
    showErrorToast(displayMessage);
  }

  // 获取最近的错误日志
  getRecentErrors(count = 10) {
    return this.errorLog.slice(-count);
  }
}

// 全局实例
const errorHandler = new UnifiedErrorHandler(i18n, analytics);

// 导出
module.exports = errorHandler;
```

## ApiClient 集成

```javascript
// frontend/game-client/src/utils/ApiClient.js

class ApiClient {
  constructor(errorHandler) {
    this.errorHandler = errorHandler;
    this.pendingRequests = new Map();
  }

  async request(config) {
    const requestId = generateUUID();
    const startTime = Date.now();

    try {
      const response = await this._fetch(config);
      
      // 记录成功请求
      this.logSuccess(requestId, startTime, response);
      
      return response;
    } catch (error) {
      // 记录失败请求
      this.logFailure(requestId, startTime, error);
      
      // 使用统一错误处理器
      return this.errorHandler.handle(error);
    }
  }

  async _fetch(config) {
    const url = `${API_BASE}${config.path}`;
    
    const response = await fetch(url, {
      method: config.method || 'GET',
      headers: {
        'Authorization': `Bearer ${this.getToken()}`,
        'Content-Type': 'application/json',
        'X-Request-Id': generateUUID(),
        ...config.headers
      },
      body: config.data ? JSON.stringify(config.data) : null
    });

    if (!response.ok) {
      const error = await response.json();
      error.status = response.status;
      throw error;
    }

    return response.json();
  }

  logSuccess(requestId, startTime, response) {
    const duration = Date.now() - startTime;
    analytics.track('api_success', {
      requestId,
      path: config.path,
      method: config.method,
      duration,
      timestamp: startTime
    });
  }

  logFailure(requestId, startTime, error) {
    const duration = Date.now() - startTime;
    analytics.track('api_failure', {
      requestId,
      path: config.path,
      method: config.method,
      errorCode: error.code,
      duration,
      timestamp: startTime
    });
  }
}
```

## 错误恢复策略

### 1. 自动重试

```javascript
const retryWithBackoff = async (requestFn, options = {}) => {
  const maxRetries = options.maxRetries || 3;
  const baseDelay = options.baseDelay || 1000;
  const maxDelay = options.maxDelay || 30000;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await requestFn();
    } catch (error) {
      // 判断是否可重试
      if (!isRetryableError(error) || i === maxRetries - 1) {
        throw error;
      }
      
      // 指数退避 + 抖动
      const delay = Math.min(
        baseDelay * Math.pow(2, i) + Math.random() * 1000,
        maxDelay
      );
      
      await sleep(delay);
    }
  }
};

const isRetryableError = (error) => {
  const retryableCodes = [
    'TIMEOUT',
    'NETWORK_ERROR',
    'SERVICE_UNAVAILABLE',
    'RATE_LIMITED'
  ];
  return retryableCodes.includes(error.code) || retryableCodes.includes(error.type);
};
```

### 2. 离线模式

```javascript
const enableOfflineMode = () => {
  // 显示离线提示
  showOfflineBanner();
  
  // 使用本地缓存数据
  const cachedData = getLocalCache();
  if (cachedData) {
    updateUIWithCache(cachedData);
  }
  
  // 禁用需要网络的操作
  disableNetworkOperations();
  
  // 监听网络恢复
  window.addEventListener('online', () => {
    syncOfflineData();
    hideOfflineBanner();
    enableNetworkOperations();
  });
};

const syncOfflineData = async () => {
  const offlineActions = getOfflineActionQueue();
  
  for (const action of offlineActions) {
    try {
      await ApiClient.request(action.config);
      removeOfflineAction(action.id);
    } catch (error) {
      // 保持队列，稍后再试
      console.error('Sync failed:', action.id);
    }
  }
};
```

### 3. 降级策略

```javascript
const fallbackStrategies = {
  // 精灵列表查询失败 → 使用本地缓存
  'GET /api/v1/pokemon': async () => {
    return getLocalPokemonCache();
  },
  
  // 道馆列表查询失败 → 使用简化数据
  'GET /api/v1/gyms': async () => {
    return getSimplifiedGymsCache();
  },
  
  // 捕捉失败 → 保持当前状态
  'POST /api/v1/catch': async (error) => {
    return { success: false, error };
  }
};

const applyFallback = async (config, error) => {
  const key = `${config.method} ${config.path}`;
  const strategy = fallbackStrategies[key];
  
  if (strategy) {
    return strategy(error);
  }
  
  return { success: false, error };
};
```

## 用户提示最佳实践

### 1. Toast 通知

```javascript
// 短暂错误提示
const showErrorToast = (message, duration = 3000) => {
  const toast = document.createElement('div');
  toast.className = 'error-toast';
  toast.textContent = message;
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.remove();
  }, duration);
};
```

### 2. Modal 对话框

```javascript
// 重要错误需要用户确认
const showErrorModal = (error) => {
  showModal({
    title: i18n.t('error.title'),
    message: error.i18nKey ? i18n.t(error.i18nKey) : error.message,
    actions: [
      {
        label: i18n.t('error.retry'),
        onClick: () => retryOriginalRequest()
      },
      {
        label: i18n.t('error.dismiss'),
        onClick: () => closeModal()
      }
    ],
    docUrl: error.docUrl
  });
};
```

### 3. 字段级提示

```javascript
// 表单验证错误
const highlightFieldError = (field, message) => {
  const input = document.querySelector(`[name="${field}"]`);
  const errorElement = document.querySelector(`[data-error="${field}"]`);
  
  input.classList.add('error');
  errorElement.textContent = message;
  errorElement.style.display = 'block';
  
  // 输入时清除错误提示
  input.addEventListener('input', () => {
    input.classList.remove('error');
    errorElement.style.display = 'none';
  }, { once: true });
};
```

## 相关文档

- [JWT 认证流程](../authentication/jwt-auth.md)
- [错误码参考](../../backend/shared/errors/ErrorCodes.js)
- [API 响应格式规范](../api-guidelines.md)