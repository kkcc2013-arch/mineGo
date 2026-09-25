// 战斗 AI 策略助手（REQ-00357 / REQ-00365）
//
// 规则 + 蒙特卡洛模拟（不依赖外部模型服务）：
//   - 实时技能建议：对每个可用技能估算期望伤害、击倒可能、属性克制/本系加成、能量效率、连击进度，给出排序与理由；
//     当前精灵劣势明显时建议换上克制对手的队友（「一键执行」返回可直接提交的动作）。
//   - 战斗预测：以当前状态为起点，用种子随机数做 N 次完整模拟（攻方按建议策略、守方按引擎 AI），胜率 = 胜场/N。
//   - 阵容优化：从玩家精灵中按「对每只守方的期望输出/承伤」打分选出 6 只并排序，附克制说明与预测胜率。
//   - 战后复盘：每场战斗结束自动生成（覆盖率 100%），包含评分、克制命中率、能量浪费、错失击倒、建议。
//   - A/B：按用户哈希分流 A（均衡权重）/B（蓄力优先权重），灰度比例可配置；建议与预测写入日志以统计采纳率与准确率。
'use strict';

const crypto = require('crypto');
const engine = require('./engine');
const { TYPE_MATRIX, TYPES } = require('./damage');
const energyMod = require('./energy');

const WEIGHTS = {
  A: { damage: 1.0, ko: 0.8, charge: 0.0, energy: 0.15, combo: 0.35, switch: 0.3 },
  B: { damage: 1.0, ko: 0.8, charge: 0.25, energy: 0.05, combo: 0.35, switch: 0.3 },
};
const STYLE = {
  balanced: { charge: 0, energy: 0 },
  aggressive: { charge: 0.2, energy: -0.05 },
  defensive: { charge: -0.1, energy: 0.1 },
};

class Lru {
  constructor(max) { this.max = max; this.map = new Map(); this.hits = 0; this.misses = 0; }
  get(k) {
    const v = this.map.get(k);
    if (v === undefined) { this.misses++; return undefined; }
    this.hits++;
    this.map.delete(k); this.map.set(k, v);
    return v;
  }
  set(k, v) {
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  stats() { const t = this.hits + this.misses; return { size: this.map.size, hits: this.hits, misses: this.misses, hitRate: t ? Number((this.hits / t).toFixed(4)) : null }; }
}
const adviceCache = new Lru(5000);
const predictCache = new Lru(5000);

function variantFor(userId, percentB = Number(process.env.AI_VARIANT_B_PERCENT || 50)) {
  const h = crypto.createHash('sha1').update(`ai-exp-1:${userId}`).digest().readUInt16BE(0) % 100;
  return h < percentB ? 'B' : 'A';
}

function stateKey(state, extra = '') {
  const a = engine.activeOf(state, 'attacker');
  const d = engine.activeOf(state, 'defender');
  const hist = state.history.map((h) => h.moveId).join(',');
  const teamHp = state.attacker.team.map((c) => c.hp).join(',') + '|' + state.defender.team.map((c) => c.hp).join(',');
  return `${state.id}:${state.turn}:${a.pokemonId}:${a.energy}:${d.pokemonId}:${d.energy}:${teamHp}:${hist}:${extra}`;
}

function typeReason(mult) {
  if (mult >= 2.5) return '双重克制';
  if (mult > 1.01) return '属性克制';
  if (mult < 0.5) return '对方双重抵抗';
  if (mult < 0.99) return '对方抵抗';
  return null;
}

/** 攻方对守方的最佳单技能期望伤害（阵容评分用） */
function bestExpected(att, def, damage, weather) {
  let best = { dmg: 0, move: null };
  for (const m of att.moves) {
    const dmg = damage.expected(att, def, m, weather);
    // 蓄力技能按「每回合」折算：伤害 / (蓄能所需回合 + 1)
    const turns = m.category === 'CHARGE' ? Math.max(1, Math.ceil(m.energyCost / 18)) : 1;
    const perTurn = dmg / turns;
    if (perTurn > best.dmg) best = { dmg: perTurn, move: m };
  }
  return best;
}

/** 攻方在当前状态下的快速决策（模拟时使用，不含理由生成） */
function quickPolicy(state, deps) {
  const att = engine.activeOf(state, 'attacker');
  const def = engine.activeOf(state, 'defender');
  const turn = state.turn + 1;
  let best = null;
  for (const m of att.moves) {
    if (!energyMod.checkMove(att, m.id, { turn }).ok) continue;
    const dmg = deps.damage.expected(att, def, m, state.weather);
    const score = dmg >= def.hp ? 1e6 + dmg : dmg + (m.category === 'FAST' ? m.energyGain * 0.2 : 0);
    if (!best || score > best.score) best = { id: m.id, score };
  }
  return best ? best.id : att.moves[0].id;
}

/**
 * 实时技能建议
 * @returns {{recommendations, switchSuggestion, comboHints, variant}}
 */
function adviseMove(state, deps, { variant = 'A', style = 'balanced' } = {}) {
  const key = stateKey(state, `${variant}:${style}`);
  const cached = adviceCache.get(key);
  if (cached) return { ...cached, cacheHit: true };

  const w = { ...WEIGHTS[variant] || WEIGHTS.A };
  const st = STYLE[style] || STYLE.balanced;
  w.charge += st.charge;
  w.energy += st.energy;
  const att = engine.activeOf(state, 'attacker');
  const def = engine.activeOf(state, 'defender');
  const turn = state.turn + 1;
  const now = Date.now();
  const hints = deps.combos ? deps.combos.progress(state.history, att.moves.map((m) => m.id), { now }) : [];
  const recs = [];
  for (const m of att.moves) {
    const chk = energyMod.checkMove(att, m.id, { turn });
    const dmg = deps.damage.expected(att, def, m, state.weather);
    const mult = deps.damage.typeMultiplier(m.type, def.types);
    let comboMult = 1;
    let comboName = null;
    if (deps.combos) {
      const hit = deps.combos.detect(state.history, m.id, { now, seq: state.seq, attackerTypes: att.types, trainerLevel: state.trainerLevel, lastTriggered: state.comboState.lastTriggered });
      if (hit) { comboMult = hit.multiplier; comboName = hit.chain.name; }
    }
    const expDmg = Math.floor(dmg * comboMult);
    const ko = expDmg >= def.hp;
    const continuesCombo = hints.some((h) => h.nextMove === m.id);
    let score = w.damage * Math.min(1.5, expDmg / Math.max(1, def.hp))
      + (ko ? w.ko : 0)
      + (m.category === 'CHARGE' ? w.charge : 0)
      + (m.category === 'FAST' ? w.energy * (m.energyGain / 10) : 0)
      + (comboName ? w.combo * 1.5 : continuesCombo ? w.combo : 0);
    const reasons = [];
    const tr = typeReason(mult);
    if (tr) reasons.push(`${tr}（×${Number(mult.toFixed(2))}）`);
    if (att.types.includes(m.type)) reasons.push('本系加成 ×1.2');
    if (ko) reasons.push(`预计可击倒 ${def.name}`);
    if (comboName) reasons.push(`完成连击「${comboName}」×${comboMult}`);
    else if (continuesCombo) reasons.push(`继续连击「${hints.find((h) => h.nextMove === m.id).name}」`);
    if (m.category === 'FAST') reasons.push(`回复 ${m.energyGain} 能量`);
    if (!chk.ok) {
      score = -1;
      reasons.unshift(chk.reason === 'COOLDOWN' ? `冷却中（${chk.cooldownLeft} 回合）` : `能量不足（${chk.have}/${chk.need}）`);
    }
    recs.push({ action: 'move', moveId: m.id, name: m.name, category: m.category, ready: chk.ok, expectedDamage: expDmg, knockout: ko, typeMultiplier: Number(mult.toFixed(3)), score: Number(score.toFixed(3)), reasons });
  }
  recs.sort((a, b) => b.score - a.score);

  // 换人建议：当前精灵会被下一击击倒且有更好的克制队友
  let switchSuggestion = null;
  // 下一击威胁：守方当前可用技能中的最大单次伤害；对位评分：双方「每回合」期望输出占对方 HP 的比例之差
  const incoming = Math.max(...def.moves.filter((m) => energyMod.checkMove(def, m.id, { turn }).ok)
    .map((m) => deps.damage.expected(def, att, m, state.weather)), 0);
  const matchup = (c) => bestExpected(c, def, deps.damage, state.weather).dmg / Math.max(1, def.hp)
    - bestExpected(def, c, deps.damage, state.weather).dmg / Math.max(1, c.hp);
  const current = matchup(att);
  if (incoming >= att.hp || current < -0.5) {
    let best = null;
    state.attacker.team.forEach((c) => {
      if (c.hp <= 0 || c.pokemonId === att.pokemonId) return;
      const s = matchup(c);
      if (!best || s > best.s) best = { c, s };
    });
    if (best && best.s > current + w.switch) {
      switchSuggestion = {
        action: 'switch', pokemonId: best.c.pokemonId, name: best.c.name, score: Number(best.s.toFixed(3)),
        reasons: [incoming >= att.hp ? `${att.name} 预计会被下一击击倒` : `${att.name} 对位劣势`, `${best.c.name} 对 ${def.name} 更有利`],
      };
    }
  }
  // 能击倒对手时优先出手，否则面临被击倒/明显劣势时优先换人
  const bestMove = recs.find((r) => r.ready) || null;
  const out = {
    variant, style,
    best: switchSuggestion && !(bestMove && bestMove.knockout) ? switchSuggestion : bestMove,
    recommendations: recs, switchSuggestion,
    comboHints: hints.slice(0, 3),
    defender: { name: def.name, types: def.types, hp: def.hp, maxHp: def.maxHp, weakTo: weaknesses(def.types).slice(0, 3) },
  };
  adviceCache.set(key, out);
  return { ...out, cacheHit: false };
}

/** 守方属性的弱点（按 GO 倍率从高到低） */
function weaknesses(defTypes) {
  return TYPES.map((t) => ({ type: t, multiplier: defTypes.reduce((acc, d) => acc * ((TYPE_MATRIX[t] || {})[d] || 1), 1) }))
    .filter((x) => x.multiplier > 1.01)
    .sort((a, b) => b.multiplier - a.multiplier);
}

/**
 * 蒙特卡洛胜率预测
 * @returns {{winProbability, simulations, expectedTurns, avgRemainingHpRatio}}
 */
function predict(state, deps, { simulations = 24, maxTurns = 150 } = {}) {
  const key = stateKey(state, `p${simulations}`);
  const cached = predictCache.get(key);
  if (cached) return { ...cached, cacheHit: true };
  const t0 = Date.now();
  let wins = 0;
  let turns = 0;
  let hpRatio = 0;
  const base = JSON.stringify(state);
  const simDeps = { ...deps, combos: null };
  for (let i = 0; i < simulations; i++) {
    const s = JSON.parse(base);
    s.rngState = (state.rngState ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
    let now = Date.now();
    let guard = 0;
    while (s.status === 'active' && guard++ < maxTurns) {
      engine.playTurn(s, { moveId: quickPolicy(s, simDeps), now: (now += 1000) }, simDeps);
    }
    if (s.result === 'win') wins++;
    turns += s.turn - state.turn;
    const maxHp = s.attacker.team.reduce((a, c) => a + c.maxHp, 0);
    hpRatio += s.attacker.team.reduce((a, c) => a + c.hp, 0) / Math.max(1, maxHp);
  }
  const out = {
    winProbability: Number((wins / simulations).toFixed(4)), simulations,
    expectedTurns: Number((turns / simulations).toFixed(1)),
    avgRemainingHpRatio: Number((hpRatio / simulations).toFixed(3)),
    computeMs: Date.now() - t0,
  };
  predictCache.set(key, out);
  return { ...out, cacheHit: false };
}

/**
 * 阵容优化：candidates / defenders 为战斗单位
 */
function optimizeLineup(candidates, defenders, deps, { size = 6, weather = null } = {}) {
  const t0 = Date.now();
  const scored = candidates.map((c) => {
    const perDef = defenders.map((d) => {
      const out = bestExpected(c, d, deps.damage, weather);
      const inc = bestExpected(d, c, deps.damage, weather).dmg; // 与输出同口径：每回合期望伤害
      const turnsToKo = out.dmg > 0 ? d.hp / out.dmg : 99;
      const turnsToDie = inc > 0 ? c.hp / inc : 99;
      return { defender: d.name, defenderId: d.pokemonId, bestMove: out.move && out.move.name, advantage: Number((turnsToDie / Math.max(0.5, turnsToKo)).toFixed(3)), typeMultiplier: out.move ? deps.damage.typeMultiplier(out.move.type, d.types) : 1 };
    });
    const avg = perDef.reduce((a, x) => a + Math.min(4, x.advantage), 0) / Math.max(1, perDef.length);
    return { c, perDef, score: avg };
  }).sort((a, b) => b.score - a.score);

  const picked = scored.slice(0, size);
  // 出场顺序：第一位放对第一只守方优势最大的
  if (picked.length > 1 && defenders.length) {
    const firstIdx = picked.reduce((bi, x, i, arr) => (x.perDef[0].advantage > arr[bi].perDef[0].advantage ? i : bi), 0);
    picked.unshift(...picked.splice(firstIdx, 1));
  }
  const team = picked.map((x, i) => {
    const bestVs = [...x.perDef].sort((a, b) => b.advantage - a.advantage)[0];
    const reasons = [];
    if (bestVs && bestVs.typeMultiplier > 1.01) reasons.push(`${bestVs.bestMove} 克制 ${bestVs.defender}`);
    reasons.push(`综合对位评分 ${x.score.toFixed(2)}`);
    if (i === 0) reasons.push(`首发对位 ${defenders[0] ? defenders[0].name : ''}`);
    return { order: i + 1, pokemonId: x.c.pokemonId, name: x.c.name, speciesId: x.c.speciesId, cp: x.c.cp, types: x.c.types, score: Number(x.score.toFixed(3)), reasons, matchups: x.perDef };
  });
  const dims = {
    typeCoverage: new Set(picked.flatMap((x) => x.c.moves.map((m) => m.type))).size,
    avgCp: Math.round(picked.reduce((a, x) => a + x.c.cp, 0) / Math.max(1, picked.length)),
    counters: team.filter((t) => t.matchups.some((m) => m.typeMultiplier > 1.01)).length,
    weakSpots: defenders.filter((d) => !picked.some((x) => x.perDef.find((p) => p.defenderId === d.pokemonId && p.advantage >= 1))).map((d) => d.name),
  };
  return { team, analysis: dims, computeMs: Date.now() - t0 };
}

/**
 * 战后复盘
 * @param trace [{turn, recommended, chosen, koAvailable}]
 */
function reviewBattle(state, sum, trace = []) {
  const attacks = sum.attacks;
  const n = Math.max(1, attacks.length);
  const superEff = attacks.filter((a) => a.effectiveness > 1.01).length;
  const resisted = attacks.filter((a) => a.effectiveness < 0.99).length;
  const missed = attacks.filter((a) => a.missed).length;
  let energyCapped = 0;
  for (const t of state.log) {
    for (const a of t.actions) {
      if (a.type === 'attack' && a.actor === 'attacker' && a.category === 'FAST') {
        const c = state.attacker.team.find((x) => x.pokemonId === a.pokemonId);
        if (c && a.energy >= c.maxEnergy && a.energyDelta === 0) energyCapped++;
      }
    }
  }
  const followed = trace.filter((t) => t.recommended && t.chosen === t.recommended).length;
  const missedKo = trace.filter((t) => t.koAvailable && t.chosen !== t.koAvailable).length;
  let score = 50;
  score += Math.round((superEff / n) * 25) - Math.round((resisted / n) * 15);
  score += Math.min(15, sum.combos.length * 5);
  score -= Math.min(15, energyCapped * 3) + Math.min(15, missedKo * 5) + sum.attackersFainted * 3;
  if (sum.result === 'win') score += 15;
  score = Math.max(0, Math.min(100, score));
  const suggestions = [];
  if (resisted / n > 0.3) suggestions.push('较多攻击被对手抵抗，出战前使用「阵容优化」选择克制属性的精灵');
  if (energyCapped > 0) suggestions.push(`有 ${energyCapped} 次能量已满仍使用快速技能，能量满时应及时释放蓄力技能`);
  if (missedKo > 0) suggestions.push(`错过 ${missedKo} 次可击倒机会，注意蓄力技能的击倒提示`);
  if (!sum.combos.length) suggestions.push('尝试在时间窗口内按顺序释放技能触发连击，获得伤害加成');
  if (sum.attackersFainted >= 2) suggestions.push('精灵被击倒较多，劣势对位时可提前换上克制对手的队友');
  const defTypes = [...new Set(state.defender.team.flatMap((c) => c.types))];
  const counters = weaknesses(defTypes).slice(0, 3).map((x) => x.type);
  if (counters.length) suggestions.push(`面对该阵容推荐属性：${counters.join('、')}`);
  return {
    score, grade: score >= 85 ? 'S' : score >= 70 ? 'A' : score >= 55 ? 'B' : score >= 40 ? 'C' : 'D',
    result: sum.result, turns: sum.turns,
    stats: {
      attacks: attacks.length, superEffectiveRate: Number((superEff / n).toFixed(3)), resistedRate: Number((resisted / n).toFixed(3)),
      missRate: Number((missed / n).toFixed(3)), crits: sum.crits, combos: sum.combos.length, energyWasted: energyCapped,
      missedKnockouts: missedKo, adviceFollowRate: trace.length ? Number((followed / trace.length).toFixed(3)) : null,
      damageDealt: sum.damageDealt, damageTaken: sum.damageTaken, faints: sum.attackersFainted,
    },
    suggestions,
  };
}

function cacheStats() {
  return { advice: adviceCache.stats(), predict: predictCache.stats() };
}

module.exports = { adviseMove, predict, optimizeLineup, reviewBattle, variantFor, weaknesses, quickPolicy, cacheStats, WEIGHTS };
