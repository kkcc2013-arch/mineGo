// 自定义连招预设与一键连招（REQ-00143），以及连击链查询/统计/排行/练习/推荐（REQ-00288 / REQ-00311 / REQ-00364）
'use strict';

const { query } = require('../../../../shared/db');
const engine = require('./engine');
const store = require('./store');
const session = require('./session');
const repo = require('./repo');
const energyMod = require('./energy');
const { getDeps } = require('./deps');

const { BattleError } = engine;
const MAX_PRESETS = 5;
const MIN_STEPS = 2;
const MAX_STEPS = 5;
const CONDITIONS = ['energy_gte', 'target_hp_lte_pct', 'self_hp_gte_pct'];

async function pokemonMoves(userId, pokemonId) {
  if (!repo.isUuid(pokemonId)) throw new BattleError('INVALID_ID', '精灵 ID 无效', 400);
  const rows = await repo.getOwnedPokemon(userId, [pokemonId]);
  if (!rows.length) throw new BattleError('POKEMON_NOT_FOUND', '精灵不存在', 404);
  const [c] = await repo.toCombatants(rows, { withProgress: false });
  return c;
}

function validateSteps(steps, moveIds) {
  if (!Array.isArray(steps) || steps.length < MIN_STEPS || steps.length > MAX_STEPS) {
    throw new BattleError('BAD_STEPS', `连招需要 ${MIN_STEPS}-${MAX_STEPS} 个技能步骤`, 400);
  }
  return steps.map((s, i) => {
    if (!s || !moveIds.includes(s.moveId)) throw new BattleError('BAD_STEPS', `第 ${i + 1} 步技能不是该精灵已掌握的技能`, 400);
    const delayMs = Math.max(0, Math.min(3000, Number(s.delayMs) || 0));
    let condition = null;
    if (s.condition) {
      if (!CONDITIONS.includes(s.condition.type)) throw new BattleError('BAD_STEPS', `第 ${i + 1} 步条件类型无效`, 400);
      condition = { type: s.condition.type, value: Number(s.condition.value) || 0 };
    }
    return { moveId: s.moveId, delayMs, condition };
  });
}

async function listPresets(userId, pokemonId) {
  const params = [userId];
  let where = 'user_id = $1';
  if (pokemonId) {
    if (!repo.isUuid(pokemonId)) throw new BattleError('INVALID_ID', '精灵 ID 无效', 400);
    params.push(pokemonId); where += ' AND pokemon_id = $2';
  }
  const { rows } = await query(`SELECT * FROM pokemon_skill_combos WHERE ${where} ORDER BY is_default DESC, created_at`, params);
  return rows.map((r) => ({
    id: r.id, pokemonId: r.pokemon_id, name: r.name, steps: r.steps, isDefault: r.is_default,
    stats: { uses: r.uses, completions: r.completions, combosTriggered: r.combos_triggered, totalDamage: Number(r.total_damage), successRate: r.uses ? Number((r.completions / r.uses).toFixed(3)) : null },
    createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

async function createPreset(userId, body = {}) {
  const c = await pokemonMoves(userId, body.pokemonId);
  const name = String(body.name || '').trim();
  if (!name || name.length > 30) throw new BattleError('BAD_NAME', '连招名称需为 1-30 字', 400);
  const steps = validateSteps(body.steps, c.moves.map((m) => m.id));
  const { rows: [{ n }] } = await query('SELECT COUNT(*)::int AS n FROM pokemon_skill_combos WHERE pokemon_id = $1', [body.pokemonId]);
  if (n >= MAX_PRESETS) throw new BattleError('PRESET_LIMIT', `每只精灵最多 ${MAX_PRESETS} 套连招`, 400);
  if (body.isDefault) await query('UPDATE pokemon_skill_combos SET is_default = FALSE WHERE pokemon_id = $1', [body.pokemonId]);
  const { rows: [r] } = await query(`INSERT INTO pokemon_skill_combos (user_id, pokemon_id, name, steps, is_default)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [userId, body.pokemonId, name, JSON.stringify(steps), !!body.isDefault || n === 0]);
  return (await listPresets(userId, body.pokemonId)).find((p) => p.id === r.id);
}

async function ownPreset(userId, id) {
  if (!repo.isUuid(id)) throw new BattleError('INVALID_ID', '连招 ID 无效', 400);
  const { rows: [p] } = await query('SELECT * FROM pokemon_skill_combos WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!p) throw new BattleError('PRESET_NOT_FOUND', '连招不存在', 404);
  return p;
}

async function updatePreset(userId, id, body = {}) {
  const p = await ownPreset(userId, id);
  let steps = p.steps;
  if (body.steps !== undefined) {
    const c = await pokemonMoves(userId, p.pokemon_id);
    steps = validateSteps(body.steps, c.moves.map((m) => m.id));
  }
  let name = p.name;
  if (body.name !== undefined) {
    name = String(body.name || '').trim();
    if (!name || name.length > 30) throw new BattleError('BAD_NAME', '连招名称需为 1-30 字', 400);
  }
  if (body.isDefault) await query('UPDATE pokemon_skill_combos SET is_default = FALSE WHERE pokemon_id = $1 AND id <> $2', [p.pokemon_id, id]);
  await query(`UPDATE pokemon_skill_combos SET name = $2, steps = $3, is_default = COALESCE($4, is_default), updated_at = NOW() WHERE id = $1`,
    [id, name, JSON.stringify(steps), body.isDefault === undefined ? null : !!body.isDefault]);
  return (await listPresets(userId, p.pokemon_id)).find((x) => x.id === id);
}

async function deletePreset(userId, id) {
  await ownPreset(userId, id);
  await query('DELETE FROM pokemon_skill_combos WHERE id = $1', [id]);
  return { deleted: true };
}

function conditionOk(cond, att, def) {
  if (!cond) return true;
  if (cond.type === 'energy_gte') return att.energy >= cond.value;
  if (cond.type === 'target_hp_lte_pct') return (def.hp / def.maxHp) * 100 <= cond.value;
  if (cond.type === 'self_hp_gte_pct') return (att.hp / att.maxHp) * 100 >= cond.value;
  return true;
}

/**
 * 战斗中一键释放连招：按步骤依次出招（步骤间延迟计入连击时间窗口），
 * 条件不满足 / 技能冷却或能量不足 / 精灵倒下 / 战斗结束时停止
 */
async function executePreset(userId, battleId, presetId) {
  const preset = await ownPreset(userId, presetId);
  return store.withLock(battleId, async () => {
    const state = await session.loadOwned(userId, battleId);
    if (state.status !== 'active') throw new BattleError('BATTLE_ENDED', '战斗已结束', 409);
    const active = engine.activeOf(state, 'attacker');
    if (active.pokemonId !== preset.pokemon_id) throw new BattleError('PRESET_POKEMON', '该连招不属于当前出战精灵', 400);
    const deps = await getDeps();
    const turns = [];
    let stoppedReason = null;
    let t = Math.max(Date.now(), (state.lastActionAt || 0) + 1);
    const combosBefore = state.comboState.count;
    let damage = 0;
    for (const [i, step] of preset.steps.entries()) {
      const att = engine.activeOf(state, 'attacker');
      const def = engine.activeOf(state, 'defender');
      if (att.pokemonId !== preset.pokemon_id) { stoppedReason = 'POKEMON_FAINTED'; break; }
      if (!conditionOk(step.condition, att, def)) { stoppedReason = `CONDITION_FAILED:${i + 1}`; break; }
      const chk = energyMod.checkMove(att, step.moveId, { turn: state.turn + 1 });
      if (!chk.ok) { stoppedReason = `${chk.reason}:${i + 1}`; break; }
      t += i === 0 ? 0 : step.delayMs;
      const ev = engine.playTurn(state, { moveId: step.moveId, now: t }, deps);
      damage += ev.damage.attacker;
      turns.push(ev);
      if (state.status !== 'active') { stoppedReason = stoppedReason || 'BATTLE_ENDED'; break; }
    }
    state.lastActionAt = t;
    const completed = turns.length === preset.steps.length;
    const triggered = state.comboState.count - combosBefore;
    await query(`UPDATE pokemon_skill_combos SET uses = uses + 1, completions = completions + $2, combos_triggered = combos_triggered + $3,
       total_damage = total_damage + $4, updated_at = NOW() WHERE id = $1`, [preset.id, completed ? 1 : 0, triggered, damage]);
    if (!turns.length) throw new BattleError('PRESET_NOT_EXECUTABLE', '连招第一步无法执行', 400, { reason: stoppedReason });
    const out = await session.respond(state, deps, turns[turns.length - 1]);
    return { ...out, turns, executedSteps: turns.length, totalSteps: preset.steps.length, completed, combosTriggered: triggered, damage, stoppedReason };
  });
}

// ── 连击链查询 / 统计 / 排行 / 练习 / 推荐 ─────────────────────────────

async function listChains(userId) {
  const cd = await repo.getComboDetector();
  const user = userId ? await repo.getUser(userId) : { level: 50 };
  const moves = await repo.getMoves();
  return cd.chains.map((c) => ({
    chainId: c.chainId, name: c.name, description: c.description,
    sequence: c.sequence.map((id) => ({ moveId: id, name: (moves.get(id) || {}).name || id })),
    timeWindowMs: c.windowMs, element: c.element, damageMultiplier: c.damageMultiplier, bonusEffects: c.bonus,
    cooldownReductionPct: c.cooldownReduction, comboPoints: c.comboPoints, xpBonus: c.xpBonus,
    minTrainerLevel: c.minTrainerLevel, chainCooldownActions: c.chainCooldown, unlocked: Number(user.level) >= c.minTrainerLevel,
  }));
}

async function chainDetail(userId, chainId) {
  const all = await listChains(userId);
  const c = all.find((x) => x.chainId === chainId);
  if (!c) throw new BattleError('CHAIN_NOT_FOUND', '连击链不存在', 404);
  const { rows: [s] } = await query('SELECT times_executed, perfect_executions, highest_damage_dealt, total_points, last_executed_at FROM user_combo_stats WHERE user_id = $1 AND chain_id = $2', [userId, chainId]);
  const times = s ? s.times_executed : 0;
  return { ...c, myStats: s || null, masteryBonusPct: Math.min(20, times) };
}

async function myStats(userId) {
  const { rows } = await query(`SELECT s.chain_id, c.name, s.times_executed, s.perfect_executions, s.highest_damage_dealt, s.total_points, s.last_executed_at
      FROM user_combo_stats s JOIN combo_chains c ON c.chain_id = s.chain_id WHERE s.user_id = $1 ORDER BY s.total_points DESC`, [userId]);
  const { rows: [q] } = await query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE quality = 'perfect')::int AS perfect,
        COUNT(*) FILTER (WHERE quality = 'excellent')::int AS excellent,
        COALESCE(SUM(damage_dealt),0)::bigint AS damage, COALESCE(SUM(combo_points_earned),0)::int AS points
      FROM combo_records WHERE user_id = $1`, [userId]);
  return {
    totals: { combos: q.total, perfect: q.perfect, excellent: q.excellent, damage: Number(q.damage), points: q.points },
    chains: rows.map((r) => ({ ...r, masteryBonusPct: Math.min(20, r.times_executed) })),
  };
}

async function leaderboard({ chainId, limit = 50 } = {}) {
  const params = [];
  let where = '';
  if (chainId) { params.push(chainId); where = 'WHERE s.chain_id = $1'; }
  params.push(Math.min(100, Number(limit) || 50));
  const { rows } = await query(`
    SELECT s.user_id, u.nickname, SUM(s.total_points)::int AS points, SUM(s.times_executed)::int AS combos,
           SUM(s.perfect_executions)::int AS perfect, MAX(s.highest_damage_dealt)::int AS best_damage
      FROM user_combo_stats s JOIN users u ON u.id::text = s.user_id::text
      ${where}
     GROUP BY s.user_id, u.nickname
     ORDER BY points DESC, perfect DESC, combos DESC, s.user_id
     LIMIT $${params.length}`, params);
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

async function practice(userId, chainId, body = {}) {
  const cd = await repo.getComboDetector();
  const chain = cd.get(chainId);
  if (!chain) throw new BattleError('CHAIN_NOT_FOUND', '连击链不存在', 404);
  const steps = Array.isArray(body.steps) && body.steps.length
    ? body.steps.slice(0, 10).map((s) => ({ moveId: String(s.moveId || ''), atMs: Math.max(0, Number(s.atMs) || 0) }))
    : chain.sequence.map((m, i) => ({ moveId: m, atMs: i * 500 }));
  const user = await repo.getUser(userId);
  const results = cd.practice(steps, { attackerTypes: body.types || (chain.element ? [chain.element] : []), trainerLevel: Number(user.level) || 1 });
  const hit = results.find((r) => r.combo && r.combo.chainId === chainId);
  return { chainId, windowMs: chain.windowMs, steps: results, success: !!hit, quality: hit ? hit.combo.quality : null, multiplier: hit ? hit.combo.multiplier : null };
}

async function recommendForPokemon(userId, pokemonId) {
  const c = await pokemonMoves(userId, pokemonId);
  const cd = await repo.getComboDetector();
  const user = await repo.getUser(userId);
  const list = cd.achievable(c.moves.map((m) => m.id), { types: c.types, trainerLevel: Number(user.level) || 1 });
  const ready = list.filter((x) => x.ready);
  const nearly = list.filter((x) => !x.ready && x.missing.length === 1 && x.elementOk).slice(0, 5);
  return {
    pokemonId, name: c.name, moves: c.moves.map((m) => ({ id: m.id, name: m.name, category: m.category })),
    ready, nearlyReady: nearly.map((x) => ({ ...x, suggestion: `学会 ${x.missing[0]} 即可使用「${x.name}」` })),
  };
}

async function comboLogs(userId, limit = 50) {
  const { rows } = await query(`SELECT r.chain_id, c.name, r.pokemon_id, r.battle_type, r.quality, r.damage_dealt, r.combo_points_earned, r.battle_id, r.executed_at
      FROM combo_records r LEFT JOIN combo_chains c ON c.chain_id = r.chain_id
     WHERE r.user_id = $1 ORDER BY r.executed_at DESC LIMIT $2`, [userId, Math.min(200, Number(limit) || 50)]);
  return rows;
}

module.exports = {
  listPresets, createPreset, updatePreset, deletePreset, executePreset, validateSteps, conditionOk,
  listChains, chainDetail, myStats, leaderboard, practice, recommendForPokemon, comboLogs, MAX_PRESETS,
};
