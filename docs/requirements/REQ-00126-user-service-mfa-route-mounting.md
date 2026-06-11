# REQ-00126: user-service MFA 路由挂载与集成

- **编号**: REQ-00126
- **类别**: 集成与修复
- **优先级**: P0
- **状态**: done
- **涉及服务/模块**: user-service, backend/services/user-service/src/routes/mfa.js, backend/services/user-service/src/index.js
- **创建时间**: 2026-06-11 20:05
- **父需求**: REQ-00057（多因素认证 MFA 系统）

## 背景与价值

REQ-00057 已实现完整的 MFA（多因素认证）系统代码，包括 TOTP、备份码、验证中间件等核心功能，但路由文件 `backend/services/user-service/src/routes/mfa.js` 从未在 `user-service` 的 `index.js` 中挂载，导致 7 个 API 端点全部不可达：

- `POST /auth/mfa/enable` - 启用 MFA
- `POST /auth/mfa/verify` - 验证 MFA 代码
- `POST /auth/mfa/disable` - 禁用 MFA
- `POST /auth/mfa/regenerate-backup-codes` - 重新生成备份码
- `GET /auth/mfa/status` - 查询 MFA 状态
- `POST /auth/mfa/verify-backup-code` - 使用备份码验证
- `GET /auth/mfa/backup-codes` - 获取备份码列表

这导致用户无法使用已实现的 MFA 安全功能，存在安全隐患。本需求仅挂载路由并验证可达性，无需额外开发。

## 验收标准（必填，必须是可执行命令）

- [ ] `node --check backend/services/user-service/src/routes/mfa.js` 通过（语法检查）
- [ ] `grep -q "require('./routes/mfa')" backend/services/user-service/src/index.js` 通过（路由已挂载）
- [ ] `curl -sf http://localhost:3002/api/v1/auth/mfa/status -H "Authorization: Bearer test_token"` 返回非 404（路由可达）
- [ ] `node -e "require('./backend/services/user-service/src/routes/mfa')"` 通过（模块可加载）

## 完成定义（DoD）

代码已提交 ≠ 完成。全部验收命令通过 + 路由可达 + CI 绿 = 完成。

## 工作量估算

S（仅需在 index.js 添加一行挂载代码并验证）

## 优先级理由

P0 级别，理由：
1. 安全功能已实现但不可用，存在用户账号安全风险
2. 属于 GUIDELINES.md §6 欠账清单中的高优先级项
3. 实现成本极低（S 级），但对安全合规影响重大
4. 解锁 REQ-00057 的全部功能价值
