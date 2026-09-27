// 竞技联赛纯规则（REQ-00487）：积分、ELO、段位/分组、升降级、匹配范围。不依赖数据库，便于单元测试。
'use strict';

const { LEAGUE_LEVELS, LEAGUE_ORDER, SEASON_REWARDS, MATCHMAKING_CONFIG } = require('../../../../shared/LeagueConstants');

const GROUP_SPAN = 1000 / 3;

function winPoints(playerRating, opponentRating, streakBefore) {
  const ratingBonus = Math.max(0, Math.floor((opponentRating - playerRating) / 100));
  return 25 + ratingBonus + Math.min(25, Math.max(0, streakBefore) * 5);
}

function lossPoints(streakBefore) {
  return streakBefore >= 3 ? Math.floor(15 * 0.5) : 15;
}

function elo(rating, opponentRating, won, k = 32) {
  const expected = 1 / (1 + 10 ** ((opponentRating - rating) / 400));
  return Math.round(rating + k * ((won ? 1 : 0) - expected));
}

/** 积分 → 段位与分组（III 为最低组） */
function tierFor(points) {
  const p = Math.max(0, Number(points) || 0);
  let level = LEAGUE_ORDER[0];
  for (const l of LEAGUE_ORDER) if (p >= LEAGUE_LEVELS[l].minPoints) level = l;
  const def = LEAGUE_LEVELS[level];
  if (def.groups.length === 1) return { level, group: def.groups[0] };
  const idx = Math.min(2, Math.floor((p - def.minPoints) / GROUP_SPAN));
  return { level, group: ['III', 'II', 'I'][idx] };
}

function tierRank(level, group) {
  return LEAGUE_ORDER.indexOf(level) * 3 + ['III', 'II', 'I'].indexOf(group);
}

/** 段位变化：promote / demote / groupPromote / groupDemote / stay */
function tierChange(before, after) {
  if (before.level !== after.level) return LEAGUE_ORDER.indexOf(after.level) > LEAGUE_ORDER.indexOf(before.level) ? 'promote' : 'demote';
  if (before.group !== after.group) return tierRank(after.level, after.group) > tierRank(before.level, before.group) ? 'groupPromote' : 'groupDemote';
  return 'stay';
}

/** 匹配范围：同段位、分组 ±1 */
function adjacentGroups(level, group) {
  const groups = LEAGUE_LEVELS[level].groups;
  const order = ['III', 'II', 'I'].filter((g) => groups.includes(g));
  const i = order.indexOf(group);
  const r = MATCHMAKING_CONFIG.groupRange || 1;
  return order.filter((_, j) => Math.abs(j - i) <= r);
}

/** 一场对局后的积分/评分/段位结算（纯函数） */
function applyResult(member, opponentRating, won) {
  const streak = member.consecutive_wins || 0;
  const delta = won ? winPoints(member.league_rating, opponentRating, streak) : -lossPoints(streak);
  const points = Math.max(0, member.league_points + delta);
  const rating = elo(member.league_rating, opponentRating, won);
  const before = { level: member.league_level, group: member.league_group };
  const after = tierFor(points);
  return {
    points, pointsChange: points - member.league_points, rating, ratingChange: rating - member.league_rating,
    consecutiveWins: won ? streak + 1 : 0, wins: member.wins + (won ? 1 : 0), losses: member.losses + (won ? 0 : 1),
    level: after.level, group: after.group, change: tierChange(before, after), before,
  };
}

function tiers() {
  return LEAGUE_ORDER.map((l) => ({
    level: l, name: LEAGUE_LEVELS[l].name, minPoints: LEAGUE_LEVELS[l].minPoints, maxPoints: LEAGUE_LEVELS[l].maxPoints,
    groups: LEAGUE_LEVELS[l].groups.map((g) => ({ group: g, minPoints: LEAGUE_LEVELS[l].groups.length === 1 ? LEAGUE_LEVELS[l].minPoints : LEAGUE_LEVELS[l].minPoints + Math.ceil(['III', 'II', 'I'].indexOf(g) * GROUP_SPAN) })),
    rewards: { ...LEAGUE_LEVELS[l].rewards, seasonEnd: SEASON_REWARDS[l] },
  }));
}

module.exports = { winPoints, lossPoints, elo, tierFor, tierRank, tierChange, adjacentGroups, applyResult, tiers, GROUP_SPAN };
