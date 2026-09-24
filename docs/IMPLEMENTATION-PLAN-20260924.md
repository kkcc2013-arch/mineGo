# mineGo 实施计划与进度（2026-09-24 起）

> 依据：[项目评审报告](review/PROJECT-REVIEW-20260924.md) · [未完成需求清单](requirements/OPEN-REQUIREMENTS.md)
> 本轮范围（已与负责人确认）：**先跑通 → 修评审缺陷 → 实现未完成 P0 中可在服务端落地的部分**
> 验证环境：云端主机，PostgreSQL 16 + PostGIS 3.4，Redis 7，Node 22，PM2 运行全部 9 个服务

## 状态图例

⬜ 未开始 · 🔄 进行中 · ✅ 完成并验证 · ⏸️ 延后（附原因）

## Phase 0 — 安全止血

| # | 任务 | 对应缺陷 | 状态 |
|---|---|---|---|
| 0.1 | `ecosystem.config.js` 移除明文密钥，改为从 `.env` 加载；提供 `.env.example` | S1 | ✅ |
| 0.2 | `NODE_ENV=production` 时强制忽略 `SMS_DEV_MODE` | S2 | ✅ |
| 0.3 | 修复 reward 排行榜 SQL 注入（参数化 + 枚举白名单） | S3 | ✅ |
| 0.4 | 网关管理类接口加管理员鉴权 | S6 | ✅ |
| 0.5 | 统一 JWT 黑名单 key | S7 | ✅ |
| 0.6 | 活动管理接口加 `requireAdmin` | S8 | ✅ |

## Phase 1 — 能启动（PM2 全部 online）

| # | 任务 | 对应缺陷 | 状态 |
|---|---|---|---|
| 1.1 | 修复 user-service / social-service 错误的相对 require | B1 B2 | ✅ |
| 1.2 | 去掉网关对绝对路径软链接的依赖 | B3 | ✅ |
| 1.3 | docker-compose / PM2 补齐必需环境变量；payment 在未配置渠道密钥时降级而非崩溃 | B4 B5 | ✅ |
| 1.4 | 修复种子数据外键、补充刷怪点种子 | C11 | ✅ |
| 1.5 | 新增 `database/bootstrap-dev.js`：多轮收敛执行全部迁移并输出失败报告 | 2.3 | ✅ |
| 1.6 | 修复核心链路依赖的迁移（昼夜系统、特殊 IV）+ `database/tools/fix_fk_types.py` 批量修复外键类型（35 个文件 100 处），新库失败数 102→79 | C3 C5 | ✅ |
| 1.7 | `ecosystem.config.js` 改为可移植：部署目录默认取自身所在目录、配置读 `.env`、实例数可配（未另建 local 配置） | — | ✅ |

## Phase 2 — 主链路可用（注册 → 登录 → 上报位置 → 附近精灵 → 捕捉 → 背包）

| # | 任务 | 对应缺陷 | 状态 |
|---|---|---|---|
| 2.1 | 网关 `pathRewrite` 修正（auth 与 7 个缓存路由） | C1 C8 | ✅ |
| 2.2 | 修复 JWT `exp`/`expiresIn` 冲突 | C2 | ✅ |
| 2.3 | 错误处理器识别 `statusCode/httpStatus`，Zod 错误返回 400 | C7 | ✅ |
| 2.4 | 刷怪：去掉不存在列依赖、坐标转数值、稀有度权重生效、全局刷怪加分布式锁 | C3 C4 P1-3 P1-4 | ✅ |
| 2.5 | 捕捉：修复关闭会话 UPDATE、坐标 `Number.isFinite` 校验、浆果/评级先校验再扣球、原子抢占防重复捕获 | C5 C6 P1-1 P1-2 P1-5 | ✅ |
| 2.6 | 网关新增 `/v1/rewards` 路由 | C9 | ✅ |
| 2.7 | 统一 `req.user.sub` 取用户 id | C10 | ✅ |
| 2.8 | 端到端冒烟脚本 `scripts/smoke-core-flow.js` | — | ✅ |

## Phase 3 — 资金/道具类竞态修复

| # | 任务 | 对应缺陷 | 状态 |
|---|---|---|---|
| 3.1 | 支付回调/校验：条件 UPDATE + `rowCount` 判定，防重复入账 | S4 | ✅ |
| 3.2 | 交易确认：`FOR UPDATE` 锁定 + 持有者校验 | S5 | ✅ |
| 3.3 | 每日登录奖励 `SET NX` 抢占；每日任务条件 UPDATE | P1-7 | ✅ |
| 3.4 | `ipBanMiddleware` 前置；网关 `trust proxy` | P1-8 P1-9 | ✅ |

## Phase 4 — 未完成 P0 需求（服务端部分）

| 需求 | 本轮交付 | 未完成 / 不在本轮范围 | 状态 |
|---|---|---|---|
| REQ-00040 Redis 缓存层 | 网关 `cachedProxy`：按用户隔离、写后失效（用户缓存版本号）、Redis 故障回源、命中率指标与 `/api/admin/cache/stats` | 跨用户数据变化依赖 TTL | ✅ done |
| REQ-00042 分布式追踪 | 网关生成 W3C 兼容 trace id 并透传；AsyncLocalStorage + pino mixin，所有服务日志带 `trace_id` | Jaeger/Loki/Grafana/告警（需容器环境） | 🟡 partial |
| REQ-00044 GDPR 导出/删除 | 导出（归属数据、限频）、删除申请 + 30 天冷却 + 撤销、到期自动清理、管理员立即执行 | 前端 UI | 🟡 partial |
| REQ-00565 敏感字段加密 | `users.phone` AES-256-GCM + HMAC 盲索引 + 多 kid 轮换；回填/轮换脚本 | 其他服务字段、Vault、性能压测 | 🟡 partial |
| REQ-00586 GPS 欺骗检测 | 不可能行程（>1000 km/h）、多账号同坐标、轨迹重建、低可信度降级（位置/捕捉/补给站）、管理员可疑玩家/证据接口 | 客户端检测、地形校验、申诉、监控面板 | 🟡 partial |
| REQ-00592 部署健康检查与回滚 | `scripts/deploy-pm2.sh` + `deploy-health-check.js`，已实测故障版本自动回滚 | K8s operator（生产不用 K8s） | ✅ done |
| REQ-00041 客户端内存防护 | — | 纯客户端能力，需原生客户端 | ⏸️ |
| REQ-00558 团队实时语音 | — | 需 WebRTC/TURN 基础设施 | ⏸️ |

各需求文档末尾已追加"实现记录"，逐条对照验收标准标注 ✅ / ⚠️ / ❌。

## 独立复审与修正

实现完成后用独立代理对全部改动（`5cac6ab..HEAD`）做了只读复审：无高危问题，7 个中危、5 个低危，已全部处理（commit a94544b），主要包括：

- `/v1/gdpr` 改经网关鉴权（含 token 黑名单）；导出限频
- GDPR 清理只删"归属于用户"的行，不再误删他人的队伍/对战/举报与风控证据
- 反作弊：两组坐标不一致或非数字直接拒绝；同一事件只扣一次分；乘机等真实长途移动可重建轨迹
- 服务端位置有效期 5→30 分钟 + 客户端 60 秒心跳（原地不动也能捕捉）
- 分级限流不再读取可伪造的 `X-Forwarded-For`；`TRUST_PROXY` 解析数字/布尔
- 部署脚本在 `if` 条件内逐步显式判错；客户端登录页补上隐私同意勾选
- 之后反复运行冒烟又发现并修复：刷怪点被捕获后长时间不再刷新；同坐标检测精度过粗（1 米）会误伤真实玩家

## 验证结果（云端主机，2026-09-24 17:05）

| 项目 | 结果 |
|---|---|
| PM2 | 9 个服务 12 个进程全部 `online`（gateway/location/catch 各 2 实例） |
| 健康检查 | 网关 `/health` 200，8 个下游全部 `up` |
| 端到端冒烟 `node scripts/smoke-core-flow.js` | **37/37 通过，连续 3 次**（注册/登录/捕捉/背包/补给站/奖励/GDPR/缓存/追踪/反作弊/安全回归） |
| 单元测试 `cd backend && npm run test:unit` | 原有 4 套件全部通过 + 新增 `security-core.test.js` 11/11（直接测试真实模块） |
| 全新数据库迁移 | `bootstrap-dev.js`：115 成功 / 79 失败（本轮新增 5 个迁移全部成功）；`migrate.js up --from 20260924_000000` 可单独执行 |
| 部署回滚演练 | 发布一个启动即崩溃的版本 → 16 秒内检测失败 → 自动回滚 → 回滚后健康 |

## 生产环境（81.68.170.192）上线步骤

> ⚠️ 新的 `ecosystem.config.js` 不再包含任何密钥，**服务器上没有 `.env` 时 PM2 会拒绝启动**（故意的 fail-fast）。

1. **轮换凭据**（旧值已随公开仓库泄露）：数据库密码、Redis 密码、`JWT_ACCESS_SECRET`、`JWT_REFRESH_SECRET`。
2. 在 `/data/mineGo/.env` 按 `.env.example` 填写新凭据，另生成 `FIELD_ENCRYPTION_KEYS`、`FIELD_ENCRYPTION_ACTIVE_KID`、`FIELD_HASH_KEY`；`chmod 600 .env`。
3. 执行新增迁移：`cd backend && node ../database/migrate.js up --from 20260924_000000`。
4. 回填手机号密文：`node scripts/encrypt-user-phones.js --dry-run` 确认后去掉 `--dry-run` 执行，再 `--verify`。
5. 部署：`scripts/deploy-pm2.sh origin/main`（观察 5 分钟，失败自动回滚）。
6. 授予管理员：`UPDATE users SET roles = array_append(roles, 'admin') WHERE id = '<uuid>';`（重新登录后生效）。
7. 服务端口 8081–8088 只应对本机开放（防火墙），外部只暴露网关 8080。

## Phase 5 — 后续轮次（本轮不做，列入待办）

1. 修复剩余 79 个失败迁移（语法 19、缺列 14、缺表 9 …），把 `pending/` 与 `migrations/` 合并为单一有序目录；`migrate.js` 目前单事务执行全部待执行迁移，任何一个失败都会整体回滚。
2. 评审中发现但本轮未处理的功能缺陷：活动系统（`eventService` 引用不存在的导出，全部接口报错）、IP 封禁表迁移失败、补给站掉落的浆果未入账、等级不随经验提升、隐私政策表缺失、道馆战斗使用不存在的表、social `friendService` 引用不存在的指标函数、`TIMESTAMP` 无时区列的时区换算。
3. 清理/接入孤立模块：`backend/shared` 77% 文件不可达，逐个决定接入或删除。
4. 合并 51 个重复需求编号；把"done"定义改为"入口可达 + 网关可访问 + 迁移可执行 + 有真实测试"。
5. 408 条 P1 需求按"主链路相关度"重排后分批实施；优先 REQ-00619（战斗引擎测试）、REQ-00617（RUM）。

## 进度日志

| 时间 (UTC+8) | 内容 |
|---|---|
| 2026-09-24 15:10 | 克隆仓库，搭建 PG16+PostGIS、Redis 7 环境 |
| 2026-09-24 15:40 | 完成评审（3 路并行审查：核心服务 / 外围服务 / done 需求真实性），输出评审报告与未完成需求清单 |
| 2026-09-24 15:45 | 新增 `database/bootstrap-dev.js`，新库执行结果：87 成功 / 102 失败 |
| 2026-09-24 16:00 | Phase 0/1/2 完成：9 个服务在 PM2 下全部 online，`/health` 全部 200；迁移失败降至 79；`scripts/smoke-core-flow.js` 20/20 通过（commit 5de1197） |
| 2026-09-24 16:06 | Phase 3 完成：支付防重复入账、交易防盗换、签到/任务防重复领取、排行榜注入修复；顺带修复排行榜恒 500；冒烟 23 项（commit b57e7ee） |
| 2026-09-24 16:12 | REQ-00586 服务端 GPS 欺骗检测（commit 258e9a7） |
| 2026-09-24 16:17 | REQ-00044 GDPR 导出/删除（commit 1392d06） |
| 2026-09-24 16:20 | REQ-00565 手机号加密 + 盲索引，已实测密钥轮换 k1→k2（commit 52103a4） |
| 2026-09-24 16:23 | REQ-00040 网关读缓存（commit 2b26dfb）；REQ-00042 trace_id 贯通（commit c4025b7） |
| 2026-09-24 16:28 | REQ-00592 PM2 部署健康检查与自动回滚，完成正常部署与故障回滚两次演练（commit 04cff43） |
| 2026-09-24 16:30 | 修复 `migrate.js`（无法加载 pg、成功后崩溃），新增 `--from`；全新库验证新增迁移（commit 328b0da） |
| 2026-09-24 16:45 | 独立复审 12 项问题全部处理（commit a94544b） |
| 2026-09-24 17:05 | 反复运行冒烟时暴露两处问题并修复：刷怪点上的精灵被捕获后 30 分钟内不再刷新（且会把已捕获精灵加回 GEO 索引）；"多账号同坐标"精度 1 米会误伤聚集在热门补给站的真实玩家，改为 1 厘米。冒烟连续 3 次 37/37，单测全部通过 |
