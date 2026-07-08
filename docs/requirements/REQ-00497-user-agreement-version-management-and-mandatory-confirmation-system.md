# REQ-00497: 用户协议变更版本管理与强制确认通知系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00497 |
| 标题 | 用户协议变更版本管理与强制确认通知系统 |
| 类别 | 合规/隐私 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway, user-service, backend/jobs/privacyUpdateNotify.js |
| 创建时间 | 2026-07-08 07:00 |

## 需求描述

为了满足GDPR、COPPA等隐私合规要求，当服务条款或隐私政策发生重大变更时，系统需提供完善的版本管理功能，并强制用户在下次登录时完成更新协议的确认。系统需记录确认时间、版本号及同意内容快照。

## 技术方案

### 1. 协议版本管理
- 在数据库中创建 `privacy_policies` 表，存储协议版本号、发布时间、协议内容摘要或URL。
- 提供 admin-dashboard 接口管理协议版本发布。

### 2. 状态跟踪与强制确认逻辑
- 在 `user_service` 中增加 `user_privacy_status` 记录用户已确认的最高版本号。
- 在 `gateway` 增加中间件 `PrivacyCheckMiddleware`，对比用户确认版本与最新版本，若有差异则在接口响应中返回 403 (PrivacyAgreementUpdateRequired) 并附带更新公告信息，前端根据该状态弹出确认页面。

### 3. 后端记录
- 用户点击确认后，通过API提交确认动作，持久化至 `user_privacy_logs`。

## 验收标准

- [ ] 协议版本可配置发布，支持即时生效。
- [ ] 用户在下次访问核心接口时，能感知到协议更新并强制跳转到确认页。
- [ ] 确认记录包含用户ID、协议版本、确认时间，且不可篡改。
- [ ] 管理员可在后台查询用户协议签署状态。

## 影响范围

- gateway (中间件)
- user-service (数据库表结构变更)
- admin-dashboard (新增管理页)

## 参考

- GDPR Article 7: Conditions for consent
