/**
 * API 设计规范（Epic E25）运行时装配：把各模块组装成网关可用的转换管道
 *
 *   const std = createApiStandards({ query, redis, logger, versions });
 *   app.use(std.middleware());        // 放在压缩中间件之后、业务路由之前
 *   await std.start();                // 从数据库加载弃用/版本/转换规则/字段集/管道，启动定时刷新
 *
 * 中间件行为：
 *   1. 仅作用于 API 路径（/v1/*、/vN/*、/api/*、/admin/*）；API_STANDARDS_ENABLED=false 时整体旁路
 *   2. 请求阶段：内容协商 / Content-Type / 弃用下线 / 分页与字段参数（可能直接返回 4xx）
 *   3. 拦截 res.writeHead/write/end：JSON 响应缓冲后跑响应阶段（大于 maxBufferBytes 或流式类型自动透传），
 *      其它类型原样透传；任何阶段异常都回退为原始响应（fail-open）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const promClient = require('prom-client');

const mediaTypes = require('./mediaTypes');
const projection = require('./fieldProjection');
const pagination = require('./pagination');
const errorCatalog = require('./errorCatalog');
const hateoas = require('./hateoas');
const versioning = require('./versioning');
const { SchemaRegistry } = require('./schemaRegistry');
const { PipelineEngine, TransformerRegistry, hashBuffer } = require('./pipeline');
const { registerBuiltins, DEFAULT_PIPELINES } = require('./transformers');

const PIPELINE_DIR = path.join(__dirname, '..', '..', '..', 'config', 'pipelines');
const API_PATH_RE = /^\/(?:v\d+|api|admin)(?:\/|$)/;

function metricsRegistry() {
  try { return require('../metrics').register; } catch { return promClient.register; }
}

function metric(Type, cfg) {
  const reg = metricsRegistry();
  return reg.getSingleMetric(cfg.name) || new Type({ ...cfg, registers: [reg] });
}

function createMetrics() {
  return {
    stageDuration: metric(promClient.Histogram, { name: 'api_pipeline_stage_duration_seconds', help: 'Gateway transform pipeline stage duration', labelNames: ['pipeline', 'stage', 'phase'], buckets: [0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1] }),
    executions: metric(promClient.Counter, { name: 'api_pipeline_executions_total', help: 'Pipeline executions', labelNames: ['pipeline', 'phase'] }),
    cache: metric(promClient.Counter, { name: 'api_pipeline_cache_total', help: 'Pipeline transform cache lookups', labelNames: ['pipeline', 'result'] }),
    streaming: metric(promClient.Counter, { name: 'api_pipeline_streaming_total', help: 'Responses streamed without buffering', labelNames: ['pipeline'] }),
    errors: metric(promClient.Counter, { name: 'api_pipeline_errors_total', help: 'Pipeline stage errors (skipped)', labelNames: ['pipeline', 'stage'] }),
    schemaChecks: metric(promClient.Counter, { name: 'api_schema_validation_total', help: 'Response schema validations', labelNames: ['contract', 'result'] }),
    schemaDuration: metric(promClient.Histogram, { name: 'api_schema_validation_duration_seconds', help: 'Response schema validation duration', labelNames: ['contract'], buckets: [0.0001, 0.0005, 0.001, 0.002, 0.005, 0.01] }),
    projection: metric(promClient.Counter, { name: 'api_field_projection_total', help: 'Field projection usage', labelNames: ['resource', 'mode'] }),
    serialized: metric(promClient.Counter, { name: 'api_serialization_total', help: 'Non-JSON serializations', labelNames: ['format'] }),
    deprecatedCalls: metric(promClient.Counter, { name: 'api_deprecated_calls_total', help: 'Calls to deprecated APIs', labelNames: ['endpoint', 'method', 'client_id', 'client_version'] }),
    deprecatedByClient: metric(promClient.Histogram, { name: 'api_deprecated_calls_by_client', help: 'Deprecated API calls per client per flush window', labelNames: ['endpoint', 'client_id'], buckets: [1, 10, 100, 1000, 10000] }),
  };
}

/** 字段使用统计（field_usage_stats） */
class FieldUsageRecorder {
  constructor(query) { this.query = query; this.pending = new Map(); }
  record(resource, paths) {
    for (const p of paths || []) {
      const k = `${resource}|${p.slice(0, 100)}`;
      this.pending.set(k, (this.pending.get(k) || 0) + 1);
    }
  }
  async flush() {
    if (!this.query || !this.pending.size) return;
    const items = [...this.pending.entries()];
    this.pending.clear();
    for (const [k, n] of items) {
      const [resource, field] = k.split('|');
      await this.query(
        `INSERT INTO field_usage_stats (resource_type, field_name, request_count, last_requested_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (resource_type, field_name) DO UPDATE SET request_count = field_usage_stats.request_count + EXCLUDED.request_count, last_requested_at = NOW()`,
        [resource, field, n]).catch(() => {});
    }
  }
}

function defaultConfig(env = process.env) {
  const prod = (env.NODE_ENV || 'development') === 'production';
  const mode = env.API_SCHEMA_VALIDATION || (prod ? 'sample' : 'enforce');
  return {
    enabled: env.API_STANDARDS_ENABLED !== 'false',
    schemaValidation: { mode, sampleRate: Number(env.API_SCHEMA_SAMPLE_RATE || (prod ? 0.1 : 1)) },
    maxBufferBytes: Number(env.API_PIPELINE_MAX_BUFFER || 2 * 1024 * 1024),
    maxFields: Number(env.API_MAX_FIELDS || projection.MAX_FIELDS_DEFAULT),
    cursorSecret: env.PAGINATION_CURSOR_SECRET || env.JWT_ACCESS_SECRET || null,
    contentTypeExemptPaths: ['/v1/payment/webhook', '/api/v1/security/csp-report', '/api/v1/security/report'],
    refreshIntervalMs: Number(env.API_STANDARDS_REFRESH_MS || 30000),
  };
}

/** 内置版本兼容规则：v1 用户资料不含 stats / achievements（REQ-00044 changelog） */
const BUILTIN_TRANSFORMS = [
  { id: 'v1-user-profile-legacy', version: 1, method: 'GET', path: '/api/v1/users/:id/profile', description: 'v1 资料不含 v2 新增的 stats / achievements 字段', response: [{ op: 'remove', path: 'stats' }, { op: 'remove', path: 'achievements' }], builtin: true },
];

function createApiStandards({ query = null, redis = null, logger = null, versions = {}, currentVersion = null, versionRegistry: injectedVersions = null, config: cfgOverride = {}, verifyToken = null } = {}) {
  const config = { ...defaultConfig(), ...cfgOverride };
  const metrics = createMetrics();
  const log = logger || { info() {}, warn() {}, error() {}, debug() {} };

  const mediaRegistry = mediaTypes.createDefaultRegistry();
  const fieldsets = projection.createDefaultFieldsets();
  const linkRegistry = hateoas.createDefaultRegistry();
  const discoverer = new hateoas.ResourceDiscoverer(linkRegistry, {
    apiVersion: '2.0.0',
    extraLinks: {
      version: { href: '/api/version', title: 'API 版本' },
      errors: { href: '/api/errors', title: '错误码目录' },
      deprecations: { href: '/api/deprecations', title: '弃用接口' },
      batch: { href: '/api/v1/batch', title: '批量请求', method: 'POST' },
      mediaTypes: { href: '/api/media-types', title: '支持的媒体类型' },
      documentation: { href: '/api-docs', title: 'OpenAPI 文档' },
    },
  });
  const versionRegistry = injectedVersions || new versioning.VersionRegistry({ versions, currentVersion, query, logger: log });
  const transforms = new versioning.TransformEngine(BUILTIN_TRANSFORMS);
  transforms.version = 1;
  const deprecations = new versioning.DeprecationRegistry({ query, logger: log, metrics: { calls: metrics.deprecatedCalls, byClient: metrics.deprecatedByClient } });
  const schemas = new SchemaRegistry({ query, logger: log }).loadFromDir();
  const fieldUsage = new FieldUsageRecorder(query);
  const violations = [];

  const transformerRegistry = new TransformerRegistry();
  const engine = new PipelineEngine({
    registry: transformerRegistry,
    logger: log,
    metrics,
    conditions: {
      isError: (ctx) => ctx.status >= 400,
      isSuccess: (ctx) => ctx.status < 400,
      hasFieldQuery: (ctx) => !!ctx.projection,
      hasSchema: (ctx) => !!schemas.match(ctx.req.method, ctx.path, ctx.status),
      wantsHal: (ctx) => !!(ctx.media && ctx.media.mediaType === 'application/hal+json'),
      wantsAliases: (ctx) => ctx.wantsAliases,
      hasDeprecation: (ctx) => !!ctx.deprecation,
      isList: (ctx) => !!pagination.detectList(ctx.body),
    },
  });

  const deps = {
    mediaRegistry, fieldsets, linkRegistry, versionRegistry, transforms, deprecations, schemas, config, logger: log, metrics, fieldUsage,
    onSchemaViolation(v) {
      violations.unshift({ ...v, at: new Date().toISOString() });
      violations.length = Math.min(violations.length, 100);
      log.warn({ schemaViolation: v.contract, path: v.path, status: v.status, errors: v.errors.slice(0, 5) }, `响应契约校验失败：${v.contract}`);
    },
  };
  registerBuiltins(transformerRegistry, deps);
  engine.loadConfig(DEFAULT_PIPELINES, { builtin: true });
  try {
    if (fs.existsSync(PIPELINE_DIR)) {
      for (const f of fs.readdirSync(PIPELINE_DIR).filter((x) => /\.(ya?ml|json)$/.test(x)).sort()) {
        engine.loadConfig(fs.readFileSync(path.join(PIPELINE_DIR, f), 'utf8'), { builtin: true });
      }
    }
  } catch (err) {
    log.error({ err: err.message }, 'failed to load config/pipelines');
  }

  function userIdOf(req) {
    if (req.user && (req.user.sub || req.user.id)) return req.user.sub || req.user.id;
    const h = req.headers.authorization || '';
    if (!verifyToken || !h.startsWith('Bearer ')) return null;
    try { return verifyToken(h.slice(7)).sub || null; } catch { return null; }
  }

  function buildCtx(req, res, pipeline) {
    const ctx = {
      req, res, pipeline,
      phase: 'request',
      status: 200,
      body: undefined,
      headers: new Map(),
      state: {},
      path: req.path, // 路由前的对外路径（代理转发后 req.path 会被改写，响应阶段一律用 ctx.path）
      originalUrl: req.originalUrl || req.url,
      originalQuery: { ...(req.query || {}) },
      projection: null,
      pagination: null,
      media: null,
      deprecation: null,
      locale: null,
    };
    const q = req.query || {};
    ctx.wantsAliases = q._aliases === '1' || q._aliases === 'true' || req.headers['x-field-aliases'] === '1' || /profile="?compact"?/i.test(String(req.headers.accept || ''));
    ctx.setHeader = (k, v) => { if (ctx.phase === 'request') res.setHeader(k, v); else ctx.headers.set(k, v); };
    ctx.appendLink = (v) => {
      if (ctx.phase === 'request') { versioning.appendLinkHeader(res, v); return; }
      const prev = ctx.headers.get('Link');
      ctx.headers.set('Link', prev ? `${prev}, ${v}` : v);
    };
    let resourceMemo;
    ctx.resource = () => (resourceMemo !== undefined ? resourceMemo : (resourceMemo = linkRegistry.resolve(ctx.path)));
    let uidMemo;
    ctx.userId = () => (uidMemo !== undefined ? uidMemo : (uidMemo = userIdOf(req)));
    ctx.publicPath = () => ctx.path;
    ctx.publicUrl = () => ctx.originalUrl;
    ctx.rewriteQuery = (add) => {
      const u = new URL(req.url, 'http://gateway.local');
      for (const [k, v] of Object.entries(add)) u.searchParams.set(k, v);
      req.url = u.pathname + u.search;
      if (req.query && typeof req.query === 'object') Object.assign(req.query, add);
    };
    return ctx;
  }

  function decode(buf, encoding) {
    const e = String(encoding || '').toLowerCase();
    if (e === 'gzip' || e === 'x-gzip') return zlib.gunzipSync(buf);
    if (e === 'br') return zlib.brotliDecompressSync(buf);
    if (e === 'deflate') return zlib.inflateSync(buf);
    return buf;
  }

  function installInterceptor(ctx) {
    const { req, res, pipeline } = ctx;
    const origWrite = res.write;
    const origEnd = res.end;
    const origWriteHead = res.writeHead;
    let mode = null;
    let chunks = [];
    let size = 0;
    let finished = false;
    const start = process.hrtime.bigint();

    const decide = () => {
      if (mode) return mode;
      const ct = String(res.getHeader('content-type') || '');
      const enc = String(res.getHeader('content-encoding') || '').toLowerCase();
      if (req.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304 || (res.statusCode >= 100 && res.statusCode < 200)) mode = 'pass';
      else if (!/\bjson\b|\+json/i.test(ct) || /ndjson|stream\+json|event-stream/i.test(ct)) mode = 'pass';
      // 流式管道只透传成功响应；错误响应仍缓冲并按 default 管道统一格式
      else if ((pipeline.streaming && res.statusCode < 400) || res.getHeader('X-Stream') === '1') { mode = 'pass'; engine.recordStreaming(pipeline); }
      else if (enc && !['identity', 'gzip', 'x-gzip', 'br', 'deflate'].includes(enc)) mode = 'pass';
      else mode = 'buffer';
      if (mode === 'pass') {
        res.writeHead = origWriteHead; // 透传：恢复原始 writeHead（Node 隐式发头时会调用 res.writeHead）
        res.setHeader('X-Pipeline', `${pipeline.name}; passthrough`);
      }
      return mode;
    };

    const switchToPass = () => {
      mode = 'pass';
      res.writeHead = origWriteHead;
      res.setHeader('X-Pipeline', `${pipeline.name}; passthrough=size`);
      engine.recordStreaming(pipeline);
      const pending = chunks;
      chunks = [];
      for (const c of pending) origWrite.call(res, c);
    };

    res.writeHead = function writeHead(status, reason, headers) {
      if (typeof reason === 'object' && reason !== null) { headers = reason; reason = undefined; }
      if (headers) {
        if (Array.isArray(headers)) { for (let i = 0; i + 1 < headers.length; i += 2) res.setHeader(headers[i], headers[i + 1]); }
        else for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      }
      res.statusCode = status;
      if (typeof reason === 'string') res.statusMessage = reason;
      if (decide() === 'pass') return typeof reason === 'string' ? origWriteHead.call(res, status, reason) : origWriteHead.call(res, status);
      return res; // 缓冲模式：响应头在 end 时统一发出
    };

    res.write = function write(chunk, encoding, cb) {
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      if (decide() === 'pass') return origWrite.call(res, chunk, encoding, cb);
      if (chunk !== undefined && chunk !== null) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
        chunks.push(b);
        size += b.length;
        if (size > config.maxBufferBytes) { switchToPass(); if (cb) process.nextTick(cb); return true; }
      }
      if (cb) process.nextTick(cb);
      return true;
    };

    res.end = function end(chunk, encoding, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; encoding = undefined; }
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      if (finished) return res;
      if (decide() === 'pass') { finished = true; return origEnd.call(res, chunk, encoding, cb); }
      finished = true;
      if (chunk !== undefined && chunk !== null) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
        chunks.push(b);
        size += b.length;
      }
      if (size > config.maxBufferBytes) { // 大响应：不做转换，原样发出（REQ-00542 大响应透传）
        switchToPass();
        return origEnd.call(res, undefined, undefined, cb);
      }
      const raw = Buffer.concat(chunks);
      chunks = [];
      finalize(raw).then(
        (out) => { res.writeHead = origWriteHead; origEnd.call(res, out, undefined, cb); },
        (err) => {
          log.warn({ err: err.message, path: req.path, pipeline: pipeline.name }, 'response pipeline failed, sending original body');
          res.writeHead = origWriteHead;
          if (!res.headersSent) res.setHeader('Content-Length', raw.length);
          origEnd.call(res, raw, undefined, cb);
        },
      );
      return res;
    };

    async function finalize(raw) {
      let plain = raw;
      const enc = res.getHeader('content-encoding');
      if (enc && String(enc).toLowerCase() !== 'identity') {
        plain = decode(raw, enc);
        res.removeHeader('Content-Encoding');
      }
      let body;
      try { body = plain.length ? JSON.parse(plain.toString('utf8')) : undefined; } catch { body = undefined; }
      if (body === undefined) { res.setHeader('Content-Length', plain.length); return plain; }
      ctx.phase = 'response';
      ctx.status = res.statusCode;
      ctx.body = projection.stripSensitive(body, true);
      ctx.rawHash = hashBuffer(plain);
      ctx.variantKey = [req.method, ctx.originalUrl, req.apiVersion || '', ctx.locale || '', ctx.media ? ctx.media.mediaType : '', ctx.wantsAliases ? 'a' : '', config.schemaValidation.mode, transforms.version].join('|');
      const respPipeline = pipeline.streaming ? (engine.get('default') || pipeline) : pipeline;
      const r = await engine.runResponse(respPipeline, ctx);
      res.statusCode = ctx.status;
      for (const [k, v] of ctx.headers) {
        if (k === 'Link') versioning.appendLinkHeader(res, v);
        else res.setHeader(k, v);
      }
      const out = ctx.output || Buffer.from(JSON.stringify(ctx.body), 'utf8');
      res.removeHeader('ETag');
      res.setHeader('Content-Length', out.length);
      const vary = String(res.getHeader('Vary') || '');
      if (!/\baccept\b/i.test(vary)) res.setHeader('Vary', vary ? `${vary}, Accept` : 'Accept');
      const total = Number(process.hrtime.bigint() - start) / 1e6;
      res.setHeader('X-Pipeline', `${respPipeline.name}${r.cached ? '; cached' : ''}`);
      res.setHeader('X-Pipeline-Time', r.totalMs.toFixed(3));
      res.setHeader('X-Pipeline-Cached', r.cached ? 'true' : 'false');
      const st = res.getHeader('Server-Timing');
      res.setHeader('Server-Timing', `${st ? `${st}, ` : ''}pipeline;dur=${r.totalMs.toFixed(3)}, upstream;dur=${(total - r.totalMs).toFixed(1)}`);
      return out;
    }
  }

  function middleware() {
    return async function apiStandardsMiddleware(req, res, next) {
      if (!config.enabled || !API_PATH_RE.test(req.path)) return next();
      const pipeline = engine.select(req);
      if (!pipeline) return next();
      const ctx = buildCtx(req, res, pipeline);
      req.apiCtx = ctx;
      res.locals = res.locals || {};
      res.locals.compress = pipeline.stages.some((s) => s.transformer === 'compressor');
      installInterceptor(ctx);
      try {
        const r = await engine.runRequest(pipeline, ctx);
        if (r.halted) return undefined;
      } catch (err) {
        log.warn({ err: err.message, path: req.path }, 'request pipeline failed, continuing');
      }
      ctx.phase = 'request';
      return next();
    };
  }

  // ── 数据库状态加载与刷新 ─────────────────────────────────────
  async function loadTransforms() {
    if (!query) return;
    try {
      const { rows } = await query('SELECT * FROM api_version_transforms WHERE enabled = true ORDER BY id');
      const keep = transforms.rules.filter((r) => r.builtin);
      transforms.rules = [];
      for (const r of keep) transforms.add(r);
      for (const row of rows) transforms.add({ id: row.id, version: row.version, method: row.method, path: row.path, description: row.description, request: row.request_ops || [], response: row.response_ops || [] });
      transforms.version++;
    } catch (err) { log.debug({ err: err.message }, 'load api_version_transforms failed'); }
  }

  async function loadFieldsets() {
    if (!query) return;
    try {
      const { rows } = await query('SELECT resource_type, fieldset_name, fields, description, is_default FROM fieldset_configs');
      for (const r of rows) fieldsets.register(r.resource_type, r.fieldset_name, Array.isArray(r.fields) ? r.fields : null, { description: r.description, isDefault: r.is_default });
    } catch (err) { log.debug({ err: err.message }, 'load fieldset_configs failed'); }
  }

  async function loadPipelines() {
    if (!query) return;
    try {
      const { rows } = await query('SELECT name, config FROM api_transform_pipelines WHERE enabled = true');
      for (const r of rows) {
        try { engine.define(r.name, { ...r.config, builtin: false }); } catch (err) { log.warn({ err: err.message, pipeline: r.name }, 'invalid stored pipeline skipped'); }
      }
    } catch (err) { log.debug({ err: err.message }, 'load api_transform_pipelines failed'); }
  }

  async function loadTransformers() {
    if (!query) return;
    try {
      const { rows } = await query('SELECT name, type, config, description FROM api_transformers WHERE enabled = true');
      for (const r of rows) {
        try { transformerRegistry.registerDeclarative(r.name, { type: r.type, config: r.config || {}, description: r.description }); } catch (err) { log.warn({ err: err.message }, 'invalid stored transformer skipped'); }
      }
    } catch (err) { log.debug({ err: err.message }, 'load api_transformers failed'); }
  }

  const timers = [];
  async function refresh() {
    await Promise.all([deprecations.load(), versionRegistry.load(), loadTransforms()]);
  }
  async function flush() {
    await Promise.all([deprecations.flush(), versionRegistry.flushUsage(), fieldUsage.flush()]).catch(() => {});
  }

  async function start() {
    await refresh();
    await Promise.all([loadFieldsets(), loadTransformers()]);
    await loadPipelines();
    await schemas.syncVersions().catch(() => {});
    if (config.refreshIntervalMs > 0) {
      const t1 = setInterval(() => { refresh().catch(() => {}); }, config.refreshIntervalMs);
      const t2 = setInterval(() => { flush().catch(() => {}); }, Math.min(config.refreshIntervalMs, 15000));
      for (const t of [t1, t2]) { if (t.unref) t.unref(); timers.push(t); }
    }
    return true;
  }

  function stop() { for (const t of timers) clearInterval(t); }

  return {
    config, metrics, engine, transformerRegistry, mediaRegistry, fieldsets, linkRegistry, discoverer,
    versionRegistry, transforms, deprecations, schemas, fieldUsage, violations,
    middleware, start, stop, refresh, flush, loadTransforms, loadFieldsets, loadPipelines,
    errorCatalog, pagination, projection, hateoas, versioning, mediaTypes,
  };
}

module.exports = { createApiStandards, defaultConfig, API_PATH_RE, BUILTIN_TRANSFORMS };
