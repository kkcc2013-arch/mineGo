/**
 * 成就规则（纯函数，无 I/O）——REQ-00076 / REQ-00106 / REQ-00261
 *
 * 游戏事件（achievement_events.event_type，由业务表触发器写入）→ 成就指标（achievements.trigger_conditions.type）：
 *   inc：进度累加（捕捉次数、补给站次数…）
 *   set：进度取事件携带的绝对值（训练师等级）
 *   abs：进度取数据库里的绝对值（图鉴种类数、好友数、收藏室展示数…），由引擎查询
 * 进度只升不降，达到 target 即完成；filters 是对事件数据的等值匹配（如 {"battle_type": "pvp"}）。
 */
'use strict';

const inc = (metric, data = {}, value = 1) => ({ metric, mode: 'inc', value, data });
const set = (metric, value, data = {}) => ({ metric, mode: 'set', value: Number(value) || 0, data });
const abs = (metric, data = {}) => ({ metric, mode: 'abs', value: null, data });

/** 事件类型 → 指标列表 */
const EVENT_METRICS = {
  catch: (d) => [
    inc('catch_count', d),
    d.is_shiny && inc('shiny_catch', d),
    abs('catch_species', d),
  ],
  pokestop_spin: (d) => [inc('pokestop_visit', d)],
  level_up: (d) => [set('trainer_level', d.toLevel, d)],
  friend_added: (d) => [abs('friend_count', d)],
  gift_sent: (d) => [inc('gift_sent', d)],
  trade_completed: (d) => [inc('trade_count', d), d.is_lucky && inc('lucky_catch', d)],
  gym_battle: (d) => {
    const win = String(d.result || '').toUpperCase() === 'WIN';
    return [
      inc('gym_battle', d),
      win && inc('battle_win', { ...d, battle_type: 'gym' }),
      win && inc('gym_conquer', d),
    ];
  },
  pvp_win: (d) => [inc('battle_win', { ...d, battle_type: 'pvp' })],
  raid_join: (d) => [inc('raid_participate', d)],
  pokemon_bred: (d) => [inc('pokemon_breed', d)],
  egg_hatched: (d) => [inc('egg_hatch', d), d.is_perfect_iv && inc('perfect_iv_breed', d)],
  event_joined: (d) => [inc('event_join', d)],
  event_completed: (d) => [inc('event_complete', d)],
  room_pokemon_changed: (d) => [abs('room_pokemon', d), abs('room_shiny', d)],
  room_decorated: (d) => [abs('room_decorations', d)],
  room_liked: (d) => [abs('room_likes', d)],
  achievement_unlocked: (d) => [abs('achievements_unlocked', d)],
  distance_updated: (d) => [abs('distance_traveled', d)],
};

/** 引擎认识的全部指标（管理端新建成就时校验 trigger_conditions.type） */
const KNOWN_METRICS = Object.freeze([
  'catch_count', 'shiny_catch', 'catch_species', 'pokestop_visit', 'trainer_level', 'friend_count', 'gift_sent',
  'trade_count', 'lucky_catch', 'gym_battle', 'battle_win', 'gym_conquer', 'raid_participate', 'pokemon_breed',
  'egg_hatch', 'perfect_iv_breed', 'event_join', 'event_complete', 'room_pokemon', 'room_shiny', 'room_decorations',
  'room_likes', 'achievements_unlocked', 'distance_traveled',
]);

function deriveMetrics(eventType, data) {
  const fn = EVENT_METRICS[eventType];
  if (!fn) return [];
  return fn(data || {}).filter(Boolean);
}

/**
 * filters 等值匹配：每个键都要满足；值为数组时表示"属于其一"；{min, max} 表示区间
 */
function matchFilters(filters, data) {
  if (!filters || typeof filters !== 'object') return true;
  const d = data || {};
  for (const [key, expected] of Object.entries(filters)) {
    const actual = d[key];
    if (Array.isArray(expected)) {
      if (!expected.map(String).includes(String(actual))) return false;
    } else if (expected && typeof expected === 'object') {
      const n = Number(actual);
      if (!Number.isFinite(n)) return false;
      if (expected.min !== undefined && n < Number(expected.min)) return false;
      if (expected.max !== undefined && n > Number(expected.max)) return false;
    } else if (typeof expected === 'boolean') {
      if (Boolean(actual) !== expected) return false;
    } else if (String(actual) !== String(expected)) {
      return false;
    }
  }
  return true;
}

function targetOf(def) {
  const t = Number(def && def.trigger_conditions && def.trigger_conditions.target);
  return Number.isFinite(t) && t > 0 ? Math.floor(t) : 1;
}

/**
 * 计算新进度（只升不降，封顶 target）
 * @returns {{progress: number, completed: boolean}}
 */
function nextProgress(current, target, metric) {
  const cur = Math.max(0, Number(current) || 0);
  const v = Math.max(0, Math.floor(Number(metric.value) || 0));
  const raw = metric.mode === 'inc' ? cur + v : Math.max(cur, v);
  const progress = Math.min(target, raw);
  return { progress, completed: raw >= target };
}

// ── 多语言 ────────────────────────────────────────────────────
const LANGS = ['zh-CN', 'en-US', 'ja-JP'];
function normalizeLang(lang) {
  const l = String(lang || '').toLowerCase();
  if (l.startsWith('en')) return 'en-US';
  if (l.startsWith('ja')) return 'ja-JP';
  return 'zh-CN';
}
/** {"zh": "...", "en": "...", "ja": "..."} → 指定语言文本（缺失时回退中文/英文） */
function localize(obj, lang) {
  if (obj == null) return '';
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return obj; }
  }
  if (typeof obj !== 'object') return String(obj);
  const short = normalizeLang(lang).slice(0, 2);
  return obj[short] || obj[normalizeLang(lang)] || obj.zh || obj['zh-CN'] || obj.en || obj['en-US'] || Object.values(obj)[0] || '';
}

// ── 奖励 ──────────────────────────────────────────────────────
// 成就奖励 { coins, stardust, xp, pokeballs…, items: [{item_id, count}], title, decoration }
//   资源类（货币/经验/精灵球列）→ rewardGrant.grantRewards；道具 → shared/inventory.addItems；
//   称号/装饰在完成时自动解锁，不在领取时发放。
const ITEM_ALIASES = {
  pokeball: 'POKE_BALL', poke_ball: 'POKE_BALL', greatball: 'GREAT_BALL', great_ball: 'GREAT_BALL',
  ultraball: 'ULTRA_BALL', ultra_ball: 'ULTRA_BALL', masterball: 'MASTER_BALL', master_ball: 'MASTER_BALL',
  rare_candy: 'RARE_CANDY', lucky_egg: 'LUCKY_EGG', razz_berry: 'RAZZ_BERRY', star_piece: 'STAR_PIECE', incense: 'INCENSE',
};
const COSMETIC_KEYS = new Set(['title', 'decoration', 'items', 'badge', 'frame', 'theme']);

function splitRewards(rewards) {
  const r = rewards && typeof rewards === 'object' ? rewards : {};
  const currencies = {};
  for (const [k, v] of Object.entries(r)) {
    if (COSMETIC_KEYS.has(k)) continue;
    if (typeof v === 'number' && v > 0) currencies[k] = v;
  }
  const items = [];
  for (const it of Array.isArray(r.items) ? r.items : []) {
    if (!it) continue;
    const raw = String(it.item_id || it.type || '').trim();
    const qty = Math.floor(Number(it.count ?? it.qty ?? it.quantity ?? 1));
    if (!raw || !(qty > 0)) continue;
    items.push({ type: ITEM_ALIASES[raw.toLowerCase()] || raw.toUpperCase(), qty });
  }
  return { currencies, items, title: r.title || null, decoration: r.decoration || null };
}

function hasClaimableRewards(rewards) {
  const { currencies, items } = splitRewards(rewards);
  return Object.keys(currencies).length > 0 || items.length > 0;
}

// ── 事件 → 站内消息 ───────────────────────────────────────────
/**
 * 事件本身需要通知玩家的（升级、好友请求、礼物、交易、收藏室被点赞）
 * @param {string} type
 * @param {object} d  事件数据
 * @param {Map<string,string>} names  userId → 昵称
 */
function eventNotification(type, d, names = new Map(), eventId = null) {
  const nick = (id) => (id && names.get(String(id))) || '训练师';
  switch (type) {
    case 'level_up':
      return {
        type: 'reward.level_up', templateKey: 'level_up', category: 'reward', priority: 'high',
        params: { new_level: d.toLevel, old_level: d.fromLevel },
        data: { fromLevel: d.fromLevel, toLevel: d.toLevel, rewards: d.rewards || {} },
        actionUrl: '/rewards/level-ups', dedupeKey: `lvl:${d.levelUpId ?? `${d.fromLevel}-${d.toLevel}`}`,
      };
    case 'friend_request_received':
      return {
        type: 'social.friend_request', templateKey: 'friend_request', category: 'social', priority: 'high',
        params: { sender_name: nick(d.fromUserId) },
        data: { requestId: d.requestId, fromUserId: d.fromUserId, message: d.message || '' },
        actionUrl: '/friends/requests', dedupeKey: `freq:${d.requestId}`,
      };
    case 'gift_received':
      return {
        type: 'social.gift_received', templateKey: 'gift_received', category: 'social', priority: 'normal',
        params: { sender_name: nick(d.fromUserId), gift_name: d.giftName || '礼物' },
        data: { giftId: d.giftId, fromUserId: d.fromUserId },
        actionUrl: '/friends/gifts', dedupeKey: `gift:${d.giftId}`,
      };
    case 'trade_completed':
      return {
        type: 'social.trade_complete', templateKey: 'trade_completed', category: 'social', priority: 'normal',
        params: { partner_name: nick(d.partnerId), pokemon_name: '精灵' },
        data: { tradeId: d.tradeId, partnerId: d.partnerId },
        actionUrl: '/trades', dedupeKey: `trade:${d.tradeId}`,
      };
    case 'room_liked':
      if (!d.likerId) return null;
      return {
        type: 'social.collection_liked', templateKey: 'collection_liked', category: 'social', priority: 'low',
        params: { liker_name: nick(d.likerId) },
        data: { roomId: d.roomId, likerId: d.likerId },
        actionUrl: '/collection-room', dedupeKey: `like:${d.roomId}:${d.likerId}`,
      };
    default:
      return null;
  }
}

function achievementNotification(def, lang = 'zh-CN') {
  const claimable = hasClaimableRewards(def.rewards);
  return {
    type: 'reward.achievement_unlock', templateKey: 'achievement_unlock', category: 'reward', priority: 'high',
    params: { achievement_name: localize(def.name, lang) },
    data: { achievementId: def.achievement_id, rarity: def.rarity, points: def.points, claimable, rewards: def.rewards || {} },
    actionUrl: `/achievements/${def.achievement_id}`, dedupeKey: `ach:${def.achievement_id}`,
  };
}

function titleNotification(title, lang = 'zh-CN') {
  return {
    type: 'reward.title_unlock', templateKey: 'title_unlocked', category: 'reward', priority: 'normal',
    params: { title_name: localize(title.name, lang) },
    data: { titleId: title.title_id, rarity: title.rarity },
    actionUrl: '/titles', dedupeKey: `title:${title.title_id}`,
  };
}

/** 事件数据里引用到的其他玩家（用于批量查询昵称） */
function referencedUserIds(events) {
  const ids = new Set();
  for (const e of events) {
    const d = e.event_data || {};
    for (const k of ['fromUserId', 'partnerId', 'likerId', 'friendId']) if (d[k]) ids.add(String(d[k]));
  }
  return [...ids];
}

module.exports = {
  EVENT_METRICS, KNOWN_METRICS, deriveMetrics, matchFilters, targetOf, nextProgress,
  LANGS, normalizeLang, localize, splitRewards, hasClaimableRewards, ITEM_ALIASES,
  eventNotification, achievementNotification, titleNotification, referencedUserIds,
};
