/**
 * 羁绊技能规则（REQ-00151，纯函数）
 *
 * - 亲密度原值 0~255（pokemon_instances.friendship，进化条件 220 同一尺度）；
 *   羁绊等级 0~100 = floor(亲密度 × 100 / 255)，槽位解锁：1 槽 ≥20（友好）、2 槽 ≥50（亲密）、3 槽 ≥90（牵绊）
 * - 羁绊加成公式（bond_skill_definitions.friendship_bonus_formula）用安全的表达式求值器计算，不用 eval：
 *     "65 + floor(friendship * 0.5)"                 → 威力
 *     "120, crit_bonus: friendship / 255"            → 威力 + 额外效果
 *     "shield_hp: floor(friendship * 8)"             → 只有额外效果
 *     "floor(friendship * 10)"（威力为 0 的辅助技能）→ 效果值
 *   变量：friendship（原值）、bond_level（0~100）；函数：floor/ceil/round/min/max；true/false
 */
'use strict';

const SLOT_THRESHOLDS = Object.freeze({ 1: 20, 2: 50, 3: 90 });
const MAX_ACTIVE = 1;

function bondLevel(friendship) {
  const f = Math.min(255, Math.max(0, Math.trunc(Number(friendship) || 0)));
  return Math.floor((f * 100) / 255);
}

/** 亲密度原值达到某羁绊等级所需的最小值 */
function friendshipForBondLevel(level) {
  return Math.ceil((Math.max(0, Number(level) || 0) * 255) / 100);
}

// ───────────── 安全表达式求值（递归下降） ─────────────
const FUNCS = Object.freeze(Object.assign(Object.create(null), { floor: Math.floor, ceil: Math.ceil, round: Math.round, min: Math.min, max: Math.max }));

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\S))/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    const start = re.lastIndex;
    m = re.exec(src);
    if (!m) break;
    if (m[1] != null) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] != null) tokens.push({ t: 'id', v: m[2] });
    else if (m[3] != null) tokens.push({ t: 'op', v: m[3] });
    if (re.lastIndex === start) break;
  }
  return tokens;
}

function evaluate(expr, vars) {
  const tokens = tokenize(String(expr));
  let i = 0;
  const peek = () => tokens[i];
  const take = (v) => {
    const tk = tokens[i];
    if (!tk || (v && tk.v !== v)) throw new Error(`公式语法错误：${expr}`);
    i++;
    return tk;
  };
  const primary = () => {
    const tk = take();
    if (tk.t === 'num') return tk.v;
    if (tk.t === 'op' && tk.v === '(') { const v = sum(); take(')'); return v; }
    if (tk.t === 'op' && tk.v === '-') return -primary();
    if (tk.t === 'id') {
      if (tk.v === 'true') return true;
      if (tk.v === 'false') return false;
      if (Object.prototype.hasOwnProperty.call(FUNCS, tk.v)) {
        take('(');
        const args = [sum()];
        while (peek() && peek().v === ',') { take(','); args.push(sum()); }
        take(')');
        return FUNCS[tk.v](...args);
      }
      if (Object.prototype.hasOwnProperty.call(vars, tk.v)) return Number(vars[tk.v]);
      throw new Error(`公式包含未知变量：${tk.v}`);
    }
    throw new Error(`公式语法错误：${expr}`);
  };
  const product = () => {
    let v = primary();
    while (peek() && (peek().v === '*' || peek().v === '/')) {
      const op = take().v;
      const r = primary();
      v = op === '*' ? v * r : (r === 0 ? 0 : v / r);
    }
    return v;
  };
  const sum = () => {
    let v = product();
    while (peek() && (peek().v === '+' || peek().v === '-')) {
      const op = take().v;
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  if (i !== tokens.length) throw new Error(`公式语法错误：${expr}`);
  return v;
}

/** 按顶层逗号拆分（括号内的逗号是函数参数） */
function splitTop(formula) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(formula)) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * 计算羁绊技能在当前亲密度下的实际效果
 * @param {object} def bond_skill_definitions 行
 * @param {number} friendship 亲密度原值
 */
function computeEffect(def, friendship) {
  const vars = { friendship: Math.min(255, Math.max(0, Number(friendship) || 0)), bond_level: bondLevel(friendship) };
  const base = Number(def.power) || 0;
  let power = base;
  let effectValue = null;
  const extra = {};
  if (def.friendship_bonus_formula) {
    for (const part of splitTop(def.friendship_bonus_formula)) {
      const kv = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/);
      if (kv) {
        const v = evaluate(kv[2], vars);
        extra[kv[1]] = typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
      } else {
        const v = Math.floor(Number(evaluate(part, vars)) || 0);
        if (base > 0) power = Math.max(base, v); else effectValue = v;
      }
    }
  }
  return {
    skillId: def.id,
    name: def.skill_name,
    type: def.type,
    effectType: def.effect_type || (base > 0 ? 'damage' : 'buff'),
    basePower: base,
    power,
    effectValue,
    accuracy: def.accuracy,
    energyCost: def.energy_cost,
    cooldownTurns: def.cooldown_turns,
    additionalEffects: extra,
    friendship: vars.friendship,
    bondLevel: vars.bond_level,
  };
}

/** 技能解锁/学习状态 */
function skillStatus(def, friendship, learned) {
  const level = bondLevel(friendship);
  const required = Number(def.unlock_friendship_level) || SLOT_THRESHOLDS[def.slot] || 0;
  return {
    isUnlocked: level >= required,
    isLearned: !!learned,
    bondLevelRequired: required,
    bondLevelCurrent: level,
    friendshipRequired: friendshipForBondLevel(required),
    friendshipGap: Math.max(0, friendshipForBondLevel(required) - (Number(friendship) || 0)),
  };
}

module.exports = { SLOT_THRESHOLDS, MAX_ACTIVE, bondLevel, friendshipForBondLevel, evaluate, splitTop, computeEffect, skillStatus };
