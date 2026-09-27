/**
 * 玩家数据聚合与收藏家积分（REQ-00327 ProfileStatsService）
 *
 * 一次查询聚合捕捉/战斗/社交/探索/图鉴统计（各表均按 user_id 走索引），成就按稀有度计数；
 * refreshCollectorScore 计算收藏家积分写入 collector_scores（排行榜读取），达到 5 级时发放专属称号并发消息。
 * 由资料接口（缓存未命中时）与成就引擎（捕捉/孵化/成就解锁后）调用。
 */
'use strict';

const rules = require('./profileRules');
const center = require('./notificationCenter');

function defaultDb() { return require('./db'); }

const STATS_SQL = `
SELECT u.id, u.nickname, u.avatar_url, u.level, u.xp, u.team::text AS team, u.created_at, u.last_active_at,
       COALESCE(u.total_distance_km, 0)::float AS km_walked,
       (SELECT COUNT(*) FROM catch_sessions WHERE user_id = u.id AND result = 'CAUGHT')::int AS total_caught,
       (SELECT COUNT(*) FROM pokedex_entries WHERE user_id = u.id AND caught_count > 0)::int AS unique_species,
       (SELECT COUNT(*) FROM pokedex_entries WHERE user_id = u.id AND (seen_count > 0 OR caught_count > 0))::int AS seen_species,
       (SELECT COUNT(*) FROM pokemon_species)::int AS total_species,
       (SELECT COUNT(*) FROM pokemon_instances WHERE user_id = u.id AND is_shiny AND NOT COALESCE(is_released, FALSE))::int AS shiny_count,
       (SELECT COUNT(*) FROM pokemon_instances WHERE user_id = u.id AND NOT COALESCE(is_released, FALSE)
               AND (COALESCE(is_perfect_iv, FALSE) OR (iv_attack = 15 AND iv_defense = 15 AND iv_hp = 15)))::int AS perfect_iv,
       (SELECT COALESCE(MAX(cp), 0) FROM pokemon_instances WHERE user_id = u.id AND NOT COALESCE(is_released, FALSE))::int AS highest_cp,
       (SELECT json_build_object('id', ps.id, 'zh', ps.name_zh, 'en', ps.name_en, 'ja', ps.name_ja, 'count', pe.caught_count)
          FROM pokedex_entries pe JOIN pokemon_species ps ON ps.id = pe.species_id
         WHERE pe.user_id = u.id AND pe.caught_count > 0 ORDER BY pe.caught_count DESC, pe.species_id LIMIT 1) AS favorite_species,
       (SELECT COUNT(*) FROM gym_battles WHERE COALESCE(attacker_user_id, attacker_id) = u.id)::int AS gym_battles,
       (SELECT COUNT(*) FROM gym_battles WHERE COALESCE(attacker_user_id, attacker_id) = u.id AND result = 'WIN')::int AS gym_wins,
       (SELECT COUNT(*) FROM raid_participants WHERE user_id = u.id)::int AS raid_participated,
       (SELECT COUNT(*) FROM raid_participants rp JOIN raids r ON r.id = rp.raid_id
         WHERE rp.user_id = u.id AND (rp.caught_boss OR r.status = 'COMPLETED'))::int AS raid_wins,
       (SELECT COUNT(*) FROM gym_defenders WHERE user_id = u.id)::int AS current_gym_defenders,
       (SELECT COUNT(*) FROM pvp_battles WHERE winner_id = u.id)::int AS pvp_wins,
       GREATEST((SELECT COUNT(*) FROM friendships WHERE user_a = u.id OR user_b = u.id),
                (SELECT COUNT(*) FROM friends WHERE user_id = u.id AND (status IS NULL OR status IN ('accepted', 'active'))))::int AS friends_count,
       (SELECT COUNT(*) FROM friend_gifts WHERE COALESCE(sender_id, from_user_id) = u.id)::int AS gifts_sent,
       (SELECT COUNT(*) FROM friend_gifts WHERE COALESCE(receiver_id, to_user_id) = u.id)::int AS gifts_received,
       (SELECT COUNT(*) FROM pokemon_trades WHERE status = 'COMPLETED' AND (initiator_id = u.id OR receiver_id = u.id))::int AS trades_completed,
       (SELECT COUNT(*) FROM pokestop_spins WHERE user_id = u.id)::int AS pokestops_visited,
       (SELECT COUNT(DISTINCT (ROUND(caught_lat, 1), ROUND(caught_lng, 1))) FROM pokemon_instances
         WHERE user_id = u.id AND caught_lat IS NOT NULL AND caught_lng IS NOT NULL)::int AS regions_explored,
       (SELECT COUNT(*) FROM pokemon_instances pi JOIN pokemon_species ps ON ps.id = pi.species_id
         WHERE pi.user_id = u.id AND ps.rarity IN ('RARE', 'EPIC', 'LEGENDARY'))::int AS rare_encounters
  FROM users u WHERE u.id = $1`;

const ACH_SQL = `
SELECT a.rarity, COUNT(*) FILTER (WHERE ua.completed)::int AS unlocked, COUNT(*)::int AS total,
       COALESCE(SUM(a.points) FILTER (WHERE ua.completed), 0)::int AS points
  FROM achievements a LEFT JOIN user_achievements ua ON ua.achievement_id = a.achievement_id AND ua.user_id = $1
 WHERE a.is_active AND (NOT a.is_hidden OR ua.completed)
 GROUP BY a.rarity`;

/** 原始聚合（不做隐私过滤） */
async function aggregate(userId, q = defaultDb()) {
  const [{ rows: [u] }, { rows: ach }] = await Promise.all([q.query(STATS_SQL, [userId]), q.query(ACH_SQL, [userId])]);
  if (!u) return null;
  const byRarity = {};
  let unlocked = 0; let total = 0; let points = 0;
  for (const r of ach) { byRarity[r.rarity] = r.unlocked; unlocked += r.unlocked; total += r.total; points += r.points; }
  return { u, achievements: { unlocked, total, points, byRarity } };
}

function scoreInput(agg) {
  return {
    uniqueSpecies: agg.u.unique_species, shinyCount: agg.u.shiny_count, perfectIvCount: agg.u.perfect_iv,
    pokedexCaught: agg.u.unique_species, pokedexTotal: agg.u.total_species, achievementsByRarity: agg.achievements.byRarity,
  };
}

/**
 * 计算并保存收藏家积分；首次达到 5 级时发放"传奇收藏家"称号
 * @returns {Promise<{score:number, level:number, breakdown:object}|null>}
 */
async function refreshCollectorScore(userId, q = defaultDb(), agg = null) {
  const a = agg || await aggregate(userId, q);
  if (!a) return null;
  const { score, breakdown } = rules.computeCollectorScore(scoreInput(a));
  const level = rules.collectorLevel(score).level;
  const { rows: [prev] } = await q.query('SELECT score, rank FROM collector_scores WHERE user_id = $1', [userId]);
  if (!prev || prev.score !== score || prev.rank !== level) {
    await q.query(
      `INSERT INTO collector_scores (user_id, score, rank, score_breakdown, last_updated) VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET score = EXCLUDED.score, rank = EXCLUDED.rank,
         score_breakdown = EXCLUDED.score_breakdown, last_updated = NOW()`, [userId, score, level, JSON.stringify(breakdown)]);
  }
  if (level >= 5) {
    const { rows } = await q.query(
      `INSERT INTO user_titles (user_id, title_id, source_type, source_id)
       SELECT $1, title_id, 'milestone', 'collector_level_5' FROM title_definitions WHERE title_id = 'legendary_collector' AND is_active
       ON CONFLICT (user_id, title_id) DO NOTHING RETURNING title_id`, [userId]);
    if (rows.length) {
      await center.notify(q, userId, {
        type: 'reward.title_unlock', templateKey: 'title_unlocked', category: 'reward', priority: 'normal',
        params: { title_name: '传奇收藏家', _i18n: { 'en-US': { title_name: 'Legendary Collector' }, 'ja-JP': { title_name: '伝説のコレクター' } } },
        data: { titleId: 'legendary_collector' }, actionUrl: '/titles', dedupeKey: 'title:legendary_collector',
      });
    }
  }
  return { score, level, breakdown, changed: !prev || prev.score !== score };
}

module.exports = { aggregate, refreshCollectorScore, scoreInput, STATS_SQL };
