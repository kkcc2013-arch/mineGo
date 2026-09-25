#!/usr/bin/env node
/**
 * REQ-00547 / REQ-00520：契约测试框架——从契约注册中心自动生成并执行测试用例
 *
 * 用例生成（generateCases，纯函数，可单测）：
 *   positive      每个契约 1 个：按 fixtures 填充路径参数/查询/请求体，期望 2xx，响应按该契约校验
 *   unauthorized  需要鉴权的契约：不带 token，期望 401，响应按 error.any 校验
 *   invalid-body  有请求体 Schema 的 POST/PUT/PATCH：发送 {}（缺必填字段），期望 4xx，响应按 error.any 校验
 *   mock          每个契约：由 Schema 生成 Mock，自身必须通过校验（检查契约本身是否自洽）
 * 无法填充参数的正向用例标记 skipped 并给出原因。
 *
 * 用法：
 *   node scripts/contract-test.js --list                   只列出生成的用例（不发请求）
 *   node scripts/contract-test.js --run [--json]           经网关执行（BASE_URL，自动注册测试用户并写入测试精灵），失败退出码 1
 *   BASE_URL=http://127.0.0.1:18380 node scripts/contract-test.js --run
 */
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { SchemaRegistry } = require(path.join(ROOT, 'backend', 'shared', 'apiStandards', 'schemaRegistry'));
const { mockFromSchema } = require(path.join(ROOT, 'backend', 'shared', 'apiStandards', 'jsonSchema'));

/** 默认夹具：路径参数、查询串、请求体（{{pokemonIds}} 等占位符在运行时替换） */
const DEFAULT_FIXTURES = {
  params: { id: '{{pokemonId}}', speciesId: '1' },
  pathParams: { 'pokemon.species.detail': { id: '1' } },
  query: { 'map.nearby': 'lat=31.2398&lng=121.5014&radius=1000', 'pokemon.my.list': 'pageSize=5', 'pokemon.species.list': 'pageSize=5', 'rewards.leaderboard': 'pageSize=5' },
  bodies: {
    'location.update': { lat: 31.2398, lng: 121.5014, accuracy: 10 },
    'pokemon.batch.details': { ids: '{{pokemonIds}}', include: ['skills', 'battle'] },
    'gateway.batch': { requests: [{ id: 'me', path: '/v1/users/me' }, { id: 'daily', path: '/v1/rewards/daily' }] },
    'auth.refresh': { refreshToken: '{{refreshToken}}' },
  },
  // 会改变会话状态的用例最后执行（refresh 会轮换令牌）
  runLast: ['auth.refresh'],
  // 有副作用或依赖一次性凭据的正向用例不自动执行（仍生成反向用例）
  skipPositive: {
    'auth.login': '需要一次性短信验证码（冒烟脚本覆盖）',
    'catch.session': '需要刷新点实时刷出的精灵（冒烟脚本覆盖）',
    'catch.throw': '依赖捕捉会话（冒烟脚本覆盖）',
  },
};

function fillPath(route, contractId, fx) {
  const missing = [];
  const p = route.replace(/:([A-Za-z0-9_]+)/g, (_, k) => {
    const v = (fx.pathParams[contractId] || {})[k] ?? fx.params[k];
    if (v === undefined) { missing.push(k); return `:${k}`; }
    return v;
  });
  return { path: p, missing };
}

/**
 * @param {SchemaRegistry} registry
 * @returns {Array<{ id, contract, service, kind, method, path, auth, body, expectStatus, validateWith, skip? }>}
 */
function generateCases(registry, fixtures = DEFAULT_FIXTURES) {
  const fx = { ...DEFAULT_FIXTURES, ...fixtures };
  const cases = [];
  for (const meta of registry.list().sort((a, b) => a.id.localeCompare(b.id))) {
    const c = registry.get(meta.id);
    const base = { contract: c.id, service: c.service };
    cases.push({ ...base, id: `${c.id}#mock`, kind: 'mock', validateWith: c.id });
    if (c.route === '*' || !c.method || c.method === '*') continue;
    const { path: p, missing } = fillPath(c.route, c.id, fx);
    const q = fx.query[c.id];
    const url = q ? `${p}?${q}` : p;
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(c.method);
    const positive = { ...base, id: `${c.id}#positive`, kind: 'positive', method: c.method, path: url, auth: !!c.auth, body: hasBody ? (fx.bodies[c.id] ?? null) : undefined, expectStatus: '2xx', validateWith: c.id };
    if (missing.length) positive.skip = `缺少路径参数夹具：${missing.join(', ')}`;
    else if (fx.skipPositive[c.id]) positive.skip = fx.skipPositive[c.id];
    else if (hasBody && positive.body === null && c.requestSchema) positive.skip = '缺少请求体夹具';
    cases.push(positive);
    if (c.auth) cases.push({ ...base, id: `${c.id}#unauthorized`, kind: 'unauthorized', method: c.method, path: missing.length ? c.route.replace(/:([A-Za-z0-9_]+)/g, 'x') : url, auth: false, body: hasBody ? {} : undefined, expectStatus: 401, validateWith: 'error.any' });
    if (hasBody && c.requestSchema && (c.requestSchema.required || []).length) {
      cases.push({ ...base, id: `${c.id}#invalid-body`, kind: 'invalid-body', method: c.method, path: url, auth: !!c.auth, body: {}, expectStatus: '4xx', validateWith: 'error.any' });
    }
  }
  const last = (tc) => (tc.kind === 'positive' && (fx.runLast || []).includes(tc.contract) ? 1 : 0);
  return cases.map((tc, i) => [tc, i]).sort((a, b) => last(a[0]) - last(b[0]) || a[1] - b[1]).map(([tc]) => tc);
}

function statusOk(expect, status) {
  if (typeof expect === 'number') return status === expect;
  return String(status)[0] === String(expect)[0];
}

function substitute(v, vars) {
  if (typeof v === 'string') {
    const m = v.match(/^\{\{(\w+)\}\}$/);
    if (m) return vars[m[1]];
    return v.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]);
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, vars)]));
  return v;
}

async function runCases(registry, cases, { call, token, vars }) {
  const results = [];
  const resolve = (n) => registry.files.get(n) || null;
  for (const tc of cases) {
    const t0 = Date.now();
    if (tc.skip) { results.push({ ...tc, result: 'skipped', reason: tc.skip }); continue; }
    if (tc.kind === 'mock') {
      const contract = registry.get(tc.validateWith);
      const r = registry.validate(contract, mockFromSchema(contract.schema, { resolveExternal: resolve }));
      results.push({ ...tc, result: r.valid ? 'pass' : 'fail', errors: r.errors.slice(0, 5), ms: Date.now() - t0 });
      continue;
    }
    try {
      const res = await call(tc.method, substitute(tc.path, vars), { token: tc.auth ? token : undefined, body: tc.body === undefined ? undefined : substitute(tc.body, vars) });
      const okStatus = statusOk(tc.expectStatus, res.status);
      const v = res.body ? registry.validate(tc.validateWith, res.body) : { valid: false, errors: [{ path: '$', message: '响应不是 JSON' }] };
      results.push({ ...tc, result: okStatus && v.valid ? 'pass' : 'fail', status: res.status, errors: okStatus ? v.errors.slice(0, 5) : [{ path: '$status', message: `期望 ${tc.expectStatus}，实际 ${res.status}` }, ...v.errors.slice(0, 3)], ms: Date.now() - t0 });
    } catch (err) {
      results.push({ ...tc, result: 'fail', errors: [{ path: '$', message: err.message }], ms: Date.now() - t0 });
    }
  }
  return results;
}

function summarize(results) {
  const s = { total: results.length, pass: 0, fail: 0, skipped: 0, byService: {} };
  for (const r of results) {
    s[r.result === 'pass' ? 'pass' : r.result === 'fail' ? 'fail' : 'skipped']++;
    const b = s.byService[r.service] || (s.byService[r.service] = { pass: 0, fail: 0, skipped: 0 });
    b[r.result === 'pass' ? 'pass' : r.result === 'fail' ? 'fail' : 'skipped']++;
  }
  return s;
}

async function main() {
  const registry = new SchemaRegistry().loadFromDir();
  const cases = generateCases(registry);
  if (process.argv.includes('--list') || !process.argv.includes('--run')) {
    console.log(JSON.stringify({ total: cases.length, cases: cases.map(({ id, kind, method, path: p, expectStatus, skip }) => ({ id, kind, method, path: p, expectStatus, skip })) }, null, 2));
    return 0;
  }
  const T = require('./lib/testUser');
  const redis = T.redisClient();
  await redis.connect();
  const pg = T.pgClient();
  await pg.connect();
  const started = Date.now();
  let results;
  try {
    const user = await T.registerUser(redis, { prefix: 'ct' });
    const ids = await T.seedPokemon(pg, user.userId, 5);
    const vars = { pokemonId: ids[0], pokemonIds: ids, refreshToken: user.refreshToken };
    const call = (method, url, opts) => T.call(method, url, { ...opts, ip: T.randomIp() });
    results = await runCases(registry, cases, { call, token: user.token, vars });
    await pg.query('DELETE FROM pokemon_instances WHERE user_id = $1', [user.userId]).catch(() => {});
  } finally {
    await pg.end();
    await redis.quit();
  }
  const summary = { ...summarize(results), durationMs: Date.now() - started };
  if (process.argv.includes('--json')) console.log(JSON.stringify({ summary, results }, null, 2));
  else {
    for (const r of results) console.log(`${r.result === 'pass' ? '✅' : r.result === 'fail' ? '❌' : '⏭️ '} ${r.id}${r.status ? ` [${r.status}]` : ''}${r.reason ? `  — ${r.reason}` : ''}${r.result === 'fail' ? `  — ${r.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}` : ''}`);
    console.log(`\n${summary.pass} 通过 / ${summary.fail} 失败 / ${summary.skipped} 跳过（共 ${summary.total}，${summary.durationMs}ms）`);
  }
  return summary.fail ? 1 : 0;
}

if (require.main === module) main().then((c) => { process.exitCode = c; }).catch((err) => { console.error(err); process.exitCode = 2; });

module.exports = { generateCases, runCases, summarize, DEFAULT_FIXTURES };
