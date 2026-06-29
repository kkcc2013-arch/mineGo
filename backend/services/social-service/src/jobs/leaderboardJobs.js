/**
 * 排行榜定时任务
 */

const cron = require('node-cron');
const LeaderboardService = require('../leaderboardService');
const logger = require('../../../shared/logger');

const leaderboardService = new LeaderboardService();

/**
 * 启动所有定时任务
 */
function startLeaderboardJobs() {
  // 赛季结算任务 - 每小时检查
  cron.schedule('0 * * * *', async () => {
    logger.info('[Leaderboard Jobs] Checking for ended seasons...');
    
    try {
      const result = await leaderboardService.db.query(`
        SELECT id, leaderboard_type FROM seasons
        WHERE status = 'active' AND end_time <= NOW()
      `);

      for (const row of result.rows) {
        logger.info(`[Leaderboard Jobs] Settling season ${row.id}`);
        await leaderboardService.settleSeason(row.id);
      }
    } catch (error) {
      logger.error('[Leaderboard Jobs] Season settlement error:', error);
    }
  });

  // 数据库同步任务 - 每 5 分钟
  cron.schedule('*/5 * * * *', async () => {
    logger.info('[Leaderboard Jobs] Syncing to database...');
    
    const types = [
      'catch_total', 'catch_rare', 'battle_pvp', 'battle_gym',
      'pokedex_completion', 'shiny_collection', 'guild_contribution'
    ];

    for (const type of types) {
      try {
        const season = await leaderboardService.getCurrentSeason(type);
        if (!season) continue;

        const topPlayers = await leaderboardService.cache.getTopPlayers(type, season.id, 500);
        
        for (const player of topPlayers) {
          await leaderboardService.syncToDatabase(
            type, 
            season.id, 
            player.playerId, 
            player.score
          );
        }
      } catch (error) {
        logger.error(`[Leaderboard Jobs] Sync error for ${type}:`, error);
      }
    }
  });

  // 排名快照任务 - 每天凌晨 2 点
  cron.schedule('0 2 * * *', async () => {
    logger.info('[Leaderboard Jobs] Creating daily rank snapshot...');
    
    // 记录每日排名变化，用于展示排名趋势
    const types = ['catch_total', 'battle_pvp'];
    
    for (const type of types) {
      try {
        const season = await leaderboardService.getCurrentSeason(type);
        if (!season) continue;

        const topPlayers = await leaderboardService.cache.getTopPlayers(type, season.id, 100);
        
        // 更新 previous_rank
        for (const player of topPlayers) {
          await leaderboardService.db.query(`
            UPDATE leaderboards 
            SET previous_rank = rank, rank = $1
            WHERE leaderboard_type = $2 
              AND season_id = $3 
              AND player_id = $4
          `, [player.rank, type, season.id, player.playerId]);
        }
      } catch (error) {
        logger.error(`[Leaderboard Jobs] Snapshot error for ${type}:`, error);
      }
    }
  });

  logger.info('[Leaderboard Jobs] All jobs started');
}

/**
 * 初始化排行榜数据
 */
async function initializeLeaderboards() {
  logger.info('[Leaderboard Jobs] Initializing leaderboard data...');
  
  const types = [
    'catch_total', 'catch_rare', 'battle_pvp', 'battle_gym',
    'pokedex_completion', 'shiny_collection'
  ];

  for (const type of types) {
    try {
      await leaderboardService.initializeSeasonData(type);
    } catch (error) {
      logger.error(`[Leaderboard Jobs] Init error for ${type}:`, error);
    }
  }

  logger.info('[Leaderboard Jobs] Leaderboard data initialized');
}

module.exports = {
  startLeaderboardJobs,
  initializeLeaderboards
};