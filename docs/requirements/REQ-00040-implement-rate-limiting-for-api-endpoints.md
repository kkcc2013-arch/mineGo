# REQ-00040: Implement Rate Limiting for API Endpoints

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00040 |
| 标题 | Implement Rate Limiting for API Endpoints |
| 类别 | 安全加固 |
| 优先级 | P0 |
| 状态 | new |
| 涉及服务 | gateway-service |
| 创建时间 | 2026-07-08 14:00 |

## 需求描述

为了防止 API 被恶意调用、滥用或遭受 DDoS 攻击，需要在网关层实现请求限流机制。限制每个 IP 地址或用户在单位时间内的请求次数。

## 技术方案

### 1. 限流策略
- 基于 `express-rate-limit` 中间件实现。
- 支持基于 IP 地址的滑动窗口限流。
- 支持针对特定高风险接口的精细化限流。

### 2. 配置与集成
- 将限流配置集成到 `gateway/src/middleware/intelligentRateLimit.js`。
- 在 `gateway/src/routes/` 中根据接口重要性应用不同策略。

## 验收标准

- [ ] 限流功能在所有生产环境 API 端点启用。
- [ ] 超过限流阈值时返回 HTTP 429 Too Many Requests 状态码。
- [ ] 被限流的请求记录日志并发送告警。

## 影响范围

- `gateway-service`

## 参考

- [express-rate-limit documentation](https://www.npmjs.com/package/express-rate-limit)
