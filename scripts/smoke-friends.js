#!/usr/bin/env node
/**
 * E01 好友与社交互动冒烟（经网关）：REQ-00048 / REQ-00228 / REQ-00326 / REQ-00377 / REQ-00388
 *
 *   好友码、搜索、请求/接受/拒绝/忽略/过期/自动互加、好友上限 400、待处理上限 50、
 *   送礼/开礼（并发只成功一次、每日上限 50、30 天过期、按亲密度解锁礼物类型）、友情点与等级、排行榜、
 *   WebSocket 实时推送、在线状态与隐私设置实时生效、分组/权限覆盖/黑名单/审计、
 *   精灵可见性（好友/陌生人/自己、阈值、隐藏、批量、默认继承、道馆战斗匿名）、
 *   精灵好友（申请/接受/五种互动/冷却/升级奖励/纪念品）、推荐、提醒、动态流、联合任务、旧接口兼容
 *
 * 用法：BASE_URL=http://127.0.0.1:8080 node scripts/smoke-friends.js
 */
'use strict';

const path = require('path');
const { BASE, record, call, newUser, finish, getDb, sleep } = require('./lib/smoke-helpers');

const WebSocket = require(path.join(__dirname, '..', 'backend', 'node_modules', 'ws'));

class WsClient {
  constructor(ws) { this.ws = ws; this.events = []; this.waiters = []; }
  static open(token) {
    return new Promise((resolve, reject) => {
      const url = `${BASE.replace(/^http/, 'ws')}/ws/friends?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      const c = new WsClient(ws);
      const timer = setTimeout(() => reject(new Error('ws connect timeout')), 8000);
      ws.on('message', (d) => {
        let msg; try { msg = JSON.parse(String(d)); } catch { return; }
        c.events.push(msg);
        if (msg.type === 'connected') { clearTimeout(timer); resolve(c); }
        c.waiters = c.waiters.filter((w) => { if (w.pred(msg)) { w.resolve(msg); return false; } return true; });
      });
      ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); reject(Object.assign(new Error('rejected'), { status: res.statusCode })); });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }
  waitFor(type, pred = () => true, ms = 5000) {
    const hit = this.events.find((e) => e.type === type && pred(e.payload || {}));
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const w = { pred: (m) => m.type === type && pred(m.payload || {}), resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); resolve(null); }, ms);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const db = () => getDb();
const q1 = async (sql, params) => (await db().query(sql, params)).rows[0];

async function makePokemon(userId, speciesId = 1, extra = {}) {
  const r = await q1(`
    INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp,
                                   nickname, fast_move, charge_move, is_shiny, caught_lat, caught_lng)
    VALUES ($1, $2, $3, 50, 50, 15, 14, 13, $4, 'TACKLE', 'VINE_WHIP', $5, $6, $7) RETURNING id`,
  [userId, speciesId, extra.cp || 500, extra.nickname || null, !!extra.shiny, extra.lat ?? 31.23, extra.lng ?? 121.47]);
  return r.id;
}

async function befriend(a, b) {
  const req = await call('POST', '/v1/friends/request', { token: a.token, body: { toUserId: b.userId } });
  const id = req.data && req.data.requestId;
  const acc = await call('POST', `/v1/friends/request/${id}/accept`, { token: b.token });
  return acc.status === 200;
}

async function bulkUsers(n, prefix) {
  const { rows } = await db().query(`
    INSERT INTO users (nickname) SELECT $2 || i FROM generate_series(1, $1) i RETURNING id`, [n, prefix]);
  return rows.map((r) => r.id);
}

async function main() {
  const t0 = Date.now();
  const A = await newUser('fa');
  const B = await newUser('fb');
  const C = await newUser('fc');
  const D = await newUser('fd');

  // ── 未登录 ────────────────────────────────────────────────
  const anon = await call('GET', '/v1/friends');
  record('鉴权：未登录访问 /v1/friends 被拒绝', anon.status === 401, `status=${anon.status}`);

  // ── 好友码 / 搜索 ──────────────────────────────────────────
  const codeA = await call('GET', '/v1/friends/my-code', { token: A.token });
  const code = codeA.data && codeA.data.friendCode;
  record('好友码：GET /my-code 返回 12 位数字', /^\d{12}$/.test(code || ''), `code=${code} formatted=${codeA.data && codeA.data.formatted}`);
  const codeAgain = await call('GET', '/v1/friends/my-code', { token: A.token });
  record('好友码：多次获取稳定不变', codeAgain.data && codeAgain.data.friendCode === code);
  const lookup = await call('GET', `/v1/friends/code/${codeA.data.formatted.replace(/ /g, '-')}`, { token: B.token });
  record('好友码：按好友码（带分隔符）查到用户', lookup.status === 200 && lookup.data.id === A.userId, `status=${lookup.status}`);
  const badCode = await call('GET', '/v1/friends/code/123', { token: B.token });
  record('好友码：无效好友码 404', badCode.status === 404, `status=${badCode.status}`);

  const search = await call('GET', `/v1/friends/search?q=${encodeURIComponent(A.nickname.slice(0, 6))}`, { token: B.token });
  record('搜索：按昵称找到用户', search.status === 200 && (search.data || []).some((u) => u.id === A.userId), `status=${search.status} n=${(search.data || []).length}`);
  const searchCode = await call('GET', `/v1/friends/search?q=${code}`, { token: B.token });
  record('搜索：按好友码精确查找', (searchCode.data || []).length === 1 && searchCode.data[0].id === A.userId);

  // ── WebSocket ──────────────────────────────────────────────
  let wsBad = null;
  try { await WsClient.open('invalid-token'); } catch (e) { wsBad = e.status; }
  record('WebSocket：无效 token 被拒绝（401）', wsBad === 401, `status=${wsBad}`);
  const wsA = await WsClient.open(A.token);
  const wsB = await WsClient.open(B.token);
  record('WebSocket：/ws/friends 经网关连接成功', !!wsA && !!wsB);

  // ── 好友请求 ───────────────────────────────────────────────
  const reqAB = await call('POST', '/v1/friends/add-by-code', { token: B.token, body: { friendCode: codeA.data.formatted, message: '一起玩' } });
  record('请求：B 通过好友码向 A 发送请求', reqAB.status === 201 && reqAB.data.requestId, `status=${reqAB.status} ${JSON.stringify(reqAB.body).slice(0, 120)}`);
  const pushReq = await wsA.waitFor('friend_request_received', (p) => p.requestId === reqAB.data.requestId);
  record('WebSocket：A 实时收到好友请求', !!pushReq);
  const dup = await call('POST', '/v1/friends/request', { token: B.token, body: { toUserId: A.userId } });
  record('请求：重复请求 409', dup.status === 409, `status=${dup.status}`);
  const self = await call('POST', '/v1/friends/request', { token: A.token, body: { toUserId: A.userId } });
  record('请求：不能添加自己', self.status === 400, `status=${self.status}`);
  const noTo = await call('POST', '/v1/friends/request', { token: A.token, body: {} });
  record('请求：缺少 toUserId 返回 400', noTo.status === 400, `status=${noTo.status}`);
  const pendA = await call('GET', '/v1/friends/requests/pending', { token: A.token });
  record('请求：A 的待处理列表包含请求', (pendA.data.requests || []).some((r) => r.id === reqAB.data.requestId));
  const reqRow = await q1('SELECT expires_at - created_at AS ttl FROM friend_requests WHERE id = $1', [reqAB.data.requestId]);
  record('请求：7 天有效期', reqRow && reqRow.ttl && reqRow.ttl.days === 7, `ttl=${JSON.stringify(reqRow && reqRow.ttl)}`);
  const acc = await call('POST', `/v1/friends/request/${reqAB.data.requestId}/accept`, { token: A.token });
  record('请求：A 接受请求', acc.status === 200 && acc.data.friend && acc.data.friend.id === B.userId, `status=${acc.status}`);
  const pushAcc = await wsB.waitFor('friend_request_accepted');
  record('WebSocket：B 实时收到“已接受”', !!pushAcc);
  const rows = await db().query(`SELECT user_id FROM friends WHERE (user_id = $1 AND friend_user_id = $2) OR (user_id = $2 AND friend_user_id = $1)`, [A.userId, B.userId]);
  record('存储：好友关系为双向两行', rows.rowCount === 2);
  const legacy = await q1('SELECT COUNT(*)::int AS n FROM friendships WHERE user_a = LEAST($1::uuid, $2::uuid) AND user_b = GREATEST($1::uuid, $2::uuid)', [A.userId, B.userId]);
  record('存储：旧 friendships 表同步（交易/对战兼容）', legacy.n === 1);
  const listA = await call('GET', '/v1/friends', { token: A.token });
  const listB = await call('GET', '/v1/friends', { token: B.token });
  record('列表：双方好友列表互相可见', (listA.data.friends || []).some((f) => f.id === B.userId) && (listB.data.friends || []).some((f) => f.id === A.userId));
  const onlineB = (listA.data.friends || []).find((f) => f.id === B.userId);
  record('在线状态：B 已连接 WebSocket → online', onlineB && onlineB.online_status === 'online', `status=${onlineB && onlineB.online_status}`);

  // 拒绝 / 忽略 / 重新申请
  const reqCA = await call('POST', '/v1/friends/request', { token: C.token, body: { toUserId: A.userId } });
  const rej = await call('POST', `/v1/friends/request/${reqCA.data.requestId}/reject`, { token: A.token });
  record('请求：拒绝', rej.status === 200 && rej.data.status === 'rejected', `status=${rej.status}`);
  const sentC = await call('GET', '/v1/friends/requests/sent', { token: C.token });
  record('请求：被拒绝后不在发送列表', !(sentC.data || []).some((r) => r.id === reqCA.data.requestId));
  const again = await call('POST', '/v1/friends/request', { token: C.token, body: { toUserId: A.userId } });
  record('请求：被拒绝后可重新申请', again.status === 201, `status=${again.status}`);
  const ign = await call('POST', `/v1/friends/request/${again.data.requestId}/ignore`, { token: A.token });
  record('请求：忽略', ign.status === 200 && ign.data.status === 'ignored');
  const rejWrong = await call('POST', `/v1/friends/request/${again.data.requestId}/accept`, { token: A.token });
  record('请求：已处理的请求不能再接受（404）', rejWrong.status === 404, `status=${rejWrong.status}`);

  // 过期
  const reqCB = await call('POST', '/v1/friends/request', { token: C.token, body: { toUserId: B.userId } });
  await db().query("UPDATE friend_requests SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [reqCB.data.requestId]);
  const pendB = await call('GET', '/v1/friends/requests/pending', { token: B.token });
  record('过期：7 天后的请求不在待处理列表', !(pendB.data.requests || []).some((r) => r.id === reqCB.data.requestId));
  const accExp = await call('POST', `/v1/friends/request/${reqCB.data.requestId}/accept`, { token: B.token });
  record('过期：接受过期请求返回 410', accExp.status === 410, `status=${accExp.status}`);
  const expRow = await q1('SELECT status FROM friend_requests WHERE id = $1', [reqCB.data.requestId]);
  record('过期：请求状态记为 expired', expRow.status === 'expired', `status=${expRow.status}`);

  // 互相申请自动成为好友
  await call('POST', '/v1/friends/request', { token: D.token, body: { toUserId: A.userId } });
  const mutual = await call('POST', '/v1/friends/request', { token: A.token, body: { toUserId: D.userId } });
  record('请求：对方已申请时再申请 → 自动成为好友', mutual.status === 201 && mutual.data.autoAccepted === true, `status=${mutual.status}`);

  // ── 上限 ───────────────────────────────────────────────────
  const E = await newUser('fe');
  const bulk = await bulkUsers(400, `bulk${Date.now() % 100000}_`);
  await db().query(`
    INSERT INTO friends (user_id, friend_user_id, status, accepted_at)
    SELECT $1, x, 'accepted', NOW() FROM unnest($2::uuid[]) x
    UNION ALL SELECT x, $1, 'accepted', NOW() FROM unnest($2::uuid[]) x`, [E.userId, bulk]);
  const full = await call('POST', '/v1/friends/request', { token: E.token, body: { toUserId: C.userId } });
  record('上限：好友数达到 400 时不能再发请求', full.status === 400 && full.body.code === 2003, `status=${full.status} code=${full.body.code}`);
  const toFull = await call('POST', '/v1/friends/request', { token: C.token, body: { toUserId: E.userId } });
  record('上限：对方好友已满 400 时请求被拒', toFull.status === 400 && toFull.body.code === 2013, `status=${toFull.status} code=${toFull.body.code}`);
  const F = await newUser('ff');
  const bulk2 = await bulkUsers(50, `bulkp${Date.now() % 100000}_`);
  await db().query(`
    INSERT INTO friend_requests (from_user_id, to_user_id, status, expires_at)
    SELECT $1, x, 'pending', NOW() + INTERVAL '7 days' FROM unnest($2::uuid[]) x`, [F.userId, bulk2]);
  const pendFull = await call('POST', '/v1/friends/request', { token: F.token, body: { toUserId: C.userId } });
  record('上限：待处理请求达到 50 时不能再发', pendFull.status === 400 && pendFull.body.code === 2004, `status=${pendFull.status} code=${pendFull.body.code}`);
  await db().query("UPDATE friend_requests SET expires_at = NOW() - INTERVAL '1 second' WHERE from_user_id = $1 AND to_user_id = $2", [F.userId, bulk2[0]]);
  const pendOk = await call('POST', '/v1/friends/request', { token: F.token, body: { toUserId: C.userId } });
  record('上限：过期请求不计入待处理上限', pendOk.status === 201, `status=${pendOk.status}`);

  // ── 礼物 ───────────────────────────────────────────────────
  const g1 = await call('POST', `/v1/friends/${B.userId}/gift`, { token: A.token, body: { message: '送你的' } });
  record('礼物：A 给 B 送礼物包', g1.status === 201 && g1.data.giftId, `status=${g1.status} ${JSON.stringify(g1.body).slice(0, 160)}`);
  const pushGift = await wsB.waitFor('gift_received', (p) => p.giftId === g1.data.giftId);
  record('WebSocket：B 实时收到礼物', !!pushGift);
  const g1b = await call('POST', `/v1/friends/${B.userId}/gift`, { token: A.token, body: {} });
  record('礼物：同一好友每天一个礼物包（429）', g1b.status === 429, `status=${g1b.status}`);
  const giftRow = await q1("SELECT EXTRACT(DAY FROM expires_at - sent_at)::int AS d, sender_id, from_user_id FROM friend_gifts WHERE id = $1", [g1.data.giftId]);
  record('礼物：30 天过期且新旧列一致', giftRow.d === 30 && giftRow.sender_id === giftRow.from_user_id, `days=${giftRow.d}`);
  const notFriend = await call('POST', `/v1/friends/${C.userId}/gift`, { token: A.token, body: {} });
  record('礼物：非好友不能送礼', notFriend.status === 400, `status=${notFriend.status}`);
  const pendGifts = await call('GET', '/v1/friends/gifts/pending', { token: B.token });
  record('礼物：GET /gifts/pending 正常（原 fg.created_at 报错已修复）', pendGifts.status === 200 && (pendGifts.data.gifts || []).some((g) => g.id === g1.data.giftId), `status=${pendGifts.status}`);

  const ballsBefore = await q1('SELECT pokeball_count, stardust FROM users WHERE id = $1', [B.userId]);
  const claims = await Promise.all([1, 2, 3, 4, 5].map(() => call('POST', `/v1/friends/gifts/${g1.data.giftId}/claim`, { token: B.token })));
  const okClaims = claims.filter((c) => c.status === 200);
  record('礼物：并发开礼只成功一次', okClaims.length === 1, `statuses=${claims.map((c) => c.status)}`);
  const ballsAfter = await q1('SELECT pokeball_count, stardust FROM users WHERE id = $1', [B.userId]);
  const got = (okClaims[0] && okClaims[0].data.items) || [];
  const balls = got.filter((i) => i.type === 'POKE_BALL').reduce((s, i) => s + i.qty, 0);
  record('礼物：内容实际入账且只入账一次', balls > 0 && ballsAfter.pokeball_count - ballsBefore.pokeball_count === balls, `+${ballsAfter.pokeball_count - ballsBefore.pokeball_count} balls (items ${JSON.stringify(got)})`);
  const pts = await db().query('SELECT friendship_points FROM friends WHERE (user_id = $1 AND friend_user_id = $2) OR (user_id = $2 AND friend_user_id = $1)', [A.userId, B.userId]);
  record('友情点：开礼后双方友情点 +10', pts.rows.every((r) => r.friendship_points === 10), `points=${pts.rows.map((r) => r.friendship_points)}`);

  const aBalls = await q1('SELECT pokeball_count FROM users WHERE id = $1', [A.userId]);
  const itemGift = await call('POST', `/v1/friends/${B.userId}/gift`, { token: A.token, body: { giftType: 'item', giftId: 'POKE_BALL', quantity: 3 } });
  const aBalls2 = await q1('SELECT pokeball_count FROM users WHERE id = $1', [A.userId]);
  record('礼物：赠送背包道具并从赠送方扣减', itemGift.status === 201 && aBalls.pokeball_count - aBalls2.pokeball_count === 3, `status=${itemGift.status} Δ=${aBalls.pokeball_count - aBalls2.pokeball_count}`);
  const noItem = await call('POST', `/v1/friends/${B.userId}/gift`, { token: A.token, body: { giftType: 'item', giftId: 'MAX_REVIVE', quantity: 1 } });
  record('礼物：道具不足返回 400', noItem.status === 400 && noItem.body.code === 2007, `status=${noItem.status} code=${noItem.body.code}`);
  const locked = await call('POST', `/v1/friends/${B.userId}/gift`, { token: A.token, body: { giftType: 'coins', quantity: 10 } });
  record('礼物：金币礼物需亲密度 4 级（403）', locked.status === 403 && locked.body.code === 2018, `status=${locked.status}`);
  const types = await call('GET', '/v1/friends/gifts/types', { token: A.token });
  record('礼物：礼物类型含道具/糖果/星尘/精灵蛋/金币', ['item', 'candy', 'stardust', 'pokemon_egg', 'coins'].every((t) => (types.data || []).some((x) => x.code === t)));

  // 过期礼物
  await db().query("UPDATE friend_gifts SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [itemGift.data.giftId]);
  const expClaim = await call('POST', `/v1/friends/gifts/${itemGift.data.giftId}/claim`, { token: B.token });
  record('礼物：过期礼物不能领取（410）', expClaim.status === 410, `status=${expClaim.status}`);

  // 每日上限 50
  await db().query(`
    INSERT INTO friend_gifts (sender_id, receiver_id, from_user_id, to_user_id, gift_type, status, sent_at)
    SELECT $1, $2, $1, $2, 'item', 'claimed', NOW() FROM generate_series(1, 48)`, [A.userId, D.userId]);
  const quota = await call('GET', '/v1/friends/gifts/sent', { token: A.token });
  record('礼物：今日已送 50 个', quota.data.quota.sentToday === 50 && quota.data.quota.remaining === 0, JSON.stringify(quota.data.quota));
  const over = await call('POST', `/v1/friends/${D.userId}/gift`, { token: A.token, body: {} });
  record('礼物：每日 50 个上限（429）', over.status === 429 && over.body.code === 2009, `status=${over.status} code=${over.body.code}`);

  // ── 友情等级 ───────────────────────────────────────────────
  const g2 = await call('POST', `/v1/friends/${A.userId}/gift`, { token: B.token, body: {} });
  await db().query(`UPDATE friends SET friendship_points = 95 WHERE (user_id = $1 AND friend_user_id = $2) OR (user_id = $2 AND friend_user_id = $1)`, [A.userId, B.userId]);
  const lvl = await call('POST', `/v1/friends/gifts/${g2.data.giftId}/claim`, { token: A.token });
  record('友情等级：95 → 105 点升到 2 级', lvl.status === 200 && lvl.data.friendship && lvl.data.friendship.level === 2, `status=${lvl.status} lvl=${lvl.data && lvl.data.friendship && lvl.data.friendship.level}`);
  const pushLvl = await wsB.waitFor('friendship_level_up', (p) => p.friendId === A.userId && p.level === 2);
  record('友情等级：升级经 WebSocket 通知双方', !!pushLvl && !!(await wsA.waitFor('friendship_level_up', (p) => p.friendId === B.userId)));
  const remLvl = await call('GET', '/v1/friends/reminders', { token: B.token });
  record('友情等级：升级写入提醒中心', (remLvl.data.reminders || []).some((r) => r.reminder_type === 'intimacy_level_up'));
  const legacyLvl = await q1('SELECT level::text AS level FROM friendships WHERE user_a = LEAST($1::uuid, $2::uuid) AND user_b = GREATEST($1::uuid, $2::uuid)', [A.userId, B.userId]);
  record('友情等级：旧 friendships 等级同步为 GREAT', legacyLvl.level === 'GREAT', `level=${legacyLvl.level}`);
  const detail = await call('GET', `/v1/friends/${B.userId}`, { token: A.token });
  record('好友详情：含友情等级、亲密度与下一级进度', detail.status === 200 && detail.data.friendship.level === 2 && detail.data.intimacy.level === 2 && detail.data.friendship.pointsToNext === 395,
    `status=${detail.status} ${JSON.stringify(detail.data && detail.data.friendship)}`);

  // ── 排行榜 ─────────────────────────────────────────────────
  const lb = await call('GET', '/v1/friends/leaderboard?type=friendship', { token: A.token });
  const ent = (lb.data && lb.data.entries) || [];
  record('排行榜：按友情点降序', ent.length >= 2 && ent[0].id === B.userId && ent.every((e, i) => i === 0 || ent[i - 1].score >= e.score), `top=${ent.map((e) => e.score)}`);
  await db().query('UPDATE users SET level = 30 WHERE id = $1', [D.userId]);
  const lbLv = await call('GET', '/v1/friends/leaderboard?type=level', { token: A.token });
  const lvEnt = (lbLv.data && lbLv.data.entries) || [];
  record('排行榜：训练师等级榜含自己且正确排序', lvEnt[0] && lvEnt[0].id === D.userId && lvEnt.some((e) => e.is_me), `first=${lvEnt[0] && lvEnt[0].level}`);

  // ── 隐私设置实时生效 ───────────────────────────────────────
  const setPriv = await call('PATCH', '/v1/privacy/settings', { token: B.token, body: { online_status_visibility: 'private' } });
  record('隐私：更新设置', setPriv.status === 200 && setPriv.data.online_status_visibility === 'private', `status=${setPriv.status}`);
  const pushPriv = await wsA.waitFor('friend_privacy_changed', (p) => p.friendId === B.userId);
  record('隐私：好友实时收到隐私变化推送', !!pushPriv);
  const listA2 = await call('GET', '/v1/friends', { token: A.token });
  const hiddenB = (listA2.data.friends || []).find((f) => f.id === B.userId);
  record('隐私：在线状态设为私密后立即对好友隐藏', hiddenB && hiddenB.online_status === 'hidden' && hiddenB.last_active_at === null, `status=${hiddenB && hiddenB.online_status}`);
  const badPriv = await call('PATCH', '/v1/privacy/settings', { token: B.token, body: { location_visibility: 'everyone' } });
  record('隐私：非法取值 400', badPriv.status === 400, `status=${badPriv.status}`);
  const chk = await call('GET', `/v1/privacy/check/${B.userId}/location`, { token: A.token });
  record('隐私：位置默认不可见（未开启位置共享）', chk.status === 200 && chk.data.canView === false);
  await call('PATCH', '/v1/privacy/settings', { token: B.token, body: { allow_location_sharing: true, location_visibility: 'friends' } });
  const chk2 = await call('GET', `/v1/privacy/check/${B.userId}/location`, { token: A.token });
  const chkC = await call('GET', `/v1/privacy/check/${B.userId}/location`, { token: C.token });
  record('隐私：开启共享+好友可见 → 好友可见、陌生人不可见', chk2.data.canView === true && chkC.data.canView === false);

  // 分组 / 权限级别 / 覆盖
  const grp = await call('POST', '/v1/privacy/groups', { token: B.token, body: { name: '密友', permissionLevel: 'close_friends', color: '#FF5722', icon: 'star' } });
  record('分组：创建自定义分组（名称/颜色/图标/权限级别）', grp.status === 201 && grp.data.color === '#FF5722', `status=${grp.status}`);
  const shinyBefore = await call('GET', `/v1/privacy/check/${B.userId}/pokemon_shinies`, { token: A.token });
  const assign = await call('PATCH', `/v1/privacy/friends/${A.userId}/permissions`, { token: B.token, body: { groupId: grp.data.id } });
  const shinyAfter = await call('GET', `/v1/privacy/check/${B.userId}/pokemon_shinies`, { token: A.token });
  record('权限分级：加入密友分组后可见 close_friends 数据', assign.status === 200 && assign.data.permission_level === 'close_friends' && shinyBefore.data.canView === false && shinyAfter.data.canView === true,
    `before=${shinyBefore.data.canView} after=${shinyAfter.data.canView}`);
  await call('PATCH', '/v1/privacy/settings', { token: B.token, body: { battle_history_visibility: 'custom', custom_groups: { battle_history: [grp.data.id] } } });
  const custA = await call('GET', `/v1/privacy/check/${B.userId}/battle_history`, { token: A.token });
  const custD = await call('GET', `/v1/privacy/check/${B.userId}/battle_history`, { token: D.token });
  record('隐私：自定义分组可见（组内可见、组外不可见）', custA.data.canView === true && custD.data.canView === false);
  const ov = await call('PATCH', `/v1/privacy/friends/${A.userId}/permissions`, { token: B.token, body: { overrides: { achievements: false } } });
  const ovChk = await call('GET', `/v1/privacy/check/${B.userId}/achievements`, { token: A.token });
  record('权限覆盖：对单个好友关闭成就可见', ov.status === 200 && ovChk.data.canView === false);
  const targets = [A.userId, B.userId, C.userId, D.userId, ...bulk.slice(0, 96)];
  const tb = Date.now();
  const batch = await call('POST', '/v1/privacy/check/batch', { token: A.token, body: { targetIds: targets } });
  const batchMs = Date.now() - tb;
  record('隐私：批量可见性检查 100 个目标 < 100ms', batch.status === 200 && Object.keys(batch.data.results).length === 100 && batchMs < 100, `${batchMs}ms`);

  // 拒绝好友申请开关
  const G = await newUser('fg');
  await call('PATCH', '/v1/privacy/settings', { token: G.token, body: { allow_friend_requests: false } });
  const denied = await call('POST', '/v1/friends/request', { token: C.token, body: { toUserId: G.userId } });
  record('隐私：关闭好友申请后请求被拒（403）', denied.status === 403, `status=${denied.status}`);

  // 黑名单
  const blk = await call('POST', `/v1/privacy/block/${A.userId}`, { token: D.token, body: { reason: 'test' } });
  record('黑名单：拉黑', blk.status === 201 && blk.data.friendshipRemoved === true, `status=${blk.status}`);
  const gone = await q1('SELECT COUNT(*)::int AS n FROM friends WHERE (user_id = $1 AND friend_user_id = $2) OR (user_id = $2 AND friend_user_id = $1)', [A.userId, D.userId]);
  record('黑名单：拉黑后自动解除双向好友关系', gone.n === 0);
  const blkReq = await call('POST', '/v1/friends/request', { token: A.token, body: { toUserId: D.userId } });
  record('黑名单：被拉黑方无法发送请求（403）', blkReq.status === 403, `status=${blkReq.status}`);
  const blkSearch = await call('GET', `/v1/friends/search?q=${encodeURIComponent(D.nickname)}`, { token: A.token });
  record('黑名单：搜索结果中不出现', !(blkSearch.data || []).some((u) => u.id === D.userId));
  const audit = await call('GET', '/v1/privacy/audit-log', { token: D.token });
  record('审计：拉黑写入审计日志', (audit.data || []).some((a) => a.action === 'user_blocked' && a.target === A.userId));
  const auditB = await call('GET', '/v1/privacy/audit-log', { token: B.token });
  record('审计：隐私设置/权限变更写入审计日志', ['privacy_settings_changed', 'friend_permissions_changed', 'friend_group_created'].every((a) => (auditB.data || []).some((x) => x.action === a)));
  const unb = await call('DELETE', `/v1/privacy/block/${A.userId}`, { token: D.token });
  record('黑名单：解除拉黑', unb.status === 200);

  // ── 精灵可见性（REQ-00377） ─────────────────────────────────
  const pB = await makePokemon(B.userId, 1, { cp: 777, nickname: 'Bulby', shiny: true });
  const pB2 = await makePokemon(B.userId, 4, { cp: 888 });
  const vFriend = await call('GET', `/v1/pokemon/${pB}/visibility`, { token: A.token });
  const vStranger = await call('GET', `/v1/pokemon/${pB}/visibility`, { token: C.token });
  const vOwner = await call('GET', `/v1/pokemon/${pB}/visibility`, { token: B.token });
  record('精灵可见性：好友（默认 friends）可见 CP、默认隐藏 IV', vFriend.status === 200 && vFriend.data.cp === 777 && vFriend.data.iv === null, `status=${vFriend.status} cp=${vFriend.data && vFriend.data.cp}`);
  record('精灵可见性：陌生人只见基础外观', vStranger.status === 200 && vStranger.data.cp === null && vStranger.data.visibility === 'basic');
  record('精灵可见性：主人可见全部（含 IV）', vOwner.data && vOwner.data.iv && vOwner.data.iv.attack === 15 && vOwner.data.visibility === 'owner');
  record('精灵可见性：闪光受密友权限控制（A 为密友可见）', vFriend.data.appearance.is_shiny === true && vStranger.data.appearance.is_shiny === null);
  await call('PUT', `/v1/pokemon/${pB}/privacy`, { token: B.token, body: { friend_level_threshold: 3 } });
  const vThr = await call('GET', `/v1/pokemon/${pB}/visibility`, { token: A.token });
  record('精灵可见性：好友等级阈值 3（A 为 2 级）→ 仅基础信息', vThr.data.cp === null && vThr.data.visibility === 'basic', `vis=${vThr.data && vThr.data.visibility}`);
  await call('PUT', `/v1/pokemon/${pB}/privacy`, { token: B.token, body: { overall_visibility: 'public', show_iv: true, friend_level_threshold: 1 } });
  const vPub0 = await call('GET', `/v1/pokemon/${pB}/visibility`, { token: C.token });
  record('精灵可见性：public 精灵的数值仍受用户级“精灵数值”可见性约束（陌生人不可见）', vPub0.data.visibility === 'detailed' && vPub0.data.cp === null && vPub0.data.iv === null);
  await call('PATCH', '/v1/privacy/settings', { token: B.token, body: { pokemon_stats_visibility: 'public' } });
  const vPub = await call('GET', `/v1/pokemon/${pB}/visibility`, { token: C.token });
  record('精灵可见性：public + show_iv + 数值公开 → 陌生人可见 CP/IV，技能仍隐藏', vPub.data.iv && vPub.data.iv.attack === 15 && vPub.data.cp === 777 && vPub.data.skills === null,
    `iv=${JSON.stringify(vPub.data && vPub.data.iv)} cp=${vPub.data && vPub.data.cp}`);
  await call('PUT', `/v1/pokemon/${pB}/privacy`, { token: B.token, body: { overall_visibility: 'private' } });
  const vPriv = await call('GET', `/v1/pokemon/${pB}/visibility`, { token: A.token });
  record('精灵可见性：private → 好友只见基础信息', vPriv.data.visibility === 'basic' && vPriv.data.iv === null);
  await call('PUT', `/v1/pokemon/${pB}/privacy`, { token: B.token, body: { overall_visibility: 'hidden' } });
  const vHid = await call('GET', `/v1/pokemon/${pB}/visibility`, { token: A.token });
  record('精灵可见性：hidden → 他人 404（不泄露存在）', vHid.status === 404, `status=${vHid.status}`);
  const badPp = await call('PUT', `/v1/pokemon/${pB}/privacy`, { token: A.token, body: { overall_visibility: 'public' } });
  record('精灵可见性：不能修改他人精灵隐私', badPp.status === 404, `status=${badPp.status}`);
  const pA = await makePokemon(A.userId, 7, { cp: 300 });
  const batchP = await call('POST', '/v1/pokemon/privacy/batch', { token: B.token, body: { pokemon_ids: [pB, pB2], settings: { overall_visibility: 'friends', show_moves: true } } });
  record('精灵可见性：批量设置', batchP.status === 200 && batchP.data.updated_count === 2, `status=${batchP.status}`);
  const batchBad = await call('POST', '/v1/pokemon/privacy/batch', { token: B.token, body: { pokemon_ids: [pB, pA], settings: { overall_visibility: 'public' } } });
  record('精灵可见性：批量设置含他人精灵 → 400', batchBad.status === 400, `status=${batchBad.status}`);
  const defs = await call('PUT', '/v1/pokemon/privacy/defaults', { token: B.token, body: { overall_visibility: 'hidden', battle_anonymous: true } });
  const pB3 = await makePokemon(B.userId, 25, { cp: 999 });
  const inh = await call('GET', `/v1/pokemon/${pB3}/privacy`, { token: B.token });
  record('精灵可见性：默认配置持久化，新精灵继承', defs.status === 200 && inh.data.overall_visibility === 'hidden' && inh.data.battle_anonymous === true && inh.data.source === 'pokemon',
    `vis=${inh.data && inh.data.overall_visibility} src=${inh.data && inh.data.source}`);
  const coll = await call('GET', `/v1/pokemon/users/${B.userId}/collection`, { token: A.token });
  record('精灵可见性：好友查看收藏（隐藏的精灵不出现）', coll.status === 200 && coll.data.pokemon.some((p) => p.id === pB2) && !coll.data.pokemon.some((p) => p.id === pB3) && coll.data.hiddenCount === 1,
    `status=${coll.status} n=${coll.data && coll.data.pokemon && coll.data.pokemon.length}`);
  const profC = await call('GET', `/v1/users/${B.userId}`, { token: C.token });
  const profA = await call('GET', `/v1/users/${B.userId}`, { token: A.token });
  record('隐私：公开资料接口按隐私过滤（陌生人看不到精灵数；好友看到的不含隐藏精灵）', profC.status === 200 && profC.data.pokemon_count === null && profA.data.pokemon_count === 2,
    `stranger=${profC.data && profC.data.pokemon_count} friend=${profA.data && profA.data.pokemon_count}`);
  const collC = await call('GET', `/v1/pokemon/users/${B.userId}/collection`, { token: C.token });
  record('精灵可见性：陌生人无权查看收藏（403）', collC.status === 403, `status=${collC.status}`);
  // 道馆战斗匿名
  let gym = await q1('SELECT id FROM gyms LIMIT 1');
  if (!gym) gym = await q1("INSERT INTO gyms (name, lat, lng, location) VALUES ('冒烟道馆', 31.23, 121.47, ST_SetSRID(ST_MakePoint(121.47, 31.23), 4326)::geography) RETURNING id");
  await db().query('INSERT INTO gym_defenders (gym_id, user_id, pokemon_id, hp_current, hp_max) VALUES ($1, $2, $3, 50, 50)', [gym.id, B.userId, pB3]);
  const gymA = await call('GET', `/v1/gyms/${gym.id}`, { token: A.token });
  const gymB = await call('GET', `/v1/gyms/${gym.id}`, { token: B.token });
  const defA = ((gymA.data && gymA.data.defenders) || []).find((d) => d.pokemonId === pB3);
  const defB = ((gymB.data && gymB.data.defenders) || []).find((d) => d.pokemonId === pB3);
  record('战斗匿名：道馆守护精灵对他人隐藏 CP/昵称，仅显示种类', defA && defA.anonymous === true && defA.cp === null && defA.speciesId === 25, JSON.stringify(defA || gymA.body).slice(0, 160));
  record('战斗匿名：主人仍看到完整数据', defB && defB.cp === 999 && defB.anonymous === false);
  await db().query('DELETE FROM gym_defenders WHERE pokemon_id = $1', [pB3]);

  // ── 精灵好友（REQ-00326） ───────────────────────────────────
  const pfReq = await call('POST', `/v1/pokemon/${pA}/friend-request`, { token: A.token, body: { friendPokemonId: pB2, message: '做朋友吧' } });
  record('精灵好友：发起申请', pfReq.status === 201 && pfReq.data.friendshipId, `status=${pfReq.status} ${JSON.stringify(pfReq.body).slice(0, 120)}`);
  const pushPf = await wsB.waitFor('pokemon_friend_request', (p) => p.friendshipId === (pfReq.data && pfReq.data.friendshipId));
  record('WebSocket：对方主人实时收到精灵好友申请', !!pushPf);
  const pCnot = await makePokemon(C.userId, 39);
  const pfStr = await call('POST', `/v1/pokemon/${pCnot}/friend-request`, { token: C.token, body: { friendPokemonId: pB2 } });
  record('精灵好友：非好友的精灵不能申请', pfStr.status === 403, `status=${pfStr.status}`);
  const pfWrong = await call('PUT', `/v1/pokemon/friendships/${pfReq.data.friendshipId}/status`, { token: A.token, body: { action: 'accept' } });
  record('精灵好友：申请方不能自己接受', pfWrong.status === 403, `status=${pfWrong.status}`);
  const pfAcc = await call('PUT', `/v1/pokemon/friendships/${pfReq.data.friendshipId}/status`, { token: B.token, body: { action: 'accept' } });
  record('精灵好友：对方主人接受，发放 1 级奖励', pfAcc.status === 200 && pfAcc.data.status === 'accepted' && pfAcc.data.rewards.length === 2, `status=${pfAcc.status}`);
  const fid = pfReq.data.friendshipId;
  const results = {};
  for (const t of ['visit', 'gift', 'adventure', 'photo', 'training']) {
    results[t] = await call('POST', `/v1/pokemon/friendships/${fid}/interact`, { token: A.token, body: { type: t } });
  }
  record('精灵好友：五种互动均成功并增加亲密度', Object.values(results).every((r) => r.status === 200 && r.data.intimacyGained > 0),
    Object.entries(results).map(([k, r]) => `${k}:${r.status}/${r.data && r.data.intimacyGained}`).join(' '));
  record('精灵好友：亲密度按类型与加成计算（拜访 10、合影 5、跨区域/同种加成）', results.visit.data.intimacyGained === 10 && results.photo.data.intimacyGained === 5);
  const cd = await call('POST', `/v1/pokemon/friendships/${fid}/interact`, { token: A.token, body: { type: 'visit' } });
  record('精灵好友：冷却期内重复互动 429', cd.status === 429, `status=${cd.status}`);
  const cdB = await call('POST', `/v1/pokemon/friendships/${fid}/interact`, { token: B.token, body: { type: 'visit' } });
  record('精灵好友：冷却按主人独立计时（B 可拜访）', cdB.status === 200, `status=${cdB.status}`);
  const conc = await Promise.all([1, 2, 3, 4].map(() => call('POST', `/v1/pokemon/friendships/${fid}/interact`, { token: B.token, body: { type: 'photo' } })));
  record('精灵好友：并发互动只成功一次', conc.filter((r) => r.status === 200).length === 1, `statuses=${conc.map((r) => r.status)}`);
  await db().query('UPDATE pokemon_friendships SET intimacy_score = 590, friendship_level = 3 WHERE id = $1', [fid]);
  await db().query("DELETE FROM pokemon_interactions WHERE friendship_id = $1 AND interaction_type = 'training'", [fid]);
  const up = await call('POST', `/v1/pokemon/friendships/${fid}/interact`, { token: A.token, body: { type: 'training' } });
  record('精灵好友：亲密度跨过阈值升级并发放奖励', up.status === 200 && up.data.friendshipLevel === 4 && up.data.levelsGained.includes(4) && up.data.rewards.some((r) => r.type === 'feature'),
    `lvl=${up.data && up.data.friendshipLevel} rewards=${up.data && JSON.stringify(up.data.rewards).slice(0, 80)}`);
  const pushPl = await wsB.waitFor('pokemon_friendship_level_up', (p) => p.friendshipId === fid && p.newLevel === 4);
  record('WebSocket：精灵好友升级实时通知', !!pushPl);
  const ks = await call('GET', `/v1/pokemon/friendships/${fid}/keepsakes`, { token: B.token });
  record('精灵好友：合影生成纪念品', ks.status === 200 && ks.data.keepsakes.some((k) => k.keepsake_type === 'photo'), `n=${ks.data && ks.data.keepsakes.length}`);
  const pfl = await call('GET', `/v1/pokemon/${pA}/friends?sortBy=intimacy`, { token: A.token });
  record('精灵好友：好友列表（含等级、亲密度、冷却）', pfl.status === 200 && pfl.data.total === 1 && pfl.data.friends[0].friendshipLevel === 4 && pfl.data.friends[0].cooldowns.visit > 0,
    `status=${pfl.status}`);

  // ── 推荐 / 动态 / 提醒 / 联合任务（REQ-00388） ─────────────────
  const H = await newUser('fh');
  await befriend(H, A);
  const rec = await call('GET', '/v1/friends/recommendations?refresh=true', { token: H.token });
  const recB = (rec.data && rec.data.recommendations || []).find((r) => r.userId === B.userId);
  record('推荐：共同好友维度（A 的好友 B 推荐给 H）', rec.status === 200 && recB && recB.reasons.includes('mutual_friends'), `status=${rec.status} n=${rec.data && rec.data.recommendations && rec.data.recommendations.length}`);
  await db().query('UPDATE users SET last_lat = 31.2304, last_lng = 121.4737, last_active_at = NOW() WHERE id = ANY($1::uuid[])', [[H.userId, C.userId]]);
  await call('PATCH', '/v1/privacy/settings', { token: C.token, body: { allow_location_sharing: true } });
  const rec2 = await call('GET', '/v1/friends/recommendations?refresh=true', { token: H.token });
  const recC = (rec2.data.recommendations || []).find((r) => r.userId === C.userId);
  record('推荐：位置维度（附近且开启位置共享）', recC && recC.reasons.includes('location_nearby') && recC.distanceKm !== null, JSON.stringify(recC || {}).slice(0, 160));
  record('推荐：结果不含自己/好友', !(rec2.data.recommendations || []).some((r) => r.userId === H.userId || r.userId === A.userId));
  const cached = await call('GET', '/v1/friends/recommendations', { token: H.token });
  record('推荐：结果缓存', cached.data.cached === true);
  await call('POST', `/v1/friends/recommendations/${B.userId}/dismiss`, { token: H.token });
  const rec3 = await call('GET', '/v1/friends/recommendations', { token: H.token });
  record('推荐：忽略后不再推荐', !(rec3.data.recommendations || []).some((r) => r.userId === B.userId));

  const feed = await call('GET', '/v1/friends/activities', { token: A.token });
  const items = (feed.data && feed.data.items) || [];
  record('动态流：包含好友动态与捕捉记录', items.some((i) => i.type === 'catch_pokemon' && i.user.id === B.userId) && items.some((i) => i.type === 'friend_add' || i.type === 'gift_receive'),
    `types=${[...new Set(items.map((i) => i.type))]}`);
  const likable = items.find((i) => i.likable && i.user.id === B.userId);
  const like1 = likable ? await call('POST', `/v1/friends/activities/${likable.activityId}/like`, { token: A.token }) : { status: 0 };
  const like2 = likable ? await call('POST', `/v1/friends/activities/${likable.activityId}/like`, { token: A.token }) : { status: 0 };
  record('动态流：点赞（重复点赞不重复计数）', like1.status === 200 && like2.data.likeCount === like1.data.likeCount, `likes=${like1.data && like1.data.likeCount}`);
  await call('PATCH', '/v1/privacy/settings', { token: B.token, body: { pokemon_collection_visibility: 'private', activity_visibility: 'private' } });
  const feed2 = await call('GET', '/v1/friends/activities', { token: A.token });
  record('动态流：遵守好友隐私（收藏/动态私密后不可见）', !((feed2.data && feed2.data.items) || []).some((i) => i.user.id === B.userId));
  await call('PATCH', '/v1/privacy/settings', { token: B.token, body: { pokemon_collection_visibility: 'friends', activity_visibility: 'friends' } });

  const inv = await call('POST', `/v1/friends/${B.userId}/invite`, { token: A.token, body: { type: 'gym', gymId: gym.id } });
  const pushInv = await wsB.waitFor('gym_invite');
  record('提醒：道馆邀请实时推送并入提醒中心', inv.status === 201 && !!pushInv);
  await call('PUT', '/v1/friends/me/profile', { token: A.token, body: { birthday: '1990-01-01' } });
  const rem = await call('GET', '/v1/friends/reminders?unread=true', { token: B.token });
  const remTypes = new Set((rem.data.reminders || []).map((r) => r.reminder_type));
  record('提醒：礼物/等级/道馆邀请/精灵好友申请等提醒', ['gift_received', 'intimacy_level_up', 'gym_invite', 'pokemon_friend_request', 'friend_accepted'].every((t) => remTypes.has(t)), `types=${[...remTypes]}`);
  const rd = await call('POST', '/v1/friends/reminders/read', { token: B.token, body: {} });
  const rem2 = await call('GET', '/v1/friends/reminders', { token: B.token });
  record('提醒：全部标记已读', rd.status === 200 && rem2.data.unread === 0);

  const jmList = await call('GET', `/v1/friends/${B.userId}/joint-missions`, { token: A.token });
  record('联合任务：列表（按亲密度解锁）', jmList.status === 200 && jmList.data.missions.some((mm) => mm.code === 'gift_exchange' && mm.unlocked) && jmList.data.missions.some((mm) => !mm.unlocked));
  const jmLocked = await call('POST', `/v1/friends/${B.userId}/joint-missions`, { token: A.token, body: { missionId: 'legend_duo' } });
  record('联合任务：未解锁任务不能开始（403）', jmLocked.status === 403, `status=${jmLocked.status}`);
  const jm = await call('POST', `/v1/friends/${B.userId}/joint-missions`, { token: A.token, body: { missionId: 'gift_exchange' } });
  record('联合任务：开始任务', jm.status === 201 && jm.data.status === 'in_progress', `status=${jm.status}`);
  const jmInv = await wsB.waitFor('joint_mission_invite');
  record('联合任务：邀请实时推送', !!jmInv);
  await db().query("DELETE FROM friend_gifts WHERE from_user_id = $1 AND to_user_id = $2 AND gift_type = 'item' AND status = 'claimed'", [A.userId, D.userId]);
  const giftBA = await call('POST', `/v1/friends/${A.userId}/gift`, { token: B.token, body: { giftType: 'item', giftId: 'POKE_BALL', quantity: 1 } });
  const giftAB = await call('POST', `/v1/friends/${B.userId}/gift`, { token: A.token, body: { giftType: 'item', giftId: 'POKE_BALL', quantity: 1 } });
  const jmp = await call('GET', `/v1/friends/joint-missions/${jm.data.id}`, { token: A.token });
  record('联合任务：服务端按真实礼物记录计算进度并完成', giftBA.status === 201 && giftAB.status === 201 && jmp.data.status === 'completed', `status=${jmp.data && jmp.data.status} ${JSON.stringify(jmp.data && jmp.data.progress)}`);
  const dustBefore = await q1('SELECT stardust FROM users WHERE id = $1', [B.userId]);
  const jc = await Promise.all([1, 2, 3].map(() => call('POST', `/v1/friends/joint-missions/${jm.data.id}/claim`, { token: B.token })));
  const dustAfter = await q1('SELECT stardust FROM users WHERE id = $1', [B.userId]);
  record('联合任务：并发领奖只成功一次且奖励入账', jc.filter((r) => r.status === 200).length === 1 && dustAfter.stardust - dustBefore.stardust === 300, `statuses=${jc.map((r) => r.status)} Δ=${dustAfter.stardust - dustBefore.stardust}`);

  // ── 旧接口兼容 / 删除好友 ─────────────────────────────────────
  const I = await newUser('fi');
  const codeI = (await call('GET', '/v1/friends/my-code', { token: I.token })).data.friendCode;
  const legacyAdd = await call('POST', '/v1/friends/add', { token: C.token, body: { friendCode: codeI } });
  record('兼容：POST /friends/add（好友码）', legacyAdd.status === 201, `status=${legacyAdd.status}`);
  const legacyGifts = await call('GET', '/v1/friends/gifts', { token: A.token });
  record('兼容：GET /friends/gifts', legacyGifts.status === 200 && Array.isArray(legacyGifts.data));
  const openLegacy = legacyGifts.data.find((g) => g.from_user_id === B.userId);
  const legacyOpen = openLegacy ? await call('POST', `/v1/friends/gifts/${openLegacy.id}/open`, { token: A.token }) : { status: 0 };
  record('兼容：POST /friends/gifts/:id/open', legacyOpen.status === 200, `status=${legacyOpen.status}`);
  const del = await call('DELETE', `/v1/friends/${H.userId}`, { token: A.token });
  const delRows = await q1('SELECT COUNT(*)::int AS n FROM friends WHERE (user_id = $1 AND friend_user_id = $2) OR (user_id = $2 AND friend_user_id = $1)', [A.userId, H.userId]);
  const delLegacy = await q1('SELECT COUNT(*)::int AS n FROM friendships WHERE user_a = LEAST($1::uuid, $2::uuid) AND user_b = GREATEST($1::uuid, $2::uuid)', [A.userId, H.userId]);
  record('删除好友：双向删除且旧表同步', del.status === 200 && delRows.n === 0 && delLegacy.n === 0);
  const pushDel = await (async () => { const w = await WsClient.open(H.token); await sleep(200); const r = w.events.length; w.close(); return r; })();
  record('WebSocket：多用户独立连接', pushDel >= 1);

  wsA.close(); wsB.close();
  console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => { record('未捕获异常', false, err.stack || err.message); }).finally(finish);
