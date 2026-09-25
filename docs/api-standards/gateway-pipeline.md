# 网关请求/响应转换管道（REQ-00542）

代码：`backend/shared/apiStandards/`（`pipeline.js` 引擎、`transformers.js` 内置转换器、`index.js` 装配与 Express 中间件），网关装配 `backend/gateway/src/apiStandards/setup.js`，管理路由 `backend/gateway/src/routes/apiStandards.js`。

```
客户端 ─► 性能预算计时 ─► 流式压缩 ─► 【转换管道：请求阶段】─► 版本中间件 ─► 路由/代理 ─► 下游服务
                                           │                                                   │
客户端 ◄──────────── 压缩（边压边发）◄── 【转换管道：响应阶段】◄─── 拦截 res.write/end（缓冲 JSON）◄┘
```

- 只作用于 `/v1/*`、`/vN/*`、`/api/*`、`/admin/*`；`API_STANDARDS_ENABLED=false` 时整体旁路。
- 请求阶段可以直接返回（406 / 415 / 410 / 400），不再转发下游。
- 响应阶段只缓冲 JSON：非 JSON、NDJSON/SSE、`X-Stream: 1`、流式管道的成功响应、超过 `API_PIPELINE_MAX_BUFFER` 的响应都**原样透传**（`X-Pipeline: <名>; passthrough`）。
- **fail-open**：任何阶段抛错只跳过该阶段（计入 `api_pipeline_errors_total` 与日志），整个响应阶段失败则发出原始响应。管道故障不会让请求失败。

---

## 一、管道配置指南

### 1. 配置来源（后加载的同名管道覆盖先加载的）

1. 内置 `default` 管道：`transformers.js` 的 `DEFAULT_PIPELINES`；
2. `config/pipelines/*.yaml|*.json`（按文件名排序）——随代码发布；
3. 数据库 `api_transform_pipelines`——管理接口创建，网关每 `API_STANDARDS_REFRESH_MS`（默认 30 秒）刷新，多实例一致。

### 2. DSL

```yaml
pipelines:
  pokemon-detail:
    description: 精灵详情
    metadata:
      route: /v1/pokemon/my/:id     # 支持 :param 与 *；越具体越优先
      method: GET                   # * 表示任意方法
    streaming: false                # true：成功响应不缓冲直接透传（大型响应）；错误响应仍按 default 统一
    cacheEnabled: true              # 纯阶段结果缓存
    cacheTTL: 15                    # 秒
    stages:
      - transformer: contentNegotiator
      - transformer: fieldValidator
        condition: hasFieldQuery    # 条件：isError / isSuccess / hasFieldQuery / hasSchema / wantsHal / wantsAliases / hasDeprecation / always
      - transformer: hateoasLinker
        cacheable: true             # 默认 true；设 false 则该阶段及之后都不进结果缓存
        options: {}                 # 传给转换器的 ctx.stageOptions
      - transformer: compressor     # 必须包含 compressor 才启用流式压缩
      - transformer: serializer     # 通常放最后
```

阶段按声明顺序执行，`phase` 由转换器决定（请求 / 响应），写错阶段或引用不存在的转换器、未知条件时，加载或创建会被拒绝（400）。示例见 `config/pipelines/api-pipelines.yaml`（`large-response`、`species-stream`、`pokemon-detail`）。

### 3. 动态管理（管理员）

| 接口 | 说明 |
|---|---|
| `GET /api/v1/pipelines` | 列表（阶段、路由、是否内置） |
| `GET /api/v1/pipelines/:name`、`GET …/:name/metrics?period=1h\|24h\|7d` | 详情 / 执行次数、平均与 P50/P95/P99 耗时、缓存命中率、透传次数、阶段错误 |
| `POST /api/v1/pipelines` `{ name, config }`、`PUT /api/v1/pipelines/:name` `{ config }` | 创建 / 修改（立即生效并写入数据库） |
| `DELETE /api/v1/pipelines/:name` | 删除（内置管道不可删，可用同名配置覆盖） |
| `POST /api/v1/pipelines/:name/refresh-cache` | 清除该管道的结果缓存 |
| `GET /api/v1/transformers`、`POST /api/v1/transformers`、`DELETE /api/v1/transformers/:name` | 转换器列表 / 创建或删除声明式转换器 |

管理面板 `admin-dashboard/api-standards.html` 的"转换管道"页展示同样的指标。

### 4. 内置转换器

| 转换器 | 阶段 | 纯 | 作用 |
|---|---|---|---|
| contentNegotiator | 请求 | | Accept 协商；406；未实现的二进制格式回退 JSON |
| contentTypeValidator | 请求 | | 请求体 Content-Type 校验，415 |
| deprecationGate | 请求 | | 端点弃用计数；过了 Sunset → 410 |
| paramNormalizer | 请求 | | page/pageSize/cursor → 下游 limit/offset；解析 fields/fieldset |
| fieldValidator | 请求 | | strictFields 契约的未知字段 → 400 |
| languageDetector | 请求 | | Accept-Language / X-Language → 下游 X-Language |
| errorNormalizer | 响应 | ✓ | 错误统一格式（只增不减） |
| successNormalizer | 响应 | ✓ | 补 `success: true` |
| versionTransformer | 响应 | ✓ | 版本间声明式转换 |
| paginationNormalizer | 响应 | ✓ | pagination / meta.pagination / 分页链接 / Link 头 |
| hateoasLinker | 响应 | ✓ | `_links` 与操作链接 |
| schemaValidator | 响应 | ✓ | 契约校验（强制 / 采样） |
| fieldProjector | 响应 | ✓ | 字段投影 |
| halFormatter | 响应 | ✓ | HAL 表示 |
| aliasCompressor | 响应 | ✓ | 字段别名压缩 |
| localizer | 响应 | ✓ | 错误消息本地化 |
| metaInjector | 响应 | | requestId / timestamp / apiVersion |
| deprecationAnnotator | 响应 | | 弃用头与响应体字段 |
| retryAdvisor | 响应 | | 429/503 的 Retry-After |
| compressor | 响应 | | 启用网关流式压缩 |
| serializer | 响应 | | JSON / MessagePack 序列化与 Content-Type |

"纯"阶段的输出只取决于上游响应体和请求变体（方法、URL、版本、语言、媒体类型、别名开关、校验模式），可以缓存；非纯阶段（带请求级信息，如 requestId、弃用计数）每次执行。

---

## 二、转换器开发指南

### 1. 声明式转换器（无需发版）

```http
POST /api/v1/transformers
{ "name": "hideInternalFlags", "type": "removeFields", "config": { "fields": ["is_internal", "debug"] } }
```

| type | config | 行为（作用于 data，数组逐项；无信封时作用于根） |
|---|---|---|
| `renameFields` | `{ map: { old: "new" }, keepOriginal?: false }` | 字段改名 |
| `removeFields` | `{ fields: [...] }` | 删除字段 |
| `addFields` | `{ fields: { k: v } }` | 在响应根补字段（不覆盖已有） |
| `setHeader` | `{ headers: { "X-Foo": "1" } }` | 设置响应头（禁止 Set-Cookie / Authorization / Content-* 等） |

创建后引用到管道的 `stages` 中即可生效；不能覆盖或删除内置转换器。

### 2. 代码转换器

在 `shared/apiStandards/transformers.js` 的 `registerBuiltins()` 中注册：

```javascript
registry.register('gymOwnerMasker', {
  phase: 'response',           // 'request' | 'response'
  builtin: true,
  pure: true,                  // 输出只由上游响应 + 请求变体决定时才标 true（可缓存）
  description: '非本队玩家看不到道馆防守精灵的 IV（REQ-xxxxx）',
  handler(ctx) {
    const d = dataOf(ctx.body);             // 取 data（标准信封）或根
    if (!d || !Array.isArray(d.defenders)) return;
    for (const p of d.defenders) { delete p.iv_attack; delete p.iv_defense; delete p.iv_hp; }
  },
});
```

`ctx` 常用成员：

| 成员 | 说明 |
|---|---|
| `ctx.req` / `ctx.res` | Express 请求 / 响应（响应阶段不要直接写 res） |
| `ctx.path` | **路由前的对外路径**（代理会改写 `req.path`，响应阶段一律用 `ctx.path`） |
| `ctx.status`、`ctx.body` | 响应状态码与已解析的 JSON（可原地修改或替换） |
| `ctx.setHeader(k, v)`、`ctx.appendLink(v)` | 设置响应头 / 追加 Link 头（响应阶段先收集，最后统一写出） |
| `ctx.state` | 阶段间共享的临时数据 |
| `ctx.projection`、`ctx.pagination`、`ctx.media`、`ctx.locale`、`ctx.deprecation` | 请求阶段解析出的字段投影、分页参数、媒体类型、语言、弃用记录 |
| `ctx.userId()`、`ctx.resource()` | 当前用户 id、按路径识别出的资源类型 |
| `ctx.stageOptions` | 管道配置里该阶段的 `options` |
| `ctx.rewriteQuery({...})` | 请求阶段改写转发给下游的查询参数 |

请求阶段要直接返回错误时调用 `halt(ctx, 'INVALID_REQUEST', { status: 400, message, details })`（抛出 `HaltError` 终止管道并写出统一错误格式）。

### 3. 规则

- 不做 I/O：转换器在每个请求的关键路径上，需要数据库 / Redis 的信息应在网关启动或定期刷新时加载到内存（参考 `DeprecationRegistry`、`SchemaRegistry`）。
- 幂等、无副作用：同一输入多次执行结果相同；缓存命中时纯阶段不会执行。
- 抛错即跳过：不要吞掉异常后留下半修改的 body。
- 为新转换器补单测（`backend/tests/unit/api-standards-pipeline.test.js` 用进程内 Express 应用 + 假下游测试完整链路）。

---

## 三、性能调优指南

### 1. 观测

- 响应头：`X-Pipeline`（使用的管道，`; cached` 表示结果缓存命中）、`X-Pipeline-Time`（管道耗时 ms）、`Server-Timing: pipeline;dur=…, upstream;dur=…`。
- Prometheus：`api_pipeline_stage_duration_seconds{pipeline,stage,phase}`、`api_pipeline_executions_total`、`api_pipeline_cache_total{result}`、`api_pipeline_streaming_total`、`api_pipeline_errors_total{stage}`；Grafana `monitoring/grafana/dashboards/api-standards.json`。
- `GET /api/v1/pipelines/:name/metrics`：进程内的执行次数、耗时分位、缓存命中率。

### 2. 调参

| 参数 | 默认 | 说明 |
|---|---|---|
| `API_PIPELINE_MAX_BUFFER` | 2 MB | 超过即透传（不转换），限制单请求内存 |
| `cacheTTL`（管道 / 阶段） | 60 s | 纯阶段结果缓存；数据变化快的接口调小，只读字典类接口调大 |
| LRU 容量 | 1000 条、单条 ≤ 256 KB | `pipeline.js` `LRUCache`，每个网关实例独立 |
| `API_SCHEMA_VALIDATION` / `API_SCHEMA_SAMPLE_RATE` | 生产 `sample` / 0.1 | 契约校验是最贵的纯阶段之一；生产按采样执行（100 条精灵列表中位数 < 5ms） |
| `COMPRESSION_THRESHOLD` / `COMPRESSION_BROTLI_QUALITY` | 1024 B / 4 | Brotli 质量 4 在压缩率与 CPU 之间折中；CPU 紧张时降到 2～3 |
| `API_STANDARDS_REFRESH_MS` | 30000 | 数据库配置（弃用、版本、转换规则、字段集、管道）刷新间隔 |

### 3. 常见优化

1. **大型响应用流式管道**：图鉴全量、导出类接口配置 `streaming: true`，避免缓冲整个响应（内存占用与响应大小解耦），只保留请求阶段与压缩。
2. **下游先做投影**：列表接口按 `?fields` 只查需要的列（参考 `sqlColumns()` 与精灵列表的 `X-DB-Projection`），网关跳过对部分表示的完整契约校验。
3. **提高缓存命中**：纯阶段排在非纯阶段之前（`metaInjector`、`deprecationAnnotator` 等放后面）；上游响应体里避免无意义的变化字段（如每次不同的时间戳）——它们会让 `rawHash` 每次不同。
4. **按路由精简阶段**：内部或只读字典接口可以去掉 `hateoasLinker`、`halFormatter`、`aliasCompressor` 等不需要的阶段。
5. **对比基准**：`node scripts/bench-api-performance.js`（带 / 不带管道各跑一次：`API_STANDARDS_ENABLED=false` 重启网关对比），结果与 `config/performance-budget.yaml` 预算比较。
