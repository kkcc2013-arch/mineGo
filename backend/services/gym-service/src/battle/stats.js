// 由数据库行构造战斗单位（combatant）
//
// pokemon_instances 没有等级字段，只有 CP 与个体值。按 GO 公式由 CP 反推 CP 倍率（CPM）：
//   CP = A * sqrt(D) * sqrt(S) * CPM^2 / 10，A/D/S = 种族值 + 个体值
//   => 攻击 = A*CPM，防御 = D*CPM，战斗 HP = floor(S*CPM)
// （catch-service 写入的 hp_max = CP*0.8 与 GO 不一致，战斗 HP 一律按上式计算；
//   道馆驻守精灵的 hp_current/hp_max 作为「士气比例」缩放开场 HP。）
'use strict';

const CPM_MIN = 0.094;
const CPM_MAX = 0.8653;

const norm = (t) => (t ? String(t).toLowerCase() : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 规范化 moves 表行 */
function normalizeMove(row) {
  if (!row) return null;
  const category = String(row.category || '').toUpperCase() === 'CHARGE' ? 'CHARGE' : 'FAST';
  const delta = Number(row.energy_delta) || 0;
  const cooldownTurns = Number(row.cooldown_turns) || 0;
  return {
    id: row.id,
    name: row.name_zh || row.name_en || row.id,
    type: norm(row.type) || 'normal',
    category,
    power: Number(row.power) || 0,
    energyGain: category === 'FAST' ? Math.max(0, delta, Number(row.energy_recover) || 0) : 0,
    energyCost: category === 'CHARGE' ? Math.max(Number(row.energy_cost) || 0, -delta, 0) : 0,
    durationMs: Number(row.duration_ms) || (category === 'FAST' ? 1000 : 2500),
    cooldownMs: cooldownTurns > 0 ? cooldownTurns * 1000 : (Number(row.cooldown_ms) || 0),
    accuracy: row.accuracy_pct === null || row.accuracy_pct === undefined ? 100 : Number(row.accuracy_pct),
    critPct: Number(row.crit_chance_pct) || 0,
    effectType: row.effect_type ? String(row.effect_type).toUpperCase() : null,
    effectChance: Number(row.effect_chance_pct) || 0,
  };
}

const STRUGGLE = {
  id: 'STRUGGLE', name: '挣扎', type: 'normal', category: 'FAST', power: 5, energyGain: 5, energyCost: 0,
  durationMs: 1000, cooldownMs: 0, accuracy: 100, critPct: 0, effectType: null, effectChance: 0,
};

function deriveCpm(cp, A, D, S) {
  const denom = A * Math.sqrt(D) * Math.sqrt(S);
  if (!(denom > 0) || !(cp > 0)) return 0.5;
  return clamp(Math.sqrt((10 * cp) / denom), CPM_MIN, CPM_MAX);
}

/**
 * 选择精灵的技能组：已学快速技能 1 个 + 蓄力技能最多 2 个；缺失时按学习表补默认
 * @param {object} row          pokemon_instances + species 列
 * @param {Map} moveMap         id -> 规范化技能
 * @param {Array} learnset      [{move_id, learn_method}]（可选）
 */
function pickMoves(row, moveMap, learnset = []) {
  const byCat = (cat) => (id) => { const m = moveMap.get(id); return m && m.category === cat ? m : null; };
  const fastOf = byCat('FAST');
  const chargeOf = byCat('CHARGE');
  let fast = fastOf(row.fast_move);
  if (!fast) {
    const cand = learnset.filter((l) => fastOf(l.move_id)).sort((a, b) => (a.learn_method === 'LEVEL_UP' ? -1 : 0) - (b.learn_method === 'LEVEL_UP' ? -1 : 0));
    fast = cand.length ? fastOf(cand[0].move_id) : (moveMap.get('TACKLE') || STRUGGLE);
  }
  const chargeIds = [];
  for (const id of [row.charge_move, ...(row.learned_charge_moves || [])]) {
    if (id && chargeOf(id) && !chargeIds.includes(id)) chargeIds.push(id);
  }
  if (!chargeIds.length) {
    const cand = learnset.filter((l) => chargeOf(l.move_id));
    const lvl = cand.find((l) => l.learn_method === 'LEVEL_UP') || cand[0];
    if (lvl) chargeIds.push(lvl.move_id);
  }
  return [fast, ...chargeIds.slice(0, 2).map(chargeOf)];
}

/**
 * @param {object} row  pokemon_instances 行 + species 列（type1,type2,base_attack,base_defense,base_hp,name_zh,base_speed）
 * @param {Map} moveMap
 * @param {object} [opts] { learnset, hpRatio, mastery: {moveId: n}, equipment: [...] , ownerId }
 */
function buildCombatant(row, moveMap, opts = {}) {
  const ivA = Number(row.iv_attack) || 0;
  const ivD = Number(row.iv_defense) || 0;
  const ivS = Number(row.iv_hp) || 0;
  const A = (Number(row.base_attack) || 100) + ivA;
  const D = (Number(row.base_defense) || 100) + ivD;
  const S = (Number(row.base_hp) || 100) + ivS;
  const cp = Number(row.cp) || 10;
  const cpm = opts.cpm || deriveCpm(cp, A, D, S);
  const maxHp = Math.max(10, Math.floor(S * cpm));
  const hpRatio = opts.hpRatio === undefined ? 1 : clamp(Number(opts.hpRatio) || 0, 0.05, 1);
  const ivSum = ivA + ivD + ivS;
  const types = [norm(row.type1), norm(row.type2)].filter(Boolean);
  const moves = pickMoves(row, moveMap, opts.learnset || []);
  return {
    pokemonId: row.id,
    ownerId: opts.ownerId || row.user_id || null,
    speciesId: Number(row.species_id) || null,
    name: row.nickname || row.name_zh || `#${row.species_id}`,
    types: types.length ? types : ['normal'],
    cp,
    cpm: Number(cpm.toFixed(4)),
    attack: Number((A * cpm).toFixed(2)),
    defense: Number((D * cpm).toFixed(2)),
    maxHp,
    hp: Math.max(1, Math.round(maxHp * hpRatio)),
    speed: Number(row.speed) || Number(row.base_speed) || 0,
    ivSum,
    maxEnergy: 100 + Math.round((ivSum / 45) * 20),
    energy: 0,
    moves,
    readyTurn: {},
    readyAt: {},
    status: null,
    mastery: opts.mastery || {},
    equipment: opts.equipment || [],
    gymDefenderId: opts.gymDefenderId || null,
    damageDealt: 0,
    damageTaken: 0,
    knockouts: 0,
  };
}

/** Raid Boss：满个体值 + 按等级的 CPM，HP 取 GO 团战固定血量表 */
const RAID_LEVELS = {
  1: { hp: 600, cpm: 0.61, minutes: 45, xp: 3000, stardust: 1500 },
  2: { hp: 1800, cpm: 0.67, minutes: 45, xp: 3500, stardust: 2000 },
  3: { hp: 3600, cpm: 0.73, minutes: 45, xp: 4000, stardust: 3000 },
  4: { hp: 9000, cpm: 0.79, minutes: 45, xp: 5000, stardust: 4000 },
  5: { hp: 15000, cpm: 0.79, minutes: 45, xp: 10000, stardust: 5000 },
};

function buildRaidBoss(speciesRow, level, moveMap, learnset = []) {
  const lv = RAID_LEVELS[level] || RAID_LEVELS[1];
  const A = (Number(speciesRow.base_attack) || 100) + 15;
  const D = (Number(speciesRow.base_defense) || 100) + 15;
  const S = (Number(speciesRow.base_hp) || 100) + 15;
  const cp = Math.floor((A * Math.sqrt(D) * Math.sqrt(S) * lv.cpm * lv.cpm) / 10);
  const c = buildCombatant({ ...speciesRow, id: `boss-${speciesRow.id}`, species_id: speciesRow.id, cp,
    iv_attack: 15, iv_defense: 15, iv_hp: 15 }, moveMap, { learnset, cpm: lv.cpm });
  c.maxHp = lv.hp;
  c.hp = lv.hp;
  return c;
}

module.exports = { normalizeMove, buildCombatant, buildRaidBoss, deriveCpm, pickMoves, RAID_LEVELS, STRUGGLE, CPM_MIN, CPM_MAX };
