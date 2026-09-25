/**
 * REQ-00369：捕捉连击 —— 纯规则（无 I/O，单测直接 require）
 *
 * 状态（与表 catch_combos 一一对应，camelCase）：
 *   { currentCombo, maxCombo, comboStartedAt, lastCatchTime, protectionCharges, protectedUntil, pokemonIds, comboRewards }
 *
 * 规则：
 *   - 捕捉成功：距上次成功 ≤ timeoutMinutes（默认 30）则 +1，否则上一段连击按 timeout 结束、从 1 重新计数；
 *   - 捕捉失败（精灵逃跑 FLED）：连击中断（current → 0，写历史 end_reason='failed'）；
 *     若有保护次数且保护未过期，则消耗 1 次保护、连击保留；
 *   - 奖励：当前连击数命中的最高档位（threshold ≤ combo）给"每次捕捉的连击奖励"
 *       amount × min(bonusMultiplier × (1 + perComboStep × combo), maxMultiplier)；
 *     连击数恰好等于某档位阈值时额外发该档位的特殊道具（specialRewards，只在到达时发一次）；
 *   - 里程碑（默认 10/25/50/100/200/500）触发通知事件。
 * 连击奖励是额外奖励，不改变捕捉本身的 XP/星尘/糖果。
 */
'use strict';

const DEFAULT_CONFIG = Object.freeze({
  timeoutMinutes: 30,
  perComboStep: 0.1,
  maxMultiplier: 5,
  protectionMinutes: 60,
  maxProtectionCharges: 3,
  maxTrackedPokemon: 500,
  milestones: Object.freeze([10, 25, 50, 100, 200, 500]),
});

// 默认档位（迁移种子与此一致；运营可通过 PUT /catch/combo/rewards 调整）
// rewardType: experience → users.xp，coins → users.coins，premium → users.premium_coins
// specialRewards 的 item 必须是 items 表里存在的道具（精灵球走 users 计数列）
const DEFAULT_REWARD_TIERS = Object.freeze([
  { threshold: 3, rewardType: 'experience', rewardAmount: 20, bonusMultiplier: 1.0, specialRewards: [] },
  { threshold: 5, rewardType: 'experience', rewardAmount: 50, bonusMultiplier: 1.0, specialRewards: [{ item: 'POKE_BALL', amount: 5 }] },
  { threshold: 10, rewardType: 'coins', rewardAmount: 10, bonusMultiplier: 1.2, specialRewards: [{ item: 'LUCKY_EGG', amount: 1 }] },
  { threshold: 20, rewardType: 'coins', rewardAmount: 20, bonusMultiplier: 1.5, specialRewards: [{ item: 'RAZZ_BERRY', amount: 3 }] },
  { threshold: 25, rewardType: 'coins', rewardAmount: 25, bonusMultiplier: 1.5, specialRewards: [{ item: 'COMBO_SHIELD', amount: 1 }, { item: 'RARE_CANDY', amount: 1 }] },
  { threshold: 50, rewardType: 'coins', rewardAmount: 50, bonusMultiplier: 2.0, specialRewards: [{ item: 'GOLDEN_RAZZ_BERRY', amount: 3 }, { item: 'ULTRA_BALL', amount: 5 }] },
  { threshold: 100, rewardType: 'coins', rewardAmount: 100, bonusMultiplier: 3.0, specialRewards: [{ item: 'LURE_MODULE', amount: 1 }, { item: 'ULTRA_BALL', amount: 10 }] },
  { threshold: 200, rewardType: 'premium', rewardAmount: 5, bonusMultiplier: 3.5, specialRewards: [{ item: 'STAR_PIECE', amount: 2 }, { item: 'COMBO_SHIELD', amount: 2 }] },
  { threshold: 500, rewardType: 'premium', rewardAmount: 20, bonusMultiplier: 4.0, specialRewards: [{ item: 'MASTER_BALL', amount: 1 }, { item: 'STAR_PIECE', amount: 5 }] },
]);

const REWARD_TYPES = Object.freeze(['experience', 'coins', 'premium', 'items']);

function toDate(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function emptyState() {
  return {
    currentCombo: 0,
    maxCombo: 0,
    comboStartedAt: null,
    lastCatchTime: null,
    protectionCharges: 0,
    protectedUntil: null,
    pokemonIds: [],
    comboRewards: {},
  };
}

/** 把 DB 行（snake_case）或部分对象规范化为状态 */
function normalizeState(row) {
  if (!row) return emptyState();
  const s = emptyState();
  s.currentCombo = Math.max(0, Number(row.currentCombo ?? row.current_combo ?? 0) || 0);
  s.maxCombo = Math.max(s.currentCombo, Number(row.maxCombo ?? row.max_combo ?? 0) || 0);
  s.comboStartedAt = toDate(row.comboStartedAt ?? row.combo_started_at);
  s.lastCatchTime = toDate(row.lastCatchTime ?? row.last_catch_time);
  s.protectionCharges = Math.max(0, Number(row.protectionCharges ?? row.protection_charges ?? 0) || 0);
  s.protectedUntil = toDate(row.protectedUntil ?? row.protected_until);
  const ids = row.pokemonIds ?? row.pokemon_ids;
  s.pokemonIds = Array.isArray(ids) ? ids.filter(Boolean).map(String) : [];
  const rw = row.comboRewards ?? row.combo_rewards;
  s.comboRewards = rw && typeof rw === 'object' ? { ...rw } : {};
  return s;
}

function mergeConfig(cfg) {
  return { ...DEFAULT_CONFIG, ...(cfg || {}) };
}

/** 连击是否已超时（有连击且距上次成功超过 timeoutMinutes） */
function isExpired(state, now, cfg) {
  const c = mergeConfig(cfg);
  const s = normalizeState(state);
  if (!s.currentCombo || !s.lastCatchTime) return false;
  return toDate(now).getTime() - s.lastCatchTime.getTime() > c.timeoutMinutes * 60_000;
}

function isProtected(state, now) {
  const s = normalizeState(state);
  return s.protectionCharges > 0 && !!s.protectedUntil && s.protectedUntil.getTime() > toDate(now).getTime();
}

/** 对外展示的状态：已超时的连击显示为 0（数据库里会在下一次成功/查询时归档） */
function effectiveStatus(state, now, cfg) {
  const c = mergeConfig(cfg);
  const s = normalizeState(state);
  const expired = isExpired(s, now, c);
  const current = expired ? 0 : s.currentCombo;
  const expiresAt = !expired && current > 0 && s.lastCatchTime
    ? new Date(s.lastCatchTime.getTime() + c.timeoutMinutes * 60_000).toISOString() : null;
  return {
    currentCombo: current,
    maxCombo: s.maxCombo,
    lastCatchTime: s.lastCatchTime ? s.lastCatchTime.toISOString() : null,
    comboStartedAt: current > 0 && s.comboStartedAt ? s.comboStartedAt.toISOString() : null,
    expiresAt,
    expired,
    protectionCharges: isProtected(s, now) ? s.protectionCharges : 0,
    protectedUntil: isProtected(s, now) ? s.protectedUntil.toISOString() : null,
    timeoutMinutes: c.timeoutMinutes,
  };
}

/** 规范化档位（接受 DB 行或 camelCase），按阈值升序 */
function normalizeTiers(tiers) {
  const list = (tiers && tiers.length ? tiers : DEFAULT_REWARD_TIERS).map((t) => ({
    threshold: Math.floor(Number(t.threshold ?? t.combo_threshold)),
    rewardType: String(t.rewardType ?? t.reward_type ?? 'experience'),
    rewardAmount: Math.max(0, Math.floor(Number(t.rewardAmount ?? t.reward_amount ?? 0)) || 0),
    bonusMultiplier: Math.max(0, Number(t.bonusMultiplier ?? t.bonus_multiplier ?? 1) || 0),
    specialRewards: normalizeItems(t.specialRewards ?? t.special_rewards),
  })).filter((t) => Number.isInteger(t.threshold) && t.threshold > 0 && REWARD_TYPES.includes(t.rewardType));
  return list.sort((a, b) => a.threshold - b.threshold);
}

function normalizeItems(v) {
  let arr = v;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => ({ item: String(x.item || x.type || '').toUpperCase(), amount: Math.floor(Number(x.amount ?? x.qty ?? 0)) }))
    .filter((x) => /^[A-Z0-9_]{2,50}$/.test(x.item) && x.amount > 0);
}

/**
 * 计算第 combo 次连击的奖励
 * @returns {{ xp, coins, premiumCoins, items: Array<{item, amount}>, tier: number|null, multiplier: number, milestone: number|null }}
 */
function computeRewards(combo, tiers, cfg) {
  const c = mergeConfig(cfg);
  const out = { xp: 0, coins: 0, premiumCoins: 0, items: [], tier: null, multiplier: 0, milestone: null };
  const n = Math.floor(Number(combo) || 0);
  if (n <= 0) return out;
  const list = normalizeTiers(tiers);
  let tier = null;
  for (const t of list) if (t.threshold <= n) tier = t;
  if (tier) {
    const mult = Math.min(tier.bonusMultiplier * (1 + c.perComboStep * n), c.maxMultiplier);
    const amount = Math.floor(tier.rewardAmount * mult);
    out.tier = tier.threshold;
    out.multiplier = Math.round(mult * 100) / 100;
    if (tier.rewardType === 'experience') out.xp = amount;
    else if (tier.rewardType === 'coins') out.coins = amount;
    else if (tier.rewardType === 'premium') out.premiumCoins = amount;
    // 到达档位（恰好等于阈值）时发一次特殊道具；items 型档位每次都发
    if (tier.threshold === n || tier.rewardType === 'items') out.items = tier.specialRewards.map((x) => ({ ...x }));
  }
  if (c.milestones.includes(n)) out.milestone = n;
  return out;
}

function addRewards(acc, r) {
  const a = { xp: 0, coins: 0, premiumCoins: 0, items: {}, ...(acc || {}) };
  a.xp += r.xp || 0;
  a.coins += r.coins || 0;
  a.premiumCoins += r.premiumCoins || 0;
  a.items = { ...(a.items || {}) };
  for (const it of r.items || []) a.items[it.item] = (a.items[it.item] || 0) + it.amount;
  return a;
}

/**
 * 捕捉成功
 * @param {object} state 当前状态
 * @param {{ now: Date|string, pokemonId?: string }} ev
 * @returns {{ state, combo, previousCombo, restarted, archived: null|{comboCount, startedAt, endedAt, pokemonIds, totalRewards, endReason}, isNewRecord, rewards }}
 */
function applyCatchSuccess(state, ev, tiers, cfg) {
  const c = mergeConfig(cfg);
  const now = toDate(ev && ev.now) || new Date();
  const s = normalizeState(state);
  let archived = null;
  const previousCombo = s.currentCombo;
  let restarted = false;

  if (s.currentCombo > 0 && isExpired(s, now, c)) {
    archived = {
      comboCount: s.currentCombo,
      startedAt: s.comboStartedAt || s.lastCatchTime,
      endedAt: new Date(s.lastCatchTime.getTime() + c.timeoutMinutes * 60_000),
      pokemonIds: s.pokemonIds.slice(),
      totalRewards: s.comboRewards,
      endReason: 'timeout',
    };
    s.currentCombo = 0;
    s.pokemonIds = [];
    s.comboRewards = {};
    restarted = true;
  }

  if (s.currentCombo === 0) { s.comboStartedAt = now; restarted = true; }
  s.currentCombo += 1;
  const isNewRecord = s.currentCombo > s.maxCombo;
  s.maxCombo = Math.max(s.maxCombo, s.currentCombo);
  s.lastCatchTime = now;
  if (ev && ev.pokemonId) {
    s.pokemonIds.push(String(ev.pokemonId));
    if (s.pokemonIds.length > c.maxTrackedPokemon) s.pokemonIds = s.pokemonIds.slice(-c.maxTrackedPokemon);
  }
  const rewards = computeRewards(s.currentCombo, tiers, c);
  s.comboRewards = addRewards(s.comboRewards, rewards);
  return { state: s, combo: s.currentCombo, previousCombo, restarted, archived, isNewRecord, rewards };
}

/**
 * 捕捉失败 / 手动重置
 * @param {{ now, reason: 'failed'|'manual_reset'|'timeout', force?: boolean }} ev  force=true 时忽略保护（手动重置）
 * @returns {{ state, broken, protectedUsed, previousCombo, archived }}
 */
function applyCatchFailure(state, ev, cfg) {
  const c = mergeConfig(cfg);
  const now = toDate(ev && ev.now) || new Date();
  const reason = (ev && ev.reason) || 'failed';
  const s = normalizeState(state);
  const previousCombo = s.currentCombo;
  if (s.currentCombo === 0) return { state: s, broken: false, protectedUsed: false, previousCombo: 0, archived: null };

  // 已超时的连击按 timeout 归档，不消耗保护
  const expired = isExpired(s, now, c);
  if (!expired && !(ev && ev.force) && isProtected(s, now)) {
    s.protectionCharges -= 1;
    if (s.protectionCharges <= 0) { s.protectionCharges = 0; s.protectedUntil = null; }
    return { state: s, broken: false, protectedUsed: true, previousCombo, archived: null };
  }
  const archived = {
    comboCount: s.currentCombo,
    startedAt: s.comboStartedAt || s.lastCatchTime || now,
    endedAt: expired ? new Date(s.lastCatchTime.getTime() + c.timeoutMinutes * 60_000) : now,
    pokemonIds: s.pokemonIds.slice(),
    totalRewards: s.comboRewards,
    endReason: expired ? 'timeout' : reason,
  };
  s.currentCombo = 0;
  s.comboStartedAt = null;
  s.pokemonIds = [];
  s.comboRewards = {};
  return { state: s, broken: true, protectedUsed: false, previousCombo, archived };
}

/** 使用保护道具：+1 次保护，保护期从现在（或尚未过期的保护期末）起延长 protectionMinutes */
function applyProtection(state, ev, cfg) {
  const c = mergeConfig(cfg);
  const now = toDate(ev && ev.now) || new Date();
  const s = normalizeState(state);
  if (isProtected(s, now) && s.protectionCharges >= c.maxProtectionCharges) {
    return { state: s, applied: false, reason: 'max_charges' };
  }
  const base = isProtected(s, now) ? s.protectedUntil.getTime() : now.getTime();
  s.protectionCharges = (isProtected(s, now) ? s.protectionCharges : 0) + 1;
  s.protectedUntil = new Date(base + c.protectionMinutes * 60_000);
  return { state: s, applied: true };
}

/** 状态 → DB 列（供 UPSERT） */
function toRow(state) {
  const s = normalizeState(state);
  return {
    current_combo: s.currentCombo,
    max_combo: s.maxCombo,
    combo_started_at: s.comboStartedAt,
    last_catch_time: s.lastCatchTime,
    protection_charges: s.protectionCharges,
    protected_until: s.protectedUntil,
    pokemon_ids: s.pokemonIds,
    combo_rewards: s.comboRewards,
  };
}

/** 校验运营提交的档位配置，返回 { ok, errors, tiers } */
function validateTierInput(input) {
  const errors = [];
  if (!Array.isArray(input) || input.length === 0) return { ok: false, errors: ['tiers 必须是非空数组'], tiers: [] };
  const seen = new Set();
  input.forEach((t, i) => {
    const th = Math.floor(Number(t && (t.threshold ?? t.combo_threshold)));
    if (!Number.isInteger(th) || th < 1 || th > 100000) errors.push(`#${i} threshold 必须是 1~100000 的整数`);
    else if (seen.has(th)) errors.push(`#${i} threshold ${th} 重复`);
    seen.add(th);
    const type = t && (t.rewardType ?? t.reward_type);
    if (!REWARD_TYPES.includes(type)) errors.push(`#${i} rewardType 必须是 ${REWARD_TYPES.join('/')}`);
    const amt = Number(t && (t.rewardAmount ?? t.reward_amount ?? 0));
    if (!Number.isFinite(amt) || amt < 0 || amt > 1_000_000) errors.push(`#${i} rewardAmount 超出范围`);
    const mul = Number(t && (t.bonusMultiplier ?? t.bonus_multiplier ?? 1));
    if (!Number.isFinite(mul) || mul < 0 || mul > 10) errors.push(`#${i} bonusMultiplier 必须在 0~10`);
  });
  return { ok: errors.length === 0, errors, tiers: errors.length ? [] : normalizeTiers(input) };
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_REWARD_TIERS,
  REWARD_TYPES,
  emptyState,
  normalizeState,
  normalizeTiers,
  normalizeItems,
  isExpired,
  isProtected,
  effectiveStatus,
  computeRewards,
  addRewards,
  applyCatchSuccess,
  applyCatchFailure,
  applyProtection,
  toRow,
  validateTierInput,
};
