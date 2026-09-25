/**
 * REQ-00542: 请求/响应转换器管道引擎
 *
 * - TransformerRegistry：内置转换器 + 声明式转换器（rename/remove/add 字段、设置响应头），
 *   不接受任意代码，管理接口注册的转换器只能是声明式的
 * - PipelineEngine：
 *     · define/remove/list/get，配置 DSL（YAML/JSON：pipelines.<name>.{ metadata.route/method, stages[], streaming, cacheEnabled }）
 *     · select(req)：按 method + 路由模式选择最具体的管道，找不到用 default
 *     · runRequest / runResponse：逐阶段执行，阶段条件（condition）、耗时追踪、错误隔离（单个阶段出错只记录，不影响请求）
 *     · 两级执行：纯阶段（pure=true，结果只取决于上游响应体 + 请求变体参数）→ 结果缓存（LRU + TTL）；
 *       易变阶段（meta 时间戳、弃用剩余天数、序列化）每次执行
 * - 指标：阶段耗时直方图、执行次数、缓存命中、流式透传次数、错误数；getStats() 供管理接口
 */
'use strict';

const crypto = require('crypto');

function routeRegex(route) {
  if (!route || route === '*') return /.*/;
  const esc = String(route).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const re = esc.replace(/\/:[A-Za-z0-9_]+/g, '/[^/]+').replace(/\\\*/g, '*').replace(/\*/g, '.*');
  return new RegExp(`^${re}/?$`);
}

function specificity(route) {
  if (!route || route === '*') return 0;
  return String(route).replace(/:[A-Za-z0-9_]+|\*/g, '').length + (route.includes('*') ? 0 : 1000);
}

class LRUCache {
  constructor({ max = 1000, ttlMs = 60000, maxEntryBytes = 256 * 1024 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.maxEntryBytes = maxEntryBytes;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) { this.map.delete(key); return undefined; }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }
  set(key, value, { ttlMs = this.ttlMs, size = 0 } = {}) {
    if (size > this.maxEntryBytes) return false;
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return true;
  }
  clear(prefix) {
    if (!prefix) { const n = this.map.size; this.map.clear(); return n; }
    let n = 0;
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) { this.map.delete(k); n++; }
    return n;
  }
  get size() { return this.map.size; }
}

// ── 转换器注册表 ─────────────────────────────────────────────
const DECLARATIVE_TYPES = {
  renameFields: (config) => (ctx) => {
    const target = ctx.body && typeof ctx.body === 'object' && ctx.body.data && typeof ctx.body.data === 'object' ? 'data' : null;
    const apply = (o) => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return;
      for (const [from, to] of Object.entries(config.map || {})) if (o[from] !== undefined && o[to] === undefined) { o[to] = o[from]; if (!config.keepOriginal) delete o[from]; }
    };
    const t = target ? ctx.body.data : ctx.body;
    if (Array.isArray(t)) t.forEach(apply); else apply(t);
  },
  removeFields: (config) => (ctx) => {
    const apply = (o) => { if (o && typeof o === 'object' && !Array.isArray(o)) for (const f of config.fields || []) delete o[f]; };
    const t = ctx.body && ctx.body.data && typeof ctx.body.data === 'object' ? ctx.body.data : ctx.body;
    if (Array.isArray(t)) t.forEach(apply); else apply(t);
  },
  addFields: (config) => (ctx) => {
    if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) return;
    for (const [k, v] of Object.entries(config.fields || {})) if (ctx.body[k] === undefined) ctx.body[k] = v;
  },
  setHeader: (config) => (ctx) => {
    for (const [k, v] of Object.entries(config.headers || {})) {
      if (/^(set-cookie|authorization|content-length|content-encoding|transfer-encoding)$/i.test(k)) continue;
      ctx.setHeader(k, String(v));
    }
  },
};

class TransformerRegistry {
  constructor() {
    this.transformers = new Map();
  }
  /**
   * @param {string} name
   * @param {object} def { phase, priority, description, pure, handler(ctx), builtin, declarative }
   */
  register(name, def) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(name)) throw new Error(`invalid transformer name: ${name}`);
    if (!['request', 'response'].includes(def.phase)) throw new Error('phase must be request|response');
    if (typeof def.handler !== 'function') throw new Error('handler must be a function');
    this.transformers.set(name, { name, phase: def.phase, priority: def.priority || 0, description: def.description || '', pure: !!def.pure, handler: def.handler, builtin: !!def.builtin, declarative: def.declarative || null });
    return this.transformers.get(name);
  }
  registerDeclarative(name, { type, config = {}, description = '' }) {
    const factory = DECLARATIVE_TYPES[type];
    if (!factory) throw Object.assign(new Error(`不支持的声明式转换器类型 ${type}，可选：${Object.keys(DECLARATIVE_TYPES).join(', ')}`), { status: 400 });
    const existing = this.transformers.get(name);
    if (existing && existing.builtin) throw Object.assign(new Error(`不能覆盖内置转换器 ${name}`), { status: 409 });
    return this.register(name, { phase: 'response', pure: type !== 'setHeader', description: description || `${type}`, handler: factory(config), declarative: { type, config } });
  }
  unregister(name) {
    const t = this.transformers.get(name);
    if (!t) return false;
    if (t.builtin) throw Object.assign(new Error(`不能删除内置转换器 ${name}`), { status: 409 });
    return this.transformers.delete(name);
  }
  get(name) { return this.transformers.get(name) || null; }
  list() {
    return [...this.transformers.values()].map((t) => ({ name: t.name, phase: t.phase, priority: t.priority, description: t.description, pure: t.pure, builtin: t.builtin, declarative: t.declarative }));
  }
}

// ── 管道引擎 ─────────────────────────────────────────────────
class PipelineEngine {
  constructor({ registry = new TransformerRegistry(), logger = null, metrics = null, conditions = {}, cache = null } = {}) {
    this.registry = registry;
    this.logger = logger;
    this.metrics = metrics;
    this.conditions = { always: () => true, ...conditions };
    this.pipelines = new Map();
    this.cache = cache || new LRUCache();
    this.stats = new Map();
  }

  define(name, cfg) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw Object.assign(new Error(`无效的管道名 ${name}`), { status: 400 });
    const meta = cfg.metadata || cfg.match || {};
    const stages = (cfg.stages || []).map((s, i) => {
      const t = this.registry.get(s.transformer);
      if (!t) throw Object.assign(new Error(`管道 ${name} 第 ${i + 1} 阶段引用了不存在的转换器 ${s.transformer}`), { status: 400 });
      const phase = s.phase || t.phase;
      if (phase !== t.phase) throw Object.assign(new Error(`转换器 ${s.transformer} 只能用于 ${t.phase} 阶段`), { status: 400 });
      if (s.condition && !this.conditions[s.condition]) throw Object.assign(new Error(`未知条件 ${s.condition}，可选：${Object.keys(this.conditions).join(', ')}`), { status: 400 });
      return { transformer: s.transformer, phase, condition: s.condition || null, cacheable: s.cacheable !== false, cacheTTL: s.cacheTTL || null, options: s.options || {} };
    });
    const p = {
      name,
      description: cfg.description || '',
      route: meta.route || '*',
      method: String(meta.method || '*').toUpperCase(),
      re: routeRegex(meta.route || '*'),
      specificity: specificity(meta.route || '*'),
      streaming: !!cfg.streaming,
      cacheEnabled: cfg.cacheEnabled !== false,
      cacheTTL: cfg.cacheTTL || 60,
      stages,
      builtin: !!cfg.builtin,
      version: (this.pipelines.get(name) ? this.pipelines.get(name).version : 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this.pipelines.set(name, p);
    this.cache.clear(`${name}:`);
    return this.describe(p);
  }

  remove(name) {
    const p = this.pipelines.get(name);
    if (!p) return false;
    if (name === 'default') throw Object.assign(new Error('不能删除 default 管道'), { status: 409 });
    this.cache.clear(`${name}:`);
    return this.pipelines.delete(name);
  }

  get(name) { return this.pipelines.get(name) || null; }

  describe(p) {
    return { name: p.name, description: p.description, route: p.route, method: p.method, streaming: p.streaming, cacheEnabled: p.cacheEnabled, cacheTTL: p.cacheTTL, stages: p.stages.map((s) => ({ ...s })), builtin: p.builtin, version: p.version, updatedAt: p.updatedAt };
  }

  list() { return [...this.pipelines.values()].map((p) => this.describe(p)); }

  /** 加载配置 DSL（对象或 YAML/JSON 文本） */
  loadConfig(raw, { builtin = false } = {}) {
    let cfg = raw;
    if (typeof raw === 'string') {
      try { cfg = JSON.parse(raw); } catch {
        const YAML = require('yamljs');
        cfg = YAML.parse(raw);
      }
    }
    const names = [];
    for (const [name, p] of Object.entries((cfg && cfg.pipelines) || {})) {
      this.define(name, { ...p, builtin: p.builtin ?? builtin });
      names.push(name);
    }
    return names;
  }

  select(req) {
    const m = req.method.toUpperCase();
    let best = null;
    for (const p of this.pipelines.values()) {
      if (p.name === 'default') continue;
      if (p.method !== '*' && p.method !== m && !(m === 'HEAD' && p.method === 'GET')) continue;
      if (!p.re.test(req.path)) continue;
      if (!best || p.specificity > best.specificity) best = p;
    }
    return best || this.pipelines.get('default') || null;
  }

  _stat(name) {
    let s = this.stats.get(name);
    if (!s) {
      s = { executions: 0, errors: 0, cacheHits: 0, cacheMisses: 0, streamingCount: 0, halted: 0, samples: [], stageTotals: {} };
      this.stats.set(name, s);
    }
    return s;
  }

  _observe(pipeline, phase, trace, total) {
    const s = this._stat(pipeline.name);
    s.executions++;
    s.samples.push({ t: Date.now(), ms: total, phase });
    if (s.samples.length > 2000) s.samples.splice(0, s.samples.length - 2000);
    for (const st of trace) {
      const agg = s.stageTotals[st.stage] || { count: 0, totalMs: 0, errors: 0 };
      agg.count++;
      agg.totalMs += st.ms;
      if (st.error) agg.errors++;
      s.stageTotals[st.stage] = agg;
      if (this.metrics && this.metrics.stageDuration) { try { this.metrics.stageDuration.observe({ pipeline: pipeline.name, stage: st.stage, phase }, st.ms / 1000); } catch { /* ignore */ } }
    }
    if (this.metrics && this.metrics.executions) { try { this.metrics.executions.inc({ pipeline: pipeline.name, phase }); } catch { /* ignore */ } }
  }

  async _runStage(stage, ctx, trace) {
    const t = this.registry.get(stage.transformer);
    if (!t) return;
    if (stage.condition) {
      let ok = false;
      try { ok = this.conditions[stage.condition](ctx); } catch { ok = false; }
      if (!ok) return;
    }
    const t0 = process.hrtime.bigint();
    try {
      ctx.stageOptions = stage.options;
      await t.handler(ctx);
      trace.push({ stage: stage.transformer, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
    } catch (err) {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      trace.push({ stage: stage.transformer, ms, error: err.message });
      if (err.halt) throw err; // 请求阶段主动中断（已发出错误响应）
      this._stat(ctx.pipeline.name).errors++;
      if (this.metrics && this.metrics.errors) { try { this.metrics.errors.inc({ pipeline: ctx.pipeline.name, stage: stage.transformer }); } catch { /* ignore */ } }
      if (this.logger) this.logger.warn({ err: err.message, pipeline: ctx.pipeline.name, stage: stage.transformer, path: ctx.req && ctx.req.path }, 'pipeline stage failed, skipped');
    }
  }

  /** 执行请求阶段；返回 { halted, trace } */
  async runRequest(pipeline, ctx) {
    const trace = [];
    const t0 = process.hrtime.bigint();
    let halted = false;
    try {
      for (const stage of pipeline.stages.filter((s) => s.phase === 'request')) {
        await this._runStage(stage, ctx, trace);
        if (ctx.halted) { halted = true; break; }
      }
    } catch (err) {
      if (!err.halt) throw err;
      halted = true;
    }
    const total = Number(process.hrtime.bigint() - t0) / 1e6;
    this._observe(pipeline, 'request', trace, total);
    if (halted) this._stat(pipeline.name).halted++;
    return { halted, trace, totalMs: total };
  }

  /**
   * 执行响应阶段：纯阶段结果可缓存（key = 管道 + 上游响应体哈希 + 状态码 + 变体）
   * ctx.rawHash / ctx.variantKey 由调用方提供；ctx.body 为已解析的响应体
   */
  async runResponse(pipeline, ctx) {
    const trace = [];
    const t0 = process.hrtime.bigint();
    const stages = pipeline.stages.filter((s) => s.phase === 'response');
    const pureStages = [];
    const volatileStages = [];
    let seenVolatile = false;
    for (const s of stages) {
      const t = this.registry.get(s.transformer);
      if (!seenVolatile && t && t.pure && s.cacheable) pureStages.push(s);
      else { seenVolatile = true; volatileStages.push(s); }
    }
    let cached = false;
    const canCache = pipeline.cacheEnabled && ctx.rawHash && pureStages.length;
    const key = canCache ? `${pipeline.name}:v${pipeline.version}:${ctx.status}:${ctx.rawHash}:${ctx.variantKey || ''}` : null;
    const s = this._stat(pipeline.name);
    if (key) {
      const hit = this.cache.get(key);
      if (hit) {
        ctx.body = JSON.parse(hit.body);
        ctx.status = hit.status;
        for (const [k, v] of hit.headers) ctx.setHeader(k, v);
        Object.assign(ctx.state, hit.state || {});
        cached = true;
        s.cacheHits++;
        if (this.metrics && this.metrics.cache) { try { this.metrics.cache.inc({ pipeline: pipeline.name, result: 'hit' }); } catch { /* ignore */ } }
      }
    }
    if (!cached) {
      for (const st of pureStages) await this._runStage(st, ctx, trace);
      if (key) {
        s.cacheMisses++;
        if (this.metrics && this.metrics.cache) { try { this.metrics.cache.inc({ pipeline: pipeline.name, result: 'miss' }); } catch { /* ignore */ } }
        const bodyStr = JSON.stringify(ctx.body);
        const ttl = Math.min(...pureStages.map((x) => x.cacheTTL || pipeline.cacheTTL)) * 1000;
        this.cache.set(key, { body: bodyStr, status: ctx.status, headers: [...ctx.headers.entries()], state: { schemaResult: ctx.state.schemaResult } }, { ttlMs: ttl, size: bodyStr.length });
      }
    }
    for (const st of volatileStages) await this._runStage(st, ctx, trace);
    const total = Number(process.hrtime.bigint() - t0) / 1e6;
    this._observe(pipeline, 'response', trace, total);
    return { trace, cached, totalMs: total };
  }

  recordStreaming(pipeline) {
    this._stat(pipeline.name).streamingCount++;
    if (this.metrics && this.metrics.streaming) { try { this.metrics.streaming.inc({ pipeline: pipeline.name }); } catch { /* ignore */ } }
  }

  getStats(name, { periodMs = 3600000 } = {}) {
    const s = this.stats.get(name) || this._stat(name);
    const since = Date.now() - periodMs;
    const samples = s.samples.filter((x) => x.t >= since).map((x) => x.ms).sort((a, b) => a - b);
    const pct = (p) => (samples.length ? +samples[Math.min(samples.length - 1, Math.ceil(p / 100 * samples.length) - 1)].toFixed(3) : null);
    const lookups = s.cacheHits + s.cacheMisses;
    return {
      pipeline: name,
      executions: s.executions,
      periodExecutions: samples.length,
      avgMs: samples.length ? +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(3) : null,
      p50Ms: pct(50), p95Ms: pct(95), p99Ms: pct(99),
      cacheHits: s.cacheHits, cacheMisses: s.cacheMisses, cacheHitRate: lookups ? +(s.cacheHits / lookups).toFixed(4) : null,
      streamingCount: s.streamingCount,
      errors: s.errors,
      errorRate: s.executions ? +(s.errors / s.executions).toFixed(4) : 0,
      halted: s.halted,
      stages: Object.fromEntries(Object.entries(s.stageTotals).map(([k, v]) => [k, { count: v.count, avgMs: +(v.totalMs / v.count).toFixed(4), errors: v.errors }])),
    };
  }

  clearCache(name) { return this.cache.clear(name ? `${name}:` : undefined); }
}

function hashBuffer(buf) {
  return crypto.createHash('sha1').update(buf).digest('base64url');
}

module.exports = { PipelineEngine, TransformerRegistry, LRUCache, routeRegex, hashBuffer, DECLARATIVE_TYPES };
