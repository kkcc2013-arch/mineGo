// Epic E25 —— 契约相关单元测试：JSON Schema 校验 / Mock / TS 生成 / 契约注册中心 / 兼容性检测 / 快照与生成物同步
// REQ-00315 REQ-00547 REQ-00520
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { Validator, mockFromSchema, toTs } = require('../../shared/apiStandards/jsonSchema');
const { SchemaRegistry, statusMatches } = require('../../shared/apiStandards/schemaRegistry');
const compat = require('../../shared/apiStandards/compatibility');

const ROOT = path.join(__dirname, '..', '..', '..');

test('Validator：类型/必填/枚举/格式/数组/additionalProperties/anyOf/oneOf/not/$ref', () => {
  const v = new Validator();
  const schema = {
    definitions: { Id: { type: 'string', format: 'uuid' } },
    type: 'object',
    required: ['id', 'cp', 'tags'],
    additionalProperties: false,
    properties: {
      id: { $ref: '#/definitions/Id' },
      cp: { type: 'integer', minimum: 0 },
      nick: { type: ['string', 'null'], maxLength: 5 },
      kind: { enum: ['A', 'B'] },
      tags: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^[a-z]+$' } },
      at: { type: 'string', format: 'date-time' },
      any: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      one: { oneOf: [{ type: 'integer' }, { type: 'number', minimum: 10 }] },
      notnull: { not: { type: 'null' } },
      n: { type: 'number', nullable: true },
    },
  };
  const ok = v.validate(schema, { id: '00000000-0000-4000-8000-000000000001', cp: 10, nick: null, kind: 'A', tags: ['a'], at: '2026-01-01T00:00:00Z', any: 1, one: 5, notnull: 1, n: null });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
  const bad = v.validate(schema, { id: 'x', cp: -1, nick: 'toolong', kind: 'C', tags: [], at: 'yesterday', any: true, one: 12, notnull: null, extra: 1 });
  const kw = bad.errors.map((e) => e.keyword).sort();
  assert.deepEqual(kw, ['additionalProperties', 'anyOf', 'enum', 'format', 'format', 'maxLength', 'minItems', 'minimum', 'not', 'oneOf'].sort());
  assert.ok(bad.errors.find((e) => e.path === '$.extra'));
  const missing = v.validate(schema, {});
  assert.deepEqual(missing.errors.map((e) => e.path).sort(), ['$.cp', '$.id', '$.tags']);
  assert.equal(v.validate({ type: 'integer' }, 1.5).valid, false);
  assert.equal(v.validate({ type: 'number' }, 2).valid, true);
});

test('Mock 生成：从 Schema 生成的 mock 能通过同一 Schema 校验', () => {
  const reg = new SchemaRegistry().loadFromDir();
  const resolve = (n) => reg.files.get(n) || null;
  let checked = 0;
  for (const c of reg.list()) {
    const contract = reg.get(c.id);
    const mock = mockFromSchema(contract.schema, { resolveExternal: resolve });
    const r = reg.validate(contract, mock);
    assert.equal(r.valid, true, `${c.id}: ${JSON.stringify(r.errors.slice(0, 3))}`);
    checked++;
  }
  assert.ok(checked >= 20);
});

test('TypeScript 类型生成：对象/可选/联合/数组/nullable', () => {
  const ts = toTs({ type: 'object', required: ['id'], properties: { id: { type: 'string' }, cp: { type: 'integer' }, tags: { type: 'array', items: { enum: ['a', 'b'] } }, n: { type: ['string', 'null'] } }, additionalProperties: false });
  assert.match(ts, /id: string;/);
  assert.match(ts, /cp\?: number;/);
  assert.match(ts, /tags\?: Array<"a" \| "b">;/);
  assert.match(ts, /n\?: string \| null;/);
  assert.doesNotMatch(ts, /\[key: string\]/);
});

test('SchemaRegistry：加载 9 个服务域的契约、按路由/状态匹配、真实形态响应通过校验', () => {
  const reg = new SchemaRegistry().loadFromDir();
  const list = reg.list();
  assert.ok(list.length >= 20);
  const services = new Set(list.map((c) => c.service));
  for (const s of ['user', 'pokemon', 'gateway']) assert.ok(services.has(s), s);
  assert.equal(reg.match('GET', '/v1/pokemon/my/0a1b2c3d-0000-4000-8000-000000000001', 200).id, 'pokemon.my.detail');
  assert.equal(reg.match('GET', '/v1/pokemon/my', 200).id, 'pokemon.my.list');
  assert.equal(reg.match('GET', '/v1/whatever', 404).id, 'error.any');
  assert.equal(reg.match('GET', '/v1/whatever', 200), null);
  assert.equal(statusMatches('4xx|5xx', 503), true);
  assert.equal(statusMatches(undefined, 201), true);
  const me = {
    success: true, code: 0, message: 'ok',
    data: { id: 'f908286b-27bf-4174-8cd8-4fb952877b58', nickname: 'cap', avatar_url: null, team: null, level: 1, xp: '0', stardust: 500, coins: 0, created_at: '2026-09-24T23:41:50.049Z', pokemon_count: 0 },
    _links: { self: { href: '/v1/users/me' } },
  };
  assert.equal(reg.validate('users.me', me).valid, true);
  const broken = JSON.parse(JSON.stringify(me));
  broken.data.level = 'one';
  delete broken.data.nickname;
  const r = reg.validate('users.me', broken);
  assert.equal(r.valid, false);
  assert.deepEqual(r.errors.map((e) => e.path).sort(), ['$.data.level', '$.data.nickname']);
  const err = { success: false, code: 1005, message: 'x', error: { code: 1005, name: 'NOT_FOUND', message: 'x' } };
  assert.equal(reg.validate('error.any', err).valid, true);
  assert.equal(reg.validate('error.any', { code: 1, message: 'x' }).valid, false);
});

test('Schema 校验性能：100 条精灵列表 < 5ms（REQ-00315 验收）', () => {
  const reg = new SchemaRegistry().loadFromDir();
  const pokemon = Array.from({ length: 100 }, (_, i) => ({ id: `0a1b2c3d-0000-4000-8000-${String(i).padStart(12, '0')}`, species_id: i + 1, cp: 100 + i, nickname: null, iv_attack: 1, iv_defense: 2, iv_hp: 3, is_shiny: false, name_zh: 'x', type1: 'GRASS', type2: null, sprite_url: '/s.png', rarity: 'COMMON', caught_at: '2026-09-20T10:00:00.000Z' }));
  const body = { success: true, code: 0, message: 'ok', data: { pokemon, total: 100, limit: 100, offset: 0 }, pagination: { type: 'offset', page: 1, pageSize: 100, limit: 100, offset: 0, total: 100, totalPages: 1, hasMore: false, hasNext: false, hasPrev: false } };
  reg.validate('pokemon.my.list', body); // 预热
  const times = [];
  for (let i = 0; i < 50; i++) times.push(reg.validate('pokemon.my.list', body).durationMs);
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p95 = times[Math.ceil(0.95 * times.length) - 1];
  // 共享 CI 机器负载波动大：用中位数判定，p95 放宽到 10ms 防偶发抖动
  assert.ok(median < 5, `median=${median}ms p95=${p95}ms`);
  assert.ok(p95 < 10, `median=${median}ms p95=${p95}ms`);
});

// ── REQ-00520：10 个历史/典型变更案例，检测准确率 >= 90% ──────────────
const base = () => ({
  'users.me': { method: 'GET', route: '/v1/users/me', auth: 'bearer', schema: { type: 'object', required: ['id', 'level'], properties: { id: { type: 'string' }, level: { type: 'integer' }, team: { type: 'string', enum: ['VALOR', 'MYSTIC', 'INSTINCT'] }, avatar: { type: 'string' } } } },
  'pokemon.list': { method: 'GET', route: '/v1/pokemon/my', auth: 'bearer', schema: { type: 'object', properties: { pokemon: { type: 'array', items: { type: 'object', required: ['id', 'cp'], properties: { id: { type: 'string' }, cp: { type: 'integer' } } } } } } },
  'rewards.daily': { method: 'GET', route: '/v1/rewards/daily', schema: { type: 'object', properties: { streak: { type: 'integer' } } }, requestSchema: { type: 'object', properties: { tz: { type: 'string', maxLength: 64 } } } },
  'payment.orders': { method: 'POST', route: '/v1/payment/orders', auth: 'bearer', schema: { type: 'object' }, requestSchema: { type: 'object', required: ['productId'], properties: { productId: { type: 'string' }, channel: { type: 'string' } } } },
});
const CASES = [
  { name: '删除端点（REQ-00045 旧设备接口下线）', mutate: (s) => { delete s['rewards.daily']; }, expect: 'ENDPOINT_REMOVED' },
  { name: '删除必填响应字段 level', mutate: (s) => { delete s['users.me'].schema.properties.level; s['users.me'].schema.required = ['id']; }, expect: 'REQUIRED_FIELD_REMOVED' },
  { name: 'cp 由 integer 改为 string', mutate: (s) => { s['pokemon.list'].schema.properties.pokemon.items.properties.cp = { type: 'string' }; }, expect: 'FIELD_TYPE_CHANGED' },
  { name: '订单新增必填请求字段 idempotencyKey', mutate: (s) => { s['payment.orders'].requestSchema.properties.idempotencyKey = { type: 'string' }; s['payment.orders'].requestSchema.required.push('idempotencyKey'); }, expect: 'REQUIRED_REQUEST_FIELD_ADDED' },
  { name: '删除可选字段 avatar', mutate: (s) => { delete s['users.me'].schema.properties.avatar; }, expect: 'OPTIONAL_FIELD_REMOVED' },
  { name: 'GET 改为 POST', mutate: (s) => { s['rewards.daily'].method = 'POST'; }, expect: 'METHOD_CHANGED' },
  { name: '公开接口新增鉴权', mutate: (s) => { s['rewards.daily'].auth = 'bearer'; }, expect: 'AUTH_CHANGED' },
  { name: '可选字段 channel 变为必填', mutate: (s) => { s['payment.orders'].requestSchema.required.push('channel'); }, expect: 'REQUIRED_REQUEST_FIELD_ADDED' },
  { name: '响应枚举新增值（旧客户端未知）', mutate: (s) => { s['users.me'].schema.properties.team.enum.push('HARMONY'); }, expect: 'ENUM_VALUE_REMOVED' },
  { name: '仅新增可选字段（兼容）', mutate: (s) => { s['users.me'].schema.properties.title = { type: 'string' }; }, expect: 'FIELD_ADDED', compatible: true },
];

test('兼容性引擎：10 个变更案例检测准确率 >= 90%，并给出严重级别（REQ-00520）', () => {
  let correct = 0;
  const details = [];
  for (const c of CASES) {
    const oldS = base();
    const newS = base();
    c.mutate(newS);
    const r = compat.detectContractChanges(oldS, newS);
    const hit = r.changes.some((x) => x.type === c.expect);
    const compatOk = c.compatible ? r.summary.compatible : !r.summary.compatible;
    if (hit && compatOk) correct++;
    details.push(`${hit && compatOk ? '✓' : '✗'} ${c.name}: ${r.changes.map((x) => x.type).join(',')}`);
  }
  const accuracy = correct / CASES.length;
  assert.ok(accuracy >= 0.9, `准确率 ${accuracy}\n${details.join('\n')}`);
  const removed = compat.detectContractChanges(base(), (() => { const s = base(); delete s['rewards.daily']; return s; })());
  assert.equal(removed.changes[0].severity, 'CRITICAL');
  assert.equal(removed.summary.blocking, true);
  const md = compat.generateMigrationGuide(removed);
  assert.match(md, /ENDPOINT_REMOVED/);
  assert.match(md, /迁移步骤/);
});

test('OpenAPI 文档对比：删除路径 / 方法变更 / 新增必填参数 / 新增鉴权', () => {
  const doc = () => ({
    openapi: '3.0.3',
    paths: {
      '/a': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/A' } } } } } } },
      '/b': { get: { parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }], responses: { 200: {} } } },
      '/c': { get: { security: [], responses: { 200: {} } } },
    },
    components: { schemas: { A: { type: 'object', required: ['x'], properties: { x: { type: 'integer' } } } } },
  });
  const n = doc();
  delete n.paths['/a'].get;
  n.paths['/a'].post = { responses: { 200: {} } };
  n.paths['/b'].get.parameters[0].required = true;
  n.paths['/c'].get.security = [{ bearer: [] }];
  n.components.schemas.A.properties.x.type = 'string';
  const r = compat.detectOpenApiChanges(doc(), n);
  const types = r.changes.map((c) => c.type);
  for (const t of ['METHOD_CHANGED', 'REQUIRED_REQUEST_FIELD_ADDED', 'AUTH_CHANGED']) assert.ok(types.includes(t), t);
  const r2 = compat.detectOpenApiChanges(doc(), (() => { const d = doc(); d.components.schemas.A.properties.x.type = 'string'; return d; })());
  assert.ok(r2.changes.some((c) => c.type === 'FIELD_TYPE_CHANGED'));
  const r3 = compat.detectOpenApiChanges(doc(), (() => { const d = doc(); delete d.paths['/c']; return d; })());
  assert.ok(r3.changes.some((c) => c.type === 'ENDPOINT_REMOVED'));
});

test('契约快照：当前契约相对已提交快照无未审批的破坏性变更（CI 门禁，REQ-00547）', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'contract-snapshot.js'), '--check', '--json'], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(r.unapprovedBreaking.length, 0, JSON.stringify(r.unapprovedBreaking.slice(0, 5)));
});

test('生成物与契约同步：TypeScript 类型、OpenAPI 组件（REQ-00315）', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-api-types.js'), '--check'], { encoding: 'utf8' });
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'generate-openapi-standards.js'), '--check'], { encoding: 'utf8' });
  const dts = fs.readFileSync(path.join(ROOT, 'frontend', 'game-client', 'src', 'types', 'api.generated.d.ts'), 'utf8');
  assert.match(dts, /export interface ErrorResponse/);
  assert.match(dts, /export type PokemonMyListResponse/);
});

test('契约测试框架：从注册中心自动生成用例（正向/未鉴权/非法请求体/Mock 自洽），覆盖全部契约（REQ-00547）', async () => {
  const ct = require(path.join(ROOT, 'scripts', 'contract-test.js'));
  const reg = new SchemaRegistry().loadFromDir();
  const cases = ct.generateCases(reg);
  const contracts = reg.list().map((c) => c.id);
  for (const id of contracts) assert.ok(cases.some((c) => c.contract === id && c.kind === 'mock'), `${id} 缺少 mock 用例`);
  for (const c of reg.list().filter((x) => x.route !== '*')) assert.ok(cases.some((x) => x.contract === c.id && x.kind === 'positive'), `${c.id} 缺少正向用例`);
  for (const c of reg.list().filter((x) => x.auth)) assert.ok(cases.some((x) => x.contract === c.id && x.kind === 'unauthorized' && x.expectStatus === 401), `${c.id} 缺少未鉴权用例`);
  assert.ok(cases.find((x) => x.id === 'pokemon.batch.details#invalid-body'));
  assert.equal(cases.find((x) => x.id === 'pokemon.my.detail#positive').path, '/v1/pokemon/my/{{pokemonId}}');
  assert.equal(cases[cases.length - 1].id, 'auth.refresh#positive', '轮换令牌的用例最后执行');
  assert.ok(cases.find((x) => x.id === 'auth.login#positive').skip);
  // 执行器：用假的 call 验证判定逻辑（状态码 + 契约校验）
  const fake = async (method, url, opts) => {
    if (url === '/v1/users/me' && opts.token) return { status: 200, body: { success: true, code: 0, message: 'ok', data: { id: 'f908286b-27bf-4174-8cd8-4fb952877b58', nickname: 'a', level: 1 } } };
    return { status: 401, body: { success: false, code: 1002, message: '未认证', error: { code: 1002, name: 'UNAUTHORIZED', message: '未认证' } } };
  };
  const picked = cases.filter((x) => ['users.me#positive', 'users.me#unauthorized', 'users.me#mock', 'rewards.daily#positive'].includes(x.id));
  const results = await ct.runCases(reg, picked, { call: fake, token: 't', vars: {} });
  const by = Object.fromEntries(results.map((r) => [r.id, r.result]));
  assert.deepEqual(by, { 'users.me#mock': 'pass', 'users.me#positive': 'pass', 'users.me#unauthorized': 'pass', 'rewards.daily#positive': 'fail' });
  assert.equal(ct.summarize(results).fail, 1);
});

test('契约草稿生成：从真实响应样本推断 Schema，推断结果能校验样本本身（REQ-00315 覆盖面扩展工具）', () => {
  const sc = require(path.join(ROOT, 'scripts', 'contract-scaffold.js'));
  const s = sc.inferSchema([
    { id: '0a1b2c3d-0000-4000-8000-000000000001', cp: 10, rate: 1, name: 'a', owner: null, tags: ['x'], at: '2026-09-25T00:00:00.000Z', extra: true },
    { id: '0a1b2c3d-0000-4000-8000-000000000002', cp: 12, rate: 1.5, name: 'b', owner: 'u', tags: [], at: '2026-09-25T01:00:00Z' },
  ]);
  assert.deepEqual(s.required, ['at', 'cp', 'id', 'name', 'owner', 'rate', 'tags']);
  assert.deepEqual(s.properties.id, { type: 'string', format: 'uuid' });
  assert.deepEqual(s.properties.cp, { type: 'integer' });
  assert.deepEqual(s.properties.rate, { type: 'number' });
  assert.deepEqual(s.properties.owner, { type: ['string', 'null'] });
  assert.deepEqual(s.properties.at, { type: 'string', format: 'date-time' });
  assert.deepEqual(s.properties.tags, { type: 'array', items: { type: 'string' } });
  const reg = new SchemaRegistry().loadFromDir();
  const bodies = [{ success: true, code: 0, message: 'ok', data: { gyms: [{ id: '0a1b2c3d-0000-4000-8000-000000000003', level: 2 }] } }];
  const c = sc.contractFromSamples({ id: 'gym.nearby', method: 'GET', route: '/v1/gyms/nearby', service: 'gym' }, bodies);
  assert.equal(c.schema.allOf[0].$ref, 'common#/definitions/SuccessEnvelope');
  reg.register({ ...c, service: 'gym' });
  assert.equal(reg.validate('gym.nearby', bodies[0]).valid, true);
  assert.equal(reg.validate('gym.nearby', { success: true, code: 0, message: 'ok', data: { gyms: [{ id: 'x', level: 'high' }] } }).valid, false);
  assert.deepEqual(sc.parseEndpoint('gym.detail GET /v1/gyms/:id=g1?x=1'), { id: 'gym.detail', method: 'GET', route: '/v1/gyms/:id', url: '/v1/gyms/g1?x=1' });
  assert.throws(() => sc.parseEndpoint('bad'), /无法解析/);
});
