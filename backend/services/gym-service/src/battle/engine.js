// 回合制战斗引擎（道馆对战 / 联赛对战共用）。纯逻辑：不访问数据库，状态为可 JSON 序列化的对象。
//
// 每个回合：攻方使用技能 → 守方（AI）反击 → 回合结束（状态伤害结算、双方自动回复能量）。
// 伤害全部由服务端按双方精灵数值与技能表计算；客户端只提交技能 ID。
'use strict';

const { createRng } = require('./rng');
const energy = require('./energy');
const cooldown = require('./cooldown');

class BattleError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const STATUS_DEF = {
  STUN: { name: '麻痹', turns: 1, skip: true },
  FREEZE: { name: '冰冻', turns: 1, skip: true },
  BURN: { name: '灼伤', turns: 3, tick: 1 / 16, attackFactor: 0.8 },
  POISON: { name: '中毒', turns: 4, tick: 1 / 16 },
  CONFUSE: { name: '混乱', turns: 2, confuse: 0.33 },
};
const HISTORY_MAX = 8;

function createBattle({ id, type = 'gym', mode = 'PVE', userId, trainerLevel = 1, attackerTeam, defenderTeam, seed, weather = null, meta = {}, now = Date.now() }) {
  if (!attackerTeam || !attackerTeam.length) throw new BattleError('BAD_TEAM', '攻击队伍为空');
  if (!defenderTeam || !defenderTeam.length) throw new BattleError('NO_DEFENDERS', '没有可挑战的对手');
  return {
    id, type, mode, userId, trainerLevel, weather,
    seed: seed >>> 0, rngState: seed >>> 0,
    turn: 0, seq: 0, status: 'active', result: null,
    startedAt: now, updatedAt: now, endedAt: null, meta,
    attacker: { active: 0, team: attackerTeam },
    defender: { active: 0, team: defenderTeam },
    history: [],
    comboState: { count: 0, lastTriggered: {}, points: 0, xpBonus: 0, list: [] },
    masteryGain: {},
    log: [],
  };
}

const activeOf = (state, side) => state[side].team[state[side].active];
const aliveCount = (state, side) => state[side].team.filter((c) => c.hp > 0).length;

function assertActive(state) {
  if (!state || state.status !== 'active') throw new BattleError('BATTLE_ENDED', '战斗已结束', 409);
}

function cooldownCtx(state, actor) {
  return {
    mode: state.mode,
    comboCount: state.comboState.count,
    speed: actor.speed,
    equipment: actor.equipment,
    weather: state.weather,
  };
}

/** 攻方当前可用技能（前端技能按钮 / AI 输入） */
function availableMoves(state, side = 'attacker') {
  const c = activeOf(state, side);
  const nextTurn = state.turn + 1;
  return c.moves.map((m) => {
    const chk = energy.checkMove(c, m.id, { turn: nextTurn });
    return {
      id: m.id, name: m.name, type: m.type, category: m.category, power: m.power,
      energyCost: m.energyCost, energyGain: m.energyGain,
      cooldownLeft: cooldown.remainingTurns(c, m.id, nextTurn),
      energyOk: m.category !== 'CHARGE' || c.energy >= m.energyCost,
      ready: chk.ok,
      cooldownTurns: cooldown.effectiveCooldown(m, { ...cooldownCtx(state, c), mastery: (c.mastery || {})[m.id] }).turns,
    };
  });
}

function applyStatus(target, code) {
  if (!code || !STATUS_DEF[code] || target.status || target.hp <= 0) return false;
  target.status = { code, turns: STATUS_DEF[code].turns };
  return true;
}

/** 执行一次技能。返回事件列表 */
function performMove(state, side, actor, target, move, { rng, now, deps, events }) {
  const isAttacker = side === 'attacker';
  // 状态阻止行动
  if (actor.status && STATUS_DEF[actor.status.code] && STATUS_DEF[actor.status.code].skip) {
    events.push({ type: 'skip', actor: side, pokemonId: actor.pokemonId, reason: actor.status.code, message: `${actor.name} ${STATUS_DEF[actor.status.code].name}，无法行动` });
    actor.status = null;
    if (isAttacker) state.history = [];
    return;
  }
  if (actor.status && actor.status.code === 'CONFUSE' && rng() < STATUS_DEF.CONFUSE.confuse) {
    const self = Math.max(1, Math.floor(actor.maxHp / 10));
    actor.hp = Math.max(0, actor.hp - self);
    events.push({ type: 'confusion', actor: side, pokemonId: actor.pokemonId, damage: self, message: `${actor.name} 混乱中攻击了自己` });
    if (isAttacker) state.history = [];
    return;
  }

  const energyDelta = energy.applyMoveEnergy(actor, move);
  const cd = cooldown.startCooldown(actor, move, { turn: state.turn, ctx: { ...cooldownCtx(state, actor), mastery: (actor.mastery || {})[move.id] } });

  let combo = null;
  if (isAttacker && deps.combos) {
    combo = deps.combos.detect(state.history, move.id, {
      now, seq: state.seq, attackerTypes: actor.types, trainerLevel: state.trainerLevel,
      lastTriggered: state.comboState.lastTriggered, masteryCounts: deps.comboMastery || state.comboState.mastery || {},
    });
  }

  const missed = rng() * 100 >= (move.accuracy === undefined ? 100 : move.accuracy);
  let dmg = { damage: 0, effectiveness: 1, effectivenessText: '', isCrit: false };
  if (missed) {
    combo = null;
  } else {
    const burn = actor.status && actor.status.code === 'BURN' ? STATUS_DEF.BURN.attackFactor : 1;
    dmg = deps.damage.compute(actor, target, move, {
      rng, weather: state.weather, attackFactor: burn,
      multiplier: combo ? combo.multiplier : 1,
      critBoostPct: combo ? combo.effects.critBoostPct : 0,
      ignoreDefensePct: combo ? combo.effects.ignoreDefensePct : 0,
    });
    const dealt = Math.min(target.hp, dmg.damage);
    target.hp = Math.max(0, target.hp - dmg.damage);
    actor.damageDealt += dealt;
    target.damageTaken += dealt;
  }

  const ev = {
    type: 'attack', actor: side, pokemonId: actor.pokemonId, name: actor.name, speciesId: actor.speciesId,
    move: move.id, moveName: move.name, moveType: move.type, category: move.category,
    damage: dmg.damage, effectiveness: dmg.effectiveness, effectivenessText: dmg.effectivenessText,
    isCritical: dmg.isCrit, missed, targetId: target.pokemonId, targetHp: target.hp, targetMaxHp: target.maxHp,
    energy: actor.energy, energyDelta, cooldownTurns: cd.turns,
  };
  events.push(ev);

  // 附加状态：连击奖励必定附加，否则按技能几率
  let statusCode = null;
  if (combo && combo.effects.status) statusCode = combo.effects.status;
  else if (!missed && move.effectType && STATUS_DEF[move.effectType] && rng() * 100 < move.effectChance) statusCode = move.effectType;
  if (statusCode && target.hp > 0 && applyStatus(target, statusCode)) {
    events.push({ type: 'status_apply', actor: side, target: isAttacker ? 'defender' : 'attacker', pokemonId: target.pokemonId, effect: statusCode, message: `${target.name} 陷入${STATUS_DEF[statusCode].name}状态` });
  }

  if (isAttacker) {
    state.masteryGain[actor.pokemonId] = state.masteryGain[actor.pokemonId] || {};
    const mg = state.masteryGain[actor.pokemonId];
    mg[move.id] = (mg[move.id] || 0) + (combo ? 2 : 1);
    if (combo) {
      const cs = state.comboState;
      cs.count += 1;
      cs.lastTriggered[combo.chain.chainId] = state.seq;
      cs.points += combo.chain.comboPoints;
      const xp = Math.round(combo.chain.xpBonus * combo.qualityFactor);
      cs.xpBonus += xp;
      if (combo.effects.energyRefund) actor.energy = Math.min(actor.maxEnergy, actor.energy + combo.effects.energyRefund);
      if (combo.effects.healPct) actor.hp = Math.min(actor.maxHp, actor.hp + Math.floor(actor.maxHp * combo.effects.healPct / 100));
      if (combo.effects.cooldownReductionPct) cooldown.reduceRemaining(actor, combo.effects.cooldownReductionPct, { turn: state.turn });
      ev.combo = { chainId: combo.chain.chainId, name: combo.chain.name, quality: combo.quality, multiplier: combo.multiplier, elapsedMs: combo.elapsedMs, comboPoints: combo.chain.comboPoints, xpBonus: xp };
      cs.list.push({ ...ev.combo, turn: state.turn, pokemonId: actor.pokemonId, damage: dmg.damage });
      state.history = [];
    } else if (missed) {
      state.history = [];
    } else {
      state.history.push({ moveId: move.id, at: now, seq: state.seq });
      if (state.history.length > HISTORY_MAX) state.history.shift();
    }
    state.seq += 1;
  }
}

/** 守方 AI：蓄力技能可用时选期望伤害最高的，否则快速技能 */
function chooseAiMove(state, side, deps) {
  const actor = activeOf(state, side);
  const target = activeOf(state, side === 'attacker' ? 'defender' : 'attacker');
  const turn = state.turn;
  const usable = actor.moves.filter((m) => energy.checkMove(actor, m.id, { turn }).ok);
  const charges = usable.filter((m) => m.category === 'CHARGE');
  if (charges.length) {
    return charges.reduce((best, m) => (deps.damage.expected(actor, target, m, state.weather) > deps.damage.expected(actor, target, best, state.weather) ? m : best));
  }
  return usable.find((m) => m.category === 'FAST') || actor.moves[0];
}

/** 处理倒下：换下一只或结束战斗 */
function handleFaints(state, events, now) {
  for (const side of ['defender', 'attacker']) {
    const c = activeOf(state, side);
    if (c.hp > 0) continue;
    if (!c.faintLogged) {
      c.faintLogged = true;
      events.push({ type: 'faint', side, pokemonId: c.pokemonId, name: c.name, message: `${c.name} 倒下了` });
      const other = activeOf(state, side === 'attacker' ? 'defender' : 'attacker');
      other.knockouts = (other.knockouts || 0) + 1;
      if (side === 'attacker') state.history = [];
    }
    const next = state[side].team.findIndex((x) => x.hp > 0);
    if (next === -1) {
      state.status = 'ended';
      state.result = side === 'defender' ? 'win' : 'lose';
      state.endedAt = now;
      return;
    }
    state[side].active = next;
    const n = activeOf(state, side);
    events.push({ type: 'switch', side, pokemonId: n.pokemonId, name: n.name, hp: n.hp, maxHp: n.maxHp, message: `${n.name} 上场` });
  }
}

function endOfTurn(state, events, deps) {
  for (const side of ['attacker', 'defender']) {
    const c = activeOf(state, side);
    if (c.hp <= 0) continue;
    if (c.status) {
      const def = STATUS_DEF[c.status.code];
      if (def && def.tick) {
        const d = Math.max(1, Math.floor(c.maxHp * def.tick));
        c.hp = Math.max(0, c.hp - d);
        events.push({ type: 'status_tick', side, pokemonId: c.pokemonId, effect: c.status.code, damage: d, message: `${c.name} 受到${def.name}伤害` });
      }
      c.status.turns -= 1;
      if (c.status.turns <= 0 && !(def && def.skip)) {
        events.push({ type: 'status_clear', side, pokemonId: c.pokemonId, effect: c.status.code });
        c.status = null;
      }
    }
    if (c.hp > 0) {
      const gained = energy.regenerate(c, deps.energyRule || energy.DEFAULT_RULE);
      if (gained > 0 && side === 'attacker') events.push({ type: 'energy_regen', side, pokemonId: c.pokemonId, amount: gained, energy: c.energy });
    }
  }
}

function finishTurn(state, events, now) {
  const a = activeOf(state, 'attacker');
  const d = activeOf(state, 'defender');
  const turnEvent = {
    turn: state.turn, at: now, actions: events,
    hp: { attacker: a.hp, defender: d.hp },
    damage: {
      attacker: events.filter((e) => e.type === 'attack' && e.actor === 'attacker').reduce((s, e) => s + e.damage, 0),
      defender: events.filter((e) => e.type === 'attack' && e.actor === 'defender').reduce((s, e) => s + e.damage, 0),
    },
  };
  state.log.push(turnEvent);
  state.updatedAt = now;
  return turnEvent;
}

/**
 * 执行一个回合
 * @param {object} state
 * @param {{moveId:string, now?:number}} action
 * @param {{damage:DamageService, combos?:ComboDetector, energyRule?:object, comboMastery?:object}} deps
 */
function playTurn(state, { moveId, now = Date.now() }, deps) {
  assertActive(state);
  const att = activeOf(state, 'attacker');
  const def = activeOf(state, 'defender');
  const check = energy.checkMove(att, moveId, { turn: state.turn + 1 });
  if (!check.ok) {
    if (check.reason === 'UNKNOWN_MOVE') throw new BattleError('INVALID_MOVE', '该精灵没有这个技能', 400);
    if (check.reason === 'COOLDOWN') throw new BattleError('MOVE_COOLDOWN', `技能冷却中，还需 ${check.cooldownLeft} 回合`, 400, { cooldownLeft: check.cooldownLeft });
    throw new BattleError('INSUFFICIENT_ENERGY', `能量不足（需要 ${check.need}，当前 ${check.have}）`, 400, { need: check.need, have: check.have });
  }
  const rng = createRng(state.rngState);
  state.turn += 1;
  const events = [];
  performMove(state, 'attacker', att, def, check.move, { rng, now, deps, events });
  handleFaints(state, events, now);
  if (state.status === 'active' && activeOf(state, 'defender') === def && def.hp > 0) {
    const dm = chooseAiMove(state, 'defender', deps);
    performMove(state, 'defender', def, activeOf(state, 'attacker'), dm, { rng, now, deps, events });
    handleFaints(state, events, now);
  }
  if (state.status === 'active') {
    endOfTurn(state, events, deps);
    handleFaints(state, events, now);
  }
  state.rngState = rng.state();
  return finishTurn(state, events, now);
}

/** 攻方换人：消耗一个回合，守方获得一次行动 */
function switchActive(state, pokemonId, { now = Date.now() } = {}, deps) {
  assertActive(state);
  const idx = state.attacker.team.findIndex((c) => c.pokemonId === pokemonId);
  if (idx === -1) throw new BattleError('NOT_IN_TEAM', '该精灵不在队伍中', 400);
  if (state.attacker.team[idx].hp <= 0) throw new BattleError('FAINTED', '该精灵已倒下，无法上场', 400);
  if (idx === state.attacker.active) throw new BattleError('ALREADY_ACTIVE', '该精灵已在场上', 400);
  const rng = createRng(state.rngState);
  state.turn += 1;
  state.attacker.active = idx;
  state.history = [];
  const events = [{ type: 'switch', side: 'attacker', pokemonId, name: state.attacker.team[idx].name, message: `换上 ${state.attacker.team[idx].name}` }];
  const def = activeOf(state, 'defender');
  const dm = chooseAiMove(state, 'defender', deps);
  performMove(state, 'defender', def, activeOf(state, 'attacker'), dm, { rng, now, deps, events });
  handleFaints(state, events, now);
  if (state.status === 'active') {
    endOfTurn(state, events, deps);
    handleFaints(state, events, now);
  }
  state.rngState = rng.state();
  return finishTurn(state, events, now);
}

function forfeit(state, now = Date.now()) {
  assertActive(state);
  state.status = 'ended';
  state.result = 'forfeit';
  state.endedAt = now;
  return finishTurn(state, [{ type: 'forfeit', side: 'attacker', message: '攻方认输' }], now);
}

function combatantView(c, { withMoves = false } = {}) {
  const v = {
    pokemonId: c.pokemonId, name: c.name, speciesId: c.speciesId, types: c.types, cp: c.cp,
    hp: c.hp, maxHp: c.maxHp, energy: c.energy, maxEnergy: c.maxEnergy,
    status: c.status ? c.status.code : null, fainted: c.hp <= 0,
  };
  if (withMoves) v.moveIds = c.moves.map((m) => m.id);
  return v;
}

function publicView(state, deps = {}) {
  const att = activeOf(state, 'attacker');
  const def = activeOf(state, 'defender');
  const view = {
    battleId: state.id, type: state.type, mode: state.mode, status: state.status, result: state.result,
    turn: state.turn, weather: state.weather,
    attacker: {
      active: { ...combatantView(att), moves: availableMoves(state, 'attacker') },
      team: state.attacker.team.map((c) => combatantView(c)),
    },
    defender: {
      active: combatantView(def),
      remaining: aliveCount(state, 'defender'),
      total: state.defender.team.length,
    },
    combo: { count: state.comboState.count, points: state.comboState.points },
  };
  if (deps.combos && state.status === 'active') {
    view.combo.hints = deps.combos.progress(state.history, att.moves.map((m) => m.id), { now: Date.now() }).slice(0, 3);
  }
  return view;
}

/** 结算用摘要 */
function summarize(state) {
  const attacks = [];
  for (const t of state.log) {
    for (const e of t.actions) {
      if (e.type === 'attack') attacks.push({ ...e, turn: t.turn });
    }
  }
  const mine = attacks.filter((a) => a.actor === 'attacker');
  return {
    result: state.result,
    turns: state.turn,
    durationMs: (state.endedAt || state.updatedAt) - state.startedAt,
    defendersDefeated: state.defender.team.filter((c) => c.hp <= 0),
    defendersRemaining: state.defender.team.filter((c) => c.hp > 0),
    attackersFainted: state.attacker.team.filter((c) => c.hp <= 0).length,
    damageDealt: mine.reduce((s, a) => s + a.damage, 0),
    damageTaken: attacks.filter((a) => a.actor === 'defender').reduce((s, a) => s + a.damage, 0),
    superEffective: mine.filter((a) => a.effectiveness > 1.01).length,
    crits: mine.filter((a) => a.isCritical).length,
    attacks: mine,
    combos: state.comboState.list,
    comboPoints: state.comboState.points,
    comboXp: state.comboState.xpBonus,
    masteryGain: state.masteryGain,
  };
}

module.exports = {
  BattleError, STATUS_DEF, createBattle, playTurn, switchActive, forfeit, availableMoves,
  publicView, summarize, chooseAiMove, activeOf, aliveCount, combatantView,
};
