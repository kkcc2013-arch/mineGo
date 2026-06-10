/**
 * 排行榜 Prometheus 指标
 * 
 * REQ-00074: 玩家排行榜系统
 */

const { Counter, Gauge, Histogram } = require('prom-client');

// 排行榜更新计数
const leaderboardUpdateTotal = new Counter({
  name: 'leaderboard_update_total',
  help: 'Total leaderboard updates',
  labelNames: ['type']
});

// 排行榜查询延迟
const leaderboardQueryLatency = new Histogram({
  name: 'leaderboard_query_latency_seconds',
  help: 'Leaderboard query latency',
  labelNames: ['type'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1]
});

// 排行榜玩家数量
const leaderboardPlayersCount = new Gauge({
  name: 'leaderboard_players_count',
  help: 'Number of players in leaderboard',
  labelNames: ['type', 'season_id']
});

// 赛季结束计数
const seasonEndTotal = new Counter({
  name: 'leaderboard_season_end_total',
  help: 'Total seasons ended',
  labelNames: ['type']
});

// 排名变化通知计数
const rankChangeNotifications = new Counter({
  name: 'leaderboard_rank_change_notifications_total',
  help: 'Total rank change notifications sent',
  labelNames: ['type', 'direction']
});

// 奖励领取计数
const rewardsClaimedTotal = new Counter({
  name: 'leaderboard_rewards_claimed_total',
  help: 'Total rewards claimed',
  labelNames: ['type', 'rank']
});

// 数据库同步计数
const databaseSyncTotal = new Counter({
  name: 'leaderboard_database_sync_total',
  help: 'Total database sync operations',
  labelNames: ['type', 'status']
});

// 赛季创建计数
const seasonCreateTotal = new Counter({
  name: 'leaderboard_season_create_total',
  help: 'Total seasons created',
  labelNames: ['type']
});

module.exports = {
  leaderboardUpdateTotal,
  leaderboardQueryLatency,
  leaderboardPlayersCount,
  seasonEndTotal,
  rankChangeNotifications,
  rewardsClaimedTotal,
  databaseSyncTotal,
  seasonCreateTotal
};
