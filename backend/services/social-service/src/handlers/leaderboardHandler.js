/**
 * 排行榜事件处理器
 * 监听游戏事件并更新排行榜
 */

const LeaderboardService = require('../leaderboardService');
const logger = require('../../../../shared/logger');

const leaderboardService = new LeaderboardService();

const handlers = {
  /**
   * 监听捕捉事件
   */
  async handleCatchEvent(event) {
    const { userId, rarity } = event.data;
    await leaderboardService.onCatchEvent(userId, rarity);
    logger.info(`[Leaderboard Handler] Catch event processed for user ${userId}`);
  },

  /**
   * 监听战斗结果
   */
  async handleBattleResult(event) {
    const { userId, isWin, points } = event.data;
    await leaderboardService.onBattleResult(userId, isWin, points);
    logger.info(`[Leaderboard Handler] Battle result processed for user ${userId}`);
  },

  /**
   * 监听道馆战斗
   */
  async handleGymBattle(event) {
    const { userId, isWin } = event.data;
    await leaderboardService.onGymBattle(userId, isWin);
  },

  /**
   * 监听图鉴更新
   */
  async handlePokedexUpdate(event) {
    const { userId, completionRate } = event.data;
    await leaderboardService.onPokedexUpdate(userId, completionRate);
  },

  /**
   * 监听闪光捕捉
   */
  async handleShinyCatch(event) {
    const { userId } = event.data;
    await leaderboardService.onShinyCatch(userId);
    logger.info(`[Leaderboard Handler] Shiny catch processed for user ${userId}`);
  },

  /**
   * 监听公会贡献
   */
  async handleGuildContribution(event) {
    const { userId, contribution } = event.data;
    const season = await leaderboardService.getCurrentSeason('guild_contribution');
    if (!season) return;

    const result = await leaderboardService.cache.incrementScore(
      'guild_contribution',
      season.id,
      userId,
      contribution
    );

    await leaderboardService.syncToDatabase(
      'guild_contribution',
      season.id,
      userId,
      result.score
    );
  }
};

/**
 * 注册所有事件监听器
 */
function registerLeaderboardHandlers(eventBus) {
  eventBus.subscribe('catch.success', handlers.handleCatchEvent);
  eventBus.subscribe('battle.pvp_result', handlers.handleBattleResult);
  eventBus.subscribe('gym.battle_result', handlers.handleGymBattle);
  eventBus.subscribe('pokedex.update', handlers.handlePokedexUpdate);
  eventBus.subscribe('pokemon.shiny_caught', handlers.handleShinyCatch);
  eventBus.subscribe('guild.contribution', handlers.handleGuildContribution);

  logger.info('[Leaderboard Handler] All handlers registered');
}

module.exports = {
  handlers,
  registerLeaderboardHandlers
};