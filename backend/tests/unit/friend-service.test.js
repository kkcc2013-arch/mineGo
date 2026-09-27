// tests/unit/friend-service.test.js
// E01 好友与社交互动：直接测试真实模块的纯逻辑（不需要数据库）
//   shared/social/{privacyRules, friendshipLevels, intimacyCalculator, visibilityEngine}
//   social-service friendService / recommendationService / jointMissionService 的纯函数
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.FRIEND_JOBS_DISABLED = 'true';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'unit-access-secret';

const rules = require('../../shared/social/privacyRules');
const levels = require('../../shared/social/friendshipLevels');
const {
  IntimacyCalculator, FRIENDSHIP_REWARDS, INTERACTION_TYPES, activeBoost, pairBonuses, haversineKm, MAX_SCORE,
} = require('../../shared/social/intimacyCalculator');
const engine = require('../../shared/social/visibilityEngine');
const friendService = require('../../services/social-service/src/friendService');
const { scoreCandidate } = require('../../services/social-service/src/social/recommendationService');
const { evaluateProgress } = require('../../services/social-service/src/social/jointMissionService');

const friendRel = (lvl = 'regular', extra = {}) => ({ isOwner: false, isFriend: true, blocked: false, permissionLevel: lvl, groupId: null, overrides: {}, friendshipLevel: 1, ...extra });
const stranger = { isOwner: false, isFriend: false, blocked: false, overrides: {} };
const owner = { isOwner: true };

// ── 隐私规则（REQ-00228） ─────────────────────────────────────
test('privacyRules: 默认设置与各可见性级别', () => {
  const s = rules.withDefaults(null);
  assert.equal(s.online_status_visibility, 'friends');
  assert.equal(rules.canView(s, 'profile', stranger), true, 'profile 默认公开');
  assert.equal(rules.canView(s, 'online_status', stranger), false);
  assert.equal(rules.canView(s, 'online_status', friendRel()), true);
  assert.equal(rules.canView(s, 'pokemon_shinies', friendRel('regular')), false, 'close_friends 级别普通好友不可见');
  assert.equal(rules.canView(s, 'pokemon_shinies', friendRel('close_friends')), true);
  assert.equal(rules.canView(s, 'pokemon_shinies', friendRel('family')), true, '家人包含密友权限');
  const fam = rules.withDefaults({ achievements_visibility: 'family' });
  assert.equal(rules.canView(fam, 'achievements', friendRel('close_friends')), false);
  assert.equal(rules.canView(fam, 'achievements', friendRel('family')), true);
  const priv = rules.withDefaults({ profile_visibility: 'private' });
  assert.equal(rules.canView(priv, 'profile', friendRel('family')), false);
  assert.equal(rules.canView(priv, 'profile', owner), true, '自己总能看到');
});

test('privacyRules: 拉黑、权限覆盖、自定义分组、位置共享开关', () => {
  const s = rules.withDefaults({ profile_visibility: 'public' });
  assert.equal(rules.canView(s, 'profile', { ...stranger, blocked: true }), false, '拉黑后公开数据也不可见');
  assert.equal(rules.canView(rules.withDefaults(null), 'online_status', friendRel('regular', { overrides: { online_status: false } })), false);
  assert.equal(rules.canView(rules.withDefaults(null), 'pokemon_shinies', friendRel('regular', { overrides: { pokemon_shinies: true } })), true);
  const custom = rules.withDefaults({ battle_history_visibility: 'custom', custom_groups: { battle_history: [7] } });
  assert.equal(rules.canView(custom, 'battle_history', friendRel('regular', { groupId: 7 })), true);
  assert.equal(rules.canView(custom, 'battle_history', friendRel('regular', { groupId: 8 })), false);
  assert.equal(rules.canView(custom, 'battle_history', stranger), false);
  const loc = rules.withDefaults({ location_visibility: 'public' });
  assert.equal(rules.canView(loc, 'location', stranger), false, '未开启位置共享时任何人不可见');
  assert.equal(rules.canView({ ...loc, allow_location_sharing: true }, 'location', stranger), true);
  assert.throws(() => rules.canView(s, 'nope', stranger));
  assert.equal(rules.canView(s, 'profile', null), false);
});

test('privacyRules: 设置补丁校验', () => {
  assert.deepEqual(rules.sanitizeSettingsPatch({ profile_visibility: 'friends', allow_gifts: false }).errors, []);
  assert.ok(rules.sanitizeSettingsPatch({ profile_visibility: 'everyone' }).errors.length);
  assert.ok(rules.sanitizeSettingsPatch({ allow_gifts: 'no' }).errors.length);
  assert.ok(rules.sanitizeSettingsPatch({ unknown: 1 }).errors.length);
  assert.ok(rules.sanitizeSettingsPatch({}).errors.length);
  assert.ok(rules.sanitizeSettingsPatch(null).errors.length);
  assert.ok(rules.sanitizeSettingsPatch({ custom_groups: { location: ['x'] } }).errors.length);
  assert.ok(rules.sanitizeSettingsPatch({ custom_groups: { nope: [1] } }).errors.length);
  assert.ok(rules.sanitizeSettingsPatch({ custom_groups: [] }).errors.length);
  const ok = rules.sanitizeSettingsPatch({ custom_groups: { location: [1, 1, 2] } });
  assert.deepEqual(ok.value.custom_groups.location, [1, 2]);
  const map = rules.visibilityMap(rules.withDefaults(null), friendRel(), ['profile', 'location']);
  assert.deepEqual(map, { profile: true, location: false });
});

test('privacyRules: 在线/离开/离线', () => {
  const now = Date.now();
  assert.equal(rules.onlineStatus(null), 'offline');
  assert.equal(rules.onlineStatus('garbage'), 'offline');
  assert.equal(rules.onlineStatus(new Date(now - 60e3), { now }), 'online');
  assert.equal(rules.onlineStatus(new Date(now - 30 * 60e3), { now }), 'away');
  assert.equal(rules.onlineStatus(new Date(now - 2 * 3600e3).toISOString(), { now }), 'offline');
});

// ── 友情等级（REQ-00048 / REQ-00388） ─────────────────────────
test('friendshipLevels: 友情等级 1-5 与亲密度 1-10 边界', () => {
  const f = levels.friendshipLevelFor;
  assert.deepEqual([0, 99, 100, 499, 500, 999, 1000, 1999, 2000, 99999].map(f), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  const i = levels.intimacyLevelFor;
  assert.deepEqual([0, 100, 299, 300, 600, 1000, 1500, 2200, 3000, 4000, 4999, 5000, 1e6].map(i), [1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 9, 10, 10]);
  assert.equal(f(-5), 1);
  assert.equal(f('abc'), 1);
});

test('friendshipLevels: 升级检测与进度', () => {
  assert.deepEqual(levels.detectLevelUps(95, 105), { friendship: { from: 1, to: 2 }, intimacy: { from: 1, to: 2 } });
  assert.deepEqual(levels.detectLevelUps(290, 310), { friendship: null, intimacy: { from: 2, to: 3 } });
  assert.deepEqual(levels.detectLevelUps(10, 20), { friendship: null, intimacy: null });
  const p = levels.friendshipProgress(105);
  assert.equal(p.level, 2);
  assert.equal(p.pointsToNext, 395);
  assert.equal(levels.friendshipProgress(3000).nextLevelPoints, null);
  assert.equal(levels.intimacyProgress(5000).progress, 1);
  assert.ok(levels.DAILY_ONCE_INTERACTIONS.includes('visit_profile'));
  assert.equal(levels.INTERACTION_POINTS.trade, 100);
});

// ── 精灵亲密度（REQ-00326） ───────────────────────────────────
test('IntimacyCalculator: 基础值 × 等级倍率 × 加成', () => {
  const c = new IntimacyCalculator();
  assert.equal(c.calculateGain('visit', 1), 10);
  assert.equal(c.calculateGain('adventure', 1), 50);
  assert.equal(c.calculateGain('photo', 5), 7);
  assert.equal(c.calculateGain('visit', 10), 40);
  assert.equal(c.calculateGain('gift', 1, { sameSpecies: true }), 30);
  assert.equal(c.calculateGain('gift', 1, { compatibleType: true }), 24);
  assert.equal(c.calculateGain('gift', 1, { crossRegion: true }), 26);
  assert.equal(c.calculateGain('training', 3, { boost: 1.1 }), 39);
  assert.equal(c.calculateGain('visit', 1, { eventActive: true }), 20);
  assert.throws(() => c.calculateGain('dance', 1));
  assert.equal(c.isValidType('photo'), true);
  assert.equal(Object.keys(INTERACTION_TYPES).length, 5);
});

test('IntimacyCalculator: 等级、跨级升级、上限与冷却', () => {
  const c = new IntimacyCalculator();
  assert.equal(c.levelForScore(0), 1);
  assert.equal(c.levelForScore(100), 2);
  assert.equal(c.levelForScore(5500), 10);
  assert.equal(c.canLevelUp(99, 1), false);
  assert.equal(c.canLevelUp(100, 1), true);
  assert.equal(c.canLevelUp(99999, 10), false);
  const r = c.applyGain(590, 3, 420);
  assert.equal(r.level, 5);
  assert.deepEqual(r.levelsGained, [4, 5]);
  assert.equal(c.applyGain(9990, 10, 500).score, MAX_SCORE);
  const now = Date.now();
  assert.equal(c.cooldownRemaining('visit', null), 0);
  assert.ok(c.cooldownRemaining('visit', new Date(now - 60e3), now) > 3500);
  assert.equal(c.cooldownRemaining('visit', new Date(now - 3601e3), now), 0);
  assert.equal(c.cooldownSeconds('adventure'), 604800);
  assert.equal(c.cooldownSeconds('nope'), 0);
});

test('精灵好友：等级奖励表与加成', () => {
  for (let l = 1; l <= 10; l++) assert.ok(FRIENDSHIP_REWARDS[l], `等级 ${l} 有奖励`);
  assert.equal(FRIENDSHIP_REWARDS[10].feature, 'soul_bond');
  assert.equal(activeBoost(1), 1);
  assert.equal(activeBoost(3), 1.1);
  assert.equal(activeBoost(9), 1.3);
  const d = haversineKm(31.23, 121.47, 39.9, 116.4);
  assert.ok(d > 1000 && d < 1100, `上海-北京 ${d}km`);
  assert.equal(haversineKm(null, 1, 2, 3), null);
  const b = pairBonuses({ species_id: 1, type1: 'GRASS', type2: 'POISON', caught_lat: 31.23, caught_lng: 121.47 },
    { species_id: 1, type1: 'GRASS', caught_lat: 39.9, caught_lng: 116.4 });
  assert.deepEqual([b.sameSpecies, b.compatibleType, b.crossRegion], [true, true, true]);
  const b2 = pairBonuses({ species_id: 4, type1: 'FIRE' }, { species_id: 7, type1: 'WATER' });
  assert.deepEqual([b2.sameSpecies, b2.compatibleType, b2.crossRegion], [false, false, false]);
});

// ── 精灵可见性（REQ-00377） ───────────────────────────────────
const pokemon = {
  id: '11111111-1111-1111-1111-111111111111', user_id: 'owner', species_id: 25, nickname: 'Sparky', cp: 900,
  iv_attack: 15, iv_defense: 15, iv_hp: 15, power_up_count: 4, fast_move: 'THUNDER_SHOCK', charge_move: 'THUNDERBOLT',
  learned_fast_moves: ['QUICK_ATTACK'], learned_charge_moves: [], is_shiny: true, sprite_url: 's.png', sprite_shiny_url: 'ss.png',
};

test('visibilityEngine: 访问层级', () => {
  const p = (o) => ({ ...engine.DEFAULT_POKEMON_PRIVACY, ...o });
  assert.equal(engine.accessTier(p({}), owner), 'owner');
  assert.equal(engine.accessTier(p({ overall_visibility: 'public' }), { ...stranger, blocked: true }), 'none');
  assert.equal(engine.accessTier(p({ overall_visibility: 'hidden' }), friendRel()), 'none');
  assert.equal(engine.accessTier(p({ overall_visibility: 'private' }), friendRel()), 'basic');
  assert.equal(engine.accessTier(p({ overall_visibility: 'public' }), stranger), 'detailed');
  assert.equal(engine.accessTier(p({ overall_visibility: 'friends' }), stranger), 'basic');
  assert.equal(engine.accessTier(p({ friend_level_threshold: 3 }), friendRel('regular', { friendshipLevel: 2 })), 'basic');
  assert.equal(engine.accessTier(p({ friend_level_threshold: 3 }), friendRel('regular', { friendshipLevel: 3 })), 'detailed');
  assert.equal(engine.accessTier(p({}), null), 'none');
});

test('visibilityEngine: 属性开关、用户级数值/闪光可见性、主人全量', () => {
  const priv = { ...engine.DEFAULT_POKEMON_PRIVACY };
  const friendView = engine.applyVisibility(pokemon, priv, friendRel());
  assert.equal(friendView.cp, 900);
  assert.equal(friendView.level, 3);
  assert.equal(friendView.iv, null, 'IV 默认不对好友展示');
  assert.equal(friendView.moves, null);
  assert.ok(friendView.nature);
  assert.ok(friendView.restricted.includes('iv'));
  const noStats = engine.applyVisibility(pokemon, priv, friendRel(), { statsVisible: false, shiniesVisible: false });
  assert.equal(noStats.cp, null);
  assert.equal(noStats.appearance.is_shiny, null);
  assert.equal(noStats.appearance.sprite_url, 's.png', '不暴露闪光外观');
  const basic = engine.applyVisibility(pokemon, priv, stranger);
  assert.equal(basic.visibility, 'basic');
  assert.equal(basic.cp, null);
  assert.equal(basic.nickname, 'Sparky');
  const full = engine.applyVisibility(pokemon, { ...priv, show_iv: false }, owner);
  assert.equal(full.visibility, 'owner');
  assert.equal(full.iv.percent, 100);
  assert.deepEqual(full.moves, { fast: 'THUNDER_SHOCK', charge: 'THUNDERBOLT' });
  assert.equal(engine.applyVisibility(pokemon, { ...priv, overall_visibility: 'hidden' }, friendRel()), null);
  const pub = engine.applyVisibility(pokemon, { ...priv, overall_visibility: 'public', show_iv: true, show_skills: true, show_cp: false }, stranger);
  assert.equal(pub.cp, null);
  assert.equal(pub.iv.attack, 15);
  assert.deepEqual(pub.skills.fast, ['QUICK_ATTACK']);
  assert.equal(engine.natureOf(pokemon), engine.natureOf({ ...pokemon }), '性格稳定');
  assert.equal(engine.ivOf({}), null);
});

test('visibilityEngine: 战斗匿名视图与配置优先级', () => {
  const anon = engine.battleView(pokemon, { ...engine.DEFAULT_POKEMON_PRIVACY, battle_anonymous: true }, stranger);
  assert.equal(anon.anonymous, true);
  assert.equal(anon.cp, null);
  assert.equal(anon.nickname, null);
  assert.equal(anon.species_id, 25);
  const normal = engine.battleView(pokemon, engine.DEFAULT_POKEMON_PRIVACY, stranger);
  assert.equal(normal.cp, 900);
  assert.equal(engine.battleView(pokemon, { battle_anonymous: true }, owner).cp, 900, '主人不匿名');
  const d = { default_pokemon_visibility: 'private', default_show_cp: false, default_battle_anonymous: true };
  assert.equal(engine.resolvePrivacy(null, null).source, 'system_default');
  const fromDefault = engine.resolvePrivacy(null, d);
  assert.equal(fromDefault.overall_visibility, 'private');
  assert.equal(fromDefault.show_cp, false);
  assert.equal(fromDefault.source, 'user_default');
  const own = engine.resolvePrivacy({ overall_visibility: 'public', show_cp: null }, d);
  assert.equal(own.overall_visibility, 'public');
  assert.equal(own.show_cp, false, '精灵行为空的字段回落到默认');
  assert.equal(own.source, 'pokemon');
});

test('visibilityEngine: 精灵隐私补丁校验', () => {
  assert.deepEqual(engine.sanitizePokemonPrivacy({ overall_visibility: 'hidden', show_iv: true, friend_level_threshold: 5 }).errors, []);
  assert.ok(engine.sanitizePokemonPrivacy({ overall_visibility: 'secret' }).errors.length);
  assert.ok(engine.sanitizePokemonPrivacy({ friend_level_threshold: 6 }).errors.length);
  assert.ok(engine.sanitizePokemonPrivacy({ show_cp: 'yes' }).errors.length);
  assert.ok(engine.sanitizePokemonPrivacy({ foo: true }).errors.length);
  assert.ok(engine.sanitizePokemonPrivacy({}).errors.length);
  assert.ok(engine.sanitizePokemonPrivacy(null).errors.length);
});

// ── 好友服务纯函数 ───────────────────────────────────────────
test('friendService: 好友码规范化与格式化', () => {
  const { normalizeFriendCode, formatFriendCode } = friendService;
  assert.equal(normalizeFriendCode('1234 5678 9012'), '123456789012');
  assert.equal(normalizeFriendCode('1234-5678-9012'), '123456789012');
  assert.equal(normalizeFriendCode('12345'), null);
  assert.equal(normalizeFriendCode('abcd5678efgh'), null);
  assert.equal(normalizeFriendCode(null), null);
  assert.equal(formatFriendCode('123456789012'), '1234 5678 9012');
  assert.equal(formatFriendCode(null), null);
});

test('friendService: 礼物包内容随友情等级变化', () => {
  const always = () => 0.01; // 所有概率事件命中
  const never = () => 0.99;
  const low = friendService.generateStandardGift(1, never);
  assert.deepEqual(low, [{ type: 'POKE_BALL', qty: 4 }]);
  const high = friendService.generateStandardGift(5, always);
  const types = high.map((i) => i.type);
  for (const t of ['POKE_BALL', 'STARDUST', 'RAZZ_BERRY', 'GREAT_BALL', 'ULTRA_BALL', 'EGG_7KM']) assert.ok(types.includes(t), t);
  assert.equal(high.find((i) => i.type === 'STARDUST').qty, 300, '星尘合并');
  assert.ok(!friendService.generateStandardGift(2, always).some((i) => i.type === 'GREAT_BALL'), '3 级以下没有超级球');
  assert.deepEqual(friendService.mergeItems([{ type: 'A', qty: 1 }, { type: 'A', qty: 2 }]), [{ type: 'A', qty: 3 }]);
  assert.equal(friendService.DEFAULT_CONFIG.max_friends, 400);
  assert.equal(friendService.DEFAULT_CONFIG.max_pending_requests, 50);
  assert.equal(friendService.DEFAULT_CONFIG.max_daily_gifts, 50);
  assert.equal(friendService.DEFAULT_CONFIG.request_expire_days, 7);
  assert.equal(friendService.DEFAULT_CONFIG.gift_expire_days, 30);
});

test('friendService: 参数校验在访问数据库前失败', async () => {
  const fs = new friendService.FriendService({ db: { query: () => { throw new Error('不应访问数据库'); } } });
  await assert.rejects(fs.sendFriendRequest('u1', 'not-a-uuid'), (e) => e.code === 1001);
  const id = '22222222-2222-2222-2222-222222222222';
  await assert.rejects(fs.sendFriendRequest(id, id), (e) => e.code === 2012);
  await assert.rejects(fs.searchUsers(id, 'a'), (e) => e.code === 1001);
  await assert.rejects(fs.claimGift(id, 'bad'), (e) => e.code === 2010);
  await assert.rejects(fs.acceptFriendRequest(id, 'x'), (e) => e.code === 2005);
  await assert.rejects(fs.findUserByFriendCode('12'), (e) => e.code === 2011);
});

test('friendService: 配置从 friend_system_config 读取并缓存，缺失时用默认值', async () => {
  let calls = 0;
  const fs = new friendService.FriendService({ db: { query: async () => { calls++; return { rows: [{ key: 'max_friends', value: 300 }, { key: 'unknown', value: 1 }] }; } } });
  const cfg = await fs.getConfig();
  assert.equal(cfg.max_friends, 300);
  assert.equal(cfg.max_daily_gifts, 50);
  await fs.getConfig();
  assert.equal(calls, 1, '60 秒内使用缓存');
  const broken = new friendService.FriendService({ db: { query: async () => { throw new Error('down'); } } });
  assert.equal((await broken.getConfig()).max_friends, 400);
});

test('friendService: 排行榜类型校验与 Redis 缓存命中', async () => {
  const store = new Map([['friend_lb_v:u', '3'], ['friend_lb:u:3:friendship:10', JSON.stringify({ type: 'friendship', entries: [{ rank: 1 }] })]]);
  const redis = { get: async (k) => store.get(k) || null, setex: async () => {}, incr: async (k) => store.set(k, String(Number(store.get(k) || 0) + 1)) };
  const fs = new friendService.FriendService({ db: { query: () => { throw new Error('不应访问数据库'); } }, redisFactory: () => redis });
  await assert.rejects(fs.getFriendLeaderboard('u', 'nope'), (e) => e.code === 1001);
  const r = await fs.getFriendLeaderboard('u', 'friendship', 10);
  assert.equal(r.cached, true);
  await fs.bumpLeaderboardVersion(['u']);
  assert.equal(store.get('friend_lb_v:u'), '4', '好友关系/友情点变化后版本号递增，旧缓存失效');
});

// ── 推荐与联合任务 ───────────────────────────────────────────
test('recommendation: 四维打分与推荐理由', () => {
  const me = { level: 20, lat: 31.23, lng: 121.47, types: ['FIRE', 'WATER'] };
  const near = scoreCandidate(me, { level: 21, lat: 31.231, lng: 121.471, types: ['FIRE'], mutual: 3, activeDaysAgo: 0.5 });
  assert.ok(near.reasons.includes('location_nearby'));
  assert.ok(near.reasons.includes('mutual_friends'));
  assert.ok(near.reasons.includes('similar_level'));
  assert.ok(near.reasons.includes('similar_pokemon_types'));
  const far = scoreCandidate(me, { level: 40, lat: null, lng: null, types: [], mutual: 0, activeDaysAgo: 5 });
  assert.equal(far.score, 0);
  assert.ok(near.score > far.score);
  assert.equal(far.distanceKm, null);
  const recent = scoreCandidate(me, { level: 40, types: [], mutual: 0, activeDaysAgo: 0.1 });
  assert.deepEqual(recent.reasons, ['active_recently']);
});

test('jointMission: 进度计算', () => {
  assert.deepEqual(evaluateProgress({ type: 'gift_exchange', each: 1 }, { giftsUser1: 3, giftsUser2: 0 }),
    { current: 1, target: 2, user1: 3, user2: 0, done: false });
  assert.equal(evaluateProgress({ type: 'gift_exchange', each: 1 }, { giftsUser1: 1, giftsUser2: 1 }).done, true);
  assert.deepEqual(evaluateProgress({ type: 'catch', count: 10 }, { catchUser1: 7, catchUser2: 5 }),
    { current: 10, target: 10, user1: 7, user2: 5, done: true });
  assert.equal(evaluateProgress({ type: 'catch_type', count: 5 }, { catchUser1: 1, catchUser2: 1 }).done, false);
  assert.equal(evaluateProgress({ type: 'unknown' }, {}).done, false);
});

// ── WebSocket 推送（/ws/friends） ─────────────────────────────
test('ws: 鉴权（无效/吊销/错误路径被拒）、连接即 connected、订阅频道推送给目标用户、PING/PONG', async () => {
  const http = require('http');
  const { EventEmitter } = require('events');
  const WebSocket = require('ws');
  const { signAccess } = require('../../shared/auth');
  const { initSocialWs } = require('../../services/social-service/src/social/ws');
  const { CHANNEL } = require('../../shared/social/socialEvents');

  const sub = new EventEmitter();
  sub.subscribe = async () => 1;
  sub.disconnect = () => {};
  const touched = [];
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const hub = initSocialWs(server, {
    friends: { touchPresence: async (u) => { touched.push(u); return { updated: true }; } },
    db: { query: async () => ({ rows: [{ n: 3 }] }) },
    redisFactory: () => ({ duplicate: () => sub }),
    isBlacklisted: async (jti) => jti === 'revoked',
    heartbeatMs: 60000,
  });
  const base = `ws://127.0.0.1:${server.address().port}`;
  const rejected = (url) => new Promise((resolve) => {
    const w = new WebSocket(url);
    w.on('unexpected-response', (_q, res) => resolve(res.statusCode));
    w.on('error', () => resolve('error'));
  });
  assert.equal(await rejected(`${base}/ws/friends?token=bad`), 401);
  assert.equal(await rejected(`${base}/ws/friends?token=${signAccess({ sub: 'u1', jti: 'revoked' })}`), 401);
  assert.equal(await rejected(`${base}/ws/other`), 404);

  const w = new WebSocket(`${base}/ws/friends?token=${signAccess({ sub: 'u1', jti: 'ok' })}`);
  const msgs = [];
  const next = (type) => new Promise((resolve) => {
    const hit = msgs.find((m) => m.type === type);
    if (hit) return resolve(hit);
    w.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === type) resolve(m); });
  });
  w.on('message', (d) => msgs.push(JSON.parse(String(d))));
  const connected = await next('connected');
  assert.equal(connected.payload.unreadReminders, 3);
  assert.ok(touched.includes('u1'), '连接即刷新在线状态');
  assert.equal(hub.isConnected('u1'), true);
  assert.equal(hub.connectionCount(), 1);
  sub.emit('message', CHANNEL, JSON.stringify({ userIds: ['someone-else'], type: 'x', payload: {} }));
  sub.emit('message', CHANNEL, JSON.stringify({ userIds: ['u1', 'u2'], type: 'gift_received', payload: { giftId: 'g1' } }));
  sub.emit('message', CHANNEL, 'not-json');
  const gift = await next('gift_received');
  assert.equal(gift.payload.giftId, 'g1');
  assert.ok(!msgs.some((m) => m.type === 'x'), '只推送给目标用户');
  w.send(JSON.stringify({ type: 'PING' }));
  w.send('garbage');
  assert.ok(await next('PONG'));
  w.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hub.isConnected('u1'), false);
  hub.close();
  await new Promise((r) => server.close(r));
});

test('socialEvents: 发布到 Redis 频道；写提醒去重后推送', async () => {
  const events = require('../../shared/social/socialEvents');
  const published = [];
  events._setRedisFactory(() => ({ publish: async (ch, msg) => { published.push([ch, JSON.parse(msg)]); return 1; } }));
  assert.equal(await events.publish([], 'noop'), 0);
  await events.publish(['a', 'a', 'b'], 'friend_online', { friendId: 'c' });
  assert.equal(published[0][0], events.CHANNEL);
  assert.deepEqual(published[0][1].userIds, ['a', 'b']);
  let inserted = 0;
  const q = { query: async () => (inserted++ === 0 ? { rows: [{ id: 1, reminder_type: 'birthday' }] } : { rows: [] }) };
  assert.equal((await events.createReminder(q, { userId: 'a', type: 'birthday', dedupeKey: 'k' })).id, 1);
  assert.equal(await events.createReminder(q, { userId: 'a', type: 'birthday', dedupeKey: 'k' }), null, '重复提醒不写入');
  assert.equal(published.filter((p) => p[1].type === 'reminder').length, 1);
  assert.equal(await events.createReminder({ query: async () => { throw new Error('db down'); } }, { userId: 'a', type: 'x' }), null);
  events._setRedisFactory(() => ({ publish: async () => { throw new Error('redis down'); } }));
  assert.equal(await events.publish(['a'], 't'), 0, 'Redis 故障不影响业务');
});
