# 需求生成与质量规范（GUIDELINES）

> 本文档约束每日需求生成循环。**每次创建或实现需求前必须先读本文档。**
> 目标：10000 条需求。原则：**数量靠拆细，质量靠门禁，完成靠验收命令。**

---

## 1. 为什么需要本规范（2026-06-12 审计结论）

对前 115 条需求的全量审计发现了以下系统性问题，本规范的每条规则都对应一个真实事故：

| 事故 | 规则 |
|------|------|
| 2 个语法错误文件合入 main（evolutionService.js、auditLogEncrypted.js），pokemon-service 启动即崩溃 | CI 全仓 `node --check` 阻断（已实现） |
| 17 个路由文件写完从未挂载（battle、messageCenter、evolution 等），对应需求却标记"已完成" | DoD 必须含挂载验证 + 可执行验收命令 |
| privacy.js 两个 admin 端点留 `// TODO: 添加管理员权限检查` 上线，任何人可拉取用户 email | 安全红线：禁止 TODO 鉴权 |
| 代码调用了不存在的函数 `getMasterKey()`/`decryptWithMasterKey()`（幻觉代码） | 实现后必须实际 require/运行一次 |
| REQ-00057、REQ-00110 编号重复，各挂了两个不同需求 | 编号必须用脚本取号（已实现） |
| STATUS.md 自评 100/100，但统计数与实际文件数不符、章节重复、表格格式损坏 | STATUS.md 只允许追加，统计改为脚本生成 |
| `/policy/check` 被 `/policy/:version` 遮蔽，端点永远不可达 | 验收命令必须逐端点实测 |

## 2. 需求编号

- 创建需求前运行：`node scripts/check-req-numbering.js`，使用输出的 `Next available number`。
- 严禁手工猜号。CI 会阻断新的重复编号。
- 伴生实现文档命名为 `REQ-XXXXX-IMPLEMENTATION.md`，不占用编号。

## 3. 需求文档模板（新增需求必须包含全部字段）

```markdown
# REQ-XXXXX: <标题>

- 类别: 功能增强 | 集成与修复 | 性能 | 安全 | 测试 | 运维 | 文档
- 优先级: P0-P3
- 父需求: REQ-XXXXX（拆分自大需求时填写）

## 背景与价值
<一段话。禁止编造"提升 XX%"的数字，除非有测量方法>

## 验收标准（必填，必须是可执行命令）
- [ ] `node --check backend/...` 通过
- [ ] `curl -sf http://localhost:3001/api/v1/xxx` 返回 200（端点类需求逐端点列出）
- [ ] `node backend/tests/unit/xxx.test.js` 通过
- [ ] 路由已在对应 service 的 index.js 挂载（grep 命令验证）

## 完成定义（DoD）
代码已提交 ≠ 完成。全部验收命令通过 + 路由可达 + CI 绿 = 完成。
```

## 4. 质量红线（任何一条违反即不得标记完成）

1. **禁止幻觉调用**：实现完成后必须 `node -e "require('<模块路径>')"` 实际加载一次。
2. **禁止孤儿路由**：新增 `routes/*.js` 必须同一提交内在 service 的 `index.js` 挂载，并用 curl 验证可达。
3. **禁止 TODO 鉴权**：admin/管理端点必须带 `requireAdmin` 类中间件，参考 `services/user-service/src/routes/privacy.js`。
4. **Express 路由顺序**：静态路径（`/policy/check`）必须注册在参数路径（`/policy/:version`）之前。
5. **隐私默认值**：涉及用户数据收集的开关，非必需类别默认必须是关闭（opt-in），不得默认同意。
6. **STATUS.md**：只追加"最新需求"条目，不重写历史章节；统计数字以 `ls docs/requirements | wc -l` 为准。

## 5. 需求方向配比（每 10 条新需求的参考分布）

| 方向 | 占比 | 说明 |
|------|------|------|
| 集成与修复 | 3 | 优先消化 §6 欠账清单；让"已写"的变成"可用"的 |
| 深化既有系统 | 4 | 在已有系统上纵向拆子需求（见 §7） |
| 新功能 | 2 | 新系统开坑前先确认旧坑已填 |
| 文档/运维/测试 | 1 | 含 CI 强化、测试 runner 统一 |

## 6. 现成需求欠账清单（按此创建即可产出 20+ 条真实需求）

**P0 — 集成欠账（每项一条需求，验收 = curl 该路由返回非 404）：**

| 服务 | 未挂载路由 | 关联需求 |
|------|-----------|---------|
| pokemon-service | evolution, achievements, inventory, pokedex, showcase | REQ-00076 等 |
| user-service | messageCenter, mfa, ipAppeal, gdprService | REQ-00099, REQ-00057 |
| social-service | friends, leaderboard, pvp | — |
| gym-service | battle（battleEngine 整套从未接线，线上还是旧简化版） | REQ-00054 |
| payment-service | currency | — |
| reward-service | events | REQ-00057 |
| location-service | spawnConfig | REQ-00069 |

**P1 — 已知缺陷：**
- 隐私偏好默认值改为 opt-in（`privacyPreferences.js` 的 `initializeUserPreferences`/`canCollectData`），GDPR 要求。
- `getCurrentPolicy` 增加 `WHERE effective_date <= NOW()`，否则未来政策提前生效。
- REQ-00057 / REQ-00110 重复编号清理（重命名为新号 + 更新引用 + 从 `scripts/check-req-numbering.js` 豁免名单移除）。
- 统一测试 runner：82 个单测文件中 64 个是 jest 风格但 CI 不跑 jest；迁移到统一 runner 后让 CI 全量阻断（可拆 8-10 条按服务划分的子需求）。
- STATUS.md 统计部分改为脚本生成（`scripts/gen-status.js`）。
- CI 增加"孤儿路由检测"步骤（routes/*.js 必须被对应 index.js 引用）。

## 7. 冲 10000 的正确姿势：拆细，不是加速

一条"精灵季节活动系统"应拆为 5-10 条可独立验收的子需求：
`春季精灵池 → 夏季精灵池 → 季节任务 → 季节商店 → 樱花粒子效果 → 季节切换调度器 → ...`

每条子需求改动面小、验收命令明确、单独提交。既增加需求数量，又降低单次变更风险。
现有的战斗、培育、交易市场、成就等系统，纵向每个都能拆出几十条。

**反模式**：一次提交 5 个文件 60KB 实现一个"完整系统"，然后自评完成。这正是产生 17 个孤儿路由的根源。

## 8. 每日循环清单

```
1. node scripts/check-req-numbering.js        # 取号
2. 按 §5 配比与 §6 欠账选方向，按 §3 模板写需求文档
3. 实现（小步提交）
4. 逐条执行验收命令；node -e "require(...)" 加载冒烟
5. CI 绿后才允许在 STATUS.md 追加完成条目
```
