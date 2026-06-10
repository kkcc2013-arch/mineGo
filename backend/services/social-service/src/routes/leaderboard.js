/**
 * 排行榜 API 路由
 * 
 * REQ-00074: 玩家排行榜系统
 */

const express = require('express');
const router = express.Router();
const LeaderboardService = require('../leaderboardService');
const { authMiddleware } = require('../../../shared/auth');
const { logger } = require('../../../shared/logger');
const { rewardsClaimedTotal } = require('../leaderboardMetrics');

const leaderboardService = new LeaderboardService();

/**
 * 获取排行榜
 * GET /api/leaderboard/:type
 * 
 * Query params:
 * - limit: 返回数量 (default: 100)
 * - aroundMe: 是否显示当前玩家附近排名 (true/false)
 * - seasonId: 指定赛季 ID
 */
router.get('/:type', authMiddleware, async (req, res) => {
  try {
    const { type } = req.params;
    const { limit, aroundMe, seasonId } = req.query;

    if (!leaderboardService.isValidType(type)) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid leaderboard type',
        validTypes: LeaderboardService.VALID_LEADERBOARD_TYPES
      });
    }

    const result = await leaderboardService.getLeaderboard(type, {
      limit: parseInt(limit) || 100,
      aroundPlayer: aroundMe === 'true' ? req.user.id : null,
      seasonId: seasonId ? parseInt(seasonId) : null
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Get leaderboard error', { error: error.message, type: req.params.type });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

/**
 * 获取玩家排名
 * GET /api/leaderboard/:type/rank
 */
router.get('/:type/rank', authMiddleware, async (req, res) => {
  try {
    const { type } = req.params;
    const userId = req.user.id;

    if (!leaderboardService.isValidType(type)) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid leaderboard type' 
      });
    }

    const rankInfo = await leaderboardService.getPlayerRankInfo(type, userId);

    res.json({
      success: true,
      data: rankInfo
    });
  } catch (error) {
    logger.error('Get player rank error', { error: error.message, type: req.params.type });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

/**
 * 获取赛季历史
 * GET /api/leaderboard/:type/seasons
 */
router.get('/:type/seasons', authMiddleware, async (req, res) => {
  try {
    const { type } = req.params;
    const { limit = 10 } = req.query;

    if (!leaderboardService.isValidType(type)) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid leaderboard type' 
      });
    }

    const seasons = await leaderboardService.getSeasonHistory(type, parseInt(limit));

    res.json({
      success: true,
      data: seasons
    });
  } catch (error) {
    logger.error('Get seasons error', { error: error.message, type: req.params.type });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

/**
 * 领取赛季奖励
 * POST /api/leaderboard/season/:seasonId/claim
 */
router.post('/season/:seasonId/claim', authMiddleware, async (req, res) => {
  try {
    const { seasonId } = req.params;
    const userId = req.user.id;

    const result = await leaderboardService.claimSeasonRewards(parseInt(seasonId), userId);

    rewardsClaimedTotal.inc({ type: 'unknown', rank: result.rank.toString() });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Claim rewards error', { error: error.message, seasonId: req.params.seasonId });
    res.status(400).json({ 
      success: false,
      error: error.message 
    });
  }
});

/**
 * 获取玩家赛季历史记录
 * GET /api/leaderboard/my-history
 */
router.get('/my-history', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 10 } = req.query;

    const result = await leaderboardService.db.query(`
      SELECT 
        lh.*,
        s.name as season_name,
        s.leaderboard_type
      FROM leaderboard_history lh
      JOIN seasons s ON s.id = lh.season_id
      WHERE lh.player_id = $1
      ORDER BY lh.created_at DESC
      LIMIT $2
    `, [userId, parseInt(limit)]);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    logger.error('Get my history error', { error: error.message });
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

/**
 * 获取排行榜类型列表
 * GET /api/leaderboard/types
 */
router.get('/types/list', (req, res) => {
  res.json({
    success: true,
    data: LeaderboardService.VALID_LEADERBOARD_TYPES.map(type => ({
      type,
      name: getTypeDisplayName(type),
      description: getTypeDescription(type)
    }))
  });
});

/**
 * 辅助函数：获取类型显示名称
 */
function getTypeDisplayName(type) {
  const names = {
    'catch_total': '捕捉榜',
    'catch_rare': '稀有捕捉榜',
    'battle_pvp': 'PVP 战斗榜',
    'battle_gym': '道馆战斗榜',
    'pokedex_completion': '图鉴完成榜',
    'shiny_collection': '闪光收集榜',
    'guild_contribution': '公会贡献榜'
  };
  return names[type] || type;
}

/**
 * 辅助函数：获取类型描述
 */
function getTypeDescription(type) {
  const descriptions = {
    'catch_total': '累计捕捉精灵数量排名',
    'catch_rare': '稀有和传说精灵捕捉数量排名',
    'battle_pvp': 'PVP 对战积分排名',
    'battle_gym': '道馆战斗胜率排名',
    'pokedex_completion': '精灵图鉴完成度排名',
    'shiny_collection': '闪光精灵收集数量排名',
    'guild_contribution': '公会贡献积分排名'
  };
  return descriptions[type] || '';
}

module.exports = router;
