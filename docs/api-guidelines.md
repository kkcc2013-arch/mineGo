# mineGo API 规范（Epic E25）

本文档是客户端与后端开发者共用的 API 约定：响应格式、错误码、分页、超媒体链接、字段投影、内容协商、版本与弃用、批量请求、重试、压缩与流、契约与性能预算。

规范的执行点有两层：

1. **网关转换管道**（`backend/shared/apiStandards`，挂在 `backend/gateway/src/index.js`）：对所有 `/v1/*`、`/api/*`、`/admin/*` 响应统一补齐格式、错误、分页元数据、`_links`、弃用头、契约校验、序列化与压缩。下游服务不改代码也能得到统一格式。
2. **服务端工具**：`shared/apiStandards/pagination.js`（分页中间件与 SQL 工具）、`shared/utils/ApiResponse.js`（响应构造）、`shared/middleware/errorHandler.js`（`AppError`）、`services/pokemon-service/src/services/PokemonBatchService.js`（批量聚合）。

所有改动遵循**只增不减**：旧客户端依赖的 `code: 0`、`message`、`data` 结构和业务错误码都保留。

更深入的主题：

- [命名规范与 Linter](api-standards/naming-conventions.md)（REQ-00329）
- [版本管理、兼容性与弃用](api-standards/versioning-and-deprecation.md)（REQ-00201 / 00520 / 00407）
- [网关转换管道：配置、转换器开发、性能调优](api-standards/gateway-pipeline.md)（REQ-00542）
- 生成物：[OpenAPI（契约生成）](api-spec/openapi.yaml)、[路由清单](api-spec/generated/ROUTES.md)、[分页迁移报告](api-spec/generated/pagination-migration.md)、前端类型 `frontend/game-client/src/types/api.generated.d.ts` 与 `frontend/shared/types/api.ts`

---

## 1. 响应格式（REQ-00386）

### 1.1 成功

```json
{
  "success": true,
  "code": 0,
  "message": "ok",
  "data": { "id": "0a1b…", "nickname": "ash", "level": 5 },
  "meta": { "requestId": "gw-1790294762584-dfzw9s", "timestamp": "2026-09-25T00:06:02.627Z", "apiVersion": 1 },
  "_links": { "self": { "href": "/v1/users/me" }, "inventory": { "href": "/v1/users/me/inventory" } }
}
```

- `code: 0` 表示成功（game-client 以 `code !== 0` 判错，保持不变）；`success` 是新增的布尔标志。
- `meta.requestId` 与日志、`X-Trace-Id` 对应，排查问题时附上。
- 响应 `Content-Type` 总是带 `charset=utf-8`，并设置 `Vary: Accept`。

### 1.2 列表（分页）

```json
{
  "success": true, "code": 0, "message": "ok",
  "data": { "pokemon": [ … ], "total": 100, "limit": 10, "offset": 10 },
  "pagination": { "type": "offset", "page": 2, "pageSize": 10, "limit": 10, "offset": 10, "total": 100, "totalPages": 10, "hasMore": true, "hasNext": true, "hasPrev": true },
  "meta": { "pagination": { …与 pagination 相同… }, "requestId": "…" },
  "_links": { "self": {…}, "first": {…}, "prev": {…}, "next": { "href": "/v1/pokemon/my?page=3&pageSize=10" }, "last": {…} }
}
```

`data` 可以是数组，也可以是保留旧结构的对象（如 `data.pokemon` + `data.total`）；`pagination` 与 `meta.pagination` 是同一个对象，同时提供 RFC 8288 `Link` 头与 `X-Total-Count`。详见第 3 节。

### 1.3 错误

```json
{
  "success": false,
  "code": 1005,
  "message": "路由不存在: GET /v1/nope",
  "error": {
    "code": 1005, "name": "NOT_FOUND", "message": "路由不存在: GET /v1/nope", "httpStatus": 404,
    "i18nKey": "errors.general.not_found", "docUrl": "/api/errors/NOT_FOUND", "retryable": false,
    "localizedMessage": "资源不存在", "details": {}
  },
  "meta": { "requestId": "…", "timestamp": "…" },
  "_links": { "self": { "href": "/v1/nope" }, "help": { "href": "/api/errors/NOT_FOUND" } }
}
```

- 顶层 `code` / `message` 是旧字段，**不改写业务码**（如捕捉限流仍是 `code: 6003`）。
- `error` 是标准对象；个别旧服务返回 `error: "字符串"` 时，字符串原样保留，标准对象放在 `errorInfo`。
- `retryable: true` 的错误可以重试；429 / 503 同时有 `Retry-After` 头与 `error.retryAfter`（秒）。

### 1.4 HTTP 状态码

| 状态码 | 场景 | 错误名 |
|---|---|---|
| 200 / 201 / 204 | 成功 / 创建 / 无内容 | — |
| 400 | 参数错误、非法分页或字段 | `INVALID_REQUEST`、`VALIDATION_ERROR`、`INVALID_PAGINATION`、`INVALID_FIELDS` |
| 401 / 403 | 未认证 / 无权限（管理接口 403 也是 JSON） | `UNAUTHORIZED` / `FORBIDDEN` |
| 404 / 409 | 资源不存在 / 冲突 | `NOT_FOUND` / `CONFLICT` |
| 406 | `Accept` 只包含不支持的类型 | `NOT_ACCEPTABLE` |
| 410 | 版本或端点已下线 | `GONE`（版本，code 1014）/ `API_SUNSET`（端点） |
| 415 | 请求体缺少或使用不支持的 `Content-Type` | `UNSUPPORTED_MEDIA_TYPE` |
| 429 | 限流 | `RATE_LIMITED`、`BATCH_RATE_LIMITED` |
| 500 / 502 / 503 / 504 | 服务器、上游、维护、超时 | `INTERNAL_ERROR`、`RESPONSE_SCHEMA_VIOLATION`（仅开发/测试）… |

### 1.5 错误码目录

- 全部错误码：`GET /api/errors`，单个：`GET /api/errors/NOT_FOUND`（公开，含 `httpStatus`、`i18nKey`、`retryable`）。
- 定义位置：`backend/shared/errors/ErrorCodes.js`（每项含 `code`、`httpStatus`、`message`、`i18nKey`）与 `shared/apiStandards/errorCatalog.js`（网关目录）。
- 新增错误码：在目录中登记，**不要复用含义不同的旧码**；前端用 `i18nKey` 做本地化。

### 1.6 服务端写法

```javascript
const ApiResponse = require('../../../shared/utils/ApiResponse');
const { AppError, asyncHandler } = require('../../../shared/middleware/errorHandler');

router.get('/gyms/:id', asyncHandler(async (req, res) => {
  const gym = await findGym(req.params.id);
  if (!gym) throw new AppError('RESOURCE_NOT_FOUND', { id: req.params.id });  // → 404，统一错误格式
  return ApiResponse.withLinks(res, gym, 'gym');                               // → data + _links（self/defend/collection）
}));

router.get('/items', offsetPaginationMiddleware(), asyncHandler(async (req, res) => {
  const { limit, offset } = req.pagination;
  const rows = await listItems(limit, offset);
  return ApiResponse.paginated(res, rows, { ...req.pagination, total: await countItems() });
}));
```

也可以继续使用 `successResp()`：网关会补齐 `success`、`meta`、`_links` 等字段。

---

## 2. 客户端基本约定

- 每个请求带 `X-Request-ID`（可选）、`X-Client-Id`（如 `game-client-web`）、`X-Client-Version`：弃用接口按客户端统计调用量并定向通知。
- 请求体一律 `Content-Type: application/json; charset=utf-8`（支付回调等白名单除外），否则 415。
- 前端统一使用 `frontend/game-client/src/api/client.js`：已内置退避重试、别名还原、弃用提示（`window` 事件 `pmg:api-deprecated`）、`raw: true` 取完整响应体、`LinkNavigator`、`pages()` 翻页、`batch()`、`streamSpecies()`。

---

## 3. 分页（REQ-00302 / REQ-00465）

### 3.1 参数

| 参数 | 默认 | 上限 | 说明 |
|---|---|---|---|
| `page` | 1 | — | 页码（offset 分页） |
| `pageSize` | 接口默认（精灵 30、图鉴 50、好友 200、排行榜 100） | 100（部分接口 200） | 每页条数 |
| `cursor` | — | — | 游标；`cursor=first` 表示从第一页开始游标分页 |
| `direction` | `next` | — | `next` / `prev` |
| `limit` / `offset` / `size` | — | — | 旧参数，继续有效（自动换算为 page/pageSize），响应头 `X-Pagination-Deprecated-Params` 提示 |

非法值（`page=0`、`pageSize=abc`、伪造游标）→ 400 `INVALID_PAGINATION`；超过上限自动截断。

### 3.2 元数据与链接

`pagination`（= `meta.pagination`）：`type`、`page`、`pageSize`、`limit`、`offset`、`total`、`totalPages`、`hasMore`、`hasNext`、`hasPrev`，游标分页另有 `nextCursor` / `prevCursor`。`total` 在大表上可能是规划器估算值（响应头 `X-Total-Count-Estimated: true`）。

`_links` 与 `Link` 头：`self`、`first`、`prev`、`next`、`last`（游标分页没有 `last`）。客户端翻页**只跟随 `next` 链接**，不要自己拼参数：

```javascript
for await (const page of api.pages('/pokemon/my?pageSize=50')) render(page.data.pokemon);
```

### 3.3 策略

| 场景 | 策略 |
|---|---|
| 需要跳页、总页数 | offset（`page` / `pageSize`） |
| 无限滚动、实时插入频繁 | cursor（keyset：`(sort_key, id) < ($1, $2)`，游标 HMAC 签名防篡改） |
| offset > 1000 | 延迟关联（`deferredJoinSql`：先按索引取 id 再回表），响应头 `X-Pagination-Strategy: deferred-join` |
| 总数 > 1 万行 | `countWithStrategy(..., { mode: 'estimate' })` 用 `EXPLAIN` 估算 |

`PaginationStrategySelector` 按以上规则自动给出建议。

### 3.4 服务端实现

```javascript
const { offsetPaginationMiddleware, cursorPaginationMiddleware, keysetClause, keysetResult, buildLinks } = require('../../../shared/apiStandards/pagination');

app.get('/friends', requireAuth, offsetPaginationMiddleware({ defaultPageSize: 200, maxPageSize: 200 }), async (req, res) => {
  const { limit, offset } = req.pagination;           // 已校验、已换算
  const rows = await query('… LIMIT $2 OFFSET $3', [uid, limit, offset]);
  res.paginated(rows, { total });                     // 或 res.addPaginationMeta() + res.addLinks()
});
```

已迁移：`GET /v1/pokemon/my`（offset + cursor + `?ids=`）、`/v1/pokemon/species`、`/v1/friends`、`/v1/rewards/leaderboard`（延迟关联 + 估算）。其余列表见 `node scripts/pagination-migration-report.js` 生成的迁移报告。

---

## 4. 超媒体链接 HATEOAS（REQ-00518）

### 4.1 约定

- 所有 JSON 对象响应都有 `_links.self`；错误响应有 `_links.help` 指向错误码文档。
- 核心资源附带**可执行操作**链接，链接对象形如 `{ "href": "/v1/pokemon/my/0a1b…/evolve", "method": "POST", "title": "进化" }`，缺省方法为 GET。
- 链接按状态条件出现：精灵糖果不足或没有进化形态时**没有** `evolve`；已完成的交易没有 `accept` / `cancel`；只有本人资料才有 `inventory`。
- 列表中每一项也带 `_links.self`；分页链接见第 3 节。

| 资源 | 链接（部分） |
|---|---|
| pokemon | `self`、`species`、`trainer`、`collection`、`powerUp`、`evolve`（条件）、`setFavorite`、`transfer`、`batch` |
| gym | `self`、`defend`、`collection` |
| user | `self`、`profile`、`pokemon`、`achievements`、`friends` / `inventory`（仅本人） |
| trade | `self`、`initiator`、`receiver`、`collection`、`accept` / `cancel`（进行中） |

### 4.2 资源发现与 HAL

- `GET /api/discover`：所有顶层资源入口与其可用操作（公开）。
- `Accept: application/hal+json`：返回 HAL 表示（资源字段在顶层，`_links` / `_embedded`，信封字段移到 `_meta`）。
- `Link` 响应头：分页与弃用（`successor-version`、`deprecation`）链接。

### 4.3 客户端导航

```javascript
const nav = await api.getPokemonNavigator(id);   // 带 _links 的详情
if (nav.can('evolve')) await nav.follow('evolve'); // 方法与地址都来自链接，不硬编码 URL
const trainer = await nav.follow('trainer');
```

服务端构造链接：`ApiResponse.withLinks(res, data, 'pokemon')` / `paginatedWithLinks` / `hal`；链接模板在 `shared/apiStandards/hateoas.js` 的 `createDefaultRegistry()` 中登记新资源。

---

## 5. 字段投影与别名压缩（REQ-00532 / REQ-00251）

- `?fields=id,cp,stats.hp,moves[].name,trainer(id,nickname)`：只返回指定字段（最多 50 个），分页与信封字段保留。
- `?fieldset=list|detail|battle|social`：预定义字段集，`GET /api/fieldsets` 查询；管理员可通过 `POST /api/admin/api-standards/fieldsets` 维护。
- 声明了 `strictFields` 的接口（如精灵列表）对未知字段返回 400 与 `allowedFields`；敏感字段（password、token 等）永远不可选且全局剥离。
- 精灵列表在下游只查询需要的列（响应头 `X-DB-Projection`）。
- `?_aliases=1` 或 `X-Field-Aliases: 1`：`data` 内长字段名替换为 ≤3 字符别名，别名表在 `_aliases`，客户端 `expandAliasedBody()` 自动还原；单测样本（50 只精灵）体积减少 30% 以上。
- 字段使用情况写入 `field_usage_stats`，用于决定字段集与字段下线。

---

## 6. 内容协商（REQ-00368 / REQ-00554）

| Accept | 结果 |
|---|---|
| 缺省、`*/*`、`application/json` | `application/json; charset=utf-8` |
| `application/x-msgpack` | MessagePack（二进制，体积小于 JSON；配合 `?_aliases=1` 在单测样本中比 JSON 小 30% 以上） |
| `application/hal+json` | HAL |
| `application/vnd.minego.<资源>.v<N>+json` | JSON，同时按 v<N> 协商版本 |
| `application/x-protobuf` 等已知但未实现的格式 | 回退 JSON，响应头 `X-Content-Fallback` |
| 仅包含不支持的类型（如 `text/csv`） | 406，`error.details.supported` 列出可用类型 |

多个类型按 q 值、具体程度、出现顺序选择。可用类型：`GET /api/media-types`。

---

## 7. 版本与弃用（摘要）

- 版本标识：URL（`/api/v1/…`，旧前缀 `/v1/…` 等价）> 媒体类型 `application/vnd.minego.v1+json` > `Accept-Version: 1` > `X-API-Version: 1` > 默认当前稳定版。响应头 `X-API-Version`、`X-API-Version-Source`。
- 生命周期 development → testing → stable → deprecated → sunset；deprecated 响应带 `Deprecation`、`Sunset`、`Link: <…>; rel="successor-version"`，sunset 返回 410。
- 单个端点的弃用同样带这三个头，响应体附 `deprecation` 字段（含 `daysRemaining`、`successorApi`、`migrationGuide` 链接）；到期后 410 `API_SUNSET`。
- 详见 [版本管理、兼容性与弃用](api-standards/versioning-and-deprecation.md)。

---

## 8. 批量请求（REQ-00308 / REQ-00350）

```http
POST /api/v1/batch        （别名 /api/batch，需登录）
{ "requests": [ { "id": "me", "path": "/v1/users/me", "priority": "high" },
                { "id": "daily", "path": "/v1/rewards/daily" } ],
  "options": { "parallel": true, "maxParallel": 10, "timeout": 10000, "failFast": false, "cacheTTL": 30 } }
```

- 最多 20 个子请求；子请求经网关回环执行，鉴权、限流、转换管道与单独请求完全一致；禁止嵌套批量与路径穿越。
- 结果按请求顺序返回：`{ responses: [{ id, status, data | error, cached, duration }], summary: { total, success, failed, cached, totalDuration, costSaved } }`。
- `priority` 决定执行顺序；`failFast: true` 首个失败后中止其余（状态 499）；整体超时的子请求为 504。
- GET 结果按用户隔离缓存（`cacheTTL` 秒，用户任何写操作后自动失效）；幂等 GET 在 502/503/504 时自动重试。
- `?stream=1` 或 `Accept: application/x-ndjson`：每个子请求完成即输出一行，最后一行为 summary。
- 预定义模板：`GET /api/v1/batch/templates`，`POST /api/v1/batch/templates/<name>` + `{ "params": { "id": "…" } }`（pokemon-detail、friends-list、inventory、home）。
- 每用户每分钟 60 次批量请求（429 `BATCH_RATE_LIMITED`）。
- 精灵详情批量：`POST /v1/pokemon/batch/details`（别名 `/api/pokemon/batch/details`）`{ ids: [≤100], include: ["skills","equipment","effects","battle","history"], options: { cacheStrategy: "prefer"|"bypass"|"only" } }`，部分 include 失败时其余照常返回（`metadata.partial`）。

---

## 9. 重试（REQ-00402）

客户端（`client.js` 已实现）：

- 只重试**幂等请求**（GET/HEAD/OPTIONS/PUT/DELETE，或带 `X-Idempotency-Key` 的 POST）；
- 可重试条件：网络错误、超时、408、429、502、503、504；最多 2 次；
- 等待时间：有 `Retry-After` 用它（上限 8 秒），否则 full jitter 指数退避 `random(0, min(8s, 300ms × 2^n))`，避免多个客户端同时重试；
- 取消（`AbortSignal`）立即停止等待。

服务端：`shared/RetryManager.js`（指数 / 线性 / 自适应退避、错误分类、重试预算、截止时间、`fetch()` 只重试幂等请求）；网关把实例注入 `req.retryManager` / `req.retryableFetch`，代理在上游连接失败时对幂等请求退避重试；统计写入 `retry_events` / `retry_stats_hourly`，指标 `retry_total`、`retry_exhausted_total`、`retry_budget_exhausted_total`。

---

## 10. 压缩与流（REQ-00526）

- 网关对 ≥1KB 的响应做流式压缩：Brotli 优先，其次 gzip / deflate（按 `Accept-Encoding` q 值）；压缩流边读边写，不缓冲整个响应；客户端断开时立即释放压缩流。
- 流式内容（`application/x-ndjson`、`text/event-stream`、`X-Stream: 1`）每块写出后立即 flush。
- 图鉴全量 NDJSON：`GET /v1/pokemon/species/stream`，每行一个精灵，最后一行 `{"_summary":{…}}`；前端 `api.streamSpecies(onItem, { signal })` 逐行解析。

---

## 11. 契约（REQ-00315 / REQ-00547 / REQ-00520）

- 契约文件：`backend/shared/apiStandards/schemas/*.json`（JSON Schema 子集，`common#/definitions/…` 共享定义）。每个契约声明 `id`、`method`、`route`、`service`、`auth`、`schema`、可选 `requestSchema` / `strictFields`。
- 网关校验：非生产环境**强制**（违规返回 500 `RESPONSE_SCHEMA_VIOLATION` 并记录），生产按采样率（默认 10%）记录不阻塞；响应头 `X-Schema-Validation: pass|fail|skipped; contract=…`。运行时可调整：`PATCH /api/admin/api-standards/config`。
- 修改契约走 PR：`node scripts/contract-snapshot.js --check` 检测相对快照的破坏性变更（未在 `docs/api-spec/contracts/approved-breaking-changes.json` 审批的会阻断），`--update` 刷新快照。
- 生成物：`node scripts/generate-api-types.js`（前端 TS 类型）、`node scripts/generate-openapi-standards.js`（OpenAPI），均有 `--check`。
- 契约测试：`node scripts/contract-test.js --run`（从契约自动生成正向 / 未鉴权 / 非法请求体 / Mock 用例并经网关执行）。

---

## 12. 性能预算（REQ-00476）

- 预算：`config/performance-budget.yaml`（P50 / P95 / P99 / MAX，`budgetType: strict|moderate|relaxed`，`priority: P0…P3`）。
- 网关实时记录每个 API 请求耗时（`api_performance_budget_duration_seconds`），违规计入 Prometheus 与 Redis 小时汇总；strict 接口 MAX 违规立即告警（`api_performance_alerts` 表 + 日志）。
- 基准：`node scripts/bench-api-performance.js [--gate] [--update-baseline] [--record-db]`，与基线比较 P99 增长 > 20% 视为退化。
- 查看：管理面板 `admin-dashboard/api-standards.html`（达标率、热点、趋势），Grafana `monitoring/grafana/dashboards/api-standards.json`。

---

## 13. 工具一览

| 命令 | 作用 |
|---|---|
| `node scripts/api-lint.js [--all] [--json]` | 路由命名规范检查（error 退出码 1） |
| `node scripts/api-lint.js --docs` / `--check-docs` | 从注释生成路由清单 / 校验与代码同步 |
| `node scripts/pagination-migration-report.js --out …` | 分页迁移报告 |
| `node scripts/contract-snapshot.js --check \| --update \| --report` | 契约破坏性变更门禁 / 快照 / 兼容性报告 |
| `node scripts/generate-api-types.js [--check]` | 前端 TypeScript 类型 |
| `node scripts/generate-openapi-standards.js [--check]` | OpenAPI 文档 |
| `node scripts/contract-test.js --list \| --run` | 契约测试 |
| `node scripts/bench-api-performance.js --gate` | 性能基准与门禁 |
| `node scripts/smoke-api-standards.js` | 端到端冒烟（需运行中的网关） |
| `cd backend && npm run test:api-standards` | 单元测试 |

CI 工作流模板：`ci/github-workflows/api-standards.yml`（需有 workflow 权限的人拷贝到 `.github/workflows/`）。
