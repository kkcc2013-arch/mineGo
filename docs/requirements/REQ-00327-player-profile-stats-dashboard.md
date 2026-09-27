# REQ-00327：玩家个人资料与数据统计展示系统

- **编号**：REQ-00327
- **类别**：功能增强
- **优先级**：P1
- **状态**：implemented
- **涉及服务/模块**：user-service、pokemon-service、social-service、gateway、game-client、frontend/game-client/src/components、database/migrations
- **创建时间**：2026-06-27 00:42 UTC
- **依赖需求**：REQ-00076（成就系统）、REQ-00056（图鉴完成度）、REQ-00055（收藏展示）

## 1. 背景与问题

当前 mineGo 项目缺乏玩家个人资料页面和游戏数据统计展示功能：

1. **无个人资料入口**：玩家无法查看自己的综合游戏数据，包括捕捉统计、道馆战绩、社交活跃度等核心信息
2. **数据分散难以汇总**：玩家数据分散在各个微服务中（pokemon-service 捕捉数据、gym-service 战斗数据、social-service 社交数据），缺乏统一的聚合展示
3. **社交展示缺失**：好友之间无法查看对方的玩家卡片和游戏成就，降低了社交互动的趣味性
4. **缺少收藏家等级系统**：玩家收集精灵的努力缺乏量化的等级评估和展示

## 2. 目标

构建完整的玩家个人资料与数据统计展示系统，提供：

1. 玩家个人资料页面，展示核心游戏数据统计
2. 玩家收藏家等级系统，基于精灵收集进度和成就
3. 可分享的玩家卡片，支持社交展示
4. 数据可视化展示，包括图表和进度条

## 3. 范围

### 包含：
- user-service 新增玩家资料 API（/users/:id/profile）
- 数据统计聚合服务（捕捉、战斗、社交、探索）
- 收藏家等级计算与展示系统
- game-client 玩家资料页面组件
- 玩家卡片生成与分享功能
- 数据库迁移脚本

### 不包含：
- 第三方社交平台分享（后续扩展）
- 详细战斗回放功能
- 隐私设置（已有 REQ-00228）

## 4. 详细需求

### 4.1 数据聚合服务

在 user-service 中实现 `ProfileStatsService`：

```javascript
// 聚合数据结构
{
  player: {
    id: string,
    nickname: string,
    avatar: string,
    level: number,
    team: string,
    title: string,          // 当前激活称号
    collectorRank: string,  // 收藏家等级
    collectorScore: number
  },
  stats: {
    pokemon: {
      totalCaught: number,
      uniqueSpecies: number,
      shinyCount: number,
      perfectIV: number,      // IV 100% 数量
      highestCP: number,
      favoriteSpecies: string
    },
    battle: {
      gymBattles: number,
      gymWins: number,
      raidParticipated: number,
      raidWins: number,
      currentGymDefenders: number
    },
    social: {
      friendsCount: number,
      giftsSent: number,
      giftsReceived: number,
      tradesCompleted: number
    },
    exploration: {
      pokeStopsVisited: number,
      kmWalked: number,
      regionsExplored: number,
      rareEncounters: number
    }
  },
  achievements: {
    unlocked: number,
    total: number,
    recent: Array<{id, name, unlockedAt}>
  },
  pokedex: {
    seen: number,
    caught: number,
    total: number,
    completionRate: number
  }
}
```

### 4.2 收藏家等级系统

定义收藏家等级与积分规则：

| 等级 | 名称 | 所需积分 | 特权 |
|------|------|----------|------|
| 1 | 初学者 | 0 | 基础资料展示 |
| 2 | 收藏家 | 500 | 展示精灵数量+2 |
| 3 | 资深收藏家 | 2000 | 稀有精灵边框 |
| 4 | 精灵学者 | 5000 | 自定义资料背景 |
| 5 | 传奇收藏家 | 10000 | 专属称号解锁 |

积分来源：
- 精灵种类收集：每新种类 +10 分
- 闪光精灵：每只 +50 分
- 完美 IV：每只 +30 分
- 图鉴完成里程碑：每 10% +100 分
- 成就解锁：根据成就稀有度 +5~50 分

### 4.3 API 设计

```
GET /users/:id/profile
  - 返回玩家完整资料数据
  - 支持隐私过滤（非好友只能看公开数据）

GET /users/:id/profile/card
  - 返回可分享的玩家卡片图片 URL

GET /users/me/stats/summary
  - 返回当前用户统计数据摘要

POST /users/me/profile/title
  - 设置展示称号

GET /leaderboard/collectors
  - 收藏家积分排行榜
```

### 4.4 前端组件

```
frontend/game-client/src/components/
├── PlayerProfile/
│   ├── index.js              # 主页面入口
│   ├── ProfileHeader.js      # 玩家头像、等级、称号
│   ├── CollectorBadge.js     # 收藏家等级徽章
│   ├── StatsGrid.js          # 数据统计网格
│   ├── PokedexProgress.js    # 图鉴进度（复用现有）
│   ├── AchievementShowcase.js # 成就展示
│   ├── PlayerCard.js         # 可分享卡片
│   └── ProfileStats.css      # 样式文件
```

### 4.5 数据库设计

```sql
-- 收藏家积分记录
CREATE TABLE collector_scores (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  score INTEGER NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 1,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  score_breakdown JSONB DEFAULT '{}'
);

-- 资料访问日志
CREATE TABLE profile_views (
  id SERIAL PRIMARY KEY,
  viewer_id UUID REFERENCES users(id),
  profile_user_id UUID REFERENCES users(id),
  viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## 5. 验收标准（可测试）

- [ ] GET /users/:id/profile 返回完整玩家资料数据
- [ ] 收藏家等级根据积分规则正确计算
- [ ] 玩家资料页面正确渲染所有统计数据
- [ ] 玩家卡片支持导出为图片格式
- [ ] 非好友用户访问资料时应用隐私过滤
- [ ] 收藏家排行榜正确排序并缓存
- [ ] 资料数据变更后缓存正确更新
- [ ] 前端组件通过单元测试覆盖

## 6. 工作量估算

**L (Large)**

理由：
- 需要跨多个微服务聚合数据（3-4 个服务）
- 前端组件开发较多（6+ 个组件）
- 收藏家等级系统需要设计积分规则和计算逻辑
- 涉及数据库迁移和缓存策略

## 7. 优先级理由

P1 优先级理由：

1. **核心社交体验**：玩家资料是社交互动的基础功能，缺失会严重影响用户粘性
2. **数据价值可视化**：玩家投入的时间和精力需要通过统计数据得到认可和展示
3. **收藏激励**：收藏家等级系统提供持续的游戏目标，增加留存率
4. **成熟度提升**：当前核心功能完整度已达 24/25，此功能将填补个人展示的重要缺口

## 实现记录（2026-09-24）

> E05「成就/称号/资料卡/收藏室」与 E13「消息中心与推送」统一实现：REQ-00076 / 00106 / 00327 / 00359 / 00387 / 00403 与 REQ-00099 / 00261 / 00425 共用同一套游戏事件 outbox、成就引擎与消息中心。
> 状态 `implemented`：代码已全部完成，**未做服务级验证**（2026-09-25 18:30 起规则）。此前迁移 `20260925_130000`、`20260925_131000` 曾在隔离 CI 栈（栈 8）的存量库上执行无失败，user-service 启动后事件消费者、消息分发器、WebSocket 均正常监听；之后新增的迁移 `20260925_132000`、`20260925_133000`、全部接口、前端界面只做了静态检查（`node --check`、`scripts/check-deps.js`、宿主机纯逻辑/内存替身单测），**待验证**。

**共用架构**

- 事件来源：业务表上的触发器把"发生了什么"写入 outbox 表 `achievement_events`（与业务同事务，业务回滚事件也不存在；触发器内部异常只 `RAISE WARNING`，不影响业务）并 `pg_notify('pmg_game_events')`。接入的表：`catch_sessions`（捕捉成功）、`pokestop_spins`、`trainer_level_ups`（升级，覆盖所有加经验路径）、`friendships`/`friends`、`friend_requests`、`friend_gifts`、`pokemon_trades`、`gym_battles`、`raid_participants`、`pvp_battles`、`egg_hatching`、`event_participations`；收藏室的展示/装饰/被点赞由 JS 在同事务写事件。
- 消费：`backend/shared/achievementEngine.js`，user-service 启动时 `LISTEN` 实时处理 + 10 秒兜底扫描 + 每小时清理；pokemon-service 查询成就前按需处理该玩家未处理事件。`FOR UPDATE SKIP LOCKED` 保证多消费者不重复处理；每个事件一个 SAVEPOINT，单事件失败不影响其他事件，失败 5 次后放弃并保留 `last_error`。
- 规则：`backend/shared/achievementRules.js`（事件 → 指标、过滤条件、奖励拆分、事件 → 消息、多语言，纯函数）。
- 消息：`backend/shared/notificationCenter.js`（生成/列表/未读/已读/删除/偏好/广播/分析/清理）、`notificationPolicy.js`（分类、偏好、免打扰、投递计划，纯函数）、`notificationRealtime.js`（`/ws/messages` 与 LISTEN 分发）、`pushProviders.js`（FCM/APNs）。
- 迁移：`database/migrations/20260925_130000__e05_achievement_title_core.sql`（成就/称号收敛 + outbox 触发器）、`20260925_131000__e13_notification_center.sql`（消息中心）、`20260925_132000__e05_collection_room.sql`（收藏室）、`20260925_133000__e05_player_profile.sql`（资料卡）。均 `IF NOT EXISTS`/`ON CONFLICT` 幂等，外键均按 `users.id UUID`；依赖的表（`achievements`、`title_definitions`、`trainer_level_ups`、`notification_templates`、E01 的 `privacy_settings`/`blocked_users` 等）都在更早的迁移中创建（已逐条核对）。
- 测试：单测 `cd backend && node --test tests/unit/achievementRules.test.js tests/unit/achievementEngine.test.js tests/unit/notificationPolicy.test.js tests/unit/notificationCenter.test.js tests/unit/profileRules.test.js tests/unit/collectionRoomRules.test.js tests/unit/securityNotifier.test.js`（53 例，已加入 `test:unit`，宿主机已运行通过；引擎与消息中心用 `tests/unit/helpers/fakeGameDb.js` 内存替身，不依赖数据库）；经网关冒烟 `BASE_URL=… node scripts/smoke-profile-notify.js`（约 97 项，**未运行**）；压测 `node scripts/bench-profile-notify.js`（**未运行**）；前端 `cd frontend/game-client && npx playwright test tests/e2e/profile-notify.spec.js`（Mock 接口，**未运行**）。
- 前端：`frontend/game-client/src/features/profileNotify.js` + `src/features/profile-notify/*`（由 `src/bootstrap/features.js` 注册一行）：底部导航「消息」🔔、「我的」页「成长与收藏」卡片（成就、称号、资料卡、我的收藏室、热门收藏室、收藏家排行、消息与通知设置）。

| 验收标准 | 结果 | 说明 |
|---|---|---|
| GET /users/:id/profile 返回完整玩家资料数据 | ✅ | `GET /v1/users/:id/profile`（`me` 表示本人）：`player`（昵称/头像/等级/队伍/称号/收藏家等级/头像框/背景）、`stats.pokemon`（已捕捉、种类、闪光、完美个体、最高 CP、最爱种类）、`stats.battle`（道馆战/胜、团战/胜、守护道馆、PvP 胜）、`stats.social`（好友、送/收礼、交易）、`stats.exploration`（补给站、行走 km、探索区域、稀有邂逅）、`achievements`（解锁/总数/点数/按稀有度/最近 5 个）、`pokedex`（见过/捕获/总数/完成度）、徽章、精选精灵、收藏室摘要；本人另有访客统计。统计由 `shared/profileStats.js` 一次查询聚合（各子查询按 user_id 走索引） |
| 收藏家等级根据积分规则正确计算 | ✅ | `shared/profileRules.js`：新种类 ×10、闪光 ×50、完美个体 ×30、图鉴每 10% +100、成就按稀有度 5/15/30/50；等级 1~5（初学者/收藏家/资深收藏家/精灵学者/传奇收藏家，0/500/2000/5000/10000）。特权已落地：2 级精选精灵 3→5 只、3 级"收藏家银框"头像框、4 级"学者书房"资料背景、5 级专属称号"传奇收藏家"（自动发放并通知）。积分写 `collector_scores`（资料计算时、捕捉/孵化/交易/成就解锁后由成就引擎刷新）。单测覆盖边界 |
| 玩家资料页面正确渲染所有统计数据 | ✅ | `src/features/profile-notify/profileCard.js` `renderProfile`：头部（头像框/背景主题/称号/收藏家徽章）、收藏家进度与特权、按玩家配置的统计分区顺序渲染统计网格、图鉴进度条、成就与徽章、精选精灵、收藏室摘要、访客数；受限资料显示"未公开" |
| 玩家卡片支持导出为图片格式 | ✅ | 服务端生成 SVG 卡片（`GET /v1/users/:id/profile/card`，`?format=json` 返回字符串；昵称/签名等全部 XML 转义、颜色值白名单校验），客户端"保存为图片"把 SVG 绘制到 canvas 导出 PNG；公开资料的分享卡片 `GET /v1/profile-cards/:code.svg` 无需登录 |
| 非好友用户访问资料时应用隐私过滤 | ✅ | 可见范围：本人 → 全部；好友 → 完整统计（不含访客记录）；非好友看公开资料 → 隐藏社交明细（只留好友数）、行走距离/探索区域、最近活跃、私密收藏室、访客记录；资料设为"仅好友"或"私密"、或被对方拉黑 → 只有昵称/等级/队伍/称号等基本信息。可见性与 E01 隐私设置 `privacy_settings.profile_visibility` 取更严格者，`achievements_visibility` 控制成就/徽章是否展示 |
| 收藏家排行榜正确排序并缓存 | ✅ | `GET /v1/users/leaderboard/collectors?limit=`：按积分降序（同分先达到者在前），排除封禁/已删除账号，带佩戴称号、本人名次；Redis 缓存 60 秒 |
| 资料数据变更后缓存正确更新 | ✅ | 资料按"被查看者 + 可见范围 + 语言"缓存 120 秒，键带被查看者版本号（`shared/profileCache.js`）；资料配置、称号、成就进度（引擎处理完事件）、收藏室变化时版本号递增，所有查看者的旧缓存立即失效。网关原先对 `/v1/users/:id/profile`、`/stats` 做"按查看者缓存 5 分钟"（只随查看者自己的写操作失效，被查看者改资料后别人最多 5 分钟看到旧数据），已改为直接代理。冒烟：查看 → 命中缓存 → 被查看者改签名 → 再查看立即是新签名 |
| 前端组件通过单元测试覆盖 | ⚠️ | 前端没有可运行的单测配置（`tests/unit` 为 jest 风格但无 jest 配置）；改为 Playwright 用例 `tests/e2e/profile-notify.spec.js`（Mock 接口，覆盖"我的"页入口、成就面板、收藏室渲染），未运行；资料规则的纯函数单测在后端 `tests/unit/profileRules.test.js`（9 例，已通过） |

- 入口：user-service `src/routes/profile.js`（挂载 `/users`，在 `user.js` 之前）+ `src/profile/profileService.js`；`GET /v1/users/me/stats/summary`、`POST /v1/users/me/profile/title`（设置展示称号，见 REQ-00106）；网关 `/v1/users/*`、公开 `/v1/profile-cards/*`
- 迁移：`database/migrations/20260925_133000__e05_player_profile.sql`（`collector_scores`、`profile_view_logs` 等，见 REQ-00387）
- 测试：`tests/unit/profileRules.test.js`；冒烟 `scripts/smoke-profile-notify.js` 资料/隐私/资料卡/统计/收藏家约 20 项（未运行）
- 偏差：`profile_views` 与 REQ-00387 的 `profile_view_logs` 合并为一张表；`GET /leaderboard/collectors` 实际路径为 `/v1/users/leaderboard/collectors`
- 待验证：① 资料统计各项与真实数据一致（尤其道馆/团战/探索区域口径）；② 隐私过滤与 E01 隐私设置合并的效果；③ 前端资料页在浏览器中的显示
