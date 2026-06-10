/**
 * 排行榜事件处理器
 * 
 * REQ-00074: 玩家排行榜系统
 */

const LeaderboardService = require('../leaderboardService');
const { logger } = require('../../../shared/logger');

const leaderboardService = new LeaderboardService();

module.exports = {
  /**
   * 监听捕捉事件
   */
  async handleCatchEvent(event) {
    const { userId, rarity, pokemonId } = event.data;
    
    logger.info('LeaderboardHandler.handleCatchEvent', { userId, rarity, pokemonId });
    
    await leaderboardService.onCatchEvent(userId, rarity, pokemonId);
  },

  /**
   * 监听战斗结果
   */
  async handleBattleResult(event) {
    const { userId, isWin, points, battleType } = event.data;
    
    logger.info('LeaderboardHandler.handleBattleResult', { userId, isWin, points, battleType });
    
    await leaderboardService.onBattleResult(userId, isWin, points, battleType);
  },

  /**
   * 监听图鉴更新
   */
  async handlePokedexUpdate(event) {
    const { userId, completionRate, totalCaught } = event.data;
    
    logger.info('LeaderboardHandler.handlePokedexUpdate', { userId, completionRate, totalCaught });
    
    await leaderboardService.onPokedexUpdate(userId, completionRate, totalCaught);
  },

  /**
   * 监听闪光捕捉
   */
  async handleShinyCatch(event) {
    const { userId, pokemonId } = event.data;
    
    logger.info('LeaderboardHandler.handleShinyCatch', { userId, pokemonId });
    
    await leaderboardService.onShinyCatch(userId);
  },

  /**
   * 监听道馆战斗结果
   */
  async handleGymBattleResult(event) {
    const { userId, isWin, gymId } = event.data;
    
    logger.info('LeaderboardHandler.handleGymBattleResult', { userId, isWin, gymId });
    
    // 道馆战斗积分：胜利 +10，失败 -3
    await leaderboardService.onBattleResult(userId, isWin, isWin ? 10 : 3, 'gym');
  },

  /**
   * 监听公会贡献事件
   */
  async handleGuildContribution(event) {
    const { userId, contributionPoints } = event.data;
    
    logger.info('LeaderboardHandler.handleGuildContribution', { userId, contributionPoints });
    
    const season = await leaderboardService.getCurrentSeason('guild_contribution');
    if (!season) return;

    const result = await leaderboardService.cache.incrementScore(
      'guild_contribution',
      season.id,
      userId,
      contributionPoints
    );

    await leaderboardService.syncToDatabase('guild_contribution', season.id, userId, result.score);
  }
};
