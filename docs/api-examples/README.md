# mineGo API 调用示例库

> 完整的 API 调用示例和最佳实践指南

## 目录结构

```
docs/api-examples/
├── README.md                   # 总览（本文件）
├── authentication/             # 认证相关示例
│   ├── jwt-auth.md             # JWT 认证流程
│   ├── token-refresh.md        # Token 自动刷新
│   ├── websocket-auth.md       # WebSocket 认证
│   └── mfa-setup.md            # 多因素认证
├── user-service/               # 用户服务示例
├── location-service/           # 位置服务示例
├── pokemon-service/            # 精灵服务示例
├── catch-service/              # 捕捉服务示例
├── gym-service/               # 道馆服务示例
├── social-service/             # 社交服务示例
├── reward-service/             # 奖励服务示例
├── payment-service/            # 支付服务示例
├── frontend-integration/       # 前端集成指南
│   ├── game-client-best-practices.md
│   ├── error-handling-pattern.md
│   └── offline-support.md
├── testing/                    # 测试示例
│   ├── unit-test-examples.md
│   ├── integration-test-examples.md
│   └── e2e-test-examples.md
```

## 快速开始

### 1. 环境配置

```bash
# 设置 API 基础 URL
export API_BASE_URL="https://api.minego.example.com"

# 或在代码中配置
const API_BASE = 'https://api.minego.example.com';
```

### 2. 认证流程

所有需要认证的 API 都需要在请求头携带 JWT Token：

```javascript
fetch(`${API_BASE}/api/v1/pokemon`, {
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
});
```

详细认证流程请参考 [authentication/jwt-auth.md](authentication/jwt-auth.md)。

### 3. 通用请求模式

推荐使用项目提供的 ApiClient 类：

```javascript
const ApiClient = require('@pmg/shared/ApiClient');

// GET 请求
const pokemon = await ApiClient.get('/api/v1/pokemon/:id');

// POST 请求
const result = await ApiClient.post('/api/v1/catch', {
  pokemonId: 'xxx',
  location: { lat: 31.2304, lng: 121.4737 }
});

// 带自定义配置
const result = await ApiClient.request({
  method: 'POST',
  path: '/api/v1/catch',
  data: { ... },
  timeout: 5000,
  retries: 3
});
```

### 4. 错误处理

统一错误处理模式：

```javascript
try {
  const result = await ApiClient.catchAttempt(params);
  if (result.success) {
    // 处理成功
    updateGameState(result.data);
  }
} catch (error) {
  // 根据 error.code 分类处理
  if (error.code === 'TOKEN_EXPIRED') {
    await refreshToken();
    // 重试
  } else if (error.code === 'RATE_LIMITED') {
    showRateLimitMessage(error.details.retryAfter);
  } else {
    showErrorToast(error.message);
  }
}
```

详细错误处理指南请参考 [frontend-integration/error-handling-pattern.md](frontend-integration/error-handling-pattern.md)。

## 服务概览

| 服务 | 基础路径 | 主要功能 |
|------|---------|---------|
| user-service | `/api/v1/users` | 注册、登录、资料、设备管理 |
| location-service | `/api/v1/location` | GPS 上报、附近精灵查询 |
| pokemon-service | `/api/v1/pokemon` | 精灵仓库、图鉴、进化 |
| catch-service | `/api/v1/catch` | 捕捉流程、道具使用 |
| gym-service | `/api/v1/gyms` | 道馆、Raid、WebSocket |
| social-service | `/api/v1/friends` | 好友、礼物、交易 |
| reward-service | `/api/v1/tasks` | 任务、成就、排行榜 |
| payment-service | `/api/v1/payments` | 内购、充值、订单 |

## 响应格式

所有 API 遵循统一的响应格式：

```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "requestId": "req-uuid",
    "timestamp": "2026-07-06T17:00:00Z"
  }
}
```

错误响应：

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": { ... },
    "i18nKey": "error.key",
    "docUrl": "https://docs.minego.example.com/errors/ERROR_CODE"
  }
}
```

## 最佳实践

### 1. 使用统一的 ApiClient

不要直接使用 fetch，使用项目提供的 ApiClient：

- 自动 Token 管理
- 自动错误处理
- 自动重试机制
- 请求日志记录

### 2. 处理网络离线

```javascript
// 使用 Service Worker 缓存
navigator.serviceWorker.register('/sw.js');

// 离线时使用本地数据
if (!navigator.onLine) {
  const cachedData = getLocalCache();
  updateUIWithCache(cachedData);
}
```

### 3. 合理设置超时

```javascript
// 快速操作：5 秒超时
ApiClient.request({ ..., timeout: 5000 });

// 慢操作：30 秒超时
ApiClient.request({ ..., timeout: 30000 });
```

### 4. 使用幂等键

对于可能重复的请求（如支付），使用幂等键：

```javascript
const idempotencyKey = generateUUID();
await ApiClient.purchaseItem({
  itemId: 'xxx',
  idempotencyKey
});
```

## 相关文档

- [API 响应格式规范](../api-guidelines.md)
- [OpenAPI 规范](../api-spec/openapi.yaml)
- [错误码参考](../../backend/shared/errors/ErrorCodes.js)

---

**最后更新**：2026-07-06
**维护者**：mineGo 开发团队