#!/usr/bin/env node
/**
 * Epic E05（成就/称号/资料卡/收藏室）+ E13（消息中心/推送）经网关冒烟
 *
 *   成就：升级（任意加经验路径 → trainer_level_ups 触发器）与捕捉、补给站触发成就进度与站内消息；隐藏成就不出现；
 *         成就奖励并发领取只成功一次且入账；排行榜；管理员定义管理
 *   称号：成就完成自动解锁、佩戴/取下、并发佩戴只有一个激活、经验加成作用于捕捉经验、玩家不能自行解锁
 *   资料卡：聚合统计、收藏家等级、隐私（公开/好友/私密）、徽章/精选精灵、分享链接与卡片图片、访问日志、缓存随变更失效
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
  const deferred = await q1(`SELECT metadata FROM notification_events WHERE user_id = $1 AND event_type = 'deferred' ORDER BY id DESC LIMIT 1`, [a.userId]);
  record('实时推送：投递记录（WS 送达 / 离线降级原因）', ev2.n >= 1 && !!deferred, `ws=${ev2.n} deferred=${deferred && JSON.stringify(deferred.metadata)}`);
  const analytics = await call('GET', '/v1/notifications/admin/analytics?days=1', { token: admin.token });
  record('消息：管理员送达/打开率分析', analytics.status === 200 && analytics.data.totals.sent > 0, `sent=${analytics.data && analytics.data.totals.sent} openRate=${analytics.data && analytics.data.openRate}`);
}

async function main() {
  const ctx = await testLevelAchievementsAndTitles();
  await testCatchAndPokestop(ctx.user);
  await testMessageCenter(ctx);
  if (typeof global.extraTests === 'function') await global.extraTests(ctx);
}

main().catch((err) => { record('冒烟脚本异常', false, err.stack); }).finally(finish);
