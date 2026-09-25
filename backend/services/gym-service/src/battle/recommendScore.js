// 技能组合推荐的纯评分逻辑（REQ-00324），不依赖数据库，便于单元测试。
'use strict';

const { TYPE_MATRIX, TYPES } = require('./damage');

const STAB = 1.2;

function grade(ratio) {
  if (ratio >= 0.95) return 'S';
  if (ratio >= 0.85) return 'A';
  if (ratio >= 0.7) return 'B';
  if (ratio >= 0.55) return 'C';
  return 'D';
}

function coverage(types) {
  const out = [];
  for (const def of TYPES) {
    if (types.some((t) => (TYPE_MATRIX[t] || {})[def] > 1.01)) out.push(def);
  }
  return out;
}

/**
 * 纯函数：给定种类属性与候选技能，计算所有组合的得分
 * @param {string[]} speciesTypes 小写属性
 * @param {Array} fastMoves / chargeMoves 规范化技能
 * @param {object} opts { scenario, style, stats: Map('fast|charge' → {battles, wins, avg_damage}) }
 */
function scorePairs(speciesTypes, fastMoves, chargeMoves, { scenario = 'pve', style = 'balanced', stats = new Map() } = {}) {
  const out = [];
  const charges = chargeMoves.length ? chargeMoves : [null];
  for (const f of fastMoves) {
    for (const c of charges) {
      const fStab = speciesTypes.includes(f.type) ? STAB : 1;
      const fDmg = f.power * fStab;
      const fSec = Math.max(0.3, f.durationMs / 1000);
      const eps = f.energyGain / fSec;
      let dps = fDmg / fSec;
      let dpe = 0;
      let cStab = 1;
      if (c) {
        cStab = speciesTypes.includes(c.type) ? STAB : 1;
        const cDmg = c.power * cStab;
        const n = Math.max(1, Math.ceil(c.energyCost / Math.max(1, f.energyGain)));
        const cycleSec = n * fSec + Math.max(0.5, c.durationMs / 1000);
        dps = (n * fDmg + cDmg) / cycleSec;
        dpe = c.energyCost > 0 ? cDmg / c.energyCost : 0;
      }
      const cov = coverage([f.type, c ? c.type : f.type].filter(Boolean));
      let score;
      if (scenario === 'pvp') score = (eps * 1.5 + dpe * 6) * (1 + 0.03 * cov.length);
      else score = dps * (1 + 0.02 * cov.length);
      if (style === 'dps') score *= 1 + dps / 100;
      else if (style === 'energy') score *= 1 + eps / 20;
      else if (style === 'tank') score *= 1 + cov.length / 30;
      const key = `${f.id}|${c ? c.id : ''}`;
      const s = stats.get(key);
      let winRate = null;
      if (s && s.battles >= 5) {
        winRate = s.wins / s.battles;
        score *= 0.8 + 0.4 * winRate;
      }
      out.push({ fast: f, charge: c, score, dps, eps, dpe, coverage: cov, stab: { fast: fStab > 1, charge: cStab > 1 }, sample: s || null, winRate });
    }
  }
  const best = Math.max(...out.map((x) => x.score), 1e-9);
  return out
    .map((x) => ({ ...x, ratio: x.score / best, grade: grade(x.score / best) }))
    .sort((a, b) => b.score - a.score);
}

function reasonsFor(x, scenario) {
  const r = [];
  if (x.stab.fast || x.stab.charge) r.push(`${[x.stab.fast && x.fast.name, x.stab.charge && x.charge && x.charge.name].filter(Boolean).join('、')} 与本系属性相同（伤害 ×1.2）`);
  if (scenario === 'pvp') r.push(`${x.fast.name} 每秒回能 ${x.eps.toFixed(1)}，${x.charge ? `${x.charge.name} 每点能量 ${x.dpe.toFixed(2)} 伤害` : '无蓄力技能'}`);
  else r.push(`循环输出约 ${x.dps.toFixed(1)} 伤害/秒`);
  if (x.coverage.length) r.push(`可克制 ${x.coverage.length} 种属性：${x.coverage.slice(0, 5).join('、')}${x.coverage.length > 5 ? '…' : ''}`);
  if (x.fast.type !== (x.charge && x.charge.type)) r.push('快速与蓄力技能属性不同，覆盖面更广');
  if (x.winRate !== null) r.push(`全服 ${x.sample.battles} 场战斗胜率 ${(x.winRate * 100).toFixed(0)}%`);
  return r;
}

module.exports = { scorePairs, grade, coverage, reasonsFor, STAB };
