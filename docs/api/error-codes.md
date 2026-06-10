# mineGo API 错误码文档

> 本文档记录所有 API 错误码，帮助开发者快速定位和解决问题。

## 错误响应格式

所有 API 错误响应遵循统一格式：

```json
{
  "success": false,
  "error": {
    "code": "G1-001-001",
    "message": "Invalid access token",
    "messageKey": "error.auth.invalid_token",
    "details": {
      "reason": "token_expired"
    },
    "requestId": "req_abc123def456",
    "docUrl": "https://docs.minego.app/errors/G1-001-001",
    "retryable": false,
    "severity": "warning"
  },
  "timestamp": "2026-06-10T07:00:00Z"
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | string | 错误码（格式：SX-MMM-EEE） |
| `message` | string | 英文错误描述 |
| `messageKey` | string | 国际化键名 |
| `details` | object | 错误详细信息 |
| `requestId` | string | 请求追踪 ID |
| `docUrl` | string | 错误文档链接 |
| `retryable` | boolean | 是否可重试 |
| `severity` | string | 严重程度（info/warning/critical） |

## 错误码格式

采用分层错误码格式：**SX-MMM-EEE**

- **S**：服务码（1 位）
  - G = Gateway（网关）
  - U = User（用户服务）
  - L = Location（位置服务）
  - P = Pokemon（精灵服务）
  - C = Catch（捕捉服务）
  - G = Gym（道馆服务）
  - S = Social（社交服务）
  - R = Reward（奖励服务）
  - P = Payment（支付服务）

- **X**：子系统码（1 位，0 = 通用）

- **MMM**：模块码（3 位）
  - 001 = 认证模块
  - 002 = 用户资料模块
  - 003 = 好友模块
  - ...

- **EEE**：错误序号（3 位）

## HTTP 状态码映射

| 错误分类 | HTTP 状态码 | 说明 |
|---------|-------------|------|
| 认证错误 | 401 | 未认证或令牌无效 |
| 权限错误 | 403 | 无权限访问资源 |
| 资源错误 | 404 | 资源不存在 |
| 验证错误 | 400 | 请求参数无效 |
| 业务错误 | 422 | 业务规则冲突 |
| 限流错误 | 429 | 请求过于频繁 |
| 系统错误 | 500/503 | 服务内部错误 |

---

## 网关服务错误（G1-xxx-xxx）

### 认证错误（G1-001-xxx）

| 错误码 | HTTP | 消息 | 说明 | 可重试 |
|--------|------|------|------|--------|
| G1-001-001 | 401 | Invalid access token | 访问令牌无效 | ❌ |
| G1-001-002 | 401 | Access token expired | 访问令牌已过期 | ❌ |
| G1-001-003 | 401 | Missing authorization header | 缺少认证头 | ❌ |
| G1-001-004 | 403 | Insufficient permissions | 权限不足 | ❌ |

**解决方案**：
- G1-001-001/002：重新登录获取新的访问令牌
- G1-001-003：在请求头添加 `Authorization: Bearer <token>`
- G1-001-004：联系管理员获取相应权限

### 限流错误（G1-002-xxx）

| 错误码 | HTTP | 消息 | 说明 | 可重试 |
|--------|------|------|------|--------|
| G1-002-001 | 429 | Rate limit exceeded | 请求频率超限 | ✅ |
| G1-002-002 | 503 | Service temporarily unavailable | 服务暂时不可用 | ✅ |

**解决方案**：
- G1-002-001：等待 `details.retryAfter` 秒后重试
- G1-002-002：稍后重试，通常 1-2 分钟内恢复

---

## 用户服务错误（U2-xxx-xxx）

### 认证错误（U2-001-xxx）

| 错误码 | HTTP | 消息 | 说明 | 可重试 |
|--------|------|------|------|--------|
| U2-001-001 | 400 | Email already registered | 邮箱已被注册 | ❌ |
| U2-001-002 | 400 | Invalid email format | 邮箱格式无效 | ❌ |
| U2-001-003 | 400 | Password too weak | 密码强度不足 | ❌ |
| U2-001-004 | 401 | Invalid credentials | 邮箱或密码错误 | ❌ |
| U2-001-005 | 403 | Account banned | 账号已被封禁 | ❌ |
| U2-001-006 | 403 | Account suspended | 账号已被暂停 | ❌ |

**解决方案**：
- U2-001-001：使用其他邮箱或直接登录
- U2-001-003：使用至少 8 位密码，包含大小写字母和数字
- U2-001-004：检查邮箱和密码是否正确
- U2-001-005：联系客服申诉
- U2-001-006：等待 `details.suspendedUntil` 时间后自动解封

### 用户资料错误（U2-002-xxx）

| 错误码 | HTTP | 消息 | 说明 | 可重试 |
|--------|------|------|------|--------|
| U2-002-001 | 404 | User not found | 用户不存在 | ❌ |
| U2-002-002 | 400 | Username already taken | 用户名已被使用 | ❌ |
| U2-002-003 | 400 | Invalid username format | 用户名格式无效 | ❌ |

---

## 位置服务错误（L3-xxx-xxx）

| 错误码 | HTTP | 消息 | 说明 | 可重试 |
|--------|------|------|------|--------|
| L3-001-001 | 400 | Invalid GPS coordinates | GPS 坐标无效 | ❌ |
| L3-001-002 | 403 | GPS spoofing detected | GPS 伪造检测 | ❌ |
| L3-001-003 | 403 | Speed limit exceeded | 移动速度异常 | ❌ |
| L3-001-004 | 404 | No nearby pokemon found | 附近无精灵 | ✅ |

**解决方案**：
- L3-001-001：确保经度在 [-180, 180]，纬度在 [-90, 90]
- L3-001-002：停止使用 GPS 伪造工具，否则可能被封号
- L3-001-003：正常游玩，不要使用瞬移等功能
- L3-001-004：移动到其他位置或稍后再试

---

## 精灵服务错误（P4-xxx-xxx）

| 错误码 | HTTP | 消息 | 说明 | 可重试 |
|--------|------|------|------|--------|
| P4-001-001 | 404 | Pokemon not found | 精灵不存在 | ❌ |
| P4-001-002 | 403 | Pokemon does not belong to user | 精灵不属于当前用户 | ❌ |
| P4-001-003 | 400 | Pokemon already transferred | 精灵已被转移 | ❌ |
| P4-001-004 | 400 | Pokemon is favorite | 精灵已收藏 | ❌ |
| P4-001-005 | 400 | Pokemon storage full | 精灵存储已满 | ❌ |

**解决方案**：
- P4-001-004：先取消收藏再转移
- P4-001-005：升级存储空间或转移精灵

---

## 捕捉服务错误（C5-xxx-xxx）

| 错误码 | HTTP | 消息 | 说明 | 可重试 |
|--------|------|------|------|--------|
| C5-001-001 | 200 | Pokemon escaped | 精灵逃跑 | ✅ |
| C5-001-002 | 400 | No pokeballs available | 没有精灵球 | ❌ |
| C5-001-003 | 400 | Pokemon out of range | 精灵距离太远 | ✅ |
| C5-001-004 | 403 | Catch blocked by anti-cheat | 反作弊拦截 | ❌ |
| C5-001-005 | 400 | Invalid catch attempt | 捕捉请求无效 | ❌ |

**解决方案**：
- C5-001-001：使用更高级的精灵球或技能球
- C5-001-002：前往商店购买精灵球
- C5-001-003：靠近精灵后再捕捉
- C5-001-004：遵守游戏规则，停止作弊行为

---

## 道馆服务错误（G6-xxx-xxx）

| 错误码 | HTTP | 消息 | 说明 | 可重试 |
|--------|------|------|------|--------|
| G6-001-001 | 404 | Gym not found | 道馆不存在 | ❌ |
| G6-001-002 | 403 | Gym too far away | 道馆距离太远 | ✅ |
| G6-001-003 | 400 | Gym already owned by your team | 道馆已被己方占领 | ❌ |
| G6-001-004 | 400 | No eligible pokemon for gym | 无符合条件的精灵 | ❌ |
| G6-001-005 | 400 | Gym battle cooldown active | 战斗冷却中 | ✅ |

---

## 支付服务错误（P9-xxx-xxx）

| 错误码 | HTTP | 消息 | 说明 | 可重试 |
|--------|------|------|------|--------|
| P9-001-001 | 404 | Order not found | 订单不存在 | ❌ |
| P9-001-002 | 400 | Order already paid | 订单已支付 | ❌ |
| P9-001-003 | 400 | Order expired | 订单已过期 | ❌ |
| P9-001-004 | 400 | Invalid payment amount | 支付金额无效 | ❌ |
| P9-001-005 | 402 | Payment failed | 支付失败 | ✅ |
| P9-001-006 | 403 | Duplicate order detected | 重复订单 | ❌ |

**解决方案**：
- P9-001-003：重新下单
- P9-001-005：检查支付方式或稍后重试

---

## 错误码统计

- **总错误码数**：100+
- **按服务分布**：
  - 网关服务：10
  - 用户服务：15
  - 位置服务：5
  - 精灵服务：10
  - 捕捉服务：8
  - 道馆服务：10
  - 社交服务：12
  - 奖励服务：8
  - 支付服务：10

- **按严重程度分布**：
  - critical：15
  - warning：60
  - info：25

---

## 最佳实践

### 前端错误处理

```javascript
import { handleError, isRetryable } from './utils/ErrorHandler';

try {
  const result = await api.catchPokemon(pokemonId);
} catch (error) {
  const handled = handleError(error);
  
  if (handled.retryable) {
    // 显示重试按钮
    showRetryButton(() => retry());
  } else {
    // 显示错误信息
    showErrorToast(handled.message);
  }
  
  // 记录请求 ID 用于客服查询
  console.log('Request ID:', handled.requestId);
}
```

### 自动重试机制

```javascript
async function fetchWithRetry(url, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fetch(url);
    } catch (error) {
      const handled = handleError(error, { silent: true });
      
      if (!handled.retryable || i === maxRetries - 1) {
        handleError(error); // 显示错误
        throw error;
      }
      
      // 等待后重试
      const retryAfter = handled.details?.retryAfter || 2;
      await sleep(retryAfter * 1000);
    }
  }
}
```

---

## 更新日志

- **2026-06-10**：初始版本，包含 100+ 错误码
- 维护者：mineGo 后端团队
- 反馈渠道：GitHub Issues
