// Epic E25 —— 服务侧组件单测：PokemonBatchService（REQ-00350）、RequestCoalescer（50ms 合并）、ApiResponse（REQ-00386/518）
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const promClient = require('prom-client');

const { RequestCoalescer } = require('../../shared/apiStandards/requestCoalescer');
const { PokemonBatchService, DETAIL_SQL } = require('../../services/pokemon-service/src/services/PokemonBatchService');
const ApiResponse = require('../../shared/utils/ApiResponse');

const UID = 'f908286b-27bf-4174-8cd8-4fb952877b58';
const id = (n) => `0a1b2c3d-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fakeDb({ owned = 10, failInclude = null } = {}) {
  const calls = [];
  const rows = Array.from({ length: owned }, (_, i) => ({
    id: id(i + 1), user_id: UID, species_id: i + 1, cp: 100 + i, fast_move: 'TACKLE', charge_move: 'BODY_SLAM', learned_fast_moves: ['QUICK_ATTACK'], learned_charge_moves: [],
    hp_current: i % 2 ? 10 : 50, hp_max: 50, max_stamina: 100, current_stamina: 80, fatigue_level: i === 0 ? 'TIRED' : 'NONE', caught_at: '2026-09-01T00:00:00Z', candy_count: 5,
  }));
  const exec = async (sql, params) => {
    calls.push(sql.trim().slice(0, 40));
    if (failInclude && sql.includes(failInclude)) throw new Error('boom');
    if (sql.startsWith('SET') || sql.startsWith('RESET')) return { rows: [] };
    if (sql === DETAIL_SQL) return { rows: rows.filter((r) => params[0].includes(r.id) && params[1] === UID) };
    if (sql.includes('FROM moves')) return { rows: params[0].map((m) => ({ id: m, name_zh: m, power: 10 })) };
    if (sql.includes('player_equipment')) return { rows: [{ id: 1, equipped_to_pokemon_id: params[0][0], current_level: 2, current_stats: { atk: 1 }, name_zh: '护符', type: 'charm', rarity: 'RARE' }] };
    if (sql.includes('pokemon_battle_stats')) return { rows: [{ pokemon_id: params[0][0], battles_won: 3, battles_lost: 1, total_damage_dealt: '100', total_damage_taken: '50', ko_count: 2, fainted_count: 1 }] };
    if (sql.includes('pokemon_friendship_logs')) return { rows: [{ pokemon_instance_id: params[0][0], change_amount: 5, source: 'walk', new_value: 30, created_at: '2026-09-10T00:00:00Z' }] };
    return { rows: [] };
  };
  let connections = 0;
  return {
    calls,
    connections: () => connections,
    query: exec,
    getClient: async () => { connections++; return { query: exec, release() {} }; },
  };
}

function fakeRedis() {
  const kv = new Map();
  const h = new Map();
  return {
    kv,
    async get(k) { return kv.get(k) ?? null; },
    async mget(...ks) { return ks.map((k) => kv.get(k) ?? null); },
    pipeline() { const ops = []; return { set: (k, v) => { ops.push([k, v]); return this; }, exec: async () => { for (const [k, v] of ops) kv.set(k, v); } }; },
    async hincrby(key, f, n) { const m = h.get(key) || {}; m[f] = (m[f] || 0) + n; h.set(key, m); },
    async hgetall(key) { return h.get(key) || {}; },
  };
}

test('RequestCoalescer：50ms 窗口内合并、去重、按作用域隔离、达到上限立即发出、错误传播', async () => {
  const calls = [];
  const c = new RequestCoalescer({ windowMs: 30, maxBatch: 3, batchFn: async (scope, ids) => { calls.push([scope, ids]); return new Map(ids.map((i) => [i, `${scope}:${i}`])); } });
  const r = await Promise.all([c.load('u1', 'a'), c.load('u1', 'b'), c.load('u1', 'a'), c.load('u2', 'a')]);
  assert.deepEqual(r, ['u1:a', 'u1:b', 'u1:a', 'u2:a']);
  assert.deepEqual(calls.map(([s, ids]) => [s, ids.sort()]), [['u1', ['a', 'b']], ['u2', ['a']]]);
  assert.equal(c.stats.merged, 2);
  calls.length = 0;
  await Promise.all(['a', 'b', 'c', 'd'].map((x) => c.load('u3', x)));
  assert.equal(calls[0][1].length, 3, 'maxBatch 触发立即发出');
  const bad = new RequestCoalescer({ windowMs: 5, batchFn: async () => { throw new Error('db down'); } });
  await assert.rejects(bad.load('s', 'x'), /db down/);
  const missing = new RequestCoalescer({ windowMs: 5, batchFn: async () => new Map() });
  assert.equal(await missing.load('s', 'x'), null);
});

test('PokemonBatchService：单连接批量查询 + include 聚合 + 未找到进 errors', async () => {
  const db = fakeDb();
  const svc = new PokemonBatchService({ query: db.query, getClient: db.getClient, redis: fakeRedis(), register: new promClient.Registry() });
  const ids = [id(1), id(2), id(99)];
  const out = await svc.getBatchDetails(ids, { userId: UID, include: ['skills', 'equipment', 'effects', 'battle', 'history'] });
  assert.deepEqual(Object.keys(out.results), [id(1), id(2)]);
  assert.equal(out.errors[id(99)].code, 'NOT_FOUND');
  assert.equal(db.connections(), 1, '整批只占用 1 个数据库连接');
  assert.equal(out.metadata.dbQueries, 5, '主查询 1 + skills/equipment/battle/history 各 1（effects 由字段推导）');
  const p1 = out.results[id(1)];
  assert.equal(p1.skills.selected.fast, 'TACKLE');
  assert.equal(p1.skills.fast.length, 2);
  assert.equal(p1.equipment[0].name_zh, '护符');
  assert.ok(p1.effects.find((e) => e.type === 'fatigue'));
  assert.equal(p1.battle.won, 3);
  assert.equal(out.results[id(2)].battle.won, 0);
  assert.equal(p1.history[0].type, 'friendship');
  assert.equal(p1.history[1].type, 'caught');
  assert.equal(out.metadata.partial, false);
  // 100 个 id 仍是 1 个连接：相对逐个查询减少 99% 的连接
  const many = await svc.getBatchDetails(Array.from({ length: 100 }, (_, i) => id(i + 1)), { userId: UID });
  assert.equal(many.metadata.requested, 100);
  assert.equal(many.metadata.dbConnections, 1);
});

test('PokemonBatchService：缓存按用户+版本隔离，重复查询命中；部分 include 失败降级；参数校验', async () => {
  const db = fakeDb();
  const redis = fakeRedis();
  const svc = new PokemonBatchService({ query: db.query, getClient: db.getClient, redis, register: new promClient.Registry() });
  await svc.getBatchDetails([id(1), id(2)], { userId: UID, include: ['battle'] });
  const again = await svc.getBatchDetails([id(1), id(2)], { userId: UID, include: ['battle'] });
  assert.equal(again.metadata.cached, 2);
  assert.equal(again.metadata.cacheHitRate, 1);
  assert.equal(again.metadata.dbQueries, 0);
  redis.kv.set(`cache:ver:${UID}`, '7'); // 用户写操作后版本 +1
  const afterWrite = await svc.getBatchDetails([id(1)], { userId: UID, include: ['battle'] });
  assert.equal(afterWrite.metadata.cached, 0, '版本变化后旧缓存失效');
  const only = await svc.getBatchDetails([id(3)], { userId: UID, cacheStrategy: 'only' });
  assert.equal(only.errors[id(3)].code, 'CACHE_MISS');
  const failing = fakeDb({ failInclude: 'player_equipment' });
  const svc2 = new PokemonBatchService({ query: failing.query, getClient: failing.getClient, register: new promClient.Registry() });
  const partial = await svc2.getBatchDetails([id(1)], { userId: UID, include: ['equipment', 'battle'] });
  assert.equal(partial.metadata.partial, true);
  assert.deepEqual(partial.metadata.failedIncludes, ['equipment']);
  assert.deepEqual(partial.results[id(1)]._missing, ['equipment']);
  assert.equal(partial.results[id(1)].battle.won, 3, '其余 include 正常返回');
  assert.throws(() => PokemonBatchService.validate(Array.from({ length: 101 }, (_, i) => id(i))), /最多 100/);
  assert.throws(() => PokemonBatchService.validate(['not-uuid']), /UUID/);
  assert.throws(() => PokemonBatchService.validate([id(1)], ['bogus']), /include/);
  assert.deepEqual(PokemonBatchService.validate([id(1).toUpperCase(), id(1)], 'battle,skills'), { ids: [id(1)], include: ['battle', 'skills'] });
});

test('PokemonBatchService：详情请求 50ms 窗口合并；预取命中计入准确率', async () => {
  const db = fakeDb();
  const redis = fakeRedis();
  const svc = new PokemonBatchService({ query: db.query, getClient: db.getClient, redis, register: new promClient.Registry(), windowMs: 30 });
  const before = db.calls.filter((c) => c.startsWith('SELECT pi.*')).length;
  const rows = await Promise.all([id(1), id(2), id(3), id(1)].map((x) => svc.getDetail(x, UID)));
  assert.equal(rows.filter(Boolean).length, 4);
  assert.equal(db.calls.filter((c) => c.startsWith('SELECT pi.*')).length - before, 1, '4 个并发详情请求只查一次数据库');
  assert.equal(await svc.getDetail('bad', UID), null);
  const n = await svc.prefetch(UID, [id(4), id(5), id(6)]);
  assert.equal(n, 3);
  await svc.getDetail(id(4), UID);
  await svc.getDetail(id(5), UID);
  await svc.getDetail(id(4), UID); // 第二次不重复计命中
  const st = await svc.prefetchStats();
  assert.deepEqual([st.prefetched, st.hits, st.accuracy], [3, 2, 0.6667]);
});

test('ApiResponse：success/created/list/paginated/withLinks/hal/error 格式（REQ-00386/518）', () => {
  const mk = (url = '/v1/pokemon/my?page=2&pageSize=2') => {
    const res = { req: { originalUrl: url, url, headers: { 'x-request-id': 'r1' }, query: Object.fromEntries(new URL(`http://x${url}`).searchParams) }, locals: {}, headers: {} };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.send = () => res;
    res.type = (t) => { res.headers['content-type'] = t; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    return res;
  };
  const s = ApiResponse.success(mk(), { id: 1 });
  assert.deepEqual([s.body.success, s.body.code, s.body.data.id, s.body.meta.requestId], [true, 0, 1, 'r1']);
  assert.equal(ApiResponse.created(mk(), {}).statusCode, 201);
  assert.equal(ApiResponse.noContent(mk()).statusCode, 204);
  const l = ApiResponse.list(mk(), [1, 2, 3]);
  assert.deepEqual([l.body.pagination.total, l.body.pagination.hasNext], [3, false]);
  const p = ApiResponse.paginated(mk(), [{ id: 3 }, { id: 4 }], { page: 2, pageSize: 2, total: 9 });
  assert.deepEqual([p.body.pagination.totalPages, p.body.meta.pagination.page], [5, 2]);
  assert.equal(p.body._links.next.href, '/v1/pokemon/my?page=3&pageSize=2');
  assert.match(p.headers.Link, /rel="last"/);
  const w = ApiResponse.withLinks(mk('/v1/pokemon/my/p1'), { id: 'p1', species_id: 3, user_id: UID }, 'pokemon');
  assert.equal(w.body._links.powerUp.method, 'POST');
  const pw = ApiResponse.paginatedWithLinks(mk(), [{ id: 'p1' }], 'pokemon', { page: 1, pageSize: 1, total: 1 });
  assert.equal(pw.body.data[0]._links.self.href, '/v1/pokemon/my/p1');
  const h = ApiResponse.hal(mk('/v1/gyms/g1'), { id: 'g1', name: 'x' }, 'gym');
  assert.equal(h.headers['content-type'], 'application/hal+json');
  assert.equal(h.body._links.defend.href, '/v1/gyms/g1/defend');
  const e = ApiResponse.error(mk(), 'NOT_FOUND', { message: '没有' });
  assert.deepEqual([e.statusCode, e.body.success, e.body.error.name, e.body.error.i18nKey], [404, false, 'NOT_FOUND', 'errors.general.not_found']);
});

test('errorHandler：AppError 映射到 HTTP 状态码，错误响应格式 { success:false, error:{ code, message, i18nKey, docUrl }, meta }（REQ-00386）', async () => {
  const { AppError, errorHandler, notFoundHandler, asyncHandler } = require('../../shared/middleware/errorHandler');
  const mkRes = () => {
    const res = { locals: { requestId: 'req-1' }, headersSent: false };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  };
  for (const [name, status] of [['RESOURCE_NOT_FOUND', 404], ['VALIDATION_ERROR', 400], ['RATE_LIMIT_EXCEEDED', 429], ['CONFLICT', 409], ['USER_AUTH_TOKEN_EXPIRED', 401]]) {
    const err = new AppError(name, { id: 1 });
    assert.equal(err.httpStatus, status, name);
    const res = mkRes();
    errorHandler(err, { path: '/x', method: 'GET' }, res, () => assert.fail('不应调用 next'));
    assert.equal(res.statusCode, status);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, name);
    assert.ok(res.body.error.i18nKey && res.body.error.docUrl);
    assert.deepEqual(res.body.error.details, { id: 1 });
    assert.equal(res.body.meta.requestId, 'req-1');
  }
  assert.throws(() => new AppError('NO_SUCH_CODE'), /Unknown error code/);
  const nf = mkRes();
  notFoundHandler({ method: 'GET', path: '/nope' }, nf);
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.body.error.details.path, '/nope');
  let passed = null;
  await asyncHandler(async () => { throw new AppError('CONFLICT'); })({}, {}, (e) => { passed = e; });
  assert.equal(passed.httpStatus, 409);
});
