/**
 * 排行榜定时任务
 * 
 * REQ-00074: 玩家排行榜系统
 */

const cron = require('node-cron');
const LeaderboardService = require('../leaderboardService');
const { logger } = require('../../../shared/logger');

const leaderboardService = new LeaderboardService();

/**
 * 赛季结算任务 - 每小时检查
 */
const seasonSettlementJob = cron.schedule('0 * * * *', async () => {
  logger.info('[LeaderboardJob] Checking for ended seasons...');
  
  try {
    // 查找已结束但未结算的赛季
    const result = await leaderboardService.db.query(`
      SELECT id, name, leaderboard_type FROM seasons
      WHERE status = 'active' AND end_time <= NOW()
    `);

    for (const row of result.rows) {
      logger.info('[LeaderboardJob] Settling season', { 
        seasonId: row.id, 
        name: row.name,
        type: row.leaderboard_type
      });
      
      await leaderboardService.settleSeason(row.id);
    }
  } catch (error) {
    logger.error('[LeaderboardJob] Season settlement error', { error: error.message });
  }
});

/**
 * 数据库同步任务 - 每 5 分钟
 */
const databaseSyncJob = cron.schedule('*/5 * * * *', async () => {
  logger.info('[LeaderboardJob] Syncing to database...');
  
  try {
    await leaderboardService.syncAllToDatabase();
  } catch (error) {
    logger.error('[LeaderboardJob] Database sync error', { error: error.message });
  }
});

/**
 * 排名快照任务 - 每天凌晨 2 点
 */
const dailySnapshotJob = cron.schedule('0 2 * * *', async () => {
  logger.info('[LeaderboardJob] Creating daily rank snapshot...');
  
  try {
    await leaderboardService.createDailySnapshot();
  } catch (error) {
    logger.error('[LeaderboardJob] Daily snapshot error', { error: error.message });
  }
});

/**
 * 启动所有任务
 */
function startJobs() {
  logger.info('[LeaderboardJob] Starting leaderboard jobs...');
  
  // 任务已在 cron.schedule 中自动启动
  // 这里只是记录日志
}

/**
 * 停止所有任务
 */
function stopJobs() {
  logger.info('[LeaderboardJob] Stopping leaderboard jobs...');
  
  seasonSettlementJob.stop();
  databaseSyncJob.stop();
  dailySnapshotJob.stop();
}

module.exports = {
  startJobs,
  stopJobs,
  seasonSettlementJob,
  databaseSyncJob,
  dailySnapshotJob
};
