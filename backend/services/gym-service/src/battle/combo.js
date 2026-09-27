// 技能连击链判定（REQ-00143 / REQ-00288 / REQ-00311 / REQ-00364）
//
// 连击链配置来自 combo_chains：trigger_sequence 为技能 ID 序列，time_window_ms 为完成窗口。
// 判定规则：
//   - 攻击方最近 N 次行动（本次技能计入）与 trigger_sequence 完全一致且为连续行动（中间无其他技能/换人）；
//   - 从第一个技能到本次技能的真实耗时 ≤ time_window_ms；
//   - 攻方属性满足 element_requirement，训练师等级 ≥ min_trainer_level；
//   - 同一连击链触发后，下一次同名连击的起手技能须在 chain_cooldown_turns 次行动之后（连击冷却）。
// 质量：耗时/窗口 < 0.5 完美（×1.25）、< 0.8 优秀（×1.1）、其余普通（×1.0）；
// 熟练度：该玩家此前完成次数 × 1%，最多 +20%；最终倍率上限 3.0。
'use strict';

const QUALITY = [
  { name: 'perfect', below: 0.5, factor: 1.25 },
  { name: 'excellent', below: 0.8, factor: 1.1 },
  { name: 'normal', below: Infinity, factor: 1.0 },
];
const MAX_MULTIPLIER = 3.0;
const MASTERY_STEP = 0.01;
const MASTERY_MAX = 0.2;

const STATUS_NAME_TO_CODE = {
  paralyzed: 'STUN', paralysis: 'STUN', stun: 'STUN', sleep: 'STUN',
  burn: 'BURN', burned: 'BURN', frozen: 'FREEZE', freeze: 'FREEZE',
  poison: 'POISON', poisoned: 'POISON', confuse: 'CONFUSE', confused: 'CONFUSE',
};

function parseJson(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
  return v;
}

function normalizeChain(row) {
  return {
    chainId: row.chain_id,
    name: row.name,
    description: row.description || '',
    sequence: parseJson(row.trigger_sequence, []),
    windowMs: Number(row.time_window_ms) || 5000,
    element: row.element_requirement ? String(row.element_requirement).toLowerCase() : null,
    damageMultiplier: Number(row.damage_multiplier) || 1,
    bonus: parseJson(row.bonus_effects, {}) || {},
    cooldownReduction: Number(row.cooldown_reduction) || 0,
    comboPoints: Number(row.combo_points) || 0,
    xpBonus: Number(row.xp_bonus) || 0,
    minTrainerLevel: Number(row.min_trainer_level) || 1,
    chainCooldown: row.chain_cooldown_turns === undefined || row.chain_cooldown_turns === null ? 3 : Number(row.chain_cooldown_turns),
    active: row.is_active !== false,
  };
}

function qualityOf(elapsedMs, windowMs) {
  const ratio = windowMs > 0 ? elapsedMs / windowMs : 1;
  return QUALITY.find((q) => ratio < q.below);
}

/** 解析连击奖励效果 */
function effectsOf(chain) {
  const b = chain.bonus || {};
  let status = null;
  if (typeof b.status === 'string') status = STATUS_NAME_TO_CODE[b.status.toLowerCase()] || b.status.toUpperCase();
  else if (b.burn) status = 'BURN';
  else if (b.sleep) status = 'STUN';
  return {
    status,
    damageBoostPct: Number(b.damage_boost) || 0,
    ignoreDefensePct: Math.min(50, Number(b.ignore_defense) || 0),
    critBoostPct: Number(b.crit_rate_boost) || 0,
    energyRefund: Number(b.energy_refund) || 0,
    healPct: Number(b.heal_pct) || 0,
    cooldownReductionPct: chain.cooldownReduction,
  };
}

class ComboDetector {
  constructor(chainRows = []) {
    this.setChains(chainRows);
  }

  setChains(rows) {
    this.chains = rows.map((r) => (r.chainId ? r : normalizeChain(r))).filter((c) => c.active && c.sequence.length >= 2);
    this.byLastMove = new Map();
    for (const c of this.chains) {
      const last = c.sequence[c.sequence.length - 1];
      if (!this.byLastMove.has(last)) this.byLastMove.set(last, []);
      this.byLastMove.get(last).push(c);
    }
  }

  get(chainId) {
    return this.chains.find((c) => c.chainId === chainId) || null;
  }

  /**
   * 判断本次技能是否完成连击
   * @param {Array<{moveId, at, seq}>} history  攻方此前的连续行动（换人/被打断时由调用方清空）
   * @param {string} moveId   本次技能
   * @param {object} ctx { now, seq, attackerTypes, trainerLevel, lastTriggered: {chainId: seq}, masteryCounts: {chainId: n} }
   * @returns {null | {chain, quality, elapsedMs, multiplier, effects, masteryBonus}}
   */
  detect(history, moveId, ctx = {}) {
    const candidates = this.byLastMove.get(moveId);
    if (!candidates) return null;
    const now = ctx.now || Date.now();
    const seq = ctx.seq || 0;
    const types = (ctx.attackerTypes || []).map((t) => String(t).toLowerCase());
    let best = null;
    for (const chain of candidates) {
      const n = chain.sequence.length;
      if (history.length < n - 1) continue;
      const tail = history.slice(-(n - 1));
      let ok = true;
      for (let i = 0; i < n - 1; i++) {
        if (tail[i].moveId !== chain.sequence[i]) { ok = false; break; }
        // 必须为连续行动
        if (i > 0 && tail[i].seq !== tail[i - 1].seq + 1) { ok = false; break; }
      }
      if (!ok) continue;
      if (tail.length && tail[tail.length - 1].seq !== seq - 1) continue;
      const elapsedMs = now - tail[0].at;
      if (elapsedMs > chain.windowMs) continue;
      if (chain.element && !types.includes(chain.element)) continue;
      if ((ctx.trainerLevel || 1) < chain.minTrainerLevel) continue;
      // 连击冷却：上次触发后至少间隔 chainCooldown 次行动，才能开始下一次同名连击
      const last = (ctx.lastTriggered || {})[chain.chainId];
      const startSeq = tail.length ? tail[0].seq : seq;
      if (last !== undefined && startSeq - last <= chain.chainCooldown) continue;
      const quality = qualityOf(elapsedMs, chain.windowMs);
      const masteryBonus = Math.min(MASTERY_MAX, ((ctx.masteryCounts || {})[chain.chainId] || 0) * MASTERY_STEP);
      const effects = effectsOf(chain);
      const multiplier = Math.min(MAX_MULTIPLIER,
        chain.damageMultiplier * quality.factor * (1 + masteryBonus) * (1 + effects.damageBoostPct / 100));
      const result = { chain, quality: quality.name, qualityFactor: quality.factor, elapsedMs, multiplier: Number(multiplier.toFixed(3)), effects, masteryBonus };
      if (!best || result.multiplier > best.multiplier || (result.multiplier === best.multiplier && chain.comboPoints > best.chain.comboPoints)) {
        best = result;
      }
    }
    return best;
  }

  /** 连击提示：当前序列可继续的连击链及下一步技能（前端连击提示 / AI 使用） */
  progress(history, availableMoveIds = null, ctx = {}) {
    const now = ctx.now || Date.now();
    const out = [];
    for (const chain of this.chains) {
      if (availableMoveIds && !chain.sequence.every((m) => availableMoveIds.includes(m))) continue;
      const n = chain.sequence.length;
      // 最长的「序列前缀 == 历史后缀」
      for (let k = Math.min(n - 1, history.length); k >= 1; k--) {
        const tail = history.slice(-k);
        if (tail.every((h, i) => h.moveId === chain.sequence[i] && (i === 0 || h.seq === tail[i - 1].seq + 1))) {
          const remainingMs = chain.windowMs - (now - tail[0].at);
          if (remainingMs > 0) {
            out.push({ chainId: chain.chainId, name: chain.name, matched: k, total: n, nextMove: chain.sequence[k], remainingMs, damageMultiplier: chain.damageMultiplier });
          }
          break;
        }
      }
    }
    return out.sort((a, b) => b.matched / b.total - a.matched / a.total || b.damageMultiplier - a.damageMultiplier);
  }

  /** 精灵已掌握技能可完成的连击链（连击推荐 / 图鉴） */
  achievable(moveIds, { types = [], trainerLevel = 50 } = {}) {
    const t = types.map((x) => String(x).toLowerCase());
    return this.chains
      .map((c) => {
        const missing = [...new Set(c.sequence.filter((m) => !moveIds.includes(m)))];
        const elementOk = !c.element || t.includes(c.element);
        return { chainId: c.chainId, name: c.name, sequence: c.sequence, windowMs: c.windowMs, damageMultiplier: c.damageMultiplier,
          comboPoints: c.comboPoints, minTrainerLevel: c.minTrainerLevel, element: c.element, missing, elementOk,
          unlocked: trainerLevel >= c.minTrainerLevel, ready: !missing.length && elementOk && trainerLevel >= c.minTrainerLevel };
      })
      .sort((a, b) => a.missing.length - b.missing.length || b.damageMultiplier - a.damageMultiplier);
  }

  /**
   * 练习模式：给定 [{moveId, atMs}] 序列，逐步判定（无奖励、无冷却限制）
   */
  practice(steps, ctx = {}) {
    const history = [];
    const results = [];
    const base = Date.now();
    steps.forEach((s, i) => {
      const at = base + (Number(s.atMs) || 0);
      const hit = this.detect(history, s.moveId, { ...ctx, now: at, seq: i, lastTriggered: {} });
      results.push({ step: i, moveId: s.moveId, combo: hit ? { chainId: hit.chain.chainId, name: hit.chain.name, quality: hit.quality, multiplier: hit.multiplier, elapsedMs: hit.elapsedMs } : null });
      if (hit) history.length = 0;
      else history.push({ moveId: s.moveId, at, seq: i });
    });
    return results;
  }
}

module.exports = { ComboDetector, normalizeChain, qualityOf, effectsOf, QUALITY, MAX_MULTIPLIER };
