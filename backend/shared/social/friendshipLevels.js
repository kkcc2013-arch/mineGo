/**
 * 玩家好友友情点 → 等级（纯函数）
 *
 * 同一份友情点（friends.friendship_points）驱动两套等级：
 *   - 友情等级 1-5（REQ-00048，阈值与 friendship_level_thresholds 表一致：0/100/500/1000/2000）
 *   - 亲密度等级 1-10（REQ-00388，阈值与 intimacy_levels 表一致：0/100/300/600/1000/1500/2200/3000/4000/5000）
 */
'use strict';

const FRIENDSHIP_LEVELS = Object.freeze([
  { level: 1, minPoints: 0, name: '新朋友', label: 'Good' },
  { level: 2, minPoints: 100, name: '好朋友', label: 'Great' },
  { level: 3, minPoints: 500, name: '超级朋友', label: 'Ultra' },
  { level: 4, minPoints: 1000, name: '最佳朋友', label: 'Best' },
  { level: 5, minPoints: 2000, name: '幸运朋友', label: 'Lucky' },
]);

const INTIMACY_LEVELS = Object.freeze([
  { level: 1, minPoints: 0, name: '陌生人' },
  { level: 2, minPoints: 100, name: '点头之交' },
  { level: 3, minPoints: 300, name: '泛泛之交' },
  { level: 4, minPoints: 600, name: '普通朋友' },
  { level: 5, minPoints: 1000, name: '好友' },
  { level: 6, minPoints: 1500, name: '好朋友' },
  { level: 7, minPoints: 2200, name: '密友' },
  { level: 8, minPoints: 3000, name: '挚友' },
  { level: 9, minPoints: 4000, name: '知己' },
  { level: 10, minPoints: 5000, name: '生死之交' },
]);

/**
 * 互动 → 友情点（服务端确认的互动才计分；低价值互动按天每对好友只计一次）
 */
const INTERACTION_POINTS = Object.freeze({
  gift_received: 10,      // 实际分值取自 gift_types.friendship_points
  exchange_gift: 20,
  raid_together: 50,
  battle_together: 30,
  trade: 100,
  joint_mission: 50,      // 实际分值取自 joint_missions.rewards.friendship_points
  visit_profile: 2,
  like_post: 3,
});
const DAILY_ONCE_INTERACTIONS = Object.freeze(['visit_profile', 'like_post', 'battle_together', 'raid_together']);

function levelFor(table, points) {
  const p = Math.max(0, Number(points) || 0);
  let cur = table[0];
  for (const l of table) if (p >= l.minPoints) cur = l;
  return cur;
}

const friendshipLevelFor = (points) => levelFor(FRIENDSHIP_LEVELS, points).level;
const intimacyLevelFor = (points) => levelFor(INTIMACY_LEVELS, points).level;

/** 距下一等级的进度（用于前端进度条） */
function progressInfo(table, points) {
  const p = Math.max(0, Number(points) || 0);
  const cur = levelFor(table, p);
  const next = table.find((l) => l.level === cur.level + 1) || null;
  return {
    level: cur.level,
    name: cur.name,
    points: p,
    currentMin: cur.minPoints,
    nextLevelPoints: next ? next.minPoints : null,
    pointsToNext: next ? next.minPoints - p : 0,
    progress: next ? Math.min(1, (p - cur.minPoints) / (next.minPoints - cur.minPoints)) : 1,
  };
}

/** 升级检测：返回 { friendship: {from,to}|null, intimacy: {from,to}|null } */
function detectLevelUps(beforePoints, afterPoints) {
  const fb = friendshipLevelFor(beforePoints); const fa = friendshipLevelFor(afterPoints);
  const ib = intimacyLevelFor(beforePoints); const ia = intimacyLevelFor(afterPoints);
  return {
    friendship: fa > fb ? { from: fb, to: fa } : null,
    intimacy: ia > ib ? { from: ib, to: ia } : null,
  };
}

module.exports = {
  FRIENDSHIP_LEVELS,
  INTIMACY_LEVELS,
  INTERACTION_POINTS,
  DAILY_ONCE_INTERACTIONS,
  friendshipLevelFor,
  intimacyLevelFor,
  friendshipProgress: (p) => progressInfo(FRIENDSHIP_LEVELS, p),
  intimacyProgress: (p) => progressInfo(INTIMACY_LEVELS, p),
  detectLevelUps,
};
