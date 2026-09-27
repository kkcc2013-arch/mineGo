# REQ-00469: 游戏实时对战回放录制与分享系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00469 |
| 标题 | 游戏实时对战回放录制与分享系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | implemented |
| 涉及服务 | battle-service, media-service, social-service |
| 创建时间 | 2026-07-07 03:00 |

## 需求描述

为了增强玩家的社交分享体验及对战竞技分析，需要开发一套游戏实时对战回放录制与分享系统。系统应支持：
1. 在对战结束后自动生成对战回放文件（记录玩家操作序列、战斗事件流）。
2. 提供回放文件的回溯播放功能。
3. 支持将精彩对战片段一键分享至社交媒体或平台内部频道。

## 技术方案

### 1. 对战数据序列化
- 在 Battle Engine 中定义 `BattleEvent` 接口。
- 对战过程中，将每个 `BattleEvent` 序列化并按时间戳排序，存储至 Message Queue（如 Kafka），最后持久化到 Blob Storage。

### 2. 回放与播放引擎
- 提供客户端回放 SDK，解析对战事件流并重现战斗逻辑。
- 增加对“快进”、“倍速”播放的支持。

### 3. 分享机制
- 生成独有的 `Replay-ID`，通过 Link 预览功能展示战斗结果快照。
- 导出对战摘要图（如：胜负、关键伤害数字）供外部平台分享。

## 验收标准

- [ ] 对战结束后可正确生成回放文件并存入存储服务。
- [ ] 玩家可以通过 `Replay-ID` 在客户端重现战斗过程。
- [ ] 支持一键生成战斗结果分享链接，并显示基本的战斗概况。

## 影响范围

- `battle-service`: 战斗事件流水线生成
- `media-service`: 回放数据存储与导出
- `social-service`: 分享链接管理与社交动态发布

## 参考

- [对战系统设计规范](./REQ-00073-pvp-player-vs-player-battle-system.md)

## 实现记录（2026-09-25）

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 对战结束后可正确生成回放文件并存入存储服务。 | ✅ | 结算后自动录制（事件流 + 阵容 + 随机种子，gzip），存 PostgreSQL；偏差：未使用 Kafka/Blob Storage（生产未部署） |
| 玩家可以通过 `Replay-ID` 在客户端重现战斗过程。 | ✅ | `GET /v1/battle/replays/:id` + 客户端 ReplayPlayer 逐回合重现 |
| 支持一键生成战斗结果分享链接，并显示基本的战斗概况。 | ✅ | 结算页「分享」一键生成链接与二维码；落地页显示胜负、回合、伤害、连击、精彩时刻 |

- 入口：gym-service `src/battle/*`（纯逻辑：damage/cooldown/energy/combo/engine/ai/stats/leagueRules/recommendScore/replayFormat/presetRules；持久化与编排：repo/store/session/gym/raid/league/replay/recommend/comboPresets/pokemonEnergy/settle/deps）；路由 `routes/gyms.js`、`routes/gymBattle.js`、`routes/raids.js`、`routes/battleApi.js`（挂 `/battle`）；网关 `backend/gateway/src/index.js`：`/v1/gyms/*`、`/v1/raids/*`、`/v1/battle/*`（鉴权）、公开 `/v1/battle/replays/shared/:code`、WebSocket 升级转发 `/ws/raid`、`/ws/notifications`、`/ws/battle`；同 REQ-00379
- 迁移：`database/migrations/20260925_110000__e11_battle_core.sql`（补列/新表/连击链种子/时间列 TIMESTAMPTZ，全部 IF NOT EXISTS）、`20260925_110100__e11_restore_fast_move_power.sql`；复用既有表见各行说明
- 测试：宿主机已运行（纯逻辑，不连服务）：`cd backend && node --test tests/unit/battle-core.test.js tests/unit/battle-features.test.js` → 29/29 通过；`node --test frontend/game-client/tests/unit/battle-client.test.mjs` → 11/11 通过；`node --expose-gc scripts/bench-battle.js --local`（数字见表）。验证方式调整前（2026-09-25 08:39，提交 e022c97）曾在隔离 CI 栈实测：`scripts/smoke-battle.js` 101/101、核心冒烟 37/37、battle-core 16/16。之后的改动（连击熟练度接入、实时天气、连击道具奖励、大师联赛分组、AI 对位口径、迁移时间列段、前端全部）**未运行，待验证**。待运行：`BASE_URL=… DATABASE_URL=… REDIS_URL=… node scripts/smoke-battle.js`（102 项）、`node scripts/bench-battle.js --battles 20 --concurrency 5`；迁移在全新库上执行 `reset-db` 后检查 bootstrap-report 无 20260925_1100xx 失败
- 待验证：同 REQ-00379
