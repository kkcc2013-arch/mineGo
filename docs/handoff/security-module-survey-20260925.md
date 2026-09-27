# 安全相关既有模块调研（E17 执行代理，2026-09-25）

E17（安全加固）开工前对仓库中已有安全模块做的盘点。E17 在写基础模块时因 API 额度用尽中断，**以下问题均未修复**。
接手 E17 时以本文为起点；其中标 🔴 的是**当前线上可达代码中的缺陷**，建议优先修。

## 全局事实

- PM2 实际运行：`backend/gateway/src/index.js` + 8 个 `backend/services/*/src/index.js`。
  `backend/services/gateway/`（无 index.js）与仓库根目录的 `gateway/`、`backend/security/` 下的控制器都**不会运行**，只被它们引用的模块是死代码。
- `backend/gateway/shared` 是指向 `../shared` 的软链接。
- 迁移只执行 `database/pending/` 与 `database/migrations/`；**`backend/migrations/*.sql` 从不执行**（`threat_events`、`ip_bans`、`threat_feedback_history` 等表只在那里定义）。
- 很多模块按 winston 风格调用 pino：`logger.info('msg', {meta})`——pino 要求对象在前，meta 字段会丢失。
- `backend/shared/metrics.js` 没有 `increment()`，也没有 `PrometheusMetrics` 导出；调用它们的代码会抛异常。

## 🔴 线上可达代码中的缺陷

| 位置 | 问题 | 后果 |
|---|---|---|
| `backend/shared/IpBanManager.js` + `backend/gateway/src/middleware/ipBan.js`（网关全局中间件） | 命中封禁分支时调用不存在的 `metrics.increment()` → 抛异常 → catch 里 `next()` | **被封禁的 IP 照样放行（fail-open）** |
| 同上 `addToBlacklist` | COMMIT 之后调用 `metrics.increment()` 抛异常 | 封禁已写库但接口报错；`ON CONFLICT DO NOTHING` 使重复封禁不更新过期时间；Redis 黑名单是单个 hash，无按条目 TTL；每个请求做一次 geo-ban 查库；表名 `geo_bans`/`geo_ban` 不一致 |
| `backend/services/user-service/src/routes/ipAppeal.js` | 调用 `getIpBanManager()`，但 user-service 进程里从未初始化 | 恒 500 |
| `backend/shared/mfaService.js` | `const {logger, metrics} = require('./logger')` 得到 `metrics === undefined`；setup/enable/disable 在 COMMIT 后调用 `metrics.mfaSetupTotal?.inc()` 抛异常，随后又对已提交事务 ROLLBACK | **数据已保存但接口返回 500**；setup 从不返回 secret/二维码/恢复码。另：缺 `MFA_ENCRYPTION_KEY` 时回退到硬编码密钥；无 TOTP 重放保护 |
| `backend/services/user-service/src/routes/mfa.js` | setup 需要 `req.user.email`，JWT 中没有 → 恒失败；`POST /users/verify`、`/users/recovery` 从请求体取 `userId` 并签发 mfaToken；`GET /users/` 可能与 userRouter 冲突 | MFA 流程不可用；可能可被滥用 |
| `backend/gateway/src/middleware/mfaRequired.js` | `!req.user.mfaEnabled` 时跳过检查，而 access JWT 从不包含 `mfaEnabled` | **二次验证检查恒被跳过**；签名用 `JWT_SECRET \|\| 'minego-secret'` 而非 `JWT_ACCESS_SECRET` |
| `backend/shared/logger.js` | `redact` 只覆盖顶层 `authorization/cookie/password/token`（无通配，不含 `smsCode/phone/refreshToken`/嵌套字段）；`requestLogger` 记录原始 `query` | 敏感信息可能进日志 |
| user-service `PUT /users/me/password` | 引用 `users.password_hash` / `password_changed_at`，**没有任何迁移创建这两列** | 接口不可用 |
| 登录（`user-service/src/routes/auth.js`） | 手机号 + 短信验证码；登录流程**不做 MFA/风险检查**。access JWT：`{sub, nickname, level, roles[], jti}` | — |

## 各组模块结论（(b)=是否可达，(e)=建议）

**二次验证 / 风险评估**
- `shared/SensitiveOperationGuard.js`、`shared/RiskEvaluator.js`：`require('./database')` 文件不存在，加载即抛；只被测试引用 → 重写（Redis 冷却/累计风险 ZSET、距离/速度计算可复用）。
- `gateway/src/middleware/risk-control.js`：无引用（可自动封号），死代码，仅参考。
- `backend/security/src/sensitiveApiMfa.js`：只被不运行的根目录 `gateway/` 使用；验证码用 `Math.random`；与 `user_mfa` 是两套并行模型 → 借鉴思路即可。
- `shared/risk-engine/`：只被死代码使用；`DynamicRuleLoader` 引用不存在的 `../logging` → 需修，helpers 可复用。
- `shared/RiskControlEngine.js`（Kafka 消费者，1019 行）：无引用，仅参考。`shared/risk-control-engine.js`：重导出的 4 个名字全是 undefined → 删除。

**威胁检测**
- `shared/threatDetection/`（Engine/ResponseExecutor/Middleware/FeatureExtractor）：无引用；规则与统计在内存；自有封禁键 `threat:ban:{ip}` 与 IpBanManager 重复；告警是桩 → 需修，FeatureExtractor（熵、间隔、扫描/机器人检测）可复用。
- `backend/security/src/threatDetectionController.js`：未挂载；依赖未执行的 `backend/migrations` 表；验证码校验是假的（`token.length > 10`）→ 重写。
- `shared/injectionDetector.js`：只被未挂载的中间件使用；**误报极多**（`#`、以 `/` 开头的路径、正常文本里的 select…from 都会命中）；多个模式有多项式回溯风险且无长度上限 → 重写。
- `shared/InjectionGuard.js`：`require('./AttackLogger')` 文件不存在 → 重写。
- `shared/alertCorrelator.js`：运维告警关联，与安全无关。

**脱敏 / 日志**
- `shared/dataMaskingEngine.js`：三个脱敏模块里最好的，可直接复用（`maskData/maskObject/mask*`）。`shared/dataMasking.js`：简单可复用。
- `shared/SensitiveDataMasker.js`：键名模糊匹配误伤（pan→company/japan、pin→shipping、pass→passenger）、无循环/深度保护、每次脱敏同步写文件 → 需修。
- `shared/middleware/logSanitization.js`（长 ID 全被脱敏、`/g` 正则复用 `.test()`）、`logSecurityMiddleware.js`（按 winston 参数顺序处理，对 pino 无效）、`sensitiveDataFilter.js`（**把 req.body/query 替换为脱敏副本**，会让登录拿到脱敏后的密码）、`sensitiveDataAudit.js`（解构的三个函数都是 undefined）→ 需修或重写。

**参数校验**
- 可复用：`shared/validators/commonSchemas.js`（zod）、`validators/errorCodes.js`、`shared/middleware/requestValidator.js`（zod validateBody/Query/...）。
- 实际做法：7 个路由文件在处理函数内直接 `Schema.parse(req.body)`，没有统一校验中间件。
- 不用：`shared/requestValidator.js`（自研编译器，邮箱正则有回溯风险）、`InputSanitizer.js` 的 SQLSanitizer（手工转义引号，反模式）。

**限流 / 配置**（E14+E15+E18 正在重做）
- `gateway/src/middleware/intelligentRateLimit.js`（可达）：挂载的限流器全部用 express-rate-limit **内存存储**（多实例不共享）；`dynamicRateLimiter` 每次调用都 `setInterval`。
- `shared/rateLimitMonitor.js`：绕过检测器（IP 轮换、账号分布、窗口边界）可复用于 REQ-00389。
- `shared/ConfigCenter.js`：Redis `config:{env}:{service}` + pub/sub，可经网关 `/admin/config` 访问（E15 计划改为门面）。

**合规 / 扫描**
- `backend/security/SecurityPolicyEnforcer.js`：依赖不存在的模块 → 重写。`backend/security/scripts/generate-compliance-report.js` 可独立运行，但工作流里的调用路径错误。
- `.github/workflows/security-compliance-scan.yml`：`npm i -g kube-bench`（不是 npm 包）失败后**回退到伪造结果** `{"total":10,"passed":8,"failed":2}` → 需修（推送 token 无 workflow 权限，改动放 `ci/github-workflows/` 由有权限者拷贝）。
- 仓库无 hadolint；根目录有 `.gitleaks.toml`、`.trivyignore`。

## 安全相关迁移（已执行的目录）

`database/migrations/`：015 风控表、055 敏感 API MFA、00521 反作弊、config_audit_log、20260614 安全事件/CSP/CSRF、跨境传输（20260614_130000）、
security_sessions/request_nonces（20260616）、MFA（20260622）、会话安全（20260626）、IP 封禁（20260629）、脱敏审计（20260630）、
敏感操作守卫（20260701）、风控系统（20260708）、协同作弊（20260715）。
`database/pending/`：登录追踪、反作弊表、敏感数据审计/audit_logs、MFA（与 0622 重复）、IP 封禁补充（geo_bans、auto_ban_triggers）、anti-cheat uuid 修复。
**未执行**：`backend/migrations/` 下的威胁检测、安全违规、AR 安全、动态反作弊规则。
