/**
 * REQ-00308: 批量请求执行器（与传输层解耦，dispatch 由网关注入：回环调用网关自身，完整复用鉴权/限流/管道）
 *
 * - 校验：最多 maxRequests 个子请求；路径必须是网关 API 路径（/vN/...、/api/vN/...），禁止嵌套批量与路径穿越
 * - 调度：按 priority（high > normal > low）优先出队，maxParallel 并发（parallel=false 时串行）
 * - failFast：首个失败后中止其余（进行中的请求被 abort，未开始的标记 ABORTED）
 * - timeout：整体超时，未完成的子请求记 504
 * - GET 结果缓存（按用户 + 用户缓存版本隔离，用户任意写操作后自动失效），可选 cacheTTL
 * - 幂等 GET 在 502/503/504/网络错误时经 RetryManager 退避重试
 * - summary：total/success/failed/cached/totalDuration/costSaved（节省的往返 + 命中缓存的后端调用）
 */
'use strict';

const PRIORITY = { high: 0, normal: 1, low: 2 };
const ROUND_TRIP_COST_USD = 0.00004;   // 每省掉一次客户端 ↔ 网关往返的估算成本
const BACKEND_CALL_COST_USD = 0.00004; // 每次命中缓存省掉的后端调用估算成本
const PATH_RE = /^\/(?:api\/)?v\d+\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/;

class BatchError extends Error {
  constructor(message, details, name = 'BATCH_LIMIT_EXCEEDED', status = 400) {
    super(message);
    this.name = name;
    this.status = status;
    this.details = details;
  }
}

function costSaved(total, cached) {
  return +(Math.max(0, total - 1) * ROUND_TRIP_COST_USD + cached * BACKEND_CALL_COST_USD).toFixed(8);
}

function expandTemplate(path, params = {}) {
  return String(path).replace(/\{([A-Za-z0-9_]+)\}/g, (_, k) => {
    if (params[k] === undefined || params[k] === null) throw new BatchError(`模板参数缺失：${k}`, { param: k }, 'INVALID_REQUEST');
    return encodeURIComponent(String(params[k]));
  });
}

class BatchExecutor {
  /**
   * @param {object} opts
   *   dispatch(sub, { signal, ctx }) → Promise<{ status, headers, body }>
   *   cache: { get(key) → Promise<string|null>, set(key, value, ttlSeconds) → Promise }
   *   retryManager: RetryManager（可选）
   *   metrics: { requests, subrequests, duration, size, cost }
   *   limits: { maxRequests, maxParallel, maxTimeout, defaultTimeout, maxCacheTTL, defaultCacheTTL }
   */
  constructor({ dispatch, cache = null, retryManager = null, metrics = null, logger = null, limits = {} } = {}) {
    if (typeof dispatch !== 'function') throw new Error('dispatch is required');
    this.dispatch = dispatch;
    this.cache = cache;
    this.retryManager = retryManager;
    this.metrics = metrics;
    this.logger = logger;
    this.limits = { maxRequests: 20, maxParallel: 10, maxTimeout: 30000, defaultTimeout: 10000, maxCacheTTL: 300, defaultCacheTTL: 0, ...limits };
  }

  validate(payload) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.requests)) throw new BatchError('请求体必须包含 requests 数组', null, 'INVALID_REQUEST');
    const reqs = payload.requests;
    if (!reqs.length) throw new BatchError('requests 不能为空', null, 'INVALID_REQUEST');
    if (reqs.length > this.limits.maxRequests) throw new BatchError(`单次批量最多 ${this.limits.maxRequests} 个子请求`, { max: this.limits.maxRequests, actual: reqs.length });
    const ids = new Set();
    const subs = reqs.map((r, i) => {
      if (!r || typeof r !== 'object') throw new BatchError(`requests[${i}] 必须是对象`, null, 'INVALID_REQUEST');
      const id = r.id === undefined || r.id === null ? `req-${i + 1}` : String(r.id).slice(0, 64);
      if (ids.has(id)) throw new BatchError(`子请求 id 重复：${id}`, null, 'INVALID_REQUEST');
      ids.add(id);
      const method = String(r.method || 'GET').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new BatchError(`requests[${i}].method 不支持：${method}`, null, 'INVALID_REQUEST');
      const path = String(r.path || '');
      if (!PATH_RE.test(path) || path.length > 2048 || /\/\.\.?(\/|$|\?)/.test(path) || path.includes('//') || /%2e%2e|%2f/i.test(path)) {
        throw new BatchError(`requests[${i}].path 非法：${path.slice(0, 100)}`, { allowed: '/v1/... 或 /api/vN/...' }, 'INVALID_REQUEST');
      }
      if (/^\/api\/v\d+\/batch(\/|$|\?)/.test(path)) throw new BatchError('不允许嵌套批量请求', null, 'INVALID_REQUEST');
      const priority = PRIORITY[r.priority] !== undefined ? r.priority : 'normal';
      if (method === 'GET' && r.body !== undefined) throw new BatchError(`requests[${i}] GET 请求不能带 body`, null, 'INVALID_REQUEST');
      return { index: i, id, method, path, priority, body: r.body, headers: r.headers && typeof r.headers === 'object' ? r.headers : {} };
    });
    const o = payload.options || {};
    const options = {
      parallel: o.parallel !== false,
      maxParallel: Math.max(1, Math.min(this.limits.maxParallel, Number(o.maxParallel) || this.limits.maxParallel)),
      timeout: Math.max(100, Math.min(this.limits.maxTimeout, Number(o.timeout) || this.limits.defaultTimeout)),
      failFast: o.failFast === true,
      cacheTTL: Math.max(0, Math.min(this.limits.maxCacheTTL, o.cacheTTL === undefined ? this.limits.defaultCacheTTL : Number(o.cacheTTL) || 0)),
    };
    return { subs, options };
  }

  /**
   * @param {object} payload { requests, options }
   * @param {object} ctx { userId, cacheScope, template, onResult(result) }
   */
  async execute(payload, ctx = {}) {
    const { subs, options } = this.validate(payload);
    const started = Date.now();
    const results = new Array(subs.length);
    const controller = new AbortController();
    let failedFast = false;
    let timedOut = false;
    const queue = [...subs].sort((a, b) => (PRIORITY[a.priority] - PRIORITY[b.priority]) || (a.index - b.index));
    const concurrency = options.parallel ? options.maxParallel : 1;
    const inflight = new Map();

    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeout);
    if (timer.unref) timer.unref();

    const finish = (sub, r) => {
      results[sub.index] = r;
      if (typeof ctx.onResult === 'function') { try { ctx.onResult(r); } catch { /* ignore */ } }
      if (this.metrics && this.metrics.subrequests) {
        try { this.metrics.subrequests.inc({ status_class: `${String(r.status)[0]}xx`, cached: r.cached ? 'true' : 'false' }); } catch { /* ignore */ }
      }
    };

    const runOne = async (sub) => {
      const t0 = Date.now();
      const cacheKey = sub.method === 'GET' && this.cache && ctx.cacheScope ? `batch:${ctx.cacheScope}:${sub.path}` : null;
      if (cacheKey && options.cacheTTL > 0) {
        try {
          const hit = await this.cache.get(cacheKey);
          if (hit) {
            const body = JSON.parse(hit);
            return finish(sub, this._toResult(sub, 200, body, Date.now() - t0, true));
          }
        } catch { /* 缓存故障回源 */ }
      }
      let res;
      try {
        const call = () => this.dispatch(sub, { signal: controller.signal, ctx }).then((r) => {
          if (sub.method === 'GET' && [502, 503, 504].includes(r.status)) {
            const e = new Error(`HTTP ${r.status}`); e.status = r.status; e.headers = r.headers || {}; e.result = r; throw e;
          }
          return r;
        });
        res = sub.method === 'GET' && this.retryManager
          ? await this.retryManager.execute(call, { operationName: 'batch.subrequest', signal: controller.signal }).catch((err) => {
            const inner = err.cause || err;
            if (inner && inner.result) return inner.result;
            throw err;
          })
          : await call();
      } catch (err) {
        const aborted = controller.signal.aborted;
        const status = timedOut ? 504 : aborted ? 499 : 502;
        const name = timedOut ? 'GATEWAY_TIMEOUT' : aborted ? 'ABORTED' : 'BAD_GATEWAY';
        return finish(sub, { id: sub.id, status, priority: sub.priority, cached: false, duration: Date.now() - t0, error: { code: name, name, message: timedOut ? '批量请求整体超时' : aborted ? '因 failFast 被中止' : String(err.message || err) } });
      }
      if (cacheKey && options.cacheTTL > 0 && res.status === 200 && res.body && typeof res.body === 'object') {
        this.cache.set(cacheKey, JSON.stringify(res.body), options.cacheTTL).catch(() => {});
      }
      const r = this._toResult(sub, res.status, res.body, Date.now() - t0, false);
      finish(sub, r);
      if (options.failFast && res.status >= 400 && !failedFast) {
        failedFast = true;
        controller.abort();
      }
      return undefined;
    };

    await new Promise((resolve) => {
      let active = 0;
      const pump = () => {
        while (active < concurrency && queue.length) {
          if ((failedFast || timedOut) && queue.length) {
            const sub = queue.shift();
            finish(sub, { id: sub.id, status: timedOut ? 504 : 499, priority: sub.priority, cached: false, duration: 0, error: timedOut ? { code: 'GATEWAY_TIMEOUT', name: 'GATEWAY_TIMEOUT', message: '批量请求整体超时' } : { code: 'ABORTED', name: 'ABORTED', message: '因 failFast 被中止' } });
            continue;
          }
          const sub = queue.shift();
          active++;
          const p = runOne(sub).finally(() => { active--; inflight.delete(sub.id); if (!queue.length && active === 0) resolve(); else pump(); });
          inflight.set(sub.id, p);
        }
        if (!queue.length && active === 0) resolve();
      };
      pump();
    });
    clearTimeout(timer);

    const totalDuration = Date.now() - started;
    const success = results.filter((r) => r.status < 400).length;
    const cached = results.filter((r) => r.cached).length;
    const summary = { total: results.length, success, failed: results.length - success, cached, totalDuration, costSaved: costSaved(results.length, cached), failedFast, timedOut, sequentialEstimate: results.reduce((s, r) => s + (r.duration || 0), 0) };
    if (this.metrics) {
      try {
        if (this.metrics.requests) this.metrics.requests.inc({ template: ctx.template || 'adhoc', result: summary.failed ? (failedFast ? 'fail_fast' : 'partial') : 'success' });
        if (this.metrics.duration) this.metrics.duration.observe({ template: ctx.template || 'adhoc' }, totalDuration / 1000);
        if (this.metrics.size) this.metrics.size.observe(results.length);
        if (this.metrics.cost) this.metrics.cost.inc(summary.costSaved);
      } catch { /* ignore */ }
    }
    return { responses: results, summary };
  }

  _toResult(sub, status, body, duration, cached) {
    const r = { id: sub.id, status, priority: sub.priority, cached, duration };
    if (status < 400) {
      r.data = body && typeof body === 'object' && !Array.isArray(body) && body.data !== undefined ? body.data : body;
      if (body && typeof body === 'object' && body.pagination) r.pagination = body.pagination;
    } else {
      const e = body && typeof body === 'object' ? (body.error && typeof body.error === 'object' ? body.error : body.errorInfo || { code: body.code, message: body.message || body.error }) : { message: String(body || '') };
      r.error = { code: e.name || e.code || status, name: e.name, message: e.message };
    }
    return r;
  }
}

module.exports = { BatchExecutor, BatchError, costSaved, expandTemplate, PRIORITY, ROUND_TRIP_COST_USD, BACKEND_CALL_COST_USD };
