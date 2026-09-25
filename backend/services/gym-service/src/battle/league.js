// 精灵竞技联赛（REQ-00487）
//
// - 等级：青铜/白银/黄金/铂金/钻石/大师（shared/LeagueConstants），每级 1000 分、分 III→II→I 三组（大师仅 I 组）
// - 新玩家：青铜 III、0 积分、真实评分 1000
// - 赛季 28 天，到期自动结算（按最终段位发放赛季奖励）并开启下一赛季
// - 对局：异步 PvP——匹配同段位 ±1 分组、评分差 ±200 的对手，与其防守队伍（battle_teams 默认队伍，否则 CP 最高 3 只）
//   进行回合制对战（锦标赛冷却策略：禁用装备/熟练度加成）；无合适对手时匹配同评分的联赛 AI 训练师
// - 积分：胜 25 + 评分差奖励 floor(max(0, 对手-自己)/100) + 连胜奖励 min(25, 连胜×5)；负 15，连胜 ≥3 时连胜保护减半
// - 真实评分：ELO（K=32）；积分跨越段位/分组时自动晋级、降级，写入 league_history，晋级与连胜发放奖励
'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../../../../shared/db');
const { createLogger } = require('../../../../shared/logger');
const { LEAGUE_LEVELS, LEAGUE_ORDER, SEASON_CONFIG, SEASON_REWARDS, MATCHMAKING_CONFIG } = require('../../../../shared/LeagueConstants');
const repo = require('./repo');
const { BattleError, createBattle, summarize } = require('./engine');
const { buildCombatant } = require('./stats');
const { randomSeed } = require('./rng');
const { persistBattleStats } = require('./settle');
const battleMetrics = require('./metrics');
const rules = require('./leagueRules');

const { winPoints, lossPoints, elo, tierFor, tierChange, adjacentGroups, applyResult, tiers } = rules;

const logger = createLogger('league');
const SEASON_MS = (SEASON_CONFIG.durationDays || 28) * 24 * 3600 * 1000;
const TEAM_SIZE = 3;
const STREAK_MILESTONES = [3, 5, 10];

// ── 赛季 ─────────────────────────────────────────────────────
let seasonCache = null;

async function ensureSeason({ force = false } = {}) {
  if (!force && seasonCache && seasonCache.expires > Date.now() && new Date(seasonCache.season.end_time) > new Date()) return seasonCache.season;
  const { rows: [active] } = await query("SELECT * FROM league_seasons WHERE status = 'active' ORDER BY season_number DESC LIMIT 1");
  if (active && new Date(active.end_time) > new Date()) {
    seasonCache = { season: active, expires: Date.now() + 60000 };
    return active;
  }
  if (active) await settleSeason(active.id);
  const { rows: [last] } = await query('SELECT season_number, end_time FROM league_seasons ORDER BY season_number DESC LIMIT 1');
  const now = Date.now();
  let start = last ? new Date(last.end_time).getTime() : SEASON_CONFIG.startTime.getTime();
  if (start + SEASON_MS <= now || start > now) start = Math.floor(now / 3600e3) * 3600e3;
  const number = last ? last.season_number + 1 : 1;
  await query(`INSERT INTO league_seasons (season_number, start_time, end_time, status) VALUES ($1, to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), 'active')
      ON CONFLICT (season_number) DO NOTHING`, [number, start, start + SEASON_MS]);
  const { rows: [cur] } = await query("SELECT * FROM league_seasons WHERE status = 'active' ORDER BY season_number DESC LIMIT 1");
  seasonCache = { season: cur, expires: Date.now() + 60000 };
  logger.info({ season: cur && cur.season_number }, 'league season started');
  return cur;
}

/** 赛季结算：按最终段位发放赛季奖励（league_rewards，待领取），幂等 */
async function settleSeason(seasonId) {
  return transaction(async (client) => {
    const { rows: [s] } = await client.query(`UPDATE league_seasons SET status = 'completed',
        total_players = (SELECT COUNT(*) FROM league_members WHERE season_id = $1)
      WHERE id = $1 AND status = 'active' RETURNING id, season_number`, [seasonId]);
    if (!s) return { settled: false };
    const { rows: members } = await client.query(`SELECT player_id, league_level, league_group, league_points,
        RANK() OVER (PARTITION BY league_level, league_group ORDER BY league_points DESC, league_rating DESC) AS rnk
        FROM league_members WHERE season_id = $1`, [seasonId]);
    for (const m of members) {
      const reward = SEASON_REWARDS[m.league_level] || SEASON_REWARDS.BRONZE;
      const data = { coins: reward.coins, stardust: reward.coins * 10, items: reward.items, badge: reward.badge };
      if (LEAGUE_ORDER.indexOf(m.league_level) >= LEAGUE_ORDER.indexOf('GOLD')) data.equipment = 'RUNE_FOCUS';
      await client.query(`INSERT INTO league_rewards (player_id, season_id, reward_type, league_level, final_rank, reward_data, dedupe_key)
          VALUES ($1,$2,'season_end',$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [m.player_id, seasonId, m.league_level, Number(m.rnk), JSON.stringify(data), `season:${seasonId}`]);
    }
    seasonCache = null;
    logger.info({ seasonId, members: members.length }, 'league season settled');
    return { settled: true, seasonNumber: s.season_number, members: members.length };
  });
}

async function getMember(userId, season, client = null) {
  const q = client ? client.query.bind(client) : query;
  await q(`INSERT INTO league_members (player_id, league_level, league_group, league_points, league_rating, season_id)
      VALUES ($1, 'BRONZE', 'III', 0, 1000, $2) ON CONFLICT (player_id, season_id) DO NOTHING`, [userId, season.id]);
  const { rows: [m] } = await q(`SELECT * FROM league_members WHERE player_id = $1 AND season_id = $2${client ? ' FOR UPDATE' : ''}`, [userId, season.id]);
  return m;
}

function memberView(m, season) {
  const def = LEAGUE_LEVELS[m.league_level];
  return {
    level: m.league_level, levelName: def.name, group: m.league_group, points: m.league_points, rating: m.league_rating,
    consecutiveWins: m.consecutive_wins, bestConsecutiveWins: m.best_consecutive_wins, wins: m.wins, losses: m.losses,
    winRate: m.wins + m.losses ? Number((m.wins / (m.wins + m.losses)).toFixed(3)) : null,
    nextTier: nextTierInfo(m.league_points),
    season: season ? seasonView(season) : undefined,
  };
}

function nextTierInfo(points) {
  const cur = tierFor(points);
  for (let p = points + 1; p <= points + 1000; p++) {
    const t = tierFor(p);
    if (t.level !== cur.level || t.group !== cur.group) return { ...t, pointsNeeded: p - points };
  }
  return null;
}

function seasonView(s) {
  const end = new Date(s.end_time).getTime();
  return { id: s.id, number: s.season_number, startTime: s.start_time, endTime: s.end_time, status: s.status,
    remainingMs: Math.max(0, end - Date.now()), remainingDays: Math.max(0, Math.ceil((end - Date.now()) / 86400e3)), durationDays: SEASON_CONFIG.durationDays };
}

// ── 对局 ─────────────────────────────────────────────────────
async function teamRowsFor(userId, requestedIds = null) {
  let ids = requestedIds;
  if (!ids) {
    const { rows: [t] } = await query('SELECT pokemon_ids FROM battle_teams WHERE user_id = $1 ORDER BY is_default DESC, updated_at DESC LIMIT 1', [userId]);
    ids = t && t.pokemon_ids && t.pokemon_ids.length ? t.pokemon_ids.slice(0, TEAM_SIZE) : null;
  }
  let rows = ids ? await repo.getOwnedPokemon(userId, ids) : [];
  rows = rows.filter((r) => !r.defending_gym_id);
  if (!rows.length) rows = await repo.getTopPokemon(userId, TEAM_SIZE);
  return rows.slice(0, TEAM_SIZE);
}

/** 联赛 AI 训练师：评分越高精灵 CP 越高 */
async function botTeam(rating) {
  const { rows } = await query(`SELECT id, name_zh, type1::text AS type1, type2::text AS type2, base_attack, base_defense, base_hp
      FROM pokemon_species WHERE NOT (id = ANY($1::int[])) ORDER BY random() LIMIT $2`, [[144, 145, 146, 150, 151], TEAM_SIZE]);
  const moves = await repo.getMoves();
  const learn = await repo.getLearnsets(rows.map((r) => r.id));
  const cp = Math.max(200, Math.min(3000, Math.round(400 + (rating - 1000) * 1.5)));
  return rows.map((s) => buildCombatant({ ...s, id: `bot-${crypto.randomUUID()}`, species_id: s.id, cp, iv_attack: 10, iv_defense: 10, iv_hp: 10 }, moves,
    { learnset: learn.get(s.id) || [], ownerId: null }));
}

async function findOpponent(userId, member, season) {
  const groups = adjacentGroups(member.league_level, member.league_group);
  const { rows } = await query(`
    SELECT lm.player_id, lm.league_rating, lm.league_level, lm.league_group, u.nickname
      FROM league_members lm JOIN users u ON u.id = lm.player_id
     WHERE lm.season_id = $1 AND lm.league_level = $2 AND lm.league_group = ANY($3::text[])
       AND ABS(lm.league_rating - $4) <= $5 AND lm.player_id <> $6 AND COALESCE(u.is_banned, FALSE) = FALSE
     ORDER BY random() LIMIT 10`, [season.id, member.league_level, groups, member.league_rating, MATCHMAKING_CONFIG.ratingRange, userId]);
  for (const r of rows) {
    const team = await teamRowsFor(r.player_id);
    if (team.length) return { ...r, teamRows: team };
  }
  return null;
}

/** 匹配并开始一场联赛对局（返回未保存的战斗状态） */
async function prepareMatch(userId, body = {}) {
  const season = await ensureSeason();
  const member = await getMember(userId, season);
  const user = await repo.getUser(userId);
  let ids = null;
  if (Array.isArray(body.pokemonIds) && body.pokemonIds.length) {
    ids = body.pokemonIds;
    if (ids.length > TEAM_SIZE || !ids.every(repo.isUuid) || new Set(ids).size !== ids.length) throw new BattleError('BAD_TEAM', `联赛队伍为 1-${TEAM_SIZE} 只不重复的精灵`, 400);
    const owned = await repo.getOwnedPokemon(userId, ids);
    if (owned.length !== ids.length) throw new BattleError('POKEMON_UNAVAILABLE', '部分精灵不存在或不属于你', 400);
  }
  const myRows = await teamRowsFor(userId, ids);
  if (!myRows.length) throw new BattleError('NO_POKEMON', '没有可出战的精灵', 400);
  const attackers = await repo.toCombatants(myRows);

  const opp = await findOpponent(userId, member, season);
  let defenders;
  let meta;
  if (opp) {
    defenders = await repo.toCombatants(opp.teamRows);
    meta = { opponentType: 'player', opponentUserId: opp.player_id, opponentName: opp.nickname, opponentRating: opp.league_rating, opponentTier: { level: opp.league_level, group: opp.league_group } };
  } else {
    defenders = await botTeam(member.league_rating);
    meta = { opponentType: 'bot', opponentUserId: null, opponentName: `联赛训练师·${LEAGUE_LEVELS[member.league_level].name}`, opponentRating: member.league_rating, opponentTier: { level: member.league_level, group: member.league_group } };
  }
  const state = createBattle({
    id: crypto.randomUUID(), type: 'league', mode: 'TOURNAMENT', userId, trainerLevel: Number(user.level) || 1,
    attackerTeam: attackers, defenderTeam: defenders, seed: randomSeed(), weather: null,
    meta: { ...meta, seasonId: season.id, seasonNumber: season.season_number, nickname: user.nickname, myRating: member.league_rating, pokemonIds: myRows.map((r) => r.id) },
  });
  return { state, member, season, opponent: { type: meta.opponentType, name: meta.opponentName, rating: meta.opponentRating, tier: meta.opponentTier, team: defenders.map((d) => ({ name: d.name, speciesId: d.speciesId, cp: d.cp, types: d.types })) } };
}

async function grantReward(client, playerId, seasonId, type, level, data, dedupeKey) {
  const { rows: [r] } = await client.query(`INSERT INTO league_rewards (player_id, season_id, reward_type, league_level, reward_data, dedupe_key)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id, reward_type, reward_data`, [playerId, seasonId, type, level, JSON.stringify(data), dedupeKey]);
  return r || null;
}

async function applyMember(client, member, res, seasonId, battleId) {
  await client.query(`UPDATE league_members SET league_points = $3, league_rating = $4, consecutive_wins = $5, wins = $6, losses = $7,
      league_level = $8, league_group = $9, best_consecutive_wins = GREATEST(best_consecutive_wins, $5), last_match_time = NOW(), updated_at = NOW()
     WHERE player_id = $1 AND season_id = $2`,
  [member.player_id, seasonId, res.points, res.rating, res.consecutiveWins, res.wins, res.losses, res.level, res.group]);
  const rewards = [];
  if (res.change !== 'stay') {
    await client.query(`INSERT INTO league_history (player_id, season_id, action, from_level, from_group, to_level, to_group, points_at_action)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [member.player_id, seasonId, res.change, res.before.level, res.before.group, res.level, res.group, res.points]);
    if (res.change === 'promote') {
      const promo = LEAGUE_LEVELS[res.level].rewards.promotion || 0;
      const r = await grantReward(client, member.player_id, seasonId, 'promotion', res.level, { coins: promo, stardust: promo * 10, equipment: res.level === 'SILVER' ? 'GEM_SWIFT' : undefined }, `promotion:${seasonId}:${res.level}`);
      if (r) rewards.push(r);
    }
  }
  if (STREAK_MILESTONES.includes(res.consecutiveWins)) {
    const r = await grantReward(client, member.player_id, seasonId, 'streak', res.level, { coins: res.consecutiveWins * 10, stardust: res.consecutiveWins * 200 }, `streak:${seasonId}:${battleId}`);
    if (r) rewards.push(r);
  }
  return rewards;
}

/** 联赛对局结算：双方积分/评分/段位、对局记录、晋级与连胜奖励、战绩统计 */
async function settleLeague(state) {
  const sum = summarize(state);
  const won = sum.result === 'win';
  const seasonId = state.meta.seasonId;
  const outcome = await transaction(async (client) => {
    const { rows: [dup] } = await client.query('SELECT id FROM league_matches WHERE battle_id = $1', [state.id]);
    if (dup) return { duplicate: true };
    // 按 ID 顺序加行锁，避免两名玩家互相挑战时死锁
    const locked = {};
    for (const id of [state.userId, state.meta.opponentUserId].filter(Boolean).sort()) locked[id] = await getMember(id, { id: seasonId }, client);
    const me = locked[state.userId];
    const opp = state.meta.opponentUserId ? locked[state.meta.opponentUserId] : null;
    const oppRating = opp ? opp.league_rating : state.meta.opponentRating;
    const mine = applyResult(me, oppRating, won);
    const theirs = opp ? applyResult(opp, me.league_rating, !won) : null;
    await client.query(`INSERT INTO league_matches (season_id, player1_id, player2_id, winner_id, player1_points_change, player2_points_change,
        player1_rating_change, player2_rating_change, match_duration_seconds, match_time, battle_id, opponent_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11)`,
    [seasonId, state.userId, state.meta.opponentUserId, won ? state.userId : state.meta.opponentUserId, mine.pointsChange, theirs ? theirs.pointsChange : 0,
      mine.ratingChange, theirs ? theirs.ratingChange : 0, Math.round(sum.durationMs / 1000), state.id, state.meta.opponentType]);
    const rewards = await applyMember(client, me, mine, seasonId, state.id);
    if (opp) await applyMember(client, opp, theirs, seasonId, state.id);
    const xp = won ? 200 : 50;
    await client.query('UPDATE users SET xp = xp + $2, updated_at = NOW() WHERE id = $1', [state.userId, xp + (sum.comboXp || 0)]);
    await persistBattleStats(client, state, sum);
    return { duplicate: false, mine, theirs, rewards, xp: xp + (sum.comboXp || 0) };
  });
  battleMetrics.leagueMatches.inc({ result: sum.result, opponent: state.meta.opponentType });
  const m = outcome.mine;
  return {
    sum,
    settlement: {
      result: sum.result, turns: sum.turns, duplicate: !!outcome.duplicate,
      league: m ? {
        pointsChange: m.pointsChange, points: m.points, ratingChange: m.ratingChange, rating: m.rating,
        level: m.level, levelName: LEAGUE_LEVELS[m.level].name, group: m.group, change: m.change, consecutiveWins: m.consecutiveWins,
      } : null,
      opponent: { type: state.meta.opponentType, name: state.meta.opponentName, pointsChange: outcome.theirs ? outcome.theirs.pointsChange : 0 },
      rewards: outcome.rewards ? outcome.rewards.map((r) => ({ id: r.id, type: r.reward_type, data: r.reward_data })) : [],
      xp: outcome.xp || 0, combos: sum.combos.length,
    },
    replayOpts: { opponentUserId: state.meta.opponentUserId, labels: { opponentName: state.meta.opponentName, attackerNickname: state.meta.nickname, seasonNumber: state.meta.seasonNumber } },
  };
}

async function leaderboard({ level = 'BRONZE', group = 'III', limit = 100 } = {}) {
  const season = await ensureSeason();
  const lv = LEAGUE_ORDER.includes(level) ? level : 'BRONZE';
  const gr = LEAGUE_LEVELS[lv].groups.includes(group) ? group : LEAGUE_LEVELS[lv].groups[0];
  const { rows } = await query(`SELECT lm.player_id, u.nickname, lm.league_points, lm.league_rating, lm.wins, lm.losses, lm.consecutive_wins
      FROM league_members lm JOIN users u ON u.id = lm.player_id
     WHERE lm.season_id = $1 AND lm.league_level = $2 AND lm.league_group = $3
     ORDER BY lm.league_points DESC, lm.league_rating DESC, lm.updated_at ASC LIMIT $4`, [season.id, lv, gr, Math.min(100, Number(limit) || 100)]);
  return { season: seasonView(season), level: lv, group: gr, players: rows.map((r, i) => ({ rank: i + 1, userId: r.player_id, nickname: r.nickname, points: r.league_points, rating: r.league_rating, wins: r.wins, losses: r.losses, streak: r.consecutive_wins })) };
}

async function matches(userId, limit = 20) {
  const { rows } = await query(`SELECT m.id, m.season_id, m.player1_id, m.player2_id, m.winner_id, m.player1_points_change, m.player2_points_change,
        m.player1_rating_change, m.player2_rating_change, m.match_duration_seconds, m.match_time, m.battle_id, m.opponent_type,
        u1.nickname AS p1_name, u2.nickname AS p2_name, r.id AS replay_id
      FROM league_matches m LEFT JOIN users u1 ON u1.id = m.player1_id LEFT JOIN users u2 ON u2.id = m.player2_id
      LEFT JOIN battle_replay_records r ON r.battle_id = m.battle_id
     WHERE m.player1_id = $1 OR m.player2_id = $1 ORDER BY m.match_time DESC LIMIT $2`, [userId, Math.min(100, Number(limit) || 20)]);
  return rows.map((m) => {
    const asP1 = m.player1_id === userId;
    return {
      id: m.id, battleId: m.battle_id, replayId: m.replay_id, time: m.match_time, role: asP1 ? 'challenger' : 'defender',
      opponent: asP1 ? (m.opponent_type === 'bot' ? '联赛训练师' : m.p2_name) : m.p1_name, opponentType: asP1 ? m.opponent_type : 'player',
      result: m.winner_id === userId ? 'win' : 'lose',
      pointsChange: asP1 ? m.player1_points_change : m.player2_points_change,
      ratingChange: asP1 ? m.player1_rating_change : m.player2_rating_change,
      durationSeconds: m.match_duration_seconds,
    };
  });
}

async function rewards(userId) {
  const { rows } = await query(`SELECT id, season_id, reward_type, league_level, final_rank, reward_data, claimed, claimed_at, created_at
      FROM league_rewards WHERE player_id = $1 ORDER BY claimed, created_at DESC LIMIT 100`, [userId]);
  return rows;
}

/** 领取奖励：金币/星尘入账，装备放入背包；并发只成功一次 */
async function claimReward(userId, rewardId) {
  const id = Number(rewardId);
  if (!Number.isInteger(id) || id <= 0) throw new BattleError('INVALID_ID', '奖励 ID 无效', 400);
  return transaction(async (client) => {
    const { rows: [r] } = await client.query(`UPDATE league_rewards SET claimed = TRUE, claimed_at = NOW()
        WHERE id = $1 AND player_id = $2 AND claimed = FALSE RETURNING reward_type, reward_data`, [id, userId]);
    if (!r) throw new BattleError('REWARD_UNAVAILABLE', '奖励不存在或已领取', 409);
    const d = r.reward_data || {};
    await client.query('UPDATE users SET coins = coins + $2, stardust = stardust + $3, updated_at = NOW() WHERE id = $1', [userId, Number(d.coins) || 0, Number(d.stardust) || 0]);
    if (d.equipment) {
      await client.query(`INSERT INTO user_cooldown_equipment (user_id, equipment_id, source)
          SELECT $1::uuid, $2::varchar, 'league' WHERE EXISTS (SELECT 1 FROM cooldown_equipment_catalog WHERE id = $2::varchar)`, [userId, d.equipment]);
    }
    return { rewardId: id, type: r.reward_type, granted: { coins: Number(d.coins) || 0, stardust: Number(d.stardust) || 0, equipment: d.equipment || null, items: d.items || [] } };
  });
}

async function getDefenseTeam(userId) {
  const rows = await teamRowsFor(userId);
  return { pokemon: rows.map((r) => ({ pokemonId: r.id, name: r.nickname || r.name_zh, cp: r.cp, speciesId: r.species_id })) };
}

async function setDefenseTeam(userId, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > TEAM_SIZE || !ids.every(repo.isUuid) || new Set(ids).size !== ids.length) {
    throw new BattleError('BAD_TEAM', `防守队伍为 1-${TEAM_SIZE} 只不重复的精灵`, 400);
  }
  const owned = await repo.getOwnedPokemon(userId, ids);
  if (owned.length !== ids.length) throw new BattleError('POKEMON_UNAVAILABLE', '部分精灵不存在或不属于你', 400);
  await query('UPDATE battle_teams SET is_default = FALSE WHERE user_id = $1', [userId]);
  await query(`INSERT INTO battle_teams (user_id, name, pokemon_ids, is_default) VALUES ($1, '联赛防守队', $2::uuid[], TRUE)
      ON CONFLICT (user_id, name) DO UPDATE SET pokemon_ids = EXCLUDED.pokemon_ids, is_default = TRUE, updated_at = NOW()`, [userId, ids]);
  return getDefenseTeam(userId);
}


let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => ensureSeason({ force: true }).catch((err) => logger.warn({ err }, 'league season check failed')), 3600e3);
  timer.unref();
  setTimeout(() => ensureSeason({ force: true }).catch(() => {}), 5000).unref();
  require('./recommend').startScheduler();
}

module.exports = {
  winPoints, lossPoints, elo, tierFor, tierChange, adjacentGroups, applyResult,
  ensureSeason, settleSeason, getMember, memberView, seasonView, prepareMatch, settleLeague, leaderboard, matches, rewards,
  claimReward, getDefenseTeam, setDefenseTeam, tiers, startScheduler, TEAM_SIZE,
};
