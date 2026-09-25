// 精灵能量池与技能可用性（REQ-00112 接口：能量查询 / 自然回复 / 技能检查），冷却预测（REQ-00299），熟练度与冷却装备
//
// 战斗外：pokemon_energy 保存能量池（上限与个体值关联），按经过时间自然回复（energy_regen_rate 点/分钟），
//   回复量完全由服务端按时间计算，客户端无法指定；
// 战斗中：返回进行中战斗里的实时能量与各技能剩余冷却。
'use strict';

const { query, transaction } = require('../../../../shared/db');
const repo = require('./repo');
const store = require('./store');
const engine = require('./engine');
const energyMod = require('./energy');
const cooldown = require('./cooldown');

const { BattleError } = engine;
const DEFAULT_REGEN_PER_MIN = 5;

async function ownedCombatant(userId, pokemonId) {
  if (!repo.isUuid(pokemonId)) throw new BattleError('INVALID_ID', '精灵 ID 无效', 400);
  const rows = await repo.getOwnedPokemon(userId, [pokemonId]);
  if (!rows.length) throw new BattleError('POKEMON_NOT_FOUND', '精灵不存在', 404);
  const [c] = await repo.toCombatants(rows);
  return c;
}

/** 若该精灵在玩家进行中的战斗里，返回 { state, combatant } */
async function inBattle(userId, pokemonId) {
  const id = await store.activeBattleId(userId);
  if (!id) return null;
  const state = await store.load(id);
  if (!state || state.status !== 'active') return null;
  const c = state.attacker.team.find((x) => x.pokemonId === pokemonId);
  return c ? { state, combatant: c } : null;
}

async function pool(c, { persist = false } = {}) {
  const { rows: [row] } = await query('SELECT current_energy, max_energy, energy_regen_rate, last_updated FROM pokemon_energy WHERE pokemon_instance_id = $1', [c.pokemonId]);
  const max = c.maxEnergy;
  const rate = row ? Number(row.energy_regen_rate) || DEFAULT_REGEN_PER_MIN : DEFAULT_REGEN_PER_MIN;
  if (!row) {
    if (persist) {
      await query(`INSERT INTO pokemon_energy (pokemon_instance_id, current_energy, max_energy, energy_regen_rate, last_updated)
          VALUES ($1, $2, $2, $3, NOW()) ON CONFLICT DO NOTHING`, [c.pokemonId, max, rate]).catch(() => {});
    }
    return { current: max, max, regenPerMinute: rate, regenerated: 0 };
  }
  const minutes = Math.max(0, (Date.now() - new Date(row.last_updated).getTime()) / 60000);
  const gained = Math.floor(minutes * rate);
  const current = Math.min(max, Number(row.current_energy) + gained);
  return { current, max, regenPerMinute: rate, regenerated: current - Number(row.current_energy), lastUpdated: row.last_updated, fullInMinutes: current >= max ? 0 : Math.ceil((max - current) / rate) };
}

async function getEnergy(userId, pokemonId) {
  const c = await ownedCombatant(userId, pokemonId);
  const p = await pool(c);
  const b = await inBattle(userId, pokemonId);
  return {
    pokemonId, name: c.name, maxEnergy: c.maxEnergy, ivSum: c.ivSum,
    pool: { current: p.current, max: p.max, regenPerMinute: p.regenPerMinute, fullInMinutes: p.fullInMinutes || 0 },
    battle: b ? {
      battleId: b.state.id, energy: b.combatant.energy, maxEnergy: b.combatant.maxEnergy, turn: b.state.turn,
      cooldowns: Object.fromEntries(b.combatant.moves.map((m) => [m.id, cooldown.remainingTurns(b.combatant, m.id, b.state.turn + 1)])),
    } : null,
    moves: c.moves.map((m) => ({ id: m.id, name: m.name, category: m.category, energyCost: m.energyCost, energyGain: m.energyGain, cooldownMs: m.cooldownMs })),
  };
}

/** 按经过时间结算自然回复并落库（重复调用不会多回复） */
async function regenerate(userId, pokemonId) {
  const c = await ownedCombatant(userId, pokemonId);
  return transaction(async (client) => {
    const { rows: [row] } = await client.query('SELECT current_energy, energy_regen_rate, last_updated FROM pokemon_energy WHERE pokemon_instance_id = $1 FOR UPDATE', [pokemonId]);
    if (!row) {
      await client.query(`INSERT INTO pokemon_energy (pokemon_instance_id, current_energy, max_energy, energy_regen_rate, last_updated)
          VALUES ($1,$2,$2,$3,NOW())`, [pokemonId, c.maxEnergy, DEFAULT_REGEN_PER_MIN]);
      return { pokemonId, energy: c.maxEnergy, maxEnergy: c.maxEnergy, regenerated: 0 };
    }
    const rate = Number(row.energy_regen_rate) || DEFAULT_REGEN_PER_MIN;
    const elapsedMs = Date.now() - new Date(row.last_updated).getTime();
    const gained = Math.floor((elapsedMs / 60000) * rate);
    const next = Math.min(c.maxEnergy, Number(row.current_energy) + gained);
    // 只推进已兑换成能量的整段时间，余数保留到下次
    const consumedMs = gained > 0 ? Math.floor((gained / rate) * 60000) : 0;
    await client.query(`UPDATE pokemon_energy SET current_energy = $2, max_energy = $3,
        last_updated = CASE WHEN $2 >= $3 THEN NOW() ELSE last_updated + make_interval(secs => $4::float / 1000) END WHERE pokemon_instance_id = $1`,
    [pokemonId, next, c.maxEnergy, consumedMs]);
    return { pokemonId, energy: next, maxEnergy: c.maxEnergy, regenerated: next - Number(row.current_energy), regenPerMinute: rate };
  });
}

/** 技能可用性检查（战斗中按战斗状态，否则按能量池） */
async function checkMove(userId, pokemonId, moveId) {
  const c = await ownedCombatant(userId, pokemonId);
  if (!c.moves.some((m) => m.id === moveId)) return { ok: false, reason: 'UNKNOWN_MOVE', message: '该精灵没有这个技能' };
  const b = await inBattle(userId, pokemonId);
  if (b) {
    const chk = energyMod.checkMove(b.combatant, moveId, { turn: b.state.turn + 1 });
    return { ok: chk.ok, reason: chk.reason || null, inBattle: true, energy: b.combatant.energy, need: chk.need || (chk.move ? chk.move.energyCost : 0), cooldownLeft: chk.cooldownLeft || 0,
      message: chk.ok ? '可以使用' : chk.reason === 'ENERGY' ? `能量不足（${chk.have}/${chk.need}）` : `冷却中（${chk.cooldownLeft} 回合）` };
  }
  const p = await pool(c);
  const move = c.moves.find((m) => m.id === moveId);
  const ok = move.category !== 'CHARGE' || p.current >= move.energyCost;
  return { ok, reason: ok ? null : 'ENERGY', inBattle: false, energy: p.current, need: move.energyCost, cooldownLeft: 0,
    message: ok ? '可以使用' : `能量不足（${p.current}/${move.energyCost}）` };
}

/** 冷却预测与可视化数据（REQ-00299） */
async function cooldownInfo(userId, pokemonId, mode = 'PVE', weather = null) {
  const c = await ownedCombatant(userId, pokemonId);
  const b = await inBattle(userId, pokemonId);
  const src = b ? b.combatant : c;
  const turn = b ? b.state.turn + 1 : 0;
  const m = cooldown.MODE_STRATEGIES[mode] ? mode : 'PVE';
  const w = weather || (b ? b.state.weather : null);
  const p = cooldown.predict(src, { turn, ctx: { mode: m, weather: w, comboCount: b ? b.state.comboState.count : 0 } });
  return { pokemonId, name: c.name, speed: c.speed, equipment: c.equipment, mastery: c.mastery, inBattle: !!b, weather: w, ...p, strategies: cooldown.MODE_STRATEGIES };
}

async function masteryInfo(userId, pokemonId) {
  const c = await ownedCombatant(userId, pokemonId);
  const { rows } = await query('SELECT move_id, mastery, uses, combos, updated_at FROM pokemon_move_mastery WHERE pokemon_id = $1', [pokemonId]);
  const byMove = new Map(rows.map((r) => [r.move_id, r]));
  return {
    pokemonId, name: c.name,
    moves: c.moves.map((mv) => {
      const r = byMove.get(mv.id);
      const mastery = r ? r.mastery : 0;
      return { moveId: mv.id, name: mv.name, mastery, uses: r ? r.uses : 0, combos: r ? r.combos : 0, cooldownReductionPct: Number((cooldown.masteryReduction(mastery) * 100).toFixed(2)) };
    }),
  };
}

// ── 冷却装备 ────────────────────────────────────────────────
async function equipmentCatalog() {
  const { rows } = await query('SELECT id, name_zh, equip_type, reduction_pct, applies_to, move_type, description_zh FROM cooldown_equipment_catalog ORDER BY equip_type, reduction_pct');
  return { items: rows, capPct: cooldown.LIMITS.equipmentMax * 100 };
}

async function myEquipment(userId) {
  const { rows } = await query(`SELECT u.id, u.equipment_id, c.name_zh, c.equip_type, c.reduction_pct, c.applies_to, c.move_type, u.pokemon_id, u.source, u.acquired_at, u.equipped_at
      FROM user_cooldown_equipment u JOIN cooldown_equipment_catalog c ON c.id = u.equipment_id WHERE u.user_id = $1 ORDER BY u.acquired_at`, [userId]);
  return { items: rows };
}

/** 装备到精灵：每只精灵每种类型（宝石/符文/神器）各 1 件 */
async function equip(userId, itemId, pokemonId) {
  if (!repo.isUuid(itemId) || !repo.isUuid(pokemonId)) throw new BattleError('INVALID_ID', 'ID 无效', 400);
  await ownedCombatant(userId, pokemonId);
  return transaction(async (client) => {
    const { rows: [it] } = await client.query(`SELECT u.id, c.equip_type FROM user_cooldown_equipment u JOIN cooldown_equipment_catalog c ON c.id = u.equipment_id
        WHERE u.id = $1 AND u.user_id = $2 FOR UPDATE OF u`, [itemId, userId]);
    if (!it) throw new BattleError('ITEM_NOT_FOUND', '装备不存在', 404);
    await client.query(`UPDATE user_cooldown_equipment u SET pokemon_id = NULL, equipped_at = NULL
        FROM cooldown_equipment_catalog c WHERE c.id = u.equipment_id AND u.user_id = $1 AND u.pokemon_id = $2 AND c.equip_type = $3 AND u.id <> $4`,
    [userId, pokemonId, it.equip_type, itemId]);
    await client.query('UPDATE user_cooldown_equipment SET pokemon_id = $2, equipped_at = NOW() WHERE id = $1', [itemId, pokemonId]);
    return { itemId, pokemonId, equipType: it.equip_type };
  });
}

async function unequip(userId, itemId) {
  if (!repo.isUuid(itemId)) throw new BattleError('INVALID_ID', 'ID 无效', 400);
  const { rowCount } = await query('UPDATE user_cooldown_equipment SET pokemon_id = NULL, equipped_at = NULL WHERE id = $1 AND user_id = $2', [itemId, userId]);
  if (!rowCount) throw new BattleError('ITEM_NOT_FOUND', '装备不存在', 404);
  return { itemId, unequipped: true };
}

async function grantEquipment(targetUserId, equipmentId, source = 'admin') {
  if (!repo.isUuid(targetUserId)) throw new BattleError('INVALID_ID', '用户 ID 无效', 400);
  const { rows: [r] } = await query(`INSERT INTO user_cooldown_equipment (user_id, equipment_id, source)
      SELECT $1::uuid, $2::varchar, $3::varchar WHERE EXISTS (SELECT 1 FROM cooldown_equipment_catalog WHERE id = $2::varchar) AND EXISTS (SELECT 1 FROM users WHERE id = $1::uuid)
      RETURNING id, equipment_id`, [targetUserId, equipmentId, source]);
  if (!r) throw new BattleError('BAD_REQUEST', '用户或装备不存在', 400);
  return r;
}

module.exports = { getEnergy, regenerate, checkMove, cooldownInfo, masteryInfo, equipmentCatalog, myEquipment, equip, unequip, grantEquipment };
