// 战斗结算的通用持久化：精灵战绩、技能熟练度、连击记录与统计、技能使用日志、回放、AI 复盘
'use strict';

const { query } = require('../../../../shared/db');
const { createLogger } = require('../../../../shared/logger');
const replay = require('./replay');
const ai = require('./ai');
const battleMetrics = require('./metrics');

const logger = createLogger('battle-settle');

/** 在结算事务内调用：精灵战绩、熟练度、连击、技能日志 */
async function persistBattleStats(client, state, sum) {
  const won = sum.result === 'win';
  for (const c of state.attacker.team) {
    if (!c.pokemonId || String(c.pokemonId).startsWith('bot-')) continue;
    await client.query(`
      INSERT INTO pokemon_battle_stats (pokemon_id, battles_won, battles_lost, total_damage_dealt, total_damage_taken, ko_count, fainted_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (pokemon_id) DO UPDATE SET
        battles_won = pokemon_battle_stats.battles_won + EXCLUDED.battles_won,
        battles_lost = pokemon_battle_stats.battles_lost + EXCLUDED.battles_lost,
        total_damage_dealt = pokemon_battle_stats.total_damage_dealt + EXCLUDED.total_damage_dealt,
        total_damage_taken = pokemon_battle_stats.total_damage_taken + EXCLUDED.total_damage_taken,
        ko_count = pokemon_battle_stats.ko_count + EXCLUDED.ko_count,
        fainted_count = pokemon_battle_stats.fainted_count + EXCLUDED.fainted_count,
        updated_at = NOW()`,
    [c.pokemonId, won ? 1 : 0, won ? 0 : 1, c.damageDealt || 0, c.damageTaken || 0, c.knockouts || 0, c.hp <= 0 ? 1 : 0]);
  }

  // 技能熟练度：每次使用 +1，连击完成技 +2，上限 100（REQ-00299）
  for (const [pokemonId, moves] of Object.entries(sum.masteryGain || {})) {
    for (const [moveId, gain] of Object.entries(moves)) {
      const combos = sum.combos.filter((x) => x.pokemonId === pokemonId).length;
      await client.query(`
        INSERT INTO pokemon_move_mastery (pokemon_id, move_id, mastery, uses, combos)
        VALUES ($1,$2,LEAST(100,$3),$4,$5)
        ON CONFLICT (pokemon_id, move_id) DO UPDATE SET
          mastery = LEAST(100, pokemon_move_mastery.mastery + $3),
          uses = pokemon_move_mastery.uses + $4,
          combos = pokemon_move_mastery.combos + $5,
          updated_at = NOW()`, [pokemonId, moveId, gain, gain, combos]);
    }
  }

  // 连击记录 + 玩家连击统计（排行榜、熟练度加成来源）
  const byChain = new Map();
  for (const cb of sum.combos) {
    await client.query(`INSERT INTO combo_records (user_id, chain_id, pokemon_id, battle_type, quality, damage_dealt, combo_points_earned, battle_id, opponent_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [state.userId, cb.chainId, cb.pokemonId, state.type, cb.quality, cb.damage, cb.comboPoints, state.id, state.meta.opponentUserId || state.meta.gymId || null]);
    const agg = byChain.get(cb.chainId) || { n: 0, perfect: 0, maxDmg: 0, points: 0 };
    agg.n++;
    if (cb.quality === 'perfect') agg.perfect++;
    agg.maxDmg = Math.max(agg.maxDmg, cb.damage);
    agg.points += cb.comboPoints;
    byChain.set(cb.chainId, agg);
    battleMetrics.combosTriggered.inc({ chain: cb.chainId, quality: cb.quality, mode: state.mode });
  }
  for (const [chainId, a] of byChain) {
    await client.query(`
      INSERT INTO user_combo_stats (user_id, chain_id, times_executed, perfect_executions, last_executed_at, highest_damage_dealt, total_points)
      VALUES ($1,$2,$3,$4,NOW(),$5,$6)
      ON CONFLICT (user_id, chain_id) DO UPDATE SET
        times_executed = user_combo_stats.times_executed + EXCLUDED.times_executed,
        perfect_executions = user_combo_stats.perfect_executions + EXCLUDED.perfect_executions,
        last_executed_at = NOW(),
        highest_damage_dealt = GREATEST(user_combo_stats.highest_damage_dealt, EXCLUDED.highest_damage_dealt),
        total_points = user_combo_stats.total_points + EXCLUDED.total_points,
        updated_at = NOW()`, [state.userId, chainId, a.n, a.perfect, a.maxDmg, a.points]);
  }

  // 技能使用日志（技能推荐的数据来源）
  if (sum.attacks.length) {
    const team = new Map(state.attacker.team.map((c) => [c.pokemonId, c]));
    const vals = [];
    const params = [];
    for (const a of sum.attacks) {
      const c = team.get(a.pokemonId) || {};
      const fast = (c.moves || []).find((m) => m.category === 'FAST');
      const charge = (c.moves || []).find((m) => m.category === 'CHARGE');
      const b = params.length;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13})`);
      params.push(state.id, state.type, state.userId, String(a.pokemonId).startsWith('bot-') ? null : a.pokemonId, c.speciesId || null,
        fast ? fast.id : null, charge ? charge.id : null, a.move, a.damage, a.effectiveness, !!a.isCritical, a.combo ? a.combo.chainId : null, sum.result);
    }
    await client.query(`INSERT INTO battle_move_logs (battle_id, battle_type, user_id, pokemon_id, species_id, fast_move, charge_move, move_id, damage, effectiveness, is_crit, combo_chain, result)
      VALUES ${vals.join(',')}`, params);
  }
}

/**
 * 事务提交后的收尾：回放录制、AI 复盘、AI 日志回填实际结果。任何一步失败都不影响已结算的结果。
 */
async function afterSettle(state, sum, { gymId = null, opponentUserId = null, labels = {} } = {}) {
  const out = { replayId: null, highlights: [], review: null };
  try {
    const r = await replay.recordReplay(state, sum, { gymId, opponentUserId, labels });
    out.replayId = r.replayId;
    out.highlights = r.highlights.map((h) => ({ type: h.highlightType, title: h.title, turn: h.startTurn, severity: h.severity }));
    out.replaySizeBytes = r.sizeBytes;
  } catch (err) {
    logger.error({ err, battleId: state.id }, 'record replay failed');
  }
  try {
    const review = ai.reviewBattle(state, sum, (state.meta.ai && state.meta.ai.trace) || []);
    await query(`INSERT INTO battle_ai_reviews (battle_id, user_id, battle_type, result, score, review)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (battle_id) DO NOTHING`, [state.id, state.userId, state.type, sum.result, review.score, JSON.stringify(review)]);
    out.review = review;
  } catch (err) {
    logger.error({ err, battleId: state.id }, 'battle review failed');
  }
  try {
    await query('UPDATE battle_ai_advice_logs SET actual_result = $2 WHERE battle_id = $1', [state.id, sum.result]);
  } catch (err) {
    logger.warn({ err }, 'update advice logs failed');
  }
  battleMetrics.battlesFinished.inc({ type: state.type, result: sum.result });
  return out;
}

module.exports = { persistBattleStats, afterSettle };
