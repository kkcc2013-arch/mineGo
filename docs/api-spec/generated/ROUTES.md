# 路由清单（自动生成）

> node scripts/api-lint.js --docs 生成；CI 用 --check-docs 校验与代码一致。


## catch

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/catch/session` | REQ-00586: 可信度低于 RESTRICTED(40) 的玩家禁止捕捉（位置功能降级） |
| POST | `/catch/throw` |  |

## gateway

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/api/deprecations` |  |
| POST | `/admin/api/deprecations` |  |
| DELETE | `/admin/api/deprecations/:id` |  |
| GET | `/admin/api/deprecations/:id` |  |
| PATCH | `/admin/api/deprecations/:id` |  |
| POST | `/admin/api/deprecations/:id/clients/:clientId/migrated` |  |
| POST | `/admin/api/deprecations/notify` |  |
| GET | `/admin/cache/warmup/status` | ── Cache Warmup Management API (REQ-00039) ──────────────────── 获取预热状态 |
| POST | `/admin/cache/warmup/trigger` | 手动触发预热 |
| GET | `/admin/config` | GET /admin/config 获取所有服务的配置概览 |
| GET | `/admin/config/:serviceName` | GET /admin/config/:serviceName 获取指定服务的配置 |
| DELETE | `/admin/config/:serviceName/:key` | DELETE /admin/config/:serviceName/:key 删除配置项 |
| GET | `/admin/config/:serviceName/:key` | GET /admin/config/:serviceName/:key 获取指定配置项 |
| PUT | `/admin/config/:serviceName/:key` | PUT /admin/config/:serviceName/:key 更新单个配置项 |
| GET | `/admin/config/:serviceName/audit` | GET /admin/config/:serviceName/audit 获取配置审计日志 |
| POST | `/admin/config/:serviceName/batch` | POST /admin/config/:serviceName/batch 批量更新配置 |
| GET | `/admin/config/:serviceName/history` | GET /admin/config/:serviceName/history 获取配置变更历史 |
| POST | `/admin/config/:serviceName/rollback` | POST /admin/config/:serviceName/rollback 回滚到指定版本 |
| GET | `/admin/config/health` | GET /admin/config/health 配置中心健康检查 |
| GET | `/api/admin/api-standards/compat-report` |  |
| GET | `/api/admin/api-standards/config` |  |
| PATCH | `/api/admin/api-standards/config` |  |
| GET | `/api/admin/api-standards/field-usage/:resourceType` |  |
| GET | `/api/admin/api-standards/fieldsets` |  |
| POST | `/api/admin/api-standards/fieldsets` |  |
| GET | `/api/admin/api-standards/lint` |  |
| GET | `/api/admin/api-standards/performance` |  |
| POST | `/api/admin/api-standards/performance/evaluate` |  |
| GET | `/api/admin/api-standards/retry` |  |
| GET | `/api/admin/api-standards/schemas` |  |
| GET | `/api/admin/api-standards/schemas/:id` |  |
| GET | `/api/admin/api-standards/schemas/:id/diff` |  |
| GET | `/api/admin/api-standards/schemas/:id/mock` |  |
| POST | `/api/admin/api-standards/schemas/:id/validate` |  |
| GET | `/api/admin/api-standards/schemas/violations` |  |
| POST | `/api/admin/api-standards/validate-body` |  |
| GET | `/api/admin/api-versions` |  |
| PATCH | `/api/admin/api-versions/:version` |  |
| POST | `/api/admin/api-versions/:version/changes` |  |
| GET | `/api/admin/api-versions/transforms` |  |
| POST | `/api/admin/api-versions/transforms` |  |
| DELETE | `/api/admin/api-versions/transforms/:id` |  |
| GET | `/api/admin/cache/stats` | ── REQ-00040: 网关缓存命中率 ─────────────────────────────── |
| GET | `/api/admin/delay-queue/buckets` | GET /api/admin/delay-queue/buckets Get delay bucket information |
| POST | `/api/admin/delay-queue/dlq/:taskId/retry` | POST /api/admin/delay-queue/dlq/:taskId/retry Retry a DLQ task manually |
| GET | `/api/admin/delay-queue/health` | GET /api/admin/delay-queue/health Get queue health status |
| GET | `/api/admin/delay-queue/monitor` | GET /api/admin/delay-queue/monitor Get monitor statistics |
| POST | `/api/admin/delay-queue/monitor/clear-alerts` | POST /api/admin/delay-queue/monitor/clear-alerts Clear alert counts |
| POST | `/api/admin/delay-queue/monitor/config` | POST /api/admin/delay-queue/monitor/config Update monitor configuration |
| POST | `/api/admin/delay-queue/recurring` | POST /api/admin/delay-queue/recurring Schedule a recurring task |
| DELETE | `/api/admin/delay-queue/recurring/:taskId` | DELETE /api/admin/delay-queue/recurring/:taskId Cancel a recurring task |
| GET | `/api/admin/delay-queue/scheduler` | GET /api/admin/delay-queue/scheduler Get scheduler statistics |
| GET | `/api/admin/delay-queue/stats` | GET /api/admin/delay-queue/stats Get queue statistics |
| POST | `/api/admin/delay-queue/tasks` | POST /api/admin/delay-queue/tasks Manually schedule a task |
| GET | `/api/admin/dependencies` | GET /api/admin/dependencies 获取完整依赖图 |
| GET | `/api/admin/dependencies/:service` | GET /api/admin/dependencies/:service 获取单个服务的依赖详情 |
| GET | `/api/admin/dependencies/cycles` | GET /api/admin/dependencies/cycles 检测循环依赖 |
| GET | `/api/admin/dependencies/graph` | GET /api/admin/dependencies/graph 获取 Mermaid 格式依赖图 |
| GET | `/api/admin/dependencies/impact/:service` | GET /api/admin/dependencies/impact/:service 分析服务故障影响范围 |
| POST | `/api/admin/dependencies/refresh` | POST /api/admin/dependencies/refresh 强制刷新依赖分析缓存 |
| GET | `/api/admin/dependencies/startup-order` | GET /api/admin/dependencies/startup-order 获取服务启动顺序 |
| GET | `/api/admin/deprecations` |  |
| POST | `/api/admin/deprecations` |  |
| DELETE | `/api/admin/deprecations/:id` |  |
| GET | `/api/admin/deprecations/:id` |  |
| PATCH | `/api/admin/deprecations/:id` |  |
| POST | `/api/admin/deprecations/:id/clients/:clientId/migrated` |  |
| POST | `/api/admin/deprecations/notify` |  |
| GET | `/api/admin/geo-ban` | GET /api/admin/geo-ban 查询地理位置封禁列表 |
| POST | `/api/admin/geo-ban` | POST /api/admin/geo-ban 添加地理位置封禁 |
| DELETE | `/api/admin/geo-ban/:country` | DELETE /api/admin/geo-ban/:country 解除地理位置封禁 |
| GET | `/api/admin/ip-appeals` | GET /api/admin/ip-appeals 查询申诉列表 |
| POST | `/api/admin/ip-appeals/:id/approve` | POST /api/admin/ip-appeals/:id/approve 批准申诉并解封 IP |
| POST | `/api/admin/ip-appeals/:id/reject` | POST /api/admin/ip-appeals/:id/reject 拒绝申诉 |
| GET | `/api/admin/ip-blacklist` | GET /api/admin/ip-blacklist 查询黑名单列表 |
| POST | `/api/admin/ip-blacklist` | POST /api/admin/ip-blacklist 添加 IP 到黑名单 |
| DELETE | `/api/admin/ip-blacklist/:ip` | DELETE /api/admin/ip-blacklist/:ip 从黑名单移除 IP |
| GET | `/api/admin/ip-blacklist/stats` | GET /api/admin/ip-blacklist/stats 黑名单统计 |
| GET | `/api/admin/ip-risk/:ip` | GET /api/admin/ip-risk/:ip 查询 IP 风险评分详情 |
| POST | `/api/admin/ip-risk/:ip/reset` | POST /api/admin/ip-risk/:ip/reset 重置 IP 风险评分 |
| GET | `/api/admin/ip-whitelist` | GET /api/admin/ip-whitelist 查询白名单列表 |
| POST | `/api/admin/ip-whitelist` | POST /api/admin/ip-whitelist 添加 IP 到白名单 |
| DELETE | `/api/admin/ip-whitelist/:ip` | DELETE /api/admin/ip-whitelist/:ip 从白名单移除 IP |
| POST | `/api/batch` |  |
| GET | `/api/batch/stats` |  |
| GET | `/api/batch/templates` |  |
| POST | `/api/batch/templates/:name` |  |
| GET | `/api/budgets/anomalies` | GET /api/costs/anomalies 获取成本异常 |
| GET | `/api/budgets/budgets` | GET /api/budgets 获取预算列表和状态 |
| POST | `/api/budgets/budgets` | POST /api/budgets 创建新预算 |
| DELETE | `/api/budgets/budgets/:name` | DELETE /api/budgets/:name 删除预算 |
| POST | `/api/budgets/budgets/reset-alerts` | POST /api/budgets/reset-alerts 重置预算告警状态 |
| GET | `/api/budgets/by-service` | GET /api/costs/by-service 按服务获取成本 |
| POST | `/api/budgets/collect` | POST /api/costs/collect 手动触发成本采集 |
| GET | `/api/budgets/history` | GET /api/costs/history 获取成本历史 |
| GET | `/api/budgets/prediction` | GET /api/costs/prediction 获取成本预测 |
| GET | `/api/budgets/report` | GET /api/costs/report 生成成本报告 |
| GET | `/api/budgets/summary` | GET /api/costs/summary 获取成本概览 |
| GET | `/api/costs/anomalies` | GET /api/costs/anomalies 获取成本异常 |
| GET | `/api/costs/budgets` | GET /api/budgets 获取预算列表和状态 |
| POST | `/api/costs/budgets` | POST /api/budgets 创建新预算 |
| DELETE | `/api/costs/budgets/:name` | DELETE /api/budgets/:name 删除预算 |
| POST | `/api/costs/budgets/reset-alerts` | POST /api/budgets/reset-alerts 重置预算告警状态 |
| GET | `/api/costs/by-service` | GET /api/costs/by-service 按服务获取成本 |
| POST | `/api/costs/collect` | POST /api/costs/collect 手动触发成本采集 |
| GET | `/api/costs/history` | GET /api/costs/history 获取成本历史 |
| GET | `/api/costs/prediction` | GET /api/costs/prediction 获取成本预测 |
| GET | `/api/costs/report` | GET /api/costs/report 生成成本报告 |
| GET | `/api/costs/summary` | GET /api/costs/summary 获取成本概览 |
| GET | `/api/deprecations` |  |
| GET | `/api/deprecations/:id/migration-guide` |  |
| GET | `/api/device/:deviceId` | GET /api/device/:deviceId 获取设备信息 |
| GET | `/api/device/:deviceId/accounts` | GET /api/device/:deviceId/accounts 获取设备关联的账号列表 |
| POST | `/api/device/:deviceId/ban` | POST /api/device/:deviceId/ban 封禁设备 |
| POST | `/api/device/:deviceId/unban` | POST /api/device/:deviceId/unban 解封设备 |
| GET | `/api/device/logs/:deviceId` | GET /api/device/logs/:deviceId 获取设备检测日志 |
| POST | `/api/device/register` | POST /api/device/register 设备注册与完整性检测 |
| GET | `/api/device/rules` | GET /api/device/rules 获取设备风险规则列表 |
| PUT | `/api/device/rules/:ruleId` | PUT /api/device/rules/:ruleId 更新设备风险规则 |
| GET | `/api/device/statistics/cluster` | GET /api/device/statistics/cluster 获取群控设备列表 |
| GET | `/api/device/statistics/emulators` | GET /api/device/statistics/emulators 获取模拟器设备列表 |
| GET | `/api/device/statistics/overview` | GET /api/device/statistics/overview 获取设备统计概览 |
| GET | `/api/device/statistics/risky` | GET /api/device/statistics/risky 获取高风险设备列表 |
| GET | `/api/discover` |  |
| GET | `/api/errors` |  |
| GET | `/api/errors/:name` |  |
| GET | `/api/events` | @route   GET /api/events @desc    查询业务事件 @query   type - 事件类型（可选） @query   category - 事件类别（可选） @query   userId - 用户 ID（可选） @query   startTime - 开始时间（ISO 8601） @query   endTime - 结束时间（ISO 8601） @query   limit - 返回数量（默认 100） @query   offset - 偏移量（默认 0） @access  Admin |
| GET | `/api/events/heatmap` | @route   GET /api/events/heatmap @desc    获取事件地理热力图数据 @query   eventType - 事件类型（可选） @query   startTime - 开始时间 @query   endTime - 结束时间 @query   precision - 经纬度精度（默认 2） @access  Admin |
| GET | `/api/events/realtime` | @route   GET /api/events/realtime @desc    获取实时业务指标 @access  Admin |
| GET | `/api/events/stats` | @route   GET /api/events/stats @desc    获取事件统计（按类别/类型分组） @query   interval - 时间间隔（hour/day） @query   startTime - 开始时间 @query   endTime - 结束时间 @query   category - 事件类别（可选） @access  Admin |
| GET | `/api/events/timeline` | @route   GET /api/events/timeline @desc    获取事件时间线（按时间分组） @query   eventType - 事件类型 @query   interval - 时间间隔（minute/hour/day） @query   startTime - 开始时间 @query   endTime - 结束时间 @access  Admin |
| GET | `/api/events/top` | @route   GET /api/events/top @desc    获取热门事件类型排行 @query   startTime - 开始时间 @query   endTime - 结束时间 @query   limit - 返回数量（默认 20） @access  Admin |
| GET | `/api/fieldsets` |  |
| GET | `/api/media-types` |  |
| GET | `/api/pokemon/:id/energy` | 需求文档（REQ-00112 / REQ-00324）约定的接口路径 |
| POST | `/api/pokemon/:id/energy/regenerate` |  |
| POST | `/api/pokemon/:id/moves/check` |  |
| GET | `/api/time/activity-stats` | GET /api/time/activity-stats 获取玩家时段活动统计（需认证） |
| GET | `/api/time/current` | GET /api/time/current 获取当前时段信息 |
| GET | `/api/time/periods` | GET /api/time/periods 获取所有时段配置 |
| GET | `/api/time/preview/:hour` | GET /api/time/preview/:hour 预览指定小时的时段信息 |
| POST | `/api/time/spawn-config` | POST /api/time/spawn-config 配置精灵时段刷新（管理员接口） |
| GET | `/api/time/special-pokemon` | GET /api/time/special-pokemon 获取当前时段特殊精灵列表 |
| GET | `/api/time/type-bonus/:type` | GET /api/time/type-bonus/:type 获取特定属性在当前时段的加成 |
| GET | `/api/time/type-bonuses` | GET /api/time/type-bonuses 获取当前时段所有属性加成 |
| GET | `/api/v1/autoscaling/efficiency` | GET /api/v1/autoscaling/efficiency 获取资源利用效率报告 |
| POST | `/api/v1/autoscaling/execute` | POST /api/v1/autoscaling/execute 手动执行预测性扩容 |
| GET | `/api/v1/autoscaling/predictions` | GET /api/v1/autoscaling/predictions 获取预测性扩容建议 |
| GET | `/api/v1/autoscaling/services/:serviceName/prediction` | GET /api/v1/autoscaling/services/:serviceName/prediction 获取单个服务的预测结果 |
| GET | `/api/v1/autoscaling/status` | GET /api/v1/autoscaling/status 获取预测性扩容引擎状态 |
| POST | `/api/v1/batch` |  |
| GET | `/api/v1/batch/stats` |  |
| GET | `/api/v1/batch/templates` |  |
| POST | `/api/v1/batch/templates/:name` |  |
| GET | `/api/v1/pipelines` |  |
| POST | `/api/v1/pipelines` |  |
| DELETE | `/api/v1/pipelines/:name` |  |
| GET | `/api/v1/pipelines/:name` |  |
| PUT | `/api/v1/pipelines/:name` |  |
| GET | `/api/v1/pipelines/:name/metrics` |  |
| POST | `/api/v1/pipelines/:name/refresh-cache` |  |
| GET | `/api/v1/pokemon/:speciesId/move-recommendations` |  |
| POST | `/api/v1/privacy/confirm` | POST /api/v1/privacy/confirm 确认政策 |
| GET | `/api/v1/privacy/current` | GET /api/v1/privacy/current 获取当前生效的政策 |
| GET | `/api/v1/privacy/history` | GET /api/v1/privacy/history 获取用户确认历史 |
| GET | `/api/v1/privacy/pending` | GET /api/v1/privacy/pending 获取待确认的政策列表 |
| POST | `/api/v1/security/init-session` | POST /api/v1/security/init-session 初始化安全会话 |
| POST | `/api/v1/security/refresh-key` | POST /api/v1/security/refresh-key 刷新会话密钥 |
| POST | `/api/v1/security/report-scan` | POST /api/v1/security/report-scan 上报内存扫描结果 |
| POST | `/api/v1/security/report-tamper` | POST /api/v1/security/report-tamper 上报篡改事件 |
| DELETE | `/api/v1/security/session` | DELETE /api/v1/security/session 销毁会话 |
| GET | `/api/v1/security/status` | GET /api/v1/security/status 查询会话安全状态 |
| GET | `/api/v1/transformers` |  |
| POST | `/api/v1/transformers` |  |
| DELETE | `/api/v1/transformers/:name` |  |
| GET | `/api/v1/users` | 用户列表 |
| PATCH | `/api/v1/users/:id` | 更新用户 |
| GET | `/api/v1/users/:id/profile` | 用户资料 |
| GET | `/api/v2/pokemon` | 用户精灵列表 - 增加技能信息 |
| GET | `/api/v2/pokemon/:id` | 精灵详情 - 增加完整信息 |
| POST | `/api/v2/pokemon/:id/learn-move` | 学习技能 - 新端点 |
| DELETE | `/api/v2/pokemon/:id/moves/:moveId` | 遗忘技能 - 新端点 |
| GET | `/api/v2/pokemon/pokedex` | 精灵图鉴 - 增加技能池信息 |
| GET | `/api/v2/users` | 用户列表 |
| PATCH | `/api/v2/users/:id` | 更新用户 |
| GET | `/api/v2/users/:id/achievements` | 用户成就 - 新端点 |
| GET | `/api/v2/users/:id/profile` | 用户资料 - 增强统计字段 |
| GET | `/api/v2/users/:id/stats` | 用户统计 - 新端点 |
| GET | `/api/version` | GET /api/version 获取 API 版本信息（REQ-00201：状态为生命周期 development/testing/stable/deprecated/sunset） |
| GET | `/api/version/:version` | GET /api/version/:version 获取特定版本详情 |
| GET | `/api/version/:version(\\d+)/breaking-changes` | GET /api/version/:version/breaking-changes 破坏性变更与变更记录（api_changes） |
| GET | `/api/version/:version(\\d+)/openapi.json` | GET /api/version/:version/openapi.json 按版本生成的 OpenAPI 文档：从 bundled.yaml 取出属于该版本的路径（/api/vN/、/vN/） |
| GET | `/api/version/:version/changelog` | GET /api/version/:version/changelog 获取特定版本的变更日志 |
| GET | `/api/version/:version/compatibility` | GET /api/version/:version/compatibility 检查版本兼容性 |
| GET | `/api/version/changelog/all` | GET /api/version/changelog 获取所有版本的变更日志 |
| GET | `/api/version/deprecation/list` | GET /api/deprecation/list 获取所有废弃的端点 |
| POST | `/api/version/deprecation/mark` | POST /api/deprecation/mark 标记端点为废弃（管理员操作） |
| GET | `/api/version/deprecation/upcoming` | GET /api/deprecation/upcoming 获取即将下线的端点 |
| GET | `/api/version/deprecation/usage/:endpoint(*)` | GET /api/deprecation/usage/:endpoint 获取废弃端点的使用统计 |
| GET | `/config/health` | GET /admin/config 获取所有服务的配置概览 |
| GET | `/config/health/:serviceName` | GET /admin/config/:serviceName 获取指定服务的配置 |
| DELETE | `/config/health/:serviceName/:key` | DELETE /admin/config/:serviceName/:key 删除配置项 |
| GET | `/config/health/:serviceName/:key` | GET /admin/config/:serviceName/:key 获取指定配置项 |
| PUT | `/config/health/:serviceName/:key` | PUT /admin/config/:serviceName/:key 更新单个配置项 |
| GET | `/config/health/:serviceName/audit` | GET /admin/config/:serviceName/audit 获取配置审计日志 |
| POST | `/config/health/:serviceName/batch` | POST /admin/config/:serviceName/batch 批量更新配置 |
| GET | `/config/health/:serviceName/history` | GET /admin/config/:serviceName/history 获取配置变更历史 |
| POST | `/config/health/:serviceName/rollback` | POST /admin/config/:serviceName/rollback 回滚到指定版本 |
| GET | `/config/health/health` | GET /admin/config/health 配置中心健康检查 |
| GET | `/health` | ── Health ──────────────────────────────────────────────────── |
| GET | `/metrics` | ── Metrics ──────────────────────────────────────────────────── |
| GET | `/v1/battle/replays/shared/:code` | ── E11 战斗与技能（gym-service /battle/*）────────────────────── 回放分享链接：公开访问（无需登录），查看次数/密码/有效期由服务端校验 |
| GET | `/v1/gdpr/privacy-policy` | REQ-00044: GDPR 数据导出 / 删除。隐私政策公开；其余经网关鉴权（含 token 黑名单， 登出/吊销后的 token 不能再导出个人数据或发起删除） |
| GET | `/v1/gyms/nearby` | 道馆附近查询 - 缓存 1 分钟 |
| GET | `/v1/pokemon` | 用户精灵列表 - 缓存 2 分钟 |
| GET | `/v1/pokemon/my` | 背包 - 按用户缓存 60 秒，用户任一写操作（如捕捉成功）后立即失效（REQ-00040） |
| GET | `/v1/pokemon/pokedex` | 精灵图鉴 - 缓存 1 小时（静态数据） |
| GET | `/v1/raids/nearby` | Raid 附近查询 - 缓存 30 秒 |
| GET | `/v1/users/:id/profile` | Protected with cache (REQ-00031) 用户资料 - 缓存 5 分钟 |
| GET | `/v1/users/:id/stats` | 用户统计 - 缓存 5 分钟 |

## gym

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/teams` | 创建团队 POST /api/teams |
| GET | `/api/teams/:id` | 获取团队详情 GET /api/teams/:id |
| POST | `/api/teams/:id/invite` | 邀请玩家 POST /api/teams/:id/invite |
| POST | `/api/teams/:id/join` | 加入团队 POST /api/teams/:id/join |
| POST | `/api/teams/:id/kick` | 踢出成员 POST /api/teams/:id/kick |
| POST | `/api/teams/:id/leave` | 离开团队 POST /api/teams/:id/leave |
| POST | `/api/teams/:id/ready` | 标记准备状态 POST /api/teams/:id/ready |
| POST | `/api/teams/:id/start-battle` | 启动战斗 POST /api/teams/:id/start-battle |
| POST | `/api/teams/battle/:battleId/action` | 提交行动 POST /api/teams/battle/:battleId/action |
| POST | `/api/teams/battle/:battleId/execute-turn` | 执行回合 POST /api/teams/battle/:battleId/execute-turn |
| GET | `/api/teams/battle/:battleId/rewards` | 获取战斗奖励 GET /api/teams/battle/:battleId/rewards |
| GET | `/api/teams/battle/stats` | 获取战斗统计 GET /api/teams/battle/stats |
| GET | `/api/teams/combo-skills` | 获取连携技能列表 GET /api/teams/combo-skills |
| GET | `/api/teams/open` | 获取开放团队列表 GET /api/teams/open |
| GET | `/api/teams/raids` | 获取活跃 Raid Boss GET /api/teams/raids |
| POST | `/api/teams/raids/:raidId/challenge` | 挑战 Raid Boss POST /api/teams/raids/:raidId/challenge |
| GET | `/api/v1/gym/damage/effectiveness` | GET /gym/damage/effectiveness - 查询特定属性克制关系 查询参数: - attackType: 攻击属性 - defenderType1: 防御者主属性 - defenderType2: 防御者副属性(可选) |
| POST | `/api/v1/gym/damage/simulate` | POST /gym/damage/simulate - 伤害模拟计算 请求体: { attacker: { species_id: number, attack: number, fast_move?: string, charged_move?: string }, defender: { species_id: number, defense: number }, weather?: string } |
| GET | `/api/v1/gym/damage/typechart` | GET /gym/damage/typechart - 获取属性克制表 |
| GET | `/api/v1/gym/damage/weather` | GET /gym/damage/weather - 获取天气加成信息 |
| GET | `/api/v1/gym/season/current` | 获取当前赛季信息 |
| GET | `/api/v1/gym/season/history` | 获取赛季历史 |
| GET | `/api/v1/gym/season/leaderboard` | 获取段位排行榜 |
| POST | `/api/v1/gym/season/placement/match` | 定位赛匹配 |
| GET | `/api/v1/gym/season/rank` | 获取玩家段位信息 |
| POST | `/api/v1/gym/season/ranked/match` | 排位赛匹配 |
| POST | `/api/v1/gym/season/ranked/result` | 上报排位赛结果 |
| POST | `/api/v1/gym/season/rewards/:seasonId/claim` | 领取赛季奖励 |
| POST | `/batch/details` | POST /batch/details 批量获取道馆详细信息 Body: { gymIds: ['gym1', 'gym2', 'gym3'] } Response: { code: 0, data: { gyms: [gym1, gym2, gym3] } } |
| POST | `/batch/nearby` | POST /batch/nearby 批量获取附近道馆简要信息（用于地图显示） Body: { lat, lng, radius = 1000, limit = 20 } Response: { code: 0, data: { gyms: [...] } } |
| POST | `/batch/raids` | POST /batch/raids 批量获取道馆 Raid 信息 Body: { gymIds: ['gym1', 'gym2'] } |
| PUT | `/battle/ai/experiment` |  |
| POST | `/battle/ai/feedback` |  |
| POST | `/battle/ai/lineup` | 阵容优化：针对道馆（gymId）或联赛（target=league，按自己段位的典型对手）从自己精灵中选队 |
| GET | `/battle/ai/preferences` | ── AI 策略助手 ────────────────────────────────────────────── |
| PUT | `/battle/ai/preferences` |  |
| GET | `/battle/ai/quota` |  |
| GET | `/battle/ai/review/:battleId` |  |
| GET | `/battle/ai/reviews` |  |
| GET | `/battle/ai/stats` | 运营看板：各实验组采纳率、满意度、预测准确率（胜率预测偏差）、时延、缓存命中 |
| GET | `/battle/combos` | ── 连击 ───────────────────────────────────────────────────── |
| GET | `/battle/combos/:chainId` |  |
| POST | `/battle/combos/:chainId/practice` |  |
| GET | `/battle/combos/leaderboard` |  |
| GET | `/battle/combos/logs` |  |
| GET | `/battle/combos/my/stats` |  |
| GET | `/battle/combos/presets` |  |
| POST | `/battle/combos/presets` |  |
| DELETE | `/battle/combos/presets/:id` |  |
| PUT | `/battle/combos/presets/:id` |  |
| GET | `/battle/combos/recommend/:pokemonId` |  |
| POST | `/battle/damage/cache/refresh` |  |
| GET | `/battle/damage/cache/stats` |  |
| POST | `/battle/damage/simulate` |  |
| GET | `/battle/damage/typechart` | ── 伤害 ───────────────────────────────────────────────────── |
| POST | `/battle/equipment/:itemId/equip` |  |
| POST | `/battle/equipment/:itemId/unequip` |  |
| GET | `/battle/equipment/catalog` |  |
| POST | `/battle/equipment/grant` |  |
| GET | `/battle/equipment/mine` |  |
| POST | `/battle/league/admin/end-season` |  |
| GET | `/battle/league/defense-team` |  |
| PUT | `/battle/league/defense-team` |  |
| GET | `/battle/league/leaderboard` |  |
| POST | `/battle/league/match` |  |
| GET | `/battle/league/matches` |  |
| GET | `/battle/league/me` |  |
| GET | `/battle/league/rewards` |  |
| POST | `/battle/league/rewards/:id/claim` |  |
| GET | `/battle/league/season` | ── 竞技联赛 ───────────────────────────────────────────────── |
| GET | `/battle/league/tiers` |  |
| GET | `/battle/moves/:moveId/energy-info` |  |
| GET | `/battle/perf/config` |  |
| GET | `/battle/perf/dashboard` |  |
| POST | `/battle/perf/report` |  |
| GET | `/battle/pokemon/:id/cooldowns` |  |
| GET | `/battle/pokemon/:id/energy` | ── 能量 / 冷却 / 熟练度 / 装备 ───────────────────────────────── |
| POST | `/battle/pokemon/:id/energy/regenerate` |  |
| GET | `/battle/pokemon/:id/mastery` |  |
| POST | `/battle/pokemon/:id/moves/check` |  |
| GET | `/battle/recommendations/:speciesId` |  |
| POST | `/battle/recommendations/aggregate` |  |
| GET | `/battle/recommendations/preferences` | ── 技能推荐 ───────────────────────────────────────────────── |
| PUT | `/battle/recommendations/preferences` |  |
| DELETE | `/battle/replays/:id` |  |
| GET | `/battle/replays/:id` |  |
| PATCH | `/battle/replays/:id` |  |
| GET | `/battle/replays/:id/comments` |  |
| POST | `/battle/replays/:id/comments` |  |
| POST | `/battle/replays/:id/like` |  |
| POST | `/battle/replays/:id/share` |  |
| GET | `/battle/replays/hot` |  |
| GET | `/battle/replays/mine` |  |
| GET | `/battle/replays/search` |  |
| GET | `/battle/replays/shared/:code` |  |
| GET | `/health` |  |
| GET | `/metrics` | Metrics endpoint |
| GET | `/metrics/battle` | 暴露指标端点 |

## location

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/anticheat/appeals` | ── 管理员：申诉列表 ────────────────────────────────────────── |
| POST | `/anticheat/appeals/:id/decision` | ── 管理员：审核 ────────────────────────────────────────────── |
| GET | `/anticheat/stats` | ── 管理员：监控面板数据 ────────────────────────────────────── |
| GET | `/anticheat/suspicious` | ── REQ-00586: 反作弊管理（可疑玩家列表 / 证据），经网关 /api/admin/anticheat 访问 ── |
| GET | `/anticheat/users/:userId/evidence` |  |
| GET | `/anticheat/zones` | ── 管理员：地形/禁入区域 ───────────────────────────────────── |
| POST | `/anticheat/zones` |  |
| DELETE | `/anticheat/zones/:id` |  |
| GET | `/api/admin/spawn/biomes` | 获取所有生物群系 GET /api/v1/spawn/biomes |
| GET | `/api/admin/spawn/config/cell/:geohash` | 获取区域配置 GET /api/v1/spawn/config/cell/:geohash |
| PUT | `/api/admin/spawn/config/cell/:geohash` | 更新区域配置 PUT /api/v1/spawn/config/cell/:geohash |
| POST | `/api/admin/spawn/config/cells/batch` | 批量更新区域配置 POST /api/v1/spawn/config/cells/batch |
| GET | `/api/admin/spawn/events` | 获取活动列表 GET /api/v1/spawn/events |
| POST | `/api/admin/spawn/events` | 创建活动事件 POST /api/v1/spawn/events |
| DELETE | `/api/admin/spawn/events/:id` | 删除活动事件 DELETE /api/v1/spawn/events/:id |
| PUT | `/api/admin/spawn/events/:id` | 更新活动事件 PUT /api/v1/spawn/events/:id |
| GET | `/api/admin/spawn/logs` | 获取操作日志 GET /api/v1/spawn/logs |
| POST | `/api/admin/spawn/manual` | 手动刷新精灵 POST /api/v1/spawn/manual |
| GET | `/api/admin/spawn/pool/:biome` | 获取精灵池配置 GET /api/v1/spawn/pool/:biome |
| PUT | `/api/admin/spawn/pool/:biome` | 更新精灵池 PUT /api/v1/spawn/pool/:biome |
| GET | `/api/admin/spawn/statistics` | 获取刷新统计 GET /api/v1/spawn/statistics |
| POST | `/api/v1/location/check-action` | POST /api/v1/location/check-action 检查某动作是否允许（用于捕捉、道馆等） |
| POST | `/api/v1/location/device-check` | POST /api/v1/location/device-check 设备风险检查 |
| POST | `/api/v1/location/report` | POST /api/v1/location/report 上报位置（客户端定期上报） |
| GET | `/api/v1/location/restrictions` | GET /api/v1/location/restrictions 获取用户当前限制 |
| POST | `/api/v1/location/verify` | POST /api/v1/location/verify 验证位置可信度 |
| DELETE | `/cache/wild/:id` | DELETE /cache/wild/:id — invalidate wild pokemon cache (called by catch-service) |
| POST | `/daynight/config` | POST /daynight/config 管理员配置时间段（需要管理员权限） |
| GET | `/daynight/current` | GET /daynight/current 获取当前游戏时间和时间段信息 |
| GET | `/daynight/periods` | GET /daynight/periods 获取所有时间段配置列表 |
| POST | `/daynight/pokemon-config` | POST /daynight/pokemon-config 配置精灵的时间段权重 |
| GET | `/daynight/pokemon/:period` | GET /daynight/pokemon/:period 获取指定时间段的可生成精灵列表 |
| GET | `/daynight/statistics` | GET /daynight/statistics 获取昼夜生成统计数据 |
| GET | `/daynight/tips` | GET /daynight/tips 获取当前时间段的捕捉提示 |
| DELETE | `/habitat/area/:areaId` | DELETE /api/habitat/area/:areaId (Admin) 删除自定义栖息地区域 |
| GET | `/habitat/current` | GET /api/habitat/current 获取当前位置的栖息地类型 |
| POST | `/habitat/define-area` | POST /api/habitat/define-area (Admin) 定义自定义栖息地区域 |
| GET | `/habitat/recommended-pokemon` | GET /api/habitat/recommended-pokemon 获取当前栖息地推荐的精灵列表 |
| GET | `/habitat/types` | GET /api/habitat/types 获取所有栖息地类型列表 |
| GET | `/habitat/user/:userId` | GET /api/habitat/user/:userId 获取用户缓存的栖息地信息 |
| GET | `/health` |  |
| POST | `/location` | POST /location  — player GPS update |
| GET | `/location/appeals` | ── 玩家：我的申诉 ──────────────────────────────────────────── |
| POST | `/location/appeals` | ── 玩家：提交申诉 ──────────────────────────────────────────── |
| GET | `/map/nearby` | GET /map/nearby — get all game elements near player |
| GET | `/map/weather` | GET /map/weather — 获取当前天气 |
| GET | `/metrics` | Metrics endpoint |
| GET | `/metrics/cache` | GET /metrics/cache — cache performance metrics |
| GET | `/recovery-stations/:id` | GET /recovery-stations/:id 获取恢复站详情 |
| POST | `/recovery-stations/:id/check-in` | POST /recovery-stations/:id/check-in 恢复站签到 |
| DELETE | `/recovery-stations/:id/favorite` | DELETE /recovery-stations/:id/favorite 取消收藏 |
| POST | `/recovery-stations/:id/favorite` | POST /recovery-stations/:id/favorite 收藏恢复站 |
| GET | `/recovery-stations/:id/reviews` | GET /recovery-stations/:id/reviews 获取恢复站评论列表 |
| POST | `/recovery-stations/:id/reviews` | POST /recovery-stations/:id/reviews 添加恢复站评论 |
| GET | `/recovery-stations/favorites` | GET /recovery-stations/favorites 获取收藏的恢复站列表 |
| GET | `/recovery-stations/nearby` | GET /recovery-stations/nearby 查询附近恢复站 |

## payment

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/currencies` | GET /api/v1/currencies Get list of supported currencies |
| POST | `/api/v1/currencies/admin/cleanup-locks` | POST /api/v1/currencies/admin/cleanup-locks Admin: Clean up expired rate locks |
| POST | `/api/v1/currencies/admin/refresh-rates` | POST /api/v1/currencies/admin/refresh-rates Admin: Refresh all exchange rates |
| POST | `/api/v1/currencies/admin/set-price` | POST /api/v1/currencies/admin/set-price Admin: Set product price in currency Body: { productId, currency, price, originalPrice } |
| POST | `/api/v1/currencies/convert` | POST /api/v1/currencies/convert Convert amount between currencies Body: { amount, from, to, lockRate?: boolean } |
| POST | `/api/v1/currencies/detect` | POST /api/v1/currencies/detect Detect currency by country Body: { country } |
| POST | `/api/v1/currencies/lock-rate` | POST /api/v1/currencies/lock-rate Lock exchange rate for payment Body: { from, to, durationMinutes } |
| GET | `/api/v1/currencies/preference` | GET /api/v1/currencies/preference Get user currency preference |
| POST | `/api/v1/currencies/preference` | POST /api/v1/currencies/preference Set user currency preference Body: { currency, autoDetect } |
| GET | `/api/v1/currencies/prices/:productId` | GET /api/v1/currencies/prices/:productId Get product price in specified currency Query: currency=JPY |
| GET | `/api/v1/currencies/rates` | GET /api/v1/currencies/rates Get exchange rates Query: from=USD&to=EUR,GBP,JPY |
| GET | `/currency` | GET /api/v1/currencies Get list of supported currencies |
| POST | `/currency/admin/cleanup-locks` | POST /api/v1/currencies/admin/cleanup-locks Admin: Clean up expired rate locks |
| POST | `/currency/admin/refresh-rates` | POST /api/v1/currencies/admin/refresh-rates Admin: Refresh all exchange rates |
| POST | `/currency/admin/set-price` | POST /api/v1/currencies/admin/set-price Admin: Set product price in currency Body: { productId, currency, price, originalPrice } |
| POST | `/currency/convert` | POST /api/v1/currencies/convert Convert amount between currencies Body: { amount, from, to, lockRate?: boolean } |
| POST | `/currency/detect` | POST /api/v1/currencies/detect Detect currency by country Body: { country } |
| POST | `/currency/lock-rate` | POST /api/v1/currencies/lock-rate Lock exchange rate for payment Body: { from, to, durationMinutes } |
| GET | `/currency/preference` | GET /api/v1/currencies/preference Get user currency preference |
| POST | `/currency/preference` | POST /api/v1/currencies/preference Set user currency preference Body: { currency, autoDetect } |
| GET | `/currency/prices/:productId` | GET /api/v1/currencies/prices/:productId Get product price in specified currency Query: currency=JPY |
| GET | `/currency/rates` | GET /api/v1/currencies/rates Get exchange rates Query: from=USD&to=EUR,GBP,JPY |
| GET | `/health` |  |
| GET | `/metrics` | Metrics endpoint |
| GET | `/payment/orders` | ── GET /payment/orders ──────────────────────────────────────────────── |
| POST | `/payment/orders` | ── POST /payment/orders ─────────────────────────────────────────────── |
| POST | `/payment/orders/:id/verify` | ── POST /payment/orders/:id/verify ─────────────────────────────────── Called by client after payment completes; server verifies with channel. FIX: verifyPaymentSign was a stub that always returned true (free coin exploit). Now performs real HMAC-SHA256 verification. |
| GET | `/payment/products` | ── GET /payment/products ────────────────────────────────────────────── |
| POST | `/payment/webhook/:channel` | ── POST /payment/webhook/:channel  (channel callback) ──────────────── FIX: was calling `transaction(...)` which was never imported/defined in this file. Replaced with the correctly imported `transactionSerializable`. |

## pokemon

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/abilities` | 获取特性列表 GET /api/pokemon/abilities |
| GET | `/abilities/:abilityId` | 获取单个特性详情 GET /api/pokemon/abilities/:abilityId |
| POST | `/abilities/apply-effect` | 应用特性效果 POST /api/pokemon/abilities/apply-effect |
| POST | `/abilities/check-trigger` | 检查特性触发条件 POST /api/pokemon/abilities/check-trigger |
| GET | `/abilities/items/list` | 获取特性道具列表 GET /api/pokemon/abilities/items |
| GET | `/abilities/pokemon/:pokemonId` | 获取玩家精灵的特性列表 GET /api/pokemon/abilities/pokemon/:pokemonId |
| POST | `/abilities/pokemon/:pokemonId/activate-hidden` | 激活隐藏特性 POST /api/pokemon/abilities/pokemon/:pokemonId/activate-hidden |
| GET | `/abilities/pokemon/:pokemonId/active` | 获取玩家精灵的激活特性 GET /api/pokemon/abilities/pokemon/:pokemonId/active |
| POST | `/abilities/pokemon/:pokemonId/switch` | 切换精灵特性 POST /api/pokemon/abilities/pokemon/:pokemonId/switch |
| POST | `/abilities/pokemon/:pokemonId/unlock-hidden` | 解锁隐藏特性 POST /api/pokemon/abilities/pokemon/:pokemonId/unlock-hidden |
| POST | `/abilities/pokemon/:pokemonId/use-item` | 使用特性道具 POST /api/pokemon/abilities/pokemon/:pokemonId/use-item |
| GET | `/abilities/species/:speciesId` | 获取精灵种类的特性配置 GET /api/pokemon/abilities/species/:speciesId |
| GET | `/abilities/stats/overview` | 获取特性统计 GET /api/pokemon/abilities/stats |
| GET | `/achievements/:achievementId` | GET /achievements/:achievementId - 获取成就详情 |
| POST | `/achievements/:achievementId/claim` | POST /achievements/:achievementId/claim - 领取成就奖励 |
| GET | `/achievements/categories` | GET /achievements/categories - 获取成就类别列表 |
| GET | `/achievements/leaderboard` | GET /achievements/leaderboard - 获取成就排行榜 |
| GET | `/achievements/my` | GET /achievements/my - 获取用户成就列表 |
| GET | `/achievements/my/progress` | GET /achievements/my/progress - 获取成就进度概览 |
| GET | `/achievements/titles` | GET /achievements/titles - 获取用户称号列表 |
| POST | `/achievements/titles/:titleId/activate` | POST /achievements/titles/:titleId/activate - 设置激活称号 |
| DELETE | `/backup/:backupId` | DELETE /api/pokemon/backup/:backupId 删除备份 |
| GET | `/backup/:backupId` | GET /api/pokemon/backup/:backupId 获取备份详情 |
| DELETE | `/backup/auto-backup` | DELETE /api/pokemon/backup/auto-backup 禁用自动备份 |
| GET | `/backup/auto-backup` | GET /api/pokemon/backup/auto-backup 获取自动备份配置 |
| POST | `/backup/auto-backup` | POST /api/pokemon/backup/auto-backup 设置自动备份 |
| POST | `/backup/create` | POST /api/pokemon/backup/create 创建手动备份 |
| GET | `/backup/export` | GET /api/pokemon/backup/export 导出用户数据（GDPR） |
| GET | `/backup/list` | GET /api/pokemon/backup/list 获取用户备份列表 |
| GET | `/backup/quota` | GET /api/pokemon/backup/quota 获取用户备份配额信息 |
| GET | `/backup/restore-history` | GET /api/pokemon/backup/restore-history 获取恢复历史 |
| POST | `/backup/restore/:backupId` | POST /api/pokemon/backup/restore/:backupId 从备份恢复精灵数据 |
| GET | `/bag/alert-config` | GET /bag/alert-config 获取预警配置 |
| PATCH | `/bag/alert-config` | PATCH /bag/alert-config 更新预警配置 Body: { enableAlert?, alertThresholds?, autoTransferToStorage?, notificationMethod? } |
| POST | `/bag/batch-action` | POST /bag/batch-action 批量操作精灵 Body: { pokemonIds: number[], action: 'release'\|'transfer_to_storage' } |
| GET | `/bag/capacity` | GET /bag/capacity 获取背包容量信息 |
| GET | `/bag/check-full` | GET /bag/check-full 检查背包是否已满 Query: additional - 额外需要的槽位 |
| POST | `/bag/expand` | POST /bag/expand 扩展背包容量 Body: { method: 'gold'\|'diamond', units: number } |
| GET | `/bag/expansion-cost` | GET /bag/expansion-cost 获取扩展成本预览 Query: units, method |
| GET | `/bag/expansion-history` | GET /bag/expansion-history 获取扩展历史 Query: limit |
| GET | `/bag/filter-options` | GET /bag/filter-options 获取筛选选项 |
| GET | `/bag/pokemon` | GET /bag/pokemon 获取排序后的精灵列表 Query: sortBy, sortOrder, page, limit, storageStatus |
| PATCH | `/bag/pokemon/:id/favorite` | PATCH /bag/pokemon/:id/favorite 设置收藏标记 Body: { isFavorited: boolean } |
| POST | `/bag/quick-sort` | POST /bag/quick-sort 快速排序（按规则重新排列） Body: { sortBy: string, sortOrder: string } |
| POST | `/bag/sort-order` | POST /bag/sort-order 更新排序顺序 Body: { pokemonIds: number[] } |
| POST | `/bag/transfer-from-storage` | POST /bag/transfer-from-storage 从仓库移回背包 Body: { pokemonIds: number[] } |
| POST | `/batch/details` |  |
| GET | `/batch/metrics` |  |
| POST | `/bond-skills/calculate-effect` | POST /api/bond-skills/calculate-effect 计算羁绊技能实际效果（用于战斗模拟） |
| GET | `/bond-skills/stats` | GET /api/bond-skills/stats 获取用户羁绊技能统计 |
| POST | `/breeding/cancel/:pairId` | 取消培育 POST /api/breeding/cancel/:pairId |
| GET | `/breeding/center` | 获取培育中心状态 GET /api/breeding/center |
| POST | `/breeding/check` | 检查两只精灵是否可以培育 POST /api/breeding/check |
| POST | `/breeding/collect/:pairId` | 收集培育完成的蛋 POST /api/breeding/collect/:pairId |
| POST | `/breeding/hatch/update` | 更新孵化进度 POST /api/breeding/hatch/update |
| GET | `/breeding/lineage/:pokemonId` | 获取精灵谱系 GET /api/breeding/lineage/:pokemonId |
| POST | `/breeding/start` | 开始培育 POST /api/breeding/start |
| GET | `/breeding/stats` | 获取培育统计 GET /api/breeding/stats |
| POST | `/breeding/upgrade` | 升级培育中心 POST /api/breeding/upgrade |
| GET | `/equipment/:id` | GET /api/pokemon/equipment/:id 获取装备详情 |
| POST | `/equipment/equip` | POST /api/pokemon/equipment/equip 装备到精灵 |
| GET | `/equipment/inventory` | GET /api/pokemon/equipment/inventory 获取玩家装备背包 |
| GET | `/equipment/pokemon/:pokemonId` | GET /api/pokemon/equipment/pokemon/:pokemonId 获取精灵已装备列表 |
| POST | `/equipment/sell` | POST /api/pokemon/equipment/sell 出售装备 |
| GET | `/equipment/sets` | GET /api/pokemon/equipment/sets 获取套装列表 |
| GET | `/equipment/sets/:id` | GET /api/pokemon/equipment/sets/:id 获取套装详情 |
| GET | `/equipment/templates` | GET /api/pokemon/equipment/templates 获取装备模板列表 |
| GET | `/equipment/templates/:id` | GET /api/pokemon/equipment/templates/:id 获取装备模板详情 |
| POST | `/equipment/unequip` | POST /api/pokemon/equipment/unequip 从精灵卸下装备 |
| POST | `/equipment/upgrade` | POST /api/pokemon/equipment/upgrade 强化装备 |
| GET | `/equipment/upgrade-preview/:id` | GET /api/pokemon/equipment/upgrade-preview/:id 获取强化预览（消耗和成功率） |
| GET | `/inventory` | GET /api/pokemon/inventory 获取用户精灵列表（支持排序、分组、过滤） |
| GET | `/inventory/:pokemonId` | GET /api/pokemon/inventory/:pokemonId 获取单个精灵详情 |
| GET | `/inventory/admin/upgrades/stats` | GET /api/v1/admin/inventory/upgrades/stats 管理员获取全平台扩容统计 |
| GET | `/inventory/advice` | GET /api/pokemon/inventory/advice 获取智能整理建议 |
| POST | `/inventory/batch-favorite` | POST /api/pokemon/inventory/batch-favorite 批量设置收藏 |
| POST | `/inventory/batch-transfer` | POST /api/pokemon/inventory/batch-transfer 批量转移精灵 |
| POST | `/inventory/favorite` | POST /api/pokemon/inventory/favorite 设置/取消收藏 |
| POST | `/inventory/lock` | POST /api/pokemon/inventory/lock 锁定/解锁精灵 |
| GET | `/inventory/sort-options` | GET /api/pokemon/inventory/sort-options 获取可用的排序选项 |
| POST | `/inventory/sort-preference` | POST /api/pokemon/inventory/sort-preference 保存用户排序偏好 |
| GET | `/inventory/storage` | GET /api/pokemon/inventory/storage 获取背包存储状态 |
| POST | `/inventory/tags` | POST /api/pokemon/inventory/tags 更新精灵自定义标签 |
| GET | `/inventory/upgrades` | GET /api/v1/inventory/upgrades 获取背包扩容配置列表 |
| GET | `/inventory/upgrades/:upgradeId` | GET /api/v1/inventory/upgrades/:upgradeId 获取单个扩容配置详情 |
| POST | `/inventory/upgrades/:upgradeId/grant` | POST /api/v1/inventory/upgrades/:upgradeId/grant 赠送免费扩容（管理员） Body: { "userId": number, "reason": "achievement" \| "event" \| "free" \| "vip" \| "admin" } |
| POST | `/inventory/upgrades/:upgradeId/purchase` | POST /api/v1/inventory/upgrades/:upgradeId/purchase 购买背包扩容 Body: { "method": "gold" \| "gem" } |
| POST | `/inventory/upgrades/batch-check` | POST /api/v1/inventory/upgrades/batch-check 批量检查用户是否可以购买多个配置 Body: { "upgradeIds": ["base_50", "pokeball_20", ...] } |
| GET | `/inventory/upgrades/history` | GET /api/v1/inventory/upgrades/history 获取用户扩容购买历史 |
| GET | `/inventory/upgrades/stats` | GET /api/v1/inventory/upgrades/stats 获取用户扩容统计信息 |
| GET | `/localizations/items` | GET /localizations/items - Get all localized items |
| GET | `/localizations/moves` | GET /localizations/moves - Get all localized moves |
| GET | `/localizations/pokemon/:id` | GET /localizations/pokemon/:id - Get all localizations for a Pokemon |
| GET | `/localizations/supported-languages` | GET /localizations/supported-languages - Get supported languages |
| GET | `/moves` | GET /moves 获取技能列表 Query: type, category, limit, offset |
| GET | `/moves/:id` | GET /moves/:id 获取技能详情 |
| GET | `/pokedex/achievements` | GET /api/pokedex/achievements 获取图鉴成就列表 |
| GET | `/pokedex/catch-bonus` | GET /api/pokedex/catch-bonus 获取捕捉概率加成 |
| GET | `/pokedex/detailed` | GET /api/pokedex/detailed 获取详细图鉴列表 Query params: region, type, caught, shiny, seen |
| GET | `/pokedex/generation-stats` | GET /api/pokedex/generation-stats 获取世代统计 |
| GET | `/pokedex/leaderboard` | GET /api/pokedex/leaderboard 获取图鉴排行榜 Query params: limit, offset |
| GET | `/pokedex/milestones` | GET /api/pokedex/milestones 获取里程碑列表 |
| POST | `/pokedex/milestones/:milestoneId/claim` | POST /api/pokedex/milestones/:milestoneId/claim 手动领取里程碑奖励 |
| GET | `/pokedex/missing` | GET /api/pokedex/missing 获取未拥有的精灵列表 Query params: region, type |
| GET | `/pokedex/progress` | GET /api/pokedex/progress 获取图鉴完成度进度 |
| GET | `/pokedex/rank` | GET /api/pokedex/rank 获取当前用户排名 |
| POST | `/pokedex/record/caught` | POST /api/pokedex/record/caught 记录捕获精灵（内部调用） |
| POST | `/pokedex/record/seen` | POST /api/pokedex/record/seen 记录见过精灵（内部调用） |
| GET | `/pokedex/region-stats` | GET /api/pokedex/region-stats 获取地区统计 |
| GET | `/pokedex/special-iv-stats` | GET /api/pokedex/special-iv-stats REQ-00160: 获取特殊 IV 统计 |
| GET | `/pokedex/stats/:userId` | GET /api/pokedex/stats/:userId 获取指定用户的图鉴统计（公开信息） |
| GET | `/pokedex/type-stats` | GET /api/pokedex/type-stats 获取属性统计 |
| GET | `/pokemon-species/:speciesId/bond-skills/available` | GET /api/pokemon-species/:speciesId/bond-skills/available 查询特定精灵种类可用的羁绊技能列表（公开API） |
| GET | `/pokemon/:id/bond-skills` | GET /api/pokemon/:id/bond-skills 查询精灵可学习和已学习的羁绊技能 |
| DELETE | `/pokemon/:id/bond-skills/:skillId` | DELETE /api/pokemon/:id/bond-skills/:skillId 遗忘羁绊技能 |
| POST | `/pokemon/:id/bond-skills/:skillId/activate` | POST /api/pokemon/:id/bond-skills/:skillId/activate 激活羁绊技能（用于战斗） |
| POST | `/pokemon/:id/bond-skills/:skillId/learn` | POST /api/pokemon/:id/bond-skills/:skillId/learn 学习羁绊技能 |
| GET | `/pokemon/:id/evolution/check` | GET /api/pokemon/:id/evolution/check 检查精灵是否可以进化 |
| POST | `/pokemon/:id/evolution/execute` | POST /api/pokemon/:id/evolution/execute 执行进化 |
| POST | `/pokemon/:id/experience` | POST /api/pokemon/:id/experience 添加经验值 |
| POST | `/pokemon/:id/friendship` | POST /api/pokemon/:id/friendship 增加亲密度 |
| GET | `/pokemon/:id/stamina` | GET /pokemon/:id/stamina 获取精灵体力状态 |
| POST | `/pokemon/:id/stamina/check` | POST /pokemon/:id/stamina/check 检查精灵是否有足够体力 |
| POST | `/pokemon/:id/stamina/consume` | POST /pokemon/:id/stamina/consume 消耗体力 |
| POST | `/pokemon/:id/stamina/recover` | POST /pokemon/:id/stamina/recover 恢复体力 |
| POST | `/pokemon/:id/stamina/use-item` | POST /pokemon/:id/stamina/use-item 使用道具恢复体力 |
| GET | `/pokemon/:id/stats` | GET /api/pokemon/:id/stats 获取精灵详细属性 |
| GET | `/pokemon/:pokemonId/comments` | GET /api/pokemon/:pokemonId/comments 获取评语列表 |
| POST | `/pokemon/:pokemonId/comments` | POST /api/pokemon/:pokemonId/comments 添加评语 |
| GET | `/pokemon/:pokemonId/evolution-check` | 检查亲密度进化 GET /api/pokemon/:pokemonId/evolution-check |
| POST | `/pokemon/:pokemonId/evolve` | 执行亲密度进化 POST /api/pokemon/:pokemonId/evolve |
| POST | `/pokemon/:pokemonId/friend-request` |  |
| GET | `/pokemon/:pokemonId/friends` |  |
| GET | `/pokemon/:pokemonId/friendship` | 获取精灵亲密度状态 GET /pokemon/:pokemonId/friendship |
| GET | `/pokemon/:pokemonId/friendship-history` | 获取互动历史 GET /api/pokemon/:pokemonId/friendship-history Query: limit, offset |
| POST | `/pokemon/:pokemonId/friendship/add` | 增加亲密度（供其他服务调用） POST /pokemon/:pokemonId/friendship/add |
| POST | `/pokemon/:pokemonId/friendship/evolution-preview` | 预览进化结果 POST /pokemon/:pokemonId/friendship/evolution-preview |
| GET | `/pokemon/:pokemonId/friendship/evolution-progress` | 获取进化进度和建议 GET /pokemon/:pokemonId/friendship/evolution-progress |
| GET | `/pokemon/:pokemonId/friendship/history` | 获取亲密度历史 GET /pokemon/:pokemonId/friendship/history |
| POST | `/pokemon/:pokemonId/interact` | 与精灵互动 POST /api/pokemon/:pokemonId/interact Body: { type: 'massage'\|'camping'\|'feed_berry'\|'feed_vitamin'\|'spa'\|'touch', itemId?: number } |
| GET | `/pokemon/:pokemonId/interaction-status` | 获取互动状态 GET /api/pokemon/:pokemonId/interaction-status |
| DELETE | `/pokemon/:pokemonId/like` | DELETE /api/pokemon/:pokemonId/like 取消点赞 |
| POST | `/pokemon/:pokemonId/like` | POST /api/pokemon/:pokemonId/like 点赞精灵 |
| GET | `/pokemon/:pokemonId/liked` | GET /api/pokemon/:pokemonId/liked 检查是否已点赞 |
| GET | `/pokemon/:pokemonId/privacy` |  |
| PUT | `/pokemon/:pokemonId/privacy` |  |
| GET | `/pokemon/:pokemonId/visibility` |  |
| POST | `/pokemon/:pokemonId/walking-bonus` | 处理行走步数奖励 POST /api/pokemon/:pokemonId/walking-bonus Body: { steps: number } |
| GET | `/pokemon/:speciesId/learnset` | GET /pokemon/:speciesId/learnset 获取种族可学习技能列表 |
| POST | `/pokemon/batch-evolution-chains` | POST /api/pokemon/batch-evolution-chains 批量获取多个物种的进化链 |
| POST | `/pokemon/batch-status` | POST /stamina/batch-status 批量获取精灵体力状态 |
| POST | `/pokemon/batch/details` |  |
| GET | `/pokemon/batch/metrics` |  |
| DELETE | `/pokemon/comments/:commentId` | DELETE /api/pokemon/comments/:commentId 删除评语 |
| GET | `/pokemon/config` | GET /stamina/config 获取体力消耗配置 |
| GET | `/pokemon/evolution-stats/:speciesId` | GET /api/pokemon/evolution-stats/:speciesId 获取精灵进化统计数据（进化玩家数、成功率等） |
| GET | `/pokemon/evolution-types` | GET /api/pokemon/evolution-types 获取所有进化类型枚举 |
| GET | `/pokemon/evolution/history/:userId` | GET /api/evolution/history/:userId 获取用户进化历史 |
| GET | `/pokemon/evolution/items` | GET /api/evolution/items 获取所有进化道具 |
| GET | `/pokemon/favorites` | GET /api/pokemon/favorites 获取当前用户的收藏列表 |
| POST | `/pokemon/favorites` | POST /api/pokemon/favorites 添加收藏 |
| DELETE | `/pokemon/favorites/:pokemonId` | DELETE /api/pokemon/favorites/:pokemonId 移除收藏 |
| PUT | `/pokemon/favorites/reorder` | PUT /api/pokemon/favorites/reorder 重新排序收藏 |
| POST | `/pokemon/friendship/batch` | 批量获取精灵好感度 POST /api/pokemon/friendship/batch Body: { pokemonIds: number[] } |
| GET | `/pokemon/friendships/:friendshipId` |  |
| POST | `/pokemon/friendships/:friendshipId/interact` |  |
| GET | `/pokemon/friendships/:friendshipId/keepsakes` |  |
| PUT | `/pokemon/friendships/:friendshipId/status` |  |
| GET | `/pokemon/friendships/requests` | ── 精灵好友（REQ-00326） ──────────────────────────────────────── |
| GET | `/pokemon/inventory` | GET /api/pokemon/inventory 获取用户精灵列表（支持排序、分组、过滤） |
| GET | `/pokemon/inventory/:pokemonId` | GET /api/pokemon/inventory/:pokemonId 获取单个精灵详情 |
| GET | `/pokemon/inventory/advice` | GET /api/pokemon/inventory/advice 获取智能整理建议 |
| POST | `/pokemon/inventory/batch-favorite` | POST /api/pokemon/inventory/batch-favorite 批量设置收藏 |
| POST | `/pokemon/inventory/batch-transfer` | POST /api/pokemon/inventory/batch-transfer 批量转移精灵 |
| POST | `/pokemon/inventory/favorite` | POST /api/pokemon/inventory/favorite 设置/取消收藏 |
| POST | `/pokemon/inventory/lock` | POST /api/pokemon/inventory/lock 锁定/解锁精灵 |
| GET | `/pokemon/inventory/sort-options` | GET /api/pokemon/inventory/sort-options 获取可用的排序选项 |
| POST | `/pokemon/inventory/sort-preference` | POST /api/pokemon/inventory/sort-preference 保存用户排序偏好 |
| GET | `/pokemon/inventory/storage` | GET /api/pokemon/inventory/storage 获取背包存储状态 |
| POST | `/pokemon/inventory/tags` | POST /api/pokemon/inventory/tags 更新精灵自定义标签 |
| GET | `/pokemon/items` | GET /stamina/items 获取用户体力道具库存 |
| GET | `/pokemon/my` | GET /pokemon/my — player's pokemon list REQ-00302/465：统一分页（page/pageSize 或 limit/offset；cursor 游标分页）+ pagination/meta.pagination/_links， 保留 data.{pokemon,total,limit,offset} 旧结构；REQ-00350：?ids=a,b,c 按 id 批量取（≤100）+ 预取前 10 个详情 |
| GET | `/pokemon/my/:id` | GET /pokemon/my/:id — 50ms 窗口内同一用户的详情请求合并为一次查询；命中预取/按用户版本隔离的缓存（REQ-00350） |
| POST | `/pokemon/my/:id/evolve` | POST /pokemon/my/:id/evolve |
| GET | `/pokemon/my/:id/moves` | GET /pokemon/my/:id/moves 获取精灵技能栏 |
| POST | `/pokemon/my/:id/moves/forget` | POST /pokemon/my/:id/moves/forget 遗忘技能 Body: { moveId } |
| POST | `/pokemon/my/:id/moves/learn` | POST /pokemon/my/:id/moves/learn 学习新技能 Body: { tmId, forgetMoveId? } |
| POST | `/pokemon/my/:id/moves/switch` | POST /pokemon/my/:id/moves/switch 切换技能 Body: { fastMoveId?, chargeMoveId? } |
| POST | `/pokemon/my/:id/power-up` | POST /pokemon/my/:id/power-up |
| GET | `/pokemon/my/:id/voice-description` |  |
| GET | `/pokemon/my/:instanceId/evolution-preview` | GET /api/pokemon/my/:instanceId/evolution-preview 获取用户精灵的进化预览 |
| GET | `/pokemon/pokedex` | GET /pokemon/pokedex |
| POST | `/pokemon/privacy/batch` |  |
| GET | `/pokemon/privacy/defaults` | ── 精灵隐私（REQ-00377） ──────────────────────────────────────── |
| PUT | `/pokemon/privacy/defaults` |  |
| POST | `/pokemon/release/execute` | POST /api/pokemon/release/execute 执行放生 |
| GET | `/pokemon/release/history` | GET /api/pokemon/release/history 查询放生历史 |
| POST | `/pokemon/release/preview` | POST /api/pokemon/release/preview 预览放生资源 |
| GET | `/pokemon/release/stats` | GET /api/pokemon/release/stats 放生统计 |
| POST | `/pokemon/rest-station/:stationId/start` | POST /stamina/rest-station/:stationId/start 在休息站开始休息 |
| GET | `/pokemon/rest-stations` | GET /stamina/rest-stations 获取附近的休息站 |
| POST | `/pokemon/rest/:recordId/end` | POST /stamina/rest/:recordId/end 结束休息 |
| GET | `/pokemon/showcase/leaderboard` | GET /api/pokemon/showcase/leaderboard 获取排行榜 |
| GET | `/pokemon/species` | GET /pokemon/species — master data list (with localization) REQ-00302/465：统一分页（page/pageSize，兼容 limit/offset；默认 50 条）+ total + 分页链接 |
| GET | `/pokemon/species/:id` | GET /pokemon/species/:id (with localization) |
| GET | `/pokemon/species/:id/voice-description` |  |
| GET | `/pokemon/species/:speciesId/all-evolution-paths` | GET /api/pokemon/:speciesId/all-evolution-paths 获取精灵的所有进化路径（包括退化） |
| GET | `/pokemon/species/:speciesId/evolution-chain` | GET /api/pokemon/:speciesId/evolution-chain 获取精灵进化链（树形结构） |
| GET | `/pokemon/species/stream` | GET /pokemon/species/stream — REQ-00526：图鉴全量 NDJSON 流（按 200 行分批读取、逐行写出，网关边压缩边转发） |
| GET | `/pokemon/users/:userId/collection` |  |
| GET | `/pokemon/users/:userId/showcase` | GET /api/users/:userId/showcase 获取用户展示页 |
| GET | `/pokemon/voice-descriptions` |  |
| POST | `/pokestops/:id/spin` | POST /pokestops/:id/spin |
| GET | `/tm/my` | GET /tm/my 获取玩家 TM 背包 |
| POST | `/tm/use` | POST /tm/use 使用 TM（等同于 /pokemon/my/:id/moves/learn） Body: { pokemonId, tmId, forgetMoveId? } |
| POST | `/training/admin/process-completed` | 管理员接口：处理已完成的训练 POST /api/pokemon/training/admin/process-completed |
| POST | `/training/boost/:slotId` | 使用加速道具 POST /api/pokemon/training/boost/:slotId Body: { boostType: 'time_50' \| 'time_75' \| 'instant' \| 'exp_double' } |
| GET | `/training/camps` | 获取玩家所有训练营信息 GET /api/pokemon/training/camps |
| GET | `/training/camps/:campId/courses` | 获取训练营可用课程 GET /api/pokemon/training/camps/:campId/courses |
| GET | `/training/camps/:campId/slots` | 获取指定训练营的训练槽位 GET /api/pokemon/training/camps/:campId/slots |
| POST | `/training/camps/:campId/upgrade` | 升级训练营 POST /api/pokemon/training/camps/:campId/upgrade |
| POST | `/training/cancel/:slotId` | 取消训练 POST /api/pokemon/training/cancel/:slotId |
| POST | `/training/complete/:slotId` | 完成训练并领取奖励 POST /api/pokemon/training/complete/:slotId |
| GET | `/training/history` | 获取训练历史 GET /api/pokemon/training/history Query: limit, offset |
| GET | `/training/slots/:slotId` | 获取训练槽位详情 GET /api/pokemon/training/slots/:slotId |
| POST | `/training/start` | 开始训练 POST /api/pokemon/training/start Body: { campId, slotIndex, pokemonId, courseId } |

## reward

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/events` | GET /api/events 获取所有活跃活动列表 |
| POST | `/events` | POST /api/events 创建新活动（管理员） |
| GET | `/events/:eventId` | GET /api/events/:eventId 获取活动详情 |
| POST | `/events/:eventId/cancel` | POST /api/events/:eventId/cancel 取消活动（管理员） |
| POST | `/events/:eventId/claim` | POST /api/events/:eventId/claim 领取活动奖励 |
| POST | `/events/:eventId/join` | POST /api/events/:eventId/join 用户参与活动 |
| GET | `/events/:eventId/leaderboard` | GET /api/events/:eventId/leaderboard 获取活动排行榜 |
| POST | `/events/:eventId/pause` | POST /api/events/:eventId/pause 暂停活动（管理员） |
| POST | `/events/:eventId/resume` | POST /api/events/:eventId/resume 恢复活动（管理员） |
| POST | `/events/:eventId/shop/:shopItemId/purchase` | POST /api/events/:eventId/shop/:shopItemId/purchase 活动商店购买 |
| POST | `/events/:eventId/tasks/:taskId/complete` | POST /api/events/:eventId/tasks/:taskId/complete 完成活动任务 |
| GET | `/health` |  |
| GET | `/metrics` | Metrics endpoint |
| POST | `/rewards/achievements/check` | ── POST /rewards/achievements/check  — check & unlock ─────── Called internally by other services after state changes |
| GET | `/rewards/daily` | ── GET /rewards/daily  — check today's login reward status ── |
| POST | `/rewards/daily/claim` | ── POST /rewards/daily/claim ───────────────────────────────── |
| GET | `/rewards/leaderboard` | ── GET /rewards/leaderboard  — global rankings ────────────── REQ-00302/465：page/pageSize 分页（默认第 1 页 100 条，与旧行为一致）；offset > 1000 时走延迟关联（deferred join）， 总数在大表上用规划器估算（countWithStrategy），响应补 pagination/meta.pagination/_links |
| GET | `/rewards/level-ups` | ── 训练师升级奖励 ─────────────────────────────────────────── 升级由数据库触发器根据经验自动完成并写入 trainer_level_ups（见 20260925_020000 迁移），这里负责查询与发放奖励 |
| POST | `/rewards/level-ups/claim` |  |
| GET | `/rewards/quests` | ── GET /rewards/quests  — today's quest status ────────────── |
| POST | `/rewards/quests/claim` | ── POST /rewards/quests/claim  — claim completed quest ────── |
| GET | `/rewards/season` | ── GET /rewards/season  — current season info ─────────────── |

## social

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/batch/friends/status` | POST /batch/friends/status 批量获取好友在线状态和基本信息 Body: { friendIds: ['user1', 'user2', 'user3'] } Response: { code: 0, data: { friends: [status1, status2, status3] } } |
| POST | `/batch/friends/summary` | POST /batch/friends/summary 批量获取好友摘要信息（精简版，用于列表展示） Body: { friendIds: ['user1', 'user2'] } Response: { code: 0, data: { friends: [summary1, summary2] } } |
| POST | `/batch/guilds/members` | POST /batch/guilds/members 批量获取公会成员状态 Body: { memberIds: ['user1', 'user2'] } |
| GET | `/friends` | ── 列表 / 好友码 / 搜索 ────────────────────────────────────── REQ-00302/465：统一分页参数（page/pageSize，兼容 limit/offset；非法值 400），默认 50、上限 400 与原实现一致 |
| DELETE | `/friends/:friendId` |  |
| GET | `/friends/:friendId` |  |
| PATCH | `/friends/:friendId` |  |
| POST | `/friends/:friendId/gift` |  |
| POST | `/friends/:friendId/invite` | 邀请好友（道馆 / 联合任务）：写提醒并实时推送 |
| GET | `/friends/:friendId/joint-missions` | ── 单个好友 ─────────────────────────────────────────────────── |
| POST | `/friends/:friendId/joint-missions` |  |
| GET | `/friends/activities` |  |
| POST | `/friends/activities/:activityId/like` |  |
| POST | `/friends/add` | 旧接口兼容：POST /friends/add { friendCode }（好友码或用户 ID） |
| POST | `/friends/add-by-code` |  |
| GET | `/friends/code/:code` |  |
| GET | `/friends/gifts` |  |
| POST | `/friends/gifts/:giftId/claim` |  |
| POST | `/friends/gifts/:giftId/open` |  |
| POST | `/friends/gifts/claim-all` |  |
| GET | `/friends/gifts/pending` | ── 礼物 ─────────────────────────────────────────────────────── |
| GET | `/friends/gifts/sent` |  |
| GET | `/friends/gifts/types` |  |
| GET | `/friends/joint-missions/:progressId` | ── 联合任务 ─────────────────────────────────────────────────── |
| POST | `/friends/joint-missions/:progressId/claim` |  |
| GET | `/friends/leaderboard` | ── 排行榜 / 在线状态 / 个人资料 ──────────────────────────────── |
| GET | `/friends/levels` |  |
| PUT | `/friends/me/profile` |  |
| GET | `/friends/my-code` |  |
| GET | `/friends/recommendations` | ── 推荐 / 提醒 / 动态 ───────────────────────────────────────── |
| POST | `/friends/recommendations/:userId/dismiss` |  |
| GET | `/friends/reminders` |  |
| POST | `/friends/reminders/read` |  |
| POST | `/friends/request` |  |
| DELETE | `/friends/request/:requestId` |  |
| POST | `/friends/request/:requestId/accept` |  |
| POST | `/friends/request/:requestId/ignore` |  |
| POST | `/friends/request/:requestId/reject` |  |
| GET | `/friends/requests/pending` | ── 好友请求 ─────────────────────────────────────────────────── |
| GET | `/friends/requests/sent` |  |
| GET | `/friends/search` |  |
| POST | `/friends/update-status` |  |
| GET | `/guild` | 搜索公会 GET /api/v1/guilds |
| POST | `/guild` | 创建公会 POST /api/v1/guilds |
| DELETE | `/guild/:guildId` | 解散公会 DELETE /api/v1/guilds/:guildId |
| GET | `/guild/:guildId` | 获取公会详情 GET /api/v1/guilds/:guildId |
| PUT | `/guild/:guildId` | 更新公会设置 PUT /api/v1/guilds/:guildId |
| POST | `/guild/:guildId/applications` | 申请加入公会 POST /api/v1/guilds/:guildId/applications |
| PUT | `/guild/:guildId/applications/:applicationId` | 处理申请 PUT /api/v1/guilds/:guildId/applications/:applicationId |
| POST | `/guild/:guildId/donate` | 捐赠金币 POST /api/v1/guilds/:guildId/donate |
| POST | `/guild/:guildId/kick/:memberId` | 踢出成员 POST /api/v1/guilds/:guildId/kick/:memberId |
| POST | `/guild/:guildId/leave` | 退出公会 POST /api/v1/guilds/:guildId/leave |
| GET | `/health` |  |
| GET | `/leaderboard/:type` | 获取排行榜 GET /api/leaderboard/:type |
| GET | `/leaderboard/:type/rank` | 获取玩家排名 GET /api/leaderboard/:type/rank |
| GET | `/leaderboard/:type/seasons` | 获取赛季历史 GET /api/leaderboard/:type/seasons |
| GET | `/leaderboard/my-ranks` | 获取玩家多个排行榜排名概览 GET /api/leaderboard/my-ranks |
| POST | `/leaderboard/season/:seasonId/claim` | 领取赛季奖励 POST /api/leaderboard/season/:seasonId/claim |
| GET | `/marketplace/favorites` | GET /api/marketplace/favorites 获取用户收藏列表 |
| GET | `/marketplace/listings` | GET /api/marketplace/listings 搜索市场列表 |
| POST | `/marketplace/listings` | POST /api/marketplace/listings 创建市场列表 |
| DELETE | `/marketplace/listings/:listingId` | DELETE /api/marketplace/listings/:listingId 取消列表 |
| GET | `/marketplace/listings/:listingId` | GET /api/marketplace/listings/:listingId 获取列表详情 |
| POST | `/marketplace/listings/:listingId/bid` | POST /api/marketplace/listings/:listingId/bid 出价（拍卖模式） |
| DELETE | `/marketplace/listings/:listingId/favorite` | DELETE /api/marketplace/listings/:listingId/favorite 取消收藏 |
| POST | `/marketplace/listings/:listingId/favorite` | POST /api/marketplace/listings/:listingId/favorite 收藏列表 |
| POST | `/marketplace/listings/:listingId/purchase` | POST /api/marketplace/listings/:listingId/purchase 固定价格购买 |
| GET | `/marketplace/my/listings` | GET /api/marketplace/my/listings 获取我的列表 |
| GET | `/marketplace/stats` | GET /api/marketplace/stats 获取市场统计信息 |
| GET | `/metrics` | Metrics endpoint |
| GET | `/privacy/audit-log` |  |
| DELETE | `/privacy/block/:userId` |  |
| POST | `/privacy/block/:userId` |  |
| GET | `/privacy/blocked` |  |
| GET | `/privacy/check/:targetId/:dataType` |  |
| POST | `/privacy/check/batch` |  |
| GET | `/privacy/friend-requests` | 好友申请审批（与 /v1/friends/request* 等价，便于隐私中心统一处理） |
| POST | `/privacy/friend-requests` |  |
| POST | `/privacy/friend-requests/:requestId/:action` |  |
| DELETE | `/privacy/friends/:friendId` |  |
| PATCH | `/privacy/friends/:friendId/permissions` |  |
| GET | `/privacy/groups` |  |
| POST | `/privacy/groups` |  |
| DELETE | `/privacy/groups/:groupId` |  |
| PATCH | `/privacy/groups/:groupId` |  |
| GET | `/privacy/settings` |  |
| PATCH | `/privacy/settings` |  |
| PUT | `/privacy/settings` |  |
| POST | `/pvp/battle/:battleId/action` | @route   POST /api/pvp/battle/:battleId/action @desc    提交回合行动 @access  Private |
| POST | `/pvp/battle/:battleId/ready` | @route   POST /api/pvp/battle/:battleId/ready @desc    标记准备就绪 @access  Private |
| POST | `/pvp/battle/:battleId/surrender` | @route   POST /api/pvp/battle/:battleId/surrender @desc    认输 @access  Private |
| POST | `/pvp/battle/start` | @route   POST /api/pvp/battle/start @desc    开始好友对战 @access  Private |
| GET | `/pvp/history` | @route   GET /api/pvp/history @desc    获取对战历史 @access  Private |
| GET | `/pvp/leaderboard` | @route   GET /api/pvp/leaderboard @desc    获取排行榜 @access  Public |
| POST | `/pvp/match/join` | @route   POST /api/pvp/match/join @desc    加入匹配队列 @access  Private |
| DELETE | `/pvp/match/leave` | @route   DELETE /api/pvp/match/leave @desc    离开匹配队列 @access  Private |
| GET | `/pvp/ranking` | @route   GET /api/pvp/ranking @desc    获取用户排位信息 @access  Private |
| GET | `/pvp/replay/:battleId` | @route   GET /api/pvp/replay/:battleId @desc    获取战斗回放 @access  Public |
| GET | `/pvp/season` | @route   GET /api/pvp/season @desc    获取赛季信息 @access  Public |
| GET | `/pvp/team` | @route   GET /api/pvp/team @desc    获取 PVP 队伍 @access  Private |
| POST | `/pvp/team` | @route   POST /api/pvp/team @desc    保存 PVP 队伍 @access  Private |
| GET | `/trades/:id` | GET /trades/:id 查询交易详情 |
| POST | `/trades/:id/cancel` | POST /trades/:id/cancel 取消交易 |
| POST | `/trades/:id/confirm` | POST /trades/:id/confirm 确认交易 |
| POST | `/trades/:id/rollback` | POST /trades/:id/rollback 回滚交易（24小时内） |
| GET | `/trades/analytics/report` | GET /trades/analytics/report 生成异常交易报表（管理员） |
| GET | `/trades/fraud/rings` | GET /trades/fraud/rings 检测欺诈团伙（管理员） |
| GET | `/trades/history` | GET /trades/history 查询交易历史 |
| POST | `/trades/request` | POST /trades/request 发起交易请求 |
