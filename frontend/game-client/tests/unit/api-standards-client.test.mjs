// Epic E25 客户端单测（node --test，无需浏览器/服务）：
//   apiStandards.js —— 别名还原（与服务端 compressKeys 互逆）、重试策略、NDJSON 分块解析与中止、Link 头、LinkNavigator、翻页
//   client.js       —— 幂等请求退避重试、非幂等不重试、幂等键 POST 可重试、弃用事件、别名自动还原、raw 响应、批量接口
// 运行：node --test frontend/game-client/tests/unit/api-standards-client.test.mjs   （Node ≥ 22.12，.js 按 ESM 语法自动识别）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => pathToFileURL(path.join(here, '..', '..', 'src', p)).href;
const require = createRequire(import.meta.url);
const serverProjection = require('../../../../backend/shared/apiStandards/fieldProjection.js');
const serverPagination = require('../../../../backend/shared/apiStandards/pagination.js');

const S = await import(src('api/apiStandards.js'));

test('别名还原：与服务端 compressKeys 互逆，无 _aliases 时原样返回', () => {
  const data = { pokemon: [{ id: 'a', species_id: 1, name_zh: '妙蛙种子', stats: { attack: 1 } }, { id: 'b', species_id: 2, name_zh: 'x', stats: { attack: 2 } }], total: 2 };
  const { data: packed, aliases } = serverProjection.compressKeys(data);
  const body = { success: true, code: 0, data: packed, _aliases: aliases, meta: { requestId: 'r' } };
  const out = S.expandAliasedBody(body);
  assert.deepEqual(out.data, data);
  assert.equal(out._aliases, undefined);
  assert.equal(out.meta.requestId, 'r');
  const plain = { code: 0, data: { id: 1 } };
  assert.equal(S.expandAliasedBody(plain), plain);
});

test('重试策略：只重试幂等请求；可重试状态；Retry-After 优先；full jitter 范围', () => {
  const base = { attempt: 0, maxRetries: 2 };
  assert.equal(S.shouldRetry({ ...base, method: 'GET', status: 503 }), true);
  assert.equal(S.shouldRetry({ ...base, method: 'GET', status: 429 }), true);
  assert.equal(S.shouldRetry({ ...base, method: 'GET', status: 500 }), false);
  assert.equal(S.shouldRetry({ ...base, method: 'GET', status: 404 }), false);
  assert.equal(S.shouldRetry({ ...base, method: 'POST', status: 503 }), false);
  assert.equal(S.shouldRetry({ ...base, method: 'POST', status: 503, idempotencyKey: 'k' }), true);
  assert.equal(S.shouldRetry({ ...base, method: 'GET', error: new TypeError('Failed to fetch') }), true);
  assert.equal(S.shouldRetry({ ...base, method: 'GET', error: Object.assign(new Error('x'), { name: 'AbortError' }) }), false);
  assert.equal(S.shouldRetry({ attempt: 2, maxRetries: 2, method: 'GET', status: 503 }), false);
  assert.equal(S.parseRetryAfter('3'), 3000);
  assert.equal(S.parseRetryAfter('abc'), null);
  assert.ok(Math.abs(S.parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) - 5000) < 1500);
  assert.equal(S.retryDelay(1, { retryAfter: '2' }), 2000);
  assert.equal(S.retryDelay(1, { retryAfter: '60', max: 8000 }), 8000);
  assert.equal(S.retryDelay(3, { base: 100, random: () => 1 }), 400);
  assert.equal(S.retryDelay(10, { base: 100, max: 1000, random: () => 1 }), 1000);
  const samples = Array.from({ length: 300 }, () => S.retryDelay(3, { base: 100 }));
  assert.ok(samples.every((d) => d >= 0 && d <= 400));
  assert.ok(new Set(samples).size > 50, '抖动分散重试时间，避免惊群');
});

function streamOf(chunks, { delayMs = 0 } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    async pull(controller) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (cancelled) return;
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(enc.encode(chunks[i++]));
    },
    cancel() { cancelled = true; },
  });
  return { body: stream, wasCancelled: () => cancelled };
}

test('NDJSON：跨块半行拼接、多字节字符跨块、空行跳过、summary 行', async () => {
  const line1 = JSON.stringify({ id: 1, name: '妙蛙种子' });
  const bytes = Buffer.from(`${line1}\n`);
  // 把中文 UTF-8 字节切在中间，验证 TextDecoder stream 模式
  const cut = bytes.indexOf(Buffer.from('蛙')) + 1;
  const enc = new TextEncoder();
  let step = 0;
  const parts = [bytes.subarray(0, cut), bytes.subarray(cut), enc.encode('\n{"id":2,"na'), enc.encode('me":"b"}\n{"_summary":{"count":2}}')];
  const body = new ReadableStream({ pull(c) { if (step < parts.length) c.enqueue(new Uint8Array(parts[step++])); else c.close(); } });
  const items = [];
  const r = await S.readNdjson({ body }, (x) => items.push(x));
  assert.deepEqual(items, [{ id: 1, name: '妙蛙种子' }, { id: 2, name: 'b' }]);
  assert.deepEqual(r, { count: 2, summary: { count: 2 } });
  const batchStyle = streamOf(['{"type":"response","id":"a"}\n', '{"type":"summary","summary":{"total":1}}\n']);
  const r2 = await S.readNdjson(batchStyle, () => {});
  assert.deepEqual(r2.summary, { total: 1 });
});

test('NDJSON：中止时取消底层流、释放读取器并抛 AbortError', async () => {
  const s = streamOf(Array.from({ length: 50 }, (_, i) => `{"i":${i}}\n`), { delayMs: 5 });
  const ac = new AbortController();
  const seen = [];
  await assert.rejects(S.readNdjson(s, (x) => { seen.push(x); if (seen.length === 3) ac.abort(); }, { signal: ac.signal }), (e) => e.name === 'AbortError');
  assert.ok(seen.length < 50);
  assert.equal(s.wasCancelled(), true);
});

test('Link 头：与服务端 toLinkHeader 互通', () => {
  const links = serverPagination.buildLinks('/v1/pokemon/my', { page: '2', pageSize: '10' }, serverPagination.buildMeta({ type: 'offset', page: 2, pageSize: 10, offset: 10, total: 45, count: 10 }));
  const parsed = S.parseLinkHeader(serverPagination.toLinkHeader(links));
  assert.equal(parsed.next.href, '/v1/pokemon/my?page=3&pageSize=10');
  assert.equal(parsed.last.href, '/v1/pokemon/my?page=5&pageSize=10');
  assert.deepEqual(S.parseLinkHeader('</a>; rel="deprecation"; type="text/html", </v2/>; rel="successor-version"'), { deprecation: { href: '/a' }, 'successor-version': { href: '/v2/' } });
  assert.deepEqual(S.parseLinkHeader(''), {});
});

test('LinkNavigator：按 _links 的方法与地址执行操作；缺失链接给出可用列表；翻页迭代', async () => {
  const calls = [];
  const client = {
    async requestUrl(method, url, body) {
      calls.push([method, url, body]);
      if (url.includes('page=2')) return { success: true, code: 0, data: [3], _links: { self: { href: url } } };
      if (url.includes('/v1/pokemon/my?')) return { success: true, code: 0, data: [1, 2], _links: { next: { href: '/v1/pokemon/my?page=2&pageSize=2' } } };
      return { success: true, code: 0, data: { id: 'p1', species_id: 2 }, _links: { self: { href: '/v1/pokemon/my/p1' } } };
    },
  };
  const detail = { success: true, code: 0, data: { id: 'p1' }, _links: { self: { href: '/v1/pokemon/my/p1' }, evolve: { href: '/v1/pokemon/my/p1/evolve', method: 'POST' }, trainer: { href: '/v1/users/u1' } } };
  const nav = new S.LinkNavigator(client, detail);
  assert.deepEqual(nav.rels(), ['self', 'evolve', 'trainer']);
  assert.equal(nav.can('evolve'), true);
  assert.equal(nav.can('powerUp'), false);
  assert.equal(nav.data.id, 'p1');
  const evolved = await nav.follow('evolve');
  assert.deepEqual(calls[0], ['POST', '/v1/pokemon/my/p1/evolve', {}]);
  assert.equal(evolved.data.species_id, 2);
  await nav.follow('trainer');
  assert.deepEqual(calls[1], ['GET', '/v1/users/u1', null]);
  assert.throws(() => nav.link('powerUp'), /可用：self, evolve, trainer/);
  const pages = [];
  for await (const p of S.pageIterator(client, '/v1/pokemon/my?page=1&pageSize=2')) pages.push(p.data);
  assert.deepEqual(pages, [[1, 2], [3]]);
  assert.equal(S.resolveHref('https://api.example.com/v1', '/v1/pokemon/my/1'), 'https://api.example.com/v1/pokemon/my/1');
  assert.equal(S.resolveHref('https://api.example.com/v1', 'https://other/x'), 'https://other/x');
});

// ── client.js（stub window / localStorage / fetch） ─────────
const events = [];
globalThis.window = { PMG_CONFIG: { apiBase: 'http://gw.test/v1' }, dispatchEvent: (e) => events.push(e) };
globalThis.localStorage = { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, v); }, removeItem(k) { this._m.delete(k); } };
if (typeof globalThis.CustomEvent === 'undefined') globalThis.CustomEvent = class CustomEvent extends Event { constructor(t, o = {}) { super(t); this.detail = o.detail; } };
const fetchCalls = [];
let responder = null;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, method: init.method, headers: init.headers, body: init.body });
  return responder(url, init, fetchCalls.length);
};
const resp = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => body });
const { api, ApiError } = await import(src('api/client.js'));
const origWarn = console.warn;

test('client：GET 遇 503 退避重试（Retry-After: 0）后成功；带客户端标识头', async () => {
  fetchCalls.length = 0;
  responder = (url, init, n) => (n < 3 ? resp(503, { code: 9002, message: 'busy' }, { 'Retry-After': '0' }) : resp(200, { code: 0, data: { id: 'me' } }));
  const me = await api.getMe();
  assert.equal(me.id, 'me');
  assert.equal(fetchCalls.length, 3);
  assert.equal(fetchCalls[0].url, 'http://gw.test/v1/users/me');
  assert.equal(fetchCalls[0].headers['X-Client-Id'], 'game-client-web');
});

test('client：POST 不重试；带幂等键的下单可重试；最终失败抛 ApiError 并带标准 error 对象', async () => {
  fetchCalls.length = 0;
  responder = () => resp(503, { success: false, code: 9002, message: '服务繁忙', error: { code: 9002, name: 'SERVICE_UNAVAILABLE', retryable: true } }, { 'Retry-After': '0' });
  await assert.rejects(api.claimDailyReward(), (e) => e instanceof ApiError && e.httpStatus === 503 && e.details.name === 'SERVICE_UNAVAILABLE');
  assert.equal(fetchCalls.length, 1);
  fetchCalls.length = 0;
  responder = (url, init, n) => (n < 2 ? resp(502, {}, { 'Retry-After': '0' }) : resp(200, { code: 0, data: { orderId: 'o1' } }));
  const order = await api.createOrder('coins_60', 'wechat');
  assert.equal(order.orderId, 'o1');
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].headers['X-Idempotency-Key'], JSON.parse(fetchCalls[1].body).idempotencyKey);
});

test('client：弃用头触发一次 pmg:api-deprecated；别名响应自动还原；raw 返回完整响应体', async () => {
  console.warn = () => {};
  try {
    events.length = 0;
    const { data, aliases } = serverProjection.compressKeys({ pokemon: [{ id: 'a', species_id: 1 }], total: 1 });
    responder = () => resp(200, { success: true, code: 0, data, _aliases: aliases, pagination: { total: 1 }, _links: { self: { href: '/v1/pokemon/my' } } },
      { Deprecation: '@1790000000', Sunset: 'Wed, 30 Dec 2026 00:00:00 GMT', Link: '</v2/pokemon/my>; rel="successor-version"' });
    const list = await api.getMyPokemon({ _aliases: 1 });
    assert.deepEqual(list, { pokemon: [{ id: 'a', species_id: 1 }], total: 1 });
    await api.getMyPokemon({ _aliases: 1 });
    assert.equal(events.filter((e) => e.type === 'pmg:api-deprecated').length, 1, '同一接口只提示一次');
    assert.equal(events[0].detail.sunset, 'Wed, 30 Dec 2026 00:00:00 GMT');
    const raw = await api.get('/pokemon/my', { raw: true });
    assert.equal(raw.pagination.total, 1);
    const nav = api.navigate(raw);
    assert.equal(nav.link('self').href, '/v1/pokemon/my');
  } finally { console.warn = origWarn; }
});

test('client：批量接口走网关根路径 /api/v1/batch；_links 根相对地址解析到 API 源站', async () => {
  fetchCalls.length = 0;
  responder = () => resp(200, { code: 0, data: { responses: [], summary: { total: 0 } } });
  await api.batch([{ path: '/v1/users/me' }], { cacheTTL: 30 });
  assert.equal(fetchCalls[0].url, 'http://gw.test/api/v1/batch');
  assert.deepEqual(JSON.parse(fetchCalls[0].body), { requests: [{ path: '/v1/users/me' }], options: { cacheTTL: 30 } });
  await api.requestUrl('POST', '/v1/pokemon/my/p1/evolve', {});
  assert.equal(fetchCalls[1].url, 'http://gw.test/v1/pokemon/my/p1/evolve');
});
