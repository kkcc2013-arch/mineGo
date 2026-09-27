# E03 + E04 + E12 进度（work/e03-e04-e12）

> 恢复时：`git status` + 读本文件。不要启动任何服务（见 tools/AGENT-BRIEF.md「验证方式」）。
> 已 fast-forward 合并 dev/review-20260924 到 10ae788（含 E11）。最终报告前再 `git merge dev/review-20260924`。

## 设计要点（已定）
- E12 连击：catch-service `src/combo/`（纯规则 comboRules.js + CatchComboService.js），表 catch_combos / catch_combo_history /
  catch_combo_rewards / catch_combo_events（按 catch session 去重，幂等）。捕捉事务提交后再记连击，失败只记日志，不改变原有返回字段（只新增 `combo`）。
  FLED 断连击（有保护道具 COMBO_SHIELD 则消耗保护）；30 分钟超时。路由 /catch/combo/*（网关 /v1/catch 已整体转发）。
- E12 批处理（REQ-00383）：`CATCH_PERSISTENCE_MODE=sync|batch`，默认 sync（行为完全不变）。
  batch：捕捉关键写（抢占 wild、建实例、关闭 session）仍同步；奖励类写（xp/stardust、糖果、图鉴、成就计数）改为
  同事务写 catch_reward_outbox（不会丢）→ 批量 applier 按用户/物种聚合写入（同事务标记 applied，恰好一次）；
  投掷日志 catch_throws 走 Redis Stream WAL（XADD 失败回退同步 INSERT），批量 INSERT ON CONFLICT(id) DO NOTHING，XACK 于提交后；
  size/time 触发 flush、关停 flush、指数退避重试、超过次数进死信表 catch_persist_failures。
- E04：纯逻辑 `backend/shared/ecosystem/`（geohash / environment / habitats / speciesEcology(151 种) / foodWeb / balancer / spawnWeights / spawnControl）。
  location-service `src/ecosystem/`：spawnDirector 接入 spawnPokemonForPoint + runSpawnCycle（按格子密度控制）；
  ingest worker 轮询 catch_sessions(CAUGHT) 与 pokemon_releases 更新区域生态（不改 catch/pokemon-service）；
  路由重写 spawnConfig（原 req.db/req.redis 不存在）、扩展 habitat、新增 ecosystem；网关加 /v1/habitat /v1/ecosystem /v1/spawn /api/admin/spawn 等。
- E03：统一教程表（沿用 tutorial_steps 加 i18n 列 + tutorials 目录 + user_tutorial_progress + dynamic_hints/hint_contents）；
  user-service 重写 tutorialService（原用 EventBus 发奖无人消费、返回格式与客户端 api 不符）；网关 /v1/tutorial；
  客户端 src/tutorial/* + bootstrap/tutorial.js（features.js 一行）；文案用 src/i18n/locales/*.json 的 tutorial 节点。

## 已完成
- (无)

## 下一步
1. E12 连击：纯规则 + 单测 → 迁移 → 服务 + 路由 → 接入 catch-service
2. E12 批处理
3. E04 纯逻辑 + 单测 → 迁移/种子 → location-service 接入 → 网关
4. E03 迁移 → 纯状态机/提示匹配 + 单测 → 服务/路由 → 网关 → 客户端
5. 客户端 E04/E12 界面；冒烟脚本；需求文档实现记录；合并集成分支 + 静态检查

## 坑
- 宿主机无 backend/node_modules：单测只能 require 纯模块（不 require pg/ioredis/express/prom-client）。
- shared/spawnMetrics.js、HeatmapCollector.js、SpawnEngine.js 是未接入的旧模块（SpawnEngine 另起一套 Redis 刷怪，与 wild_pokemon 冲突，不用）。
- pokemon_species 只种了 ~32 种；生态数据集在代码里覆盖 151 种，DB 关系表不加 species 外键。
- spawn_admin_logs.admin_id 是 INTEGER（users.id 是 UUID），迁移里转换。
