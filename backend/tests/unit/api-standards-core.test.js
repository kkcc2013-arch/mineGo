// Epic E25 API 设计规范 —— 核心模块单元测试（直接 require 业务模块）
// msgpack / 内容协商 / 字段投影与别名压缩 / 分页 / HATEOAS / 错误目录
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const msgpack = require('../../shared/apiStandards/msgpack');
const media = require('../../shared/apiStandards/mediaTypes');
const fp = require('../../shared/apiStandards/fieldProjection');
const pg = require('../../shared/apiStandards/pagination');
const hateoas = require('../../shared/apiStandards/hateoas');
const errors = require('../../shared/apiStandards/errorCatalog');
const ErrorCodes = require('../../shared/errors/ErrorCodes');

const samplePokemonList = () => Array.from({ length: 50 }, (_, i) => ({
  id: `0000000${i}-0000-4000-8000-00000000000${i % 10}`.slice(-36).padStart(36, '0'),
  species_id: i + 1, nickname: null, cp: 100 + i * 17, hp_current: 50, hp_max: 50,
  iv_attack: i % 16, iv_defense: (i * 3) % 16, iv_hp: (i * 7) % 16, iv_pct: '66.7', is_shiny: i % 9 === 0,
  is_lucky: false, is_favorite: false, power_up_count: 0, fast_move: 'TACKLE', charge_move: 'BODY_SLAM',
  caught_at: '2026-09-20T10:00:00.000Z', name_zh: '妙蛙种子', name_en: 'Bulbasaur', type1: 'GRASS', type2: 'POISON',
  sprite_url: `/sprites/${i + 1}.png`, sprite_shiny_url: null, rarity: 'UNCOMMON', defending_gym_id: null,
}));

// ── msgpack ─────────────────────────────────────────────────
test('msgpack：往返一致（整数边界/浮点/字符串/嵌套/空值/二进制）', () => {
  const v = {
    a: 1, b: -1, c: -33, d: 255, e: 65535, f: 2 ** 32 + 5, g: -(2 ** 31) - 3, h: 1.5, i: 'x'.repeat(40), j: '中文',
    k: [1, [2, [3]]], l: null, m: true, n: false, o: {}, p: [], q: 'y'.repeat(70000), r: Buffer.from([1, 2, 3]),
  };
  const out = msgpack.decode(msgpack.encode(v));
  assert.deepEqual({ ...out, r: undefined }, { ...v, r: undefined });
  assert.deepEqual([...out.r], [1, 2, 3]);
  assert.equal(msgpack.decode(msgpack.encode(NaN)), null);
  assert.throws(() => msgpack.decode(Buffer.from([0xc1])), /unsupported/);
});

test('msgpack：精灵列表比 JSON 体积小 >= 30%（REQ-00554 验收）', () => {
  const body = { success: true, code: 0, data: { pokemon: samplePokemonList(), total: 50 } };
  const json = Buffer.byteLength(JSON.stringify(body));
  const mp = msgpack.encode(body).length;
  // 纯二进制编码对字符串为主的数据约省 15-25%，配合别名压缩后 > 30%
  const aliased = msgpack.encode(fp.packAliased(body)).length;
  assert.ok(mp < json, `msgpack ${mp} < json ${json}`);
  assert.ok(1 - aliased / json >= 0.3, `msgpack+别名节省 ${(100 * (1 - aliased / json)).toFixed(1)}%`);
});

// ── 内容协商 ─────────────────────────────────────────────────
test('parseAccept：按 q 值 → 具体程度 → 出现顺序排序', () => {
  const r = media.parseAccept('text/*;q=0.5, application/json;q=0.8, application/x-msgpack, */*;q=0.1');
  assert.deepEqual(r.map((x) => x.full), ['application/x-msgpack', 'application/json', 'text/*', '*/*']);
  assert.equal(media.parseAccept('garbage').length, 0);
});

test('negotiate：默认 JSON(charset)、q 值优先级、msgpack、厂商版本类型、406、protobuf 回退', () => {
  const reg = media.createDefaultRegistry();
  assert.equal(media.negotiate(undefined, reg).contentType, 'application/json; charset=utf-8');
  assert.equal(media.negotiate('', reg).mediaType, 'application/json');
  assert.equal(media.negotiate('*/*', reg).mediaType, 'application/json');
  assert.equal(media.negotiate('application/x-msgpack', reg).mediaType, 'application/x-msgpack');
  assert.equal(media.negotiate('application/x-msgpack', reg).contentType, 'application/x-msgpack');
  assert.equal(media.negotiate('application/json;q=0.5, application/x-msgpack;q=0.9', reg).mediaType, 'application/x-msgpack');
  assert.equal(media.negotiate('application/x-msgpack;q=0.2, application/json', reg).mediaType, 'application/json');
  const vnd = media.negotiate('application/vnd.minego.pokemon.v1+json', reg);
  assert.equal(vnd.mediaType, 'application/vnd.minego.pokemon.v1+json');
  assert.equal(vnd.version, 1);
  assert.equal(vnd.resource, 'pokemon');
  assert.match(vnd.contentType, /charset=utf-8/);
  assert.equal(media.negotiate('text/html, application/xml;q=0.9, */*;q=0.8', reg).mediaType, 'application/json');
  assert.equal(media.negotiate('text/csv', reg).notAcceptable, true);
  assert.equal(media.negotiate('application/json;q=0', reg).notAcceptable, true);
  const fb = media.negotiate('application/x-protobuf', reg);
  assert.equal(fb.fallback, true);
  assert.equal(fb.mediaType, 'application/json');
  assert.equal(media.negotiate('application/*', reg).mediaType, 'application/json');
});

test('MediaTypeRegistry：注册 / 查询 / 弃用 / 注销', () => {
  const reg = new media.MediaTypeRegistry();
  reg.register('application/json');
  reg.register('application/vnd.test+json', { priority: 5 });
  assert.ok(reg.get('application/vnd.test+json'));
  assert.equal(reg.deprecate('application/vnd.test+json', { replacement: 'application/json' }).deprecated, true);
  assert.equal(reg.list().find((x) => x.mediaType === 'application/vnd.test+json').replacement, 'application/json');
  assert.equal(reg.unregister('application/vnd.test+json'), true);
  assert.equal(reg.get('application/vnd.test+json'), null);
  assert.throws(() => reg.register('not a type'), /invalid media type/);
});

test('checkContentType：缺失/非法/非 UTF-8/不支持 → 拒绝；JSON、+json、空 body 放行', () => {
  const r = (method, headers) => media.checkContentType({ method, headers });
  assert.equal(r('POST', { 'content-length': '10' }).reason, 'missing');
  assert.equal(r('POST', { 'content-length': '10', 'content-type': 'text/plain' }).reason, 'unsupported');
  assert.equal(r('POST', { 'content-length': '10', 'content-type': '*/*' }).reason, 'invalid');
  assert.equal(r('PUT', { 'content-length': '10', 'content-type': 'application/json; charset=latin1' }).reason, 'unsupported');
  assert.equal(r('POST', { 'content-length': '10', 'content-type': 'application/json; charset=utf-8' }).ok, true);
  assert.equal(r('PATCH', { 'transfer-encoding': 'chunked', 'content-type': 'application/merge-patch+json' }).ok, true);
  assert.equal(r('POST', { 'content-length': '0' }).ok, true);
  assert.equal(r('POST', {}).ok, true);
  assert.equal(r('GET', { 'content-length': '10' }).ok, true);
});

// ── 字段投影 ─────────────────────────────────────────────────
test('parseFields：逗号、嵌套、数组、括号分组；上限与非法名', () => {
  const { tree, paths } = fp.parseFields('id,stats.hp,moves[].name,trainer(id,nickname)');
  assert.deepEqual(tree, { id: true, stats: { hp: true }, moves: { name: true }, trainer: { id: true, nickname: true } });
  assert.deepEqual(paths, ['id', 'stats.hp', 'moves.name', 'trainer.id', 'trainer.nickname']);
  assert.throws(() => fp.parseFields(Array.from({ length: 51 }, (_, i) => `f${i}`).join(',')), /最多 50/);
  assert.throws(() => fp.parseFields('id,1bad'), /非法字段名/);
  assert.throws(() => fp.parseFields('a(b'), /括号不匹配/);
  assert.equal(fp.parseFields(''), null);
});

test('project：对象/数组逐项投影，缺失字段忽略，敏感字段不可选', () => {
  const data = { id: 1, name: 'x', password: 'p', stats: { hp: 3, atk: 4 }, moves: [{ name: 'a', power: 1 }, { name: 'b', power: 2 }], token: 't' };
  const { tree } = fp.parseFields('id,stats.hp,moves[].name,password,token,missing');
  assert.deepEqual(fp.project(data, tree), { id: 1, stats: { hp: 3 }, moves: [{ name: 'a' }, { name: 'b' }] });
  assert.deepEqual(fp.project([data, data], fp.parseFields('id').tree), [{ id: 1 }, { id: 1 }]);
  assert.deepEqual(fp.stripSensitive({ a: { password_hash: 'x', b: [{ password: 1, c: 2 }] } }), { a: { b: [{ c: 2 }] } });
  const same = { a: 1 };
  assert.equal(fp.stripSensitive(same), same, '未命中时返回原引用');
});

test('字段集注册表与 validateAgainst', () => {
  const f = fp.createDefaultFieldsets();
  assert.ok(f.get('pokemon', 'list').fields.includes('cp'));
  assert.equal(f.get('pokemon', 'detail').fields, null);
  assert.deepEqual(f.names('gym').sort(), ['detail', 'list']);
  assert.deepEqual(fp.validateAgainst(['id', 'nope', 'password'], ['id', 'cp']), ['nope']);
});

test('别名压缩：别名 ≤ 3 字符、客户端可无损还原、精灵列表体积减少 >= 30%（REQ-00251）', () => {
  assert.equal(fp.aliasFor(0), 'a');
  assert.equal(fp.aliasFor(52).length, 2);
  assert.equal(fp.aliasFor(52 + 52 * 52).length, 3);
  const body = { success: true, code: 0, data: { pokemon: samplePokemonList(), total: 50 } };
  const packed = fp.packAliased(body);
  assert.ok(Object.keys(packed.$a).every((k) => k.length <= 3));
  assert.deepEqual(fp.expandPayload(JSON.parse(JSON.stringify(packed))), body);
  const before = JSON.stringify(body).length;
  const after = JSON.stringify(packed).length;
  assert.ok(1 - after / before >= 0.3, `减少 ${(100 * (1 - after / before)).toFixed(1)}%`);
  // 字段选择 + 别名叠加
  const list = fp.project(body.data.pokemon, fp.parseFields('id,cp,name_zh').tree);
  assert.ok(JSON.stringify(list).length < before * 0.35);
  // 与原有短键不冲突
  const c = fp.compressKeys({ a: 1, bb: 2, long_key: 3 });
  assert.equal(fp.expandKeys(c.data, c.aliases).long_key, 3);
  assert.ok(!Object.prototype.hasOwnProperty.call(c.aliases, 'a'));
});

test('扁平化 / 还原', () => {
  const o = { a: { b: { c: 1 } }, d: [{ e: { f: 2 } }], g: 3 };
  const flat = fp.flatten(o);
  assert.deepEqual(flat, { 'a.b.c': 1, d: [{ 'e.f': 2 }], g: 3 });
  assert.deepEqual(fp.unflatten(flat), o);
});

// ── 分页 ─────────────────────────────────────────────────────
test('parsePagination：默认值、别名（page/pageSize/limit/offset/size）、截断与非法值', () => {
  assert.deepEqual(pg.parsePagination({}).pageSize, 20);
  const a = pg.parsePagination({ page: '3', pageSize: '10' });
  assert.equal(a.offset, 20);
  assert.equal(a.type, 'offset');
  const b = pg.parsePagination({ limit: '15', offset: '30' });
  assert.equal(b.page, 3);
  assert.deepEqual(b.deprecatedParams.sort(), ['limit', 'offset']);
  assert.equal(pg.parsePagination({ size: '500' }).pageSize, 100);
  assert.equal(pg.parsePagination({ size: '500' }).clamped, true);
  assert.throws(() => pg.parsePagination({ page: '0' }), pg.PaginationError);
  assert.throws(() => pg.parsePagination({ pageSize: 'abc' }), /整数/);
  assert.throws(() => pg.parsePagination({ cursor: 'x', direction: 'up' }), /direction/);
});

test('游标编码：往返、签名防篡改、非法游标', () => {
  const c = pg.encodeCursor({ s: 100, i: 'abc' }, 'secret');
  assert.deepEqual(pg.decodeCursor(c, 'secret'), { s: 100, i: 'abc' });
  assert.throws(() => pg.decodeCursor(`${c}x`, 'secret'), /签名/);
  assert.throws(() => pg.decodeCursor('!!!'), /无效的游标/);
  const first = pg.parsePagination({ cursor: 'first', pageSize: '5' });
  assert.deepEqual([first.type, first.cursorData], ['cursor', null], 'cursor=first 从首页开始游标分页');
  const p = pg.parsePagination({ cursor: c, pageSize: '5' }, { cursorSecret: 'secret' });
  assert.equal(p.type, 'cursor');
  assert.deepEqual(p.cursorData, { s: 100, i: 'abc' });
});

test('buildMeta / buildLinks / toLinkHeader：offset 与 cursor；空列表、最后一页', () => {
  const m = pg.buildMeta({ type: 'offset', page: 2, pageSize: 20, offset: 20, total: 150, count: 20 });
  assert.deepEqual([m.total, m.totalPages, m.hasNext, m.hasPrev, m.hasMore], [150, 8, true, true, true]);
  const links = pg.buildLinks('/v1/pokemon/my', { page: '2', pageSize: '20', sort: 'cp' }, m);
  assert.equal(links.next.href, '/v1/pokemon/my?page=3&pageSize=20&sort=cp');
  assert.equal(links.prev.href, '/v1/pokemon/my?page=1&pageSize=20&sort=cp');
  assert.equal(links.last.href, '/v1/pokemon/my?page=8&pageSize=20&sort=cp');
  assert.match(pg.toLinkHeader(links), /<\/v1\/pokemon\/my\?page=3&pageSize=20&sort=cp>; rel="next"/);
  const last = pg.buildMeta({ type: 'offset', page: 8, pageSize: 20, offset: 140, total: 150, count: 10 });
  assert.equal(last.hasNext, false);
  assert.equal(pg.buildLinks('/x', {}, last).next, undefined);
  const empty = pg.buildMeta({ type: 'offset', pageSize: 20, offset: 0, total: 0, count: 0 });
  assert.deepEqual([empty.total, empty.totalPages, empty.hasNext, empty.hasPrev], [0, 1, false, false]);
  const cm = pg.buildMeta({ type: 'cursor', pageSize: 10, nextCursor: 'n1', prevCursor: null });
  assert.equal(cm.hasNext, true);
  const cl = pg.buildLinks('/x', { cursor: 'c0' }, cm);
  assert.equal(cl.next.href, '/x?pageSize=10&cursor=n1');
  assert.equal(cl.first.href, '/x?pageSize=10&cursor=first');
});

test('detectList：顶层数组 / data 数组 / data.{key:[...],total} / items', () => {
  assert.equal(pg.detectList([1, 2]).items.length, 2);
  assert.equal(pg.detectList({ data: [1], success: true }).key, 'data');
  const d = pg.detectList({ success: true, data: { pokemon: [1, 2], total: 9, limit: 2, offset: 0 } });
  assert.deepEqual([d.key, d.total, d.limit], ['pokemon', 9, 2]);
  assert.equal(pg.detectList({ items: [1], total: '3' }).total, 3);
  assert.equal(pg.detectList({ data: { wildPokemons: [], pokestops: [] } }), null);
  assert.equal(pg.detectList({ data: { leaderboard: [], myRank: 3 } }), null);
});

test('keyset 游标 SQL 与结果处理；延迟关联 SQL；策略选择', () => {
  const k = pg.keysetClause({ sortCol: 'pi.cp', idCol: 'pi.id', dir: 'desc', cursorData: { s: 500, i: 'x' }, pageSize: 10, paramOffset: 1 });
  assert.equal(k.where, '(pi.cp, pi.id) < ($2, $3)');
  assert.equal(k.order, 'pi.cp DESC, pi.id DESC');
  assert.equal(k.limit, 11);
  assert.throws(() => pg.keysetClause({ sortCol: 'cp; DROP TABLE x', pageSize: 1 }), /invalid identifier/);
  const rows = Array.from({ length: 11 }, (_, i) => ({ id: `id${i}`, cp: 1000 - i }));
  const r = pg.keysetResult(rows, { pageSize: 10, sortKey: 'cp', hadCursor: true });
  assert.equal(r.items.length, 10);
  assert.ok(r.nextCursor && r.prevCursor);
  assert.deepEqual(pg.decodeCursor(r.nextCursor), { s: 991, i: 'id9' });
  const sql = pg.deferredJoinSql({ table: 'users', alias: 'u', select: 'u.id, u.xp', where: 'u.is_banned = false', orderBy: 'u.xp DESC, u.id', limitParam: '$1', offsetParam: '$2' });
  assert.match(sql, /JOIN \(SELECT u\.id FROM users u WHERE u\.is_banned = false ORDER BY u\.xp DESC, u\.id LIMIT \$1 OFFSET \$2\) _k/);
  assert.equal(pg.shouldUseDeferredJoin(1001), true);
  assert.equal(pg.shouldUseDeferredJoin(1000), false);
  const sel = new pg.PaginationStrategySelector();
  assert.equal(sel.select({ pagination: { type: 'offset', offset: 5000 } }).strategy, 'cursor');
  assert.equal(sel.select({ pagination: { type: 'offset', offset: 0 }, estimatedTotal: 50000 }).countMode, 'estimate');
  assert.equal(sel.select({ pagination: { type: 'offset', offset: 0 }, estimatedTotal: 100 }).strategy, 'offset');
  assert.equal(sel.select({ pagination: { type: 'cursor' } }).reason, 'explicit-cursor');
});

test('countWithStrategy / estimateCount：估算模式走 EXPLAIN，小表回退精确 COUNT', async () => {
  const calls = [];
  const q = async (sql) => {
    calls.push(sql);
    if (sql.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': 250000 } }] }] };
    return { rows: [{ count: 42 }] };
  };
  assert.deepEqual(await pg.countWithStrategy(q, 'SELECT COUNT(*)::int FROM users', [], { mode: 'estimate' }), { total: 250000, estimated: true });
  assert.deepEqual(await pg.countWithStrategy(q, 'SELECT COUNT(*)::int FROM users', [], { mode: 'exact' }), { total: 42, estimated: false });
  assert.deepEqual(await pg.countWithStrategy(q, 'x', [], { mode: 'none' }), { total: null, estimated: false });
  assert.ok(calls[0].startsWith('EXPLAIN (FORMAT JSON) SELECT 1 FROM users'));
});

test('offset/cursor 分页中间件注入 req.pagination；res.addPaginationMeta / res.addLinks / res.paginated', () => {
  const headers = {};
  let sent = null;
  const res = { locals: {}, setHeader: (k, v) => { headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { sent = b; return this; } };
  const req = { query: { page: '2', pageSize: '2', sort: 'cp' }, originalUrl: '/v1/pokemon/species?page=2&pageSize=2&sort=cp' };
  pg.offsetPaginationMiddleware()(req, res, () => {});
  assert.equal(req.pagination.offset, 2);
  res.paginated([{ id: 3 }, { id: 4 }], { total: 7 });
  assert.equal(sent.pagination.total, 7);
  assert.equal(sent.meta.pagination.totalPages, 4);
  assert.equal(sent.code, 0);
  assert.equal(sent._links.next.href, '/v1/pokemon/species?page=3&pageSize=2&sort=cp');
  assert.match(headers.Link, /rel="next"/);
  const bad = { query: { page: '-1' } };
  const res2 = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  pg.cursorPaginationMiddleware()(bad, res2, () => assert.fail('should not call next'));
  assert.equal(res2.statusCode, 400);
});

// ── HATEOAS ─────────────────────────────────────────────────
test('LinkRegistry：路径 → 资源类型；精灵详情操作链接（可进化条件）', () => {
  const reg = hateoas.createDefaultRegistry();
  assert.deepEqual(reg.resolve('/v1/pokemon/my/0a1b2c3d-0000-4000-8000-000000000001'), { type: 'pokemon', kind: 'item', pathId: '0a1b2c3d-0000-4000-8000-000000000001' });
  assert.equal(reg.resolve('/v1/pokemon/my').kind, 'collection');
  assert.equal(reg.resolve('/v1/gyms/nearby').kind, 'collection');
  assert.equal(reg.resolve('/v1/gyms/g1').type, 'gym');
  assert.equal(reg.resolve('/v1/pokemon/pokedex'), null);
  assert.ok(reg.get('trade') && reg.get('user') && reg.get('gym') && reg.get('pokemon'));
  const b = new hateoas.LinksBuilder(reg);
  const canEvolve = b.forResource('pokemon', { id: 'p1', species_id: 1, user_id: 'u1', evolves_to: 2, candy_to_evolve: 25, candy_count: 30 });
  assert.equal(canEvolve.evolve.href, '/v1/pokemon/my/p1/evolve');
  assert.equal(canEvolve.evolve.method, 'POST');
  assert.equal(canEvolve.trainer.href, '/v1/users/u1');
  assert.equal(canEvolve.collection.href, '/v1/pokemon/my');
  const cannot = b.forResource('pokemon', { id: 'p1', species_id: 1, evolves_to: 2, candy_to_evolve: 25, candy_count: 3 });
  assert.equal(cannot.evolve, undefined);
  const noEvo = b.forResource('pokemon', { id: 'p1', species_id: 3, evolves_to: null });
  assert.equal(noEvo.evolve, undefined);
  const me = b.forResource('user', { id: 'u1' }, { isMe: true });
  assert.ok(me.inventory && me.friends);
  const other = b.forResource('user', { id: 'u2' }, { isMe: false });
  assert.equal(other.inventory, undefined);
  const trade = b.forResource('trade', { id: 't1', status: 'COMPLETED', initiator_id: 'a', receiver_id: 'b' });
  assert.equal(trade.accept, undefined);
  assert.equal(trade.cancel, undefined);
  assert.equal(trade.initiator.href, '/v1/users/a');
});

test('复合响应内嵌集合链接：附近野生精灵 catch、补给站 spin（可转时）', () => {
  const reg = hateoas.createDefaultRegistry();
  assert.deepEqual(reg.embedsFor('/v1/map/nearby'), { wildPokemons: 'spawn', pokestops: 'pokestop', gyms: 'gym' });
  assert.equal(reg.embedsFor('/v1/pokemon/my'), null);
  const b = new hateoas.LinksBuilder(reg);
  const spawn = b.forResource('spawn', { id: 's1', species_id: 25 });
  assert.deepEqual([spawn.catch.href, spawn.catch.method, spawn.species.href], ['/v1/catch/session', 'POST', '/v1/pokemon/species/25']);
  assert.equal(b.forResource('pokestop', { id: 'p1', can_spin: true }).spin.href, '/v1/pokestops/p1/spin');
  assert.equal(b.forResource('pokestop', { id: 'p1', can_spin: false }).spin, undefined);
});

test('HalFormatter / Link 头解析 / ResourceDiscoverer', () => {
  const hal = hateoas.HalFormatter.format({ success: true, data: [{ id: 1 }], _links: { self: { href: '/x' } }, pagination: { page: 1 } }, { rel: 'pokemon' });
  assert.deepEqual(hal._embedded.pokemon, [{ id: 1 }]);
  assert.equal(hateoas.HalFormatter.isValid(hal), true);
  const single = hateoas.HalFormatter.format({ success: true, code: 0, data: { id: 1 }, _links: { self: { href: '/y' } } });
  assert.equal(single.id, 1);
  assert.equal(single._meta.code, 0);
  assert.equal(hateoas.HalFormatter.isValid({ _links: { self: {} } }), false);
  const header = hateoas.LinksBuilder.toLinkHeader({ self: { href: '/a' }, next: { href: '/b', title: 'n' } });
  assert.deepEqual(hateoas.LinksBuilder.parseLinkHeader(header), { self: { href: '/a' }, next: { href: '/b' } });
  const d = new hateoas.ResourceDiscoverer(hateoas.createDefaultRegistry(), { extraLinks: { version: { href: '/api/version' } } }).discover();
  assert.equal(d._links.self.href, '/api/discover');
  assert.equal(d._links.pokemon.href, '/v1/pokemon/my');
  assert.ok(d.resources.pokemon.actions.find((a) => a.rel === 'evolve' && a.method === 'POST'));
  assert.ok(d._meta.server_time);
});

// ── 错误目录 ────────────────────────────────────────────────
test('ErrorCodes.js 至少 20 个错误码，均含 code/httpStatus/message/i18nKey（REQ-00386 验收）', () => {
  const entries = Object.values(ErrorCodes).filter((x) => x && typeof x === 'object');
  assert.ok(entries.length >= 20);
  for (const e of entries) {
    for (const k of ['code', 'httpStatus', 'message', 'i18nKey']) assert.ok(e[k] !== undefined, `${e.code} 缺少 ${k}`);
  }
  const all = errors.listCatalog();
  assert.ok(all.length >= 60);
  assert.ok(all.every((e) => e.i18nKey && e.docUrl && typeof e.retryable === 'boolean'));
});

test('normalizeErrorBody：只增不减（网关旧格式 / 服务 error 对象 / 旧字符串 error）', () => {
  const gw = errors.normalizeErrorBody({ code: 1005, message: '路由不存在', data: null }, 404, { requestId: 'r1' });
  assert.equal(gw.code, 1005);
  assert.equal(gw.success, false);
  assert.equal(gw.error.name, 'NOT_FOUND');
  assert.equal(gw.error.i18nKey, 'errors.general.not_found');
  assert.equal(gw.meta.requestId, 'r1');
  const svc = errors.normalizeErrorBody({ success: false, error: { code: 3001, name: 'POKEMON_NOT_FOUND', message: '精灵不存在' } }, 404);
  assert.equal(svc.error.code, 3001);
  assert.equal(svc.code, 3001);
  assert.equal(svc.message, '精灵不存在');
  assert.equal(svc.error.httpStatus, 404);
  const legacy = errors.normalizeErrorBody({ error: 'Guild not found' }, 404);
  assert.equal(legacy.error, 'Guild not found');
  assert.equal(legacy.errorInfo.name, 'NOT_FOUND');
  assert.equal(legacy.message, 'Guild not found');
  const rl = errors.normalizeErrorBody({ code: 6003, message: '捕捉过于频繁' }, 429, { retryAfter: 30 });
  assert.equal(rl.code, 6003, '不改写业务码（冒烟依赖 body.code === 6003）');
  assert.equal(rl.error.retryable, true);
  assert.equal(rl.error.retryAfter, 30);
  const named = errors.normalizeErrorBody({ success: false, code: 'VALIDATION_ERROR', message: 'bad' }, 400);
  assert.equal(named.error.name, 'VALIDATION_ERROR');
  const noMeta = errors.normalizeErrorBody({ code: 1 }, 500, { meta: false });
  assert.equal(noMeta.meta, undefined);
});

test('buildErrorBody：网关错误完整标准格式', () => {
  const { status, body } = errors.buildErrorBody('NOT_ACCEPTABLE', { message: 'x', details: { a: 1 }, requestId: 'q' });
  assert.equal(status, 406);
  assert.equal(body.code, 1013);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'details', 'docUrl', 'httpStatus', 'i18nKey', 'message', 'name', 'retryable'].sort());
  assert.equal(body.meta.requestId, 'q');
  assert.equal(errors.buildErrorBody('SOMETHING_NEW', { status: 503 }).body.error.retryable, true);
  const s = errors.normalizeSuccessBody({ code: 0, data: 1 }, 200, { requestId: 'z' });
  assert.equal(s.success, true);
  assert.equal(s.meta.requestId, 'z');
});

test('sqlColumns：?fields / ?fieldset 只查询需要的列；非法参数或完整字段集回退全部列（REQ-00532）', () => {
  const map = { id: 'pi.id', cp: 'pi.cp', nickname: 'pi.nickname', iv_pct: 'ROUND(x) AS iv_pct', caught_at: 'pi.caught_at', password: 'u.password' };
  const r = fp.sqlColumns({ fields: 'cp,nickname,unknown' }, map, { always: ['id', 'caught_at'] });
  assert.equal(r.projected, true);
  assert.deepEqual(r.fields, ['id', 'caught_at', 'cp', 'nickname']);
  assert.deepEqual(r.columns, ['pi.id', 'pi.caught_at', 'pi.cp', 'pi.nickname']);
  assert.deepEqual(fp.sqlColumns({ fields: 'password,cp' }, map).fields, ['id', 'cp'], '敏感字段不可选');
  assert.deepEqual(fp.sqlColumns({ fields: 'stats.hp,cp' }, { ...map, stats: 's.stats' }).fields, ['id', 'stats', 'cp'], '嵌套字段按顶层列查询');
  assert.equal(fp.sqlColumns({}, map).projected, false);
  assert.equal(fp.sqlColumns({ fields: '1bad' }, map).projected, false, '非法参数交给网关 400，这里回退全部列');
  const sets = fp.createDefaultFieldsets();
  const list = fp.sqlColumns({ fieldset: 'list' }, { id: 'a', cp: 'b', iv_attack: 'c', name_zh: 'd' }, { resource: 'pokemon', fieldsets: sets });
  assert.equal(list.projected, true);
  assert.ok(list.fields.includes('cp') && !list.fields.includes('iv_attack'));
  assert.equal(fp.sqlColumns({ fieldset: 'detail' }, map, { resource: 'pokemon', fieldsets: sets }).projected, false, 'detail = 完整字段');
});
