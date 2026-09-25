# API 版本管理、兼容性与弃用（REQ-00201 / REQ-00520 / REQ-00407）

本文包含三部分：**版本管理指南**（给后端与运维）、**迁移路径文档模板**（给发起破坏性变更的人）、**开发者集成手册**（给客户端与第三方调用方）。

---

## 第一部分：版本管理指南

### 1. 版本协商

| 优先级 | 方式 | 示例 |
|---|---|---|
| 1 | URL 路径 | `/api/v2/pokemon/my`；旧前缀 `/v1/…` 等价于 v1 |
| 2 | 厂商媒体类型 | `Accept: application/vnd.minego.v1+json`（可带资源：`application/vnd.minego.pokemon.v1+json`） |
| 3 | 请求头 | `Accept-Version: 1` |
| 4 | 自定义头 | `X-API-Version: v1` |
| 5 | 默认 | 当前稳定版（`GET /api/version` 的 `currentVersion`） |

- 响应头：`X-API-Version`（生效版本）、`X-API-Version-Source`（path / media-type / header / default）、`X-API-Supported-Versions`。
- 路径版本与头部版本冲突时以路径为准，并返回 `X-API-Warning` 说明；通过头部使用旧版本时同样有 `X-API-Warning` 提示升级；未知版本 → 400。
- 实现：`backend/gateway/src/middleware/apiVersion.js`（中间件）+ `backend/shared/apiStandards/versioning.js`（`VersionRegistry`，与转换管道共享同一实例）。

### 2. 生命周期

```
development ──► testing ──► stable ──► deprecated ──► sunset
     ▲             │                      │
     └─────────────┘                      └──► stable（撤销弃用，需 force）
```

| 状态 | 对外可见 | 行为 |
|---|---|---|
| development / testing | 否（不出现在 `supportedVersions`） | 仅内部联调 |
| stable | 是 | 正常服务 |
| deprecated | 是 | 响应带 `Deprecation: @<弃用时间戳>`、`Sunset: <HTTP 日期>`、`Link: </api/vN+1/>; rel="successor-version", <迁移指南>; rel="deprecation"` |
| sunset | 否 | 410 Gone（code 1014），响应体给出后继版本；**到达 `sunsetAt` 自动视为 sunset**，无需人工操作 |

状态保存在 `api_versions` 表，网关启动时加载、定期刷新。非法迁移（如 stable → sunset 跳过弃用期）返回 409。

### 3. 管理接口（管理员）

| 接口 | 用途 |
|---|---|
| `GET /api/admin/api-versions` | 版本列表 + 生命周期 + 近 7 天调用量（`api_version_usage`）+ 调用最多的接口 |
| `PATCH /api/admin/api-versions/:v` | 变更状态：`{ status, sunsetAt?, deprecatedAt?, successor?, migrationGuide?, force? }` |
| `POST /api/admin/api-versions/:v/changes` | 登记变更记录（`api_changes`，`breaking: true` 为破坏性） |
| `GET/POST /api/admin/api-versions/transforms`、`DELETE …/transforms/:id` | 版本间数据转换规则 |
| `GET /api/version`、`GET /api/version/:v/breaking-changes`、`GET /api/version/:v/openapi.json` | 公开：版本信息、破坏性变更、按版本过滤的 OpenAPI |

管理面板：`admin-dashboard/api-standards.html` → "版本"页（状态按钮只显示合法迁移）。

### 4. 版本间数据转换

让旧版本客户端继续拿到旧结构，而服务只实现最新结构。规则是声明式的（没有代码执行）：

```json
{ "id": "v1-user-profile-legacy", "version": 1, "method": "GET", "path": "/api/v1/users/:id/profile",
  "response": [ { "op": "remove", "path": "stats" }, { "op": "rename", "from": "nickname", "to": "nick" } ],
  "request":  [ { "op": "default", "path": "channel", "value": "wechat" } ] }
```

操作：`remove`、`rename`、`default`（缺失时补值）、`set`、`move`；作用于 `data`（标准信封）或根，数组逐项处理。生效时响应头 `X-API-Transformed: <规则 id>`。内置规则见 `shared/apiStandards/index.js` 的 `BUILTIN_TRANSFORMS`，其余存 `api_version_transforms`。

### 5. 兼容性检测（REQ-00520）

`shared/apiStandards/compatibility.js` 对比两份契约（或两份 OpenAPI 文档），识别以下变更：

| 类型 | 严重级别 | 破坏性 |
|---|---|---|
| `ENDPOINT_REMOVED` 端点删除 | CRITICAL / P0 | 是 |
| `METHOD_CHANGED` 方法变更 | CRITICAL / P0 | 是 |
| `REQUIRED_FIELD_REMOVED` 删除必填响应字段 | CRITICAL / P0 | 是 |
| `FIELD_TYPE_CHANGED` 字段类型变更 | HIGH / P1 | 是 |
| `REQUIRED_REQUEST_FIELD_ADDED` 新增必填请求字段 / 可选变必填 | HIGH / P1 | 是 |
| `AUTH_CHANGED` 公开接口新增鉴权 | HIGH / P1 | 是 |
| `OPTIONAL_FIELD_REMOVED` 删除可选字段 | MEDIUM / P2 | 是 |
| `ENUM_VALUE_REMOVED` 响应枚举变化（旧客户端遇到未知值） | MEDIUM / P2 | 是 |
| `CONSTRAINT_TIGHTENED`、`FIELD_ADDED`、`ENDPOINT_ADDED`、`DESCRIPTION_CHANGED` | MEDIUM / LOW | 否 |

单测用 10 个历史 / 典型变更案例验证检测准确率 ≥ 90%（`backend/tests/unit/api-standards-contract.test.js`）。

**CI 门禁**（模板 `ci/github-workflows/api-standards.yml`）：

1. `node scripts/contract-snapshot.js --check`：当前契约对比已提交快照 `docs/api-spec/contracts/schema-snapshot.json`，**未审批的破坏性变更阻断合并**；
2. `--report` 生成 Markdown 兼容性报告并作为构件上传（可贴到 PR 评论）；
3. 审批：在 `docs/api-spec/contracts/approved-breaking-changes.json` 加一条 `{ contract, type, path, reason, approvedBy }`，与代码同一个 PR 评审；
4. 合并后运行 `--update` 刷新快照。

管理面板"兼容性报告"页可在线查看，并导出 Markdown / 打印为 PDF。

### 6. 端点级弃用（REQ-00407）

比整版本弃用更细：单个接口换了实现，其余不动。

1. 登记：管理面板"弃用接口"页，或 `POST /api/admin/deprecations`（`/admin/api/deprecations` 等价）
   ```json
   { "endpoint": "/v1/rewards/season", "method": "GET", "sunsetAt": "2026-12-31",
     "successorEndpoint": "/v2/rewards/season",
     "breakingChanges": [ { "field": "freeTierRewards", "change": "renamed to rewards.free" } ],
     "migrationGuide": "可选的补充说明（Markdown）" }
   ```
   `endpoint` 支持 `:param` 与 `*`，具体的规则优先。
2. 生效后该接口响应带 `Deprecation` / `Sunset` / `Link: <successor>; rel="successor-version"` 头，响应体附：
   ```json
   "deprecation": { "deprecated": true, "sunsetAt": "…", "daysRemaining": 30, "successorApi": "/v2/rewards/season",
                    "migrationGuide": "/api/deprecations/12/migration-guide", "breakingChanges": [ … ] }
   ```
3. 调用统计：按 `X-Client-Id` + `X-Client-Version`（没有时按用户）聚合到 `client_migration_status`，同时计入 Prometheus `api_deprecated_calls_total{endpoint,method,client_id,client_version}`；网关导出 `api_deprecation_days_remaining`。
4. 通知：网关每 6 小时检查一次（Redis 锁保证多实例 20 小时内只执行一次），找出 30 天内下线、调用 ≥ 5 次且未迁移的调用方——有用户 id 的写站内通知 `notification_history(type='api_deprecation')`，否则记录告警日志；7 天内不重复通知。也可在面板手动触发（`POST /api/admin/deprecations/notify`）。
5. 迁移进度：面板显示未迁移客户端数、调用次数与进度；确认某客户端已迁移：`POST /api/admin/deprecations/:id/clients/:clientId/migrated`。
6. 到期：`sunsetAt` 之后该接口返回 410 `API_SUNSET`，`error.details` 含 `successorApi` 与迁移文档链接。取消登记：`DELETE /api/admin/deprecations/:id`。
7. 监控：Grafana `monitoring/grafana/dashboards/api-standards.json`（调用量、仍在调用的客户端、即将下线列表），告警 `DeprecatedApiSunsetSoonStillCalled`（`infrastructure/monitoring/prometheus/api_standards_alerts.yml`）。

迁移文档由 `GET /api/deprecations/:id/migration-guide` 自动生成（Markdown，`?format=json` 返回 JSON），内容即下面的模板。

---

## 第二部分：迁移路径文档模板

> 自动生成的迁移文档使用同一结构；手写补充说明放在登记时的 `migrationGuide` 字段。

```markdown
# 迁移指南：GET /v1/rewards/season → /v2/rewards/season

## 概述
- 弃用时间：2026-09-25
- 下线时间：2026-12-31（剩余 N 天）；下线后返回 410 Gone
- 影响：仍有 X 个客户端、Y 次调用未迁移

## 请求对比
| | 旧 | 新 |
|---|---|---|
| 方法 / 路径 | GET /v1/rewards/season | GET /v2/rewards/season |
| 参数 | … | … |

## 响应对比
（字段级差异：改名 / 删除 / 类型变化）

## Breaking Changes
| 字段 | 变化 | 旧类型 | 新类型 |
|---|---|---|---|
| freeTierRewards | 已改名为 rewards.free | array | object |

## 代码示例
（旧调用 → 新调用；JavaScript 示例）

## 迁移步骤
1. 在测试环境改用新接口并对照响应；
2. 客户端发版，带上 X-Client-Id / X-Client-Version，便于确认迁移完成；
3. 观察管理面板中本客户端的调用量归零。

## 时间线与联系人
```

---

## 第三部分：开发者集成手册

### 接入清单

1. **固定版本**：请求路径使用 `/api/v1/…`（或 `/v1/…`），不要依赖"默认版本"——默认会随新版本发布而变化。
2. **标识客户端**：每个请求带 `X-Client-Id`（稳定的应用标识，如 `ios-app`、`partner-foo`）与 `X-Client-Version`。弃用通知按它们定向发送。
3. **监听弃用信号**：响应出现 `Deprecation` 头或 `deprecation` 字段时记录日志并上报；`Sunset` 是最后期限，`Link rel="successor-version"` 是替代接口，`deprecation.migrationGuide` 是迁移文档。游戏客户端已把它转成 `pmg:api-deprecated` 事件。
4. **容忍新增**：响应可能增加字段与 `_links` 条目，客户端应忽略未知字段（新增字段不算破坏性变更）；响应枚举新增取值按破坏性变更提前公告，但客户端仍应对未知枚举值做兜底显示。
5. **处理 410**：收到 410 说明版本或接口已下线，按 `error.details.successorApi` 升级；不要重试。
6. **错误处理**：按 `error.name` 或业务 `code` 分支，用 `error.i18nKey` 本地化，`error.retryable` / `Retry-After` 决定是否重试（只重试幂等请求）。
7. **分页**：跟随 `_links.next` 翻页；不要假设页大小。
8. **查询变更**：`GET /api/version` 看当前与支持的版本，`GET /api/version/:v/breaking-changes` 看变更记录，`GET /api/version/:v/openapi.json` 取该版本的 OpenAPI，`GET /api/deprecations` 看所有弃用公告。

### 时间承诺

- 稳定版本进入 deprecated 后至少保留 **90 天**再 sunset（管理面板默认值）；单个端点弃用至少提前 **30 天**登记，下线前 30 天内的高频调用方会收到通知。
- 破坏性变更只出现在新版本或经审批的端点弃用中；同一版本内只做兼容性变更。
