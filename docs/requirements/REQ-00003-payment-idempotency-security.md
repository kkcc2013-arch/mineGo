# REQ-00003：支付订单幂等性与签名验证安全加固

- **编号**：REQ-00003
- **类别**：安全加固
- **优先级**：P0
- **状态**：done
- **涉及服务/模块**：payment-service、gateway
- **创建时间**：2026-06-04 17:00
- **依赖需求**：无

## 1. 背景与问题

当前支付服务存在严重安全隐患：

1. **缺少幂等性保护**：用户重复提交订单可能导致重复扣款或重复发货
2. **Webhook 签名未验证**：payment-service 接收支付渠道回调时未验证签名，存在伪造支付成功的风险
3. **缺少订单状态机**：订单状态流转缺少合法性校验，可能导致非法状态变更
4. **敏感信息泄露风险**：订单查询接口返回了不必要的支付渠道原始响应数据

这些问题可能导致：
- 重复扣款、资损
- 黑产伪造支付回调，免费获取游戏道具
- 订单状态混乱，运营对账困难

## 2. 目标

1. 实现支付订单幂等性保护，防止重复提交
2. 对所有支付渠道回调进行签名验证，杜绝伪造
3. 建立严格的订单状态机，防止非法状态流转
4. 清理敏感信息返回，仅保留必要字段

**预期收益**：
- 消除支付安全漏洞，防止资金损失
- 提升订单处理可靠性，降低客诉率
- 通过金融级安全审计

## 3. 范围

- **包含**：
  - 订单创建接口增加幂等性保护（Idempotency-Key 机制）
  - 支付回调接口增加签名验证（HMAC-SHA256）
  - 订单状态机实现与校验
  - 订单查询接口脱敏处理
  - 单元测试覆盖

- **不包含**：
  - 第三方支付渠道 SDK 升级
  - 支付对账系统开发
  - 退款流程优化

## 4. 详细需求

### 4.1 订单幂等性保护

```javascript
// 在 payment-service 创建订单时：
// 1. 检查 X-Idempotency-Key 头
// 2. Redis 存储幂等键（TTL 24h）
// 3. 如果键存在，返回已创建的订单而非重复创建

// 幂等键格式: payment:create:{userId}:{idempotencyKey}
// 存储: { orderId, status, createdAt }
```

### 4.2 Webhook 签名验证

```javascript
// 验证流程：
// 1. 从请求头获取 X-Signature（或 X-Pay-Signature）
// 2. 使用预配置的密钥对请求体进行 HMAC-SHA256
// 3. 比对签名是否一致
// 4. 签名不匹配返回 401，记录安全日志

// 支持多渠道配置：
const CHANNEL_SECRETS = {
  alipay: process.env.ALIPAY_SECRET,
  wechat: process.env.WECHAT_SECRET,
  apple:  process.env.APPLE_SHARED_SECRET,
};
```

### 4.3 订单状态机

```
订单状态流转图：
  pending → paid → fulfilled
      ↓        ↓
  cancelled  refunded

合法流转：
- pending → paid（支付成功）
- pending → cancelled（用户取消/超时）
- paid → fulfilled（发货完成）
- paid → refunded（退款）

非法流转（应拒绝）：
- paid → pending
- fulfilled → paid
- fulfilled → cancelled
```

### 4.4 敏感信息脱敏

```javascript
// 订单查询返回字段白名单：
{
  orderId,
  amount,
  currency,
  status,
  productName,
  createdAt,
  paidAt,
  // 不返回：channelResponse、rawCallback、signature 等
}
```

### 4.5 API 接口设计

```javascript
// POST /payment/orders - 创建订单
Headers:
  X-Idempotency-Key: <uuid>  // 必填，24小时内幂等
Body:
  { productId, quantity, channel }
Response:
  { orderId, amount, paymentUrl, expiresAt }

// POST /payment/webhook/:channel - 支付回调
Headers:
  X-Signature: <hmac-sha256>
Body:
  { orderId, channelData... }
Response:
  { success: true }
```

## 5. 验收标准（可测试）

- [ ] 创建订单时，相同 X-Idempotency-Key 返回相同订单，不重复创建
- [ ] 无签名或错误签名的 Webhook 请求返回 401 并记录安全日志
- [ ] 所有合法状态流转均成功，非法流转返回 400 错误
- [ ] 订单查询接口不返回 channelResponse、rawCallback、signature 字段
- [ ] 单元测试覆盖率 > 90%，包含幂等性、签名验证、状态机测试
- [ ] 安全审计日志记录所有关键操作（创建、回调、状态变更）

## 6. 工作量估算

**M（2-3天）**

理由：
- 涉及支付核心逻辑，需要谨慎实现
- 状态机逻辑相对简单
- 签名验证已有成熟方案
- 需要充分测试，避免影响生产环境

## 7. 优先级理由

**P0 级别**

1. **安全隐患严重**：Webhook 签名未验证是金融级漏洞，可能被黑产利用
2. **资损风险高**：缺少幂等性可能导致重复扣款、资金损失
3. **合规要求**：支付系统必须通过安全审计才能上线
4. **对项目可用性的贡献**：支付是核心商业闭环，必须安全可靠
