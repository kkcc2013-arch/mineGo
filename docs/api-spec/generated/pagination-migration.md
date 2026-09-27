# 分页迁移报告（自动生成）

> node scripts/pagination-migration-report.js 生成；分类依据见脚本头注释。

- GET 路由 811 个，其中列表类 165 个
- 已迁移 4，自定义分页参数 130，固定 LIMIT 31；迁移率 2.4%

## 已迁移（4）

| 服务 | 接口 | 位置 | 说明 |
|---|---|---|---|
| pokemon | `GET /pokemon/my` | backend/services/pokemon-service/src/index.js:240 |  |
| pokemon | `GET /pokemon/species` | backend/services/pokemon-service/src/index.js:141 |  |
| reward | `GET /rewards/leaderboard` | backend/services/reward-service/src/index.js:261 |  |
| social | `GET /friends` | backend/services/social-service/src/routes/friends.js:37 |  |

## 待迁移：自定义分页参数（130）

| 服务 | 接口 | 位置 | 说明 |
|---|---|---|---|
| gateway | `GET /:jobId/history` | backend/gateway/src/routes/jobMonitor.js:103 | 参数：limit, offset |
| gateway | `GET /:taskType` | backend/gateway/src/routes/dlqRoutes.js:56 | 参数：limit, offset |
| gateway | `GET /admin/config/:serviceName/audit` | backend/gateway/src/routes/configRoutes.js:340 | 参数：limit, offset |
| gateway | `GET /admin/config/:serviceName/history` | backend/gateway/src/routes/configRoutes.js:269 | 参数：limit |
| gateway | `GET /alerts` | backend/gateway/src/routes/regionSync.js:250 | 参数：limit |
| gateway | `GET /api/admin/ip-appeals` | backend/gateway/src/routes/admin/ipBan.js:420 | 参数：page, limit |
| gateway | `GET /api/admin/ip-blacklist` | backend/gateway/src/routes/admin/ipBan.js:124 | 参数：page, limit |
| gateway | `GET /api/admin/ip-whitelist` | backend/gateway/src/routes/admin/ipBan.js:294 | 参数：page, limit |
| gateway | `GET /api/admin/pools/:service/history` | backend/gateway/src/routes/poolManagement.js:160 | 参数：limit |
| gateway | `GET /api/device/logs/:deviceId` | backend/gateway/src/routes/deviceIntegrity.js:327 | 参数：limit |
| gateway | `GET /api/device/statistics/cluster` | backend/gateway/src/routes/deviceIntegrity.js:291 | 参数：limit |
| gateway | `GET /api/device/statistics/emulators` | backend/gateway/src/routes/deviceIntegrity.js:257 | 参数：limit |
| gateway | `GET /api/device/statistics/risky` | backend/gateway/src/routes/deviceIntegrity.js:222 | 参数：limit |
| gateway | `GET /api/events` | backend/gateway/src/routes/businessEvents.js:45 | 参数：limit, offset |
| gateway | `GET /api/events/top` | backend/gateway/src/routes/businessEvents.js:350 | 参数：limit |
| gateway | `GET /api/metrics/image-stats/by-pokemon` | backend/gateway/src/routes/imageMetrics.js:167 | 参数：limit |
| gateway | `GET /api/v2/user/quota/history` | backend/gateway/src/routes/quota.js:35 | 参数：limit |
| gateway | `GET /arbitration/history` | backend/gateway/src/routes/regionSync.js:220 | 参数：limit |
| gateway | `GET /audit/:service` | backend/gateway/src/routes/degradation.js:236 | 参数：limit |
| gateway | `GET /config/health/:serviceName/audit` | backend/gateway/src/routes/configRoutes.js:340 | 参数：limit, offset |
| gateway | `GET /config/health/:serviceName/history` | backend/gateway/src/routes/configRoutes.js:269 | 参数：limit |
| gateway | `GET /deployments` | backend/gateway/src/routes/canary.js:18 | 参数：limit |
| gateway | `GET /deployments/:id/history` | backend/gateway/src/routes/canary.js:236 | 参数：limit |
| gateway | `GET /drill/history` | backend/gateway/src/routes/disasterRecovery.js:241 | 参数：limit |
| gateway | `GET /drills` | backend/gateway/src/routes/admin/disasterRecovery.js:390 | 参数：limit |
| gateway | `GET /events` | backend/gateway/src/routes/regionSync.js:157 | 参数：limit, offset |
| gateway | `GET /failover/history` | backend/gateway/src/routes/disasterRecovery.js:134 | 参数：limit |
| gateway | `GET /failover/history` | backend/gateway/src/routes/replication.js:187 | 参数：limit |
| gateway | `GET /history` | backend/gateway/src/routes/admin/alerts.js:19 | 参数：limit |
| gateway | `GET /history` | backend/gateway/src/routes/admin/disasterRecovery.js:429 | 参数：limit |
| gateway | `GET /history` | backend/gateway/src/routes/clientIntegrity.js:242 | 参数：limit, offset |
| gateway | `GET /history` | backend/gateway/src/routes/degradation.js:208 | 参数：limit |
| gateway | `GET /history/:keyId/:language` | backend/gateway/src/routes/translations.js:280 | 参数：limit |
| gateway | `GET /incidents` | backend/gateway/src/routes/admin/kms.js:307 | 参数：limit |
| gateway | `GET /ip-appeals` | backend/gateway/src/routes/ipBanAdmin.js:390 | 参数：page, limit |
| gateway | `GET /ip-blacklist` | backend/gateway/src/routes/ipBanAdmin.js:33 | 参数：page, limit |
| gateway | `GET /keys` | backend/gateway/src/routes/admin/kms.js:21 | 参数：limit, offset |
| gateway | `GET /keys` | backend/gateway/src/routes/translations.js:77 | 参数：limit, offset |
| gateway | `GET /keys/:keyName/logs` | backend/gateway/src/routes/admin/kms.js:156 | 参数：limit |
| gateway | `GET /missing/:language` | backend/gateway/src/routes/translations.js:217 | 参数：limit, offset |
| gateway | `GET /pokemon/search` | backend/gateway/src/middleware/validationMiddleware.js:140 | 参数：page, limit |
| gateway | `GET /recommendations` | backend/gateway/src/routes/queryPerformance.js:172 | 参数：limit |
| gateway | `GET /services/:service/history` | backend/gateway/src/routes/canary.js:314 | 参数：limit |
| gateway | `GET /services/:serviceName/recovery-history` | backend/gateway/src/routes/healthDashboard.js:222 | 参数：limit |
| gateway | `GET /slow-queries` | backend/gateway/src/routes/queryPerformance.js:100 | 参数：limit, offset |
| gateway | `GET /swaps` | backend/gateway/src/routes/regionSync.js:189 | 参数：limit |
| gateway | `GET /traces` | backend/gateway/src/routes/tracing.js:70 | 参数：limit |
| gym | `GET /api/teams/open` | backend/services/gym-service/src/routes/teamBattle.js:43 | 参数：limit |
| gym | `GET /api/v1/gym/season/history` | backend/services/gym-service/src/routes/season.js:175 | 参数：limit |
| gym | `GET /api/v1/gym/season/leaderboard` | backend/services/gym-service/src/routes/season.js:56 | 参数：limit |
| gym | `GET /battle/combos/leaderboard` | backend/services/gym-service/src/routes/battleApi.js:77 | 参数：limit |
| gym | `GET /battle/combos/logs` | backend/services/gym-service/src/routes/battleApi.js:78 | 参数：limit |
| gym | `GET /battle/league/leaderboard` | backend/services/gym-service/src/routes/battleApi.js:267 | 参数：limit |
| gym | `GET /battle/league/matches` | backend/services/gym-service/src/routes/battleApi.js:268 | 参数：limit |
| gym | `GET /battle/recommendations/:speciesId` | backend/services/gym-service/src/routes/battleApi.js:112 | 参数：limit |
| gym | `GET /battle/replays/hot` | backend/services/gym-service/src/routes/battleApi.js:245 | 参数：limit |
| gym | `GET /battle/replays/search` | backend/services/gym-service/src/routes/battleApi.js:246 | 参数：limit, offset |
| gym | `GET /gyms/battles/history` | backend/services/gym-service/src/routes/gymBattle.js:41 | 参数：limit |
| gym | `GET /leaderboard` | backend/services/gym-service/src/routes/combos.js:84 | 参数：limit |
| location | `GET /api/admin/spawn/logs` | backend/services/location-service/src/routes/spawnConfig.js:483 | 参数：limit |
| location | `GET /daynight/pokemon/:period` | backend/services/location-service/src/routes/dayNight.js:92 | 参数：limit |
| location | `GET /habitat/recommended-pokemon` | backend/services/location-service/src/routes/habitat.js:110 | 参数：limit |
| location | `GET /recovery-stations/:id/reviews` | backend/services/location-service/src/routes/recoveryStations.js:358 | 参数：limit, offset |
| location | `GET /recovery-stations/nearby` | backend/services/location-service/src/routes/recoveryStations.js:16 | 参数：limit |
| pokemon | `GET /abilities` | backend/services/pokemon-service/src/routes/abilities.js:16 | 参数：limit, offset |
| pokemon | `GET /achievements/leaderboard` | backend/services/pokemon-service/src/routes/achievements.js:94 | 参数：limit, offset |
| pokemon | `GET /backup/list` | backend/services/pokemon-service/src/routes/backup.js:26 | 参数：limit, offset |
| pokemon | `GET /backup/restore-history` | backend/services/pokemon-service/src/routes/backup.js:279 | 参数：limit, offset |
| pokemon | `GET /bag/expansion-history` | backend/services/pokemon-service/src/routes/bag.js:118 | 参数：limit |
| pokemon | `GET /bag/pokemon` | backend/services/pokemon-service/src/routes/bag.js:138 | 参数：page, limit |
| pokemon | `GET /equipment/inventory` | backend/services/pokemon-service/src/routes/equipment.js:74 | 参数：limit, offset |
| pokemon | `GET /equipment/templates` | backend/services/pokemon-service/src/routes/equipment.js:19 | 参数：limit, offset |
| pokemon | `GET /inventory` | backend/services/pokemon-service/src/routes/inventory.js:29 | 参数：page, limit |
| pokemon | `GET /inventory/upgrades/history` | backend/services/pokemon-service/src/routes/bagUpgrade.js:129 | 参数：limit |
| pokemon | `GET /moves` | backend/services/pokemon-service/src/routes/moves.js:19 | 参数：limit, offset |
| pokemon | `GET /pokedex/leaderboard` | backend/services/pokemon-service/src/routes/pokedex.js:239 | 参数：limit, offset |
| pokemon | `GET /pokemon/:pokemonId/comments` | backend/services/pokemon-service/src/routes/showcase.js:198 | 参数：limit, offset |
| pokemon | `GET /pokemon/:pokemonId/friends` | backend/services/pokemon-service/src/routes/pokemonSocial.js:50 | 参数：page, limit |
| pokemon | `GET /pokemon/:pokemonId/friendship-history` | backend/services/pokemon-service/src/routes/friendship.js:194 | 参数：limit, offset |
| pokemon | `GET /pokemon/:pokemonId/friendship/history` | backend/services/pokemon-service/src/routes/friendshipEvolution.js:76 | 参数：limit |
| pokemon | `GET /pokemon/evolution/history/:userId` | backend/services/pokemon-service/src/routes/evolution.js:318 | 参数：limit, offset |
| pokemon | `GET /pokemon/inventory` | backend/services/pokemon-service/src/routes/inventory.js:29 | 参数：page, limit |
| pokemon | `GET /pokemon/release/history` | backend/services/pokemon-service/src/routes/release.js:293 | 参数：page, limit |
| pokemon | `GET /pokemon/showcase/leaderboard` | backend/services/pokemon-service/src/routes/showcase.js:261 | 参数：limit |
| pokemon | `GET /pokemon/users/:userId/collection` | backend/services/pokemon-service/src/routes/pokemonSocial.js:26 | 参数：limit, offset |
| pokemon | `GET /talents` | backend/services/pokemon-service/src/routes/admin/talentAdminRoutes.js:16 | 参数：limit, offset |
| pokemon | `GET /training/history` | backend/services/pokemon-service/src/routes/trainingCamp.js:209 | 参数：limit, offset |
| reward | `GET /events/:eventId/leaderboard` | backend/services/reward-service/src/routes/events.js:192 | 参数：limit, offset |
| social | `GET /friends/activities` | backend/services/social-service/src/routes/friends.js:125 | 参数：limit |
| social | `GET /friends/gifts/pending` | backend/services/social-service/src/routes/friends.js:88 | 参数：page, limit |
| social | `GET /friends/gifts/sent` | backend/services/social-service/src/routes/friends.js:90 | 参数：limit |
| social | `GET /friends/leaderboard` | backend/services/social-service/src/routes/friends.js:97 | 参数：limit |
| social | `GET /friends/recommendations` | backend/services/social-service/src/routes/friends.js:112 | 参数：limit |
| social | `GET /friends/reminders` | backend/services/social-service/src/routes/friends.js:120 | 参数：limit |
| social | `GET /friends/requests/pending` | backend/services/social-service/src/routes/friends.js:58 | 参数：page, limit |
| social | `GET /friends/search` | backend/services/social-service/src/routes/friends.js:49 | 参数：limit |
| social | `GET /guild` | backend/services/social-service/src/routes/guild.js:219 | 参数：page, limit |
| social | `GET /leaderboard/:type` | backend/services/social-service/src/routes/leaderboard.js:17 | 参数：limit |
| social | `GET /leaderboard/:type/seasons` | backend/services/social-service/src/routes/leaderboard.js:83 | 参数：limit |
| social | `GET /marketplace/listings` | backend/services/social-service/src/routes/marketplace.js:95 | 参数：page, limit |
| social | `GET /privacy/audit-log` | backend/services/social-service/src/routes/privacy.js:77 | 参数：limit |
| social | `GET /privacy/friend-requests` | backend/services/social-service/src/routes/privacy.js:63 | 参数：page, limit |
| social | `GET /public-rooms` | backend/services/social-service/src/routes/voice.js:403 | 参数：page, limit |
| social | `GET /public-rooms` | backend/services/social-service/src/voice/routes.js:221 | 参数：page, limit |
| social | `GET /pvp/history` | backend/services/social-service/src/routes/pvp.js:313 | 参数：limit, offset |
| social | `GET /pvp/leaderboard` | backend/services/social-service/src/routes/pvp.js:297 | 参数：limit, offset |
| social | `GET /trades/history` | backend/services/social-service/src/routes/trade.js:435 | 参数：limit, offset |
| user | `GET /` | backend/services/user-service/src/routes/messageCenter.js:111 | 参数：page, limit |
| user | `GET /:deviceId/activity` | backend/services/user-service/src/routes/deviceManagement.js:323 | 参数：limit, offset |
| user | `GET /admin/data-lifecycle/audit-logs` | backend/services/user-service/src/routes/dataLifecycle.js:217 | 参数：limit, offset |
| user | `GET /admin/high-risk` | backend/services/user-service/src/routes/sessionManagement.js:367 | 参数：limit |
| user | `GET /admin/pending` | backend/services/user-service/src/routes/dataDeletion.js:283 | 参数：limit, offset |
| user | `GET /admin/pending-users` | backend/services/user-service/src/routes/privacy.js:481 | 参数：limit |
| user | `GET /admin/requests` | backend/services/user-service/src/routes/dataDeletion.js:436 | 参数：limit, offset |
| user | `GET /anomalies` | backend/services/user-service/src/routes/secureExportRoutes.js:178 | 参数：limit |
| user | `GET /anomaly-history` | backend/services/user-service/src/routes/sessionManagement.js:235 | 参数：limit, offset |
| user | `GET /audit-logs` | backend/services/user-service/src/routes/gdpr.js:202 | 参数：limit |
| user | `GET /consent/history` | backend/services/user-service/src/routes/cookieConsent.js:386 | 参数：limit |
| user | `GET /high-risk-users` | backend/services/user-service/src/routes/secureExportRoutes.js:193 | 参数：limit |
| user | `GET /history` | backend/services/user-service/src/routes/push.js:183 | 参数：limit, offset |
| user | `GET /history` | backend/services/user-service/src/routes/share.js:131 | 参数：limit, offset |
| user | `GET /logs` | backend/services/user-service/src/routes/notifications.js:208 | 参数：limit |
| user | `GET /pending-requests` | backend/services/user-service/src/routes/secureExportRoutes.js:95 | 参数：limit, offset |
| user | `GET /policies` | backend/services/user-service/src/routes/policyAdmin.js:81 | 参数：limit, offset |
| user | `GET /report/history` | backend/services/user-service/src/routes/privacy.js:375 | 参数：limit |
| user | `GET /requests` | backend/services/user-service/src/routes/dataDeletion.js:129 | 参数：limit, offset |
| user | `GET /titles/leaderboard` | backend/services/user-service/src/routes/titles.js:237 | 参数：limit |
| user | `GET /transfer-logs` | backend/services/user-service/src/routes/dataTransferCompliance.js:129 | 参数：limit |
| user | `GET /transfer-requests` | backend/services/user-service/src/routes/dataTransferCompliance.js:203 | 参数：limit, offset |
| user | `GET /trending` | backend/services/user-service/src/routes/share.js:261 | 参数：limit |

## 待评估：固定 LIMIT（31）

| 服务 | 接口 | 位置 | 说明 |
|---|---|---|---|
| gateway | `GET /admin/api/deprecations/:id` | backend/gateway/src/routes/apiStandards.js:289 | LIMIT 100 |
| gateway | `GET /api/admin/api-standards/field-usage/:resourceType` | backend/gateway/src/routes/apiStandards.js:460 | LIMIT 50 |
| gateway | `GET /api/admin/api-standards/retry` | backend/gateway/src/routes/apiStandards.js:490 | LIMIT 100 |
| gateway | `GET /api/admin/api-versions` | backend/gateway/src/routes/apiStandards.js:335 | LIMIT 20 |
| gateway | `GET /api/admin/deprecations/:id` | backend/gateway/src/routes/apiStandards.js:289 | LIMIT 100 |
| gateway | `GET /api/admin/quota/stats` | backend/gateway/src/routes/quota.js:202 | LIMIT 20 |
| gateway | `GET /api/events/heatmap` | backend/gateway/src/routes/businessEvents.js:208 | LIMIT 10000 |
| gateway | `GET /hourly-stats` | backend/gateway/src/routes/replication.js:224 | LIMIT 48 |
| gateway | `GET /regions/:regionCode/health` | backend/gateway/src/routes/admin/disasterRecovery.js:129 | LIMIT 1000 |
| gateway | `GET /stats` | backend/gateway/src/routes/gang.js:203 | LIMIT 10 |
| gateway | `GET /status` | backend/gateway/src/routes/admin/disasterRecovery.js:53 | LIMIT 5 |
| gym | `GET /battle/ai/reviews` | backend/services/gym-service/src/routes/battleApi.js:175 | LIMIT 30 |
| gym | `GET /gyms/nearby` | backend/services/gym-service/src/routes/gyms.js:18 | LIMIT 1 |
| location | `GET /anticheat/appeals` | backend/services/location-service/src/routes/antiCheatAppeals.js:72 | LIMIT 100 |
| location | `GET /anticheat/suspicious` | backend/services/location-service/src/index.js:524 | LIMIT 100 |
| location | `GET /anticheat/users/:userId/evidence` | backend/services/location-service/src/index.js:549 | LIMIT 50 |
| location | `GET /api/admin/spawn/statistics` | backend/services/location-service/src/routes/spawnConfig.js:436 | LIMIT 1000 |
| location | `GET /location/appeals` | backend/services/location-service/src/routes/antiCheatAppeals.js:60 | LIMIT 20 |
| location | `GET /metrics` | backend/services/location-service/src/index.js:51 | LIMIT 50 |
| location | `GET /metrics/cache` | backend/services/location-service/src/index.js:378 | LIMIT 1 |
| payment | `GET /payment/orders` | backend/services/payment-service/src/index.js:256 | LIMIT 20 |
| pokemon | `GET /pokemon/species/stream` | backend/services/pokemon-service/src/index.js:102 | LIMIT 200 |
| pokemon | `GET /talent-stats` | backend/services/pokemon-service/src/routes/admin/talentAdminRoutes.js:244 | LIMIT 20 |
| reward | `GET /rewards/level-ups` | backend/services/reward-service/src/index.js:142 | LIMIT 50 |
| social | `GET /guild/:guildId` | backend/services/social-service/src/routes/guild.js:127 | LIMIT 20 |
| social | `GET /pvp/season` | backend/services/social-service/src/routes/pvp.js:485 | LIMIT 1 |
| user | `GET /` | backend/services/user-service/src/routes/friend.js:11 | LIMIT 200 |
| user | `GET /:deviceId` | backend/services/user-service/src/routes/deviceManagement.js:125 | LIMIT 50 |
| user | `GET /consent` | backend/services/user-service/src/routes/cookieConsent.js:24 | LIMIT 1 |
| user | `GET /search` | backend/services/user-service/src/routes/friend.js:33 | LIMIT 20 |
| user | `GET /status` | backend/services/user-service/src/routes/ipAppeal.js:74 | LIMIT 1 |

## 迁移方法

1. 路由加 `offsetPaginationMiddleware({ defaultPageSize, maxPageSize })`（或按排序键稳定的列表用 `cursorPaginationMiddleware`）；
2. SQL 用 `req.pagination.limit / req.pagination.offset`，另查 total（大表用 `countWithStrategy` 估算）；偏移量 > 1000 用 `deferredJoinSql`；
3. 响应改为 `res.paginated(items, { total })`（或保留旧 data 结构并附加 `pagination` / `meta.pagination` / `_links`）；
4. 旧参数 limit/offset 继续有效（中间件自动换算），默认页大小保持旧行为，客户端无需同步修改。

