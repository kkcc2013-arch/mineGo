# REQ-00438: API 调用示例库与最佳实践文档系统

- **编号**: REQ-00438
- **类别**: 文档/开发者体验
- **优先级**: P1
- **状态**: new
- **涉及服务/模块**: backend/docs/examples、frontend/game-client/examples、admin-dashboard/examples、docs/api-examples
- **创建时间**: 2026-07-06 08:17 UTC
- **依赖需求**: REQ-00257(API回归测试)、api-guidelines.md(已存在)

## 1. 背景与问题

当前 mineGo 项目已有完善的 API 响应格式规范（api-guidelines.md）和 OpenAPI 规范，但开发者使用 API 时存在以下痛点：

1. **缺少实际调用示例**: 新开发者不知道如何正确调用各服务 API（如捕捉精灵、道馆战斗、支付）
2. **前端集成文档缺失**: game-client 和 admin-dashboard 缺少 API 调用最佳实践示例
3. **错误处理不统一**: 前端代码中对 API 错误的处理方式各异，缺少统一指南
4. **认证流程不清晰**: JWT 认证、Token刷新、WebSocket 认证的完整流程缺少文档说明
5. **测试示例不足**: 开发者不知道如何为 API 调用编写单元测试和集成测试

## 2. 目标

构建完整的 API 调用示例库与最佳实践文档系统：

1. **核心 API 示例库**: 为 9 个微服务提供完整的调用示例（请求、响应、错误处理）
2. **前端集成指南**: game-client 和 admin-dashboard 的 API 调用最佳实践
3. **认证流程文档**: JWT 认证、Token刷新、WebSocket 认证完整流程
4. **错误处理指南**: 统一的错误处理模式和最佳实践
5. **测试示例**: API 调用的单元测试和集成测试示例

## 3. 范围

### 包含
- 核心业务 API 调用示例（捕捉、道馆、社交、支付等）
- 前端集成最佳实践文档
- 认证与安全最佳实践文档
- 错误处理模式指南
- 测试示例代码
- 自动化示例验证脚本

### 不包含
- OpenAPI 规范生成（已存在）
- API 响应格式规范（已存在 api-guidelines.md）
- API 回归测试（REQ-00257 已完成）

## 4. 详细需求

### 4.1 API 调用示例库目录结构

```
docs/api-examples/
├── README.md                   # 示例库总览
├── authentication/
│   ├── jwt-auth.md             # JWT 认证示例
│   ├── token-refresh.md        # Token 刷新流程
│   ├── websocket-auth.md       # WebSocket 认证示例
│   └── mfa-setup.md            # 多因素认证示例
├── user-service/
│   ├── register.md             # 用户注册示例
│   ├── login.md                # 登录示例
│   ├── profile-update.md       # 用户资料更新
│   └── device-binding.md       # 设备绑定示例
├── location-service/
│   ├── update-location.md      # 位置更新示例
│   ├── nearby-spawn.md         # 附近精灵查询示例
│   ├── geofencing.md           # 地理围栏示例
├── pokemon-service/
│   ├── list-pokemon.md         # 精灵列表查询
│   ├── pokemon-detail.md       # 精灵详情查询
│   ├── pokemon-stats.md        # 精灵属性统计
├── catch-service/
│   ├── catch-attempt.md        # 捕捉尝试示例
│   ├── catch-result.md         # 捕捉结果查询
│   ├── item-usage.md           # 道具使用示例
├── gym-service/
│   ├── gym-list.md             # 道馆列表查询
│   ├── gym-battle.md           # 道馆战斗示例
│   ├── gym-claim.md            # 道馆占领示例
│   ├── raid-join.md            # Raid 参加示例
├── social-service/
│   ├── friend-add.md           # 添加好友示例
│   ├── friend-list.md          # 好友列表查询
│   ├── gift-send.md            # 礼物发送示例
│   ├── trade-request.md        # 精灵交易示例
├── reward-service/
│   ├── daily-task.md           # 每日任务示例
│   ├── achievement-list.md     # 成就列表查询
│   ├── leaderboard.md          # 排行榜查询
├── payment-service/
│   ├── purchase-item.md        # 道具购买示例
│   ├── coin-balance.md         # 精币余额查询
│   ├── transaction-history.md  # 交易历史查询
├── frontend-integration/
│   ├── game-client-best-practices.md  # 游戏客户端最佳实践
│   ├── admin-dashboard-best-practices.md  # 管理后台最佳实践
│   ├── error-handling-pattern.md  # 错误处理模式
│   ├── offline-support.md      # 离线支持模式
├── testing/
│   ├── unit-test-examples.md   # 单元测试示例
│   ├── integration-test-examples.md  # 集成测试示例
│   ├── e2e-test-examples.md    # E2E 测试示例
```

### 4.2 API 调用示例模板

```markdown
# {API 名称} - 调用示例

## 基本信息

- **服务**: {service-name}
- **端点**: `{method} {path}`
- **功能**: {功能描述}
- **认证**: 需要/不需要 JWT Token
- **权限**: {权限要求}

## 请求示例

### cURL

```bash
curl -X {METHOD} "{BASE_URL}{PATH}" \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{REQUEST_BODY}'
```

### JavaScript (fetch)

```javascript
const response = await fetch(`${BASE_URL}${PATH}`, {
  method: '{METHOD}',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({REQUEST_BODY})
});

const data = await response.json();
```

### JavaScript (ApiClient)

```javascript
const ApiClient = require('../shared/utils/ApiClient');

const result = await ApiClient.request({
  service: '{SERVICE}',
  method: '{METHOD}',
  path: '{PATH}',
  data: {REQUEST_BODY},
  headers: { 'Authorization': `Bearer ${token}` }
});
```

## 成功响应

```json
{
  "success": true,
  "data": {SUCCESS_RESPONSE_DATA},
  "meta": {
    "requestId": "req-xxx",
    "timestamp": "2026-07-06T08:17:00Z"
  }
}
```

## 错误响应示例

### 参数验证失败

```json
{
  "success": false,
  "error": {
    "code": "{ERROR_CODE}",
    "message": "{ERROR_MESSAGE}",
    "details": {ERROR_DETAILS},
    "i18nKey": "{I18N_KEY}",
    "docUrl": "{DOC_URL}"
  }
}
```

## 前端最佳实践

### 错误处理

```javascript
try {
  const result = await ApiClient.catchAttempt({
    pokemonId: 'xxx',
    itemId: 'xxx',
    location: { lat, lng }
  });
  
  if (result.success) {
    // 处理成功逻辑
    updateGameState(result.data);
  }
} catch (error) {
  if (error.code === 'INSUFFICIENT_ITEMS') {
    // 显示道具不足提示
    showNotification(i18n.t(error.i18nKey));
  } else if (error.code === 'LOCATION_INVALID') {
    // 位置无效处理
    refreshLocation();
  } else {
    // 通用错误处理
    showErrorToast(error.message);
  }
}
```

### Token刷新

```javascript
// 自动Token刷新
ApiClient.interceptors.response.use(
  response => response,
  async error => {
    if (error.code === 'TOKEN_EXPIRED') {
      const newToken = await refreshToken();
      // 重试原始请求
      return ApiClient.retryOriginalRequest();
    }
    throw error;
  }
);
```

## 测试示例

### 单元测试

```javascript
describe('{API Name}', () => {
  it('should return success with valid parameters', async () => {
    const mockResponse = { success: true, data: mockData };
    mockApiClient.request.mockResolvedValue(mockResponse);
    
    const result = await {API_FUNCTION}(validParams);
    expect(result.success).toBe(true);
  });
  
  it('should handle error correctly', async () => {
    const mockError = { code: 'INVALID_PARAM', message: '...' };
    mockApiClient.request.mockRejectedValue(mockError);
    
    await expect({API_FUNCTION}(invalidParams)).rejects.toThrow();
  });
});
```

## 相关文档

- [API 响应格式规范](../api-guidelines.md)
- [OpenAPI 规范](../api-spec/openapi.yaml)
- [错误码参考](../backend/shared/errors/ErrorCodes.js)
```

### 4.3 认证流程文档

```javascript
// docs/api-examples/authentication/jwt-auth.md

## JWT 认证流程

### 1. 用户注册

```javascript
const register = async (userData) => {
  const response = await fetch(`${API_BASE}/api/v1/user/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: userData.email,
      password: userData.password,
      username: userData.username,
      deviceFingerprint: generateDeviceFingerprint()
    })
  });
  
  return response.json();
};
```

### 2. 登录获取 Token

```javascript
const login = async (credentials) => {
  const response = await fetch(`${API_BASE}/api/v1/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
      deviceId: getDeviceId()
    })
  });
  
  const data = await response.json();
  
  if (data.success) {
    // 存储 Token
    localStorage.setItem('accessToken', data.data.accessToken);
    localStorage.setItem('refreshToken', data.data.refreshToken);
    localStorage.setItem('tokenExpiry', data.data.expiresAt);
  }
  
  return data;
};
```

### 3. Token 刷新

```javascript
const refreshToken = async () => {
  const refreshToken = localStorage.getItem('refreshToken');
  
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }
  
  const response = await fetch(`${API_BASE}/api/v1/user/refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  });
  
  const data = await response.json();
  
  if (data.success) {
    localStorage.setItem('accessToken', data.data.accessToken);
    localStorage.setItem('tokenExpiry', data.data.expiresAt);
    return data.data.accessToken;
  } else {
    // Refresh token 过期，重新登录
    redirectToLogin();
  }
};
```

### 4. 自动 Token 刷新中间件

```javascript
// frontend/game-client/src/utils/apiMiddleware.js

class ApiMiddleware {
  constructor() {
    this.refreshThreshold = 5 * 60 * 1000; // Token过期前5分钟刷新
  }
  
  async request(config) {
    const tokenExpiry = localStorage.getItem('tokenExpiry');
    
    // 检查是否需要刷新
    if (tokenExpiry && Date.now() > tokenExpiry - this.refreshThreshold) {
      await refreshToken();
    }
    
    const token = localStorage.getItem('accessToken');
    
    return fetch(config.url, {
      ...config,
      headers: {
        ...config.headers,
        'Authorization': `Bearer ${token}`
      }
    });
  }
}
```

### 5. WebSocket 认证

```javascript
// WebSocket 连接认证
const connectWebSocket = (endpoint) => {
  const token = localStorage.getItem('accessToken');
  
  const ws = new WebSocket(`${WS_BASE}${endpoint}?token=${token}`);
  
  ws.onopen = () => {
    console.log('WebSocket connected');
  };
  
  ws.onerror = (error) => {
    if (error.code === 4001) {
      // Token 无效，重新登录
      redirectToLogin();
    }
  };
  
  return ws;
};
```
```

### 4.4 错误处理指南

```markdown
# API 错误处理最佳实践

## 错误分类

### 1. 认证错误 (401)

```javascript
const handleAuthError = (error) => {
  if (error.code === 'TOKEN_EXPIRED') {
    // 自动刷新Token
    return refreshTokenAndRetry();
  } else if (error.code === 'TOKEN_INVALID') {
    // 清除本地存储，重新登录
    clearStorage();
    redirectToLogin();
  } else if (error.code === 'DEVICE_NOT_TRUSTED') {
    // 设备验证流程
    showDeviceVerificationUI();
  }
};
```

### 2. 权限错误 (403)

```javascript
const handleForbiddenError = (error) => {
  if (error.code === 'INSUFFICIENT_PERMISSIONS') {
    showPermissionDeniedMessage(error.message);
  } else if (error.code === 'ACCOUNT_BANNED') {
    showBannedMessage(error.details.reason);
  } else if (error.code === 'REGION_RESTRICTED') {
    showRegionRestrictionMessage();
  }
};
```

### 3. 业务逻辑错误 (400)

```javascript
const handleBusinessError = (error) => {
  const errorHandlers = {
    'POKEMON_NOT_FOUND': () => showPokemonNotFound(),
    'INSUFFICIENT_BALANCE': () => showPurchaseFailed(error.details),
    'LOCATION_TOO_FAR': () => showLocationWarning(),
    'CATCH_COOLDOWN': () => showCooldownTimer(error.details.remainingTime)
  };
  
  const handler = errorHandlers[error.code];
  if (handler) {
    handler();
  } else {
    showGenericError(error.message);
  }
};
```

### 4. 网络错误

```javascript
const handleNetworkError = (error) => {
  if (error.type === 'TIMEOUT') {
    showTimeoutMessage();
    retryWithBackoff();
  } else if (error.type === 'NETWORK_ERROR') {
    showOfflineMessage();
    enableOfflineMode();
  } else if (error.type === 'RATE_LIMITED') {
    showRateLimitMessage(error.details.retryAfter);
  }
};
```

## 统一错误处理器

```javascript
// frontend/game-client/src/utils/errorHandler.js

class UnifiedErrorHandler {
  constructor(i18n) {
    this.i18n = i18n;
  }
  
  handle(error) {
    // 1. 优先使用 i18nKey 显示本地化错误
    const displayMessage = error.i18nKey 
      ? this.i18n.t(error.i18nKey, error.details)
      : error.message;
    
    // 2. 根据错误码分类处理
    if (error.code.startsWith('AUTH_')) {
      return this.handleAuthError(error, displayMessage);
    } else if (error.code.startsWith('FORBIDDEN_')) {
      return this.handleForbiddenError(error, displayMessage);
    } else if (error.code.startsWith('VALIDATION_')) {
      return this.handleValidationError(error, displayMessage);
    } else {
      return this.handleGenericError(error, displayMessage);
    }
  }
  
  // 记录错误到监控系统
  logError(error) {
    if (window.analytics) {
      window.analytics.track('api_error', {
        code: error.code,
        message: error.message,
        requestId: error.requestId,
        timestamp: Date.now()
      });
    }
  }
}
```

## 错误恢复策略

### 1. 自动重试

```javascript
const retryWithBackoff = async (requestFn, maxRetries = 3) => {
  const delays = [1000, 3000, 5000];
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await requestFn();
    } catch (error) {
      if (!isRetryableError(error) || i === maxRetries - 1) {
        throw error;
      }
      await sleep(delays[i]);
    }
  }
};
```

### 2. 离线模式

```javascript
const enableOfflineMode = () => {
  // 使用本地缓存数据
  const cachedData = getLocalCache();
  if (cachedData) {
    updateUIWithCache(cachedData);
  }
  
  // 监听网络恢复
  window.addEventListener('online', () => {
    syncOfflineData();
  });
};
```
```

### 4.5 自动化示例验证脚本

```javascript
// scripts/validate-api-examples.js

const fs = require('fs');
const path = require('path');

class ExampleValidator {
  constructor() {
    this.examplesDir = 'docs/api-examples';
    this.apiSpecPath = 'docs/api-spec/openapi.yaml';
    this.errors = [];
  }
  
  async validate() {
    const examples = this.loadExamples();
    const apiSpec = this.loadApiSpec();
    
    for (const example of examples) {
      // 1. 验证端点是否存在于 OpenAPI 规范中
      const endpointValid = this.validateEndpoint(example, apiSpec);
      
      // 2. 验证请求参数是否符合规范
      const paramsValid = this.validateParams(example, apiSpec);
      
      // 3. 验证响应格式是否符合规范
      const responseValid = this.validateResponse(example, apiSpec);
      
      // 4. 验证代码示例是否可执行
      const codeValid = await this.validateCodeExecution(example);
      
      if (!endpointValid || !paramsValid || !responseValid || !codeValid) {
        this.errors.push({
          file: example.file,
          issues: [endpointValid, paramsValid, responseValid, codeValid]
            .filter(v => !v)
        });
      }
    }
    
    return this.errors.length === 0;
  }
  
  loadExamples() {
    // 遍历 docs/api-examples 目录加载所有示例
    const examples = [];
    const walkDir = (dir) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          walkDir(fullPath);
        } else if (file.endsWith('.md')) {
          examples.push({
            file: fullPath,
            content: fs.readFileSync(fullPath, 'utf8')
          });
        }
      }
    };
    walkDir(this.examplesDir);
    return examples;
  }
  
  validateEndpoint(example, apiSpec) {
    // 从示例中提取端点信息
    const endpointRegex = /\*\*端点\*\*: `(\w+) ([^\s]+)`/;
    const match = example.content.match(endpointRegex);
    
    if (!match) return false;
    
    const [, method, path] = match;
    const normalizedPath = path.replace(/{[^}]+}/g, '{param}');
    
    // 检查端点是否存在于 OpenAPI 规范中
    return apiSpec.paths[normalizedPath]?.[method.toLowerCase()] !== undefined;
  }
  
  validateParams(example, apiSpec) {
    // 提取请求参数示例
    // 验证参数是否符合 OpenAPI 规范定义
    return true; // 简化验证
  }
  
  validateResponse(example, apiSpec) {
    // 提取响应示例
    // 验证响应格式是否符合 api-guidelines.md
    const responseRegex = /```json\s*\n\{[\s\S]*?\n```/;
    const match = example.content.match(responseRegex);
    
    if (!match) return false;
    
    try {
      const response = JSON.parse(match[0].replace(/```json\n|\n```/g, ''));
      return response.success !== undefined && response.meta !== undefined;
    } catch (e) {
      return false;
    }
  }
  
  async validateCodeExecution(example) {
    // 提取 JavaScript 代码示例
    // 验证代码语法是否正确
    const codeRegex = /```javascript\s*\n([\s\S]*?)\n```/;
    const matches = example.content.matchAll(codeRegex);
    
    for (const match of matches) {
      try {
        new Function(match[1]); // 验证语法
      } catch (e) {
        return false;
      }
    }
    
    return true;
  }
  
  generateReport() {
    return {
      totalExamples: this.loadExamples().length,
      validExamples: this.loadExamples().length - this.errors.length,
      errors: this.errors,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = ExampleValidator;
```

## 5. 验收标准

- [ ] 为 9 个微服务提供完整的 API 调用示例文档
- [ ] 每个示例包含 cURL、fetch、ApiClient 三种调用方式
- [ ] 认证流程文档包含 JWT 认证、Token刷新、WebSocket 认证完整流程
- [ ] 错误处理指南包含认证错误、权限错误、业务错误、网络错误处理
- [ ] 前端集成指南包含 game-client 和 admin-dashboard 最佳实践
- [ ] 测试示例包含单元测试、集成测试、E2E 测试示例
- [ ] 自动化验证脚本能够检测示例与 OpenAPI 规范的一致性
- [ ] 所有示例代码语法验证通过
- [ ] 文档目录结构完整且易于导航

## 6. 工作量估算

**L (Large)**

理由：
- 需要覆盖 9 个微服务的所有核心 API
- 每个示例需要多种调用方式和完整的错误处理
- 认证、错误处理、测试示例需要详细文档
- 自动化验证脚本需要开发
- 预计需要 5-7 天完成

## 7. 优先级理由

**P1 理由**：

1. **开发者体验关键**: 新开发者上手需要明确的 API 调用指南
2. **错误处理统一**: 前端错误处理不统一导致用户体验差
3. **认证流程复杂**: JWT + WebSocket 认证流程缺少完整文档
4. **测试覆盖率**: 开发者不知道如何为 API 编写测试
5. **生产就绪**: API 文档是生产环境必需的