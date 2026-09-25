// Epic E25 —— 运行时组件单元测试：批量执行器 / 重试与退避 / 性能预算 / 版本生命周期与弃用 / 流式压缩
// REQ-00308 REQ-00402 REQ-00476 REQ-00201 REQ-00520 REQ-00407 REQ-00526
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');

const { BatchExecutor, BatchError, costSaved, expandTemplate } = require('../../shared/apiStandards/batch');
const R = require('../../shared/RetryManager');
const perf = require('../../shared/apiStandards/performanceBudget');
const V = require('../../shared/apiStandards/versioning');
const { createStreamingCompression, selectEncoding } = require('../../shared/apiStandards/streamingCompression');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 批量执行器 ────────────────────────────────────────────────
function fakeDispatch(log, { delay = 30, fail = [] } = {}) {
  return async (sub, { signal }) => {
    log.push(`start:${sub.id}`);
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, typeof delay === 'function' ? delay(sub) : delay);
      signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
    });
    log.push(`end:${sub.id}`);
    if (fail.includes(sub.id)) return { status: 404, body: { success: false, code: 3001, message: '精灵不存在', error: { code: 3001, name: 'POKEMON_NOT_FOUND', message: '精灵不存在' } } };
    return { status: 200, body: { success: true, code: 0, data: { path: sub.path } } };
  };
}

test('批量：并行执行总耗时 < 串行耗时；summary/costSaved 正确', async () => {
  const log = [];
  const ex = new BatchExecutor({ dispatch: fakeDispatch(log, { delay: 50 }) });
  const t0 = Date.now();
  const out = await ex.execute({ requests: [1, 2, 3, 4, 5].map((i) => ({ id: `r${i}`, path: `/v1/pokemon/my/${i}` })) });
  const elapsed = Date.now() - t0;
  assert.equal(out.responses.length, 5);
  assert.ok(elapsed < 5 * 50 * 0.6, `并行 ${elapsed}ms`);
  assert.ok(out.summary.sequentialEstimate >= 5 * 45);
  assert.deepEqual([out.summary.total, out.summary.success, out.summary.failed, out.summary.cached], [5, 5, 0, 0]);
  assert.equal(out.summary.costSaved, costSaved(5, 0));
  assert.equal(costSaved(3, 1), 0.00012, '与需求示例一致：3 个请求 1 个命中缓存 → $0.00012');
  assert.equal(out.responses[0].data.path, '/v1/pokemon/my/1');
});

test('批量：高优先级先执行；串行模式；单个失败不影响其他（failFast=false）', async () => {
  const log = [];
  const ex = new BatchExecutor({ dispatch: fakeDispatch(log, { delay: 5, fail: ['b'] }) });
  const out = await ex.execute({ requests: [
    { id: 'a', path: '/v1/a', priority: 'low' }, { id: 'b', path: '/v1/b' }, { id: 'c', path: '/v1/c', priority: 'high' },
  ], options: { parallel: false } });
  assert.deepEqual(log.filter((x) => x.startsWith('start')), ['start:c', 'start:b', 'start:a']);
  assert.deepEqual(out.responses.map((r) => r.id), ['a', 'b', 'c'], '结果按请求顺序返回');
  assert.equal(out.responses[1].status, 404);
  assert.equal(out.responses[1].error.name, 'POKEMON_NOT_FOUND');
  assert.equal(out.summary.failed, 1);
  assert.equal(out.summary.success, 2);
});

test('批量：failFast=true 首个失败后中止其余；整体超时 → 504', async () => {
  const log = [];
  const ex = new BatchExecutor({ dispatch: fakeDispatch(log, { delay: (s) => (s.id === 'x' ? 5 : 200), fail: ['x'] }) });
  const out = await ex.execute({ requests: [{ id: 'x', path: '/v1/x', priority: 'high' }, { id: 'y', path: '/v1/y' }, { id: 'z', path: '/v1/z' }], options: { failFast: true, maxParallel: 2 } });
  assert.equal(out.summary.failedFast, true);
  assert.equal(out.responses.find((r) => r.id === 'x').status, 404);
  assert.ok(out.responses.filter((r) => r.status === 499).length >= 1);
  const ex2 = new BatchExecutor({ dispatch: fakeDispatch([], { delay: 500 }) });
  const t0 = Date.now();
  const out2 = await ex2.execute({ requests: [{ path: '/v1/slow' }], options: { timeout: 150 } });
  assert.ok(Date.now() - t0 < 450);
  assert.equal(out2.responses[0].status, 504);
  assert.equal(out2.summary.timedOut, true);
});

test('批量：GET 结果按用户作用域缓存，重复请求命中', async () => {
  const store = new Map();
  const cache = { get: async (k) => store.get(k) || null, set: async (k, v) => { store.set(k, v); } };
  const log = [];
  const ex = new BatchExecutor({ dispatch: fakeDispatch(log, { delay: 1 }), cache });
  const payload = { requests: [{ id: 'p', path: '/v1/pokemon/my/1' }, { id: 'w', method: 'POST', path: '/v1/location', body: { lat: 1 } }], options: { cacheTTL: 60 } };
  await ex.execute(payload, { cacheScope: 'u:1:v0' });
  const out = await ex.execute(payload, { cacheScope: 'u:1:v0' });
  assert.equal(out.responses[0].cached, true);
  assert.equal(out.responses[1].cached, false, '写请求不缓存');
  assert.equal(out.summary.cached, 1);
  const other = await ex.execute(payload, { cacheScope: 'u:2:v0' });
  assert.equal(other.responses[0].cached, false, '不同用户不共享缓存');
});

test('批量：校验（数量上限、嵌套、路径穿越、GET 带 body、重复 id）与模板展开', () => {
  const ex = new BatchExecutor({ dispatch: async () => ({}) });
  assert.throws(() => ex.validate({ requests: Array.from({ length: 21 }, () => ({ path: '/v1/a' })) }), BatchError);
  assert.throws(() => ex.validate({ requests: [{ path: '/api/v1/batch' }] }), /嵌套/);
  assert.throws(() => ex.validate({ requests: [{ path: '/v1/../admin' }] }), /非法/);
  assert.throws(() => ex.validate({ requests: [{ path: 'http://evil/' }] }), /非法/);
  assert.throws(() => ex.validate({ requests: [{ path: '/v1/a', body: {} }] }), /GET/);
  assert.throws(() => ex.validate({ requests: [{ id: 'a', path: '/v1/a' }, { id: 'a', path: '/v1/b' }] }), /重复/);
  const { options } = ex.validate({ requests: [{ path: '/v1/a' }], options: { maxParallel: 999, timeout: 999999, cacheTTL: 9999 } });
  assert.deepEqual([options.maxParallel, options.timeout, options.cacheTTL], [10, 30000, 300]);
  assert.equal(expandTemplate('/v1/pokemon/my/{id}?x={x}', { id: 'a b', x: 1 }), '/v1/pokemon/my/a%20b?x=1');
  assert.throws(() => expandTemplate('/v1/{id}', {}), /模板参数缺失/);
});

test('批量：幂等 GET 在 503 时经 RetryManager 重试成功', async () => {
  let n = 0;
  const rm = new R.RetryManager({ maxRetries: 2, initialDelay: 5, maxDelay: 20, jitterType: 'none' });
  const ex = new BatchExecutor({ retryManager: rm, dispatch: async () => (++n < 2 ? { status: 503, headers: {}, body: { code: 9002 } } : { status: 200, body: { data: 1 } }) });
  const out = await ex.execute({ requests: [{ path: '/v1/flaky' }] });
  assert.equal(out.responses[0].status, 200);
  assert.equal(n, 2);
});

// ── 重试与退避 ────────────────────────────────────────────────
test('退避算法：指数 / 线性 / 自适应；抖动范围；去相关抖动', () => {
  const cfg = { initialDelay: 100, maxDelay: 10000, backoffFactor: 2, jitterType: 'none', jitterRange: 0.5 };
  const exp = new R.ExponentialBackoff(cfg);
  assert.deepEqual([1, 2, 3, 4].map((a) => exp.calculateDelay(a, {})), [100, 200, 400, 800]);
  assert.equal(exp.calculateDelay(20, {}), 10000);
  const full = new R.ExponentialBackoff({ ...cfg, jitterType: 'full' });
  const samples = Array.from({ length: 200 }, () => full.calculateDelay(3, {}));
  assert.ok(samples.every((d) => d >= 0 && d <= 400));
  assert.ok(new Set(samples.map((d) => Math.round(d))).size > 50, '抖动使多个客户端的重试时间分散（防惊群）');
  const equal = new R.ExponentialBackoff({ ...cfg, jitterType: 'equal' });
  assert.ok(Array.from({ length: 100 }, () => equal.calculateDelay(3, {})).every((d) => d >= 200 && d <= 400));
  const deco = new R.ExponentialBackoff({ ...cfg, jitterType: 'decorrelated' });
  assert.ok(Array.from({ length: 100 }, () => deco.calculateDelay(3, {}, 300)).every((d) => d >= 100 && d <= 900));
  const lin = new R.LinearBackoff({ initialDelay: 100, maxDelay: 5000, increment: 100, jitterRange: 0 });
  assert.deepEqual([1, 2, 3].map((a) => lin.calculateDelay(a)), [100, 200, 300]);
  const ad = new R.AdaptiveBackoff({ initialDelay: 100, maxDelay: 10000, backoffFactor: 2 });
  for (let i = 0; i < 10; i++) ad.recordFailure();
  const afterFail = ad.currentDelay;
  assert.ok(afterFail > 100, '失败率高 → 延迟变大');
  for (let i = 0; i < 10; i++) ad.recordSuccess();
  assert.ok(ad.currentDelay < afterFail, '成功率高 → 延迟变小');
});

test('错误分类：HTTP 状态 / 网络错误 / 业务错误 / Abort / Retry-After', () => {
  const c = new R.ErrorClassifier();
  assert.equal(c.classify({ status: 503 }).retryable, true);
  assert.equal(c.classify({ status: 404 }).retryable, false);
  assert.equal(c.classify({ response: { status: 502 } }).retryable, true);
  assert.equal(c.classify({ status: 501 }).retryable, false);
  assert.equal(c.classify({ code: 'ECONNRESET' }).type, 'network');
  assert.equal(c.classify({ code: 'ENOENT' }).retryable, false);
  assert.equal(c.classify(Object.assign(new Error('x'), { name: 'ValidationError' })).retryable, false);
  assert.equal(c.classify(new R.AbortError('x')).retryable, false);
  assert.equal(c.classify(new R.TimeoutError('x')).retryable, true);
  assert.equal(c.classify({ status: 429, headers: { 'retry-after': '2' } }).suggestedDelay, 2000);
  const d = c.classify({ status: 503, headers: { 'retry-after': new Date(Date.now() + 3000).toUTCString() } }).suggestedDelay;
  assert.ok(d > 1000 && d <= 3000);
});

test('RetryManager：成功重试、最大次数、预算限制、超时、AbortSignal、钩子', async () => {
  const events = [];
  const rm = new R.RetryManager({ maxRetries: 3, initialDelay: 1, maxDelay: 5, jitterType: 'none', timeout: 1000, onRetry: (e) => events.push(['retry', e.attempt]), onSuccess: (e) => events.push(['ok', e.attempt]) });
  let n = 0;
  assert.equal(await rm.execute(async () => { if (++n < 3) throw Object.assign(new Error('x'), { status: 503 }); return 'done'; }, { operationName: 't1' }), 'done');
  assert.deepEqual(events, [['retry', 1], ['retry', 2], ['ok', 3]]);
  await assert.rejects(rm.execute(async () => { throw Object.assign(new Error('x'), { status: 500 }); }), R.MaxRetriesExceededError);
  await assert.rejects(rm.execute(async () => { throw Object.assign(new Error('x'), { status: 400 }); }), /x/);
  const budget = new R.RetryBudget({ maxBudget: 1, refillRate: 0, autoRefill: false });
  const rb = new R.RetryManager({ maxRetries: 5, initialDelay: 1, jitterType: 'none', retryBudget: budget });
  await assert.rejects(rb.execute(async () => { throw Object.assign(new Error('x'), { status: 503 }); }), R.RetryBudgetExhaustedError);
  assert.equal(budget.getBudget(), 0);
  const rt = new R.RetryManager({ maxRetries: 0, timeout: 30 });
  await assert.rejects(rt.execute(() => sleep(200)), /timed out|failed after/);
  const ac = new AbortController();
  const ra = new R.RetryManager({ maxRetries: 5, initialDelay: 200, jitterType: 'none' });
  setTimeout(() => ac.abort(), 30);
  const t0 = Date.now();
  await assert.rejects(ra.execute(async () => { throw Object.assign(new Error('x'), { status: 503 }); }, { signal: ac.signal }), /aborted/i);
  assert.ok(Date.now() - t0 < 150, 'Abort 立即取消等待中的重试');
  const rd = new R.RetryManager({ maxRetries: 10, initialDelay: 50, jitterType: 'none', deadline: 120 });
  await assert.rejects(rd.execute(async () => { throw Object.assign(new Error('x'), { status: 503 }); }), /deadline|timed out/);
  // 多个实例不重复注册指标
  assert.doesNotThrow(() => { new R.RetryManager(); new R.RetryManager(); });
});

test('RetryManager.fetch：只对幂等请求重试，返回最后一次 HTTP 响应', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 503, headers: new Map([['retry-after', '0']]) }; };
  const rm = new R.RetryManager({ maxRetries: 2, initialDelay: 1, jitterType: 'none' });
  const res = await rm.fetch('http://x/a', { fetchImpl });
  assert.equal(res.status, 503);
  assert.equal(calls, 3);
  calls = 0;
  await rm.fetch('http://x/a', { method: 'POST', fetchImpl });
  assert.equal(calls, 1, 'POST 不自动重试');
  calls = 0;
  await rm.fetch('http://x/a', { method: 'POST', headers: { 'Idempotency-Key': 'k' }, fetchImpl });
  assert.equal(calls, 3, '带幂等键的 POST 可重试');
});

test('RetryStatsRecorder：聚合写 retry_stats_hourly 与 retry_events', async () => {
  const sqls = [];
  const rec = new R.RetryStatsRecorder({ query: async (sql, p) => { sqls.push([sql.trim().split(/\s+/).slice(0, 3).join(' '), p]); return { rows: [] }; }, serviceName: 'svc', flushIntervalMs: 0 });
  const rm = new R.RetryManager({ maxRetries: 2, initialDelay: 1, jitterType: 'none', ...rec.hooks() });
  let n = 0;
  await rm.execute(async () => { if (++n < 2) throw Object.assign(new Error('x'), { status: 502 }); return 1; }, { operationName: 'op' });
  await rec.flush();
  assert.ok(sqls.some(([s]) => s.startsWith('INSERT INTO retry_events')));
  const agg = sqls.find(([s]) => s.startsWith('INSERT INTO retry_stats_hourly'));
  assert.equal(agg[1][5], 1, 'retry_attempts=1');
});

// ── 性能预算 ────────────────────────────────────────────────
const YAML_TEXT = `version: 1
defaults:
  p50: 200ms
  p95: 500ms
  p99: 1000ms
  max: 3000ms
evaluation:
  windowSize: 100
  minSamples: 10
budgets:
  pokemon:
    "GET /v1/pokemon/my/:id":
      p50: 50ms
      p95: 100ms
      p99: 200ms
      max: 300ms
      budgetType: strict
      priority: P0
    "GET /v1/pokemon/my":
      p95: 400ms
regressionThresholds:
  p99: 20%
`;

test('性能预算：YAML 解析、路由匹配（具体优先）、MAX 违规即时告警、窗口百分位评估、热点与趋势', async () => {
  const cfg = perf.normalizeConfig(YAML_TEXT);
  assert.equal(cfg.budgets[0].key, 'GET /v1/pokemon/my/:id');
  assert.equal(cfg.regressionThresholds.p99, 0.2);
  const alerts = [];
  const redisCalls = [];
  const redis = { hincrby: async (...a) => { redisCalls.push(a); }, expire: async () => {}, hgetall: async () => ({ 'GET /v1/pokemon/my/:id|total': '5', 'GET /v1/pokemon/my/:id|violation:max': '1' }) };
  const m = new perf.PerformanceBudgetManager({ config: cfg, redis, onAlert: (a) => alerts.push(a) });
  assert.equal(m.budgetFor('GET', '/v1/pokemon/my/abc').budgetType, 'strict');
  assert.equal(m.budgetFor('GET', '/v1/pokemon/my').p95, 400);
  assert.equal(m.budgetFor('GET', '/v1/other/123').key, 'GET /v1/other/:id');
  const r = m.record('GET', '/v1/pokemon/my/abc', 350);
  assert.deepEqual(r.violations, ['max']);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'critical');
  for (let i = 0; i < 20; i++) m.record('GET', '/v1/pokemon/my/abc', 150);
  const ev = m.evaluate().find((x) => x.key === 'GET /v1/pokemon/my/:id');
  assert.deepEqual(ev.violations.sort(), ['p50', 'p95', 'p99'], '350ms 样本同时抬高 p99');
  for (let i = 0; i < 20; i++) m.record('GET', '/v1/pokemon/my', 10);
  const rep = m.report();
  assert.equal(rep.hotspots[0].route, 'GET /v1/pokemon/my/:id');
  assert.equal(rep.summary.configuredRoutes, 2);
  assert.equal(rep.summary.complianceRate, 0.5);
  assert.ok(redisCalls.length > 0);
  const trend = await m.trend(2);
  assert.equal(trend.length, 2);
  assert.equal(trend[0].violations, 1);
});

test('性能回归检测：P99 增长 > 20% 判定退化；预算门禁', () => {
  const r = perf.detectRegression({ 'GET /a': { p50: 10, p95: 50, p99: 100 } }, { 'GET /a': { p50: 10, p95: 52, p99: 130 } });
  assert.equal(r.passed, false);
  assert.deepEqual(r.regressions.map((x) => x.percentile), ['p99']);
  assert.equal(perf.detectRegression({ 'GET /a': { p99: 2 } }, { 'GET /a': { p99: 4 } }).passed, true, '基线极小时忽略绝对值 <5ms 的抖动');
  const cfg = perf.normalizeConfig(YAML_TEXT);
  const g = perf.checkAgainstBudget(cfg, { 'GET /v1/pokemon/my/x': { p50: 40, p95: 150, p99: 190 } });
  assert.equal(g.passed, false);
  assert.equal(g.failures[0].percentile, 'p95');
  assert.equal(perf.parseDuration('1.5s'), 1500);
  assert.deepEqual(perf.stats([5, 1, 3, 2, 4]), { count: 5, p50: 3, p95: 5, p99: 5, max: 5, avg: 3 });
});

test('仓库内 config/performance-budget.yaml 可解析且覆盖 >= 5 个 P0 接口', () => {
  const cfg = perf.loadConfigFile();
  const p0 = cfg.budgets.filter((b) => b.priority === 'P0');
  assert.ok(p0.length >= 5, `P0=${p0.length}`);
  assert.ok(cfg.budgets.every((b) => b.p50 <= b.p95 && b.p95 <= b.p99 && b.p99 <= b.max));
});

// ── 版本生命周期与弃用 ───────────────────────────────────────
test('版本协商：URL > 媒体类型 > Accept-Version > X-API-Version > 默认；冲突提示；非法头', () => {
  const reg = new V.VersionRegistry({ versions: { 1: { status: 'stable' }, 2: { status: 'stable' }, 3: { status: 'development' } }, currentVersion: 2 });
  const r = (path, headers = {}) => reg.resolve({ path, headers });
  assert.deepEqual([r('/api/v1/x').version, r('/api/v1/x').source], [1, 'path']);
  assert.equal(r('/v1/x').version, 1);
  assert.deepEqual([r('/api/x', { accept: 'application/vnd.minego.v1+json' }).version, r('/api/x', { accept: 'application/vnd.minego.v1+json' }).source], [1, 'media-type']);
  assert.equal(r('/api/x', { 'accept-version': '1' }).version, 1);
  assert.equal(r('/api/x', { 'x-api-version': 'v1' }).version, 1);
  assert.equal(r('/api/x', { accept: 'application/vnd.minego.v2+json', 'accept-version': '1' }).version, 2);
  assert.deepEqual([r('/api/x').version, r('/api/x').source], [2, 'default']);
  assert.equal(r('/api/v1/x', { 'accept-version': '2' }).conflict, true);
  assert.equal(r('/api/x', { 'accept-version': 'abc' }).invalidHeader, true);
  assert.deepEqual(reg.supported(), [1, 2], 'development 版本不对外');
});

test('版本生命周期：合法/非法迁移、deprecated 头、到期自动视为 sunset', () => {
  let now = new Date('2026-09-25T00:00:00Z');
  const reg = new V.VersionRegistry({ versions: { 1: { status: 'stable', successor: 2, migrationGuide: 'https://docs/m' }, 2: { status: 'testing' } }, now: () => now });
  assert.throws(() => reg.transition(1, 'sunset'), /不允许的生命周期迁移/);
  assert.throws(() => reg.transition(1, 'bogus'), /无效状态/);
  const d = reg.transition(1, 'deprecated', { sunsetAt: '2026-12-31T00:00:00Z' });
  assert.equal(d.status, 'deprecated');
  const h = reg.deprecationHeaders(1);
  assert.equal(h.Deprecation, `@${Math.floor(now.getTime() / 1000)}`);
  assert.equal(h.Sunset, new Date('2026-12-31T00:00:00Z').toUTCString());
  assert.match(h.Link, /<\/api\/v2\/>; rel="successor-version"/);
  assert.match(h.Link, /rel="deprecation"/);
  reg.transition(2, 'stable');
  assert.equal(reg.current(), 2);
  now = new Date('2027-01-01T00:00:00Z');
  assert.equal(reg.describe(1).status, 'sunset');
  assert.deepEqual(reg.supported(), [2]);
  assert.equal(reg.transition(1, 'sunset').status, 'sunset');
  assert.throws(() => reg.transition(1, 'stable'), /不允许/);
  reg.recordUsage(2, 'GET /v1/x');
  reg.recordUsage(2, 'GET /v1/x');
  assert.equal(reg.usageSnapshot()['2027-01-01'].v2, 2);
});

test('TransformEngine：remove/rename/default/set/move 作用于 data 或根，数组逐项', () => {
  const t = new V.TransformEngine([{ id: 'r1', version: 1, method: 'GET', path: '/api/v1/users/:id', response: [{ op: 'remove', path: 'stats' }, { op: 'rename', from: 'nickname', to: 'nick' }, { op: 'default', path: 'team', value: 'none' }, { op: 'set', path: 'meta.legacy', value: true }, { op: 'move', from: 'a.b', to: 'c' }] }]);
  const { body, applied } = t.transformResponse(1, 'GET', '/api/v1/users/42', { success: true, data: { stats: 1, nickname: 'n', a: { b: 2 } } });
  assert.deepEqual(applied, ['r1']);
  assert.deepEqual(body.data, { nick: 'n', team: 'none', meta: { legacy: true }, a: {}, c: 2 });
  const arr = t.transformResponse(1, 'GET', '/api/v1/users/1', { data: [{ stats: 1, nickname: 'x' }] }).body;
  assert.deepEqual(arr.data[0], { nick: 'x', team: 'none', meta: { legacy: true } });
  assert.equal(t.transformResponse(2, 'GET', '/api/v1/users/1', { data: { stats: 1 } }).applied.length, 0);
  const req = new V.TransformEngine([{ id: 'q', version: 1, path: '/api/v1/orders', request: [{ op: 'default', path: 'channel', value: 'wechat' }] }]);
  assert.equal(req.transformRequest(1, 'POST', '/api/v1/orders', {}).body.channel, 'wechat');
});

test('DeprecationRegistry：模式匹配（具体优先）、头与响应体、下线判定、调用统计 flush、迁移文档', async () => {
  const now = new Date('2026-09-25T00:00:00Z');
  const sqls = [];
  const reg = new V.DeprecationRegistry({ now: () => now, query: async (sql, p) => { sqls.push(p); return { rows: [] }; } });
  reg.setAll([
    { id: 1, endpoint: '/v1/pokemon/*', method: '*', deprecated_at: '2026-09-01', sunset_at: '2026-12-01', status: 'active' },
    { id: 2, endpoint: '/v1/pokemon/nearby', method: 'GET', deprecated_at: '2026-09-01', sunset_at: '2026-10-01', successor_endpoint: '/v2/pokemon/nearby', breaking_changes: [{ field: 'location', change: 'renamed to coordinates', oldType: 'object', newType: 'object' }], status: 'active' },
    { id: 3, endpoint: '/v1/old/:id', method: 'GET', deprecated_at: '2026-01-01', sunset_at: '2026-06-01', status: 'active' },
    { id: 4, endpoint: '/v1/cancelled', method: 'GET', deprecated_at: '2026-01-01', sunset_at: '2027-06-01', status: 'cancelled' },
  ]);
  assert.equal(reg.find('GET', '/v1/pokemon/nearby').id, 2);
  assert.equal(reg.find('POST', '/v1/pokemon/nearby').id, 1);
  assert.equal(reg.find('GET', '/v1/cancelled'), null);
  const d = reg.find('GET', '/v1/pokemon/nearby');
  const h = reg.headers(d);
  assert.match(h.Link, /<\/v2\/pokemon\/nearby>; rel="successor-version"/);
  assert.equal(h.Sunset, new Date('2026-10-01').toUTCString());
  assert.equal(reg.bodyField(d).daysRemaining, 6);
  assert.equal(reg.isSunset(reg.find('GET', '/v1/old/9')), true);
  reg.recordCall(d, { clientId: 'ios app!!', clientVersion: '2.1', userId: 'u1' });
  reg.recordCall(d, { clientId: 'ios app!!', clientVersion: '2.1', userId: 'u1' });
  reg.recordCall(d, { userId: 'u2' });
  assert.equal(await reg.flush(), 2);
  assert.deepEqual(sqls[0].slice(0, 3), ['iosapp', '2.1', 2]);
  assert.equal(sqls[1][0], 'user:u2');
  const md = V.generateMigrationGuide({ ...d, endpoint: '/v1/pokemon/nearby', method: 'GET', deprecated_at: '2026-09-01', sunset_at: '2026-10-01', successor_endpoint: '/v2/pokemon/nearby', breaking_changes: d.breakingChanges }, { stats: { clients: 3, calls: 120 } });
  for (const s of ['## 概述', '## 请求对比', '## 响应对比', '## Breaking Changes', '## 代码示例', '已改名为 coordinates', '410 Gone']) assert.ok(md.includes(s), s);
});

// ── 流式压缩 ────────────────────────────────────────────────
function serve(handler) {
  const mw = createStreamingCompression({ threshold: 256 });
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.path = req.url;
      mw(req, res, () => handler(req, res));
    }).listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      let first = null;
      res.on('data', (c) => { if (first === null) first = Date.now() - t0; chunks.push(c); });
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks), ttfb: first, total: Date.now() - t0 }));
    });
    req.on('error', reject);
  });
}

test('流式压缩：br 优先/小响应明文/不可压缩类型透传/ndjson 分块边压边发', async () => {
  assert.equal(selectEncoding('gzip, deflate, br'), 'br');
  assert.equal(selectEncoding('gzip;q=1, br;q=0.5'), 'gzip');
  assert.equal(selectEncoding('identity'), null);
  const { server, port } = await serve((req, res) => {
    if (req.url === '/small') { res.setHeader('Content-Type', 'application/json'); return res.end('{"a":1}'); }
    if (req.url === '/png') { res.setHeader('Content-Type', 'image/png'); return res.end(Buffer.alloc(4096, 1)); }
    if (req.url === '/big') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ d: 'abc'.repeat(5000) })); }
    // ndjson：先写 5 行，再延迟 300ms 写剩余并结束
    res.setHeader('Content-Type', 'application/x-ndjson');
    for (let i = 0; i < 5; i++) res.write(`${JSON.stringify({ i, pad: 'x'.repeat(100) })}\n`);
    setTimeout(() => { for (let i = 5; i < 10; i++) res.write(`${JSON.stringify({ i })}\n`); res.end(); }, 300);
    return undefined;
  });
  try {
    const small = await rawGet(port, '/small', { 'accept-encoding': 'br' });
    assert.equal(small.res.headers['content-encoding'], undefined);
    assert.equal(small.res.headers['content-length'], '7');
    const png = await rawGet(port, '/png', { 'accept-encoding': 'br' });
    assert.equal(png.res.headers['content-encoding'], undefined);
    const big = await rawGet(port, '/big', { 'accept-encoding': 'br, gzip' });
    assert.equal(big.res.headers['content-encoding'], 'br');
    assert.ok(big.body.length < 1000);
    assert.equal(JSON.parse(zlib.brotliDecompressSync(big.body)).d.length, 15000);
    const nd = await rawGet(port, '/nd', { 'accept-encoding': 'gzip' });
    assert.equal(nd.res.headers['content-encoding'], 'gzip');
    assert.ok(nd.ttfb < 200, `首字节 ${nd.ttfb}ms 早于整体完成 ${nd.total}ms（流式 flush）`);
    assert.ok(nd.total >= 290);
    const lines = zlib.gunzipSync(nd.body).toString().trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 10);
  } finally { server.close(); }
});

test('流式压缩：客户端中途断开时销毁压缩流、不再写入', async () => {
  let destroyed = false;
  let writesAfterClose = 0;
  const { server, port } = await serve((req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    let i = 0;
    const timer = setInterval(() => {
      if (res.destroyed || res.writableEnded) { clearInterval(timer); destroyed = true; return; }
      res.write(`${JSON.stringify({ i: i++, pad: 'y'.repeat(500) })}\n`);
      if (res.socket && res.socket.destroyed) writesAfterClose++;
    }, 10);
    res.on('close', () => { destroyed = true; clearInterval(timer); });
  });
  try {
    await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/s', headers: { 'accept-encoding': 'br' } }, (res) => {
        res.once('data', () => { req.destroy(); setTimeout(resolve, 100); });
      });
      req.on('error', () => {});
    });
    assert.equal(destroyed, true);
    assert.ok(writesAfterClose <= 1);
  } finally { server.close(); }
});

test('重试中间件：注入 req.retryManager / req.retryableFetch；retryableFetch 只重试幂等请求（REQ-00402）', async () => {
  const { createRetryMiddleware } = require('../../shared/middleware/retryMiddleware');
  const mw = createRetryMiddleware({ serviceName: 'unit-retry-mw', maxRetries: 2, initialDelay: 1, maxDelay: 5, jitterType: 'none' });
  const req = {};
  let nextCalled = false;
  mw(req, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.ok(req.retryManager instanceof R.RetryManager);
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 503, headers: new Map([['retry-after', '0']]) }; };
  const res = await req.retryableFetch('http://svc/a', { fetchImpl });
  assert.equal(res.status, 503);
  assert.equal(calls, 3, 'GET：1 次 + 2 次重试');
  calls = 0;
  await req.retryableFetch('http://svc/a', { method: 'POST', fetchImpl });
  assert.equal(calls, 1, 'POST 不自动重试');
  const req2 = {};
  mw(req2, {}, () => {});
  assert.equal(req2.retryManager, req.retryManager, '同一服务复用同一个 RetryManager');
});
