#!/usr/bin/env node
/**
 * Epic E25 API 设计规范 —— 经网关的端到端冒烟
 *
 * 覆盖：响应/错误统一（REQ-00386）、内容协商 406/415/msgpack/回退（REQ-00368/554）、版本协商与生命周期/410/转换（REQ-00201/520）、
 *      端点弃用头与 410、迁移文档、客户端统计与通知（REQ-00407）、分页 offset/cursor/延迟关联（REQ-00302/465）、
 *      HATEOAS 与链接导航（REQ-00518）、字段投影/字段集/别名压缩（REQ-00532/251）、契约校验（REQ-00315/547）、
 *      批量请求/模板/流式/限流（REQ-00308）、精灵批量详情/合并/预取（REQ-00350）、流式压缩（REQ-00526）、
 *      转换管道管理（REQ-00542）、性能预算（REQ-00476）、重试（REQ-00402）、命名规范 lint（REQ-00329）
 *
 * 用法：BASE_URL=http://127.0.0.1:18380 node scripts/smoke-api-standards.js
 * 退出码：0 全部通过；1 有失败项
 */
'use strict';

const http = require('http');
const zlib = require('zlib');
const path = require('path');
const T = require('./lib/testUser');

const msgpack = require(path.join(T.ROOT, 'backend', 'shared', 'apiStandards', 'msgpack'));
const { expandPayload } = require(path.join(T.ROOT, 'backend', 'shared', 'apiStandards', 'fieldProjection'));
const { LinksBuilder } = require(path.join(T.ROOT, 'backend', 'shared', 'apiStandards', 'hateoas'));

const results = [];
const metricsOut = {};
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, b) => `${(100 * (1 - a / b)).toFixed(1)}%`;

let token, admin;
const c = (method, url, opts = {}) => T.call(method, url, { token, ip: T.randomIp(), ...opts });
const a = (method, url, opts = {}) => T.call(method, url, { token: admin, ip: T.randomIp(), ...opts });

function rawGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(T.BASE + url);
    const t0 = Date.now();
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      const chunks = [];
      let first = null;
      res.on('data', (d) => { if (first === null) first = Date.now() - t0; chunks.push(d); });
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks), ttfb: first, total: Date.now() - t0 }));
    });
    req.on('error', reject);
  });
}

async function main() {
  const redis = T.redisClient();
  await redis.connect();
  const pg = T.pgClient();
  await pg.connect();

  // ── 准备：普通用户 + 管理员 + 测试精灵 ───────────────────────
  const user = await T.registerUser(redis, { prefix: 'e25' });
  token = user.token;
  const adm = await T.registerUser(redis, { prefix: 'e25a' });
  await T.grantAdmin(pg, adm.userId);
  admin = await T.login(redis, adm.phone);
  const pokemonIds = await T.seedPokemon(pg, user.userId, 100);
  record('准备：测试用户 / 管理员 / 100 只测试精灵', !!token && !!admin && pokemonIds.length === 100);

  // ═════ REQ-00386 响应格式与错误统一 ═════
  const me = await c('GET', '/v1/users/me');
  record('统一响应：code=0 + success + meta.requestId + _links.self', me.status === 200 && me.body.code === 0 && me.body.success === true && !!me.body.meta.requestId && me.body._links.self.href === '/v1/users/me',
    `x-pipeline=${me.headers.get('x-pipeline')}`);
  record('Content-Type 含 charset、Vary 含 Accept', me.headers.get('content-type') === 'application/json; charset=utf-8' && /Accept/.test(me.headers.get('vary') || ''));
  const nf = await c('GET', '/v1/no-such-route');
  record('统一错误：404 保留旧 code=1005，补 error{name,i18nKey,docUrl}', nf.status === 404 && nf.body.code === 1005 && nf.body.error.name === 'NOT_FOUND' && nf.body.error.i18nKey === 'errors.general.not_found' && nf.body._links.help.href === '/api/errors/NOT_FOUND');
  const forb = await c('GET', '/api/admin/delay-queue/stats');
  record('统一错误：管理接口 403 由 HTML 变为 JSON', forb.status === 403 && forb.body && forb.body.error && forb.body.error.name === 'FORBIDDEN', `content-type=${forb.headers.get('content-type')}`);
  const cat = await c('GET', '/api/errors');
  const nfDoc = await c('GET', '/api/errors/NOT_FOUND');
  record('错误码目录 /api/errors 可查询', cat.status === 200 && cat.data.total >= 60 && nfDoc.data.httpStatus === 404, `total=${cat.data && cat.data.total}`);

  // ═════ REQ-00368 / REQ-00554 内容协商 ═════
  const na = await c('GET', '/v1/users/me', { headers: { Accept: 'text/csv' } });
  record('Accept 仅含不支持类型 → 406', na.status === 406 && na.body.error.name === 'NOT_ACCEPTABLE');
  const mp = await c('GET', '/v1/users/me', { headers: { Accept: 'application/x-msgpack' } });
  const mpBody = mp.status === 200 ? msgpack.decode(mp.buf) : null;
  record('Accept: application/x-msgpack → MessagePack', mp.headers.get('content-type') === 'application/x-msgpack' && mpBody && mpBody.data.id === me.data.id);
  const spJson = await c('GET', '/v1/pokemon/species?pageSize=100', { headers: { 'Accept-Encoding': 'identity' } });
  const spMp = await c('GET', '/v1/pokemon/species?pageSize=100', { headers: { Accept: 'application/x-msgpack', 'Accept-Encoding': 'identity' } });
  const spMpAlias = await c('GET', '/v1/pokemon/species?pageSize=100&_aliases=1', { headers: { Accept: 'application/x-msgpack', 'Accept-Encoding': 'identity' } });
  metricsOut.msgpackSaving = pct(spMp.buf.length, spJson.buf.length);
  metricsOut.msgpackAliasSaving = pct(spMpAlias.buf.length, spJson.buf.length);
  record('MessagePack 体积对比（图鉴 100 条）', spMp.buf.length < spJson.buf.length && (1 - spMpAlias.buf.length / spJson.buf.length) > 0.3,
    `json=${spJson.buf.length}B msgpack=${spMp.buf.length}B(${metricsOut.msgpackSaving}) msgpack+别名=${spMpAlias.buf.length}B(${metricsOut.msgpackAliasSaving})`);
  const pb = await c('GET', '/v1/users/me', { headers: { Accept: 'application/x-protobuf' } });
  record('未实现的 protobuf → 回退 JSON（X-Content-Fallback）', pb.status === 200 && /application\/json/.test(pb.headers.get('x-content-fallback') || ''));
  const vnd = await c('GET', '/v1/users/me', { headers: { Accept: 'application/vnd.minego.user.v1+json' } });
  record('厂商媒体类型 application/vnd.minego.user.v1+json', vnd.status === 200 && /vnd\.minego\.user\.v1\+json; charset=utf-8/.test(vnd.headers.get('content-type')));
  const t415 = await c('POST', '/v1/location', { body: 'lat=1', raw: true, headers: { 'Content-Type': 'text/plain' } });
  const n415 = await c('POST', '/v1/location', { body: '{"lat":1}', raw: true });
  record('POST 非 JSON / 缺 Content-Type → 415', t415.status === 415 && n415.status === 415 && t415.body.error.name === 'UNSUPPORTED_MEDIA_TYPE', `text=${t415.status} none=${n415.status}`);
  const mts = await c('GET', '/api/media-types');
  record('媒体类型注册表 /api/media-types', mts.status === 200 && mts.data.mediaTypes.some((m) => m.mediaType === 'application/x-msgpack'));

  // ═════ REQ-00201 / REQ-00520 版本 ═════
  const ver = await c('GET', '/api/version');
  record('版本列表含生命周期状态', ver.status === 200 && ver.data.versions.every((v) => ['development', 'testing', 'stable', 'deprecated', 'sunset'].includes(v.status)), ver.data && ver.data.versions.map((v) => `v${v.version}:${v.status}`).join(','));
  const hv = await c('GET', '/api/discover', { headers: { 'Accept-Version': '1' } });
  const mv = await c('GET', '/api/discover', { headers: { Accept: 'application/vnd.minego.v1+json' } });
  const bad = await c('GET', '/api/discover', { headers: { 'Accept-Version': '99' } });
  record('Header / 媒体类型版本协商；未知版本 400', hv.headers.get('x-api-version') === '1' && hv.headers.get('x-api-version-source') === 'header' && mv.headers.get('x-api-version-source') === 'media-type' && bad.status === 400);
  const dep = await a('PATCH', '/api/admin/api-versions/1', { body: { status: 'deprecated', sunsetAt: new Date(Date.now() + 90 * 86400000).toISOString(), migrationGuide: 'https://docs.minego.game/migration/v1-to-v2' } });
  const depCall = await c('GET', '/v1/users/me');
  record('v1 标记 deprecated → Deprecation / Sunset / Link successor-version', dep.status === 200 && /^@\d+$/.test(depCall.headers.get('deprecation') || '') && !!depCall.headers.get('sunset') && /rel="successor-version"/.test(depCall.headers.get('link') || ''),
    `deprecation=${depCall.headers.get('deprecation')}`);
  const bad2 = await a('PATCH', '/api/admin/api-versions/2', { body: { status: 'sunset' } });
  record('生命周期校验：stable → sunset 不允许（409）', bad2.status === 409);
  await a('PATCH', '/api/admin/api-versions/1', { body: { status: 'sunset' } });
  const gone = await c('GET', '/v1/users/me');
  record('v1 下线（sunset）→ 410 Gone', gone.status === 410 && gone.body.code === 1014, `status=${gone.status}`);
  const restore = await a('PATCH', '/api/admin/api-versions/1', { body: { status: 'stable', force: true } });
  const back = await c('GET', '/v1/users/me');
  record('管理接口恢复 v1 → 正常', restore.status === 200 && back.status === 200 && !back.headers.get('deprecation'));
  const rule = await a('POST', '/api/admin/api-versions/transforms', { body: { id: 'smoke-v1-me', version: 1, method: 'GET', path: '/v1/users/me', response: [{ op: 'rename', from: 'nickname', to: 'nick_name' }] } });
  const tr = await c('GET', '/v1/users/me');
  await a('DELETE', '/api/admin/api-versions/transforms/smoke-v1-me');
  const tr2 = await c('GET', '/v1/users/me');
  record('版本转换规则：v1 响应字段改名并可撤销', rule.status === 201 && tr.data.nick_name && !tr.data.nickname && tr.headers.get('x-api-transformed') === 'smoke-v1-me' && tr2.data.nickname, `applied=${tr.headers.get('x-api-transformed')}`);
  const bc = await c('GET', '/api/version/2/breaking-changes');
  const oa = await c('GET', '/api/version/1/openapi.json');
  record('破坏性变更可查询 / 按版本 OpenAPI', bc.status === 200 && bc.data.total >= 1 && oa.status === 200 && Object.keys(oa.body.paths || {}).length > 0, `changes=${bc.data && bc.data.total} paths=${oa.body && Object.keys(oa.body.paths || {}).length}`);
  const vadm = await a('GET', '/api/admin/api-versions');
  record('版本使用统计（api_version_usage）', vadm.status === 200 && vadm.data.usage.length > 0, `rows=${vadm.data && vadm.data.usage.length}`);

  // ═════ REQ-00407 端点弃用 ═════
  const dReg = await a('POST', '/api/admin/deprecations', { body: { endpoint: '/v1/rewards/season', method: 'GET', sunsetAt: new Date(Date.now() + 30 * 86400000).toISOString(), successorEndpoint: '/v2/rewards/season', breakingChanges: [{ field: 'freeTierRewards', change: 'renamed to rewards.free' }] } });
  const did = dReg.data && dReg.data.id;
  let dCall;
  for (let i = 0; i < 6; i++) dCall = await c('GET', '/v1/rewards/season', { headers: { 'X-Client-Id': 'smoke-client', 'X-Client-Version': '9.9.9' } });
  record('弃用接口响应头 Deprecation / Sunset / Link(successor-version)', dReg.status === 201 && !!dCall.headers.get('deprecation') && !!dCall.headers.get('sunset') && /<\/v2\/rewards\/season>; rel="successor-version"/.test(dCall.headers.get('link') || ''));
  record('弃用接口响应体 deprecation 字段（含迁移指南链接）', dCall.body.deprecation && dCall.body.deprecation.successorApi === '/v2/rewards/season' && dCall.body.deprecation.migrationGuide === `/api/deprecations/${did}/migration-guide`, `daysRemaining=${dCall.body.deprecation && dCall.body.deprecation.daysRemaining}`);
  const guide = await c('GET', `/api/deprecations/${did}/migration-guide`);
  const md = guide.buf.toString();
  record('自动生成迁移文档 Markdown（请求/响应对比、Breaking Changes、代码示例）', guide.status === 200 && /## Breaking Changes/.test(md) && /## 代码示例/.test(md) && /freeTierRewards/.test(md));
  const dDetail = await a('GET', `/api/admin/deprecations/${did}`);
  const client = dDetail.data && dDetail.data.clients.find((x) => x.client_id === 'smoke-client');
  record('按客户端统计弃用接口调用（client_migration_status）', !!client && client.deprecated_call_count >= 6 && client.client_version === '9.9.9', client ? `calls=${client.deprecated_call_count}` : '');
  // 用户维度（不带 X-Client-Id 的调用归到 user:<id>）并触发通知
  for (let i = 0; i < 6; i++) await c('GET', '/v1/rewards/season');
  const notify = await a('POST', '/api/admin/deprecations/notify', { body: { days: 60, minCalls: 5 } });
  const { rows: notes } = await pg.query(`SELECT COUNT(*)::int AS n FROM notification_history WHERE user_id = $1 AND type = 'api_deprecation'`, [user.userId]);
  record('高频调用弃用接口的用户收到站内通知', notify.status === 200 && notes[0].n >= 1, `candidates=${notify.data && notify.data.candidates} notified=${notify.data && notify.data.notified}`);
  const metricsTxt = (await T.call('GET', '/metrics')).buf.toString();
  record('Prometheus：api_deprecated_calls_total 按客户端记录', /api_deprecated_calls_total\{[^}]*client_id="smoke-client"/.test(metricsTxt));
  await a('PATCH', `/api/admin/deprecations/${did}`, { body: { sunsetAt: new Date(Date.now() - 60000).toISOString(), deprecatedAt: new Date(Date.now() - 86400000).toISOString() } });
  const dGone = await c('GET', '/v1/rewards/season');
  record('下线日期到达 → 410 Gone，响应体含迁移指引', dGone.status === 410 && dGone.body.error.name === 'API_SUNSET' && dGone.body.error.details.successorApi === '/v2/rewards/season');
  await a('DELETE', `/api/admin/deprecations/${did}`);
  const dBack = await c('GET', '/v1/rewards/season');
  record('取消弃用后恢复正常', dBack.status === 200 && !dBack.headers.get('deprecation'));

  // ═════ REQ-00302 / REQ-00465 分页 ═════
  const p1 = await c('GET', '/v1/pokemon/my?page=1&pageSize=10');
  record('offset 分页：pagination 与 meta.pagination、_links、Link 头', p1.status === 200 && p1.body.pagination.type === 'offset' && p1.body.pagination.total === 100 && p1.body.pagination.totalPages === 10 && p1.body.pagination.hasNext === true
    && JSON.stringify(p1.body.meta.pagination) === JSON.stringify(p1.body.pagination) && /page=2/.test(p1.body._links.next.href) && /rel="next"/.test(p1.headers.get('link') || ''), `total=${p1.body.pagination && p1.body.pagination.total}`);
  record('旧结构保留：data.pokemon / data.total / data.limit', Array.isArray(p1.data.pokemon) && p1.data.pokemon.length === 10 && p1.data.total === 100 && p1.data.limit === 10);
  const legacy = await c('GET', '/v1/pokemon/my?limit=5&offset=95');
  record('兼容 limit/offset；最后一页 hasNext=false', legacy.data.pokemon.length === 5 && legacy.body.pagination.hasNext === false && legacy.body.pagination.page === 20);
  const cur1 = await c('GET', '/v1/pokemon/my?cursor=first&pageSize=30');
  const cur2 = await c('GET', `/v1/pokemon/my?cursor=${encodeURIComponent(cur1.body.pagination.nextCursor)}&pageSize=30`);
  const overlap = cur2.data.pokemon.some((x) => cur1.data.pokemon.find((y) => y.id === x.id));
  record('游标分页：nextCursor 连续翻页无重叠', cur1.body.pagination.type === 'cursor' && cur2.status === 200 && cur2.data.pokemon.length === 30 && !overlap && cur2.data.pokemon[0].cp <= cur1.data.pokemon[29].cp);
  const badCur = await c('GET', '/v1/pokemon/my?cursor=forged.xxx');
  const badPage = await c('GET', '/v1/pokemon/my?page=0');
  record('非法游标 / 非法页码 → 400', badCur.status === 400 && badPage.status === 400, `cursor=${badCur.status} page=${badPage.status}`);
  const sp = await c('GET', '/v1/pokemon/species?page=2&pageSize=20');
  record('图鉴分页（pokemon-service 迁移）', sp.status === 200 && sp.body.pagination.page === 2 && sp.body.pagination.total >= 100 && !!sp.body._links.last && Array.isArray(sp.data), `total=${sp.body.pagination && sp.body.pagination.total}`);
  const fr = await c('GET', '/v1/friends?page=1&pageSize=10');
  const frBad = await c('GET', '/v1/friends?page=0');
  record('好友分页（social-service 迁移，E01 结构 data.friends + data.pagination）', fr.status === 200 && Array.isArray(fr.data.friends) && fr.data.pagination.limit === 10 && frBad.status === 400,
    `status=${fr.status} bad=${frBad.status}`);
  const lb = await c('GET', '/v1/rewards/leaderboard?page=1&pageSize=5');
  const lbDeep = await c('GET', '/v1/rewards/leaderboard?page=300&pageSize=5');
  record('排行榜分页（reward-service 迁移）；offset > 1000 自动延迟关联', lb.status === 200 && lb.body.pagination.pageSize === 5 && lbDeep.status === 200 && lbDeep.headers.get('x-pagination-strategy') === 'deferred-join',
    `strategy=${lbDeep.headers.get('x-pagination-strategy')}`);

  // ═════ REQ-00518 HATEOAS ═════
  const pid = pokemonIds[0];
  const det = await c('GET', `/v1/pokemon/my/${pid}`);
  const L = det.body && det.body._links;
  record('精灵详情 _links：self/species/powerUp/trainer/collection', det.status === 200 && L && L.self.href === `/v1/pokemon/my/${pid}` && L.powerUp.method === 'POST' && L.trainer.href === `/v1/users/${user.userId}` && L.collection.href === '/v1/pokemon/my');
  record('精灵列表：集合 _links + 每项 _links', p1.body._links.self && p1.data.pokemon[0]._links && p1.data.pokemon[0]._links.self.href === `/v1/pokemon/my/${p1.data.pokemon[0].id}`);
  // 链接导航：详情 → powerUp（按链接给出的方法与地址执行）
  const pu = await c(L.powerUp.method, L.powerUp.href, { body: {} });
  record('链接导航：按 _links.powerUp 执行操作（路由存在且业务校验生效）', pu.status !== 404 && pu.status !== 405 && !!pu.body, `status=${pu.status} code=${pu.body && pu.body.code}`);
  const selfNav = await c('GET', L.species.href);
  record('链接导航：_links.species → 图鉴详情', selfNav.status === 200 && selfNav.data.id === det.data.species_id);
  const near = await c('GET', '/v1/map/nearby?lat=31.2398&lng=121.5014&radius=1000');
  const stop = near.data && near.data.pokestops && near.data.pokestops[0];
  const wild = near.data && near.data.wildPokemons && near.data.wildPokemons[0];
  record('附近地图：野生精灵带 catch 链接、可转补给站带 spin 链接', near.status === 200 && (!wild || (wild._links && wild._links.catch && wild._links.catch.method === 'POST')) && (!stop || stop.can_spin === false || (stop._links && /\/spin$/.test(stop._links.spin.href))),
    `wild=${near.data && near.data.wildPokemons.length} stops=${near.data && near.data.pokestops.length}`);
  const hal = await c('GET', `/v1/pokemon/my/${pid}`, { headers: { Accept: 'application/hal+json' } });
  record('HAL 表示（Accept: application/hal+json）', hal.status === 200 && hal.body.id === pid && hal.body._links && /hal\+json/.test(hal.headers.get('content-type')));
  const disc = await c('GET', '/api/discover');
  record('资源发现 /api/discover', disc.status === 200 && disc.body._links.pokemon.href === '/v1/pokemon/my' && !!disc.body.resources.gym && LinksBuilder.parseLinkHeader(p1.headers.get('link')).next);

  // ═════ REQ-00532 / REQ-00251 字段投影 ═════
  const f1 = await c('GET', '/v1/pokemon/my?pageSize=5&fields=id,cp');
  record('?fields=id,cp 只返回指定字段（保留容器与分页）', f1.status === 200 && Object.keys(f1.data.pokemon[0]).sort().join(',') === '_links,cp,id' && f1.data.total === 100);
  const fs1 = await c('GET', '/v1/pokemon/my?pageSize=5&fieldset=list');
  record('?fieldset=list 预定义字段集', fs1.status === 200 && fs1.data.pokemon[0].cp !== undefined && fs1.data.pokemon[0].iv_attack === undefined);
  const fbad = await c('GET', '/v1/pokemon/my?fields=id,secret_sauce');
  record('无效字段 → 400 并返回允许字段列表', fbad.status === 400 && fbad.body.error.name === 'INVALID_FIELDS' && fbad.body.error.details.allowedFields.includes('cp'));
  const fmany = await c('GET', `/v1/users/me?fields=${Array.from({ length: 51 }, (_, i) => `f${i}`).join(',')}`);
  record('字段数上限 50', fmany.status === 400);
  const fme = await c('GET', '/v1/users/me?fields=id,nickname');
  record('单资源字段投影 /v1/users/me?fields=id,nickname', fme.status === 200 && Object.keys(fme.data).sort().join(',') === 'id,nickname' && fme.body.code === 0);
  const full = await c('GET', '/v1/pokemon/my?pageSize=50', { headers: { 'Accept-Encoding': 'identity' } });
  const al = await c('GET', '/v1/pokemon/my?pageSize=50&_aliases=1', { headers: { 'Accept-Encoding': 'identity' } });
  const restored = expandPayload({ $a: al.body._aliases, $d: al.body.data });
  metricsOut.aliasSaving = pct(al.buf.length, full.buf.length);
  record('别名压缩：键 ≤ 3 字符、可还原、精灵列表体积 >= 30% 减少', Object.keys(al.body._aliases).every((k) => k.length <= 3) && restored.pokemon.length === 50 && restored.pokemon[0].cp === full.data.pokemon[0].cp && (1 - al.buf.length / full.buf.length) >= 0.3,
    `${full.buf.length}B → ${al.buf.length}B（${metricsOut.aliasSaving}）`);
  await sleep(100);
  const fu = await a('GET', '/api/admin/api-standards/field-usage/pokemon');
  record('字段使用统计 field_usage_stats', fu.status === 200 && fu.data.some((x) => x.field_name === 'cp'));

  // ═════ REQ-00315 / REQ-00547 契约 ═════
  await a('PATCH', '/api/admin/api-standards/config', { body: { schemaValidation: { sampleRate: 1 } } });
  const v1 = await c('GET', '/v1/users/me');
  const v2 = await c('GET', '/v1/pokemon/my?pageSize=3');
  const v3 = await c('GET', '/v1/no-such');
  record('契约校验（采样率 1）：关键接口通过', /^pass; contract=users\.me/.test(v1.headers.get('x-schema-validation') || '') && /^pass; contract=pokemon\.my\.list/.test(v2.headers.get('x-schema-validation') || '') && /^pass; contract=error\.any/.test(v3.headers.get('x-schema-validation') || ''),
    `${v1.headers.get('x-schema-validation')} | ${v2.headers.get('x-schema-validation')}`);
  const sampled = [];
  for (const u of ['/v1/pokemon/species?pageSize=5', '/v1/rewards/daily', '/v1/map/nearby?lat=31.2398&lng=121.5014&radius=1000', '/v1/users/me/inventory', '/v1/payment/products', '/v1/pokemon/pokedex', `/v1/pokemon/my/${pid}`, '/api/version', '/api/discover', '/v1/friends']) {
    const r = await c('GET', u);
    sampled.push(`${u.split('?')[0]}=${(r.headers.get('x-schema-validation') || 'none').split(';')[0]}`);
  }
  record('契约校验覆盖 10 个接口全部通过', sampled.every((s) => s.endsWith('=pass')), sampled.join(' '));
  await a('PATCH', '/api/admin/api-standards/config', { body: { schemaValidation: { sampleRate: 0.1 } } });
  const sl = await a('GET', '/api/admin/api-standards/schemas');
  const sh = await a('GET', '/api/admin/api-standards/schemas/users.me');
  const mock = await a('GET', '/api/admin/api-standards/schemas/pokemon.my.list/mock');
  const viol = await a('GET', '/api/admin/api-standards/schemas/violations');
  record('Schema Registry：契约列表 / 版本历史 / Mock / 违规记录', sl.data.total >= 20 && sh.data.history.length >= 1 && !!mock.data.mock && viol.status === 200, `contracts=${sl.data.total} history=${sh.data.history.length} violations=${viol.data.total}`);
  const vbody = await a('POST', '/api/admin/api-standards/schemas/users.me/validate', { body: { body: { success: true, code: 0, data: { id: 'x' } } } });
  record('差异检测：错误响应结构被识别', vbody.data.valid === false && vbody.data.errors.length >= 2, vbody.data.errors.map((e) => e.path).join(','));
  const comp = await a('GET', '/api/admin/api-standards/compat-report');
  record('兼容性报告：当前契约相对快照无破坏性变更', comp.status === 200 && comp.data.summary.compatible === true, `changes=${comp.data && comp.data.summary.total}`);

  // ═════ REQ-00308 批量请求 ═════
  const batch = await c('POST', '/api/v1/batch', { body: { requests: [
    { id: 'me', path: '/v1/users/me', priority: 'high' }, { id: 'daily', path: '/v1/rewards/daily' },
    { id: 'my', path: '/v1/pokemon/my?pageSize=5' }, { id: 'missing', path: `/v1/pokemon/my/${'0'.repeat(8)}-0000-4000-8000-000000000000` },
  ], options: { cacheTTL: 60 } } });
  const bd = batch.data || {};
  record('批量：4 个子请求并行执行，失败不影响其他', batch.status === 200 && bd.summary.total === 4 && bd.summary.success === 3 && bd.summary.failed === 1 && bd.responses.find((r) => r.id === 'missing').status === 404,
    `total=${bd.summary && bd.summary.totalDuration}ms 串行估计=${bd.summary && bd.summary.sequentialEstimate}ms costSaved=$${bd.summary && bd.summary.costSaved}`);
  record('批量：并行总耗时 < 子请求耗时之和', bd.summary && bd.summary.totalDuration < bd.summary.sequentialEstimate);
  const batch2 = await c('POST', '/api/v1/batch', { body: { requests: [{ id: 'me', path: '/v1/users/me' }, { id: 'daily', path: '/v1/rewards/daily' }], options: { cacheTTL: 60 } } });
  record('批量：GET 结果缓存，重复请求命中', batch2.data.summary.cached === 2, `cached=${batch2.data.summary.cached}`);
  const ff = await c('POST', '/api/v1/batch', { body: { requests: [{ id: 'bad', path: '/v1/no-such', priority: 'high' }, { id: 'a', path: '/v1/users/me' }, { id: 'b', path: '/v1/rewards/daily' }], options: { failFast: true, parallel: false } } });
  record('批量：failFast=true 首个失败后中止其余', ff.data.summary.failedFast === true && ff.data.responses.filter((r) => r.status === 499).length === 2);
  const nested = await c('POST', '/api/v1/batch', { body: { requests: [{ path: '/api/v1/batch' }] } });
  const tooMany = await c('POST', '/api/v1/batch', { body: { requests: Array.from({ length: 21 }, () => ({ path: '/v1/users/me' })) } });
  record('批量：禁止嵌套 / 超过 20 个子请求 → 400', nested.status === 400 && tooMany.status === 400 && tooMany.body.error.name === 'BATCH_LIMIT_EXCEEDED');
  const tpl = await c('GET', '/api/v1/batch/templates');
  const tplRuns = [];
  for (const t of tpl.data.templates) {
    const params = { id: pid, speciesId: det.data.species_id, lat: 31.2398, lng: 121.5014 };
    const r = await c('POST', `/api/v1/batch/templates/${t.name}`, { body: { params } });
    tplRuns.push(`${t.name}:${r.status === 200 ? `${r.data.summary.success}/${r.data.summary.total}` : r.status}`);
  }
  record('批量：预定义模板全部可执行（集成覆盖）', tpl.data.total >= 4 && tplRuns.every((x) => /:(\d+)\/\1$/.test(x)), tplRuns.join(' '));
  const st = await rawGet('/api/v1/batch?stream=1', {});
  void st;
  const streamRes = await fetch(`${T.BASE}/api/v1/batch?stream=1`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Forwarded-For': T.randomIp(), 'Accept-Encoding': 'br' },
    body: JSON.stringify({ requests: [{ id: 'slow', path: '/v1/pokemon/my?pageSize=50', priority: 'low' }, { id: 'fast', path: '/v1/users/me', priority: 'high' }] }) });
  const lines = (await streamRes.text()).trim().split('\n').map((l) => JSON.parse(l));
  record('批量流式（NDJSON）：高优先级先返回，最后一行 summary', streamRes.status === 200 && lines[0].id === 'fast' && lines[lines.length - 1].type === 'summary', `order=${lines.map((l) => l.id || l.type).join(',')}`);
  let limited = null;
  for (let i = 0; i < 61 && !limited; i++) {
    const r = await c('POST', '/api/v1/batch', { body: { requests: [{ path: '/v1/users/me' }] } });
    if (r.status === 429) limited = r;
  }
  record('批量：每用户每分钟 60 次限流（429 + Retry-After）', !!limited && limited.body.error.name === 'BATCH_RATE_LIMITED' && !!limited.headers.get('retry-after'), limited ? `retry-after=${limited.headers.get('retry-after')}` : '未触发');
  const bstats = await c('GET', '/api/v1/batch/stats');
  record('批量统计 batch_request_stats + Prometheus 指标', bstats.data.batches >= 5 && /api_batch_requests_total/.test((await T.call('GET', '/metrics')).buf.toString()), `batches=${bstats.data.batches} costSaved=$${bstats.data.cost_saved_usd}`);

  // ═════ REQ-00350 精灵批量详情 ═════
  const inc = ['skills', 'equipment', 'effects', 'battle', 'history'];
  const bq = await c('POST', '/v1/pokemon/batch/details', { body: { ids: pokemonIds, include: inc, options: { cacheStrategy: 'bypass' } } });
  record('POST /v1/pokemon/batch/details：100 个 id + 5 类 include，单连接', bq.status === 200 && bq.data.metadata.found === 100 && bq.data.metadata.dbConnections === 1 && !!bq.data.results[pid].skills && Array.isArray(bq.data.results[pid].history),
    `queryTime=${bq.data && bq.data.metadata.queryTime}ms dbQueries=${bq.data && bq.data.metadata.dbQueries}`);
  const lats = [];
  for (let i = 0; i < 20; i++) {
    const r = await c('POST', '/api/v1/pokemon/batch/details', { body: { ids: pokemonIds, include: inc, options: { cacheStrategy: 'bypass' } } });
    lats.push(r.ms);
  }
  lats.sort((x, y) => x - y);
  metricsOut.batch100P95 = +lats[Math.ceil(0.95 * lats.length) - 1].toFixed(1);
  record('100 个精灵详情批量查询 P95 < 500ms（经网关，不走缓存）', metricsOut.batch100P95 < 500, `p50=${lats[10].toFixed(1)}ms p95=${metricsOut.batch100P95}ms`);
  await c('POST', '/v1/pokemon/batch/details', { body: { ids: pokemonIds, include: inc } });
  const bq2 = await c('POST', '/v1/pokemon/batch/details', { body: { ids: pokemonIds, include: inc } });
  metricsOut.batchCacheHitRate = bq2.data.metadata.cacheHitRate;
  record('批量查询缓存命中率 >= 60%（重复查询）', bq2.data.metadata.cacheHitRate >= 0.6, `hitRate=${bq2.data.metadata.cacheHitRate}`);
  const foreign = await c('POST', '/v1/pokemon/batch/details', { body: { ids: [pid, '0a1b2c3d-0000-4000-8000-999999999999'] } });
  const bad3 = await c('POST', '/v1/pokemon/batch/details', { body: { ids: ['x'] } });
  record('批量：非本人/不存在的 id 进 errors；非法 id → 400', foreign.data.metadata.found === 1 && foreign.data.errors['0a1b2c3d-0000-4000-8000-999999999999'].code === 'NOT_FOUND' && bad3.status === 400);
  const other = await T.registerUser(redis, { prefix: 'e25o' });
  const peek = await T.call('POST', '/v1/pokemon/batch/details', { token: other.token, ip: T.randomIp(), body: { ids: [pid] } });
  record('安全：他人无法通过批量接口（或其缓存）读取不属于自己的精灵', peek.status === 200 && peek.data.metadata.found === 0);
  const byIds = await c('GET', `/v1/pokemon/my?ids=${pokemonIds.slice(0, 3).join(',')}`);
  record('GET /v1/pokemon/my?ids=… 按 id 批量取', byIds.status === 200 && byIds.data.pokemon.length === 3);
  await c('GET', '/v1/pokemon/my?pageSize=20&sort=caught'); // 触发预取前 10 个
  await sleep(500);
  const listTop = (await c('GET', '/v1/pokemon/my?pageSize=10&sort=caught')).data.pokemon.map((x) => x.id);
  const concurrent = await Promise.all(listTop.slice(0, 8).map((x) => c('GET', `/v1/pokemon/my/${x}`)));
  const pstats = await a('GET', '/v1/pokemon/batch/metrics');
  metricsOut.prefetch = pstats.data;
  record('详情预取 + 50ms 请求合并统计', concurrent.every((r) => r.status === 200) && pstats.status === 200 && pstats.data.hits >= 1,
    `prefetched=${pstats.data && pstats.data.prefetched} hits=${pstats.data && pstats.data.hits} accuracy=${pstats.data && pstats.data.accuracy} merged=${pstats.data && pstats.data.coalescer.merged}`);

  // ═════ REQ-00526 流式压缩 ═════
  const stream = await rawGet('/v1/pokemon/species/stream', { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'br', 'X-Forwarded-For': T.randomIp() });
  const ndLines = zlib.brotliDecompressSync(stream.body).toString().trim().split('\n');
  const buffered = await rawGet('/v1/pokemon/species?pageSize=200', { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'br', 'X-Forwarded-For': T.randomIp() });
  record('图鉴 NDJSON 流经网关 Brotli 流式压缩，客户端逐行解析', stream.res.statusCode === 200 && stream.res.headers['content-encoding'] === 'br' && ndLines.length >= 100 && JSON.parse(ndLines[ndLines.length - 1])._summary,
    `lines=${ndLines.length} 压缩后=${stream.body.length}B ttfb=${stream.ttfb}ms total=${stream.total}ms；缓冲 JSON ttfb=${buffered.ttfb}ms total=${buffered.total}ms`);
  await new Promise((resolve) => {
    const u = new URL(`${T.BASE}/v1/pokemon/species/stream`);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'br' } }, (res) => { res.once('data', () => { req.destroy(); setTimeout(resolve, 300); }); });
    req.on('error', () => resolve());
  });
  const health = await T.call('GET', '/health');
  record('流中途断开后网关与服务正常', health.status === 200);
  const big = await c('GET', '/v1/pokemon/pokedex', { headers: { 'Accept-Encoding': 'br' } });
  record('大响应 Brotli 压缩（Content-Encoding: br）', big.status === 200 && big.headers.get('content-encoding') === 'br');

  // ═════ REQ-00542 转换管道 ═════
  const pl = await a('GET', '/api/v1/pipelines');
  const tf = await a('GET', '/api/v1/transformers');
  record('管道 / 转换器列表（YAML 配置已加载）', pl.status === 200 && pl.data.pipelines.some((p) => p.name === 'default') && pl.data.pipelines.some((p) => p.name === 'large-response') && tf.data.transformers.filter((t) => t.builtin).length >= 20,
    `pipelines=${pl.data && pl.data.pipelines.map((p) => p.name).join(',')}`);
  const dt = await a('POST', '/api/v1/transformers', { body: { name: 'smokeTag', type: 'setHeader', config: { headers: { 'X-Smoke': '1' } } } });
  const defStages = pl.data.pipelines.find((p) => p.name === 'default').stages.map(({ transformer, condition, phase }) => ({ transformer, phase, ...(condition ? { condition } : {}) }));
  const np = await a('POST', '/api/v1/pipelines', { body: { name: 'smoke-pipeline', config: { description: 'smoke', metadata: { route: '/v1/rewards/season', method: 'GET' }, stages: [...defStages.slice(0, -1), { transformer: 'smokeTag' }, defStages[defStages.length - 1]] } } });
  const viaPipe = await c('GET', '/v1/rewards/season');
  const delP = await a('DELETE', '/api/v1/pipelines/smoke-pipeline');
  const after = await c('GET', '/v1/rewards/season');
  record('动态管道：创建 → 按路由选择生效（声明式转换器）→ 删除', dt.status === 201 && np.status === 201 && /^smoke-pipeline/.test(viaPipe.headers.get('x-pipeline') || '') && viaPipe.headers.get('x-smoke') === '1' && delP.status === 200 && /^default/.test(after.headers.get('x-pipeline') || ''));
  const invalid = await a('POST', '/api/v1/pipelines', { body: { name: 'bad', config: { stages: [{ transformer: 'nope' }] } } });
  record('非法管道配置被拒绝（400）', invalid.status === 400);
  for (let i = 0; i < 5; i++) await c('GET', '/v1/pokemon/species/1');
  const pm = await a('GET', '/api/v1/pipelines/default/metrics?period=1h');
  metricsOut.pipeline = { avgMs: pm.data.avgMs, p95Ms: pm.data.p95Ms, cacheHitRate: pm.data.cacheHitRate };
  record('管道性能统计：执行耗时、缓存命中率（重复请求场景）', pm.status === 200 && pm.data.executions > 0 && pm.data.cacheHitRate !== null && pm.data.cacheHits > 0, `avg=${pm.data.avgMs}ms p95=${pm.data.p95Ms}ms hitRate=${pm.data.cacheHitRate}`);
  const rc = await a('POST', '/api/v1/pipelines/default/refresh-cache');
  record('刷新管道缓存', rc.status === 200 && rc.data.cleared >= 0);
  const ns = await c('GET', '/v1/pokemon/pokedex');
  record('大型响应管道（large-response）流式透传', /large-response; passthrough/.test(ns.headers.get('x-pipeline') || ''), ns.headers.get('x-pipeline'));

  // ═════ REQ-00476 性能预算 / REQ-00402 重试 / REQ-00329 lint ═════
  const pf = await a('GET', '/api/admin/api-standards/performance');
  record('性能预算：各接口实测百分位、达标率、热点榜单', pf.status === 200 && pf.data.routes.length > 5 && pf.data.hotspots.length > 0 && pf.data.summary.configuredRoutes >= 5, `compliance=${pf.data.summary.complianceRate} hottest=${pf.data.hotspots[0] && pf.data.hotspots[0].route}`);
  const rt = await a('GET', '/api/admin/api-standards/retry');
  record('重试配置与统计（retry_configs / retry_stats_hourly）', rt.status === 200 && rt.data.configs.some((x) => x.service_name === 'gateway-batch'));
  record('429 响应带 Retry-After 与 error.retryAfter', !!limited && Number(limited.body.error.retryAfter) > 0);
  const li = await a('GET', '/api/admin/api-standards/lint');
  record('API 命名规范统计（管理接口）', li.status === 200 && li.data.summary.errors === 0 && li.data.summary.routes > 500, `routes=${li.data.summary.routes} warnings=${li.data.summary.warnings} compliance=${li.data.summary.complianceRate}`);

  // 清理
  await pg.query('DELETE FROM pokemon_instances WHERE user_id = $1', [user.userId]).catch(() => {});
  await pg.end();
  await redis.quit();
}

main()
  .catch((err) => record('执行异常', false, err.stack || err.message))
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n测量值：${JSON.stringify(metricsOut)}`);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  });
