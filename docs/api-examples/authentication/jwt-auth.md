# JWT 认证流程

## 概述

mineGo 使用 JWT (JSON Web Token) 进行用户认证。所有需要认证的 API 请求都需要在 Header 中携带有效的 JWT Token。

## 认证流程

### 1. 用户注册

```bash
# cURL
curl -X POST "${API_BASE}/api/v1/users/register" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "player@example.com",
    "password": "securePassword123",
    "username": "pokemonMaster",
    "deviceFingerprint": "device-xxx"
  }'
```

```javascript
// JavaScript
const register = async (userData) => {
  const response = await fetch(`${API_BASE}/api/v1/users/register`, {
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

// 使用 ApiClient
const result = await ApiClient.register({
  email: 'player@example.com',
  password: 'securePassword123',
  username: 'pokemonMaster'
});
```

**成功响应**：

```json
{
  "success": true,
  "data": {
    "userId": 123,
    "username": "pokemonMaster",
    "email": "player@example.com",
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
    "expiresAt": "2026-07-06T18:00:00Z"
  },
  "meta": {
    "requestId": "req-xxx",
    "timestamp": "2026-07-06T17:00:00Z"
  }
}
```

### 2. 用户登录

```bash
# cURL
curl -X POST "${API_BASE}/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "player@example.com",
    "password": "securePassword123",
    "deviceId": "device-xxx"
  }'
```

```javascript
// JavaScript
const login = async (credentials) => {
  const response = await fetch(`${API_BASE}/api/v1/users/login`, {
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
    localStorage.setItem('userId', data.data.userId);
  }
  
  return data;
};

// 使用 ApiClient（自动存储 Token）
const result = await ApiClient.login({
  email: 'player@example.com',
  password: 'securePassword123'
});
// Token 自动存储在 ApiClient 内部
```

**成功响应**：

```json
{
  "success": true,
  "data": {
    "userId": 123,
    "username": "pokemonMaster",
    "team": "valor",
    "level": 25,
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
    "expiresAt": "2026-07-06T18:00:00Z"
  }
}
```

### 3. 使用 Token 调用 API

```bash
# cURL
curl -X GET "${API_BASE}/api/v1/pokemon" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..."
```

```javascript
// 手动添加 Authorization Header
const token = localStorage.getItem('accessToken');

const response = await fetch(`${API_BASE}/api/v1/pokemon`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

// 使用 ApiClient（自动添加 Authorization）
const pokemon = await ApiClient.get('/api/v1/pokemon');
```

### 4. Token 刷新

JWT Token 有效期通常为 1 小时。当 Token 过期时，需要使用 Refresh Token 获取新的 Access Token。

```bash
# cURL
curl -X POST "${API_BASE}/api/v1/users/refresh-token" \
  -H "Content-Type: application/json" \
  -d '{
    "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
  }'
```

```javascript
// 手动刷新
const refreshToken = async () => {
  const refreshToken = localStorage.getItem('refreshToken');
  
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }
  
  const response = await fetch(`${API_BASE}/api/v1/users/refresh-token`, {
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
    // Refresh Token 过期，需要重新登录
    clearStorage();
    redirectToLogin();
  }
};

// ApiClient 自动刷新（推荐）
// ApiClient 内部会自动检测 Token 过期并刷新
const pokemon = await ApiClient.get('/api/v1/pokemon');
// 如果 Token 过期，ApiClient 会自动刷新并重试
```

### 5. 自动 Token 刷新中间件

ApiClient 内置自动 Token 刷新机制：

```javascript
// frontend/game-client/src/utils/ApiClient.js

class ApiClient {
  constructor() {
    this.refreshThreshold = 5 * 60 * 1000; // Token 过期前 5 分钟刷新
  }
  
  async request(config) {
    const tokenExpiry = localStorage.getItem('tokenExpiry');
    
    // 检查是否需要刷新
    if (tokenExpiry && Date.now() > tokenExpiry - this.refreshThreshold) {
      await this.refreshToken();
    }
    
    const token = localStorage.getItem('accessToken');
    
    try {
      return await this._fetch(config, token);
    } catch (error) {
      if (error.code === 'TOKEN_EXPIRED') {
        // Token 已过期，刷新并重试
        await this.refreshToken();
        const newToken = localStorage.getItem('accessToken');
        return await this._fetch(config, newToken);
      }
      throw error;
    }
  }
  
  async refreshToken() {
    const refreshToken = localStorage.getItem('refreshToken');
    const response = await fetch(`${API_BASE}/api/v1/users/refresh-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
    
    const data = await response.json();
    
    if (data.success) {
      localStorage.setItem('accessToken', data.data.accessToken);
      localStorage.setItem('tokenExpiry', data.data.expiresAt);
    } else {
      throw new Error('Token refresh failed');
    }
  }
}
```

## JWT Payload 结构

```json
{
  "sub": "user-123",
  "username": "pokemonMaster",
  "team": "valor",
  "level": 25,
  "iat": 1717632000,
  "exp": 1717718400
}
```

| 字段 | 说明 |
|------|------|
| `sub` | 用户唯一标识 |
| `username` | 用户名 |
| `team` | 所属阵营（valor/mystic/instinct） |
| `level` | 用户等级 |
| `iat` | Token 签发时间 |
| `exp` | Token 过期时间 |

## 错误处理

### TOKEN_EXPIRED

Token 已过期，需要刷新：

```javascript
if (error.code === 'TOKEN_EXPIRED') {
  // 自动刷新（ApiClient 会处理）
  // 或手动刷新
  await refreshToken();
}
```

### TOKEN_INVALID

Token 无效，需要重新登录：

```javascript
if (error.code === 'TOKEN_INVALID') {
  clearStorage();
  redirectToLogin();
}
```

### REFRESH_TOKEN_EXPIRED

Refresh Token 过期，需要重新登录：

```javascript
if (error.code === 'REFRESH_TOKEN_EXPIRED') {
  clearStorage();
  redirectToLogin();
}
```

## 安全最佳实践

### 1. Token 存储

推荐使用 localStorage（仅 Web）：

```javascript
localStorage.setItem('accessToken', token);
localStorage.setItem('refreshToken', refreshToken);
```

对于移动端，使用安全的本地存储：

```javascript
// React Native
await AsyncStorage.setItem('accessToken', token);

// iOS (Swift)
KeychainWrapper.standard.set(token, forKey: "accessToken");

// Android (Kotlin)
val sharedPref = getSharedPreferences("auth", Context.MODE_PRIVATE)
sharedPref.edit().putString("accessToken", token).apply()
```

### 2. Token 传输

所有 API 请求必须使用 HTTPS。Token 通过 Authorization Header 传输：

```javascript
headers: {
  'Authorization': `Bearer ${token}`
}
```

### 3. Token 刷新策略

- 在 Token 过期前 5 分钟主动刷新
- Token 过期时自动刷新并重试请求
- Refresh Token 过期时跳转登录页

### 4. 多设备支持

每个设备有独立的 Device ID：

```javascript
const deviceId = localStorage.getItem('deviceId') || generateUUID();
localStorage.setItem('deviceId', deviceId);

// 登录时携带 deviceId
await ApiClient.login({
  email,
  password,
  deviceId
});
```

## 相关文档

- [Token 自动刷新](token-refresh.md)
- [WebSocket 认证](websocket-auth.md)
- [多因素认证](mfa-setup.md)
- [错误处理指南](../frontend-integration/error-handling-pattern.md)