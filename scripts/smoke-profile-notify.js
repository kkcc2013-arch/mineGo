#!/usr/bin/env node
/**
 * Epic E05（成就/称号/资料卡/收藏室）+ E13（消息中心/推送）经网关冒烟
 *
 *   成就：升级（任意加经验路径 → trainer_level_ups 触发器）与捕捉、补给站触发成就进度与站内消息；隐藏成就不出现；
 *         成就奖励并发领取只成功一次且入账；排行榜；管理员定义管理
 *   称号：成就完成自动解锁、佩戴/取下、并发佩戴只有一个激活、经验加成作用于捕捉经验、玩家不能自行解锁
 *   资料卡：聚合统计、收藏家等级、隐私（公开/好友/私密）、徽章/精选精灵、分享链接/二维码/卡片图片、访问日志、缓存随变更失效
 *   收藏室：创建/主题/展示精灵/装饰/访问/点赞/评论/排行、成就联动
 *   消息中心：未读数、列表/分类、已读/全部已读、删除/清空已读、偏好（关闭分类后不再生成）、免打扰、好友请求消息、
 *             活动开始广播、WebSocket 实时推送与鉴权、推送渠道未配置时降级站内、多语言
 *
 * 用法：BASE_URL=http://127.0.0.1:8080 node scripts/smoke-profile-notify.js
 * 依赖 scripts/lib/smoke-helpers.js（读 .env 推导 REDIS_URL / DATABASE_URL）
 */
'use strict';

const { BASE, record, call: rawCall, newUser, makeAdmin, finish, getDb, sleep } = require('./lib/smoke-helpers');

// 网关全局限流 200 次/分钟/IP：遇到 429 退避重试（捕捉限频 6003 除外）
async function call(method, url, opts = {}) {
  for (let i = 0; ; i++) {
    const r = await rawCall(method, url, opts);
    if (r.status !== 429 || i >= 6 || (r.body && r.body.code === 6003)) return r;
    await sleep(10000);
  }
}

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 500 } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

const db = () => getDb();
const q1 = async (sql, params) => (await db().query(sql, params)).rows[0];

async function notificationsOf(user, qs = '') {
  const r = await call('GET', `/v1/notifications?limit=50${qs}`, { token: user.token });
  return (r.data && r.data.notifications) || [];
}

// ── 成就 + 升级 + 消息 + 称号 ─────────────────────────────────
async function testLevelAchievementsAndTitles() {
  const u = await newUser('ach');
  const anon = await call('GET', '/v1/achievements/my');
  record('成就：未登录访问被网关拒绝', anon.status === 401, `status=${anon.status}`);

  // 任意加经验路径（这里直接改 xp，等价于捕捉/签到/活动奖励）→ 等级触发器写 trainer_level_ups → 游戏事件 → 成就 + 消息
  await db().query('UPDATE users SET xp = xp + 45000 WHERE id = $1', [u.userId]);
  const notes = await waitFor(async () => {
    const list = await notificationsOf(u);
    const lvl = list.find((n) => n.type === 'reward.level_up');
    const ach = list.filter((n) => n.type === 'reward.achievement_unlock');
    return lvl && ach.length >= 2 ? { lvl, ach, list } : null;
  });
  record('升级：经验增长后生成"等级提升"站内消息（1→10 级）', !!(notes && notes.lvl && /10/.test(notes.lvl.body)),
    notes ? `title=${notes.lvl.title} body=${notes.lvl.body}` : 'timeout');
  record('升级：训练师等级成就自动完成并发消息（5 级、10 级）', !!notes && notes.ach.length >= 2,
    notes ? notes.ach.map((n) => n.body).join(' | ') : 'timeout');

  const my = await call('GET', '/v1/achievements/my', { token: u.token });
  const list = (my.data && my.data.achievements) || [];
  const lv5 = list.find((a) => a.achievementId === 'trainer_level_5');
  const lv10 = list.find((a) => a.achievementId === 'trainer_level_10');
  record('成就：列表返回进度与完成状态', my.status === 200 && lv5 && lv5.completed && lv5.claimable && lv10 && lv10.completed,
    `status=${my.status} total=${list.length} lv5=${lv5 && `${lv5.progress}/${lv5.target}`}`);
  record('成就：隐藏成就解锁前不出现在列表中', !list.some((a) => a.isHidden) && my.data.hiddenLocked > 0,
    `hiddenLocked=${my.data && my.data.hiddenLocked}`);
  const hiddenDetail = await call('GET', '/v1/achievements/night_owl', { token: u.token });
  record('成就：未解锁的隐藏成就详情返回 404', hiddenDetail.status === 404, `status=${hiddenDetail.status}`);
  const cat = await call('GET', '/v1/achievements/my?category=growth', { token: u.token });
  record('成就：按分类过滤', cat.status === 200 && cat.data.achievements.length > 0 && cat.data.achievements.every((a) => a.category === 'growth'),
    `count=${cat.data && cat.data.achievements.length}`);
  const en = await call('GET', '/v1/achievements/trainer_level_10?lang=en', { token: u.token });
  record('成就：多语言（英文名称）', en.status === 200 && en.data.name === 'Rising Star', `name=${en.data && en.data.name}`);

  // 并发领奖只成功一次，且精灵球只入账一次（trainer_level_5 奖励 20 个精灵球）
  const before = await q1('SELECT pokeball_count FROM users WHERE id = $1', [u.userId]);
  const claims = await Promise.all([1, 2, 3, 4, 5].map(() => call('POST', '/v1/achievements/trainer_level_5/claim', { token: u.token })));
  const ok = claims.filter((c) => c.status === 200).length;
  const after = await q1('SELECT pokeball_count FROM users WHERE id = $1', [u.userId]);
  record('成就：奖励并发领取只成功一次', ok === 1 && claims.every((c) => c.status === 200 || c.status === 409),
    `statuses=${claims.map((c) => c.status)}`);
  record('成就：奖励经 grantRewards 实际入账（精灵球 +20）', after.pokeball_count - before.pokeball_count === 20,
    `Δ=${after.pokeball_count - before.pokeball_count}`);
  const notDone = await call('POST', '/v1/achievements/catch_master_1000/claim', { token: u.token });
  record('成就：未完成的成就不能领奖', notDone.status === 400, `status=${notDone.status}`);

  const t0 = Date.now();
  const prog = await call('GET', '/v1/achievements/my/progress', { token: u.token });
  const progMs = Date.now() - t0;
  record('成就：总览（点数/完成数/分类进度/排名）', prog.status === 200 && prog.data.completed >= 2 && prog.data.totalPoints >= 70 && prog.data.rank >= 1,
    `completed=${prog.data && prog.data.completed} points=${prog.data && prog.data.totalPoints} rank=${prog.data && prog.data.rank} ${progMs}ms`);
  const lb = await call('GET', '/v1/achievements/leaderboard?limit=20', { token: u.token });
  record('成就：排行榜返回排名与本人名次', lb.status === 200 && Array.isArray(lb.data.leaderboard) && lb.data.me && lb.data.me.rank >= 1,
    `size=${lb.data && lb.data.leaderboard.length} myRank=${lb.data && lb.data.me && lb.data.me.rank}`);

  // 称号：trainer_level_10 → rising_star 自动解锁
  const titles = await call('GET', '/v1/users/me/titles', { token: u.token });
  const rising = (titles.data || []).find((t) => t.titleId === 'rising_star');
  record('称号：完成成就自动解锁称号（新星训练师）', titles.status === 200 && !!rising, `titles=${(titles.data || []).map((t) => t.titleId)}`);
  const titleNote = (await notificationsOf(u)).find((n) => n.type === 'reward.title_unlock');
  record('称号：解锁称号生成站内消息', !!titleNote, titleNote ? titleNote.body : 'none');
  const selfUnlock = await call('POST', '/v1/users/me/titles/champion/unlock', { token: u.token });
  record('称号：玩家不能自行解锁称号', selfUnlock.status === 404 || selfUnlock.status === 405, `status=${selfUnlock.status}`);
  const notOwned = await call('PUT', '/v1/users/me/titles/champion/activate', { token: u.token });
  record('称号：不能佩戴未拥有的称号', notOwned.status === 404, `status=${notOwned.status}`);
  const catalog = await call('GET', '/v1/users/titles', { token: u.token });
  record('称号：目录 ≥ 20 个且标记已拥有', catalog.status === 200 && catalog.data.length >= 20 && catalog.data.some((t) => t.titleId === 'rising_star' && t.owned),
    `count=${catalog.data && catalog.data.length}`);

  // 再给一个称号（管理员发放），测试并发佩戴只有一个激活
  const admin = await makeAdmin(await newUser('tadm'));
  const granted = await call('POST', '/v1/users/titles/grant', { token: admin.token, body: { userId: u.userId, titleId: 'early_supporter' } });
  const deny = await call('POST', '/v1/users/titles/grant', { token: u.token, body: { userId: u.userId, titleId: 'champion' } });
  record('称号：管理员发放称号（普通玩家不能发放）', granted.status === 200 && granted.data.granted && deny.status === 403,
    `admin=${granted.status} player=${deny.status}`);
  const acts = await Promise.all(['rising_star', 'early_supporter', 'rising_star', 'early_supporter'].map((t) =>
    call('PUT', `/v1/users/me/titles/${t}/activate`, { token: u.token })));
  const activeRows = await q1('SELECT COUNT(*)::int AS n FROM user_titles WHERE user_id = $1 AND is_active', [u.userId]);
  record('称号：并发佩戴后只有一个激活称号', acts.every((a) => a.status === 200) && activeRows.n === 1,
    `statuses=${acts.map((a) => a.status)} active=${activeRows.n}`);
  const wear = await call('POST', '/v1/users/me/profile/title', { token: u.token, body: { titleId: 'rising_star' } });
  const active = await call('GET', '/v1/users/me/titles/active', { token: u.token });
  record('称号：佩戴称号（资料卡展示称号接口）', wear.status === 200 && active.data && active.data.titleId === 'rising_star',
    `active=${active.data && active.data.titleId}`);
  const bonus = await call('GET', '/v1/users/me/titles/bonuses', { token: u.token });
  record('称号：激活称号的属性加成', bonus.status === 200 && Number(bonus.data.exp_bonus) === 0.02, `bonus=${JSON.stringify(bonus.data)}`);
  const lb2 = await call('GET', '/v1/achievements/leaderboard?limit=100', { token: u.token });
  const meRow = (lb2.data && lb2.data.leaderboard || []).find((r) => r.userId === u.userId);
  record('称号：排行榜展示佩戴的称号', !!(meRow && meRow.activeTitle && meRow.activeTitle.titleId === 'rising_star'),
    `row=${meRow ? JSON.stringify(meRow.activeTitle) : 'not in top100 (cache 60s)'}`);
  return { user: u, admin };
}

// ── 捕捉 / 补给站 触发成就 ────────────────────────────────────
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
    await sleep(1500);
  }
  return {};
}

async function catchOne(user) {
  const map = await nearby(user.token);
  const wild = (map.wildPokemons || []).slice().sort((a, b) =>
    ({ COMMON: 0, UNCOMMON: 1 }[a.rarity] ?? 2) - ({ COMMON: 0, UNCOMMON: 1 }[b.rarity] ?? 2));
  let first = true;
  for (const w of wild.slice(0, 4)) {
    const pos = { lat: Number(w.lat) + 0.0001 + jitter(), lng: Number(w.lng) + jitter() };
    if (!first) await sleep(8000); // 慢速移动，避免速度反作弊
    first = false;
    await call('POST', '/v1/location', { token: user.token, body: { ...pos, accuracy: 10 } });
    const sess = await call('POST', '/v1/catch/session', { token: user.token, body: { spawnId: w.id, playerLat: pos.lat, playerLng: pos.lng } });
    const sessionId = sess.data && sess.data.sessionId;
    if (!sessionId) continue;
    for (let i = 0; i < 25; i++) {
      const t = await call('POST', '/v1/catch/throw', { token: user.token, body: { sessionId, ballType: 'POKE_BALL', throwRating: 'EXCELLENT', isCurve: true } });
      if (t.status !== 200) break;
      if (t.data.result === 'CAUGHT') return t.data;
      if (t.data.result === 'FLED') break;
    }
  }
  return null;
}

async function testCatchAndPokestop(titled) {
  const u = await newUser('cat');
  const caught = await catchOne(u);
  record('捕捉：成功捕捉一只精灵', !!caught, caught ? `species=${caught.pokemon && caught.pokemon.name}` : 'no catch');
  if (caught) {
    const ach = await waitFor(async () => {
      const r = await call('GET', '/v1/achievements/first_catch', { token: u.token });
      return r.data && r.data.completed ? r.data : null;
    });
    record('捕捉：触发"初次捕捉"成就完成', !!ach, ach ? `progress=${ach.progress}/${ach.target}` : 'timeout');
    const c10 = await call('GET', '/v1/achievements/catch_master_10', { token: u.token });
    record('捕捉：累计类成就进度 +1（捕捉 10 只：1/10）', c10.data && c10.data.progress === 1 && !c10.data.completed,
      `progress=${c10.data && c10.data.progress}`);
    const msg = (await notificationsOf(u)).find((n) => n.type === 'reward.achievement_unlock' && n.data.achievementId === 'first_catch');
    record('捕捉：成就解锁生成站内消息', !!msg, msg ? msg.body : 'none');
    const title = await call('GET', '/v1/users/me/titles', { token: u.token });
    record('捕捉：成就联动解锁称号（新手训练师）', (title.data || []).some((t) => t.titleId === 'novice_trainer'),
      `titles=${(title.data || []).map((t) => t.titleId)}`);
  }

  // 称号经验加成作用于捕捉：佩戴 exp_bonus 0.02 的称号后，捕捉经验 = 基础经验 × 1.02
  if (titled) {
    const c2 = await catchOne(titled);
    if (c2) {
      const base = 200 + 10 + (c2.pokemon && c2.pokemon.isShiny ? 500 : 0);
      record('称号：激活称号的经验加成作用于捕捉（EXCELLENT+弧线球 210 × 1.02）', c2.rewards && c2.rewards.xp === Math.round(base * 1.02),
        `xp=${c2.rewards && c2.rewards.xp} expected=${Math.round(base * 1.02)}`);
    } else {
      record('称号：激活称号的经验加成作用于捕捉', false, 'no catch');
    }
  }

  // 补给站
  const s = await newUser('stp');
  const map = await nearby(s.token);
  const stop = (map.pokestops || [])[0];
  if (!stop) { record('补给站：附近有补给站', false); return u; }
  await call('POST', '/v1/location', { token: s.token, body: { lat: Number(stop.lat) + jitter(), lng: Number(stop.lng) + jitter(), accuracy: 10 } });
  const spin = await call('POST', `/v1/pokestops/${stop.id}/spin`, { token: s.token, body: {} });
  const done = await waitFor(async () => {
    const r = await call('GET', '/v1/achievements/first_pokestop', { token: s.token });
    return r.data && r.data.completed ? r.data : null;
  });
  record('补给站：转动补给站触发"第一次补给"成就', spin.status === 200 && !!done, `spin=${spin.status}`);
  const p100 = await call('GET', '/v1/achievements/pokestop_visitor_100', { token: s.token });
  record('补给站：累计成就进度 1/100', p100.data && p100.data.progress === 1, `progress=${p100.data && p100.data.progress}`);
  return u;
}

// ── 消息中心 ──────────────────────────────────────────────────
async function testMessageCenter(ctx) {
  const a = await newUser('msa');
  const b = await newUser('msb');

  // b 注册了安卓推送令牌，但服务端没有 FCM 凭据 → 离线时降级为站内消息并记录原因
  const dev = await call('POST', '/v1/notifications/device-token', { token: b.token, body: { platform: 'android', token: 'smoke-fcm-token' } });
  // 好友请求 → 接收方收到社交消息
  const fr = await call('POST', '/v1/friends/request', { token: a.token, body: { toUserId: b.userId, message: 'hi <b>there</b>' } });
  const got = await waitFor(async () => (await notificationsOf(b, '&category=social')).find((n) => n.type === 'social.friend_request'));
  record('消息：好友请求生成接收方站内消息', fr.status === 201 && !!got && got.body.includes(a.nickname), got ? got.body : `request=${fr.status}`);

  const uc = await call('GET', '/v1/notifications/unread-count', { token: b.token });
  record('消息：未读数（总数/按分类）', uc.status === 200 && uc.data.total >= 1 && uc.data.byCategory.social >= 1, `total=${uc.data && uc.data.total}`);
  const rd = await call('PATCH', `/v1/notifications/${got && got.id}/read`, { token: b.token });
  const uc2 = await call('GET', '/v1/notifications/unread-count', { token: b.token });
  record('消息：标记已读后未读数减少', rd.status === 200 && uc2.data.total === uc.data.total - 1, `before=${uc.data.total} after=${uc2.data.total}`);
  const others = await call('PATCH', `/v1/notifications/${got && got.id}/read`, { token: a.token });
  record('消息：不能操作他人的消息', others.status === 404, `status=${others.status}`);
  const badId = await call('PATCH', '/v1/notifications/not-a-uuid/read', { token: b.token });
  record('消息：非法 ID 返回 400', badId.status === 400, `status=${badId.status}`);

  // 偏好：关闭社交分类后不再生成社交消息；系统类强制
  const pf = await call('PATCH', '/v1/notifications/preferences', { token: a.token, body: {
    notificationTypes: { social: false, system: false }, quietHours: { enabled: true, start: '22:00', end: '08:00' } } });
  const pfGet = await call('GET', '/v1/notifications/preferences', { token: a.token });
  record('消息：偏好设置保存并持久化（分类开关、免打扰时段）', pf.status === 200 && pfGet.data.notificationTypes.social === false
    && pfGet.data.notificationTypes.system === true && pfGet.data.quietHours.enabled === true && pfGet.data.quietHours.start === '22:00',
  `social=${pfGet.data && pfGet.data.notificationTypes.social} system=${pfGet.data && pfGet.data.notificationTypes.system}`);
  const badPf = await call('PATCH', '/v1/notifications/preferences', { token: a.token, body: { quietHours: { enabled: true, start: '25:00' } } });
  record('消息：非法免打扰时段被拒绝', badPf.status === 400, `status=${badPf.status}`);
  const c = await newUser('msc');
  await call('POST', '/v1/friends/request', { token: c.token, body: { toUserId: a.userId } });
  await sleep(2500);
  const aSocial = (await notificationsOf(a, '&category=social')).filter((n) => n.type === 'social.friend_request');
  record('消息：关闭社交分类后好友请求不再生成消息', aSocial.length === 0, `social=${aSocial.length}`);
  record('消息：推送渠道未配置时降级为站内消息（记录原因）', pfGet.data && pfGet.data.pushProviders && pfGet.data.pushProviders.fcm === false,
    `providers=${JSON.stringify(pfGet.data && pfGet.data.pushProviders)}`);

  // 活动开始 → 全服广播（读取时物化）
  const admin = ctx.admin;
  const now = Date.now();
  const ev = await call('POST', '/v1/events', { token: admin.token, body: {
    eventKey: `smk-notify-${now}`, title: '冒烟活动开始通知', description: 'E13', eventType: 'double_xp',
    startTime: new Date(now - 60e3).toISOString(), endTime: new Date(now + 7200e3).toISOString(), rewards: [{ type: 'stardust', amount: 10 }] } });
  const evId = ev.body && ev.body.event && ev.body.event.id;
  await call('POST', `/v1/events/${evId}/resume`, { token: admin.token });
  const evNote = await waitFor(async () => (await notificationsOf(b, '&category=event')).find((n) => n.data && n.data.eventId === evId));
  record('消息：活动开始向玩家发送活动消息', !!evNote, evNote ? `${evNote.title}: ${evNote.body}` : `event=${ev.status}`);
  const evEn = await call('GET', `/v1/notifications?category=event&lang=en`, { token: b.token });
  const evEnNote = (evEn.data && evEn.data.notifications || []).find((n) => n.data && n.data.eventId === evId);
  record('消息：多语言（英文模板渲染）', !!(evEnNote && evEnNote.title === 'Event Started'), evEnNote ? evEnNote.title : 'none');

  // 系统公告（管理员广播）
  const bc = await call('POST', '/v1/notifications/admin/broadcast', { token: admin.token, body: { title: '冒烟公告', body: '维护通知', priority: 'high' } });
  const bcDeny = await call('POST', '/v1/notifications/admin/broadcast', { token: b.token, body: { title: 'x' } });
  const sys = await waitFor(async () => (await notificationsOf(b, '&category=system')).find((n) => n.title === '冒烟公告'));
  record('消息：管理员系统公告送达（普通玩家不能发）', bc.status === 201 && bcDeny.status === 403 && !!sys, `admin=${bc.status} player=${bcDeny.status}`);

  // 列表、分页、全部已读、删除、清空已读
  const page = await call('GET', '/v1/notifications?page=1&limit=2', { token: b.token });
  record('消息：分页列表', page.status === 200 && page.data.notifications.length <= 2 && page.data.pagination.total >= 3,
    `total=${page.data && page.data.pagination.total}`);
  const all = await call('POST', '/v1/notifications/batch-read', { token: b.token, body: { all: true } });
  const uc3 = await call('GET', '/v1/notifications/unread-count', { token: b.token });
  record('消息：全部已读', all.status === 200 && uc3.data.total === 0, `updated=${all.data && all.data.updatedCount} unread=${uc3.data.total}`);
  const del = await call('DELETE', `/v1/notifications/${got && got.id}`, { token: b.token });
  const afterDel = (await notificationsOf(b)).some((n) => n.id === (got && got.id));
  record('消息：删除', del.status === 200 && !afterDel, `status=${del.status}`);
  const clr = await call('POST', '/v1/notifications/clear-read', { token: b.token });
  const remain = await notificationsOf(b);
  record('消息：清空已读', clr.status === 200 && remain.length === 0, `deleted=${clr.data && clr.data.deletedCount} remain=${remain.length}`);

  // WebSocket 实时推送：鉴权 + 新消息实时到达
  const wsBase = BASE.replace(/^http/, 'ws');
  const rejected = await new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/ws/notifications?token=bad`);
    ws.onopen = () => { ws.close(); resolve(false); };
    ws.onerror = () => resolve(true);
    setTimeout(() => resolve(false), 5000);
  });
  record('实时推送：无效 token 的 WebSocket 连接被拒绝', rejected);
  const d = await newUser('wsd');
  const messages = [];
  const ws = new WebSocket(`${wsBase}/ws/notifications?token=${d.token}`);
  const opened = await new Promise((resolve) => { ws.onopen = () => resolve(true); ws.onerror = () => resolve(false); setTimeout(() => resolve(false), 5000); });
  ws.onmessage = (m) => { try { messages.push({ at: Date.now(), msg: JSON.parse(m.data) }); } catch { /* ignore */ } };
  await sleep(500);
  const t0 = Date.now();
  await call('POST', '/v1/friends/request', { token: a.token, body: { toUserId: d.userId } });
  const pushed = await waitFor(async () => messages.find((m) => m.msg.type === 'notification' && m.msg.notification.type === 'social.friend_request'), { timeoutMs: 8000, intervalMs: 100 });
  record('实时推送：WebSocket 连接成功并收到 hello', opened && messages.some((m) => m.msg.type === 'hello'), `opened=${opened}`);
  record('实时推送：新消息经 WebSocket 实时到达（< 3 秒）', !!pushed && pushed.at - t0 < 3000, pushed ? `${pushed.at - t0}ms unread=${pushed.msg.unreadCount}` : 'timeout');
  ws.close();
  const ev2 = await q1(`SELECT COUNT(*)::int AS n FROM notification_events WHERE user_id = $1 AND event_type = 'delivered' AND channel = 'ws'`, [d.userId]);
  record('实时推送：投递记录 WS 送达', ev2.n >= 1, `ws=${ev2.n}`);
  const deferred = await waitFor(() => q1(`SELECT e.metadata FROM notification_events e JOIN notifications n ON n.id = e.notification_id
      WHERE e.user_id = $1 AND e.event_type = 'deferred' AND n.type = 'social.friend_request' ORDER BY e.id DESC LIMIT 1`, [b.userId]));
  record('推送降级：有设备令牌但未配置 FCM 凭据 → 仅站内消息并记录原因', dev.status === 200 && !!deferred
    && (deferred.metadata.reasons || []).includes('push_provider_unconfigured'), `device=${dev.status} deferred=${deferred && JSON.stringify(deferred.metadata)}`);
  const analytics = await call('GET', '/v1/notifications/admin/analytics?days=1', { token: admin.token });
  record('消息：管理员送达/打开率分析', analytics.status === 200 && analytics.data.totals.sent > 0, `sent=${analytics.data && analytics.data.totals.sent} openRate=${analytics.data && analytics.data.openRate}`);
}

// ── 资料卡 / 数据统计 / 隐私 ──────────────────────────────────
async function testProfile(ctx) {
  const u = ctx.user;       // 10 级、已解锁 trainer_level_5/10 与称号 rising_star
  const v = await newUser('pv');
  const me = await call('GET', '/v1/users/me/profile', { token: u.token });
  const d = me.data || {};
  record('资料：本人资料含统计/收藏家等级/称号/图鉴/访客', me.status === 200 && d.stats && d.stats.pokemon && d.player.collector
    && d.player.collector.level >= 1 && d.player.title && d.player.title.titleId === 'rising_star' && d.pokedex && d.views,
  `status=${me.status} collector=${d.player && JSON.stringify(d.player.collector && { level: d.player.collector.level, score: d.player.collector.score })}`);

  const locked = await call('PUT', '/v1/users/me/profile', { token: u.token, body: { avatarFrameId: 'legend' } });
  record('资料卡：未解锁的头像框不能使用', locked.status === 403, `status=${locked.status}`);
  const badBadge = await call('PUT', '/v1/users/me/profile', { token: u.token, body: { selectedBadges: ['pokedex_151'] } });
  record('资料卡：只能展示已解锁的成就徽章', badBadge.status === 400, `status=${badBadge.status}`);
  const tooMany = await call('PUT', '/v1/users/me/profile', { token: u.token, body: { selectedBadges: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'] } });
  record('资料卡：徽章最多 6 个', tooMany.status === 400, `status=${tooMany.status}`);
  const pid = (await db().query(
    `INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp, is_shiny)
     VALUES ($1, 25, 888, 60, 60, 15, 15, 15, TRUE) RETURNING id`, [u.userId])).rows[0].id;
  const upd = await call('PUT', '/v1/users/me/profile', { token: u.token, body: {
    signature: '冒烟签名 v1', avatarFrameId: 'leaf', backgroundThemeId: 'sunset', visibility: 'public',
    selectedBadges: ['trainer_level_10', 'trainer_level_5'], selectedPokemon: [pid], statsLayout: { order: ['battle', 'pokemon'] } } });
  record('资料卡：自定义头像框/背景/签名/徽章/精选精灵', upd.status === 200 && upd.data.signature === '冒烟签名 v1'
    && upd.data.player.frame.id === 'leaf' && upd.data.badges.length === 2 && upd.data.badges[0].id === 'trainer_level_10'
    && upd.data.featuredPokemon.length === 1, `status=${upd.status} ${upd.status !== 200 ? JSON.stringify(upd.body).slice(0, 150) : ''}`);
  const custom = await call('GET', '/v1/users/me/profile/customization', { token: u.token });
  record('资料卡：头像框/背景主题列表含解锁状态', custom.status === 200 && custom.data.frames.some((f) => f.id === 'leaf' && f.unlocked && f.selected)
    && custom.data.frames.some((f) => f.id === 'legend' && !f.unlocked), `frames=${custom.data && custom.data.frames.length}`);
  const badges = await call('GET', '/v1/users/me/profile/badges/available', { token: u.token });
  record('资料卡：可展示徽章列表', badges.status === 200 && badges.data.some((b) => b.id === 'trainer_level_10' && b.selected), `count=${badges.data && badges.data.length}`);

  // 陌生人查看：公开资料，隐藏社交明细/位置统计/访客记录
  const t0 = Date.now();
  const pub = await call('GET', `/v1/users/${u.userId}/profile`, { token: v.token });
  const pubMs = Date.now() - t0;
  const pd = pub.data || {};
  record('隐私：非好友查看公开资料（隐藏社交明细与位置统计）', pub.status === 200 && pd.audience === 'public' && pd.stats
    && pd.stats.social && pd.stats.social.giftsSent === undefined && pd.stats.exploration.kmWalked === undefined && !pd.views && pd.badges.length === 2,
  `audience=${pd.audience} ${pubMs}ms`);
  const pub2 = await call('GET', `/v1/users/${u.userId}/profile`, { token: v.token });
  record('资料：重复查看命中缓存', pub2.data && pub2.data.cache && pub2.data.cache.hit === true, `cache=${JSON.stringify(pub2.data && pub2.data.cache)}`);
  await call('PUT', '/v1/users/me/profile', { token: u.token, body: { signature: '冒烟签名 v2' } });
  const pub3 = await call('GET', `/v1/users/${u.userId}/profile`, { token: v.token });
  record('资料：被查看者修改资料后缓存立即失效', pub3.data && pub3.data.signature === '冒烟签名 v2', `signature=${pub3.data && pub3.data.signature}`);

  await call('PUT', '/v1/users/me/profile', { token: u.token, body: { visibility: 'friends' } });
  const fr = await call('GET', `/v1/users/${u.userId}/profile`, { token: v.token });
  record('隐私：仅好友可见时陌生人只看到基本信息', fr.status === 200 && fr.data.restricted === true && !fr.data.stats, `audience=${fr.data && fr.data.audience}`);
  const req = await call('POST', '/v1/friends/request', { token: v.token, body: { toUserId: u.userId } });
  const reqId = req.body && (req.body.requestId || (req.body.data && req.body.data.requestId));
  const acc = await call('POST', `/v1/friends/request/${reqId}/accept`, { token: u.token });
  const fr2 = await call('GET', `/v1/users/${u.userId}/profile`, { token: v.token });
  record('隐私：成为好友后可见完整统计', acc.status === 200 && fr2.data && fr2.data.audience === 'full' && fr2.data.stats.social.giftsSent !== undefined,
    `accept=${acc.status} audience=${fr2.data && fr2.data.audience}`);
  await call('PUT', '/v1/users/me/profile', { token: u.token, body: { visibility: 'private' } });
  const pr = await call('GET', `/v1/users/${u.userId}/profile`, { token: v.token });
  record('隐私：私密资料好友也只看到基本信息', pr.data && pr.data.restricted === true, `audience=${pr.data && pr.data.audience}`);
  const prCard = await call('GET', `/v1/users/${u.userId}/profile/card`, { token: v.token });
  record('隐私：私密资料不能生成资料卡', prCard.status === 403, `status=${prCard.status}`);
  await call('PUT', '/v1/users/me/profile', { token: u.token, body: { visibility: 'public' } });

  const mine = await call('GET', '/v1/users/me/profile', { token: u.token });
  record('资料：访问日志记录他人查看', mine.data && mine.data.views && mine.data.views.total >= 1, `views=${JSON.stringify(mine.data && mine.data.views)}`);

  const card = await rawCall('GET', `/v1/users/${u.userId}/profile/card`, { token: v.token, raw: true });
  const svg = await card.text();
  record('资料卡：生成图片（SVG，含昵称）', card.status === 200 && /image\/svg\+xml/.test(card.headers.get('content-type') || '') && svg.includes('<svg') && svg.includes(u.nickname),
    `status=${card.status} bytes=${svg.length}`);
  const share = await call('POST', '/v1/users/me/profile/share', { token: u.token });
  const sd = share.data || {};
  record('资料卡：分享链接与二维码', share.status === 200 && /\/p\/[A-Za-z0-9]{8,}/.test(sd.shareUrl || '') && String(sd.qrCode || '').startsWith('data:image/png'),
    `url=${sd.shareUrl} qr=${sd.qrCode ? 'yes' : 'no'}`);
  const anonCard = await rawCall('GET', `/v1/profile-cards/${sd.shareCode}.svg`, { raw: true });
  record('资料卡：分享卡片无需登录即可打开（公开资料）', anonCard.status === 200 && (await anonCard.text()).includes('<svg'), `status=${anonCard.status}`);
  const shareLog = await q1(`SELECT COUNT(*)::int AS n FROM profile_view_logs WHERE profile_user_id = $1 AND view_source = 'share_link'`, [u.userId]);
  record('资料卡：分享链接访问计入访问日志', shareLog.n >= 1, `share_views=${shareLog.n}`);

  const sum = await call('GET', '/v1/users/me/stats/summary', { token: u.token });
  record('统计：统计摘要', sum.status === 200 && sum.data.stats && sum.data.collector, `status=${sum.status}`);
  const lb = await call('GET', '/v1/users/leaderboard/collectors?limit=50', { token: u.token });
  const sorted = (lb.data && lb.data.leaderboard || []).every((r, i, a) => i === 0 || a[i - 1].score >= r.score);
  record('收藏家：积分排行榜按分数排序并返回本人名次', lb.status === 200 && sorted && lb.data.me && lb.data.me.rank >= 1,
    `size=${lb.data && lb.data.leaderboard.length} me=${JSON.stringify(lb.data && lb.data.me && { rank: lb.data.me.rank, score: lb.data.me.score })}`);
  return { viewer: v, featuredPokemon: pid };
}

// ── 收藏室 ────────────────────────────────────────────────────
async function testCollectionRoom(ctx, prof) {
  const owner = await newUser('room');
  const visitor = prof.viewer;
  const mk = async (uid, shiny) => (await db().query(
    `INSERT INTO pokemon_instances (user_id, species_id, cp, hp_current, hp_max, iv_attack, iv_defense, iv_hp, is_shiny)
     VALUES ($1, $2, 500, 50, 50, 10, 11, 12, $3) RETURNING id`, [uid, shiny ? 6 : 1, shiny])).rows[0].id;
  const p1 = await mk(owner.userId, false); const p2 = await mk(owner.userId, true); const other = await mk(visitor.userId, false);

  const room = await call('GET', '/v1/collection-room', { token: owner.token });
  const rd = room.data || {};
  record('收藏室：首次访问自动创建（1 级，展示位 20）', room.status === 200 && rd.room && rd.room.level === 1 && rd.room.capacity.pokemon === 20
    && rd.isOwner && rd.unlockedThemes.includes('default') && !rd.unlockedThemes.includes('forest'), `status=${room.status}`);
  const roomId = rd.room && rd.room.id;

  const disp = await call('POST', '/v1/collection-room/pokemon', { token: owner.token, body: { pokemonId: p1, x: 0, y: 0 } });
  const dup = await call('POST', '/v1/collection-room/pokemon', { token: owner.token, body: { pokemonId: p1, x: 1, y: 0 } });
  const notMine = await call('POST', '/v1/collection-room/pokemon', { token: owner.token, body: { pokemonId: other, x: 1, y: 0 } });
  const overlap = await call('POST', '/v1/collection-room/pokemon', { token: owner.token, body: { pokemonId: p2, x: 0, y: 0 } });
  const badMode = await call('POST', '/v1/collection-room/pokemon', { token: owner.token, body: { pokemonId: p1, displayMode: 'shiny' } });
  const pedestal = await call('POST', '/v1/collection-room/pokemon', { token: owner.token, body: { pokemonId: p2, x: 1, y: 0, pedestalType: 'gold' } });
  record('收藏室：展示精灵（重复/他人精灵/位置重叠/高级展示台被拒绝）', disp.status === 201 && dup.status === 409 && notMine.status === 404
    && overlap.status === 409 && pedestal.status === 403, `display=${disp.status} dup=${dup.status} notMine=${notMine.status} overlap=${overlap.status} pedestal=${pedestal.status} mode=${badMode.status}`);
  const shinyDisp = await call('POST', '/v1/collection-room/pokemon', { token: owner.token, body: { pokemonId: p2, x: 1, y: 0, displayMode: 'shiny' } });
  record('收藏室：闪光精灵使用闪光展示模式', shinyDisp.status === 201, `status=${shinyDisp.status}`);

  const fern = await waitFor(async () => {
    const inv = await call('GET', '/v1/collection-room/decorations/inventory', { token: owner.token });
    return (inv.data || []).find((i) => i.itemCode === 'plant_potted_fern');
  });
  record('收藏室：展示第一只精灵完成成就并获得装饰奖励（蕨类盆栽）', !!fern, fern ? `available=${fern.available}` : 'timeout');
  const place = await call('POST', '/v1/collection-room/decorations', { token: owner.token, body: { itemCode: 'plant_potted_fern', x: 5, y: 5 } });
  const again = await call('POST', '/v1/collection-room/decorations', { token: owner.token, body: { itemCode: 'plant_potted_fern', x: 6, y: 6 } });
  record('收藏室：摆放装饰（库存不足时拒绝）', place.status === 201 && again.status === 400, `place=${place.status} again=${again.status}`);

  await db().query('UPDATE users SET coins = 5000 WHERE id = $1', [owner.userId]);
  const buy = await call('POST', '/v1/collection-room/decorations/chair_wood/purchase', { token: owner.token, body: { quantity: 2 } });
  const coins = await q1('SELECT coins FROM users WHERE id = $1', [owner.userId]);
  const buyLocked = await call('POST', '/v1/collection-room/decorations/chair_silver/purchase', { token: owner.token, body: { quantity: 1 } });
  record('收藏室：商店购买装饰扣金币（高等级装饰被拒绝）', buy.status === 200 && coins.coins === 4800 && buyLocked.status === 403,
    `buy=${buy.status} coins=${coins.coins} locked=${buyLocked.status}`);
  const onPlant = await call('POST', '/v1/collection-room/decorations', { token: owner.token, body: { itemCode: 'chair_wood', x: 5, y: 5 } });
  const chair = await call('POST', '/v1/collection-room/decorations', { token: owner.token, body: { itemCode: 'chair_wood', x: 6, y: 5, rotation: 90 } });
  const move = chair.data ? await call('PUT', `/v1/collection-room/decorations/${chair.data.id}`, { token: owner.token, body: { x: 7, y: 5 } }) : { status: 0 };
  record('收藏室：装饰占格冲突检测、旋转与拖拽移动', onPlant.status === 409 && chair.status === 201 && move.status === 200,
    `overlap=${onPlant.status} place=${chair.status} move=${move.status}`);
  const layout = await call('PUT', '/v1/collection-room/layout', { token: owner.token, body: { pokemon: [{ pokemonId: p1, x: 1, y: 0 }, { pokemonId: p2, x: 0, y: 0 }] } });
  record('收藏室：拖拽编辑器批量保存布局（交换两只精灵位置）', layout.status === 200, `status=${layout.status} ${layout.status !== 200 ? JSON.stringify(layout.body).slice(0, 120) : ''}`);

  const themeLocked = await call('PUT', '/v1/collection-room', { token: owner.token, body: { themeId: 'forest' } });
  const custBg = await call('PUT', '/v1/collection-room', { token: owner.token, body: { backgroundImageUrl: 'https://example.com/bg.png' } });
  const set = await call('PUT', '/v1/collection-room', { token: owner.token, body: { roomName: '冒烟展馆', themeId: 'classic', backgroundId: 'meadow' } });
  record('收藏室：设置主题/背景（未解锁主题、低等级自定义背景被拒绝）', themeLocked.status === 403 && custBg.status === 400 && set.status === 200
    && set.data.room.roomName === '冒烟展馆' && set.data.room.theme.id === 'classic', `locked=${themeLocked.status} bg=${custBg.status} set=${set.status}`);
  const themes = await call('GET', '/v1/collection-room/themes?lang=en', { token: owner.token });
  const buyTheme = await call('POST', '/v1/collection-room/themes/sakura/purchase', { token: owner.token });
  const buyTheme2 = await call('POST', '/v1/collection-room/themes/sakura/purchase', { token: owner.token });
  const useTheme = await call('PUT', '/v1/collection-room', { token: owner.token, body: { themeId: 'sakura' } });
  record('收藏室：至少 5 种主题（英文名），付费主题购买一次后可用', themes.status === 200 && themes.data.length >= 5 && themes.data.some((t) => t.name === 'Forest')
    && buyTheme.status === 200 && buyTheme2.status === 409 && useTheme.status === 200, `themes=${themes.data && themes.data.length} buy=${buyTheme.status}/${buyTheme2.status} use=${useTheme.status}`);
  const catalog = await call('GET', '/v1/collection-room/decorations/catalog?lang=ja', { token: owner.token });
  const rarities = new Set((catalog.data || []).map((i) => i.rarity));
  record('收藏室：装饰物品 ≥ 50 种、五档稀有度、三语名称', catalog.data && catalog.data.length >= 50 && rarities.size === 5
    && catalog.data.some((i) => i.itemCode === 'chair_wood' && i.name === '木のイス'), `count=${catalog.data && catalog.data.length} rarities=${[...rarities]}`);

  // 访问、点赞、留言
  const v1 = await call('GET', `/v1/collection-room/users/${owner.userId}`, { token: visitor.token });
  const v2 = await call('GET', `/v1/collection-room/${roomId}/visit`, { token: visitor.token });
  const end = await call('POST', `/v1/collection-room/${roomId}/visit/end`, { token: visitor.token, body: { durationSeconds: 42 } });
  const visitRow = await q1('SELECT visit_count, duration_seconds FROM room_visits WHERE room_id = $1 AND visitor_id = $2', [roomId, visitor.userId]);
  record('收藏室：访问他人公开收藏室，记录访客数（每人每天 1 次）、次数与时长', v1.status === 200 && v1.data.isOwner === false
    && v1.data.pokemon.length === 2 && v2.data.room.visitorCount === 1 && end.status === 200 && visitRow.visit_count === 2 && visitRow.duration_seconds === 42,
  `visitors=${v2.data && v2.data.room.visitorCount} row=${JSON.stringify(visitRow)}`);
  const likes = await Promise.all([1, 2, 3].map(() => call('POST', `/v1/collection-room/${roomId}/like`, { token: visitor.token })));
  const selfLike = await call('POST', `/v1/collection-room/${roomId}/like`, { token: owner.token });
  const lc = await q1('SELECT like_count FROM collection_rooms WHERE id = $1', [roomId]);
  record('收藏室：点赞持久化，并发重复点赞只计一次，不能给自己点赞', likes.every((l) => l.status === 200) && lc.like_count === 1 && selfLike.status === 400,
    `likes=${likes.map((l) => l.status)} count=${lc.like_count} self=${selfLike.status}`);
  const liked = await waitFor(async () => (await notificationsOf(owner, '&category=social')).find((n) => n.type === 'social.collection_liked'));
  record('收藏室：被点赞后房主收到消息', !!liked, liked ? liked.body : 'timeout');
  await call('DELETE', `/v1/collection-room/${roomId}/like`, { token: visitor.token });
  await call('POST', `/v1/collection-room/${roomId}/like`, { token: visitor.token });
  const likeExp = await q1(`SELECT COUNT(*)::int AS n FROM room_exp_log WHERE room_id = $1 AND reason = 'visitor_liked'`, [roomId]);
  const lc2 = await q1('SELECT like_count FROM collection_rooms WHERE id = $1', [roomId]);
  record('收藏室：取消后再点赞不重复发经验', likeExp.n === 1 && lc2.like_count === 1, `expRows=${likeExp.n} count=${lc2.like_count}`);
  const cm = await call('POST', `/v1/collection-room/${roomId}/comments`, { token: visitor.token, body: { content: '<b>好看！</b>' } });
  const cms = await call('GET', `/v1/collection-room/${roomId}/comments`, { token: owner.token });
  const cmNote = await waitFor(async () => (await notificationsOf(owner, '&category=social')).find((n) => n.type === 'social.collection_comment'));
  const del = cm.data ? await call('DELETE', `/v1/collection-room/${roomId}/comments/${cm.data.id}`, { token: owner.token }) : { status: 0 };
  record('收藏室：留言（内容清理）、房主收到留言消息、房主可删除留言', cm.status === 201 && cm.data.content === 'b好看！/b'
    && cms.data.comments.length === 1 && !!cmNote && del.status === 200, `comment=${cm.status} note=${!!cmNote} del=${del.status}`);

  const mineRoom = await call('GET', '/v1/collection-room', { token: owner.token });
  const exp = mineRoom.data && mineRoom.data.room.experience;
  record('收藏室：活动累积经验（展示 10×2 + 装饰 5×2 + 到访 3 + 点赞 15 + 留言 10 = 58）', exp === 58, `experience=${exp} level=${mineRoom.data && mineRoom.data.room.level}`);
  const stats = await call('GET', '/v1/collection-room/stats', { token: owner.token });
  record('收藏室：收藏统计（数量/稀有度分布/闪光/图鉴完成度）', stats.status === 200 && stats.data.displayed === 2 && stats.data.shiny === 1
    && stats.data.rarityDistribution && stats.data.pokedex, `displayed=${stats.data && stats.data.displayed}`);
  const pop = await call('GET', '/v1/collection-room/popular?sort=likes', { token: visitor.token });
  record('收藏室：热门排行', pop.status === 200 && Array.isArray(pop.data), `size=${pop.data && pop.data.length}`);

  await call('PUT', '/v1/collection-room', { token: owner.token, body: { isPublic: false } });
  const priv = await call('GET', `/v1/collection-room/${roomId}/visit`, { token: visitor.token });
  const privLike = await call('POST', `/v1/collection-room/${roomId}/like`, { token: visitor.token });
  record('收藏室：未公开的收藏室他人不能访问/点赞', priv.status === 403 && privLike.status === 403, `visit=${priv.status} like=${privLike.status}`);
  const ownerAch = await waitFor(async () => {
    const r = await call('GET', '/v1/achievements/room_first_pokemon', { token: owner.token });
    return r.data && r.data.completed ? r.data : null;
  });
  record('收藏室：收藏成就（开馆大吉）已完成', !!ownerAch);
}

async function main() {
  const ctx = await testLevelAchievementsAndTitles();
  await testCatchAndPokestop(ctx.user);
  await testMessageCenter(ctx);
  const prof = await testProfile(ctx);
  await testCollectionRoom(ctx, prof);
}

main().catch((err) => { record('冒烟脚本异常', false, err.stack); }).finally(finish);
