# REQ-00215：API 请求签名验证与重放攻击防护系统

- **编号**：REQ-00215
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared、game-client
- **创建时间**：2026-06-14 23:00
- **依赖需求**：REQ-00003（支付幂等性）、REQ-00021（JWT黑名单）

## 1. 背景与问题

当前系统虽然已有 JWT 认证、限流和反作弊机制，但缺少对 API 请求的完整性和真实性验证：

1. **请求篡改风险**：攻击者可能拦截请求并修改参数（如修改交易金额、商品ID等）
2. **重放攻击风险**：即使有 JWT，攻击者仍可截获请求并重放，导致重复扣款、重复领取奖励
3. **缺少签名机制**：敏感 API（支付、交易、奖励领取）没有请求签名验证，无法保证请求来源可信
4. **时间戳验证缺失**：请求没有时间戳验证，无法防止过期请求重放

当前 `AdaptiveRateLimiter` 和 `anti-cheat.js` 只能检测异常行为，无法从根本上防止请求伪造和重放。

## 2. 目标

1. 为所有敏感 API（支付、交易、奖励领取）添加请求签名验证
2. 实现请求时间戳验证，拒绝过期请求
3. 构建请求 nonce 防重放系统，记录已处理请求
4. 提供多级安全策略，支持不同敏感度 API 的差异化验证

## 3. 范围

- **包含**：
  - 请求签名生成与验证中间件
  - Nonce 防重放系统（基于 Redis）
  - 时间戳验证与时钟偏差容忍机制
  - 签名密钥管理与轮换
  - 客户端签名 SDK（game-client）
  - 敏感 API 签名验证配置

- **不包含**：
  - 硬件安全模块（HSM）集成
  - 双向 TLS 认证
  - 第三方支付网关签名（已有独立实现）

## 4. 详细需求

### 4.1 签名算法设计

```javascript
// 签名生成流程
signature = HMAC-SHA256(
  secretKey,
  `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`
)

// bodyHash 计算
bodyHash = SHA256(requestBody || '')

// 请求头
X-Signature: signature
X-Timestamp: timestamp (毫秒)
X-Nonce: uuid-v4
X-Signature-Version: v1
```

### 4.2 API 安全等级

| 等级 | 类型 | 签名验证 | 时间戳验证 | Nonce 验证 | 示例 |
|------|------|----------|------------|------------|------|
| L1 | 只读查询 | 否 | 否 | 否 | 获取精灵列表 |
| L2 | 写入操作 | 否 | 是（5分钟） | 否 | 更新用户名 |
| L3 | 敏感操作 | 是 | 是（2分钟） | 是 | 支付、交易 |
| L4 | 高危操作 | 是 | 是（30秒） | 是 | 大额充值、账号注销 |

### 4.3 Nonce 防重放机制

```javascript
// Redis 存储结构
nonce:{hash} -> { userId, timestamp, apiPath }
TTL = 时间戳容差 * 2

// 验证流程
1. 检查 nonce 是否已存在
2. 如已存在，拒绝请求（重放攻击）
3. 如不存在，存储 nonce 并设置 TTL
```

### 4.4 密钥管理

- 每个用户分配唯一签名密钥（与 JWT secret 分离）
- 支持密钥轮换（旧密钥保留 24 小时过渡期）
- 密钥通过安全通道首次下发（HTTPS + 加密存储）

### 4.5 客户端集成

```javascript
// game-client SDK
import { RequestSigner } from './security/RequestSigner';

// 自动签名中间件
const signer = new RequestSigner({
  secretKey: user.signingKey,
  level: 'auto' // 根据请求自动选择等级
});

// 拦截 fetch/XMLHttpRequest
signer.intercept();
```

### 4.6 签名验证中间件

```javascript
// backend/shared/middleware/requestSignature.js
function verifyRequestSignature(options = {}) {
  const {
    level = 'L3',
    maxClockSkewMs = 120000, // 2分钟
    nonceRedis = 'default'
  } = options;

  return async (req, res, next) => {
    // 1. 提取签名相关头
    // 2. 验证时间戳
    // 3. 验证 nonce
    // 4. 计算并验证签名
    // 5. 记录审计日志
  };
}
```

### 4.7 错误码定义

| 错误码 | 消息 | 说明 |
|--------|------|------|
| 1101 | 签名缺失 | 缺少 X-Signature 头 |
| 1102 | 时间戳缺失 | 缺少 X-Timestamp 头 |
| 1103 | 时间戳过期 | 请求已超出时间窗口 |
| 1104 | Nonce 已使用 | 检测到重放攻击 |
| 1105 | 签名验证失败 | 签名不匹配 |
| 1106 | 签名版本不支持 | 版本号不兼容 |

## 5. 验收标准（可测试）

- [ ] 支付 API（/api/v1/payment/*）必须通过签名验证才能执行
- [ ] 交易 API（/api/v1/social/trade）必须通过签名验证
- [ ] 奖励领取 API（/api/v1/reward/claim/*）必须通过签名验证
- [ ] 重放同一请求（相同 nonce）在有效期内被拒绝，返回错误码 1104
- [ ] 修改请求参数后签名验证失败，返回错误码 1105
- [ ] 时间戳超过 2 分钟的请求被拒绝，返回错误码 1103
- [ ] 客户端 SDK 能自动为 L3/L4 级 API 添加签名
- [ ] 签名验证延迟 < 10ms（P95）
- [ ] 单元测试覆盖率 > 90%

## 6. 工作量估算

**M**（中等）

理由：
- 签名算法实现相对简单
- Nonce 系统可复用 Redis 现有基础设施
- 需要修改 gateway 中间件链和客户端 SDK
- 测试工作量适中（多场景验证）

## 7. 优先级理由

P1 理由：
1. 直接影响支付安全和交易安全，属于核心安全需求
2. 没有签名验证，支付和交易系统存在被攻击风险
3. 与 REQ-00003（支付幂等性）协同，共同保障支付安全
4. 实现难度适中，但安全价值高
