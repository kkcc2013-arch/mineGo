#!/usr/bin/env node
/**
 * 核心链路端到端冒烟测试（经网关）
 *
 *   注册 → 登录 → 上报位置 → 附近精灵 → 创建捕捉会话 → 投掷 → 背包 → 刷新/登出
 *   + 若干安全回归检查（验证码不回传、坐标校验、管理接口鉴权、伪造身份头）
 *
 * 用法：
 *   node scripts/smoke-core-flow.js
 * 环境变量：
 *   BASE_URL   网关地址，默认 http://127.0.0.1:8080
 *   REDIS_URL  读取短信验证码用（生产模式验证码不回传），默认从仓库根目录 .env 推导
 *   SMOKE_LAT / SMOKE_LNG  刷怪中心点，默认上海陆家嘴（与 backend/seed_spawns.js 一致）
 *
 * 退出码：0 全部通过；1 有失败项
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const Redis = require(path.join(ROOT, 'backend', 'node_modules', 'ioredis'));

function loadEnv() {
  const f = path.join(ROOT, '.env');
  const env = {};
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return env;
}

const fileEnv = loadEnv();
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const REDIS_URL = process.env.REDIS_URL || fileEnv.REDIS_URL ||
  `redis://:${encodeURIComponent(fileEnv.REDIS_PASSWORD || '')}@${fileEnv.REDIS_HOST || '127.0.0.1'}:${fileEnv.REDIS_PORT || 6379}/0`;
const CENTER = { lat: Number(process.env.SMOKE_LAT || 31.2398), lng: Number(process.env.SMOKE_LNG || 121.5014) };

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
}

async function call(method, url, { body, token, headers = {} } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: json, data: json && json.data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();

  // 0. 健康检查
  const health = await call('GET', '/health');
  const down = (health.body.services || []).filter((s) => s.status !== 'up').map((s) => s.name);
  record('网关健康检查：全部下游服务 up', health.status === 200 && down.length === 0, down.length ? `down: ${down}` : '');

  // 1. 短信验证码（生产模式下不得回传 dev_code）
  const phone = `13${String(Date.now()).slice(-9)}`;
  const sms = await call('POST', '/v1/auth/sms-code', { body: { phone, scene: 'register' } });
  record('发送验证码 /v1/auth/sms-code', sms.status === 200, `status=${sms.status}`);
  record('安全：响应中不包含验证码', sms.status === 200 && !(sms.data && sms.data.dev_code));
  const code = await redis.get(`sms:code:${phone}:register`);

  // 2. 注册（缺少 consent 应被拒绝）
  const noConsent = await call('POST', '/v1/auth/register', { body: { phone, smsCode: code, nickname: `smk${phone.slice(-6)}` } });
  record('注册：缺少隐私同意被拒绝', noConsent.status === 400, `status=${noConsent.status}`);
  const reg = await call('POST', '/v1/auth/register', {
    body: { phone, smsCode: code, nickname: `smk${phone.slice(-6)}`, consent: { privacyPolicy: true, termsOfService: true } },
  });
  record('注册 /v1/auth/register', [200, 201].includes(reg.status) && !!(reg.data && reg.data.accessToken), `status=${reg.status} ${![200, 201].includes(reg.status) ? JSON.stringify(reg.body).slice(0, 160) : ''}`);
  if (!reg.data || !reg.data.accessToken) throw new Error('注册失败，后续步骤无法继续');

  // 3. 登录
  await redis.del(`sms:lock:${phone}`);
  await call('POST', '/v1/auth/sms-code', { body: { phone, scene: 'login' } });
  const loginCode = await redis.get(`sms:code:${phone}:login`);
  const wrong = await call('POST', '/v1/auth/login', { body: { phone, smsCode: loginCode === '000000' ? '111111' : '000000' } });
  record('登录：错误验证码被拒绝', wrong.status === 400, `status=${wrong.status}`);
  const login = await call('POST', '/v1/auth/login', { body: { phone, smsCode: loginCode } });
  record('登录 /v1/auth/login', login.status === 200 && !!(login.data && login.data.accessToken), `status=${login.status}`);
  const token = login.data.accessToken;
  const refreshToken = login.data.refreshToken;

  // 4. 个人信息
  const me = await call('GET', '/v1/users/me', { token });
  record('个人信息 /v1/users/me', me.status === 200, `status=${me.status}`);

  // 5. 附近精灵（首次请求触发附近刷怪，异步完成）
  let wild = [];
  for (let i = 0; i < 10 && wild.length === 0; i++) {
    const nearby = await call('GET', `/v1/map/nearby?lat=${CENTER.lat}&lng=${CENTER.lng}&radius=1000`, { token });
    if (nearby.status !== 200) { record('附近精灵 /v1/map/nearby', false, `status=${nearby.status}`); break; }
    wild = (nearby.data && nearby.data.wildPokemons) || [];
    if (!wild.length) await sleep(1500);
  }
  record('附近精灵 /v1/map/nearby 返回野生精灵', wild.length > 0, `count=${wild.length}`);
  if (!wild.length) throw new Error('没有刷出精灵，无法继续捕捉测试');

  // 6. 先在第一只精灵旁上报真实位置，再做伪造坐标 / 远程捕捉的负面测试
  const target = wild[0];
  var lastPos = { lat: Number(target.lat) + 0.0001, lng: Number(target.lng) }; // eslint-disable-line no-var
  const firstLoc = await call('POST', '/v1/location', { token, body: { ...lastPos, accuracy: 10 } });
  record('上报位置 /v1/location', firstLoc.status === 200, `status=${firstLoc.status} risk=${firstLoc.data && firstLoc.data.riskLevel}`);
  const bad = await call('POST', '/v1/catch/session', { token, body: { spawnId: target.id, playerLat: 'x', playerLng: 'y' } });
  record('安全：非数字坐标创建捕捉会话被拒绝', bad.status === 400, `status=${bad.status}`);
  const far = await call('POST', '/v1/catch/session', { token, body: { spawnId: target.id, playerLat: Number(target.lat) + 0.05, playerLng: Number(target.lng) } });
  // 坐标与精灵相距 5km：可能被距离校验拒绝（400），也可能被反作弊判定为瞬移（403）
  record('安全：距离过远被拒绝', far.status === 400 || far.status === 403, `status=${far.status}`);

  // 7. 上报位置到精灵附近 → 捕捉
  const distM = (a, b) => {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  let caught = null;
  let caughtWildId = null;
  let throws = 0;
  // 从第一只开始，按与其距离排序，尽量少走路
  const first = { lat: Number(wild[0].lat), lng: Number(wild[0].lng) };
  const ordered = wild.slice().sort((a, b) =>
    distM(first, { lat: Number(a.lat), lng: Number(a.lng) }) - distM(first, { lat: Number(b.lat), lng: Number(b.lng) }));
  for (const w of ordered.slice(0, 6)) {
    const pos = { lat: Number(w.lat) + 0.0001, lng: Number(w.lng) };
    if (lastPos) {
      // 以约 36 km/h 的速度"走过去"，避免触发服务端速度异常检测
      const waitMs = Math.ceil(distM(lastPos, pos) / 10) * 1000;
      if (waitMs > 20000) continue;
      await sleep(waitMs);
    }
    const { lat, lng } = pos;
    const loc = await call('POST', '/v1/location', { token, body: { lat, lng, accuracy: 10 } });
    if (loc.status !== 200) { record('上报位置 /v1/location', false, `status=${loc.status}`); break; }
    lastPos = pos;
    const sess = await call('POST', '/v1/catch/session', { token, body: { spawnId: w.id, playerLat: lat, playerLng: lng } });
    if (sess.status !== 200) {
      console.log(`   (跳过 ${w.id}: status=${sess.status} ${JSON.stringify(sess.body).slice(0, 120)})`);
      continue;
    }
    const sessionId = sess.data.sessionId;
    for (let i = 0; i < 25; i++) {
      const t = await call('POST', '/v1/catch/throw', { token, body: { sessionId, ballType: 'POKE_BALL', throwRating: 'EXCELLENT', isCurve: true } });
      throws++;
      if (t.status !== 200) { record('投掷 /v1/catch/throw', false, `status=${t.status} ${JSON.stringify(t.body).slice(0, 160)}`); break; }
      if (t.data.result === 'CAUGHT') { caught = t.data; caughtWildId = w.id; break; }
      if (t.data.result === 'FLED') break;
    }
    if (caught) break;
  }
  record('捕捉成功 /v1/catch/throw → CAUGHT', !!caught, caught ? `species=${caught.pokemon.name} cp=${caught.pokemon.cp} throws=${throws}` : `throws=${throws}`);

  // 8. 背包中能看到这只精灵
  if (caught) {
    const my = await call('GET', '/v1/pokemon/my?limit=20', { token });
    const list = (my.data && (my.data.pokemon || my.data.items || my.data.list || my.data)) || [];
    const arr = Array.isArray(list) ? list : [];
    const found = arr.some((p) => p.id === caught.pokemonInstanceId);
    record('背包 /v1/pokemon/my 包含新捕获的精灵', my.status === 200 && found, `status=${my.status} count=${arr.length}`);

    // 已捕获的精灵不应再出现在附近列表
    const nearby2 = await call('GET', `/v1/map/nearby?lat=${CENTER.lat}&lng=${CENTER.lng}&radius=1000`, { token });
    const still = ((nearby2.data && nearby2.data.wildPokemons) || []).some((w) => String(w.id) === String(caughtWildId));
    record('已捕获精灵从附近列表移除', nearby2.status === 200 && !still);
  }

  // 8b. 补给站：必须在 80 米内；冷却期内不能重复旋转
  const nb = await call('GET', `/v1/map/nearby?lat=${CENTER.lat}&lng=${CENTER.lng}&radius=1000`, { token });
  const stops = ((nb.data && nb.data.pokestops) || []).map((p) => ({ ...p, lat: Number(p.lat), lng: Number(p.lng) }));
  if (stops.length && lastPos) {
    stops.sort((a, b) => distM(lastPos, a) - distM(lastPos, b));
    const stop = stops[0];
    const farStop = stops.find((p) => distM(stop, p) > 200);
    const waitMs = Math.ceil(distM(lastPos, stop) / 10) * 1000;
    if (waitMs <= 60000) {
      await sleep(waitMs);
      await call('POST', '/v1/location', { token, body: { lat: stop.lat, lng: stop.lng, accuracy: 10 } });
      lastPos = { lat: stop.lat, lng: stop.lng };
      const spin1 = await call('POST', `/v1/pokestops/${stop.id}/spin`, { token, body: {} });
      record('补给站旋转 /v1/pokestops/:id/spin', spin1.status === 200, `status=${spin1.status} items=${spin1.data && JSON.stringify(spin1.data.items)}`);
      const spin2 = await call('POST', `/v1/pokestops/${stop.id}/spin`, { token, body: {} });
      record('补给站冷却期内重复旋转被拒绝', spin2.status === 400, `status=${spin2.status}`);
      if (farStop) {
        const spin3 = await call('POST', `/v1/pokestops/${farStop.id}/spin`, { token, body: {} });
        record('安全：远程旋转补给站被拒绝', spin3.status === 400, `status=${spin3.status} dist=${Math.round(distM(stop, farStop))}m`);
      }
    }
  }

  // 8c. REQ-00586：瞬移（上海 → 北京，1 秒内）被判定为不可能行程
  if (lastPos) {
    const tp = await call('POST', '/v1/location', { token, body: { lat: 39.9042, lng: 116.4074, accuracy: 10 } });
    record('反作弊：不可能行程（>1000 km/h）被拦截', tp.status === 403 && tp.body && tp.body.code === 6001,
      `status=${tp.status} reason=${tp.body && tp.body.data && tp.body.data.reason}`);
    // 本用户已有两次不可能行程（上面的远程捕捉 + 这次瞬移），可信度降到 RESTRICTED 以下，位置功能降级
    const back = await call('POST', '/v1/location', { token, body: { lat: lastPos.lat, lng: lastPos.lng, accuracy: 10 } });
    const reason = back.body && back.body.data && back.body.data.reason;
    record('反作弊：多次作弊后可信度过低，位置功能降级', back.status === 403 && reason === 'LOW_TRUST_SCORE',
      `status=${back.status} reason=${reason} trust=${back.body && back.body.data && back.body.data.trustScore}`);
  }

  // 9. 奖励服务可经网关访问
  const daily = await call('GET', '/v1/rewards/daily', { token });
  record('奖励服务 /v1/rewards/daily 可访问', daily.status === 200, `status=${daily.status}`);

  // 9b. 并发领取每日签到只能成功一次；排行榜 team 参数注入被拒绝
  const claims = await Promise.all(Array.from({ length: 5 }, () => call('POST', '/v1/rewards/daily/claim', { token, body: {} })));
  const okClaims = claims.filter((c) => c.status === 200).length;
  record('并发：每日签到 5 个并发请求只成功 1 次', okClaims === 1, `success=${okClaims} statuses=${claims.map((c) => c.status).join(',')}`);
  const inj = await call('GET', `/v1/rewards/leaderboard?team=${encodeURIComponent("x' OR '1'='1")}`, { token });
  record('安全：排行榜 team 参数注入被拒绝', inj.status === 400, `status=${inj.status}`);
  const lb = await call('GET', '/v1/rewards/leaderboard?team=valor', { token });
  record('排行榜按队伍过滤正常', lb.status === 200, `status=${lb.status}`);

  // 10. 安全：管理接口需要管理员
  const adm1 = await call('GET', '/api/admin/delay-queue/stats');
  const adm2 = await call('GET', '/api/admin/delay-queue/stats', { token });
  record('安全：管理接口未登录拒绝', adm1.status === 401, `status=${adm1.status}`);
  record('安全：管理接口普通用户拒绝', adm2.status === 403, `status=${adm2.status}`);

  // 11. 安全：伪造 x-user-id 头无效
  const spoof = await call('GET', '/v1/pokemon/my', { headers: { 'x-user-id': reg.data.user ? reg.data.user.id : 'x' } });
  record('安全：未带 token 伪造 x-user-id 被拒绝', spoof.status === 401, `status=${spoof.status}`);

  // 12. 刷新 token；登出后 refresh token 失效
  const ref = await call('POST', '/v1/auth/refresh', { body: { refreshToken } });
  record('刷新 token /v1/auth/refresh', ref.status === 200 && !!(ref.data && ref.data.accessToken), `status=${ref.status}`);
  await call('POST', '/v1/auth/logout', { token });
  const ref2 = await call('POST', '/v1/auth/refresh', { body: { refreshToken } });
  record('安全：登出后 refresh token 失效', ref2.status === 401, `status=${ref2.status}`);

  await redis.quit();
}

main()
  .catch((err) => record('执行异常', false, err.message))
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  });
