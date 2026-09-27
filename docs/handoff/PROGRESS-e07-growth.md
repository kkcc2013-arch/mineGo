# E07 精灵成长 — PROGRESS（worktree 本地记录，不提交）

环境：STACK=7 REPO=/data/workspace/mineGo/wt/e07-growth；网关 http://127.0.0.1:18780（容器内）
T=/data/workspace/mineGo/tools/ci-stack.sh ；探针脚本 docker cp 到 /data/mineGo-ci-7/scripts/_probe.js（scratchpad/probe.js）

## 统一设计（决定）
- 进化单一真相：pokemon_species(evolves_to/candy_to_evolve/evolves_with_item/evolution_level) 为主路径；
  evolution_rules 只提供"目标 != species.evolves_to 且目标物种存在"的分支（伊布 134/135/136/196/197，迁移补物种）。
  同一对 (from,to) 以 species 列为准，规则忽略。条件：糖果(必)、道具(player_inventory, items.item_id 大写)、
  精灵等级、亲密度(0-255)、昼夜、交换(不支持)。
- CP 一律按比例更新：进化 cp*base(new)/base(old)；升级 cp*lm(new)/lm(old)（lm=1+0.02*(L-1)）；觉醒 cp*(1+b')/(1+b)。
  baseCp = floor((A+ivA)*sqrt(D+ivD)*sqrt(H+ivH)/10)（与刷怪一致）。
- 精灵等级：pokemon_instances.level（新列）由 experience 按 species.growth_rate 曲线换算，上限 min(100, 2*训练师等级+10)。
- 亲密度：pokemon_instances.friendship 0-255（默认70）；羁绊等级(0-100)=floor(f*100/255)，羁绊技能 20/50/90。
- 所有新接口挂在 /pokemon/* 下（网关 /v1/pokemon/* 已代理，无需改网关）。
- 忙碌锁：pokemon_instances.occupied_by/occupied_until（训练营/特训/培育），进化/合并/放生/觉醒拒绝忙碌精灵。
- 统一出口：精灵经验 backend/shared/ExperienceEngine.js（纯计算）+ services/pokemon-service/src/growth/experienceService.js
  （事务内 grant）；catch-service 通过 shared/pokemonGrowth.js 调用（捕捉经验 + 传承）。

## 步骤
- [x] 1 迁移 core（level/觉醒/忙碌列、vip_level、伊布进化物种、evolution_rules.is_hidden/hint、evolution_history uuid、成长道具）
- [x] 2 进化修复 (d7ebeb6, smoke evolution 24/24)（evolutionService 重写 + routes/evolution + index.js evolve 委托 + friendship evolve 委托）+ 单测
- [x] 3 经验引擎 + 经验历史/成长轨迹（REQ-00216/00230）+ 捕捉集成 (45655ec; smoke experience+evolution 41/41, core 37/37)
  注意：用 Edit 工具改自己写过的文件，Bash/python 改会回显整文件浪费上下文
- [x] 4 体力（REQ-00172）(65125bf，未在栈上运行)

**新规则（18:30 起）：不再启动任何服务/CI 栈/DB 测试；只写代码+测试+文档，静态检查（node --check、check-deps、
纯逻辑单测 `cd backend && node --test tests/unit/growth-*.test.js`）。需求状态写 implemented，实现记录注明"未运行，待验证"。
不要 push、不要改 .github/workflows。**
- [x] 5 进化路径可视化（REQ-00355）(4ef3325)
- [x] 6 羁绊技能（REQ-00151）(5010471)
- [x] 7 训练营（REQ-00370）(f6cf039)
- [x] 8 训练特训（REQ-00612）(6d9bbc5)
- [x] 9 觉醒（REQ-00245）+ 战斗档案 + 成长商店 (44b30b8)
- [x] 10 培育（REQ-00276）(32dc900)
- [x] 11 传承（REQ-00361）(8fc00ea)
- [x] 12 合并进化（REQ-00390）(befed92)
- [x] 已合并 dev/review-20260924（4a160af，package.json test:unit 冲突已解决）
- [x] 13 前端 growth 面板 (4286d5c)
- [x] E11 战斗接入 (443d7cf)：shared/growthBattle.js + gym-service battle/repo.js、settle.js；熟练度经验统一用 pokemon_move_mastery
- [x] 第二次合并集成分支（E25）6f0dd92：api-lint 0 error（:id + uuidOnly 替代模板参数）、--docs 已生成、contract --check 0 未审批
- [ ] 14 需求文档实现记录（11 个）、回报

## 需求状态计划
00151 implemented（战斗已接入）；00172 implemented（战斗扣体力/疲劳已接入，捕捉不消耗精灵体力⚠️）；00216/00230/00245/00276/00355/00361/00370/00390/00612 implemented

## 坑
- npm install 偶发 EIO（并发写 npm 缓存），重跑 sync 即可。
- 进化接口 500 根因：ps.image_url/ps.name/types 等列不存在或为空；evolution_history.pokemon_instance_id 为 integer；
  user_items 表不存在；pokemon_instances 无 level 列。
- reset-db 偶发 1~2 个无关迁移失败（负载导致超时后顺序变化），重跑即 200/0。PG max_connections=100 被多栈占满时会 500（FATAL remaining connection slots）。
- 协调者：负载高，迁移未变时用 migrate 不用 reset-db；不测试时 stop 服务。
- 带 JOIN 的 FOR UPDATE 在并发更新后会过滤掉行 → lockOwnedPokemon 先单独锁 pi 行。
