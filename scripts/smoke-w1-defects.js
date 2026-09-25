#!/usr/bin/env node
/**
 * 评审遗留功能缺陷（W1-B）回归冒烟：经网关验证
 *   活动系统（列表/详情/参与/领奖入账/管理员创建-暂停-恢复-取消、并发领奖只成功一次、非法 ID 返回 400）
 *   训练师等级（经验增长自动升级、升级奖励查询与并发领取只成功一次）
 *   道具入账（补给站全部掉落入账 + 经验；捕捉使用浆果时原子扣减，不足时球也不扣）
 *   服务端不信任 x-user-id 请求头（绕过网关直连服务端口伪造身份被拒绝）
 *   时区：核心表时间列为 TIMESTAMPTZ；每日任务按游戏日（GAME_TIMEZONE）建档
 *
 * 用法：BASE_URL=http://127.0.0.1:8080 node scripts/smoke-w1-defects.js
 * 依赖 scripts/lib/smoke-helpers.js（读 .env 推导 REDIS_URL / DATABASE_URL）
 */
'use strict';

const { BASE, record, call, newUser, makeAdmin, finish, getDb } = require('./lib/smoke-helpers');

async function testEvents() {
  const player = await newUser('evt');
  const admin = await makeAdmin(await newUser('adm'));

  const list = await call('GET', '/v1/events', { token: player.token });
  record('活动：列表 /v1/events', list.status === 200 && Array.isArray(list.body.events), `status=${list.status}`);
  const anon = await call('GET', '/v1/events');
  record('活动：未登录访问被网关拒绝', anon.status === 401, `status=${anon.status}`);

  const badId = await call('GET', '/v1/events/active', { token: player.token });
  record('活动：非法活动 ID 返回 400（不是 500）', badId.status === 400, `status=${badId.status}`);

  const now = Date.now();
  const payload = {
    eventKey: `smoke-${now}`, title: '冒烟测试活动', description: 'W1-B 回归', eventType: 'double_xp',
    startTime: new Date(now - 60e3).toISOString(), endTime: new Date(now + 3600e3).toISOString(),
    rewards: [{ type: 'stardust', amount: 100 }],
  };
  const denied = await call('POST', '/v1/events', { token: player.token, body: payload });
  record('活动：普通玩家不能创建活动', denied.status === 403, `status=${denied.status}`);

  const created = await call('POST', '/v1/events', { token: admin.token, body: payload });
  const ev = created.body && created.body.event;
  record('活动：管理员创建活动', created.status === 201 && ev && ev.id, `status=${created.status} ${created.status !== 201 ? JSON.stringify(created.body).slice(0, 160) : ''}`);
  if (!ev) return;

  const resumed = await call('POST', `/v1/events/${ev.id}/resume`, { token: admin.token });
  record('活动：管理员上线（resume）', resumed.status === 200, `status=${resumed.status}`);

  const detail = await call('GET', `/v1/events/${ev.id}`, { token: player.token });
  record('活动：详情', detail.status === 200 && detail.body.event && detail.body.event.status === 'active', `status=${detail.status} state=${detail.body.event && detail.body.event.status}`);

  const joins = await Promise.all([1, 2, 3].map(() => call('POST', `/v1/events/${ev.id}/join`, { token: player.token })));
  record('活动：参与（并发重复参与不报错）', joins.every((j) => j.status === 200), `statuses=${joins.map((j) => j.status)}`);

  const mine = await call('GET', '/v1/events', { token: player.token });
  const joined = (mine.body.events || []).find((e) => e.id === ev.id);
  record('活动：列表中显示本人参与状态', joined && joined.participation_status === 'active', `participation=${joined && joined.participation_status}`);

  const before = (await getDb().query('SELECT stardust FROM users WHERE id = $1', [player.userId])).rows[0];
  const claims = await Promise.all([1, 2, 3, 4, 5].map(() => call('POST', `/v1/events/${ev.id}/claim`, { token: player.token })));
  const ok = claims.filter((c) => c.status === 200).length;
  record('活动：并发领奖只成功一次', ok === 1, `success=${ok} statuses=${claims.map((c) => c.status)}`);
  const after = (await getDb().query('SELECT stardust FROM users WHERE id = $1', [player.userId])).rows[0];
  record('活动：奖励实际入账（星尘 +100，且只入账一次）', after.stardust - before.stardust === 100, `Δstardust=${after.stardust - before.stardust}`);

  const paused = await call('POST', `/v1/events/${ev.id}/pause`, { token: admin.token });
  const afterPause = await call('GET', '/v1/events', { token: player.token });
  record('活动：暂停后不在活跃列表', paused.status === 200 && !(afterPause.body.events || []).some((e) => e.id === ev.id), `status=${paused.status}`);

  const cantPause = await call('POST', `/v1/events/${ev.id}/cancel`, { token: player.token });
  record('活动：普通玩家不能取消活动', cantPause.status === 403, `status=${cantPause.status}`);
  const cancelled = await call('POST', `/v1/events/${ev.id}/cancel`, { token: admin.token });
  const afterCancel = await call('GET', `/v1/events/${ev.id}`, { token: admin.token });
  record('活动：管理员取消', cancelled.status === 200 && afterCancel.body.event && afterCancel.body.event.status === 'cancelled', `status=${cancelled.status}`);
}

async function testTrainerLevel() {
  const u = await newUser('lvl');
  const db = getDb();
  const start = (await db.query('SELECT level, pokeball_count FROM users WHERE id = $1', [u.userId])).rows[0];
  // 测试夹具：直接加经验（等价于多次捕捉/签到），升级由数据库触发器换算
  await db.query('UPDATE users SET xp = xp + 12000 WHERE id = $1', [u.userId]);
  const info = await call('GET', '/v1/rewards/level-ups', { token: u.token });
  const d = info.data || {};
  record('等级：经验增长后自动升级（12000 经验 → 5 级）', info.status === 200 && d.level === 5, `status=${info.status} level=${d.level}`);
  record('等级：返回升级记录与下一级所需经验', (d.unclaimed || []).length === 1 && d.nextLevelXp === 15000, `unclaimed=${(d.unclaimed || []).length} next=${d.nextLevelXp}`);
  const claims = await Promise.all([1, 2, 3].map(() => call('POST', '/v1/rewards/level-ups/claim', { token: u.token })));
  const ok = claims.filter((c) => c.status === 200).length;
  record('等级：升级奖励并发领取只成功一次', ok === 1, `statuses=${claims.map((c) => c.status)}`);
  const end = (await db.query('SELECT pokeball_count FROM users WHERE id = $1', [u.userId])).rows[0];
  record('等级：升级奖励入账（2~5 级精灵球 15+15+15+20=65）', end.pokeball_count - start.pokeball_count === 65, `Δpokeballs=${end.pokeball_count - start.pokeball_count}`);
  const me = await call('GET', '/v1/users/me', { token: u.token });
  const lvl = me.data && (me.data.level ?? (me.data.user && me.data.user.level));
  record('等级：个人信息中的等级同步更新', lvl === 5, `level=${lvl}`);
}

const CENTERS = [
  { lat: 31.2398, lng: 121.5014 }, { lat: 31.2304, lng: 121.4737 }, { lat: 31.2397, lng: 121.4905 },
  { lat: 31.2269, lng: 121.4918 }, { lat: 31.2198, lng: 121.4631 }, { lat: 31.2350, lng: 121.4800 },
];
const jitter = () => (Math.random() - 0.5) * 0.00004;

async function nearby(token) {
  const c = CENTERS[Math.floor(Math.random() * CENTERS.length)];
  for (let i = 0; i < 10; i++) {
    const r = await call('GET', `/v1/map/nearby?lat=${c.lat}&lng=${c.lng}&radius=1000`, { token });
    const d = r.data || {};
    if ((d.wildPokemons || []).length) return d;
    await new Promise((res) => setTimeout(res, 1500));
  }
  return {};
}

async function testItems() {
  const db = getDb();
  // 1) 补给站：玩家首次上报就在补给站旁（避免移动速度反作弊），旋转后全部掉落入账、+50 经验
  const spinner = await newUser('spn');
  const map1 = await nearby(spinner.token);
  const stop = (map1.pokestops || [])[0];
  if (!stop) { record('道具：附近有补给站', false); return; }
  await call('POST', '/v1/location', { token: spinner.token, body: { lat: Number(stop.lat) + jitter(), lng: Number(stop.lng) + jitter(), accuracy: 10 } });
  const before = await call('GET', '/v1/users/me/items', { token: spinner.token });
  const xp0 = (await db.query('SELECT xp FROM users WHERE id = $1', [spinner.userId])).rows[0].xp;
  const spin = await call('POST', `/v1/pokestops/${stop.id}/spin`, { token: spinner.token, body: {} });
  const after = await call('GET', '/v1/users/me/items', { token: spinner.token });
  const xp1 = (await db.query('SELECT xp FROM users WHERE id = $1', [spinner.userId])).rows[0].xp;
  const dropped = (spin.data && spin.data.items) || [];
  const count = (bag, type) => (bag.data.balls[type] ?? (bag.data.items.find((i) => i.itemId === type) || { quantity: 0 }).quantity);
  const allCredited = spin.status === 200 && before.status === 200 && dropped.every((d) => count(after, d.type) - count(before, d.type) === d.qty);
  record('道具：补给站所有掉落都入账（含浆果/高级球）', allCredited, `status=${spin.status} items=${JSON.stringify(dropped)}`);
  record('道具：转动补给站获得 50 经验', Number(xp1) - Number(xp0) === 50, `Δxp=${Number(xp1) - Number(xp0)}`);

  // 1b) 直接调用入账模块（补给站掉落是随机的，确保浆果路径一定被覆盖）：堆叠累加 + 扣减到 0 删除行 + 并发扣减不超扣
  const { addItems, consumeItem } = require('../backend/shared/inventory');
  const client = await db.connect();
  try {
    await addItems(client, spinner.userId, [{ type: 'RAZZ_BERRY', qty: 2 }, { type: 'GOLDEN_RAZZ_BERRY', qty: 1 }, { type: 'ULTRA_BALL', qty: 1 }]);
    await addItems(client, spinner.userId, [{ type: 'RAZZ_BERRY', qty: 1 }, { type: 'NOT_AN_ITEM', qty: 1 }]);
  } finally { client.release(); }
  const bag = await call('GET', '/v1/users/me/items', { token: spinner.token });
  const qty = (id) => ((bag.data.items || []).find((i) => i.itemId === id) || { quantity: 0 }).quantity;
  record('道具：浆果按用户堆叠累加（2+1=3），未定义道具跳过', qty('RAZZ_BERRY') >= 3 && qty('GOLDEN_RAZZ_BERRY') >= 1 && qty('NOT_AN_ITEM') === 0, `razz=${qty('RAZZ_BERRY')} golden=${qty('GOLDEN_RAZZ_BERRY')}`);
  const n = qty('RAZZ_BERRY');
  const results = await Promise.all(Array.from({ length: n + 3 }, async () => {
    const c = await db.connect();
    try { await c.query('BEGIN'); const ok = await consumeItem(c, spinner.userId, 'RAZZ_BERRY', 1); await c.query('COMMIT'); return ok; }
    finally { c.release(); }
  }));
  const left = (await db.query("SELECT COUNT(*)::int AS rows FROM player_inventory WHERE user_id = $1 AND item_id = 'RAZZ_BERRY'", [spinner.userId])).rows[0].rows;
  record('道具：并发扣减不超扣，扣完删除堆叠行', results.filter(Boolean).length === n && left === 0, `ok=${results.filter(Boolean).length}/${n + 3} rowsLeft=${left}`);

  // 2) 捕捉使用浆果：夹具给 1 个树果，第一次投掷扣 1 球 1 果，第二次果不足 → 400 且不扣球
  const catcher = await newUser('bry');
  const map2 = await nearby(catcher.token);
  const w = (map2.wildPokemons || [])[0];
  if (!w) { record('道具：附近有野生精灵', false); return; }
  const pos = { lat: Number(w.lat) + 0.0001 + jitter(), lng: Number(w.lng) + jitter() };
  await call('POST', '/v1/location', { token: catcher.token, body: { ...pos, accuracy: 10 } });
  await db.query(
    `INSERT INTO player_inventory (user_id, item_id, quantity) VALUES ($1, 'RAZZ_BERRY', 1)
     ON CONFLICT (user_id, item_id) WHERE slot_index IS NULL DO UPDATE SET quantity = 1`, [catcher.userId]);
  const sess = await call('POST', '/v1/catch/session', { token: catcher.token, body: { spawnId: w.id, playerLat: pos.lat, playerLng: pos.lng } });
  const sessionId = sess.data && (sess.data.sessionId || sess.data.id);
  if (!sessionId) { record('道具：创建捕捉会话', false, `status=${sess.status} ${JSON.stringify(sess.body).slice(0, 120)}`); return; }
  const balls0 = (await db.query('SELECT pokeball_count FROM users WHERE id = $1', [catcher.userId])).rows[0].pokeball_count;
  const t1 = await call('POST', '/v1/catch/throw', { token: catcher.token, body: { sessionId, ballType: 'POKE_BALL', throwRating: 'MISS', berryUsed: 'RAZZ_BERRY' } });
  const berries1 = (await db.query("SELECT COALESCE(SUM(quantity),0)::int AS n FROM player_inventory WHERE user_id = $1 AND item_id = 'RAZZ_BERRY'", [catcher.userId])).rows[0].n;
  const balls1 = (await db.query('SELECT pokeball_count FROM users WHERE id = $1', [catcher.userId])).rows[0].pokeball_count;
  record('道具：投掷使用树果成功，扣 1 球 1 果', t1.status === 200 && berries1 === 0 && balls0 - balls1 === 1, `status=${t1.status} berries=${berries1} Δballs=${balls0 - balls1}`);
  const t2 = await call('POST', '/v1/catch/throw', { token: catcher.token, body: { sessionId, ballType: 'POKE_BALL', throwRating: 'MISS', berryUsed: 'RAZZ_BERRY' } });
  const balls2 = (await db.query('SELECT pokeball_count FROM users WHERE id = $1', [catcher.userId])).rows[0].pokeball_count;
  record('道具：树果不足时拒绝且不扣球', t2.status === 400 && balls2 === balls1, `status=${t2.status} Δballs=${balls1 - balls2}`);
  const t3 = await call('POST', '/v1/catch/throw', { token: catcher.token, body: { sessionId, ballType: 'POKE_BALL', throwRating: 'MISS', berryUsed: 'MAGIC_BEAN' } });
  record('道具：未知浆果类型被拒绝', t3.status === 400, `status=${t3.status}`);
}

async function testForgedIdentity() {
  // 直连 pokemon-service（网关端口 + 3）：只带伪造的 x-user-id、不带 token
  const u = await newUser('fid');
  const svc = BASE.replace(/:(\d+)$/, (_, p) => `:${Number(p) + 3}`);
  const fake = { 'x-user-id': u.userId, 'Content-Type': 'application/json' };
  const pid = '00000000-0000-0000-0000-000000000001';
  const r1 = await fetch(`${svc}/pokemon/${pid}/evolution/check`, { headers: fake });
  record('身份：直连服务伪造 x-user-id 访问进化接口被拒绝', r1.status === 401, `status=${r1.status}`);
  const r2 = await fetch(`${svc}/pokemon/1/friendship`, { headers: fake });
  record('身份：直连服务伪造 x-user-id 访问好感度接口被拒绝', r2.status === 401, `status=${r2.status}`);
  const r3 = await fetch(`${svc}/pokemon/my`, { headers: { Authorization: `Bearer ${u.token}` } });
  record('身份：携带有效 token 直连服务可正常访问', r3.status === 200, `status=${r3.status}`);
  const r4 = await fetch(`${svc}/pokemon/my`, { headers: fake });
  record('身份：直连服务只带伪造 x-user-id 访问背包被拒绝', r4.status === 401, `status=${r4.status}`);
}

async function testTimezone() {
  const db = getDb();
  const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'
       AND table_name IN ('users','catch_sessions','pokestop_spins','wild_pokemon','raids','events','orders')`);
  record('时区：核心表时间列均为 TIMESTAMPTZ', rows[0].n === 0, `timestamp 列=${rows[0].n}`);
  const u = await newUser('tz');
  const q = await call('GET', '/v1/rewards/quests', { token: u.token });
  const tz = process.env.GAME_TIMEZONE || 'Asia/Shanghai';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const row = (await db.query("SELECT to_char(quest_date, 'YYYY-MM-DD') AS d FROM daily_quests WHERE user_id = $1", [u.userId])).rows[0];
  record(`时区：每日任务按游戏日（${tz}）建档`, q.status === 200 && row && row.d === today, `status=${q.status} quest_date=${row && row.d} expected=${today}`);
}

(async () => {
  await testEvents();
  await testTimezone();
  await testForgedIdentity();
  await testTrainerLevel();
  await testItems();
  await finish();
})().catch(async (e) => {
  record('执行异常', false, e.message);
  await finish();
});
