# API 端点命名规范与 Linter（REQ-00329）

规范由 `scripts/api-lint.js` 自动检查：扫描 9 个服务（gateway + user / location / pokemon / catch / gym / social / reward / payment）的 `app.<method>()`、`router.<method>()` 定义，并解析 `app.use('/prefix', require('./routes/x'))` 等挂载前缀得到完整路径。

```bash
node scripts/api-lint.js            # 只列出 error；有 error 时退出码 1（CI 阻断）
node scripts/api-lint.js --all      # 同时列出 warning
node scripts/api-lint.js --json     # JSON（管理面板"命名规范"页同源）
node scripts/api-lint.js --docs     # 从路由上方的注释生成 docs/api-spec/generated/{routes.json,ROUTES.md}
node scripts/api-lint.js --check-docs   # 文档与代码不一致时退出码 1（列出新增/删除的路由）
```

报告每行：`文件:行号  级别  规则  方法 路径 — 违规描述；建议：修复方法`。

## 规则

### error（必须修复）

| 规则 | 说明 | 反例 → 正例 |
|---|---|---|
| `route/invalid-path` | 路径含空白、`//`、非法字符或多余的结尾斜杠 | `/v1/users//me`、`/v1/users/` → `/v1/users/me` |
| `route/duplicate` | 同一服务内相同方法 + 完整路径重复注册：后注册的处理函数永远不会执行 | 两个文件都定义 `GET /friends` → 删除被遮蔽的一个 |
| `method/unsafe-get` | GET 路径以改变状态的动词开头（delete / remove / create / update / reset / purchase / claim / ban …），会被预取、爬虫、CSRF 误触发 | `GET /v1/items/:id/delete` → `DELETE /v1/items/:id`；`GET /v1/rewards/claim` → `POST /v1/rewards/daily/claim` |

名词短语不算违规：`GET /transfer-logs`、`GET /geo-ban`、`GET /reset-history`。

### warning（存量兼容，新代码必须遵守）

| 规则 | 说明 | 示例 |
|---|---|---|
| `naming/kebab-case` | 路径段用小写 + 连字符 | `/v1/userProfiles`、`/v1/friend_requests` → `/v1/user-profiles`、`/v1/friend-requests` |
| `naming/no-verbs` | 路径表达资源，不以 get / fetch / list / create 等动词开头；资源上的 POST 动作子路径（`/evolve`、`/claim`、`/power-up`）可以 | `POST /v1/getThings` → `GET /v1/things` |
| `naming/plural-collection` | 集合资源使用复数（`pokemon`、`inventory`、`me` 等不可数或单例名词在白名单内） | `GET /v1/gym` → `GET /v1/gyms` |
| `naming/nesting-depth` | 嵌套资源不超过 3 层，更深的关系用查询参数或顶层资源 | `/v1/users/:u/pokemon/:p/moves/:m/effects` → `/v1/moves/:m/effects?pokemonId=` |
| `gateway/version-prefix` | 网关对外业务路由带版本前缀（`/v1/…` 或 `/api/vN/…`）；`/health`、`/metrics`、`/api/admin/*`、`/api/discover` 等例外 | `/shop/items` → `/api/v1/shop/items` |
| `docs/missing-jsdoc` | 路由上方写一行说明注释（生成路由清单的依据） | `// GET /v1/gyms/:id — 道馆详情` |

## 最佳实践

1. **资源用名词、动作用方法**：`GET` 查询、`POST` 创建或执行动作、`PUT` 全量替换、`PATCH` 部分更新、`DELETE` 删除；幂等性按 HTTP 语义保证（重试策略依赖它）。
2. **动作子资源**：无法映射到 CRUD 的领域动作用 `POST /资源/:id/动作`（`POST /v1/pokemon/my/:id/evolve`），并在 HATEOAS 链接中声明（见 [api-guidelines.md 第 4 节](../api-guidelines.md)）。
3. **路径参数用 `:camelCase`**（`:pokemonId`），查询参数用 camelCase（`pageSize`、`sortBy`），JSON 字段沿用各服务现有风格（数据库列为 snake_case 的保持 snake_case，不做破坏性改名）。
4. **版本**：新接口一律挂 `/api/v1/…`；旧 `/v1/…` 前缀等价、保留。破坏性变更走新版本或端点弃用流程（[versioning-and-deprecation.md](versioning-and-deprecation.md)）。
5. **过滤 / 排序 / 分页用查询参数**：`GET /v1/pokemon/my?sort=cp&order=desc&page=2&pageSize=20`，不要把过滤条件放进路径。
6. **重命名旧路径**：新路径上线 → 旧路径保留为别名并登记弃用（带 `Deprecation` / `Sunset` / `successor-version`）→ 统计调用方 → 到期 410。
7. **每个路由写一行注释**，说明用途与鉴权要求；`--check-docs` 在 CI 中保证路由清单与代码同步。

## 当前状态

截至本次提交：约 1340 条路由（按挂载前缀展开），error 0；warning 主要为存量的单数资源名与缺少注释。发现并修复的问题：3 处被同路径路由遮蔽、从未执行的处理函数（pokemon-service `GET /pokemon/:pokemonId/friendship` 的 parseInt 版本、social-service `routes/friends.js` 的好友列表、location-service 重复的 `/health`）。实时统计见管理面板 `admin-dashboard/api-standards.html` 的"命名规范"页（`GET /api/admin/api-standards/lint`）。
