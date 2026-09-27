/**
 * REQ-00542 内置转换器（网关管道阶段）
 *
 * 请求阶段：contentNegotiator(406) → contentTypeValidator(415) → deprecationGate(410) → paramNormalizer(分页/字段参数)
 *           → fieldValidator(字段白名单 400) → languageDetector
 * 响应阶段（纯，可缓存）：errorNormalizer → successNormalizer → versionTransformer → paginationNormalizer
 *           → hateoasLinker → schemaValidator → fieldProjector → halFormatter → aliasCompressor → localizer
 * 响应阶段（易变）：metaInjector → deprecationAnnotator → retryAdvisor → compressor → serializer
 */
'use strict';

const mediaTypes = require('./mediaTypes');
const projection = require('./fieldProjection');
const pagination = require('./pagination');
const errors = require('./errorCatalog');
const { LinksBuilder, HalFormatter } = require('./hateoas');
const { appendLinkHeader } = require('./versioning');

let errorMessages = null;
try { errorMessages = require('../errorMessages'); } catch { errorMessages = null; }

class HaltError extends Error {
  constructor() { super('halted'); this.halt = true; }
}

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/** 请求阶段直接返回错误并中断管道 */
function halt(ctx, name, opts = {}) {
  const { status, body } = errors.buildErrorBody(name, { ...opts, requestId: ctx.req.headers['x-request-id'] });
  ctx.halted = true;
  ctx.res.status(status).json(body);
  throw new HaltError();
}

/** 找出响应体里"资源数据"所在位置：标准信封取 data，否则取根 */
function dataOf(body) {
  if (isObj(body) && body.data !== undefined && body.data !== null && typeof body.data === 'object') return { holder: body, key: 'data', value: body.data };
  return { holder: null, key: null, value: body };
}

/** 从契约的响应 schema 推导允许的字段（用于 fields 白名单） */
function allowedFieldsFromContract(contract, resolver) {
  if (!contract || !contract.schema) return null;
  const seen = new Set();
  const resolve = (s, depth = 0) => {
    if (!s || depth > 10) return s || {};
    if (s.$ref) return resolve(resolver(s.$ref), depth + 1);
    if (s.allOf) {
      const merged = { type: 'object', properties: {} };
      for (const x of s.allOf) {
        const r = resolve(x, depth + 1);
        Object.assign(merged.properties, r.properties || {});
        if (r.items) merged.items = r.items;
        if (r.type && r.type !== 'object') merged.type = r.type;
      }
      return merged;
    }
    return s;
  };
  const root = resolve(contract.schema);
  let data = root.properties && root.properties.data ? resolve(root.properties.data) : root;
  if (data.type === 'array' || data.items) data = resolve(data.items || {});
  else if (data.properties) {
    const arrays = Object.entries(data.properties).filter(([, v]) => { const r = resolve(v); return r.type === 'array' || r.items; });
    if (arrays.length === 1) data = resolve(resolve(arrays[0][1]).items || {});
  }
  for (const [k, v] of Object.entries(data.properties || {})) {
    seen.add(k);
    const r = resolve(v);
    const inner = r.type === 'array' || r.items ? resolve(r.items || {}) : r;
    for (const k2 of Object.keys(inner.properties || {})) seen.add(`${k}.${k2}`);
  }
  return seen.size ? seen : null;
}

/**
 * @param {object} deps 由 index.js 注入：mediaRegistry, fieldsets, linkRegistry, versionRegistry, transforms,
 *                      deprecations, schemas, config, logger, metrics
 */
function registerBuiltins(registry, deps) {
  const linksBuilder = new LinksBuilder(deps.linkRegistry);

  // ── 请求阶段 ───────────────────────────────────────────────
  registry.register('contentNegotiator', {
    phase: 'request', builtin: true, priority: 100,
    description: 'Accept 协商：JSON / vnd.minego+json / HAL / MessagePack；不可接受 → 406；未实现的二进制格式回退 JSON（REQ-00368/554）',
    handler(ctx) {
      const neg = mediaTypes.negotiate(ctx.req.headers.accept, deps.mediaRegistry);
      ctx.media = neg;
      if (neg.notAcceptable) {
        ctx.media = mediaTypes.negotiate(undefined, deps.mediaRegistry);
        halt(ctx, 'NOT_ACCEPTABLE', {
          message: `无法提供 Accept 中要求的格式：${neg.requested.join(', ')}`,
          details: { requested: neg.requested, supported: deps.mediaRegistry.implemented().map((e) => e.mediaType) },
        });
      }
      if (neg.fallback) ctx.setHeader('X-Content-Fallback', `${neg.fallbackFrom} -> ${neg.mediaType}`);
    },
  });

  registry.register('contentTypeValidator', {
    phase: 'request', builtin: true, priority: 95,
    description: 'POST/PUT/PATCH 请求体 Content-Type 校验：缺失/非法 → 415（支付回调等白名单除外）',
    handler(ctx) {
      const p = ctx.path;
      if ((deps.config.contentTypeExemptPaths || []).some((x) => p.startsWith(x))) return;
      const r = mediaTypes.checkContentType(ctx.req);
      if (!r.ok) {
        halt(ctx, 'UNSUPPORTED_MEDIA_TYPE', {
          message: r.reason === 'missing' ? '请求体缺少 Content-Type' : `不支持的 Content-Type：${r.contentType}`,
          details: { reason: r.reason, contentType: r.contentType, allowed: mediaTypes.DEFAULT_ALLOWED_REQUEST_TYPES },
        });
      }
    },
  });

  registry.register('deprecationGate', {
    phase: 'request', builtin: true, priority: 90,
    description: '端点弃用：记录调用；超过 Sunset 日期 → 410 Gone（REQ-00407）',
    handler(ctx) {
      const d = deps.deprecations.find(ctx.req.method, ctx.path);
      if (!d) return;
      ctx.deprecation = d;
      deps.deprecations.recordCall(d, {
        clientId: ctx.req.headers['x-client-id'] || ctx.req.headers['x-platform'],
        clientVersion: ctx.req.headers['x-client-version'] || ctx.req.headers['x-client-ver'],
        userId: ctx.userId(),
      });
      if (deps.deprecations.isSunset(d)) {
        for (const [k, v] of Object.entries(deps.deprecations.headers(d))) ctx.res.setHeader(k, v);
        halt(ctx, 'API_SUNSET', {
          message: `接口 ${d.method} ${d.endpoint} 已于 ${d.sunsetAt ? d.sunsetAt.toISOString() : '-'} 下线${d.successor ? `，请改用 ${d.successor}` : ''}`,
          details: deps.deprecations.bodyField(d),
        });
      }
    },
  });

  registry.register('paramNormalizer', {
    phase: 'request', builtin: true, priority: 80,
    description: '分页参数标准化（page/pageSize/cursor → 下游 limit/offset）与 fields/fieldset 解析（REQ-00302/465/532）',
    handler(ctx) {
      const q = ctx.req.query || {};
      const usesStd = ['page', 'pageSize', 'page_size', 'per_page', 'cursor'].some((k) => q[k] !== undefined);
      try {
        ctx.pagination = pagination.parsePagination(q, { cursorSecret: deps.config.cursorSecret });
      } catch (err) {
        if (usesStd) halt(ctx, 'INVALID_PAGINATION', { message: err.message, details: err.details });
        ctx.pagination = null;
      }
      const hasSize = ['pageSize', 'page_size', 'per_page'].some((k) => q[k] !== undefined);
      if (usesStd && hasSize && ctx.pagination && ctx.pagination.type === 'offset') {
        // 下游服务多数只认 limit/offset：补齐（不覆盖客户端显式给出的值）。
        // 只给 page 不给页大小时不补：各接口默认页大小不同（精灵 30、图鉴 50、好友 50…），由下游分页中间件按 page 处理
        const add = {};
        if (q.limit === undefined) add.limit = String(ctx.pagination.pageSize);
        if (q.offset === undefined) add.offset = String(ctx.pagination.offset);
        if (Object.keys(add).length) ctx.rewriteQuery(add);
      }
      if (ctx.pagination && ctx.pagination.deprecatedParams.length && usesStd === false && q.offset !== undefined) {
        ctx.setHeader('X-Pagination-Deprecated-Params', ctx.pagination.deprecatedParams.join(','));
      }
      // 字段投影参数
      if (q.fields !== undefined || q.fieldset !== undefined) {
        try {
          let paths = null, tree = null;
          if (q.fields !== undefined) ({ tree, paths } = projection.parseFields(q.fields, { maxFields: deps.config.maxFields }) || {});
          let fieldset = null;
          if (q.fieldset !== undefined) {
            const resource = ctx.resource();
            const fs = resource ? deps.fieldsets.get(resource.type, String(q.fieldset)) : null;
            if (!fs) {
              halt(ctx, 'INVALID_FIELDS', {
                message: `未知字段集 "${q.fieldset}"`,
                details: { resource: resource ? resource.type : null, available: resource ? deps.fieldsets.names(resource.type) : [] },
              });
            }
            fieldset = String(q.fieldset);
            if (fs.fields) {
              const parsed = projection.parseFields(fs.fields.join(','), { maxFields: 200 });
              if (tree) { Object.assign(parsed.tree, tree); paths = [...new Set([...parsed.paths, ...paths])]; } else ({ tree, paths } = parsed);
            }
          }
          ctx.projection = tree ? { tree, paths, fieldset } : null;
          if (deps.metrics && deps.metrics.projection && ctx.projection) {
            try { deps.metrics.projection.inc({ resource: (ctx.resource() || {}).type || 'other', mode: fieldset ? 'fieldset' : 'fields' }); } catch { /* ignore */ }
          }
          if (deps.fieldUsage && ctx.projection) deps.fieldUsage.record((ctx.resource() || {}).type || 'other', ctx.projection.paths);
        } catch (err) {
          if (err.halt) throw err;
          halt(ctx, 'INVALID_FIELDS', { message: err.message, details: err.details });
        }
      }
    },
  });

  registry.register('fieldValidator', {
    phase: 'request', builtin: true, priority: 70,
    description: '按接口契约校验 fields：契约声明 strictFields 时未知字段 → 400 并返回允许字段列表（REQ-00532）',
    handler(ctx) {
      if (!ctx.projection || ctx.projection.fieldset) return;
      const contract = deps.schemas.match(ctx.req.method, ctx.path, 200);
      if (!contract || !contract.strictFields) return;
      const allowed = allowedFieldsFromContract(contract, deps.schemas.resolver());
      if (!allowed) return;
      const invalid = projection.validateAgainst(ctx.projection.paths, allowed);
      if (invalid.length) {
        halt(ctx, 'INVALID_FIELDS', { message: `无效字段：${invalid.join(', ')}`, details: { invalid, allowedFields: [...allowed].sort() } });
      }
    },
  });

  registry.register('languageDetector', {
    phase: 'request', builtin: true, priority: 60,
    description: '语言检测：X-Language / Accept-Language → 透传下游 X-Language',
    handler(ctx) {
      const raw = String(ctx.req.headers['x-language'] || ctx.req.headers['accept-language'] || '');
      const l = raw.toLowerCase();
      const lang = l.startsWith('zh') ? 'zh-CN' : l.startsWith('ja') ? 'ja-JP' : l.startsWith('en') ? 'en-US' : null;
      ctx.locale = lang;
      if (lang && !ctx.req.headers['x-language']) ctx.req.headers['x-language'] = lang;
    },
  });

  // ── 响应阶段（纯） ───────────────────────────────────────────
  registry.register('errorNormalizer', {
    phase: 'response', builtin: true, pure: true,
    description: '错误响应统一：success/code/message/error{code,name,message,i18nKey,docUrl,retryable}（只增不减，REQ-00386）',
    handler(ctx) {
      if (ctx.status < 400) return;
      if (!isObj(ctx.body)) {
        const { body } = errors.buildErrorBody(errors.statusDefault(ctx.status).name, { status: ctx.status, message: typeof ctx.body === 'string' ? ctx.body.slice(0, 200) : undefined });
        delete body.meta; // meta 在易变阶段（metaInjector）补
        ctx.body = body;
        return;
      }
      errors.normalizeErrorBody(ctx.body, ctx.status, { meta: false });
    },
  });

  registry.register('successNormalizer', {
    phase: 'response', builtin: true, pure: true,
    description: '成功响应补 success:true（不改 code/message/data）',
    handler(ctx) {
      if (ctx.status >= 400 || !isObj(ctx.body)) return;
      if (ctx.body.success === undefined) ctx.body.success = true;
    },
  });

  registry.register('versionTransformer', {
    phase: 'response', builtin: true, pure: true,
    description: '版本间响应转换（声明式规则，REQ-00201）',
    handler(ctx) {
      const v = ctx.req.apiVersion;
      if (!v || !deps.transforms) return;
      const r = deps.transforms.transformResponse(v, ctx.req.method, ctx.path, ctx.body);
      if (r.applied.length) ctx.setHeader('X-API-Transformed', r.applied.join(','));
    },
  });

  registry.register('paginationNormalizer', {
    phase: 'response', builtin: true, pure: true,
    description: '列表响应补 pagination / meta.pagination / 分页 _links / Link 头（REQ-00302/465/518）',
    handler(ctx) {
      if (ctx.status >= 300) return;
      const list = pagination.detectList(ctx.body);
      if (!list || !Array.isArray(list.items)) return;
      const opt = (ctx.stageOptions && ctx.stageOptions.routes && Object.entries(ctx.stageOptions.routes).find(([r]) => new RegExp(`^${r}$`).test(ctx.path))) || null;
      const routeOpt = opt ? opt[1] : {};
      const reqP = ctx.pagination || { type: 'offset', page: 1, pageSize: null, offset: 0 };
      const q = ctx.originalQuery || ctx.req.query || {};
      const explicit = ['page', 'pageSize', 'page_size', 'per_page', 'size', 'limit', 'offset', 'cursor'].some((k) => q[k] !== undefined);
      const up = isObj(ctx.body) && isObj(ctx.body.pagination) ? ctx.body.pagination : (isObj(ctx.body) && isObj(ctx.body.meta) && isObj(ctx.body.meta.pagination) ? ctx.body.meta.pagination : null);
      let meta;
      if (up && up.type) {
        meta = pagination.buildMeta({ ...up, count: list.items.length });
        Object.assign(meta, up);
      } else {
        const container = list.container || {};
        const cursorNext = container.nextCursor || container.next_cursor || null;
        const limit = Number(list.limit) || (explicit ? reqP.pageSize : null) || routeOpt.defaultLimit || null;
        const total = list.total !== null && list.total !== undefined ? list.total : (!limit && !explicit ? list.items.length : null);
        const pageSize = limit || Math.max(list.items.length, 1);
        const offset = list.offset !== undefined && list.offset !== null ? Number(list.offset) : (reqP.type === 'offset' ? reqP.offset || 0 : null);
        meta = pagination.buildMeta({
          type: cursorNext || reqP.type === 'cursor' ? 'cursor' : 'offset',
          page: reqP.type === 'offset' && offset !== null ? Math.floor(offset / pageSize) + 1 : null,
          pageSize, offset, total, count: list.items.length,
          nextCursor: cursorNext, prevCursor: container.prevCursor || container.prev_cursor || null,
          hasMore: container.hasMore ?? container.has_more ?? null,
        });
      }
      const links = pagination.buildLinks(ctx.publicPath(), q, meta);
      if (isObj(ctx.body)) {
        if (ctx.body.pagination === undefined) ctx.body.pagination = meta;
        if (ctx.body.meta === undefined || ctx.body.meta === null) ctx.body.meta = {};
        if (isObj(ctx.body.meta) && ctx.body.meta.pagination === undefined) ctx.body.meta.pagination = meta;
        ctx.body._links = { ...links, ...(isObj(ctx.body._links) ? ctx.body._links : {}) };
      }
      const header = pagination.toLinkHeader(links);
      if (header) ctx.setHeader('Link', header);
      if (meta.total !== null && meta.total !== undefined) ctx.setHeader('X-Total-Count', String(meta.total));
      ctx.state.isList = true;
      ctx.state.list = list;
    },
  });

  registry.register('hateoasLinker', {
    phase: 'response', builtin: true, pure: true,
    description: '_links：所有对象响应带 self；核心资源（pokemon/species/gym/user/trade/raid）附操作链接（REQ-00518）',
    handler(ctx) {
      if (!isObj(ctx.body)) return;
      const self = { href: ctx.publicUrl() };
      const existing = isObj(ctx.body._links) ? ctx.body._links : {};
      if (ctx.status >= 400) {
        const help = ctx.body.error && isObj(ctx.body.error) ? ctx.body.error.docUrl : (ctx.body.errorInfo || {}).docUrl;
        ctx.body._links = { self, ...(help ? { help: { href: help } } : {}), ...existing };
        return;
      }
      const res = ctx.resource();
      const links = { self };
      if (res) {
        const isMe = /\/users\/me$/.test(ctx.path);
        const data = dataOf(ctx.body).value;
        if (res.kind === 'item' && isObj(data)) {
          Object.assign(links, linksBuilder.forResource(res.type, data, { pathId: res.pathId, isMe }));
          links.self = self;
        } else if (res.kind === 'collection') {
          Object.assign(links, linksBuilder.forCollection(res.type, self.href));
          const list = ctx.state.list || pagination.detectList(ctx.body);
          if (list && Array.isArray(list.items)) {
            for (const item of list.items) {
              if (isObj(item) && item._links === undefined) {
                const il = linksBuilder.forResource(res.type, item, {});
                if (Object.keys(il).length) item._links = il;
              }
            }
          }
        }
        if (deps.config.discoverLink !== false) links.discover = { href: '/api/discover' };
      }
      // 复合响应的内嵌集合逐项加操作链接（如附近野生精灵的 catch、补给站的 spin）
      const embeds = linksBuilder.registry.embedsFor ? linksBuilder.registry.embedsFor(ctx.path) : null;
      if (embeds) {
        const data = dataOf(ctx.body).value;
        if (isObj(data)) {
          for (const [key, type] of Object.entries(embeds)) {
            if (!Array.isArray(data[key])) continue;
            for (const item of data[key]) {
              if (!isObj(item) || item._links !== undefined) continue;
              const il = linksBuilder.forResource(type, item, {});
              if (Object.keys(il).length) item._links = il;
            }
          }
        }
        links.discover = { href: '/api/discover' };
      }
      ctx.body._links = { ...links, ...existing, self };
    },
  });

  registry.register('schemaValidator', {
    phase: 'response', builtin: true, pure: true,
    description: '响应契约校验：开发/测试强制（违规返回 500），生产按采样率记录告警（REQ-00315/547）',
    handler(ctx) {
      const cfg = deps.config.schemaValidation;
      if (!cfg || cfg.mode === 'off') return;
      const contract = deps.schemas.match(ctx.req.method, ctx.path, ctx.status);
      if (!contract) return;
      // 下游已按 ?fields= 只查询了部分列（X-DB-Projection），响应本就是部分表示，不做完整契约校验
      if (ctx.projection && ctx.res && typeof ctx.res.getHeader === 'function' && ctx.res.getHeader('x-db-projection')) {
        ctx.setHeader('X-Schema-Validation', `skipped; contract=${contract.id}; reason=db-projection`);
        return;
      }
      if (cfg.mode === 'sample' && !ctx.forceSchemaCheck && Math.random() >= cfg.sampleRate) {
        ctx.setHeader('X-Schema-Validation', `skipped; contract=${contract.id}`);
        return;
      }
      const r = deps.schemas.validate(contract, ctx.body);
      ctx.state.schemaResult = { contract: contract.id, valid: r.valid, durationMs: r.durationMs };
      if (deps.metrics && deps.metrics.schemaChecks) { try { deps.metrics.schemaChecks.inc({ contract: contract.id, result: r.valid ? 'pass' : 'fail' }); } catch { /* ignore */ } }
      if (deps.metrics && deps.metrics.schemaDuration) { try { deps.metrics.schemaDuration.observe({ contract: contract.id }, r.durationMs / 1000); } catch { /* ignore */ } }
      ctx.setHeader('X-Schema-Validation', `${r.valid ? 'pass' : 'fail'}; contract=${contract.id}; dur=${r.durationMs}`);
      if (r.valid) return;
      deps.onSchemaViolation({ contract: contract.id, method: ctx.req.method, path: ctx.path, status: ctx.status, errors: r.errors.slice(0, 20) });
      if (cfg.mode === 'enforce' && ctx.status < 500) {
        const { status, body } = errors.buildErrorBody('RESPONSE_SCHEMA_VIOLATION', {
          message: `响应不符合接口契约 ${contract.id}`,
          details: { contract: contract.id, violations: r.errors.slice(0, 20), originalStatus: ctx.status },
        });
        delete body.meta;
        ctx.status = status;
        ctx.body = body;
      }
    },
  });

  registry.register('fieldProjector', {
    phase: 'response', builtin: true, pure: true,
    description: '字段投影：?fields=a,b.c,items[].x / ?fieldset=list；敏感字段不可选（REQ-00532/251）',
    handler(ctx) {
      if (!ctx.projection || ctx.status >= 400) return;
      const { tree } = ctx.projection;
      const apply = (v) => {
        if (Array.isArray(v)) return v.map(apply);
        if (!isObj(v)) return v;
        const out = projection.project(v, tree);
        if (v._links !== undefined) out._links = v._links;
        return out;
      };
      const d = dataOf(ctx.body);
      const list = pagination.detectList(ctx.body);
      if (list && list.container && list.key && list.container !== ctx.body) {
        list.container[list.key] = apply(list.items);
      } else if (list && list.key === 'data' && isObj(ctx.body)) {
        ctx.body.data = apply(ctx.body.data);
      } else if (d.holder) {
        d.holder[d.key] = apply(d.value);
      } else {
        ctx.body = apply(ctx.body);
      }
      ctx.setHeader('X-Fields-Applied', (ctx.projection.fieldset ? `fieldset=${ctx.projection.fieldset};` : '') + ctx.projection.paths.slice(0, 50).join(','));
    },
  });

  registry.register('halFormatter', {
    phase: 'response', builtin: true, pure: true,
    description: 'Accept: application/hal+json 时输出 HAL（_links/_embedded）',
    handler(ctx) {
      if (!ctx.media || ctx.media.mediaType !== 'application/hal+json' || !isObj(ctx.body)) return;
      const res = ctx.resource();
      ctx.body = HalFormatter.format(ctx.body, { rel: res ? res.type : 'items' });
    },
  });

  registry.register('aliasCompressor', {
    phase: 'response', builtin: true, pure: true,
    description: '字段别名压缩：?_aliases=1 或 X-Field-Aliases: 1 时 data 内长字段名映射为 ≤3 字符别名（REQ-00251）',
    handler(ctx) {
      if (ctx.status >= 400) return;
      const d = dataOf(ctx.body);
      if (d.holder) {
        const { data, aliases } = projection.compressKeys(d.value);
        d.holder[d.key] = data;
        d.holder._aliases = aliases;
      } else {
        ctx.body = projection.packAliased(ctx.body);
      }
      ctx.setHeader('X-Field-Aliases', '1');
    },
  });

  registry.register('localizer', {
    phase: 'response', builtin: true, pure: true,
    description: '错误消息本地化：按 X-Language / Accept-Language 补 error.localizedMessage',
    handler(ctx) {
      if (ctx.status < 400 || !isObj(ctx.body) || !errorMessages || !ctx.locale) return;
      const e = isObj(ctx.body.error) ? ctx.body.error : ctx.body.errorInfo;
      if (!isObj(e) || !e.name || !errorMessages.ERROR_MESSAGES[e.name]) return;
      const msg = errorMessages.ERROR_MESSAGES[e.name][ctx.locale];
      if (msg && e.localizedMessage === undefined) e.localizedMessage = msg.replace(/[:：]?\s*\{[A-Za-z_]+\}/g, '');
    },
  });

  // ── 响应阶段（易变） ─────────────────────────────────────────
  registry.register('metaInjector', {
    phase: 'response', builtin: true,
    description: 'meta.requestId / timestamp / apiVersion',
    handler(ctx) {
      if (!isObj(ctx.body)) return;
      errors.addMeta(ctx.body, { requestId: ctx.req.headers['x-request-id'], apiVersion: ctx.req.apiVersion });
    },
  });

  registry.register('deprecationAnnotator', {
    phase: 'response', builtin: true,
    description: '弃用端点：Deprecation / Sunset / Link(successor-version) 响应头 + 响应体 deprecation 字段（REQ-00407）',
    handler(ctx) {
      const d = ctx.deprecation;
      if (!d) return;
      for (const [k, v] of Object.entries(deps.deprecations.headers(d))) {
        if (k === 'Link') ctx.appendLink(v); else ctx.setHeader(k, v);
      }
      if (isObj(ctx.body) && ctx.body.deprecation === undefined) ctx.body.deprecation = deps.deprecations.bodyField(d);
    },
  });

  registry.register('retryAdvisor', {
    phase: 'response', builtin: true,
    description: '429/503 响应补 Retry-After，并写入 error.retryAfter（REQ-00402）',
    handler(ctx) {
      if (ctx.status !== 429 && ctx.status !== 503) return;
      let ra = ctx.res.getHeader('Retry-After') || ctx.headers.get('Retry-After');
      if (!ra) {
        const reset = Number(ctx.res.getHeader('RateLimit-Reset') || ctx.res.getHeader('X-RateLimit-Reset'));
        if (reset && reset > 1e9) ra = Math.max(1, Math.ceil(reset - Date.now() / 1000));
        else if (reset) ra = Math.max(1, Math.ceil(reset));
        else ra = ctx.status === 429 ? 60 : 5;
        ctx.setHeader('Retry-After', String(ra));
      }
      if (isObj(ctx.body)) {
        const e = isObj(ctx.body.error) ? ctx.body.error : ctx.body.errorInfo;
        if (isObj(e) && e.retryAfter === undefined && /^\d+$/.test(String(ra))) e.retryAfter = Number(ra);
      }
    },
  });

  registry.register('compressor', {
    phase: 'response', builtin: true,
    description: '启用网关流式压缩（Brotli 优先，REQ-00526）；未包含该阶段的管道不压缩',
    handler(ctx) {
      ctx.res.locals.compress = true;
    },
  });

  registry.register('serializer', {
    phase: 'response', builtin: true,
    description: '序列化：JSON（charset=utf-8）/ MessagePack，设置 Content-Type 与 Vary: Accept（REQ-00368/554）',
    handler(ctx) {
      const media = ctx.media || mediaTypes.negotiate(undefined, deps.mediaRegistry);
      const useMedia = ctx.status === 406 ? mediaTypes.negotiate(undefined, deps.mediaRegistry) : media;
      ctx.output = useMedia.entry.serializer.serialize(ctx.body);
      ctx.setHeader('Content-Type', useMedia.contentType);
      if (deps.metrics && deps.metrics.serialized && useMedia.entry.serializer.name !== 'json') {
        try { deps.metrics.serialized.inc({ format: useMedia.entry.serializer.name }); } catch { /* ignore */ }
      }
    },
  });
}

/** 预置管道（可被 config/pipelines/*.yaml 覆盖） */
const DEFAULT_PIPELINES = {
  pipelines: {
    default: {
      description: '所有 API 路由的默认管道',
      metadata: { route: '*', method: '*' },
      cacheEnabled: true,
      cacheTTL: 60,
      stages: [
        { transformer: 'contentNegotiator' }, { transformer: 'contentTypeValidator' }, { transformer: 'deprecationGate' },
        { transformer: 'paramNormalizer' }, { transformer: 'fieldValidator', condition: 'hasFieldQuery' }, { transformer: 'languageDetector' },
        { transformer: 'errorNormalizer', condition: 'isError' }, { transformer: 'successNormalizer', condition: 'isSuccess' },
        { transformer: 'versionTransformer' }, { transformer: 'paginationNormalizer', condition: 'isSuccess' },
        { transformer: 'hateoasLinker' }, { transformer: 'schemaValidator', condition: 'hasSchema' },
        { transformer: 'fieldProjector', condition: 'hasFieldQuery' }, { transformer: 'halFormatter', condition: 'wantsHal' },
        { transformer: 'aliasCompressor', condition: 'wantsAliases' }, { transformer: 'localizer', condition: 'isError' },
        { transformer: 'metaInjector' }, { transformer: 'deprecationAnnotator', condition: 'hasDeprecation' },
        { transformer: 'retryAdvisor', condition: 'isError' }, { transformer: 'compressor' }, { transformer: 'serializer' },
      ],
    },
  },
};

module.exports = { registerBuiltins, DEFAULT_PIPELINES, allowedFieldsFromContract, HaltError, dataOf };
