/**
 * 排行榜 API 路由
 */

const express = require('express');
const router = express.Router();
const LeaderboardService = require('../leaderboardService');
const { requireAuth } = require('../../../shared/auth');
const logger = require('../../shared/logger');

const leaderboardService = new LeaderboardService();

/**
 * 获取排行榜
 * GET /api/leaderboard/:type
 */
router.get('/:type', requireAuth, async (req, res) => {
  try {
    const { type } = req.params;
    const { limit, aroundMe, seasonId } = req.query;

    if (!leaderboardService.isValidType(type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid leaderboard type' 
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
    logger.error('[Leaderboard API] Get leaderboard error:', error);
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
router.get('/:type/rank', requireAuth, async (req, res) => {
  try {
    const { type } = req.params;
    const userId = req.user.id;

    if (!leaderboardService.isValidType(type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid leaderboard type' 
      });
    }

    const result = await leaderboardService.getPlayerRankInfo(type, userId);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('[Leaderboard API] Get player rank error:', error);
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
router.get('/:type/seasons', requireAuth, async (req, res) => {
  try {
    const { type } = req.params;
    const { limit = 10 } = req.query;

    if (!leaderboardService.isValidType(type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid leaderboard type' 
      });
    }

    const result = await leaderboardService.db.query(`
      SELECT * FROM seasons
      WHERE leaderboard_type = $1
      ORDER BY start_time DESC
      LIMIT $2
    `, [type, parseInt(limit)]);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    logger.error('[Leaderboard API] Get seasons error:', error);
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
router.post('/season/:seasonId/claim', requireAuth, async (req, res) => {
  try {
    const { seasonId } = req.params;
    const userId = req.user.id;

    const result = await leaderboardService.claimSeasonRewards(
      parseInt(seasonId),
      userId
    );

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('[Leaderboard API] Claim rewards error:', error);
    res.status(400).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * 获取玩家多个排行榜排名概览
 * GET /api/leaderboard/my-ranks
 */
router.get('/my-ranks', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const types = ['catch_total', 'battle_pvp', 'pokedex_completion', 'shiny_collection'];

    const ranks = {};
    for (const type of types) {
      try {
        const result = await leaderboardService.getPlayerRankInfo(type, userId);
        ranks[type] = {
          rank: result.rank,
          score: result.score,
          seasonName: result.season?.name
        };
      } catch (error) {
        ranks[type] = { rank: null, score: 0 };
      }
    }

    res.json({
      success: true,
      data: ranks
    });
  } catch (error) {
    logger.error('[Leaderboard API] Get my ranks error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;