// 战斗数据访问：技能表、连击链、能量规则、精灵/道馆/驻守数据、玩家位置
'use strict';

const { query } = require('../../../../shared/db');
const { getJSON } = require('../../../../shared/redis');
const { normalizeMove, buildCombatant } = require('./stats');
const { ComboDetector } = require('./combo');
const { normalizeRule, DEFAULT_RULE } = require('./energy');
const { BattleError } = require('./engine');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

const cache = { moves: null, movesAt: 0, chains: null, chainsAt: 0, rules: new Map(), rulesAt: 0 };
const MOVES_TTL = 5 * 60 * 1000;
const CHAINS_TTL = 60 * 1000;

async function getMoves() {
  if (cache.moves && Date.now() - cache.movesAt < MOVES_TTL) return cache.moves;
  const { rows } = await query('SELECT * FROM moves');
  cache.moves = new Map(rows.map((r) => [r.id, normalizeMove(r)]));
  cache.movesAt = Date.now();
  return cache.moves;
}

async function getComboDetector() {
  if (cache.chains && Date.now() - cache.chainsAt < CHAINS_TTL) return cache.chains;
  const { rows } = await query('SELECT * FROM combo_chains WHERE is_active = TRUE ORDER BY id');
  if (cache.chains) cache.chains.setChains(rows);
  else cache.chains = new ComboDetector(rows);
  cache.chainsAt = Date.now();
  return cache.chains;
}

async function getEnergyRule(name = 'standard') {
  if (Date.now() - cache.rulesAt > MOVES_TTL) { cache.rules.clear(); cache.rulesAt = Date.now(); }
  if (cache.rules.has(name)) return cache.rules.get(name);
  let rule = DEFAULT_RULE;
  try {
    const { rows: [r] } = await query('SELECT * FROM energy_regen_rules WHERE rule_name = $1 AND is_active = TRUE', [name]);
    if (r) rule = normalizeRule(r);
  } catch { /* 表缺失时使用默认规则 */ }
  cache.rules.set(name, rule);
  return rule;
}

function invalidateStaticCache() {
  cache.moves = null;
  cache.chainsAt = 0;
  cache.rules.clear();
}

const POKEMON_COLUMNS = `
  pi.id, pi.user_id, pi.species_id, pi.nickname, pi.cp, pi.hp_current, pi.hp_max,
  pi.iv_attack, pi.iv_defense, pi.iv_hp, pi.fast_move, pi.charge_move, pi.learned_charge_moves,
  pi.speed, pi.defending_gym_id,
  ps.name_zh, ps.type1::text AS type1, ps.type2::text AS type2,
  ps.base_attack, ps.base_defense, ps.base_hp, ps.base_speed`;

const ACTIVE_POKEMON = `COALESCE(pi.is_released, FALSE) = FALSE AND COALESCE(pi.is_deleted, FALSE) = FALSE AND pi.deleted_at IS NULL`;

async function getLearnsets(speciesIds) {
  const ids = [...new Set(speciesIds.filter(Boolean).map(Number))];
  if (!ids.length) return new Map();
  const { rows } = await query('SELECT species_id, move_id, learn_method FROM pokemon_moves WHERE species_id = ANY($1::int[])', [ids]);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.species_id)) map.set(r.species_id, []);
    map.get(r.species_id).push(r);
  }
  return map;
}

async function getMasteryAndEquipment(pokemonIds) {
  const mastery = new Map();
  const equipment = new Map();
  if (!pokemonIds.length) return { mastery, equipment };
  const [m, e] = await Promise.all([
    query('SELECT pokemon_id, move_id, mastery FROM pokemon_move_mastery WHERE pokemon_id = ANY($1::uuid[])', [pokemonIds]),
    query(`SELECT uce.pokemon_id, c.id, c.name_zh, c.equip_type, c.reduction_pct, c.applies_to, c.move_type
             FROM user_cooldown_equipment uce JOIN cooldown_equipment_catalog c ON c.id = uce.equipment_id
            WHERE uce.pokemon_id = ANY($1::uuid[])`, [pokemonIds]),
  ]);
  for (const r of m.rows) {
    if (!mastery.has(r.pokemon_id)) mastery.set(r.pokemon_id, {});
    mastery.get(r.pokemon_id)[r.move_id] = Number(r.mastery);
  }
  for (const r of e.rows) {
    if (!equipment.has(r.pokemon_id)) equipment.set(r.pokemon_id, []);
    equipment.get(r.pokemon_id).push({ id: r.id, name: r.name_zh, equip_type: r.equip_type, reduction_pct: Number(r.reduction_pct), applies_to: r.applies_to, move_type: r.move_type });
  }
  return { mastery, equipment };
}

/**
 * 读取玩家自己的精灵（校验归属、未放生），保持请求顺序
 */
async function getOwnedPokemon(userId, pokemonIds) {
  const { rows } = await query(`SELECT ${POKEMON_COLUMNS}
      FROM pokemon_instances pi JOIN pokemon_species ps ON ps.id = pi.species_id
     WHERE pi.id = ANY($1::uuid[]) AND pi.user_id = $2 AND ${ACTIVE_POKEMON}`, [pokemonIds, userId]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return pokemonIds.map((id) => byId.get(id)).filter(Boolean);
}

/** 玩家 CP 最高的若干只可出战精灵（未驻守道馆） */
async function getTopPokemon(userId, limit = 6) {
  const { rows } = await query(`SELECT ${POKEMON_COLUMNS}
      FROM pokemon_instances pi JOIN pokemon_species ps ON ps.id = pi.species_id
     WHERE pi.user_id = $1 AND ${ACTIVE_POKEMON} AND pi.defending_gym_id IS NULL
     ORDER BY pi.cp DESC LIMIT $2`, [userId, limit]);
  return rows;
}

/** 把精灵行转为战斗单位（补学习表默认技能、熟练度、装备） */
async function toCombatants(rows, { withProgress = true, hpRatios = new Map(), extra = new Map() } = {}) {
  const moves = await getMoves();
  const learnsets = await getLearnsets(rows.map((r) => r.species_id));
  const { mastery, equipment } = withProgress ? await getMasteryAndEquipment(rows.map((r) => r.id)) : { mastery: new Map(), equipment: new Map() };
  return rows.map((r) => buildCombatant(r, moves, {
    learnset: learnsets.get(Number(r.species_id)) || [],
    mastery: mastery.get(r.id) || {},
    equipment: equipment.get(r.id) || [],
    hpRatio: hpRatios.get(r.id),
    ...(extra.get(r.id) || {}),
  }));
}

async function getUser(userId) {
  const { rows: [u] } = await query('SELECT id, nickname, team::text AS team, level, xp FROM users WHERE id = $1', [userId]);
  if (!u) throw new BattleError('USER_NOT_FOUND', '用户不存在', 404);
  return u;
}

async function getGym(gymId) {
  if (!isUuid(gymId)) throw new BattleError('INVALID_ID', '道馆 ID 无效', 400);
  const { rows: [g] } = await query('SELECT id, name, lat, lng, controlling_team::text AS controlling_team, prestige, is_active FROM gyms WHERE id = $1', [gymId]);
  if (!g) throw new BattleError('GYM_NOT_FOUND', '道馆不存在', 404);
  return g;
}

async function getGymDefenders(gymId) {
  const { rows } = await query(`SELECT gd.id AS gym_defender_id, gd.user_id AS defender_user_id, gd.hp_current AS gd_hp_current,
           gd.hp_max AS gd_hp_max, gd.assigned_at, ${POKEMON_COLUMNS}
      FROM gym_defenders gd
      JOIN pokemon_instances pi ON pi.id = gd.pokemon_id
      JOIN pokemon_species ps ON ps.id = pi.species_id
     WHERE gd.gym_id = $1
     ORDER BY gd.assigned_at, gd.id`, [gymId]);
  return rows;
}

/**
 * 战斗天气（REQ-00311 天气影响冷却 / REQ-00146 天气加成伤害）：取道馆坐标的实时游戏天气
 * （shared/weatherService，Redis 缓存 15 分钟，未配置 API Key 时按坐标生成稳定的回退天气）。
 * BATTLE_WEATHER 环境变量可强制指定（活动/测试）；查询失败或超过 1.5 秒按无天气处理，不阻塞开战。
 */
async function weatherAt(lat, lng) {
  if (process.env.BATTLE_WEATHER) return String(process.env.BATTLE_WEATHER).toLowerCase();
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  try {
    const { getWeather } = require('../../../../shared/weatherService');
    const w = await Promise.race([getWeather(la, ln), new Promise((resolve) => setTimeout(() => resolve(null), 1500))]);
    return w && w.weather ? String(w.weather).toLowerCase() : null;
  } catch {
    return null;
  }
}

/** 玩家各连击链的累计完成次数（连击熟练度：每次 +1%，上限 +20%） */
async function getComboMastery(userId) {
  const { rows } = await query('SELECT chain_id, times_executed FROM user_combo_stats WHERE user_id::text = $1::text', [userId]);
  return Object.fromEntries(rows.map((r) => [r.chain_id, Number(r.times_executed) || 0]));
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 以 location-service 写入的服务端位置为准校验距离（与补给站/捕捉一致） */
async function assertNear(userId, lat, lng, radiusM, what) {
  const pos = await getJSON(`player:pos:${userId}`);
  if (!pos) throw new BattleError('LOCATION_REQUIRED', '请先上报当前位置', 400);
  const d = haversineM(Number(pos.lat), Number(pos.lng), Number(lat), Number(lng));
  if (!(d <= radiusM)) throw new BattleError('TOO_FAR', `距离${what}太远（需在${radiusM}米内）`, 400, { distanceM: Math.round(d) });
  return d;
}

module.exports = {
  isUuid, getMoves, getComboDetector, getEnergyRule, invalidateStaticCache, getLearnsets,
  getOwnedPokemon, getTopPokemon, toCombatants, getMasteryAndEquipment, getUser, getGym, getGymDefenders,
  assertNear, haversineM, getComboMastery, weatherAt, POKEMON_COLUMNS, ACTIVE_POKEMON,
};
