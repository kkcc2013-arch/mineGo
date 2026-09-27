// Epic E25 —— 网关转换管道集成单测：进程内 Express 应用挂载真实中间件（createApiStandards + 流式压缩），
// 用假的"下游"处理器验证 406/415/410、错误统一、分页、HATEOAS、字段投影、别名、HAL、msgpack、契约校验、
// 版本转换、弃用头、缓存命中、大响应透传、fail-open（REQ-00542/368/554/386/302/465/518/532/251/315/547/201/407/526）
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const express = require('express');

const { createApiStandards } = require('../../shared/apiStandards');
const { createStreamingCompression } = require('../../shared/apiStandards/streamingCompression');
const { PipelineEngine, TransformerRegistry, LRUCache } = require('../../shared/apiStandards/pipeline');
const { VersionRegistry } = require('../../shared/apiStandards/versioning');
const msgpack = require('../../shared/apiStandards/msgpack');

const PID = '0a1b2c3d-0000-4000-8000-000000000001';
const UID = 'f908286b-27bf-4174-8cd8-4fb952877b58';

function pokemonRows(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `0a1b2c3d-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, species_id: i + 1, nickname: null, cp: 500 - i, iv_attack: 1, iv_defense: 2, iv_hp: 3, is_shiny: false, name_zh: '皮卡丘', sprite_url: '/s.png', rarity: 'COMMON', password: 'leak' }));
}

function buildApp({ schemaMode = 'enforce', deprecations = [], versions } = {}) {
  const versionRegistry = new VersionRegistry({ versions: versions || { 1: { status: 'stable', successor: 2 }, 2: { status: 'stable' } }, currentVersion: 2 });
  const std = createApiStandards({ versionRegistry, config: { schemaValidation: { mode: schemaMode, sampleRate: 1 }, refreshIntervalMs: 0, maxBufferBytes: 64 * 1024 } });
  std.deprecations.setAll(deprecations);
  const app = express();
  app.use(createStreamingCompression({ threshold: 512, skip: (req, res) => res.locals && res.locals.compress === false }));
  app.use(std.middleware());
  app.use((req, res, next) => { req.apiVersion = VersionRegistry.extractPathVersion(req.path) || 2; next(); });
  // ── 假下游 ──
  app.get('/v1/pokemon/my', (req, res) => {
    const limit = Number(req.query.limit || 30), offset = Number(req.query.offset || 0);
    let all = pokemonRows(45);
    if (req.query.fields === 'id,cp') { // 模拟下游按 ?fields 只查部分列（REQ-00532）
      res.setHeader('X-DB-Projection', 'id,cp');
      all = all.map(({ id, cp }) => ({ id, cp }));
    }
    res.json({ success: true, code: 0, message: 'ok', data: { pokemon: all.slice(offset, offset + limit), total: all.length, limit, offset }, timestamp: new Date().toISOString() });
  });
  app.get('/v1/pokemon/my/:id', (req, res) => {
    if (req.params.id === 'badshape') return res.json({ success: true, code: 0, data: { id: 'not-a-uuid', species_id: 'x' } });
    res.json({ success: true, code: 0, message: 'ok', data: { id: req.params.id, user_id: UID, species_id: 25, cp: 300, nickname: null, iv_attack: 1, iv_defense: 2, iv_hp: 3, is_shiny: false, evolves_to: 26, candy_to_evolve: 50, candy_count: 80 } });
  });
  app.get('/v1/users/me', (req, res) => res.json({ success: true, code: 0, message: 'ok', data: { id: UID, nickname: 'ash', level: 5, xp: '100', avatar_url: null, team: null, password_hash: 'x' } }));
  app.get('/api/v1/users/:id/profile', (req, res) => res.json({ success: true, code: 0, data: { id: req.params.id, nickname: 'ash', stats: { catches: 3 }, achievements: [1] } }));
  app.get('/v1/nope', (req, res) => res.status(404).json({ code: 1005, message: '路由不存在', data: null }));
  app.get('/v1/legacy-error', (req, res) => res.status(400).json({ error: 'Guild not found' }));
  app.get('/v1/throttled', (req, res) => { res.setHeader('RateLimit-Reset', '17'); res.status(429).json({ code: 6003, message: '太快了' }); });
  app.get('/v1/map/nearby', (req, res) => res.json({ success: true, code: 0, message: 'ok', data: { wildPokemons: [{ id: 'w1', species_id: 25, lat: '31.2', lng: '121.5', cp: 10, is_shiny: false, expires_at: '2026-09-25T00:00:00Z' }], pokestops: [{ id: 'ps1', lat: '31.2', lng: '121.5', can_spin: true }], gyms: [{ id: 'g1', lat: '31.2', lng: '121.5' }] } }));
  app.get('/v1/pokemon/pokedex', (req, res) => (req.query.fail ? res.status(404).json({ code: 1005, message: 'nope', data: null }) : res.json({ success: true, code: 0, data: { entries: pokemonRows(20) } })));
  app.get('/v1/big', (req, res) => res.json({ success: true, code: 0, data: { blob: 'x'.repeat(100 * 1024) } }));
  app.get('/v1/text', (req, res) => res.type('text/plain').send('plain'));
  app.get('/v1/ndjson', (req, res) => { res.setHeader('Content-Type', 'application/x-ndjson'); res.write('{"a":1}\n'); setTimeout(() => res.end('{"a":2}\n'), 30); });
  app.post('/v1/echo', express.json(), (req, res) => res.json({ success: true, code: 0, data: req.body }));
  app.get('/v1/rewards/daily', (req, res) => res.json({ success: true, code: 0, data: { claimed: false, streak: 1 } }));
  return { app, std };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function call(base, path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(base + path, { method, headers: { 'accept-encoding': 'identity', ...headers }, body });
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  let json = null;
  if (/json/.test(ct)) { try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; } }
  return { status: res.status, headers: res.headers, buf, json };
}

test('网关管道：进程内端到端行为', async (t) => {
  const { app, std } = buildApp({
    deprecations: [
      { id: 1, endpoint: '/v1/rewards/daily', method: 'GET', deprecated_at: new Date(Date.now() - 86400000), sunset_at: new Date(Date.now() + 10 * 86400000), successor_endpoint: '/v2/rewards/daily', breaking_changes: [{ field: 'streak', change: 'renamed to streakDays' }], status: 'active' },
      { id: 2, endpoint: '/v1/echo', method: 'POST', deprecated_at: new Date(Date.now() - 2 * 86400000), sunset_at: new Date(Date.now() - 1000), successor_endpoint: '/v2/echo', status: 'active' },
    ],
  });
  const { server, base } = await listen(app);
  t.after(() => server.close());

  await t.test('成功响应：保留 code/message/data，补 success/meta/_links；全局剥离密码字段', async () => {
    const r = await call(base, '/v1/users/me');
    assert.equal(r.status, 200);
    assert.equal(r.json.code, 0);
    assert.equal(r.json.data.nickname, 'ash');
    assert.equal(r.json.data.password_hash, undefined);
    assert.ok(r.json.meta.timestamp && r.json.meta.apiVersion === 1, '旧前缀 /v1 视为 v1');
    assert.equal(r.json._links.self.href, '/v1/users/me');
    assert.ok(r.json._links.inventory, '当前用户资源带操作链接');
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.match(r.headers.get('vary'), /Accept/);
    assert.match(r.headers.get('x-schema-validation'), /^pass; contract=users\.me/);
    assert.ok(r.headers.get('x-pipeline'));
  });

  await t.test('错误统一：网关旧格式 / 旧字符串 error / 429 Retry-After', async () => {
    const nf = await call(base, '/v1/nope');
    assert.equal(nf.status, 404);
    assert.equal(nf.json.code, 1005);
    assert.equal(nf.json.success, false);
    assert.equal(nf.json.error.name, 'NOT_FOUND');
    assert.equal(nf.json._links.help.href, '/api/errors/NOT_FOUND');
    const lg = await call(base, '/v1/legacy-error', { headers: { 'accept-language': 'zh-CN' } });
    assert.equal(lg.json.error, 'Guild not found');
    assert.equal(lg.json.errorInfo.name, 'INVALID_REQUEST');
    assert.equal(lg.json.errorInfo.localizedMessage, '请求参数无效');
    const rl = await call(base, '/v1/throttled');
    assert.equal(rl.json.code, 6003);
    assert.equal(rl.headers.get('retry-after'), '17');
    assert.equal(rl.json.error.retryAfter, 17);
    assert.equal(rl.json.error.retryable, true);
  });

  await t.test('内容协商：406 / msgpack / vnd 版本类型 / protobuf 回退 JSON', async () => {
    const na = await call(base, '/v1/users/me', { headers: { accept: 'text/csv' } });
    assert.equal(na.status, 406);
    assert.equal(na.json.error.name, 'NOT_ACCEPTABLE');
    assert.ok(na.json.error.details.supported.includes('application/x-msgpack'));
    const mp = await call(base, '/v1/users/me', { headers: { accept: 'application/x-msgpack' } });
    assert.equal(mp.headers.get('content-type'), 'application/x-msgpack');
    const decoded = msgpack.decode(mp.buf);
    assert.equal(decoded.data.nickname, 'ash');
    const js = await call(base, '/v1/users/me');
    assert.ok(mp.buf.length < js.buf.length, 'msgpack 体积更小');
    const vnd = await call(base, '/v1/users/me', { headers: { accept: 'application/vnd.minego.user.v1+json' } });
    assert.equal(vnd.headers.get('content-type'), 'application/vnd.minego.user.v1+json; charset=utf-8');
    const pb = await call(base, '/v1/users/me', { headers: { accept: 'application/x-protobuf' } });
    assert.equal(pb.status, 200);
    assert.match(pb.headers.get('x-content-fallback'), /x-protobuf -> application\/json/);
  });

  await t.test('Content-Type 校验：缺失/非法 → 415，JSON 通过', async () => {
    const miss = await fetch(`${base}/v1/rewards/daily`, { method: 'POST', body: Buffer.from('a=1'), headers: { 'content-type': '' } });
    assert.equal(miss.status, 415);
    const txt = await call(base, '/v1/echo', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' });
    assert.equal(txt.status, 415);
    assert.equal(txt.json.error.name, 'UNSUPPORTED_MEDIA_TYPE');
  });

  await t.test('分页：list 形态自动补 pagination + meta.pagination + _links + Link 头；page/pageSize 映射下游 limit/offset', async () => {
    const r = await call(base, '/v1/pokemon/my?page=2&pageSize=10&sort=cp');
    assert.equal(r.json.data.pokemon.length, 10);
    assert.equal(r.json.data.offset, 10, '下游收到 offset=10');
    assert.deepEqual([r.json.pagination.page, r.json.pagination.total, r.json.pagination.totalPages, r.json.pagination.hasNext, r.json.pagination.hasPrev], [2, 45, 5, true, true]);
    assert.deepEqual(r.json.meta.pagination, r.json.pagination);
    assert.equal(r.json._links.next.href, '/v1/pokemon/my?page=3&pageSize=10&sort=cp');
    assert.equal(r.json._links.last.href, '/v1/pokemon/my?page=5&pageSize=10&sort=cp');
    assert.match(r.headers.get('link'), /rel="next"/);
    assert.equal(r.headers.get('x-total-count'), '45');
    assert.equal(r.json.data.pokemon[0]._links.self.href, `/v1/pokemon/my/${r.json.data.pokemon[0].id}`);
    assert.equal(r.json.data.pokemon[0].password, undefined);
    const bad = await call(base, '/v1/pokemon/my?page=0');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.name, 'INVALID_PAGINATION');
    const last = await call(base, '/v1/pokemon/my?page=5&pageSize=10');
    assert.equal(last.json.pagination.hasNext, false);
    assert.equal(last.json._links.next, undefined);
  });

  await t.test('HATEOAS：精灵详情含 evolve/powerUp/trainer/species 链接', async () => {
    const r = await call(base, `/v1/pokemon/my/${PID}`);
    const l = r.json._links;
    assert.equal(l.self.href, `/v1/pokemon/my/${PID}`);
    assert.deepEqual([l.evolve.href, l.evolve.method], [`/v1/pokemon/my/${PID}/evolve`, 'POST']);
    assert.equal(l.trainer.href, `/v1/users/${UID}`);
    assert.equal(l.species.href, '/v1/pokemon/species/25');
    assert.equal(l.discover.href, '/api/discover');
    const near = await call(base, '/v1/map/nearby?lat=31.2&lng=121.5');
    assert.equal(near.json.data.wildPokemons[0]._links.catch.method, 'POST');
    assert.equal(near.json.data.pokestops[0]._links.spin.href, '/v1/pokestops/ps1/spin');
    assert.equal(near.json.data.gyms[0]._links.defend.href, '/v1/gyms/g1/defend');
    const hal = await call(base, `/v1/pokemon/my/${PID}`, { headers: { accept: 'application/hal+json' } });
    assert.equal(hal.json.id, PID);
    assert.ok(hal.json._links.evolve);
    assert.equal(hal.headers.get('content-type'), 'application/hal+json; charset=utf-8');
  });

  await t.test('字段投影：fields / fieldset / 嵌套；超上限、未知字段集、严格契约未知字段 → 400', async () => {
    const r = await call(base, '/v1/pokemon/my?fields=id,cp');
    assert.equal(r.status, 200, '下游部分列响应不触发契约强制校验 500');
    assert.match(r.headers.get('x-schema-validation'), /reason=db-projection/);
    assert.deepEqual(Object.keys(r.json.data.pokemon[0]).sort(), ['_links', 'cp', 'id']);
    assert.equal(r.json.data.total, 45, '容器字段保留');
    assert.equal(r.json.pagination.total, 45);
    const fs = await call(base, '/v1/pokemon/my?fieldset=list');
    assert.ok(fs.json.data.pokemon[0].cp !== undefined && fs.json.data.pokemon[0].iv_attack === undefined);
    const me = await call(base, '/v1/users/me?fields=id,nickname');
    assert.deepEqual(Object.keys(me.json.data).sort(), ['id', 'nickname']);
    assert.equal(me.json.code, 0);
    const tooMany = await call(base, `/v1/users/me?fields=${Array.from({ length: 51 }, (_, i) => `f${i}`).join(',')}`);
    assert.equal(tooMany.status, 400);
    const unknownSet = await call(base, '/v1/pokemon/my?fieldset=nope');
    assert.equal(unknownSet.status, 400);
    assert.ok(unknownSet.json.error.details.available.includes('list'));
    const strict = await call(base, '/v1/pokemon/my?fields=id,secretSauce');
    assert.equal(strict.status, 400);
    assert.ok(strict.json.error.details.allowedFields.includes('cp'));
    const sensitive = await call(base, '/v1/users/me?fields=id,password_hash');
    assert.deepEqual(Object.keys(sensitive.json.data), ['id']);
  });

  await t.test('别名压缩：_aliases=1 → data 键 ≤3 字符并附别名表', async () => {
    const r = await call(base, '/v1/pokemon/my?_aliases=1&pageSize=5');
    assert.equal(r.headers.get('x-field-aliases'), '1');
    const alias = r.json._aliases;
    assert.ok(Object.keys(alias).every((k) => k.length <= 3));
    const firstKey = Object.keys(r.json.data)[0];
    assert.ok(alias[firstKey]);
    assert.equal(r.json.code, 0, '信封字段不压缩');
  });

  await t.test('契约校验（enforce）：不符合契约的响应被替换为 500 RESPONSE_SCHEMA_VIOLATION', async () => {
    const r = await call(base, '/v1/pokemon/my/badshape');
    assert.equal(r.status, 500);
    assert.equal(r.json.error.name, 'RESPONSE_SCHEMA_VIOLATION');
    assert.equal(r.json.error.details.contract, 'pokemon.my.detail');
    assert.ok(std.violations.length >= 1);
  });

  await t.test('版本转换：v1 用户资料去掉 v2 新增字段', async () => {
    const r = await call(base, `/api/v1/users/${UID}/profile`);
    assert.equal(r.json.data.stats, undefined);
    assert.equal(r.json.data.achievements, undefined);
    assert.equal(r.headers.get('x-api-transformed'), 'v1-user-profile-legacy');
  });

  await t.test('弃用：Deprecation/Sunset/Link successor 头 + 响应体 deprecation；过了 Sunset → 410', async () => {
    const r = await call(base, '/v1/rewards/daily', { headers: { 'x-client-id': 'game-client-web', 'x-client-version': '1.0.0' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('deprecation'), /^@\d+$/);
    assert.ok(new Date(r.headers.get('sunset')).getTime() > Date.now());
    assert.match(r.headers.get('link'), /<\/v2\/rewards\/daily>; rel="successor-version"/);
    assert.equal(r.json.deprecation.successorApi, '/v2/rewards/daily');
    assert.ok(r.json.deprecation.daysRemaining >= 9);
    assert.equal(r.json.deprecation.migrationGuide, '/api/deprecations/1/migration-guide');
    const pending = [...std.deprecations.pending.values()].find((p) => p.clientId === 'game-client-web');
    assert.equal(pending.clientVersion, '1.0.0');
    const gone = await call(base, '/v1/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    assert.equal(gone.status, 410);
    assert.equal(gone.json.error.name, 'API_SUNSET');
    assert.equal(gone.json.error.details.successorApi, '/v2/echo');
  });

  await t.test('纯阶段结果缓存：相同上游响应第二次命中（X-Pipeline-Cached）', async () => {
    const a = await call(base, '/v1/rewards/daily?x=1');
    const b = await call(base, '/v1/rewards/daily?x=1');
    // daily 每次返回相同 body（无时间戳）→ 第二次命中
    assert.equal(a.headers.get('x-pipeline-cached'), 'false');
    assert.equal(b.headers.get('x-pipeline-cached'), 'true');
    assert.ok(b.json.meta.timestamp, '命中缓存后仍逐请求注入 meta');
    const stats = std.engine.getStats('default');
    assert.ok(stats.cacheHits >= 1);
  });

  await t.test('大响应透传（>maxBufferBytes 不缓冲）、非 JSON 透传、ndjson 流式透传', async () => {
    const big = await call(base, '/v1/big');
    assert.equal(big.status, 200);
    assert.match(big.headers.get('x-pipeline'), /passthrough=size/);
    assert.equal(big.json.data.blob.length, 100 * 1024);
    const txt = await call(base, '/v1/text');
    assert.equal(txt.buf.toString(), 'plain');
    const nd = await call(base, '/v1/ndjson');
    assert.equal(nd.buf.toString(), '{"a":1}\n{"a":2}\n');
    assert.ok(std.engine.getStats('default').streamingCount >= 1);
  });

  await t.test('压缩：br 优先、小响应不压缩、Vary 含 Accept-Encoding', async () => {
    const res = await fetch(`${base}/v1/pokemon/my?pageSize=30`, { headers: { 'accept-encoding': 'gzip, br' } });
    assert.equal(res.headers.get('content-encoding'), 'br');
    assert.match(res.headers.get('vary'), /Accept-Encoding/);
    const body = await res.json();
    assert.equal(body.data.pokemon.length, 30);
    const small = await fetch(`${base}/v1/nope`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(small.headers.get('content-encoding'), null);
  });
});

test('fail-open：阶段抛错时跳过该阶段，请求仍成功', async () => {
  const { app, std } = buildApp();
  std.transformerRegistry.register('boom', { phase: 'response', pure: true, handler: () => { throw new Error('boom'); } });
  const def = std.engine.get('default');
  std.engine.define('default', { ...std.engine.describe(def), stages: [{ transformer: 'boom' }, ...def.stages] });
  const { server, base } = await listen(app);
  try {
    const r = await call(base, '/v1/users/me');
    assert.equal(r.status, 200);
    assert.equal(r.json.data.nickname, 'ash');
    assert.ok(std.engine.getStats('default').errors >= 1);
  } finally { server.close(); }
});

test('PipelineEngine：DSL 加载、路由选择按具体程度、非法配置拒绝、声明式转换器', async () => {
  const reg = new TransformerRegistry();
  reg.register('addA', { phase: 'response', pure: true, handler: (ctx) => { ctx.body.a = 1; } });
  const engine = new PipelineEngine({ registry: reg, cache: new LRUCache({ max: 10 }) });
  const names = engine.loadConfig(`pipelines:
  default:
    metadata:
      route: "*"
    stages:
      - transformer: addA
  pokemon-detail:
    metadata:
      route: "/v1/pokemon/my/:id"
      method: GET
    stages:
      - transformer: addA
`);
  assert.deepEqual(names, ['default', 'pokemon-detail']);
  assert.equal(engine.select({ method: 'GET', path: '/v1/pokemon/my/abc' }).name, 'pokemon-detail');
  assert.equal(engine.select({ method: 'POST', path: '/v1/pokemon/my/abc' }).name, 'default');
  assert.throws(() => engine.define('bad', { stages: [{ transformer: 'nope' }] }), /不存在的转换器/);
  assert.throws(() => engine.define('bad', { stages: [{ transformer: 'addA', phase: 'request' }] }), /只能用于 response/);
  assert.throws(() => engine.remove('default'), /不能删除/);
  reg.registerDeclarative('renameNick', { type: 'renameFields', config: { map: { nickname: 'nick' } } });
  assert.throws(() => reg.registerDeclarative('x', { type: 'eval' }), /不支持/);
  engine.define('renamer', { metadata: { route: '/r' }, stages: [{ transformer: 'renameNick' }] });
  const ctx = { req: { path: '/r' }, pipeline: engine.get('renamer'), status: 200, body: { data: { nickname: 'n' } }, headers: new Map(), state: {}, setHeader() {}, rawHash: 'h', variantKey: 'v' };
  await engine.runResponse(engine.get('renamer'), ctx);
  assert.deepEqual(ctx.body.data, { nick: 'n' });
  const ctx2 = { ...ctx, body: { data: { nickname: 'n' } }, headers: new Map(), state: {} };
  const r2 = await engine.runResponse(engine.get('renamer'), ctx2);
  assert.equal(r2.cached, true);
  assert.equal(engine.getStats('renamer').cacheHitRate, 0.5);
  assert.equal(engine.clearCache('renamer') >= 1, true);
});

test('YAML 管道配置（config/pipelines）：按路由选择；streaming 管道成功响应透传、错误响应仍按 default 统一（REQ-00542）', async () => {
  const { app, std } = buildApp();
  assert.deepEqual(['large-response', 'species-stream', 'pokemon-detail'].map((n) => !!std.engine.get(n)), [true, true, true]);
  assert.equal(std.engine.select({ method: 'GET', path: '/v1/pokemon/my/abc' }).name, 'pokemon-detail');
  const { server, base } = await listen(app);
  try {
    const ok = await call(base, '/v1/pokemon/pokedex');
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('x-pipeline'), /^large-response; passthrough/);
    assert.equal(ok.json.meta, undefined, '透传：不做响应阶段转换');
    const err = await call(base, '/v1/pokemon/pokedex?fail=1');
    assert.equal(err.status, 404);
    assert.equal(err.json.error.name, 'NOT_FOUND');
    assert.match(err.headers.get('x-pipeline'), /^default/);
  } finally { server.close(); }
});
