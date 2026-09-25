// 技能组合推荐（REQ-00324）
//
// 对某个精灵种类的每一对（快速技能, 蓄力技能）评分：
//   PVE / 道馆 / 团战：循环 DPS = (n×快速伤害 + 蓄力伤害) / (n×快速时长 + 蓄力时长)，n = ceil(蓄力消耗 / 快速回能)
//   PVP（联赛）：回能速度（能量/秒）+ 蓄力技能每能量伤害，蓄力越便宜越好
//   属性覆盖：两技能能克制的属性数量加成；本系（STAB）×1.2
//   数据驱动：move_recommendation_stats（由 battle_move_logs 每周聚合）中样本 ≥ 5 场时按胜率修正 ±20%
// 评分归一化到该种类最佳组合：≥0.95 S、≥0.85 A、≥0.70 B、≥0.55 C，其余 D；每条推荐附可读理由。
'use strict';

const { query } = require('../../../../shared/db');
const { getRedis } = require('../../../../shared/redis');
const { createLogger } = require('../../../../shared/logger');
const repo = require('./repo');
const { TYPE_MATRIX, TYPES } = require('./damage');
const { BattleError } = require('./engine');

const logger = createLogger('move-recommend');
const SCENARIOS = ['pve', 'pvp', 'gym', 'raid'];
const STYLES = ['balanced', 'dps', 'tank', 'energy'];
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
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

async function recommend(speciesId, { scenario = 'pve', style = 'balanced', limit = 5 } = {}) {
  const sid = Number(speciesId);
  if (!Number.isInteger(sid) || sid <= 0) throw new BattleError('INVALID_ID', '精灵种类 ID 无效', 400);
  const sc = SCENARIOS.includes(scenario) ? scenario : 'pve';
  const st = STYLES.includes(style) ? style : 'balanced';
  const key = `${sid}|${sc}|${st}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return { ...hit.value, recommendations: hit.value.recommendations.slice(0, limit), cached: true };

  const { rows: [sp] } = await query('SELECT id, name_zh, type1::text AS type1, type2::text AS type2 FROM pokemon_species WHERE id = $1', [sid]);
  if (!sp) throw new BattleError('SPECIES_NOT_FOUND', '精灵种类不存在', 404);
  const moves = await repo.getMoves();
  const learn = (await repo.getLearnsets([sid])).get(sid) || [];
  const fast = [];
  const charge = [];
  for (const l of learn) {
    const m = moves.get(l.move_id);
    if (!m || (fast.includes(m) || charge.includes(m))) continue;
    (m.category === 'FAST' ? fast : charge).push(m);
  }
  if (!fast.length) throw new BattleError('NO_LEARNSET', '该精灵没有可学习的技能数据', 404);
  const scenarioStats = sc === 'pve' ? ['pve', 'gym'] : [sc];
  const { rows: statRows } = await query(`SELECT fast_move, charge_move, SUM(battles)::int AS battles, SUM(wins)::int AS wins, AVG(avg_damage) AS avg_damage
      FROM move_recommendation_stats WHERE species_id = $1 AND scenario = ANY($2::text[]) GROUP BY fast_move, charge_move`, [sid, scenarioStats]);
  const stats = new Map(statRows.map((r) => [`${r.fast_move}|${r.charge_move}`, r]));
  const types = [sp.type1, sp.type2].filter(Boolean).map((t) => t.toLowerCase());
  const scored = scorePairs(types, fast, charge, { scenario: sc, style: st, stats });
  const value = {
    speciesId: sid, name: sp.name_zh, types, scenario: sc, style: st,
    dataSamples: statRows.reduce((a, r) => a + r.battles, 0),
    recommendations: scored.map((x, i) => ({
      rank: i + 1, grade: x.grade, score: Number((x.ratio * 100).toFixed(1)),
      fastMove: { id: x.fast.id, name: x.fast.name, type: x.fast.type },
      chargeMove: x.charge ? { id: x.charge.id, name: x.charge.name, type: x.charge.type } : null,
      metrics: { dps: Number(x.dps.toFixed(2)), energyPerSec: Number(x.eps.toFixed(2)), damagePerEnergy: Number(x.dpe.toFixed(3)), coverage: x.coverage.length, winRate: x.winRate },
      reasons: reasonsFor(x, sc),
    })),
  };
  cache.set(key, { at: Date.now(), value });
  return { ...value, recommendations: value.recommendations.slice(0, limit), cached: false };
}

/** 从战斗技能日志聚合推荐数据（每周任务 / 管理员手动触发） */
async function aggregate() {
  const t0 = Date.now();
  const { rowCount } = await query(`
    INSERT INTO move_recommendation_stats (species_id, fast_move, charge_move, scenario, battles, wins, avg_damage, updated_at)
    SELECT species_id, fast_move, charge_move,
           CASE battle_type WHEN 'league' THEN 'pvp' WHEN 'raid' THEN 'raid' WHEN 'gym' THEN 'gym' ELSE 'pve' END AS scenario,
           COUNT(DISTINCT battle_id)::int,
           COUNT(DISTINCT battle_id) FILTER (WHERE result = 'win')::int,
           ROUND(AVG(damage)::numeric, 2), NOW()
      FROM battle_move_logs
     WHERE species_id IS NOT NULL AND fast_move IS NOT NULL AND charge_move IS NOT NULL
       AND created_at > NOW() - INTERVAL '90 days'
     GROUP BY 1, 2, 3, 4
    ON CONFLICT (species_id, fast_move, charge_move, scenario) DO UPDATE SET
      battles = EXCLUDED.battles, wins = EXCLUDED.wins, avg_damage = EXCLUDED.avg_damage, updated_at = NOW()`);
  cache.clear();
  try { await getRedis().set('battle:reco:aggregated_at', String(Date.now())); } catch { /* ignore */ }
  const out = { rows: rowCount, ms: Date.now() - t0, at: new Date().toISOString() };
  logger.info(out, 'move recommendation stats aggregated');
  return out;
}

let timer = null;
const WEEK_MS = 7 * 24 * 3600 * 1000;
function startScheduler() {
  if (timer) return;
  const tick = async () => {
    try {
      const last = Number(await getRedis().get('battle:reco:aggregated_at')) || 0;
      if (Date.now() - last >= WEEK_MS) await aggregate();
    } catch (err) { logger.warn({ err }, 'recommendation aggregation failed'); }
  };
  setTimeout(tick, 30 * 1000).unref();
  timer = setInterval(tick, 6 * 3600 * 1000);
  timer.unref();
}

async function getPreferences(userId) {
  const { rows: [p] } = await query('SELECT scenario, style, updated_at FROM move_recommendation_preferences WHERE user_id = $1', [userId]);
  return p || { scenario: 'pve', style: 'balanced', updated_at: null };
}

async function setPreferences(userId, body = {}) {
  const scenario = SCENARIOS.includes(body.scenario) ? body.scenario : 'pve';
  const style = STYLES.includes(body.style) ? body.style : 'balanced';
  const { rows: [p] } = await query(`INSERT INTO move_recommendation_preferences (user_id, scenario, style) VALUES ($1,$2,$3)
      ON CONFLICT (user_id) DO UPDATE SET scenario = EXCLUDED.scenario, style = EXCLUDED.style, updated_at = NOW()
      RETURNING scenario, style, updated_at`, [userId, scenario, style]);
  return p;
}

module.exports = { recommend, aggregate, scorePairs, grade, coverage, startScheduler, getPreferences, setPreferences, SCENARIOS, STYLES };
