# mineGo 项目评审报告（2026-09-24）

> 评审对象：`main@5cac6ab`（2026-07-21 最后一次提交，共 918 个 commit）
> 评审方式：静态阅读 + require 依赖图分析 + 在全新 PostgreSQL 16/PostGIS 3.4 + Redis 7 环境中实际启动各服务并请求接口
> 配套文档：[未完成需求清单](../requirements/OPEN-REQUIREMENTS.md) · [实施计划与进度](../IMPLEMENTATION-PLAN-20260924.md)
> 处置情况：第 2 节全部 P0 缺陷与第 4 节 P1 问题 1–10 已在本轮修复（见实施计划 Phase 0–3 与"独立复审与修正"）；第 2.3 节迁移失败数 102 → 79。

## 1. 结论摘要

| 项目 | 文档自评 | 实测 |
|---|---|---|
| 成熟度评分 | 160 / 100（`docs/STATUS.md`） | 核心链路无法跑通，不具备上线条件 |
| 需求数 | 625 条 | 661 个文件、600 个唯一编号，其中 **51 个编号重复** |
| 已完成需求 | 212 | 抽样 40 条：**仅 8 条（20%）在运行时可通过网关访问**，外推约 41 条 |
| 未完成需求 | — | **446 条**（P0 8、P1 408、P2 30） |
| 数据库迁移 | — | 189 个迁移文件中 **102 个在新库上执行失败** |
| 服务启动 | 9 个服务 | 按仓库原样启动：user-service、social-service 启动即崩；docker-compose 下 8 个服务因缺少 `JWT_REFRESH_SECRET` 崩溃 |
| 核心链路 | "主链路闭环" | 注册/登录 404→500；刷怪 0 只；捕捉事务必然回滚 |
| 代码规模 | — | 后端约 42 万行 JS；`backend/shared` 557 个文件中 **77% 从任何服务入口都不可达** |

**核心判断**：项目由自动化 Agent 每小时生成需求并"实现"，实现物大量是未接入运行时的孤立模块，状态文档与事实严重脱节。当前最高优先级不是继续新增需求，而是让现有主链路真正可用、堵住安全漏洞、修复迁移链。

## 2. 阻断性缺陷（P0）

### 2.1 安全

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| S1 | `ecosystem.config.js:14-34` | 生产数据库密码、Redis 密码、JWT 签名密钥明文提交在**公开仓库** | 任何人可伪造任意用户 token、直连数据库 |
| S2 | `ecosystem.config.js:31` + `user-service/src/routes/auth.js:68` | 生产环境 `SMS_DEV_MODE=true`，`/auth/sms-code` 直接返回验证码 | 可登录任意手机号账号 |
| S3 | `reward-service/src/index.js:202` | 排行榜 `team` 参数字符串拼接进 SQL | SQL 注入 |
| S4 | `payment-service/src/index.js:205-310` | 订单状态在事务外读取、UPDATE 无 `status='PENDING'` 条件，序列化重试会重复执行回调 | 同一订单可重复入账精币 |
| S5 | `social-service/src/routes/trade.js:247-342` | 交易确认不校验当前持有者、状态无条件更新 | 一只精灵可同时挂 N 个交易，换走 N 只 |
| S6 | `gateway/src/index.js:442-488` | `/api/admin/*`、`/api/budgets`、`/api/v1/autoscaling/execute` 等管理接口无鉴权 | 任意调用管理操作 |
| S7 | `user-service/src/routes/auth.js:235` vs `shared/JwtBlacklist.js:11` | 刷新时查 `token:blacklist:`，登出写 `blacklist:token:` | 登出后 refresh token 仍可续签 |
| S8 | `reward-service/src/routes/events.js:76,202,219,236` | 活动创建/暂停/恢复/取消只校验登录 | 任意玩家可操作全服活动 |

### 2.2 启动与主链路

| # | 位置 | 问题 |
|---|---|---|
| B1 | `user-service/src/routes/timezone.js:10-12` | `require('../../../shared/...')` 路径错误，user-service 启动即 `MODULE_NOT_FOUND` |
| B2 | `social-service/src/routes/pvp.js:9-13`、`leaderboard.js:9` | 同类相对路径错误，social-service 启动即崩 |
| B3 | `gateway/src/routes/autoscaling.js:7-8` + `backend/gateway/shared` | 依赖一个指向 `/data/mineGo/backend/shared` 的**绝对路径软链接**，离开生产机器即崩 |
| B4 | `docker-compose.yml` | 除 user-service 外所有服务缺 `JWT_REFRESH_SECRET`，`shared/auth.js:94` 在 production 下加载即抛错 |
| B5 | `payment-service/src/index.js:44-49` | production 下强制要求 `WECHAT_SECRET/ALIPAY_SECRET/APPLE_SHARED_SECRET`，PM2 配置里没有，启动失败 |
| C1 | `gateway/src/index.js:279,295,317` | `pathRewrite` 作用在已剥离前缀的路径上：`/v1/auth/login` 到达 user-service 变成 `/login`（应为 `/auth/login`），注册/登录全部 404 |
| C2 | `user-service/src/routes/auth.js:292` + `shared/auth.js:113` | payload 自带 `exp` 同时又传 `expiresIn`，jsonwebtoken 抛错，注册/登录/刷新全部 500 |
| C3 | `location-service/src/index.js:99` | 刷怪 SQL 查询 V1 中不存在的 `time_preference/is_nocturnal/is_diurnal`（对应迁移执行失败），**一只精灵都刷不出来** |
| C4 | `location-service/src/index.js:125` + `shared/weatherService.js:128` | `NUMERIC` 坐标被 pg 返回为字符串，天气服务校验失败抛错，刷怪第二个独立失败点 |
| C5 | `catch-service/src/index.js:235,115` | 查询 `is_zero_iv/is_perfect_iv` 列（迁移失败未建），`/catch/session` 恒 500 |
| C6 | `catch-service/src/index.js:157-161` | 关闭会话的 UPDATE 传了 7 个参数却不使用 `$1`，PG 报错导致捕捉事务回滚（球已扣），且 `WHERE id` 绑定的是野生精灵 id 而非会话 id |
| C7 | `shared/errorHandler.js:214` | 不识别 `AppError/AuthenticationError`，球不够、距离太远、未登录等全部变成 500 |
| C8 | `gateway/src/index.js:321-420` | 7 个带缓存的 `app.get` 路由路径被重写成 `/pokemon/v1/pokemon/pokedex` 之类，全部 404 |
| C9 | 网关 | 没有 `/v1/rewards` 路由，reward-service 完全无法从外部访问 |
| C10 | `gym-service/src/routes/battle.js` 等 | 读取 `req.user.id`，但 token 字段是 `sub`，所有依赖用户身份的道馆/公会/市场/排行逻辑拿到 `undefined` |
| C11 | 数据 | 种子数据 `evolves_to` 引用了不存在的 55/75/80 号精灵，整批 `pokemon_species` 插入失败；`spawn_points` 为空 |

### 2.3 数据库迁移链

- 迁移文件分散在 `database/pending/`（76）和 `database/migrations/`（115）两处，存在 4 种命名格式、重复文件；`migrate.js` 只读 `pending/`，docker-compose 只加载 V1。
- 在新库上逐个执行（多轮重试依赖顺序）后仍有 **102 个失败**，失败分类：
  - 35 个：外键类型不匹配（`INTEGER/VARCHAR` 引用 `users(id) UUID`）
  - 19 个：SQL 语法错误（MySQL 风格内联 `INDEX`、`COMMENT` 等）
  - 23 个：引用不存在的表/列
  - 其余：分区键、不可变函数、缺少角色 `minego_user`、`pg_cron` 扩展等
- 结果：大量"已完成"功能（交易、PVP、公会、市场、MFA、IP 封禁、GDPR 等）所依赖的表在新环境中根本不存在。

完整失败清单见 `database/bootstrap-report.json`（由新增的 `database/bootstrap-dev.js` 生成）。

## 3. "done" 需求真实性核验

按编号均匀抽取 40 条 `done` 需求（含 20 条 P0），逐条核对：文件是否存在 → 是否从服务入口可达 → 依赖的表能否建出 → 网关是否能路由到。

| 分类 | 含义 | 数量 |
|---|---|---|
| WIRED | 服务能启动且网关可达 | 8 |
| WIRED-INT | 已挂载在服务上，但网关无路由（外部不可用） | 8 |
| BROKEN | 已挂载但必然失败（服务崩溃/路径错误/中间件位置错） | 6 |
| ORPHAN | 代码存在但没有任何入口引用 | 15 |
| STUB | 测试只 mock 自身、不引用业务代码 | 2 |
| MISSING | 文件不存在 | 1 |

典型例子：REQ-00494 行为风控（`RiskControlEngine.js` 1020 行无人引用）、REQ-00375 多区域容灾（3 个独立进程启动即崩）、REQ-00543 客户端加密（`index.html` 未引入）、REQ-00126/00149 MFA 与申诉（挂在启动即崩的 user-service 上）。

另：213 个 `done` 文档中有 200 个验收标准复选框全部未勾选；262 个测试文件中 83 个 require 路径无法解析。

## 4. 其他重要问题（P1）

| # | 问题 |
|---|---|
| 1 | 捕捉距离校验信任客户端坐标，传 `"x"` 得到 `NaN`，`NaN > 100` 为 false，可远程捕捉 |
| 2 | 捕捉无并发保护，同一野生精灵可被重复捕获 |
| 3 | 稀有度权重从未生效，传说精灵与普通精灵刷新概率相同 |
| 4 | 每次 `/map/nearby` 都触发一次全局刷怪循环，且 2 个 cluster 实例无锁，重复刷怪、DB 压力大 |
| 5 | 浆果类型/投掷评级未校验：未知浆果使概率变 NaN；投掷评级非法时先扣球后 500 |
| 6 | 补给站旋转无距离/存在校验，冷却为先查后插存在竞态 |
| 7 | 每日登录奖励、每日任务领奖、好友礼物开启均为先查后写，可并发重复领取 |
| 8 | `ipBanMiddleware` 注册在所有路由之后，只对 404 生效 |
| 9 | 限流按 `req.ip` 且未设置 `trust proxy`，网关后所有用户共享同一限额 |
| 10 | `evolution.js`、`dayNight.js` 等直接信任 `x-user-id` 请求头 |
| 11 | 道馆 raid 伤害取客户端值；战斗 WebSocket 用未配置的 `JWT_SECRET` 校验，且端口 8086 与 social-service 冲突 |
| 12 | 各服务 `package.json` 缺少实际使用的依赖（Docker 分服务安装时会 `MODULE_NOT_FOUND`） |

## 5. 做得好的部分

- 服务划分、端口规划、网关服务映射清晰，与 PM2 配置一致。
- 核心 SQL 基本参数化；动态列名均走白名单。
- V1 基础 schema（PostGIS 空间索引、捕捉会话/投掷记录）设计合理。
- 5 个原有单元测试套件全部通过（catch 25、auth 14、spawn 15、logger-metrics、payment）。

## 6. 建议

1. **立即**轮换 81.68.170.192 上的数据库密码、Redis 密码、JWT 密钥（旧值已公开），关闭生产 `SMS_DEV_MODE`。
2. 暂停"每小时新增一条需求"的自动循环，先按 [实施计划](../IMPLEMENTATION-PLAN-20260924.md) 修复主链路。
3. 把"done"的定义改为：代码可从服务入口到达 + 网关可访问 + 迁移可在新库执行 + 有覆盖真实代码的测试。
4. 合并重复编号需求，把 `docs/STATUS.md` 评分改为基于可验证事实。
