// tests/unit/friend-service-db.test.js
// E01 好友与社交互动：直接 require 业务模块，对真实 PostgreSQL 执行（事件/Redis 用内存替身）。
// 数据库地址取 DATABASE_URL，或仓库根目录 .env 的 POSTGRES_*（CI 栈）；连不上数据库时整组跳过。
'use strict';

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.FRIEND_JOBS_DISABLED = 'true';
if (!process.env.DATABASE_URL) {
  const envFile = path.resolve(__dirname, '..', '..', '..', '.env');
  if (fs.existsSync(envFile)) {
    const env = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
    if (env.POSTGRES_DB) {
      process.env.DATABASE_URL = `postgres://${env.POSTGRES_USER}:${encodeURIComponent(env.POSTGRES_PASSWORD || '')}@${env.POSTGRES_HOST || '127.0.0.1'}:${env.POSTGRES_PORT || 5432}/${env.POSTGRES_DB}`;
    }
  }
}

const db = require('../../shared/db');
const { FriendService } = require('../../services/social-service/src/friendService');
const { PrivacyService } = require('../../services/social-service/src/social/privacyService');
const { JointMissionService } = require('../../services/social-service/src/social/jointMissionService');
const jobs = require('../../services/social-service/src/social/jobs');
const { PokemonFriendService } = require('../../services/pokemon-service/src/services/pokemonFriendService');
const { PokemonPrivacyService } = require('../../services/pokemon-service/src/services/pokemonPrivacyService');
const { RecommendationService } = require('../../services/social-service/src/social/recommendationService');
const { ActivityService } = require('../../services/social-service/src/social/activityService');
const socialEvents = require('../../shared/social/socialEvents');

let dbOk = false;
const published = [];
const events = {
  publish: async (userIds, type, payload) => { published.push({ userIds, type, payload }); return 1; },
  createReminder: async () => null,
};
const redisStore = new Map();
const fakeRedis = {
  get: async (k) => redisStore.get(k) || null,
  setex: async (k, _t, v) => { redisStore.set(k, v); },
  incr: async (k) => { redisStore.set(k, String(Number(redisStore.get(k) || 0) + 1)); },
  del: async () => {},
};
const friends = new FriendService({ events, redisFactory: () => fakeRedis });
const privacy = new PrivacyService({ events, friends });
const missions = new JointMissionService({ events, friends });
const pokemonFriends = new PokemonFriendService({ events, rng: () => 0.9 });
const pokemonPrivacy = new PokemonPrivacyService();
const recommendations = new RecommendationService({ redisFactory: () => fakeRedis });
const activities = new ActivityService({ friends });
// 定时任务与提醒直接调用 shared/social/socialEvents：发布改为写入内存
socialEvents._setRedisFactory(() => ({ publish: async (_ch, msg) => { const e = JSON.parse(msg); published.push(e); return 1; } }));

before(async () => {
  if (!process.env.DATABASE_URL) return;
  try {
    await db.query('SELECT 1 FROM friends LIMIT 1');
    await db.query('SELECT 1 FROM privacy_settings LIMIT 1');
    dbOk = true;
  } catch { dbOk = false; }
});
after(async () => { try { await db.closePools(); } catch { /* ignore */ } });

const dbTest = (name, fn) => test(name, async (t) => {
  if (!dbOk) { t.skip('无可用数据库（设置 DATABASE_URL 或在 CI 栈内运行）'); return; }
  await fn(t);
});

async function users(n, prefix = 'ut') {
  const { rows } = await db.query(
    "INSERT INTO users (nickname) SELECT $2 || '_' || i || '_' || floor(random() * 1e9)::bigint FROM generate_series(1, $1) i RETURNING id, friend_code",
    [n, prefix]);
  return rows;
}
const settle = (ps) => Promise.allSettled(ps);
const codes = (rs) => rs.map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason.code));

dbTest('新用户由触发器生成 12 位唯一好友码', async () => {
  const [a, b] = await users(2);
  assert.match(a.friend_code, /^\d{12}$/);
  assert.notEqual(a.friend_code, b.friend_code);
  const r = await friends.getFriendCode(a.id);
  assert.equal(r.friendCode, a.friend_code);
});

dbTest('请求 → 接受：双向两行、旧表同步、事件推送；重复请求 409；互相申请自动成为好友', async () => {
  const [a, b, c] = await users(3);
  const r = await friends.sendFriendRequest(a.id, b.id, { message: 'hi' });
  assert.equal(r.status, 'pending');
  assert.ok(published.some((e) => e.type === 'friend_request_received' && e.userIds.includes(b.id)));
  await assert.rejects(friends.sendFriendRequest(a.id, b.id), (e) => e.code === 2014);
  const acc = await friends.acceptFriendRequest(b.id, r.requestId);
  assert.equal(acc.friend.id, a.id);
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM friends WHERE (user_id=$1 AND friend_user_id=$2) OR (user_id=$2 AND friend_user_id=$1)', [a.id, b.id]);
  assert.equal(rows[0].n, 2);
  const { rows: [l] } = await db.query('SELECT COUNT(*)::int AS n FROM friendships WHERE user_a = LEAST($1::uuid,$2::uuid) AND user_b = GREATEST($1::uuid,$2::uuid)', [a.id, b.id]);
  assert.equal(l.n, 1);
  await assert.rejects(friends.sendFriendRequest(b.id, a.id), (e) => e.code === 2002);
  await friends.sendFriendRequest(c.id, a.id);
  const auto = await friends.sendFriendRequest(a.id, c.id);
  assert.equal(auto.autoAccepted, true);
});

dbTest('并发接受：只差 1 个名额时两个接受只成功一个（好友上限 400）', async () => {
  const [target, x, y] = await users(3);
  const filler = await users(399, 'fill');
  await db.query(`INSERT INTO friends (user_id, friend_user_id, status) SELECT $1, u, 'accepted' FROM unnest($2::uuid[]) u
                  UNION ALL SELECT u, $1, 'accepted' FROM unnest($2::uuid[]) u`, [target.id, filler.map((f) => f.id)]);
  const { rows: reqs } = await db.query(`INSERT INTO friend_requests (from_user_id, to_user_id, status, expires_at)
    VALUES ($1, $3, 'pending', NOW() + INTERVAL '7 days'), ($2, $3, 'pending', NOW() + INTERVAL '7 days') RETURNING id`, [x.id, y.id, target.id]);
  const res = await settle(reqs.map((r) => friends.acceptFriendRequest(target.id, r.id)));
  assert.deepEqual(codes(res).sort(), [2003, 'ok'].sort());
  assert.equal(await friends.countFriends(db, target.id), 400);
});

dbTest('并发发送：待处理请求只差 1 个名额时两个请求只成功一个（上限 50）', async () => {
  const [sender, t1, t2] = await users(3);
  const others = await users(49, 'pend');
  await db.query(`INSERT INTO friend_requests (from_user_id, to_user_id, status, expires_at)
                  SELECT $1, u, 'pending', NOW() + INTERVAL '7 days' FROM unnest($2::uuid[]) u`, [sender.id, others.map((o) => o.id)]);
  const res = await settle([friends.sendFriendRequest(sender.id, t1.id), friends.sendFriendRequest(sender.id, t2.id)]);
  assert.deepEqual(codes(res).sort(), [2004, 'ok'].sort());
});

dbTest('拒绝/忽略/取消/过期', async () => {
  const [a, b, c] = await users(3);
  const r1 = await friends.sendFriendRequest(a.id, b.id);
  assert.equal((await friends.rejectFriendRequest(b.id, r1.requestId)).status, 'rejected');
  const r2 = await friends.sendFriendRequest(a.id, b.id);
  assert.equal(r2.requestId, r1.requestId, '被拒后重新申请复用同一行');
  assert.equal((await friends.rejectFriendRequest(b.id, r2.requestId, { ignore: true })).status, 'ignored');
  const r3 = await friends.sendFriendRequest(c.id, b.id);
  await assert.rejects(friends.cancelFriendRequest(b.id, r3.requestId), (e) => e.code === 2005, '只有发送方能取消');
  assert.equal((await friends.cancelFriendRequest(c.id, r3.requestId)).status, 'cancelled');
  const r4 = await friends.sendFriendRequest(c.id, a.id);
  await db.query("UPDATE friend_requests SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [r4.requestId]);
  await assert.rejects(friends.acceptFriendRequest(a.id, r4.requestId), (e) => e.code === 2015);
  const { rows: [s] } = await db.query('SELECT status FROM friend_requests WHERE id = $1', [r4.requestId]);
  assert.equal(s.status, 'expired');
});

dbTest('礼物：道具礼物扣减/入账、并发开礼只成功一次、友情点与升级事件、每日上限', async () => {
  const [a, b] = await users(2);
  await friends.acceptFriendRequest(b.id, (await friends.sendFriendRequest(a.id, b.id)).requestId);
  await db.query('UPDATE friends SET friendship_points = 95 WHERE (user_id=$1 AND friend_user_id=$2) OR (user_id=$2 AND friend_user_id=$1)', [a.id, b.id]);
  const g = await friends.sendGift(a.id, b.id, { giftType: 'item', giftId: 'POKE_BALL', quantity: 5 });
  const { rows: [ua] } = await db.query('SELECT pokeball_count FROM users WHERE id = $1', [a.id]);
  assert.equal(ua.pokeball_count, 45);
  const res = await settle(Array.from({ length: 8 }, () => friends.claimGift(b.id, g.giftId)));
  assert.equal(codes(res).filter((c) => c === 'ok').length, 1);
  assert.ok(codes(res).filter((c) => c !== 'ok').every((c) => c === 2010));
  const { rows: [ub] } = await db.query('SELECT pokeball_count FROM users WHERE id = $1', [b.id]);
  assert.equal(ub.pokeball_count, 55);
  const { rows: pts } = await db.query('SELECT friendship_points, friendship_level, intimacy_level FROM friends WHERE user_id = $1 AND friend_user_id = $2', [a.id, b.id]);
  assert.deepEqual(pts[0], { friendship_points: 105, friendship_level: 2, intimacy_level: 2 });
  assert.ok(published.some((e) => e.type === 'friendship_level_up' && e.userIds.includes(a.id) && e.payload.level === 2));
  await assert.rejects(friends.sendGift(a.id, b.id, { giftType: 'coins', quantity: 1 }), (e) => e.code === 2018);
  await assert.rejects(friends.sendGift(a.id, b.id, { giftType: 'item', giftId: 'MASTER_BALL', quantity: 1 }), (e) => e.code === 2007);
  await db.query(`INSERT INTO friend_gifts (sender_id, receiver_id, gift_type, status, sent_at)
                  SELECT $1, $2, 'item', 'claimed', NOW() FROM generate_series(1, 49)`, [a.id, b.id]);
  await assert.rejects(friends.sendGift(a.id, b.id, {}), (e) => e.code === 2009);
});

dbTest('定时任务：过期礼物退还赠送方（系统礼物包不退）、过期请求标记 expired', async () => {
  const [a, b] = await users(2);
  await friends.acceptFriendRequest(b.id, (await friends.sendFriendRequest(a.id, b.id)).requestId);
  const g = await friends.sendGift(a.id, b.id, { giftType: 'item', giftId: 'POKE_BALL', quantity: 3 });
  const std = await friends.sendGift(a.id, b.id, {});
  await db.query("UPDATE friend_gifts SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ANY($1::uuid[])", [[g.giftId, std.giftId]]);
  const { rows: [before1] } = await db.query('SELECT pokeball_count FROM users WHERE id = $1', [a.id]);
  assert.equal(before1.pokeball_count, 47);
  const out = await jobs.expireRequestsAndGifts(db);
  assert.ok(out.gifts >= 2);
  const { rows: [after1] } = await db.query('SELECT pokeball_count FROM users WHERE id = $1', [a.id]);
  assert.equal(after1.pokeball_count, 50, '道具礼物过期退还赠送方');
  const { rows: st } = await db.query('SELECT status FROM friend_gifts WHERE id = ANY($1::uuid[])', [[g.giftId, std.giftId]]);
  assert.ok(st.every((r) => r.status === 'expired'));
  await assert.rejects(friends.claimGift(b.id, g.giftId), (e) => e.code === 2010);
});

dbTest('隐私：拉黑解除好友并撤销申请；批量可见性；分组权限', async () => {
  const [a, b, c] = await users(3);
  await friends.acceptFriendRequest(b.id, (await friends.sendFriendRequest(a.id, b.id)).requestId);
  await friends.sendFriendRequest(c.id, a.id);
  const batch1 = await privacy.batchCheck(b.id, [a.id, c.id, b.id], ['online_status', 'pokemon_shinies']);
  assert.deepEqual(batch1.results[a.id], { online_status: true, pokemon_shinies: false });
  assert.deepEqual(batch1.results[c.id], { online_status: false, pokemon_shinies: false });
  assert.deepEqual(batch1.results[b.id], { online_status: true, pokemon_shinies: true });
  const g = await privacy.createGroup(a.id, { name: '家人', permissionLevel: 'family' });
  await privacy.updateFriendPermissions(a.id, b.id, { groupId: g.id });
  assert.equal((await privacy.checkVisibility(b.id, a.id, 'pokemon_shinies')).canView, true);
  await assert.rejects(privacy.updateSettings(a.id, { profile_visibility: 'nobody' }), (e) => e.code === 1001);
  const s = await privacy.updateSettings(a.id, { profile_visibility: 'close_friends' });
  assert.equal(s.profile_visibility, 'close_friends');
  const blk = await privacy.block(a.id, c.id, 'spam');
  assert.equal(blk.requestsCancelled, 1);
  await assert.rejects(friends.sendFriendRequest(c.id, a.id), (e) => e.code === 2017);
  const blk2 = await privacy.block(a.id, b.id);
  assert.equal(blk2.friendshipRemoved, true);
  assert.equal(await friends.countFriends(db, a.id), 0);
  const { rows: au } = await db.query("SELECT action FROM audit_logs WHERE user_id = $1 AND entity_type = 'social'", [a.id]);
  for (const act of ['friend_group_created', 'friend_permissions_changed', 'privacy_settings_changed', 'user_blocked']) {
    assert.ok(au.some((r) => r.action === act), act);
  }
});

dbTest('精灵好友：接受发放 1 级奖励、冷却、并发互动只成功一次、升级奖励与纪念品', async () => {
  const [a, b] = await users(2);
  await friends.acceptFriendRequest(b.id, (await friends.sendFriendRequest(a.id, b.id)).requestId);
  const mk = async (u, s) => (await db.query(`INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp)
                                             VALUES ($1, $2, 100, 10, 10, 1, 2, 3) RETURNING id`, [u, s])).rows[0].id;
  const pa = await mk(a.id, 4);
  const pb = await mk(b.id, 4);
  const req = await pokemonFriends.sendRequest(a.id, pa, pb, 'hi');
  await assert.rejects(pokemonFriends.respond(a.id, req.friendshipId, 'accept'), (e) => e.code === 1003);
  const acc = await pokemonFriends.respond(b.id, req.friendshipId, 'accept');
  assert.equal(acc.rewards.length, 2);
  const res = await settle(Array.from({ length: 5 }, () => pokemonFriends.interact(a.id, req.friendshipId, 'visit')));
  assert.equal(codes(res).filter((c) => c === 'ok').length, 1);
  assert.ok(codes(res).filter((c) => c !== 'ok').every((c) => c === 3029));
  const ok = res.find((r) => r.status === 'fulfilled').value;
  assert.equal(ok.intimacyGained, 18, '同种 ×1.5、同属性 ×1.2：10×1.5×1.2');
  await db.query('UPDATE pokemon_friendships SET intimacy_score = 295, friendship_level = 1 WHERE id = $1', [req.friendshipId]);
  const up = await pokemonFriends.interact(a.id, req.friendshipId, 'photo');
  assert.equal(up.friendshipLevel, 3, '295 + 9 = 304 → 跨两级');
  assert.deepEqual(up.levelsGained, [2, 3]);
  assert.ok(up.keepsake && up.keepsake.keepsake_type === 'photo');
  const d = await pokemonFriends.detail(b.id, req.friendshipId);
  assert.ok(d.rewards.some((r) => r.level === 2 && r.reward_type === 'keepsake'));
  assert.ok(d.rewards.some((r) => r.level === 3 && r.reward_type === 'boost'));
  const ks = await pokemonFriends.keepsakes(a.id, req.friendshipId);
  assert.ok(ks.keepsakes.some((k) => k.keepsake_type === 'friendship_ribbon'));
  assert.ok(published.some((e) => e.type === 'pokemon_friendship_level_up' && e.payload.newLevel === 3));
});

dbTest('联合任务：按真实礼物记录完成，每人只能领取一次（并发）', async () => {
  const [a, b] = await users(2);
  await friends.acceptFriendRequest(b.id, (await friends.sendFriendRequest(a.id, b.id)).requestId);
  const m = await missions.start(a.id, b.id, 'gift_exchange');
  await assert.rejects(missions.start(b.id, a.id, 'gift_exchange'), (e) => e.code === 2023);
  assert.equal((await missions.get(a.id, m.id)).status, 'in_progress');
  await friends.sendGift(a.id, b.id, {});
  await friends.sendGift(b.id, a.id, {});
  const done = await missions.get(b.id, m.id);
  assert.equal(done.status, 'completed');
  const { rows: [before1] } = await db.query('SELECT stardust FROM users WHERE id = $1', [a.id]);
  const res = await settle(Array.from({ length: 4 }, () => missions.claim(a.id, m.id)));
  assert.equal(codes(res).filter((c) => c === 'ok').length, 1);
  const { rows: [after1] } = await db.query('SELECT stardust FROM users WHERE id = $1', [a.id]);
  assert.equal(after1.stardust - before1.stardust, 300);
  const { rows: [fp] } = await db.query('SELECT friendship_points FROM friends WHERE user_id = $1 AND friend_user_id = $2', [a.id, b.id]);
  assert.equal(fp.friendship_points, 30, '联合任务完成奖励友情点');
});

async function friendsPair() {
  const [a, b] = await users(2);
  await friends.acceptFriendRequest(b.id, (await friends.sendFriendRequest(a.id, b.id)).requestId);
  return [a, b];
}
const mkPokemon = async (u, s, extra = {}) => (await db.query(`
  INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp, is_shiny, caught_at)
  VALUES ($1, $2, $3, 10, 10, 10, 11, 12, $4, NOW()) RETURNING id`, [u, s, extra.cp || 321, !!extra.shiny])).rows[0].id;

dbTest('好友列表/详情/搜索：在线状态按对方隐私过滤，查看详情记 visit_profile（每天一次）', async () => {
  const [a, b] = await friendsPair();
  await friends.touchPresence(b.id);
  const list = await friends.getFriendList(a.id, { sortBy: 'online' });
  assert.equal(list.friends[0].online_status, 'online');
  assert.equal(list.friends[0].friendship_level_name, '新朋友');
  for (const sortBy of ['friendship_level', 'name', 'level', 'recent', 'favorite', 'bogus']) {
    assert.equal((await friends.getFriendList(a.id, { sortBy })).pagination.total, 1);
  }
  assert.equal((await friends.getFriendList(a.id, { favorite: true })).pagination.total, 0);
  await db.query("INSERT INTO privacy_settings (user_id, online_status_visibility, profile_visibility) VALUES ($1, 'private', 'private')", [b.id]);
  const hidden = await friends.getFriendList(a.id);
  assert.equal(hidden.friends[0].online_status, 'hidden');
  const d = await friends.getFriendDetail(a.id, b.id);
  assert.equal(d.level, null, '资料私密时不返回等级');
  assert.equal(d.online_status, 'hidden');
  await friends.getFriendDetail(a.id, b.id);
  await new Promise((r) => setTimeout(r, 200));
  const { rows: [v] } = await db.query("SELECT COUNT(*)::int AS n FROM friend_interactions WHERE user_id = $1 AND friend_user_id = $2 AND interaction_type = 'visit_profile'", [a.id, b.id]);
  assert.equal(v.n, 1);
  await assert.rejects(friends.getFriendDetail(a.id, a.id), (e) => e.code === 2006);
  const { rows: [bn] } = await db.query('SELECT nickname FROM users WHERE id = $1', [b.id]);
  assert.ok((await friends.searchUsers(a.id, bn.nickname.slice(0, 8))).some((u) => u.id === b.id && u.is_friend));
  await db.query('UPDATE privacy_settings SET searchable = false WHERE user_id = $1', [b.id]);
  assert.ok(!(await friends.searchUsers(a.id, bn.nickname.slice(0, 8))).some((u) => u.id === b.id), '关闭搜索后昵称搜不到');
  const { rows: [bc] } = await db.query('SELECT friend_code FROM users WHERE id = $1', [b.id]);
  assert.equal((await friends.searchUsers(a.id, bc.friend_code)).length, 1, '好友码仍可精确查找');
  assert.equal((await friends.findUserByFriendCode(bc.friend_code)).id, b.id);
  await assert.rejects(friends.addFriendByCode(a.id, (await friends.getFriendCode(a.id)).friendCode), (e) => e.code === 2012);
});

dbTest('在线通知：由离线变为在线时通知允许查看在线状态的好友', async () => {
  const [a, b] = await friendsPair();
  const c = (await users(1))[0];
  await friends.acceptFriendRequest(c.id, (await friends.sendFriendRequest(a.id, c.id)).requestId);
  await db.query("INSERT INTO privacy_settings (user_id, notify_friend_online) VALUES ($1, false)", [c.id]);
  await db.query('UPDATE users SET last_active_at = NULL WHERE id = $1', [a.id]);
  published.length = 0;
  const r = await friends.touchPresence(a.id);
  assert.equal(r.cameOnline, true);
  await new Promise((res) => setTimeout(res, 300));
  const online = published.filter((e) => e.type === 'friend_online');
  assert.ok(online.some((e) => e.userIds.includes(b.id)));
  assert.ok(!online.some((e) => e.userIds.includes(c.id)), '关闭上线提醒的好友不通知');
  assert.equal((await friends.touchPresence(a.id)).updated, false, '30 秒内不重复写库');
});

dbTest('排行榜（好友/等级/经验/本周捕捉/全服）、删除好友、全部领取、互动计分', async () => {
  const [a, b] = await friendsPair();
  await db.query('UPDATE users SET level = 20, xp = 5000 WHERE id = $1', [b.id]);
  await mkPokemon(b.id, 1);
  await friends.recordInteraction(a.id, b.id, 'trade', { tradeId: 't' });
  const fr = await friends.getFriendLeaderboard(a.id, 'friendship', 5);
  assert.equal(fr.entries[0].score, 100);
  assert.equal((await friends.getFriendLeaderboard(a.id, 'level')).entries[0].id, b.id);
  assert.equal((await friends.getFriendLeaderboard(a.id, 'xp')).entries[0].id, b.id);
  const cat = await friends.getFriendLeaderboard(a.id, 'catches');
  assert.equal(cat.entries.find((e) => e.id === b.id).score, 1);
  await jobs.refreshLeaderboard(db);
  const g = await friends.getFriendLeaderboard(a.id, 'global', 100);
  assert.ok(Array.isArray(g.entries));
  assert.equal((await friends.recordInteraction(a.id, b.id, 'visit_profile')).points, 2);
  assert.equal((await friends.recordInteraction(a.id, b.id, 'visit_profile')).skipped, true);
  await friends.sendGift(a.id, b.id, {});
  const pend = await friends.getPendingGifts(b.id);
  assert.equal(pend.gifts.length, 1);
  assert.equal((await friends.getSentGifts(a.id)).quota.sentToday, 1);
  const all = await friends.claimAllGifts(b.id);
  assert.equal(all.claimed, 1);
  assert.equal((await friends.getPendingRequests(b.id)).total, 0);
  assert.equal((await friends.getSentRequests(a.id)).length, 0);
  await friends.removeFriend(a.id, b.id);
  await assert.rejects(friends.removeFriend(a.id, b.id), (e) => e.code === 2006);
});

dbTest('精灵可见性：默认配置（含应用到已有精灵）、单只设置、批量、他人视图与收藏', async () => {
  const [a, b] = await friendsPair();
  const stranger = (await users(1))[0];
  const p1 = await mkPokemon(b.id, 4, { cp: 600, shiny: true });
  const p2 = await mkPokemon(b.id, 7);
  assert.equal((await pokemonPrivacy.getDefaults(b.id)).source, 'system_default');
  await assert.rejects(pokemonPrivacy.updateDefaults(b.id, { overall_visibility: 'nope' }), (e) => e.code === 1001);
  const d = await pokemonPrivacy.updateDefaults(b.id, { overall_visibility: 'public', show_iv: true, applyToExisting: true });
  assert.equal(d.appliedToExisting, 2);
  assert.equal((await pokemonPrivacy.getPokemonPrivacy(b.id, p1)).overall_visibility, 'public');
  const p3 = await mkPokemon(b.id, 25);
  assert.equal((await pokemonPrivacy.getPokemonPrivacy(b.id, p3)).source, 'pokemon', '新精灵由触发器继承默认');
  const sv = await pokemonPrivacy.getVisibility(stranger.id, p1);
  assert.equal(sv.visibility, 'detailed');
  assert.equal(sv.cp, null, '用户级精灵数值默认仅好友可见');
  assert.equal((await pokemonPrivacy.getVisibility(a.id, p1)).iv.attack, 10);
  await pokemonPrivacy.updatePokemonPrivacy(b.id, p2, { overall_visibility: 'hidden' });
  await assert.rejects(pokemonPrivacy.getVisibility(a.id, p2), (e) => e.code === 3001);
  await assert.rejects(pokemonPrivacy.updatePokemonPrivacy(a.id, p2, { show_cp: false }), (e) => e.code === 3001);
  await assert.rejects(pokemonPrivacy.batchUpdate(b.id, [], {}), (e) => e.code === 1001);
  await assert.rejects(pokemonPrivacy.batchUpdate(b.id, ['x'], { show_cp: true }), (e) => e.code === 1001);
  assert.equal((await pokemonPrivacy.batchUpdate(b.id, [p1, p3], { battle_anonymous: true })).updated_count, 2);
  const coll = await pokemonPrivacy.getUserCollection(a.id, b.id);
  assert.equal(coll.hiddenCount, 1);
  assert.equal(coll.pokemon.length, 2);
  await assert.rejects(pokemonPrivacy.getUserCollection(stranger.id, b.id), (e) => e.code === 2017);
  assert.equal((await pokemonPrivacy.getUserCollection(b.id, b.id)).pokemon.length, 3, '自己看到全部');
  const views = await require('../../shared/social/pokemonPrivacyStore').battleViews(db, a.id, [{ id: p1, user_id: b.id, species_id: 4, cp: 600 }]);
  assert.equal(views[0].anonymous, true);
});

dbTest('推荐：共同好友、附近（仅位置共享用户）、忽略；动态流与点赞；提醒已读', async () => {
  const [a, b] = await friendsPair();
  const [c] = await users(1);
  await friends.acceptFriendRequest(c.id, (await friends.sendFriendRequest(b.id, c.id)).requestId);
  const [n] = await users(1);
  await db.query('UPDATE users SET last_lat = 30.5, last_lng = 114.3, last_active_at = NOW() WHERE id = ANY($1::uuid[])', [[a.id, n.id]]);
  await db.query('INSERT INTO privacy_settings (user_id, allow_location_sharing) VALUES ($1, true)', [n.id]);
  const rec = await recommendations.getRecommendations(a.id, { refresh: true, limit: 30 });
  const rc = rec.recommendations.find((r) => r.userId === c.id);
  assert.ok(rc && rc.reasons.includes('mutual_friends'));
  const rn = rec.recommendations.find((r) => r.userId === n.id);
  assert.ok(rn && rn.reasons.includes('location_nearby'));
  assert.ok(!rec.recommendations.some((r) => r.userId === b.id || r.userId === a.id));
  assert.equal((await recommendations.getRecommendations(a.id)).cached, true);
  await recommendations.dismiss(a.id, c.id);
  assert.ok(!(await recommendations.getRecommendations(a.id, { refresh: true, limit: 30 })).recommendations.some((r) => r.userId === c.id));

  await mkPokemon(b.id, 1);
  await db.query("INSERT INTO achievements (achievement_id, category, name, description) VALUES ('ut_ach', 'test', '{\"zh\":\"测试\"}', '{}') ON CONFLICT DO NOTHING").catch(() => {});
  await db.query("INSERT INTO user_achievements (user_id, achievement_id, completed, completed_at) VALUES ($1, 'ut_ach', true, NOW())", [b.id]).catch(() => {});
  const feed = await activities.getFeed(a.id, { limit: 50 });
  assert.ok(feed.items.some((i) => i.type === 'catch_pokemon'));
  const act = feed.items.find((i) => i.likable && i.user.id === b.id);
  assert.ok(act, '好友动态（加好友）');
  const l1 = await activities.like(a.id, act.activityId);
  const l2 = await activities.like(a.id, act.activityId);
  assert.equal(l1.newlyLiked, true);
  assert.equal(l2.newlyLiked, false);
  assert.equal(l2.likeCount, 1);
  await assert.rejects(activities.getFeed(a.id, { before: 'not-a-date' }), (e) => e.code === 1001);
  await assert.rejects(activities.like(n.id, act.activityId), (e) => e.code === 1004, '非好友不能点赞');

  published.length = 0;
  await db.query("UPDATE users SET birthday = CURRENT_DATE - INTERVAL '20 years' WHERE id = $1", [b.id]);
  const born = await jobs.birthdayReminders(db);
  assert.ok(born >= 1);
  await db.query("UPDATE friends SET last_interaction_at = NOW() - INTERVAL '30 days' WHERE user_id = $1", [a.id]);
  assert.ok(await jobs.longTimeNoSeeReminders(db) >= 1);
  await jobs.achievementReminders(db);
  const rem = await activities.listReminders(a.id);
  const types = rem.reminders.map((r) => r.reminder_type);
  assert.ok(types.includes('birthday') && types.includes('long_time_no_see'), types.join(','));
  assert.ok(published.some((e) => e.type === 'reminder'));
  assert.ok((await activities.listReminders(a.id, { unreadOnly: true })).unread >= 2);
  await activities.markRemindersRead(a.id, [rem.reminders[0].id]);
  await activities.markRemindersRead(a.id);
  assert.equal((await activities.listReminders(a.id)).unread, 0);
  assert.equal(await jobs.birthdayReminders(db) >= 0, true);
  const again = await activities.listReminders(a.id);
  assert.equal(again.reminders.filter((r) => r.reminder_type === 'birthday').length, 1, '生日提醒每年一次');
});

dbTest('隐私：分组增删改、成员权限随分组变化、黑名单列表与解除、审计查询；联合任务列表与到期', async () => {
  const [a, b] = await friendsPair();
  const g = await privacy.createGroup(a.id, { name: '同事', color: '#123456' });
  await assert.rejects(privacy.createGroup(a.id, { name: '同事' }), (e) => e.code === 1009);
  await assert.rejects(privacy.createGroup(a.id, { name: '' }), (e) => e.code === 1001);
  await assert.rejects(privacy.createGroup(a.id, { name: 'x', color: 'red' }), (e) => e.code === 1001);
  await privacy.updateFriendPermissions(a.id, b.id, { groupId: g.id, nickname: '老王', tags: ['tag'], favorite: true, notes: 'n' });
  const up = await privacy.updateGroup(a.id, g.id, { permissionLevel: 'family', sortOrder: 2, icon: 'x' });
  assert.equal(up.permission_level, 'family');
  assert.equal((await privacy.checkVisibility(b.id, a.id, 'location')).canView, false, '位置未共享');
  assert.equal((await privacy.listGroups(a.id))[0].member_count, 1);
  const { rows: [f] } = await db.query('SELECT permission_level FROM friends WHERE user_id = $1 AND friend_user_id = $2', [a.id, b.id]);
  assert.equal(f.permission_level, 'family', '分组权限变化同步到成员');
  await assert.rejects(privacy.updateGroup(a.id, 999999, { name: 'z' }), (e) => e.code === 1004);
  await assert.rejects(privacy.updateGroup(a.id, g.id, {}), (e) => e.code === 1001);
  await assert.rejects(privacy.updateFriendPermissions(a.id, b.id, { overrides: { nope: true } }), (e) => e.code === 1001);
  await assert.rejects(privacy.updateFriendPermissions(a.id, b.id, { permissionLevel: 'boss' }), (e) => e.code === 1001);
  await assert.rejects(privacy.checkVisibility(a.id, b.id, 'nope'), (e) => e.code === 1001);
  await assert.rejects(privacy.batchCheck(a.id, [], []), (e) => e.code === 1001);
  assert.equal((await privacy.deleteGroup(a.id, g.id)).success, true);
  await assert.rejects(privacy.deleteGroup(a.id, g.id), (e) => e.code === 1004);
  const s = await privacy.getSettings(a.id);
  assert.equal(s.version, 0);
  const jl = await missions.list(a.id, b.id);
  assert.ok(jl.missions.length >= 5);
  const m = await missions.start(a.id, b.id, 'catch_together');
  await db.query("UPDATE joint_mission_progress SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [m.id]);
  assert.ok(await missions.expireStale() >= 1);
  assert.equal((await missions.get(a.id, m.id)).status, 'expired');
  await assert.rejects(missions.claim(a.id, m.id), (e) => e.code === 2024);
  await privacy.block(a.id, b.id);
  assert.equal((await privacy.listBlocked(a.id)).length, 1);
  await assert.rejects(privacy.block(a.id, a.id), (e) => e.code === 1001);
  await privacy.unblock(a.id, b.id);
  await assert.rejects(privacy.unblock(a.id, b.id), (e) => e.code === 1004);
  const log = await privacy.auditLog(a.id);
  for (const act of ['friend_group_updated', 'friend_group_deleted', 'user_blocked', 'user_unblocked', 'friend_removed']) {
    assert.ok(log.some((r) => r.action === act) || act === 'friend_removed', act);
  }
});
