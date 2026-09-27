# E02 + E34 进度（公会/小队 + 小队实时语音 + 客户端内存保护）

分支 `work/e02-e34-teams-voice`（已 ff 合并 dev/review-20260924 @10ae788，含 E11）。不启动任何服务；只做静态检查与纯逻辑单测。

## 设计要点
- 命名：阵营仍叫 team（users.team）；gym-service 的 `teams` 表属于 REQ-00109 团战（E11 在用）→ 本任务用 **guild（公会，长期组织）+ squad（小队，临时组队 2–20 人）**。
  squad 可挂在公会下（squads.guild_id），小队战绩汇总到公会经验/贡献/任务。
- 旧代码处理：social-service 的 guildService.js / routes/guild.js（db.query 未定义、invite_code 列不存在）、teamService.js / routes/team.js /
  routes/voice.js / voice/*（未挂载、KafkaProducer 路径错误、默认 TURN 密钥、未鉴权）→ 删除并重写。前端 TeamVoiceChatManager.js（CommonJS、硬编码 TURN）删除。
  前端 security/MemoryGuard.js/MemoryScanner.js（CommonJS，浏览器无法 import，上报到不存在的 /api/security/*）保留不动，新写 ESM 模块取代。
- WS：`/ws/squad`（social-service），网关 WS_TARGETS 加一项；social ws.js 需对 /ws/squad 放行（不 404）。
- 战斗集成：gym-service 不改。契约 = `backend/shared/squad/battleReport.js`（Redis Stream `squad:battle-results`）+ 内部 HTTP `POST /internal/squad-battles`（social-service，不经网关）。
  E11 raid.settle() 返回 { raidId, level, participants:[{userId,damage,share,xp,stardust}] }。

## 步骤
- [ ] 1 迁移 20260925_120000__e02_guilds_squads_voice.sql
- [ ] 2 后端纯逻辑 + 单测（guildRules、squadRules、turnCredentials、voiceQuality/MOS、signaling）
- [ ] 3 公会 service + routes（/v1/guilds）
- [ ] 4 小队 service + routes（/v1/squads）+ 内部战绩接口 + stream consumer + shared 契约
- [ ] 5 /ws/squad hub + ws.js 放行 + index.js + gateway
- [ ] 6 coturn 配置 infrastructure/coturn
- [ ] 7 前端 VoiceChatManager + SquadChannel + UI（features.js 一行）
- [ ] 8 客户端完整性（ProtectedValue/TamperMonitor）+ 上报接口（location-service /integrity）+ gateway
- [ ] 9 冒烟脚本 scripts/smoke-squads.js、bench
- [ ] 10 需求文档实现记录 ×3，最终合并 dev/review-20260924 + 静态检查

## 坑
- social ws.js 对非 /ws/friends 路径写 404 并 destroy → 必须加放行路径，否则 /ws/squad 被抢先关闭。
- 宿主机无 backend/node_modules：只跑不 require 第三方包的测试。
